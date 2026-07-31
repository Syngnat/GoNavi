package app

import (
	"fmt"
	"strings"
	"testing"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
)

func TestResolveConnectionConfigByIDLoadsSecretsFromStore(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	repo := newSavedConnectionRepository(app.configDir, store)
	view, err := repo.Save(connection.SavedConnectionInput{
		ID:   "conn-1",
		Name: "Primary",
		Config: connection.ConnectionConfig{
			ID:       "conn-1",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "postgres",
			Password: "postgres-secret",
			DSN:      "postgres://user:pass@db.local/app",
		},
	})
	if err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	resolved, err := app.resolveConnectionSecrets(view.Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "postgres-secret" {
		t.Fatalf("expected restored password, got %q", resolved.Password)
	}
	if resolved.DSN != "postgres://user:pass@db.local/app" {
		t.Fatalf("expected restored DSN, got %q", resolved.DSN)
	}
}

func TestResolveConnectionConfigByIDLoadsRedisSentinelPasswordFromStore(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	view, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "redis-sentinel",
		Name: "Redis Sentinel",
		Config: connection.ConnectionConfig{
			ID:                    "redis-sentinel",
			Type:                  "redis",
			Host:                  "sentinel.local",
			Port:                  26379,
			Topology:              "sentinel",
			RedisSentinelMaster:   "mymaster",
			RedisSentinelUser:     "sentinel-user",
			RedisSentinelPassword: "sentinel-secret",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}
	if view.Config.RedisSentinelPassword != "" {
		t.Fatal("saved metadata must not expose Redis Sentinel password")
	}
	if !view.HasRedisSentinelPassword {
		t.Fatal("expected saved view to report Redis Sentinel password")
	}

	resolved, err := app.resolveConnectionSecrets(view.Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.RedisSentinelPassword != "sentinel-secret" {
		t.Fatalf("expected restored Redis Sentinel password, got %q", resolved.RedisSentinelPassword)
	}
}

func TestResolveConnectionSecretsOnDarwinUsesInlineSavedSecrets(t *testing.T) {
	app := NewAppWithSecretStore(failOnUseSecretStore{})
	app.configDir = t.TempDir()

	if _, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-darwin-inline",
		Name: "Primary",
		Config: connection.ConnectionConfig{
			ID:       "conn-darwin-inline",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "postgres",
			Password: "postgres-secret",
			DSN:      "postgres://user:pass@db.local/app",
		},
	}); err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	resolved, err := app.resolveConnectionSecrets(connection.ConnectionConfig{
		ID:   "conn-darwin-inline",
		Type: "postgres",
		Host: "db.local",
		Port: 5432,
		User: "postgres",
	})
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "postgres-secret" {
		t.Fatalf("expected daily-stored password to be restored, got %q", resolved.Password)
	}
	if resolved.DSN != "postgres://user:pass@db.local/app" {
		t.Fatalf("expected daily-stored DSN to be restored, got %q", resolved.DSN)
	}
}


func TestConnectionSecretResolutionCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	keys := []string{
		"connection_modal.secret.error.saved_connection_deleted",
		"connection_modal.secret.error.saved_connection_missing",
		"connection_modal.secret.error.store_unavailable",
	}
	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range keys {
			if strings.TrimSpace(catalog[key]) == "" {
				t.Fatalf("%s catalog missing secret resolution key %q", language, key)
			}
		}
	}
}

func TestResolveConnectionSecretsReturnsLocalizedMessageWhenSavedSecretSourceIsMissing(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	_, err := app.resolveConnectionSecrets(connection.ConnectionConfig{
		ID:   "conn-missing",
		Type: "postgres",
		Host: "db.local",
		Port: 5432,
		User: "postgres",
	})
	if err == nil {
		t.Fatal("expected resolveConnectionSecrets to fail for a missing saved connection")
	}
	want := "The saved secret for the current connection was not found. Re-enter the password, save, and try again."
	if err.Error() != want {
		t.Fatalf("expected localized secret-specific error message %q, got %q", want, err.Error())
	}
}

func TestResolveConnectionSecretsReturnsLocalizedMessageWhenSavedConnectionRecordIsMissing(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()
	app.SetLanguage(string(i18n.LanguageEnUS))

	_, err := app.resolveConnectionSecrets(connection.ConnectionConfig{ID: "conn-deleted"})
	if err == nil {
		t.Fatal("expected resolveConnectionSecrets to fail for a missing saved connection record")
	}

	want := "The saved connection was not found. It may have been deleted. Refresh and try again."
	if err.Error() != want {
		t.Fatalf("expected localized missing saved connection message %q, got %q", want, err.Error())
	}
}

func TestResolveConnectionSecretsReturnsLocalizedMessageWhenSecretStoreIsUnavailable(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.SetLanguage(string(i18n.LanguageEnUS))

	err := app.normalizeConnectionSecretResolutionError(connection.ConnectionConfig{}, fmt.Errorf("secret store unavailable"))
	want := "Secure secret storage is currently unavailable. Check the system keychain or credential manager, then try again."
	if err.Error() != want {
		t.Fatalf("expected localized unavailable secret store message %q, got %q", want, err.Error())
	}
}

func TestResolveConnectionSecretsFallsBackToInlineSecretsWhenSavedConnectionIsMissing(t *testing.T) {
	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	input := connection.ConnectionConfig{
		ID:       "legacy-inline",
		Type:     "postgres",
		Host:     "db.local",
		Port:     5432,
		User:     "postgres",
		Password: "inline-secret",
		DSN:      "postgres://postgres:inline-secret@db.local/app",
	}

	resolved, err := app.resolveConnectionSecrets(input)
	if err != nil {
		t.Fatalf("expected inline secrets to be used as fallback, got error: %v", err)
	}
	if resolved.Password != "inline-secret" {
		t.Fatalf("expected inline password to be preserved, got %q", resolved.Password)
	}
	if resolved.DSN != "postgres://postgres:inline-secret@db.local/app" {
		t.Fatalf("expected inline DSN to be preserved, got %q", resolved.DSN)
	}
}

func TestResolveConnectionSecretsFallsBackToInlineSecretsWhenSavedSecretBundleIsMissing(t *testing.T) {
	withTestGOOS(t, "linux")

	store := newFakeAppSecretStore()
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	view, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-inline-fallback",
		Name: "Primary",
		Config: connection.ConnectionConfig{
			ID:       "conn-inline-fallback",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "postgres",
			Password: "stored-secret",
			DSN:      "postgres://postgres:stored-secret@db.local/app",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}
	if view.SecretRef != "" {
		t.Fatalf("expected saved connection to avoid secret refs, got %q", view.SecretRef)
	}
	if err := app.dailySecretStore().DeleteConnection("conn-inline-fallback"); err != nil {
		t.Fatalf("DeleteConnection returned error: %v", err)
	}

	resolved, err := app.resolveConnectionSecrets(connection.ConnectionConfig{
		ID:       "conn-inline-fallback",
		Type:     "postgres",
		Host:     "db.local",
		Port:     5432,
		User:     "postgres",
		Password: "inline-secret",
		DSN:      "postgres://postgres:inline-secret@db.local/app",
	})
	if err != nil {
		t.Fatalf("expected inline secrets to be used when secret bundle is missing, got error: %v", err)
	}
	if resolved.Password != "inline-secret" {
		t.Fatalf("expected inline password to be preserved, got %q", resolved.Password)
	}
	if resolved.DSN != "postgres://postgres:inline-secret@db.local/app" {
		t.Fatalf("expected inline DSN to be preserved, got %q", resolved.DSN)
	}
}
