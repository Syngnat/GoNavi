package sqlparam

import "unicode/utf8"

// OracleAlternativeQuoteEnd 判定 text[start:] 是否以 Oracle 替代引号开头
// （q'X...X'、Q'X...X'、nq'X...X'、NQ'X...X'），是则返回闭合引号之后的字节
// 下标。定界符 X 为紧随引号的任意非空白字符（括号类取匹配闭括号），闭合
// 序列是「定界符 + '」，内容整体是字面量。
//
// 前一个字符是标识符成分（如 abcq'、中q'）、前缀不匹配或定界符非法时返回
// ok=false，调用方按普通词法继续。找不到闭合同样返回 ok=false——调用方
// 必须自行回退为普通引号处理，避免把后续真实参数吞进幻影字符串。
//
// 供 internal/app 的语句拆分器（sql_split.go）与只读守卫词法
// （sql_sanitize.go）复用，保证「语句拆分」「参数扫描」「只读分类」对
// q-quote 的边界判定一致；语义对齐 internal/mcpserver/result_masking.go
// 的 sqlOracleAlternativeQuoteEnd。
func OracleAlternativeQuoteEnd(text string, start int) (int, bool) {
	opener, openerIndex, ok := oracleAlternativeQuoteOpener(text, start)
	if !ok {
		return start, false
	}
	return oracleAlternativeQuoteEnd(text, start, opener, openerIndex)
}

// OracleAlternativeQuoteOpenerSize 返回替代引号前缀（q' 或 nq'）之后的
// 定界符 rune 长度，供调用方在探测失败后跳过整个前缀继续扫描。
// start 处不是合法的替代引号开头时返回 0。
func OracleAlternativeQuoteOpenerSize(text string, start int) int {
	_, openerIndex, ok := oracleAlternativeQuoteOpener(text, start)
	if !ok {
		return 0
	}
	_, size := utf8.DecodeRuneInString(text[openerIndex:])
	return size
}
