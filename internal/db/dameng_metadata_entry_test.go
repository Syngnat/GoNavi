//go:build gonavi_full_drivers || gonavi_dameng_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"testing"
)

type damengMetadataCapture struct {
	queries []string
}

type damengMetadataConnector struct {
	capture *damengMetadataCapture
}

func (c damengMetadataConnector) Connect(context.Context) (driver.Conn, error) {
	return damengMetadataConn{capture: c.capture}, nil
}

func (damengMetadataConnector) Driver() driver.Driver { return damengMetadataDriver{} }

type damengMetadataDriver struct{}

func (damengMetadataDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("use sql.OpenDB with the test connector")
}

type damengMetadataConn struct {
	capture *damengMetadataCapture
}

func (c damengMetadataConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("prepared statements are not supported by this test driver")
}

func (damengMetadataConn) Close() error { return nil }

func (damengMetadataConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions are not supported by this test driver")
}

func (c damengMetadataConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	c.capture.queries = append(c.capture.queries, query)
	switch {
	case strings.Contains(query, "all_tables"):
		return &damengMetadataRows{columns: []string{"OWNER", "TABLE_NAME"}, values: [][]driver.Value{{"SALES'OPS", "ORDER'ITEMS"}}}, nil
	case strings.Contains(query, "DBMS_METADATA.GET_DDL"):
		return &damengMetadataRows{columns: []string{"DDL"}, values: [][]driver.Value{{"CREATE TABLE TEST"}}}, nil
	case strings.Contains(query, "all_triggers"):
		return &damengMetadataRows{columns: []string{"TRIGGER_NAME", "TRIGGER_TYPE", "TRIGGERING_EVENT"}}, nil
	case strings.Contains(query, "all_tab_comments"):
		return &damengMetadataRows{columns: []string{"TABLE_COMMENT"}}, nil
	default:
		return &damengMetadataRows{columns: []string{"TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "COL_COMMENT"}}, nil
	}
}

type damengMetadataRows struct {
	columns []string
	values  [][]driver.Value
	index   int
}

func (r *damengMetadataRows) Columns() []string { return r.columns }
func (r *damengMetadataRows) Close() error      { return nil }
func (r *damengMetadataRows) Next(dest []driver.Value) error {
	if r.index >= len(r.values) {
		return io.EOF
	}
	copy(dest, r.values[r.index])
	r.index++
	return nil
}

func openDamengMetadataCaptureDB(t *testing.T, capture *damengMetadataCapture) *sql.DB {
	t.Helper()
	db := sql.OpenDB(damengMetadataConnector{capture: capture})
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestDamengMetadataEntrypointsEscapeLiterals(t *testing.T) {
	t.Parallel()

	const schema = "Sales'Ops"
	const table = "Order'Items"
	const escapedSchema = "SALES''OPS"
	const escapedTable = "ORDER''ITEMS"

	tests := []struct {
		name string
		call func(*DamengDB) error
		want []string
	}{
		{
			name: "tables",
			call: func(db *DamengDB) error { _, err := db.GetTables(schema); return err },
			want: []string{escapedSchema},
		},
		{
			name: "create statement",
			call: func(db *DamengDB) error { _, err := db.GetCreateStatement(schema, table); return err },
			want: []string{escapedSchema, escapedTable},
		},
		{
			name: "triggers",
			call: func(db *DamengDB) error { _, err := db.GetTriggers(schema, table); return err },
			want: []string{escapedSchema, escapedTable},
		},
		{
			name: "all columns",
			call: func(db *DamengDB) error { _, err := db.GetAllColumns(schema); return err },
			want: []string{escapedSchema},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			capture := &damengMetadataCapture{}
			db := &DamengDB{conn: openDamengMetadataCaptureDB(t, capture)}
			if err := test.call(db); err != nil {
				t.Fatalf("metadata entrypoint returned error: %v", err)
			}
			if len(capture.queries) == 0 {
				t.Fatal("metadata entrypoint did not execute a query")
			}
			query := capture.queries[0]
			for _, want := range test.want {
				if !strings.Contains(query, want) {
					t.Fatalf("query should contain escaped literal %q, got: %s", want, query)
				}
			}
		})
	}
}

func TestDamengMetadataEntrypointsTreatWhitespaceSchemaAsEmpty(t *testing.T) {
	t.Parallel()

	capture := &damengMetadataCapture{}
	db := &DamengDB{conn: openDamengMetadataCaptureDB(t, capture)}
	if _, err := db.GetTables("  "); err != nil {
		t.Fatalf("GetTables returned error: %v", err)
	}
	if len(capture.queries) != 1 || !strings.Contains(capture.queries[0], "FROM user_tables") {
		t.Fatalf("whitespace schema should use current-schema table query, got: %v", capture.queries)
	}

	capture.queries = nil
	if _, err := db.GetCreateStatement("  ", "orders"); err != nil {
		t.Fatalf("GetCreateStatement returned error: %v", err)
	}
	if len(capture.queries) < 1 || strings.Contains(capture.queries[0], ", ''") || !strings.Contains(capture.queries[0], "GET_DDL('TABLE', 'ORDERS')") {
		t.Fatalf("whitespace schema should use current-schema DDL query, got: %v", capture.queries)
	}
}
