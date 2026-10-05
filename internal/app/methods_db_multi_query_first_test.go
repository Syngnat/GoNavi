package app

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

func TestNormalizeNativeResultStatementIndexesAssignsMySQLSelectPrefix(t *testing.T) {
	statements := []string{"SELECT phone AS mobile FROM users", "WITH active AS (SELECT phone FROM users) SELECT phone FROM active"}
	results := []connection.ResultSetData{{Columns: []string{"mobile"}, Truncated: true}}

	normalizeNativeResultStatementIndexes("mysql", statements, results)

	if results[0].StatementIndex != 1 {
		t.Fatalf("truncated MySQL prefix statementIndex = %d, want 1", results[0].StatementIndex)
	}
}

func TestNormalizeNativeResultStatementIndexesDoesNotGuessMySQLProcedureResults(t *testing.T) {
	statements := []string{"CALL get_users()", "SELECT phone AS mobile FROM users"}
	results := []connection.ResultSetData{{Columns: []string{"id"}}, {Columns: []string{"mobile"}}}

	normalizeNativeResultStatementIndexes("mysql", statements, results)

	for idx, result := range results {
		if result.StatementIndex != 0 {
			t.Fatalf("ambiguous MySQL result set %d received guessed statementIndex=%d: %#v", idx, result.StatementIndex, results)
		}
	}
}

func TestNormalizeNativeResultStatementIndexesKeepsAmbiguousSQLServerResultsUnassigned(t *testing.T) {
	statements := []string{"SELECT 1", "SELECT 2"}
	results := []connection.ResultSetData{
		{Rows: []map[string]interface{}{{"first": int64(1)}}, Columns: []string{"first"}},
		{Rows: []map[string]interface{}{{"second": int64(2)}}, Columns: []string{"second"}},
		{Rows: []map[string]interface{}{{"affectedRows": int64(1)}}, Columns: []string{"affectedRows"}},
		{Rows: []map[string]interface{}{{"affectedRows": int64(1)}}, Columns: []string{"affectedRows"}},
	}

	normalizeNativeResultStatementIndexes("sqlserver", statements, results)

	for idx, result := range results {
		if result.StatementIndex != 0 {
			t.Fatalf("ambiguous result set %d received guessed statementIndex=%d: %#v", idx, result.StatementIndex, results)
		}
	}
}

func TestDBQueryMultiTreatsBareSQLServerProcedureCallAsQueryFirst(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := `p_get_select c_dyscript,'projectid = 1',1`
	fakeDB := &fakeBatchWriteDB{
		messageMap: map[string][]string{
			query: {`INSERT c_dyscript(id,name) values (1,"demo")`},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sqlserver-bare-proc-query-first-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.session == nil {
		t.Fatal("expected bare SQL Server procedure call to use a pinned query session")
	}
	if fakeDB.session.queryCalls != 1 {
		t.Fatalf("expected one session query call, got %d", fakeDB.session.queryCalls)
	}
	if fakeDB.session.execCalls != 0 {
		t.Fatalf("expected exec path to be skipped, got execCalls=%d", fakeDB.session.execCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 {
		t.Fatalf("expected one result set, got %#v", resultSets)
	}
	if len(resultSets[0].Rows) != 0 || len(resultSets[0].Columns) != 0 {
		t.Fatalf("expected message-only result set, got %#v", resultSets[0])
	}
	if len(resultSets[0].Messages) != 1 || !strings.Contains(resultSets[0].Messages[0], "INSERT c_dyscript") {
		t.Fatalf("expected procedure output message to be preserved, got %#v", resultSets[0].Messages)
	}
}

func TestDBQueryMultiTreatsReturningWriteAsQueryFirst(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "INSERT INTO audit_logs(id) VALUES (1) RETURNING id"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"id": 1},
			},
		},
		fieldMap: map[string][]string{
			query: {"id"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, User: "postgres"}

	result := app.DBQueryMulti(config, "main", query, "postgres-returning-query-first-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected RETURNING write to skip batch exec path, got batchCalls=%d", fakeDB.batchCalls)
	}
	if fakeDB.session == nil || fakeDB.session.queryCalls != 1 {
		t.Fatalf("expected RETURNING write to query through pinned session, got session=%#v", fakeDB.session)
	}
	if fakeDB.session.execCalls != 0 {
		t.Fatalf("expected exec path to be skipped, got execCalls=%d", fakeDB.session.execCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 || len(resultSets[0].Rows) != 1 || resultSets[0].Rows[0]["id"] != 1 {
		t.Fatalf("expected RETURNING rows to be preserved, got %#v", resultSets)
	}
}

func TestDBQueryMultiTreatsSQLServerOutputWriteAsQueryFirst(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	query := "UPDATE users SET name = 'next' OUTPUT inserted.id WHERE id = 1"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"id": 1},
			},
		},
		fieldMap: map[string][]string{
			query: {"id"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}

	result := app.DBQueryMulti(config, "master", query, "sqlserver-output-query-first-test")
	if !result.Success {
		t.Fatalf("expected DBQueryMulti success, got failure: %s", result.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected OUTPUT write to skip batch exec path, got batchCalls=%d", fakeDB.batchCalls)
	}
	if fakeDB.session == nil || fakeDB.session.queryCalls != 1 {
		t.Fatalf("expected OUTPUT write to query through pinned session, got session=%#v", fakeDB.session)
	}
	if fakeDB.session.execCalls != 0 {
		t.Fatalf("expected exec path to be skipped, got execCalls=%d", fakeDB.session.execCalls)
	}
	resultSets, ok := result.Data.([]connection.ResultSetData)
	if !ok {
		t.Fatalf("expected []connection.ResultSetData, got %T", result.Data)
	}
	if len(resultSets) != 1 || len(resultSets[0].Rows) != 1 || resultSets[0].Rows[0]["id"] != 1 {
		t.Fatalf("expected OUTPUT rows to be preserved, got %#v", resultSets)
	}
}

func TestDBQueryMultiTreatsWrappedMessageBlocksAsQueryFirst(t *testing.T) {
	installFakeOptionalDriverRuntime(t)
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
	})

	sqlServerQuery := "IF 1 = 1 PRINT 'done'"
	postgresQuery := "DO $$ BEGIN RAISE NOTICE 'done'; END $$"
	fakeDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			sqlServerQuery: {},
			postgresQuery:  {},
		},
		fieldMap: map[string][]string{
			sqlServerQuery: {},
			postgresQuery:  {},
		},
		messageMap: map[string][]string{
			sqlServerQuery: {"done"},
			postgresQuery:  {"done"},
		},
		queryErr: map[string]error{},
	}
	newDatabaseFunc = func(dbType string) (db.Database, error) {
		return fakeDB, nil
	}

	app := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))

	sqlServerResult := app.DBQueryMulti(connection.ConnectionConfig{Type: "sqlserver", Host: "127.0.0.1", Port: 1433, User: "sa"}, "master", sqlServerQuery, "sqlserver-print-block-test")
	if !sqlServerResult.Success {
		t.Fatalf("expected SQL Server block success, got failure: %s", sqlServerResult.Message)
	}

	postgresResult := app.DBQueryMulti(connection.ConnectionConfig{Type: "postgres", Host: "127.0.0.1", Port: 5432, User: "postgres"}, "main", postgresQuery, "postgres-notice-block-test")
	if !postgresResult.Success {
		t.Fatalf("expected PostgreSQL notice block success, got failure: %s", postgresResult.Message)
	}
	if fakeDB.batchCalls != 0 {
		t.Fatalf("expected message blocks to skip batch exec path, got batchCalls=%d", fakeDB.batchCalls)
	}
	if fakeDB.execCalls != 0 {
		t.Fatalf("expected message blocks to avoid shared exec path, got execCalls=%d", fakeDB.execCalls)
	}
}

func TestExecuteManagedSQLTransactionStatementsPrefersPlainQueryForDamengReadResults(t *testing.T) {
	query := "SELECT * FROM PUB_TIMER"
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"ID": 1, "NAME": "timer_a"},
			},
		},
		fieldMap: map[string][]string{
			query: {"ID", "NAME"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: {{
				Rows:    []map[string]interface{}{},
				Columns: []string{"ID", "NAME"},
			}},
		},
		queryErr: map[string]error{},
	}
	session := &fakeBatchWriteSession{parent: baseDB}

	results, err := executeManagedSQLTransactionStatements(
		context.Background(),
		session,
		connection.ConnectionConfig{Type: "custom", Driver: "dm8"},
		[]string{query},
		nil,
	)
	if err != nil {
		t.Fatalf("expected executeManagedSQLTransactionStatements success, got %v", err)
	}
	if session.queryCalls != 1 {
		t.Fatalf("expected dameng managed read query to use plain query once, got %d calls", session.queryCalls)
	}
	if len(results) != 1 {
		t.Fatalf("expected one result set, got %#v", results)
	}
	if !reflect.DeepEqual(results[0].Columns, []string{"ID", "NAME"}) {
		t.Fatalf("expected plain query columns, got %#v", results[0].Columns)
	}
	if got := results[0].Rows[0]["NAME"]; got != "timer_a" {
		t.Fatalf("expected plain query SELECT result NAME=timer_a, got %#v", got)
	}
}

func TestExecuteManagedSQLTransactionStatementsFallsBackWhenSQLServerReadReturnsOnlyAffectedRowsStatus(t *testing.T) {
	query := "SELECT name FROM sys.databases"
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {{"name": "master"}},
		},
		fieldMap: map[string][]string{
			query: {"name"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: {{
				Rows:    []map[string]interface{}{{"affectedRows": int64(1)}},
				Columns: []string{"affectedRows"},
			}},
		},
		queryErr: map[string]error{},
	}
	session := &fakeBatchWriteSession{parent: baseDB}

	results, err := executeManagedSQLTransactionStatements(
		context.Background(),
		session,
		connection.ConnectionConfig{Type: "sqlserver"},
		[]string{query},
		nil,
	)
	if err != nil {
		t.Fatalf("expected executeManagedSQLTransactionStatements success, got %v", err)
	}
	if session.queryCalls != 2 {
		t.Fatalf("expected SQL Server status-only result plus plain query fallback, got %d calls", session.queryCalls)
	}
	if len(results) != 1 || len(results[0].Rows) != 1 {
		t.Fatalf("expected one fallback result row, got %#v", results)
	}
	if got := results[0].Rows[0]["name"]; got != "master" {
		t.Fatalf("expected fallback SQL Server row name=master, got %#v", got)
	}
	if got := queryResultRowsReturned(connection.QueryResult{Success: true, Data: results}); got != 1 {
		t.Fatalf("expected SQL audit rows returned = 1, got %d", got)
	}
}

func TestExecuteManagedSQLTransactionStatementsPrefersPlainQueryForOceanBaseOracleReadResults(t *testing.T) {
	query := "SELECT * FROM EINP_BASICINFO.AC01"
	baseDB := &fakeBatchWriteDB{
		queryMap: map[string][]map[string]interface{}{
			query: {
				{"AAC001": 1001, "AAC003": "张三"},
			},
		},
		fieldMap: map[string][]string{
			query: {"AAC001", "AAC003"},
		},
		multiResult: map[string][]connection.ResultSetData{
			query: {{
				Rows:    []map[string]interface{}{},
				Columns: []string{"AAC001", "AAC003"},
			}},
		},
		queryErr: map[string]error{},
	}
	session := &fakeBatchWriteSession{parent: baseDB}

	results, err := executeManagedSQLTransactionStatements(
		context.Background(),
		session,
		connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "oracle"},
		[]string{query},
		nil,
	)
	if err != nil {
		t.Fatalf("expected executeManagedSQLTransactionStatements success, got %v", err)
	}
	if session.queryCalls != 1 {
		t.Fatalf("expected OceanBase Oracle managed read query to use plain query once, got %d calls", session.queryCalls)
	}
	if len(results) != 1 {
		t.Fatalf("expected one result set, got %#v", results)
	}
	if !reflect.DeepEqual(results[0].Columns, []string{"AAC001", "AAC003"}) {
		t.Fatalf("expected plain query columns, got %#v", results[0].Columns)
	}
	if got := results[0].Rows[0]["AAC003"]; got != "张三" {
		t.Fatalf("expected plain query SELECT result AAC003=张三, got %#v", got)
	}
}
