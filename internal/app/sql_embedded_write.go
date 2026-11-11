package app

import "strings"

// embeddedWriteKeywords 是"出现在语句体内即代表存在写操作"的关键字集合。
//
// 与 isSQLDataWriteKeyword 的区别在用途：后者回答"这条语句的类型是不是写"，
// 本集合回答"这段文本里是否还埋着另一条写语句"。因此这里额外收录 DDL ——
// 缺分号时 `SELECT ... DROP TABLE x` 同样会被切分器吞成一条只读语句。
//
// 收录标准：该关键字不可能作为普通标识符或函数名合法出现在一条只读语句中。
// 按此标准排除了 `set` / `use` / `call` / `load` 等在大批只读语境中合法出现的
// 词（例如 `SELECT setting FROM t`），宁可漏报也不误杀只读查询。
// 事务控制词（commit / rollback / savepoint）也一并排除：它们由
// sqlBeginStartsTransactionForDialect 与前端事务控制判定负责，收进写集合会让
// `BEGIN; SELECT 1; COMMIT;` 这类显式事务脚本被误判为写操作。
// `replace` 同样排除：SQL Server 的 REPLACE() 是只读字符串函数
// （见 connectionReadOnly.test.ts 的既有用例）。
// `insert` 同理排除：MySQL 的 INSERT(str, pos, len, newstr) 是字符串函数，常出现在
// SELECT 列表里；它由 isEmbeddedInsertStatement 单独识别「INSERT 后不跟左括号」的形态。
var embeddedWriteKeywords = map[string]struct{}{
	// DML
	"delete": {}, "update": {}, "upsert": {},
	// DDL
	"create": {}, "alter": {}, "drop": {}, "truncate": {}, "rename": {},
	// 权限与数据控制
	"grant": {}, "revoke": {},
}

// update 是唯一存在只读歧义的收录词：`SELECT ... FOR UPDATE` 的 update 属于
// 行锁语法而非写操作，也是真实生产 SQL 中最高频的 update 出现形式。该歧义由
// containsEmbeddedWriteStatement 内的 FOR UPDATE OF 前瞻单独豁免，不能靠移出
// 集合来规避 —— 否则 `SELECT ... UPDATE t SET ...`（缺分号）会漏判。

// isEmbeddedWriteKeywordToken 判断 token 是否代表写操作。
func isEmbeddedWriteKeywordToken(token string) bool {
	if token == "" {
		return false
	}
	_, ok := embeddedWriteKeywords[token]
	return ok
}

// isEmbeddedInsertStatement 判断 token 之后的第一个非空白字符是否为左括号，
// 以此区分 MySQL 的 INSERT() 字符串函数与真正的 INSERT 语句。
func isEmbeddedInsertStatement(text string, pos int) bool {
	for pos < len(text) {
		switch text[pos] {
		case ' ', '\t', '\r', '\n', '\f':
			pos++
			continue
		}
		break
	}
	return pos >= len(text) || text[pos] != '('
}

// isReadOnlyContextualKeyword 判断写关键字是否处于合法只读语境中，从而应予豁免。
//
// 仅两类语境可豁免，否则会造成大面积误杀：
//
//  1. `SHOW CREATE TABLE t` / `SHOW CREATE VIEW v` —— MySQL 族的表结构查看语句，
//     GoNavi 自身就在 methods_db_create_statement.go 中生成并执行它。
//  2. `EXPLAIN <任意语句>` —— EXPLAIN 前缀表示只执行计划、不真正改数据。
//     `EXPLAIN DELETE FROM t` 虽然有写关键字，但不会改动数据。EXPLAIN ANALYZE
//     确实会执行语句，该场景已由 explainAnalyzeMayWrite 单独判定，不在此处重复处理。
//
// 刻意**不**豁免 `describe` / `desc`：`DESCRIBE t` 之后不可能合法跟随写关键字，
// 而 `desc` 更常见于 `ORDER BY x DESC` 的排序修饰词 —— 一旦纳入豁免，
// `SELECT ... ORDER BY id DESC` 后的缺分号 DELETE 会被直接放行，
// 而该形状正是 issue #1308 事故 SQL 的原文特征。
//
// precedingToken 为当前写关键字之前最近的一个关键字 token。
func isReadOnlyContextualKeyword(precedingToken string) bool {
	switch precedingToken {
	case "show", "explain":
		return true
	default:
		return false
	}
}

// containsEmbeddedWriteStatement 扫描整段 SQL 文本，判断首关键字之外是否还埋着
// 写语句或 DDL。用于覆盖"语句之间缺少分号"导致切分器无法切出边界的场景
// （issue #1308）。
func containsEmbeddedWriteStatement(dbType string, text string) bool {
	return firstEmbeddedWriteKeyword(dbType, text) != ""
}

// firstEmbeddedWriteKeyword 返回文本中出现的第一个"内嵌写关键字"（小写），
// 未检出时返回空串。返回具体关键字而非布尔值，是因为下游分类器
// （classifyHeadlessSQLOperation 等）需要据此判定 SQLOpDML / SQLOpDDL，
// 若只返回布尔值，这些下游仍会退回"首关键字"判定而再次漏判。
//
// 它只做词法级扫描，不构建语法树。
//
// 关键约束：必须跳过字符串字面量、行注释（-- / #）、块注释（/* */）、反引号与
// 双引号标识符、方括号标识符（SQL Server / SQLite）、PostgreSQL dollar-quoting，
// 否则 `SELECT 'DELETE'`、`SELECT 1 -- DELETE` 这类只读语句会被误判为写。
// 上述跳过逻辑全部复用既有词法设施 skipSQLQuotedOrComment，不新写解析器。
//
// 首关键字判定由调用方（isReadOnlySQLQuery）先行完成；CTE 体内的写由
// sqlKeywordAfterLeadingWith 负责，故此处遇到 `with` 直接跳过以免重复判定。
func firstEmbeddedWriteKeyword(dbType string, text string) string {
	pos := 0
	previousToken := ""
	updateNeedsOfCheck := false

	for pos < len(text) {
		if next, ok := skipSQLQuotedOrComment(text, pos, dbType); ok {
			pos = next
			continue
		}

		if !isSQLKeywordByte(text[pos]) {
			pos++
			continue
		}

		tokenStart := pos
		for pos < len(text) && isSQLKeywordByte(text[pos]) {
			pos++
		}
		token := strings.ToLower(text[tokenStart:pos])

		// `FOR UPDATE OF`：update 属于只读锁定语法，仅当后继为 `of` 时豁免，
		// 否则 `SELECT ... FOR UPDATE DELETE FROM t` 会漏判其中的 delete。
		if updateNeedsOfCheck {
			updateNeedsOfCheck = false
			if token == "of" {
				previousToken = token
				continue
			}
		}

		switch token {
		case "with":
			// CTE 内的写操作由 sqlKeywordAfterLeadingWith 判定，跳过以免重复。
			previousToken = token
			continue
		case "update":
			if previousToken == "for" {
				// 交给下一轮确认后继是否为 `of`。
				updateNeedsOfCheck = true
				previousToken = token
				continue
			}
		}

		if token == "insert" && !isReadOnlyContextualKeyword(previousToken) {
			if isEmbeddedInsertStatement(text, pos) {
				return token
			}
			// INSERT(...) 是字符串函数，继续扫描后续 token。
			previousToken = token
			continue
		}

		if isEmbeddedWriteKeywordToken(token) && !isReadOnlyContextualKeyword(previousToken) {
			return token
		}

		previousToken = token
	}
	return ""
}
