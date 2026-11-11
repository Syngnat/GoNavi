package app

import (
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/connection"
)

// issue1308SQL 是引发 issue #1308 的原始输入：ORDER BY 与 DELETE 之间缺少分号，
// 切分器无法切出语句边界，导致整段曾被误判为单条只读查询。
const issue1308SQL = `SELECT
    *
FROM
    t_bank_payment
WHERE
    f_bank_name = '安徽农商银行'
    AND f_create_time >= '2026-09-20 00:00:00'
ORDER BY
    id DESC
DELETE FROM t_bank_payment
WHERE
    f_bank_name = '安徽农商银行'
    AND f_create_time >= '2026-09-20 00:00:00'`

// TestIssue1308EmbeddedWriteIsDetected 复现并锁定 issue #1308：
// 缺分号分隔的多语句必须被判定为含写操作，且所有依赖该判定的防线同步收紧。
func TestIssue1308EmbeddedWriteIsDetected(t *testing.T) {
	t.Parallel()

	dialects := []string{"mysql", "mariadb", "dameng", "postgres", "oracle", "sqlserver"}
	for _, dbType := range dialects {
		t.Run(dbType, func(t *testing.T) {
			t.Parallel()

			if isReadOnlySQLQuery(dbType, issue1308SQL) {
				t.Fatalf("缺分号的多语句含 DELETE，必须判定为非只读")
			}
			if !containsSQLAuditWrite(dbType, issue1308SQL) {
				t.Fatalf("含 DELETE 的语句必须计入审计写操作")
			}
			if got := InspectSQL(dbType, issue1308SQL); got.ReadOnly {
				t.Fatalf("InspectSQL 必须报告非只读，实际 ReadOnly=%v", got.ReadOnly)
			}
		})
	}
}

// TestIssue1308ReadOnlyConnectionBlocksEmbeddedWrite 验证连接只读保护不再被绕过。
func TestIssue1308ReadOnlyConnectionBlocksEmbeddedWrite(t *testing.T) {
	t.Parallel()

	config := connection.ConnectionConfig{Type: "mysql", ReadOnly: true}
	if err := ensureConnectionAllowsQuery(config, issue1308SQL); err == nil {
		t.Fatalf("只读连接必须拦截含 DELETE 的语句，实际放行")
	}
}

// TestIssue1308HeadlessSafetyRequiresMutatingConsent 验证 AI/MCP 安全分级同步收紧。
func TestIssue1308HeadlessSafetyRequiresMutatingConsent(t *testing.T) {
	t.Parallel()

	decision := evaluateHeadlessSQLSafety(ai.PermissionReadWrite, "mysql", issue1308SQL)
	if !decision.RequiresAllowMutating {
		t.Fatalf("AI/MCP 路径必须要求写操作授权")
	}
	if decision.Inspection.ReadOnly {
		t.Fatalf("AI/MCP 路径的 inspection 必须报告非只读")
	}
	// 首关键字为 select 时若退回首关键字判定，DELETE 会被归为 SQLOpOther
	// 而被误判为"越权"，必须由内嵌写扫描纠正为 DML。
	if len(decision.ConfirmRequired) != 1 || decision.ConfirmRequired[0].Operation != ai.SQLOpDML {
		t.Fatalf("内嵌写必须归类为 DML 并要求二次确认，实际 %+v", decision.ConfirmRequired)
	}
	if len(decision.Disallowed) != 0 {
		t.Fatalf("readwrite 级别下 DML 不应被直接拒绝，实际 %+v", decision.Disallowed)
	}
}

// TestIssue1308ManagedTransactionApplies 验证托管事务不再被跳过。
// 事故中该 SQL 以 autocommit 直接下发，数据库侧无事务可回滚。
func TestIssue1308ManagedTransactionApplies(t *testing.T) {
	t.Parallel()

	if !shouldUseManagedSQLTransaction("mysql", issue1308SQL) {
		t.Fatalf("含内嵌 DELETE 的语句必须进入托管事务")
	}
	// 纯只读语句不得因此被拖入托管事务（防误杀）。
	if shouldUseManagedSQLTransaction("mysql", "SELECT * FROM delete_log") {
		t.Fatalf("纯只读语句不应进入托管事务")
	}
}

// TestContainsEmbeddedWriteStatementReadOnlyBoundaries 锁定只读边界用例，
// 防止修复引入误杀：这些输入的首关键字为读，且体内出现的"写关键字"只是
// 标识符、字面量或注释内容，必须保持只读判定。
func TestContainsEmbeddedWriteStatementReadOnlyBoundaries(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		dbType string
		sql    string
	}{
		{"表名含 delete", "mysql", "SELECT * FROM delete_log"},
		{"列名含 drop", "mysql", "SELECT drop_count FROM t"},
		{"字符串字面量含 DELETE", "mysql", "SELECT 'DELETE FROM t' AS note"},
		{"行注释含 DELETE", "mysql", "SELECT 1 -- DELETE FROM t"},
		{"井号注释含 DELETE", "mysql", "SELECT 1 # DELETE FROM t"},
		{"块注释含 DELETE", "mysql", "SELECT 1 /* DELETE FROM t */"},
		{"反引号标识符含 delete", "mysql", "SELECT `delete` FROM t"},
		{"双引号标识符含 delete", "postgres", `SELECT "delete" FROM t`},
		{"dollar-quoting 含 DELETE", "postgres", "SELECT $$ DELETE FROM t $$"},
		{"CTE 只读", "postgres", "WITH x AS (SELECT 1) SELECT * FROM x"},
		{"普通只读查询", "mysql", "SELECT id, name FROM users WHERE status = 1"},
		{"SHOW CREATE TABLE", "mysql", "SHOW CREATE TABLE users"},
		{"SHOW CREATE VIEW", "mysql", "SHOW CREATE VIEW v_users"},
		{"EXPLAIN SELECT", "mysql", "EXPLAIN SELECT * FROM t"},
		{"EXPLAIN DELETE 只出计划", "mysql", "EXPLAIN DELETE FROM t"},
		{"FOR UPDATE 锁行为", "mysql", "SELECT * FROM t WHERE id = 1 FOR UPDATE"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if containsEmbeddedWriteStatement(tc.dbType, tc.sql) {
				t.Fatalf("只读语句被误判为含写操作：%s", tc.sql)
			}
			if !isReadOnlySQLQuery(tc.dbType, tc.sql) {
				t.Fatalf("只读语句被整体误判为非只读：%s", tc.sql)
			}
		})
	}
}

// TestContainsEmbeddedWriteStatementDetectsWrites 锁定真实写操作的检出，
// 尤其覆盖"缺分号"这一本次修复的核心场景。
// 回归：MySQL 的 INSERT(str, pos, len, newstr) 是字符串函数。它出现在 SELECT
// 列表里时，按关键字判定会被当成写语句，导致只读连接拒绝执行一条纯读 SQL
// （用户反馈：同一条 SQL 在 Navicat 能查、在 GoNavi 查不出）。
func TestContainsEmbeddedWriteStatementIgnoresInsertFunction(t *testing.T) {
	t.Parallel()

	readOnly := []string{
		`SELECT INSERT(device_name, 1, 1, '_') FROM t`,
		`SELECT CAST(id AS CHAR) AS a, INSERT(device_name, CHAR_LENGTH(device_name) - LOCATE('-', REVERSE(device_name)) + 1, 1, '_') AS b FROM t WHERE device_name REGEXP '^T[0-9]+$' ORDER BY device_name`,
		`WITH x AS (SELECT 1) SELECT INSERT(name, 1, 1, '_') FROM x`,
		`SELECT INSERT (name, 1, 1, '_') FROM t`,
	}
	for _, sql := range readOnly {
		if containsEmbeddedWriteStatement("mysql", sql) {
			t.Fatalf("只读的 INSERT() 函数被误判为写操作：%s", sql)
		}
	}

	// 反向守卫：真正的 INSERT 语句必须仍然命中，包括与函数混用的形状。
	writes := []string{
		`INSERT INTO t VALUES (1)`,
		`INSERT INTO t(a) VALUES (1)`,
		`SELECT 1 INSERT INTO t VALUES (1)`,
		`SELECT INSERT(name, 1, 1, '_') FROM t INSERT INTO t VALUES (1)`,
	}
	for _, sql := range writes {
		if !containsEmbeddedWriteStatement("mysql", sql) {
			t.Fatalf("真实 INSERT 被漏判：%s", sql)
		}
	}
}

func TestContainsEmbeddedWriteStatementDetectsWrites(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		dbType string
		sql    string
	}{
		{"缺分号 SELECT+DELETE", "mysql", "SELECT * FROM t ORDER BY id DESC\nDELETE FROM t WHERE id = 1"},
		{"缺分号 SELECT+UPDATE", "mysql", "SELECT * FROM t\nUPDATE t SET a = 1"},
		{"缺分号 SELECT+INSERT", "mysql", "SELECT * FROM t\nINSERT INTO t VALUES (1)"},
		{"缺分号 SELECT+DROP", "mysql", "SELECT * FROM t\nDROP TABLE t"},
		{"缺分号 SELECT+TRUNCATE", "mysql", "SELECT * FROM t\nTRUNCATE TABLE t"},
		{"缺分号 SELECT+ALTER", "mysql", "SELECT * FROM t\nALTER TABLE t ADD COLUMN c INT"},
		{"分号分隔 SELECT+DELETE", "mysql", "SELECT * FROM t; DELETE FROM t"},
		{"FOR UPDATE 后接 DELETE", "mysql", "SELECT * FROM t FOR UPDATE DELETE FROM t"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if !containsEmbeddedWriteStatement(tc.dbType, tc.sql) {
				t.Fatalf("写操作被漏判：%s", tc.sql)
			}
		})
	}
}
