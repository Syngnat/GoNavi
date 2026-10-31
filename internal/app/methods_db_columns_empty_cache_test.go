package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

// 列定义返回空时不能写入 45s 元数据缓存：否则一次 schema/代理抖动会让表头在缓存期内
// 一直缺类型和注释，用户看到的就是「刚才还有，现在没了，过一会儿又自己回来」。
func TestDBGetColumnsDoesNotCacheEmptyColumnDefinitions(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	originalResolveDialConfigWithProxyFunc := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalNewDatabaseFunc
		resolveDialConfigWithProxyFunc = originalResolveDialConfigWithProxyFunc
	})

	database := &fakeMetadataRetryDB{}
	newDatabaseFunc = func(string) (db.Database, error) { return database, nil }
	resolveDialConfigWithProxyFunc = func(raw connection.ConnectionConfig) (connection.ConnectionConfig, error) {
		return raw, nil
	}

	application := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	config := connection.ConnectionConfig{Type: "mysql", Host: "metadata.test", Port: 3306, User: "u", Database: "app"}

	first := application.DBGetColumns(config, "app", "users")
	if !first.Success {
		t.Fatalf("expected empty column fetch to stay successful, got failure: %s", first.Message)
	}
	if columns, _ := first.Data.([]connection.ColumnDefinition); len(columns) != 0 {
		t.Fatalf("expected empty columns on first fetch, got %d", len(columns))
	}

	// 表结构本身没变，只是这一次查询拿到了结果（模拟上一次 schema/代理抖动）。
	database.columns = []connection.ColumnDefinition{
		{Name: "id", Type: "bigint"},
		{Name: "name", Type: "varchar(50)"},
	}
	second := application.DBGetColumns(config, "app", "users")
	columns, _ := second.Data.([]connection.ColumnDefinition)
	if len(columns) != 2 {
		t.Fatalf("empty result was cached: second fetch returned %d columns, want 2", len(columns))
	}
	if database.columnCalls != 2 {
		t.Fatalf("expected two backend column fetches, got %d", database.columnCalls)
	}
}
