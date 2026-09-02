package webserver

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"

	appcore "GoNavi-Wails/internal/app"
)

func buildWebUploadRequest(t *testing.T, purpose string, fileName string, content string) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", fileName)
	if err != nil {
		t.Fatalf("create multipart file: %v", err)
	}
	if _, err := io.WriteString(part, content); err != nil {
		t.Fatalf("write multipart file: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, internalRoutePrefix+"/api/upload?purpose="+purpose, bytes.NewReader(body.Bytes()))
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

func newWebFileTransferServer(t *testing.T) (*Server, *appcore.App) {
	t.Helper()
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())
	application := appcore.NewWebApp()
	return &Server{app: application}, application
}

func TestWebUploadHandlerReturnsOpaqueTokenAndEnforcesPurpose(t *testing.T) {
	server, _ := newWebFileTransferServer(t)
	request := buildWebUploadRequest(t, "data-import", `C:\fakepath\customers.csv`, "id,name\n1,Ada\n")
	recorder := httptest.NewRecorder()
	server.handleWebUpload(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("upload status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Success bool `json:"success"`
		Data    struct {
			FilePath string `json:"filePath"`
			Name     string `json:"name"`
			FileSize int64  `json:"fileSize"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode upload response: %v", err)
	}
	if !response.Success || response.Data.FilePath == "" || response.Data.Name != "customers.csv" || response.Data.FileSize == 0 {
		t.Fatalf("unexpected upload response: %+v", response)
	}
	if strings.Contains(response.Data.FilePath, "/") || strings.Contains(recorder.Body.String(), "web-file-transfer") {
		t.Fatalf("upload response leaked a managed path: %s", recorder.Body.String())
	}

	wrongPurpose := buildWebUploadRequest(t, "sql-execution", "customers.csv", "id\n1\n")
	wrongRecorder := httptest.NewRecorder()
	server.handleWebUpload(wrongRecorder, wrongPurpose)
	if wrongRecorder.Code != http.StatusBadRequest {
		t.Fatalf("wrong-purpose upload status = %d, body=%s", wrongRecorder.Code, wrongRecorder.Body.String())
	}
}

func TestWebUploadHandlerRejectsOversizeContentLengthBeforeStaging(t *testing.T) {
	server, _ := newWebFileTransferServer(t)
	request := buildWebUploadRequest(t, "sql-execution", "backup.sql", "SELECT 1;")
	request.ContentLength = appcore.MaxWebUploadBytes + webUploadMultipartOverheadBytes + 1
	recorder := httptest.NewRecorder()
	server.handleWebUpload(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize status = %d, body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestWebUploadErrorReportsStorageQuotaExhaustion(t *testing.T) {
	server, _ := newWebFileTransferServer(t)
	recorder := httptest.NewRecorder()
	server.writeWebUploadError(recorder, appcore.ErrWebTransferStorageFull)
	if recorder.Code != http.StatusInsufficientStorage {
		t.Fatalf("storage quota status = %d, want %d", recorder.Code, http.StatusInsufficientStorage)
	}
	if !strings.Contains(recorder.Body.String(), appcore.ErrWebTransferStorageFull.Error()) {
		t.Fatalf("storage quota response = %s", recorder.Body.String())
	}

	diskFullRecorder := httptest.NewRecorder()
	server.writeWebUploadError(diskFullRecorder, syscall.ENOSPC)
	if diskFullRecorder.Code != http.StatusInsufficientStorage {
		t.Fatalf("disk full status = %d, want %d", diskFullRecorder.Code, http.StatusInsufficientStorage)
	}
}

func TestWebDownloadHandlerSupportsMetadataHeadAndRange(t *testing.T) {
	server, application := newWebFileTransferServer(t)
	result := application.ExportDataWithOptions(
		[]map[string]interface{}{{"id": 1, "name": "Ada"}},
		[]string{"id", "name"},
		"customers",
		appcore.ExportFileOptions{Format: "csv"},
	)
	if !result.Success {
		t.Fatalf("prepare download: %s", result.Message)
	}
	data := result.Data.(map[string]interface{})
	download := data["webDownload"].(appcore.WebDownloadInfo)
	url := internalRoutePrefix + "/api/download/" + download.Token

	headRequest := httptest.NewRequest(http.MethodHead, url, nil)
	headRecorder := httptest.NewRecorder()
	server.handleWebDownload(headRecorder, headRequest)
	if headRecorder.Code != http.StatusOK || headRecorder.Body.Len() != 0 {
		t.Fatalf("HEAD status=%d body=%q", headRecorder.Code, headRecorder.Body.String())
	}
	if disposition := headRecorder.Header().Get("Content-Disposition"); !strings.Contains(disposition, "customers.csv") {
		t.Fatalf("Content-Disposition = %q", disposition)
	}
	if headRecorder.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", headRecorder.Header().Get("Cache-Control"))
	}

	rangeRequest := httptest.NewRequest(http.MethodGet, url, nil)
	rangeRequest.Header.Set("Range", "bytes=0-2")
	rangeRecorder := httptest.NewRecorder()
	server.handleWebDownload(rangeRecorder, rangeRequest)
	if rangeRecorder.Code != http.StatusPartialContent {
		t.Fatalf("range status=%d body=%q", rangeRecorder.Code, rangeRecorder.Body.String())
	}
	if rangeRecorder.Body.Len() != 3 || !strings.HasPrefix(rangeRecorder.Header().Get("Content-Range"), "bytes 0-2/") {
		t.Fatalf("unexpected range response headers=%v body=%q", rangeRecorder.Header(), rangeRecorder.Body.Bytes())
	}

	missingRecorder := httptest.NewRecorder()
	server.handleWebDownload(missingRecorder, httptest.NewRequest(http.MethodGet, internalRoutePrefix+"/api/download/not-a-token", nil))
	if missingRecorder.Code != http.StatusNotFound {
		t.Fatalf("invalid token status = %d", missingRecorder.Code)
	}
}

func TestWebFileTransferRoutesRequireAuthentication(t *testing.T) {
	server, _ := newWebFileTransferServer(t)
	manager, err := newWebAuthManager(t.TempDir())
	if err != nil {
		t.Fatalf("new auth manager: %v", err)
	}
	setup, err := manager.BeginSetup("127.0.0.1:34116")
	if err != nil {
		t.Fatalf("begin setup: %v", err)
	}
	_, sessionID, err := manager.CompleteSetup(setup.SetupToken, "123456", "", false, 30, 24, 7)
	if err != nil {
		t.Fatalf("complete setup: %v", err)
	}
	server.auth = manager
	handler := server.routes()

	unauthorized := buildWebUploadRequest(t, "data-import", "rows.csv", "id\n1\n")
	unauthorizedRecorder := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedRecorder, unauthorized)
	if unauthorizedRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized upload status = %d, body=%s", unauthorizedRecorder.Code, unauthorizedRecorder.Body.String())
	}
	unauthorizedDownload := httptest.NewRequest(http.MethodGet, internalRoutePrefix+"/api/download/"+strings.Repeat("a", 36), nil)
	unauthorizedDownloadRecorder := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedDownloadRecorder, unauthorizedDownload)
	if unauthorizedDownloadRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized download status = %d, body=%s", unauthorizedDownloadRecorder.Code, unauthorizedDownloadRecorder.Body.String())
	}

	authorized := buildWebUploadRequest(t, "data-import", "rows.csv", "id\n1\n")
	authorized.AddCookie(&http.Cookie{Name: webSessionCookieName, Value: sessionID})
	authorizedRecorder := httptest.NewRecorder()
	handler.ServeHTTP(authorizedRecorder, authorized)
	if authorizedRecorder.Code != http.StatusOK {
		t.Fatalf("authorized upload status = %d, body=%s", authorizedRecorder.Code, authorizedRecorder.Body.String())
	}
}
