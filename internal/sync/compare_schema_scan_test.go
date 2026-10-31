package sync

import (
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

// serializedCompareDB 只给 Query 加锁：fakeMigrationDB 会用共享切片记录 SQL，
// 并发扫描下不加锁就是数据竞争。其余方法都是只读 map 访问。
type serializedCompareDB struct {
	db.Database
	mu sync.Mutex
}

func (s *serializedCompareDB) Query(query string) ([]map[string]interface{}, []string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Database.Query(query)
}

func compareTestColumns(first string) []connection.ColumnDefinition {
	return []connection.ColumnDefinition{
		{Name: first, Type: "bigint", Nullable: "NO", Key: "PRI"},
		{Name: "name", Type: "varchar(64)", Nullable: "YES"},
	}
}

// 并发扫描必须保持表顺序，并把目标缺表整表标成缺表差异。
func TestScanCompareSchemaTablesKeepsOrderAndMarksMissingTargets(t *testing.T) {
	source := &serializedCompareDB{Database: &fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
		"dev.customer": compareTestColumns("id"),
		"dev.order":    compareTestColumns("order_id"),
		"dev.orphan":   compareTestColumns("orphan_id"),
	}}}
	target := &serializedCompareDB{Database: &fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{
		"prod.customer": compareTestColumns("id"),
		"prod.order":    compareTestColumns("order_id"),
	}}}
	config := SyncConfig{
		SourceConfig:   connection.ConnectionConfig{Type: "mysql"},
		TargetConfig:   connection.ConnectionConfig{Type: "mysql"},
		SourceDatabase: "dev",
		TargetDatabase: "prod",
		Tables:         []string{"customer", "order", "orphan"},
		Content:        "schema",
		CompareOnly:    true,
	}

	summaries := NewSyncEngine(Reporter{}).scanCompareSchemaTables(config, source.Database, target.Database, 3)

	if len(summaries) != 3 {
		t.Fatalf("expected 3 summaries, got %d: %+v", len(summaries), summaries)
	}
	wantOrder := []string{"customer", "order", "orphan"}
	for index, want := range wantOrder {
		if summaries[index].Table != want {
			t.Fatalf("summary %d = %q, want %q (order must not follow goroutine scheduling)", index, summaries[index].Table, want)
		}
	}
	orphan := summaries[2]
	if orphan.TargetTableExists {
		t.Fatalf("orphan must be reported as a missing target table: %+v", orphan)
	}
	if !orphan.CanSync || orphan.SchemaDiffCount == 0 {
		t.Fatalf("missing target must stay comparable with a diff count: %+v", orphan)
	}
	if len(orphan.ColumnDiffs) != 2 || orphan.ColumnDiffs[0].Kind != "missing_in_target" {
		t.Fatalf("orphan columns must all be missing_in_target: %+v", orphan.ColumnDiffs)
	}
	for _, index := range []int{0, 1} {
		if !summaries[index].TargetTableExists {
			t.Fatalf("existing target %q must be reported as present: %+v", summaries[index].Table, summaries[index])
		}
		if summaries[index].SchemaDiffCount != 0 {
			t.Fatalf("identical tables must have no diff, got %+v", summaries[index])
		}
	}
}
