package nativewindow

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestPluginWindowCapabilityRoutesCallerScope(t *testing.T) {
	c, _ := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	c.mu.Lock()
	c.capability = func(_ context.Context, id string, generation uint64, method string, args json.RawMessage) (json.RawMessage, error) {
		if id != "test.one" || generation != 1 || method != "metadata.tables" {
			t.Errorf("unexpected scope: %s/%d/%s", id, generation, method)
		}
		if string(args) != `{"connectionId":"conn-1","database":"app"}` {
			t.Errorf("arguments = %s", args)
		}
		return json.RawMessage(`{"ok":true,"data":{"tables":["users"]}}`), nil
	}
	c.mu.Unlock()

	response := servePluginTest(c, entry, http.MethodPost, pluginBridgePrefix+"capability",
		`{"id":"cap-1","method":"metadata.tables","arguments":{"connectionId":"conn-1","database":"app"}}`)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "users") {
		t.Fatalf("capability response: %d %s", response.Code, response.Body.String())
	}
	for _, body := range []string{
		`{"id":"a","method":""}`,
		`{"id":"a","method":"metadata.tables","pluginId":"test.other"}`,
		`{"id":"a","method":"metadata.tables"} {}`,
		`{"id":"a","method":"metadata.tables","arguments":"` + strings.Repeat("x", pluginMaxJSONBytes) + `"}`,
	} {
		response := servePluginTest(c, entry, http.MethodPost, pluginBridgePrefix+"capability", body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid capability request accepted: %d %s", response.Code, body)
		}
	}
}

func TestPluginWindowCapabilityUnavailableWithoutCallback(t *testing.T) {
	c, _ := newPluginTestController(t)
	entry := openPluginTestWindow(t, c, "test.one")
	response := servePluginTest(c, entry, http.MethodPost, pluginBridgePrefix+"capability",
		`{"id":"cap-1","method":"app.info"}`)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
}
