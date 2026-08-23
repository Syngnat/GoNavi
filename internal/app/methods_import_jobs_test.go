package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"GoNavi-Wails/internal/importjob"
)

func TestListImportJobsSkipsCorruptMetadataAndKeepsJobArrayContract(t *testing.T) {
	app := NewApp()
	app.configDir = t.TempDir()
	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	valid, err := store.Put(importjob.Job{ID: "import-valid", Kind: importjob.KindSQL, Status: importjob.StatusCompleted})
	if err != nil {
		t.Fatal(err)
	}
	corruptContents := `{"sourcePath":"C:\\private\\customer.sql"`
	if err := os.WriteFile(filepath.Join(app.configDir, "import-jobs", "import-corrupt.json"), []byte(corruptContents), 0o600); err != nil {
		t.Fatal(err)
	}

	result := app.ListImportJobs()
	if !result.Success {
		t.Fatalf("list import jobs failed: %#v", result)
	}
	jobs, ok := result.Data.([]importjob.Job)
	if !ok {
		t.Fatalf("data type = %T, want []importjob.Job", result.Data)
	}
	if len(jobs) != 1 || jobs[0].ID != valid.ID {
		t.Fatalf("jobs = %#v, want only %q", jobs, valid.ID)
	}
	if !strings.Contains(result.Message, "1") {
		t.Fatalf("warning = %q, want skipped file count", result.Message)
	}
	if strings.Contains(result.Message, app.configDir) || strings.Contains(result.Message, corruptContents) {
		t.Fatalf("warning leaked path or contents: %q", result.Message)
	}
}

func TestRecoverImportJobsOnStartupSkipsCorruptMetadataAndRecoversValidJobs(t *testing.T) {
	app := NewApp()
	app.configDir = t.TempDir()
	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	running, err := store.Put(importjob.Job{
		ID:                  "import-running-valid",
		Kind:                importjob.KindTable,
		Status:              importjob.StatusRunning,
		SourcePath:          "D:/imports/users.csv",
		ConnectionID:        "connection-v1",
		SourceIdentityToken: "source-v1",
		TargetFingerprint:   "target-v1",
		OptionsHash:         "options-v1",
		TableImportOptions:  &importjob.TableImportOptions{},
		Checkpoint:          importjob.Checkpoint{Safe: true, SourceRow: 1000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(app.configDir, "import-jobs", "import-truncated.json"), []byte(`{"id":`), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := app.recoverImportJobsOnStartup(); err != nil {
		t.Fatalf("startup recovery failed because one metadata file was corrupt: %v", err)
	}
	persisted, err := store.Get(running.ID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Status != importjob.StatusInterrupted || !persisted.Resumable {
		t.Fatalf("valid job was not recovered: %#v", persisted)
	}
}

func TestImportJobsRecoverAcrossApplicationRestart(t *testing.T) {
	configDir := t.TempDir()
	first := NewApp()
	first.configDir = configDir
	store, err := first.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Put(importjob.Job{
		ID:                  "import-persisted-job",
		Kind:                importjob.KindTable,
		Status:              importjob.StatusRunning,
		SourcePath:          "D:/imports/users.csv",
		ConnectionID:        "connection-v1",
		SourceIdentityToken: "source-v1",
		TargetFingerprint:   "target-v1",
		OptionsHash:         "options-v1",
		TableImportOptions:  &importjob.TableImportOptions{},
		Checkpoint:          importjob.Checkpoint{Safe: true, SourceRow: 1000},
	}); err != nil {
		t.Fatal(err)
	}

	second := NewApp()
	second.configDir = configDir
	if err := second.recoverImportJobsOnStartup(); err != nil {
		t.Fatal(err)
	}
	result := second.ListImportJobs()
	if !result.Success {
		t.Fatalf("list import jobs failed: %#v", result)
	}
	jobs, ok := result.Data.([]importjob.Job)
	if !ok || len(jobs) != 1 {
		t.Fatalf("unexpected jobs payload: %T %#v", result.Data, result.Data)
	}
	if jobs[0].Status != importjob.StatusInterrupted || !jobs[0].Resumable {
		t.Fatalf("job was not recovered safely: %#v", jobs[0])
	}
}

func TestDeleteImportJobRejectsRunningAndDeletesTerminalHistory(t *testing.T) {
	app := NewApp()
	app.configDir = t.TempDir()
	store, err := app.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	running, err := store.Put(importjob.Job{ID: "import-running", Kind: importjob.KindTable, Status: importjob.StatusRunning})
	if err != nil {
		t.Fatal(err)
	}
	artifactStore, err := app.ensureImportErrorArtifactStore()
	if err != nil {
		t.Fatal(err)
	}
	artifactWriter, err := artifactStore.Begin("import-terminal")
	if err != nil {
		t.Fatal(err)
	}
	if err := artifactWriter.Append(ImportRowError{SourceRow: 2, Category: "database", Message: "duplicate"}); err != nil {
		t.Fatal(err)
	}
	artifact, err := artifactWriter.Finish()
	if err != nil {
		t.Fatal(err)
	}
	terminal, err := store.Put(importjob.Job{
		ID:              "import-terminal",
		Kind:            importjob.KindSQL,
		Status:          importjob.StatusCompleted,
		ErrorArtifactID: artifact.ID,
	})
	if err != nil {
		t.Fatal(err)
	}

	if result := app.DeleteImportJob(running.ID); result.Success {
		t.Fatalf("running job deletion unexpectedly succeeded: %#v", result)
	}
	if result := app.DeleteImportJob(terminal.ID); !result.Success {
		t.Fatalf("terminal job deletion failed: %#v", result)
	}
	if _, err := store.Get(terminal.ID); err == nil {
		t.Fatal("terminal job still exists after deletion")
	}
	if file, err := artifactStore.Open(artifact.ID); err == nil {
		file.Close()
		t.Fatal("terminal job artifact still exists after deletion")
	}
}
