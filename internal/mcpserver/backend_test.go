package mcpserver

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/ai"
	appcore "GoNavi-Wails/internal/app"
)

func TestNewAppBackendInitializesWithoutGUI(t *testing.T) {
	t.Setenv("GONAVI_DATA_ROOT", t.TempDir())
	backend, err := NewAppBackend(context.Background())
	if err != nil {
		t.Fatalf("NewAppBackend returned error: %v", err)
	}
	if backend == nil {
		t.Fatal("NewAppBackend returned nil backend")
	}
	if _, err := backend.GetSavedConnections(); err != nil {
		t.Fatalf("headless backend could not read saved connections: %v", err)
	}
	if err := backend.Close(context.Background()); err != nil {
		t.Fatalf("backend.Close returned error: %v", err)
	}
}

func TestAppBackendReadsResultMaskingFromSelectedConfigDirectory(t *testing.T) {
	configDir := t.TempDir()
	config := `{"schemaVersion":6,"providers":[],"safetyLevel":"readonly","contextLevel":"schema_only","resultMasking":{"enabled":true,"fullMaskFields":[" phone "],"partialMaskFields":["email"]}}`
	if err := os.WriteFile(filepath.Join(configDir, "ai_config.json"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	backend := &AppBackend{configDir: configDir}
	settings, err := backend.GetResultMaskingSettings()
	if err != nil {
		t.Fatal(err)
	}
	want := ai.ResultMaskingSettings{Enabled: true, FullMaskFields: []string{"phone"}, PartialMaskFields: []string{"email"}}
	if settings.Enabled != want.Enabled || len(settings.FullMaskFields) != 1 || settings.FullMaskFields[0] != want.FullMaskFields[0] || len(settings.PartialMaskFields) != 1 || settings.PartialMaskFields[0] != want.PartialMaskFields[0] {
		t.Fatalf("settings = %#v, want %#v", settings, want)
	}
}

func TestAppBackendRejectsDamagedResultMaskingConfig(t *testing.T) {
	configDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(configDir, "ai_config.json"), []byte(`{"resultMasking":`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := (&AppBackend{configDir: configDir}).GetResultMaskingSettings(); err == nil {
		t.Fatal("damaged AI config must fail closed")
	}
}

func TestNewAppBackendFromAppBorrowsDesktopLifecycle(t *testing.T) {
	application := appcore.NewApp()
	backend, err := NewAppBackendFromApp(application)
	if err != nil {
		t.Fatalf("NewAppBackendFromApp returned error: %v", err)
	}
	if backend == nil || backend.app != application {
		t.Fatalf("borrowed backend did not retain the supplied App: %#v", backend)
	}
	if backend.configDir != appcore.ConfigDirForIntegration(application) {
		t.Fatalf("borrowed backend config directory = %q, want %q", backend.configDir, appcore.ConfigDirForIntegration(application))
	}
	if backend.ownsApp {
		t.Fatal("borrowed backend must not own the desktop App lifecycle")
	}
	if err := backend.Close(context.Background()); err != nil {
		t.Fatalf("borrowed backend Close returned error: %v", err)
	}
	if backend.app != application {
		t.Fatal("borrowed backend Close detached the desktop App")
	}
}
