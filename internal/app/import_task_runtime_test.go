package app

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"GoNavi-Wails/internal/importjob"
)

func TestCancelAndWaitImportTasksKeepsRegistrationUntilCleanup(t *testing.T) {
	app := NewApp()
	ctx, cancel := context.WithCancel(context.Background())
	cleanup, registered := app.registerImportTask("shutdown-import", cancel)
	if !registered {
		t.Fatal("import task registration failed")
	}
	done := make(chan struct{})
	go func() {
		<-ctx.Done()
		cleanup()
		close(done)
	}()

	if !app.cancelAndWaitImportTasks(time.Second) {
		t.Fatal("import task did not unwind before shutdown deadline")
	}
	select {
	case <-done:
	default:
		t.Fatal("shutdown returned before task cleanup")
	}
	app.queryMu.RLock()
	_, retained := app.runningQueries["shutdown-import"]
	app.queryMu.RUnlock()
	if retained {
		t.Fatal("completed import registration leaked")
	}
}

func TestCancelAndWaitImportTasksRejectsRegistrationsAfterShutdownStarts(t *testing.T) {
	app := NewApp()
	if !app.cancelAndWaitImportTasks(0) {
		t.Fatal("empty import runtime did not finish shutdown")
	}
	cleanup, registered := app.registerImportTask("late-shutdown-import", func() {})
	defer cleanup()
	if registered {
		t.Fatal("import task registered after import runtime shutdown started")
	}
}

func TestCancelImportJobBeforeLifecycleBindingPersistsStoppingWhenBound(t *testing.T) {
	app := NewApp()
	app.configDir = t.TempDir()
	var cancelCalls atomic.Int32
	cleanup, registered := app.registerImportTask("late-bound-import", func() {
		cancelCalls.Add(1)
	}, importjob.KindTable)
	if !registered {
		t.Fatal("import task registration failed")
	}
	defer cleanup()

	first := app.CancelImportJob("late-bound-import")
	second := app.CancelImportJob("late-bound-import")
	if !first.Success || !second.Success {
		t.Fatalf("repeated cancellation should be idempotent: first=%#v second=%#v", first, second)
	}
	if got := cancelCalls.Load(); got != 1 {
		t.Fatalf("cancel callback calls = %d, want 1", got)
	}

	lifecycle, err := app.beginManagedImportJob(managedImportJobStart{
		ID:   "late-bound-import",
		Kind: importjob.KindTable,
	})
	if err != nil {
		t.Fatal(err)
	}
	stored, err := lifecycle.store.Get("late-bound-import")
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != importjob.StatusStopping {
		t.Fatalf("status = %q, want %q", stored.Status, importjob.StatusStopping)
	}
	if result := app.CancelImportJob("late-bound-import"); !result.Success {
		t.Fatalf("cancelling an already-stopping import should succeed: %#v", result)
	}
	afterRepeatedCancel, err := lifecycle.store.Get("late-bound-import")
	if err != nil {
		t.Fatal(err)
	}
	if afterRepeatedCancel.Revision != stored.Revision {
		t.Fatalf("repeated cancellation rewrote stopping job: before=%d after=%d", stored.Revision, afterRepeatedCancel.Revision)
	}
	if got := cancelCalls.Load(); got != 1 {
		t.Fatalf("cancel callback calls after lifecycle bind = %d, want 1", got)
	}
}

func TestCancelImportJobDoesNotCancelOrdinaryRunningQuery(t *testing.T) {
	app := NewApp()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cleanup, registered := app.registerExclusiveRunningQuery("ordinary-query", cancel, true)
	if !registered {
		t.Fatal("query registration failed")
	}
	defer cleanup()

	result := app.CancelImportJob("ordinary-query")
	if result.Success {
		t.Fatalf("ordinary query cancellation unexpectedly succeeded: %#v", result)
	}
	select {
	case <-ctx.Done():
		t.Fatal("import cancellation touched an ordinary running query")
	default:
	}
}

func TestCancelImportTaskByKindRejectsDifferentImportKind(t *testing.T) {
	app := NewApp()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cleanup, registered := app.registerImportTask("table-import-kind", cancel, importjob.KindTable)
	if !registered {
		t.Fatal("import task registration failed")
	}
	defer cleanup()

	wrongKind := app.cancelImportTaskByKind("table-import-kind", importjob.KindSQL)
	if wrongKind.Success {
		t.Fatalf("wrong-kind cancellation unexpectedly succeeded: %#v", wrongKind)
	}
	select {
	case <-ctx.Done():
		t.Fatal("wrong-kind cancellation reached the task")
	default:
	}

	matchingKind := app.cancelImportTaskByKind("table-import-kind", importjob.KindTable)
	if !matchingKind.Success {
		t.Fatalf("matching-kind cancellation failed: %#v", matchingKind)
	}
	select {
	case <-ctx.Done():
	default:
		t.Fatal("matching-kind cancellation did not reach the task")
	}
}
