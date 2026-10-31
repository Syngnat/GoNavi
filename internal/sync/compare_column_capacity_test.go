package sync

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestTextFamilyRank(t *testing.T) {
	cases := map[string]int{
		"tinytext":      1,
		"text":          2,
		"mediumtext":    3,
		"longtext":      4,
		"longtext ":     4,
		"LONGTEXT":      4,
		"varchar(255)":  0,
		"int":           0,
		"":              0,
		"text charset":  2,
		"mediumtext(0)": 3,
	}
	for raw, want := range cases {
		if got := textFamilyRank(raw); got != want {
			t.Fatalf("textFamilyRank(%q)=%d, want %d", raw, got, want)
		}
	}
}

func TestIsWithinFamilyCapacityShrinkOnlyCoversTextFamily(t *testing.T) {
	shrink := [][2]string{
		{"longtext", "mediumtext"},
		{"mediumtext", "text"},
		{"text", "tinytext"},
	}
	for _, pair := range shrink {
		if !isWithinFamilyCapacityShrink(pair[0], pair[1]) {
			t.Fatalf("%s -> %s 应判定为 TEXT 族降级", pair[0], pair[1])
		}
	}

	// 扩容、字符型收窄、族切换都不是「容量降级」。
	notShrink := [][2]string{
		{"text", "longtext"},
		{"varchar(200)", "varchar(50)"},
		{"varchar(255)", "text"},
		{"longtext", "varchar(255)"},
		{"int", "tinyint"},
	}
	for _, pair := range notShrink {
		if isWithinFamilyCapacityShrink(pair[0], pair[1]) {
			t.Fatalf("%s -> %s 不应判定为 TEXT 族降级", pair[0], pair[1])
		}
	}
}

func TestDiffColumnStructuresMarksTextShrinkAsCapacityDegraded(t *testing.T) {
	source := []connection.ColumnDefinition{column("content", "longtext", "YES")}
	target := []connection.ColumnDefinition{column("content", "mediumtext", "YES")}

	diffs := diffColumnStructures(source, target, "mysql", "mysql")

	if len(diffs) != 1 {
		t.Fatalf("应只有一条差异, got=%d %#v", len(diffs), diffs)
	}
	if diffs[0].Kind != ColumnDiffCapacityDegraded {
		t.Fatalf("TEXT 族降级应标 capacity_degraded: %#v", diffs[0])
	}
	if diffs[0].Source != "longtext" || diffs[0].Target != "mediumtext" {
		t.Fatalf("方向必须是 源端 → 目标端: %#v", diffs[0])
	}
}

// 字符型收窄会让建表或写入失败，必须仍按高风险的类型变更处理。
func TestDiffColumnStructuresKeepsVarcharShrinkAsType(t *testing.T) {
	source := []connection.ColumnDefinition{column("code", "varchar(200)", "YES")}
	target := []connection.ColumnDefinition{column("code", "varchar(50)", "YES")}

	diffs := diffColumnStructures(source, target, "mysql", "mysql")

	if len(diffs) != 1 || diffs[0].Kind != ColumnDiffType {
		t.Fatalf("varchar 收窄应仍报 type: %#v", diffs)
	}
}

func TestDiffColumnAttributesReportsDefaultAndComment(t *testing.T) {
	withDefault := func(value string, has bool) connection.ColumnDefinition {
		return connection.ColumnDefinition{
			Name: "created_at", Type: "datetime", Default: &value, HasDefault: has,
		}
	}
	source := []connection.ColumnDefinition{{
		Name: "created_at", Type: "datetime", Default: ptrString("CURRENT_TIMESTAMP"),
		HasDefault: true, Comment: "创建时间",
	}}
	target := []connection.ColumnDefinition{{
		Name: "created_at", Type: "datetime", Default: ptrString(""), HasDefault: false,
		Comment: "",
	}}

	diffs := diffColumnAttributes(source, target)

	byKind := map[string]ColumnAttributeDiff{}
	for _, diff := range diffs {
		byKind[diff.Kind] = diff
	}
	if got := byKind[ColumnAttributeDefault]; got.Source != "CURRENT_TIMESTAMP" || got.Target != "" {
		t.Fatalf("默认值差异方向错误: %#v", got)
	}
	if got := byKind[ColumnAttributeComment]; got.Source != "创建时间" || got.Target != "" {
		t.Fatalf("注释差异方向错误: %#v", got)
	}
	_ = withDefault
}

func TestDiffColumnAttributesIgnoresBothEmptyComments(t *testing.T) {
	source := []connection.ColumnDefinition{column("a", "int", "YES")}
	target := []connection.ColumnDefinition{column("a", "int", "YES")}

	if diffs := diffColumnAttributes(source, target); len(diffs) != 0 {
		t.Fatalf("两端都取不到注释时不应报差异: %#v", diffs)
	}
}

func TestDiffColumnAttributesSkipsColumnsMissingOnTarget(t *testing.T) {
	source := []connection.ColumnDefinition{
		column("a", "int", "YES"),
		column("b", "int", "YES"),
	}
	target := []connection.ColumnDefinition{column("a", "int", "YES")}

	diffs := diffColumnAttributes(source, target)

	for _, diff := range diffs {
		if diff.Column == "b" {
			t.Fatalf("整列缺失应由列差异负责，附表不该重复报: %#v", diffs)
		}
	}
}

func ptrString(value string) *string { return &value }
