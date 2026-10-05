//go:build gonavi_full_drivers || gonavi_typesense_driver

package db

import (
	"regexp"
	"strconv"
	"strings"
)

// 数据网格的 SQL 条件翻译成 Typesense filter_by。只有 schema 里建了索引的字段能过滤：字符串只做精确匹配
// （0.23 之前要求 facet 字段），大小比较与区间只对数值字段；LIKE、IS NULL 没有对应写法。0.24 之前没有 || 与括号，
// 只能翻译纯 AND 条件。翻译不了时返回 false，由调用方改在客户端筛选。

// typesenseBareToken 是不加引号也能写进 filter_by 的值（0.23 之前对反引号的支持不完整，简单词直接写出）。
var typesenseBareToken = regexp.MustCompile(`^[\p{L}\p{N}_.-]+$`)

var typesenseNegatedOps = map[string]string{
	"=": "!=", "!=": "=", ">": "<=", ">=": "<", "<": ">=", "<=": ">",
	"IN": "NOT IN", "NOT IN": "IN", "BETWEEN": "NOT BETWEEN", "NOT BETWEEN": "BETWEEN",
	"LIKE": "NOT LIKE", "NOT LIKE": "LIKE", "IS NULL": "IS NOT NULL", "IS NOT NULL": "IS NULL",
}

// nativeFilter 返回条件树对应的 filter_by；node 为 nil 时返回空串。
func (t *TypesenseDB) nativeFilter(meta *typesenseCollectionMeta, node interface{}) (string, bool) {
	if node == nil {
		return "", true
	}
	return t.renderFilterNode(meta, node, false)
}

// renderFilterNode 渲染条件树；negate 为 true 时按德摩根律下推取反（Typesense 没有通用的 NOT）。
func (t *TypesenseDB) renderFilterNode(meta *typesenseCollectionMeta, node interface{}, negate bool) (string, bool) {
	switch typed := node.(type) {
	case registryWhereLogical:
		if typed.op == "Not" {
			if len(typed.operands) != 1 {
				return "", false
			}
			return t.renderFilterNode(meta, typed.operands[0], !negate)
		}
		or := (typed.op == "Or") != negate
		parts := make([]string, 0, len(typed.operands))
		for _, operand := range typed.operands {
			part, ok := t.renderFilterNode(meta, operand, negate)
			if !ok {
				return "", false
			}
			parts = append(parts, part)
		}
		return t.joinFilters(parts, or)
	case registryWhereCondition:
		if negate {
			negated, ok := typesenseNegatedOps[typed.op]
			if !ok {
				return "", false
			}
			typed.op = negated
		}
		return t.renderFilterCondition(meta, typed)
	}
	return "", false
}

// joinFilters 用 && / || 连接；0.24 之前没有 || 与括号，只能连接不含 || 的条件。
func (t *TypesenseDB) joinFilters(parts []string, or bool) (string, bool) {
	if !t.supportsOrFilter() {
		if or {
			return "", false
		}
		for _, part := range parts {
			if strings.Contains(part, "||") {
				return "", false
			}
		}
		return strings.Join(parts, " && "), true
	}
	wrapped := make([]string, 0, len(parts))
	for _, part := range parts {
		wrapped = append(wrapped, "("+part+")")
	}
	if or {
		return strings.Join(wrapped, " || "), true
	}
	return strings.Join(wrapped, " && "), true
}

func (t *TypesenseDB) renderFilterCondition(meta *typesenseCollectionMeta, condition registryWhereCondition) (string, bool) {
	field, ok := meta.field(condition.field)
	if !ok || !field.indexed() || strings.ContainsAny(condition.field, ":()&|[]`, ") {
		return "", false
	}
	kind := strings.TrimSuffix(field.Type, "[]")
	isID := condition.field == "id"
	if isID && !t.supportsExactFilter() {
		return "", false
	}
	values := make([]string, 0, len(condition.values))
	for _, literal := range condition.values {
		value, ok := t.renderFilterValue(kind, field, literal)
		if !ok {
			return "", false
		}
		values = append(values, value)
	}
	name := condition.field
	numeric := kind == "int32" || kind == "int64" || kind == "float"
	notEqual := func(value string) (string, bool) {
		switch {
		case !t.supportsExactFilter():
			// 0.23 之前 != 不生效（总是返回空结果），交给客户端。
			return "", false
		case isID:
			return name + ":!=" + value, t.supportsIDNotEq()
		case kind == "bool":
			return name + ":=" + map[string]string{"true": "false", "false": "true"}[value], true
		case numeric && !t.supportsNumericNotEq():
			return "(" + name + ":<" + value + " || " + name + ":>" + value + ")", t.supportsOrFilter()
		}
		return name + ":!=" + value, true
	}
	switch condition.op {
	case "=":
		return name + ":=" + values[0], true
	case "!=":
		return notEqual(values[0])
	case ">", ">=", "<", "<=":
		return name + ":" + condition.op + values[0], numeric
	case "IN":
		if numeric {
			return name + ":[" + strings.Join(values, ",") + "]", true
		}
		return name + ":=[" + strings.Join(values, ",") + "]", kind != "bool"
	case "NOT IN":
		if kind == "string" && !isID {
			return name + ":!=[" + strings.Join(values, ",") + "]", t.supportsExactFilter()
		}
		parts := make([]string, 0, len(values))
		for _, value := range values {
			part, ok := notEqual(value)
			if !ok {
				return "", false
			}
			parts = append(parts, part)
		}
		return t.joinFilters(parts, false)
	case "BETWEEN":
		return name + ":[" + values[0] + ".." + values[1] + "]", numeric
	case "NOT BETWEEN":
		return "(" + name + ":<" + values[0] + " || " + name + ":>" + values[1] + ")", numeric && t.supportsOrFilter()
	}
	return "", false
}

// renderFilterValue 按字段类型生成过滤值：整数字段只接受整数，字符串用反引号包住（值里有反引号时交给客户端）。
func (t *TypesenseDB) renderFilterValue(kind string, field typesenseField, literal registryWhereLiteral) (string, bool) {
	text := strings.TrimSpace(literal.text)
	switch kind {
	case "int32", "int64":
		_, err := strconv.ParseInt(text, 10, 64)
		return text, err == nil
	case "float":
		_, err := strconv.ParseFloat(text, 64)
		return text, err == nil
	case "bool":
		switch strings.ToLower(text) {
		case "true", "1":
			return "true", true
		case "false", "0":
			return "false", true
		}
		return "", false
	case "string":
		// 0.23 之前字符串精确过滤要求 facet 字段。
		if !t.supportsExactFilter() && !field.Facet {
			return "", false
		}
		if strings.Contains(literal.text, "`") {
			return "", false
		}
		if !t.supportsExactFilter() && typesenseBareToken.MatchString(literal.text) {
			return literal.text, true
		}
		return "`" + literal.text + "`", true
	}
	return "", false
}

// nativeSort 返回 sort_by；字段不可排序或超过 3 个排序字段时返回 false。
func (t *TypesenseDB) nativeSort(meta *typesenseCollectionMeta, keys []documentSortKey) (string, bool) {
	if len(keys) == 0 {
		return "", true
	}
	if len(keys) > 3 {
		return "", false
	}
	sorts := make([]string, 0, len(keys))
	for _, key := range keys {
		field, ok := meta.schema[key.field]
		if !ok || !field.indexed() || !field.sortable() || strings.HasSuffix(field.Type, "[]") {
			return "", false
		}
		direction := "asc"
		if key.desc {
			direction = "desc"
		}
		sorts = append(sorts, key.field+":"+direction)
	}
	return strings.Join(sorts, ","), true
}
