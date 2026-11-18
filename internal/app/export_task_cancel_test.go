package app

import (
	"bufio"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestExportTaskCancelFlowRegistersCancelsAndCleansUp(t *testing.T) {
	app := NewApp()
	exportCtx, finish := app.beginCancelableExportTask("job-cancel-flow")
	defer finish()

	if response := app.CancelExportFile("job-cancel-flow"); !response.Success {
		t.Fatalf("CancelExportFile returned %+v, want success", response)
	}
	if err := exportCtx.Err(); !errors.Is(err, context.Canceled) {
		t.Fatalf("task ctx err = %v, want context.Canceled", err)
	}
	if response := app.CancelExportFile("job-cancel-flow"); !response.Success {
		t.Fatalf("repeated CancelExportFile returned %+v, want idempotent success", response)
	}

	finish()
	if response := app.CancelExportFile("job-cancel-flow"); response.Success {
		t.Fatalf("CancelExportFile after finish returned %+v, want task not found", response)
	}
}

func TestRegisterExportTaskCancelsReplacedTask(t *testing.T) {
	app := NewApp()
	ctx1, finish1 := app.beginCancelableExportTask("same-job")
	defer finish1()
	ctx2, finish2 := app.beginCancelableExportTask("same-job")
	defer finish2()

	if ctx1.Err() == nil {
		t.Fatal("replaced export task should be canceled")
	}
	if ctx2.Err() != nil {
		t.Fatalf("new export task should stay active: %v", ctx2.Err())
	}
}

func TestBeginCancelableExportTaskWithoutJobIDIsNotCancelable(t *testing.T) {
	app := NewApp()
	exportCtx, finish := app.beginCancelableExportTask("   ")
	defer finish()

	if exportCtx != context.Background() {
		t.Fatalf("empty jobID should fall back to Background ctx, got %v", exportCtx)
	}
	if response := app.CancelExportFile(""); response.Success {
		t.Fatalf("CancelExportFile with empty jobID returned %+v, want failure", response)
	}
}

func TestFinishExportTaskWithoutCancelDoesNotLeakRegistration(t *testing.T) {
	app := NewApp()
	_, finish := app.beginCancelableExportTask("job-normal-finish")
	finish()
	finish()

	if response := app.CancelExportFile("job-normal-finish"); response.Success {
		t.Fatalf("CancelExportFile after normal finish returned %+v, want task not found", response)
	}
}

func TestCancelExportStopsStreamingAndAbortsPartialTarget(t *testing.T) {
	app := NewApp()
	dir := t.TempDir()
	targetPath := filepath.Join(dir, "out.csv")

	f, atomicTarget, err := openCancelableExportTarget(nil, targetPath)
	if err != nil {
		t.Fatalf("open target failed: %v", err)
	}
	if atomicTarget == nil {
		t.Fatal("desktop target should be atomic")
	}
	defer atomicTarget.abort()

	streamDB := &fakeStreamExportDB{streamBlock: true, streamStarted: make(chan context.Context, 1)}
	exportCtx, finish := app.beginCancelableExportTask("job-cancel-stream")
	defer finish()

	errCh := make(chan error, 1)
	go func() {
		_, _, streamErr := exportQueryResultToFileWithContext(
			exportCtx,
			f,
			streamDB,
			connection.ConnectionConfig{Timeout: 10},
			"SELECT 1",
			ExportFileOptions{Format: "csv"},
			nil,
		)
		errCh <- streamErr
	}()

	select {
	case <-streamDB.streamStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not start")
	}
	if response := app.CancelExportFile("job-cancel-stream"); !response.Success {
		t.Fatalf("CancelExportFile returned %+v, want success", response)
	}
	select {
	case streamErr := <-errCh:
		if !errors.Is(streamErr, context.Canceled) {
			t.Fatalf("stream error = %v, want context.Canceled", streamErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stream did not observe cancellation")
	}
	atomicTarget.abort()

	if _, err := os.Stat(targetPath); !os.IsNotExist(err) {
		t.Fatalf("canceled export published target file: %v", err)
	}
	if leftovers := listGonaviPartFiles(t, dir); len(leftovers) > 0 {
		t.Fatalf("partial temp files remained after cancel: %v", leftovers)
	}
}

func TestCancelExportBetweenWriteAndCommitDoesNotPublishTarget(t *testing.T) {
	app := NewApp()
	dir := t.TempDir()
	targetPath := filepath.Join(dir, "out.csv")

	f, atomicTarget, err := openCancelableExportTarget(nil, targetPath)
	if err != nil {
		t.Fatalf("open target failed: %v", err)
	}
	defer atomicTarget.abort()
	if _, err := f.Write([]byte("partial,data\n")); err != nil {
		t.Fatalf("write partial data failed: %v", err)
	}

	exportCtx, finish := app.beginCancelableExportTask("job-cancel-commit")
	defer finish()
	if response := app.CancelExportFile("job-cancel-commit"); !response.Success {
		t.Fatalf("CancelExportFile returned %+v, want success", response)
	}

	if commitErr := finishCancelableExportTarget(exportCtx, atomicTarget, f); !errors.Is(commitErr, context.Canceled) {
		t.Fatalf("finish after cancel = %v, want context.Canceled", commitErr)
	}
	atomicTarget.abort()

	if _, err := os.Stat(targetPath); !os.IsNotExist(err) {
		t.Fatalf("canceled export published target file: %v", err)
	}
	if leftovers := listGonaviPartFiles(t, dir); len(leftovers) > 0 {
		t.Fatalf("partial temp files remained after cancel: %v", leftovers)
	}
}

func TestCancelExportSQLDumpAbortsPartialTarget(t *testing.T) {
	app := NewApp()
	dir := t.TempDir()
	targetPath := filepath.Join(dir, "dump.sql")

	atomicTarget, err := createAtomicExportTarget(targetPath)
	if err != nil {
		t.Fatalf("create atomic target failed: %v", err)
	}
	defer atomicTarget.abort()

	streamDB := &fakeStreamExportDB{streamBlock: true, streamStarted: make(chan context.Context, 1)}
	exportCtx, finish := app.beginCancelableExportTask("job-cancel-sql-dump")
	defer finish()

	w := bufio.NewWriterSize(atomicTarget.file, 4096)
	dumpErrCh := make(chan error, 1)
	go func() {
		dumpErrCh <- dumpTableSQL(
			exportCtx,
			w,
			streamDB,
			connection.ConnectionConfig{Type: "mysql", Timeout: 10},
			"app",
			"users",
			false,
			true,
			map[string]string{},
		)
	}()

	select {
	case <-streamDB.streamStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("SQL dump stream did not start")
	}
	if response := app.CancelExportFile("job-cancel-sql-dump"); !response.Success {
		t.Fatalf("CancelExportFile returned %+v, want success", response)
	}
	select {
	case dumpErr := <-dumpErrCh:
		if !errors.Is(dumpErr, context.Canceled) {
			t.Fatalf("dumpTableSQL error = %v, want context.Canceled", dumpErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("SQL dump did not observe cancellation")
	}
	if commitErr := commitCancelableExportTarget(exportCtx, atomicTarget); !errors.Is(commitErr, context.Canceled) {
		t.Fatalf("commit after cancel = %v, want context.Canceled", commitErr)
	}
	atomicTarget.abort()

	if _, err := os.Stat(targetPath); !os.IsNotExist(err) {
		t.Fatalf("canceled SQL export published target file: %v", err)
	}
	if leftovers := listGonaviPartFiles(t, dir); len(leftovers) > 0 {
		t.Fatalf("partial temp files remained after cancel: %v", leftovers)
	}
}

func TestWriteRowsToFileWithReporterStopsOnCanceledContext(t *testing.T) {
	exportCtx, cancel := context.WithCancel(context.Background())
	cancel()

	written, err := writeRowsToFileWithReporter(
		exportCtx,
		&strings.Builder{},
		[]map[string]interface{}{{"id": 1}, {"id": 2}},
		[]string{"id"},
		ExportFileOptions{Format: "csv"},
		nil,
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("writeRowsToFileWithReporter error = %v, want context.Canceled", err)
	}
	if written != 0 {
		t.Fatalf("canceled write consumed %d rows, want 0", written)
	}
}

func TestClassifyExportTaskResultMarksOnlyCanceledFailures(t *testing.T) {
	app := NewApp()
	exportCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	success := connection.QueryResult{Success: true}
	if got := app.classifyExportTaskResult(exportCtx, success); !got.Success {
		t.Fatalf("live ctx should keep success result, got %+v", got)
	}
	failure := connection.QueryResult{Success: false, Message: "boom"}
	if got := app.classifyExportTaskResult(exportCtx, failure); got.Message != "boom" {
		t.Fatalf("live ctx should keep failure message, got %+v", got)
	}

	cancel()
	classified := app.classifyExportTaskResult(exportCtx, failure)
	if classified.Success {
		t.Fatalf("canceled failure should stay unsuccessful, got %+v", classified)
	}
	data, ok := classified.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("canceled result data type = %T, want map", classified.Data)
	}
	if canceledFlag, ok := data["canceled"].(bool); !ok || !canceledFlag {
		t.Fatalf("canceled result missing data.canceled flag, got %+v", classified)
	}
}

func listGonaviPartFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir failed: %v", err)
	}
	var leftovers []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".gonavi-export-") {
			leftovers = append(leftovers, entry.Name())
		}
	}
	return leftovers
}
