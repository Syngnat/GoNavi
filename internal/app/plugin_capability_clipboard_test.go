package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func replaceClipboard(t *testing.T, read string, written *string) {
	t.Helper()
	previousGet, previousSet := clipboardGetText, clipboardSetText
	clipboardGetText = func(context.Context) (string, error) { return read, nil }
	clipboardSetText = func(_ context.Context, text string) error {
		if written != nil {
			*written = text
		}
		return nil
	}
	t.Cleanup(func() { clipboardGetText, clipboardSetText = previousGet, previousSet })
}

func TestPluginCapabilityClipboardRoundTripsText(t *testing.T) {
	a := newPluginTestApp(t)
	var written string
	replaceClipboard(t, "copied", &written)

	value, code := pluginCapabilityClipboardRead(context.Background(), a, pluginCapabilityRequest{})
	if code != "" || value.(pluginClipboardReadResult).Text != "copied" {
		t.Fatalf("read failed: %s %#v", code, value)
	}
	value, code = pluginCapabilityClipboardWrite(context.Background(), a, pluginCapabilityRequest{
		Arguments: json.RawMessage(`{"text":"pasted"}`),
	})
	if code != "" || value.(map[string]any)["written"] != true || written != "pasted" {
		t.Fatalf("write failed: %s %#v %q", code, value, written)
	}
}

func TestPluginCapabilityClipboardTruncatesLargeReads(t *testing.T) {
	a := newPluginTestApp(t)
	replaceClipboard(t, strings.Repeat("x", pluginClipboardMaxRead+1), nil)
	value, code := pluginCapabilityClipboardRead(context.Background(), a, pluginCapabilityRequest{})
	if code != "" {
		t.Fatalf("read failed: %s", code)
	}
	result := value.(pluginClipboardReadResult)
	if !result.Truncated || len(result.Text) != pluginClipboardMaxRead {
		t.Fatalf("unexpected truncation: %#v", result)
	}
}

func TestPluginCapabilityClipboardRejectsUnsafeWrites(t *testing.T) {
	a := newPluginTestApp(t)
	replaceClipboard(t, "", nil)
	if _, code := pluginCapabilityClipboardWrite(context.Background(), a, pluginCapabilityRequest{
		Arguments: json.RawMessage(`{"text":"` + strings.Repeat("x", pluginClipboardMaxWrite+1) + `"}`),
	}); code != "invalid_arguments" {
		t.Fatalf("oversized write accepted: %s", code)
	}
	if _, code := pluginCapabilityClipboardWrite(context.Background(), a, pluginCapabilityRequest{
		Arguments: json.RawMessage(`{"text":"ok","unknown":true}`),
	}); code != "invalid_arguments" {
		t.Fatalf("unknown argument accepted: %s", code)
	}
}

func TestPluginCapabilityClipboardDeclinesWebRuntime(t *testing.T) {
	a := newPluginTestApp(t)
	a.webRuntime = true
	if _, code := pluginCapabilityClipboardRead(context.Background(), a, pluginCapabilityRequest{}); code != "unsupported" {
		t.Fatalf("web runtime must decline: %s", code)
	}
}
