package webserver

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestServeCompressedAssetSetsHeadersAndBody(t *testing.T) {
	source := strings.Repeat("console.log('gonavi');\n", 200)
	server := &Server{
		assets: fstest.MapFS{
			"assets/main-abc123.js": &fstest.MapFile{Data: []byte(source)},
		},
		assetCache: newCompressedAssetCache(),
	}
	request := httptest.NewRequest(http.MethodGet, "/assets/main-abc123.js", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	recorder := httptest.NewRecorder()

	if !server.serveCompressedAsset(recorder, request) {
		t.Fatal("expected asset to be served compressed")
	}
	response := recorder.Result()
	defer response.Body.Close()
	if got := response.Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := response.Header.Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Fatalf("Cache-Control = %q, want immutable", got)
	}
	reader, err := gzip.NewReader(response.Body)
	if err != nil {
		t.Fatalf("gzip.NewReader failed: %v", err)
	}
	decoded, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read compressed body failed: %v", err)
	}
	if string(decoded) != source {
		t.Fatalf("decoded body mismatch: got %d bytes want %d", len(decoded), len(source))
	}

	// 第二次命中缓存，仍应返回同样的内容。
	second := httptest.NewRecorder()
	if !server.serveCompressedAsset(second, request.Clone(request.Context())) {
		t.Fatal("expected cached asset to be served compressed")
	}
}

func TestWithGzipJSONCompressesInvokeResponse(t *testing.T) {
	handler := withGzipJSON(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = w.Write([]byte(`{"result":"ok"}`))
	}))
	request := httptest.NewRequest(http.MethodPost, "/__gonavi/api/invoke", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	response := recorder.Result()
	defer response.Body.Close()
	if got := response.Header.Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	reader, err := gzip.NewReader(response.Body)
	if err != nil {
		t.Fatalf("gzip.NewReader failed: %v", err)
	}
	payload, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read compressed body failed: %v", err)
	}
	if string(payload) != `{"result":"ok"}` {
		t.Fatalf("unexpected decoded payload: %s", payload)
	}
}

func TestWithGzipJSONSkipsClientsWithoutGzip(t *testing.T) {
	handler := withGzipJSON(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"result":"ok"}`))
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/__gonavi/api/invoke", nil))
	if got := recorder.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("unexpected Content-Encoding %q", got)
	}
	if recorder.Body.String() != `{"result":"ok"}` {
		t.Fatalf("unexpected body: %s", recorder.Body.String())
	}
}
