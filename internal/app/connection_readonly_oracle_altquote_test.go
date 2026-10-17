package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

// 只读守卫的词法扫描（skipSQLQuotedOrComment）必须认识 Oracle 替代引号：
// q'[it's]' 的撇号曾让后续文本进入幻影字符串，`SELECT q'[it's]' FROM dual;
// DELETE FROM users` 的 DELETE 被当成字符串内容漏判放行。
func TestEnsureReadOnlyConnectionAllowsQueryOracleAlternativeQuote(t *testing.T) {
	config := connection.ConnectionConfig{Type: "oracle", ReadOnly: true}

	// 含撇号的 q-quote 之后内嵌写语句必须被拦截（漏洞回归）。
	if err := ensureConnectionAllowsQuery(config, "SELECT q'[it's]' FROM dual; DELETE FROM users"); err == nil {
		t.Fatal("只读连接必须拦截 q-quote 撇号之后的 DELETE")
	}
	// 花括号定界符内容里的分号后内嵌写语句同样拦截。
	if err := ensureConnectionAllowsQuery(config, "SELECT q'{a;b}'; DELETE FROM users"); err == nil {
		t.Fatal("只读连接必须拦截 q-quote 内容分号之后的 DELETE")
	}
	// 正常 q-quote 查询保持放行。
	if err := ensureConnectionAllowsQuery(config, "SELECT q'[it's]' FROM dual"); err != nil {
		t.Fatalf("只读连接应放行含 q-quote 的 SELECT: %v", err)
	}
	// 找不到闭合时按普通引号词法回退，不吞后续 DELETE。
	if err := ensureConnectionAllowsQuery(config, "SELECT q'!a' FROM dual; DELETE FROM users"); err == nil {
		t.Fatal("只读连接必须拦截未闭合 q-quote 回退后的 DELETE")
	}
	// 达梦同口径。
	dameng := connection.ConnectionConfig{Type: "dameng", ReadOnly: true}
	if err := ensureConnectionAllowsQuery(dameng, "SELECT q'[it's]' FROM dual; DELETE FROM users"); err == nil {
		t.Fatal("达梦只读连接必须拦截 q-quote 撇号之后的 DELETE")
	}
	// 非 Oracle 方言不受影响（MySQL 无替代引号，q'{a;b}' 是普通字符串）。
	mysql := connection.ConnectionConfig{Type: "mysql", ReadOnly: true}
	if err := ensureConnectionAllowsQuery(mysql, "SELECT q'{a;b}' FROM dual"); err != nil {
		t.Fatalf("MySQL 只读连接应放行普通字符串查询: %v", err)
	}
}
