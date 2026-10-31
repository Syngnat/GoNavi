package provider

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/plugin"
)

func TestPluginCatalogReadsDeclaredProviderIcon(t *testing.T) {
	source := t.TempDir()
	manifest := `{
  "schemaVersion": 1,
  "apiVersion": 1,
  "id": "example.icons",
  "name": "Icon provider",
  "version": "1.0.0",
  "permissions": ["ai.providers"],
  "backend": {"default": {"executable": "plugin", "runtime": "native"}},
  "contributes": {
    "commands": [{"id": "provider", "title": "Provider"}],
    "aiProviders": [{
      "id": "chat",
      "name": "Chat",
      "command": "provider",
      "icon": "icons/provider.png",
      "models": [{"id": "model", "name": "Model", "contextWindow": 4096, "maxOutputTokens": 512}],
      "supportsTools": true,
      "supportsImages": false
    }]
  }
}`
	if err := os.WriteFile(filepath.Join(source, "gonavi.plugin.json"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "plugin"), []byte("fixture"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(source, "icons"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "icons", "provider.png"), []byte("\x89PNG\r\n\x1a\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	manager, err := plugin.NewManager(plugin.Options{Root: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = manager.Close(context.Background()) })
	inspection, err := manager.Inspect(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	status, err := manager.Install(ctx, plugin.InstallRequest{Path: source, Digest: inspection.Digest, Trusted: true})
	if err != nil {
		t.Fatal(err)
	}
	factory := NewPluginFactory(
		func(context.Context) (PluginProviderSnapshot, error) {
			return PluginProviderSnapshot{Statuses: []plugin.Status{status}}, nil
		},
		func(context.Context) (*plugin.Manager, error) { return manager, nil },
	)
	views, err := factory.Catalog(ctx)
	if err != nil || len(views) != 1 {
		t.Fatalf("catalog: %d %v", len(views), err)
	}
	if !strings.HasPrefix(views[0].Icon, "data:image/png;base64,") {
		t.Fatalf("provider icon missing: %q", views[0].Icon)
	}
}
