package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"GoNavi-Wails/internal/cloudbackup"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/secretstore"
)

type startupSecretStoreProbe struct {
	gets         atomic.Int32
	healthChecks atomic.Int32
}

func (s *startupSecretStoreProbe) Put(string, []byte) error { return nil }

func (s *startupSecretStoreProbe) Get(string) ([]byte, error) {
	s.gets.Add(1)
	return nil, os.ErrNotExist
}

func (s *startupSecretStoreProbe) Delete(string) error { return nil }

func (s *startupSecretStoreProbe) HealthCheck() error {
	s.healthChecks.Add(1)
	return nil
}

var _ secretstore.SecretStore = (*startupSecretStoreProbe)(nil)

func TestInitializeCloudBackupDoesNotReadSecretStore(t *testing.T) {
	probe := &startupSecretStoreProbe{}
	application := NewAppWithSecretStore(probe)
	application.configDir = t.TempDir()
	if err := application.saveCloudBackupState(CloudBackupConfig{
		Enabled:          true,
		Provider:         CloudBackupProviderWebDAV,
		Schedule:         CloudBackupScheduleManual,
		BackupCategories: defaultCloudBackupCategories(),
	}); err != nil {
		t.Fatalf("save cloud backup metadata: %v", err)
	}

	application.initializeCloudBackup(context.Background())
	t.Cleanup(application.shutdownCloudBackup)
	if got := probe.gets.Load(); got != 0 {
		t.Fatalf("startup read %d secrets from the OS store", got)
	}
	if got := probe.healthChecks.Load(); got != 0 {
		t.Fatalf("startup performed %d OS store health checks", got)
	}
}

const cloudBackupRestoreTestPassword = "cloud-backup-layout-test-password"

func configureCloudBackupRestoreTestPayload(t *testing.T, application *App, payload cloudBackupPayload) {
	t.Helper()
	if payload.SchemaVersion == 0 {
		payload.SchemaVersion = cloudBackupPayloadSchemaVersion
	}
	if payload.CreatedAt == "" {
		payload.CreatedAt = "2026-08-25T00:00:00Z"
	}
	plain, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal cloud backup restore payload: %v", err)
	}
	envelope, err := cloudbackup.Encrypt(plain, cloudBackupRestoreTestPassword)
	if err != nil {
		t.Fatalf("encrypt cloud backup restore payload: %v", err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(envelope)
	}))
	t.Cleanup(server.Close)
	if _, err := application.SaveCloudBackupConfig(CloudBackupConfigInput{
		Provider:           CloudBackupProviderWebDAV,
		WebDAVEndpoint:     server.URL,
		WebDAVFilePath:     "backup.gonavi",
		Schedule:           CloudBackupScheduleManual,
		WebDAVUsername:     "layout-test-user",
		WebDAVPassword:     "layout-test-password",
		EncryptionPassword: cloudBackupRestoreTestPassword,
	}); err != nil {
		t.Fatalf("configure cloud backup restore payload: %v", err)
	}
}

func restoreCloudBackupTestPayload(t *testing.T, application *App, categories ...string) error {
	t.Helper()
	preview, err := application.CloudBackupPreviewRestore()
	if err != nil {
		t.Fatalf("preview cloud backup restore payload: %v", err)
	}
	_, err = application.CloudBackupRestore(CloudBackupRestoreRequest{
		ConfirmationToken: preview.ConfirmationToken,
		Categories:        categories,
	})
	return err
}

func cloudBackupLayoutTestConnection(id, name, host string) connectionPackageItem {
	return connectionPackageItem{
		ID:   id,
		Name: name,
		Config: connection.ConnectionConfig{
			ID: id, Type: "mysql", Host: host, Port: 3306, User: "root", Database: "layout_test",
		},
	}
}

func seedCloudBackupLayoutTestState(t *testing.T, application *App) connection.ConnectionSidebarLayout {
	t.Helper()
	if _, err := application.SaveConnection(connection.SavedConnectionInput{
		ID: "shared-layout-host", Name: "Local layout host",
		Config: connection.ConnectionConfig{
			ID: "shared-layout-host", Type: "mysql", Host: "local-layout.example.test", Port: 3306,
		},
	}); err != nil {
		t.Fatalf("seed local layout connection: %v", err)
	}
	layout, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID: "local-layout-group", Name: "Local layout group",
			ConnectionIDs: []string{"shared-layout-host"},
			ChildOrder:    []string{"connection:shared-layout-host"},
		}},
		SidebarRootOrder: []string{"tag:local-layout-group"},
	})
	if err != nil {
		t.Fatalf("seed local sidebar layout: %v", err)
	}
	return layout
}

func TestCloudBackupSyncPreviewAndRestore(t *testing.T) {
	store := newFakeAppSecretStore()
	application := NewAppWithSecretStore(store)
	application.configDir = t.TempDir()
	var remotePayload []byte
	collectionExists := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			if !collectionExists {
				w.WriteHeader(http.StatusConflict)
				return
			}
			var err error
			remotePayload, err = io.ReadAll(r.Body)
			if err != nil {
				t.Fatalf("read PUT body: %v", err)
			}
			w.Header().Set("ETag", `"test-etag"`)
			w.Header().Set("Last-Modified", "Tue, 28 Jul 2026 12:00:00 GMT")
			w.WriteHeader(http.StatusCreated)
		case "MKCOL":
			collectionExists = true
			w.WriteHeader(http.StatusCreated)
		case http.MethodHead:
			w.Header().Set("Content-Length", "123")
			w.Header().Set("ETag", `"test-etag"`)
			w.Header().Set("Last-Modified", "Tue, 28 Jul 2026 12:00:00 GMT")
			w.WriteHeader(http.StatusOK)
		case http.MethodGet:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(remotePayload)
		default:
			w.WriteHeader(http.StatusMethodNotAllowed)
		}
	}))
	defer server.Close()

	config, err := application.SaveCloudBackupConfig(CloudBackupConfigInput{
		Enabled: true, Provider: CloudBackupProviderWebDAV, WebDAVEndpoint: server.URL,
		WebDAVFilePath: "gonavi/backup.gonavi", Schedule: CloudBackupScheduleManual,
		WebDAVUsername: "user", WebDAVPassword: "pass", EncryptionPassword: "backup-pass",
	})
	if err != nil {
		t.Fatalf("SaveCloudBackupConfig returned error: %v", err)
	}
	if !config.HasWebDAVCredential || config.HasS3Credential || !config.HasEncryptionKey {
		t.Fatalf("expected secret markers in config view: %#v", config)
	}
	configData, err := os.ReadFile(filepath.Join(application.configDir, cloudBackupConfigFileName))
	if err != nil {
		t.Fatalf("read cloud backup config: %v", err)
	}
	if strings.Contains(string(configData), "backup-pass") || strings.Contains(string(configData), "user") {
		t.Fatalf("cloud backup config contains plaintext secret: %s", configData)
	}
	if !strings.Contains(string(configData), `"webdavEndpoint"`) || !strings.Contains(string(configData), `"webdavFilePath"`) {
		t.Fatalf("cloud backup config did not persist WebDAV-specific fields: %s", configData)
	}
	if strings.Contains(string(configData), `"endpoint"`) || strings.Contains(string(configData), `"objectKey"`) {
		t.Fatalf("cloud backup config still contains legacy shared fields: %s", configData)
	}
	if strings.Contains(string(configData), `"hasRemoteCredential"`) || strings.Contains(string(configData), `"hasWebdavCredential"`) || strings.Contains(string(configData), `"hasS3Credential"`) || strings.Contains(string(configData), `"hasEncryptionKey"`) {
		t.Fatalf("cloud backup config persisted keyring-only credential markers: %s", configData)
	}
	var persistedConfig cloudBackupPersisted
	if err := json.Unmarshal(configData, &persistedConfig); err != nil {
		t.Fatalf("decode persisted cloud backup config: %v", err)
	}
	if persistedConfig.SchemaVersion != 3 {
		t.Fatalf("cloud backup config schema version = %d, want 3", persistedConfig.SchemaVersion)
	}
	if len(persistedConfig.Config.BackupCategories) != len(defaultCloudBackupCategories()) {
		t.Fatalf("default backup categories were not persisted: %#v", persistedConfig.Config.BackupCategories)
	}
	if _, err := application.SaveConnection(connection.SavedConnectionInput{
		ID: "round-trip", Name: "Round Trip",
		Config: connection.ConnectionConfig{ID: "round-trip", Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root", Database: "test", Password: "connection-secret"},
	}); err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}
	if _, err := application.SaveQuery(connection.SavedQuery{
		ID: "shared-query", Name: "Remote Query", SQL: "select 'remote'", ConnectionID: "round-trip", DBName: "test", CreatedAt: 100,
	}); err != nil {
		t.Fatalf("SaveQuery returned error: %v", err)
	}
	dirtyStatus, err := application.CloudBackupGetStatus()
	if err != nil || !dirtyStatus.Dirty {
		t.Fatalf("saved local changes should mark cloud backup dirty: status=%#v err=%v", dirtyStatus, err)
	}

	status, err := application.CloudBackupSyncNow()
	if err != nil {
		t.Fatalf("CloudBackupSyncNow returned error: %v", err)
	}
	if !status.LastSyncSuccess || status.Dirty || len(remotePayload) == 0 {
		t.Fatalf("unexpected sync status/payload: %#v payload=%d", status, len(remotePayload))
	}
	if strings.Contains(string(remotePayload), "backup-pass") || strings.Contains(string(remotePayload), "user") {
		t.Fatal("remote payload contains plaintext credentials")
	}
	plainPayload, err := cloudbackup.Decrypt(remotePayload, "backup-pass")
	if err != nil {
		t.Fatalf("decrypt uploaded cloud backup payload: %v", err)
	}
	var uploadedPayload cloudBackupPayload
	if err := json.Unmarshal(plainPayload, &uploadedPayload); err != nil {
		t.Fatalf("decode uploaded cloud backup payload: %v", err)
	}
	if uploadedPayload.SchemaVersion != 1 {
		t.Fatalf("cloud backup payload schema version = %d, want 1", uploadedPayload.SchemaVersion)
	}

	preview, err := application.CloudBackupPreviewRestore()
	if err != nil {
		t.Fatalf("CloudBackupPreviewRestore returned error: %v", err)
	}
	if preview.ConnectionCount != 1 || preview.CreatedAt == "" {
		t.Fatalf("unexpected restore preview: %#v", preview)
	}
	var connectionPreview *CloudBackupCategory
	for index := range preview.Categories {
		if preview.Categories[index].ID == CloudBackupCategoryConnections {
			connectionPreview = &preview.Categories[index]
			break
		}
	}
	if connectionPreview == nil || len(connectionPreview.Connections) != 1 || connectionPreview.Connections[0].Name != "Round Trip" || connectionPreview.Connections[0].Host != "127.0.0.1" {
		t.Fatalf("restore preview did not expose the safe connection summary: %#v", connectionPreview)
	}
	previewJSON, err := json.Marshal(preview)
	if err != nil {
		t.Fatalf("marshal restore preview: %v", err)
	}
	if strings.Contains(string(previewJSON), "connection-secret") || strings.Contains(string(previewJSON), `"user"`) || strings.Contains(string(previewJSON), `"config"`) {
		t.Fatalf("restore preview leaked connection configuration: %s", previewJSON)
	}
	if _, err := application.CloudBackupRestore(CloudBackupRestoreRequest{}); err == nil {
		t.Fatal("restore without confirmation should fail")
	}

	destination := NewAppWithSecretStore(newFakeAppSecretStore())
	destination.configDir = t.TempDir()
	if _, err := destination.SaveCloudBackupConfig(CloudBackupConfigInput{
		Enabled: true, Provider: CloudBackupProviderWebDAV, WebDAVEndpoint: server.URL,
		WebDAVFilePath: "gonavi/backup.gonavi", Schedule: CloudBackupScheduleManual,
		WebDAVUsername: "user", WebDAVPassword: "pass", EncryptionPassword: "backup-pass",
	}); err != nil {
		t.Fatalf("destination SaveCloudBackupConfig returned error: %v", err)
	}
	for _, input := range []connection.SavedConnectionInput{
		{ID: "round-trip", Name: "Stale Remote", Config: connection.ConnectionConfig{ID: "round-trip", Type: "mysql", Host: "old.example.test", Port: 3306, User: "old", Database: "test", Password: "stale-secret"}},
		{ID: "local-only", Name: "Local Only", Config: connection.ConnectionConfig{ID: "local-only", Type: "postgresql", Host: "local.example.test", Port: 5432, User: "local", Database: "local", Password: "local-secret"}},
	} {
		if _, err := destination.SaveConnection(input); err != nil {
			t.Fatalf("seed destination connection %s: %v", input.ID, err)
		}
	}
	for _, query := range []connection.SavedQuery{
		{ID: "shared-query", Name: "Stale Query", SQL: "select 'stale'", ConnectionID: "round-trip", DBName: "test", CreatedAt: 1},
		{ID: "local-query", Name: "Local Query", SQL: "select 'local'", ConnectionID: "local-only", DBName: "local", CreatedAt: 2},
	} {
		if _, err := destination.SaveQuery(query); err != nil {
			t.Fatalf("seed destination query %s: %v", query.ID, err)
		}
	}
	destinationPreview, err := destination.CloudBackupPreviewRestore()
	if err != nil {
		t.Fatalf("destination CloudBackupPreviewRestore returned error: %v", err)
	}
	if destinationPreview.ConnectionCount != 1 {
		t.Fatalf("destination failed to identify uploaded connection: %#v", destinationPreview)
	}
	restoreCategories := make([]string, 0, len(destinationPreview.Categories))
	for _, category := range destinationPreview.Categories {
		restoreCategories = append(restoreCategories, category.ID)
	}
	if _, err := destination.CloudBackupRestore(CloudBackupRestoreRequest{
		ConfirmationToken: destinationPreview.ConfirmationToken,
		Categories:        restoreCategories,
	}); err != nil {
		t.Fatalf("destination restore returned error: %v", err)
	}
	connections, err := destination.GetSavedConnections()
	if err != nil {
		t.Fatalf("destination GetSavedConnections returned error: %v", err)
	}
	if len(connections) != 2 {
		t.Fatalf("connection restore did not preserve local-only records: %#v", connections)
	}
	restoredConnection, err := destination.savedConnectionRepository().Find("round-trip")
	if err != nil || restoredConnection.Name != "Round Trip" || restoredConnection.Config.Host != "127.0.0.1" {
		t.Fatalf("same-id connection was not updated from backup: connection=%#v err=%v", restoredConnection, err)
	}
	localConnection, err := destination.savedConnectionRepository().Find("local-only")
	if err != nil {
		t.Fatalf("local-only connection was removed: %v", err)
	}
	localSecret, err := destination.savedConnectionRepository().loadSecretBundle(localConnection)
	if err != nil || localSecret.Password != "local-secret" {
		t.Fatalf("local-only connection secret was not preserved: bundle=%#v err=%v", localSecret, err)
	}
	restoredQueries, err := destination.GetSavedQueries()
	if err != nil {
		t.Fatalf("destination GetSavedQueries returned error: %v", err)
	}
	queriesByID := make(map[string]connection.SavedQuery, len(restoredQueries))
	for _, query := range restoredQueries {
		queriesByID[query.ID] = query
	}
	if len(queriesByID) != 2 || queriesByID["shared-query"].SQL != "select 'remote'" || queriesByID["shared-query"].Name != "Remote Query" {
		t.Fatalf("same-id saved query was not updated from backup: %#v", restoredQueries)
	}
	if queriesByID["local-query"].SQL != "select 'local'" {
		t.Fatalf("local-only saved query was not preserved: %#v", restoredQueries)
	}
}

func TestCloudBackupConfigRequiresEncryptionAndRemoteCredentialsWhenEnabled(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	_, err := application.SaveCloudBackupConfig(CloudBackupConfigInput{Enabled: true, Provider: CloudBackupProviderWebDAV, WebDAVEndpoint: "http://127.0.0.1:12345"})
	if err == nil || !strings.Contains(err.Error(), "credentials") {
		t.Fatalf("expected credential validation error, got %v", err)
	}
}

func TestCloudBackupConfigRejectsEmptyBackupSelectionOnSave(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	_, err := application.SaveCloudBackupConfig(CloudBackupConfigInput{
		Enabled:          false,
		Provider:         CloudBackupProviderWebDAV,
		WebDAVEndpoint:   "http://127.0.0.1:12345",
		BackupCategories: []string{},
	})
	if err == nil || !strings.Contains(err.Error(), "at least one") {
		t.Fatalf("expected empty backup category validation error, got %v", err)
	}
}

func TestCloudBackupConfigPersistsSelectedBackupCategories(t *testing.T) {
	configDir := t.TempDir()
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = configDir
	want := []string{CloudBackupCategoryConnections, CloudBackupCategoryAISettings}
	if _, err := application.SaveCloudBackupConfig(CloudBackupConfigInput{
		Provider:         CloudBackupProviderWebDAV,
		Schedule:         CloudBackupScheduleManual,
		BackupCategories: []string{CloudBackupCategoryAISettings, CloudBackupCategoryConnections},
	}); err != nil {
		t.Fatalf("SaveCloudBackupConfig returned error: %v", err)
	}

	restarted := NewAppWithSecretStore(newFakeAppSecretStore())
	restarted.configDir = configDir
	config, err := restarted.CloudBackupGetConfig()
	if err != nil {
		t.Fatalf("CloudBackupGetConfig after restart returned error: %v", err)
	}
	if !slices.Equal(config.BackupCategories, want) {
		t.Fatalf("persisted backup categories = %#v, want %#v", config.BackupCategories, want)
	}
}

func TestCloudBackupPayloadHonorsSelectedCategories(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	for name, content := range map[string]string{
		"ai_config.json":     `{"provider":"selected"}`,
		"global_proxy.json":  `{"host":"must-not-leak"}`,
		"saved_queries.json": `[{"sql":"select 1"}]`,
	} {
		if err := os.WriteFile(filepath.Join(application.configDir, name), []byte(content), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	if _, err := application.SaveConnection(connection.SavedConnectionInput{
		ID: "unselected-layout-connection", Name: "Unselected layout connection",
		Config: connection.ConnectionConfig{ID: "unselected-layout-connection", Type: "mysql", Host: "layout.example.test", Port: 3306},
	}); err != nil {
		t.Fatalf("seed unselected layout connection: %v", err)
	}
	if _, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID: "unselected-layout-group", Name: "Unselected layout group",
			ConnectionIDs: []string{"unselected-layout-connection"},
			ChildOrder:    []string{"connection:unselected-layout-connection"},
		}},
		SidebarRootOrder: []string{"tag:unselected-layout-group"},
	}); err != nil {
		t.Fatalf("seed unselected sidebar layout: %v", err)
	}

	raw, err := application.buildCloudBackupPayload(CloudBackupConfig{
		BackupCategories: []string{CloudBackupCategoryAISettings},
	})
	if err != nil {
		t.Fatalf("buildCloudBackupPayload returned error: %v", err)
	}
	var payload cloudBackupPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode cloud backup payload: %v", err)
	}
	if len(payload.Connections.Connections) != 0 {
		t.Fatalf("unselected connections leaked into payload: %#v", payload.Connections.Connections)
	}
	if payload.ConnectionSidebarLayout != nil || bytes.Contains(raw, []byte(`"connectionSidebarLayout"`)) {
		t.Fatalf("unselected connection sidebar layout leaked into payload: %s", raw)
	}
	if len(payload.Files) != 1 || payload.Files[0].Path != "ai_config.json" {
		t.Fatalf("payload did not honor selected categories: %#v", payload.Files)
	}
}

func TestCloudBackupConnectionsPayloadIncludesInitializedSidebarLayout(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	if _, err := application.SaveConnection(connection.SavedConnectionInput{
		ID: "layout-connection", Name: "Layout connection",
		Config: connection.ConnectionConfig{ID: "layout-connection", Type: "mysql", Host: "layout.example.test", Port: 3306},
	}); err != nil {
		t.Fatalf("seed connection: %v", err)
	}
	want, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID: "layout-group", Name: "Layout group",
			ConnectionIDs: []string{"layout-connection"},
			ChildOrder:    []string{"connection:layout-connection"},
		}},
		SidebarRootOrder: []string{"tag:layout-group"},
	})
	if err != nil {
		t.Fatalf("bootstrap sidebar layout: %v", err)
	}

	raw, err := application.buildCloudBackupPayload(CloudBackupConfig{
		BackupCategories: []string{CloudBackupCategoryConnections},
	})
	if err != nil {
		t.Fatalf("buildCloudBackupPayload returned error: %v", err)
	}
	var payload cloudBackupPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode cloud backup payload: %v", err)
	}
	if payload.ConnectionSidebarLayout == nil {
		t.Fatal("connections backup omitted initialized sidebar layout")
	}
	if !reflect.DeepEqual(*payload.ConnectionSidebarLayout, want) {
		t.Fatalf("sidebar layout = %#v, want %#v", *payload.ConnectionSidebarLayout, want)
	}
}
