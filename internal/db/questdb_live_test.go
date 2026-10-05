//go:build gonavi_full_drivers || gonavi_questdb_driver

package db

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

// waitForQuestDBRows 等待 WAL 表的异步提交可见（QuestDB 的 WAL 表写入后由后台应用）。
func waitForQuestDBRows(t *testing.T, client Database, table string, want int) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for {
		rows, _, err := client.Query("SELECT count() AS n FROM " + quoteQuestDBIdentifier(table))
		if err == nil && FirstQueryRowValue(rows) == fmt.Sprint(want) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("table %s did not reach %d rows: %v %v", table, want, rows, err)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func TestQuestDBLiveSmoke(t *testing.T) {
	for _, addr := range liveAddrs(t, "GONAVI_QUESTDB_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			config := liveConfig(t, "questdb", addr, "admin", "")
			config.Password = "quest"
			client := &QuestDB{}
			if err := client.Connect(config); err != nil {
				t.Fatalf("connect: %v", err)
			}
			defer client.Close()
			variant, version := client.DriverVariantInfo()
			t.Logf("server %s resolved to variant %s", version, variant)
			if variant == "" || version == "" {
				t.Fatal("variant must be resolved from build()")
			}

			_, _ = client.Exec("DROP VIEW IF EXISTS gonavi_qdb_buys")
			_, _ = client.Exec("DROP MATERIALIZED VIEW IF EXISTS gonavi_qdb_hourly")
			_, _ = client.Exec("DROP TABLE IF EXISTS gonavi_qdb_trades")
			mustExec(t, client, "CREATE TABLE gonavi_qdb_trades (symbol SYMBOL CAPACITY 128 CACHE INDEX, side SYMBOL, price DOUBLE, ts TIMESTAMP) TIMESTAMP(ts) PARTITION BY DAY WAL")
			defer func() { _, _ = client.Exec("DROP TABLE IF EXISTS gonavi_qdb_trades") }()
			mustExec(t, client, "INSERT INTO gonavi_qdb_trades VALUES ('BTC-USD', 'buy', 101.5, '2026-10-03T08:00:00.000000Z'), ('ETH-USD', 'sell', 20.5, '2026-10-03T08:01:00.000000Z')")
			waitForQuestDBRows(t, client, "gonavi_qdb_trades", 2)

			if databases, err := client.GetDatabases(); err != nil || len(databases) == 0 {
				t.Fatalf("databases %v: %v", databases, err)
			}
			columns, err := client.GetColumns("", "gonavi_qdb_trades")
			if err != nil || len(columns) != 4 || !strings.Contains(columns[0].Extra, "INDEXED") || !strings.Contains(columns[3].Extra, "DESIGNATED TIMESTAMP") {
				t.Fatalf("columns %#v: %v", columns, err)
			}
			indexes, err := client.GetIndexes("", "gonavi_qdb_trades")
			if err != nil || len(indexes) != 1 || indexes[0].ColumnName != "symbol" {
				t.Fatalf("indexes %#v: %v", indexes, err)
			}
			ddl, err := client.GetCreateStatement("", "gonavi_qdb_trades")
			t.Logf("ddl: %s", ddl)
			if err != nil || !strings.Contains(ddl, "CREATE TABLE") || !strings.Contains(ddl, "PARTITION BY DAY") || !strings.Contains(strings.ToLower(ddl), "timestamp(ts)") {
				t.Fatalf("ddl %q: %v", ddl, err)
			}
			if keys, err := client.GetForeignKeys("", "gonavi_qdb_trades"); err != nil || len(keys) != 0 {
				t.Fatalf("foreign keys %v: %v", keys, err)
			}
			// 数据浏览分页使用 LIMIT lo, hi（第 lo+1 到第 hi 行）。
			rows, _, err := client.Query("SELECT symbol FROM gonavi_qdb_trades ORDER BY ts LIMIT 1, 2")
			if err != nil || len(rows) != 1 || fmt.Sprint(rows[0]["symbol"]) != "ETH-USD" {
				t.Fatalf("page rows %v: %v", rows, err)
			}

			views := []string{}
			if client.atLeast("8.3") {
				mustExec(t, client, "CREATE MATERIALIZED VIEW gonavi_qdb_hourly AS (SELECT ts, symbol, avg(price) AS avg_price FROM gonavi_qdb_trades SAMPLE BY 1h) PARTITION BY DAY")
				defer func() { _, _ = client.Exec("DROP MATERIALIZED VIEW IF EXISTS gonavi_qdb_hourly") }()
				views = append(views, "gonavi_qdb_hourly")
			}
			if client.atLeast("10.0") {
				mustExec(t, client, "CREATE VIEW gonavi_qdb_buys AS (SELECT * FROM gonavi_qdb_trades WHERE side = 'buy')")
				defer func() { _, _ = client.Exec("DROP VIEW IF EXISTS gonavi_qdb_buys") }()
				views = append(views, "gonavi_qdb_buys")
			}
			tables, err := client.GetTables("")
			if err != nil || !slices.Contains(tables, "gonavi_qdb_trades") {
				t.Fatalf("tables %v: %v", tables, err)
			}
			for _, view := range views {
				if slices.Contains(tables, view) {
					t.Fatalf("view %s must not be listed as a table: %v", view, tables)
				}
				viewDDL, err := client.GetCreateStatement("", view)
				if err != nil || !strings.Contains(viewDDL, "VIEW") {
					t.Fatalf("view ddl %q: %v", viewDDL, err)
				}
			}

			err = client.ApplyChanges("gonavi_qdb_trades", connection.ChangeSet{Deletes: []map[string]interface{}{{"symbol": "BTC-USD"}}})
			if err == nil {
				t.Fatal("row edits must be rejected for QuestDB")
			}
		})
	}
}
