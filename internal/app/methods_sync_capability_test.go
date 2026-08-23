package app

import (
	"GoNavi-Wails/internal/connection"
	datasync "GoNavi-Wails/internal/sync"
	"testing"
)

func TestDataSyncCapabilityDelegatesToMigrationCapabilityResolver(t *testing.T) {
	source := connection.ConnectionConfig{Type: "mysql"}
	target := connection.ConnectionConfig{Type: "postgres"}

	got := (&App{}).DataSyncCapability(source, target)
	want := datasync.ResolveMigrationCapability(source, target)
	if got != want {
		t.Fatalf("unexpected Wails capability: got %+v want %+v", got, want)
	}
}
