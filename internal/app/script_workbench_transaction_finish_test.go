package app

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type scriptWorkbenchContextFinisher struct {
	*fakeManagedTransactionFinisher
	commitCtx   context.Context
	rollbackCtx context.Context
}

func (f *scriptWorkbenchContextFinisher) CommitContext(ctx context.Context) error {
	f.commitCtx = ctx
	return f.fakeManagedTransactionFinisher.Commit()
}

func (f *scriptWorkbenchContextFinisher) RollbackContext(ctx context.Context) error {
	f.rollbackCtx = ctx
	return f.fakeManagedTransactionFinisher.Rollback()
}

type scriptWorkbenchContextKey struct{}

func installScriptWorkbenchManagedTransaction(
	application *App,
	transactionID string,
	finisher db.TransactionExecer,
) {
	application.sqlTransactions[transactionID] = &managedSQLTransaction{
		id:         transactionID,
		execer:     finisher.(db.StatementExecer),
		transactor: finisher,
		config:     connection.ConnectionConfig{Type: "postgres"},
		dbType:     "postgres",
	}
}

func TestManagedTransactionFinishPassesCallerContextToDriver(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	finisher := &scriptWorkbenchContextFinisher{
		fakeManagedTransactionFinisher: &fakeManagedTransactionFinisher{},
	}
	installScriptWorkbenchManagedTransaction(application, "tx-context", finisher)
	ctx := context.WithValue(context.Background(), scriptWorkbenchContextKey{}, "caller-context")

	result := application.finishManagedSQLTransactionContext(ctx, "tx-context", true, "manual")
	if !result.Success {
		t.Fatalf("commit result = %+v", result)
	}
	if finisher.commitCtx == nil || finisher.commitCtx.Value(scriptWorkbenchContextKey{}) != "caller-context" {
		t.Fatalf("driver commit context = %#v, want caller context value", finisher.commitCtx)
	}
}

func TestManagedTransactionFinishDoesNotCallDriverAfterCanceledContext(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	finisher := &scriptWorkbenchContextFinisher{
		fakeManagedTransactionFinisher: &fakeManagedTransactionFinisher{},
	}
	installScriptWorkbenchManagedTransaction(application, "tx-canceled", finisher)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	result := application.finishManagedSQLTransactionContext(ctx, "tx-canceled", true, "manual")
	if result.Success {
		t.Fatalf("canceled commit unexpectedly succeeded: %+v", result)
	}
	if finisher.commitCalls != 0 {
		t.Fatalf("canceled commit reached driver %d times", finisher.commitCalls)
	}
}

func TestScriptWorkbenchHostCloseWaitsForStuckLegacyFinalizer(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	finisher := &blockingRollbackFinisher{
		fakeManagedTransactionFinisher: &fakeManagedTransactionFinisher{},
		started:                        make(chan struct{}),
		release:                        make(chan struct{}),
	}
	installScriptWorkbenchManagedTransaction(application, "tx-legacy-blocked", finisher)
	run := &scriptWorkbenchRun{
		id:       "script-run-legacy-blocked",
		ctx:      context.Background(),
		status:   scriptWorkbenchStatusRunning,
		maxCalls: 100,
		done:     make(chan struct{}),
	}
	host := newScriptWorkbenchHost(application, run, &scriptWorkbenchPrepared{})
	host.transactions["script-tx-legacy-blocked"] = &scriptWorkbenchTransaction{
		id:           "script-tx-legacy-blocked",
		underlyingID: "tx-legacy-blocked",
		alias:        "prod",
	}

	closed := make(chan struct{})
	go func() {
		host.Close()
		close(closed)
	}()
	select {
	case <-finisher.started:
	case <-time.After(time.Second):
		t.Fatal("legacy rollback did not start")
	}
	select {
	case <-closed:
		t.Fatal("Host.Close returned before the legacy finalizer completed")
	case <-time.After(100 * time.Millisecond):
	}
	close(finisher.release)
	select {
	case <-closed:
	case <-time.After(2 * time.Second):
		t.Fatal("Host.Close did not return after the finalizer completed")
	}
}

func TestScriptWorkbenchExecuteUsesBoundedResultBudget(t *testing.T) {
	t.Run("db.execute non-param", func(t *testing.T) {
		host, database := prepareScriptWorkbenchBudgetHost(t)
		if _, err := host.Handle(host.ctx, scriptengineHostRequestForTest(
			"db.execute",
			mustScriptWorkbenchJSON(t, map[string]any{
				"alias": "prod",
				"sql":   "UPDATE users SET active = true",
			}),
		)); err != nil {
			t.Fatalf("db.execute: %v", err)
		}
		assertScriptWorkbenchBudget(t, scriptWorkbenchContextForBudget(database))
	})

	t.Run("db.execute parameterized", func(t *testing.T) {
		host, database := prepareScriptWorkbenchBudgetHost(t)
		if _, err := host.Handle(host.ctx, scriptengineHostRequestForTest(
			"db.execute",
			mustScriptWorkbenchJSON(t, map[string]any{
				"alias":  "prod",
				"sql":    "UPDATE users SET active = :active",
				"params": map[string]any{"active": true},
			}),
		)); err != nil {
			t.Fatalf("parameterized db.execute: %v", err)
		}
		assertScriptWorkbenchBudget(t, scriptWorkbenchContextForBudget(database))
	})
}

func TestScriptWorkbenchTransactionExecuteUsesBoundedResultBudget(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
	})
	database := &scriptWorkbenchTransactionDB{}
	installScriptWorkbenchDatabase(t, database)
	host, _ := prepareScriptWorkbenchHostForTest(t, application, saved.ID, true)

	value, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.begin",
		mustScriptWorkbenchJSON(t, map[string]any{"alias": "prod"}),
	))
	if err != nil {
		t.Fatalf("tx.begin: %v", err)
	}
	transactionID := value.(map[string]any)["transactionId"].(string)
	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.execute",
		mustScriptWorkbenchJSON(t, map[string]any{
			"transactionId": transactionID,
			"sql":           "UPDATE users SET active = true",
		}),
	)); err != nil {
		t.Fatalf("first tx.execute: %v", err)
	}
	assertScriptWorkbenchBudget(t, database.session.lastCtx)

	if _, err := host.Handle(context.Background(), scriptengineHostRequestForTest(
		"tx.execute",
		mustScriptWorkbenchJSON(t, map[string]any{
			"transactionId": transactionID,
			"sql":           "UPDATE users SET active = :active",
			"params":        map[string]any{"active": true},
		}),
	)); err != nil {
		t.Fatalf("follow-up tx.execute: %v", err)
	}
	assertScriptWorkbenchBudget(t, database.session.lastCtx)
}

func TestScriptWorkbenchTransactionTimeoutReportsOutcomeUnknown(t *testing.T) {
	application := newScriptWorkbenchTestApp(t, false)
	finisher := &blockingRollbackFinisher{
		fakeManagedTransactionFinisher: &fakeManagedTransactionFinisher{},
		started:                        make(chan struct{}),
		release:                        make(chan struct{}),
	}
	installScriptWorkbenchManagedTransaction(application, "tx-timeout-unknown", finisher)
	run := &scriptWorkbenchRun{
		id:       "script-run-timeout-unknown",
		ctx:      context.Background(),
		status:   scriptWorkbenchStatusRunning,
		maxCalls: 100,
		done:     make(chan struct{}),
	}
	host := newScriptWorkbenchHost(application, run, &scriptWorkbenchPrepared{})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	err := host.finishUnderlyingTransaction(ctx, "tx-timeout-unknown", false, "auto")
	if err == nil || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout error = %v", err)
	}
	run.mu.RLock()
	runErr := run.err
	run.mu.RUnlock()
	if runErr == "" || !strings.Contains(runErr, "outcome is unknown") {
		t.Fatalf("run error = %q", runErr)
	}
	select {
	case <-finisher.started:
	case <-time.After(time.Second):
		t.Fatal("timed-out rollback did not start")
	}
	close(finisher.release)
}

func prepareScriptWorkbenchBudgetHost(t *testing.T) (*scriptWorkbenchHost, *scriptWorkbenchQueryDB) {
	t.Helper()
	application := newScriptWorkbenchTestApp(t, false)
	saved := saveScriptWorkbenchConnection(t, application, connection.ConnectionConfig{
		Type:     "postgres",
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "tester",
		Database: "main",
	})
	database := &scriptWorkbenchQueryDB{}
	installScriptWorkbenchDatabase(t, database)
	host, _ := prepareScriptWorkbenchHostForTest(t, application, saved.ID, true)
	return host, database
}

func assertScriptWorkbenchBudget(t *testing.T, ctx context.Context) {
	t.Helper()
	budget := db.RowBudgetFromContext(ctx)
	if budget == nil {
		t.Fatalf("execute context has no result budget: %#v", ctx)
	}
	if budget.MaxRowsPerResult() != 1 || budget.MaxTotalRows() != 1 ||
		budget.MaxTotalBytes() != 1<<20 || budget.MaxFieldBytes() != 256<<10 {
		t.Fatalf("execute budget = %+v", budget.Options())
	}
}

func scriptWorkbenchContextForBudget(database *scriptWorkbenchQueryDB) context.Context {
	if database == nil {
		return nil
	}
	if database.lastExecCtx != nil {
		return database.lastExecCtx
	}
	return database.fakeBatchWriteDB.lastCtx
}
