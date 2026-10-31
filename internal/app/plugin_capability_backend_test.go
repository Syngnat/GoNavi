package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func decodePluginCapabilityEnvelope(t *testing.T, raw json.RawMessage) (bool, string) {
	t.Helper()
	var envelope struct {
		OK    bool `json:"ok"`
		Error *struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("decode envelope %s: %v", raw, err)
	}
	code := ""
	if envelope.Error != nil {
		code = envelope.Error.Code
	}
	return envelope.OK, code
}

func TestPluginCapabilityBackendCallUsesSharedRegistry(t *testing.T) {
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.backend", plugin.QueryReadPermission),
		Generation:     3,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	a := &App{}
	ctx := context.Background()

	raw, err := a.pluginCapabilityBackendCall(ctx, status, "app.info", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code := decodePluginCapabilityEnvelope(t, raw)
	if !ok || code != "" {
		t.Fatalf("app.info envelope = %s", raw)
	}

	raw, err = a.pluginCapabilityBackendCall(ctx, status, "metadata.views", json.RawMessage(`{"connectionId":"missing","database":"db"}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "permission_denied" {
		t.Fatalf("metadata.views envelope = %s", raw)
	}

	raw, err = a.pluginCapabilityBackendCall(ctx, status, "unknown.method", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "unknown_method" {
		t.Fatalf("unknown method envelope = %s", raw)
	}

	raw, err = a.pluginCapabilityBackendCall(ctx, status, "query.read", json.RawMessage(`[1]`))
	if err != nil {
		t.Fatal(err)
	}
	ok, code = decodePluginCapabilityEnvelope(t, raw)
	if ok || code != "invalid_arguments" {
		t.Fatalf("invalid arguments envelope = %s", raw)
	}
}

func TestPluginHostCapabilityRejectsMalformedParamsBeforeRuntime(t *testing.T) {
	a := &App{}
	for _, params := range []json.RawMessage{
		json.RawMessage(`[1]`),
		json.RawMessage(`{"method":""}`),
		json.RawMessage(`{"method":"app.info","unexpected":true}`),
	} {
		raw, err := a.pluginHostCapability(context.Background(), "test.backend", 1, params)
		if err != nil {
			t.Fatalf("malformed params returned transport error: %v", err)
		}
		ok, code := decodePluginCapabilityEnvelope(t, raw)
		if ok || code != "invalid_arguments" {
			t.Fatalf("params %s envelope = %s", params, raw)
		}
	}
}
