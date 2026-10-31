package app

import (
	"strings"

	"GoNavi-Wails/internal/connection"
)

// parseHiveExplain retains the native stage/physical plan rather than treating
// Hive, Spark and Impala as MySQL cost trees. Only EXPLAIN is issued, never ANALYZE.
func parseHiveExplain(dbType, sourceSQL, raw string, text explainText) connection.ExplainResult {
	result := connection.ExplainResult{
		DBType: dbType, SourceSQL: sourceSQL,
		RawFormat: connection.ExplainFormatText, RawPayload: raw,
	}
	header, rows := parseExplainTSVRows(raw)
	column := lookupTSVColumn(header, "Explain", "plan", "QUERY PLAN", "explain plan")
	if column < 0 && len(header) == 1 {
		column = 0
	}
	if column < 0 {
		result.Warnings = []string{text("sql_analysis.backend.warning.plan_columns_missing", map[string]any{"name": "HiveServer2"})}
		return result
	}
	builder := newIndentedPlanBuilder(&result, classifyHivePlanOperator)
	for _, row := range rows {
		if column >= len(row) {
			continue
		}
		for _, line := range strings.Split(row[column], "\n") {
			line = strings.TrimRight(line, " \r")
			trimmed := strings.TrimLeft(line, " \t|:+-\\")
			if trimmed == "" {
				continue
			}
			builder.addNode(len(line)-len(trimmed), trimmed)
		}
	}
	if len(result.Nodes) == 0 {
		result.Warnings = []string{text("sql_analysis.backend.warning.plan_nodes_missing", map[string]any{"name": "HiveServer2"})}
	}
	finalizeExplainStats(&result)
	return result
}

func classifyHivePlanOperator(operator string) string {
	lower := strings.ToLower(operator)
	switch {
	case strings.Contains(lower, "group by"), strings.Contains(lower, "groupby"), strings.Contains(lower, "aggregate"):
		return connection.ExplainOpAggregate
	case strings.Contains(lower, "select operator"), strings.Contains(lower, "project"):
		return connection.ExplainOpOther
	case strings.Contains(lower, "file output"), strings.Contains(lower, "file sink"):
		return connection.ExplainOpOther
	default:
		return classifyQuestDBOperator(operator)
	}
}
