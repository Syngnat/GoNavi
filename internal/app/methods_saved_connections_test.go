package app

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func withTestGOOS(t *testing.T, goos string) {
	t.Helper()
	previous := runtimeGOOS
	runtimeGOOS = func() string {
		return goos
	}
	t.Cleanup(func() {
		runtimeGOOS = previous
	})
}

func TestSaveConnectionMethodReturnsSecretlessView(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	result, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:                      "conn-1",
		Name:                    "Primary",
		EnvironmentType:         "production",
		IncludeDatabases:        []string{"appdb"},
		IncludeDatabasePatterns: []string{"app_*"},
		ExcludeDatabasePatterns: []string{"app_tmp%"},
		IconType:                "postgres",
		IconColor:               "#1677ff",
		Config: connection.ConnectionConfig{
			ID:       "conn-1",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "postgres",
			Password: "postgres-secret",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Config.Password != "" {
		t.Fatal("SaveConnection must not return plaintext password")
	}
	if !result.HasPrimaryPassword {
		t.Fatal("expected HasPrimaryPassword=true")
	}
	if !reflect.DeepEqual(result.IncludeDatabases, []string{"appdb"}) {
		t.Fatalf("expected include databases to be preserved, got %#v", result.IncludeDatabases)
	}
	if !reflect.DeepEqual(result.IncludeDatabasePatterns, []string{"app_*"}) {
		t.Fatalf("expected include database patterns to be preserved, got %#v", result.IncludeDatabasePatterns)
	}
	if !reflect.DeepEqual(result.ExcludeDatabasePatterns, []string{"app_tmp%"}) {
		t.Fatalf("expected exclude database patterns to be preserved, got %#v", result.ExcludeDatabasePatterns)
	}
	if result.IconType != "postgres" || result.IconColor != "#1677ff" {
		t.Fatalf("expected icon metadata to be preserved, got type=%q color=%q", result.IconType, result.IconColor)
	}
	if result.EnvironmentType != "production" {
		t.Fatalf("expected environment type to be preserved, got %q", result.EnvironmentType)
	}
}

func TestSaveConnectionSanitizesDatabasePatterns(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	unicodePattern := strings.Repeat("租", 85) // 255 UTF-8 bytes.
	includePatterns := []string{
		" team_% ",
		"team_%",
		"",
		unicodePattern,
	}

	result, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:                      "conn-patterns",
		Name:                    "Patterns",
		IncludeDatabasePatterns: includePatterns,
		ExcludeDatabasePatterns: []string{" tmp_* ", "tmp_*", "   "},
		Config: connection.ConnectionConfig{
			ID:   "conn-patterns",
			Type: "postgres",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if !reflect.DeepEqual(result.IncludeDatabasePatterns, []string{"team_%", unicodePattern}) {
		t.Fatalf("expected patterns to be trimmed, deduplicated, and preserve valid Unicode, got %#v", result.IncludeDatabasePatterns)
	}
	if !reflect.DeepEqual(result.ExcludeDatabasePatterns, []string{"tmp_*"}) {
		t.Fatalf("expected exclude patterns to be trimmed and deduplicated, got %#v", result.ExcludeDatabasePatterns)
	}

	saved, err := app.GetSavedConnections()
	if err != nil {
		t.Fatal(err)
	}
	if len(saved) != 1 || !reflect.DeepEqual(saved[0].IncludeDatabasePatterns, result.IncludeDatabasePatterns) ||
		!reflect.DeepEqual(saved[0].ExcludeDatabasePatterns, result.ExcludeDatabasePatterns) {
		t.Fatalf("expected sanitized patterns to persist, got %#v", saved)
	}
}

func TestSaveConnectionRejectsInvalidDatabasePatterns(t *testing.T) {
	tooManyPatterns := make([]string, maxDatabaseFilterPatterns+1)
	for index := range tooManyPatterns {
		tooManyPatterns[index] = fmt.Sprintf("db-%03d", index)
	}

	tests := []struct {
		name     string
		includes []string
		excludes []string
		wantText string
	}{
		{
			name:     "include pattern exceeds UTF-8 byte limit",
			includes: []string{strings.Repeat("租", 86)},
			wantText: "database include pattern exceeds 256 UTF-8 bytes",
		},
		{
			name:     "exclude pattern exceeds UTF-8 byte limit",
			excludes: []string{strings.Repeat("x", maxDatabaseFilterPatternBytes+1)},
			wantText: "database exclude pattern exceeds 256 UTF-8 bytes",
		},
		{
			name:     "too many include patterns",
			includes: tooManyPatterns,
			wantText: "too many database include patterns: maximum is 256",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app := NewAppWithSecretStore(newFakeAppSecretStore())
			app.configDir = t.TempDir()

			_, err := app.SaveConnection(connection.SavedConnectionInput{
				ID:                      "conn-invalid-patterns",
				Name:                    "Invalid patterns",
				IncludeDatabasePatterns: test.includes,
				ExcludeDatabasePatterns: test.excludes,
				Config: connection.ConnectionConfig{
					ID:   "conn-invalid-patterns",
					Type: "postgres",
				},
			})
			if err == nil || !strings.Contains(err.Error(), test.wantText) {
				t.Fatalf("expected error containing %q, got %v", test.wantText, err)
			}
			if saved, listErr := app.GetSavedConnections(); listErr != nil || len(saved) != 0 {
				t.Fatalf("expected rejected patterns not to be persisted, saved=%#v err=%v", saved, listErr)
			}
		})
	}
}

func TestSaveConnectionDefaultsInvalidEnvironmentTypeToLocal(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	result, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:              "conn-default-environment",
		Name:            "Default environment",
		EnvironmentType: "staging",
		Config: connection.ConnectionConfig{
			ID:   "conn-default-environment",
			Type: "sqlite",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.EnvironmentType != defaultConnectionEnvironment {
		t.Fatalf("expected invalid environment to default to %q, got %q", defaultConnectionEnvironment, result.EnvironmentType)
	}
}

func TestSaveConnectionSanitizesSchemaVisibilityRules(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	result, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-schema-rules",
		Name: "Schema rules",
		Config: connection.ConnectionConfig{
			ID:   "conn-schema-rules",
			Type: "sqlserver",
			Host: "db.local",
			Port: 1433,
			User: "sa",
		},
		SchemaVisibilityByDatabase: map[string]connection.SchemaVisibilityRule{
			" appdb ": {
				Mode:    "include",
				Schemas: []string{" dbo ", "dbo", ""},
			},
			"invalid-mode": {
				Mode:    "all",
				Schemas: []string{"dbo"},
			},
			"empty": {
				Mode: "exclude",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	expected := map[string]connection.SchemaVisibilityRule{
		"appdb": {Mode: "include", Schemas: []string{"dbo"}},
	}
	if !reflect.DeepEqual(result.SchemaVisibilityByDatabase, expected) {
		t.Fatalf("expected schema visibility rules to be sanitized, got %#v", result.SchemaVisibilityByDatabase)
	}
}

func TestGetEditableSavedConnectionReturnsResolvedSecretsForEdit(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	if _, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-edit",
		Name: "Editable",
		Config: connection.ConnectionConfig{
			ID:       "conn-edit",
			Type:     "mysql",
			Host:     "db.local",
			Port:     3306,
			User:     "root",
			Password: "mysql-secret",
			UseSSH:   true,
			SSH: connection.SSHConfig{
				Host:     "jump.local",
				Port:     22,
				User:     "ops",
				Password: "ssh-secret",
			},
		},
	}); err != nil {
		t.Fatal(err)
	}

	view, err := app.GetEditableSavedConnection("conn-edit")
	if err != nil {
		t.Fatal(err)
	}
	if view.Config.Password != "mysql-secret" {
		t.Fatalf("expected editable primary password, got %q", view.Config.Password)
	}
	if view.Config.SSH.Password != "ssh-secret" {
		t.Fatalf("expected editable SSH password, got %q", view.Config.SSH.Password)
	}
	if !view.HasPrimaryPassword || !view.HasSSHPassword {
		t.Fatalf("expected secret flags to stay true, got %#v", view)
	}

	saved, err := app.GetSavedConnections()
	if err != nil {
		t.Fatal(err)
	}
	if len(saved) != 1 {
		t.Fatalf("expected one saved connection, got %d", len(saved))
	}
	if saved[0].Config.Password != "" {
		t.Fatalf("expected saved connection list to remain secretless, got %q", saved[0].Config.Password)
	}
	if saved[0].Config.SSH.Password != "" {
		t.Fatalf("expected saved connection list SSH password to remain secretless, got %q", saved[0].Config.SSH.Password)
	}
}

func TestSaveConnectionOnDarwinPersistsSecretsInlineButReturnsSecretlessView(t *testing.T) {
	app := NewAppWithSecretStore(failOnUseSecretStore{})
	app.configDir = t.TempDir()

	result, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-darwin",
		Name: "Primary",
		Config: connection.ConnectionConfig{
			ID:       "conn-darwin",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "postgres",
			Password: "postgres-secret",
			DSN:      "postgres://user:pass@db.local/app",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Config.Password != "" {
		t.Fatal("SaveConnection must keep macOS return value secretless")
	}
	if result.Config.DSN != "" {
		t.Fatal("SaveConnection must not return plaintext DSN")
	}
	if result.SecretRef != "" {
		t.Fatalf("expected macOS inline persistence to avoid secret refs, got %q", result.SecretRef)
	}
	if !result.HasPrimaryPassword || !result.HasOpaqueDSN {
		t.Fatalf("expected secret flags to stay true, got %#v", result)
	}

	raw, err := app.savedConnectionRepository().Find("conn-darwin")
	if err != nil {
		t.Fatal(err)
	}
	if raw.Config.Password != "" {
		t.Fatalf("expected raw saved connection metadata to stay secretless, got %q", raw.Config.Password)
	}
	if raw.Config.DSN != "" {
		t.Fatalf("expected raw saved connection metadata to stay secretless, got %q", raw.Config.DSN)
	}
	if raw.SecretRef != "" {
		t.Fatalf("expected raw saved connection to avoid secret refs, got %q", raw.SecretRef)
	}

	stored, ok, err := app.dailySecretStore().GetConnection("conn-darwin")
	if err != nil {
		t.Fatalf("GetConnection returned error: %v", err)
	}
	if !ok {
		t.Fatal("expected daily secret store to keep saved connection secret")
	}
	if stored.Password != "postgres-secret" {
		t.Fatalf("expected daily secret store to persist password, got %q", stored.Password)
	}
	if stored.OpaqueDSN != "postgres://user:pass@db.local/app" {
		t.Fatalf("expected daily secret store to persist DSN, got %q", stored.OpaqueDSN)
	}
}

func TestSaveConnectionClearsRequestedSecretFields(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-1",
		Name: "Primary",
		Config: connection.ConnectionConfig{
			ID:       "conn-1",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "postgres",
			Password: "postgres-secret",
			UseSSH:   true,
			SSH: connection.SSHConfig{
				Host:     "jump.local",
				Port:     22,
				User:     "ops",
				Password: "ssh-secret",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	view, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-1",
		Name: "Primary",
		Config: connection.ConnectionConfig{
			ID:     "conn-1",
			Type:   "postgres",
			Host:   "db.local",
			Port:   5432,
			User:   "postgres",
			UseSSH: true,
			SSH: connection.SSHConfig{
				Host: "jump.local",
				Port: 22,
				User: "ops",
			},
		},
		ClearPrimaryPassword: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if view.HasPrimaryPassword {
		t.Fatal("expected HasPrimaryPassword=false after clearing")
	}
	if !view.HasSSHPassword {
		t.Fatal("expected SSH password to stay stored")
	}

	resolved, err := app.resolveConnectionSecrets(view.Config)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Password != "" {
		t.Fatalf("expected cleared primary password, got %q", resolved.Password)
	}
	if resolved.SSH.Password != "ssh-secret" {
		t.Fatalf("expected SSH password to stay stored, got %q", resolved.SSH.Password)
	}
}

func TestDuplicateConnectionClonesSecretBundle(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.SetLanguage("en-US")

	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:                      "conn-1",
		Name:                    "Primary",
		IncludeDatabases:        []string{"appdb"},
		IncludeDatabasePatterns: []string{"app_*"},
		ExcludeDatabasePatterns: []string{"app_tmp%"},
		IncludeRedisDatabases:   []int{0, 1},
		SchemaVisibilityByDatabase: map[string]connection.SchemaVisibilityRule{
			"appdb": {
				Mode:    "include",
				Schemas: []string{"dbo", "reporting"},
			},
		},
		IconType:  "postgres",
		IconColor: "#1677ff",
		Config: connection.ConnectionConfig{
			ID:       "conn-1",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "postgres",
			Password: "postgres-secret",
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	duplicate, err := app.DuplicateConnection("conn-1")
	if err != nil {
		t.Fatal(err)
	}
	if duplicate.ID == "conn-1" {
		t.Fatal("duplicate should have a new id")
	}
	if duplicate.Name != "Primary - Copy" {
		t.Fatalf("expected duplicate name to be localized, got %q", duplicate.Name)
	}
	if !reflect.DeepEqual(duplicate.IncludeDatabases, []string{"appdb"}) {
		t.Fatalf("expected include databases to be cloned, got %#v", duplicate.IncludeDatabases)
	}
	if !reflect.DeepEqual(duplicate.IncludeDatabasePatterns, []string{"app_*"}) {
		t.Fatalf("expected include database patterns to be cloned, got %#v", duplicate.IncludeDatabasePatterns)
	}
	if !reflect.DeepEqual(duplicate.ExcludeDatabasePatterns, []string{"app_tmp%"}) {
		t.Fatalf("expected exclude database patterns to be cloned, got %#v", duplicate.ExcludeDatabasePatterns)
	}
	if !reflect.DeepEqual(duplicate.IncludeRedisDatabases, []int{0, 1}) {
		t.Fatalf("expected redis include databases to be cloned, got %#v", duplicate.IncludeRedisDatabases)
	}
	expectedSchemaVisibility := map[string]connection.SchemaVisibilityRule{
		"appdb": {
			Mode:    "include",
			Schemas: []string{"dbo", "reporting"},
		},
	}
	if !reflect.DeepEqual(duplicate.SchemaVisibilityByDatabase, expectedSchemaVisibility) {
		t.Fatalf("expected schema visibility rules to be cloned, got %#v", duplicate.SchemaVisibilityByDatabase)
	}
	if duplicate.IconType != "postgres" || duplicate.IconColor != "#1677ff" {
		t.Fatalf("expected icon metadata to be cloned, got type=%q color=%q", duplicate.IconType, duplicate.IconColor)
	}

	resolved, err := app.resolveConnectionSecrets(duplicate.Config)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Password != "postgres-secret" {
		t.Fatalf("expected duplicated secret bundle, got %q", resolved.Password)
	}
}

func TestSaveGlobalProxyReturnsSecretlessView(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	view, err := app.SaveGlobalProxy(connection.SaveGlobalProxyInput{
		Enabled:  true,
		Type:     "http",
		Host:     "127.0.0.1",
		Port:     8080,
		User:     "ops",
		Password: "proxy-secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if view.Password != "" {
		t.Fatal("global proxy view must not expose plaintext password")
	}
	if !view.HasPassword {
		t.Fatal("expected hasPassword=true")
	}
}

func TestSaveGlobalProxyOnDarwinPersistsPasswordInlineButReturnsSecretlessView(t *testing.T) {
	app := NewAppWithSecretStore(failOnUseSecretStore{})
	app.configDir = t.TempDir()

	view, err := app.SaveGlobalProxy(connection.SaveGlobalProxyInput{
		Enabled:  true,
		Type:     "http",
		Host:     "127.0.0.1",
		Port:     8080,
		User:     "ops",
		Password: "proxy-secret",
	})
	if err != nil {
		t.Fatal(err)
	}
	if view.Password != "" {
		t.Fatal("SaveGlobalProxy must not expose plaintext password")
	}
	if !view.HasPassword {
		t.Fatal("expected hasPassword=true")
	}
	if view.SecretRef != "" {
		t.Fatalf("expected proxy persistence to avoid secret refs, got %q", view.SecretRef)
	}

	stored, err := app.loadStoredGlobalProxyView()
	if err != nil {
		t.Fatal(err)
	}
	if stored.Password != "" {
		t.Fatalf("expected stored global proxy metadata to stay secretless, got %q", stored.Password)
	}
	if stored.SecretRef != "" {
		t.Fatalf("expected stored global proxy to avoid secret refs, got %q", stored.SecretRef)
	}

	proxySecret, ok, err := app.dailySecretStore().GetGlobalProxy()
	if err != nil {
		t.Fatalf("GetGlobalProxy returned error: %v", err)
	}
	if !ok {
		t.Fatal("expected daily secret store to keep proxy password")
	}
	if proxySecret.Password != "proxy-secret" {
		t.Fatalf("expected daily secret store to persist proxy password, got %q", proxySecret.Password)
	}
}

func TestImportLegacyConnectionsIsIdempotentForSameID(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	legacy := connection.LegacySavedConnection{
		ID:   "legacy-1",
		Name: "Legacy",
		Config: connection.ConnectionConfig{
			ID:       "legacy-1",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "postgres",
			Password: "secret-1",
		},
	}

	if _, err := app.ImportLegacyConnections([]connection.LegacySavedConnection{legacy}); err != nil {
		t.Fatalf("first ImportLegacyConnections returned error: %v", err)
	}
	if _, err := app.ImportLegacyConnections([]connection.LegacySavedConnection{legacy}); err != nil {
		t.Fatalf("second ImportLegacyConnections returned error: %v", err)
	}

	saved, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(saved) != 1 {
		t.Fatalf("expected a single saved connection after repeated import, got %d", len(saved))
	}
}

func TestImportLegacyConnectionsClearsExistingSecretWhenReimportOmitsPassword(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	if _, err := app.ImportLegacyConnections([]connection.LegacySavedConnection{
		{
			ID:   "legacy-1",
			Name: "Legacy",
			Config: connection.ConnectionConfig{
				ID:       "legacy-1",
				Type:     "postgres",
				Host:     "db.local",
				Port:     5432,
				User:     "postgres",
				Password: "secret-1",
			},
		},
	}); err != nil {
		t.Fatalf("initial ImportLegacyConnections returned error: %v", err)
	}

	if _, err := app.ImportLegacyConnections([]connection.LegacySavedConnection{
		{
			ID:   "legacy-1",
			Name: "Legacy Updated",
			Config: connection.ConnectionConfig{
				ID:   "legacy-1",
				Type: "postgres",
				Host: "db.local",
				Port: 5432,
				User: "postgres",
			},
		},
	}); err != nil {
		t.Fatalf("update ImportLegacyConnections returned error: %v", err)
	}

	saved, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(saved) != 1 {
		t.Fatalf("expected 1 saved connection, got %d", len(saved))
	}
	resolved, err := app.resolveConnectionSecrets(saved[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "" {
		t.Fatalf("expected missing import password to clear existing secret, got %q", resolved.Password)
	}
}
