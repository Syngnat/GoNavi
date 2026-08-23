package sync

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"errors"
	"strings"
	"testing"
)

func TestAnalyzeBlocksUnsupportedMigrationBeforeDatabaseInitialization(t *testing.T) {
	oldFactory := newSyncDatabase
	factoryCalls := 0
	newSyncDatabase = func(string) (db.Database, error) {
		factoryCalls++
		return nil, errors.New("database factory should not be called")
	}
	defer func() { newSyncDatabase = oldFactory }()

	result := NewSyncEngine(Reporter{}).Analyze(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "kafka"},
		TargetConfig: connection.ConnectionConfig{Type: "qdrant"},
		Tables:       []string{"events"},
	})

	if result.Success || factoryCalls != 0 {
		t.Fatalf("expected capability guard before database initialization, result=%+v calls=%d", result, factoryCalls)
	}
	if !strings.Contains(result.Message, "kafka") || !strings.Contains(result.Message, "qdrant") {
		t.Fatalf("expected rejected pair in error message, got %q", result.Message)
	}
}

func TestRunSyncBlocksUnsupportedMigrationBeforeDatabaseInitialization(t *testing.T) {
	oldFactory := newSyncDatabase
	factoryCalls := 0
	newSyncDatabase = func(string) (db.Database, error) {
		factoryCalls++
		return nil, errors.New("database factory should not be called")
	}
	defer func() { newSyncDatabase = oldFactory }()

	result := NewSyncEngine(Reporter{}).RunSync(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "kafka"},
		TargetConfig: connection.ConnectionConfig{Type: "qdrant"},
		Tables:       []string{"events"},
	})

	if result.Success || factoryCalls != 0 {
		t.Fatalf("expected capability guard before database initialization, result=%+v calls=%d", result, factoryCalls)
	}
	if !strings.Contains(result.Message, "kafka") || !strings.Contains(result.Message, "qdrant") {
		t.Fatalf("expected rejected pair in error message, got %q", result.Message)
	}
}

func TestPreviewBlocksPlannedMigrationBeforeDatabaseInitialization(t *testing.T) {
	oldFactory := newSyncDatabase
	factoryCalls := 0
	newSyncDatabase = func(string) (db.Database, error) {
		factoryCalls++
		return nil, errors.New("database factory should not be called")
	}
	defer func() { newSyncDatabase = oldFactory }()

	_, err := NewSyncEngine(Reporter{}).Preview(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mongodb"},
		TargetConfig: connection.ConnectionConfig{Type: "oracle"},
		Tables:       []string{"documents"},
	}, "documents", 20)

	if err == nil || factoryCalls != 0 {
		t.Fatalf("expected capability guard before database initialization, err=%v calls=%d", err, factoryCalls)
	}
	if !strings.Contains(err.Error(), "mongodb") || !strings.Contains(err.Error(), "oracle") {
		t.Fatalf("expected planned pair in error message, got %q", err.Error())
	}
}

func TestValidateMigrationCapabilityLeavesSourceQueryPathToItsOwnValidator(t *testing.T) {
	err := ValidateMigrationCapability(SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mongodb"},
		TargetConfig: connection.ConnectionConfig{Type: "oracle"},
		SourceQuery:  `{"find":"documents","filter":{}}`,
		Tables:       []string{"documents"},
	})

	if err != nil {
		t.Fatalf("source-query sync must not be rejected by the table-pair guard: %v", err)
	}
}
