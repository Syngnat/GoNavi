package sync

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

// batchableCompareDB 给 fakeMigrationDB 补上批量接口，并记录批量调用次数。
type batchableCompareDB struct {
	*fakeMigrationDB
	batchColumns map[string][]connection.ColumnDefinition
	batchIndexes map[string][]connection.IndexDefinition
	columnCalls  int
	indexCalls   int
}

func (b *batchableCompareDB) GetColumnsBatch(string, []string) (map[string][]connection.ColumnDefinition, error) {
	b.columnCalls++
	return b.batchColumns, nil
}

func (b *batchableCompareDB) GetIndexesBatch(string, []string) (map[string][]connection.IndexDefinition, error) {
	b.indexCalls++
	return b.batchIndexes, nil
}

func newBatchableCompareDB() *batchableCompareDB {
	return &batchableCompareDB{
		fakeMigrationDB: &fakeMigrationDB{
			columns: map[string][]connection.ColumnDefinition{},
			tables:  map[string][]string{"dev": {"customer", "order", "empty_columns"}},
		},
		batchColumns: map[string][]connection.ColumnDefinition{
			"customer": {{Name: "id", Type: "bigint", Nullable: "NO"}},
			"order":    {{Name: "order_id", Type: "bigint", Nullable: "NO"}},
		},
		batchIndexes: map[string][]connection.IndexDefinition{
			"customer": {{Name: "PRIMARY", ColumnName: "id", IndexType: "BTREE"}},
		},
	}
}

// 预取后逐表查询必须命中内存，且「不在库里的表」不再产生往返。
func TestPrefetchCompareDatabaseAnswersWithoutRoundTrips(t *testing.T) {
	source := newBatchableCompareDB()
	prefetched, enabled := prefetchCompareDatabase(source, "dev", []string{"customer", "order", "ghost"})
	if !enabled {
		t.Fatal("batch-capable driver must enable prefetch")
	}
	if source.columnCalls != 1 || source.indexCalls != 1 {
		t.Fatalf("prefetch must run exactly once per metadata kind, got columns=%d indexes=%d", source.columnCalls, source.indexCalls)
	}

	columns, err := prefetched.GetColumns("dev", "customer")
	if err != nil || len(columns) != 1 || columns[0].Name != "id" {
		t.Fatalf("expected prefetched columns, got %+v err=%v", columns, err)
	}
	indexes, err := prefetched.GetIndexes("dev", "customer")
	if err != nil || len(indexes) != 1 || indexes[0].Name != "PRIMARY" {
		t.Fatalf("expected prefetched indexes, got %+v err=%v", indexes, err)
	}

	// 库里没有的表直接回空，不能回落到逐表查询。
	missing, err := prefetched.GetColumns("dev", "ghost")
	if err != nil || len(missing) != 0 {
		t.Fatalf("absent table must return empty without a round trip, got %+v err=%v", missing, err)
	}
	// 表存在但批量结果没给出列（例如视图/受限账号）时回落到驱动，保证正确性。
	fallback, err := prefetched.GetColumns("dev", "empty_columns")
	if err != nil || len(fallback) != 0 {
		t.Fatalf("expected fallback to the driver, got %+v err=%v", fallback, err)
	}
}

// 驱动不支持批量时必须原样返回，不得改变任何现有行为。
func TestPrefetchCompareDatabaseFallsBackWhenUnsupported(t *testing.T) {
	plain := &fakeMigrationDB{columns: map[string][]connection.ColumnDefinition{}, tables: map[string][]string{"dev": {"customer"}}}
	prefetched, enabled := prefetchCompareDatabase(plain, "dev", []string{"customer"})

	if enabled {
		t.Fatal("driver without batch support must not enable prefetch")
	}
	if prefetched != plain {
		t.Fatal("fallback must return the original database untouched")
	}
}

// 表名归一化：带 schema 前缀与引号的表名要落到同一个键上。
func TestCompareTableBaseNameStripsQualifiers(t *testing.T) {
	cases := map[string]string{
		"`dev240`.`kf_ai_platform`": "kf_ai_platform",
		"dev240.kf_ai_platform":     "kf_ai_platform",
		`"dev"."orders"`:            "orders",
		"orders":                    "orders",
	}
	for input, want := range cases {
		if got := compareTableBaseName(input); got != want {
			t.Fatalf("compareTableBaseName(%q) = %q, want %q", input, got, want)
		}
	}
}
