//go:build gonavi_full_drivers || gonavi_tdengine_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/shared/i18n"
)

const tdengineRecordingDriverName = "gonavi_tdengine_recording"

var (
	registerTDengineRecordingDriverOnce sync.Once
	tdengineRecordingDriverMu           sync.Mutex
	tdengineRecordingDriverSeq          int
	tdengineRecordingDriverStates       = map[string]*tdengineRecordingState{}
)

type tdengineRecordingState struct {
	mu           sync.Mutex
	queries      []string
	execErr      error
	queryResults map[string]tdengineQueryResult
}

func (s *tdengineRecordingState) snapshotQueries() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	queries := make([]string, len(s.queries))
	copy(queries, s.queries)
	return queries
}

type tdengineQueryResult struct {
	columns []string
	rows    [][]driver.Value
	err     error
}

type tdengineRecordingDriver struct{}

func (tdengineRecordingDriver) Open(name string) (driver.Conn, error) {
	tdengineRecordingDriverMu.Lock()
	state := tdengineRecordingDriverStates[name]
	tdengineRecordingDriverMu.Unlock()
	if state == nil {
		return nil, fmt.Errorf("recording state not found: %s", name)
	}
	return &tdengineRecordingConn{state: state}, nil
}

type tdengineRecordingConn struct {
	state *tdengineRecordingState
}

func (c *tdengineRecordingConn) Prepare(query string) (driver.Stmt, error) {
	return nil, fmt.Errorf("prepare not supported in tdengine recording driver: %s", query)
}

func (c *tdengineRecordingConn) Close() error { return nil }

func (c *tdengineRecordingConn) Begin() (driver.Tx, error) {
	return nil, fmt.Errorf("transactions not supported in tdengine recording driver")
}

func (c *tdengineRecordingConn) ExecContext(_ context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if len(args) > 0 {
		return nil, fmt.Errorf("unexpected exec args: %d", len(args))
	}
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	if c.state.execErr != nil {
		return nil, c.state.execErr
	}
	c.state.queries = append(c.state.queries, query)
	return driver.RowsAffected(1), nil
}

var _ driver.ExecerContext = (*tdengineRecordingConn)(nil)

func (c *tdengineRecordingConn) QueryContext(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if len(args) > 0 {
		return nil, fmt.Errorf("unexpected query args: %d", len(args))
	}
	c.state.mu.Lock()
	defer c.state.mu.Unlock()
	c.state.queries = append(c.state.queries, query)
	if result, ok := c.state.queryResults[query]; ok {
		if result.err != nil {
			return nil, result.err
		}
		return &tdengineRecordingRows{columns: result.columns, rows: result.rows}, nil
	}
	return &tdengineRecordingRows{}, nil
}

var _ driver.QueryerContext = (*tdengineRecordingConn)(nil)

type tdengineRecordingRows struct {
	columns []string
	rows    [][]driver.Value
	index   int
}

func (r *tdengineRecordingRows) Columns() []string {
	return append([]string(nil), r.columns...)
}

func (r *tdengineRecordingRows) Close() error { return nil }

func (r *tdengineRecordingRows) Next(dest []driver.Value) error {
	if r.index >= len(r.rows) {
		return io.EOF
	}
	row := r.rows[r.index]
	for idx := range dest {
		if idx < len(row) {
			dest[idx] = row[idx]
		}
	}
	r.index++
	return nil
}

func openTDengineRecordingDB(t *testing.T) (*sql.DB, *tdengineRecordingState) {
	t.Helper()
	registerTDengineRecordingDriverOnce.Do(func() {
		sql.Register(tdengineRecordingDriverName, tdengineRecordingDriver{})
	})

	tdengineRecordingDriverMu.Lock()
	tdengineRecordingDriverSeq++
	dsn := fmt.Sprintf("tdengine-recording-%d", tdengineRecordingDriverSeq)
	state := &tdengineRecordingState{queryResults: map[string]tdengineQueryResult{}}
	tdengineRecordingDriverStates[dsn] = state
	tdengineRecordingDriverMu.Unlock()

	dbConn, err := sql.Open(tdengineRecordingDriverName, dsn)
	if err != nil {
		t.Fatalf("打开 recording db 失败: %v", err)
	}

	t.Cleanup(func() {
		_ = dbConn.Close()
		tdengineRecordingDriverMu.Lock()
		delete(tdengineRecordingDriverStates, dsn)
		tdengineRecordingDriverMu.Unlock()
	})

	return dbConn, state
}

func TestTDengineQueryContextReturnsRowsAndColumns(t *testing.T) {
	t.Parallel()

	dbConn, state := openTDengineRecordingDB(t)
	td := &TDengineDB{conn: dbConn}
	query := "SELECT ts, current FROM meters ORDER BY ts DESC LIMIT 1"
	state.queryResults[query] = tdengineQueryResult{
		columns: []string{"ts", "current"},
		rows: [][]driver.Value{
			{"2026-07-19 00:00:00.000", 10.2},
		},
	}

	rows, columns, err := td.QueryContext(context.Background(), query)
	if err != nil {
		t.Fatalf("TDengine QueryContext returned error: %v", err)
	}
	if !reflect.DeepEqual(columns, []string{"ts", "current"}) {
		t.Fatalf("TDengine QueryContext columns = %#v", columns)
	}
	if len(rows) != 1 || rows[0]["ts"] != "2026-07-19 00:00:00.000" || rows[0]["current"] != 10.2 {
		t.Fatalf("TDengine QueryContext rows = %#v, want one data row", rows)
	}
}

func TestTDengineApplyChanges_InsertsIntoQualifiedTable(t *testing.T) {
	t.Parallel()

	dbConn, state := openTDengineRecordingDB(t)
	td := &TDengineDB{conn: dbConn}

	changes := connection.ChangeSet{
		Inserts: []map[string]interface{}{
			{
				"ts":      "2026-03-09 10:00:00",
				"value":   12.5,
				"device":  "sensor-a",
				"enabled": true,
			},
		},
	}

	if err := td.ApplyChanges("analytics.metrics", changes); err != nil {
		t.Fatalf("ApplyChanges 返回错误: %v", err)
	}

	queries := state.snapshotQueries()
	if len(queries) != 1 {
		t.Fatalf("期望执行 1 条 SQL，实际 %d 条: %#v", len(queries), queries)
	}

	want := "INSERT INTO `analytics`.`metrics` (`device`, `enabled`, `ts`, `value`) VALUES ('sensor-a', 1, '2026-03-09 10:00:00', 12.5)"
	if queries[0] != want {
		t.Fatalf("插入 SQL 不符合预期\nwant: %s\n got: %s", want, queries[0])
	}
}

func TestTDengineApplyChanges_RejectsMixedUpdatesWithoutPartialWrite(t *testing.T) {
	t.Parallel()

	dbConn, state := openTDengineRecordingDB(t)
	td := &TDengineDB{conn: dbConn}

	changes := connection.ChangeSet{
		Inserts: []map[string]interface{}{{
			"ts":    "2026-03-09 10:00:00",
			"value": 12.5,
		}},
		Updates: []connection.UpdateRow{{
			Keys:   map[string]interface{}{"ts": "2026-03-09 10:00:00"},
			Values: map[string]interface{}{"value": 18.8},
		}},
	}

	err := td.ApplyChanges("metrics", changes)
	if err == nil {
		t.Fatalf("期望 mixed changes 被拒绝")
	}
	if !strings.Contains(err.Error(), "UPDATE/DELETE") {
		t.Fatalf("错误信息未说明限制边界: %v", err)
	}
	if queries := state.snapshotQueries(); len(queries) != 0 {
		t.Fatalf("期望拒绝 mixed changes 时不执行任何 SQL，实际=%#v", queries)
	}
}

func rawTDengineConnectionNotOpenText() string {
	return string([]rune{0x8fde, 0x63a5, 0x672a, 0x6253, 0x5f00})
}

func rawTDengineTableNameRequiredText() string {
	return string([]rune{0x8868, 0x540d, 0x4e0d, 0x80fd, 0x4e3a, 0x7a7a})
}

func rawTDengineApplyChangesInsertOnlyText() string {
	return string([]rune{
		0x0054, 0x0044, 0x0065, 0x006e, 0x0067, 0x0069, 0x006e, 0x0065, 0x0020,
		0x76ee, 0x6807, 0x7aef, 0x5f53, 0x524d, 0x4ec5, 0x652f, 0x6301,
		0x0020, 0x0049, 0x004e, 0x0053, 0x0045, 0x0052, 0x0054, 0x0020,
		0x5199, 0x5165, 0xff0c, 0x6682, 0x4e0d, 0x652f, 0x6301, 0x0020,
		0x0055, 0x0050, 0x0044, 0x0041, 0x0054, 0x0045, 0x002f, 0x0044,
		0x0045, 0x004c, 0x0045, 0x0054, 0x0045, 0x0020, 0x5dee, 0x5f02,
		0x540c, 0x6b65, 0xff0c, 0x8bf7, 0x6539, 0x7528, 0x4ec5, 0x63d2,
		0x5165, 0x6216, 0x5168, 0x91cf, 0x8986, 0x76d6, 0x6a21, 0x5f0f,
	})
}

func tdengineApplyChangesI18nKeys() []string {
	return []string{
		"db.backend.error.connection_not_open",
		"db.backend.error.table_name_required",
		"db.backend.error.tdengine_apply_changes_insert_only",
	}
}

func TestTDengineApplyChangesErrorsUseCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	t.Run("connection not open", func(t *testing.T) {
		td := &TDengineDB{}
		err := td.ApplyChanges("metrics", connection.ChangeSet{})
		if err == nil {
			t.Fatal("expected connection-not-open error")
		}
		if err.Error() != "Connection is not open" {
			t.Fatalf("expected English connection-not-open error, got %q", err.Error())
		}
		if strings.Contains(err.Error(), rawTDengineConnectionNotOpenText()) {
			t.Fatalf("expected no raw Chinese connection-not-open text, got %q", err.Error())
		}
	})

	t.Run("table name required", func(t *testing.T) {
		dbConn, _ := openTDengineRecordingDB(t)
		td := &TDengineDB{conn: dbConn}
		err := td.ApplyChanges(" ", connection.ChangeSet{})
		if err == nil {
			t.Fatal("expected table-name-required error")
		}
		if err.Error() != "Table name is required" {
			t.Fatalf("expected English table-name-required error, got %q", err.Error())
		}
		if strings.Contains(err.Error(), rawTDengineTableNameRequiredText()) {
			t.Fatalf("expected no raw Chinese table-name-required text, got %q", err.Error())
		}
	})

	t.Run("update delete unsupported", func(t *testing.T) {
		dbConn, state := openTDengineRecordingDB(t)
		td := &TDengineDB{conn: dbConn}
		changes := connection.ChangeSet{
			Deletes: []map[string]interface{}{
				{"ts": "2026-03-09 10:00:00"},
			},
		}

		err := td.ApplyChanges("metrics", changes)
		if err == nil {
			t.Fatal("expected TDengine insert-only error")
		}
		want := "TDengine targets currently support only INSERT writes; UPDATE/DELETE differences are not supported by ApplyChanges"
		if err.Error() != want {
			t.Fatalf("expected %q, got %q", want, err.Error())
		}
		if strings.Contains(err.Error(), rawTDengineApplyChangesInsertOnlyText()) {
			t.Fatalf("expected no raw Chinese insert-only text, got %q", err.Error())
		}
		if queries := state.snapshotQueries(); len(queries) != 0 {
			t.Fatalf("expected no SQL execution after insert-only rejection, got %#v", queries)
		}
	})
}

func TestTDengineApplyChangesCatalogKeysExist(t *testing.T) {
	catalogs, err := i18n.LoadCatalogs()
	if err != nil {
		t.Fatalf("LoadCatalogs() error = %v", err)
	}

	for _, language := range i18n.SupportedLanguages() {
		catalog := catalogs[language]
		for _, key := range tdengineApplyChangesI18nKeys() {
			value := strings.TrimSpace(catalog[key])
			if value == "" {
				t.Fatalf("%s catalog missing TDengine ApplyChanges key %q", language, key)
			}
			if strings.Contains(value, "{{") || strings.Contains(value, "}}") {
				t.Fatalf("%s catalog key %q should not use placeholders, got %q", language, key, value)
			}
		}
	}
}

func TestTDengineGetTablesIncludesSuperTables(t *testing.T) {
	t.Parallel()

	dbConn, state := openTDengineRecordingDB(t)
	state.mu.Lock()
	state.queryResults["SHOW TABLES FROM `metrics`"] = tdengineQueryResult{
		columns: []string{"name"},
		rows: [][]driver.Value{
			{"d001"},
			{"d002"},
		},
	}
	state.queryResults["SHOW STABLES FROM `metrics`"] = tdengineQueryResult{
		columns: []string{"name"},
		rows: [][]driver.Value{
			{"meters"},
		},
	}
	state.mu.Unlock()

	td := &TDengineDB{conn: dbConn}
	tables, err := td.GetTables("metrics")
	if err != nil {
		t.Fatalf("GetTables returned error: %v", err)
	}

	want := []string{"d001", "d002", "meters"}
	if !reflect.DeepEqual(tables, want) {
		t.Fatalf("unexpected tables: got=%v want=%v", tables, want)
	}
}

func TestTDengineGetTablesFallsBackToLegacyFromSyntax(t *testing.T) {
	t.Parallel()

	dbConn, state := openTDengineRecordingDB(t)
	state.mu.Lock()
	state.queryResults["SHOW TABLES FROM `metrics`"] = tdengineQueryResult{
		err: fmt.Errorf("[0x2600] syntax error near '`metrics`'"),
	}
	state.queryResults["SHOW STABLES FROM `metrics`"] = tdengineQueryResult{
		err: fmt.Errorf("[0x2600] syntax error near '`metrics`'"),
	}
	state.queryResults["SHOW TABLES FROM metrics"] = tdengineQueryResult{
		columns: []string{"name"},
		rows: [][]driver.Value{
			{"d001"},
		},
	}
	state.queryResults["SHOW STABLES FROM metrics"] = tdengineQueryResult{
		columns: []string{"name"},
		rows: [][]driver.Value{
			{"meters"},
		},
	}
	state.mu.Unlock()

	td := &TDengineDB{conn: dbConn}
	tables, err := td.GetTables("metrics")
	if err != nil {
		t.Fatalf("GetTables returned error: %v", err)
	}

	wantTables := []string{"d001", "meters"}
	if !reflect.DeepEqual(tables, wantTables) {
		t.Fatalf("unexpected tables: got=%v want=%v", tables, wantTables)
	}

	queries := state.snapshotQueries()
	wantQueries := []string{
		"SHOW TABLES FROM `metrics`",
		"SHOW STABLES FROM `metrics`",
		"SHOW TABLES FROM metrics",
		"SHOW STABLES FROM metrics",
		"SHOW TABLES",
		"SHOW STABLES",
	}
	if !reflect.DeepEqual(queries, wantQueries) {
		t.Fatalf("unexpected query sequence: got=%v want=%v", queries, wantQueries)
	}
}

func TestTDengineGetColumnsFallsBackToLegacyDescribeSyntax(t *testing.T) {
	t.Parallel()

	dbConn, state := openTDengineRecordingDB(t)
	state.mu.Lock()
	state.queryResults["DESCRIBE `metrics`.`meters`"] = tdengineQueryResult{
		err: fmt.Errorf("[0x2600] syntax error near '`metrics`.`meters`'"),
	}
	state.queryResults["DESCRIBE metrics.meters"] = tdengineQueryResult{
		columns: []string{"Field", "Type", "Note", "Null"},
		rows: [][]driver.Value{
			{"ts", "TIMESTAMP", "", "NO"},
			{"value", "DOUBLE", "", "YES"},
		},
	}
	state.mu.Unlock()

	td := &TDengineDB{conn: dbConn}
	columns, err := td.GetColumns("metrics", "meters")
	if err != nil {
		t.Fatalf("GetColumns returned error: %v", err)
	}

	if len(columns) != 2 {
		t.Fatalf("expected 2 columns, got %d", len(columns))
	}
	queries := state.snapshotQueries()
	wantQueries := []string{"DESCRIBE `metrics`.`meters`", "DESCRIBE metrics.meters"}
	if !reflect.DeepEqual(queries, wantQueries) {
		t.Fatalf("unexpected query sequence: got=%v want=%v", queries, wantQueries)
	}
}

func TestTDengineGetCreateStatementFallsBackToLegacySyntax(t *testing.T) {
	t.Parallel()

	dbConn, state := openTDengineRecordingDB(t)
	state.mu.Lock()
	state.queryResults["SHOW CREATE TABLE `metrics`.`meters`"] = tdengineQueryResult{
		err: fmt.Errorf("[0x2600] syntax error near '`metrics`.`meters`'"),
	}
	state.queryResults["SHOW CREATE STABLE `metrics`.`meters`"] = tdengineQueryResult{
		err: fmt.Errorf("[0x2600] syntax error near '`metrics`.`meters`'"),
	}
	state.queryResults["SHOW CREATE TABLE metrics.meters"] = tdengineQueryResult{
		columns: []string{"SQL"},
		rows: [][]driver.Value{
			{"CREATE TABLE metrics.meters (ts TIMESTAMP, value DOUBLE)"},
		},
	}
	state.mu.Unlock()

	td := &TDengineDB{conn: dbConn}
	ddl, err := td.GetCreateStatement("metrics", "meters")
	if err != nil {
		t.Fatalf("GetCreateStatement returned error: %v", err)
	}
	if ddl != "CREATE TABLE metrics.meters (ts TIMESTAMP, value DOUBLE)" {
		t.Fatalf("unexpected DDL: %q", ddl)
	}

	queries := state.snapshotQueries()
	wantQueries := []string{
		"SHOW CREATE TABLE `metrics`.`meters`",
		"SHOW CREATE STABLE `metrics`.`meters`",
		"SHOW CREATE TABLE metrics.meters",
	}
	if !reflect.DeepEqual(queries, wantQueries) {
		t.Fatalf("unexpected query sequence: got=%v want=%v", queries, wantQueries)
	}
}

func TestQuoteTDengineTablePreservesQuotedDottedTable(t *testing.T) {
	t.Parallel()

	if got := quoteTDengineTable("metrics", "`order.items`"); got != "`metrics`.`order.items`" {
		t.Fatalf("quoted dotted table = %q, want %q", got, "`metrics`.`order.items`")
	}
	if got := quoteTDengineTable("metrics", "metrics.`order.items`"); got != "`metrics`.`order.items`" {
		t.Fatalf("qualified quoted dotted table = %q, want %q", got, "`metrics`.`order.items`")
	}
}

func TestTDengineGetCreateStatementNotFoundUsesCurrentLanguage(t *testing.T) {
	SetBackendLanguage(i18n.LanguageEnUS)
	t.Cleanup(func() {
		SetBackendLanguage(i18n.LanguageZhCN)
	})

	dbConn, _ := openTDengineRecordingDB(t)
	td := &TDengineDB{conn: dbConn}

	_, err := td.GetCreateStatement("metrics", "meters")
	if err == nil {
		t.Fatal("expected CREATE TABLE not found error")
	}

	want := "The CREATE TABLE statement was not found"
	if err.Error() != want {
		t.Fatalf("expected %q, got %q", want, err.Error())
	}
	rawNotFoundText := "\u672a\u627e\u5230\u5efa\u8868\u8bed\u53e5"
	if strings.Contains(err.Error(), rawNotFoundText) {
		t.Fatalf("expected no raw Chinese CREATE TABLE not found text, got %q", err.Error())
	}
}
