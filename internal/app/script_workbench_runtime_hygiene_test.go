package app

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"GoNavi-Wails/internal/connection"
)

type runtimeHygieneBlockingRollback struct {
	*fakeManagedTransactionFinisher
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (f *runtimeHygieneBlockingRollback) Rollback() error {
	close(f.started)
	<-f.release
	return f.fakeManagedTransactionFinisher.Rollback()
}

func (f *runtimeHygieneBlockingRollback) allowRollback() {
	f.once.Do(func() { close(f.release) })
}

func TestScriptWorkbenchFinishKeepsTerminalStatusUntilCleanupCompletes(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	finisher := &runtimeHygieneBlockingRollback{
		fakeManagedTransactionFinisher: &fakeManagedTransactionFinisher{},
		started:                        make(chan struct{}),
		release:                        make(chan struct{}),
	}
	t.Cleanup(finisher.allowRollback)
	if application.sqlTransactions == nil {
		application.sqlTransactions = make(map[string]*managedSQLTransaction)
	}
	application.sqlTransactions["tx-finalizing"] = &managedSQLTransaction{
		id:         "tx-finalizing",
		execer:     finisher,
		transactor: finisher,
		config:     connection.ConnectionConfig{Type: "postgres"},
		dbType:     "postgres",
	}
	run := &scriptWorkbenchRun{
		id:       "script-run-finalizing",
		status:   scriptWorkbenchStatusRunning,
		ctx:      context.Background(),
		maxCalls: 100,
		done:     make(chan struct{}),
	}
	host := newScriptWorkbenchHost(application, run, &scriptWorkbenchPrepared{})
	host.transactions["script-tx-finalizing"] = &scriptWorkbenchTransaction{
		id:           "script-tx-finalizing",
		underlyingID: "tx-finalizing",
		alias:        "prod",
	}
	run.host = host
	runtime := &scriptWorkbenchRuntime{runs: map[string]*scriptWorkbenchRun{run.id: run}}

	go runtime.finish(run, scriptWorkbenchStatusSucceeded, nil)
	select {
	case <-finisher.started:
	case <-time.After(time.Second):
		t.Fatal("cleanup did not start")
	}
	duringCleanup := run.snapshot()
	if duringCleanup.Status != scriptWorkbenchStatusRunning || duringCleanup.Stage != "finalizing" {
		t.Fatalf("status leaked before cleanup: %+v", duringCleanup)
	}
	finisher.allowRollback()
	select {
	case <-run.done:
	case <-time.After(5 * time.Second):
		t.Fatal("run did not finish")
	}
	if final := run.snapshot(); final.Status != scriptWorkbenchStatusSucceeded {
		t.Fatalf("final status = %+v", final)
	}
}

func TestNormalizeScriptInputErrorRedactsWebPaths(t *testing.T) {
	pathErr := &os.PathError{Op: "open", Path: "/private/server/ids.xlsx", Err: os.ErrNotExist}
	webErr := normalizeScriptInputError(pathErr, true, "ids")
	if strings.Contains(webErr.Error(), "/private/server") || !strings.Contains(webErr.Error(), "script input") {
		t.Fatalf("web error = %v", webErr)
	}
	if desktopErr := normalizeScriptInputError(pathErr, false, "ids"); !strings.Contains(desktopErr.Error(), "/private/server") {
		t.Fatalf("desktop error lost detail: %v", desktopErr)
	}
}

func TestScriptWorkbenchFileReaderCleanupErrorIsRecorded(t *testing.T) {
	run := &scriptWorkbenchRun{}
	reader := &scriptWorkbenchFileReader{alias: "ids", run: run}
	reader.reportCleanupError(errors.New("reader did not stop"))
	snapshot := run.snapshot()
	if !strings.Contains(snapshot.Error, "reader did not stop") || snapshot.ErrorKind != "backend" {
		t.Fatalf("cleanup error snapshot = %+v", snapshot)
	}
}

func TestScriptWorkbenchLogSequenceAndUTF8Truncation(t *testing.T) {
	run := &scriptWorkbenchRun{}
	run.appendLog("info", strings.Repeat("a", 8191)+"中")
	run.appendLog("warn", "second")
	snapshot := run.snapshot()
	if len(snapshot.Logs) != 2 || snapshot.Logs[0].Sequence >= snapshot.Logs[1].Sequence {
		t.Fatalf("log sequence = %+v", snapshot.Logs)
	}
	if !utf8.ValidString(snapshot.Logs[0].Message) || len(snapshot.Logs[0].Message) > 8<<10 {
		t.Fatalf("truncated log is not valid UTF-8: %q", snapshot.Logs[0].Message)
	}
}

func TestScriptWorkbenchOutputBudgetMarksNewOutputTruncated(t *testing.T) {
	run := &scriptWorkbenchRun{outputRows: scriptWorkbenchDefaultOutputRows}
	run.appendOutput("new", []map[string]any{{"id": 1}})
	if !run.outputsTruncated || len(run.outputs) != 0 {
		t.Fatalf("output budget state = outputs=%d truncated=%v", len(run.outputs), run.outputsTruncated)
	}
}

func TestScriptWorkbenchRunErrorKindDefaultsToBackend(t *testing.T) {
	if kind := scriptWorkbenchErrorKind(
		scriptWorkbenchStatusFailed,
		false,
		errors.New("script failed"),
	); kind != "backend" {
		t.Fatalf("generic failure kind = %q", kind)
	}
	if kind := scriptWorkbenchErrorKind(
		scriptWorkbenchStatusFailed,
		false,
		errors.New("TypeError: ids is not iterable"),
	); kind != "script" {
		t.Fatalf("JS exception kind = %q", kind)
	}
}
