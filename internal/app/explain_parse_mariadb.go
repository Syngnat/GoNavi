package app

import (
	"encoding/json"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// MariaDB EXPLAIN / ANALYZE FORMAT=JSON 解析。
//
// 结构与 MySQL 的 FORMAT=JSON 不同：表可以藏在 filesort、temporary_table、
// read_sorted_file、block-nl-join 等操作层里，行数字段是 rows（每次循环），
// 成本是每张表自己的 cost。ANALYZE 额外给出 r_loops、r_rows、r_filtered，
// 以及表的 r_table_time_ms + r_other_time_ms、操作层的 r_total_time_ms（都是所有循环合计）。
//
//	{"query_block": {"select_id": 1, "r_loops": 1, "r_total_time_ms": 24.0,
//	  "filesort": {"sort_key": "c.city", "r_total_time_ms": 0.01,
//	    "temporary_table": {"nested_loop": [{"table": {...}}, {"table": {...}}]}}}}

// mariaDBContainerKeys are walked in this order, which follows how MariaDB
// prints a block: the access first, then the operations wrapped around it.
var mariaDBContainerKeys = []string{
	"table", "nested_loop", "read_sorted_file", "block-nl-join", "filesort", "temporary_table",
	"duplicates_removal", "window_functions_computation", "union_result", "materialized",
	"expression_cache", "query_block", "subqueries", "query_specifications",
}

type mariaDBStep struct {
	SelectID          json.Number `json:"select_id"`
	TableName         string      `json:"table_name"`
	AccessType        string      `json:"access_type"`
	Key               string      `json:"key"`
	UsedKeyParts      []string    `json:"used_key_parts"`
	Rows              json.Number `json:"rows"`
	Cost              json.Number `json:"cost"`
	Filtered          json.Number `json:"filtered"`
	UsingIndex        bool        `json:"using_index"`
	AttachedCondition string      `json:"attached_condition"`
	HavingCondition   string      `json:"having_condition"`
	SortKey           string      `json:"sort_key"`
	RLoops            json.Number `json:"r_loops"`
	RRows             json.Number `json:"r_rows"`
	ROutputRows       json.Number `json:"r_output_rows"`
	RFiltered         json.Number `json:"r_filtered"`
	RTotalTimeMs      json.Number `json:"r_total_time_ms"`
	RTableTimeMs      json.Number `json:"r_table_time_ms"`
	ROtherTimeMs      json.Number `json:"r_other_time_ms"`
	Message           string      `json:"message"`
}

// isMariaDBExplainJSON tells MariaDB's JSON plan from MySQL's: MySQL always
// reports cost_info on the query block, MariaDB never does.
func isMariaDBExplainJSON(raw string) bool {
	var top map[string]json.RawMessage
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &top); err != nil {
		return false
	}
	var block map[string]json.RawMessage
	if err := json.Unmarshal(top["query_block"], &block); err != nil {
		return false
	}
	_, mysqlCost := block["cost_info"]
	return !mysqlCost
}

func parseMariaDBExplain(dbType, sourceSQL, raw string) (connection.ExplainResult, error) {
	result := connection.ExplainResult{
		DBType:     dbType,
		SourceSQL:  sourceSQL,
		RawFormat:  connection.ExplainFormatJSON,
		RawPayload: raw,
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal([]byte(strings.TrimSpace(raw)), &top); err != nil {
		return result, fmt.Errorf("MariaDB JSON 解析失败：%w", err)
	}
	blockRaw, ok := top["query_block"]
	if !ok {
		return result, fmt.Errorf("缺少 query_block 字段")
	}
	var block mariaDBStep
	if err := json.Unmarshal(blockRaw, &block); err != nil {
		return result, fmt.Errorf("query_block 解析失败：%w", err)
	}
	walker := mariaDBWalker{result: &result}
	walker.queryBlock(blockRaw, "")
	if len(result.Nodes) == 0 {
		return result, fmt.Errorf("MariaDB JSON 未解析出有效节点")
	}
	finalizeExplainStats(&result)
	result.Stats.TotalCost = parseExplainFloat64(block.Cost.String())
	if total := parseExplainFloat64(block.RTotalTimeMs.String()); total > 0 {
		result.Stats.TotalDurationMs = roundExplain(total, 3)
	}
	return result, nil
}

type mariaDBWalker struct {
	result *connection.ExplainResult
}

func (w mariaDBWalker) container(raw json.RawMessage, parentID string) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err == nil {
			for _, item := range items {
				w.container(item, parentID)
			}
		}
		return
	}
	for _, key := range mariaDBContainerKeys {
		value, ok := object[key]
		if !ok {
			continue
		}
		switch key {
		case "table":
			w.table(value, parentID)
		case "nested_loop":
			w.nestedLoop(value, parentID)
		case "filesort":
			w.operation(value, parentID, connection.ExplainOpSort, "filesort")
		case "temporary_table":
			w.operation(value, parentID, connection.ExplainOpMaterialize, "temporary table")
		case "duplicates_removal":
			w.operation(value, parentID, connection.ExplainOpOther, "duplicates removal")
		case "window_functions_computation":
			w.operation(value, parentID, connection.ExplainOpWindow, "window functions")
		case "union_result":
			w.operation(value, parentID, connection.ExplainOpUnion, "union")
		case "query_block":
			w.queryBlock(value, parentID)
		default:
			// read_sorted_file, block-nl-join, materialized, expression_cache,
			// subqueries, query_specifications only wrap what is inside them.
			w.container(value, parentID)
		}
	}
}

func (w mariaDBWalker) queryBlock(raw json.RawMessage, parentID string) {
	var step mariaDBStep
	if err := json.Unmarshal(raw, &step); err != nil {
		return
	}
	opType := connection.ExplainOpOther
	if parentID != "" {
		opType = connection.ExplainOpSubquery
	}
	node := connection.ExplainNode{
		OpType:   opType,
		OpDetail: strings.TrimSpace("SELECT #" + step.SelectID.String()),
	}
	// The block's cost is the sum of its tables' costs; keeping it off the
	// node stops the hotspot shares from counting it twice.
	applyMariaDBTiming(&node, step, step.RTotalTimeMs)
	if step.HavingCondition != "" {
		setExplainExtra(&node, "havingCondition", step.HavingCondition)
	}
	w.container(raw, appendExplainChild(w.result, parentID, node))
}

func (w mariaDBWalker) nestedLoop(raw json.RawMessage, parentID string) {
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return
	}
	if len(items) > 1 {
		parentID = appendExplainChild(w.result, parentID, connection.ExplainNode{
			OpType:   connection.ExplainOpJoin,
			OpDetail: "nested loop",
		})
	}
	for _, item := range items {
		w.container(item, parentID)
	}
}

func (w mariaDBWalker) operation(raw json.RawMessage, parentID, opType, label string) {
	var step mariaDBStep
	if err := json.Unmarshal(raw, &step); err != nil {
		// duplicates_removal may be a plain list of steps.
		w.container(raw, parentID)
		return
	}
	node := connection.ExplainNode{OpType: opType, OpDetail: label}
	if step.TableName != "" {
		setExplainExtra(&node, "internalTable", step.TableName)
	}
	applyMariaDBTiming(&node, step, step.RTotalTimeMs)
	if output := parseExplainFloat64(step.ROutputRows.String()); output > 0 && node.Loops > 0 {
		node.ActualRows = int64(output/float64(node.Loops) + 0.5)
	} else if node.Loops > 0 {
		node.ActualRows = parseExplainInt64(step.RRows.String())
	}
	if step.SortKey != "" {
		setExplainExtra(&node, "sortKey", step.SortKey)
	}
	switch opType {
	case connection.ExplainOpSort:
		node.Flags = append(node.Flags, connection.ExplainFlagFilesort)
	case connection.ExplainOpMaterialize:
		node.Flags = append(node.Flags, connection.ExplainFlagTempTable)
	}
	w.container(raw, appendExplainChild(w.result, parentID, node))
}

func (w mariaDBWalker) table(raw json.RawMessage, parentID string) {
	var step mariaDBStep
	if err := json.Unmarshal(raw, &step); err != nil {
		return
	}
	node := connection.ExplainNode{
		OpType:   classifyMySQLAccessType(step.AccessType),
		OpDetail: fmt.Sprintf("access_type=%s", strings.ToLower(strings.TrimSpace(step.AccessType))),
		Table:    step.TableName,
		Index:    step.Key,
		EstRows:  parseExplainInt64(step.Rows.String()),
		Cost:     parseExplainFloat64(step.Cost.String()),
	}
	if step.UsingIndex && node.OpType == connection.ExplainOpIndexScan {
		node.OpType = connection.ExplainOpIndexOnly
	}
	if strings.HasPrefix(step.TableName, "<") {
		// <derived2>, <subquery3>, <union1,2>: MariaDB's own intermediate result.
		node.Table = ""
		setExplainExtra(&node, "internalTable", step.TableName)
	} else if node.OpType == connection.ExplainOpScan {
		node.Flags = append(node.Flags, connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex)
	}
	tableTime := parseExplainFloat64(step.RTableTimeMs.String()) + parseExplainFloat64(step.ROtherTimeMs.String())
	applyMariaDBTiming(&node, step, json.Number(fmt.Sprintf("%g", tableTime)))
	if node.Loops > 0 {
		node.ActualRows = parseExplainInt64(step.RRows.String())
	}
	if step.AttachedCondition != "" {
		setExplainExtra(&node, "attachedCondition", step.AttachedCondition)
	}
	if len(step.UsedKeyParts) > 0 {
		setExplainExtra(&node, "usedKeyParts", step.UsedKeyParts)
	}
	if filtered := step.Filtered.String(); filtered != "" {
		setExplainExtra(&node, "filtered", parseExplainFloat64(filtered))
	}
	if filtered := step.RFiltered.String(); filtered != "" {
		setExplainExtra(&node, "actualFiltered", parseExplainFloat64(filtered))
	}
	if step.Message != "" {
		setExplainExtra(&node, "message", step.Message)
	}
	parentID = w.filter(step, node, parentID)
	w.container(raw, appendExplainChild(w.result, parentID, node))
}

// filter adds a Filter step above a table whose condition drops rows, the way
// MySQL's tree shows it: the table step then counts rows read, the filter step
// rows kept, and a wrong selectivity guess shows up as its own misestimate.
// It returns the parent the table step hangs under.
func (w mariaDBWalker) filter(step mariaDBStep, table connection.ExplainNode, parentID string) string {
	if step.AttachedCondition == "" {
		return parentID
	}
	estimated := parseExplainFloat64(step.Filtered.String())
	actual := parseExplainFloat64(step.RFiltered.String())
	measured := step.RFiltered.String() != "" && table.Loops > 0
	if !(estimated > 0 && estimated < 100) && !(measured && actual < 100) {
		return parentID
	}
	node := connection.ExplainNode{
		OpType:   connection.ExplainOpFilter,
		OpDetail: "filter",
		Loops:    table.Loops,
	}
	if estimated <= 0 {
		estimated = 100
	}
	node.EstRows = int64(float64(table.EstRows)*estimated/100 + 0.5)
	if measured {
		node.ActualRows = int64(float64(table.ActualRows)*actual/100 + 0.5)
	}
	setExplainExtra(&node, "condition", step.AttachedCondition)
	return appendExplainChild(w.result, parentID, node)
}

// applyMariaDBTiming converts MariaDB's time over all loops into the per-loop
// average every other dialect reports.
func applyMariaDBTiming(node *connection.ExplainNode, step mariaDBStep, totalMs json.Number) {
	loops := parseExplainInt64(step.RLoops.String())
	if loops <= 0 {
		return
	}
	node.Loops = loops
	if total := parseExplainFloat64(totalMs.String()); total > 0 {
		node.DurationMs = total / float64(loops)
	}
}
