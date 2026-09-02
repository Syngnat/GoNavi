package sync

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func columnDiffKinds(diffs []ColumnStructureDiff) map[string]ColumnStructureDiff {
	byColumn := make(map[string]ColumnStructureDiff, len(diffs))
	for _, diff := range diffs {
		byColumn[diff.Kind+":"+diff.Column] = diff
	}
	return byColumn
}

// 目标多出字段是旧 diffMissingColumnNames 完全看不到的方向：它只遍历源列，
// 目标独有的列从未被检查，于是两张结构不同的表被报成"结构已一致"。
func TestDiffColumnStructuresReportsExtraTargetColumn(t *testing.T) {
	sourceCols := []connection.ColumnDefinition{
		{Name: "id", Type: "int(11)", Nullable: "NO", Key: "PRI"},
	}
	targetCols := []connection.ColumnDefinition{
		{Name: "id", Type: "int(11)", Nullable: "NO", Key: "PRI"},
		{Name: "new_column", Type: "varchar(255)", Nullable: "YES"},
	}

	diffs := diffColumnStructures(sourceCols, targetCols, "mysql", "mysql")
	if len(diffs) != 1 {
		t.Fatalf("expected exactly one diff, got %+v", diffs)
	}
	diff := diffs[0]
	if diff.Kind != "extra_in_target" || diff.Column != "new_column" {
		t.Fatalf("expected extra_in_target for new_column, got %+v", diff)
	}
	if diff.Target != "varchar(255)" {
		t.Fatalf("expected target description to carry the type, got %q", diff.Target)
	}
	if diff.Source != "" {
		t.Fatalf("extra_in_target has no source column, got %q", diff.Source)
	}
}

func TestDiffColumnStructuresReportsMissingTargetColumn(t *testing.T) {
	sourceCols := []connection.ColumnDefinition{
		{Name: "id", Type: "int(11)", Nullable: "NO", Key: "PRI"},
		{Name: "remark", Type: "varchar(255)", Nullable: "NO"},
	}
	targetCols := []connection.ColumnDefinition{
		{Name: "id", Type: "int(11)", Nullable: "NO", Key: "PRI"},
	}

	diffs := diffColumnStructures(sourceCols, targetCols, "mysql", "mysql")
	if len(diffs) != 1 {
		t.Fatalf("expected exactly one diff, got %+v", diffs)
	}
	diff := diffs[0]
	if diff.Kind != "missing_in_target" || diff.Column != "remark" {
		t.Fatalf("expected missing_in_target for remark, got %+v", diff)
	}
	// NOT NULL 必须体现在描述里：可空性决定补列 SQL 是否需要默认值。
	if diff.Target != "" || diff.Source != "varchar(255) NOT NULL" {
		t.Fatalf("expected source description with NOT NULL, got %+v", diff)
	}
}

func TestDiffColumnStructuresDetectsTypeAndNullabilityWithinSameEngine(t *testing.T) {
	sourceCols := []connection.ColumnDefinition{
		{Name: "id", Type: "int(11)", Nullable: "NO", Key: "PRI"},
		{Name: "title", Type: "varchar(200)", Nullable: "NO"},
		{Name: "note", Type: "text", Nullable: "NO"},
	}
	targetCols := []connection.ColumnDefinition{
		{Name: "id", Type: "int(11)", Nullable: "NO", Key: "PRI"},
		{Name: "title", Type: "varchar(50)", Nullable: "NO"},
		{Name: "note", Type: "text", Nullable: "YES"},
	}

	diffs := diffColumnStructures(sourceCols, targetCols, "mysql", "mysql")
	byKind := columnDiffKinds(diffs)
	if len(diffs) != 2 {
		t.Fatalf("expected one type diff and one nullable diff, got %+v", diffs)
	}
	typeDiff, ok := byKind["type:title"]
	if !ok {
		t.Fatalf("expected a type diff for title, got %+v", diffs)
	}
	if typeDiff.Source != "varchar(200)" || typeDiff.Target != "varchar(50)" {
		t.Fatalf("type diff must carry both sides, got %+v", typeDiff)
	}
	nullableDiff, ok := byKind["nullable:note"]
	if !ok {
		t.Fatalf("expected a nullable diff for note, got %+v", diffs)
	}
	if nullableDiff.Source != "NO" || nullableDiff.Target != "YES" {
		t.Fatalf("nullable diff must carry both sides, got %+v", nullableDiff)
	}
}

// 跨引擎时等价类型的字面量不同（MySQL int / PostgreSQL integer）。若无条件比对，
// 每一列都会被标记为差异，真实问题会被噪音淹没。
func TestDiffColumnStructuresSkipsTypeComparisonAcrossEngines(t *testing.T) {
	sourceCols := []connection.ColumnDefinition{
		{Name: "id", Type: "int(11)", Nullable: "NO", Key: "PRI"},
		{Name: "title", Type: "varchar(200)", Nullable: "NO"},
	}
	targetCols := []connection.ColumnDefinition{
		{Name: "id", Type: "integer", Nullable: "YES"},
		{Name: "title", Type: "character varying(200)", Nullable: "NO"},
	}

	diffs := diffColumnStructures(sourceCols, targetCols, "mysql", "postgres")
	if len(diffs) != 0 {
		t.Fatalf("cross-engine compare must not report type/nullable noise, got %+v", diffs)
	}
}

// 跨引擎仍必须报告字段缺失/多余：那与类型拼写无关。
func TestDiffColumnStructuresStillReportsColumnGapsAcrossEngines(t *testing.T) {
	sourceCols := []connection.ColumnDefinition{
		{Name: "id", Type: "int(11)", Nullable: "NO", Key: "PRI"},
		{Name: "remark", Type: "varchar(255)", Nullable: "YES"},
	}
	targetCols := []connection.ColumnDefinition{
		{Name: "id", Type: "integer", Nullable: "NO"},
		{Name: "extra", Type: "text", Nullable: "YES"},
	}

	diffs := diffColumnStructures(sourceCols, targetCols, "mysql", "postgres")
	byKind := columnDiffKinds(diffs)
	if len(diffs) != 2 {
		t.Fatalf("expected the two column gaps, got %+v", diffs)
	}
	if _, ok := byKind["missing_in_target:remark"]; !ok {
		t.Fatalf("expected missing_in_target for remark, got %+v", diffs)
	}
	if _, ok := byKind["extra_in_target:extra"]; !ok {
		t.Fatalf("expected extra_in_target for extra, got %+v", diffs)
	}
}

// 列名比对必须忽略大小写，否则同一列会同时被报成"目标缺失"和"目标多出"。
func TestDiffColumnStructuresMatchesColumnNamesCaseInsensitively(t *testing.T) {
	sourceCols := []connection.ColumnDefinition{
		{Name: "ID", Type: "int(11)", Nullable: "NO", Key: "PRI"},
	}
	targetCols := []connection.ColumnDefinition{
		{Name: "id", Type: "int(11)", Nullable: "NO", Key: "PRI"},
	}

	if diffs := diffColumnStructures(sourceCols, targetCols, "mysql", "mysql"); len(diffs) != 0 {
		t.Fatalf("case-only name difference is not a structural diff, got %+v", diffs)
	}
}

func TestDiffColumnStructuresIgnoresBlankColumnNames(t *testing.T) {
	sourceCols := []connection.ColumnDefinition{
		{Name: "  ", Type: "int(11)"},
		{Name: "id", Type: "int(11)", Nullable: "NO"},
	}
	targetCols := []connection.ColumnDefinition{
		{Name: "", Type: "text"},
		{Name: "id", Type: "int(11)", Nullable: "NO"},
	}

	if diffs := diffColumnStructures(sourceCols, targetCols, "mysql", "mysql"); len(diffs) != 0 {
		t.Fatalf("blank column names must be skipped, got %+v", diffs)
	}
}

// 缺失可空性元数据的驱动不应产生假差异。
func TestDiffColumnStructuresSkipsNullableWhenMetadataMissing(t *testing.T) {
	sourceCols := []connection.ColumnDefinition{
		{Name: "id", Type: "int(11)", Nullable: "NO"},
	}
	targetCols := []connection.ColumnDefinition{
		{Name: "id", Type: "int(11)", Nullable: ""},
	}

	if diffs := diffColumnStructures(sourceCols, targetCols, "mysql", "mysql"); len(diffs) != 0 {
		t.Fatalf("absent nullability metadata must not be reported, got %+v", diffs)
	}
}

// 同一 MySQL 家族（mysql/mariadb 归一为同类型）应继续比对类型。
func TestDiffColumnStructuresTreatsNormalizedFamilyAsSameEngine(t *testing.T) {
	sourceCols := []connection.ColumnDefinition{
		{Name: "title", Type: "varchar(200)", Nullable: "NO"},
	}
	targetCols := []connection.ColumnDefinition{
		{Name: "title", Type: "varchar(50)", Nullable: "NO"},
	}

	diffs := diffColumnStructures(sourceCols, targetCols, "mysql", "goldendb")
	if len(diffs) != 1 || diffs[0].Kind != "type" {
		t.Fatalf("goldendb normalizes to mysql, so types must be compared, got %+v", diffs)
	}
}

// 补列和目标额外审计字段不影响写入；源端更严格、目标更宽松的可空性也
// 可以安全导入。只有当前不能保证安全写入的实际类型差异和反向可空性才阻断。
func TestUnsupportedExistingTargetSchemaDiffsExcludesMissingColumns(t *testing.T) {
	diffs := []ColumnStructureDiff{
		{Column: "a", Kind: "missing_in_target"},
		{Column: "b", Kind: "type"},
		{Column: "c", Kind: "nullable", Source: "YES", Target: "NO"},
		{Column: "d", Kind: "extra_in_target"},
	}

	unsupported := unsupportedExistingTargetSchemaDiffs(diffs)
	if len(unsupported) != 2 {
		t.Fatalf("expected unsafe type/restrictive-nullability differences, got %+v", unsupported)
	}
	for _, diff := range unsupported {
		if diff.Kind == "missing_in_target" || diff.Kind == "extra_in_target" {
			t.Fatalf("safe structural difference was marked unsupported: %+v", unsupported)
		}
	}
}

func TestUnsupportedExistingTargetSchemaDiffsReturnsEmptyForRepairableSet(t *testing.T) {
	diffs := []ColumnStructureDiff{
		{Column: "a", Kind: "missing_in_target"},
		{Column: "b", Kind: "missing_in_target"},
	}

	if unsupported := unsupportedExistingTargetSchemaDiffs(diffs); len(unsupported) != 0 {
		t.Fatalf("an all-missing set is fully repairable, got %+v", unsupported)
	}
}

func TestSummarizeColumnStructureDiffsCountsEachKind(t *testing.T) {
	diffs := []ColumnStructureDiff{
		{Column: "a", Kind: "missing_in_target"},
		{Column: "b", Kind: "missing_in_target"},
		{Column: "c", Kind: "extra_in_target"},
		{Column: "d", Kind: "type"},
		{Column: "e", Kind: "nullable"},
	}

	summary := summarizeColumnStructureDiffs(diffs)
	for _, fragment := range []string{"缺失 2", "多出 1", "1 个字段类型不同", "1 个字段可空性不同"} {
		if !strings.Contains(summary, fragment) {
			t.Fatalf("summary %q must mention %q", summary, fragment)
		}
	}
}
