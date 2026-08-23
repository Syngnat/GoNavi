package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/importjob"
	"GoNavi-Wails/internal/uievents"
)

func newImportRecoveryTestApp(t *testing.T) (*App, connection.ConnectionConfig) {
	t.Helper()
	app := NewAppWithSecretStore(newFakeAppSecretStore())
	app.configDir = t.TempDir()
	app.ctx = uievents.WithEmitter(context.Background(), noopImportEventEmitter{})
	config := connection.ConnectionConfig{
		ID:       "recovery-connection",
		Type:     "mysql",
		Host:     "127.0.0.1",
		Port:     3306,
		User:     "tester",
		Password: "test-secret",
		Database: "app",
	}
	if _, err := app.SaveConnection(connection.SavedConnectionInput{
		ID: config.ID, Name: "Recovery test", Config: config,
	}); err != nil {
		t.Fatal(err)
	}
	return app, config
}

func seedInterruptedTableImportJob(
	t *testing.T,
	app *App,
	config connection.ConnectionConfig,
	path string,
	options ImportFileOptions,
	checkpoint importjob.Checkpoint,
) importjob.Job {
	t.Helper()
	identity, err := captureImportSourceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Put(importjob.Job{
		ID:                  "interrupted-import",
		Kind:                importjob.KindTable,
		Status:              importjob.StatusInterrupted,
		SourcePath:          path,
		SourceIdentityToken: identity.Token,
		TargetFingerprint:   buildImportTargetFingerprint(config, "app", "users"),
		ConnectionID:        config.ID,
		DatabaseName:        "app",
		TableName:           "users",
		OptionsHash:         buildImportFileOptionsHash(options),
		TableImportOptions:  importJobTableOptionsFromImportFileOptions(options),
		Current:             checkpoint.SourceRow,
		Succeeded:           checkpoint.SourceRow,
		Checkpoint:          checkpoint,
		Resumable:           true,
	})
	if err != nil {
		t.Fatal(err)
	}
	return job
}

func TestResumeImportJobSkipsCommittedPrefixAndCreatesHistoryEntry(t *testing.T) {
	database := &rowErrorImportTestDB{fakeMetadataRetryDB: fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{{Name: "id", Type: "bigint"}},
	}}
	installImportTestDatabase(t, database)
	app, config := newImportRecoveryTestApp(t)
	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("id\n1\n2\n3\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	stopOnError := false
	parent := seedInterruptedTableImportJob(t, app, config, path, ImportFileOptions{
		ContinueOnError: &stopOnError,
	}, importjob.Checkpoint{Safe: true, SourceRow: 1})

	result := app.ResumeImportJob(parent.ID)
	if !result.Success {
		t.Fatalf("resume failed: %#v", result)
	}
	if database.execCalls != 2 {
		t.Fatalf("resume submitted %d rows, want only the two uncommitted rows", database.execCalls)
	}

	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	updatedParent, err := store.Get(parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	if updatedParent.Resumable {
		t.Fatalf("parent checkpoint remained reusable after recovery: %#v", updatedParent)
	}
	jobs, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	var resumed *importjob.Job
	for index := range jobs {
		if jobs[index].ParentJobID == parent.ID && jobs[index].RecoveryAction == "resume" {
			resumed = &jobs[index]
			break
		}
	}
	if resumed == nil || resumed.Status != importjob.StatusCompleted || resumed.Current != 3 || resumed.Succeeded != 3 {
		t.Fatalf("resumed history entry = %#v", resumed)
	}
}

func TestResumeImportJobRejectsChangedSourceTargetAndOptionsBeforeDatabaseAccess(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(t *testing.T, app *App, config connection.ConnectionConfig, path string, job importjob.Job)
	}{
		{
			name: "source",
			mutate: func(t *testing.T, _ *App, _ connection.ConnectionConfig, path string, _ importjob.Job) {
				t.Helper()
				if err := os.WriteFile(path, []byte("id\n1\nchanged\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "target",
			mutate: func(t *testing.T, app *App, config connection.ConnectionConfig, _ string, _ importjob.Job) {
				t.Helper()
				config.Host = "changed.example.test"
				if _, err := app.SaveConnection(connection.SavedConnectionInput{ID: config.ID, Name: "Recovery test", Config: config}); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "options",
			mutate: func(t *testing.T, app *App, _ connection.ConnectionConfig, _ string, job importjob.Job) {
				t.Helper()
				store, err := app.ensureImportJobStore()
				if err != nil {
					t.Fatal(err)
				}
				job.OptionsHash = "changed-options-hash"
				if _, err := store.Put(job); err != nil {
					t.Fatal(err)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app, config := newImportRecoveryTestApp(t)
			path := filepath.Join(t.TempDir(), "users.csv")
			if err := os.WriteFile(path, []byte("id\n1\n2\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			stopOnError := false
			job := seedInterruptedTableImportJob(t, app, config, path, ImportFileOptions{ContinueOnError: &stopOnError}, importjob.Checkpoint{Safe: true, SourceRow: 1})
			test.mutate(t, app, config, path, job)

			opened := false
			originalNewDatabaseFunc := newDatabaseFunc
			newDatabaseFunc = func(string) (db.Database, error) {
				opened = true
				return &rowErrorImportTestDB{}, nil
			}
			t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
			result := app.ResumeImportJob(job.ID)
			if result.Success {
				t.Fatalf("%s mismatch unexpectedly resumed: %#v", test.name, result)
			}
			if opened {
				t.Fatalf("%s mismatch opened the database", test.name)
			}
		})
	}
}

func TestRetryImportJobFailedRowsOnlySubmitsArtifactRows(t *testing.T) {
	database := &rowErrorImportTestDB{fakeMetadataRetryDB: fakeMetadataRetryDB{
		columns: []connection.ColumnDefinition{{Name: "id", Type: "bigint"}},
	}}
	installImportTestDatabase(t, database)
	app, config := newImportRecoveryTestApp(t)
	continueOnError := true
	options := ImportFileOptions{ContinueOnError: &continueOnError}
	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	artifactStore, err := app.ensureImportErrorArtifactStore()
	if err != nil {
		t.Fatal(err)
	}
	writer, err := artifactStore.Begin("partial-import")
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.Append(ImportRowError{SourceRow: 2, Category: "database", Message: "duplicate", Values: map[string]interface{}{"id": "2"}}); err != nil {
		t.Fatal(err)
	}
	artifact, err := writer.Finish()
	if err != nil {
		t.Fatal(err)
	}
	parent, err := store.Put(importjob.Job{
		ID:                  "partial-import",
		Kind:                importjob.KindTable,
		Status:              importjob.StatusPartial,
		SourcePath:          "D:/imports/users.csv",
		SourceIdentityToken: "source-v1",
		TargetFingerprint:   buildImportTargetFingerprint(config, "app", "users"),
		ConnectionID:        config.ID,
		DatabaseName:        "app",
		TableName:           "users",
		OptionsHash:         buildImportFileOptionsHash(options),
		TableImportOptions:  importJobTableOptionsFromImportFileOptions(options),
		Succeeded:           10,
		Failed:              1,
		ErrorArtifactID:     artifact.ID,
	})
	if err != nil {
		t.Fatal(err)
	}

	result := app.RetryImportJobFailedRows(parent.ID)
	if !result.Success {
		t.Fatalf("retry failed rows: %#v", result)
	}
	if database.execCalls != 1 {
		t.Fatalf("retry submitted %d rows, want only the artifact row", database.execCalls)
	}
	jobs, err := store.List()
	if err != nil {
		t.Fatal(err)
	}
	if !containsRecoveryJob(jobs, parent.ID, importJobRecoveryActionRetryFailedRows) {
		t.Fatalf("missing failed-row retry history entry: %#v", jobs)
	}
}

func TestRecoveryActionsFailClosedForUnknownOutcome(t *testing.T) {
	app, config := newImportRecoveryTestApp(t)
	path := filepath.Join(t.TempDir(), "users.csv")
	if err := os.WriteFile(path, []byte("id\n1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	continueOnError := true
	job := seedInterruptedTableImportJob(t, app, config, path, ImportFileOptions{ContinueOnError: &continueOnError}, importjob.Checkpoint{Safe: true, SourceRow: 1})
	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	job.OutcomeUnknown = true
	if _, err := store.Put(job); err != nil {
		t.Fatal(err)
	}
	if result := app.ResumeImportJob(job.ID); result.Success {
		t.Fatalf("unknown outcome resume = %#v", result)
	}
	if result := app.RetryImportJobFailedRows(job.ID); result.Success {
		t.Fatalf("unknown outcome retry = %#v", result)
	}
}

func containsRecoveryJob(jobs []importjob.Job, parentID, action string) bool {
	for _, job := range jobs {
		if job.ParentJobID == parentID && job.RecoveryAction == action {
			return true
		}
	}
	return false
}
