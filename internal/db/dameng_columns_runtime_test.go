//go:build gonavi_full_drivers || gonavi_dameng_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
)

type damengColumnsMetadataDriver struct{}

type damengColumnsMetadataConn struct{}

type damengColumnsMetadataRows struct {
	columns []string
	values  [][]driver.Value
	index   int
}

var registerDamengColumnsMetadataDriverOnce sync.Once

var damengColumnsMetadataQueryState struct {
	sync.Mutex
	failAutoIncrementQuery bool
	failColumnCommentQuery bool
	queries                []string
}

func (damengColumnsMetadataDriver) Open(name string) (driver.Conn, error) {
	return damengColumnsMetadataConn{}, nil
}

func (damengColumnsMetadataConn) Prepare(query string) (driver.Stmt, error) {
	return nil, errors.New("prepared statements are not supported by this test driver")
}

func (damengColumnsMetadataConn) Close() error { return nil }

func (damengColumnsMetadataConn) Begin() (driver.Tx, error) {
	return nil, errors.New("transactions are not supported by this test driver")
}

func (damengColumnsMetadataConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	damengColumnsMetadataQueryState.Lock()
	damengColumnsMetadataQueryState.queries = append(damengColumnsMetadataQueryState.queries, query)
	failAutoIncrementQuery := damengColumnsMetadataQueryState.failAutoIncrementQuery
	failColumnCommentQuery := damengColumnsMetadataQueryState.failColumnCommentQuery
	damengColumnsMetadataQueryState.Unlock()

	if strings.Contains(query, "DBMS_METADATA.GET_DDL") {
		return &damengColumnsMetadataRows{
			columns: []string{"DDL"},
			values: [][]driver.Value{{`CREATE TABLE "BIZ"."ORDERS" (
  "ID" NUMBER NOT NULL
)`}},
		}, nil
	}

	if strings.Contains(query, "all_tab_comments") {
		return &damengColumnsMetadataRows{
			columns: []string{"TABLE_COMMENT"},
			values:  [][]driver.Value{{"订单'归档"}},
		}, nil
	}

	if strings.Contains(query, "SYS.SYSCOLUMNCOMMENTS") {
		if failColumnCommentQuery {
			return nil, errors.New("insufficient privilege for SYS.SYSCOLUMNCOMMENTS")
		}
		return &damengColumnsMetadataRows{
			columns: []string{"COLUMN_NAME", "COL_COMMENT"},
			values: [][]driver.Value{
				{"ID", "订单主键"},
				{"NAME", "客户名称"},
			},
		}, nil
	}

	if strings.Contains(query, "SYS.SYSCOLUMNS") {
		if failAutoIncrementQuery {
			return nil, errors.New("insufficient privilege for SYS.SYSCOLUMNS")
		}
		return &damengColumnsMetadataRows{
			columns: []string{"COLUMN_NAME"},
			values:  [][]driver.Value{{"ID"}},
		}, nil
	}

	if strings.Contains(query, "all_ind_columns") {
		if !strings.Contains(query, "i.owner = c.index_owner AND i.index_name = c.index_name") {
			return nil, errors.New("ALL_IND_COLUMNS must join ALL_INDEXES through INDEX_OWNER")
		}
		return &damengColumnsMetadataRows{
			columns: []string{"INDEX_NAME", "COLUMN_NAME", "UNIQUENESS", "COLUMN_POSITION", "INDEX_TYPE"},
			values: [][]driver.Value{
				{"IDX_ORDERS_TENANT_CREATED", "TENANT_ID", "NONUNIQUE", int64(1), "NORMAL"},
				{"IDX_ORDERS_TENANT_CREATED", "CREATED_AT", "NONUNIQUE", int64(2), "NORMAL"},
			},
		}, nil
	}

	return &damengColumnsMetadataRows{
		columns: []string{
			"COLUMN_NAME", "DATA_TYPE", "DATA_LENGTH", "CHAR_LENGTH", "DATA_PRECISION",
			"DATA_SCALE", "NULLABLE", "DATA_DEFAULT", "COL_COMMENT", "COLUMN_KEY",
		},
		values: [][]driver.Value{
			{"ID", "NUMBER", nil, nil, int64(10), int64(0), "N", nil, "", "PRI"},
			{"NAME", "VARCHAR2", int64(64), int64(64), nil, nil, "Y", nil, "", ""},
		},
	}, nil
}

func (r *damengColumnsMetadataRows) Columns() []string { return r.columns }

func (r *damengColumnsMetadataRows) Close() error { return nil }

func (r *damengColumnsMetadataRows) Next(dest []driver.Value) error {
	if r.index >= len(r.values) {
		return io.EOF
	}
	copy(dest, r.values[r.index])
	r.index++
	return nil
}

func openDamengColumnsMetadataDB(t *testing.T) *sql.DB {
	t.Helper()

	registerDamengColumnsMetadataDriverOnce.Do(func() {
		sql.Register("dameng_columns_metadata", damengColumnsMetadataDriver{})
	})

	conn, err := sql.Open("dameng_columns_metadata", "")
	if err != nil {
		t.Fatalf("open dameng_columns_metadata test DB failed: %v", err)
	}
	t.Cleanup(func() {
		_ = conn.Close()
	})
	return conn
}

func resetDamengColumnsMetadataQueryState(t *testing.T, failAutoIncrementQuery, failColumnCommentQuery bool) {
	t.Helper()

	damengColumnsMetadataQueryState.Lock()
	damengColumnsMetadataQueryState.failAutoIncrementQuery = failAutoIncrementQuery
	damengColumnsMetadataQueryState.failColumnCommentQuery = failColumnCommentQuery
	damengColumnsMetadataQueryState.queries = nil
	damengColumnsMetadataQueryState.Unlock()
	t.Cleanup(func() {
		damengColumnsMetadataQueryState.Lock()
		damengColumnsMetadataQueryState.failAutoIncrementQuery = false
		damengColumnsMetadataQueryState.failColumnCommentQuery = false
		damengColumnsMetadataQueryState.queries = nil
		damengColumnsMetadataQueryState.Unlock()
	})
}

func damengColumnsMetadataQueries() []string {
	damengColumnsMetadataQueryState.Lock()
	defer damengColumnsMetadataQueryState.Unlock()
	return append([]string(nil), damengColumnsMetadataQueryState.queries...)
}

func TestDamengGetColumnsMarksAutoIncrementColumns(t *testing.T) {
	resetDamengColumnsMetadataQueryState(t, false, false)

	damengDB := &DamengDB{conn: openDamengColumnsMetadataDB(t)}
	columns, err := damengDB.GetColumns("biz", "orders")
	if err != nil {
		t.Fatalf("GetColumns returned error: %v", err)
	}
	if len(columns) != 2 {
		t.Fatalf("unexpected column count: %d", len(columns))
	}
	if columns[0].Extra != "auto_increment" {
		t.Fatalf("identity column should be marked as auto_increment: %+v", columns[0])
	}
	if columns[1].Extra != "" {
		t.Fatalf("non-identity column should not be marked: %+v", columns[1])
	}
	if columns[0].Comment != "订单主键" || columns[1].Comment != "客户名称" {
		t.Fatalf("native column comments should fill empty compatibility-view values: %+v", columns)
	}

	queries := damengColumnsMetadataQueries()
	if len(queries) != 3 || !strings.Contains(queries[1], "SYS.SYSCOLUMNCOMMENTS") || !strings.Contains(queries[2], "SYS.SYSCOLUMNS") {
		t.Fatalf("expected base, native comment, and system column metadata queries, got=%v", queries)
	}
}

func TestDamengGetColumnsKeepsBaseMetadataWhenAutoIncrementQueryFails(t *testing.T) {
	resetDamengColumnsMetadataQueryState(t, true, false)

	damengDB := &DamengDB{conn: openDamengColumnsMetadataDB(t)}
	columns, err := damengDB.GetColumns("biz", "orders")
	if err != nil {
		t.Fatalf("GetColumns should keep base metadata when auto-increment lookup fails: %v", err)
	}
	if len(columns) != 2 || columns[0].Name != "ID" || columns[0].Extra != "" {
		t.Fatalf("unexpected fallback columns: %+v", columns)
	}
}

func TestDamengGetColumnsKeepsBaseMetadataWhenNativeCommentQueryFails(t *testing.T) {
	resetDamengColumnsMetadataQueryState(t, false, true)

	damengDB := &DamengDB{conn: openDamengColumnsMetadataDB(t)}
	columns, err := damengDB.GetColumns("biz", "orders")
	if err != nil {
		t.Fatalf("GetColumns should keep base metadata when native comments are unavailable: %v", err)
	}
	if len(columns) != 2 || columns[0].Name != "ID" || columns[0].Extra != "auto_increment" {
		t.Fatalf("unexpected fallback columns: %+v", columns)
	}
}

func TestDamengGetCreateStatementAppendsTableComment(t *testing.T) {
	resetDamengColumnsMetadataQueryState(t, false, false)

	damengDB := &DamengDB{conn: openDamengColumnsMetadataDB(t)}
	ddl, err := damengDB.GetCreateStatement("biz", "orders")
	if err != nil {
		t.Fatalf("GetCreateStatement returned error: %v", err)
	}

	for _, want := range []string{
		`CREATE TABLE "BIZ"."ORDERS"`,
		`COMMENT ON TABLE "BIZ"."ORDERS" IS '订单''归档';`,
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("expected DDL to contain %q, got: %s", want, ddl)
		}
	}

	queries := damengColumnsMetadataQueries()
	if len(queries) != 2 || !strings.Contains(queries[1], "all_tab_comments") {
		t.Fatalf("expected DDL and table comment metadata queries, got=%v", queries)
	}
	if !strings.Contains(queries[1], "owner = 'BIZ'") || !strings.Contains(queries[1], "table_name = 'ORDERS'") {
		t.Fatalf("expected normalized schema and table comment predicates, got=%s", queries[1])
	}
}

func TestDamengGetIndexesUsesIndexOwnerJoinAndMapsColumnOrder(t *testing.T) {
	resetDamengColumnsMetadataQueryState(t, false, false)

	damengDB := &DamengDB{conn: openDamengColumnsMetadataDB(t)}
	indexes, err := damengDB.GetIndexes("biz", "orders")
	if err != nil {
		t.Fatalf("GetIndexes returned error: %v", err)
	}
	if len(indexes) != 2 {
		t.Fatalf("unexpected index column count: %d", len(indexes))
	}
	if indexes[0].Name != "IDX_ORDERS_TENANT_CREATED" || indexes[0].ColumnName != "TENANT_ID" || indexes[0].SeqInIndex != 1 || indexes[0].IndexType != "NORMAL" {
		t.Fatalf("unexpected first index column: %+v", indexes[0])
	}
	if indexes[1].ColumnName != "CREATED_AT" || indexes[1].SeqInIndex != 2 {
		t.Fatalf("unexpected second index column: %+v", indexes[1])
	}

	queries := damengColumnsMetadataQueries()
	if len(queries) != 1 || !strings.Contains(queries[0], "c.table_owner = 'BIZ'") || !strings.Contains(queries[0], "c.table_name = 'ORDERS'") {
		t.Fatalf("expected one normalized schema index query, got=%v", queries)
	}
}
