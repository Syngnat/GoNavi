package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	syncbackend "GoNavi-Wails/internal/sync"
)

func TestDataSyncMetadataMethodsRequireSavedConnectionIDs(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()

	for name, result := range map[string]connection.QueryResult{
		"databases":  application.DataSyncDatabaseList(""),
		"objects":    application.DataSyncObjectList("", "", ""),
		"fields":     application.DataSyncFieldList("", "", "", "orders"),
		"capability": application.DataSyncCapabilityResolve("", "", "", "target", "", ""),
	} {
		if result.Success {
			t.Fatalf("%s metadata request unexpectedly succeeded", name)
		}
	}
}

func TestDataSyncCapabilityResolveUsesSavedConnectionsWithoutReturningSecrets(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	for _, input := range []connection.SavedConnectionInput{
		{
			ID:   "source",
			Name: "Source",
			Config: connection.ConnectionConfig{
				ID: "source", Type: "postgres", Host: "source.internal", Password: "source-secret",
			},
		},
		{
			ID:   "target",
			Name: "Target",
			Config: connection.ConnectionConfig{
				ID: "target", Type: "mysql", Host: "target.internal", Password: "target-secret",
			},
		},
	} {
		if _, err := application.SaveConnection(input); err != nil {
			t.Fatalf("save connection %s: %v", input.ID, err)
		}
	}

	result := application.DataSyncCapabilityResolve("source", "sales", "public", "target", "warehouse", "")
	if !result.Success {
		t.Fatalf("capability resolution failed: %s", result.Message)
	}
	capability, ok := result.Data.(syncbackend.MigrationCapability)
	if !ok {
		t.Fatalf("capability response type = %T", result.Data)
	}
	if capability.SourceType != "postgres" || capability.TargetType != "mysql" {
		t.Fatalf("unexpected capability route: %#v", capability)
	}
	encoded := string(mustJSON(result.Data))
	if strings.Contains(encoded, "source-secret") || strings.Contains(encoded, "target-secret") {
		t.Fatal("capability response leaked a saved connection secret")
	}
}
