package app

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/cloudbackup"
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/secretstore"
)

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
	if len(payload.Files) != 1 || payload.Files[0].Path != "ai_config.json" {
		t.Fatalf("payload did not honor selected categories: %#v", payload.Files)
	}
}

func TestCloudBackupRestoreSelectionAndConfirmationToken(t *testing.T) {
	payload := cloudBackupPayload{
		SchemaVersion: cloudBackupPayloadSchemaVersion,
		CreatedAt:     "2026-07-27T03:22:04Z",
		Connections: connectionPackagePayload{Connections: []connectionPackageItem{{
			ID: "connection-1", Name: "Connection 1",
		}}},
		Files: []cloudBackupFile{
			{Path: "ai_config.json", Data: []byte(`{"provider":"remote"}`)},
			{Path: "global_proxy.json", Data: []byte(`{"host":"remote"}`)},
			{Path: "saved_queries/query.sql", Data: []byte("select 1")},
		},
	}
	restoreConnections, files, selected, err := selectCloudBackupRestorePayload(payload, []string{
		CloudBackupCategoryAISettings,
		CloudBackupCategorySavedQueries,
	})
	if err != nil {
		t.Fatalf("selectCloudBackupRestorePayload returned error: %v", err)
	}
	if restoreConnections || len(files) != 2 {
		t.Fatalf("unexpected selective restore payload: connections=%v files=%#v", restoreConnections, files)
	}
	preview, err := buildCloudBackupRestorePreview(payload, selected)
	if err != nil || preview.ConnectionCount != 0 || preview.FileCount != 2 || len(preview.Categories) != 2 {
		t.Fatalf("unexpected selective restore preview: preview=%#v err=%v", preview, err)
	}

	application := NewAppWithSecretStore(newFakeAppSecretStore())
	token, err := application.issueCloudBackupRestoreConfirmationToken(payload)
	if err != nil {
		t.Fatalf("issue confirmation token: %v", err)
	}
	if err := application.consumeCloudBackupRestoreConfirmationToken(token, payload); err != nil {
		t.Fatalf("consume confirmation token: %v", err)
	}
	if err := application.consumeCloudBackupRestoreConfirmationToken(token, payload); err == nil {
		t.Fatal("replayed confirmation token should fail")
	}

	changedPayload := payload
	changedPayload.CreatedAt = "2026-07-27T03:23:04Z"
	changedToken, err := application.issueCloudBackupRestoreConfirmationToken(payload)
	if err != nil {
		t.Fatalf("issue confirmation token for changed payload test: %v", err)
	}
	if err := application.consumeCloudBackupRestoreConfirmationToken(changedToken, changedPayload); err == nil {
		t.Fatal("confirmation token should reject a changed remote payload")
	}
}

func TestCloudBackupConfigMigratesLegacyProviderFields(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	configPath := filepath.Join(application.configDir, cloudBackupConfigFileName)
	legacy := `{"schemaVersion":1,"config":{"enabled":false,"provider":"webdav","endpoint":"https://dav.example.test","objectKey":"legacy/backup.gonavi","schedule":"manual","lastSyncAt":"webdav-legacy-time","lastSyncSuccess":true,"remoteAvailable":true,"remoteUpdatedAt":"webdav-remote-time"}}`
	if err := os.WriteFile(configPath, []byte(legacy), 0o600); err != nil {
		t.Fatalf("write legacy WebDAV config: %v", err)
	}
	config, err := application.CloudBackupGetConfig()
	if err != nil {
		t.Fatalf("load legacy WebDAV config: %v", err)
	}
	if config.WebDAVEndpoint != "https://dav.example.test" || config.WebDAVFilePath != "legacy/backup.gonavi" {
		t.Fatalf("legacy WebDAV fields were not migrated: %#v", config)
	}
	if config.WebDAVLastSyncAt != "webdav-legacy-time" || !config.WebDAVLastSyncSuccess || !config.WebDAVRemoteAvailable || config.WebDAVRemoteUpdatedAt != "webdav-remote-time" || config.S3LastSyncAt != "" {
		t.Fatalf("legacy WebDAV state was not isolated to WebDAV: %#v", config)
	}

	legacy = `{"schemaVersion":1,"config":{"enabled":false,"provider":"s3","endpoint":"https://s3.example.test","bucket":"legacy-bucket","region":"eu-west-1","objectKey":"legacy/backup.gonavi","schedule":"manual","lastSyncAt":"s3-legacy-time","lastSyncSuccess":false,"lastSyncError":"legacy S3 failure","remoteAvailable":true,"remoteUpdatedAt":"s3-remote-time"}}`
	if err := os.WriteFile(configPath, []byte(legacy), 0o600); err != nil {
		t.Fatalf("write legacy S3 config: %v", err)
	}
	config, err = application.CloudBackupGetConfig()
	if err != nil {
		t.Fatalf("load legacy S3 config: %v", err)
	}
	if config.S3Endpoint != "https://s3.example.test" || config.S3Bucket != "legacy-bucket" || config.S3Region != "eu-west-1" || config.S3ObjectKey != "legacy/backup.gonavi" {
		t.Fatalf("legacy S3 fields were not migrated: %#v", config)
	}
	if config.S3LastSyncAt != "s3-legacy-time" || config.S3LastSyncSuccess || config.S3LastSyncError != "legacy S3 failure" || !config.S3RemoteAvailable || config.S3RemoteUpdatedAt != "s3-remote-time" || config.WebDAVLastSyncAt != "" {
		t.Fatalf("legacy S3 state was not isolated to S3: %#v", config)
	}
}

func TestCloudBackupStatusUsesSelectedProviderState(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	config := CloudBackupConfig{
		Enabled: true, Provider: CloudBackupProviderWebDAV,
		WebDAVEndpoint: "https://dav.example.test", S3Endpoint: "https://s3.example.test",
		WebDAVLastSyncAt: "webdav-time", WebDAVLastSyncSuccess: true, WebDAVRemoteAvailable: true,
		S3LastSyncAt: "s3-time", S3LastSyncSuccess: false, S3LastSyncError: "s3 failed", S3RemoteAvailable: false,
	}
	webdav := application.cloudBackupStatusFromConfig(config, false)
	if webdav.LastSyncAt != "webdav-time" || !webdav.LastSyncSuccess || webdav.LastSyncError != "" || !webdav.RemoteAvailable {
		t.Fatalf("WebDAV status selected the wrong provider state: %#v", webdav)
	}
	config.Provider = CloudBackupProviderS3
	s3 := application.cloudBackupStatusFromConfig(config, false)
	if s3.LastSyncAt != "s3-time" || s3.LastSyncSuccess || s3.LastSyncError != "s3 failed" || s3.RemoteAvailable {
		t.Fatalf("S3 status selected the wrong provider state: %#v", s3)
	}
}

func TestSaveCloudBackupConfigPreservesProviderState(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	previous := CloudBackupConfig{
		Provider:         CloudBackupProviderWebDAV,
		BackupCategories: defaultCloudBackupCategories(),
		WebDAVEndpoint:   "https://dav.example.test", WebDAVFilePath: "dav/backup.gonavi",
		S3Endpoint: "https://s3.example.test", S3Bucket: "backup-bucket", S3Region: "eu-west-1", S3ObjectKey: "s3/backup.gonavi",
		Schedule:         CloudBackupScheduleManual,
		WebDAVLastSyncAt: "2026-07-27T01:02:03Z", WebDAVLastSyncSuccess: true,
		WebDAVRemoteAvailable: true, WebDAVRemoteUpdatedAt: "2026-07-27T00:59:59Z",
		S3LastSyncAt: "2026-07-26T04:05:06Z", S3LastSyncSuccess: false, S3LastSyncError: "S3 unavailable",
		S3RemoteAvailable: true, S3RemoteUpdatedAt: "2026-07-26T04:00:00Z",
	}
	if err := application.saveCloudBackupState(previous); err != nil {
		t.Fatalf("save previous cloud backup state: %v", err)
	}

	config, err := application.SaveCloudBackupConfig(CloudBackupConfigInput{
		Provider:       CloudBackupProviderS3,
		WebDAVEndpoint: previous.WebDAVEndpoint, WebDAVFilePath: previous.WebDAVFilePath,
		S3Endpoint: previous.S3Endpoint, S3Bucket: previous.S3Bucket, S3Region: previous.S3Region, S3ObjectKey: previous.S3ObjectKey,
		Schedule: CloudBackupScheduleManual,
	})
	if err != nil {
		t.Fatalf("SaveCloudBackupConfig returned error: %v", err)
	}
	if config.WebDAVLastSyncAt != previous.WebDAVLastSyncAt || !config.WebDAVLastSyncSuccess || !config.WebDAVRemoteAvailable || config.WebDAVRemoteUpdatedAt != previous.WebDAVRemoteUpdatedAt {
		t.Fatalf("saving settings discarded WebDAV state: %#v", config)
	}
	if config.S3LastSyncAt != previous.S3LastSyncAt || config.S3LastSyncSuccess || config.S3LastSyncError != previous.S3LastSyncError || !config.S3RemoteAvailable || config.S3RemoteUpdatedAt != previous.S3RemoteUpdatedAt {
		t.Fatalf("saving settings discarded S3 state: %#v", config)
	}
}

func TestSaveCloudBackupConfigInvalidatesOnlyChangedProviderState(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	previous := CloudBackupConfig{
		Provider:         CloudBackupProviderS3,
		BackupCategories: defaultCloudBackupCategories(),
		WebDAVEndpoint:   "https://dav.example.test", WebDAVFilePath: "dav/backup.gonavi",
		S3Endpoint: "https://s3.example.test", S3Bucket: "backup-bucket", S3Region: "eu-west-1", S3ObjectKey: "old/backup.gonavi",
		Schedule:         CloudBackupScheduleManual,
		WebDAVLastSyncAt: "webdav-time", WebDAVLastSyncSuccess: true, WebDAVRemoteAvailable: true, WebDAVRemoteUpdatedAt: "webdav-remote-time",
		S3LastSyncAt: "s3-time", S3LastSyncSuccess: true, S3RemoteAvailable: true, S3RemoteUpdatedAt: "s3-remote-time",
	}
	if err := application.saveCloudBackupState(previous); err != nil {
		t.Fatalf("save previous cloud backup state: %v", err)
	}

	config, err := application.SaveCloudBackupConfig(CloudBackupConfigInput{
		Provider:       CloudBackupProviderS3,
		WebDAVEndpoint: previous.WebDAVEndpoint, WebDAVFilePath: previous.WebDAVFilePath,
		S3Endpoint: previous.S3Endpoint, S3Bucket: previous.S3Bucket, S3Region: previous.S3Region, S3ObjectKey: "new/backup.gonavi",
		Schedule: CloudBackupScheduleManual,
	})
	if err != nil {
		t.Fatalf("SaveCloudBackupConfig returned error: %v", err)
	}
	if config.WebDAVLastSyncAt != previous.WebDAVLastSyncAt || !config.WebDAVLastSyncSuccess || !config.WebDAVRemoteAvailable || config.WebDAVRemoteUpdatedAt != previous.WebDAVRemoteUpdatedAt {
		t.Fatalf("changing S3 settings discarded WebDAV state: %#v", config)
	}
	if config.S3LastSyncAt != "" || config.S3LastSyncSuccess || config.S3LastSyncError != "" || config.S3RemoteAvailable || config.S3RemoteUpdatedAt != "" {
		t.Fatalf("changing the S3 destination retained stale S3 state: %#v", config)
	}
}

func TestCloudBackupConfigReportsProviderCredentialMarkers(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	config, err := application.SaveCloudBackupConfig(CloudBackupConfigInput{
		Provider:       CloudBackupProviderS3,
		WebDAVEndpoint: "https://dav.example.test", WebDAVFilePath: "backup.gonavi",
		S3Endpoint: "https://s3.example.test", S3Bucket: "backup-bucket", S3Region: "us-east-1", S3ObjectKey: "backup.gonavi",
		Schedule:       CloudBackupScheduleManual,
		WebDAVUsername: "dav-user", WebDAVPassword: "dav-pass",
	})
	if err != nil {
		t.Fatalf("SaveCloudBackupConfig returned error: %v", err)
	}
	payload, err := json.Marshal(config)
	if err != nil {
		t.Fatalf("marshal cloud backup config view: %v", err)
	}
	var view map[string]any
	if err := json.Unmarshal(payload, &view); err != nil {
		t.Fatalf("unmarshal cloud backup config view: %v", err)
	}
	if view["hasWebdavCredential"] != true || (view["hasS3Credential"] != nil && view["hasS3Credential"] != false) {
		t.Fatalf("provider credential markers are not independent: %s", payload)
	}
	if _, exists := view["hasRemoteCredential"]; exists {
		t.Fatalf("legacy shared credential marker leaked into config view: %s", payload)
	}
}

func TestCloudBackupSecretsUseIndependentKeyringEntries(t *testing.T) {
	store := newFakeAppSecretStore()
	application := NewAppWithSecretStore(store)
	application.configDir = t.TempDir()
	if _, err := application.SaveCloudBackupConfig(CloudBackupConfigInput{
		Provider: CloudBackupProviderWebDAV, Schedule: CloudBackupScheduleManual,
		WebDAVUsername: "dav-user", WebDAVPassword: "dav-pass",
		S3AccessKey: "s3-access", S3SecretKey: "s3-secret",
		EncryptionPassword: "backup-pass",
	}); err != nil {
		t.Fatalf("save cloud backup secrets: %v", err)
	}

	webDAVRef, _ := secretstore.BuildRef(cloudBackupSecretKind, "webdav")
	s3Ref, _ := secretstore.BuildRef(cloudBackupSecretKind, "s3")
	encryptionRef, _ := secretstore.BuildRef(cloudBackupSecretKind, "encryption")
	legacyRef, _ := secretstore.BuildRef(cloudBackupSecretKind, "default")

	webDAVPayload, webDAVExists := store.items[webDAVRef]
	s3Payload, s3Exists := store.items[s3Ref]
	encryptionPayload, encryptionExists := store.items[encryptionRef]
	if !webDAVExists || !s3Exists || !encryptionExists {
		t.Fatalf("provider secrets were not stored independently: refs=%v", store.items)
	}
	if _, exists := store.items[legacyRef]; exists {
		t.Fatal("legacy combined cloud backup secret remained after split storage save")
	}
	if !strings.Contains(string(webDAVPayload), "dav-user") || strings.Contains(string(webDAVPayload), "s3-access") || strings.Contains(string(webDAVPayload), "backup-pass") {
		t.Fatalf("WebDAV keyring entry contains the wrong secret fields: %s", webDAVPayload)
	}
	if !strings.Contains(string(s3Payload), "s3-access") || strings.Contains(string(s3Payload), "dav-user") || strings.Contains(string(s3Payload), "backup-pass") {
		t.Fatalf("S3 keyring entry contains the wrong secret fields: %s", s3Payload)
	}
	if !strings.Contains(string(encryptionPayload), "backup-pass") || strings.Contains(string(encryptionPayload), "dav-user") || strings.Contains(string(encryptionPayload), "s3-access") {
		t.Fatalf("encryption keyring entry contains remote credentials: %s", encryptionPayload)
	}
}

func TestCloudBackupSecretsMigrateLegacyCombinedKeyringEntry(t *testing.T) {
	store := newFakeAppSecretStore()
	application := NewAppWithSecretStore(store)
	application.configDir = t.TempDir()
	legacyRef, _ := secretstore.BuildRef(cloudBackupSecretKind, "default")
	legacyPayload, err := json.Marshal(cloudBackupSecrets{
		WebDAVUsername: "legacy-dav-user", WebDAVPassword: "legacy-dav-pass",
		S3AccessKey: "legacy-s3-access", S3SecretKey: "legacy-s3-secret",
		EncryptionPassword: "legacy-backup-pass",
	})
	if err != nil {
		t.Fatalf("marshal legacy cloud backup secret: %v", err)
	}
	store.items[legacyRef] = legacyPayload

	secrets, err := application.loadCloudBackupSecrets()
	if err != nil {
		t.Fatalf("load legacy cloud backup secrets: %v", err)
	}
	if secrets.WebDAVUsername != "legacy-dav-user" || secrets.S3AccessKey != "legacy-s3-access" || secrets.EncryptionPassword != "legacy-backup-pass" {
		t.Fatalf("legacy combined secret was not read: %#v", secrets)
	}
	if err := application.saveCloudBackupSecrets(secrets); err != nil {
		t.Fatalf("migrate legacy cloud backup secrets: %v", err)
	}
	if _, exists := store.items[legacyRef]; exists {
		t.Fatal("legacy combined cloud backup secret was not removed after migration")
	}
	for _, id := range []string{"webdav", "s3", "encryption"} {
		ref, _ := secretstore.BuildRef(cloudBackupSecretKind, id)
		if _, exists := store.items[ref]; !exists {
			t.Fatalf("missing migrated %s keyring entry", id)
		}
	}
}

func TestCloudBackupProviderSecretsIgnoreInactiveProviderEntry(t *testing.T) {
	store := newFakeAppSecretStore()
	application := NewAppWithSecretStore(store)
	if err := application.saveCloudBackupSecrets(cloudBackupSecrets{
		WebDAVUsername: "dav-user", WebDAVPassword: "dav-pass",
		S3AccessKey: "s3-access", S3SecretKey: "s3-secret",
		EncryptionPassword: "backup-pass",
	}); err != nil {
		t.Fatalf("save split cloud backup secrets: %v", err)
	}
	s3Ref, _ := secretstore.BuildRef(cloudBackupSecretKind, cloudBackupS3SecretID)
	store.items[s3Ref] = []byte(`{"accessKey":`)

	secrets, err := application.loadCloudBackupProviderSecrets(CloudBackupProviderWebDAV)
	if err != nil {
		t.Fatalf("inactive S3 secret blocked WebDAV: %v", err)
	}
	if secrets.WebDAVUsername != "dav-user" || secrets.WebDAVPassword != "dav-pass" || secrets.EncryptionPassword != "backup-pass" {
		t.Fatalf("WebDAV runtime secrets were not isolated: %#v", secrets)
	}
	if secrets.S3AccessKey != "" || secrets.S3SecretKey != "" {
		t.Fatalf("WebDAV runtime received S3 credentials: %#v", secrets)
	}
	if _, err := application.loadCloudBackupProviderSecrets(CloudBackupProviderS3); err == nil {
		t.Fatal("active S3 provider ignored its malformed keyring entry")
	}
}

func TestCloudBackupSecretSplitRollsBackPartialWrite(t *testing.T) {
	baseStore := newFakeAppSecretStore()
	application := NewAppWithSecretStore(baseStore)
	original := cloudBackupSecrets{
		WebDAVUsername: "old-dav-user", WebDAVPassword: "old-dav-pass",
		S3AccessKey: "old-s3-access", S3SecretKey: "old-s3-secret",
		EncryptionPassword: "old-backup-pass",
	}
	if err := application.saveCloudBackupSecrets(original); err != nil {
		t.Fatalf("save original split secrets: %v", err)
	}
	s3Ref, _ := secretstore.BuildRef(cloudBackupSecretKind, cloudBackupS3SecretID)
	application.secretStore = &failOncePutSecretStore{fakeAppSecretStore: baseStore, failRef: s3Ref}
	err := application.saveCloudBackupSecrets(cloudBackupSecrets{
		WebDAVUsername: "new-dav-user", WebDAVPassword: "new-dav-pass",
		S3AccessKey: "new-s3-access", S3SecretKey: "new-s3-secret",
		EncryptionPassword: "new-backup-pass",
	})
	if err == nil {
		t.Fatal("expected split keyring write failure")
	}
	secrets, loadErr := application.loadCloudBackupSecrets()
	if loadErr != nil {
		t.Fatalf("load secrets after rollback: %v", loadErr)
	}
	if secrets != original {
		t.Fatalf("partial split keyring write was not rolled back: got=%#v want=%#v", secrets, original)
	}
}

type failOncePutSecretStore struct {
	*fakeAppSecretStore
	failRef string
}

func (store *failOncePutSecretStore) Put(ref string, payload []byte) error {
	if ref == store.failRef {
		store.failRef = ""
		return errors.New("injected keyring write failure")
	}
	return store.fakeAppSecretStore.Put(ref, payload)
}

func TestCloudBackupConfigClearsProviderCredentialsIndependently(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	baseInput := CloudBackupConfigInput{
		Provider:       CloudBackupProviderWebDAV,
		WebDAVEndpoint: "https://dav.example.test", WebDAVFilePath: "backup.gonavi",
		S3Endpoint: "https://s3.example.test", S3Bucket: "backup-bucket", S3Region: "us-east-1", S3ObjectKey: "backup.gonavi",
		Schedule:       CloudBackupScheduleManual,
		WebDAVUsername: "dav-user", WebDAVPassword: "dav-pass",
		S3AccessKey: "s3-access", S3SecretKey: "s3-secret",
	}
	if _, err := application.SaveCloudBackupConfig(baseInput); err != nil {
		t.Fatalf("save both provider credentials: %v", err)
	}

	var clearWebDAV CloudBackupConfigInput
	if err := json.Unmarshal([]byte(`{"provider":"webdav","webdavEndpoint":"https://dav.example.test","webdavFilePath":"backup.gonavi","s3Endpoint":"https://s3.example.test","s3Bucket":"backup-bucket","s3Region":"us-east-1","s3ObjectKey":"backup.gonavi","schedule":"manual","clearWebdavCredential":true}`), &clearWebDAV); err != nil {
		t.Fatalf("decode WebDAV clear input: %v", err)
	}
	if _, err := application.SaveCloudBackupConfig(clearWebDAV); err != nil {
		t.Fatalf("clear WebDAV credentials: %v", err)
	}
	secrets, err := application.loadCloudBackupSecrets()
	if err != nil {
		t.Fatalf("load credentials after clearing WebDAV: %v", err)
	}
	if secrets.WebDAVUsername != "" || secrets.WebDAVPassword != "" {
		t.Fatalf("WebDAV credentials were not cleared: %#v", secrets)
	}
	if secrets.S3AccessKey != "s3-access" || secrets.S3SecretKey != "s3-secret" {
		t.Fatalf("clearing WebDAV credentials changed S3 credentials: %#v", secrets)
	}

	var clearS3 CloudBackupConfigInput
	if err := json.Unmarshal([]byte(`{"provider":"s3","webdavEndpoint":"https://dav.example.test","webdavFilePath":"backup.gonavi","s3Endpoint":"https://s3.example.test","s3Bucket":"backup-bucket","s3Region":"us-east-1","s3ObjectKey":"backup.gonavi","schedule":"manual","clearS3Credential":true}`), &clearS3); err != nil {
		t.Fatalf("decode S3 clear input: %v", err)
	}
	if _, err := application.SaveCloudBackupConfig(clearS3); err != nil {
		t.Fatalf("clear S3 credentials: %v", err)
	}
	secrets, err = application.loadCloudBackupSecrets()
	if err != nil {
		t.Fatalf("load credentials after clearing S3: %v", err)
	}
	if secrets.S3AccessKey != "" || secrets.S3SecretKey != "" {
		t.Fatalf("S3 credentials were not cleared: %#v", secrets)
	}
}

func TestCloudBackupRemoteCheckUpdatesOnlySelectedProviderState(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Last-Modified", "Tue, 28 Jul 2026 12:00:00 GMT")
		w.Header().Set("Content-Length", "42")
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	if _, err := application.SaveCloudBackupConfig(CloudBackupConfigInput{
		Provider:       CloudBackupProviderWebDAV,
		WebDAVEndpoint: server.URL, WebDAVFilePath: "backup.gonavi",
		S3Endpoint: "https://s3.example.test", S3Bucket: "backup-bucket", S3Region: "us-east-1", S3ObjectKey: "backup.gonavi",
		Schedule: CloudBackupScheduleManual, WebDAVUsername: "dav-user", WebDAVPassword: "dav-pass",
	}); err != nil {
		t.Fatalf("save cloud backup config: %v", err)
	}
	config, err := application.loadCloudBackupConfig()
	if err != nil {
		t.Fatalf("load cloud backup config: %v", err)
	}
	config.S3RemoteAvailable = true
	config.S3RemoteUpdatedAt = "old-s3-time"
	if err := application.saveCloudBackupState(config); err != nil {
		t.Fatalf("seed S3 remote state: %v", err)
	}

	points, err := application.CloudBackupListRestorePoints()
	if err != nil {
		t.Fatalf("CloudBackupListRestorePoints returned error: %v", err)
	}
	if len(points) != 1 || points[0].ObjectKey != "backup.gonavi" {
		t.Fatalf("unexpected restore points: %#v", points)
	}
	config, err = application.loadCloudBackupConfig()
	if err != nil {
		t.Fatalf("reload cloud backup config: %v", err)
	}
	if !config.WebDAVRemoteAvailable || config.WebDAVRemoteUpdatedAt == "" {
		t.Fatalf("WebDAV remote check did not persist its state: %#v", config)
	}
	if !config.S3RemoteAvailable || config.S3RemoteUpdatedAt != "old-s3-time" {
		t.Fatalf("WebDAV remote check changed S3 state: %#v", config)
	}
}

func TestCloudBackupImmediateScheduleSyncsAfterSavingConnection(t *testing.T) {
	synced := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		select {
		case synced <- struct{}{}:
		default:
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	if _, err := application.SaveCloudBackupConfig(CloudBackupConfigInput{
		Enabled: true, Provider: CloudBackupProviderWebDAV, WebDAVEndpoint: server.URL,
		WebDAVFilePath: "backup.gonavi", Schedule: CloudBackupScheduleImmediate,
		WebDAVUsername: "user", WebDAVPassword: "pass", EncryptionPassword: "backup-pass",
	}); err != nil {
		t.Fatalf("SaveCloudBackupConfig returned error: %v", err)
	}
	select {
	case <-synced:
	case <-time.After(3 * time.Second):
		t.Fatal("immediate cloud backup configuration save did not sync")
	}

	if _, err := application.SaveConnection(connection.SavedConnectionInput{
		ID: "sync-connection", Name: "Sync Connection",
		Config: connection.ConnectionConfig{ID: "sync-connection", Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root", Database: "test"},
	}); err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}

	select {
	case <-synced:
	case <-time.After(3 * time.Second):
		t.Fatal("saving a connection did not trigger immediate cloud backup sync")
	}
	application.cloudBackupSyncMu.Lock()
	application.cloudBackupSyncMu.Unlock()
}

func TestCloudBackupImmediateScheduleSaveDoesNotWaitForRemote(t *testing.T) {
	requestStarted := make(chan struct{})
	releaseRequest := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		select {
		case <-requestStarted:
		default:
			close(requestStarted)
		}
		<-releaseRequest
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	saveDone := make(chan error, 1)
	go func() {
		_, err := application.SaveCloudBackupConfig(CloudBackupConfigInput{
			Enabled: true, Provider: CloudBackupProviderWebDAV, WebDAVEndpoint: server.URL,
			WebDAVFilePath: "backup.gonavi", Schedule: CloudBackupScheduleImmediate,
			WebDAVUsername: "user", WebDAVPassword: "pass", EncryptionPassword: "backup-pass",
		})
		saveDone <- err
	}()

	select {
	case err := <-saveDone:
		if err != nil {
			close(releaseRequest)
			t.Fatalf("SaveCloudBackupConfig returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		close(releaseRequest)
		t.Fatal("SaveCloudBackupConfig waited for the remote upload")
	}

	select {
	case <-requestStarted:
	case <-time.After(2 * time.Second):
		close(releaseRequest)
		t.Fatal("immediate cloud backup did not start in the background")
	}
	close(releaseRequest)
	application.cloudBackupSyncMu.Lock()
	application.cloudBackupSyncMu.Unlock()
}

func TestCloudBackupSyncCompletionPreservesConcurrentProviderConfig(t *testing.T) {
	requestStarted := make(chan struct{})
	releaseRequest := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		select {
		case <-requestStarted:
		default:
			close(requestStarted)
		}
		<-releaseRequest
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	if _, err := application.SaveCloudBackupConfig(CloudBackupConfigInput{
		Enabled: true, Provider: CloudBackupProviderWebDAV, WebDAVEndpoint: server.URL,
		WebDAVFilePath: "webdav/backup.gonavi", Schedule: CloudBackupScheduleManual,
		WebDAVUsername: "dav-user", WebDAVPassword: "dav-pass", EncryptionPassword: "backup-pass",
	}); err != nil {
		t.Fatalf("save initial WebDAV config: %v", err)
	}

	syncDone := make(chan error, 1)
	go func() {
		_, err := application.CloudBackupSyncNow()
		syncDone <- err
	}()
	select {
	case <-requestStarted:
	case <-time.After(3 * time.Second):
		close(releaseRequest)
		t.Fatal("WebDAV upload did not start")
	}

	if _, err := application.SaveCloudBackupConfig(CloudBackupConfigInput{
		Provider:       CloudBackupProviderS3,
		WebDAVEndpoint: server.URL, WebDAVFilePath: "webdav/backup.gonavi",
		S3Endpoint: "https://s3.example.test", S3Bucket: "new-bucket", S3Region: "eu-west-1", S3ObjectKey: "s3/backup.gonavi",
		Schedule: CloudBackupScheduleManual,
	}); err != nil {
		close(releaseRequest)
		t.Fatalf("save S3 config during WebDAV upload: %v", err)
	}
	close(releaseRequest)
	select {
	case err := <-syncDone:
		if err != nil {
			t.Fatalf("WebDAV sync returned error: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("WebDAV sync did not finish")
	}

	config, err := application.loadCloudBackupConfig()
	if err != nil {
		t.Fatalf("load final cloud backup config: %v", err)
	}
	if config.Provider != CloudBackupProviderS3 || config.S3Endpoint != "https://s3.example.test" || config.S3Bucket != "new-bucket" || config.S3Region != "eu-west-1" || config.S3ObjectKey != "s3/backup.gonavi" {
		t.Fatalf("WebDAV completion overwrote concurrent S3 config: %#v", config)
	}
	if !config.WebDAVLastSyncSuccess || config.WebDAVLastSyncAt == "" {
		t.Fatalf("WebDAV completion did not update WebDAV state: %#v", config)
	}
}

func TestCloudBackupRestoreFilesProtectsSecretsAndSupportsRollback(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	secretPath := filepath.Join(application.configDir, "daily_secrets.json")
	if err := os.WriteFile(secretPath, []byte(`{"old":true}`), 0o600); err != nil {
		t.Fatalf("write original daily secrets: %v", err)
	}

	rollback, err := application.restoreCloudBackupFiles([]cloudBackupFile{{Path: "daily_secrets.json", Data: []byte(`{"new":true}`)}})
	if err != nil {
		t.Fatalf("restoreCloudBackupFiles returned error: %v", err)
	}
	data, err := os.ReadFile(secretPath)
	if err != nil || string(data) != `{"new":true}` {
		t.Fatalf("restored daily secrets mismatch: data=%q err=%v", data, err)
	}
	if runtime.GOOS != "windows" {
		if mode := (mustStatFile(t, secretPath)).Mode().Perm(); mode != 0o600 {
			t.Fatalf("daily secrets permissions = %04o, want 0600", mode)
		}
	}
	if err := rollback(); err != nil {
		t.Fatalf("rollback returned error: %v", err)
	}
	data, err = os.ReadFile(secretPath)
	if err != nil || string(data) != `{"old":true}` {
		t.Fatalf("rollback did not restore original daily secrets: data=%q err=%v", data, err)
	}
}

func TestCloudBackupRestoreRequiresRestartForRuntimeSettingsAndCredentials(t *testing.T) {
	for _, path := range []string{"ai_config.json", "global_proxy.json", "daily_secrets.json", "update_channel.json"} {
		if !cloudBackupRestoreRequiresRestart([]cloudBackupFile{{Path: path}}) {
			t.Fatalf("restoring %s should require restart", path)
		}
	}
	if cloudBackupRestoreRequiresRestart([]cloudBackupFile{{Path: "saved_queries.json"}}) {
		t.Fatal("restoring saved queries should not require restart")
	}
}

func mustStatFile(t *testing.T, path string) os.FileInfo {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return info
}
