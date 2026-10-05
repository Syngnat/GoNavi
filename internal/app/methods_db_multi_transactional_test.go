package app

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

func TestDBQueryMultiTransactionalKeepsDMLTransactionOpenUntilCommit(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	firstStmt := "UPDATE users SET name = 'new' WHERE id = 1"
	secondStmt := "DELETE FROM audit_logs WHERE user_id = 1"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			firstStmt:  1,
			secondStmt: 3,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}

	result := app.DBQueryMultiTransactional(config, "main", firstStmt+";\n"+secondStmt+";", "tx-query")
	if !result.Success {
		t.Fatalf("expected transactional query success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil {
		t.Fatal("expected transactional query to open a pinned session")
	}
	if fakeDB.session.closed {
		t.Fatal("expected transaction session to stay open before commit")
	}
	wantExecs := []string{"START TRANSACTION", firstStmt, secondStmt}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected exec queries %#v, got %#v", wantExecs, fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}

	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 2 {
		t.Fatalf("expected one affectedRows result per DML statement, got %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["affectedRows"]; got != int64(1) {
		t.Fatalf("expected first affectedRows=1, got %#v", got)
	}
	if got := resultSets[1].Rows[0]["affectedRows"]; got != int64(3) {
		t.Fatalf("expected second affectedRows=3, got %#v", got)
	}

	commitResult := app.DBCommitTransaction(result.TransactionID)
	if !commitResult.Success {
		t.Fatalf("expected commit success, got failure: %s", commitResult.Message)
	}
	if !fakeDB.session.closed {
		t.Fatal("expected transaction session to close after commit")
	}
	if got := fakeDB.execQueries[len(fakeDB.execQueries)-1]; got != "COMMIT" {
		t.Fatalf("expected final exec to be COMMIT, got %q", got)
	}
}

func TestDBQueryMultiTransactionalCancellationRollsBackWithoutLeavingPendingTransaction(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	statement := "UPDATE users SET active = 0 WHERE id = 1"
	execStarted := make(chan string, 2)
	fakeDB := &fakeBatchWriteDB{
		execDelay:   map[string]time.Duration{statement: 10 * time.Second},
		execStarted: execStarted,
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}
	resultCh := make(chan connection.QueryResult, 1)
	go func() {
		resultCh <- app.DBQueryMultiTransactional(config, "main", statement, "tx-close-before-result")
	}()

	for _, expected := range []string{"START TRANSACTION", statement} {
		select {
		case executed := <-execStarted:
			if executed != expected {
				t.Fatalf("executed statement = %q, want %q", executed, expected)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for %q", expected)
		}
	}

	if cancelled := app.CancelQuery("tx-close-before-result"); !cancelled.Success {
		t.Fatalf("CancelQuery failed: %#v", cancelled)
	}
	select {
	case result := <-resultCh:
		if result.Success || result.TransactionID != "" || result.TransactionPending {
			t.Fatalf("cancelled transaction must not become pending: %#v", result)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("managed transaction did not stop after cancellation")
	}

	app.sqlTransactionMu.Lock()
	pendingCount := len(app.sqlTransactions)
	app.sqlTransactionMu.Unlock()
	if pendingCount != 0 {
		t.Fatalf("cancelled transaction left %d pending entries", pendingCount)
	}
	if fakeDB.session == nil || !fakeDB.session.closed {
		t.Fatal("cancelled transaction session was not closed")
	}
	if got := fakeDB.execQueries[len(fakeDB.execQueries)-1]; got != "ROLLBACK" {
		t.Fatalf("final transaction statement = %q, want ROLLBACK", got)
	}
}

func TestDBQueryMultiTransactionalKeepsSQLServerBeginEndBlockOpenUntilRollback(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	block := `BEGIN
    UPDATE users SET name = 'new' WHERE id = 1;
END;`
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{block: 1},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMultiTransactional(config, "testdb", block, "sqlserver-begin-end-tx-query")
	if !result.Success {
		t.Fatalf("expected SQL Server BEGIN...END transaction success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil {
		t.Fatal("expected SQL Server transactional block to open a pinned session")
	}
	if fakeDB.session.closed {
		t.Fatal("expected SQL Server transaction session to stay open before rollback")
	}
	if !reflect.DeepEqual(fakeDB.execQueries, []string{"BEGIN TRANSACTION"}) {
		t.Fatalf("expected SQL Server transaction begin before rollback, got %#v", fakeDB.execQueries)
	}
	if !reflect.DeepEqual(fakeDB.queryQueries, []string{block}) {
		t.Fatalf("expected SQL Server block to execute through the pinned query session, got %#v", fakeDB.queryQueries)
	}

	rollbackResult := app.DBRollbackTransaction(result.TransactionID)
	if !rollbackResult.Success {
		t.Fatalf("expected SQL Server rollback success, got failure: %s", rollbackResult.Message)
	}
	if !fakeDB.session.closed {
		t.Fatal("expected SQL Server transaction session to close after rollback")
	}
	wantExecs := []string{"BEGIN TRANSACTION", "ROLLBACK TRANSACTION"}
	if !reflect.DeepEqual(fakeDB.execQueries, wantExecs) {
		t.Fatalf("expected SQL Server rollback without commit, got %#v", fakeDB.execQueries)
	}
}

func TestDBQueryMultiTransactionalKeepsTrailingCommentInsideManagedTransaction(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	statement := "DELETE FROM users WHERE id = 1"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{statement: 1},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}
	result := app.DBQueryMultiTransactional(
		config,
		"main",
		statement+"; -- keep this operation pending",
		"tx-trailing-comment",
	)

	if !result.Success {
		t.Fatalf("expected transactional query success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected trailing comment to preserve pending transaction, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if strings.Contains(result.Message, "逐条执行") {
		t.Fatalf("expected trailing comment to avoid sequential fallback message, got %q", result.Message)
	}
	wantExecs := []string{"START TRANSACTION", statement}
	if !reflect.DeepEqual(fakeDB.execQueries, wantExecs) {
		t.Fatalf("expected exec queries %#v, got %#v", wantExecs, fakeDB.execQueries)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok || len(resultSets) != 1 {
		t.Fatalf("expected one DML result set, got %T %#v", result.Data, result.Data)
	}

	rollbackResult := app.DBRollbackTransaction(result.TransactionID)
	if !rollbackResult.Success {
		t.Fatalf("expected rollback success, got failure: %s", rollbackResult.Message)
	}
}

func TestDBQueryMultiInTransactionReusesPendingManagedSessionForReadQueries(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	updateStmt := "UPDATE users SET name = 'new' WHERE id = 1"
	readStmt := "SELECT name FROM users WHERE id = 1"
	fakeDB := &fakeTransactionalDB{
		fakeBatchWriteDB: fakeBatchWriteDB{
			execAffected: map[string]int64{
				updateStmt: 1,
			},
			queryMap: map[string][]map[string]interface{}{
				readStmt: {
					{"name": "new"},
				},
			},
			fieldMap: map[string][]string{
				readStmt: {"name"},
			},
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}

	startResult := app.DBQueryMultiTransactional(config, "main", updateStmt, "tx-query")
	if !startResult.Success {
		t.Fatalf("expected transactional update success, got failure: %s", startResult.Message)
	}
	if startResult.TransactionID == "" || !startResult.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", startResult.TransactionID, startResult.TransactionPending)
	}
	if fakeDB.txSession == nil {
		t.Fatal("expected transaction provider session to be opened")
	}
	if fakeDB.txSession.closed {
		t.Fatal("expected transaction session to stay open before follow-up read")
	}

	readResult := app.DBQueryMultiInTransaction(startResult.TransactionID, readStmt, "tx-query-read")
	if !readResult.Success {
		t.Fatalf("expected in-transaction read success, got failure: %s", readResult.Message)
	}
	if readResult.TransactionID != startResult.TransactionID || !readResult.TransactionPending {
		t.Fatalf("expected follow-up read to preserve pending transaction metadata, got id=%q pending=%v", readResult.TransactionID, readResult.TransactionPending)
	}
	if fakeDB.txSession.queryCalls == 0 {
		t.Fatal("expected follow-up read to execute on the pinned transaction session")
	}
	if fakeDB.txSession.closed {
		t.Fatal("expected transaction session to remain open after follow-up read")
	}

	resultSets, ok := readResult.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData from in-transaction read, got %T", readResult.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one read result set, got %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["name"]; got != "new" {
		t.Fatalf("expected in-transaction read to return updated value, got %#v", got)
	}

	rollbackResult := app.DBRollbackTransaction(startResult.TransactionID)
	if !rollbackResult.Success {
		t.Fatalf("expected rollback success after follow-up read, got failure: %s", rollbackResult.Message)
	}
	if !fakeDB.txSession.closed {
		t.Fatal("expected transaction session to close after rollback")
	}
}

func TestDBQueryMultiTransactionalUsesImplicitSessionTransactionForOracle(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	firstStmt := "UPDATE users SET name = 'new' WHERE id = 1"
	secondStmt := "DELETE FROM audit_logs WHERE user_id = 1"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			firstStmt:  1,
			secondStmt: 3,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "oracle", Host: "127.0.0.1", Port: 1521, User: "app"}

	result := app.DBQueryMultiTransactional(config, "ORCLPDB1", firstStmt+";\n"+secondStmt+";", "oracle-tx-query")
	if !result.Success {
		t.Fatalf("expected Oracle transactional query success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil {
		t.Fatal("expected Oracle transactional query to open a pinned session")
	}
	if fakeDB.session.closed {
		t.Fatal("expected Oracle transaction session to stay open before commit")
	}
	wantExecs := []string{firstStmt, secondStmt}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected implicit transaction exec queries %#v, got %#v", wantExecs, fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}

	commitResult := app.DBCommitTransaction(result.TransactionID)
	if !commitResult.Success {
		t.Fatalf("expected Oracle commit success, got failure: %s", commitResult.Message)
	}
	if !fakeDB.session.closed {
		t.Fatal("expected Oracle transaction session to close after commit")
	}
	wantExecs = append(wantExecs, "COMMIT")
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected Oracle implicit transaction COMMIT on pinned session, got %#v", fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
}

func TestDBQueryMultiTransactionalTreatsWithDMLAsManagedWrite(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	stmt := "WITH target AS (SELECT id FROM users WHERE active = 1) UPDATE users SET synced = 1 WHERE id IN (SELECT id FROM target)"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			stmt: 2,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, User: "postgres"}

	result := app.DBQueryMultiTransactional(config, "main", stmt, "with-dml-query")
	if !result.Success {
		t.Fatalf("expected transactional WITH DML success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil || fakeDB.session.closed {
		t.Fatal("expected WITH DML transaction session to stay open")
	}
	wantExecs := []string{"BEGIN", stmt}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected exec queries %#v, got %#v", wantExecs, fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
}

func TestDBQueryMultiTransactionalTreatsDataChangingCTEAsManagedWrite(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	stmt := "WITH moved AS (DELETE FROM audit_logs WHERE created_at < NOW() RETURNING id) SELECT * FROM moved"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			stmt: {{"id": 41}, {"id": 42}},
		},
		fieldMap: map[string][]string{
			stmt: {"id"},
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, User: "postgres"}

	result := app.DBQueryMultiTransactional(config, "main", stmt, "cte-write-query")
	if !result.Success {
		t.Fatalf("expected transactional data-changing CTE success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil || fakeDB.session.closed {
		t.Fatal("expected data-changing CTE transaction session to stay open")
	}
	wantExecs := []string{"BEGIN"}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected exec queries %#v, got %#v", wantExecs, fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
	if fakeDB.session.queryCalls == 0 {
		t.Fatal("expected data-changing CTE SELECT to query returned rows inside the transaction")
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 || len(resultSets[0].Rows) != 2 {
		t.Fatalf("expected returned rows from data-changing CTE, got %#v", resultSets)
	}
}

func TestDBQueryMultiTransactionalRollsBackAndClosesOnDMLFailure(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	firstStmt := "UPDATE users SET name = 'new' WHERE id = 1"
	secondStmt := "DELETE FROM audit_logs WHERE user_id = 1"
	fakeDB := &fakeBatchWriteDB{
		execErr: map[string]error{
			secondStmt: errors.New("delete failed"),
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}

	result := app.DBQueryMultiTransactional(config, "main", firstStmt+";\n"+secondStmt+";", "tx-query")
	if result.Success {
		t.Fatal("expected transactional query failure")
	}
	if result.TransactionID != "" || result.TransactionPending {
		t.Fatalf("expected failed transaction not to be exposed, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil || !fakeDB.session.closed {
		t.Fatal("expected failed transaction session to close")
	}
	wantExecs := []string{"START TRANSACTION", firstStmt, secondStmt, "ROLLBACK"}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected exec queries %#v, got %#v", wantExecs, fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
}

func TestDBQueryMultiTransactionalSkipsManagedTransactionForReadOnlySQL(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT 1 AS value"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {{"value": 1}},
		},
		fieldMap: map[string][]string{
			query: {"value"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}

	result := app.DBQueryMultiTransactional(config, "main", query, "read-query")
	if !result.Success {
		t.Fatalf("expected read-only query success, got failure: %s", result.Message)
	}
	if result.TransactionID != "" || result.TransactionPending {
		t.Fatalf("expected read-only query not to start managed transaction, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if len(fakeDB.execQueries) != 0 {
		t.Fatalf("expected no transaction wrapper execs for read-only query, got %#v", fakeDB.execQueries)
	}
}

func TestDBQueryMultiTransactionalSkipsManagedTransactionForExplicitTransactionSQL(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	stmt := "UPDATE users SET name = 'new' WHERE id = 1"
	fakeDB := &fakeBatchWriteDB{}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, User: "root"}

	result := app.DBQueryMultiTransactional(config, "main", "BEGIN;\n"+stmt+";\nCOMMIT;", "explicit-tx-query")
	if !result.Success {
		t.Fatalf("expected explicit transaction SQL success, got failure: %s", result.Message)
	}
	if result.TransactionID != "" || result.TransactionPending {
		t.Fatalf("expected explicit transaction SQL not to be managed, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if len(fakeDB.execQueries) != 3 {
		t.Fatalf("expected explicit transaction statements only, got %#v", fakeDB.execQueries)
	}
	if fakeDB.execQueries[0] != "BEGIN" || fakeDB.execQueries[1] != stmt || fakeDB.execQueries[2] != "COMMIT" {
		t.Fatalf("expected explicit transaction statements unchanged, got %#v", fakeDB.execQueries)
	}
	if fakeDB.session == nil || !fakeDB.session.closed {
		t.Fatal("expected normal DBQueryMulti session to close after explicit transaction SQL")
	}
}

func TestDBQueryMultiTransactionalTreatsSelectIntoAsManagedWrite(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	stmt := "SELECT * INTO archived_users FROM users"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			stmt: 12,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, User: "postgres"}

	result := app.DBQueryMultiTransactional(config, "main", stmt, "select-into-managed-tx-test")
	if !result.Success {
		t.Fatalf("expected managed SELECT INTO success, got failure: %s", result.Message)
	}
	if result.TransactionID == "" || !result.TransactionPending {
		t.Fatalf("expected pending transaction metadata, got id=%q pending=%v", result.TransactionID, result.TransactionPending)
	}
	if fakeDB.session == nil || fakeDB.session.closed {
		t.Fatal("expected managed SELECT INTO transaction session to stay open")
	}
	wantExecs := []string{"BEGIN", stmt}
	if len(fakeDB.execQueries) != len(wantExecs) {
		t.Fatalf("expected exec queries %#v, got %#v", wantExecs, fakeDB.execQueries)
	}
	for i, want := range wantExecs {
		if fakeDB.execQueries[i] != want {
			t.Fatalf("expected exec query %d = %q, got %q", i, want, fakeDB.execQueries[i])
		}
	}
}
