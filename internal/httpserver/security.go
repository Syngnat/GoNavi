// Package httpserver contains the HTTP resource limits shared by GoNavi's
// browser and Streamable HTTP MCP servers.
package httpserver

import (
	"bytes"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"time"
)

const (
	// MaxRequestBodyBytes is large enough for normal Web invoke and MCP JSON-RPC
	// payloads while bounding the memory used when a request is buffered.
	MaxRequestBodyBytes int64 = 1 << 20

	ReadHeaderTimeout = 10 * time.Second
	ReadTimeout       = 30 * time.Second
	// WriteTimeout is deliberately longer than ReadTimeout so the server can
	// still send a timeout response after a request body read reaches its limit.
	WriteTimeout = time.Minute
	IdleTimeout  = 2 * time.Minute
)

// LimitRequestBody reads and buffers the complete request body before invoking
// next. This makes the size and read deadline apply before any business handler
// or SDK code can observe a partial request.
func LimitRequestBody(next http.Handler) http.Handler {
	return limitRequestBody(next, MaxRequestBodyBytes, ReadTimeout)
}

func limitRequestBody(next http.Handler, maxBytes int64, readTimeout time.Duration) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body == nil || r.Body == http.NoBody {
			next.ServeHTTP(w, r)
			return
		}
		if r.ContentLength > maxBytes {
			_ = r.Body.Close()
			writeRequestBodyError(w, http.StatusRequestEntityTooLarge)
			return
		}

		controller := http.NewResponseController(w)
		if readTimeout > 0 {
			// A fresh per-request deadline ensures that a client cannot spend the
			// server-wide read budget on headers and then drip-feed the body.
			_ = controller.SetReadDeadline(time.Now().Add(readTimeout))
			defer func() { _ = controller.SetReadDeadline(time.Time{}) }()
		}

		limited := http.MaxBytesReader(w, r.Body, maxBytes)
		body, err := io.ReadAll(limited)
		closeErr := limited.Close()
		if err == nil {
			err = closeErr
		}
		if err != nil {
			var maxBytesError *http.MaxBytesError
			if errors.As(err, &maxBytesError) {
				writeRequestBodyError(w, http.StatusRequestEntityTooLarge)
				return
			}
			var netError net.Error
			if errors.As(err, &netError) && netError.Timeout() {
				writeRequestBodyError(w, http.StatusRequestTimeout)
				return
			}
			writeRequestBodyError(w, http.StatusBadRequest)
			return
		}

		r.Body = io.NopCloser(bytes.NewReader(body))
		r.ContentLength = int64(len(body))
		// The body is now memory-backed, so the connection no longer needs a
		// read deadline while the business handler runs.
		_ = controller.SetReadDeadline(time.Time{})
		next.ServeHTTP(w, r)
	})
}

func writeRequestBodyError(w http.ResponseWriter, status int) {
	message := "invalid request body"
	switch status {
	case http.StatusRequestEntityTooLarge:
		message = "request body too large"
	case http.StatusRequestTimeout:
		message = "request body read timed out"
	}
	http.Error(w, message, status)
}

// StreamingWriteTimeout converts http.Server's absolute WriteTimeout into a
// rolling per-write timeout. Long-lived SSE connections may remain idle for any
// duration, but a write to a slow or disconnected client is still bounded.
func StreamingWriteTimeout(next http.Handler) http.Handler {
	return streamingWriteTimeout(next, WriteTimeout)
}

// StreamingWriteTimeoutWhen applies rolling write deadlines only to requests
// selected by isStream. Other requests retain http.Server.WriteTimeout.
func StreamingWriteTimeoutWhen(next http.Handler, isStream func(*http.Request) bool) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isStream != nil && isStream(r) {
			StreamingWriteTimeout(next).ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func streamingWriteTimeout(next http.Handler, timeout time.Duration) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		controller := http.NewResponseController(w)
		_ = controller.SetWriteDeadline(time.Time{})
		next.ServeHTTP(&streamingResponseWriter{ResponseWriter: w, timeout: timeout}, r)
	})
}

type streamingResponseWriter struct {
	http.ResponseWriter
	timeout time.Duration
	mu      sync.Mutex
}

// Unwrap lets http.ResponseController retain access to the original writer.
func (w *streamingResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *streamingResponseWriter) WriteHeader(status int) {
	w.withWriteDeadline(func() {
		w.ResponseWriter.WriteHeader(status)
	})
}

func (w *streamingResponseWriter) Write(payload []byte) (int, error) {
	var n int
	var err error
	w.withWriteDeadline(func() {
		n, err = w.ResponseWriter.Write(payload)
	})
	return n, err
}

func (w *streamingResponseWriter) Flush() {
	w.withWriteDeadline(func() {
		_ = http.NewResponseController(w.ResponseWriter).Flush()
	})
}

func (w *streamingResponseWriter) withWriteDeadline(write func()) {
	w.mu.Lock()
	defer w.mu.Unlock()

	controller := http.NewResponseController(w.ResponseWriter)
	if w.timeout > 0 {
		_ = controller.SetWriteDeadline(time.Now().Add(w.timeout))
	}
	write()
	_ = controller.SetWriteDeadline(time.Time{})
}
