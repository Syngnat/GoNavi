//go:build gonavi_full_drivers || gonavi_gbase8c_driver

package db

import (
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// TestGBase8cLiveSmoke 连真实 GBase 8c，在每个兼容模式的库里建临时 schema，覆盖版本识别、search_path、
// 内部 schema 过滤、列 / 索引元数据、建表语句与网格提交。地址来自 GONAVI_GBASE8C_TEST_ADDRS，账号与密码来自
// GONAVI_GBASE8C_TEST_USER / GONAVI_GBASE8C_TEST_PASSWORD，库来自 GONAVI_GBASE8C_TEST_DATABASES（逗号分隔，缺省 postgres）。
func TestGBase8cLiveSmoke(t *testing.T) {
	user := os.Getenv("GONAVI_GBASE8C_TEST_USER")
	databases := strings.Split(os.Getenv("GONAVI_GBASE8C_TEST_DATABASES"), ",")
	if strings.TrimSpace(databases[0]) == "" {
		databases = []string{"postgres"}
	}
	for _, addr := range liveAddrs(t, "GONAVI_GBASE8C_TEST_ADDRS") {
		for _, database := range databases {
			t.Run(addr+"/"+database, func(t *testing.T) {
				config := liveConfig(t, "gbase8c", addr, user, strings.TrimSpace(database))
				config.Password = os.Getenv("GONAVI_GBASE8C_TEST_PASSWORD")
				client := &GBase8cDB{}
				if err := client.Connect(config); err != nil {
					t.Fatalf("connect: %v", err)
				}
				defer client.Close()
				variant, version := client.DriverVariantInfo()
				if variant != "v5" || version == "" {
					t.Fatalf("unexpected variant %s / version %q", variant, version)
				}
				rows, _, err := client.Query("SELECT current_schema() AS s, current_setting('sql_compatibility') AS compat")
				if err != nil || len(rows) != 1 {
					t.Fatalf("session info: %v %v", rows, err)
				}
				t.Logf("server %s, compatibility %v, current schema %v", version, rows[0]["compat"], rows[0]["s"])
				if schema := fmt.Sprint(rows[0]["s"]); schema != "public" && schema != config.User {
					t.Fatalf("current schema should stay on public / $user, got %s", schema)
				}

				schema := "gonavi_live_8c"
				mustExec(t, client, "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
				mustExec(t, client, "CREATE SCHEMA "+schema)
				defer client.Exec("DROP SCHEMA IF EXISTS " + schema + " CASCADE")
				mustExec(t, client, "CREATE TABLE "+schema+".items (id INTEGER PRIMARY KEY, code VARCHAR(20) NOT NULL, qty INTEGER DEFAULT 0, note TEXT)")
				mustExec(t, client, "CREATE INDEX idx_items_code_qty ON "+schema+".items (code, qty)")
				mustExec(t, client, "COMMENT ON COLUMN "+schema+".items.code IS 'item code'")

				tables, err := client.GetTables(database)
				if err != nil || !slices.Contains(tables, schema+".items") {
					t.Fatalf("tables %v %v", tables, err)
				}
				for _, table := range tables {
					if strings.HasPrefix(table, "dbe_perf.") || strings.HasPrefix(table, "cstore.") || strings.HasPrefix(table, "db4ai.") {
						t.Fatalf("internal table listed: %s", table)
					}
				}
				columns, err := client.GetColumns(schema, "items")
				if err != nil || len(columns) != 4 {
					t.Fatalf("columns %+v %v", columns, err)
				}
				if columns[0].Key != "PRI" || columns[1].Key != "" || columns[1].Comment != "item code" || columns[1].Nullable != "NO" {
					t.Fatalf("column metadata %+v", columns)
				}
				indexes, err := client.GetIndexes(schema, "items")
				if err != nil {
					t.Fatalf("indexes: %v", err)
				}
				var compound []string
				for _, index := range indexes {
					if index.Name == "idx_items_code_qty" {
						compound = append(compound, fmt.Sprintf("%d:%s", index.SeqInIndex, index.ColumnName))
					}
				}
				if strings.Join(compound, ",") != "1:code,2:qty" {
					t.Fatalf("compound index columns %v (all %+v)", compound, indexes)
				}
				ddl, err := client.GetCreateStatement(schema, "items")
				if err != nil || !strings.HasPrefix(ddl, "CREATE TABLE "+schema+".items (") || !strings.Contains(ddl, " ON "+schema+".items ") {
					t.Fatalf("ddl %q %v", ddl, err)
				}

				inserts := connection.ChangeSet{Inserts: []map[string]interface{}{
					{"id": 1, "code": "A-1", "qty": 1},
					{"id": 2, "code": "B-2", "note": "中文"},
				}}
				if err := client.ApplyChanges(schema+".items", inserts); err != nil {
					t.Fatalf("apply inserts: %v", err)
				}
				edits := connection.ChangeSet{
					Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"id": 1}, Values: map[string]interface{}{"qty": 7}}},
					Deletes: []map[string]interface{}{{"id": 2}},
				}
				if err := client.ApplyChanges(schema+".items", edits); err != nil {
					t.Fatalf("apply update/delete: %v", err)
				}
				rows, _, err = client.Query("SELECT id, qty FROM " + schema + ".items ORDER BY id")
				if err != nil || len(rows) != 1 || fmt.Sprint(rows[0]["qty"]) != "7" {
					t.Fatalf("rows after grid changes %v %v", rows, err)
				}
			})
		}
	}
}
