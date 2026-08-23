package mcpserver

import (
	"context"
	"testing"
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
