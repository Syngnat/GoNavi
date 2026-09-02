package mcpserver

import (
	"context"
	"testing"

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

func TestNewAppBackendFromAppBorrowsDesktopLifecycle(t *testing.T) {
	application := appcore.NewApp()
	backend, err := NewAppBackendFromApp(application)
	if err != nil {
		t.Fatalf("NewAppBackendFromApp returned error: %v", err)
	}
	if backend == nil || backend.app != application {
		t.Fatalf("borrowed backend did not retain the supplied App: %#v", backend)
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
