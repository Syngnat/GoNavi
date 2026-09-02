package mcpserver

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	httpserverlimits "GoNavi-Wails/internal/httpserver"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type closeTrackingBackend struct {
	*fakeBackend
	closed chan struct{}
}

func (b *closeTrackingBackend) Close(context.Context) error {
	close(b.closed)
	return nil
}

type bearerTokenRoundTripper struct {
	token string
	base  http.RoundTripper
}

func (t bearerTokenRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	request.Header = request.Header.Clone()
	request.Header.Set("Authorization", "Bearer "+t.token)
	return t.base.RoundTrip(request)
}

func TestStartStreamableHTTPServerStopsWhenContextIsCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	handle, err := StartStreamableHTTPServer(ctx, &fakeBackend{}, HTTPServerOptions{
		Addr:  "127.0.0.1:0",
		Path:  "/mcp",
		Token: "test-token",
	})
	if err != nil {
		t.Fatalf("StartStreamableHTTPServer returned error: %v", err)
	}

	if handle.Addr == "" {
		t.Fatal("StartStreamableHTTPServer returned an empty listener address")
	}
	cancel()

	if err := handle.Wait(); err != nil {
		t.Fatalf("HTTP server returned error after context cancellation: %v", err)
	}
}

func TestStreamableHTTPServerWaitsForActiveHandlerBeforeClosingBackend(t *testing.T) {
	const shutdownTimeout = 20 * time.Millisecond

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	backend := &closeTrackingBackend{
		fakeBackend: &fakeBackend{},
		closed:      make(chan struct{}),
	}
	handlerStarted := make(chan struct{})
	releaseHandler := make(chan struct{}, 1)
	t.Cleanup(func() {
		select {
		case releaseHandler <- struct{}{}:
		default:
		}
	})
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(handlerStarted)
		<-releaseHandler
		w.WriteHeader(http.StatusNoContent)
	})

	handle, err := startStreamableHTTPServer(ctx, HTTPServerOptions{
		Addr:  "127.0.0.1:0",
		Path:  "/mcp",
		Token: "test-token",
	}, handler, shutdownTimeout)
	if err != nil {
		t.Fatalf("startStreamableHTTPServer returned error: %v", err)
	}
	closeBackendAfterServerStops(handle, backend)

	requestDone := make(chan error, 1)
	go func() {
		req, err := http.NewRequest(http.MethodPost, "http://"+handle.Addr+handle.Path, nil)
		if err != nil {
			requestDone <- err
			return
		}
		req.Header.Set("Authorization", "Bearer test-token")
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			_ = resp.Body.Close()
		}
		requestDone <- err
	}()

	select {
	case <-handlerStarted:
	case <-time.After(time.Second):
		t.Fatal("handler did not start")
	}

	cancel()
	stopCtx, stopCancel := context.WithTimeout(context.Background(), 3*shutdownTimeout)
	defer stopCancel()
	if err := handle.Stop(stopCtx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Stop returned %v while handler was still active, want deadline exceeded", err)
	}
	select {
	case <-backend.closed:
		t.Fatal("backend closed while handler was still active")
	default:
	}

	releaseHandler <- struct{}{}
	if err := <-requestDone; err != nil {
		t.Fatalf("request returned error after handler release: %v", err)
	}
	if err := handle.Wait(); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Wait returned %v after shutdown timeout, want deadline exceeded", err)
	}
	select {
	case <-backend.closed:
	case <-time.After(time.Second):
		t.Fatal("backend did not close after handler completed")
	}
}

func TestStreamableHTTPRoutesRejectOversizeBeforeSDKHandler(t *testing.T) {
	var called atomic.Bool
	handler := streamableHTTPRoutes(HTTPServerOptions{Path: "/mcp", Token: "test-token"}, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called.Store(true)
		w.WriteHeader(http.StatusNoContent)
	}))

	request := httptest.NewRequest(http.MethodPost, "/mcp", bytes.NewReader(bytes.Repeat([]byte("x"), int(httpserverlimits.MaxRequestBodyBytes+1))))
	request.Header.Set("Authorization", "Bearer test-token")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d; body=%q", recorder.Code, http.StatusRequestEntityTooLarge, recorder.Body.String())
	}
	if called.Load() {
		t.Fatal("MCP SDK handler was called for an oversized body")
	}
}

func TestStreamableHTTPRoutesPassNormalBody(t *testing.T) {
	var body string
	handler := streamableHTTPRoutes(HTTPServerOptions{Path: "/mcp", Token: "test-token", JSONResponse: true}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read body in SDK handler: %v", err)
		}
		body = string(payload)
		w.WriteHeader(http.StatusNoContent)
	}))

	request := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0"}`))
	request.Header.Set("Authorization", "Bearer test-token")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNoContent)
	}
	if body != `{"jsonrpc":"2.0"}` {
		t.Fatalf("SDK handler body = %q", body)
	}
}

func TestStartStreamableHTTPServerSupportsNormalSessionAndSSE(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	handle, err := StartStreamableHTTPServer(ctx, &fakeBackend{}, HTTPServerOptions{
		Addr:  "127.0.0.1:0",
		Path:  "/mcp",
		Token: "test-token",
	})
	if err != nil {
		t.Fatalf("StartStreamableHTTPServer returned error: %v", err)
	}
	t.Cleanup(func() {
		stopCtx, stopCancel := context.WithTimeout(context.Background(), time.Second)
		defer stopCancel()
		if err := handle.Stop(stopCtx); err != nil {
			t.Errorf("stop Streamable HTTP server: %v", err)
		}
	})

	transport := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(transport.CloseIdleConnections)
	httpClient := &http.Client{Transport: bearerTokenRoundTripper{token: "test-token", base: transport}}
	client := mcp.NewClient(&mcp.Implementation{Name: "run-test-client", Version: "v0.0.1"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint:   "http://" + handle.Addr + handle.Path,
		HTTPClient: httpClient,
	}, nil)
	if err != nil {
		t.Fatalf("connect Streamable HTTP client: %v", err)
	}
	defer session.Close()

	result, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("list tools over normal MCP session: %v", err)
	}
	if len(result.Tools) == 0 {
		t.Fatal("normal MCP session returned no tools")
	}
}

func TestParseHTTPServerOptionsSupportsFlagsAndEnvFallback(t *testing.T) {
	t.Setenv("GONAVI_MCP_HTTP_ADDR", "127.0.0.1:9000")
	t.Setenv("GONAVI_MCP_HTTP_PATH", "/env-mcp")
	t.Setenv("GONAVI_MCP_HTTP_TOKEN", "env-token")

	options, err := ParseHTTPServerOptions([]string{
		"--addr", "127.0.0.1:8765",
		"--path", "mcp",
		"--token", "flag-token",
		"--schema-only",
		"--json-response=false",
	})
	if err != nil {
		t.Fatalf("ParseHTTPServerOptions returned error: %v", err)
	}
	normalized, err := normalizeHTTPServerOptions(options)
	if err != nil {
		t.Fatalf("normalizeHTTPServerOptions returned error: %v", err)
	}

	if normalized.Addr != "127.0.0.1:8765" {
		t.Fatalf("expected addr from flag, got %q", normalized.Addr)
	}
	if normalized.Path != "/mcp" {
		t.Fatalf("expected normalized path /mcp, got %q", normalized.Path)
	}
	if normalized.Token != "flag-token" {
		t.Fatalf("expected token from flag, got %q", normalized.Token)
	}
	if normalized.JSONResponse {
		t.Fatal("expected json response flag to be false")
	}
	if !normalized.SchemaOnly {
		t.Fatal("expected schema-only flag to be true")
	}
}

func TestNormalizeHTTPServerOptionsRejectsNonLoopbackAddresses(t *testing.T) {
	for _, addr := range []string{"0.0.0.0:8765", ":8765", "192.0.2.10:8765", "[::]:8765"} {
		if _, err := normalizeHTTPServerOptions(HTTPServerOptions{Addr: addr, Path: "/mcp", Token: "secret"}); err == nil {
			t.Fatalf("normalizeHTTPServerOptions(%q) unexpectedly succeeded", addr)
		}
	}
	for _, addr := range []string{"127.0.0.1:8765", "localhost:8765", "[::1]:8765"} {
		if _, err := normalizeHTTPServerOptions(HTTPServerOptions{Addr: addr, Path: "/mcp", Token: "secret"}); err != nil {
			t.Fatalf("normalizeHTTPServerOptions(%q) returned error: %v", addr, err)
		}
	}
}

func TestNormalizeHTTPServerOptionsAllowsNonLoopbackWithExplicitEnvOptIn(t *testing.T) {
	t.Setenv("GONAVI_MCP_HTTP_ADDR", "0.0.0.0:8765")
	t.Setenv("GONAVI_MCP_HTTP_TOKEN", "secret")
	t.Setenv("GONAVI_MCP_HTTP_ALLOW_NON_LOOPBACK", "true")

	options, err := ParseHTTPServerOptions(nil)
	if err != nil {
		t.Fatalf("ParseHTTPServerOptions returned error: %v", err)
	}
	if _, err := normalizeHTTPServerOptions(options); err != nil {
		t.Fatalf("explicit non-loopback env opt-in returned error: %v", err)
	}
}

func TestNormalizeHTTPServerOptionsAllowsNonLoopbackWithExplicitFlagOptIn(t *testing.T) {
	options, err := ParseHTTPServerOptions([]string{
		"--addr", "0.0.0.0:8765",
		"--token", "secret",
		"--allow-non-loopback",
	})
	if err != nil {
		t.Fatalf("ParseHTTPServerOptions returned error: %v", err)
	}
	if _, err := normalizeHTTPServerOptions(options); err != nil {
		t.Fatalf("explicit non-loopback flag opt-in returned error: %v", err)
	}
}

func TestNormalizeHTTPServerOptionsRequiresBearerToken(t *testing.T) {
	_, err := normalizeHTTPServerOptions(HTTPServerOptions{Addr: "127.0.0.1:8765", Path: "/mcp"})
	if err == nil || !strings.Contains(err.Error(), "bearer token") {
		t.Fatalf("expected missing bearer token error, got %v", err)
	}

	_, err = normalizeHTTPServerOptions(HTTPServerOptions{
		Addr:             "0.0.0.0:8765",
		Path:             "/mcp",
		AllowNonLoopback: true,
	})
	if err == nil || !strings.Contains(err.Error(), "bearer token") {
		t.Fatalf("expected non-loopback opt-in to keep requiring a bearer token, got %v", err)
	}
}

func TestBearerTokenAuthHandlerRejectsMissingOrWrongToken(t *testing.T) {
	called := false
	handler := bearerTokenAuthHandler("secret-token", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}))

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/mcp", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected missing token to return 401, got %d", recorder.Code)
	}
	if called {
		t.Fatal("next handler should not be called without token")
	}

	recorder = httptest.NewRecorder()
	wrongReq := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	wrongReq.Header.Set("Authorization", "Bearer wrong")
	handler.ServeHTTP(recorder, wrongReq)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected wrong token to return 401, got %d", recorder.Code)
	}
	if called {
		t.Fatal("next handler should not be called with wrong token")
	}

	recorder = httptest.NewRecorder()
	validReq := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	validReq.Header.Set("Authorization", "Bearer secret-token")
	handler.ServeHTTP(recorder, validReq)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("expected valid token to pass, got %d", recorder.Code)
	}
	if !called {
		t.Fatal("next handler should be called with valid token")
	}
}
