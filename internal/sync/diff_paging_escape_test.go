package sync

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// TestQuoteSyncSQLStringEscapesBackslashPerDialect 覆盖分页比对字面量的方言感知转义。
//
// 回归背景：quoteSyncSQLString 原先只翻倍单引号。含反斜杠的主键（Windows 路径、正则、
// 转义 JSON）在 MySQL/ClickHouse 等以反斜杠转义的目标上会被解释成别的字符串，导致
// IN 列表匹配不到：源端存在的行先被判为需要插入，随后反查时又匹配不到而被判为需要删除，
// 于是真的从目标删掉，最终 Success=true 但目标永久缺行。
func TestQuoteSyncSQLStringEscapesBackslashPerDialect(t *testing.T) {
	t.Parallel()

	// 分页白名单中以反斜杠转义的方言：必须翻倍。
	for _, dbType := range []string{"mysql", "mariadb", "clickhouse", "tdengine", "starrocks", "diros"} {
		if got := quoteSyncSQLString(dbType, `C:\logs`); got != `'C:\\logs'` {
			t.Errorf("quoteSyncSQLString(%q, %q) = %s，期望 %s", dbType, `C:\logs`, got, `'C:\\logs'`)
		}
	}

	// 白名单中反斜杠为普通字面字符的方言：翻倍反而会损坏数据，必须保持原样。
	for _, dbType := range []string{"postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "sqlite", "duckdb"} {
		if got := quoteSyncSQLString(dbType, `C:\logs`); got != `'C:\logs'` {
			t.Errorf("quoteSyncSQLString(%q, %q) = %s，期望 %s", dbType, `C:\logs`, got, `'C:\logs'`)
		}
	}

	// 单引号翻倍的既有行为必须保持不变。
	if got := quoteSyncSQLString("mysql", `O'Brien`); got != `'O''Brien'` {
		t.Errorf("mysql 单引号处理 = %s，期望 %s", got, `'O''Brien'`)
	}
	if got := quoteSyncSQLString("postgres", `O'Brien`); got != `'O''Brien'` {
		t.Errorf("postgres 单引号处理 = %s，期望 %s", got, `'O''Brien'`)
	}
	// 反斜杠与单引号并存时顺序不能颠倒（先反斜杠、后单引号）。
	if got := quoteSyncSQLString("mysql", `a\'b`); got != `'a\\''b'` {
		t.Errorf("mysql 混合转义 = %s，期望 %s", got, `'a\\''b'`)
	}
}

// TestBuildPKInSelectQueryEscapesBackslashInPrimaryKey 端到端断言主键字面量不会越出引号。
func TestBuildPKInSelectQueryEscapesBackslashInPrimaryKey(t *testing.T) {
	t.Parallel()

	cols := []connection.ColumnDefinition{{Name: "id"}, {Name: "name"}}

	mysqlQuery := buildPKInSelectQuery("mysql", "app.users", cols, "id", []interface{}{`C:\logs`})
	if !strings.Contains(mysqlQuery, `'C:\\logs'`) {
		t.Errorf("MySQL 主键字面量未转义反斜杠：%s", mysqlQuery)
	}

	pgQuery := buildPKInSelectQuery("postgres", "app.users", cols, "id", []interface{}{`C:\logs`})
	if !strings.Contains(pgQuery, `'C:\logs'`) {
		t.Errorf("PostgreSQL 主键字面量不应翻倍反斜杠：%s", pgQuery)
	}
}

// TestBuildKeysetPagedTableQueryEscapesBackslash keyset 分页的 WHERE pk > 字面量同样受影响。
func TestBuildKeysetPagedTableQueryEscapesBackslash(t *testing.T) {
	t.Parallel()

	cols := []connection.ColumnDefinition{{Name: "id"}}
	query := buildKeysetPagedTableQuery("mysql", "app.users", cols, "id", `a\b`, true, 100)
	if !strings.Contains(query, `'a\\b'`) {
		t.Errorf("keyset 分页字面量未转义反斜杠：%s", query)
	}
}

// TestEscapeMySQLStringLiteralEscapesBackslash 列注释与 DEFAULT 值的 DDL 字面量。
func TestEscapeMySQLStringLiteralEscapesBackslash(t *testing.T) {
	t.Parallel()

	if got := escapeMySQLStringLiteral(`C:\tmp`); got != `C:\\tmp` {
		t.Errorf("escapeMySQLStringLiteral(%q) = %q，期望 %q", `C:\tmp`, got, `C:\\tmp`)
	}
	// 以反斜杠结尾的注释原先会吞掉闭合引号，生成语法错误的 DDL。
	if got := escapeMySQLStringLiteral(`ends with\`); got != `ends with\\` {
		t.Errorf("escapeMySQLStringLiteral(%q) = %q，期望 %q", `ends with\`, got, `ends with\\`)
	}
	if got := escapeMySQLStringLiteral(`O'Brien`); got != `O''Brien` {
		t.Errorf("单引号处理被破坏：%q", got)
	}
}

// TestSyncDialectEscapesBackslashCoversPaginationWhitelist 固定方言分组，
// 漏加（数据被改写）与误加（反斜杠被写成两个）两个方向都必须失败。
func TestSyncDialectEscapesBackslashCoversPaginationWhitelist(t *testing.T) {
	t.Parallel()

	for _, dbType := range []string{"mysql", "mariadb", "clickhouse", "tdengine", "starrocks", "diros", "oceanbase"} {
		if !syncDialectEscapesBackslash(dbType) {
			t.Errorf("syncDialectEscapesBackslash(%q) = false，期望 true", dbType)
		}
	}
	for _, dbType := range []string{"postgres", "kingbase", "highgo", "vastbase", "opengauss", "gaussdb", "sqlserver", "sqlite", "duckdb", ""} {
		if syncDialectEscapesBackslash(dbType) {
			t.Errorf("syncDialectEscapesBackslash(%q) = true，期望 false", dbType)
		}
	}
}
