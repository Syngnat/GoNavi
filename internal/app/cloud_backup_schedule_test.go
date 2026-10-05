package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
)

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

func TestCloudBackupImmediateScheduleCoalescesDirtySignals(t *testing.T) {
	requests := make(chan int32, 128)
	releaseFirst := make(chan struct{})
	var requestCount atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		current := requestCount.Add(1)
		requests <- current
		if current == 1 {
			<-releaseFirst
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
		close(releaseFirst)
		t.Fatalf("SaveCloudBackupConfig returned error: %v", err)
	}

	select {
	case <-requests:
	case <-time.After(3 * time.Second):
		close(releaseFirst)
		t.Fatal("initial immediate cloud backup did not start")
	}
	for range 100 {
		application.markCloudBackupDirty()
	}
	close(releaseFirst)

	select {
	case request := <-requests:
		if request != 2 {
			t.Fatalf("coalesced cloud backup request = %d, want 2", request)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("coalesced dirty cloud backup did not run")
	}
	select {
	case request := <-requests:
		t.Fatalf("dirty signals queued an extra cloud backup request %d", request)
	case <-time.After(300 * time.Millisecond):
	}
	application.shutdownCloudBackup()
}

func TestCloudBackupShutdownCancelsImmediateSyncAndDropsPendingDirty(t *testing.T) {
	requests := make(chan struct{}, 128)
	releaseServer := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		requests <- struct{}{}
		select {
		case <-r.Context().Done():
		case <-releaseServer:
		}
	}))
	defer server.Close()
	defer close(releaseServer)

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
	case <-requests:
	case <-time.After(3 * time.Second):
		t.Fatal("initial immediate cloud backup did not start")
	}
	for range 100 {
		application.markCloudBackupDirty()
	}

	shutdownDone := make(chan struct{})
	go func() {
		application.shutdownCloudBackup()
		close(shutdownDone)
	}()
	select {
	case <-shutdownDone:
	case <-time.After(3 * time.Second):
		t.Fatal("cloud backup shutdown did not wait for cancellation")
	}

	application.markCloudBackupDirty()
	select {
	case <-requests:
		t.Fatal("cloud backup wrote to the remote after shutdown")
	case <-time.After(300 * time.Millisecond):
	}
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

func TestCloudBackupConnectionSnapshotWaitsForSharedStorageLock(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	repository := application.savedConnectionRepository()
	if _, err := repository.Save(connection.SavedConnectionInput{
		ID: "snapshot-connection", Name: "Snapshot connection",
		Config: connection.ConnectionConfig{ID: "snapshot-connection", Type: "mysql", Password: "snapshot-secret"},
	}); err != nil {
		t.Fatalf("seed connection: %v", err)
	}

	lock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(application.configDir))
	if err != nil {
		t.Fatalf("acquire shared storage lock: %v", err)
	}
	released := false
	t.Cleanup(func() {
		if !released {
			_ = lock.Close()
		}
	})

	type snapshotResult struct {
		snapshot cloudBackupConnectionFilesSnapshot
		err      error
	}
	finished := make(chan snapshotResult, 1)
	go func() {
		snapshot, captureErr := application.captureCloudBackupConnectionFilesSnapshot()
		finished <- snapshotResult{snapshot: snapshot, err: captureErr}
	}()
	select {
	case result := <-finished:
		t.Fatalf("snapshot acquired shared lock before release: %#v", result)
	case <-time.After(50 * time.Millisecond):
	}
	if _, err := repository.saveUnlocked(connection.SavedConnectionInput{
		ID: "snapshot-connection", Name: "Snapshot connection after lock",
		Config: connection.ConnectionConfig{ID: "snapshot-connection", Type: "mysql", Host: "db-after-lock", Password: "after-lock-secret"},
	}); err != nil {
		t.Fatalf("write paired connection snapshot while holding lock: %v", err)
	}
	if err := lock.Close(); err != nil {
		t.Fatalf("release shared storage lock: %v", err)
	}
	released = true
	select {
	case result := <-finished:
		if result.err != nil {
			t.Fatalf("snapshot after lock release: %v", result.err)
		}
		if len(result.snapshot.connectionsData) == 0 || len(result.snapshot.dailySecretsData) == 0 {
			t.Fatalf("snapshot did not capture paired connection files: %#v", result.snapshot)
		}
		if !strings.Contains(string(result.snapshot.connectionsData), "db-after-lock") || !strings.Contains(string(result.snapshot.dailySecretsData), "after-lock-secret") {
			t.Fatalf("snapshot mixed pre-lock metadata and secret revisions: connections=%s secrets=%s", result.snapshot.connectionsData, result.snapshot.dailySecretsData)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("snapshot did not acquire shared lock after release")
	}
}

func TestCloudBackupPayloadKeepsConnectionAndSecretSnapshotTogether(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	repository := application.savedConnectionRepository()
	if _, err := repository.Save(connection.SavedConnectionInput{
		ID: "payload-connection", Name: "Payload connection",
		Config: connection.ConnectionConfig{ID: "payload-connection", Type: "mysql", Host: "db-before-lock", Password: "before-lock-secret"},
	}); err != nil {
		t.Fatalf("seed connection: %v", err)
	}
	if _, err := application.BootstrapConnectionSidebarLayout(connection.ConnectionSidebarLayoutInput{
		ConnectionTags: []connection.ConnectionTag{{
			ID: "layout-before-lock", Name: "Layout before lock",
			ConnectionIDs: []string{"payload-connection"},
			ChildOrder:    []string{"connection:payload-connection"},
		}},
		SidebarRootOrder: []string{"tag:layout-before-lock"},
	}); err != nil {
		t.Fatalf("seed sidebar layout: %v", err)
	}
	lock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(application.configDir))
	if err != nil {
		t.Fatalf("acquire shared storage lock: %v", err)
	}
	released := false
	t.Cleanup(func() {
		if !released {
			_ = lock.Close()
		}
	})
	finished := make(chan struct {
		data []byte
		err  error
	}, 1)
	go func() {
		data, buildErr := application.buildCloudBackupPayload(CloudBackupConfig{
			BackupCategories: []string{CloudBackupCategoryConnections, CloudBackupCategoryDailySecrets},
		})
		finished <- struct {
			data []byte
			err  error
		}{data: data, err: buildErr}
	}()
	select {
	case result := <-finished:
		t.Fatalf("cloud backup payload acquired shared lock before release: %v", result.err)
	case <-time.After(50 * time.Millisecond):
	}
	if _, err := repository.saveUnlocked(connection.SavedConnectionInput{
		ID: "payload-connection", Name: "Payload connection after lock",
		Config: connection.ConnectionConfig{ID: "payload-connection", Type: "mysql", Host: "db-after-lock", Password: "after-lock-secret"},
	}); err != nil {
		t.Fatalf("write paired payload snapshot while holding lock: %v", err)
	}
	if err := application.connectionSidebarLayoutRepository().saveUnlocked(connection.ConnectionSidebarLayout{
		Initialized: true,
		Revision:    2,
		ConnectionTags: []connection.ConnectionTag{{
			ID: "layout-after-lock", Name: "Layout after lock",
			ConnectionIDs: []string{"payload-connection"},
			ChildOrder:    []string{"connection:payload-connection"},
		}},
		SidebarRootOrder: []string{"tag:layout-after-lock"},
	}); err != nil {
		t.Fatalf("write paired sidebar layout snapshot while holding lock: %v", err)
	}
	if err := lock.Close(); err != nil {
		t.Fatalf("release shared storage lock: %v", err)
	}
	released = true
	select {
	case result := <-finished:
		if result.err != nil {
			t.Fatalf("build cloud backup payload: %v", result.err)
		}
		var payload cloudBackupPayload
		if err := json.Unmarshal(result.data, &payload); err != nil {
			t.Fatalf("decode cloud backup payload: %v", err)
		}
		if len(payload.Connections.Connections) != 1 || payload.Connections.Connections[0].Config.Host != "db-after-lock" || payload.Connections.Connections[0].Secrets.Password != "after-lock-secret" {
			t.Fatalf("cloud backup payload mixed connection revisions: %#v", payload.Connections.Connections)
		}
		if payload.ConnectionSidebarLayout == nil || payload.ConnectionSidebarLayout.Revision != 2 || len(payload.ConnectionSidebarLayout.ConnectionTags) != 1 || payload.ConnectionSidebarLayout.ConnectionTags[0].ID != "layout-after-lock" {
			t.Fatalf("cloud backup payload mixed connection and sidebar layout revisions: %#v", payload.ConnectionSidebarLayout)
		}
		var dailySecrets []cloudBackupFile
		for _, file := range payload.Files {
			if file.Path == "daily_secrets.json" {
				dailySecrets = append(dailySecrets, file)
			}
		}
		if len(dailySecrets) != 1 || !strings.Contains(string(dailySecrets[0].Data), "after-lock-secret") {
			t.Fatalf("cloud backup payload did not include paired daily secrets: %#v", dailySecrets)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cloud backup payload did not acquire shared lock after release")
	}
}

func TestCloudBackupRestoreFilesWaitsForSharedStorageLock(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	secretPath := filepath.Join(application.configDir, "daily_secrets.json")
	if err := os.WriteFile(secretPath, []byte(`{"old":true}`), 0o600); err != nil {
		t.Fatalf("write original daily secrets: %v", err)
	}

	lock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(application.configDir))
	if err != nil {
		t.Fatalf("acquire shared storage lock: %v", err)
	}
	released := false
	t.Cleanup(func() {
		if !released {
			_ = lock.Close()
		}
	})
	type restoreResult struct {
		rollback func() error
		err      error
	}
	finished := make(chan restoreResult, 1)
	go func() {
		rollback, restoreErr := application.restoreCloudBackupFiles([]cloudBackupFile{{Path: "daily_secrets.json", Data: []byte(`{"new":true}`)}})
		finished <- restoreResult{rollback: rollback, err: restoreErr}
	}()
	select {
	case result := <-finished:
		t.Fatalf("restore acquired shared lock before release: %#v", result.err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := lock.Close(); err != nil {
		t.Fatalf("release shared storage lock: %v", err)
	}
	released = true
	select {
	case result := <-finished:
		if result.err != nil {
			t.Fatalf("restore after lock release: %v", result.err)
		}
		if data, readErr := os.ReadFile(secretPath); readErr != nil || string(data) != `{"new":true}` {
			t.Fatalf("restored daily secrets mismatch: data=%q err=%v", data, readErr)
		}
		if result.rollback == nil {
			t.Fatal("restore did not return rollback")
		}
		rollbackLock, lockErr := appdata.AcquireFileLock(appdata.SharedStorageLockPath(application.configDir))
		if lockErr != nil {
			t.Fatalf("acquire rollback shared storage lock: %v", lockErr)
		}
		rollbackDone := make(chan error, 1)
		go func() { rollbackDone <- result.rollback() }()
		select {
		case rollbackErr := <-rollbackDone:
			_ = rollbackLock.Close()
			t.Fatalf("rollback acquired shared lock before release: %v", rollbackErr)
		case <-time.After(50 * time.Millisecond):
		}
		if lockErr := rollbackLock.Close(); lockErr != nil {
			t.Fatalf("release rollback shared storage lock: %v", lockErr)
		}
		select {
		case rollbackErr := <-rollbackDone:
			if rollbackErr != nil {
				t.Fatalf("rollback after lock release: %v", rollbackErr)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("rollback did not acquire shared lock after release")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("restore did not acquire shared lock after release")
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
