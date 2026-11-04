package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

func replaceConfirmDialog(t *testing.T, answer string) {
	t.Helper()
	previous := pluginConfirmDialog
	pluginConfirmDialog = func(context.Context, wailsRuntime.MessageDialogOptions) (string, error) { return answer, nil }
	t.Cleanup(func() { pluginConfirmDialog = previous })
}

func TestPluginCapabilityDialogConfirmReturnsTheChoice(t *testing.T) {
	a := newPluginTestApp(t)
	replaceConfirmDialog(t, "Delete")
	value, code := pluginCapabilityDialogConfirm(context.Background(), a, pluginCapabilityRequest{
		Arguments: json.RawMessage(`{"title":"确认","message":"删除这个文件？","confirmText":"Delete","cancelText":"Cancel"}`),
	})
	if code != "" || value.(map[string]any)["confirmed"] != true {
		t.Fatalf("confirm failed: %s %#v", code, value)
	}
	value, code = pluginCapabilityDialogConfirm(context.Background(), a, pluginCapabilityRequest{
		Arguments: json.RawMessage(`{"message":"继续？","confirmText":"Yes","cancelText":"No"}`),
	})
	if code != "" || value.(map[string]any)["confirmed"] != false {
		t.Fatalf("cancel must return false: %s %#v", code, value)
	}
}

func TestPluginCapabilityDialogConfirmRejectsUnsafeArguments(t *testing.T) {
	a := newPluginTestApp(t)
	replaceConfirmDialog(t, "OK")
	cases := []string{
		`{}`,
		`{"message":""}`,
		`{"message":"` + strings.Repeat("x", pluginDialogMaxMessage+1) + `"}`,
		`{"message":"ok","confirmText":"` + strings.Repeat("x", pluginDialogMaxLabel+1) + `"}`,
		`{"message":"ok","unknown":true}`,
	}
	for _, raw := range cases {
		if _, code := pluginCapabilityDialogConfirm(context.Background(), a, pluginCapabilityRequest{Arguments: json.RawMessage(raw)}); code != "invalid_arguments" {
			t.Fatalf("unsafe dialog arguments accepted: %s -> %s", raw, code)
		}
	}
}

func TestPluginCapabilityDialogConfirmDeclinesWebRuntime(t *testing.T) {
	a := newPluginTestApp(t)
	a.webRuntime = true
	if _, code := pluginCapabilityDialogConfirm(context.Background(), a, pluginCapabilityRequest{
		Arguments: json.RawMessage(`{"message":"ok"}`),
	}); code != "unsupported" {
		t.Fatalf("web runtime must decline: %s", code)
	}
}
