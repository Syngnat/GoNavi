//go:build gonavi_full_drivers || gonavi_yashandb_driver

package db

import (
	"context"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

// TestYashanDBLiveSmoke 连真实崖山（需要本机崖山客户端：GONAVI_YASHANDB_TEST_CLIENT_DIR 或 YASDB_HOME），以
// GONAVI_YASHANDB_TEST_USER（缺省 gonavi，需有建表、建视图、建触发器、建序列权限）登录，在该用户的 Schema 里建临时对象，
// 覆盖版本、元数据、建表语句、各类型取值、网格提交（含大对象与失败回滚）、托管事务与查询取消。地址来自 GONAVI_YASHANDB_TEST_ADDRS。
func TestYashanDBLiveSmoke(t *testing.T) {
	user := os.Getenv("GONAVI_YASHANDB_TEST_USER")
	if user == "" {
		user = "gonavi"
	}
	schema := strings.ToUpper(user)
	for _, addr := range liveAddrs(t, "GONAVI_YASHANDB_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			client := connectYashanDBLive(t, addr, user, "")
			defer client.Close()
			variant, version := client.DriverVariantInfo()
			if variant == "" || version == "" {
				t.Fatalf("unexpected variant %s / version %q", variant, version)
			}
			t.Logf("server version %s, variant %s", version, variant)
			databases, err := client.GetDatabases()
			if err != nil || !slices.Contains(databases, schema) {
				t.Fatalf("databases %v %v", databases, err)
			}

			for _, statement := range []string{"DROP VIEW GN_BIG_ITEMS", "DROP TABLE GN_ITEMS", "DROP TABLE GN_GROUPS", "DROP SEQUENCE GN_ITEMS_SEQ"} {
				_, _ = client.Exec(statement)
			}
			mustExec(t, client, "CREATE TABLE gn_groups (gid INTEGER PRIMARY KEY, title VARCHAR(40))")
			// 23.1 还没有带时区的时间戳类型，该列改成普通 TIMESTAMP（列数不变）。
			tzType := "TIMESTAMP WITH TIME ZONE"
			if !client.atLeast("23.2") {
				tzType = "TIMESTAMP"
			}
			mustExec(t, client, `CREATE TABLE gn_items (
	id NUMBER(10) NOT NULL,
	gid INTEGER,
	code CHAR(8) DEFAULT 'X' NOT NULL,
	price NUMBER(12,2) DEFAULT 1.50,
	made DATE DEFAULT SYSDATE,
	stamp TIMESTAMP,
	stamp_tz `+tzType+`,
	flag BOOLEAN,
	ratio DOUBLE,
	note CLOB,
	payload BLOB,
	raw_id RAW(16),
	CONSTRAINT pk_gn_items PRIMARY KEY (id),
	CONSTRAINT uq_gn_items_code UNIQUE (code),
	CONSTRAINT ck_gn_items_price CHECK (price >= 0),
	CONSTRAINT fk_gn_items_group FOREIGN KEY (gid) REFERENCES gn_groups (gid)
)`)
			mustExec(t, client, "CREATE INDEX idx_gn_items_gid ON gn_items (gid, made DESC)")
			mustExec(t, client, "COMMENT ON TABLE gn_items IS '商品'")
			mustExec(t, client, "COMMENT ON COLUMN gn_items.code IS '编码'")
			mustExec(t, client, "CREATE VIEW gn_big_items AS SELECT id, price FROM gn_items WHERE price > 100")
			mustExec(t, client, "CREATE SEQUENCE gn_items_seq START WITH 100")
			mustExec(t, client, `CREATE OR REPLACE TRIGGER trg_gn_items_bi BEFORE INSERT ON gn_items FOR EACH ROW
BEGIN
  IF :NEW.id IS NULL THEN
    :NEW.id := gn_items_seq.NEXTVAL;
  END IF;
END;`)
			defer client.Exec("DROP SEQUENCE GN_ITEMS_SEQ")
			defer client.Exec("DROP TABLE GN_GROUPS")
			defer client.Exec("DROP TABLE GN_ITEMS")
			defer client.Exec("DROP VIEW GN_BIG_ITEMS")

			tables, err := client.GetTables(schema)
			if err != nil || !slices.Contains(tables, schema+".GN_ITEMS") {
				t.Fatalf("tables %v %v", tables, err)
			}
			columns, err := client.GetColumns(schema, "GN_ITEMS")
			if err != nil || len(columns) != 12 {
				t.Fatalf("columns %+v %v", columns, err)
			}
			for _, column := range columns {
				t.Logf("column %s %s key=%s null=%s default=%v comment=%q", column.Name, column.Type, column.Key, column.Nullable, yashanLiveText(column.Default), column.Comment)
			}
			indexes, err := client.GetIndexes(schema, "GN_ITEMS")
			if err != nil || len(indexes) < 3 {
				t.Fatalf("indexes %+v %v", indexes, err)
			}
			foreignKeys, err := client.GetForeignKeys(schema, "GN_ITEMS")
			if err != nil || len(foreignKeys) != 1 || foreignKeys[0].RefTableName != "GN_GROUPS" {
				t.Fatalf("foreign keys %+v %v", foreignKeys, err)
			}
			triggers, err := client.GetTriggers(schema, "GN_ITEMS")
			if err != nil || len(triggers) != 1 {
				t.Fatalf("triggers %+v %v", triggers, err)
			}
			ddl, err := client.GetCreateStatement(schema, "GN_ITEMS")
			if err != nil || !strings.Contains(ddl, "CREATE TABLE") || !strings.Contains(ddl, "商品") {
				t.Fatalf("ddl %q %v", ddl, err)
			}
			t.Logf("ddl:\n%s", ddl)
			mustExec(t, client, "CREATE OR REPLACE FUNCTION gn_double(p NUMBER) RETURN NUMBER IS BEGIN RETURN p * 2; END;")
			mustExec(t, client, "CREATE OR REPLACE PACKAGE gn_pkg AS FUNCTION twice(p NUMBER) RETURN NUMBER; END gn_pkg;")
			mustExec(t, client, "CREATE OR REPLACE PACKAGE BODY gn_pkg AS FUNCTION twice(p NUMBER) RETURN NUMBER IS BEGIN RETURN p * 2; END; END gn_pkg;")
			defer client.Exec("DROP PACKAGE GN_PKG")
			defer client.Exec("DROP FUNCTION GN_DOUBLE")
			for name, want := range map[string]string{
				"GN_DOUBLE": "CREATE OR REPLACE FUNCTION", "gn_double": "CREATE OR REPLACE FUNCTION", schema + ".GN_PKG": "PACKAGE BODY",
				"TRG_GN_ITEMS_BI": "CREATE OR REPLACE TRIGGER", "GN_BIG_ITEMS": "VIEW",
			} {
				definition, err := client.GetCreateStatement(schema, name)
				if err != nil || !strings.Contains(definition, want) || strings.Contains(definition, "ALTER TRIGGER") || (want == "CREATE OR REPLACE TRIGGER" && !strings.HasSuffix(definition, "END;")) {
					t.Fatalf("definition of %s = %q, %v", name, definition, err)
				}
			}

			mustExec(t, client, "INSERT INTO gn_groups VALUES (1, 'g1')")
			mustExec(t, client, `INSERT INTO gn_items (gid, code, price, made, stamp, stamp_tz, flag, ratio, note, payload, raw_id)
VALUES (1, 'A1', 123.45, TO_DATE('2024-02-29 13:14:15', 'YYYY-MM-DD HH24:MI:SS'), TIMESTAMP '2024-02-29 13:14:15.123456',
`+yashanLiveTZLiteral(client)+`, TRUE, 2.5, '备注', HEXTORAW('DEADBEEF'), HEXTORAW('0102'))`)
			rows, _, err := client.Query("SELECT * FROM gn_items")
			if err != nil || len(rows) != 1 {
				t.Fatalf("rows %v %v", rows, err)
			}
			row := rows[0]
			t.Logf("row %#v", row)
			if row["ID"] != "100" && row["ID"] != int64(100) {
				t.Fatalf("trigger-assigned id %#v", row["ID"])
			}

			changes := connection.ChangeSet{
				Inserts: []map[string]any{{"ID": "200", "GID": "1", "CODE": "B2", "MADE": "2024-03-01 08:09:10", "NOTE": strings.Repeat("长", 40000), "PAYLOAD": strings.Repeat("ab", 10)}},
				Updates: []connection.UpdateRow{{Keys: map[string]any{"ID": "100"}, Values: map[string]any{"PRICE": "99.5", "STAMP": "2025-01-02 03:04:05.678"}}},
			}
			if err := client.ApplyChanges(schema+".GN_ITEMS", changes); err != nil {
				t.Fatalf("apply changes: %v", err)
			}
			checked, _, err := client.Query("SELECT id, price, stamp, made, LENGTH(note) AS note_len FROM gn_items ORDER BY id")
			if err != nil || len(checked) != 2 {
				t.Fatalf("checked %v %v", checked, err)
			}
			t.Logf("after changes %#v", checked)

			failing := connection.ChangeSet{
				Inserts: []map[string]any{{"ID": "300", "GID": "1", "CODE": "C3"}},
				Updates: []connection.UpdateRow{{Keys: map[string]any{"ID": "999"}, Values: map[string]any{"PRICE": "1"}}},
			}
			if err := client.ApplyChanges(schema+".GN_ITEMS", failing); err == nil {
				t.Fatal("expected failure for missing row")
			}
			if rows, _, _ := client.Query("SELECT id FROM gn_items WHERE id = 300"); len(rows) != 0 {
				t.Fatalf("failed change set was not rolled back: %v", rows)
			}

			execer, err := client.OpenTransactionExecer(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if _, err := execer.ExecContext(context.Background(), "INSERT INTO gn_groups VALUES (2, 'g2')"); err != nil {
				t.Fatal(err)
			}
			if err := execer.Rollback(); err != nil {
				t.Fatal(err)
			}
			if rows, _, _ := client.Query("SELECT gid FROM gn_groups WHERE gid = 2"); len(rows) != 0 {
				t.Fatalf("rolled back transaction is visible: %v", rows)
			}

			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			started := time.Now()
			_, _, err = client.QueryContext(ctx, "SELECT COUNT(*) FROM all_objects a, all_objects b, all_objects c WHERE a.object_name || b.object_name || c.object_name LIKE '%zz%q%'")
			if err == nil || time.Since(started) > 15*time.Second {
				t.Fatalf("cancel: err=%v after %s", err, time.Since(started))
			}
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Logf("cancel error: %v", err)
			}
			if _, _, err := client.Query("SELECT 1 FROM dual"); err != nil {
				t.Fatalf("connection unusable after cancel: %v", err)
			}

			scoped := connectYashanDBLive(t, addr, user, schema)
			defer scoped.Close()
			if rows, _, err := scoped.Query("SELECT COUNT(*) AS n FROM gn_groups"); err != nil || len(rows) != 1 {
				t.Fatalf("current schema query %v %v", rows, err)
			}
		})
	}
}

func connectYashanDBLive(t *testing.T, addr, user, database string) *YashanDB {
	t.Helper()
	config := liveConfig(t, "yashandb", addr, user, database)
	config.Password = os.Getenv("GONAVI_YASHANDB_TEST_PASSWORD")
	if dir := os.Getenv("GONAVI_YASHANDB_TEST_CLIENT_DIR"); dir != "" {
		config.ConnectionParams = "clientDir=" + dir
	}
	client := &YashanDB{}
	if err := client.Connect(config); err != nil {
		t.Fatalf("connect %s: %v", addr, err)
	}
	return client
}

func yashanLiveTZLiteral(client *YashanDB) string {
	if client.atLeast("23.2") {
		return "TO_TIMESTAMP_TZ('2024-02-29 13:14:15.5 +05:30', 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM')"
	}
	return "TIMESTAMP '2024-02-29 13:14:15.5'"
}

func yashanLiveText(value *string) string {
	if value == nil {
		return "<nil>"
	}
	return *value
}

// TestYashanDBLiveFetchThroughput 读取 20 万行，确认逐行 yacFetch 不会退化成每行一次网络往返。
func TestYashanDBLiveFetchThroughput(t *testing.T) {
	user := os.Getenv("GONAVI_YASHANDB_TEST_USER")
	if user == "" {
		user = "gonavi"
	}
	for _, addr := range liveAddrs(t, "GONAVI_YASHANDB_TEST_ADDRS") {
		client := connectYashanDBLive(t, addr, user, "")
		started := time.Now()
		rows, err := client.conn.QueryContext(context.Background(), "SELECT LEVEL AS n, 'row-' || LEVEL AS label, SYSDATE AS created FROM dual CONNECT BY LEVEL <= 200000")
		if err != nil {
			t.Fatal(err)
		}
		count := 0
		for rows.Next() {
			count++
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		_ = rows.Close()
		elapsed := time.Since(started)
		t.Logf("fetched %d rows in %s", count, elapsed)
		if count != 200000 || elapsed > 20*time.Second {
			t.Fatalf("fetched %d rows in %s", count, elapsed)
		}
		client.Close()
	}
}
