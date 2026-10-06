package app

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

type fakeAnalyzeDatabase struct {
	fakePinnedExplainDatabase
	session *fakeAnalyzeSession
	// analyzeSession replaces session for dialects needing other session calls.
	analyzeSession db.StatementExecer
	mu             sync.Mutex
	execs          []string
}

func (database *fakeAnalyzeDatabase) OpenSessionExecer(context.Context) (db.StatementExecer, error) {
	if database.analyzeSession != nil {
		return database.analyzeSession, nil
	}
	return database.session, nil
}

func (database *fakeAnalyzeDatabase) ExecContext(_ context.Context, query string) (int64, error) {
	database.mu.Lock()
	defer database.mu.Unlock()
	database.execs = append(database.execs, query)
	return 0, nil
}

func (database *fakeAnalyzeDatabase) executed() []string {
	database.mu.Lock()
	defer database.mu.Unlock()
	return append([]string(nil), database.execs...)
}

type fakeAnalyzeSession struct {
	fakePinnedExplainSession
	version string
	plan    string
	block   bool
}

func (session *fakeAnalyzeSession) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	session.operations = append(session.operations, "query:"+query)
	if strings.Contains(query, "CONNECTION_ID()") {
		return []map[string]interface{}{{"gonavi_connection_id": int64(42), "gonavi_version": session.version}},
			[]string{"gonavi_connection_id", "gonavi_version"}, nil
	}
	if session.block {
		<-ctx.Done()
		return nil, nil, ctx.Err()
	}
	return []map[string]interface{}{{"EXPLAIN": session.plan}}, []string{"EXPLAIN"}, nil
}

func (session *fakeAnalyzeSession) Query(query string) ([]map[string]interface{}, []string, error) {
	return session.QueryContext(context.Background(), query)
}

func TestExecuteExplainAnalyzeRunsInRolledBackReadOnlyTransaction(t *testing.T) {
	session := &fakeAnalyzeSession{version: "8.4.6", plan: mysqlTreeJoinSample}
	database := &fakeAnalyzeDatabase{session: session}
	result, statement, err := NewApp().executeExplainAnalyzeContext(context.Background(), database, connection.ConnectionConfig{}, "mysql", "SELECT 1;")
	if err != nil {
		t.Fatalf("analyze: %v", err)
	}
	want := []string{
		"query:SELECT CONNECTION_ID() AS gonavi_connection_id, VERSION() AS gonavi_version",
		"exec:START TRANSACTION READ ONLY",
		"query:EXPLAIN ANALYZE SELECT 1",
		"exec:ROLLBACK",
		"close",
	}
	if strings.Join(session.operations, "\n") != strings.Join(want, "\n") {
		t.Fatalf("operations:\n got=%q\nwant=%q", session.operations, want)
	}
	if statement != "EXPLAIN ANALYZE SELECT 1" || !result.Analyzed || result.HotspotBasis != explainHotspotBasisTime {
		t.Fatalf("statement=%q analyzed=%t basis=%q", statement, result.Analyzed, result.HotspotBasis)
	}
	if executed := database.executed(); len(executed) != 0 {
		t.Fatalf("nothing may be killed after a normal run: %q", executed)
	}
}

func TestExecuteExplainAnalyzeSwitchesToMariaDBSyntaxBehindMySQLConnection(t *testing.T) {
	session := &fakeAnalyzeSession{version: "11.4.2-MariaDB-ubu2404", plan: mariaDBAnalyzeFilterSample}
	database := &fakeAnalyzeDatabase{session: session}
	result, statement, err := NewApp().executeExplainAnalyzeContext(context.Background(), database, connection.ConnectionConfig{}, "mysql", "SELECT * FROM items")
	if err != nil {
		t.Fatalf("analyze: %v", err)
	}
	if statement != "ANALYZE FORMAT=JSON SELECT * FROM items" || len(result.Nodes) == 0 || !result.Analyzed {
		t.Fatalf("statement=%q nodes=%d", statement, len(result.Nodes))
	}
}

func TestExecuteExplainAnalyzeKillsTimedOutStatementAndDropsSession(t *testing.T) {
	session := &fakeAnalyzeSession{version: "8.0.36", block: true}
	database := &fakeAnalyzeDatabase{session: session}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, _, err := NewApp().executeExplainAnalyzeContext(ctx, database, connection.ConnectionConfig{Timeout: 7}, "mysql", "SELECT SLEEP(60)")
	if err == nil || !strings.Contains(err.Error(), "7") {
		t.Fatalf("want a timeout naming the limit, got %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(database.executed()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if executed := database.executed(); len(executed) != 1 || executed[0] != "KILL QUERY 42" {
		t.Fatalf("the server-side statement must be killed: %q", executed)
	}
	if !session.discarded {
		t.Fatalf("a killed session must not go back to the pool: %q", session.operations)
	}
}

func TestExecuteExplainAnalyzePostgresUsesReadOnlyTransaction(t *testing.T) {
	session := &fakeAnalyzeSession{plan: `[{"Plan": {"Node Type": "Seq Scan", "Relation Name": "t", "Total Cost": 10, "Plan Rows": 5, "Actual Total Time": 0.5, "Actual Rows": 5, "Actual Loops": 1}, "Execution Time": 0.6}]`}
	database := &fakeAnalyzeDatabase{session: session}
	result, statement, err := NewApp().executeExplainAnalyzeContext(context.Background(), database, connection.ConnectionConfig{}, "postgres", "SELECT * FROM t")
	if err != nil {
		t.Fatalf("analyze: %v", err)
	}
	want := []string{"exec:BEGIN READ ONLY", "query:EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM t", "exec:ROLLBACK", "close"}
	if strings.Join(session.operations, "\n") != strings.Join(want, "\n") {
		t.Fatalf("operations:\n got=%q\nwant=%q", session.operations, want)
	}
	if statement != strings.TrimPrefix(want[1], "query:") || result.Stats.TotalDurationMs != 0.6 || result.Nodes[0].CostShare != 1 {
		t.Fatalf("statement=%q stats=%+v nodes=%+v", statement, result.Stats, result.Nodes)
	}
}

func TestDiagnoseQueryWithOptionsRefusesAnalyzeWhereUnsupported(t *testing.T) {
	app := NewApp()
	for _, dbType := range []string{"clickhouse", "oceanbase", "sqlite"} {
		if explainAnalyzeSupported(dbType) {
			t.Fatalf("%s must not offer a measured run yet", dbType)
		}
		result := app.DiagnoseQueryWithOptions(connection.ConnectionConfig{Type: dbType, Host: "127.0.0.1"}, "", "SELECT 1", connection.DiagnoseOptions{Analyze: true})
		if result.Success || !strings.Contains(result.Message, dbType) {
			t.Fatalf("%s: %+v", dbType, result)
		}
	}
	for _, dbType := range []string{"mysql", "mariadb", "postgres", "kingbase", "highgo", "vastbase", "sqlserver", "oracle"} {
		if !explainAnalyzeSupported(dbType) {
			t.Fatalf("%s should offer a measured run", dbType)
		}
	}
	// OceanBase's Oracle mode reads plans like Oracle but has no cursor statistics.
	oceanBaseOracle := connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "oracle"}
	if dbType := resolveExplainDBType(oceanBaseOracle); dbType != "oracle" || explainAnalyzeSupportedFor(oceanBaseOracle, dbType) {
		t.Fatalf("OceanBase Oracle mode resolved to %q and must not offer a measured run", dbType)
	}
	if !explainAnalyzeSupportedFor(connection.ConnectionConfig{Type: "oracle"}, "oracle") {
		t.Fatalf("Oracle itself should offer a measured run")
	}
}

func TestExplainAnalyzeErrorExplainsOldMySQL(t *testing.T) {
	ctx := context.Background()
	old := errors.New("Error 1064 (42000): You have an error in your SQL syntax; check the manual near 'ANALYZE SELECT 1' at line 1")
	got := explainAnalyzeError(ctx, "mysql", time.Minute, old, defaultExplainBackendText)
	if !strings.Contains(got.Error(), "8.0.18") {
		t.Fatalf("old MySQL error = %v", got)
	}
	other := explainAnalyzeError(ctx, "postgres", time.Minute, errors.New("permission denied for table t"), defaultExplainBackendText)
	if !strings.Contains(other.Error(), "permission denied for table t") {
		t.Fatalf("other error = %v", other)
	}
}
