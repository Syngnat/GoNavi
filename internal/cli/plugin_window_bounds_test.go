package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPluginCheckWindowBounds(t *testing.T) {
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
			raw, err := json.Marshal(map[string]any{
				"schemaVersion": 1, "apiVersion": 1, "id": "example.window", "name": "Window", "version": "1.0.0", "permissions": []any{"ui.html-panel"},
				"window": map[string]any{"entry": test.entry, "title": test.title, "width": test.width},
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
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			var stdout, stderr bytes.Buffer
			code := runPlugin(ctx, []string{"--root", t.TempDir(), "check", source}, &stdout, &stderr)
			cancel()
			if test.ok && code != ExitSuccess {
				t.Fatalf("bounded window failed: %s", stderr.String())
			}
			if !test.ok && (code == ExitSuccess || strings.Contains(stderr.String(), strings.Repeat("中", 40)) || strings.Contains(stderr.String(), source)) {
				t.Fatalf("window bound: exit=%d stderr=%s", code, stderr.String())
			}
		})
	}
}
