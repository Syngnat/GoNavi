package app

import (
	"context"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// fakeRegistryViewDB 的驱动 DDL 固定为 ddl；pg_get_viewdef 查询返回一条视图定义。
type fakeRegistryViewDB struct {
	db.Database
	ddl     string
	queries []string
}

func (f *fakeRegistryViewDB) GetCreateStatement(string, string) (string, error) { return f.ddl, nil }

func (f *fakeRegistryViewDB) Query(query string) ([]map[string]interface{}, []string, error) {
	f.queries = append(f.queries, query)
	if strings.Contains(query, "pg_get_viewdef") {
		return []map[string]interface{}{{"ddl": "SELECT device FROM conditions"}}, []string{"ddl"}, nil
	}
	return nil, nil, nil
}

const timescaleCaggDDL = "CREATE MATERIALIZED VIEW \"public\".\"hourly\" WITH (timescaledb.continuous) AS\nSELECT time_bucket('1 hour', time) AS bucket FROM conditions GROUP BY bucket;"

func TestRegistryViewDDLPrefersDriverStatement(t *testing.T) {
	fake := &fakeRegistryViewDB{ddl: timescaleCaggDDL}
	ddl, ok := tryGetViewCreateStatement(context.Background(), fake, connection.ConnectionConfig{Type: "timescaledb"}, "postgres", "public", "hourly")
	if !ok || ddl != timescaleCaggDDL || len(fake.queries) != 0 {
		t.Fatalf("continuous aggregate ddl = %q ok=%v queries=%v", ddl, ok, fake.queries)
	}

	created, err := resolveCreateStatementWithFallback(fake, connection.ConnectionConfig{Type: "timescaledb"}, "postgres", "public.hourly")
	if err != nil || !strings.HasPrefix(created, "CREATE MATERIALIZED VIEW") {
		t.Fatalf("DBShowCreateTable must keep the driver's materialized view ddl: %q %v", created, err)
	}
}

func TestRegistryViewDDLFallsBackToDialectQueries(t *testing.T) {
	plain := &fakeRegistryViewDB{ddl: "-- SHOW CREATE TABLE not fully supported for PostgreSQL in this MVP."}
	ddl, ok := tryGetViewCreateStatement(context.Background(), plain, connection.ConnectionConfig{Type: "timescaledb"}, "postgres", "public", "devices_view")
	if !ok || ddl != `CREATE VIEW "public"."devices_view" AS SELECT device FROM conditions;` {
		t.Fatalf("plain view ddl = %q ok=%v", ddl, ok)
	}

	postgres := &fakeRegistryViewDB{ddl: timescaleCaggDDL}
	if ddl, _ := tryGetViewCreateStatement(context.Background(), postgres, connection.ConnectionConfig{Type: "postgres"}, "app", "public", "hourly"); !strings.HasPrefix(ddl, "CREATE VIEW") {
		t.Fatalf("built-in types keep their dialect queries: %q", ddl)
	}
}

func TestIsCreateViewStatement(t *testing.T) {
	for ddl, want := range map[string]bool{
		timescaleCaggDDL: true,
		"CREATE VIEW public.v (\n\tid\n) AS SELECT 1":                                             true,
		"CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`%` SQL SECURITY DEFINER VIEW `v` AS select 1": true,
		"CREATE TABLE t AS SELECT 1":                                                              false,
		"CREATE TABLE t (view int)":                                                               false,
		"-- SHOW CREATE TABLE not fully supported":                                                false,
	} {
		if got := isCreateViewStatement(ddl); got != want {
			t.Errorf("isCreateViewStatement(%q) = %v, want %v", ddl, got, want)
		}
	}
}
