package sync

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func column(name, colType, nullable string) connection.ColumnDefinition {
	return connection.ColumnDefinition{Name: name, Type: colType, Nullable: nullable}
}

func diffByName(diffs []ColumnStructureDiff) map[string]ColumnStructureDiff {
	byName := make(map[string]ColumnStructureDiff, len(diffs))
	for _, diff := range diffs {
		byName[diff.Column] = diff
	}
	return byName
}

// 两端结构一致的一缺一多就是一次改名：报 renamed 才说得清该改列名，
// 报成「一删一增」会让人以为要删列再加列。
func TestDiffColumnStructuresFoldsUnambiguousRename(t *testing.T) {
	source := []connection.ColumnDefinition{column("order_no", "varchar(32)", "NO")}
	target := []connection.ColumnDefinition{column("order_number", "varchar(32)", "NO")}

	diffs := diffColumnStructures(source, target, "mysql", "mysql")

	if len(diffs) != 1 {
		t.Fatalf("应折叠成一条 renamed, got=%d %#v", len(diffs), diffs)
	}
	diff := diffs[0]
	if diff.Kind != ColumnDiffRenamed {
		t.Fatalf("kind 应为 renamed: %#v", diff)
	}
	if diff.Source != "order_no" || diff.Target != "order_number" {
		t.Fatalf("renamed 必须给出两端列名: %#v", diff)
	}
}

// 结构不同就不是改名，而是真的删一列加一列。
func TestDiffColumnStructuresKeepsAddRemoveWhenStructureDiffers(t *testing.T) {
	source := []connection.ColumnDefinition{column("order_no", "varchar(32)", "NO")}
	target := []connection.ColumnDefinition{column("note", "text", "YES")}

	diffs := diffColumnStructures(source, target, "mysql", "mysql")

	byName := diffByName(diffs)
	if byName["order_no"].Kind != ColumnDiffMissingInTarget {
		t.Fatalf("结构不同时源列应报缺失: %#v", diffs)
	}
	if byName["note"].Kind != ColumnDiffExtraInTarget {
		t.Fatalf("结构不同时目标列应报多出: %#v", diffs)
	}
}

// 一对多无法判断谁改成了谁：宁可保留增删（永远成立），也不要猜错。
func TestDiffColumnStructuresLeavesAmbiguousRenameAsAddRemove(t *testing.T) {
	source := []connection.ColumnDefinition{
		column("a_old", "int", "YES"),
		column("b_old", "int", "YES"),
	}
	target := []connection.ColumnDefinition{
		column("a_new", "int", "YES"),
		column("b_new", "int", "YES"),
	}

	diffs := diffColumnStructures(source, target, "mysql", "mysql")

	for _, diff := range diffs {
		if diff.Kind == ColumnDiffRenamed {
			t.Fatalf("一对多不应推断重命名: %#v", diffs)
		}
	}
	if len(diffs) != 4 {
		t.Fatalf("歧义场景应保留 2 缺 2 多, got=%d %#v", len(diffs), diffs)
	}
}

// 同名不同结构不应被当成重命名。
func TestDiffColumnStructuresDoesNotRenameSameName(t *testing.T) {
	source := []connection.ColumnDefinition{column("amount", "int", "YES")}
	target := []connection.ColumnDefinition{column("amount", "bigint", "YES")}

	diffs := diffColumnStructures(source, target, "mysql", "mysql")
	if len(diffs) != 1 || diffs[0].Kind != ColumnDiffType {
		t.Fatalf("同名类型漂移应报 type: %#v", diffs)
	}
}

// 重命名是推断结果，写任务不能据此跳过补列，必须按不可自动修复处理。
func TestUnsupportedExistingTargetSchemaDiffsTreatsRenameAsUnrepairable(t *testing.T) {
	diffs := []ColumnStructureDiff{{
		Column: "order_no", Kind: ColumnDiffRenamed, Source: "order_no", Target: "order_number",
	}}

	unsupported := unsupportedExistingTargetSchemaDiffs(diffs)

	if len(unsupported) != 1 {
		t.Fatalf("renamed 必须算作不可自动修复: %#v", unsupported)
	}
}

func TestBuildTableDiffStatsCountsRenamed(t *testing.T) {
	stats := buildTableDiffStats(
		[]ColumnStructureDiff{
			{Kind: ColumnDiffRenamed},
			{Kind: ColumnDiffMissingInTarget},
		},
		[]IndexStructureDiff{
			{Kind: IndexDiffRenamed},
			{Kind: IndexDiffChanged},
		},
		false,
	)
	if stats == nil {
		t.Fatal("有差异时必须返回统计")
	}
	if stats.Columns.Renamed != 1 || stats.Columns.MissingInTarget != 1 {
		t.Fatalf("列 renamed 计数错误: %#v", stats.Columns)
	}
	if stats.Indexes.Renamed != 1 || stats.Indexes.Changed != 1 {
		t.Fatalf("索引 renamed 计数错误: %#v", stats.Indexes)
	}
}

func TestSummarizeColumnStructureDiffsMentionsRename(t *testing.T) {
	summary := summarizeColumnStructureDiffs([]ColumnStructureDiff{{Kind: ColumnDiffRenamed}})
	if summary == "" || !strings.Contains(summary, "疑似重命名") {
		t.Fatalf("摘要应提到重命名: %q", summary)
	}
}
