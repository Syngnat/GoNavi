package app

import (
	"strings"

	"GoNavi-Wails/internal/connection"
)

// parseGreptimeDBExplain 解析 GreptimeDB 的 EXPLAIN：plan_type / plan 两列，plan 是多行 DataFusion 计划，
// 写入原文时单元格内的换行原样保留，所以按行扫描：以 "logical_plan\t" 开头的行开始逻辑计划段，
// 段内每行 "算子: 详情" 按缩进表达层级；分布式外壳 "MergeScan [... remote_input=[" 与收尾的 "]]" 跳过。
func parseGreptimeDBExplain(dbType, sourceSQL, raw string, text explainText) connection.ExplainResult {
	result := connection.ExplainResult{
		DBType:     dbType,
		SourceSQL:  sourceSQL,
		RawFormat:  connection.ExplainFormatText,
		RawPayload: raw,
	}
	builder := newIndentedPlanBuilder(&result, classifyGreptimeDBOperator)
	inLogical := false
	for _, rawLine := range strings.Split(raw, "\n") {
		line := strings.TrimRight(rawLine, " \r")
		if planType, rest, ok := strings.Cut(line, "\t"); ok {
			switch strings.TrimSpace(planType) {
			case "logical_plan":
				inLogical = true
				line = rest
			case "plan_type", "physical_plan":
				inLogical = false
				continue
			}
		}
		if !inLogical {
			continue
		}
		trimmed := strings.TrimLeft(line, " ")
		if trimmed == "" || strings.HasPrefix(trimmed, "]") || strings.HasPrefix(trimmed, "MergeScan [") {
			continue
		}
		operator, detail, _ := strings.Cut(trimmed, ":")
		node := builder.addNode(len(line)-len(trimmed), strings.TrimSpace(operator))
		applyGreptimeDBPlanDetail(node, strings.TrimSpace(detail))
	}
	if len(result.Nodes) == 0 {
		result.Warnings = []string{text("sql_analysis.backend.warning.plan_nodes_missing", map[string]any{"name": "GreptimeDB"})}
		return result
	}
	finalizeExplainStats(&result)
	return result
}

func classifyGreptimeDBOperator(operator string) string {
	lower := strings.ToLower(operator)
	switch {
	case strings.Contains(lower, "join"):
		return connection.ExplainOpJoin
	case lower == "tablescan":
		return connection.ExplainOpScan
	case lower == "aggregate", lower == "distinct":
		return connection.ExplainOpAggregate
	case lower == "sort":
		return connection.ExplainOpSort
	case lower == "limit":
		return connection.ExplainOpLimit
	case lower == "filter":
		return connection.ExplainOpFilter
	case lower == "union":
		return connection.ExplainOpUnion
	case lower == "windowaggr", lower == "window":
		return connection.ExplainOpWindow
	case lower == "subqueryalias":
		return connection.ExplainOpSubquery
	default:
		return connection.ExplainOpOther
	}
}

// applyGreptimeDBPlanDetail 写入算子详情：TableScan 的第一段是表名，没有下推过滤时标全表扫描；排序标额外排序。
func applyGreptimeDBPlanDetail(node *connection.ExplainNode, detail string) {
	if detail != "" {
		node.OpDetail = strings.TrimSpace(node.OpDetail + ": " + detail)
		node.Extra["detail"] = detail
	}
	switch node.OpType {
	case connection.ExplainOpScan:
		table, rest, _ := strings.Cut(detail, ",")
		node.Table = strings.TrimSpace(table)
		if !strings.Contains(rest, "filters=") {
			node.Flags = appendUniqueExplainFlags(node.Flags, connection.ExplainFlagFullScan)
		}
	case connection.ExplainOpSort:
		node.Flags = appendUniqueExplainFlags(node.Flags, connection.ExplainFlagFilesort)
	}
}
