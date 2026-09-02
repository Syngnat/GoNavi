package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/importjob"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/internal/uievents"
)

type rowErrorImportTestDB struct {
	fakeMetadataRetryDB
	execCalls int
	failAt    int
	afterExec func(int)
}

func (database *rowErrorImportTestDB) Exec(string) (int64, error) {
	database.execCalls++
	if database.afterExec != nil {
		database.afterExec(database.execCalls)
	}
	if database.execCalls == database.failAt {
		return 0, errors.New("duplicate key token=private-value")
	}
	return 1, nil
}

func (database *rowErrorImportTestDB) ApplyChanges(_ string, changes connection.ChangeSet) error {
	for range changes.Inserts {
		if _, err := database.Exec(""); err != nil {
			return err
		}
	}
	return nil
}

func (database *rowErrorImportTestDB) ApplyChangesContext(ctx context.Context, tableName string, changes connection.ChangeSet) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return database.ApplyChanges(tableName, changes)
}

func installImportTestDatabase(t *testing.T, database db.Database) {
	t.Helper()
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
}

func newManagedImportTestApp(t *testing.T) *App {
	t.Helper()
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	app.configDir = t.TempDir()
	app.ctx = uievents.WithEmitter(context.Background(), noopImportEventEmitter{})
	return app
}

func TestImportDataWithProgressOptionsPersistsCompletedManagedJob(t *testing.T) {
	database := &rowErrorImportTestDB{fakeMetadataRetryDB: fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{{Name: "id", Type: "bigint"}},
	}}
	installImportTestDatabase(t, database)

	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("id\n1\n2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := newManagedImportTestApp(t)
	stopOnError := false
	result := app.ImportDataWithProgressOptions(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
		"app",
		"users",
		path,
		ImportFileOptions{JobID: "table-import-complete", ContinueOnError: &stopOnError},
	)
	if !result.Success {
		t.Fatalf("import failed: %#v", result)
	}

	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Get("table-import-complete")
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != importjob.StatusCompleted || job.Current != 2 || job.Succeeded != 2 || job.Failed != 0 {
		t.Fatalf("unexpected managed job: %#v", job)
	}
	if job.SourceIdentityToken == "" || job.TargetFingerprint == "" || job.OptionsHash == "" {
		t.Fatalf("managed job identity is incomplete: %#v", job)
	}
	if job.TableImportOptions == nil || job.TableImportOptions.ContinueOnError == nil || *job.TableImportOptions.ContinueOnError {
		t.Fatalf("managed job replay recipe is incomplete: %#v", job.TableImportOptions)
	}
}

func TestImportDataWithProgressOptionsPublishesRejectedRowsAndPartialJob(t *testing.T) {
	database := &rowErrorImportTestDB{
		fakeMetadataRetryDB: fakeMetadataRetryDB{columns: []connection.ColumnDefinition{{Name: "id", Type: "bigint"}}},
		failAt:              2,
	}
	installImportTestDatabase(t, database)

	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("id\n1\n2\n3\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	app := newManagedImportTestApp(t)
	continueOnError := true
	result := app.ImportDataWithProgressOptions(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
		"app",
		"users",
		path,
		ImportFileOptions{JobID: "table-import-partial", ContinueOnError: &continueOnError},
	)
	if !result.Success {
		t.Fatalf("continue import failed: %#v", result)
	}
	payload, ok := result.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected payload type: %T", result.Data)
	}
	artifactID, _ := payload["errorArtifactId"].(string)
	if artifactID == "" || payload["errorArtifactCount"] != int64(1) {
		t.Fatalf("missing rejected-row artifact: %#v", payload)
	}

	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Get("table-import-partial")
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != importjob.StatusPartial || job.Succeeded != 2 || job.Failed != 1 || job.ErrorArtifactID != artifactID {
		t.Fatalf("unexpected partial job: %#v", job)
	}
	if job.ErrorArtifactCount != 1 || job.ErrorArtifactBytes <= 0 || job.ErrorArtifactOmittedCount != 0 ||
		job.ErrorArtifactTruncated || job.ErrorArtifactRetryableCount != 1 ||
		job.ErrorArtifactUnretryableCount != 0 || !job.ErrorArtifactScopeKnown {
		t.Fatalf("unexpected partial artifact scope: %#v", job)
	}

	artifactStore, err := app.ensureImportErrorArtifactStore()
	if err != nil {
		t.Fatal(err)
	}
	artifact, err := artifactStore.Open(artifactID)
	if err != nil {
		t.Fatal(err)
	}
	defer artifact.Close()
	var rejected ImportRowError
	if err := json.NewDecoder(artifact).Decode(&rejected); err != nil {
		t.Fatal(err)
	}
	if rejected.SourceRow != 2 || rejected.Category != "database" || rejected.Values["id"] != "2" {
		t.Fatalf("unexpected rejected row: %#v", rejected)
	}
	if rejected.Message == "" || rejected.Message == "duplicate key token=private-value" {
		t.Fatalf("database error was not sanitized: %q", rejected.Message)
	}
}

func TestImportDataWithProgressOptionsRejectsStaleSourceBeforeDatabaseAccess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("id\n1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	identity, err := captureImportSourceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("id\n1\n2\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	opened := false
	newDatabaseFunc = func(string) (db.Database, error) {
		opened = true
		return &rowErrorImportTestDB{}, nil
	}
	result := NewApp().ImportDataWithProgressOptions(
		connection.ConnectionConfig{Type: "mysql"}, "app", "users", path,
		ImportFileOptions{SourceIdentityToken: identity.Token},
	)
	if result.Success {
		t.Fatalf("stale source should fail: %#v", result)
	}
	if opened {
		t.Fatal("stale source must be rejected before opening the database")
	}
}

func TestImportDataWithProgressOptionsMarksOutcomeUnknownWhenSourceChangesDuringRun(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("id\n1\n2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	database := &rowErrorImportTestDB{
		fakeMetadataRetryDB: fakeMetadataRetryDB{columns: []connection.ColumnDefinition{{Name: "id", Type: "bigint"}}},
		afterExec: func(call int) {
			if call == 1 {
				file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
				if err != nil {
					t.Errorf("open source for mutation: %v", err)
					return
				}
				if _, err := file.WriteString("3\n"); err != nil {
					t.Errorf("mutate source: %v", err)
				}
				if err := file.Close(); err != nil {
					t.Errorf("close mutated source: %v", err)
				}
			}
		},
	}
	installImportTestDatabase(t, database)
	app := newManagedImportTestApp(t)
	continueOnError := true
	result := app.ImportDataWithProgressOptions(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
		"app", "users", path,
		ImportFileOptions{JobID: "table-import-mutated", ContinueOnError: &continueOnError},
	)
	if result.Success {
		t.Fatalf("mutated source must not be reported as a certain success: %#v", result)
	}
	payload, ok := result.Data.(map[string]interface{})
	if !ok || payload["sourceChanged"] != true || payload["outcomeUnknown"] != true {
		t.Fatalf("unexpected source-change payload: %#v", result.Data)
	}
	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Get("table-import-mutated")
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != importjob.StatusUnknown || !job.OutcomeUnknown {
		t.Fatalf("unexpected source-change job: %#v", job)
	}
}

func TestCompatibilityTableImportAlsoDetectsSourceChangesDuringRun(t *testing.T) {
	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("id\n1\n2\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	database := &rowErrorImportTestDB{
		fakeMetadataRetryDB: fakeMetadataRetryDB{columns: []connection.ColumnDefinition{{Name: "id", Type: "bigint"}}},
		afterExec: func(call int) {
			if call != 1 {
				return
			}
			file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
			if err != nil {
				t.Errorf("open source for mutation: %v", err)
				return
			}
			if _, err := file.WriteString("3\n"); err != nil {
				t.Errorf("mutate source: %v", err)
			}
			if err := file.Close(); err != nil {
				t.Errorf("close mutated source: %v", err)
			}
		},
	}
	installImportTestDatabase(t, database)
	continueOnError := true
	result := NewApp().ImportDataWithProgressOptions(
		connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
		"app", "users", path,
		ImportFileOptions{ContinueOnError: &continueOnError},
	)
	if result.Success {
		t.Fatalf("mutated source must not be reported as a certain success: %#v", result)
	}
	payload, ok := result.Data.(map[string]interface{})
	if !ok || payload["sourceChanged"] != true || payload["outcomeUnknown"] != true {
		t.Fatalf("unexpected source-change payload: %#v", result.Data)
	}
}
