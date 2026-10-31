package sync

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

// 对比任务遇到目标整表缺表时，源列必须全部按 missing_in_target 返回，
// 前端才能整表标缺表并据此生成 CREATE TABLE。
func TestCompareMissingTargetColumnsMarksEverySourceColumn(t *testing.T) {
	cols := []connection.ColumnDefinition{
		{Name: "id", Type: "bigint", Nullable: "NO"},
		{Name: " name ", Type: "varchar(64)", Nullable: "YES"},
		{Name: "   ", Type: "text", Nullable: "YES"},
	}

	missing, diffs := compareMissingTargetColumns(cols)

	if len(missing) != 2 {
		t.Fatalf("expected 2 named source columns, got %d: %v", len(missing), missing)
	}
	if missing[0] != "id" || missing[1] != "name" {
		t.Fatalf("unexpected missing column order: %v", missing)
	}
	if len(diffs) != 2 {
		t.Fatalf("expected 2 column diffs, got %d", len(diffs))
	}
	if diffs[0].Kind != "missing_in_target" || diffs[0].Source != "bigint NOT NULL" {
		t.Fatalf("unexpected first diff: %+v", diffs[0])
	}
	if diffs[1].Column != "name" || diffs[1].Source != "varchar(64)" {
		t.Fatalf("unexpected second diff: %+v", diffs[1])
	}
}

func TestCompareMissingTargetColumnsHandlesEmptySource(t *testing.T) {
	missing, diffs := compareMissingTargetColumns(nil)

	if len(missing) != 0 || len(diffs) != 0 {
		t.Fatalf("expected no diffs for an empty source, got %v / %v", missing, diffs)
	}
}
