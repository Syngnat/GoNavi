package app

import (
	"regexp"
	"strings"

	"GoNavi-Wails/internal/connection"
)

var (
	// yashanDBPlanBorderPattern 匹配崖山计划表格的边框行（+----+-----+）。
	yashanDBPlanBorderPattern = regexp.MustCompile(`^\+[-+]+\+?$`)
	// yashanDBOperationInfoPattern 匹配 Operation Information 段的条目："4 - Predicate : filter(...)"。
	yashanDBOperationInfoPattern = regexp.MustCompile(`^\s*(\d+)\s*-\s*([^:]+?)\s*:\s*(.*)$`)
	// yashanDBCostPattern 匹配代价列 "147( 0)"，改写成 DBMS_XPLAN 的 "147 (0)"。
	yashanDBCostPattern = regexp.MustCompile(`(\d+)\(\s*(\d+)\)`)
)

// parseYashanDBExplain 解析崖山 EXPLAIN：单列文本，结构与 Oracle DBMS_XPLAN 相近（Id / Operation type / Name /
// Owner / Rows / Cost(%CPU) 表格，Operation type 的前导空格表达层级），差别是表格边框用 + 与 -、谓词写在
// Operation Information 段（"4 - Predicate : filter(...)"）。先规整成 DBMS_XPLAN 的样子，再交给 Oracle 解析器。
func parseYashanDBExplain(dbType, sourceSQL, raw string, text explainText) connection.ExplainResult {
	result, err := parseOracleExplain(sourceSQL, normalizeYashanDBExplain(raw), connection.ExplainFormatTable)
	result.DBType = dbType
	result.SourceSQL = sourceSQL
	result.RawPayload = raw
	if err != nil || len(result.Nodes) == 0 {
		result.RawFormat = connection.ExplainFormatText
		result.Warnings = append(result.Warnings, text("sql_analysis.backend.warning.plan_nodes_missing", map[string]any{"name": "YashanDB"}))
		return result
	}
	for i := range result.Nodes {
		node := &result.Nodes[i]
		// 崖山的排序、分组算子名不带 ORDER BY / GROUP BY（SORT、HASH GROUP、SORT GROUP）。
		switch operation := strings.ToUpper(node.OpDetail); {
		case operation == "SORT":
			node.OpType = connection.ExplainOpSort
			node.Flags = appendUniqueExplainFlags(node.Flags, connection.ExplainFlagFilesort)
		case strings.HasSuffix(operation, " GROUP"):
			node.OpType = connection.ExplainOpAggregate
		}
	}
	finalizeExplainStats(&result)
	return result
}

// normalizeYashanDBExplain 把崖山计划文本改写成 DBMS_XPLAN 格式：边框行换成横线，Operation Information 段换成
// Predicate Information 段（只保留谓词条目，同一算子的多条谓词合并），段与段之间补空行。
func normalizeYashanDBExplain(raw string) string {
	_, rows := parseExplainTSVRows(raw)
	lines := make([]string, 0, len(rows))
	for _, row := range rows {
		lines = append(lines, strings.Join(row, "\t"))
	}

	var builder strings.Builder
	inOperationInfo := false
	predicates := map[string][]string{}
	var predicateOrder []string
	for _, line := range lines {
		line = strings.TrimRight(strings.ReplaceAll(line, "\x00", ""), " \r")
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(strings.ToLower(trimmed), "operation information"):
			inOperationInfo = true
			continue
		case inOperationInfo:
			match := yashanDBOperationInfoPattern.FindStringSubmatch(line)
			if match == nil || !strings.EqualFold(strings.TrimSpace(match[2]), "predicate") {
				continue
			}
			if _, seen := predicates[match[1]]; !seen {
				predicateOrder = append(predicateOrder, match[1])
			}
			predicates[match[1]] = append(predicates[match[1]], strings.TrimSpace(match[3]))
			continue
		case yashanDBPlanBorderPattern.MatchString(trimmed):
			line = strings.Repeat("-", len(trimmed))
		case strings.HasPrefix(trimmed, "|"):
			line = yashanDBCostPattern.ReplaceAllString(line, "$1 ($2)")
		case strings.Trim(trimmed, "-") == "" && trimmed != "":
			// 段标题下的横线与边框残行：按边框处理，表格段在下一个空行结束。
			line = strings.Repeat("-", len(trimmed))
		}
		builder.WriteString(line)
		builder.WriteByte('\n')
	}
	if len(predicateOrder) > 0 {
		builder.WriteString("\nPredicate Information (identified by operation id):\n")
		builder.WriteString("---------------------------------------------------\n")
		for _, id := range predicateOrder {
			builder.WriteString("   " + id + " - " + strings.Join(predicates[id], " AND ") + "\n")
		}
	}
	return builder.String()
}
