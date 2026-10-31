//go:build gonavi_full_drivers || gonavi_kingbase_driver

package db

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"io"
	"strings"
	"sync"
	"testing"
)

// KingbaseES 没有可依赖的建表语句函数，DDL 由 pg_catalog 拼装；
// 这里用独立 fake 驱动覆盖四段查询（列/约束/索引/表注释），不复用其它测试的状态。

const fakeKingbaseDdlDriverName = "kingbase-ddl-fake"

var registerFakeKingbaseDdlDriverOnce sync.Once

type fakeKingbaseDdlDriver struct{}

func (fakeKingbaseDdlDriver) Open(string) (driver.Conn, error) { return fakeKingbaseDdlConn{}, nil }

type fakeKingbaseDdlConn struct{}

func (fakeKingbaseDdlConn) Prepare(string) (driver.Stmt, error) {
	return nil, driver.ErrSkip
}

func (fakeKingbaseDdlConn) Close() error { return nil }

func (fakeKingbaseDdlConn) Begin() (driver.Tx, error) { return nil, driver.ErrSkip }

func (fakeKingbaseDdlConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	switch {
	case strings.Contains(query, "AS column_name"):
		return &fakeKingbaseRows{
			columns: []string{"column_name", "data_type", "is_nullable", "column_default", "comment"},
			rows: [][]driver.Value{
				{"id", "bigint", "NO", "nextval('lab_customers_id_seq'::regclass)", "客户ID"},
				{"name", "character varying(50)", "NO", nil, "客户姓名"},
				{"city", "character varying(30)", "YES", nil, nil},
			},
		}, nil
	case strings.Contains(query, "pg_get_indexdef"):
		return &fakeKingbaseRows{
			columns: []string{"index_name", "definition"},
			rows: [][]driver.Value{
				{"lab_customers_city_idx", "CREATE INDEX lab_customers_city_idx ON dbms_job.lab_customers USING btree (city)"},
			},
		}, nil
	case strings.Contains(query, "pg_constraint"):
		return &fakeKingbaseRows{
			columns: []string{"constraint_name", "constraint_type", "definition"},
			rows: [][]driver.Value{
				{"lab_customers_pkey", "p", "PRIMARY KEY (id)"},
			},
		}, nil
	case strings.Contains(query, "obj_description"):
		return &fakeKingbaseRows{
			columns: []string{"table_comment"},
			rows:    [][]driver.Value{{"客户表"}},
		}, nil
	}
	return &fakeKingbaseRows{}, nil
}

func openFakeKingbaseDdlDB(t *testing.T) *sql.DB {
	t.Helper()
	registerFakeKingbaseDdlDriverOnce.Do(func() {
		sql.Register(fakeKingbaseDdlDriverName, fakeKingbaseDdlDriver{})
	})
	sqlDB, err := sql.Open(fakeKingbaseDdlDriverName, "")
	if err != nil {
		t.Fatalf("open fake kingbase: %v", err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	return sqlDB
}

func TestKingbaseGetCreateStatementBuildsDdlFromCatalog(t *testing.T) {
	client := &KingbaseDB{conn: openFakeKingbaseDdlDB(t)}

	ddl, err := client.GetCreateStatement("", "dbms_job.lab_customers")
	if err != nil {
		t.Fatalf("GetCreateStatement returned error: %v", err)
	}

	for _, want := range []string{
		`CREATE TABLE "dbms_job"."lab_customers"`,
		`"id" bigint DEFAULT nextval('lab_customers_id_seq'::regclass) NOT NULL`,
		`"name" character varying(50) NOT NULL`,
		`"city" character varying(30)`,
		`CONSTRAINT "lab_customers_pkey" PRIMARY KEY (id)`,
		`COMMENT ON TABLE "dbms_job"."lab_customers" IS '客户表';`,
		`COMMENT ON COLUMN "dbms_job"."lab_customers"."id" IS '客户ID';`,
		`CREATE INDEX lab_customers_city_idx ON dbms_job.lab_customers USING btree (city);`,
	} {
		if !strings.Contains(ddl, want) {
			t.Fatalf("generated DDL missing %q\n---\n%s", want, ddl)
		}
	}
	if strings.Contains(ddl, "not directly supported") {
		t.Fatalf("DDL must not fall back to the placeholder message: %s", ddl)
	}
}

func TestKingbaseGetCreateStatementWithoutCommentKeepsTableSlim(t *testing.T) {
	client := &KingbaseDB{conn: openFakeKingbaseDdlDB(t)}

	ddl, err := client.GetCreateStatement("public", "demo_cols")
	if err != nil {
		t.Fatalf("GetCreateStatement returned error: %v", err)
	}
	if !strings.HasPrefix(ddl, `CREATE TABLE "public"."demo_cols"`) {
		t.Fatalf("unexpected DDL header: %s", ddl)
	}
	if !strings.HasSuffix(strings.TrimSpace(ddl), ";") {
		t.Fatalf("DDL should end with a statement terminator: %s", ddl)
	}
}

func TestKingbaseGetCreateStatementRequiresTableName(t *testing.T) {
	client := &KingbaseDB{conn: openFakeKingbaseDdlDB(t)}
	if _, err := client.GetCreateStatement("public", ""); err == nil {
		t.Fatal("expected an error for an empty table name")
	}
}

var _ io.Closer = fakeKingbaseDdlConn{}
