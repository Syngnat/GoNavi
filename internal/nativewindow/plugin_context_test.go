package nativewindow

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestPluginWindowContextAndMultiOpen(t *testing.T) {
	c, _ := newPluginTestController(t)
	first, err := c.Open(context.Background(), "test.one", "action:conn-1", json.RawMessage(`{"connectionId":"conn-1","readOnly":true}`), "", "")
	if err != nil {
		t.Fatal(err)
	}
	second, err := c.Open(context.Background(), "test.one", "action:conn-2", json.RawMessage(`{"connectionId":"conn-2"}`), "", "")
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == second.ID {
		t.Fatal("different connection actions reused one window")
	}
	same, err := c.Open(context.Background(), "test.one", "action:conn-1", json.RawMessage(`{"connectionId":"conn-1"}`), "", "")
	if err != nil || same.ID != first.ID {
		t.Fatalf("same action did not reuse window: %+v %v", same, err)
	}
	c.mu.Lock()
	entry := c.windows["action:conn-1"]
	c.mu.Unlock()
	response := servePluginTest(c, entry, http.MethodGet, pluginBridgePrefix+"bootstrap", "")
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"connectionId":"conn-1"`) {
		t.Fatalf("launch context missing from bootstrap: %d %s", response.Code, response.Body.String())
	}
}
