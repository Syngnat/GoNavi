package sync

import (
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func indexRows(name string, nonUnique int, indexType string, columns ...string) []connection.IndexDefinition {
	rows := make([]connection.IndexDefinition, 0, len(columns))
	for position, column := range columns {
		rows = append(rows, connection.IndexDefinition{
			Name:       name,
			ColumnName: column,
			NonUnique:  nonUnique,
			SeqInIndex: position + 1,
			IndexType:  indexType,
		})
	}
	return rows
}

func flattenIndexes(groups ...[]connection.IndexDefinition) []connection.IndexDefinition {
	var all []connection.IndexDefinition
	for _, group := range groups {
		all = append(all, group...)
	}
	return all
}

func TestDiffIndexStructuresReportsEachDirection(t *testing.T) {
	source := flattenIndexes(
		indexRows("idx_only_source", 1, "BTREE", "code"),
		indexRows("idx_changed", 1, "BTREE", "name"),
		indexRows("idx_same", 1, "BTREE", "id"),
	)
	target := flattenIndexes(
		indexRows("idx_only_target", 1, "BTREE", "legacy"),
		indexRows("idx_changed", 0, "BTREE", "name"),
		indexRows("idx_same", 1, "BTREE", "id"),
	)

	diffs := diffIndexStructures(source, target)

	byName := map[string]IndexStructureDiff{}
	for _, diff := range diffs {
		byName[diff.Name] = diff
	}
	if len(diffs) != 3 {
		t.Fatalf("应报告 3 条索引差异, got=%d %#v", len(diffs), diffs)
	}
	if got := byName["idx_only_source"]; got.Kind != IndexDiffMissingInTarget {
		t.Fatalf("目标缺失的索引 kind 错误: %#v", got)
	}
	if got := byName["idx_only_target"]; got.Kind != IndexDiffExtraInTarget {
		t.Fatalf("目标多出的索引 kind 错误: %#v", got)
	}
	changed := byName["idx_changed"]
	if changed.Kind != IndexDiffChanged {
		t.Fatalf("同名不同定义应报 changed: %#v", changed)
	}
	if changed.Source == changed.Target {
		t.Fatalf("changed 必须同时给出两端定义: %#v", changed)
	}
	if _, ok := byName["idx_same"]; ok {
		t.Fatalf("完全一致的索引不应出现在差异里")
	}
}

// 同定义换名字（跨引擎的默认索引命名差异很常见）必须报成 renamed，
// 而不是「一删一增」——后者会让整库索引全变成差异。
func TestDiffIndexStructuresReportsRenamedIdenticalIndex(t *testing.T) {
	source := indexRows("idx_orders_code", 1, "BTREE", "code")
	target := indexRows("IDX_ORDERS_CODE_ALT", 1, "BTREE", "code")

	diffs := diffIndexStructures(source, target)
	if len(diffs) != 1 {
		t.Fatalf("同定义不同名应报一条 renamed, got=%d %#v", len(diffs), diffs)
	}
	if diffs[0].Kind != IndexDiffRenamed {
		t.Fatalf("kind 应为 renamed: %#v", diffs[0])
	}
	if diffs[0].Source != "idx_orders_code" || diffs[0].Target != "IDX_ORDERS_CODE_ALT" {
		t.Fatalf("renamed 必须给出两端名字: %#v", diffs[0])
	}
}

func TestDiffIndexStructuresDetectsColumnOrderAndPrefixChanges(t *testing.T) {
	source := flattenIndexes(indexRows("idx_multi", 1, "BTREE", "a", "b"))
	target := flattenIndexes(indexRows("idx_multi", 1, "BTREE", "b", "a"))
	if diffs := diffIndexStructures(source, target); len(diffs) != 1 ||
		diffs[0].Kind != IndexDiffChanged {
		t.Fatalf("列顺序变化应报 changed: %#v", diffs)
	}

	prefixSource := []connection.IndexDefinition{{Name: "idx_p", ColumnName: "code", NonUnique: 1, SeqInIndex: 1, IndexType: "BTREE", SubPart: 10}}
	prefixTarget := []connection.IndexDefinition{{Name: "idx_p", ColumnName: "code", NonUnique: 1, SeqInIndex: 1, IndexType: "BTREE"}}
	if diffs := diffIndexStructures(prefixSource, prefixTarget); len(diffs) != 1 ||
		diffs[0].Kind != IndexDiffChanged {
		t.Fatalf("前缀长度变化应报 changed: %#v", diffs)
	}
}

func TestDiffIndexStructuresReturnsNothingWhenBothSidesAreEmpty(t *testing.T) {
	if diffs := diffIndexStructures(nil, nil); len(diffs) != 0 {
		t.Fatalf("两端都没有索引时不应产生差异: %#v", diffs)
	}
}

type namedIndexDB struct {
	db.Database
	indexes []connection.IndexDefinition
	err     error
}

func (s namedIndexDB) GetIndexes(_, _ string) ([]connection.IndexDefinition, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.indexes, nil
}

// 索引读取失败与「没有索引」无法区分：任一端口失败就必须整体放弃，
// 否则会把整表误报成「全缺索引」。
func TestCompareTableIndexesGivesUpWhenEitherSideFails(t *testing.T) {
	source := namedIndexDB{indexes: indexRows("idx_a", 1, "BTREE", "a")}
	failing := namedIndexDB{err: errors.New("permission denied")}

	if diffs := compareTableIndexes(source, failing, "s", "t", "s", "t"); diffs != nil {
		t.Fatalf("目标端读失败应放弃索引比对: %#v", diffs)
	}
	if diffs := compareTableIndexes(failing, source, "s", "t", "s", "t"); diffs != nil {
		t.Fatalf("源端读失败应放弃索引比对: %#v", diffs)
	}
	if diffs := compareTableIndexes(nil, source, "s", "t", "s", "t"); diffs != nil {
		t.Fatalf("缺少连接时应放弃索引比对: %#v", diffs)
	}
}

func TestCompareTableIndexesComparesReadableSides(t *testing.T) {
	source := namedIndexDB{indexes: indexRows("idx_a", 1, "BTREE", "a")}
	target := namedIndexDB{indexes: indexRows("idx_b", 1, "BTREE", "b")}

	diffs := compareTableIndexes(source, target, "s", "t", "s", "t")
	if len(diffs) != 2 {
		t.Fatalf("应报告一缺一多, got=%d %#v", len(diffs), diffs)
	}
	if diffs[0].Kind != IndexDiffMissingInTarget || diffs[1].Kind != IndexDiffExtraInTarget {
		t.Fatalf("差异顺序应按 缺失 -> 多出 排列: %#v", diffs)
	}
}

func TestBuildTableDiffStatsCountsBothDimensions(t *testing.T) {
	stats := buildTableDiffStats(
		[]ColumnStructureDiff{
			{Kind: "missing_in_target"},
			{Kind: "missing_in_target"},
			{Kind: "type"},
			{Kind: "nullable"},
		},
		[]IndexStructureDiff{
			{Kind: IndexDiffMissingInTarget},
			{Kind: IndexDiffChanged},
		},
		false,
	)
	if stats == nil {
		t.Fatal("有差异时必须返回统计")
	}
	if stats.Columns.MissingInTarget != 2 || stats.Columns.TypeChanged != 1 ||
		stats.Columns.NullableChanged != 1 || stats.Columns.ExtraInTarget != 0 {
		t.Fatalf("列差异计数错误: %#v", stats.Columns)
	}
	if stats.Indexes.MissingInTarget != 1 || stats.Indexes.Changed != 1 ||
		stats.Indexes.ExtraInTarget != 0 {
		t.Fatalf("索引差异计数错误: %#v", stats.Indexes)
	}
	if stats.TargetTableMissing {
		t.Fatalf("目标表存在时不应标记 missing")
	}
}

func TestBuildTableDiffStatsReturnsNilWhenClean(t *testing.T) {
	if stats := buildTableDiffStats(nil, nil, false); stats != nil {
		t.Fatalf("没有差异时不应返回统计: %#v", stats)
	}
}

func TestBuildTableDiffStatsMarksMissingTargetTable(t *testing.T) {
	stats := buildTableDiffStats(
		[]ColumnStructureDiff{{Kind: "missing_in_target"}},
		nil,
		true,
	)
	if stats == nil || !stats.TargetTableMissing {
		t.Fatalf("整表缺失必须显式标记: %#v", stats)
	}
}

func TestSummarizeIndexStructureDiffsCoversAllKinds(t *testing.T) {
	if got := summarizeIndexStructureDiffs(nil); got != "" {
		t.Fatalf("无差异时应返回空串, got=%q", got)
	}
	got := summarizeIndexStructureDiffs([]IndexStructureDiff{
		{Kind: IndexDiffMissingInTarget},
		{Kind: IndexDiffExtraInTarget},
		{Kind: IndexDiffChanged},
		{Kind: IndexDiffChanged},
	})
	for _, fragment := range []string{"目标缺失 1 个索引", "目标多出 1 个索引", "2 个索引定义不同"} {
		if !strings.Contains(got, fragment) {
			t.Fatalf("摘要缺少 %q: %q", fragment, got)
		}
	}
}
