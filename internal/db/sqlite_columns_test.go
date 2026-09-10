//go:build gonavi_full_drivers || gonavi_sqlite_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestSQLiteGetColumnsMarksCompositePrimaryKeyMembers(t *testing.T) {
	client := &SQLiteDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "sqlite", Host: ":memory:"}); err != nil {
		t.Fatalf("连接 SQLite 失败: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	if _, err := client.conn.Exec(`CREATE TABLE composite_pk (a INTEGER NOT NULL, b INTEGER NOT NULL, c TEXT, PRIMARY KEY(a, b))`); err != nil {
		t.Fatalf("创建复合主键表失败: %v", err)
	}

	columns, err := client.GetColumns("main", "composite_pk")
	if err != nil {
		t.Fatalf("GetColumns 失败: %v", err)
	}
	got := map[string]string{}
	for _, col := range columns {
		got[col.Name] = col.Key
		if col.Extra != "" {
			t.Fatalf("复合主键列不应标记自增: %+v", col)
		}
	}
	if got["a"] != "PRI" || got["b"] != "PRI" {
		t.Fatalf("PRIMARY KEY(a,b) 两列均应标记 PRI，实际=%v", got)
	}
	if got["c"] != "" {
		t.Fatalf("非主键列不应标记 PRI: %q", got["c"])
	}
}

func TestSQLiteGetColumnsPreservesPrimaryKeyOrdinal(t *testing.T) {
	client := &SQLiteDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "sqlite", Host: ":memory:"}); err != nil {
		t.Fatalf("连接 SQLite 失败: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	// 列声明顺序与主键序号不同：b 在前但 PRIMARY KEY(a,b)。
	if _, err := client.conn.Exec(`CREATE TABLE ordinal_pk (b INTEGER NOT NULL, a INTEGER NOT NULL, PRIMARY KEY(a, b))`); err != nil {
		t.Fatalf("创建错序复合主键表失败: %v", err)
	}

	columns, err := client.GetColumns("main", "ordinal_pk")
	if err != nil {
		t.Fatalf("GetColumns 失败: %v", err)
	}
	if len(columns) != 2 || columns[0].Name != "b" || columns[1].Name != "a" {
		t.Fatalf("列顺序应保持声明顺序，实际=%#v", columns)
	}
	if columns[0].Key != "PRI" || columns[1].Key != "PRI" {
		t.Fatalf("错序复合主键两列均应标记 PRI: %#v", columns)
	}

	data, _, err := client.Query("PRAGMA table_info('ordinal_pk')")
	if err != nil {
		t.Fatalf("PRAGMA table_info 失败: %v", err)
	}
	_, pkNames := sqliteTableInfoColumns(data)
	if !reflect.DeepEqual(pkNames, []string{"a", "b"}) {
		t.Fatalf("主键序号应为 [a b]，实际=%#v", pkNames)
	}
}

func TestSQLiteGetColumnsMarksSingleColumnPrimaryAndAutoIncrement(t *testing.T) {
	client := &SQLiteDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "sqlite", Host: ":memory:"}); err != nil {
		t.Fatalf("连接 SQLite 失败: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	if _, err := client.conn.Exec(`CREATE TABLE plain_pk (id INTEGER PRIMARY KEY, name TEXT)`); err != nil {
		t.Fatalf("创建单列主键表失败: %v", err)
	}
	if _, err := client.conn.Exec(`CREATE TABLE auto_pk (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`); err != nil {
		t.Fatalf("创建 AUTOINCREMENT 表失败: %v", err)
	}

	plain, err := client.GetColumns("main", "plain_pk")
	if err != nil {
		t.Fatalf("GetColumns(plain_pk) 失败: %v", err)
	}
	if len(plain) != 2 || plain[0].Name != "id" || plain[0].Key != "PRI" || plain[0].Extra != "" {
		t.Fatalf("单列主键应标记 PRI 且无自增: %#v", plain)
	}
	if plain[1].Key != "" || plain[1].Extra != "" {
		t.Fatalf("非主键列不应带 PRI/自增: %#v", plain[1])
	}

	autoCols, err := client.GetColumnsContext(nil, "main", "auto_pk")
	if err != nil {
		t.Fatalf("GetColumnsContext(auto_pk) 失败: %v", err)
	}
	if len(autoCols) != 2 || autoCols[0].Name != "id" || autoCols[0].Key != "PRI" || autoCols[0].Extra != "auto_increment" {
		t.Fatalf("AUTOINCREMENT 主键应标记 PRI+auto_increment: %#v", autoCols)
	}
	if autoCols[1].Extra != "" {
		t.Fatalf("非主键列不应标记自增: %#v", autoCols[1])
	}
}

func TestSQLiteTableInfoColumnsCoversPragmaValueShapes(t *testing.T) {
	t.Parallel()

	columns, pkNames := sqliteTableInfoColumns([]map[string]interface{}{
		{
			"name":       "b",
			"type":       "INTEGER",
			"notnull":    int(1),
			"pk":         int64(2),
			"dflt_value": nil,
		},
		{
			"NAME":       "a",
			"TYPE":       "INTEGER",
			"NOTNULL":    "1",
			"PK":         " 1 ",
			"DFLT_VALUE": 0,
		},
		{
			"name":       "note",
			"type":       "TEXT",
			"notnull":    float64(0),
			"pk":         uint(0),
			"dflt_value": "x",
		},
		{
			"name": "orphan",
		},
	})

	if len(columns) != 4 {
		t.Fatalf("unexpected column count: %d", len(columns))
	}
	if columns[0].Name != "b" || columns[0].Type != "INTEGER" || columns[0].Nullable != "NO" || columns[0].Key != "PRI" {
		t.Fatalf("first PK member = %+v", columns[0])
	}
	if columns[1].Name != "a" || columns[1].Type != "INTEGER" || columns[1].Nullable != "NO" || columns[1].Key != "PRI" {
		t.Fatalf("second PK member = %+v", columns[1])
	}
	if columns[1].Default == nil || *columns[1].Default != "0" {
		t.Fatalf("uppercase default = %#v", columns[1].Default)
	}
	if columns[2].Name != "note" || columns[2].Nullable != "YES" || columns[2].Key != "" {
		t.Fatalf("non-key column = %+v", columns[2])
	}
	if columns[2].Default == nil || *columns[2].Default != "x" {
		t.Fatalf("lowercase default = %#v", columns[2].Default)
	}
	if columns[3].Name != "orphan" || columns[3].Type != "" || columns[3].Nullable != "YES" || columns[3].Key != "" || columns[3].Default != nil {
		t.Fatalf("missing-field column = %+v", columns[3])
	}
	if !reflect.DeepEqual(pkNames, []string{"a", "b"}) {
		t.Fatalf("pk ordinal names = %#v, want [a b]", pkNames)
	}
	if columns[0].Default != nil {
		t.Fatalf("nil default should stay unset, got %v", *columns[0].Default)
	}
}

func TestSQLiteGetColumnsRequiresOpenConnection(t *testing.T) {
	_, err := (&SQLiteDB{}).GetColumns("main", "orders")
	if err == nil || !strings.Contains(err.Error(), "连接未打开") {
		t.Fatalf("未打开连接应失败，实际=%v", err)
	}
}

type sqliteColumnsScenarioDriver struct{}

type sqliteColumnsScenarioConn struct {
	scenario string
}

type sqliteColumnsScenarioStmt struct {
	scenario string
	query    string
}

type sqliteColumnsScenarioRows struct {
	columns []string
	values  [][]driver.Value
	index   int
}

var registerSQLiteColumnsScenarioDriverOnce sync.Once

func (sqliteColumnsScenarioDriver) Open(name string) (driver.Conn, error) {
	return sqliteColumnsScenarioConn{scenario: name}, nil
}

func (c sqliteColumnsScenarioConn) Prepare(query string) (driver.Stmt, error) {
	return sqliteColumnsScenarioStmt{scenario: c.scenario, query: query}, nil
}

func (sqliteColumnsScenarioConn) Close() error { return nil }

func (sqliteColumnsScenarioConn) Begin() (driver.Tx, error) {
	return nil, errors.New("not supported")
}

func (sqliteColumnsScenarioStmt) Close() error { return nil }

func (sqliteColumnsScenarioStmt) NumInput() int { return -1 }

func (sqliteColumnsScenarioStmt) Exec(args []driver.Value) (driver.Result, error) {
	return driver.RowsAffected(0), nil
}

func (s sqliteColumnsScenarioStmt) Query(args []driver.Value) (driver.Rows, error) {
	isTableInfo := strings.Contains(s.query, "table_info(")
	isDDL := strings.Contains(s.query, "sqlite_master")
	switch s.scenario {
	case "pragma_error":
		if isTableInfo {
			return nil, errors.New("pragma failed")
		}
	case "ddl_error":
		if isTableInfo {
			return sqliteCompositeTableInfoRows(), nil
		}
		if isDDL {
			return nil, errors.New("sqlite_master failed")
		}
	case "ddl_empty":
		if isTableInfo {
			return sqliteCompositeTableInfoRows(), nil
		}
		if isDDL {
			return &sqliteColumnsScenarioRows{columns: []string{"sql"}}, nil
		}
	case "ddl_nil_sql":
		if isTableInfo {
			return sqliteCompositeTableInfoRows(), nil
		}
		if isDDL {
			return &sqliteColumnsScenarioRows{
				columns: []string{"sql"},
				values:  [][]driver.Value{{nil}},
			}, nil
		}
	case "ddl_missing_sql":
		if isTableInfo {
			return sqliteCompositeTableInfoRows(), nil
		}
		if isDDL {
			return &sqliteColumnsScenarioRows{
				columns: []string{"name"},
				values:  [][]driver.Value{{"composite_pk"}},
			}, nil
		}
	case "uppercase_composite":
		if isTableInfo {
			return &sqliteColumnsScenarioRows{
				columns: []string{"CID", "NAME", "TYPE", "NOTNULL", "DFLT_VALUE", "PK"},
				values: [][]driver.Value{
					{int64(0), "a", "INTEGER", int64(1), nil, int64(1)},
					{int64(1), "b", "INTEGER", int64(1), "7", int64(2)},
				},
			}, nil
		}
		if isDDL {
			return &sqliteColumnsScenarioRows{
				columns: []string{"sql"},
				values:  [][]driver.Value{{"CREATE TABLE composite_pk (a INTEGER, b INTEGER, PRIMARY KEY(a, b))"}},
			}, nil
		}
	default:
		return nil, errors.New("unexpected columns scenario")
	}
	return nil, errors.New("unexpected metadata query")
}

func sqliteCompositeTableInfoRows() *sqliteColumnsScenarioRows {
	return &sqliteColumnsScenarioRows{
		columns: []string{"cid", "name", "type", "notnull", "dflt_value", "pk"},
		values: [][]driver.Value{
			{int64(0), "a", "INTEGER", int64(1), nil, int64(1)},
			{int64(1), "b", "INTEGER", int64(1), nil, int64(2)},
		},
	}
}

func (r *sqliteColumnsScenarioRows) Columns() []string { return r.columns }

func (r *sqliteColumnsScenarioRows) Close() error { return nil }

func (r *sqliteColumnsScenarioRows) Next(dest []driver.Value) error {
	if r.index >= len(r.values) {
		return io.EOF
	}
	copy(dest, r.values[r.index])
	r.index++
	return nil
}

func openSQLiteColumnsScenarioDB(t *testing.T, scenario string) *sql.DB {
	t.Helper()
	registerSQLiteColumnsScenarioDriverOnce.Do(func() {
		sql.Register("sqlite_columns_scenario", sqliteColumnsScenarioDriver{})
	})
	conn, err := sql.Open("sqlite_columns_scenario", scenario)
	if err != nil {
		t.Fatalf("open sqlite_columns_scenario %s: %v", scenario, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func TestSQLiteGetColumnsContextHandlesTableInfoAndDDLLookups(t *testing.T) {
	t.Run("pragma error", func(t *testing.T) {
		database := &SQLiteDB{conn: openSQLiteColumnsScenarioDB(t, "pragma_error")}
		_, err := database.GetColumns("main", "composite_pk")
		if err == nil || !strings.Contains(err.Error(), "pragma failed") {
			t.Fatalf("expected pragma error, got %v", err)
		}
	})

	t.Run("ddl lookup error keeps columns", func(t *testing.T) {
		database := &SQLiteDB{conn: openSQLiteColumnsScenarioDB(t, "ddl_error")}
		columns, err := database.GetColumns("main", "composite_pk")
		if err != nil {
			t.Fatalf("DDL 失败应跳过，实际=%v", err)
		}
		assertCompositePRI(t, columns)
	})

	t.Run("empty ddl rows", func(t *testing.T) {
		database := &SQLiteDB{conn: openSQLiteColumnsScenarioDB(t, "ddl_empty")}
		columns, err := database.GetColumns("main", "composite_pk")
		if err != nil {
			t.Fatalf("空 DDL 应跳过，实际=%v", err)
		}
		assertCompositePRI(t, columns)
	})

	t.Run("nil ddl sql", func(t *testing.T) {
		database := &SQLiteDB{conn: openSQLiteColumnsScenarioDB(t, "ddl_nil_sql")}
		columns, err := database.GetColumns("main", "composite_pk")
		if err != nil {
			t.Fatalf("nil DDL 应跳过，实际=%v", err)
		}
		assertCompositePRI(t, columns)
	})

	t.Run("missing ddl sql column", func(t *testing.T) {
		database := &SQLiteDB{conn: openSQLiteColumnsScenarioDB(t, "ddl_missing_sql")}
		columns, err := database.GetColumns("main", "composite_pk")
		if err != nil {
			t.Fatalf("缺少 sql 列应跳过，实际=%v", err)
		}
		assertCompositePRI(t, columns)
	})

	t.Run("uppercase pragma keys", func(t *testing.T) {
		database := &SQLiteDB{conn: openSQLiteColumnsScenarioDB(t, "uppercase_composite")}
		columns, err := database.GetColumnsContext(context.Background(), "main", "composite_pk")
		if err != nil {
			t.Fatalf("uppercase GetColumnsContext 失败: %v", err)
		}
		assertCompositePRI(t, columns)
		if columns[1].Default == nil || *columns[1].Default != "7" {
			t.Fatalf("uppercase default 未保留: %#v", columns[1].Default)
		}
	})
}

func assertCompositePRI(t *testing.T, columns []connection.ColumnDefinition) {
	t.Helper()
	if len(columns) != 2 || columns[0].Name != "a" || columns[0].Key != "PRI" || columns[1].Name != "b" || columns[1].Key != "PRI" {
		t.Fatalf("expected composite PRI columns, got %#v", columns)
	}
	for _, col := range columns {
		if col.Extra != "" {
			t.Fatalf("composite PK must not be auto_increment: %+v", col)
		}
	}
}
