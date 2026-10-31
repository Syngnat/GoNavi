package webserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// newMemstatsTestServer 构造只挂鉴权所需字段的最小 Server，并走完 /setup
// 初始化流程返回一个已认证会话 ID。handleDebugMemstats 不依赖 app/assets，
// 与 file_transfer 测试的全量 Server 相比这里无需拉起应用生命周期。
func newMemstatsTestServer(t *testing.T) (*Server, string) {
	t.Helper()
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
	return &Server{auth: manager}, sessionID
}

func TestDebugMemstatsRouteRequiresAuthentication(t *testing.T) {
	server, sessionID := newMemstatsTestServer(t)
	handler := server.routes()
	url := internalRoutePrefix + "/debug/memstats"

	unauthorized := httptest.NewRequest(http.MethodGet, url, nil)
	unauthorizedRecorder := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedRecorder, unauthorized)
	if unauthorizedRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d, body=%s", unauthorizedRecorder.Code, unauthorizedRecorder.Body.String())
	}

	authorized := httptest.NewRequest(http.MethodGet, url, nil)
	authorized.AddCookie(&http.Cookie{Name: webSessionCookieName, Value: sessionID})
	authorizedRecorder := httptest.NewRecorder()
	handler.ServeHTTP(authorizedRecorder, authorized)
	if authorizedRecorder.Code != http.StatusOK {
		t.Fatalf("authorized status = %d, body=%s", authorizedRecorder.Code, authorizedRecorder.Body.String())
	}
	var payload debugMemstatsPayload
	if err := json.Unmarshal(authorizedRecorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode memstats response: %v", err)
	}
	if payload.HeapAlloc == 0 || payload.Sys == 0 {
		t.Fatalf("memstats payload missing live values: %+v", payload)
	}
	if payload.NumGoroutine <= 0 {
		t.Fatalf("numGoroutine = %d, want positive", payload.NumGoroutine)
	}
	if payload.GoMemLimit <= 0 {
		t.Fatalf("goMemLimit = %d, want positive", payload.GoMemLimit)
	}
	if payload.GOGCPercent < 0 {
		t.Fatalf("gogcPercent = %d, want non-negative", payload.GOGCPercent)
	}
}

func TestDebugMemstatsRejectsNonGet(t *testing.T) {
	server, sessionID := newMemstatsTestServer(t)
	handler := server.routes()
	request := httptest.NewRequest(http.MethodPost, internalRoutePrefix+"/debug/memstats", nil)
	request.AddCookie(&http.Cookie{Name: webSessionCookieName, Value: sessionID})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want %d", recorder.Code, http.StatusMethodNotAllowed)
	}
}
