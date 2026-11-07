package nativewindow

import "testing"

func TestOpenEventPayloadAppliesBoundsWithoutMutatingSource(t *testing.T) {
	resultWindow := map[string]any{"id": "query-result:1", "x": 1, "y": 2, "width": 300, "height": 200}
	payload := map[string]any{
		"tab":          map[string]any{"id": "query-1"},
		"resultWindow": resultWindow,
		"ignored":      true,
	}
	bounds := &WindowBounds{X: 10, Y: 20, Width: 800, Height: 600}

	got, ok := openEventPayload(payload, bounds).(map[string]any)
	if !ok {
		t.Fatalf("openEventPayload returned %T", openEventPayload(payload, bounds))
	}
	corrected := got["resultWindow"].(map[string]any)
	if corrected["x"] != 10 || corrected["y"] != 20 || corrected["width"] != 800 || corrected["height"] != 600 {
		t.Fatalf("resultWindow bounds = %#v", corrected)
	}
	if _, exists := got["ignored"]; exists {
		t.Fatalf("unexpected field copied: %#v", got)
	}
	if resultWindow["x"] != 1 || resultWindow["width"] != 300 {
		t.Fatalf("source resultWindow was mutated: %#v", resultWindow)
	}
}

func TestWithOwnerWindowIDCopiesPayload(t *testing.T) {
	payload := map[string]any{"revision": float64(3)}
	got := withOwnerWindowID(payload, " workbench:tab-1 ").(map[string]any)
	if got["ownerWindowId"] != "workbench:tab-1" {
		t.Fatalf("ownerWindowId = %#v", got["ownerWindowId"])
	}
	if _, exists := payload["ownerWindowId"]; exists {
		t.Fatalf("source payload was mutated: %#v", payload)
	}
	unchanged, ok := withOwnerWindowID(payload, "  ").(map[string]any)
	if !ok {
		t.Fatalf("empty owner returned %T", withOwnerWindowID(payload, "  "))
	}
	if _, exists := unchanged["ownerWindowId"]; exists {
		t.Fatalf("empty owner should not stamp the payload: %#v", unchanged)
	}
}
