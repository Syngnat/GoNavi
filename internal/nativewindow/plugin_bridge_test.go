package nativewindow

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPluginBridgeRejectsSharedRPCAndWrongCapabilities(t *testing.T) {
	c, _ := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	tests := []struct {
		name, path, token, id, host string
		status                      int
	}{
		{"missing token", pluginBridgePrefix + "bootstrap", "", entry.info.ID, "", 401},
		{"shared App token", pluginBridgePrefix + "bootstrap", "host-detached-secret", entry.info.ID, "", 401},
		{"wrong window", pluginBridgePrefix + "bootstrap", entry.token, "other-window", "", 401},
		{"wrong host", pluginBridgePrefix + "bootstrap", entry.token, entry.info.ID, "evil.example", 401},
		{"main RPC", InvokePath, entry.token, entry.info.ID, "", 404},
		{"main runtime", RuntimePath, entry.token, entry.info.ID, "", 404},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := pluginTestRequest(c, entry, http.MethodGet, test.path, "")
			request.Header.Set(pluginTokenHeader, test.token)
			request.Header.Set(pluginWindowHeader, test.id)
			if test.host != "" {
				request.Host = test.host
			}
			recorder := httptest.NewRecorder()
			c.serveHTTP(recorder, request)
			if recorder.Code != test.status {
				t.Fatalf("status=%d want=%d", recorder.Code, test.status)
			}
		})
	}
}

func TestPluginBridgeInvokeCannotSelectAnotherPluginOrMethod(t *testing.T) {
	c, runtime := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	runtime.invoke = func(_ context.Context, id string, generation uint64, command string, args json.RawMessage) (json.RawMessage, error) {
		if id != "test.one" || generation != 1 || command != "echo" {
			t.Errorf("unexpected scope: %s/%d/%s", id, generation, command)
		}
		return args, nil
	}
	response := servePluginTest(c, entry, http.MethodPost, pluginBridgePrefix+"invoke", `{"id":"request-1","command":"echo","arguments":{"answer":42}}`)
	if response.Code != 200 || !strings.Contains(response.Body.String(), "42") {
		t.Fatal(response.Body.String())
	}
	for _, body := range []string{
		`{"id":"a","command":"echo","pluginId":"test.other"}`,
		`{"id":"a","method":"App.DBQuery"}`,
		`{"id":"a","command":"echo"} {}`,
		`{"id":"a","command":"echo","arguments":"` + strings.Repeat("x", pluginMaxJSONBytes) + `"}`,
	} {
		response := servePluginTest(c, entry, http.MethodPost, pluginBridgePrefix+"invoke", body)
		if response.Code != 400 {
			t.Fatalf("invalid request accepted: %d", response.Code)
		}
	}
}

func TestPluginBridgeCancellationAndRevocation(t *testing.T) {
	for _, mode := range []string{"cancel-route", "request-context", "revoke"} {
		t.Run(mode, func(t *testing.T) {
			c, runtime := newPluginTestController(t)
			entry := openPluginTestWindow(t, c, "test.one")
			entered := make(chan struct{})
			finished := make(chan struct{})
			runtime.invoke = func(ctx context.Context, _ string, _ uint64, _ string, _ json.RawMessage) (json.RawMessage, error) {
				close(entered)
				<-ctx.Done()
				close(finished)
				return nil, ctx.Err()
			}
			request := pluginTestRequest(c, entry, http.MethodPost, pluginBridgePrefix+"invoke", `{"id":"blocking","command":"wait"}`)
			ctx, cancel := context.WithCancel(request.Context())
			defer cancel()
			request = request.WithContext(ctx)
			response := httptest.NewRecorder()
			returned := make(chan struct{})
			go func() { c.serveHTTP(response, request); close(returned) }()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("invoke never entered")
			}
			switch mode {
			case "cancel-route":
				canceled := servePluginTest(c, entry, http.MethodPost, pluginBridgePrefix+"cancel", `{"id":"blocking"}`)
				if canceled.Code != 204 {
					t.Fatal(canceled.Body.String())
				}
			case "request-context":
				cancel()
			case "revoke":
				c.Revoke("test.one")
			}
			awaitPluginDone(t, finished)
			awaitPluginDone(t, returned)
			if response.Code == 200 {
				t.Fatal("canceled request produced success")
			}
		})
	}
}

func TestPluginBridgeCancelBeforeInvokeAndBoundedConcurrency(t *testing.T) {
	c, _ := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	canceled := servePluginTest(c, entry, http.MethodPost, pluginBridgePrefix+"cancel", `{"id":"early"}`)
	if canceled.Code != 204 {
		t.Fatal(canceled.Body.String())
	}
	if _, release, err := c.beginInvoke(context.Background(), entry, "early"); err == nil {
		release()
		t.Fatal("early cancellation did not fence late invoke")
	}
	var releases []func()
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		_, release, err := c.beginInvoke(context.Background(), entry, id)
		if err != nil {
			t.Fatal(err)
		}
		releases = append(releases, release)
	}
	defer func() {
		for _, release := range releases {
			release()
		}
	}()
	if _, release, err := c.beginInvoke(context.Background(), entry, "extra"); err == nil {
		release()
		t.Fatal("unbounded pending calls")
	}
	// Control/heartbeat remains usable while all command slots are occupied.
	beat := servePluginTest(c, entry, http.MethodPost, pluginBridgePrefix+"heartbeat", `{"sequence":1}`)
	if beat.Code != 200 {
		t.Fatal("busy commands blocked heartbeat")
	}
	c.Revoke("test.one")
	awaitPluginDone(t, entry.done)
}

func TestPluginBridgeFencesLateResponse(t *testing.T) {
	c, runtime := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	runtime.invoke = func(context.Context, string, uint64, string, json.RawMessage) (json.RawMessage, error) {
		runtime.mu.Lock()
		runtime.statuses[0].Generation++
		runtime.mu.Unlock()
		return json.RawMessage(`{"stale":true}`), nil
	}
	response := servePluginTest(c, entry, http.MethodPost, pluginBridgePrefix+"invoke", `{"id":"late","command":"echo"}`)
	if response.Code != 410 || strings.Contains(response.Body.String(), "stale") {
		t.Fatal("late response crossed generation fence")
	}
}
