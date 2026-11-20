package app

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/scriptengine"
)

func TestScriptWorkbenchTransactionBeginRejectsUnsupportedDataSource(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "hive",
		Host:     "127.0.0.1",
		Port:     10000,
		User:     "tester",
		Database: "default",
	})
	host, _ := prepareScriptWorkbenchHostForTest(t, application, saved.ID, true)

	_, err := host.beginTransaction("prod", "")
	if err == nil || !strings.Contains(err.Error(), "does not support managed transactions") {
		t.Fatalf("tx.begin unsupported error = %v", err)
	}
}

func TestScriptWorkbenchTransactionRejectsDDLBeforeStartingDatabaseTransaction(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
	})
	database := &fakeTransactionalDB{}
	installScriptWorkbenchDatabase(t, database)
	host, _ := prepareScriptWorkbenchHostForTest(t, application, saved.ID, true)

	transactionID := beginTransactionForTest(t, host)
	_, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.execute",
		mustScriptWorkbenchJSON(t, map[string]any{
			"transactionId": transactionID,
			"sql":           "CREATE TABLE script_ddl_guard(id integer)",
		}),
	))
	if err == nil || !strings.Contains(err.Error(), "DDL") {
		t.Fatalf("tx.execute DDL error = %v", err)
	}
	if database.txSession != nil {
		t.Fatalf("DDL opened a database transaction before rejection: %+v", database.txSession)
	}
}

func TestScriptWorkbenchTransactionFirstStatementFailureCannotCommit(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
	})
	statement := "UPDATE users SET active = true WHERE id = 1"
	database := &fakeTransactionalDB{fakeBatchWriteDB: fakeBatchWriteDB{
		execErr: map[string]error{statement: errors.New("statement rejected")},
	}}
	installScriptWorkbenchDatabase(t, database)
	host, _ := prepareScriptWorkbenchHostForTest(t, application, saved.ID, true)

	transactionID := beginTransactionForTest(t, host)
	_, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.execute",
		mustScriptWorkbenchJSON(t, map[string]any{
			"transactionId": transactionID,
			"sql":           statement,
		}),
	))
	if err == nil || !strings.Contains(err.Error(), "statement rejected") {
		t.Fatalf("tx.execute failure = %v", err)
	}
	if database.txSession == nil || database.txSession.rollbackCalls != 1 {
		t.Fatalf("failed first statement was not rolled back: %+v", database.txSession)
	}
	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.commit",
		mustScriptWorkbenchJSON(t, map[string]any{"transactionId": transactionID}),
	)); err == nil {
		t.Fatal("commit after the first statement failed must be rejected")
	}
	if database.txSession.commitCalls != 0 {
		t.Fatalf("failed transaction commit calls = %d", database.txSession.commitCalls)
	}
}

func TestScriptWorkbenchTransactionFollowUpFailurePoisonsAndRollsBack(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
	})
	first := "UPDATE users SET active = true WHERE id = 1"
	failing := "UPDATE users SET active = false WHERE id = 2"
	database := &fakeTransactionalDB{fakeBatchWriteDB: fakeBatchWriteDB{
		execErr: map[string]error{failing: errors.New("constraint violated")},
	}}
	installScriptWorkbenchDatabase(t, database)
	host, _ := prepareScriptWorkbenchHostForTest(t, application, saved.ID, true)

	transactionID := beginTransactionForTest(t, host)
	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.execute",
		mustScriptWorkbenchJSON(t, map[string]any{
			"transactionId": transactionID,
			"sql":           first,
		}),
	)); err != nil {
		t.Fatalf("first tx.execute: %v", err)
	}
	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.execute",
		mustScriptWorkbenchJSON(t, map[string]any{
			"transactionId": transactionID,
			"sql":           failing,
		}),
	)); err == nil {
		t.Fatal("follow-up failure was not returned")
	}
	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.execute",
		mustScriptWorkbenchJSON(t, map[string]any{
			"transactionId": transactionID,
			"sql":           "UPDATE users SET active = true WHERE id = 3",
		}),
	)); err == nil || !strings.Contains(err.Error(), "unusable") {
		t.Fatalf("poisoned transaction accepted another statement: %v", err)
	}
	_, commitErr := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.commit",
		mustScriptWorkbenchJSON(t, map[string]any{"transactionId": transactionID}),
	))
	if commitErr == nil || !strings.Contains(commitErr.Error(), "rolled back instead") {
		t.Fatalf("poisoned commit error = %v", commitErr)
	}
	if database.txSession == nil || database.txSession.commitCalls != 0 || database.txSession.rollbackCalls != 1 {
		t.Fatalf("poisoned transaction finish = %+v", database.txSession)
	}
	if !database.txSession.closed {
		t.Fatal("poisoned transaction session was not closed")
	}
}

func TestScriptWorkbenchTransactionReadFailurePoisonsAndRollsBack(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
	})
	query := "SELECT id FROM users WHERE id = 1"
	database := &fakeTransactionalDB{fakeBatchWriteDB: fakeBatchWriteDB{
		queryErr: map[string]error{query: errors.New("read failed")},
	}}
	installScriptWorkbenchDatabase(t, database)
	host, _ := prepareScriptWorkbenchHostForTest(t, application, saved.ID, true)

	transactionID := beginTransactionForTest(t, host)
	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.execute",
		mustScriptWorkbenchJSON(t, map[string]any{
			"transactionId": transactionID,
			"sql":           "UPDATE users SET active = true WHERE id = 1",
		}),
	)); err != nil {
		t.Fatalf("first tx.execute: %v", err)
	}
	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.query",
		mustScriptWorkbenchJSON(t, map[string]any{
			"transactionId": transactionID,
			"sql":           query,
		}),
	)); err == nil {
		t.Fatal("failed transaction read was not returned")
	}
	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.commit",
		mustScriptWorkbenchJSON(t, map[string]any{"transactionId": transactionID}),
	)); err == nil || !strings.Contains(err.Error(), "rolled back instead") {
		t.Fatalf("commit after read failure error = %v", err)
	}
	if database.txSession == nil || database.txSession.commitCalls != 0 || database.txSession.rollbackCalls != 1 {
		t.Fatalf("read-failed transaction finish = %+v", database.txSession)
	}
}

func TestScriptWorkbenchTransactionWithoutUnderlyingHandleDoesNotFakeFinish(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
	})
	host, _ := prepareScriptWorkbenchHostForTest(t, application, saved.ID, true)

	for _, method := range []string{"tx.commit", "tx.rollback"} {
		transactionID := beginTransactionForTest(t, host)
		_, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
			method,
			mustScriptWorkbenchJSON(t, map[string]any{"transactionId": transactionID}),
		))
		if err == nil || !strings.Contains(err.Error(), "was not started") {
			t.Fatalf("%s without underlying transaction error = %v", method, err)
		}
	}
}

func beginTransactionForTest(t *testing.T, host *scriptWorkbenchHost) string {
	t.Helper()
	value, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.begin",
		mustScriptWorkbenchJSON(t, map[string]any{"alias": "prod"}),
	))
	if err != nil {
		t.Fatalf("tx.begin: %v", err)
	}
	return value.(map[string]any)["transactionId"].(string)
}

type blockingRollbackFinisher struct {
	*fakeManagedTransactionFinisher
	started chan struct{}
	release chan struct{}
}

func (f *blockingRollbackFinisher) Rollback() error {
	close(f.started)
	<-f.release
	f.fakeManagedTransactionFinisher.rollbackCalls++
	return nil
}

func TestScriptWorkbenchTransactionFinishHonorsDeadline(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	finisher := &blockingRollbackFinisher{
		fakeManagedTransactionFinisher: &fakeManagedTransactionFinisher{},
		started:                        make(chan struct{}),
		release:                        make(chan struct{}),
	}
	t.Cleanup(func() { close(finisher.release) })
	application.sqlTransactions["tx-blocked"] = &managedSQLTransaction{
		id:         "tx-blocked",
		execer:     finisher,
		transactor: finisher,
		config:     connection.ConnectionConfig{Type: "postgres"},
		dbType:     "postgres",
	}
	run := &scriptWorkbenchRun{
		id:       "script-run-timeout",
		ctx:      context.Background(),
		maxCalls: 100,
		done:     make(chan struct{}),
	}
	host := newScriptWorkbenchHost(application, run, &scriptWorkbenchPrepared{})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	startedAt := time.Now()
	err := host.finishUnderlyingTransaction(ctx, "tx-blocked", false, "auto")
	if err == nil || !strings.Contains(err.Error(), "deadline") {
		t.Fatalf("blocked transaction finish error = %v", err)
	}
	select {
	case <-finisher.started:
	case <-time.After(time.Second):
		t.Fatal("rollback did not start")
	}
	if elapsed := time.Since(startedAt); elapsed > time.Second {
		t.Fatalf("finish deadline took %s", elapsed)
	}
}

func TestScriptWorkbenchHostCloseSurfacesAutomaticRollbackFailure(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	finisher := &fakeManagedTransactionFinisher{rollbackErr: errors.New("rollback refused")}
	application.sqlTransactions["tx-rollback-failure"] = &managedSQLTransaction{
		id:         "tx-rollback-failure",
		execer:     finisher,
		transactor: finisher,
		config:     connection.ConnectionConfig{Type: "postgres"},
		dbType:     "postgres",
	}
	run := &scriptWorkbenchRun{
		id:       "script-run-cleanup",
		ctx:      context.Background(),
		status:   scriptWorkbenchStatusRunning,
		maxCalls: 100,
		done:     make(chan struct{}),
	}
	host := newScriptWorkbenchHost(application, run, &scriptWorkbenchPrepared{})
	host.transactions["script-tx-cleanup"] = &scriptWorkbenchTransaction{
		id:           "script-tx-cleanup",
		underlyingID: "tx-rollback-failure",
		alias:        "prod",
	}

	host.Close()

	run.mu.RLock()
	runErr := run.err
	logs := append([]ScriptWorkbenchLogEntry(nil), run.logs...)
	run.mu.RUnlock()
	if !strings.Contains(runErr, "script transaction cleanup failed") ||
		!strings.Contains(runErr, "rollback refused") {
		t.Fatalf("cleanup failure not recorded on run: %q", runErr)
	}
	if len(logs) == 0 || logs[len(logs)-1].Level != "error" {
		t.Fatalf("cleanup failure log = %+v", logs)
	}
}

func TestScriptWorkbenchFinishDowngradesSuccessWhenCleanupFails(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	finisher := &fakeManagedTransactionFinisher{rollbackErr: errors.New("rollback refused")}
	if application.sqlTransactions == nil {
		application.sqlTransactions = make(map[string]*managedSQLTransaction)
	}
	application.sqlTransactions["tx-finish-cleanup"] = &managedSQLTransaction{
		id:         "tx-finish-cleanup",
		execer:     finisher,
		transactor: finisher,
		config:     connection.ConnectionConfig{Type: "postgres"},
		dbType:     "postgres",
	}
	run := &scriptWorkbenchRun{
		id:       "script-run-finish-cleanup",
		status:   scriptWorkbenchStatusRunning,
		ctx:      context.Background(),
		maxCalls: 100,
		done:     make(chan struct{}),
	}
	host := newScriptWorkbenchHost(application, run, &scriptWorkbenchPrepared{})
	host.transactions["script-tx-finish-cleanup"] = &scriptWorkbenchTransaction{
		id:           "script-tx-finish-cleanup",
		underlyingID: "tx-finish-cleanup",
		alias:        "prod",
	}
	run.host = host
	runtime := &scriptWorkbenchRuntime{runs: map[string]*scriptWorkbenchRun{run.id: run}}

	runtime.finish(run, scriptWorkbenchStatusSucceeded, nil)
	snapshot := run.snapshot()
	if snapshot.Status != scriptWorkbenchStatusFailed ||
		!strings.Contains(snapshot.Error, "rollback refused") ||
		snapshot.ErrorKind != "backend" {
		t.Fatalf("cleanup snapshot = %+v", snapshot)
	}
}

var _ scriptengine.Host = (*scriptWorkbenchHost)(nil)
