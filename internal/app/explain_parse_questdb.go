package app

import (
	"regexp"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// QuestDB 计划里的属性行以小写字段名加冒号开头（keys: [ts]、filter: side='buy'、intervals: [...]）；
// 算子行以大写字母开头，可能在行尾带内联属性（"Async JIT Group By workers: 20"、"Frame forward scan on: trades"）。
var (
	questDBPlanPropertyPattern = regexp.MustCompile(`^([a-z][A-Za-z_-]*):\s*(.*)$`)
	questDBInlineAttrPattern   = regexp.MustCompile(`\s([a-z][A-Za-z_-]*):\s*(\S+)`)
)

// parseQuestDBExplain 解析 QuestDB 的 EXPLAIN：单列 QUERY PLAN 文本，算子行按缩进表达层级。
func parseQuestDBExplain(dbType, sourceSQL, raw string, text explainText) connection.ExplainResult {
	result := connection.ExplainResult{
		DBType:     dbType,
		SourceSQL:  sourceSQL,
		RawFormat:  connection.ExplainFormatText,
		RawPayload: raw,
	}
	header, rows := parseExplainTSVRows(raw)
	planCol := lookupTSVColumn(header, "QUERY PLAN")
	if planCol < 0 {
		result.Warnings = []string{text("sql_analysis.backend.warning.plan_columns_missing", map[string]any{"name": "QuestDB"})}
		return result
	}
	builder := newIndentedPlanBuilder(&result, classifyQuestDBOperator)
	for _, row := range rows {
		if planCol >= len(row) {
			continue
		}
		line := strings.TrimRight(row[planCol], " \r")
		trimmed := strings.TrimLeft(line, " ")
		if trimmed == "" {
			continue
		}
		if match := questDBPlanPropertyPattern.FindStringSubmatch(trimmed); match != nil {
			if node := builder.currentNode(); node != nil {
				applyQuestDBPlanProperty(node, match[1], strings.TrimSpace(match[2]))
			}
			continue
		}
		operator, attributes := splitQuestDBOperator(trimmed)
		node := builder.addNode(len(line)-len(trimmed), operator)
		if node.OpType == connection.ExplainOpSort {
			node.Flags = appendUniqueExplainFlags(node.Flags, connection.ExplainFlagFilesort)
		}
		for _, attribute := range attributes {
			applyQuestDBPlanProperty(node, attribute[0], attribute[1])
		}
	}
	if len(result.Nodes) == 0 {
		result.Warnings = append(result.Warnings, text("sql_analysis.backend.warning.plan_nodes_missing", map[string]any{"name": "QuestDB"}))
		return result
	}
	finalizeExplainStats(&result)
	return result
}

// splitQuestDBOperator 把算子行拆成算子名与行尾内联属性。
func splitQuestDBOperator(line string) (string, [][2]string) {
	matches := questDBInlineAttrPattern.FindAllStringSubmatchIndex(line, -1)
	if len(matches) == 0 {
		return line, nil
	}
	attributes := make([][2]string, 0, len(matches))
	for _, match := range matches {
		attributes = append(attributes, [2]string{line[match[2]:match[3]], line[match[4]:match[5]]})
	}
	return strings.TrimSpace(line[:matches[0][0]]), attributes
}

func classifyQuestDBOperator(operator string) string {
	lower := strings.ToLower(operator)
	switch {
	case strings.Contains(lower, "join"):
		return connection.ExplainOpJoin
	case strings.Contains(lower, "scan"), lower == "pageframe", lower == "dataframe":
		return connection.ExplainOpScan
	case strings.Contains(lower, "group by"), strings.Contains(lower, "groupby"), strings.Contains(lower, "sample by"),
		strings.Contains(lower, "sampleby"), strings.HasPrefix(lower, "count"), strings.Contains(lower, "distinct"):
		return connection.ExplainOpAggregate
	case strings.Contains(lower, "sort"):
		return connection.ExplainOpSort
	case strings.HasPrefix(lower, "limit"):
		return connection.ExplainOpLimit
	case strings.Contains(lower, "filter"):
		return connection.ExplainOpFilter
	case strings.HasPrefix(lower, "union"), strings.HasPrefix(lower, "except"), strings.HasPrefix(lower, "intersect"):
		return connection.ExplainOpUnion
	case strings.Contains(lower, "window"):
		return connection.ExplainOpWindow
	case strings.HasPrefix(lower, "update"):
		return connection.ExplainOpUpdate
	case strings.HasPrefix(lower, "insert"):
		return connection.ExplainOpInsert
	default:
		return connection.ExplainOpOther
	}
}

// applyQuestDBPlanProperty 落属性：on 是扫描的表；Frame 扫描整表（Interval 扫描只读命中的分区）标全表扫描；
// filter、keys 等写进算子说明。
func applyQuestDBPlanProperty(node *connection.ExplainNode, key, value string) {
	if node.Extra == nil {
		node.Extra = map[string]any{}
	}
	node.Extra[key] = value
	switch key {
	case "on":
		node.Table = strings.Trim(value, `"'`)
		if strings.HasPrefix(strings.ToLower(node.OpDetail), "frame") {
			node.Flags = appendUniqueExplainFlags(node.Flags, connection.ExplainFlagFullScan)
		}
	case "filter", "symbolFilter", "keys", "values", "intervals", "lo", "hi":
		node.OpDetail = strings.TrimSpace(node.OpDetail + " " + key + ": " + value)
	}
}
