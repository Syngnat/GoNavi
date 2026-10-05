package db

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// 搜索引擎类数据源（Meilisearch 等）的字段没开启过滤 / 排序，或条件超出原生过滤语法时，在客户端按数据网格生成的
// SQL 条件筛选、排序 JSON 文档。语义贴近这些引擎的原生过滤：数组字段任一元素满足即命中，字符串相等不区分大小写，
// 缺失字段视为 NULL，NOT / != / NOT IN / NOT LIKE 是对应肯定条件的取反（缺失字段也算满足）。
// 用到这里的驱动要在 sourcePrefixes 里加 document_filter。

// documentSortKey 是 ORDER BY 的一项。
type documentSortKey struct {
	field string
	desc  bool
}

// parseDocumentOrderBy 解析 ORDER BY 子句（字段可带引号，方向 ASC / DESC）。
func parseDocumentOrderBy(text string) ([]documentSortKey, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, nil
	}
	keys := make([]documentSortKey, 0, 2)
	for _, part := range splitDocumentList(text) {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil, registryWhereError(text)
		}
		name, rest := part, ""
		if part[0] == '"' || part[0] == '`' {
			// 带引号的字段名可能含空格：按收尾引号切开。
			end := strings.IndexByte(part[1:], part[0])
			if end < 0 {
				return nil, registryWhereError(part)
			}
			name, rest = part[:end+2], part[end+2:]
		} else if at := strings.IndexFunc(part, unicode.IsSpace); at >= 0 {
			name, rest = part[:at], part[at:]
		}
		key := documentSortKey{field: unquoteDocumentIdent(name)}
		switch direction := strings.ToUpper(strings.TrimSpace(rest)); direction {
		case "", "ASC":
		case "DESC":
			key.desc = true
		default:
			return nil, registryWhereError(part)
		}
		if key.field == "" {
			return nil, registryWhereError(part)
		}
		keys = append(keys, key)
	}
	return keys, nil
}

// parseDocumentProjection 解析 SELECT 的列清单；* 返回 all = true。
func parseDocumentProjection(projection string) (fields []string, all bool) {
	projection = strings.TrimSpace(projection)
	if projection == "" || projection == "*" {
		return nil, true
	}
	for _, part := range splitDocumentList(projection) {
		name := strings.TrimSpace(part)
		if name == "*" {
			return nil, true
		}
		if name != "" {
			fields = append(fields, unquoteDocumentIdent(name))
		}
	}
	return fields, len(fields) == 0
}

// splitDocumentList 按顶层逗号切分（跳过引号内文本）。
func splitDocumentList(text string) []string {
	parts := make([]string, 0, 4)
	start := 0
	var quote byte
	for i := 0; i < len(text); i++ {
		ch := text[i]
		switch {
		case quote != 0:
			if ch == quote {
				quote = 0
			}
		case ch == '"' || ch == '`' || ch == '\'':
			quote = ch
		case ch == ',':
			parts = append(parts, text[start:i])
			start = i + 1
		}
	}
	return append(parts, text[start:])
}

func unquoteDocumentIdent(name string) string {
	name = strings.TrimSpace(name)
	if len(name) >= 2 {
		if first, last := name[0], name[len(name)-1]; (first == '"' && last == '"') || (first == '`' && last == '`') {
			return name[1 : len(name)-1]
		}
		if name[0] == '[' && name[len(name)-1] == ']' {
			return name[1 : len(name)-1]
		}
	}
	return name
}

// documentFieldValue 取字段值：先按完整名称取顶层键，再按点号逐层进入嵌套对象。
func documentFieldValue(doc map[string]interface{}, field string) (interface{}, bool) {
	if value, ok := doc[field]; ok {
		return value, true
	}
	current := interface{}(doc)
	for _, part := range strings.Split(field, ".") {
		object, ok := current.(map[string]interface{})
		if !ok {
			return nil, false
		}
		if current, ok = object[part]; !ok {
			return nil, false
		}
	}
	return current, true
}

// evaluateDocumentWhere 判断文档是否满足 parseRegistryWhere 得到的条件树。
func evaluateDocumentWhere(node interface{}, doc map[string]interface{}) bool {
	switch typed := node.(type) {
	case registryWhereLogical:
		switch typed.op {
		case "And":
			for _, operand := range typed.operands {
				if !evaluateDocumentWhere(operand, doc) {
					return false
				}
			}
			return true
		case "Or":
			for _, operand := range typed.operands {
				if evaluateDocumentWhere(operand, doc) {
					return true
				}
			}
			return false
		case "Not":
			return len(typed.operands) == 1 && !evaluateDocumentWhere(typed.operands[0], doc)
		}
	case registryWhereCondition:
		return evaluateDocumentCondition(typed, doc)
	}
	return false
}

func evaluateDocumentCondition(condition registryWhereCondition, doc map[string]interface{}) bool {
	value, _ := documentFieldValue(doc, condition.field)
	op := condition.op
	if negated := strings.HasPrefix(op, "NOT "); negated {
		return !evaluateDocumentCondition(registryWhereCondition{field: condition.field, op: op[len("NOT "):], values: condition.values}, doc)
	}
	switch op {
	case "IS NULL":
		return value == nil
	case "IS NOT NULL":
		return value != nil
	case "!=":
		return !documentAnyElement(value, func(item interface{}) bool { return documentEquals(item, condition.values[0]) })
	case "=":
		return documentAnyElement(value, func(item interface{}) bool { return documentEquals(item, condition.values[0]) })
	case "IN":
		return documentAnyElement(value, func(item interface{}) bool {
			for _, literal := range condition.values {
				if documentEquals(item, literal) {
					return true
				}
			}
			return false
		})
	case "LIKE":
		pattern := documentLikePattern(condition.values[0].text)
		return documentAnyElement(value, func(item interface{}) bool { return pattern.MatchString(documentText(item)) })
	case "BETWEEN":
		return documentAnyElement(value, func(item interface{}) bool {
			low, okLow := documentCompareLiteral(item, condition.values[0])
			high, okHigh := documentCompareLiteral(item, condition.values[1])
			return okLow && okHigh && low >= 0 && high <= 0
		})
	case ">", ">=", "<", "<=":
		return documentAnyElement(value, func(item interface{}) bool {
			cmp, ok := documentCompareLiteral(item, condition.values[0])
			if !ok {
				return false
			}
			switch op {
			case ">":
				return cmp > 0
			case ">=":
				return cmp >= 0
			case "<":
				return cmp < 0
			default:
				return cmp <= 0
			}
		})
	}
	return false
}

// documentAnyElement 对数组字段逐个元素判断，其余值直接判断；NULL 不满足任何比较。
func documentAnyElement(value interface{}, match func(interface{}) bool) bool {
	if items, ok := value.([]interface{}); ok {
		for _, item := range items {
			if item != nil && match(item) {
				return true
			}
		}
		return false
	}
	return value != nil && match(value)
}

func documentEquals(value interface{}, literal registryWhereLiteral) bool {
	if number, ok := documentNumber(value); ok {
		if other, err := strconv.ParseFloat(strings.TrimSpace(literal.text), 64); err == nil {
			return number == other
		}
		return false
	}
	if flag, ok := value.(bool); ok {
		switch strings.ToLower(strings.TrimSpace(literal.text)) {
		case "true", "1":
			return flag
		case "false", "0":
			return !flag
		}
		return false
	}
	return strings.EqualFold(documentText(value), literal.text)
}

// documentCompareLiteral 比较值与字面量：两边都是数值时按数值，否则按不区分大小写的文本；无法比较时 ok 为 false。
func documentCompareLiteral(value interface{}, literal registryWhereLiteral) (int, bool) {
	if number, ok := documentNumber(value); ok {
		other, err := strconv.ParseFloat(strings.TrimSpace(literal.text), 64)
		if err != nil {
			return 0, false
		}
		return compareFloats(number, other), true
	}
	if text, ok := value.(string); ok {
		return strings.Compare(strings.ToLower(text), strings.ToLower(literal.text)), true
	}
	return 0, false
}

func compareFloats(a, b float64) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// documentNumber 取 JSON 数值（解码后可能是 int64、float64、json.Number）。
func documentNumber(value interface{}) (float64, bool) {
	switch typed := value.(type) {
	case int64:
		return float64(typed), true
	case int:
		return float64(typed), true
	case float64:
		return typed, !math.IsNaN(typed)
	case json.Number:
		number, err := typed.Float64()
		return number, err == nil
	}
	return 0, false
}

// documentText 是值的文本形式：字符串原样，对象与数组用 JSON。
func documentText(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case map[string]interface{}, []interface{}:
		encoded, err := json.Marshal(typed)
		if err == nil {
			return string(encoded)
		}
	}
	return fmt.Sprint(value)
}

// documentLikePattern 把 SQL LIKE 模式（% 与 _，反斜杠转义）转成不区分大小写的正则。
func documentLikePattern(pattern string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("(?is)^")
	for i := 0; i < len(pattern); i++ {
		switch ch := pattern[i]; ch {
		case '%':
			b.WriteString(".*")
		case '_':
			b.WriteString(".")
		case '\\':
			if i+1 < len(pattern) {
				i++
				b.WriteString(regexp.QuoteMeta(pattern[i : i+1]))
			}
		default:
			b.WriteString(regexp.QuoteMeta(pattern[i : i+1]))
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}

// sortDocuments 按 ORDER BY 稳定排序：缺失或 NULL 的值无论升降序都排在最后（与搜索引擎的排序一致），
// 不同类型按数值、文本、布尔、其他的顺序。
func sortDocuments(docs []map[string]interface{}, keys []documentSortKey) {
	if len(keys) == 0 {
		return
	}
	sort.SliceStable(docs, func(i, j int) bool {
		for _, key := range keys {
			left, _ := documentFieldValue(docs[i], key.field)
			right, _ := documentFieldValue(docs[j], key.field)
			if left == nil || right == nil {
				if (left == nil) != (right == nil) {
					return right == nil
				}
				continue
			}
			cmp := compareDocumentValues(left, right)
			if cmp == 0 {
				continue
			}
			if key.desc {
				return cmp > 0
			}
			return cmp < 0
		}
		return false
	})
}

func compareDocumentValues(left, right interface{}) int {
	leftRank, rightRank := documentValueRank(left), documentValueRank(right)
	if leftRank != rightRank {
		return compareFloats(float64(leftRank), float64(rightRank))
	}
	switch leftRank {
	case 0:
		a, _ := documentNumber(left)
		b, _ := documentNumber(right)
		return compareFloats(a, b)
	case 2:
		a, b := left.(bool), right.(bool)
		switch {
		case a == b:
			return 0
		case !a:
			return -1
		}
		return 1
	}
	return strings.Compare(strings.ToLower(documentText(left)), strings.ToLower(documentText(right)))
}

func documentValueRank(value interface{}) int {
	if _, ok := documentNumber(value); ok {
		return 0
	}
	switch value.(type) {
	case string:
		return 1
	case bool:
		return 2
	}
	return 3
}

// projectDocument 只保留投影列（缺失补 nil）。
func projectDocument(doc map[string]interface{}, fields []string) map[string]interface{} {
	row := make(map[string]interface{}, len(fields))
	for _, field := range fields {
		value, _ := documentFieldValue(doc, field)
		row[field] = value
	}
	return row
}
