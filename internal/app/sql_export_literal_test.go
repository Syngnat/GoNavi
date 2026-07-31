package app

import (
	"strings"
	"testing"
)

// TestFormatSQLValueEscapesBackslashForMySQLLikeDialects 覆盖 SQL 导出的反斜杠转义。
//
// 回归背景：formatSQLValue 原先只把单引号翻倍、不处理反斜杠。MySQL 系方言默认 sql_mode
// 不含 NO_BACKSLASH_ESCAPES，导致 (a) 含反斜杠的普通文本（Windows 路径、正则、转义 JSON）
// 在导出→还原后被静默改写；(b) 以反斜杠结尾的值会让 '...\' 吞掉闭合单引号，使后续生成的
// SQL 文本越出字面量，源库中的恶意行可在用户还原 dump 时执行任意 SQL。
func TestFormatSQLValueEscapesBackslashForMySQLLikeDialects(t *testing.T) {
	cases := []struct {
		name   string
		dbType string
		value  interface{}
		want   string
	}{
		{name: "mysql 单个反斜杠翻倍", dbType: "mysql", value: `\`, want: `'\\'`},
		{name: "mysql Windows 路径", dbType: "mysql", value: `C:\temp\new`, want: `'C:\\temp\\new'`},
		{name: "mysql 已转义的 JSON", dbType: "mysql", value: `{"k":"a\nb"}`, want: `'{"k":"a\\nb"}'`},
		{name: "mariadb 同样翻倍", dbType: "mariadb", value: `a\b`, want: `'a\\b'`},
		{name: "tidb 同样翻倍", dbType: "tidb", value: `a\b`, want: `'a\\b'`},
		{name: "oceanbase 同样翻倍", dbType: "oceanbase", value: `a\b`, want: `'a\\b'`},
		{name: "diros 同样翻倍", dbType: "diros", value: `a\b`, want: `'a\\b'`},
		{name: "starrocks 同样翻倍", dbType: "starrocks", value: `a\b`, want: `'a\\b'`},

		// 非 MySQL 系：standard_conforming_strings 下反斜杠是字面量，翻倍反而会损坏数据。
		{name: "postgres 保持反斜杠原样", dbType: "postgres", value: `C:\temp`, want: `'C:\temp'`},
		{name: "sqlserver 保持反斜杠原样", dbType: "sqlserver", value: `C:\temp`, want: `'C:\temp'`},
		{name: "oracle 保持反斜杠原样", dbType: "oracle", value: `C:\temp`, want: `'C:\temp'`},

		// 单引号翻倍的既有行为必须保持不变。
		{name: "mysql 单引号仍翻倍", dbType: "mysql", value: `O'Brien`, want: `'O''Brien'`},
		{name: "postgres 单引号仍翻倍", dbType: "postgres", value: `O'Brien`, want: `'O''Brien'`},
		{name: "mysql 反斜杠与单引号并存", dbType: "mysql", value: `a\'b`, want: `'a\\''b'`},

		// MySQL 十六进制字面量直通的既有旁路必须保持不变。
		{name: "mysql 十六进制字面量直通", dbType: "mysql", value: "0xDEADBEEF", want: "0xDEADBEEF"},
		{name: "postgres 不走十六进制直通", dbType: "postgres", value: "0xDEADBEEF", want: "'0xDEADBEEF'"},

		{name: "nil 仍为 NULL", dbType: "mysql", value: nil, want: "NULL"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := formatSQLValue(tc.dbType, tc.value); got != tc.want {
				t.Fatalf("formatSQLValue(%q, %#v) = %s，期望 %s", tc.dbType, tc.value, got, tc.want)
			}
		})
	}
}

// TestFormatSQLValueBlocksStatementBreakoutOnRoundTrip 用项目自己的切分器做闭环回归：
// 导出的 INSERT 在被本仓库的 SQL 切分器读回时，绝不能裂出额外的可执行语句。
func TestFormatSQLValueBlocksStatementBreakoutOnRoundTrip(t *testing.T) {
	// 攻击载荷：第一列是单个反斜杠，第二列试图闭合字面量并追加 DROP。
	// 未修复前 '\' 会吞掉闭合引号，使 DROP TABLE users 成为独立语句。
	c1 := formatSQLValue("mysql", `\`)
	c2 := formatSQLValue("mysql", `); DROP TABLE users; -- `)
	stmt := "INSERT INTO `t` (`c1`, `c2`) VALUES (" + c1 + ", " + c2 + ");"

	got := splitSQLStatementsForDialect("mysql", stmt)
	if len(got) != 1 {
		t.Fatalf("导出语句被切分成 %d 条，期望 1 条（字面量越界）：%#v", len(got), got)
	}
	// 载荷文本出现在这条 INSERT 的字符串字面量内部是正常的；关键是它没有成为独立语句。
	if !strings.HasPrefix(strings.TrimSpace(strings.ToUpper(got[0])), "INSERT") {
		t.Fatalf("唯一语句不是 INSERT，字面量可能已越界：%q", got[0])
	}

	// 反向对照：还原修复前的行为（只翻倍单引号、不转义反斜杠），
	// 确认该场景确实会裂出独立的 DROP 语句——以此证明上面的断言真能抓住这个回归。
	unescaped := "INSERT INTO `t` (`c1`, `c2`) VALUES ('" +
		strings.ReplaceAll(`\`, "'", "''") + "', '" +
		strings.ReplaceAll(`); DROP TABLE users; -- `, "'", "''") + "');"
	legacy := splitSQLStatementsForDialect("mysql", unescaped)
	foundStandaloneDrop := false
	for _, s := range legacy {
		if strings.HasPrefix(strings.TrimSpace(strings.ToUpper(s)), "DROP TABLE") {
			foundStandaloneDrop = true
			break
		}
	}
	if !foundStandaloneDrop {
		t.Fatalf("反向对照失效：未转义反斜杠时本应裂出独立 DROP 语句，实际切分为 %#v", legacy)
	}
}

// TestEscapeSQLStringLiteralBodyIsDialectAware 直接覆盖转义辅助函数的方言分派。
func TestEscapeSQLStringLiteralBodyIsDialectAware(t *testing.T) {
	if got := escapeSQLStringLiteralBody("mysql", `a\b'c`); got != `a\\b''c` {
		t.Fatalf("mysql 转义结果 = %q，期望 %q", got, `a\\b''c`)
	}
	if got := escapeSQLStringLiteralBody("postgres", `a\b'c`); got != `a\b''c` {
		t.Fatalf("postgres 转义结果 = %q，期望 %q", got, `a\b''c`)
	}
}

// TestDialectEscapesBackslashInStringLiteralCoversAffectedDialects 固定"字面量内反斜杠是
// 转义符"的方言集合。新增方言时若漏加，导出的 dump 会静默改写数据；若误加，反斜杠会被
// 写成两个而同样损坏数据——两个方向都必须在此失败。
func TestDialectEscapesBackslashInStringLiteralCoversAffectedDialects(t *testing.T) {
	// MySQL 协议系 + ClickHouse/TDengine 的字面量都支持反斜杠转义。
	for _, dbType := range []string{
		"mysql", "MySQL", " mariadb ", "tidb", "oceanbase", "diros", "doris", "starrocks",
		"clickhouse", "tdengine", "taos",
	} {
		if !dialectEscapesBackslashInStringLiteral(dbType) {
			t.Errorf("dialectEscapesBackslashInStringLiteral(%q) = false，期望 true", dbType)
		}
	}
	// standard_conforming_strings / 无反斜杠转义语义的方言：反斜杠必须原样保留。
	for _, dbType := range []string{"postgres", "postgresql", "sqlserver", "oracle", "sqlite", "kingbase", "highgo", "gaussdb", ""} {
		if dialectEscapesBackslashInStringLiteral(dbType) {
			t.Errorf("dialectEscapesBackslashInStringLiteral(%q) = true，期望 false", dbType)
		}
	}
}

// TestFormatSQLValueEscapesBackslashForClickHouseAndTDengine 覆盖初版修复漏掉的方言。
func TestFormatSQLValueEscapesBackslashForClickHouseAndTDengine(t *testing.T) {
	for _, dbType := range []string{"clickhouse", "tdengine"} {
		if got := formatSQLValue(dbType, `a\b`); got != `'a\\b'` {
			t.Errorf("formatSQLValue(%q, %q) = %s，期望 %s", dbType, `a\b`, got, `'a\\b'`)
		}
	}
}
