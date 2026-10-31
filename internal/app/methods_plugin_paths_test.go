package app

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
)

func TestExpandPluginPackagePath(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skipf("home directory unavailable: %v", err)
	}
	cases := []struct {
		name string
		in   string
		want string
	}{
		{name: "home only", in: "~", want: home},
		{name: "home prefix", in: "~/Downloads/pkg.zip", want: filepath.Join(home, "Downloads", "pkg.zip")},
		{name: "surrounding space", in: "  ~/Downloads/pkg.zip  ", want: filepath.Join(home, "Downloads", "pkg.zip")},
		{name: "absolute stays", in: "/tmp/pkg.zip", want: "/tmp/pkg.zip"},
		{name: "relative stays", in: "samples/pkg.zip", want: "samples/pkg.zip"},
		{name: "other user home stays", in: "~other/pkg.zip", want: "~other/pkg.zip"},
		{name: "inner tilde stays", in: "/tmp/~/pkg.zip", want: "/tmp/~/pkg.zip"},
		{name: "empty stays", in: "   ", want: ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := expandPluginPackagePath(testCase.in); got != testCase.want {
				t.Fatalf("expandPluginPackagePath(%q) = %q, want %q", testCase.in, got, testCase.want)
			}
		})
	}
}

// A path that no longer exists has to name the path problem instead of the plugin state.
func TestPluginResultReportsMissingPackagePath(t *testing.T) {
	a := newPluginTestApp(t)
	result := a.pluginResult(nil, fmt.Errorf("stat package failed: %w", fs.ErrNotExist))
	if result.Success {
		t.Fatal("missing package path reported as success")
	}
	data, ok := result.Data.(map[string]any)
	if !ok || data["code"] != "path_not_found" {
		t.Fatalf("code=%v want path_not_found", result.Data)
	}
}
