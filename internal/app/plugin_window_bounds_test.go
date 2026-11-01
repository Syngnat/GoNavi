package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func TestPluginInspectWindowBounds(t *testing.T) {
	a := newPluginTestApp(t)
	for _, test := range []struct {
		name, entry, title string
		width              int
		ok                 bool
	}{
		{name: "exact", ok: true, entry: "plugin", title: strings.Repeat("中", 85), width: 8192},
		{name: "title", entry: "plugin", title: strings.Repeat("中", 86), width: 0},
		{name: "width", entry: "plugin", title: "Window", width: 8193},
		{name: "parent", entry: "../plugin", title: "Window", width: 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw, err := json.Marshal(plugin.Manifest{
				SchemaVersion: 1, APIVersion: 1, ID: "example.window", Name: "Window", Version: "1.0.0",
				Permissions: []string{plugin.CustomPanelPermission},
				Window:      &plugin.Window{Entry: test.entry, Title: test.title, Width: test.width},
			})
			if err != nil {
				t.Fatal(err)
			}
			source := t.TempDir()
			for name, content := range map[string][]byte{"gonavi.plugin.json": raw, "plugin": []byte("not executed")} {
				if err = os.WriteFile(filepath.Join(source, name), content, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			result := a.PluginInspect(source)
			if test.ok && !result.Success {
				t.Fatalf("bounded window rejected: %+v", result)
			}
			if !test.ok && (result.Success || strings.Contains(result.Message, strings.Repeat("中", 40)) || strings.Contains(result.Message, source)) {
				t.Fatalf("window bound: %+v", result)
			}
		})
	}
}
