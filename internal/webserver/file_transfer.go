package webserver

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"strings"
	"syscall"
	"time"

	appcore "GoNavi-Wails/internal/app"
)

const (
	webUploadMultipartOverheadBytes int64 = 1 << 20
	webUploadReadTimeout                  = 5 * time.Minute
)

type webFileTransferResponse struct {
	Success bool   `json:"success"`
	Data    any    `json:"data,omitempty"`
	Message string `json:"message,omitempty"`
}

func (s *Server) handleWebUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s == nil || s.app == nil {
		s.writeWebFileTransferResponse(w, http.StatusServiceUnavailable, webFileTransferResponse{Message: "web upload is unavailable"})
		return
	}
	defer r.Body.Close()

	maxBodyBytes := appcore.MaxWebUploadBytes + webUploadMultipartOverheadBytes
	if r.ContentLength > maxBodyBytes {
		s.writeWebFileTransferResponse(w, http.StatusRequestEntityTooLarge, webFileTransferResponse{Message: appcore.ErrWebUploadTooLarge.Error()})
		return
	}
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Now().Add(webUploadReadTimeout))
	defer func() { _ = controller.SetReadDeadline(time.Time{}) }()
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)

	reader, err := r.MultipartReader()
	if err != nil {
		s.writeWebFileTransferResponse(w, http.StatusBadRequest, webFileTransferResponse{Message: "invalid multipart upload"})
		return
	}
	purpose := r.URL.Query().Get("purpose")
	for {
		part, nextErr := reader.NextPart()
		if errors.Is(nextErr, io.EOF) {
			break
		}
		if nextErr != nil {
			s.writeWebUploadError(w, nextErr)
			return
		}
		if part.FormName() != "file" || strings.TrimSpace(part.FileName()) == "" {
			_, _ = io.Copy(io.Discard, part)
			_ = part.Close()
			continue
		}
		info, stageErr := appcore.StageWebUploadForEntryPoint(s.app, purpose, part.FileName(), part)
		_ = part.Close()
		if stageErr != nil {
			s.writeWebUploadError(w, stageErr)
			return
		}
		s.writeWebFileTransferResponse(w, http.StatusOK, webFileTransferResponse{Success: true, Data: info})
		return
	}
	s.writeWebFileTransferResponse(w, http.StatusBadRequest, webFileTransferResponse{Message: "multipart field file is required"})
}

func (s *Server) writeWebUploadError(w http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	var maxBytesError *http.MaxBytesError
	var netError net.Error
	switch {
	case errors.Is(err, appcore.ErrWebUploadTooLarge), errors.As(err, &maxBytesError):
		status = http.StatusRequestEntityTooLarge
	case errors.Is(err, appcore.ErrWebTransferStorageFull), errors.Is(err, syscall.ENOSPC):
		status = http.StatusInsufficientStorage
	case errors.As(err, &netError) && netError.Timeout():
		status = http.StatusRequestTimeout
	case errors.Is(err, appcore.ErrInvalidWebUpload):
		status = http.StatusBadRequest
	default:
		status = http.StatusInternalServerError
		err = errors.New("web upload failed")
	}
	s.writeWebFileTransferResponse(w, status, webFileTransferResponse{Message: err.Error()})
}

func (s *Server) handleWebDownload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s == nil || s.app == nil {
		http.NotFound(w, r)
		return
	}
	token := strings.TrimPrefix(r.URL.Path, internalRoutePrefix+"/api/download/")
	if token == "" || strings.Contains(token, "/") {
		http.NotFound(w, r)
		return
	}
	file, download, err := appcore.OpenWebDownloadForEntryPoint(s.app, token)
	if err != nil {
		if errors.Is(err, appcore.ErrWebTransferNotFound) || errors.Is(err, appcore.ErrInvalidWebTransferToken) {
			http.NotFound(w, r)
			return
		}
		http.Error(w, "download unavailable", http.StatusInternalServerError)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		http.Error(w, "download unavailable", http.StatusInternalServerError)
		return
	}
	contentType := strings.TrimSpace(download.MimeType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": download.FileName})
	if disposition == "" {
		disposition = fmt.Sprintf("attachment; filename=%q", "gonavi-download")
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", disposition)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeContent(w, r, download.FileName, info.ModTime(), file)
}

func (s *Server) writeWebFileTransferResponse(w http.ResponseWriter, status int, response webFileTransferResponse) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(response)
}
