package app

import (
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// parseDistributedMySQLTextExplain parses the single-column text plans emitted
// by Apache Doris and StarRocks. These plans are PLAN FRAGMENT pipelines, not
// MySQL's id/type/table tabular EXPLAIN format.
func parseDistributedMySQLTextExplain(dbType, sourceSQL, raw string, format connection.ExplainFormat) connection.ExplainResult {
	result := connection.ExplainResult{
		DBType:     dbType,
		SourceSQL:  sourceSQL,
		RawFormat:  connection.ExplainFormatText,
		RawPayload: raw,
	}

	parentID := ""
	lastNodeIndex := -1
	for _, rawLine := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(strings.ToUpper(line), "EXPLAIN STRING") {
			continue
		}
		if strings.HasPrefix(strings.ToUpper(line), "PLAN FRAGMENT") {
			parentID = ""
			lastNodeIndex = -1
			continue
		}

		if detail, ok := distributedPlanOperatorDetail(line); ok {
			node := connection.ExplainNode{
				OpType:   classifyDistributedPlanOperator(detail),
				OpDetail: detail,
			}
			nodeID := appendExplainChild(&result, parentID, node)
			parentID = nodeID
			lastNodeIndex = len(result.Nodes) - 1
			continue
		}

		if lastNodeIndex >= 0 {
			applyDistributedPlanProperty(&result.Nodes[lastNodeIndex], line)
		}
	}

	if len(result.Nodes) == 0 {
		result.Warnings = []string{"未识别到 Doris/StarRocks 计划算子，请查看原文"}
		return result
	}
	finalizeExplainStats(&result)
	return result
}

func distributedPlanOperatorDetail(line string) (string, bool) {
	trimmed := strings.TrimLeft(line, " |+-├└─│\t")
	colon := strings.IndexByte(trimmed, ':')
	if colon <= 0 {
		return "", false
	}
	if _, err := strconv.Atoi(strings.TrimSpace(trimmed[:colon])); err != nil {
		return "", false
	}
	detail := strings.TrimSpace(trimmed[colon+1:])
	upper := strings.ToUpper(detail)
	known := []string{
		"SCAN", "AGGREGATE", "JOIN", "EXCHANGE", "SORT", "TOP-N", "TOPN",
		"LIMIT", "UNION", "PROJECT", "FILTER", "ANALYTIC", "WINDOW", "NODE",
	}
	for _, token := range known {
		if strings.Contains(upper, token) {
			return detail, true
		}
	}
	return "", false
}

func classifyDistributedPlanOperator(detail string) string {
	upper := strings.ToUpper(detail)
	switch {
	case strings.Contains(upper, "SCAN"):
		return connection.ExplainOpScan
	case strings.Contains(upper, "AGGREGATE"):
		return connection.ExplainOpAggregate
	case strings.Contains(upper, "JOIN"):
		return connection.ExplainOpJoin
	case strings.Contains(upper, "SORT"), strings.Contains(upper, "TOP-N"), strings.Contains(upper, "TOPN"):
		return connection.ExplainOpSort
	case strings.Contains(upper, "LIMIT"):
		return connection.ExplainOpLimit
	case strings.Contains(upper, "UNION"):
		return connection.ExplainOpUnion
	case strings.Contains(upper, "FILTER"):
		return connection.ExplainOpFilter
	case strings.Contains(upper, "ANALYTIC"), strings.Contains(upper, "WINDOW"):
		return connection.ExplainOpWindow
	default:
		return connection.ExplainOpOther
	}
}

func applyDistributedPlanProperty(node *connection.ExplainNode, line string) {
	if node == nil {
		return
	}
	trimmed := strings.TrimSpace(strings.TrimLeft(line, "|+-├└─│ "))
	lower := strings.ToLower(trimmed)
	switch {
	case strings.HasPrefix(lower, "table:"):
		value := strings.TrimSpace(trimmed[len("table:"):])
		if comma := strings.IndexByte(value, ','); comma >= 0 {
			value = strings.TrimSpace(value[:comma])
		}
		node.Table = value
	case strings.HasPrefix(lower, "cardinality="):
		node.EstRows = parseDistributedPlanInt(strings.TrimSpace(trimmed[len("cardinality="):]))
	case strings.HasPrefix(lower, "cardinality:"):
		node.EstRows = parseDistributedPlanInt(strings.TrimSpace(trimmed[len("cardinality:"):]))
	case strings.HasPrefix(lower, "actualrows="):
		node.ActualRows = parseDistributedPlanInt(strings.TrimSpace(trimmed[len("actualrows="):]))
	case strings.HasPrefix(lower, "rollup:"):
		node.Index = strings.TrimSpace(trimmed[len("rollup:"):])
	case strings.HasPrefix(lower, "partitions=") || strings.HasPrefix(lower, "partitionsratio="):
		ratio := trimmed[strings.IndexByte(trimmed, '=')+1:]
		selected, total, ok := parseDistributedPlanRatio(ratio)
		if ok && selected == total && node.OpType == connection.ExplainOpScan {
			node.Flags = appendUniqueExplainFlags(node.Flags, connection.ExplainFlagFullScan)
		}
	}
}

func parseDistributedPlanInt(value string) int64 {
	end := 0
	for end < len(value) && value[end] >= '0' && value[end] <= '9' {
		end++
	}
	if end == 0 {
		return 0
	}
	parsed, _ := strconv.ParseInt(value[:end], 10, 64)
	return parsed
}

func parseDistributedPlanRatio(value string) (int64, int64, bool) {
	parts := strings.SplitN(strings.TrimSpace(value), "/", 2)
	if len(parts) != 2 {
		return 0, 0, false
	}
	selected := parseDistributedPlanInt(parts[0])
	total := parseDistributedPlanInt(parts[1])
	return selected, total, total > 0
}

func appendUniqueExplainFlags(flags []string, values ...string) []string {
	for _, value := range values {
		found := false
		for _, existing := range flags {
			if existing == value {
				found = true
				break
			}
		}
		if !found {
			flags = append(flags, value)
		}
	}
	return flags
}
