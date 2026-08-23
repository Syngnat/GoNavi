package app

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/importjob"
)

func TestManagedImportJobPersistsProgressAndTerminalState(t *testing.T) {
	app := NewApp()
	app.configDir = t.TempDir()

	lifecycle, err := app.beginManagedImportJob(managedImportJobStart{
		ID:                  "import-job-progress",
		Kind:                importjob.KindTable,
		SourcePath:          "D:/imports/users.csv",
		SourceIdentityToken: "source-v1",
		TargetFingerprint:   "target-v1",
		OptionsHash:         "options-v1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.update(managedImportJobProgress{
		Stage:        "writing",
		Current:      1000,
		Total:        5000,
		Succeeded:    998,
		Failed:       2,
		BytesRead:    65536,
		Checkpoint:   importjob.Checkpoint{Safe: true, SourceRow: 1000, ByteOffset: 65536},
		ForcePersist: true,
	}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.finish(managedImportJobFinish{
		Status:          importjob.StatusPartial,
		Message:         "completed with rejected rows",
		ErrorArtifactID: "artifact-v1",
	}); err != nil {
		t.Fatal(err)
	}

	stored, err := lifecycle.store.Get("import-job-progress")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != importjob.StatusPartial || stored.Current != 1000 || stored.Succeeded != 998 || stored.Failed != 2 {
		t.Fatalf("unexpected terminal job: %#v", stored)
	}
	if stored.Checkpoint.SourceRow != 1000 || stored.ErrorArtifactID != "artifact-v1" || stored.Resumable {
		t.Fatalf("unexpected checkpoint/artifact state: %#v", stored)
	}
}

func TestManagedImportJobCancelProgressFinishRaceEndsTerminalWithoutRevisionConflict(t *testing.T) {
	app := NewApp()
	app.configDir = t.TempDir()
	var cancelCalls atomic.Int32
	cleanup, registered := app.registerImportTask("import-job-race", func() {
		cancelCalls.Add(1)
	}, importjob.KindTable)
	if !registered {
		t.Fatal("import task registration failed")
	}
	defer cleanup()
	lifecycle, err := app.beginManagedImportJob(managedImportJobStart{
		ID:   "import-job-race",
		Kind: importjob.KindTable,
	})
	if err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	errs := make(chan error, 64)
	var workers sync.WaitGroup
	workers.Add(3)
	go func() {
		defer workers.Done()
		<-start
		for i := int64(1); i <= 20; i++ {
			if err := lifecycle.update(managedImportJobProgress{
				Stage:        "writing",
				Current:      i,
				Succeeded:    i,
				ForcePersist: true,
			}); err != nil {
				errs <- fmt.Errorf("progress %d: %w", i, err)
				return
			}
		}
	}()
	go func() {
		defer workers.Done()
		<-start
		for i := 0; i < 3; i++ {
			if result := app.CancelImportJob("import-job-race"); !result.Success {
				errs <- fmt.Errorf("cancel %d failed: %s", i, result.Message)
				return
			}
		}
	}()
	go func() {
		defer workers.Done()
		<-start
		if err := lifecycle.finish(managedImportJobFinish{Status: importjob.StatusCancelled}); err != nil {
			errs <- fmt.Errorf("finish: %w", err)
		}
	}()
	close(start)
	workers.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	if t.Failed() {
		return
	}
	if got := cancelCalls.Load(); got != 1 {
		t.Fatalf("cancel callback calls = %d, want 1", got)
	}
	stored, err := lifecycle.store.Get("import-job-race")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != importjob.StatusCancelled {
		t.Fatalf("status = %q, want %q; job=%#v", stored.Status, importjob.StatusCancelled, stored)
	}
}

func TestManagedImportJobRejectsReusedJobID(t *testing.T) {
	app := NewApp()
	app.configDir = t.TempDir()
	start := managedImportJobStart{
		ID:                  "import-job-duplicate",
		Kind:                importjob.KindSQL,
		SourceIdentityToken: "source-v1",
		TargetFingerprint:   "target-v1",
		OptionsHash:         "options-v1",
	}
	if _, err := app.beginManagedImportJob(start); err != nil {
		t.Fatal(err)
	}
	if _, err := app.beginManagedImportJob(start); err == nil {
		t.Fatal("expected duplicate durable job id to be rejected")
	}
}

func TestManagedImportJobKeepsStoppingAndTerminalStatesMonotonic(t *testing.T) {
	app := NewApp()
	app.configDir = t.TempDir()
	lifecycle, err := app.beginManagedImportJob(managedImportJobStart{
		ID:   "import-job-monotonic",
		Kind: importjob.KindTable,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.requestStop(); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.update(managedImportJobProgress{
		Stage:        "writing",
		Current:      20,
		Succeeded:    19,
		Failed:       1,
		ForcePersist: true,
	}); err != nil {
		t.Fatal(err)
	}
	stopping, err := lifecycle.store.Get("import-job-monotonic")
	if err != nil {
		t.Fatal(err)
	}
	if stopping.Status != importjob.StatusStopping {
		t.Fatalf("progress regressed stopping job to %q", stopping.Status)
	}
	if stopping.Current != 20 || stopping.Succeeded != 19 || stopping.Failed != 1 {
		t.Fatalf("stopping progress was not retained: %#v", stopping)
	}

	if err := lifecycle.finish(managedImportJobFinish{Status: importjob.StatusCancelled}); err != nil {
		t.Fatal(err)
	}
	terminal, err := lifecycle.store.Get("import-job-monotonic")
	if err != nil {
		t.Fatal(err)
	}
	if terminal.Status != importjob.StatusCancelled {
		t.Fatalf("status = %q, want %q", terminal.Status, importjob.StatusCancelled)
	}
	if err := lifecycle.update(managedImportJobProgress{
		Stage:        "writing",
		Current:      999,
		Succeeded:    999,
		ForcePersist: true,
	}); err != nil {
		t.Fatal(err)
	}
	afterLateProgress, err := lifecycle.store.Get("import-job-monotonic")
	if err != nil {
		t.Fatal(err)
	}
	if afterLateProgress.Revision != terminal.Revision || afterLateProgress.Current != terminal.Current || afterLateProgress.Status != terminal.Status {
		t.Fatalf("late progress changed terminal job: before=%#v after=%#v", terminal, afterLateProgress)
	}
	if err := lifecycle.finish(managedImportJobFinish{Status: importjob.StatusCompleted}); err != nil {
		t.Fatal(err)
	}
	afterLateFinish, err := lifecycle.store.Get("import-job-monotonic")
	if err != nil {
		t.Fatal(err)
	}
	if afterLateFinish.Revision != terminal.Revision || afterLateFinish.Status != importjob.StatusCancelled {
		t.Fatalf("late finish changed terminal job: before=%#v after=%#v", terminal, afterLateFinish)
	}
}

func TestManagedImportJobDoesNotClearAnUnknownOutcomeWithLaterProgress(t *testing.T) {
	app := NewApp()
	app.configDir = t.TempDir()
	lifecycle, err := app.beginManagedImportJob(managedImportJobStart{
		ID:   "import-job-outcome-monotonic",
		Kind: importjob.KindSQL,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.update(managedImportJobProgress{OutcomeUnknown: true, ForcePersist: true}); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.update(managedImportJobProgress{OutcomeUnknown: false, ForcePersist: true}); err != nil {
		t.Fatal(err)
	}
	stored, err := lifecycle.store.Get("import-job-outcome-monotonic")
	if err != nil {
		t.Fatal(err)
	}
	if !stored.OutcomeUnknown {
		t.Fatalf("late progress cleared an unknown outcome: %#v", stored)
	}
	if err := lifecycle.finish(managedImportJobFinish{Status: importjob.StatusCompleted}); err != nil {
		t.Fatal(err)
	}
	terminal, err := lifecycle.store.Get("import-job-outcome-monotonic")
	if err != nil {
		t.Fatal(err)
	}
	if terminal.Status != importjob.StatusUnknown || !terminal.OutcomeUnknown {
		t.Fatalf("terminal update cleared an unknown outcome: %#v", terminal)
	}
}

func TestManagedImportJobFinishClassifiesCommittedPrefixAsPartial(t *testing.T) {
	tests := []struct {
		name string
		data map[string]interface{}
	}{
		{name: "table parser fails after writes", data: map[string]interface{}{"success": 10, "failed": 0}},
		{name: "SQL preflight rejects after statements", data: map[string]interface{}{
			"executed": 10, "failed": 0, "outcome": "failed", "previousStatementsMayHaveCompleted": true,
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			finish := managedImportJobFinishFromResult(connection.QueryResult{Success: false, Data: test.data})
			if finish.Status != importjob.StatusPartial || finish.OutcomeUnknown {
				t.Fatalf("finish = %#v, want known partial", finish)
			}
		})
	}
}

func TestManagedImportJobFinishClassifiesAmbiguousCancellationAsUnknown(t *testing.T) {
	finish := managedImportJobFinishFromResult(connection.QueryResult{
		Success: false,
		Data: map[string]interface{}{
			"cancelled":      true,
			"outcomeUnknown": true,
		},
	})
	if finish.Status != importjob.StatusUnknown || !finish.OutcomeUnknown {
		t.Fatalf("ambiguous cancellation finish = %#v, want unknown", finish)
	}
}
