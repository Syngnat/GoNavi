package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPluginPageResultLimit(t *testing.T) {
	if code := pluginPageResultCode(strings.Repeat("a", pluginPageMaxResultBytes)); code != "result_too_large" {
		t.Fatalf("code = %q, want result_too_large", code)
	}
	if code := pluginPageResultCode(map[string]any{"ok": true}); code != "" {
		t.Fatalf("small result rejected: %q", code)
	}
	if code := pluginPageResultCode(func() {}); code != "internal" {
		t.Fatalf("unencodable result code = %q, want internal", code)
	}
}

func TestPluginPageCallRejectsWebRuntimeBeforeTouchingStorage(t *testing.T) {
	a := &App{configDir: t.TempDir(), webRuntime: true}
	requirePluginPageFailure(t, a.PluginPageCall("test.pages", "overview", "app.info", "{}"), "management_denied")
	if _, err := os.Stat(filepath.Join(a.configDir, "plugins")); !os.IsNotExist(err) {
		t.Fatalf("web rejection touched plugin storage: %v", err)
	}
}

func TestPluginPageCallRejectsInvalidIdentityBeforeStatusLookup(t *testing.T) {
	a := &App{configDir: t.TempDir(), ctx: context.Background()}
	requirePluginPageFailure(t, a.PluginPageCall("", "overview", "app.info", "{}"), "page_invalid_identity")
	requirePluginPageFailure(t, a.PluginPageCall("test.pages", strings.Repeat("a", pluginPageMaxIdentityBytes+1), "app.info", "{}"), "page_invalid_identity")
}

func TestPluginPageArgumentsNormalization(t *testing.T) {
	if string(pluginPageArgumentsRaw("  ")) != "{}" {
		t.Fatal("blank arguments did not normalize to an object")
	}
	if string(pluginPageArgumentsRaw(` {"a":1} `)) != `{"a":1}` {
		t.Fatal("arguments were not trimmed")
	}
}
