//go:build gonavi_full_drivers || gonavi_tidb_driver

package db

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// TestTiDBLiveSmoke 对真实 TiDB 跑一遍连接、版本档位、元数据与行编辑。
// GONAVI_TIDB_TEST_ADDRS 为逗号分隔的 host:port 列表（可同时覆盖多个版本）。
func TestTiDBLiveSmoke(t *testing.T) {
	raw := strings.TrimSpace(os.Getenv("GONAVI_TIDB_TEST_ADDRS"))
	if raw == "" {
		t.Skip("set GONAVI_TIDB_TEST_ADDRS=host:port[,host:port] to run live TiDB smoke tests")
	}
	for _, addr := range strings.Split(raw, ",") {
		addr = strings.TrimSpace(addr)
		t.Run(addr, func(t *testing.T) { runTiDBLiveSmoke(t, addr) })
	}
}

func runTiDBLiveSmoke(t *testing.T, addr string) {
	host, portText, ok := strings.Cut(addr, ":")
	if !ok {
		t.Fatalf("invalid address %q", addr)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatalf("invalid port: %v", err)
	}
	client := &TiDBDB{}
	config := connection.ConnectionConfig{Type: "tidb", Host: host, Port: port, User: "root", Timeout: 15}
	if err := client.Connect(config); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer client.Close()
	variant, version := client.DriverVariantInfo()
	if variant == "" || version == "" {
		t.Fatalf("variant=%q version=%q", variant, version)
	}
	t.Logf("server %s resolved to variant %s", version, variant)

	schema := "gonavi_tidb_smoke"
	mustExec(t, client, "DROP DATABASE IF EXISTS "+schema)
	mustExec(t, client, "CREATE DATABASE "+schema)
	defer func() { _, _ = client.Exec("DROP DATABASE IF EXISTS " + schema) }()
	mustExec(t, client, "CREATE TABLE "+schema+".users (id BIGINT PRIMARY KEY AUTO_RANDOM, name VARCHAR(64) NOT NULL, KEY idx_name (name))")
	mustExec(t, client, "CREATE TABLE "+schema+".orders (id INT PRIMARY KEY, user_id BIGINT, CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES "+schema+".users(id))")
	mustExec(t, client, "CREATE SEQUENCE "+schema+".seq_order")
	mustExec(t, client, "INSERT INTO "+schema+".users (name) VALUES ('alice'), ('bob')")

	assertTiDBMetadata(t, client, schema)

	rows, _, err := client.Query("SELECT id, name FROM " + schema + ".users ORDER BY name")
	if err != nil || len(rows) != 2 {
		t.Fatalf("query users: %v rows=%d", err, len(rows))
	}
	changes := connection.ChangeSet{Updates: []connection.UpdateRow{{
		Keys:   map[string]interface{}{"id": rows[0]["id"]},
		Values: map[string]interface{}{"name": "alice2"},
	}}}
	// 与应用层一致：编辑表格时连接带上当前库，表名不带库前缀。
	editor := &TiDBDB{}
	editorConfig := config
	editorConfig.Database = schema
	if err := editor.Connect(editorConfig); err != nil {
		t.Fatalf("connect with database: %v", err)
	}
	defer editor.Close()
	if err := editor.ApplyChangesContext(context.Background(), "users", changes); err != nil {
		t.Fatalf("apply changes: %v", err)
	}
	updated, _, err := client.Query("SELECT COUNT(*) AS c FROM " + schema + ".users WHERE name = 'alice2'")
	if err != nil || fmt.Sprint(updated[0]["c"]) != "1" {
		t.Fatalf("update not applied: %v %v", err, updated)
	}
	plan, _, err := client.Query("EXPLAIN SELECT * FROM " + schema + ".users WHERE name = 'bob'")
	if err != nil || len(plan) == 0 {
		t.Fatalf("explain: %v", err)
	}
}

func assertTiDBMetadata(t *testing.T, client *TiDBDB, schema string) {
	t.Helper()
	databases, err := client.GetDatabases()
	if err != nil || !containsString(databases, schema) {
		t.Fatalf("databases %v: %v", databases, err)
	}
	tables, err := client.GetTables(schema)
	if err != nil || strings.Join(tables, ",") != "orders,users" {
		t.Fatalf("tables %v: %v (sequences must not be listed as tables)", tables, err)
	}
	columns, err := client.GetColumns(schema, "users")
	if err != nil || len(columns) != 2 || columns[0].Key != "PRI" {
		t.Fatalf("columns %#v: %v", columns, err)
	}
	indexes, err := client.GetIndexes(schema, "users")
	if err != nil || len(indexes) == 0 {
		t.Fatalf("indexes %#v: %v", indexes, err)
	}
	ddl, err := client.GetCreateStatement(schema, "users")
	if err != nil || !strings.Contains(ddl, "AUTO_RANDOM") {
		t.Fatalf("ddl %q: %v", ddl, err)
	}
	keys, err := client.GetForeignKeys(schema, "orders")
	if err != nil {
		t.Fatalf("foreign keys: %v", err)
	}
	if client.tidbSupportsForeignKeys() != (len(keys) == 1) {
		t.Fatalf("foreign keys %#v do not match version gate", keys)
	}
	if triggers, err := client.GetTriggers(schema, "users"); err != nil || len(triggers) != 0 {
		t.Fatalf("triggers %#v: %v", triggers, err)
	}
}
