package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/secretstore"
)

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
