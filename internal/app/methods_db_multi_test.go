package app

import (
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

func TestDBQueryMultiInTransactionSerializesCommitWithInFlightStatement(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	initialStatement := "UPDATE users SET active = 1 WHERE id = 1"
	followUpStatement := "UPDATE users SET active = 0 WHERE id = 2"
	fakeDB := &fakeTransactionalDB{fakeBatchWriteDB: fakeBatchWriteDB{
		execAffected: map[string]int64{initialStatement: 1, followUpStatement: 1},
	}}
	newDatabaseFunc = func(string) (db.Database, error) { return fakeDB, nil }
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "main"}

	started := app.DBQueryMultiTransactional(config, "main", initialStatement, "tx-serialize-start")
	if !started.Success || started.TransactionID == "" {
		t.Fatalf("start managed transaction: %#v", started)
	}

	execStarted := make(chan string, 1)
	execRelease := make(chan struct{})
	fakeDB.execStarted = execStarted
	fakeDB.execRelease = execRelease
	queryDone := make(chan connection.QueryResult, 1)
	go func() {
		queryDone <- app.DBQueryMultiInTransaction(started.TransactionID, followUpStatement, "tx-serialize-follow-up")
	}()

	select {
	case statement := <-execStarted:
		if statement != followUpStatement {
			close(execRelease)
			t.Fatalf("blocked statement = %q, want %q", statement, followUpStatement)
		}
	case <-time.After(2 * time.Second):
		close(execRelease)
		t.Fatal("follow-up statement did not start")
	}

	commitDone := make(chan connection.QueryResult, 1)
	go func() {
		commitDone <- app.DBCommitTransaction(started.TransactionID)
	}()
	select {
	case result := <-commitDone:
		close(execRelease)
		t.Fatalf("commit completed while statement was still in flight: %#v", result)
	case <-time.After(75 * time.Millisecond):
	}

	close(execRelease)
	if result := <-queryDone; !result.Success {
		t.Fatalf("follow-up statement failed: %#v", result)
	}
	if result := <-commitDone; !result.Success {
		t.Fatalf("commit after follow-up failed: %#v", result)
	}
	if fakeDB.txSession.commitCalls != 1 || !fakeDB.txSession.closed {
		t.Fatalf("transaction was not committed exactly once after execution: commitCalls=%d closed=%v", fakeDB.txSession.commitCalls, fakeDB.txSession.closed)
	}
}

func TestRollbackPendingSQLTransactionsWaitsForInFlightStatement(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })

	initialStatement := "UPDATE users SET active = 1 WHERE id = 1"
	followUpStatement := "UPDATE users SET active = 0 WHERE id = 2"
	fakeDB := &fakeTransactionalDB{fakeBatchWriteDB: fakeBatchWriteDB{
		execAffected: map[string]int64{initialStatement: 1, followUpStatement: 1},
	}}
	newDatabaseFunc = func(string) (db.Database, error) { return fakeDB, nil }
	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "main"}

	started := app.DBQueryMultiTransactional(config, "main", initialStatement, "tx-shutdown-start")
	if !started.Success || started.TransactionID == "" {
		t.Fatalf("start managed transaction: %#v", started)
	}

	execStarted := make(chan string, 1)
	execRelease := make(chan struct{})
	fakeDB.execStarted = execStarted
	fakeDB.execRelease = execRelease
	queryDone := make(chan connection.QueryResult, 1)
	go func() {
		queryDone <- app.DBQueryMultiInTransaction(started.TransactionID, followUpStatement, "tx-shutdown-follow-up")
	}()
	select {
	case <-execStarted:
	case <-time.After(2 * time.Second):
		close(execRelease)
		t.Fatal("follow-up statement did not start")
	}

	shutdownDone := make(chan struct{})
	go func() {
		app.rollbackPendingSQLTransactionsOnShutdown()
		close(shutdownDone)
	}()
	select {
	case <-shutdownDone:
		close(execRelease)
		t.Fatal("shutdown rollback completed while statement was still in flight")
	case <-time.After(75 * time.Millisecond):
	}

	close(execRelease)
	if result := <-queryDone; !result.Success {
		t.Fatalf("follow-up statement failed: %#v", result)
	}
	select {
	case <-shutdownDone:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown rollback did not finish after statement completed")
	}
	if fakeDB.txSession.rollbackCalls != 1 || !fakeDB.txSession.closed {
		t.Fatalf("transaction was not rolled back exactly once after execution: rollbackCalls=%d closed=%v", fakeDB.txSession.rollbackCalls, fakeDB.txSession.closed)
	}
}

func TestDBQueryWithCancelReturnsResultSetForExecStoredProcedure(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "EXEC sp_who2"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"SPID": 52, "STATUS": "RUNNABLE"},
			},
		},
		fieldMap: map[string][]string{
			query: {"SPID", "STATUS"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryWithCancel(config, "master", query, "sp-who2-test")
	if !result.Success {
		t.Fatalf("expected DBQueryWithCancel success, got failure: %s", result.Message)
	}
	rows, ok := result.Data.([]map[string]interface{})
	if !ok {
		t.Fatalf("expected []map[string]interface{}, got %T", result.Data)
	}
	if len(rows) != 1 || rows[0]["SPID"] != 52 {
		t.Fatalf("unexpected rows: %#v", rows)
	}
	if fakeDB.execCalls != 0 {
		t.Fatalf("expected exec path to be skipped, got execCalls=%d", fakeDB.execCalls)
	}
}

func TestDBQueryWithCancelRoutesMilvusJSONSearchToQuery(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := `{"search":"products","vector":[0.1,0.2,0.3],"limit":1}`
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {{"id": 1, "distance": 0.01}},
		},
		fieldMap: map[string][]string{
			query: {"id", "distance"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBQueryWithCancel(
		connection.ConnectionConfig{Type: "milvus", Host: "127.0.0.1", Port: 19530},
		"default",
		query,
		"milvus-search-test",
	)
	if !result.Success {
		t.Fatalf("expected Milvus JSON search success, got failure: %s", result.Message)
	}
	if fakeDB.queryCalls != 1 || fakeDB.execCalls != 0 {
		t.Fatalf("expected query path only, queryCalls=%d execCalls=%d", fakeDB.queryCalls, fakeDB.execCalls)
	}
}

func TestDBQueryWithCancelRoutesMilvusSelectPreviewToQuery(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := `SELECT * FROM "products" LIMIT 101 OFFSET 0`
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {{"id": 1, "category": "book"}},
		},
		fieldMap: map[string][]string{
			query: {"id", "category"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	result := app.DBQueryWithCancel(
		connection.ConnectionConfig{Type: "milvus", Host: "127.0.0.1", Port: 19530},
		"default",
		query,
		"milvus-select-preview-test",
	)
	if !result.Success {
		t.Fatalf("expected Milvus SELECT preview success, got failure: %s", result.Message)
	}
	if fakeDB.queryCalls != 1 || fakeDB.execCalls != 0 {
		t.Fatalf("expected query path only, queryCalls=%d execCalls=%d", fakeDB.queryCalls, fakeDB.execCalls)
	}
}

func TestDBQueryWithCancelReturnsMessagesForSQLServerQuery(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SET STATISTICS IO ON"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {},
		},
		fieldMap: map[string][]string{
			query: {},
		},
		messageMap: map[string][]string{
			query: {"Table 'users'. Scan count 1, logical reads 3."},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryWithCancel(config, "master", query, "statistics-io-test")
	if !result.Success {
		t.Fatalf("expected DBQueryWithCancel success, got failure: %s", result.Message)
	}
	if len(result.Messages) != 1 || result.Messages[0] == "" {
		t.Fatalf("expected SQL Server messages to be returned, got %#v", result.Messages)
	}
}

func TestDBQueryWithCancel_DuckDBQueriesDoNotInheritConnectTimeout(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	originalVerifyDriverAgentRevisionFunc := verifyDriverAgentRevisionFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		verifyDriverAgentRevisionFunc = originalVerifyDriverAgentRevisionFunc
	})

	query := "SELECT 1"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"value": 1},
			},
		},
		fieldMap: map[string][]string{
			query: {"value"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}
	verifyDriverAgentRevisionFunc = func(config connection.ConnectionConfig) error {
		return nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "duckdb", Host: ":memory:", Timeout: 1}

	result := app.DBQueryWithCancel(config, "main", query, "duckdb-no-deadline-test")
	if !result.Success {
		t.Fatalf("expected DuckDB DBQueryWithCancel success, got failure: %s", result.Message)
	}
	if fakeDB.lastCtx == nil {
		t.Fatal("expected DuckDB query path to receive a context")
	}
	if _, ok := fakeDB.lastCtx.Deadline(); ok {
		t.Fatal("expected DuckDB query context to avoid connection-timeout deadline")
	}
}

func TestDBQueryMulti_MySQLQueriesDoNotInheritConnectTimeout(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT 1"
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
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Timeout: 1}

	result := app.DBQueryMulti(config, "testdb", query, "mysql-no-connect-deadline-test")
	if !result.Success {
		t.Fatalf("expected MySQL DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.lastCtx == nil {
		t.Fatal("expected MySQL query path to receive a context")
	}
	if _, ok := fakeDB.lastCtx.Deadline(); ok {
		t.Fatal("expected MySQL query context to avoid connection-timeout deadline")
	}
}

func TestDBQueryMultiReportsDriverExecutionDuration(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "SELECT 1"
	fakeDB := &fakeBatchWriteDB{
		queryDelay: map[string]time.Duration{
			query: 40 * time.Millisecond,
		},
		queryMap: map[string][]map[string]interface{}{
			query: {{"value": 1}},
		},
		fieldMap: map[string][]string{
			query: {"value"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		time.Sleep(30 * time.Millisecond)
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306}

	started := time.Now()
	result := app.DBQueryMulti(config, "testdb", query, "mysql-duration-test")
	wallMs := time.Since(started).Milliseconds()
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if result.DurationMs < 20 {
		t.Fatalf("DurationMs=%d, want SQL execution time around 40ms", result.DurationMs)
	}
	if wallMs-result.DurationMs < 15 {
		t.Fatalf("DurationMs=%d wall=%dms; SQL duration should exclude connection wait", result.DurationMs, wallMs)
	}

	single := app.DBQueryWithCancel(config, "testdb", query, "mysql-duration-single-test")
	if !single.Success {
		t.Fatalf("expected DBQueryWithCancel success, got failure: %s", single.Message)
	}
	if single.DurationMs < 20 {
		t.Fatalf("DBQueryWithCancel DurationMs=%d, want SQL execution time around 40ms", single.DurationMs)
	}
}

func TestDBQueryMultiPreservesPerStatementResultsForMultipleWriteStatements(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	firstStmt := "DELETE FROM assets_asset"
	secondStmt := "DELETE FROM assets_assetcategory"
	fakeDB := &fakeBatchWriteDB{
		execAffected: map[string]int64{
			firstStmt:  5,
			secondStmt: 10,
		},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{
		Type: "mysql",
		Host: "127.0.0.1",
		Port: 1433,
		User: "sa",
	}
	query := firstStmt + ";\n" + secondStmt + ";"

	result := app.DBQueryMulti(config, "testdb", query, "batch-write-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected multiple write statements to skip batch path so each result can be preserved, got %d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 2 {
		t.Fatalf("expected sequential exec path to run twice, got execCalls=%d", fakeDB.execCalls)
	}
	if len(fakeDB.execQueries) != 2 || fakeDB.execQueries[0] != firstStmt || fakeDB.execQueries[1] != secondStmt {
		t.Fatalf("expected sequential execs to preserve statement order, got %#v", fakeDB.execQueries)
	}

	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 2 {
		t.Fatalf("expected one affectedRows result set per statement, got %#v", resultSets)
	}
	if len(resultSets[0].Rows) != 1 || len(resultSets[1].Rows) != 1 {
		t.Fatalf("expected both result sets to contain a single affectedRows row, got %#v", resultSets)
	}
	if got := resultSets[0].Rows[0]["affectedRows"]; got != int64(5) {
		t.Fatalf("expected first affectedRows=5, got %#v", got)
	}
	if got := resultSets[1].Rows[0]["affectedRows"]; got != int64(10) {
		t.Fatalf("expected second affectedRows=10, got %#v", got)
	}
}
