package app

import (
	"strings"
	"unicode"

	"GoNavi-Wails/internal/connection"
)

// parseTiDBExplain 解析 TiDB 的表格式 EXPLAIN / EXPLAIN ANALYZE。
// TiDB 不支持 MySQL 的 FORMAT=JSON，计划是 id/estRows/task/access object/operator info
// 五列，id 列用 "├─"、"└─"、"│ " 前缀表达树层级（每层两个字符）。
func parseTiDBExplain(sourceSQL, raw string, text explainText) connection.ExplainResult {
	result := connection.ExplainResult{
		DBType:     "tidb",
		SourceSQL:  sourceSQL,
		RawFormat:  connection.ExplainFormatTable,
		RawPayload: raw,
	}
	header, rows := parseExplainTSVRows(raw)
	idCol := lookupTSVColumn(header, "id")
	if idCol < 0 || len(rows) == 0 {
		result.Warnings = []string{text("sql_analysis.backend.warning.plan_columns_missing", map[string]any{"name": "TiDB"})}
		return result
	}
	columns := tidbExplainColumns{
		estRows:    lookupTSVColumn(header, "estRows", "count"),
		actRows:    lookupTSVColumn(header, "actRows"),
		task:       lookupTSVColumn(header, "task"),
		access:     lookupTSVColumn(header, "access object"),
		info:       lookupTSVColumn(header, "operator info"),
		execution:  lookupTSVColumn(header, "execution info"),
		memoryUsed: lookupTSVColumn(header, "memory"),
	}
	// parents[depth] 是当前路径上该层的节点 ID。
	parents := make([]string, 0, 8)
	for _, row := range rows {
		if idCol >= len(row) {
			continue
		}
		depth, operator, role := splitTiDBPlanID(row[idCol])
		if operator == "" {
			continue
		}
		node := buildTiDBExplainNode(operator, row, columns)
		if role != "" {
			node.Extra["role"] = role
		}
		if depth > len(parents) {
			depth = len(parents)
		}
		parentID := ""
		if depth > 0 {
			parentID = parents[depth-1]
		}
		nodeID := appendExplainChild(&result, parentID, node)
		parents = append(parents[:depth], nodeID)
	}
	if len(result.Nodes) == 0 {
		result.Warnings = []string{text("sql_analysis.backend.warning.plan_nodes_missing", map[string]any{"name": "TiDB"})}
		return result
	}
	finalizeExplainStats(&result)
	return result
}

type tidbExplainColumns struct {
	estRows, actRows, task, access, info, execution, memoryUsed int
}

func tidbExplainCell(row []string, index int) string {
	if index < 0 || index >= len(row) {
		return ""
	}
	return strings.TrimSpace(row[index])
}

// splitTiDBPlanID 把 "│ ├─TableReader_39(Build)" 拆成层级、算子名（去掉 "_39" 序号）
// 与 Join 子节点角色（Build / Probe）。
func splitTiDBPlanID(id string) (int, string, string) {
	runes := []rune(strings.TrimRight(id, " "))
	prefix := 0
	for prefix < len(runes) && !unicode.IsLetter(runes[prefix]) && !unicode.IsDigit(runes[prefix]) {
		prefix++
	}
	operator := strings.TrimSpace(string(runes[prefix:]))
	role := ""
	if open := strings.LastIndexByte(operator, '('); open > 0 && strings.HasSuffix(operator, ")") {
		role = operator[open+1 : len(operator)-1]
		operator = operator[:open]
	}
	if underscore := strings.LastIndexByte(operator, '_'); underscore > 0 && isTiDBPlanSequence(operator[underscore+1:]) {
		operator = operator[:underscore]
	}
	return prefix / 2, operator, role
}

func isTiDBPlanSequence(text string) bool {
	if text == "" {
		return false
	}
	for _, ch := range text {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}

func buildTiDBExplainNode(operator string, row []string, columns tidbExplainColumns) connection.ExplainNode {
	info := tidbExplainCell(row, columns.info)
	node := connection.ExplainNode{
		OpType:     classifyTiDBOperator(operator),
		OpDetail:   strings.TrimSpace(operator + " " + info),
		EstRows:    int64(parseExplainFloat64(tidbExplainCell(row, columns.estRows))),
		ActualRows: parseExplainInt64(tidbExplainCell(row, columns.actRows)),
	}
	table, index := parseTiDBAccessObject(tidbExplainCell(row, columns.access))
	node.Table, node.Index = table, index
	extra := map[string]any{"operator": operator}
	if task := tidbExplainCell(row, columns.task); task != "" {
		extra["task"] = task
	}
	if execution := tidbExplainCell(row, columns.execution); execution != "" {
		extra["executionInfo"] = execution
	}
	if memory := tidbExplainCell(row, columns.memoryUsed); memory != "" && memory != "N/A" {
		extra["memory"] = memory
	}
	node.Extra = extra
	switch operator {
	case "TableFullScan":
		node.Flags = appendUniqueExplainFlags(node.Flags, connection.ExplainFlagFullScan)
	case "IndexFullScan":
		if node.Index == "" {
			node.Flags = appendUniqueExplainFlags(node.Flags, connection.ExplainFlagNoIndex)
		}
	case "Sort":
		node.Flags = appendUniqueExplainFlags(node.Flags, connection.ExplainFlagFilesort)
	}
	return node
}

func classifyTiDBOperator(operator string) string {
	switch {
	case operator == "TableFullScan", operator == "TableRangeScan", operator == "TableRowIDScan",
		operator == "PointGet", operator == "BatchPointGet", strings.HasSuffix(operator, "MemTableScan"):
		return connection.ExplainOpScan
	case operator == "IndexRangeScan", operator == "IndexFullScan", operator == "IndexLookUp", operator == "IndexMerge":
		return connection.ExplainOpIndexScan
	case operator == "IndexReader":
		return connection.ExplainOpIndexOnly
	case strings.HasSuffix(operator, "Join") || strings.HasSuffix(operator, "Apply"):
		return connection.ExplainOpJoin
	case strings.HasSuffix(operator, "Agg"):
		return connection.ExplainOpAggregate
	case operator == "Sort", operator == "TopN":
		return connection.ExplainOpSort
	case operator == "Limit":
		return connection.ExplainOpLimit
	case operator == "Selection":
		return connection.ExplainOpFilter
	case strings.HasPrefix(operator, "Union"):
		return connection.ExplainOpUnion
	case operator == "Window", operator == "Shuffle":
		return connection.ExplainOpWindow
	case strings.HasPrefix(operator, "Insert"):
		return connection.ExplainOpInsert
	case strings.HasPrefix(operator, "Update"):
		return connection.ExplainOpUpdate
	case strings.HasPrefix(operator, "Delete"):
		return connection.ExplainOpDelete
	default:
		return connection.ExplainOpOther
	}
}

// parseTiDBAccessObject 解析 "table:t, index:idx_a(a)" / "table:t, partition:p0"。
func parseTiDBAccessObject(text string) (string, string) {
	var table, index string
	for _, part := range strings.Split(text, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), ":")
		if !ok {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "table":
			table = strings.TrimSpace(value)
		case "index":
			value = strings.TrimSpace(value)
			if paren := strings.IndexByte(value, '('); paren > 0 {
				value = value[:paren]
			}
			index = value
		}
	}
	return table, index
}
