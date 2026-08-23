package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/importjob"
)

type headlessSecretCaptureDB struct {
	sqlAuditTestDatabase
	connectedConfig connection.ConnectionConfig
}

func (database *headlessSecretCaptureDB) Connect(config connection.ConnectionConfig) error {
	database.connectedConfig = config
	database.connected = true
	return nil
}

func TestHeadlessLifecycleSkipsDesktopSchedulers(t *testing.T) {
	application, err := NewHeadlessApp(context.Background(), t.TempDir())
	if err != nil {
		t.Fatalf("NewHeadlessApp returned error: %v", err)
	}
	defer application.Shutdown()

	if !application.headlessRuntime {
		t.Fatal("headless lifecycle did not mark the App as headless")
	}
	if application.keepAliveCancel != nil || application.keepAliveDone != nil {
		t.Fatal("headless lifecycle must not start the database keep-alive loop")
	}
	if application.dataSyncJobManager != nil || application.dataSyncJobStore != nil {
		t.Fatal("headless lifecycle must not start data-sync jobs")
	}
	if application.cloudBackupSchedulerCancel != nil {
		t.Fatal("headless lifecycle must not start cloud-backup scheduling")
	}
	if application.sqlAuditStore == nil || !application.sqlAuditRuntimeActive {
		t.Fatal("headless lifecycle must activate the shared SQL audit store")
	}
}

func TestHeadlessLifecycleDoesNotRecoverImportJobsOwnedByAnotherProcess(t *testing.T) {
	root := t.TempDir()
	store, err := importjob.Open(filepath.Join(root, "import-jobs"))
	if err != nil {
		t.Fatalf("open import job store: %v", err)
	}
	created, err := store.Put(importjob.Job{
		ID:     "desktop-running",
		Kind:   importjob.KindSQL,
		Status: importjob.StatusRunning,
	})
	if err != nil {
		t.Fatalf("create running import job: %v", err)
	}

	application, err := NewHeadlessApp(context.Background(), root)
	if err != nil {
		t.Fatalf("NewHeadlessApp returned error: %v", err)
	}
	defer application.Shutdown()

	current, err := store.Get(created.ID)
	if err != nil {
		t.Fatalf("read running import job: %v", err)
	}
	if current.Status != importjob.StatusRunning || current.Revision != created.Revision {
		t.Fatalf("headless startup changed another process job: status=%s revision=%d, want status=%s revision=%d", current.Status, current.Revision, created.Status, created.Revision)
	}
}

func TestHeadlessLifecycleNeverStartsImmediateOrOnExitCloudBackup(t *testing.T) {
	requests := make(chan struct{}, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests <- struct{}{}
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	application := NewAppWithSecretStore(newFakeAppSecretStore())
	if err := InitializeHeadlessLifecycle(application, context.Background(), t.TempDir()); err != nil {
		t.Fatalf("InitializeHeadlessLifecycle returned error: %v", err)
	}
	closed := false
	defer func() {
		if !closed {
			application.Shutdown()
		}
	}()

	baseConfig := CloudBackupConfigInput{
		Enabled:            true,
		Provider:           CloudBackupProviderWebDAV,
		WebDAVEndpoint:     server.URL,
		WebDAVFilePath:     "backup.gonavi",
		WebDAVUsername:     "user",
		WebDAVPassword:     "pass",
		EncryptionPassword: "backup-pass",
	}
	baseConfig.Schedule = CloudBackupScheduleImmediate
	if _, err := application.SaveCloudBackupConfig(baseConfig); err != nil {
		t.Fatalf("save immediate cloud backup config: %v", err)
	}
	if _, err := application.SaveConnection(connection.SavedConnectionInput{
		ID:   "headless-no-cloud-sync",
		Name: "Headless no cloud sync",
		Config: connection.ConnectionConfig{
			ID:   "headless-no-cloud-sync",
			Type: "sqlite",
		},
	}); err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}
	assertNoHeadlessCloudBackupRequest(t, requests)

	baseConfig.Schedule = CloudBackupScheduleOnExit
	baseConfig.WebDAVUsername = ""
	baseConfig.WebDAVPassword = ""
	baseConfig.EncryptionPassword = ""
	if _, err := application.SaveCloudBackupConfig(baseConfig); err != nil {
		t.Fatalf("save on-exit cloud backup config: %v", err)
	}
	application.Shutdown()
	closed = true
	assertNoHeadlessCloudBackupRequest(t, requests)
}

func assertNoHeadlessCloudBackupRequest(t *testing.T, requests <-chan struct{}) {
	t.Helper()
	select {
	case <-requests:
		t.Fatal("headless lifecycle unexpectedly contacted the cloud backup endpoint")
	case <-time.After(150 * time.Millisecond):
	}
}

func TestHeadlessResolveSavedConnectionKeepsSecretsOutOfViewAndRestoresThemForQuery(t *testing.T) {
	root := t.TempDir()
	runtime, err := NewHeadlessRuntime(context.Background(), HeadlessRuntimeOptions{DataRoot: root})
	if err != nil {
		t.Fatalf("NewHeadlessRuntime returned error: %v", err)
	}
	defer runtime.Close()

	view, err := runtime.SaveConnection(connection.SavedConnectionInput{
		ID:   "headless-secret",
		Name: "Headless secret",
		Config: connection.ConnectionConfig{
			ID:       "headless-secret",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "postgres",
			Password: "postgres-secret",
		},
	})
	if err != nil {
		t.Fatalf("SaveConnection returned error: %v", err)
	}
	if view.Config.Password != "" {
		t.Fatal("SaveConnection returned a plaintext password")
	}

	resolved, err := runtime.ResolveSavedConnection("headless-secret")
	if err != nil {
		t.Fatalf("ResolveSavedConnection returned error: %v", err)
	}
	if resolved.Config.Password != "" {
		t.Fatal("ResolveSavedConnection exposed a plaintext password")
	}

	database := &headlessSecretCaptureDB{sqlAuditTestDatabase: sqlAuditTestDatabase{
		rows:    []map[string]interface{}{{"value": 1}},
		columns: []string{"value"},
	}}
	originalNewDatabaseFunc := newDatabaseFunc
	originalDriverSupportFunc := driverRuntimeSupportStatusFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		driverRuntimeSupportStatusFunc = originalDriverSupportFunc
	})
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }

	result := runtime.Query(context.Background(), resolved.Config, "app", "SELECT 1", HeadlessQueryOptions{})
	if !result.Success {
		t.Fatalf("headless Query returned failure: %s", result.Message)
	}
	if database.connectedConfig.Password != "postgres-secret" {
		t.Fatalf("database received password %q, want daily_secrets password", database.connectedConfig.Password)
	}
}

func TestHeadlessQueryRefreshesSavedMetadataAndSecretsAsOneSnapshot(t *testing.T) {
	root := t.TempDir()
	runtime, err := NewHeadlessRuntime(context.Background(), HeadlessRuntimeOptions{DataRoot: root})
	if err != nil {
		t.Fatalf("NewHeadlessRuntime returned error: %v", err)
	}
	defer runtime.Close()

	stale, err := runtime.SaveConnection(connection.SavedConnectionInput{
		ID:   "rotated-connection",
		Name: "Rotated connection",
		Config: connection.ConnectionConfig{
			ID:       "rotated-connection",
			Type:     "postgres",
			Host:     "old-db.local",
			Port:     5432,
			User:     "postgres",
			Password: "old-secret",
		},
	})
	if err != nil {
		t.Fatalf("save initial connection: %v", err)
	}
	if _, err := runtime.SaveConnection(connection.SavedConnectionInput{
		ID:   "rotated-connection",
		Name: "Rotated connection",
		Config: connection.ConnectionConfig{
			ID:       "rotated-connection",
			Type:     "postgres",
			Host:     "new-db.local",
			Port:     5432,
			User:     "postgres",
			Password: "new-secret",
		},
	}); err != nil {
		t.Fatalf("rotate saved connection: %v", err)
	}

	database := &headlessSecretCaptureDB{sqlAuditTestDatabase: sqlAuditTestDatabase{
		rows:    []map[string]interface{}{{"value": 1}},
		columns: []string{"value"},
	}}
	originalNewDatabaseFunc := newDatabaseFunc
	originalDriverSupportFunc := driverRuntimeSupportStatusFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		driverRuntimeSupportStatusFunc = originalDriverSupportFunc
	})
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	driverRuntimeSupportStatusFunc = func(string) (bool, string) { return true, "" }

	result := runtime.Query(context.Background(), stale.Config, "app", "SELECT 1", HeadlessQueryOptions{})
	if !result.Success {
		t.Fatalf("headless Query returned failure: %s", result.Message)
	}
	if database.connectedConfig.Host != "new-db.local" || database.connectedConfig.Password != "new-secret" {
		t.Fatalf("database received a mixed or stale connection snapshot: host=%q password=%q", database.connectedConfig.Host, database.connectedConfig.Password)
	}
}
