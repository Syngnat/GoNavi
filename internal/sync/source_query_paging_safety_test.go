package sync

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// execRecordingSyncTarget 记录目标库上执行过的语句，用于断言「退回前不得清空目标表」。
type execRecordingSyncTarget struct {
	fakeQuerySyncTargetDB
	execs []string
}

func (t *execRecordingSyncTarget) Exec(query string) (int64, error) {
	t.execs = append(t.execs, query)
	return 0, nil
}

func (t *execRecordingSyncTarget) executedClearStatement() (string, bool) {
	for _, stmt := range t.execs {
		upper := strings.ToUpper(stmt)
		if strings.Contains(upper, "TRUNCATE") || strings.Contains(upper, "DELETE FROM") {
			return stmt, true
		}
	}
	return "", false
}

// TestIsSameSyncEndpointComparesConnectionOnly 端点比较不看表名，
// 供「源是任意 SQL、无法解析出表名」的路径使用。
func TestIsSameSyncEndpointComparesConnectionOnly(t *testing.T) {
	t.Parallel()

	same := SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
	}
	if !isSameSyncEndpoint(same, "mysql", "mysql") {
		t.Fatal("相同连接端点未被识别")
	}

	for name, mutate := range map[string]func(*SyncConfig){
		"不同 database": func(c *SyncConfig) { c.TargetConfig.Database = "archive" },
		"不同 host":     func(c *SyncConfig) { c.TargetConfig.Host = "10.0.0.9" },
		"不同 port":     func(c *SyncConfig) { c.TargetConfig.Port = 3307 },
		"不同 DSN":      func(c *SyncConfig) { c.TargetConfig.DSN = "other" },
		"不同 driver":   func(c *SyncConfig) { c.TargetConfig.Driver = "other" },
	} {
		cfg := same
		mutate(&cfg)
		if isSameSyncEndpoint(cfg, "mysql", "mysql") {
			t.Errorf("%s 却被判为同一端点", name)
		}
	}

	// 方言不同一定不是同一端点。
	if isSameSyncEndpoint(same, "mysql", "postgres") {
		t.Error("不同方言被判为同一端点")
	}
}

// TestIsSamePhysicalSyncTableStillRequiresMatchingTable 重构后表名比较的语义必须保持不变。
func TestIsSamePhysicalSyncTableStillRequiresMatchingTable(t *testing.T) {
	t.Parallel()

	cfg := SyncConfig{
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
	}
	if !isSamePhysicalSyncTable(cfg, SchemaMigrationPlan{SourceQueryTable: "app.events", TargetQueryTable: "app.events"}, "mysql", "mysql") {
		t.Fatal("同库同表未被识别")
	}
	// 端点相同但表名不同：不算自表。
	if isSamePhysicalSyncTable(cfg, SchemaMigrationPlan{SourceQueryTable: "app.events", TargetQueryTable: "app.events_bak"}, "mysql", "mysql") {
		t.Fatal("不同表名被判为自表")
	}
}

// TestTryApplySourceQueryInPagesDeclinesSelfEndpointFullOverwrite 覆盖自表全量覆盖的退回。
//
// 回归背景：SQL 结果集同步的「全量覆盖」分页路径原先先 TRUNCATE 目标表、之后才第一次读取
// 源查询，且没有任何自表守卫。当源查询读的就是目标表时，目标数据被清空后首页读到 0 行，
// 函数返回成功、上层记录「无需变更」，整表数据不可恢复地丢失。修复后同端点直接退回
// 非分页路径（该路径先把源行读入内存再清空）。
func TestTryApplySourceQueryInPagesDeclinesSelfEndpointFullOverwrite(t *testing.T) {
	t.Parallel()

	cfg := SyncConfig{
		Mode:         "full_overwrite",
		SourceQuery:  "SELECT * FROM events WHERE status = 'ok'",
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Host: "127.0.0.1", Port: 3306, Database: "app"},
	}
	ctx := sourceQuerySyncContext{
		TargetQueryTable: "app.events",
		TargetType:       "mysql",
		TargetCols:       []connection.ColumnDefinition{{Name: "id"}, {Name: "status"}},
		PKColumn:         "id",
	}

	engine := &SyncEngine{}
	target := &execRecordingSyncTarget{}
	source := &fakeMigrationDB{}

	handled, counts, err := engine.tryApplySourceQueryInPages(
		cfg, &SyncResult{}, "events", source, target, ctx,
		TableOptions{Insert: true}, "full_overwrite", "app.events",
	)
	if err != nil {
		t.Fatalf("返回错误：%v", err)
	}
	if handled {
		t.Fatal("同端点全量覆盖应退回非分页路径（handled=false），实际被分页路径接管")
	}
	if counts.Inserts != 0 {
		t.Errorf("退回时不应有写入，实际 Inserts=%d", counts.Inserts)
	}
	// 最关键的断言：退回时绝不能已经清空过目标表。
	if stmt, cleared := target.executedClearStatement(); cleared {
		t.Fatalf("退回前已执行清空语句，目标数据会被销毁：%q", stmt)
	}
}

// TestTryApplySourceQueryInPagesReadsBeforeClearing 覆盖「先读首页、再清空」的顺序。
//
// 回归背景：原顺序是先 TRUNCATE 再首读，一旦源查询报错（网络断开、SQL 无效）就留下一张
// 被清空且无法恢复的目标表。TRUNCATE 在 MySQL 上是 DDL、隐式提交且不可回滚。
func TestTryApplySourceQueryInPagesReadsBeforeClearing(t *testing.T) {
	t.Parallel()

	// 源与目标是不同端点，因此不会命中自表退回，会真正进入分页路径。
	cfg := SyncConfig{
		Mode:         "full_overwrite",
		SourceQuery:  "SELECT * FROM events",
		SourceConfig: connection.ConnectionConfig{Type: "mysql", Host: "10.0.0.1", Port: 3306, Database: "src"},
		TargetConfig: connection.ConnectionConfig{Type: "mysql", Host: "10.0.0.2", Port: 3306, Database: "dst"},
	}
	ctx := sourceQuerySyncContext{
		TargetQueryTable: "dst.events",
		TargetType:       "mysql",
		TargetCols:       []connection.ColumnDefinition{{Name: "id"}},
		PKColumn:         "id",
	}

	engine := &SyncEngine{}
	target := &execRecordingSyncTarget{}
	// 源库对任何查询都返回 0 行（fakeMigrationDB 默认行为），模拟首页读取成功但无数据。
	source := &fakeMigrationDB{}

	handled, _, err := engine.tryApplySourceQueryInPages(
		cfg, &SyncResult{}, "events", source, target, ctx,
		TableOptions{Insert: true}, "full_overwrite", "dst.events",
	)
	if err != nil {
		t.Fatalf("返回错误：%v", err)
	}
	if !handled {
		t.Fatal("不同端点应由分页路径接管")
	}

	// 首页读取必须发生在清空之前：源库至少被查询过一次，且清空语句已执行。
	if len(source.queryLog) == 0 {
		t.Fatal("清空目标表前未读取源查询（顺序仍是先清空后读取）")
	}
	if _, cleared := target.executedClearStatement(); !cleared {
		t.Error("全量覆盖模式未清空目标表")
	}
}
