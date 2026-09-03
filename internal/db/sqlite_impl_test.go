//go:build gonavi_full_drivers || gonavi_sqlite_driver

package db

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestSQLiteConnectConfiguresBoundedPoolAndSerializesWrites(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "pool.sqlite")
	client := &SQLiteDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "sqlite", Host: dbPath}); err != nil {
		t.Fatalf("连接 SQLite 失败: %v", err)
	}
	t.Cleanup(func() {
		_ = client.Close()
	})

	if got := client.conn.Stats().MaxOpenConnections; got != sqliteSQLMaxOpenConns {
		t.Fatalf("期望最大连接数为 %d，实际=%d", sqliteSQLMaxOpenConns, got)
	}
	if _, err := client.conn.Exec(`CREATE TABLE pool_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		t.Fatalf("创建测试表失败: %v", err)
	}

	const requestCount = 20
	var wg sync.WaitGroup
	errCh := make(chan error, requestCount)
	for i := 0; i < requestCount; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			_, err := client.conn.ExecContext(
				context.Background(),
				`INSERT INTO pool_items (id, value) VALUES (?, ?)`,
				id,
				fmt.Sprintf("value-%d", id),
			)
			errCh <- err
		}(i)
	}
	wg.Wait()
	close(errCh)
	for err := range errCh {
		if err != nil {
			t.Fatalf("并发写入失败: %v", err)
		}
	}

	var count int
	if err := client.conn.QueryRow(`SELECT COUNT(*) FROM pool_items`).Scan(&count); err != nil {
		t.Fatalf("统计写入结果失败: %v", err)
	}
	if count != requestCount {
		t.Fatalf("期望写入 %d 行，实际=%d", requestCount, count)
	}
	stats := client.conn.Stats()
	if stats.OpenConnections > sqliteSQLMaxOpenConns || stats.Idle > sqliteSQLMaxIdleConns {
		t.Fatalf("SQLite 连接池超出边界: %+v", stats)
	}
}

func TestSQLiteMetadataSupportsApostropheObjectNames(t *testing.T) {
	client := &SQLiteDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "sqlite", Host: ":memory:"}); err != nil {
		t.Fatalf("连接 SQLite 失败: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	const parentTable = "parent'items"
	const table = "order'items"
	const index = "idx'order_parent"
	const trigger = "trg'order_insert"

	if _, err := client.conn.Exec(`CREATE TABLE "parent'items" (id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatalf("创建父表失败: %v", err)
	}
	if _, err := client.conn.Exec(`CREATE TABLE "order'items" (id INTEGER PRIMARY KEY, parent_id INTEGER, FOREIGN KEY (parent_id) REFERENCES "parent'items" (id))`); err != nil {
		t.Fatalf("创建测试表失败: %v", err)
	}
	if _, err := client.conn.Exec(`CREATE INDEX "idx'order_parent" ON "order'items" (parent_id)`); err != nil {
		t.Fatalf("创建索引失败: %v", err)
	}
	if _, err := client.conn.Exec(`CREATE TRIGGER "trg'order_insert" AFTER INSERT ON "order'items" BEGIN SELECT 1; END`); err != nil {
		t.Fatalf("创建触发器失败: %v", err)
	}

	ddl, err := client.GetCreateStatement("main", table)
	if err != nil || !strings.Contains(ddl, table) {
		t.Fatalf("GetCreateStatement = %q, %v", ddl, err)
	}

	indexes, err := client.GetIndexes("main", table)
	if err != nil || len(indexes) != 1 || indexes[0].Name != index || indexes[0].ColumnName != "parent_id" {
		t.Fatalf("GetIndexes = %#v, %v", indexes, err)
	}

	foreignKeys, err := client.GetForeignKeys("main", table)
	if err != nil || len(foreignKeys) != 1 || foreignKeys[0].RefTableName != parentTable || foreignKeys[0].ColumnName != "parent_id" {
		t.Fatalf("GetForeignKeys = %#v, %v", foreignKeys, err)
	}

	triggers, err := client.GetTriggers("main", table)
	if err != nil || len(triggers) != 1 || triggers[0].Name != trigger || triggers[0].Timing != "AFTER" || triggers[0].Event != "INSERT" {
		t.Fatalf("GetTriggers = %#v, %v", triggers, err)
	}
}

func TestSQLiteGetCreateStatementUnquotesDottedIdentifier(t *testing.T) {
	client := &SQLiteDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "sqlite", Host: ":memory:"}); err != nil {
		t.Fatalf("连接 SQLite 失败: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	if _, err := client.conn.Exec(`CREATE TABLE "order.items" (id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatalf("创建带点号表失败: %v", err)
	}
	ddl, err := client.GetCreateStatement("", "`order.items`")
	if err != nil || !strings.Contains(ddl, `"order.items"`) {
		t.Fatalf("GetCreateStatement for quoted dotted table = %q, %v", ddl, err)
	}
	ddl, err = client.GetCreateStatement("main", "[order.items]")
	if err != nil || !strings.Contains(ddl, `"order.items"`) {
		t.Fatalf("GetCreateStatement for SQLite bracketed dotted table = %q, %v", ddl, err)
	}
	ddl, err = client.GetCreateStatement("main", "order.[order.items]")
	if err != nil || !strings.Contains(ddl, `"order.items"`) {
		t.Fatalf("GetCreateStatement for schema-prefixed SQLite bracketed dotted table = %q, %v", ddl, err)
	}
}

func TestSQLiteMetadataUnquotesDottedTableAcrossObjectLookups(t *testing.T) {
	client := &SQLiteDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "sqlite", Host: ":memory:"}); err != nil {
		t.Fatalf("连接 SQLite 失败: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	if _, err := client.conn.Exec(`CREATE TABLE "order.items" (id INTEGER PRIMARY KEY, value TEXT)`); err != nil {
		t.Fatalf("创建带点号表失败: %v", err)
	}
	if _, err := client.conn.Exec(`CREATE INDEX "idx.order.items" ON "order.items" (value)`); err != nil {
		t.Fatalf("创建索引失败: %v", err)
	}
	if _, err := client.conn.Exec(`CREATE TRIGGER "trg.order.items" AFTER INSERT ON "order.items" BEGIN SELECT 1; END`); err != nil {
		t.Fatalf("创建触发器失败: %v", err)
	}

	columns, err := client.GetColumns("main", "main.`order.items`")
	if err != nil || len(columns) != 2 {
		t.Fatalf("GetColumns for quoted dotted table = %#v, %v", columns, err)
	}
	indexes, err := client.GetIndexes("main", "main.`order.items`")
	if err != nil || len(indexes) != 1 || indexes[0].Name != "idx.order.items" {
		t.Fatalf("GetIndexes for quoted dotted table = %#v, %v", indexes, err)
	}
	triggers, err := client.GetTriggers("main", "main.`order.items`")
	if err != nil || len(triggers) != 1 || triggers[0].Name != "trg.order.items" {
		t.Fatalf("GetTriggers for quoted dotted table = %#v, %v", triggers, err)
	}

	// sqlite_master returns the object name without delimiters. The same
	// metadata APIs must therefore keep an unquoted dotted name intact too.
	plainDDL, err := client.GetCreateStatement("main", "order.items")
	if err != nil || !strings.Contains(plainDDL, `"order.items"`) {
		t.Fatalf("GetCreateStatement for plain dotted table = %q, %v", plainDDL, err)
	}
	plainColumns, err := client.GetColumns("main", "order.items")
	if err != nil || len(plainColumns) != 2 {
		t.Fatalf("GetColumns for plain dotted table = %#v, %v", plainColumns, err)
	}
	plainIndexes, err := client.GetIndexes("main", "order.items")
	if err != nil || len(plainIndexes) != 1 || plainIndexes[0].Name != "idx.order.items" {
		t.Fatalf("GetIndexes for plain dotted table = %#v, %v", plainIndexes, err)
	}
	plainTriggers, err := client.GetTriggers("main", "order.items")
	if err != nil || len(plainTriggers) != 1 || plainTriggers[0].Name != "trg.order.items" {
		t.Fatalf("GetTriggers for plain dotted table = %#v, %v", plainTriggers, err)
	}
}

func TestSQLiteMetadataKeepsUnquotedDottedTableAfterKnownDatabase(t *testing.T) {
	client := &SQLiteDB{}
	if err := client.Connect(connection.ConnectionConfig{Type: "sqlite", Host: ":memory:"}); err != nil {
		t.Fatalf("连接 SQLite 失败: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	if _, err := client.conn.Exec(`CREATE TABLE "order.items" (id INTEGER PRIMARY KEY)`); err != nil {
		t.Fatalf("创建带点号表失败: %v", err)
	}
	columns, err := client.GetColumns("main", "main.order.items")
	if err != nil || len(columns) != 1 {
		t.Fatalf("GetColumns for known-db dotted table = %#v, %v", columns, err)
	}
}

func TestResolveSQLiteDSNRejectsHostPort(t *testing.T) {
	_, err := resolveSQLiteDSN(connection.ConnectionConfig{Type: "sqlite", Host: "localhost:3306"})
	if err == nil {
		t.Fatalf("期望拦截 host:port 输入")
	}
	if !strings.Contains(err.Error(), "本地数据库文件路径") {
		t.Fatalf("错误提示不符合预期: %v", err)
	}
}

func TestResolveSQLiteDSNFallbackDatabase(t *testing.T) {
	dsn, err := resolveSQLiteDSN(connection.ConnectionConfig{Type: "sqlite", Database: "/tmp/demo.sqlite"})
	if err != nil {
		t.Fatalf("解析 DSN 失败: %v", err)
	}
	if dsn != "/tmp/demo.sqlite" {
		t.Fatalf("期望使用 database 作为 DSN，实际=%s", dsn)
	}
}

func TestResolveSQLiteDSNNormalizesWindowsLegacyPath(t *testing.T) {
	dsn, err := resolveSQLiteDSN(connection.ConnectionConfig{Type: "sqlite", Host: `F:\py\py\history.db:3306:3306`})
	if err != nil {
		t.Fatalf("解析 DSN 失败: %v", err)
	}
	if dsn != `F:\py\py\history.db` {
		t.Fatalf("期望清理历史端口污染，实际=%s", dsn)
	}
}

func TestResolveSQLiteDSNNormalizesWindowsPathWithLeadingSlash(t *testing.T) {
	dsn, err := resolveSQLiteDSN(connection.ConnectionConfig{Type: "sqlite", Host: `/F:\py\py\history.db:3306`})
	if err != nil {
		t.Fatalf("解析 DSN 失败: %v", err)
	}
	if dsn != `F:\py\py\history.db` {
		t.Fatalf("期望清理前导斜杠与端口污染，实际=%s", dsn)
	}
}

func TestEnsureSQLiteParentDirCreatesNestedDir(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "nested", "child", "demo.sqlite")
	if err := ensureSQLiteParentDir(target); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	info, err := os.Stat(filepath.Dir(target))
	if err != nil {
		t.Fatalf("目录不存在: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("目标不是目录: %s", filepath.Dir(target))
	}
}

func TestLooksLikeHostPort(t *testing.T) {
	if !looksLikeHostPort("localhost:3306") {
		t.Fatalf("localhost:3306 应识别为 host:port")
	}
	if looksLikeHostPort("/tmp/demo.sqlite") {
		t.Fatalf("/tmp/demo.sqlite 不应识别为 host:port")
	}
	if looksLikeHostPort(`C:\sqlite\demo.db`) {
		t.Fatalf("Windows 路径不应识别为 host:port")
	}
}
