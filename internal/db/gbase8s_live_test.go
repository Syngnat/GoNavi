//go:build gonavi_full_drivers || gonavi_gbase8s_driver

package db

import (
	"context"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// TestGBase8sLiveSmoke 连真实 GBase 8s（需要本机 CSDK：GBASEDBTDIR 或 GONAVI_GBASE8S_TEST_CLIENT_DIR，Linux 上
// LD_LIBRARY_PATH 要包含 CSDK 的 lib、lib/esql、lib/cli），在 GONAVI_GBASE8S_TEST_DATABASE（缺省 gonavi_lab）里建临时表，
// 覆盖服务名自动识别、版本、元数据、建表语句、网格提交与托管事务。地址来自 GONAVI_GBASE8S_TEST_ADDRS。
func TestGBase8sLiveSmoke(t *testing.T) {
	database := os.Getenv("GONAVI_GBASE8S_TEST_DATABASE")
	if database == "" {
		database = "gonavi_lab"
	}
	for _, addr := range liveAddrs(t, "GONAVI_GBASE8S_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			client := connectGBase8sLive(t, addr, database)
			defer client.Close()
			variant, version := client.DriverVariantInfo()
			if variant != "v8" || version == "" {
				t.Fatalf("unexpected variant %s / version %q", variant, version)
			}
			t.Logf("server version %s", version)
			databases, err := client.GetDatabases()
			if err != nil || !slices.Contains(databases, database) || slices.Contains(databases, "sysmaster") {
				t.Fatalf("databases %v %v", databases, err)
			}

			for _, statement := range []string{"DROP VIEW IF EXISTS gn_big_items", "DROP TABLE IF EXISTS gn_items", "DROP TABLE IF EXISTS gn_groups"} {
				_, _ = client.Exec(statement)
			}
			mustExec(t, client, "CREATE TABLE gn_groups (gid INTEGER PRIMARY KEY CONSTRAINT pk_gn_groups, title VARCHAR(40))")
			mustExec(t, client, `CREATE TABLE gn_items (
	id SERIAL NOT NULL,
	gid INTEGER,
	code CHAR(8) DEFAULT 'X' NOT NULL,
	price DECIMAL(12,2) DEFAULT 1.50,
	made DATETIME YEAR TO SECOND DEFAULT CURRENT YEAR TO SECOND,
	flag BOOLEAN DEFAULT 't',
	note LVARCHAR(500),
	PRIMARY KEY (id) CONSTRAINT pk_gn_items,
	UNIQUE (code) CONSTRAINT uq_gn_items_code,
	CHECK (price >= 0) CONSTRAINT ck_gn_items_price
)`)
			mustExec(t, client, "CREATE INDEX idx_gn_items_gid ON gn_items (gid, made DESC)")
			mustExec(t, client, "ALTER TABLE gn_items ADD CONSTRAINT FOREIGN KEY (gid) REFERENCES gn_groups (gid) CONSTRAINT fk_gn_items_group")
			mustExec(t, client, "COMMENT ON TABLE gn_items IS '商品'")
			mustExec(t, client, "COMMENT ON COLUMN gn_items.code IS '编码'")
			mustExec(t, client, "CREATE VIEW gn_big_items AS SELECT id, price FROM gn_items WHERE price > 100")
			defer client.Exec("DROP TABLE IF EXISTS gn_items")
			defer client.Exec("DROP TABLE IF EXISTS gn_groups")
			defer client.Exec("DROP VIEW IF EXISTS gn_big_items")

			tables, err := client.GetTables(database)
			if err != nil || !slices.Contains(tables, "gn_items") || slices.Contains(tables, "dual") || slices.Contains(tables, "systables") {
				t.Fatalf("tables %v %v", tables, err)
			}
			columns, err := client.GetColumns(database, "gn_items")
			if err != nil || len(columns) != 7 {
				t.Fatalf("columns %+v %v", columns, err)
			}
			want := map[string]string{"id": "SERIAL", "gid": "INTEGER", "code": "CHAR(8)", "price": "DECIMAL(12,2)", "made": "DATETIME YEAR TO SECOND", "flag": "BOOLEAN", "note": "LVARCHAR(500)"}
			for _, column := range columns {
				if column.Type != want[column.Name] {
					t.Fatalf("column %s type %s, want %s", column.Name, column.Type, want[column.Name])
				}
			}
			if columns[0].Key != "PRI" || columns[0].Extra != "auto_increment" || columns[2].Nullable != "NO" || columns[2].Comment != "编码" {
				t.Fatalf("column metadata %+v", columns)
			}
			if columns[3].Default == nil || *columns[3].Default != "1.50" || columns[4].Default == nil || *columns[4].Default != "CURRENT YEAR TO SECOND" {
				t.Fatalf("defaults %+v %+v", columns[3].Default, columns[4].Default)
			}
			indexes, err := client.GetIndexes(database, "gn_items")
			if err != nil {
				t.Fatalf("indexes: %v", err)
			}
			var indexColumns []string
			for _, index := range indexes {
				indexColumns = append(indexColumns, fmt.Sprintf("%s:%d:%s", index.Name, index.SeqInIndex, index.ColumnName))
			}
			for _, expected := range []string{"PRIMARY:1:id", "uq_gn_items_code:1:code", "idx_gn_items_gid:1:gid", "idx_gn_items_gid:2:made"} {
				if !slices.Contains(indexColumns, expected) {
					t.Fatalf("index %s missing in %v", expected, indexColumns)
				}
			}
			keys, err := client.GetForeignKeys(database, "gn_items")
			if err != nil || len(keys) != 1 || keys[0].RefTableName != "gn_groups" || keys[0].RefColumnName != "gid" || keys[0].Name != "fk_gn_items_group" {
				t.Fatalf("foreign keys %+v %v", keys, err)
			}
			ddl, err := client.GetCreateStatement(database, "gn_items")
			if err != nil {
				t.Fatalf("ddl: %v", err)
			}
			t.Logf("ddl:\n%s", ddl)
			for _, fragment := range []string{"CREATE TABLE gn_items (", "flag BOOLEAN DEFAULT 't',", "made DATETIME YEAR TO SECOND DEFAULT CURRENT YEAR TO SECOND", "PRIMARY KEY (id) CONSTRAINT pk_gn_items",
				"CHECK (price >= 0", "CREATE INDEX idx_gn_items_gid ON gn_items (gid, made DESC);", "REFERENCES gn_groups (gid) CONSTRAINT fk_gn_items_group;", "COMMENT ON TABLE gn_items IS '商品';"} {
				if !strings.Contains(ddl, fragment) {
					t.Fatalf("ddl misses %q", fragment)
				}
			}
			viewDDL, err := client.GetCreateStatement(database, "gn_big_items")
			if err != nil || !strings.HasPrefix(strings.ToLower(viewDDL), "create view") || !strings.Contains(viewDDL, "gn_big_items") {
				t.Fatalf("view ddl %q %v", viewDDL, err)
			}

			mustExec(t, client, "INSERT INTO gn_groups VALUES (1, 'g1')")
			inserts := connection.ChangeSet{Inserts: []map[string]interface{}{
				{"gid": 1, "code": "A1", "price": "120.25", "note": "中文备注", "flag": "t"},
				{"gid": nil, "code": "B2", "price": 3},
			}}
			if err := client.ApplyChanges("gn_items", inserts); err != nil {
				t.Fatalf("apply inserts: %v", err)
			}
			rows, _, err := client.Query("SELECT id, code, price, made, flag, note FROM gn_items ORDER BY id")
			if err != nil || len(rows) != 2 || rows[0]["note"] != "中文备注" || fmt.Sprint(rows[0]["price"]) != "120.25" {
				t.Fatalf("rows %v %v", rows, err)
			}
			t.Logf("row: %#v", rows[0])
			edits := connection.ChangeSet{
				Updates: []connection.UpdateRow{{Keys: map[string]interface{}{"id": rows[0]["id"]}, Values: map[string]interface{}{"note": "改过"}}},
				Deletes: []map[string]interface{}{{"id": rows[1]["id"]}},
			}
			if err := client.ApplyChanges("gn_items", edits); err != nil {
				t.Fatalf("apply edits: %v", err)
			}
			missing := connection.ChangeSet{Deletes: []map[string]interface{}{{"id": 999999}}}
			if err := client.ApplyChanges("gn_items", missing); err == nil {
				t.Fatal("deleting a missing row must fail")
			}

			execer, err := client.OpenTransactionExecer(context.Background())
			if err != nil {
				t.Fatalf("open transaction: %v", err)
			}
			if _, err := execer.Exec("UPDATE gn_items SET note = 'rolled back'"); err != nil {
				t.Fatalf("exec in transaction: %v", err)
			}
			if err := execer.Rollback(); err != nil {
				t.Fatalf("rollback: %v", err)
			}
			rows, _, err = client.Query("SELECT note FROM gn_items")
			if err != nil || len(rows) != 1 || rows[0]["note"] != "改过" {
				t.Fatalf("after rollback %v %v", rows, err)
			}
			_, _ = client.Exec("DROP FUNCTION IF EXISTS gn_live_fn")
			mustExec(t, client, "CREATE FUNCTION gn_live_fn(x INT) RETURNING INT; RETURN x * 3; END FUNCTION")
			defer client.Exec("DROP FUNCTION IF EXISTS gn_live_fn")
			mustExec(t, client, "CREATE TRIGGER gn_items_ins INSERT ON gn_items FOR EACH ROW (UPDATE gn_groups SET title = 'touched' WHERE gid = 1)")
			for name, fragment := range map[string]string{"gn_live_fn": "END FUNCTION", "gn_items_ins": "for each row"} {
				definition, err := client.GetCreateStatement(database, name)
				if err != nil || !strings.Contains(strings.ToLower(definition), strings.ToLower(fragment)) || strings.ContainsRune(definition, 0) {
					t.Fatalf("definition of %s: %q %v", name, definition, err)
				}
			}
			if _, err := client.Exec("SELEC 1 FROM systables"); gbase8sErrorCode(err) != -201 || !strings.Contains(err.Error(), "syntax") {
				t.Fatalf("syntax errors should surface the server error -201, got %v", err)
			}
			paged, _, err := client.Query("SELECT SKIP 0 FIRST 1 tabname FROM systables ORDER BY tabid")
			if err != nil || len(paged) != 1 {
				t.Fatalf("skip/first %v %v", paged, err)
			}
		})
	}
}

func connectGBase8sLive(t *testing.T, addr, database string) *GBase8sDB {
	t.Helper()
	config := liveConfig(t, "gbase8s", addr, os.Getenv("GONAVI_GBASE8S_TEST_USER"), database)
	config.Password = os.Getenv("GONAVI_GBASE8S_TEST_PASSWORD")
	if dir := os.Getenv("GONAVI_GBASE8S_TEST_CLIENT_DIR"); dir != "" {
		config.ConnectionParams = "clientDir=" + dir
	}
	client := &GBase8sDB{}
	if err := client.Connect(config); err != nil {
		t.Fatalf("connect %s: %v", addr, err)
	}
	return client
}

// TestGBase8sLiveLocaleFallback 连一个非 UTF-8 的库（GONAVI_GBASE8S_TEST_LATIN1_DATABASE，en_US.819）：
// 缺省 DB_LOCALE 会报 -23197，驱动应从 sysmaster 查出库的 locale 重连，客户端仍按 UTF-8 收发。
func TestGBase8sLiveLocaleFallback(t *testing.T) {
	database := os.Getenv("GONAVI_GBASE8S_TEST_LATIN1_DATABASE")
	if database == "" {
		t.Skip("set GONAVI_GBASE8S_TEST_LATIN1_DATABASE to run")
	}
	for _, addr := range liveAddrs(t, "GONAVI_GBASE8S_TEST_ADDRS") {
		client := connectGBase8sLive(t, addr, database)
		_, _ = client.Exec("DELETE FROM t1 WHERE id = 2")
		mustExec(t, client, "INSERT INTO t1 VALUES (2, 'Müller')")
		rows, _, err := client.Query("SELECT name FROM t1 WHERE id = 2")
		client.Close()
		if err != nil || len(rows) != 1 || rows[0]["name"] != "Müller" {
			t.Fatalf("latin1 round trip %v %v", rows, err)
		}
	}
}
