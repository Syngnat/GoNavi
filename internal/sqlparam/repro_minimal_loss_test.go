package sqlparam

import (
	"testing"
)

// 最小复现：REPLACE 链的双引号 + 反斜杠 + 四引号导致后续 ${} 全部丢失。
func TestReproMinimalLoss(t *testing.T) {
	sql := "SELECT " +
		"'\x22' ,  ' '), " +
		"'\x5c',  ' '), " +
		"'\x27\x27', ' '), " +
		"'${datefr}'"
	names := Names(sql, OptionsForDBType("oracle"))
	hasDatefr := false
	for _, n := range names {
		if n == "datefr" {
			hasDatefr = true
		}
	}
	if !hasDatefr {
		t.Fatalf("datefr lost. names=%v sql=%q", names, sql)
	}
}

// 无反斜杠版本（oracle 应该不受反斜杠影响）。
func TestReproMinimalLossNoBackslash(t *testing.T) {
	sql := "SELECT " +
		"'\x22' ,  ' '), " +
		"'''', ' '), " +
		"'${datefr}'"
	names := Names(sql, OptionsForDBType("oracle"))
	hasDatefr := false
	for _, n := range names {
		if n == "datefr" {
			hasDatefr = true
		}
	}
	if !hasDatefr {
		t.Fatalf("datefr lost (no backslash). names=%v sql=%q", names, sql)
	}
}

// 无四引号版本。
func TestReproMinimalLossNoFourQuotes(t *testing.T) {
	sql := "SELECT " +
		"'\x22' ,  ' '), " +
		"'\x5c',  ' '), " +
		"'${datefr}'"
	names := Names(sql, OptionsForDBType("oracle"))
	hasDatefr := false
	for _, n := range names {
		if n == "datefr" {
			hasDatefr = true
		}
	}
	if !hasDatefr {
		t.Fatalf("datefr lost (no four quotes). names=%v sql=%q", names, sql)
	}
}
