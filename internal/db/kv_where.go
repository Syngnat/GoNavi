//go:build gonavi_full_drivers || gonavi_etcd_driver || gonavi_zookeeper_driver

package db

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// 键值类数据源（etcd、ZooKeeper）的数据浏览在客户端求值 WHERE、排序与分页：服务端只能按键 / 路径定位，
// 下推不了的条件在这里逐行过滤。

// kvColumnValue 取一行在某列上的值：数值列返回 numeric=true 与 number，其余列返回 text。
type kvColumnValue func(column string) (text string, number int64, numeric bool)

// matchKVWhere 在客户端求值 WHERE。
func matchKVWhere(node interface{}, value kvColumnValue) bool {
	switch typed := node.(type) {
	case nil:
		return true
	case registryWhereLogical:
		switch typed.op {
		case "Not":
			return !matchKVWhere(typed.operands[0], value)
		case "Or":
			for _, operand := range typed.operands {
				if matchKVWhere(operand, value) {
					return true
				}
			}
			return false
		default:
			for _, operand := range typed.operands {
				if !matchKVWhere(operand, value) {
					return false
				}
			}
			return true
		}
	case registryWhereCondition:
		return matchKVCondition(typed, value)
	}
	return false
}

// kvWhereReferences 报告 WHERE 是否引用了某列（用来决定是否需要先读取该列，如 ZooKeeper 的节点数据）。
func kvWhereReferences(node interface{}, column string) bool {
	switch typed := node.(type) {
	case registryWhereLogical:
		for _, operand := range typed.operands {
			if kvWhereReferences(operand, column) {
				return true
			}
		}
	case registryWhereCondition:
		return strings.EqualFold(typed.field, column)
	}
	return false
}

func matchKVCondition(condition registryWhereCondition, value kvColumnValue) bool {
	text, number, numeric := value(condition.field)
	compare := func(literal string) int {
		if numeric {
			parsed, err := parseKVNumber(literal)
			if err != nil {
				return strings.Compare(strconv.FormatInt(number, 10), literal)
			}
			switch {
			case number < parsed:
				return -1
			case number > parsed:
				return 1
			}
			return 0
		}
		return strings.Compare(text, literal)
	}
	values := condition.values
	switch condition.op {
	case "=":
		return compare(values[0].text) == 0
	case "!=":
		return compare(values[0].text) != 0
	case "<":
		return compare(values[0].text) < 0
	case "<=":
		return compare(values[0].text) <= 0
	case ">":
		return compare(values[0].text) > 0
	case ">=":
		return compare(values[0].text) >= 0
	case "BETWEEN", "NOT BETWEEN":
		inside := compare(values[0].text) >= 0 && compare(values[1].text) <= 0
		return inside == (condition.op == "BETWEEN")
	case "IN", "NOT IN":
		found := false
		for _, literal := range values {
			if compare(literal.text) == 0 {
				found = true
				break
			}
		}
		return found == (condition.op == "IN")
	case "LIKE", "NOT LIKE":
		subject := text
		if numeric {
			subject = strconv.FormatInt(number, 10)
		}
		return likeKVMatch(subject, values[0].text) == (condition.op == "LIKE")
	case "IS NULL":
		return !numeric && text == ""
	case "IS NOT NULL":
		return numeric || text != ""
	}
	return false
}

// parseKVNumber 接受十进制与十六进制（etcd 租约、ZooKeeper 会话 ID 习惯显示为十六进制）。
func parseKVNumber(text string) (int64, error) {
	text = strings.TrimSpace(text)
	if value, err := strconv.ParseInt(text, 10, 64); err == nil {
		return value, nil
	}
	value, err := strconv.ParseUint(strings.TrimPrefix(strings.ToLower(text), "0x"), 16, 64)
	return int64(value), err
}

// likeKVMatch 实现 SQL LIKE（% 任意串、_ 单字符、反斜杠转义）。
func likeKVMatch(subject, pattern string) bool {
	var expression strings.Builder
	expression.WriteString("^(?s)")
	runes := []rune(pattern)
	for i := 0; i < len(runes); i++ {
		switch r := runes[i]; {
		case r == '\\' && i+1 < len(runes):
			i++
			expression.WriteString(regexp.QuoteMeta(string(runes[i])))
		case r == '%':
			expression.WriteString(".*")
		case r == '_':
			expression.WriteString(".")
		default:
			expression.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	expression.WriteString("$")
	matched, err := regexp.MatchString(expression.String(), subject)
	return err == nil && matched
}

// kvText 把网格传来的值转成文本（nil 为空串）。
func kvText(value interface{}) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case []byte:
		return string(typed)
	default:
		return fmt.Sprint(typed)
	}
}

func unquoteKVIdent(text string) string {
	text = strings.TrimSpace(text)
	if len(text) >= 2 && text[0] == '"' && text[len(text)-1] == '"' {
		return strings.ReplaceAll(text[1:len(text)-1], `""`, `"`)
	}
	return text
}

// sliceKVPage 取一页。
func sliceKVPage[T any](rows []T, offset, limit int) []T {
	if offset >= len(rows) {
		return []T{}
	}
	rows = rows[offset:]
	if limit > 0 && limit < len(rows) {
		rows = rows[:limit]
	}
	return rows
}

// sortKVRows 按列在客户端稳定排序。
func sortKVRows[T any](rows []T, valueOf func(T) kvColumnValue, column string, desc bool) {
	sort.SliceStable(rows, func(i, j int) bool {
		leftText, leftNumber, numeric := valueOf(rows[i])(column)
		rightText, rightNumber, _ := valueOf(rows[j])(column)
		if numeric {
			if desc {
				return leftNumber > rightNumber
			}
			return leftNumber < rightNumber
		}
		if desc {
			return leftText > rightText
		}
		return leftText < rightText
	})
}

// kvSelectPattern 取出 SELECT 的投影与表名（表名可以是带引号的完整路径）。
var kvSelectPattern = regexp.MustCompile(`(?is)^\s*select\s+(.+?)\s+from\s+("(?:[^"]|"")+"|[^\s;]+)`)

var kvCountPattern = regexp.MustCompile(`(?i)^count\s*\(\s*\*\s*\)`)

// kvSelect 是数据浏览 SELECT 的通用部分：表、投影、计数、排序与分页。
type kvSelect struct {
	table    string
	count    bool
	columns  []string
	where    interface{}
	orderBy  string
	desc     bool
	limit    int
	offset   int
	hasLimit bool
}

// parseKVSelect 解析 SELECT；不是 SELECT 时返回 false（交给控制台命令）。
func parseKVSelect(text string, defaultLimit int) (kvSelect, bool, error) {
	match := kvSelectPattern.FindStringSubmatch(text)
	if match == nil {
		return kvSelect{}, false, nil
	}
	query := kvSelect{table: unquoteKVIdent(match[2])}
	projection := strings.TrimSpace(match[1])
	switch {
	case kvCountPattern.MatchString(projection):
		query.count = true
	case projection != "*":
		for _, column := range strings.Split(projection, ",") {
			if name := strings.ToLower(unquoteKVIdent(strings.TrimSpace(column))); name != "" {
				query.columns = append(query.columns, name)
			}
		}
	}
	clauses := splitRegistrySelectClauses(text, defaultLimit)
	query.limit, query.offset, query.hasLimit = clauses.limit, clauses.offset, clauses.hasLimit
	if order := strings.TrimSpace(clauses.orderBy); order != "" {
		fields := strings.Fields(strings.TrimSpace(strings.Split(order, ",")[0]))
		if len(fields) > 0 {
			query.orderBy = strings.ToLower(unquoteKVIdent(fields[0]))
			query.desc = len(fields) > 1 && strings.EqualFold(fields[len(fields)-1], "DESC")
		}
	}
	if strings.TrimSpace(clauses.where) != "" {
		node, err := parseRegistryWhere(clauses.where)
		if err != nil {
			return kvSelect{}, true, err
		}
		query.where = node
	}
	return query, true, nil
}
