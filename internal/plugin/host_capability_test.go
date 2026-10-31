package plugin

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestHostCapabilityForwardsCallerBoundRequest(t *testing.T) {
	m := testManager(t)
	var seen json.RawMessage
	m.opts.HostCapability = func(_ context.Context, pluginID string, generation uint64, params json.RawMessage) (json.RawMessage, error) {
		seen = append(json.RawMessage(nil), params...)
		if pluginID != "example.hostcap" || generation == 0 {
			t.Fatalf("caller binding = %q %d", pluginID, generation)
		}
		return json.RawMessage(`{"ok":true,"data":{"pluginId":"example.hostcap"}}`), nil
	}
	status := installHostLogMode(t, m, "example.hostcap", "host-capability", true)
	enableFixture(t, m, status.Manifest.ID)
	if err := m.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitState(t, m, status.Manifest.ID, StateRunning)
	body := waitHostLogResponse(t, m, status.Manifest.ID)
	if !strings.Contains(body, `"ok":true`) || !strings.Contains(body, "example.hostcap") {
		t.Fatalf("host capability response: %s", body)
	}
	var params struct {
		Method string `json:"method"`
	}
	if err := json.Unmarshal(seen, &params); err != nil || params.Method != "app.info" {
		t.Fatalf("forwarded params = %s", seen)
	}
}
