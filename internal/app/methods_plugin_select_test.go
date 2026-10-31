package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestPluginPackageDialogDirectory(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "plugin.zip")
	if err := os.WriteFile(filePath, []byte("pkg"), 0o600); err != nil {
		t.Fatalf("prepare package file: %v", err)
	}
	nested := filepath.Join(root, "nested")
	if err := os.Mkdir(nested, 0o755); err != nil {
		t.Fatalf("prepare package directory: %v", err)
	}

	cases := []struct {
		name      string
		current   string
		directory bool
		want      string
	}{
		{name: "existing directory stays", current: nested, want: nested},
		{name: "existing file opens parent", current: filePath, want: root},
		{name: "missing archive opens parent", current: filepath.Join(root, "later.tgz"), want: root},
		{name: "missing directory path keeps itself", current: filepath.Join(root, "later"), directory: true, want: filepath.Join(root, "later")},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := pluginPackageDialogDirectory(testCase.current, testCase.directory); got != testCase.want {
				t.Fatalf("pluginPackageDialogDirectory(%q) = %q, want %q", testCase.current, got, testCase.want)
			}
		})
	}

	t.Run("empty path falls back to home", func(t *testing.T) {
		home, err := os.UserHomeDir()
		if err != nil {
			t.Skipf("home directory unavailable: %v", err)
		}
		if got := pluginPackageDialogDirectory("", false); got != home {
			t.Fatalf("pluginPackageDialogDirectory(\"\") = %q, want %q", got, home)
		}
	})
}

func TestPluginPackageDialogFiltersPreferArchives(t *testing.T) {
	filters := pluginPackageDialogFilters("Plugin package")
	if len(filters) != 1 {
		t.Fatalf("filters = %d, want 1", len(filters))
	}
	if filters[0].Pattern != "*.zip;*.tgz;*.gz" {
		t.Fatalf("archive pattern = %q", filters[0].Pattern)
	}
}

// macOS maps each token to UTType(filenameExtension:) and inserts the result into the
// panel's content types. A nil result is inserted as nil and aborts the process, so every
// token must be a bare extension: one leading "*." and a dot-free remainder.
func TestPluginPackageDialogFiltersUseBareExtensions(t *testing.T) {
	for _, filter := range pluginPackageDialogFilters("Plugin package") {
		for _, token := range strings.Split(filter.Pattern, ";") {
			extension := strings.TrimPrefix(token, "*.")
			if extension == token || extension == "" || strings.Contains(extension, ".") ||
				strings.ContainsAny(extension, "*?[]/\\ ") {
				t.Fatalf("pattern token %q is not a bare extension", token)
			}
		}
	}
}

func TestSelectPluginPackageRejectsWebRuntime(t *testing.T) {
	app := &App{webRuntime: true}
	cases := []struct {
		name   string
		result connection.QueryResult
	}{
		{name: "file", result: app.SelectPluginPackageFile("")},
		{name: "directory", result: app.SelectPluginPackageDirectory("")},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if testCase.result.Success {
				t.Fatal("web runtime must not open native plugin package dialogs")
			}
			data, ok := testCase.result.Data.(map[string]any)
			if !ok || data["code"] != "desktop_only" {
				t.Fatalf("data = %#v, want desktop_only code", testCase.result.Data)
			}
		})
	}
}
