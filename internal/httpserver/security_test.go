package httpserver

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLimitRequestBodyRejectsOversizeBeforeHandler(t *testing.T) {
	var called atomic.Bool
	handler := limitRequestBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Store(true)
		w.WriteHeader(http.StatusNoContent)
	}), 16, time.Second)

	request := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(bytes.Repeat([]byte("x"), 17)))
	request.ContentLength = -1 // exercise streaming/chunked bodies, not just the header fast path
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d; body=%q", recorder.Code, http.StatusRequestEntityTooLarge, recorder.Body.String())
	}
	if called.Load() {
		t.Fatal("handler was called before the oversized body was rejected")
	}
}

func TestLimitRequestBodyBuffersNormalRequest(t *testing.T) {
	const payload = `{"value":"ok"}`
	handler := limitRequestBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read buffered body: %v", err)
			return
		}
		if string(body) != payload {
			t.Errorf("body = %q, want %q", body, payload)
		}
		w.WriteHeader(http.StatusNoContent)
	}), 1024, time.Second)

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(payload)))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNoContent)
	}
}

func TestLimitRequestBodyTimesOutSlowBodyBeforeHandler(t *testing.T) {
	var called atomic.Bool
	handler := limitRequestBody(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called.Store(true)
		w.WriteHeader(http.StatusNoContent)
	}), 1024, 75*time.Millisecond)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	address := strings.TrimPrefix(server.URL, "http://")
	connection, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatalf("dial test server: %v", err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := io.WriteString(connection, "POST / HTTP/1.1\r\nHost: "+address+"\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n"); err != nil {
		t.Fatalf("write partial request: %v", err)
	}

	response, err := http.ReadResponse(bufio.NewReader(connection), &http.Request{Method: http.MethodPost})
	if err != nil {
		t.Fatalf("read timeout response: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusRequestTimeout {
		body, _ := io.ReadAll(response.Body)
		t.Fatalf("status = %d, want %d; body=%q", response.StatusCode, http.StatusRequestTimeout, body)
	}
	if called.Load() {
		t.Fatal("handler was called before the slow body timed out")
	}
}

func TestStreamingWriteTimeoutAllowsLongLivedSSE(t *testing.T) {
	const writeTimeout = 50 * time.Millisecond
	handler := streamingWriteTimeout(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, ": connected\n\n")
		w.(http.Flusher).Flush()
		time.Sleep(3 * writeTimeout)
		_, _ = io.WriteString(w, ": ping\n\n")
		w.(http.Flusher).Flush()
	}), writeTimeout)
	server := httptest.NewUnstartedServer(handler)
	server.Config.WriteTimeout = writeTimeout
	server.Start()
	t.Cleanup(server.Close)

	client := &http.Client{Timeout: time.Second}
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatalf("open SSE response: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read SSE response after server WriteTimeout: %v", err)
	}
	if got := string(body); got != ": connected\n\n: ping\n\n" {
		t.Fatalf("SSE body = %q", got)
	}
}

func TestStreamingWriteTimeoutAllowsIdleHandlerThenWrite(t *testing.T) {
	const writeTimeout = 50 * time.Millisecond
	handler := streamingWriteTimeout(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(3 * writeTimeout)
		_, _ = io.WriteString(w, `{"ok":true}`)
	}), writeTimeout)
	server := httptest.NewUnstartedServer(handler)
	server.Config.WriteTimeout = writeTimeout
	server.Start()
	t.Cleanup(server.Close)

	client := &http.Client{Timeout: time.Second}
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatalf("invoke after idle past WriteTimeout: %v", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read invoke response: %v", err)
	}
	if got := string(body); got != `{"ok":true}` {
		t.Fatalf("invoke body = %q", got)
	}
}

func TestDecompressRequestBodyInflatesBoundedGzip(t *testing.T) {
	var received int
	handler := limitRequestBody(DecompressRequestBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		received = len(body)
		w.WriteHeader(http.StatusNoContent)
	})), MaxRequestBodyBytes, time.Second)

	plain := bytes.Repeat([]byte("row,"), 400_000) // 1.6 MiB decoded, well under the transport cap once compressed
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(plain); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if int64(compressed.Len()) >= MaxRequestBodyBytes {
		t.Fatalf("test payload did not compress below the transport limit: %d", compressed.Len())
	}

	request := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(compressed.Bytes()))
	request.Header.Set("Content-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, body=%q", recorder.Code, recorder.Body.String())
	}
	if received != len(plain) {
		t.Fatalf("decoded bytes = %d, want %d", received, len(plain))
	}
}

func TestDecompressRequestBodyRejectsExpansionOverCap(t *testing.T) {
	handler := DecompressRequestBody(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("handler must not run for an oversized decoded body")
	}))
	// Repeating one byte compresses extremely well, so the compressed body stays
	// tiny while the decoded body exceeds the inflation cap.
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	chunk := bytes.Repeat([]byte("0"), 1<<20)
	for written := int64(0); written <= MaxDecodedRequestBodyBytes; written += int64(len(chunk)) {
		if _, err := writer.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(compressed.Bytes()))
	request.Header.Set("Content-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusRequestEntityTooLarge)
	}
}

func TestLimitInvokeRequestBodyAllowsExportSizedBodies(t *testing.T) {
	payload := bytes.Repeat([]byte("x"), int(MaxRequestBodyBytes)+1024)
	var received int
	handler := LimitInvokeRequestBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		received = len(body)
		w.WriteHeader(http.StatusNoContent)
	}))

	request := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(payload))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent || received != len(payload) {
		t.Fatalf("status = %d, received = %d, want %d bytes accepted", recorder.Code, received, len(payload))
	}

	general := limitRequestBody(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("general body limit must keep rejecting export-sized payloads")
	}), MaxRequestBodyBytes, time.Second)
	rejected := httptest.NewRecorder()
	general.ServeHTTP(rejected, httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(payload)))
	if rejected.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("general limit status = %d, want %d", rejected.Code, http.StatusRequestEntityTooLarge)
	}
}
