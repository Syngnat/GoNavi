//go:build gonavi_full_drivers || gonavi_cockroachdb_driver || gonavi_kwdb_driver

package db

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// seedPGWireRelational 建两张有外键的关系表与一个视图，返回所在库名。
func seedPGWireRelational(t *testing.T, admin Database, database string) {
	t.Helper()
	mustExec(t, admin, "DROP DATABASE IF EXISTS "+database+" CASCADE")
	mustExec(t, admin, "CREATE DATABASE "+database)
	for _, statement := range []string{
		"CREATE TABLE " + database + ".public.users (id INT PRIMARY KEY, name STRING NOT NULL DEFAULT 'x', INDEX idx_name (name))",
		"CREATE TABLE " + database + ".public.orders (id INT PRIMARY KEY, user_id INT REFERENCES " + database + ".public.users(id))",
		"INSERT INTO " + database + ".public.users (id, name) VALUES (1, 'a'), (2, 'b')",
	} {
		mustExec(t, admin, statement)
	}
}

func assertPGWireRelationalMetadata(t *testing.T, client Database, internalSchema string) {
	t.Helper()
	// 连接时写入的 search_path 不能带上内部 schema，否则编辑器默认 schema 会落到内部 schema 上。
	rows, _, err := client.Query("SELECT current_schema() AS schema_name")
	if err != nil || len(rows) != 1 || fmt.Sprint(rows[0]["schema_name"]) != "public" {
		t.Fatalf("current schema %v: %v", rows, err)
	}
	tables, err := client.GetTables("")
	if err != nil || strings.Join(tables, ",") != "public.orders,public.users" {
		t.Fatalf("tables %v: %v (internal schema %s must be hidden)", tables, err, internalSchema)
	}
	columns, err := client.GetColumns("public", "users")
	if err != nil || len(columns) != 2 || columns[0].Key != "PRI" || columns[1].Default == nil {
		t.Fatalf("columns %#v: %v", columns, err)
	}
	indexes, err := client.GetIndexes("public", "users")
	if err != nil || len(indexes) < 2 {
		t.Fatalf("indexes %#v: %v", indexes, err)
	}
	keys, err := client.GetForeignKeys("public", "orders")
	if err != nil || len(keys) != 1 || keys[0].RefColumnName != "id" {
		t.Fatalf("foreign keys %#v: %v", keys, err)
	}
	ddl, err := client.GetCreateStatement("public", "users")
	if err != nil || !strings.Contains(ddl, "CREATE TABLE") || !strings.Contains(ddl, "idx_name") {
		t.Fatalf("ddl %q: %v", ddl, err)
	}
	if _, err := client.GetTriggers("public", "users"); err != nil {
		t.Fatalf("triggers: %v", err)
	}
	all, err := client.GetAllColumns("")
	if err != nil {
		t.Fatalf("all columns: %v", err)
	}
	for _, column := range all {
		if strings.HasPrefix(column.TableName, internalSchema+".") {
			t.Fatalf("internal column leaked: %s", column.TableName)
		}
	}
}

func TestCockroachDBLiveSmoke(t *testing.T) {
	for _, addr := range liveAddrs(t, "GONAVI_COCKROACHDB_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			admin := &CockroachDB{}
			if err := admin.Connect(liveConfig(t, "cockroachdb", addr, "root", "defaultdb")); err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer admin.Close()
			variant, version := admin.DriverVariantInfo()
			t.Logf("server %s resolved to variant %s", version, variant)
			if variant == "" || version == "" {
				t.Fatal("variant must be resolved")
			}
			seedPGWireRelational(t, admin, "gonavi_crdb_smoke")
			defer func() { _, _ = admin.Exec("DROP DATABASE IF EXISTS gonavi_crdb_smoke CASCADE") }()

			client := &CockroachDB{}
			if err := client.Connect(liveConfig(t, "cockroachdb", addr, "root", "gonavi_crdb_smoke")); err != nil {
				t.Fatalf("connect database: %v", err)
			}
			defer client.Close()
			assertPGWireRelationalMetadata(t, client, "crdb_internal")
			changes := connection.ChangeSet{Updates: []connection.UpdateRow{{
				Keys: map[string]interface{}{"id": 1}, Values: map[string]interface{}{"name": "a2"},
			}}}
			if err := client.ApplyChangesContext(context.Background(), "public.users", changes); err != nil {
				t.Fatalf("apply changes: %v", err)
			}
			rows, _, err := client.Query("SELECT name FROM public.users WHERE id = 1")
			if err != nil || fmt.Sprint(rows[0]["name"]) != "a2" {
				t.Fatalf("update not applied: %v %v", rows, err)
			}
		})
	}
}
