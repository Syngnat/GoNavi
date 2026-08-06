package app

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/secretstore"
)

func TestConnectionPackagePreservesEnvironmentType(t *testing.T) {
	item := newConnectionPackageItem(connection.SavedConnectionView{
		ID:              "conn-environment",
		Name:            "Production",
		EnvironmentType: "production",
		Config: connection.ConnectionConfig{
			ID:   "conn-environment",
			Type: "postgres",
		},
	}, connectionSecretBundle{}, nil)
	if item.EnvironmentType != "production" {
		t.Fatalf("expected package item environment type to be preserved, got %q", item.EnvironmentType)
	}

	input := newSavedConnectionInputFromPackageItem(item)
	if input.EnvironmentType != "production" {
		t.Fatalf("expected imported environment type to be preserved, got %q", input.EnvironmentType)
	}
}

func TestBuildConnectionPackagePayloadIncludesSecretBundles(t *testing.T) {
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
			Password: "db-secret",
			UseSSH:   true,
			SSH: connection.SSHConfig{
				Host:     "jump.local",
				Port:     22,
				User:     "ops",
				Password: "ssh-secret",
			},
			URI: "postgres://postgres:db-secret@db.local/app",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	payload, err := app.buildConnectionPackagePayload(nil, nil)
	if err != nil {
		t.Fatalf("buildConnectionPackagePayload returned error: %v", err)
	}
	if _, parseErr := time.Parse(time.RFC3339, payload.ExportedAt); parseErr != nil {
		t.Fatalf("expected RFC3339 exportedAt, got %q", payload.ExportedAt)
	}
	if len(payload.Connections) != 1 {
		t.Fatalf("expected 1 connection in payload, got %d", len(payload.Connections))
	}

	item := payload.Connections[0]
	if item.ID != "conn-1" {
		t.Fatalf("expected ID=conn-1, got %q", item.ID)
	}
	if item.Config.Password != "" {
		t.Fatalf("payload metadata must stay secretless, got password=%q", item.Config.Password)
	}
	if item.Config.SSH.Password != "" {
		t.Fatalf("payload metadata must stay secretless for SSH, got %q", item.Config.SSH.Password)
	}
	if item.Config.URI != "" {
		t.Fatalf("payload metadata must stay secretless for URI, got %q", item.Config.URI)
	}
	if item.Secrets.Password != "db-secret" {
		t.Fatalf("expected bundled primary password, got %q", item.Secrets.Password)
	}
	if item.Secrets.SSHPassword != "ssh-secret" {
		t.Fatalf("expected bundled SSH password, got %q", item.Secrets.SSHPassword)
	}
	if item.Secrets.OpaqueURI != "postgres://postgres:db-secret@db.local/app" {
		t.Fatalf("expected bundled URI secret, got %q", item.Secrets.OpaqueURI)
	}

	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}
	if strings.Contains(string(raw), "secretRef") {
		t.Fatalf("payload must not contain secretRef, got %s", string(raw))
	}
}

func TestBuildExportedConnectionPackageWithoutSecretsUsesV2AppManagedAndImportsWithoutPasswords(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:                      "conn-v2-no-secrets",
		Name:                    "Primary",
		IncludeDatabasePatterns: []string{"team_%", "archive*"},
		ExcludeDatabasePatterns: []string{"team_tmp%"},
		Config: connection.ConnectionConfig{
			ID:       "conn-v2-no-secrets",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "postgres",
			Password: "db-secret",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	raw, err := app.buildExportedConnectionPackage(ConnectionExportOptions{
		IncludeSecrets: false,
		FilePassword:   "ignored-password",
	})
	if err != nil {
		t.Fatalf("buildExportedConnectionPackage returned error: %v", err)
	}

	var file connectionPackageFileV2
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatalf("json.Unmarshal returned error: %v", err)
	}
	if file.V != connectionPackageSchemaVersionV2 {
		t.Fatalf("expected v2 package, got v=%d", file.V)
	}
	if file.P != connectionPackageProtectionAppManaged {
		t.Fatalf("expected app-managed protection, got p=%d", file.P)
	}
	if strings.Contains(string(raw), `"secrets"`) {
		t.Fatalf("expected exported JSON to omit secrets when IncludeSecrets=false, got %s", string(raw))
	}
	if len(file.Connections) != 1 {
		t.Fatalf("expected one exported connection, got %d", len(file.Connections))
	}
	if !reflect.DeepEqual(file.Connections[0].IncludeDatabasePatterns, []string{"team_%", "archive*"}) {
		t.Fatalf("expected include database patterns in package, got %#v", file.Connections[0].IncludeDatabasePatterns)
	}
	if !reflect.DeepEqual(file.Connections[0].ExcludeDatabasePatterns, []string{"team_tmp%"}) {
		t.Fatalf("expected exclude database patterns in package, got %#v", file.Connections[0].ExcludeDatabasePatterns)
	}

	importApp := NewAppWithSecretStore(newFakeAppSecretStore())
	importApp.configDir = t.TempDir()

	importedResult, err := importApp.ImportConnectionsPayload(string(raw), "")
	imported := importedResult.Connections
	if err != nil {
		t.Fatalf("ImportConnectionsPayload returned error: %v", err)
	}
	if len(imported) != 1 {
		t.Fatalf("expected 1 imported connection, got %d", len(imported))
	}
	if imported[0].HasPrimaryPassword {
		t.Fatal("expected imported connection to keep empty password when secrets are excluded")
	}
	if !reflect.DeepEqual(imported[0].IncludeDatabasePatterns, []string{"team_%", "archive*"}) {
		t.Fatalf("expected imported include database patterns, got %#v", imported[0].IncludeDatabasePatterns)
	}
	if !reflect.DeepEqual(imported[0].ExcludeDatabasePatterns, []string{"team_tmp%"}) {
		t.Fatalf("expected imported exclude database patterns, got %#v", imported[0].ExcludeDatabasePatterns)
	}

	resolved, err := importApp.resolveConnectionSecrets(imported[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "" {
		t.Fatalf("expected imported password to be empty, got %q", resolved.Password)
	}
}

func TestExportConnectionsPayloadReturnsBrowserDownloadContent(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	saveConnectionForPackageExport(t, app, "conn-browser-export", "browser-secret")

	result := app.ExportConnectionsPayload(ConnectionExportOptions{IncludeSecrets: false})
	if !result.Success {
		t.Fatalf("ExportConnectionsPayload returned failure: %+v", result)
	}

	raw, ok := result.Data.(string)
	if !ok || strings.TrimSpace(raw) == "" {
		t.Fatalf("expected browser download content, got %#v", result.Data)
	}
	if !isConnectionPackageV2AppManaged(raw) {
		t.Fatalf("expected app-managed connection package, got %s", raw)
	}

	importApp := NewAppWithSecretStore(newFakeAppSecretStore())
	importApp.configDir = t.TempDir()
	imported, err := importApp.ImportConnectionsPayload(raw, "")
	if err != nil {
		t.Fatalf("ImportConnectionsPayload returned error: %v", err)
	}
	if len(imported.Connections) != 1 || imported.Connections[0].ID != "conn-browser-export" {
		t.Fatalf("expected exported browser content to restore the connection, got %#v", imported.Connections)
	}
}

func TestImportConnectionPackagePayloadOverwritesExistingSecrets(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-1",
		Name: "Primary",
		Config: connection.ConnectionConfig{
			ID:       "conn-1",
			Type:     "postgres",
			Host:     "db.old.local",
			Port:     5432,
			User:     "postgres",
			Password: "old-primary",
			UseSSH:   true,
			SSH: connection.SSHConfig{
				Host:     "jump.old.local",
				Port:     22,
				User:     "ops",
				Password: "old-ssh",
			},
			URI: "postgres://old",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	imported, err := app.importConnectionPackagePayload(connectionPackagePayload{
		Connections: []connectionPackageItem{
			{
				ID:   "conn-1",
				Name: "Imported",
				Config: connection.ConnectionConfig{
					ID:     "conn-1",
					Type:   "postgres",
					Host:   "db.new.local",
					Port:   5432,
					User:   "postgres",
					UseSSH: true,
					SSH: connection.SSHConfig{
						Host: "jump.new.local",
						Port: 22,
						User: "ops",
					},
				},
				Secrets: connectionSecretBundle{
					Password: "new-primary",
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("importConnectionPackagePayload returned error: %v", err)
	}
	if len(imported) != 1 {
		t.Fatalf("expected 1 imported item, got %d", len(imported))
	}
	if imported[0].Name != "Imported" {
		t.Fatalf("expected imported name, got %q", imported[0].Name)
	}
	if !imported[0].HasPrimaryPassword {
		t.Fatal("expected primary password to be present after overwrite")
	}
	if imported[0].HasSSHPassword {
		t.Fatal("expected SSH password to be cleared by package overwrite")
	}
	if imported[0].HasOpaqueURI {
		t.Fatal("expected URI secret to be cleared by package overwrite")
	}

	resolved, err := app.resolveConnectionSecrets(imported[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "new-primary" {
		t.Fatalf("expected primary password to be overwritten, got %q", resolved.Password)
	}
	if resolved.SSH.Password != "" {
		t.Fatalf("expected SSH password to be cleared, got %q", resolved.SSH.Password)
	}
	if resolved.URI != "" {
		t.Fatalf("expected URI secret to be cleared, got %q", resolved.URI)
	}
}

func TestImportConnectionPackagePayloadLatestEntryWinsForSameID(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	imported, err := app.importConnectionPackagePayload(connectionPackagePayload{
		Connections: []connectionPackageItem{
			{
				ID:   "conn-dup",
				Name: "First",
				Config: connection.ConnectionConfig{
					ID:   "conn-dup",
					Type: "postgres",
					Host: "db.local",
					Port: 5432,
					User: "postgres",
				},
				Secrets: connectionSecretBundle{Password: "first-secret"},
			},
			{
				ID:   "conn-dup",
				Name: "Second",
				Config: connection.ConnectionConfig{
					ID:   "conn-dup",
					Type: "postgres",
					Host: "db.local",
					Port: 5432,
					User: "postgres",
				},
				Secrets: connectionSecretBundle{Password: "second-secret"},
			},
		},
	})
	if err != nil {
		t.Fatalf("importConnectionPackagePayload returned error: %v", err)
	}
	if len(imported) != 1 {
		t.Fatalf("expected duplicate ids to return 1 final imported item, got %d", len(imported))
	}
	if imported[0].Name != "Second" {
		t.Fatalf("expected returned import result to keep latest entry, got %q", imported[0].Name)
	}

	saved, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(saved) != 1 {
		t.Fatalf("expected 1 saved item after duplicate id overwrite, got %d", len(saved))
	}
	if saved[0].Name != "Second" {
		t.Fatalf("expected latest item to win, got %q", saved[0].Name)
	}

	resolved, err := app.resolveConnectionSecrets(saved[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "second-secret" {
		t.Fatalf("expected latest secret to win, got %q", resolved.Password)
	}
}

func TestImportConnectionsPayloadLegacyJSONRollsBackOnSaveFailure(t *testing.T) {
	withTestGOOS(t, "linux")

	failRef, err := secretstore.BuildRef(savedConnectionSecretKind, "legacy-2")
	if err != nil {
		t.Fatalf("BuildRef returned error: %v", err)
	}

	store := newFailOnPutSecretStore(failRef)
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	_, err = app.SaveConnection(connection.SavedConnectionInput{
		ID:   "legacy-1",
		Name: "Existing Legacy",
		Config: connection.ConnectionConfig{
			ID:       "legacy-1",
			Type:     "postgres",
			Host:     "db.old.local",
			Port:     5432,
			User:     "postgres",
			Password: "old-primary",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	raw, err := json.Marshal([]connection.LegacySavedConnection{
		{
			ID:   "legacy-1",
			Name: "Imported Existing Legacy",
			Config: connection.ConnectionConfig{
				ID:   "legacy-1",
				Type: "postgres",
				Host: "db.new.local",
				Port: 5432,
				User: "postgres",
			},
		},
		{
			ID:   "legacy-2",
			Name: "Imported New Legacy",
			Config: connection.ConnectionConfig{
				ID:       "legacy-2",
				Type:     "mysql",
				Host:     "db.second.local",
				Port:     3306,
				User:     "root",
				Password: "second-primary",
			},
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}

	importedResult, err := app.ImportConnectionsPayload(string(raw), "ignored")
	imported := importedResult.Connections
	if err != nil {
		t.Fatalf("expected ImportConnectionsPayload to succeed without secret store, got %v", err)
	}
	if len(imported) != 2 {
		t.Fatalf("expected 2 imported results, got %#v", imported)
	}

	saved, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(saved) != 2 {
		t.Fatalf("expected import to keep 2 legacy connections, got %d", len(saved))
	}
	if saved[0].ID != "legacy-1" || saved[0].Name != "Imported Existing Legacy" {
		t.Fatalf("expected updated legacy metadata, got %#v", saved[0])
	}
	if saved[0].Config.Host != "db.new.local" {
		t.Fatalf("expected import to update legacy host, got %q", saved[0].Config.Host)
	}

	resolved, err := app.resolveConnectionSecrets(saved[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "" {
		t.Fatalf("expected legacy import without password to clear stored password, got %q", resolved.Password)
	}

	if _, err := store.Get(failRef); !os.IsNotExist(err) {
		t.Fatalf("expected rollback to remove partially imported legacy secret ref, got err=%v", err)
	}
}

func TestImportLegacyConnectionsRollbackRemovesGeneratedSecretRefs(t *testing.T) {
	withTestGOOS(t, "linux")

	failRef, err := secretstore.BuildRef(savedConnectionSecretKind, "legacy-2")
	if err != nil {
		t.Fatalf("BuildRef returned error: %v", err)
	}

	store := newFailOnPutSecretStore(failRef)
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	imported, err := app.ImportLegacyConnections([]connection.LegacySavedConnection{
		{
			Name: "Generated ID Legacy",
			Config: connection.ConnectionConfig{
				Type:     "postgres",
				Host:     "db.generated.local",
				Port:     5432,
				User:     "postgres",
				Password: "generated-secret",
			},
		},
		{
			ID:   "legacy-2",
			Name: "Will Fail",
			Config: connection.ConnectionConfig{
				ID:       "legacy-2",
				Type:     "mysql",
				Host:     "db.fail.local",
				Port:     3306,
				User:     "root",
				Password: "fail-secret",
			},
		},
	})
	if err != nil {
		t.Fatalf("expected ImportLegacyConnections to succeed without secret store, got %v", err)
	}
	if len(imported) != 2 {
		t.Fatalf("expected 2 imported results after import, got %#v", imported)
	}

	saved, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(saved) != 2 {
		t.Fatalf("expected imported connections to be persisted, got %d saved connections", len(saved))
	}

	if got := len(store.base.items); got != 0 {
		t.Fatalf("expected rollback to remove generated secret refs, got %d remaining items", got)
	}
	if _, err := store.Get(failRef); !os.IsNotExist(err) {
		t.Fatalf("expected rollback to remove failed explicit secret ref, got err=%v", err)
	}
}

func TestImportConnectionPackagePayloadRollsBackOnSaveFailure(t *testing.T) {
	withTestGOOS(t, "linux")

	failRef, err := secretstore.BuildRef(savedConnectionSecretKind, "conn-2")
	if err != nil {
		t.Fatalf("BuildRef returned error: %v", err)
	}

	store := newFailOnPutSecretStore(failRef)
	app := NewAppWithSecretStore(store)
	app.configDir = t.TempDir()

	_, err = app.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-1",
		Name: "Existing",
		Config: connection.ConnectionConfig{
			ID:       "conn-1",
			Type:     "postgres",
			Host:     "db.old.local",
			Port:     5432,
			User:     "postgres",
			Password: "old-primary",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	imported, err := app.importConnectionPackagePayload(connectionPackagePayload{
		Connections: []connectionPackageItem{
			{
				ID:   "conn-1",
				Name: "Imported Existing",
				Config: connection.ConnectionConfig{
					ID:   "conn-1",
					Type: "postgres",
					Host: "db.new.local",
					Port: 5432,
					User: "postgres",
				},
				Secrets: connectionSecretBundle{Password: "new-primary"},
			},
			{
				ID:   "conn-2",
				Name: "Imported New",
				Config: connection.ConnectionConfig{
					ID:   "conn-2",
					Type: "mysql",
					Host: "db.second.local",
					Port: 3306,
					User: "root",
				},
				Secrets: connectionSecretBundle{Password: "second-primary"},
			},
		},
	})
	if err != nil {
		t.Fatalf("expected importConnectionPackagePayload to succeed without secret store, got %v", err)
	}
	if len(imported) != 2 {
		t.Fatalf("expected 2 imported results after import, got %#v", imported)
	}

	saved, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(saved) != 2 {
		t.Fatalf("expected import to keep 2 connections, got %d", len(saved))
	}
	if saved[0].ID != "conn-1" || saved[0].Name != "Imported Existing" {
		t.Fatalf("expected imported connection metadata, got %#v", saved[0])
	}
	if saved[0].Config.Host != "db.new.local" {
		t.Fatalf("expected import to update host, got %q", saved[0].Config.Host)
	}

	resolved, err := app.resolveConnectionSecrets(saved[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "new-primary" {
		t.Fatalf("expected import to update primary password, got %q", resolved.Password)
	}

	if _, err := store.Get(failRef); !os.IsNotExist(err) {
		t.Fatalf("expected rollback to remove partially imported secret ref, got err=%v", err)
	}
}

func TestImportConnectionsPayloadLegacyJSONClearsExistingSecretWhenMissing(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "legacy-1",
		Name: "Legacy",
		Config: connection.ConnectionConfig{
			ID:       "legacy-1",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "postgres",
			Password: "legacy-secret",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	raw, err := json.Marshal([]connection.LegacySavedConnection{
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
	})
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}

	importedResult, err := app.ImportConnectionsPayload(string(raw), "ignored")
	imported := importedResult.Connections
	if err != nil {
		t.Fatalf("ImportConnectionsPayload returned error: %v", err)
	}
	if len(imported) != 1 {
		t.Fatalf("expected 1 imported item, got %d", len(imported))
	}
	if imported[0].Name != "Legacy Updated" {
		t.Fatalf("expected legacy metadata to be overwritten, got %q", imported[0].Name)
	}

	resolved, err := app.resolveConnectionSecrets(imported[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "" {
		t.Fatalf("expected legacy import to clear existing secret when the imported file omits it, got %q", resolved.Password)
	}
}

func TestImportConnectionsPayloadLegacyJSONLatestEntryWinsForSameID(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	raw, err := json.Marshal([]connection.LegacySavedConnection{
		{
			ID:   "legacy-dup",
			Name: "First",
			Config: connection.ConnectionConfig{
				ID:       "legacy-dup",
				Type:     "postgres",
				Host:     "db.first.local",
				Port:     5432,
				User:     "postgres",
				Password: "first-secret",
			},
		},
		{
			ID:   "legacy-dup",
			Name: "Second",
			Config: connection.ConnectionConfig{
				ID:       "legacy-dup",
				Type:     "postgres",
				Host:     "db.second.local",
				Port:     5432,
				User:     "postgres",
				Password: "second-secret",
			},
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}

	importedResult, err := app.ImportConnectionsPayload(string(raw), "ignored")
	imported := importedResult.Connections
	if err != nil {
		t.Fatalf("ImportConnectionsPayload returned error: %v", err)
	}
	if len(imported) != 1 {
		t.Fatalf("expected duplicate legacy ids to return 1 final imported item, got %d", len(imported))
	}
	if imported[0].Name != "Second" {
		t.Fatalf("expected returned import result to keep latest legacy entry, got %q", imported[0].Name)
	}

	saved, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(saved) != 1 {
		t.Fatalf("expected 1 saved legacy item after duplicate id overwrite, got %d", len(saved))
	}
	if saved[0].Name != "Second" {
		t.Fatalf("expected latest legacy item to win, got %q", saved[0].Name)
	}

	resolved, err := app.resolveConnectionSecrets(saved[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "second-secret" {
		t.Fatalf("expected latest legacy secret to win, got %q", resolved.Password)
	}
}

func TestImportConnectionsPayloadLegacyJSONLatestEntryWithoutPasswordDoesNotKeepEarlierDuplicateSecret(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	raw, err := json.Marshal([]connection.LegacySavedConnection{
		{
			ID:   "legacy-dup",
			Name: "First",
			Config: connection.ConnectionConfig{
				ID:       "legacy-dup",
				Type:     "postgres",
				Host:     "db.first.local",
				Port:     5432,
				User:     "postgres",
				Password: "first-secret",
			},
		},
		{
			ID:   "legacy-dup",
			Name: "Second",
			Config: connection.ConnectionConfig{
				ID:   "legacy-dup",
				Type: "postgres",
				Host: "db.second.local",
				Port: 5432,
				User: "postgres",
			},
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}

	importedResult, err := app.ImportConnectionsPayload(string(raw), "ignored")
	imported := importedResult.Connections
	if err != nil {
		t.Fatalf("ImportConnectionsPayload returned error: %v", err)
	}
	if len(imported) != 1 {
		t.Fatalf("expected duplicate legacy ids to return 1 final imported item, got %d", len(imported))
	}

	saved, err := app.GetSavedConnections()
	if err != nil {
		t.Fatalf("GetSavedConnections returned error: %v", err)
	}
	if len(saved) != 1 {
		t.Fatalf("expected 1 saved legacy item after duplicate id overwrite, got %d", len(saved))
	}
	if saved[0].HasPrimaryPassword {
		t.Fatalf("expected latest legacy item without password to clear earlier duplicate secret, got view=%#v", saved[0])
	}

	resolved, err := app.resolveConnectionSecrets(saved[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "" {
		t.Fatalf("expected latest legacy item without password to keep empty secret, got %q", resolved.Password)
	}
}

func TestImportConnectionsPayloadEnvelopeRejectsOversizedPayloadWithDedicatedError(t *testing.T) {
	raw, err := json.Marshal(connectionPackageFile{
		SchemaVersion: connectionPackageSchemaVersion,
		Kind:          connectionPackageKind,
		Cipher:        connectionPackageCipher,
		KDF: connectionPackageKDFSpec{
			Name:        connectionPackageKDFName,
			MemoryKiB:   connectionPackageKDFDefaultMemoryKiB,
			TimeCost:    connectionPackageKDFDefaultTimeCost,
			Parallelism: connectionPackageKDFDefaultParallelism,
			Salt:        "AAAAAAAAAAAAAAAAAAAAAA==",
		},
		Nonce:   "AAAAAAAAAAAAAAAA",
		Payload: strings.Repeat("A", connectionPackageMaxPayloadBase64Bytes+4),
	})
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}

	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	_, err = app.ImportConnectionsPayload(string(raw), "package-password")
	if !errors.Is(err, errConnectionPackagePayloadTooLarge) {
		t.Fatalf("expected errConnectionPackagePayloadTooLarge, got %v", err)
	}
}

func TestImportConnectionsPayloadEnvelopeRequiresPassword(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	raw := `{
  "schemaVersion": 1,
  "kind": "gonavi_connection_package",
  "cipher": "AES-256-GCM",
  "kdf": {
    "name": "Argon2id",
    "memoryKiB": 65536,
    "timeCost": 3,
    "parallelism": 4,
    "salt": "salt"
  },
  "nonce": "nonce",
  "payload": "payload"
}`

	_, err := app.ImportConnectionsPayload(raw, "")
	if !errors.Is(err, errConnectionPackagePasswordRequired) {
		t.Fatalf("expected errConnectionPackagePasswordRequired, got %v", err)
	}
}

func TestImportConnectionsPayloadEnvelopeImportsAndOverwritesSecrets(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-1",
		Name: "Existing",
		Config: connection.ConnectionConfig{
			ID:       "conn-1",
			Type:     "postgres",
			Host:     "db.old.local",
			Port:     5432,
			User:     "postgres",
			Password: "old-primary",
			UseSSH:   true,
			SSH: connection.SSHConfig{
				Host:     "jump.old.local",
				Port:     22,
				User:     "ops",
				Password: "old-ssh",
			},
			URI: "postgres://old",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	file, err := encryptConnectionPackage(connectionPackagePayload{
		Connections: []connectionPackageItem{
			{
				ID:   "conn-1",
				Name: "Imported",
				Config: connection.ConnectionConfig{
					ID:   "conn-1",
					Type: "postgres",
					Host: "db.new.local",
					Port: 5432,
					User: "postgres",
				},
				Secrets: connectionSecretBundle{
					Password: "new-primary",
				},
			},
		},
	}, "package-password")
	if err != nil {
		t.Fatalf("encryptConnectionPackage returned error: %v", err)
	}

	raw, err := json.Marshal(file)
	if err != nil {
		t.Fatalf("json.Marshal returned error: %v", err)
	}

	importedResult, err := app.ImportConnectionsPayload(string(raw), "package-password")
	imported := importedResult.Connections
	if err != nil {
		t.Fatalf("ImportConnectionsPayload returned error: %v", err)
	}
	if len(imported) != 1 {
		t.Fatalf("expected 1 imported item, got %d", len(imported))
	}
	if imported[0].Name != "Imported" {
		t.Fatalf("expected imported name, got %q", imported[0].Name)
	}
	if !imported[0].HasPrimaryPassword {
		t.Fatal("expected primary password after envelope import")
	}
	if imported[0].HasSSHPassword {
		t.Fatal("expected missing SSH password in package to clear old secret")
	}
	if imported[0].HasOpaqueURI {
		t.Fatal("expected missing URI in package to clear old secret")
	}

	resolved, err := app.resolveConnectionSecrets(imported[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "new-primary" {
		t.Fatalf("expected primary password to be overwritten, got %q", resolved.Password)
	}
	if resolved.SSH.Password != "" {
		t.Fatalf("expected SSH password to be cleared, got %q", resolved.SSH.Password)
	}
	if resolved.URI != "" {
		t.Fatalf("expected URI secret to be cleared, got %q", resolved.URI)
	}
}

func TestBuildExportedConnectionPackageWithSecretsUsesV2AppManagedEncryption(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	saveConnectionForPackageExport(t, app, "conn-v2-app", "app-secret")

	raw, err := app.buildExportedConnectionPackage(ConnectionExportOptions{
		IncludeSecrets: true,
	})
	if err != nil {
		t.Fatalf("buildExportedConnectionPackage returned error: %v", err)
	}

	rawString := string(raw)
	if !isConnectionPackageV2AppManaged(rawString) {
		t.Fatalf("expected app-managed export, got %s", rawString)
	}
	for _, forbidden := range []string{
		"app-secret",
		"schemaVersion",
		"cipher",
		"ENC:",
	} {
		if strings.Contains(rawString, forbidden) {
			t.Fatalf("v2 p=1 export must not contain %q: %s", forbidden, rawString)
		}
	}

	importedResult, err := app.ImportConnectionsPayload(rawString, "")
	imported := importedResult.Connections
	if err != nil {
		t.Fatalf("ImportConnectionsPayload returned error: %v", err)
	}
	if len(imported) != 1 {
		t.Fatalf("expected 1 imported item, got %d", len(imported))
	}

	resolved, err := app.resolveConnectionSecrets(imported[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "app-secret" {
		t.Fatalf("expected v2 p=1 import to restore password, got %q", resolved.Password)
	}
}

func TestBuildExportedConnectionPackageWithFilePasswordUsesV2ProtectedEnvelope(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	saveConnectionForPackageExport(t, app, "conn-v2-protected", "protected-secret")

	raw, err := app.buildExportedConnectionPackage(ConnectionExportOptions{
		IncludeSecrets: true,
		FilePassword:   "package-password",
	})
	if err != nil {
		t.Fatalf("buildExportedConnectionPackage returned error: %v", err)
	}

	rawString := string(raw)
	if !isConnectionPackageV2Protected(rawString) {
		t.Fatalf("expected password-protected export, got %s", rawString)
	}
	if strings.Contains(rawString, "protected-secret") {
		t.Fatalf("v2 p=2 export must not contain plaintext secret: %s", rawString)
	}

	_, err = app.ImportConnectionsPayload(rawString, "wrong-password")
	if !errors.Is(err, errConnectionPackageDecryptFailed) {
		t.Fatalf("wrong v2 p=2 password should return unified error, got %v", err)
	}

	importedResult, err := app.ImportConnectionsPayload(rawString, "package-password")
	imported := importedResult.Connections
	if err != nil {
		t.Fatalf("ImportConnectionsPayload returned error: %v", err)
	}
	if len(imported) != 1 {
		t.Fatalf("expected 1 imported item, got %d", len(imported))
	}

	resolved, err := app.resolveConnectionSecrets(imported[0].Config)
	if err != nil {
		t.Fatalf("resolveConnectionSecrets returned error: %v", err)
	}
	if resolved.Password != "protected-secret" {
		t.Fatalf("expected v2 p=2 import to restore password, got %q", resolved.Password)
	}
}

func TestNormalizeConnectionPackageExportFilenameAddsExtension(t *testing.T) {
	filename := normalizeConnectionPackageExportFilename(`C:\tmp\connections`)
	if !strings.HasSuffix(filename, connectionPackageExtension) {
		t.Fatalf("expected filename to end with %q, got %q", connectionPackageExtension, filename)
	}

	alreadyExtended := normalizeConnectionPackageExportFilename(`C:\tmp\connections` + connectionPackageExtension)
	if alreadyExtended != `C:\tmp\connections`+connectionPackageExtension {
		t.Fatalf("expected existing extension to be preserved, got %q", alreadyExtended)
	}
}

func TestBuildExportedConnectionPackageCarriesRedisDbAliases(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   "redis-1",
		Name: "Cache",
		Config: connection.ConnectionConfig{
			ID:   "redis-1",
			Type: "redis",
			Host: "127.0.0.1",
			Port: 6379,
		},
		IncludeRedisDatabases: []int{0, 1},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	aliases := map[string]map[string]string{
		"redis-1": {
			"0": "cache",
			"1": "sessions",
		},
		// malformed entries must be dropped by sanitize
		"":      {"0": "orphan"},
		"other": {"x": "bad-index", "2": "  "},
	}

	raw, err := app.buildExportedConnectionPackage(ConnectionExportOptions{
		IncludeSecrets: false,
		RedisDbAliases: aliases,
	})
	if err != nil {
		t.Fatalf("buildExportedConnectionPackage returned error: %v", err)
	}

	importApp := NewAppWithSecretStore(newFakeAppSecretStore())
	importApp.configDir = t.TempDir()

	importedResult, err := importApp.ImportConnectionsPayload(string(raw), "")
	if err != nil {
		t.Fatalf("ImportConnectionsPayload returned error: %v", err)
	}
	if len(importedResult.Connections) != 1 {
		t.Fatalf("expected 1 imported connection, got %d", len(importedResult.Connections))
	}
	if importedResult.Connections[0].ID != "redis-1" {
		t.Fatalf("expected redis-1, got %q", importedResult.Connections[0].ID)
	}
	if importedResult.RedisDbAliases == nil {
		t.Fatal("expected RedisDbAliases in import result")
	}
	got := importedResult.RedisDbAliases["redis-1"]
	if got == nil {
		t.Fatalf("expected aliases for redis-1, got %#v", importedResult.RedisDbAliases)
	}
	if got["0"] != "cache" || got["1"] != "sessions" {
		t.Fatalf("unexpected redis aliases: %#v", got)
	}
	if _, ok := importedResult.RedisDbAliases[""]; ok {
		t.Fatal("empty connection id should not appear in imported aliases")
	}
	if _, ok := importedResult.RedisDbAliases["other"]; ok {
		t.Fatal("malformed aliases should be dropped")
	}

	// payload 内连接项也应携带别名（便于单项迁移）
	payload, err := app.buildConnectionPackagePayload(aliases, nil)
	if err != nil {
		t.Fatalf("buildConnectionPackagePayload returned error: %v", err)
	}
	if payload.Connections[0].RedisDbAliases["0"] != "cache" {
		t.Fatalf("expected item-level alias cache, got %#v", payload.Connections[0].RedisDbAliases)
	}
	if payload.RedisDbAliases["redis-1"]["1"] != "sessions" {
		t.Fatalf("expected top-level alias sessions, got %#v", payload.RedisDbAliases)
	}
}

func TestBuildConnectionPackagePayloadFiltersByConnectionIDs(t *testing.T) {
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()

	for _, item := range []connection.SavedConnectionInput{
		{
			ID:   "conn-a",
			Name: "A",
			Config: connection.ConnectionConfig{
				ID:   "conn-a",
				Type: "mysql",
				Host: "127.0.0.1",
				Port: 3306,
			},
		},
		{
			ID:   "conn-b",
			Name: "B",
			Config: connection.ConnectionConfig{
				ID:   "conn-b",
				Type: "mysql",
				Host: "127.0.0.1",
				Port: 3307,
			},
		},
	} {
		if _, err := app.SaveConnection(item); err != nil {
			t.Fatalf("SaveConnection %s: %v", item.ID, err)
		}
	}

	payload, err := app.buildConnectionPackagePayload(nil, []string{"conn-b"})
	if err != nil {
		t.Fatalf("buildConnectionPackagePayload returned error: %v", err)
	}
	if len(payload.Connections) != 1 {
		t.Fatalf("expected 1 connection, got %d", len(payload.Connections))
	}
	if payload.Connections[0].ID != "conn-b" {
		t.Fatalf("expected conn-b, got %q", payload.Connections[0].ID)
	}

	if _, err := app.buildConnectionPackagePayload(nil, []string{"missing-id"}); err == nil {
		t.Fatal("expected error when filter matches no connections")
	}
}

func TestConnectionPackageRoundTripPreservesSchemaVisibilityByDatabase(t *testing.T) {
	sourceApp := NewAppWithSecretStore(newFakeAppSecretStore())
	sourceApp.configDir = t.TempDir()

	expected := map[string]connection.SchemaVisibilityRule{
		"master": {
			Mode:    "exclude",
			Schemas: []string{"db_accessadmin", "db_backupoperator"},
		},
		"appdb": {
			Mode:    "include",
			Schemas: []string{"dbo", "reporting"},
		},
	}
	_, err := sourceApp.SaveConnection(connection.SavedConnectionInput{
		ID:                         "mssql-1",
		Name:                       "SQL Server",
		SchemaVisibilityByDatabase: expected,
		Config: connection.ConnectionConfig{
			ID:   "mssql-1",
			Type: "mssql",
			Host: "db.local",
			Port: 1433,
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	raw, err := sourceApp.buildExportedConnectionPackage(ConnectionExportOptions{IncludeSecrets: false})
	if err != nil {
		t.Fatalf("buildExportedConnectionPackage returned error: %v", err)
	}

	importApp := NewAppWithSecretStore(newFakeAppSecretStore())
	importApp.configDir = t.TempDir()
	importedResult, err := importApp.ImportConnectionsPayload(string(raw), "")
	if err != nil {
		t.Fatalf("ImportConnectionsPayload returned error: %v", err)
	}
	if len(importedResult.Connections) != 1 {
		t.Fatalf("expected one imported connection, got %d", len(importedResult.Connections))
	}
	if !reflect.DeepEqual(importedResult.Connections[0].SchemaVisibilityByDatabase, expected) {
		t.Fatalf("expected schema visibility rules to round-trip, got %#v", importedResult.Connections[0].SchemaVisibilityByDatabase)
	}
}

type failOnPutSecretStore struct {
	base    *fakeAppSecretStore
	failRef string
}

func newFailOnPutSecretStore(failRef string) *failOnPutSecretStore {
	return &failOnPutSecretStore{
		base:    newFakeAppSecretStore(),
		failRef: failRef,
	}
}

func saveConnectionForPackageExport(t *testing.T, app *App, id string, primaryPassword string) {
	t.Helper()

	_, err := app.SaveConnection(connection.SavedConnectionInput{
		ID:   id,
		Name: "Exported " + id,
		Config: connection.ConnectionConfig{
			ID:       id,
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "postgres",
			Password: primaryPassword,
			UseSSH:   true,
			SSH: connection.SSHConfig{
				Host:     "jump.local",
				Port:     22,
				User:     "ops",
				Password: "ssh-" + primaryPassword,
			},
			URI: "postgres://postgres:" + primaryPassword + "@db.local/app",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}
}

func (s *failOnPutSecretStore) Put(ref string, payload []byte) error {
	if ref == s.failRef {
		return errors.New("injected put failure")
	}
	return s.base.Put(ref, payload)
}

func (s *failOnPutSecretStore) Get(ref string) ([]byte, error) {
	return s.base.Get(ref)
}

func (s *failOnPutSecretStore) Delete(ref string) error {
	return s.base.Delete(ref)
}

func (s *failOnPutSecretStore) HealthCheck() error {
	return s.base.HealthCheck()
}
