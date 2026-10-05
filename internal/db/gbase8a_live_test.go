//go:build gonavi_full_drivers || gonavi_gbase8a_driver

package db

import (
	"context"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func connectGBase8aLive(t *testing.T, addr, database string) *GBase8aDB {
	t.Helper()
	config := liveConfig(t, "gbase8a", addr, "root", database)
	config.Password = os.Getenv("GONAVI_GBASE8A_TEST_PASSWORD")
	if config.Password == "" {
		config.Password = "root"
	}
	client := &GBase8aDB{}
	if err := client.Connect(config); err != nil {
		t.Fatalf("connect %s: %v", addr, err)
	}
	return client
}

func expectLocalizedError(t *testing.T, err error, key string, params map[string]any) {
	t.Helper()
	if err == nil || err.Error() != localizedDriverRuntimeText(key, params) {
		t.Fatalf("expected %s, got %v", key, err)
	}
}

func gbase8aLiveCount(t *testing.T, client *GBase8aDB, query string) int64 {
	t.Helper()
	rows, _, err := client.Query(query)
	if err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	value, err := strconv.ParseInt(strings.TrimSpace(FirstQueryRowValue(rows)), 10, 64)
	if err != nil {
		t.Fatalf("%s returned %v", query, rows)
	}
	return value
}

// TestGBase8aLiveSmoke 连真实 GBase 8a（MySQL 协议，root 账号），覆盖版本识别、库表元数据、网格提交的原子性
// 与托管事务。地址来自 GONAVI_GBASE8A_TEST_ADDRS，密码来自 GONAVI_GBASE8A_TEST_PASSWORD（缺省 root）。
func TestGBase8aLiveSmoke(t *testing.T) {
	for _, addr := range liveAddrs(t, "GONAVI_GBASE8A_TEST_ADDRS") {
		t.Run(addr, func(t *testing.T) {
			admin := connectGBase8aLive(t, addr, "")
			defer admin.Close()
			variant, version := admin.DriverVariantInfo()
			t.Logf("server %s resolved to variant %s", version, variant)
			if variant != "v8" || !strings.HasPrefix(version, "8.") && !strings.HasPrefix(version, "9.") {
				t.Fatalf("unexpected variant %s / version %s", variant, version)
			}
			_, _ = admin.Exec("DROP DATABASE IF EXISTS gonavi_live")
			mustExec(t, admin, "CREATE DATABASE gonavi_live")
			defer admin.Exec("DROP DATABASE IF EXISTS gonavi_live")
			databases, err := admin.GetDatabases()
			if err != nil || !slices.Contains(databases, "gonavi_live") || slices.Contains(databases, "gctmpdb") {
				t.Fatalf("databases %v: %v", databases, err)
			}

			client := connectGBase8aLive(t, addr, "gonavi_live")
			defer client.Close()
			for _, statement := range []string{
				"CREATE TABLE orders (id INT NOT NULL PRIMARY KEY, customer VARCHAR(40), amount DECIMAL(10,2), created DATETIME) COMMENT 'orders'",
				"ALTER TABLE orders ADD INDEX idx_customer USING HASH (customer)",
				"INSERT INTO orders VALUES (1, 'alice', 10.50, '2026-01-01 10:00:00'), (2, 'bob', 20.00, NULL)",
				"CREATE VIEW big_orders AS SELECT id, amount FROM orders WHERE amount > 15",
			} {
				mustExec(t, client, statement)
			}
			tables, err := client.GetTables("gonavi_live")
			if err != nil || !slices.Contains(tables, "orders") {
				t.Fatalf("tables %v: %v", tables, err)
			}
			columns, err := client.GetColumns("gonavi_live", "orders")
			if err != nil || len(columns) != 4 || columns[0].Name != "id" || columns[0].Key != "PRI" {
				t.Fatalf("columns %+v: %v", columns, err)
			}
			indexes, err := client.GetIndexes("gonavi_live", "orders")
			if err != nil || !slices.ContainsFunc(indexes, func(index connection.IndexDefinition) bool { return index.Name == "idx_customer" }) {
				t.Fatalf("indexes %+v: %v", indexes, err)
			}
			ddl, err := client.GetCreateStatement("gonavi_live", "orders")
			if err != nil || !strings.Contains(ddl, "PRIMARY KEY") || !strings.Contains(strings.ToUpper(ddl), "USING HASH") {
				t.Fatalf("ddl %q: %v", ddl, err)
			}

			// 网格提交：同类改动合成一条语句、整体提交；新增 / 修改 / 删除混合时提示分开提交。
			err = client.ApplyChanges("orders", connection.ChangeSet{
				Inserts: []map[string]interface{}{{"id": 3, "customer": "carol"}},
				Deletes: []map[string]interface{}{{"id": 2}},
			})
			expectLocalizedError(t, err, "db.backend.error.gbase8a_mixed_changes", nil)
			if err := client.ApplyChanges("orders", connection.ChangeSet{Inserts: []map[string]interface{}{
				{"id": 3, "customer": "carol", "amount": "30.00"}, {"id": 4, "customer": "dave", "amount": "40.00"}, {"id": 5, "customer": "erin"},
			}}); err != nil {
				t.Fatalf("insert rows: %v", err)
			}
			if err := client.ApplyChanges("orders", connection.ChangeSet{Updates: []connection.UpdateRow{
				{Keys: map[string]interface{}{"id": 1}, Values: map[string]interface{}{"customer": "alice2"}},
				{Keys: map[string]interface{}{"id": 3}, Values: map[string]interface{}{"amount": "33.30", "created": "2026-02-01 08:00:00"}},
			}}); err != nil {
				t.Fatalf("update rows: %v", err)
			}
			if got := gbase8aLiveCount(t, client, "SELECT COUNT(*) FROM orders WHERE (id = 1 AND customer = 'alice2' AND amount = 10.50) OR (id = 3 AND customer = 'carol' AND amount = 33.30 AND created = '2026-02-01 08:00:00')"); got != 2 {
				t.Fatalf("merged update applied to %d rows", got)
			}
			// 只匹配到部分行的修改整体回滚。
			err = client.ApplyChanges("orders", connection.ChangeSet{Updates: []connection.UpdateRow{
				{Keys: map[string]interface{}{"id": 4}, Values: map[string]interface{}{"customer": "dave2"}},
				{Keys: map[string]interface{}{"id": 999}, Values: map[string]interface{}{"customer": "ghost"}},
			}})
			expectLocalizedError(t, err, "db.backend.error.gbase8a_rows_mismatch", map[string]any{"expected": 2, "actual": int64(1)})
			if got := gbase8aLiveCount(t, client, "SELECT COUNT(*) FROM orders WHERE customer = 'dave2'"); got != 0 {
				t.Fatal("a partially matched update must be rolled back")
			}
			if err := client.ApplyChanges("orders", connection.ChangeSet{Deletes: []map[string]interface{}{{"id": 2}, {"id": 5}}}); err != nil {
				t.Fatalf("delete rows: %v", err)
			}
			if got := gbase8aLiveCount(t, client, "SELECT COUNT(*) FROM orders"); got != 3 {
				t.Fatalf("rows after delete: %d", got)
			}

			// 托管事务：回滚丢弃写入，提交后对其他连接可见；结束后连接池恢复自动提交。
			for _, commit := range []bool{false, true} {
				transaction, err := client.OpenTransactionExecer(context.Background())
				if err != nil {
					t.Fatalf("open transaction: %v", err)
				}
				if _, err := transaction.Exec("INSERT INTO orders (id, customer) VALUES (10, 'tx')"); err != nil {
					t.Fatalf("insert in transaction: %v", err)
				}
				if !commit {
					// 同一事务里 INSERT 之后再 UPDATE 同一张表会被服务端拒绝，错误带上原因说明。
					_, err := transaction.Exec("UPDATE orders SET customer = 'x' WHERE id = 1")
					if err == nil || !strings.Contains(err.Error(), "1015") {
						t.Fatalf("expected the GBase lock limitation error, got %v", err)
					}
				}
				if commit {
					err = transaction.Commit()
				} else {
					err = transaction.Rollback()
				}
				if err != nil {
					t.Fatalf("finish transaction (commit=%v): %v", commit, err)
				}
				_ = transaction.Close()
				want := map[bool]int64{false: 0, true: 1}[commit]
				if got := gbase8aLiveCount(t, admin, "SELECT COUNT(*) FROM gonavi_live.orders WHERE id = 10"); got != want {
					t.Fatalf("after commit=%v another connection sees %d rows, want %d", commit, got, want)
				}
			}
			mustExec(t, client, "INSERT INTO orders (id, customer) VALUES (11, 'autocommit')")
			if got := gbase8aLiveCount(t, admin, "SELECT COUNT(*) FROM gonavi_live.orders WHERE id = 11"); got != 1 {
				t.Fatal("pooled connections must be back in autocommit mode after a transaction")
			}
		})
	}
}
