//go:build gonavi_full_drivers || gonavi_sqlite_driver

package db

import "strings"

// sqliteDDLTokenKind 是 SQLite 建表语句词法单元的类别。
type sqliteDDLTokenKind int

const (
	sqliteTokenOther  sqliteDDLTokenKind = iota // 裸词（含关键字）与符号
	sqliteTokenQuoted                           // 一切"引起来"的内容：字符串/标识符/注释
)

// tokenizeSQLiteDDL 把建表语句切成（类别, 文本）序列。
//
// 识别的引起来内容：单引号字符串（” 转义成对跳过）、双引号/反引号/方括号
// 标识符、-- 行注释、/* */ 块注释。这些内容里的关键字不代表语法含义——
// AUTOINCREMENT 出现在 DEFAULT 'AUTOINCREMENT'、注释或列名里都不构成约束。
// 未闭合引号按保守方式把尾部全部当作引起来内容丢弃。
func tokenizeSQLiteDDL(ddl string) []struct {
	kind sqliteDDLTokenKind
	text string
} {
	type token = struct {
		kind sqliteDDLTokenKind
		text string
	}
	var tokens []token
	var other strings.Builder
	flush := func() {
		if other.Len() > 0 {
			tokens = append(tokens, token{sqliteTokenOther, other.String()})
			other.Reset()
		}
	}
	flushQuoted := func(text string) {
		tokens = append(tokens, token{sqliteTokenQuoted, text})
	}

	i := 0
	for i < len(ddl) {
		ch := ddl[i]
		switch ch {
		case '\'':
			end := findSQLiteQuoteClose(ddl, i+1, '\'')
			if end < 0 {
				flushQuoted(ddl[i:])
				i = len(ddl)
				continue
			}
			flushQuoted(ddl[i : end+1])
			i = end + 1
		case '"', '`':
			quote := ch
			end := findSQLiteQuoteClose(ddl, i+1, byte(quote))
			if end < 0 {
				flushQuoted(ddl[i:])
				i = len(ddl)
				continue
			}
			flushQuoted(ddl[i : end+1])
			i = end + 1
		case '[':
			if end := strings.IndexByte(ddl[i:], ']'); end >= 0 {
				flushQuoted(ddl[i : i+end+1])
				i += end + 1
			} else {
				flushQuoted(ddl[i:])
				i = len(ddl)
			}
		case '-':
			if i+1 < len(ddl) && ddl[i+1] == '-' {
				end := strings.IndexByte(ddl[i:], '\n')
				if end < 0 {
					flushQuoted(ddl[i:])
					i = len(ddl)
					continue
				}
				flushQuoted(ddl[i : i+end])
				i += end
			} else {
				other.WriteByte(ch)
				i++
			}
		case '/':
			if i+1 < len(ddl) && ddl[i+1] == '*' {
				end := strings.Index(ddl[i:], "*/")
				if end < 0 {
					flushQuoted(ddl[i:])
					i = len(ddl)
					continue
				}
				flushQuoted(ddl[i : i+end+2])
				i += end + 2
			} else {
				other.WriteByte(ch)
				i++
			}
		default:
			other.WriteByte(ch)
			i++
		}
	}
	flush()
	return tokens
}

// findSQLiteQuoteClose 找从 start 开始的字面量闭合引号，跳过成对转义；
// 未闭合返回 -1。
func findSQLiteQuoteClose(s string, start int, quote byte) int {
	for i := start; i < len(s); i++ {
		if s[i] != quote {
			continue
		}
		if i+1 < len(s) && s[i+1] == quote {
			i++
			continue
		}
		return i
	}
	return -1
}

// sqliteDDLPrimaryKeyUsesAutoIncrement 判断建表语句里是否存在
// "PRIMARY KEY 后随 AUTOINCREMENT" 的内联约束序列。
//
// 这是 SQLite 自增主键唯一合法的语法形态：AUTOINCREMENT 只能作为单列整数
// 主键内联约束的最后一个词出现，之前允许排序词与冲突子句（官方语法为
// PRIMARY KEY [ASC|DESC] [conflict-clause] AUTOINCREMENT，conflict-clause 即
// ON CONFLICT ROLLBACK|ABORT|FAIL|IGNORE|REPLACE）。按裸词序列匹配而不是
// 对整段 DDL 做包含匹配，注释、字符串默认值、引号包裹的标识符里出现的
// 关键字都不会误判；表级 PRIMARY KEY(a,b) 的括号列名也不是裸词序列的
// 合法修饰，遇到即终止扫描。
func sqliteDDLPrimaryKeyUsesAutoIncrement(tableDDL string) bool {
	var words []string
	for _, token := range tokenizeSQLiteDDL(tableDDL) {
		if token.kind != sqliteTokenOther {
			continue
		}
		for _, field := range strings.FieldsFunc(token.text, func(r rune) bool {
			return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_')
		}) {
			words = append(words, strings.ToUpper(field))
		}
	}
	for i := 0; i+1 < len(words); i++ {
		if words[i] != "PRIMARY" || words[i+1] != "KEY" {
			continue
		}
		// 从 PRIMARY KEY 之后逐词推进，只认合法修饰词序列，遇到其他任何
		// 词说明 AUTOINCREMENT 不在这个约束序列里。
		j := i + 2
		for j < len(words) {
			if words[j] == "AUTOINCREMENT" {
				return true
			}
			if words[j] == "ASC" || words[j] == "DESC" {
				j++
				continue
			}
			if words[j] == "ON" && j+2 < len(words) &&
				words[j+1] == "CONFLICT" && isSQLiteConflictAction(words[j+2]) {
				j += 3
				continue
			}
			break
		}
	}
	return false
}

// isSQLiteConflictAction 判定词是否为 conflict-clause 的合法冲突动作。
func isSQLiteConflictAction(word string) bool {
	switch word {
	case "ROLLBACK", "ABORT", "FAIL", "IGNORE", "REPLACE":
		return true
	default:
		return false
	}
}
