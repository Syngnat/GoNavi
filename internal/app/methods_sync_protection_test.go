package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sync"
)

func TestEnsureDataSyncTargetProtectionRequiresDataEditAndImportPermission(t *testing.T) {
	base := sync.SyncConfig{
		TargetConfig: connection.ConnectionConfig{Type: "mysql"},
		Content:      "data",
	}
	if err := ensureDataSyncTargetProtection(base); err != nil {
		t.Fatalf("unrestricted target rejected: %v", err)
	}

	dataEditBlocked := base
	dataEditBlocked.TargetConfig.Protection.RestrictDataEdit = true
	if err := ensureDataSyncTargetProtection(dataEditBlocked); err == nil {
		t.Fatal("data sync bypassed restrictDataEdit")
	}

	dataImportBlocked := base
	dataImportBlocked.TargetConfig.Protection.RestrictDataImport = true
	if err := ensureDataSyncTargetProtection(dataImportBlocked); err == nil {
		t.Fatal("data sync bypassed restrictDataImport")
	}
}
