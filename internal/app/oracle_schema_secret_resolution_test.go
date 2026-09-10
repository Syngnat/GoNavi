package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestResolveConnectionSecretsPreservesHeadlessOracleRuntimeSchema(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()
	app.headlessRuntime = true

	view, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "oracle-headless-schema",
		Name: "Oracle",
		Config: connection.ConnectionConfig{
			ID:       "oracle-headless-schema",
			Type:     "oracle",
			Host:     "oracle.local",
			Port:     1521,
			User:     "TEST",
			Password: "secret",
			Database: "ORCLPDB1",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	resolved, err := app.resolveConnectionSecrets(
		view.Config.WithRuntimeOracleCurrentSchema("PRO"),
	)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.RuntimeOracleCurrentSchema() != "PRO" {
		t.Fatalf("headless Oracle runtime schema = %q, want PRO", resolved.RuntimeOracleCurrentSchema())
	}
	if resolved.Password != "secret" {
		t.Fatalf("expected restored Oracle password, got %q", resolved.Password)
	}
}
