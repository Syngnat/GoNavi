package sync

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/shared/i18n"
)

func TestDiffRowsByKeyColumnsUsesCompleteCompositeKey(t *testing.T) {
	source := []map[string]interface{}{
		{"tenant_id": int64(1), "order_id": int64(7), "status": "paid"},
		{"tenant_id": int64(2), "order_id": int64(7), "status": "new"},
	}
	target := []map[string]interface{}{
		{"tenant_id": int64(1), "order_id": int64(7), "status": "new"},
		{"tenant_id": int64(3), "order_id": int64(7), "status": "old"},
	}
	inserts, updates, deletes, same := diffRowsByKeyColumns([]string{"tenant_id", "order_id"}, source, target)
	if len(inserts) != 1 || len(updates) != 1 || len(deletes) != 1 || same != 0 {
		t.Fatalf("unexpected composite diff: inserts=%#v updates=%#v deletes=%#v same=%d", inserts, updates, deletes, same)
	}
	if got := updates[0].Keys; len(got) != 2 || got["tenant_id"] != int64(1) || got["order_id"] != int64(7) {
		t.Fatalf("update keys = %#v, want complete composite key", got)
	}
	if got := deletes[0]; len(got) != 2 || got["tenant_id"] != int64(3) || got["order_id"] != int64(7) {
		t.Fatalf("delete keys = %#v, want complete composite key", got)
	}
}

func TestDiffRowsByKeyColumnsPreservesWhitespaceAndEmptyStrings(t *testing.T) {
	source := []map[string]interface{}{
		{"tenant_id": "", "order_id": "7", "status": "insert"},
		{"tenant_id": " tenant", "order_id": "8", "status": "left-space"},
	}
	target := []map[string]interface{}{
		{"tenant_id": "tenant", "order_id": "8", "status": "no-space"},
	}

	inserts, updates, deletes, same := diffRowsByKeyColumns([]string{"tenant_id", "order_id"}, source, target)
	if len(inserts) != 2 || len(updates) != 0 || len(deletes) != 1 || same != 0 {
		t.Fatalf("whitespace-sensitive diff: inserts=%#v updates=%#v deletes=%#v same=%d", inserts, updates, deletes, same)
	}
	if key, ok := syncRowKey(source[0], []string{"tenant_id", "order_id"}); !ok || key != `["","7"]` {
		t.Fatalf("empty-string composite key = %q, %v", key, ok)
	}
}

type fakeQuerySyncTargetDB struct {
	fakeMigrationDB
	appliedTable   string
	appliedChanges connection.ChangeSet
	appliedBatches []connection.ChangeSet
}

func (f *fakeQuerySyncTargetDB) ApplyChanges(tableName string, changes connection.ChangeSet) error {
	f.appliedTable = tableName
	f.appliedChanges.Inserts = append(f.appliedChanges.Inserts, changes.Inserts...)
	f.appliedChanges.Updates = append(f.appliedChanges.Updates, changes.Updates...)
	f.appliedChanges.Deletes = append(f.appliedChanges.Deletes, changes.Deletes...)
	f.appliedBatches = append(f.appliedBatches, changes)
	return nil
}

var _ db.BatchApplier = (*fakeQuerySyncTargetDB)(nil)

type errorMigrationDB struct {
	fakeMigrationDB
	getColumnsErr error
	queryErrors   map[string]error
}

type connectErrorMigrationDB struct {
	fakeMigrationDB
	connectErr error
}

type syncDatabaseFactoryStep struct {
	db  db.Database
	err error
}

func (f *errorMigrationDB) Query(query string) ([]map[string]interface{}, []string, error) {
	if err, ok := f.queryErrors[query]; ok {
		f.queryLog = append(f.queryLog, query)
		return nil, nil, err
	}
	return f.fakeMigrationDB.Query(query)
}

func (f *errorMigrationDB) GetColumns(dbName, tableName string) ([]connection.ColumnDefinition, error) {
	if f.getColumnsErr != nil {
		return nil, f.getColumnsErr
	}
	return f.fakeMigrationDB.GetColumns(dbName, tableName)
}

func (f *connectErrorMigrationDB) Connect(config connection.ConnectionConfig) error {
	return f.connectErr
}

func useSyncDatabaseFactorySequence(t *testing.T, steps ...syncDatabaseFactoryStep) {
	t.Helper()

	oldFactory := newSyncDatabase
	index := 0
	newSyncDatabase = func(dbType string) (db.Database, error) {
		if index >= len(steps) {
			t.Fatalf("unexpected newSyncDatabase call %d for %s", index+1, dbType)
		}
		step := steps[index]
		index++
		return step.db, step.err
	}
	t.Cleanup(func() {
		newSyncDatabase = oldFactory
	})
}

func baseSourceQuerySyncConfig() SyncConfig {
	return SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Database: "app"},
		SourceQuery:  "SELECT id, name FROM active_users",
		Tables:       []string{"users"},
		Mode:         "insert_update",
	}
}

func localizedSyncTestText(t *testing.T, language i18n.Language, key string, params map[string]any) string {
	t.Helper()

	localizer, err := i18n.NewLocalizer(language)
	if err != nil {
		t.Fatalf("NewLocalizer(%s) error = %v", language, err)
	}
	return localizer.T(key, params)
}

func assertNoLegacySourceQueryChinese(t *testing.T, text string) {
	t.Helper()

	legacyFragments := []string{
		"源查询 SQL 不能为空",
		"SQL 结果集同步当前仅支持",
		"SQL 结果集同步要求且仅允许选择一个目标表",
		"目标表不能为空",
		"目标表无主键，不支持基于 SQL 结果集的差异分析",
		"目标表为复合主键",
		"获取目标表字段失败",
		"不存在或未读取到字段定义",
		"执行源查询失败",
		"读取目标表失败",
		"\u521d\u59cb\u5316\u6e90\u6570\u636e\u5e93\u9a71\u52a8\u5931\u8d25",
		"\u521d\u59cb\u5316\u76ee\u6807\u6570\u636e\u5e93\u9a71\u52a8\u5931\u8d25",
		"\u6e90\u6570\u636e\u5e93\u8fde\u63a5\u5931\u8d25",
		"\u76ee\u6807\u6570\u636e\u5e93\u8fde\u63a5\u5931\u8d25",
		"已完成 1 个目标表的差异分析",
		"SQL 结果集差异分析完成",
		"SQL 结果集同步预览",
		"差异分析开始",
		"差异分析完成",
		"开始同步",
		"同步来源：SQL 结果集 -> 目标表",
	}
	for _, fragment := range legacyFragments {
		if strings.Contains(text, fragment) {
			t.Fatalf("expected localized message without legacy Chinese fragment %q, got %q", fragment, text)
		}
	}
}
