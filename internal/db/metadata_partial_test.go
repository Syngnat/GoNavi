//go:build gonavi_full_drivers || gonavi_sqlite_driver

package db

import (
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
)

type sqlitePartialMetadataDriver struct{}

type sqlitePartialMetadataConn struct{}

type sqlitePartialMetadataStmt struct {
	query string
}

type sqlitePartialMetadataRows struct {
	columns []string
	values  [][]driver.Value
	index   int
}

var registerSQLitePartialMetadataDriverOnce sync.Once

func (sqlitePartialMetadataDriver) Open(name string) (driver.Conn, error) {
	return sqlitePartialMetadataConn{}, nil
}

func (sqlitePartialMetadataConn) Prepare(query string) (driver.Stmt, error) {
	return sqlitePartialMetadataStmt{query: query}, nil
}

func (sqlitePartialMetadataConn) Close() error { return nil }

func (sqlitePartialMetadataConn) Begin() (driver.Tx, error) { return nil, errors.New("not supported") }

func (sqlitePartialMetadataStmt) Close() error { return nil }

func (sqlitePartialMetadataStmt) NumInput() int { return -1 }

func (sqlitePartialMetadataStmt) Exec(args []driver.Value) (driver.Result, error) {
	return driver.RowsAffected(0), nil
}

func (s sqlitePartialMetadataStmt) Query(args []driver.Value) (driver.Rows, error) {
	switch {
	case strings.Contains(s.query, "sqlite_master"):
		return &sqlitePartialMetadataRows{
			columns: []string{"name"},
			values:  [][]driver.Value{{"healthy"}, {"restricted"}},
		}, nil
	case strings.Contains(s.query, "table_info('healthy')"):
		return &sqlitePartialMetadataRows{
			columns: []string{"cid", "name", "type", "notnull", "dflt_value", "pk"},
			values:  [][]driver.Value{{int64(0), "id", "INTEGER", int64(1), nil, int64(1)}},
		}, nil
	case strings.Contains(s.query, "table_info('restricted')"):
		return nil, errors.New("metadata permission denied password=secret-token")
	default:
		return nil, errors.New("unexpected metadata query")
	}
}

func (r *sqlitePartialMetadataRows) Columns() []string { return r.columns }

func (r *sqlitePartialMetadataRows) Close() error { return nil }

func (r *sqlitePartialMetadataRows) Next(dest []driver.Value) error {
	if r.index >= len(r.values) {
		return io.EOF
	}
	copy(dest, r.values[r.index])
	r.index++
	return nil
}

func openSQLitePartialMetadataDB(t *testing.T) *sql.DB {
	t.Helper()
	registerSQLitePartialMetadataDriverOnce.Do(func() {
		sql.Register("sqlite_partial_metadata", sqlitePartialMetadataDriver{})
	})

	conn, err := sql.Open("sqlite_partial_metadata", "")
	if err != nil {
		t.Fatalf("open SQLite partial metadata test DB failed: %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})
	return conn
}

func TestSQLiteGetAllColumnsReturnsPartialErrorWithSafeObjectWarnings(t *testing.T) {
	database := &SQLiteDB{conn: openSQLitePartialMetadataDB(t)}

	columns, err := database.GetAllColumns("main")
	if len(columns) != 1 || columns[0].TableName != "healthy" || columns[0].Name != "id" {
		t.Fatalf("expected successful table columns to be preserved, got %#v", columns)
	}

	var partialErr *PartialMetadataError
	if !errors.As(err, &partialErr) {
		t.Fatalf("expected PartialMetadataError, got %v", err)
	}
	warnings := partialErr.Warnings()
	if len(warnings) != 1 || !strings.Contains(warnings[0], "restricted") {
		t.Fatalf("expected warning for restricted table, got %#v", warnings)
	}
	if strings.Contains(warnings[0], "secret-token") {
		t.Fatalf("metadata warning leaked sensitive detail: %q", warnings[0])
	}
}
