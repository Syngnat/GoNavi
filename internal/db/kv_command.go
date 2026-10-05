package db

import (
	"errors"
	"strings"
	"unicode"
)

// 键值类数据源（etcd、ZooKeeper）控制台命令共用的 shell 式切分：空白分隔，单引号内原样，
// 双引号内与引号外支持反斜杠转义，引号外的结尾分号视为语句分隔符。
// 这个文件不带构建标签：app 层的只读判定也要用。

// errShellUnclosedQuote 表示引号没有闭合，调用方换成各自的本地化提示。
var errShellUnclosedQuote = errors.New("unclosed quote")

type shellToken struct {
	text   string
	quoted bool
}

// trimShellTerminator 去掉位于引号之外的结尾分号。
func trimShellTerminator(text string) string {
	text = strings.TrimSpace(text)
	for strings.HasSuffix(text, ";") {
		inSingle, inDouble := false, false
		for i := 0; i < len(text)-1; i++ {
			switch {
			case inDouble && text[i] == '\\':
				i++
			case !inDouble && text[i] == '\'':
				inSingle = !inSingle
			case !inSingle && text[i] == '"':
				inDouble = !inDouble
			case !inSingle && !inDouble && text[i] == '\\':
				i++
			}
		}
		if inSingle || inDouble {
			return text
		}
		text = strings.TrimSpace(text[:len(text)-1])
	}
	return text
}

// tokenizeShellCommand 按 shell 规则切分命令；quoted 标记该参数是否出自引号（引号里的 -x 不是选项）。
func tokenizeShellCommand(text string) ([]shellToken, error) {
	var tokens []shellToken
	var current strings.Builder
	inToken, quoted := false, false
	runes := []rune(strings.TrimSpace(text))
	flush := func() {
		if inToken {
			tokens = append(tokens, shellToken{text: current.String(), quoted: quoted})
		}
		current.Reset()
		inToken, quoted = false, false
	}
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch {
		case r == '\'':
			end := indexRune(runes, i+1, '\'')
			if end < 0 {
				return nil, errShellUnclosedQuote
			}
			current.WriteString(string(runes[i+1 : end]))
			inToken, quoted, i = true, true, end
		case r == '"':
			inToken, quoted = true, true
			closed := false
			for i++; i < len(runes); i++ {
				if runes[i] == '\\' && i+1 < len(runes) {
					i++
					current.WriteRune(unescapeShellRune(runes[i]))
					continue
				}
				if runes[i] == '"' {
					closed = true
					break
				}
				current.WriteRune(runes[i])
			}
			if !closed {
				return nil, errShellUnclosedQuote
			}
		case r == '\\' && i+1 < len(runes):
			i++
			current.WriteRune(unescapeShellRune(runes[i]))
			inToken = true
		case unicode.IsSpace(r):
			flush()
		default:
			current.WriteRune(r)
			inToken = true
		}
	}
	flush()
	return tokens, nil
}

func indexRune(runes []rune, from int, target rune) int {
	for i := from; i < len(runes); i++ {
		if runes[i] == target {
			return i
		}
	}
	return -1
}

func unescapeShellRune(r rune) rune {
	switch r {
	case 'n':
		return '\n'
	case 't':
		return '\t'
	case 'r':
		return '\r'
	default:
		return r
	}
}

// quoteShellArgument 把参数写成可再次解析的单行形式：普通值原样，带空格的用单引号，
// 含换行、制表符、分号或单引号的用双引号并转义。
func quoteShellArgument(text string) string {
	if text != "" && !strings.ContainsAny(text, " \t\r\n'\";\\") {
		return text
	}
	if !strings.ContainsAny(text, "'\r\n\t") {
		return "'" + text + "'"
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\t", `\t`, "\r", `\r`).Replace(text) + `"`
}
