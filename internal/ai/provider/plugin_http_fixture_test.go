package provider

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/plugin"
)

func pluginHTTPFixture(t *testing.T) (*plugin.Manager, *PluginFactory) {
	t.Helper()
	examples, err := filepath.Abs(filepath.Join("..", "..", "..", "examples", "plugins"))
	if err != nil {
		t.Fatal(err)
	}
	source := t.TempDir()
	if err = os.Mkdir(filepath.Join(source, "bin"), 0700); err != nil {
		t.Fatal(err)
	}
	executable := "bin/plugin"
	if runtime.GOOS == "windows" {
		executable += ".exe"
	}
	buildCtx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	cmd := exec.CommandContext(buildCtx, "go", "build", "-trimpath", "-o", filepath.Join(source, filepath.FromSlash(executable)), "./ai-provider")
	cmd.Dir = examples
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOWORK=off", "GOPROXY=off", "GOSUMDB=off")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build actual SDK example: %v %s", err, output)
	}
	if err = os.Mkdir(filepath.Join(source, "icons"), 0700); err != nil {
		t.Fatal(err)
	}
	icon, err := os.ReadFile(filepath.Join(examples, "ai-provider", "icons", "provider.png"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(source, "icons", "provider.png"), icon, 0600); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(examples, "ai-provider", "gonavi.plugin.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest plugin.Manifest
	if err = json.Unmarshal(raw, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Backend = &plugin.Backend{Default: &plugin.Entry{Executable: executable, Runtime: "native"}}
	raw, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(source, "gonavi.plugin.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	manager, err := plugin.NewManager(plugin.Options{Root: t.TempDir(), ReconcileInterval: 5 * time.Millisecond, ShutdownTimeout: 250 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := manager.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	ctx := context.Background()
	inspection, err := manager.Inspect(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = manager.Install(ctx, plugin.InstallRequest{Path: source, Digest: inspection.Digest, Trusted: true}); err != nil {
		t.Fatal(err)
	}
	if _, err = manager.SetEnabled(ctx, manifest.ID, true); err != nil {
		t.Fatal(err)
	}
	if err = manager.Start(ctx); err != nil {
		t.Fatal(err)
	}
	factory := NewPluginFactory(func(context.Context) (PluginProviderSnapshot, error) {
		return PluginProviderSnapshot{Statuses: manager.List(), Owned: manager.OwnsRuntime()}, nil
	}, func(context.Context) (*plugin.Manager, error) { return manager, nil })
	return manager, factory
}
func pluginHTTPConfig(url string) ai.ProviderConfig {
	return ai.ProviderConfig{ID: "selected-http", Type: "plugin:sdk.examples.aiprovider:http", Name: "Local HTTP fixture", BaseURL: url, APIKey: "LOCAL_FIXTURE_KEY", Model: "gpt-4o-mini", Headers: map[string]string{"X-Selected": "fixture"}}
}
