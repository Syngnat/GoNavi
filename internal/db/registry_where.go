package db

import (
	"strconv"
	"strings"
	"time"
	"unicode"
)

// 数据网格筛选器生成的标准 SQL 条件（值一律带引号，如 qty > '5'）的词法与语法分析，
// 各描述表驱动再按自己的 schema 把条件翻译成原生过滤语法（Weaviate where、InfluxQL 等）。
// 支持比较、LIKE / NOT LIKE、IN / NOT IN、BETWEEN / NOT BETWEEN、IS [NOT] NULL、AND / OR / NOT 与括号。
// 用到这里的驱动要在 sourcePrefixes 里加 registry。

type registryWhereTokenKind int

const (
	registryWhereTokWord registryWhereTokenKind = iota
	registryWhereTokQuotedIdent
	registryWhereTokString
	registryWhereTokNumber
	registryWhereTokOperator
	registryWhereTokLParen
	registryWhereTokRParen
	registryWhereTokComma
)

type registryWhereToken struct {
	kind registryWhereTokenKind
	text string
}

func tokenizeRegistryWhere(text string) ([]registryWhereToken, error) {
	tokens := make([]registryWhereToken, 0, 16)
	for i := 0; i < len(text); {
		ch := text[i]
		switch {
		case ch < 0x80 && unicode.IsSpace(rune(ch)):
			i++
		case ch == '(':
			tokens = append(tokens, registryWhereToken{registryWhereTokLParen, "("})
			i++
		case ch == ')':
			tokens = append(tokens, registryWhereToken{registryWhereTokRParen, ")"})
			i++
		case ch == ',':
			tokens = append(tokens, registryWhereToken{registryWhereTokComma, ","})
			i++
		case ch == '\'':
			value, next, ok := readRegistryQuoted(text, i, '\'')
			if !ok {
				return nil, registryWhereError(text[i:])
			}
			tokens = append(tokens, registryWhereToken{registryWhereTokString, value})
			i = next
		case ch == '"' || ch == '`':
			value, next, ok := readRegistryQuoted(text, i, ch)
			if !ok {
				return nil, registryWhereError(text[i:])
			}
			tokens = append(tokens, registryWhereToken{registryWhereTokQuotedIdent, value})
			i = next
		case ch == '[':
			end := strings.IndexByte(text[i:], ']')
			if end < 0 {
				return nil, registryWhereError(text[i:])
			}
			tokens = append(tokens, registryWhereToken{registryWhereTokQuotedIdent, text[i+1 : i+end]})
			i += end + 1
		case strings.ContainsRune("=<>!", rune(ch)):
			start := i
			i++
			if i < len(text) && (text[i] == '=' || (ch == '<' && text[i] == '>')) {
				i++
			}
			op := text[start:i]
			if op == "!" {
				return nil, registryWhereError(op)
			}
			tokens = append(tokens, registryWhereToken{registryWhereTokOperator, op})
		case ch == '-' || ch == '+' || ch == '.' || (ch >= '0' && ch <= '9'):
			start := i
			i++
			for i < len(text) && (isSQLWordByte(text[i]) || text[i] == '.' || ((text[i] == '-' || text[i] == '+') && (text[i-1] == 'e' || text[i-1] == 'E'))) {
				i++
			}
			raw := text[start:i]
			if _, err := strconv.ParseFloat(raw, 64); err != nil {
				return nil, registryWhereError(raw)
			}
			tokens = append(tokens, registryWhereToken{registryWhereTokNumber, raw})
		case isSQLWordByte(ch) || ch >= 0x80:
			start := i
			for i < len(text) && (isSQLWordByte(text[i]) || text[i] == '.' || text[i] >= 0x80) {
				i++
			}
			tokens = append(tokens, registryWhereToken{registryWhereTokWord, text[start:i]})
		default:
			return nil, registryWhereError(string(ch))
		}
	}
	return tokens, nil
}

// readRegistryQuoted 读取引号包裹的内容，支持重复引号转义（'it”s'）与字符串里的反斜杠转义。
func readRegistryQuoted(text string, start int, quote byte) (string, int, bool) {
	var b strings.Builder
	for i := start + 1; i < len(text); i++ {
		ch := text[i]
		if ch == '\\' && quote == '\'' && i+1 < len(text) {
			b.WriteByte(text[i+1])
			i++
			continue
		}
		if ch == quote {
			if i+1 < len(text) && text[i+1] == quote {
				b.WriteByte(quote)
				i++
				continue
			}
			return b.String(), i + 1, true
		}
		b.WriteByte(ch)
	}
	return "", len(text), false
}

func registryWhereError(near string) error {
	if len(near) > 40 {
		near = near[:40]
	}
	return localizedDatabaseRuntimeError("db.backend.error.where_syntax_unsupported", map[string]any{"token": strings.TrimSpace(near)})
}

type registryWhereLiteral struct {
	kind registryWhereTokenKind // registryWhereTokString / registryWhereTokNumber / registryWhereTokWord（TRUE、FALSE）
	text string
}

type registryWhereCondition struct {
	field  string
	op     string
	values []registryWhereLiteral
}

type registryWhereLogical struct {
	op       string // And / Or / Not
	operands []interface{}
}

type registryWhereParser struct {
	tokens []registryWhereToken
	pos    int
}

func parseRegistryWhere(text string) (interface{}, error) {
	tokens, err := tokenizeRegistryWhere(text)
	if err != nil {
		return nil, err
	}
	if len(tokens) == 0 {
		return nil, registryWhereError(text)
	}
	parser := registryWhereParser{tokens: tokens}
	node, err := parser.parseOr()
	if err != nil {
		return nil, err
	}
	if parser.pos != len(tokens) {
		return nil, registryWhereError(tokens[parser.pos].text)
	}
	return node, nil
}

func (p *registryWhereParser) peekKeyword(keyword string) bool {
	return p.pos < len(p.tokens) && p.tokens[p.pos].kind == registryWhereTokWord && strings.EqualFold(p.tokens[p.pos].text, keyword)
}

func (p *registryWhereParser) acceptKeyword(keyword string) bool {
	if p.peekKeyword(keyword) {
		p.pos++
		return true
	}
	return false
}

func (p *registryWhereParser) accept(kind registryWhereTokenKind) (registryWhereToken, bool) {
	if p.pos < len(p.tokens) && p.tokens[p.pos].kind == kind {
		token := p.tokens[p.pos]
		p.pos++
		return token, true
	}
	return registryWhereToken{}, false
}

func (p *registryWhereParser) errorHere() error {
	if p.pos < len(p.tokens) {
		return registryWhereError(p.tokens[p.pos].text)
	}
	return registryWhereError("")
}

func (p *registryWhereParser) parseOr() (interface{}, error) {
	return p.parseChain("OR", "Or", p.parseAnd)
}

func (p *registryWhereParser) parseAnd() (interface{}, error) {
	return p.parseChain("AND", "And", p.parseNot)
}

func (p *registryWhereParser) parseChain(keyword, op string, next func() (interface{}, error)) (interface{}, error) {
	first, err := next()
	if err != nil {
		return nil, err
	}
	operands := []interface{}{first}
	for p.acceptKeyword(keyword) {
		operand, err := next()
		if err != nil {
			return nil, err
		}
		operands = append(operands, operand)
	}
	if len(operands) == 1 {
		return first, nil
	}
	return registryWhereLogical{op: op, operands: operands}, nil
}

func (p *registryWhereParser) parseNot() (interface{}, error) {
	if p.acceptKeyword("NOT") {
		operand, err := p.parseNot()
		if err != nil {
			return nil, err
		}
		return registryWhereLogical{op: "Not", operands: []interface{}{operand}}, nil
	}
	if _, ok := p.accept(registryWhereTokLParen); ok {
		node, err := p.parseOr()
		if err != nil {
			return nil, err
		}
		if _, ok := p.accept(registryWhereTokRParen); !ok {
			return nil, p.errorHere()
		}
		return node, nil
	}
	return p.parseCondition()
}

func (p *registryWhereParser) parseCondition() (interface{}, error) {
	fieldToken, ok := p.accept(registryWhereTokQuotedIdent)
	if !ok {
		fieldToken, ok = p.accept(registryWhereTokWord)
	}
	if !ok {
		return nil, p.errorHere()
	}
	condition := registryWhereCondition{field: fieldToken.text}
	if token, ok := p.accept(registryWhereTokOperator); ok {
		condition.op = token.text
		if condition.op == "<>" {
			condition.op = "!="
		}
		value, err := p.parseLiteral()
		if err != nil {
			return nil, err
		}
		condition.values = []registryWhereLiteral{value}
		return condition, nil
	}
	if p.acceptKeyword("IS") {
		condition.op = "IS NULL"
		if p.acceptKeyword("NOT") {
			condition.op = "IS NOT NULL"
		}
		if !p.acceptKeyword("NULL") {
			return nil, p.errorHere()
		}
		return condition, nil
	}
	negated := p.acceptKeyword("NOT")
	prefix := ""
	if negated {
		prefix = "NOT "
	}
	switch {
	case p.acceptKeyword("LIKE"):
		value, err := p.parseLiteral()
		if err != nil {
			return nil, err
		}
		condition.op, condition.values = prefix+"LIKE", []registryWhereLiteral{value}
	case p.acceptKeyword("IN"):
		if _, ok := p.accept(registryWhereTokLParen); !ok {
			return nil, p.errorHere()
		}
		for {
			value, err := p.parseLiteral()
			if err != nil {
				return nil, err
			}
			condition.values = append(condition.values, value)
			if _, ok := p.accept(registryWhereTokComma); !ok {
				break
			}
		}
		if _, ok := p.accept(registryWhereTokRParen); !ok {
			return nil, p.errorHere()
		}
		condition.op = prefix + "IN"
	case p.acceptKeyword("BETWEEN"):
		low, err := p.parseLiteral()
		if err != nil {
			return nil, err
		}
		if !p.acceptKeyword("AND") {
			return nil, p.errorHere()
		}
		high, err := p.parseLiteral()
		if err != nil {
			return nil, err
		}
		condition.op, condition.values = prefix+"BETWEEN", []registryWhereLiteral{low, high}
	default:
		return nil, p.errorHere()
	}
	return condition, nil
}

func (p *registryWhereParser) parseLiteral() (registryWhereLiteral, error) {
	if token, ok := p.accept(registryWhereTokString); ok {
		return registryWhereLiteral{kind: registryWhereTokString, text: token.text}, nil
	}
	if token, ok := p.accept(registryWhereTokNumber); ok {
		return registryWhereLiteral{kind: registryWhereTokNumber, text: token.text}, nil
	}
	if p.peekKeyword("TRUE") || p.peekKeyword("FALSE") {
		token := p.tokens[p.pos]
		p.pos++
		return registryWhereLiteral{kind: registryWhereTokWord, text: strings.ToLower(token.text)}, nil
	}
	return registryWhereLiteral{}, p.errorHere()
}

// normalizeRegistryDate 把常见日期写法转成 Weaviate 要求的 RFC3339；无时区时按 UTC。
func normalizeRegistryDate(text string) (string, bool) {
	if parsed, err := time.Parse(time.RFC3339Nano, text); err == nil {
		return parsed.Format(time.RFC3339Nano), true
	}
	for _, layout := range []string{"2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02 15:04:05.999999999", "2006-01-02"} {
		if parsed, err := time.Parse(layout, text); err == nil {
			return parsed.UTC().Format(time.RFC3339Nano), true
		}
	}
	return "", false
}

// registrySelectClauses 是简单 SELECT 的 WHERE / ORDER BY 原文与 LIMIT / OFFSET。
type registrySelectClauses struct {
	where   string
	orderBy string
	limit   int
	offset  int
	// hasLimit 报告原文是否写了 LIMIT。
	hasLimit bool
}

// splitRegistrySelectClauses 按关键字切出 SELECT 的各子句（跳过引号内文本）；没写 LIMIT 时用 defaultLimit。
func splitRegistrySelectClauses(text string, defaultLimit int) registrySelectClauses {
	clauses := registrySelectClauses{limit: defaultLimit}
	fromAt := findSQLKeyword(text, "FROM", 0)
	if fromAt < 0 {
		return clauses
	}
	whereAt := findSQLKeyword(text, "WHERE", fromAt)
	orderAt := findSQLOrderBy(text, fromAt)
	limitAt := findSQLKeyword(text, "LIMIT", fromAt)
	offsetAt := findSQLKeyword(text, "OFFSET", fromAt)
	clauseEnd := func(start int) int {
		end := len(text)
		for _, index := range []int{whereAt, orderAt, limitAt, offsetAt} {
			if index > start && index < end {
				end = index
			}
		}
		return end
	}
	if whereAt >= 0 {
		clauses.where = strings.TrimSpace(text[whereAt+len("WHERE") : clauseEnd(whereAt)])
	}
	if orderAt >= 0 {
		byAt := findSQLKeyword(text, "BY", orderAt+len("ORDER"))
		if byAt >= 0 {
			clauses.orderBy = strings.TrimSpace(text[byAt+len("BY") : clauseEnd(orderAt)])
		}
	}
	if limit, ok := parseSQLLimitClause(text[fromAt:]); ok {
		clauses.limit = limit
		clauses.hasLimit = true
	}
	if offset, ok := parseSQLUnsignedOffset(text[fromAt:]); ok {
		clauses.offset = offset
	}
	return clauses
}
