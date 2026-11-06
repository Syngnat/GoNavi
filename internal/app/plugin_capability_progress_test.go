package app

import (
	"context"
	"encoding/json"
	"testing"

	"GoNavi-Wails/internal/plugin"
	"GoNavi-Wails/internal/uievents"
)

type progressRecorder struct {
	names    []string
	payloads []map[string]any
}

func (r *progressRecorder) Emit(name string, args ...any) {
	r.names = append(r.names, name)
	if len(args) > 0 {
		if payload, ok := args[0].(map[string]any); ok {
			r.payloads = append(r.payloads, payload)
		}
	}
}

func progressTestRequest(raw string) pluginCapabilityRequest {
	return pluginCapabilityRequest{
		Status:    plugin.Status{Manifest: plugin.Manifest{ID: "test.progress"}},
		Arguments: json.RawMessage(raw),
	}
}

func TestPluginCapabilityProgressEmitsBoundedEvents(t *testing.T) {
	a := newPluginTestApp(t)
	recorder := &progressRecorder{}
	a.ctx = uievents.WithEmitter(context.Background(), recorder)

	value, code := pluginCapabilityProgress(context.Background(), a, progressTestRequest(`{"id":"upload","action":"open","title":"上传","detail":"2/10","percent":20}`))
	if code != "" || value.(map[string]any)["accepted"] != true {
		t.Fatalf("open failed: %s %#v", code, value)
	}
	if _, code = pluginCapabilityProgress(context.Background(), a, progressTestRequest(`{"id":"upload","action":"update","percent":80}`)); code != "" {
		t.Fatalf("update failed: %s", code)
	}
	if _, code = pluginCapabilityProgress(context.Background(), a, progressTestRequest(`{"id":"upload","action":"close"}`)); code != "" {
		t.Fatalf("close failed: %s", code)
	}
	if len(recorder.payloads) != 3 {
		t.Fatalf("expected three events, got %d", len(recorder.payloads))
	}
	if recorder.names[0] != pluginProgressEventName || recorder.payloads[0]["pluginId"] != "test.progress" {
		t.Fatalf("unexpected event: %s %#v", recorder.names[0], recorder.payloads[0])
	}
	if recorder.payloads[1]["percent"] != 80 || recorder.payloads[2]["action"] != "close" {
		t.Fatalf("unexpected payloads: %#v", recorder.payloads)
	}
}

func TestPluginCapabilityProgressRejectsUnsafeArguments(t *testing.T) {
	a := newPluginTestApp(t)
	a.ctx = uievents.WithEmitter(context.Background(), &progressRecorder{})
	cases := []string{
		`{"id":"","action":"open","title":"x"}`,
		`{"id":"a","action":"open"}`,
		`{"id":"a","action":"update","percent":101}`,
		`{"id":"a","action":"update","percent":-1}`,
		`{"id":"a","action":"remove"}`,
		`{"id":"a","action":"open","title":"x","unknown":true}`,
		`{"id":"` + string(make([]byte, 300)) + `","action":"open","title":"x"}`,
	}
	for _, raw := range cases {
		if _, code := pluginCapabilityProgress(context.Background(), a, progressTestRequest(raw)); code != "invalid_arguments" {
			t.Fatalf("unsafe arguments accepted: %s -> %s", raw, code)
		}
	}
}

func TestPluginCapabilityProgressDeclinesWebRuntime(t *testing.T) {
	a := newPluginTestApp(t)
	a.webRuntime = true
	if _, code := pluginCapabilityProgress(context.Background(), a, progressTestRequest(`{"id":"a","action":"close"}`)); code != "unsupported" {
		t.Fatalf("web runtime must decline: %s", code)
	}
}
