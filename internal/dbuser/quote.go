package dbuser

import "strings"

// 本文件的引号规则是“始终加引号、从不去引号”：输入原样视为名字的一部分。
// 不复用 internal/app 的 quoteIdentByType —— 那里会对已带引号的输入去引号，
// 且字符串转义不感知 NO_BACKSLASH_ESCAPES / standard_conforming_strings，
// 用在口令上会静默写入错误口令，导致账号被锁在门外。

// QuoteBacktick 以反引号引用标识符（MySQL 系）。
func QuoteBacktick(name string) string {
	return "`" + strings.ReplaceAll(name, "`", "``") + "`"
}

// MySQLAccount 生成 `user`@`host`；反引号引用与 sql_mode 无关。
func MySQLAccount(user, host string) string {
	return QuoteBacktick(user) + "@" + QuoteBacktick(host)
}

// MySQLString 生成 MySQL 字符串字面量。backslashEscapes 为 true 表示服务端
// 未开启 NO_BACKSLASH_ESCAPES，需要转义反斜杠。
func MySQLString(value string, backslashEscapes bool) string {
	escaped := value
	if backslashEscapes {
		escaped = strings.ReplaceAll(escaped, `\`, `\\`)
	}
	return "'" + strings.ReplaceAll(escaped, "'", "''") + "'"
}

// QuoteDouble 以双引号引用标识符（PG 系、Oracle、达梦），保留大小写。
func QuoteDouble(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// PGString 生成 E 前缀的转义字符串字面量，与 standard_conforming_strings 取值无关。
func PGString(value string) string {
	escaped := strings.ReplaceAll(value, `\`, `\\`)
	return "E'" + strings.ReplaceAll(escaped, "'", "''") + "'"
}

// PlainString 生成标准 SQL 字符串字面量（仅单引号加倍），用于不解释反斜杠的方言。
func PlainString(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// QuoteBracket 以方括号引用标识符（SQL Server）。
func QuoteBracket(name string) string {
	return "[" + strings.ReplaceAll(name, "]", "]]") + "]"
}

// NString 生成 SQL Server Unicode 字符串字面量。
func NString(value string) string {
	return "N'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// QuoteClickHouseIdent 以反引号引用 ClickHouse 标识符（反斜杠与反引号均转义）。
func QuoteClickHouseIdent(name string) string {
	escaped := strings.ReplaceAll(name, `\`, `\\`)
	return "`" + strings.ReplaceAll(escaped, "`", "\\`") + "`"
}

// ClickHouseString 生成 ClickHouse 字符串字面量。
func ClickHouseString(value string) string {
	escaped := strings.ReplaceAll(value, `\`, `\\`)
	return "'" + strings.ReplaceAll(escaped, "'", `\'`) + "'"
}

// SQLBuilder 同时构造可执行文本与脱敏展示文本。
type SQLBuilder struct {
	exec    strings.Builder
	display strings.Builder
}

// Write 追加两份文本都相同的片段。
func (b *SQLBuilder) Write(parts ...string) *SQLBuilder {
	for _, part := range parts {
		b.exec.WriteString(part)
		b.display.WriteString(part)
	}
	return b
}

// Secret 追加敏感片段：执行文本用 execText，展示文本用 display。
func (b *SQLBuilder) Secret(execText, display string) *SQLBuilder {
	b.exec.WriteString(execText)
	b.display.WriteString(display)
	return b
}

// Exec 返回可执行文本。
func (b *SQLBuilder) Exec() string {
	return b.exec.String()
}

// Display 返回脱敏展示文本。
func (b *SQLBuilder) Display() string {
	return b.display.String()
}

// Statement 生成语句。
func (b *SQLBuilder) Statement(database, risk string) Statement {
	return Statement{Exec: b.exec.String(), Display: b.display.String(), Database: database, Risk: risk}
}

// Masked 返回用给定引号包裹的掩码，如 Masked("'") = '******'。
func Masked(open, close string) string {
	return open + MaskedSecret + close
}

// Plain 生成不含敏感信息的语句。
func Plain(text, database, risk string) Statement {
	return Statement{Exec: text, Display: text, Database: database, Risk: risk}
}
