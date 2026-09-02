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

// buildExplainQuery 测试：验证各方言生成的 SQL 是否符合预期。
func TestBuildExplainQuery_MySQLUsesFormatJSON(t *testing.T) {
	wrapped, post, format, cleanup, err := buildExplainQuery("mysql", "SELECT * FROM t")
	if err != nil {
		t.Fatalf("mysql 构造失败：%v", err)
	}
	if want := "EXPLAIN FORMAT=JSON SELECT * FROM t"; wrapped != want {
		t.Fatalf("got=%q want=%q", wrapped, want)
	}
	if len(post) != 0 {
		t.Fatalf("mysql 不应有 post 查询，got=%v", post)
	}
	if len(cleanup) != 0 {
		t.Fatalf("mysql 不应有 cleanup，got=%v", cleanup)
	}
	if format != connection.ExplainFormatJSON {
		t.Fatalf("format got=%v want=json", format)
	}
}

func TestBuildExplainQuery_PostgresUsesSafeJSONPlan(t *testing.T) {
	wrapped, _, format, _, err := buildExplainQuery("postgres", "SELECT * FROM t WHERE id = 1")
	if err != nil {
		t.Fatalf("postgres 构造失败：%v", err)
	}
	if strings.Contains(wrapped, "ANALYZE") || strings.Contains(wrapped, "BUFFERS") {
		t.Fatalf("默认诊断不应实际执行查询，got=%q", wrapped)
	}
	if !strings.Contains(wrapped, "FORMAT JSON") {
		t.Fatalf("postgres SQL 应使用 FORMAT JSON，got=%q", wrapped)
	}
	if format != connection.ExplainFormatJSON {
		t.Fatalf("format got=%v want=json", format)
	}
}

func TestBuildExplainQuery_SQLiteUsesEQP(t *testing.T) {
	wrapped, _, format, _, err := buildExplainQuery("sqlite", "SELECT * FROM t")
	if err != nil {
		t.Fatalf("sqlite 构造失败：%v", err)
	}
	if want := "EXPLAIN QUERY PLAN SELECT * FROM t"; wrapped != want {
		t.Fatalf("got=%q want=%q", wrapped, want)
	}
	if format != connection.ExplainFormatTable {
		t.Fatalf("format got=%v want=table", format)
	}
}

func TestBuildExplainQuery_OracleReturnsStatementIDAndCleanup(t *testing.T) {
	wrapped, post, _, cleanup, err := buildExplainQuery("oracle", "SELECT * FROM t")
	if err != nil {
		t.Fatalf("oracle 构造失败：%v", err)
	}
	if !strings.Contains(wrapped, "EXPLAIN PLAN SET STATEMENT_ID") {
		t.Fatalf("oracle 主语句应含 STATEMENT_ID，got=%q", wrapped)
	}
	if len(post) != 1 || !strings.Contains(post[0], "DBMS_XPLAN.DISPLAY") {
		t.Fatalf("oracle post 应含 DBMS_XPLAN.DISPLAY，got=%v", post)
	}
	if len(cleanup) != 1 || !strings.Contains(cleanup[0], "DELETE FROM plan_table") {
		t.Fatalf("oracle cleanup 应含 DELETE FROM plan_table，got=%v", cleanup)
	}
	// 验证 statement_id 在三条 SQL 中一致
	idInWrapped := extractBetween(wrapped, "STATEMENT_ID = '", "' FOR")
	idInPost := extractBetween(post[0], "NULL, '", "'")
	idInCleanup := extractBetween(cleanup[0], "statement_id = '", "'")
	if idInWrapped == "" || idInWrapped != idInPost || idInWrapped != idInCleanup {
		t.Fatalf("statement_id 不一致：wrapped=%q post=%q cleanup=%q", idInWrapped, idInPost, idInCleanup)
	}
}

func TestBuildExplainQuery_SQLServerSetsShowplanXML(t *testing.T) {
	wrapped, post, _, _, err := buildExplainQuery("sqlserver", "SELECT * FROM t")
	if err != nil {
		t.Fatalf("sqlserver 构造失败：%v", err)
	}
	if !strings.Contains(wrapped, "SET SHOWPLAN_XML ON") {
		t.Fatalf("sqlserver 应 SET SHOWPLAN_XML ON，got=%q", wrapped)
	}
	if !strings.Contains(wrapped, "SELECT * FROM t") {
		t.Fatalf("sqlserver 应保留原 SQL，got=%q", wrapped)
	}
	if len(post) != 1 || !strings.Contains(post[0], "SET SHOWPLAN_XML OFF") {
		t.Fatalf("sqlserver post 应 SET SHOWPLAN_XML OFF，got=%v", post)
	}
}

func TestBuildExplainQuery_ClickHouseUsesExplainJSON(t *testing.T) {
	wrapped, _, format, _, err := buildExplainQuery("clickhouse", "SELECT * FROM t")
	if err != nil {
		t.Fatalf("clickhouse 构造失败：%v", err)
	}
	if want := "EXPLAIN PLAN json = 1, description = 1, indexes = 1 SELECT * FROM t"; wrapped != want {
		t.Fatalf("got=%q want=%q", wrapped, want)
	}
	if format != connection.ExplainFormatJSON {
		t.Fatalf("format got=%v want=json", format)
	}
}

func TestBuildExplainQuery_PGLikeDialectsSharePath(t *testing.T) {
	// gaussdb/opengauss/kingbase/highgo/vastbase 应该复用 PG 的安全 JSON 计划路径。
	for _, dbType := range []string{"gaussdb", "opengauss", "kingbase", "highgo", "vastbase"} {
		wrapped, _, format, _, err := buildExplainQuery(dbType, "SELECT 1")
		if err != nil {
			t.Errorf("%s 构造失败：%v", dbType, err)
			continue
		}
		if !strings.Contains(wrapped, "FORMAT JSON") {
			t.Errorf("%s 应使用 FORMAT JSON 路径，got=%q", dbType, wrapped)
		}
		if strings.Contains(wrapped, "ANALYZE") || strings.Contains(wrapped, "BUFFERS") {
			t.Errorf("%s 默认诊断不应实际执行查询，got=%q", dbType, wrapped)
		}
		if format != connection.ExplainFormatJSON {
			t.Errorf("%s format got=%v want=json", dbType, format)
		}
	}
}

func TestIsSafeExplainQueryRejectsWriteCTEAndMultipleStatements(t *testing.T) {
	tests := []struct {
		name  string
		query string
	}{
		{
			name:  "data changing CTE",
			query: "WITH moved AS (DELETE FROM audit_logs RETURNING id) SELECT * FROM moved",
		},
		{
			name:  "select into",
			query: "SELECT * INTO archived_users FROM users",
		},
		{
			name:  "trailing write statement",
			query: "SELECT 1; DELETE FROM users",
		},
		{
			name:  "multiple read statements",
			query: "SELECT 1; SELECT 2",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if isSafeExplainQuery("postgres", tt.query) {
				t.Fatalf("unsafe query should be rejected: %q", tt.query)
			}
		})
	}

	if !isSafeExplainQuery("postgres", "/* inspect */ WITH target AS (SELECT id FROM users) SELECT * FROM target;") {
		t.Fatal("single read-only CTE should be accepted")
	}
	if !isSafeExplainQuery("postgres", "SELECT 1; -- keep this note") {
		t.Fatal("trailing comments should not be treated as another statement")
	}
}

func TestIsSafeExplainQueryRejectsExecutableMySQLComments(t *testing.T) {
	unsafeQueries := []struct {
		dbType string
		query  string
	}{
		{dbType: "mysql", query: "SELECT 1 /*! ; DELETE FROM users */"},
		{dbType: "mariadb", query: "SELECT 1 /*M! ; DELETE FROM users */"},
		{dbType: "oceanbase", query: "SELECT /*!50700 SQL_NO_CACHE */ 1"},
		{dbType: "diros", query: "SELECT 1 /*! UNION SELECT secret FROM credentials */"},
		{dbType: "starrocks", query: "SELECT 1 /*m! UNION SELECT secret FROM credentials */"},
		{dbType: "mysql", query: "SELECT 1--1 /*! ; DELETE FROM users */"},
	}

	for _, tt := range unsafeQueries {
		if isSafeExplainQuery(tt.dbType, tt.query) {
			t.Fatalf("%s executable comment should be rejected: %q", tt.dbType, tt.query)
		}
	}

	if !isSafeExplainQuery("mysql", "SELECT /*+ MAX_EXECUTION_TIME(1000) */ 1") {
		t.Fatal("ordinary optimizer hints should remain supported")
	}
	if !isSafeExplainQuery("postgres", "SELECT '/*! literal text */'") {
		t.Fatal("executable-comment markers inside literals must not be rejected")
	}
}

func TestIsSafeExplainQueryUsesDialectAwareStatementSplitting(t *testing.T) {
	tests := []struct {
		name   string
		dbType string
		query  string
	}{
		{
			name:   "mysql double dash without following whitespace is arithmetic",
			dbType: "mysql",
			query:  "SELECT 1--1; DELETE FROM users",
		},
		{
			name:   "mariadb double dash without following whitespace is arithmetic",
			dbType: "mariadb",
			query:  "SELECT 1--1; UPDATE users SET active = 0",
		},
		{
			name:   "postgres hash is not a line comment",
			dbType: "postgres",
			query:  "SELECT 1 # 1; DELETE FROM users",
		},
		{
			name:   "mysql dollar-tag lookalike is an identifier",
			dbType: "mysql",
			query:  "SELECT 1 AS a$tag$; DELETE FROM users; SELECT 1 AS a$tag$",
		},
		{
			name:   "postgres dollar tag inside identifier is not a quote",
			dbType: "postgres",
			query:  "SELECT 1 AS a$tag$; DELETE FROM users; SELECT 1 AS a$tag$",
		},
		{
			name:   "postgres backslash quote ambiguity fails closed",
			dbType: "postgres",
			query:  `SELECT '\' AS x; DELETE FROM users; SELECT '\' AS y`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if isSafeExplainQuery(tt.dbType, tt.query) {
				t.Fatalf("expected dialect-aware splitter to reject %q", tt.query)
			}
		})
	}

	if !isSafeExplainQuery("mysql", "SELECT 1 -- harmless comment\n") {
		t.Fatal("expected a valid MySQL double-dash comment to remain allowed")
	}
	if !isSafeExplainQuery("clickhouse", "SELECT 1 # harmless comment") {
		t.Fatal("expected a ClickHouse hash comment to remain allowed")
	}
	if isSafeExplainQuery("postgres", "SELECT ';' AS delimiter") {
		t.Fatal("expected embedded semicolons to fail closed at the diagnostic security boundary")
	}
}

func TestGetDiagnoseTimeoutHonorsConnectionTimeout(t *testing.T) {
	if got, want := getDiagnoseTimeout(connection.ConnectionConfig{Timeout: 2}), 2*time.Second; got != want {
		t.Fatalf("configured timeout got=%v want=%v", got, want)
	}
	if got, want := getDiagnoseTimeout(connection.ConnectionConfig{}), defaultExplainStatementTimeout; got != want {
		t.Fatalf("default timeout got=%v want=%v", got, want)
	}
}

type fakePinnedExplainDatabase struct {
	session            *fakePinnedExplainSession
	queryCalled        bool
	queryContextCalled bool
}

func (database *fakePinnedExplainDatabase) Connect(connection.ConnectionConfig) error { return nil }
func (database *fakePinnedExplainDatabase) Close() error                              { return nil }
func (database *fakePinnedExplainDatabase) Ping() error                               { return nil }
func (database *fakePinnedExplainDatabase) Query(string) ([]map[string]interface{}, []string, error) {
	database.queryCalled = true
	return []map[string]interface{}{{"detail": "legacy"}}, []string{"detail"}, nil
}
func (database *fakePinnedExplainDatabase) QueryContext(ctx context.Context, _ string) ([]map[string]interface{}, []string, error) {
	database.queryContextCalled = true
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	return []map[string]interface{}{{"detail": "context"}}, []string{"detail"}, nil
}
func (database *fakePinnedExplainDatabase) Exec(string) (int64, error) { return 0, nil }
func (database *fakePinnedExplainDatabase) GetDatabases() ([]string, error) {
	return nil, nil
}
func (database *fakePinnedExplainDatabase) GetTables(string) ([]string, error) {
	return nil, nil
}
func (database *fakePinnedExplainDatabase) GetCreateStatement(string, string) (string, error) {
	return "", nil
}
func (database *fakePinnedExplainDatabase) GetColumns(string, string) ([]connection.ColumnDefinition, error) {
	return nil, nil
}
func (database *fakePinnedExplainDatabase) GetAllColumns(string) ([]connection.ColumnDefinitionWithTable, error) {
	return nil, nil
}
func (database *fakePinnedExplainDatabase) GetIndexes(string, string) ([]connection.IndexDefinition, error) {
	return nil, nil
}
func (database *fakePinnedExplainDatabase) GetForeignKeys(string, string) ([]connection.ForeignKeyDefinition, error) {
	return nil, nil
}
func (database *fakePinnedExplainDatabase) GetTriggers(string, string) ([]connection.TriggerDefinition, error) {
	return nil, nil
}
func (database *fakePinnedExplainDatabase) OpenSessionExecer(context.Context) (db.StatementExecer, error) {
	return database.session, nil
}

type fakePinnedExplainSession struct {
	operations       []string
	failExecContains string
	discarded        bool
}

func (session *fakePinnedExplainSession) Exec(query string) (int64, error) {
	return session.ExecContext(context.Background(), query)
}
func (session *fakePinnedExplainSession) ExecContext(_ context.Context, query string) (int64, error) {
	session.operations = append(session.operations, "exec:"+query)
	if session.failExecContains != "" && strings.Contains(query, session.failExecContains) {
		return 0, errors.New("forced cleanup failure")
	}
	return 0, nil
}
func (session *fakePinnedExplainSession) Query(query string) ([]map[string]interface{}, []string, error) {
	return session.QueryContext(context.Background(), query)
}
func (session *fakePinnedExplainSession) QueryContext(_ context.Context, query string) ([]map[string]interface{}, []string, error) {
	session.operations = append(session.operations, "query:"+query)
	if strings.Contains(query, "DBMS_XPLAN.DISPLAY") {
		return []map[string]interface{}{{"PLAN_TABLE_OUTPUT": "Plan hash value: 123"}}, []string{"PLAN_TABLE_OUTPUT"}, nil
	}
	return []map[string]interface{}{{"Microsoft SQL Server 2005 XML Showplan": "<ShowPlanXML/>"}}, []string{"Microsoft SQL Server 2005 XML Showplan"}, nil
}
func (session *fakePinnedExplainSession) Close() error {
	session.operations = append(session.operations, "close")
	return nil
}
func (session *fakePinnedExplainSession) Discard() error {
	session.discarded = true
	session.operations = append(session.operations, "discard")
	return nil
}

func TestExecutePinnedExplainStatements_SQLServerUsesSeparateBatches(t *testing.T) {
	session := &fakePinnedExplainSession{}
	database := &fakePinnedExplainDatabase{session: session}
	raw, format, err := executePinnedExplainStatements(context.Background(), database, "sqlserver", "SELECT * FROM users", defaultExplainBackendText)
	if err != nil {
		t.Fatalf("SQL Server pinned explain failed: %v", err)
	}
	if format != connection.ExplainFormatXML || raw != "<ShowPlanXML/>" {
		t.Fatalf("unexpected SQL Server explain result: format=%q raw=%q", format, raw)
	}
	want := []string{
		"exec:SET SHOWPLAN_XML ON",
		"query:SELECT * FROM users",
		"exec:SET SHOWPLAN_XML OFF",
		"close",
	}
	if strings.Join(session.operations, "\n") != strings.Join(want, "\n") {
		t.Fatalf("SQL Server SHOWPLAN must use separate batches on one session:\n got=%q\nwant=%q", session.operations, want)
	}
}

func TestExecutePinnedExplainStatements_SQLServerDiscardsSessionWhenCleanupFails(t *testing.T) {
	session := &fakePinnedExplainSession{failExecContains: "SHOWPLAN_XML OFF"}
	database := &fakePinnedExplainDatabase{session: session}
	if _, _, err := executePinnedExplainStatements(context.Background(), database, "sqlserver", "SELECT * FROM users", defaultExplainBackendText); err != nil {
		t.Fatalf("plan collection should still succeed before cleanup: %v", err)
	}
	if !session.discarded {
		t.Fatalf("cleanup failure must discard the pinned physical session, operations=%q", session.operations)
	}
}

func TestExecutePinnedExplainStatements_OracleReadsAndCleansPlanOnSameSession(t *testing.T) {
	session := &fakePinnedExplainSession{}
	database := &fakePinnedExplainDatabase{session: session}
	raw, format, err := executePinnedExplainStatements(context.Background(), database, "oracle", "SELECT * FROM users", defaultExplainBackendText)
	if err != nil {
		t.Fatalf("Oracle pinned explain failed: %v", err)
	}
	if format != connection.ExplainFormatTable || !strings.Contains(raw, "Plan hash value: 123") {
		t.Fatalf("unexpected Oracle explain result: format=%q raw=%q", format, raw)
	}
	if len(session.operations) != 4 ||
		!strings.HasPrefix(session.operations[0], "exec:EXPLAIN PLAN SET STATEMENT_ID") ||
		!strings.Contains(session.operations[1], "DBMS_XPLAN.DISPLAY") ||
		!strings.HasPrefix(session.operations[2], "exec:DELETE FROM plan_table") ||
		session.operations[3] != "close" {
		t.Fatalf("Oracle explain must execute/read/cleanup on one session, got=%q", session.operations)
	}
}

func TestExecuteExplainStatementsSingleResultFallbackHonorsContext(t *testing.T) {
	database := &fakePinnedExplainDatabase{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, _, err := executeExplainStatementsWithText(
		ctx,
		database,
		"sqlite",
		"EXPLAIN QUERY PLAN SELECT 1",
		nil,
		connection.ExplainFormatTable,
		defaultExplainBackendText,
	)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected canceled context, got %v", err)
	}
	if !database.queryContextCalled || database.queryCalled {
		t.Fatalf("expected QueryContext fallback only, context=%v legacy=%v", database.queryContextCalled, database.queryCalled)
	}
}

type legacyContextBoundaryExplainDatabase struct {
	db.Database
	queryCalls int
	onQuery    func()
}

func (database *legacyContextBoundaryExplainDatabase) Query(string) ([]map[string]interface{}, []string, error) {
	database.queryCalls++
	if database.onQuery != nil {
		database.onQuery()
	}
	return []map[string]interface{}{{"detail": "legacy"}}, []string{"detail"}, nil
}

type legacyContextBoundaryMultiExplainDatabase struct {
	legacyContextBoundaryExplainDatabase
	multiCalls int
	onMulti    func()
}

func (database *legacyContextBoundaryMultiExplainDatabase) QueryMulti(string) ([]connection.ResultSetData, error) {
	database.multiCalls++
	if database.onMulti != nil {
		database.onMulti()
	}
	return []connection.ResultSetData{{Rows: []map[string]interface{}{{"detail": "legacy"}}, Columns: []string{"detail"}}}, nil
}

func TestExecuteExplainStatementsLegacyFallbackChecksContextBoundaries(t *testing.T) {
	t.Run("single result does not dispatch after cancellation", func(t *testing.T) {
		database := &legacyContextBoundaryExplainDatabase{}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()

		_, _, err := executeExplainStatementsWithText(
			ctx, database, "sqlite", "EXPLAIN QUERY PLAN SELECT 1", nil,
			connection.ExplainFormatTable, defaultExplainBackendText,
		)
		if !errors.Is(err, context.Canceled) || database.queryCalls != 0 {
			t.Fatalf("result error=%v queryCalls=%d, want pre-dispatch cancellation", err, database.queryCalls)
		}
	})

	t.Run("single result reports cancellation observed after dispatch", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		database := &legacyContextBoundaryExplainDatabase{onQuery: cancel}

		_, _, err := executeExplainStatementsWithText(
			ctx, database, "sqlite", "EXPLAIN QUERY PLAN SELECT 1", nil,
			connection.ExplainFormatTable, defaultExplainBackendText,
		)
		if !errors.Is(err, context.Canceled) || database.queryCalls != 1 {
			t.Fatalf("result error=%v queryCalls=%d, want post-dispatch cancellation", err, database.queryCalls)
		}
	})

	t.Run("multi result reports cancellation observed after dispatch", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		database := &legacyContextBoundaryMultiExplainDatabase{onMulti: cancel}

		_, _, err := executeExplainStatementsWithText(
			ctx, database, "mysql", "EXPLAIN FORMAT=JSON SELECT 1", nil,
			connection.ExplainFormatJSON, defaultExplainBackendText,
		)
		if !errors.Is(err, context.Canceled) || database.multiCalls != 1 || database.queryCalls != 0 {
			t.Fatalf("result error=%v multiCalls=%d queryCalls=%d, want post-dispatch cancellation", err, database.multiCalls, database.queryCalls)
		}
	})
}

func TestBuildExplainQuery_UnsupportedDialectReturnsError(t *testing.T) {
	_, _, _, _, err := buildExplainQuery("mongodb", "db.t.find()")
	if err == nil {
		t.Fatal("未支持方言应返回 error")
	}
}

// extractBetween 取 s 中 between start 和 end 的第一个匹配子串（测试辅助）。
func extractBetween(s, start, end string) string {
	startIdx := strings.Index(s, start)
	if startIdx < 0 {
		return ""
	}
	startIdx += len(start)
	endIdx := strings.Index(s[startIdx:], end)
	if endIdx < 0 {
		return ""
	}
	return s[startIdx : startIdx+endIdx]
}
