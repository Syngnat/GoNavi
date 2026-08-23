package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/connection"
)

func TestApplyDataRootDirectorySerializesConcurrentRequests(t *testing.T) {
	app := NewApp()
	app.dataRootApplyMu.Lock()
	done := make(chan connection.QueryResult, 1)
	go func() {
		done <- app.ApplyDataRootDirectory(appdata.MustResolveActiveRoot(), false)
	}()

	select {
	case <-done:
		app.dataRootApplyMu.Unlock()
		t.Fatal("ApplyDataRootDirectory bypassed the application-wide serialization lock")
	case <-time.After(50 * time.Millisecond):
	}
	app.dataRootApplyMu.Unlock()

	select {
	case result := <-done:
		if !result.Success {
			t.Fatalf("serialized ApplyDataRootDirectory returned failure: %s", result.Message)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("serialized ApplyDataRootDirectory did not resume")
	}
}

func TestMigrateDataRootContentsCopiesKnownFilesAndDirectories(t *testing.T) {
	sourceRoot := t.TempDir()
	targetRoot := filepath.Join(t.TempDir(), "gonavi-data")

	if err := os.WriteFile(filepath.Join(sourceRoot, "connections.json"), []byte(`{"connections":[]}`), 0o644); err != nil {
		t.Fatalf("write connections.json failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "jvm_audit.jsonl"), []byte("jvm-audit\n"), 0o644); err != nil {
		t.Fatalf("write jvm_audit.jsonl failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "jvm_diag_audit.jsonl"), []byte("jvm-diag-audit\n"), 0o644); err != nil {
		t.Fatalf("write jvm_diag_audit.jsonl failed: %v", err)
	}
	for _, excludedName := range []string{
		filepath.Base(appdata.BootstrapPath()),
		filepath.Base(appdata.BootstrapLockPath()),
	} {
		if err := os.WriteFile(filepath.Join(sourceRoot, excludedName), []byte("bootstrap-only"), 0o600); err != nil {
			t.Fatalf("write excluded bootstrap file %s: %v", excludedName, err)
		}
	}
	if err := os.MkdirAll(filepath.Join(sourceRoot, "sessions"), 0o755); err != nil {
		t.Fatalf("mkdir sessions failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "sessions", "s1.json"), []byte(`{}`), 0o644); err != nil {
		t.Fatalf("write session file failed: %v", err)
	}

	if err := migrateDataRootContents(sourceRoot, targetRoot); err != nil {
		t.Fatalf("migrateDataRootContents returned error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(targetRoot, "connections.json")); err != nil {
		t.Fatalf("expected connections.json in target root: %v", err)
	}
	if _, err := os.Stat(filepath.Join(targetRoot, "sessions", "s1.json")); err != nil {
		t.Fatalf("expected session file in target root: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(targetRoot, "jvm_audit.jsonl")); err != nil || string(got) != "jvm-audit\n" {
		t.Fatalf("expected jvm_audit.jsonl to migrate, content=%q err=%v", string(got), err)
	}
	if got, err := os.ReadFile(filepath.Join(targetRoot, "jvm_diag_audit.jsonl")); err != nil || string(got) != "jvm-diag-audit\n" {
		t.Fatalf("expected jvm_diag_audit.jsonl to migrate, content=%q err=%v", string(got), err)
	}
	for _, excludedName := range []string{
		filepath.Base(appdata.BootstrapPath()),
		filepath.Base(appdata.BootstrapLockPath()),
	} {
		if _, err := os.Stat(filepath.Join(targetRoot, excludedName)); !os.IsNotExist(err) {
			t.Fatalf("bootstrap file %s should not migrate, err=%v", excludedName, err)
		}
	}
}

func TestMigrateDataRootContentsReplacesAuditDirectoryWithoutStaleSidecars(t *testing.T) {
	sourceRoot := t.TempDir()
	targetRoot := t.TempDir()
	sourceAudit := filepath.Join(sourceRoot, "audit")
	targetAudit := filepath.Join(targetRoot, "audit")
	if err := os.MkdirAll(sourceAudit, 0o700); err != nil {
		t.Fatalf("create source audit directory: %v", err)
	}
	if err := os.MkdirAll(targetAudit, 0o700); err != nil {
		t.Fatalf("create target audit directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceAudit, "sql_audit.db"), []byte("source-db"), 0o600); err != nil {
		t.Fatalf("write source audit database: %v", err)
	}
	for name, content := range map[string]string{
		"sql_audit.db":          "old-db",
		"sql_audit.db-wal":      "stale-wal",
		"sql_audit.db-shm":      "stale-shm",
		"sql_audit_health.json": "stale-health",
	} {
		if err := os.WriteFile(filepath.Join(targetAudit, name), []byte(content), 0o600); err != nil {
			t.Fatalf("write target audit artifact %s: %v", name, err)
		}
	}

	if err := migrateDataRootContents(sourceRoot, targetRoot); err != nil {
		t.Fatalf("migrateDataRootContents returned error: %v", err)
	}
	payload, err := os.ReadFile(filepath.Join(targetAudit, "sql_audit.db"))
	if err != nil || string(payload) != "source-db" {
		t.Fatalf("target audit database = %q err=%v, want exact source snapshot", payload, err)
	}
	for _, name := range []string{"sql_audit.db-wal", "sql_audit.db-shm", "sql_audit_health.json"} {
		if _, err := os.Stat(filepath.Join(targetAudit, name)); !os.IsNotExist(err) {
			t.Fatalf("stale target audit artifact %s survived exact replacement: %v", name, err)
		}
	}
}

func TestMigrateDataRootContentsRemovesTargetAuditWhenSourceHasNone(t *testing.T) {
	sourceRoot := t.TempDir()
	targetRoot := t.TempDir()
	targetAudit := filepath.Join(targetRoot, "audit")
	if err := os.MkdirAll(targetAudit, 0o700); err != nil {
		t.Fatalf("create target audit directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(targetAudit, "sql_audit.db-wal"), []byte("stale"), 0o600); err != nil {
		t.Fatalf("write stale target audit artifact: %v", err)
	}

	if err := migrateDataRootContents(sourceRoot, targetRoot); err != nil {
		t.Fatalf("migrateDataRootContents returned error: %v", err)
	}
	if _, err := os.Stat(targetAudit); !os.IsNotExist(err) {
		t.Fatalf("target audit directory survived despite absent source snapshot: %v", err)
	}
}

func TestMigrateDataRootContentsCopiesSecurityUpdateStateAndRewritesBackupPaths(t *testing.T) {
	sourceRoot := t.TempDir()
	targetRoot := filepath.Join(t.TempDir(), "gonavi-data")
	sourceRepo := newSecurityUpdateStateRepository(sourceRoot)
	started, err := sourceRepo.StartRound(StartSecurityUpdateRequest{SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig})
	if err != nil {
		t.Fatalf("start security update round failed: %v", err)
	}
	completed := started
	completed.OverallStatus = SecurityUpdateOverallStatusCompleted
	if err := sourceRepo.WriteResult(completed); err != nil {
		t.Fatalf("write security update result failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(started.BackupPath, securityUpdateSourceCurrentAppFileName), []byte(`{"state":{}}`), 0o644); err != nil {
		t.Fatalf("write source-current-app failed: %v", err)
	}

	if err := migrateDataRootContents(sourceRoot, targetRoot); err != nil {
		t.Fatalf("migrateDataRootContents returned error: %v", err)
	}

	targetBackupPath := filepath.Join(targetRoot, securityUpdateBackupRootDirName, started.MigrationID)
	targetRepo := newSecurityUpdateStateRepository(targetRoot)
	targetStatus, err := targetRepo.LoadMarker()
	if err != nil {
		t.Fatalf("load migrated marker failed: %v", err)
	}
	if targetStatus.BackupPath != targetBackupPath {
		t.Fatalf("expected migrated marker backupPath %q, got %q", targetBackupPath, targetStatus.BackupPath)
	}

	manifestData, err := os.ReadFile(filepath.Join(targetBackupPath, securityUpdateManifestFileName))
	if err != nil {
		t.Fatalf("read migrated manifest failed: %v", err)
	}
	var manifest securityUpdateBackupManifest
	if err := json.Unmarshal(manifestData, &manifest); err != nil {
		t.Fatalf("parse migrated manifest failed: %v", err)
	}
	if manifest.BackupPath != targetBackupPath {
		t.Fatalf("expected migrated manifest backupPath %q, got %q", targetBackupPath, manifest.BackupPath)
	}

	resultData, err := os.ReadFile(filepath.Join(targetBackupPath, securityUpdateResultFileName))
	if err != nil {
		t.Fatalf("read migrated result failed: %v", err)
	}
	var result SecurityUpdateStatus
	if err := json.Unmarshal(resultData, &result); err != nil {
		t.Fatalf("parse migrated result failed: %v", err)
	}
	if result.BackupPath != targetBackupPath {
		t.Fatalf("expected migrated result backupPath %q, got %q", targetBackupPath, result.BackupPath)
	}
	if _, err := os.Stat(filepath.Join(targetBackupPath, securityUpdateSourceCurrentAppFileName)); err != nil {
		t.Fatalf("expected migrated security update backup payload: %v", err)
	}
}

func TestMigrateDataRootContentsToleratesMissingSecurityUpdateArtifacts(t *testing.T) {
	sourceRoot := t.TempDir()
	targetRoot := filepath.Join(t.TempDir(), "gonavi-data")
	sourceRepo := newSecurityUpdateStateRepository(sourceRoot)
	started, err := sourceRepo.StartRound(StartSecurityUpdateRequest{SourceType: SecurityUpdateSourceTypeCurrentAppSavedConfig})
	if err != nil {
		t.Fatalf("start security update round failed: %v", err)
	}
	if err := os.Remove(sourceRepo.manifestPath(started.MigrationID)); err != nil {
		t.Fatalf("remove source manifest failed: %v", err)
	}
	if err := os.Remove(sourceRepo.resultPath(started.MigrationID)); err != nil {
		t.Fatalf("remove source result failed: %v", err)
	}

	if err := migrateDataRootContents(sourceRoot, targetRoot); err != nil {
		t.Fatalf("migrateDataRootContents should tolerate missing security update artifacts, got: %v", err)
	}

	targetRepo := newSecurityUpdateStateRepository(targetRoot)
	targetStatus, err := targetRepo.LoadMarker()
	if err != nil {
		t.Fatalf("load migrated marker failed: %v", err)
	}
	expectedBackupPath := filepath.Join(targetRoot, securityUpdateBackupRootDirName, started.MigrationID)
	if targetStatus.BackupPath != expectedBackupPath {
		t.Fatalf("expected migrated marker backupPath %q, got %q", expectedBackupPath, targetStatus.BackupPath)
	}
}

func TestMigrateDataRootContentsCopiesDailySecretsForSavedConnections(t *testing.T) {
	sourceRoot := t.TempDir()
	targetRoot := filepath.Join(t.TempDir(), "gonavi-data")
	sourceApp := NewAppWithSecretStore(newFakeAppSecretStore())
	sourceApp.configDir = sourceRoot

	if _, err := sourceApp.SaveConnection(connection.SavedConnectionInput{
		ID:   "conn-secret",
		Name: "Primary",
		Config: connection.ConnectionConfig{
			ID:       "conn-secret",
			Type:     "postgres",
			Host:     "db.local",
			Port:     5432,
			User:     "postgres",
			Password: "postgres-secret",
			DSN:      "postgres://postgres:postgres-secret@db.local/app",
		},
	}); err != nil {
		t.Fatalf("save source connection failed: %v", err)
	}

	if err := migrateDataRootContents(sourceRoot, targetRoot); err != nil {
		t.Fatalf("migrateDataRootContents returned error: %v", err)
	}

	targetApp := NewAppWithSecretStore(newFakeAppSecretStore())
	targetApp.configDir = targetRoot
	resolved, err := targetApp.resolveConnectionSecrets(connection.ConnectionConfig{ID: "conn-secret"})
	if err != nil {
		t.Fatalf("resolve migrated connection secrets failed: %v", err)
	}
	if resolved.Password != "postgres-secret" {
		t.Fatalf("expected migrated password to be restored, got %q", resolved.Password)
	}
	if resolved.DSN != "postgres://postgres:postgres-secret@db.local/app" {
		t.Fatalf("expected migrated DSN to be restored, got %q", resolved.DSN)
	}
}

func TestMigrateDataRootContentsWaitsForSourceSharedStorageLock(t *testing.T) {
	sourceRoot := t.TempDir()
	targetRoot := filepath.Join(t.TempDir(), "gonavi-data")
	if err := os.WriteFile(filepath.Join(sourceRoot, "connections.json"), []byte(`{"connections":[{"id":"locked"}]}`), 0o644); err != nil {
		t.Fatalf("write source connections: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "daily_secrets.json"), []byte(`{"connections":{"locked":{"password":"secret"}}}`), 0o600); err != nil {
		t.Fatalf("write source daily secrets: %v", err)
	}

	lock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(sourceRoot))
	if err != nil {
		t.Fatalf("acquire source shared storage lock: %v", err)
	}
	released := false
	t.Cleanup(func() {
		if !released {
			_ = lock.Close()
		}
	})
	finished := make(chan error, 1)
	go func() {
		finished <- migrateDataRootContents(sourceRoot, targetRoot)
	}()
	select {
	case migrateErr := <-finished:
		t.Fatalf("migration acquired source shared lock before release: %v", migrateErr)
	case <-time.After(50 * time.Millisecond):
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "connections.json"), []byte(`{"connections":[{"id":"after-lock"}]}`), 0o644); err != nil {
		t.Fatalf("update source connections while holding lock: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "daily_secrets.json"), []byte(`{"connections":{"after-lock":{"password":"after-lock-secret"}}}`), 0o600); err != nil {
		t.Fatalf("update source daily secrets while holding lock: %v", err)
	}
	if err := lock.Close(); err != nil {
		t.Fatalf("release source shared storage lock: %v", err)
	}
	released = true
	select {
	case migrateErr := <-finished:
		if migrateErr != nil {
			t.Fatalf("migration after source lock release: %v", migrateErr)
		}
		connections, readErr := os.ReadFile(filepath.Join(targetRoot, "connections.json"))
		if readErr != nil || string(connections) != `{"connections":[{"id":"after-lock"}]}` {
			t.Fatalf("migrated connections snapshot = %q err=%v", connections, readErr)
		}
		secrets, readErr := os.ReadFile(filepath.Join(targetRoot, "daily_secrets.json"))
		if readErr != nil || string(secrets) != `{"connections":{"after-lock":{"password":"after-lock-secret"}}}` {
			t.Fatalf("migrated daily secrets snapshot = %q err=%v", secrets, readErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("migration did not acquire source shared lock after release")
	}
}

func TestMigrateDataRootContentsWaitsForTargetSharedStorageLock(t *testing.T) {
	sourceRoot := t.TempDir()
	targetRoot := filepath.Join(t.TempDir(), "gonavi-data")
	if err := os.WriteFile(filepath.Join(sourceRoot, "connections.json"), []byte(`{"connections":[]}`), 0o644); err != nil {
		t.Fatalf("write source connections: %v", err)
	}
	if err := os.MkdirAll(targetRoot, 0o755); err != nil {
		t.Fatalf("create target root: %v", err)
	}

	lock, err := appdata.AcquireFileLock(appdata.SharedStorageLockPath(targetRoot))
	if err != nil {
		t.Fatalf("acquire target shared storage lock: %v", err)
	}
	released := false
	t.Cleanup(func() {
		if !released {
			_ = lock.Close()
		}
	})
	finished := make(chan error, 1)
	go func() {
		finished <- migrateDataRootContents(sourceRoot, targetRoot)
	}()
	select {
	case migrateErr := <-finished:
		t.Fatalf("migration acquired target shared lock before release: %v", migrateErr)
	case <-time.After(50 * time.Millisecond):
	}
	if err := lock.Close(); err != nil {
		t.Fatalf("release target shared storage lock: %v", err)
	}
	released = true
	select {
	case migrateErr := <-finished:
		if migrateErr != nil {
			t.Fatalf("migration after target lock release: %v", migrateErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("migration did not acquire target shared lock after release")
	}
}

func TestMigrateDataRootContentsUsesStableLockOrderForOppositeMigrations(t *testing.T) {
	firstRoot := t.TempDir()
	secondRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(firstRoot, "connections.json"), []byte(`{"connections":[{"id":"first"}]}`), 0o644); err != nil {
		t.Fatalf("write first source connections: %v", err)
	}
	if err := os.WriteFile(filepath.Join(secondRoot, "connections.json"), []byte(`{"connections":[{"id":"second"}]}`), 0o644); err != nil {
		t.Fatalf("write second source connections: %v", err)
	}

	results := make(chan error, 2)
	go func() { results <- migrateDataRootContents(firstRoot, secondRoot) }()
	go func() { results <- migrateDataRootContents(secondRoot, firstRoot) }()
	for index := 0; index < 2; index++ {
		select {
		case err := <-results:
			if err != nil {
				t.Fatalf("opposite migration %d returned error: %v", index, err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("opposite migrations deadlocked while acquiring roots")
		}
	}
}
