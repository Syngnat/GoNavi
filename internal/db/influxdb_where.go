//go:build gonavi_full_drivers || gonavi_influxdb_driver

package db

import (
	"regexp"
	"strconv"
	"strings"
)

// 数据网格的筛选器生成标准 SQL 条件（值一律带引号，如 usage > '5'），InfluxQL 里字符串与数值不会隐式转换，
// 这里按 measurement 的 schema 重写：字段按类型写字面量，tag 写字符串，time 写 RFC3339；LIKE 转正则（=~ /^…$/），
// IN / BETWEEN 拆成 OR / AND。InfluxQL 没有 NOT 与 NULL：tag 的 IS NULL 表达为等于空串，字段上报不支持。

type influxColumnKind int

const (
	influxColumnTime influxColumnKind = iota
	influxColumnTag
	influxColumnField
)

func resolveInfluxColumn(schema influxMeasurementSchema, name string) (influxColumnKind, influxField, error) {
	if strings.EqualFold(name, influxTimeColumn) {
		return influxColumnTime, influxField{}, nil
	}
	if schema.hasTag(name) {
		return influxColumnTag, influxField{}, nil
	}
	if field, ok := schema.field(name); ok {
		return influxColumnField, field, nil
	}
	return 0, influxField{}, localizedDatabaseRuntimeError("db.backend.error.influxdb_column_not_found", map[string]any{"column": name})
}

func renderInfluxWhere(schema influxMeasurementSchema, node interface{}) (string, error) {
	switch typed := node.(type) {
	case registryWhereLogical:
		if typed.op == "Not" {
			return "", localizedDatabaseRuntimeError("db.backend.error.influxdb_filter_unsupported", map[string]any{"condition": "NOT"})
		}
		parts := make([]string, 0, len(typed.operands))
		for _, operand := range typed.operands {
			rendered, err := renderInfluxWhere(schema, operand)
			if err != nil {
				return "", err
			}
			parts = append(parts, rendered)
		}
		return "(" + strings.Join(parts, " "+strings.ToUpper(typed.op)+" ") + ")", nil
	case registryWhereCondition:
		return renderInfluxCondition(schema, typed)
	}
	return "", registryWhereError("")
}

func renderInfluxCondition(schema influxMeasurementSchema, condition registryWhereCondition) (string, error) {
	kind, field, err := resolveInfluxColumn(schema, condition.field)
	if err != nil {
		return "", err
	}
	column := influxQuoteIdent(condition.field)
	if kind == influxColumnTime {
		column = influxTimeColumn
	}
	literal := func(value registryWhereLiteral) (string, error) {
		return influxLiteral(kind, field, condition.field, value)
	}
	compare := func(op string, value registryWhereLiteral) (string, error) {
		text, err := literal(value)
		if err != nil {
			return "", err
		}
		return column + " " + op + " " + text, nil
	}
	join := func(joiner, op string, values []registryWhereLiteral) (string, error) {
		parts := make([]string, 0, len(values))
		for _, value := range values {
			part, err := compare(op, value)
			if err != nil {
				return "", err
			}
			parts = append(parts, part)
		}
		if len(parts) == 1 {
			return parts[0], nil
		}
		return "(" + strings.Join(parts, " "+joiner+" ") + ")", nil
	}
	switch condition.op {
	case "=", "!=", ">", ">=", "<", "<=":
		return compare(condition.op, condition.values[0])
	case "IN":
		return join("OR", "=", condition.values)
	case "NOT IN":
		return join("AND", "!=", condition.values)
	case "BETWEEN", "NOT BETWEEN":
		lowOp, highOp, joiner := ">=", "<=", "AND"
		if condition.op == "NOT BETWEEN" {
			lowOp, highOp, joiner = "<", ">", "OR"
		}
		low, err := compare(lowOp, condition.values[0])
		if err != nil {
			return "", err
		}
		high, err := compare(highOp, condition.values[1])
		if err != nil {
			return "", err
		}
		return "(" + low + " " + joiner + " " + high + ")", nil
	case "LIKE", "NOT LIKE":
		if kind == influxColumnTime || (kind == influxColumnField && field.fieldType != "string") {
			return "", localizedDatabaseRuntimeError("db.backend.error.influxdb_filter_unsupported", map[string]any{"condition": condition.field + " " + condition.op})
		}
		op := "=~"
		if condition.op == "NOT LIKE" {
			op = "!~"
		}
		return column + " " + op + " " + influxLikeRegex(condition.values[0].text), nil
	case "IS NULL", "IS NOT NULL":
		if kind != influxColumnTag {
			return "", localizedDatabaseRuntimeError("db.backend.error.influxdb_filter_unsupported", map[string]any{"condition": condition.field + " " + condition.op})
		}
		if condition.op == "IS NULL" {
			return column + " = ''", nil
		}
		return column + " != ''", nil
	}
	return "", registryWhereError(condition.op)
}

// influxLiteral 按列类型写 InfluxQL 字面量：time 用 RFC3339 或纳秒整数，tag 与字符串字段用单引号，数值与布尔原样。
func influxLiteral(kind influxColumnKind, field influxField, column string, value registryWhereLiteral) (string, error) {
	text := strings.TrimSpace(value.text)
	invalid := func(fieldType string) error {
		return localizedDatabaseRuntimeError("db.backend.error.influxdb_value_invalid", map[string]any{"field": column, "fieldType": fieldType, "value": value.text})
	}
	switch kind {
	case influxColumnTime:
		if _, err := strconv.ParseInt(text, 10, 64); err == nil {
			return text, nil
		}
		if normalized, ok := normalizeRegistryDate(text); ok {
			return influxQuoteString(normalized), nil
		}
		return "", invalid("timestamp")
	case influxColumnTag:
		return influxQuoteString(value.text), nil
	}
	switch field.fieldType {
	case "integer", "unsigned":
		if _, err := strconv.ParseInt(text, 10, 64); err == nil {
			return text, nil
		}
		if float, err := strconv.ParseFloat(text, 64); err == nil && float == float64(int64(float)) {
			return strconv.FormatInt(int64(float), 10), nil
		}
		return "", invalid(field.fieldType)
	case "float":
		if _, err := strconv.ParseFloat(text, 64); err == nil {
			return text, nil
		}
		return "", invalid(field.fieldType)
	case "boolean":
		switch strings.ToLower(text) {
		case "true", "t", "1":
			return "true", nil
		case "false", "f", "0":
			return "false", nil
		}
		return "", invalid(field.fieldType)
	}
	return influxQuoteString(value.text), nil
}

// influxLikeRegex 把 LIKE 模式转成 InfluxQL 正则字面量：% → .*，_ → .，其余字符按字面匹配。
func influxLikeRegex(pattern string) string {
	var b strings.Builder
	b.WriteString("/^")
	for _, r := range pattern {
		switch r {
		case '%':
			b.WriteString(".*")
		case '_':
			b.WriteString(".")
		case '/':
			b.WriteString(`\/`)
		default:
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	b.WriteString("$/")
	return b.String()
}

// influxOrderByTime 只保留 ORDER BY 里的 time：InfluxQL 只能按时间排序，网格按主键（time + tag）排序时其余列丢弃。
func influxOrderByTime(orderBy string) string {
	tokens, err := tokenizeRegistryWhere(orderBy)
	if err != nil {
		return ""
	}
	for index, token := range tokens {
		if (token.kind == registryWhereTokWord || token.kind == registryWhereTokQuotedIdent) && strings.EqualFold(token.text, influxTimeColumn) {
			if index+1 < len(tokens) && tokens[index+1].kind == registryWhereTokWord && strings.EqualFold(tokens[index+1].text, "DESC") {
				return "ORDER BY time DESC"
			}
			return "ORDER BY time ASC"
		}
	}
	return ""
}

var influxGridUnsafeKeywords = []string{"GROUP", "FILL", "SLIMIT", "SOFFSET", "INTO", "TZ"}

// isInfluxCountStar 报告投影是否就是 COUNT(*) / COUNT(1)：网格统计总数用它，结果需要收敛成单列。
func isInfluxCountStar(projection string) bool {
	compact := strings.ToUpper(strings.Join(strings.Fields(projection), ""))
	return compact == "COUNT(*)" || compact == "COUNT(1)"
}
