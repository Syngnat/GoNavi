package sqlparam

import (
	"testing"
)

// 定位破坏扫描状态的最小构造。datefr 用 ${datefr} 裸花括号形式追加在末尾。
func TestReproMinimalConstructs(t *testing.T) {
	cases := []struct {
		name string
		sql  string
	}{
		{name: "backslash then param", sql: "SELECT '\\', '${datefr}'"},
		{name: "dbq then param", sql: "SELECT '\"', '${datefr}'"},
		{name: "four quotes then param", sql: "SELECT '''' , '${datefr}'"},
		{name: "two strings then param", sql: "SELECT 'a', 'b', '${datefr}'"},
		{name: "paren then param", sql: "SELECT ('a'), '${datefr}'"},
		{name: "chr9 then param", sql: "SELECT REPLACE(d.explanation, CHR(9), ' '), '${datefr}'"},
		{name: "dbq replace chain tail", sql: "SELECT REPLACE(x, '\"', ' '), '${datefr}'"},
		{name: "four quotes replace tail", sql: "SELECT REPLACE(x, '''', ' '), '${datefr}'"},
		{name: "concat dbq then param", sql: "SELECT '\"' || x || '\"', '${datefr}'"},
		{name: "json open then param", sql: "SELECT '{\"o\":\"', '${datefr}'"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if !hasDatefr(Names(tc.sql, OptionsForDBType("oracle"))) {
				t.Fatalf("datefr lost. sql=%q", tc.sql)
			}
		})
	}
}
