package app

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// MySQL EXPLAIN ANALYZE（8.0.18+）的树形文本解析。每行一个步骤，缩进 4 个空格一层：
//
//	-> Limit: 5 row(s)  (cost=3884 rows=1) (actual time=10.9..10.9 rows=1 loops=1)
//	    -> Nested loop inner join  (cost=3550 rows=3341) (actual time=1.8..10.4 rows=4960 loops=1)
//	        -> Index lookup on i using idx_customer (customer_id=c.id)  (cost=6.27 rows=25.1) (never executed)
//	    -> Select #2 (subquery in projection; dependent)
//
// 每步文字与新版 FORMAT=JSON 的 operation 相同，因此复用新版的节点构造与分类：
// 估算成本含子步骤；实际耗时（毫秒）与行数都是每次循环的平均值。

// mysqlTreeNumberPattern is one number such as 0.1, 9.87e+6 or 74e-6; it must
// not swallow the ".." between a range's two ends.
const mysqlTreeNumberPattern = `([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)`

var (
	mysqlTreeCostPattern   = regexp.MustCompile(`\(cost=` + mysqlTreeNumberPattern + `(?:\.\.` + mysqlTreeNumberPattern + `)? rows=` + mysqlTreeNumberPattern + `\)`)
	mysqlTreeActualPattern = regexp.MustCompile(`\(actual time=` + mysqlTreeNumberPattern + `\.\.` + mysqlTreeNumberPattern +
		` rows=` + mysqlTreeNumberPattern + ` loops=([0-9]+)\)`)
	mysqlTreeNeverPattern = regexp.MustCompile(`\(never executed\)`)
	mysqlTreeTablePattern = regexp.MustCompile(`(?i)(?:scan|lookup|search) on (\S+)(?: using (\S+))?`)
)

type mysqlTreeLine struct {
	depth int
	text  string
}

// isMySQLTreeExplain reports whether raw is EXPLAIN ANALYZE / FORMAT=TREE output.
func isMySQLTreeExplain(raw string) bool {
	return strings.HasPrefix(strings.TrimSpace(raw), "->")
}

func parseMySQLTreeExplain(dbType, sourceSQL, raw string) (connection.ExplainResult, error) {
	result := connection.ExplainResult{
		DBType:     dbType,
		SourceSQL:  sourceSQL,
		RawFormat:  connection.ExplainFormatText,
		RawPayload: raw,
	}
	lines := splitMySQLTreeLines(raw)
	if len(lines) == 0 {
		return result, fmt.Errorf("MySQL EXPLAIN ANALYZE 返回空内容")
	}
	// ancestors[d] is the latest node at depth d; a deeper line hangs under it.
	ancestors := make([]string, 0, 8)
	for _, line := range lines {
		depth := line.depth
		if depth > len(ancestors) {
			depth = len(ancestors)
		}
		parentID := ""
		if depth > 0 {
			parentID = ancestors[depth-1]
		}
		nodeID := appendExplainChild(&result, parentID, buildMySQLTreeNode(line.text, depth == 0))
		ancestors = append(ancestors[:depth], nodeID)
	}
	result.Stats.TotalCost = result.Nodes[0].Cost
	finalizeExplainStats(&result)
	result.Stats.TotalDurationMs = mysqlTreeRootDuration(result.Nodes)
	return result, nil
}

// splitMySQLTreeLines keeps one entry per "->" step; a line without the arrow
// continues the previous step (long conditions are never wrapped by MySQL, but
// a client may have wrapped them).
func splitMySQLTreeLines(raw string) []mysqlTreeLine {
	var lines []mysqlTreeLine
	for _, rawLine := range strings.Split(strings.ReplaceAll(raw, "\r\n", "\n"), "\n") {
		trimmedRight := strings.TrimRight(rawLine, " \t")
		content := strings.TrimLeft(trimmedRight, " ")
		if content == "" {
			continue
		}
		if !strings.HasPrefix(content, "->") {
			if len(lines) > 0 {
				lines[len(lines)-1].text += " " + content
			}
			continue
		}
		indent := len(trimmedRight) - len(content)
		lines = append(lines, mysqlTreeLine{
			depth: indent / 4,
			text:  strings.TrimSpace(strings.TrimPrefix(content, "->")),
		})
	}
	return lines
}

func buildMySQLTreeNode(text string, isRoot bool) connection.ExplainNode {
	step := mysqlJSONV2Node{}
	if match := mysqlTreeCostPattern.FindStringSubmatch(text); match != nil {
		cost := match[2]
		if cost == "" {
			cost = match[1]
		}
		step.EstimatedTotalCost = mysqlTreeNumber(cost)
		step.EstimatedRows = mysqlTreeNumber(match[3])
	}
	if match := mysqlTreeActualPattern.FindStringSubmatch(text); match != nil {
		step.ActualFirstRowMs = mysqlTreeNumber(match[1])
		step.ActualLastRowMs = mysqlTreeNumber(match[2])
		step.ActualRows = mysqlTreeNumber(match[3])
		step.ActualLoops = json.Number(match[4])
	}
	neverExecuted := mysqlTreeNeverPattern.MatchString(text)
	operation := mysqlTreeCostPattern.ReplaceAllString(text, "")
	operation = mysqlTreeActualPattern.ReplaceAllString(operation, "")
	operation = strings.TrimSpace(mysqlTreeNeverPattern.ReplaceAllString(operation, ""))
	step.Operation = operation

	internalTable := ""
	if match := mysqlTreeTablePattern.FindStringSubmatch(operation); match != nil {
		if strings.HasPrefix(match[1], "<") {
			internalTable = match[1]
		} else {
			step.TableName = match[1]
			step.IndexName = match[2]
		}
	}
	if strings.HasPrefix(strings.ToLower(operation), "covering index") {
		covering := true
		step.Covering = &covering
	}

	node := buildMySQLJSONV2ExplainNode(&step, isRoot)
	if internalTable != "" {
		// Reading back MySQL's own temporary/derived result is not a missing index.
		node.Flags = removeExplainFlags(node.Flags, connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex)
		node.Flags = appendExplainFlag(node.Flags, connection.ExplainFlagTempTable)
		if node.OpType == connection.ExplainOpScan {
			node.OpType = connection.ExplainOpOther
		}
		setExplainExtra(&node, "internalTable", internalTable)
	}
	if neverExecuted {
		setExplainExtra(&node, "neverExecuted", true)
	}
	return node
}

// mysqlTreeNumber turns tree numbers such as "9.87e+6" or "74e-6" into plain
// decimals the shared numeric helpers read correctly.
func mysqlTreeNumber(text string) json.Number {
	value, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil {
		return ""
	}
	return json.Number(strconv.FormatFloat(value, 'f', -1, 64))
}

// mysqlTreeRootDuration is the wall time of the whole statement: the root
// step's last-row time over all of its loops.
func mysqlTreeRootDuration(nodes []connection.ExplainNode) float64 {
	if len(nodes) == 0 {
		return 0
	}
	return roundExplain(explainNodeTotalMs(nodes[0]), 3)
}

func removeExplainFlags(flags []string, remove ...string) []string {
	kept := flags[:0]
	for _, flag := range flags {
		drop := false
		for _, target := range remove {
			if flag == target {
				drop = true
				break
			}
		}
		if !drop {
			kept = append(kept, flag)
		}
	}
	return kept
}

func setExplainExtra(node *connection.ExplainNode, key string, value any) {
	if node.Extra == nil {
		node.Extra = map[string]any{}
	}
	node.Extra[key] = value
}
