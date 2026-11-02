package app

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

// copyDatabaseStub 记录收到的语句，并可按需让某条失败。
type copyDatabaseStub struct {
	db.Database
	tables   []string
	listErr  error
	executed []string
	// failOn 是让 Exec 返回错误的语句子串；为空表示全部成功。
	failOn string
	// existing 是「已存在」的目标库名集合，用于触发重名重试。
	existing map[string]bool
}

func (s *copyDatabaseStub) Connect(connection.ConnectionConfig) error { return nil }
func (s *copyDatabaseStub) Close() error                              { return nil }
func (s *copyDatabaseStub) Ping() error                               { return nil }

func (s *copyDatabaseStub) GetTables(string) ([]string, error) {
	return s.tables, s.listErr
}

func (s *copyDatabaseStub) Exec(query string) (int64, error) {
	s.executed = append(s.executed, query)
	if s.failOn != "" && strings.Contains(query, s.failOn) {
		return 0, errors.New("boom")
	}
	if strings.HasPrefix(query, "CREATE DATABASE ") {
		name := strings.TrimPrefix(query, "CREATE DATABASE ")
		if s.existing[name] {
			return 0, errors.New("database already exists (errno 1007)")
		}
	}
	return 0, nil
}

// 复用复制表的注入方式：getDatabase 会经 resolveDialConfigWithProxyFunc 拨号，
// 只替换 newDatabaseFunc 不够。
func withCopyDatabaseStub(t *testing.T, stub *copyDatabaseStub) *App {
	t.Helper()
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})
	newDatabaseFunc = func(string) (db.Database, error) { return stub, nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return config, nil
	}
	return NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
}

func copySourceConfig() connection.ConnectionConfig {
	return connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306}
}

func TestCopyDatabaseCreatesCopyAndMovesEveryTable(t *testing.T) {
	stub := &copyDatabaseStub{tables: []string{"orders", "customers"}}
	app := withCopyDatabaseStub(t, stub)

	result := app.CopyDatabase(copySourceConfig(), "shop")

	if !result.Success {
		t.Fatalf("复制库失败: %#v", result)
	}
	if result.Data != "shop_copy1" {
		t.Fatalf("目标库名应为 shop_copy1, got=%v", result.Data)
	}
	joined := strings.Join(stub.executed, "\n")
	for _, want := range []string{
		"CREATE DATABASE `shop_copy1`",
		"CREATE TABLE `shop_copy1`.`orders` LIKE `shop`.`orders`",
		"INSERT INTO `shop_copy1`.`orders` SELECT * FROM `shop`.`orders`",
		"CREATE TABLE `shop_copy1`.`customers` LIKE `shop`.`customers`",
		"INSERT INTO `shop_copy1`.`customers` SELECT * FROM `shop`.`customers`",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("缺少语句 %q\n实际:\n%s", want, joined)
		}
	}
}

// 数据搬运必须在服务端用 INSERT ... SELECT 完成，不能把行读进应用层。
func TestCopyDatabaseDoesNotReadRowsIntoApp(t *testing.T) {
	stub := &copyDatabaseStub{tables: []string{"big"}}
	app := withCopyDatabaseStub(t, stub)

	if result := app.CopyDatabase(copySourceConfig(), "shop"); !result.Success {
		t.Fatalf("复制库失败: %#v", result)
	}
	for _, query := range stub.executed {
		if strings.HasPrefix(query, "SELECT") {
			t.Fatalf("不应把行读进应用层: %q", query)
		}
	}
}

func TestCopyDatabaseRetriesWhenTargetExists(t *testing.T) {
	stub := &copyDatabaseStub{
		tables:   []string{"orders"},
		existing: map[string]bool{"`shop_copy1`": true},
	}
	app := withCopyDatabaseStub(t, stub)

	result := app.CopyDatabase(copySourceConfig(), "shop")

	if !result.Success {
		t.Fatalf("应重试并成功: %#v", result)
	}
	if result.Data != "shop_copy2" {
		t.Fatalf("重名后应使用 shop_copy2, got=%v", result.Data)
	}
}

// 中途失败必须删掉新库，不能留下结构不全的副本。
func TestCopyDatabaseDropsTargetWhenCopyFails(t *testing.T) {
	stub := &copyDatabaseStub{tables: []string{"orders"}, failOn: "INSERT INTO"}
	app := withCopyDatabaseStub(t, stub)

	result := app.CopyDatabase(copySourceConfig(), "shop")

	if result.Success {
		t.Fatalf("应当失败: %#v", result)
	}
	joined := strings.Join(stub.executed, "\n")
	if !strings.Contains(joined, "DROP DATABASE IF EXISTS `shop_copy1`") {
		t.Fatalf("失败后应清理目标库\n实际:\n%s", joined)
	}
}

func TestCopyDatabaseRejectsUnsupportedDialect(t *testing.T) {
	stub := &copyDatabaseStub{tables: []string{"orders"}}
	app := withCopyDatabaseStub(t, stub)
	config := copySourceConfig()
	config.Type = "postgres"

	result := app.CopyDatabase(config, "shop")

	if result.Success {
		t.Fatalf("PostgreSQL 暂不支持跨库复制: %#v", result)
	}
	if len(stub.executed) != 0 {
		t.Fatalf("不支持时不应执行任何语句: %v", stub.executed)
	}
}

func TestCopyDatabaseRequiresDatabaseName(t *testing.T) {
	stub := &copyDatabaseStub{}
	app := withCopyDatabaseStub(t, stub)

	result := app.CopyDatabase(copySourceConfig(), "   ")

	if result.Success {
		t.Fatalf("空库名应被拒绝: %#v", result)
	}
}

func TestCopyDatabaseSurfacesListTablesFailure(t *testing.T) {
	stub := &copyDatabaseStub{listErr: errors.New("permission denied")}
	app := withCopyDatabaseStub(t, stub)

	result := app.CopyDatabase(copySourceConfig(), "shop")

	// 测试环境没有加载文案目录，appText 原样返回 key；这里只断言走到了
	// 「读取表清单失败」这条分支，而不是继续建库。
	if result.Success || !strings.Contains(result.Message, "database_copy_list_tables_failed") {
		t.Fatalf("应报告读取表清单失败: %#v", result)
	}
	if len(stub.executed) != 0 {
		t.Fatalf("读取表清单失败后不应执行任何语句: %v", stub.executed)
	}
}

func TestBuildCopyDatabaseTargetNameHonoursIdentifierLimit(t *testing.T) {
	long := strings.Repeat("a", 70)
	name := buildCopyDatabaseTargetName(long, 1)
	if len([]rune(name)) > 64 {
		t.Fatalf("MySQL 库名上限 64 字符, got=%d", len([]rune(name)))
	}
	if !strings.HasSuffix(name, "_copy1") {
		t.Fatalf("后缀应保留, got=%q", name)
	}
}

func TestBuildCopyDatabaseStatementsQuotesIdentifiers(t *testing.T) {
	statements, err := buildCopyDatabaseStatements("mysql", "we`ird", "we`ird_copy1", []string{"t`1"})
	if err != nil {
		t.Fatalf("生成语句失败: %v", err)
	}
	joined := strings.Join(statements, "\n")
	// 反引号必须被转义成双反引号，否则语句会被截断。
	if !strings.Contains(joined, "`we``ird_copy1`") {
		t.Fatalf("标识符中的反引号应被转义:\n%s", joined)
	}
	if !strings.Contains(joined, "`t``1`") {
		t.Fatalf("表名中的反引号应被转义:\n%s", joined)
	}
}

var _ = context.Background
