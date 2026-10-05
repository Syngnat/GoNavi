//go:build gonavi_full_drivers || gonavi_meilisearch_driver

package db

import (
	"strconv"
	"strings"
)

// 数据网格的 SQL 条件翻译成 Meilisearch 过滤表达式。只有字段在 filterableAttributes 里、且运算符在当前版本的
// 过滤语法内时才交给服务端；LIKE 没有原生写法（CONTAINS / STARTS WITH 需要实验开关）。翻译不了时返回 false，
// 由调用方改在客户端筛选。

// nativeFilter 返回条件树对应的过滤表达式；node 为 nil 时返回空串。
func (m *MeilisearchDB) nativeFilter(meta *meilisearchIndexMeta, node interface{}) (string, bool) {
	if node == nil {
		return "", true
	}
	if !m.supportsFilter() {
		return "", false
	}
	return m.renderFilterNode(meta, node)
}

func (m *MeilisearchDB) renderFilterNode(meta *meilisearchIndexMeta, node interface{}) (string, bool) {
	switch typed := node.(type) {
	case registryWhereLogical:
		if typed.op == "Not" {
			if len(typed.operands) != 1 {
				return "", false
			}
			inner, ok := m.renderFilterNode(meta, typed.operands[0])
			return "NOT (" + inner + ")", ok
		}
		joiner := " AND "
		if typed.op == "Or" {
			joiner = " OR "
		}
		parts := make([]string, 0, len(typed.operands))
		for _, operand := range typed.operands {
			part, ok := m.renderFilterNode(meta, operand)
			if !ok {
				return "", false
			}
			parts = append(parts, "("+part+")")
		}
		return strings.Join(parts, joiner), true
	case registryWhereCondition:
		return m.renderFilterCondition(meta, typed)
	}
	return "", false
}

func (m *MeilisearchDB) renderFilterCondition(meta *meilisearchIndexMeta, condition registryWhereCondition) (string, bool) {
	rule, filterable := meta.filterRule(condition.field)
	if !filterable {
		return "", false
	}
	field := `"` + strings.ReplaceAll(condition.field, `"`, `\"`) + `"`
	numericField := meta.fieldType(condition.field) == "number"
	values := make([]string, 0, len(condition.values))
	for _, literal := range condition.values {
		value, ok := m.renderFilterValue(literal, numericField)
		if !ok {
			return "", false
		}
		values = append(values, value)
	}
	// 比较大小：需要该字段开启了比较（对象写法的 filterableAttributes 默认不开），字符串比较 1.16 起才支持。
	comparable := func() bool {
		if !rule.comparison {
			return false
		}
		for _, literal := range condition.values {
			if !meilisearchNumericLiteral(literal) && !m.supportsDocumentSort() {
				return false
			}
		}
		return true
	}
	switch condition.op {
	case "=", "!=":
		return field + " " + condition.op + " " + values[0], true
	case ">", ">=", "<", "<=":
		return field + " " + condition.op + " " + values[0], comparable()
	case "IN", "NOT IN":
		var expression string
		if m.supportsInExists() {
			expression = field + " IN [" + strings.Join(values, ", ") + "]"
		} else {
			parts := make([]string, 0, len(values))
			for _, value := range values {
				parts = append(parts, field+" = "+value)
			}
			expression = strings.Join(parts, " OR ")
		}
		if condition.op == "NOT IN" {
			return "NOT (" + expression + ")", true
		}
		return expression, true
	case "BETWEEN", "NOT BETWEEN":
		if !comparable() {
			return "", false
		}
		expression := field + " >= " + values[0] + " AND " + field + " <= " + values[1]
		if meilisearchNumericLiteral(condition.values[0]) && meilisearchNumericLiteral(condition.values[1]) {
			expression = field + " " + values[0] + " TO " + values[1]
		}
		if condition.op == "NOT BETWEEN" {
			return "NOT (" + expression + ")", true
		}
		return expression, true
	case "IS NULL":
		// SQL 的 NULL 对应缺失字段与 null 值两种情况。
		return field + " IS NULL OR " + field + " NOT EXISTS", m.supportsDocumentFilter()
	case "IS NOT NULL":
		return field + " EXISTS AND " + field + " IS NOT NULL", m.supportsDocumentFilter()
	}
	return "", false
}

// renderFilterValue 生成过滤值：数值字段的数字原样写出，其余按字符串加引号。
// 1.0 之前的过滤语法不认反斜杠转义，值同时含两种引号时交给客户端筛选。
func (m *MeilisearchDB) renderFilterValue(literal registryWhereLiteral, numericField bool) (string, bool) {
	text := literal.text
	switch {
	case literal.kind == registryWhereTokWord:
		return text, true
	case literal.kind == registryWhereTokNumber || (numericField && meilisearchNumericLiteral(literal)):
		return strings.TrimSpace(text), true
	case !strings.Contains(text, `"`) && !strings.Contains(text, `\`):
		return `"` + text + `"`, true
	case !strings.Contains(text, `'`) && !strings.Contains(text, `\`):
		return `'` + text + `'`, true
	case m.atLeast("1.0"):
		return `"` + strings.ReplaceAll(strings.ReplaceAll(text, `\`, `\\`), `"`, `\"`) + `"`, true
	}
	return "", false
}

func meilisearchNumericLiteral(literal registryWhereLiteral) bool {
	if literal.kind == registryWhereTokWord {
		return false
	}
	_, err := strconv.ParseFloat(strings.TrimSpace(literal.text), 64)
	return err == nil
}

// nativeSort 返回 sort 参数（field:asc / field:desc）；有字段不在 sortableAttributes 时返回 false。
func (m *MeilisearchDB) nativeSort(meta *meilisearchIndexMeta, keys []documentSortKey) ([]string, bool) {
	if len(keys) == 0 {
		return nil, true
	}
	if !m.supportsSort() {
		return nil, false
	}
	sorts := make([]string, 0, len(keys))
	for _, key := range keys {
		if !meta.isSortable(key.field) {
			return nil, false
		}
		direction := "asc"
		if key.desc {
			direction = "desc"
		}
		sorts = append(sorts, key.field+":"+direction)
	}
	return sorts, true
}
