//go:build gonavi_full_drivers || gonavi_elasticsearch_driver || gonavi_opensearch_driver

package db

import (
	"regexp"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/esconsole"
)

// resolveEsIndexName 从 dbName / tableName / 默认值中确定索引名。
func resolveEsIndexName(dbName, tableName, defaultDB string) string {
	if name := strings.TrimSpace(tableName); name != "" {
		return name
	}
	if name := strings.TrimSpace(dbName); name != "" {
		return name
	}
	return strings.TrimSpace(defaultDB)
}

// reESSQLFrom 匹配 SELECT ... FROM "schema"."table" 或 FROM index（含多段点分标识符）。
// 支持三种格式：
//   - "a"."b"."c"  → a.b.c（引号包裹的多段标识符）
//   - "a.b.c"      → a.b.c（单引号包裹的完整名称）
//   - my_index      → my_index（无引号）
var reESSQLFrom = regexp.MustCompile(`(?i)\bFROM\s+(?:"([^"]+)"(?:\."([^"]+)")*|([a-zA-Z0-9_*][a-zA-Z0-9_.\-*]*))\s*(?:;|\s|$)`)

// extractESSQLFromTable 从 SQL 语句中提取 FROM 后的索引名。
// 支持多段引号格式（如 "schema"."table"."partition"）和单段格式。
// 返回提取的索引名（可能含 . 或 *），提取失败返回空串。
func extractESSQLFromTable(sql string) string {
	candidate := strings.TrimSpace(sql)
	if strings.HasPrefix(strings.ToUpper(candidate), "FROM ") {
		candidate = "SELECT * " + candidate
	}
	parsed, err := esconsole.ParseSimplifiedSelect(candidate)
	if err != nil {
		return ""
	}
	return parsed.Target
}

// esParsedSQL 解析后的 SQL 各组成部分。
type esParsedSQL struct {
	Table   string // FROM 后的索引名
	Columns string // SELECT 列（* 或具体列名）
	Where   string // WHERE 条件原文
	OrderBy string // ORDER BY 子句
	Limit   int    // LIMIT 值，0 表示未指定
	Offset  int    // OFFSET 值，0 表示未指定
}

// reSQLLimit 匹配 LIMIT n（可选 OFFSET m）。
var reSQLLimit = regexp.MustCompile(`(?i)\bLIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?`)

// reSQLOffset 匹配独立的 OFFSET n。
var reSQLOffset = regexp.MustCompile(`(?i)\bOFFSET\s+(\d+)`)

// reSQLOrderBy 匹配 ORDER BY 子句。
var reSQLOrderBy = regexp.MustCompile(`(?i)\bORDER\s+BY\s+(.+?)(?:\bLIMIT\b|\bOFFSET\b|$)`)

func trimESTrailingClauseSyntax(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, " \t\r\n;；")
	return strings.TrimSpace(s)
}

// parseESSQL 解析简单 SELECT SQL 为结构化组成部分。
func parseESSQL(sql string) (esParsedSQL, bool) {
	compatibility, err := esconsole.ParseSimplifiedSelect(sql)
	if err != nil {
		return esParsedSQL{}, false
	}
	return esParsedSQL{
		Table:   compatibility.Target,
		Columns: compatibility.Columns,
		Where:   compatibility.Where,
		OrderBy: compatibility.OrderBy,
		Limit:   compatibility.Limit,
		Offset:  compatibility.Offset,
	}, true
}

// convertSQLWhereToESQuery 将简单 SQL WHERE 条件转换为 ES query DSL map。
// 支持的运算符：=, !=, <>, >, <, >=, <=, LIKE, IS NULL, IS NOT NULL。
// 支持 AND / OR 组合和括号分组。
// 对于无法转换的复杂条件，返回 match_all。
func convertSQLWhereToESQuery(where string) map[string]interface{} {
	where = strings.TrimSpace(where)
	if where == "" {
		return nil
	}

	// 去掉最外层括号
	for len(where) >= 2 && where[0] == '(' && where[len(where)-1] == ')' {
		inner := where[1 : len(where)-1]
		if balancedParens(inner) {
			where = inner
		} else {
			break
		}
	}
	where = strings.TrimSpace(where)
	if where == "" {
		return nil
	}

	// 尝试拆分顶层 AND
	if parts := splitTopLevel(where, "AND"); len(parts) > 1 {
		var clauses []map[string]interface{}
		for _, p := range parts {
			if q := convertSQLWhereToESQuery(p); q != nil {
				clauses = append(clauses, q)
			}
		}
		if len(clauses) == 1 {
			return clauses[0]
		}
		if len(clauses) > 1 {
			return map[string]interface{}{"bool": map[string]interface{}{"must": clauses}}
		}
		return nil
	}

	// 尝试拆分顶层 OR
	if parts := splitTopLevel(where, "OR"); len(parts) > 1 {
		var clauses []map[string]interface{}
		for _, p := range parts {
			if q := convertSQLWhereToESQuery(p); q != nil {
				clauses = append(clauses, q)
			}
		}
		if len(clauses) == 1 {
			return clauses[0]
		}
		if len(clauses) > 1 {
			return map[string]interface{}{"bool": map[string]interface{}{"should": clauses}}
		}
		return nil
	}

	// 解析单个条件：field op value
	return parseSingleCondition(where)
}

// parseSingleCondition 解析单个 SQL 条件为 ES query。
func parseSingleCondition(cond string) map[string]interface{} {
	cond = strings.TrimSpace(cond)
	cond = strings.Trim(cond, "()")
	cond = strings.TrimSpace(cond)
	if cond == "" {
		return nil
	}

	// IS NOT NULL
	if re := regexp.MustCompile(`(?i)^"?(.+?)"?\s+IS\s+NOT\s+NULL$`); re.MatchString(cond) {
		m := re.FindStringSubmatch(cond)
		return map[string]interface{}{
			"exists": map[string]interface{}{"field": cleanIdentifier(m[1])},
		}
	}

	// IS NULL
	if re := regexp.MustCompile(`(?i)^"?(.+?)"?\s+IS\s+NULL$`); re.MatchString(cond) {
		m := re.FindStringSubmatch(cond)
		return map[string]interface{}{
			"bool": map[string]interface{}{
				"must_not": []map[string]interface{}{
					{"exists": map[string]interface{}{"field": cleanIdentifier(m[1])}},
				},
			},
		}
	}

	// NOT LIKE
	if re := regexp.MustCompile(`(?i)^"?(.+?)"?\s+NOT\s+LIKE\s+'(.+)'$`); re.MatchString(cond) {
		m := re.FindStringSubmatch(cond)
		pattern := strings.ReplaceAll(m[2], "%", "*")
		pattern = strings.ReplaceAll(pattern, "_", "?")
		return map[string]interface{}{
			"bool": map[string]interface{}{
				"must_not": []map[string]interface{}{
					{"wildcard": map[string]interface{}{cleanIdentifier(m[1]): pattern}},
				},
			},
		}
	}

	// LIKE
	if re := regexp.MustCompile(`(?i)^"?(.+?)"?\s+LIKE\s+'(.+)'$`); re.MatchString(cond) {
		m := re.FindStringSubmatch(cond)
		pattern := strings.ReplaceAll(m[2], "%", "*")
		pattern = strings.ReplaceAll(pattern, "_", "?")
		return map[string]interface{}{
			"wildcard": map[string]interface{}{cleanIdentifier(m[1]): pattern},
		}
	}

	// != 或 <>
	if idx := findOperator(cond, "!=", "<>"); idx >= 0 {
		field, value := splitAtOperator(cond, idx, 2)
		if field != "" {
			return map[string]interface{}{
				"bool": map[string]interface{}{
					"must_not": []map[string]interface{}{
						{"term": map[string]interface{}{cleanIdentifier(field): parseSQLValue(value)}},
					},
				},
			}
		}
	}

	// >=
	if idx := findOperator(cond, ">="); idx >= 0 {
		field, value := splitAtOperator(cond, idx, 2)
		if field != "" {
			return map[string]interface{}{
				"range": map[string]interface{}{cleanIdentifier(field): map[string]interface{}{"gte": parseSQLValue(value)}},
			}
		}
	}

	// <=
	if idx := findOperator(cond, "<="); idx >= 0 {
		field, value := splitAtOperator(cond, idx, 2)
		if field != "" {
			return map[string]interface{}{
				"range": map[string]interface{}{cleanIdentifier(field): map[string]interface{}{"lte": parseSQLValue(value)}},
			}
		}
	}

	// >
	if idx := findOperator(cond, ">"); idx >= 0 {
		field, value := splitAtOperator(cond, idx, 1)
		if field != "" {
			return map[string]interface{}{
				"range": map[string]interface{}{cleanIdentifier(field): map[string]interface{}{"gt": parseSQLValue(value)}},
			}
		}
	}

	// <
	if idx := findOperator(cond, "<"); idx >= 0 {
		field, value := splitAtOperator(cond, idx, 1)
		if field != "" {
			return map[string]interface{}{
				"range": map[string]interface{}{cleanIdentifier(field): map[string]interface{}{"lt": parseSQLValue(value)}},
			}
		}
	}

	// =（放在最后，避免匹配 >= <= !=）
	if idx := findOperator(cond, "="); idx >= 0 {
		field, value := splitAtOperator(cond, idx, 1)
		if field != "" {
			return map[string]interface{}{
				"term": map[string]interface{}{cleanIdentifier(field): parseSQLValue(value)},
			}
		}
	}

	// 无法识别的条件，降级为 query_string
	return map[string]interface{}{
		"query_string": map[string]interface{}{"query": cond},
	}
}

// cleanIdentifier 去掉标识符两端的引号。
func cleanIdentifier(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, `"'`)
	return s
}

// parseSQLValue 将 SQL 字面量转为 Go 值。
func parseSQLValue(s string) interface{} {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, `"'`)
	// 尝试数值转换
	if n, err := strconv.ParseFloat(s, 64); err == nil {
		return n
	}
	if s == "true" || s == "TRUE" {
		return true
	}
	if s == "false" || s == "FALSE" {
		return false
	}
	return s
}

// findOperator 在条件字符串中查找顶层运算符位置。
func findOperator(cond string, ops ...string) int {
	inQuote := byte(0)
	depth := 0
	for i := 0; i < len(cond); i++ {
		ch := cond[i]
		if ch == '\'' || ch == '"' {
			if inQuote == 0 {
				inQuote = ch
			} else if inQuote == ch {
				inQuote = 0
			}
			continue
		}
		if inQuote != 0 {
			continue
		}
		if ch == '(' {
			depth++
			continue
		}
		if ch == ')' {
			depth--
			continue
		}
		if depth != 0 {
			continue
		}
		for _, op := range ops {
			if i+len(op) <= len(cond) && cond[i:i+len(op)] == op {
				// 确保不是 >= <= <> 的一部分
				if op == ">" && i+1 < len(cond) && (cond[i+1] == '=' || cond[i+1] == '>') {
					continue
				}
				if op == "<" && i+1 < len(cond) && (cond[i+1] == '=' || cond[i+1] == '>') {
					continue
				}
				if op == "!" && i+1 < len(cond) && cond[i+1] != '=' {
					continue
				}
				return i
			}
		}
	}
	return -1
}

// splitAtOperator 在运算符位置拆分 field 和 value。
func splitAtOperator(cond string, idx, opLen int) (string, string) {
	field := strings.TrimSpace(cond[:idx])
	value := strings.TrimSpace(cond[idx+opLen:])
	return field, value
}

// splitTopLevel 在顶层按关键词拆分（忽略括号和引号内的关键词）。
func splitTopLevel(s string, keyword string) []string {
	upper := strings.ToUpper(s)
	kwLen := len(keyword)
	inQuote := byte(0)
	depth := 0
	var parts []string
	last := 0

	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch == '\'' || ch == '"' {
			if inQuote == 0 {
				inQuote = ch
			} else if inQuote == ch {
				inQuote = 0
			}
			continue
		}
		if inQuote != 0 {
			continue
		}
		if ch == '(' {
			depth++
			continue
		}
		if ch == ')' {
			depth--
			continue
		}
		if depth != 0 {
			continue
		}
		if i+kwLen <= len(upper) && upper[i:i+kwLen] == keyword {
			// 确保是完整单词（前后是空格或括号）
			beforeOK := i == 0 || s[i-1] == ' ' || s[i-1] == '(' || s[i-1] == ')'
			afterIdx := i + kwLen
			afterOK := afterIdx >= len(s) || s[afterIdx] == ' ' || s[afterIdx] == '(' || s[afterIdx] == ')'
			if beforeOK && afterOK {
				parts = append(parts, strings.TrimSpace(s[last:i]))
				last = afterIdx
			}
		}
	}
	parts = append(parts, strings.TrimSpace(s[last:]))
	return parts
}

// balancedParens 检查字符串中的括号是否完全配对。
func balancedParens(s string) bool {
	depth := 0
	inQuote := byte(0)
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if ch == '\'' || ch == '"' {
			if inQuote == 0 {
				inQuote = ch
			} else if inQuote == ch {
				inQuote = 0
			}
			continue
		}
		if inQuote != 0 {
			continue
		}
		if ch == '(' {
			depth++
		} else if ch == ')' {
			depth--
			if depth < 0 {
				return false
			}
		}
	}
	return depth == 0
}

// convertSQLOrderByToES 将 SQL ORDER BY 转换为 ES sort 数组。
// 支持 "field" ASC/DESC 和 _score DESC。
func convertSQLOrderByToES(orderBy string) []map[string]interface{} {
	orderBy = strings.TrimSpace(orderBy)
	if orderBy == "" {
		return nil
	}
	var sorts []map[string]interface{}
	for _, part := range strings.Split(orderBy, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		fields := strings.Fields(part)
		field := cleanIdentifier(fields[0])
		order := "asc"
		if len(fields) >= 2 {
			dir := strings.ToUpper(fields[1])
			if dir == "DESC" {
				order = "desc"
			}
		}
		sorts = append(sorts, map[string]interface{}{field: order})
	}
	return sorts
}
