package importjob

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStoreListSkipsCorruptMetadataAndReturnsValidJobs(t *testing.T) {
	root := t.TempDir()
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	valid, err := store.Put(Job{ID: "import-valid", Kind: KindTable, Status: StatusCompleted})
	if err != nil {
		t.Fatal(err)
	}
	corruptContents := `{"id":"private-payload-that-must-not-be-logged"`
	if err := os.WriteFile(filepath.Join(root, "import-corrupt.json"), []byte(corruptContents), 0o600); err != nil {
		t.Fatal(err)
	}

	jobs, err := store.List()
	var warning *CorruptJobFilesWarning
	if !errors.As(err, &warning) {
		t.Fatalf("error = %v, want CorruptJobFilesWarning", err)
	}
	if warning.Count != 1 {
		t.Fatalf("warning count = %d, want 1", warning.Count)
	}
	if len(jobs) != 1 || jobs[0].ID != valid.ID {
		t.Fatalf("jobs = %#v, want only %q", jobs, valid.ID)
	}
	if strings.Contains(err.Error(), root) || strings.Contains(err.Error(), corruptContents) {
		t.Fatalf("warning leaked path or contents: %q", err.Error())
	}
}

func TestStoreRecoverInterruptedSkipsCorruptMetadataAndRecoversValidJobs(t *testing.T) {
	root := t.TempDir()
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	running, err := store.Put(Job{
		ID:                  "import-running-valid",
		Kind:                KindTable,
		Status:              StatusRunning,
		SourcePath:          "D:/imports/users.csv",
		ConnectionID:        "connection-v1",
		SourceIdentityToken: "source-v1",
		TargetFingerprint:   "target-v1",
		OptionsHash:         "options-v1",
		TableImportOptions:  &TableImportOptions{},
		Checkpoint:          Checkpoint{Safe: true, SourceRow: 1000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "import-truncated.json"), []byte(`{"id":`), 0o600); err != nil {
		t.Fatal(err)
	}

	recovered, err := store.RecoverInterrupted()
	var warning *CorruptJobFilesWarning
	if !errors.As(err, &warning) || warning.Count != 1 {
		t.Fatalf("error = %v, want one-file CorruptJobFilesWarning", err)
	}
	if len(recovered) != 1 || recovered[0].ID != running.ID || recovered[0].Status != StatusInterrupted {
		t.Fatalf("recovered = %#v, want interrupted %q", recovered, running.ID)
	}
	persisted, err := store.Get(running.ID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Status != StatusInterrupted || !persisted.Resumable {
		t.Fatalf("valid job was not durably recovered: %#v", persisted)
	}
}

func TestStoreRecoversInterruptedJobOnlyFromSafeCheckpoint(t *testing.T) {
	root := t.TempDir()
	store, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Put(Job{
		ID:                  "import-job-safe",
		Kind:                KindTable,
		Status:              StatusRunning,
		SourcePath:          "D:/imports/users.csv",
		ConnectionID:        "connection-v1",
		SourceIdentityToken: "source-v1",
		TargetFingerprint:   "target-v1",
		OptionsHash:         "options-v1",
		TableImportOptions:  &TableImportOptions{},
		Checkpoint: Checkpoint{
			Safe:       true,
			SourceRow:  2000,
			ByteOffset: 65536,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if job.Revision != 1 {
		t.Fatalf("revision = %d, want 1", job.Revision)
	}

	reopened, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := reopened.RecoverInterrupted()
	if err != nil {
		t.Fatal(err)
	}
	if len(recovered) != 1 || recovered[0].Status != StatusInterrupted || !recovered[0].Resumable {
		t.Fatalf("unexpected recovered jobs: %#v", recovered)
	}
	if recovered[0].Checkpoint.SourceRow != 2000 {
		t.Fatalf("checkpoint was not preserved: %#v", recovered[0].Checkpoint)
	}
}

func TestValidateResumeRejectsChangedInputsAndUnknownOutcome(t *testing.T) {
	base := Job{
		Status:              StatusInterrupted,
		Resumable:           true,
		SourceIdentityToken: "source-v1",
		TargetFingerprint:   "target-v1",
		OptionsHash:         "options-v1",
		Checkpoint:          Checkpoint{Safe: true, SourceRow: 1000},
	}
	if err := ValidateResume(base, "source-v1", "target-v1", "options-v1"); err != nil {
		t.Fatalf("matching inputs should resume: %v", err)
	}
	for name, mutate := range map[string]func(*Job, *string, *string, *string){
		"source changed":    func(_ *Job, source, _, _ *string) { *source = "source-v2" },
		"target changed":    func(_ *Job, _, target, _ *string) { *target = "target-v2" },
		"options changed":   func(_ *Job, _, _, options *string) { *options = "options-v2" },
		"outcome unknown":   func(job *Job, _, _, _ *string) { job.OutcomeUnknown = true },
		"unsafe checkpoint": func(job *Job, _, _, _ *string) { job.Checkpoint.Safe = false },
	} {
		t.Run(name, func(t *testing.T) {
			job := base
			source, target, options := "source-v1", "target-v1", "options-v1"
			mutate(&job, &source, &target, &options)
			if err := ValidateResume(job, source, target, options); !errors.Is(err, ErrResumeUnsafe) {
				t.Fatalf("error = %v, want ErrResumeUnsafe", err)
			}
		})
	}
}

func TestStoreClaimResumeConsumesCheckpointAtomically(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.Put(Job{
		ID:                  "import-resumable",
		Kind:                KindTable,
		Status:              StatusInterrupted,
		SourcePath:          "D:/imports/users.csv",
		ConnectionID:        "connection-v1",
		SourceIdentityToken: "source-v1",
		TargetFingerprint:   "target-v1",
		OptionsHash:         "options-v1",
		TableImportOptions:  &TableImportOptions{},
		Checkpoint:          Checkpoint{Safe: true, SourceRow: 10},
		Resumable:           true,
	})
	if err != nil {
		t.Fatal(err)
	}

	claimed, err := store.ClaimResume(job.ID, "source-v1", "target-v1", "options-v1")
	if err != nil {
		t.Fatal(err)
	}
	if claimed.Resumable {
		t.Fatalf("claimed job stayed resumable: %#v", claimed)
	}
	if _, err := store.ClaimResume(job.ID, "source-v1", "target-v1", "options-v1"); !errors.Is(err, ErrRecoveryUnavailable) {
		t.Fatalf("second claim error = %v, want ErrRecoveryUnavailable", err)
	}
	if err := store.ReleaseResumeClaim(job.ID); err != nil {
		t.Fatal(err)
	}
	restored, err := store.Get(job.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !restored.Resumable {
		t.Fatalf("released job did not restore its safe checkpoint action: %#v", restored)
	}
}

func TestStoreDeleteRemovesOnlyTheRequestedJob(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"import-job-a", "import-job-b"} {
		if _, err := store.Put(Job{ID: id, Kind: KindTable, Status: StatusCompleted}); err != nil {
			t.Fatal(err)
		}
	}

	if err := store.Delete("import-job-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get("import-job-a"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted job error = %v, want ErrNotFound", err)
	}
	if _, err := store.Get("import-job-b"); err != nil {
		t.Fatalf("unrelated job was removed: %v", err)
	}
	if err := store.Delete("../outside"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("invalid id error = %v, want ErrNotFound", err)
	}
}
