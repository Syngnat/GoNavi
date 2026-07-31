package app

import (
	"encoding/json"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// PostgreSQL EXPLAIN (FORMAT JSON) 解析，同时兼容外部驱动返回的 ANALYZE/BUFFERS 字段。
//
// 典型结构（PG 13+）：
//
//	[
//	  {
//	    "Plan": {
//	      "Node Type": "Seq Scan",
//	      "Relation Name": "t",
//	      "Alias": "t",
//	      "Startup Cost": 0.00,
//	      "Total Cost": 100.00,
//	      "Plan Rows": 1000,
//	      "Plan Width": 4,
//	      "Actual Startup Time": 0.01,
//	      "Actual Total Time": 1.23,
//	      "Actual Rows": 1000,
//	      "Actual Loops": 1,
//	      "Filter": "(id > 100)",
//	      "Rows Removed by Filter": 100,
//	      "Shared Hit Blocks": 50,
//	      "Shared Read Blocks": 0,
//	      "Plans": [...]   // 递归子节点
//	    },
//	    "Planning Time": 0.15,
//	    "Execution Time": 1.30,
//	    "Triggers": [],
//	    "Execution Buffers": {...}
//	  }
//	]
//
// 多语句时数组可能有多个元素，但 EXPLAIN 单条 SQL 时通常是 1 个。

func parsePostgresExplain(dbType, sourceSQL, raw string, format connection.ExplainFormat) (connection.ExplainResult, error) {
	result := connection.ExplainResult{
		DBType:    dbType,
		SourceSQL: sourceSQL,
	}

	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return result, fmt.Errorf("PostgreSQL EXPLAIN 返回空内容")
	}

	if !strings.HasPrefix(trimmed, "[") && !strings.HasPrefix(trimmed, "{") {
		// 老版本 PG 无 FORMAT JSON 时返回文本表格——PR2 增强
		result.RawFormat = connection.ExplainFormatText
		result.RawPayload = raw
		result.Warnings = []string{"PostgreSQL 返回非 JSON 格式（可能未启用 FORMAT JSON），原文保留"}
		return result, nil
	}

	var top []map[string]json.RawMessage
	if err := json.Unmarshal([]byte(trimmed), &top); err != nil {
		// 单对象（无外层数组）兼容
		var single map[string]json.RawMessage
		if err2 := json.Unmarshal([]byte(trimmed), &single); err2 == nil {
			top = []map[string]json.RawMessage{single}
		} else {
			return result, fmt.Errorf("PostgreSQL JSON 解析失败：%w", err)
		}
	}

	if len(top) == 0 {
		return result, fmt.Errorf("PostgreSQL EXPLAIN 数组为空")
	}

	var warnings []string
	for _, item := range top {
		// 顶层 Execution Time / Planning Time
		if etRaw, ok := item["Execution Time"]; ok {
			var et float64
			if err := json.Unmarshal(etRaw, &et); err == nil {
				result.Stats.TotalDurationMs = et
			}
		}
		planRaw, ok := item["Plan"]
		if !ok {
			continue
		}
		parsePostgresPlanNode(planRaw, "", &result, &warnings)
	}

	result.RawFormat = connection.ExplainFormatJSON
	result.RawPayload = raw
	result.Warnings = warnings
	finalizeExplainStats(&result)
	return result, nil
}

// pgPlanNode 映射 PG FORMAT JSON 的 Plan 结构（部分字段，未识别字段保留在 raw 中备用）。
type pgPlanNode struct {
	NodeType       string          `json:"Node Type"`
	RelationName   string          `json:"Relation Name"`
	Alias          string          `json:"Alias"`
	Schema         string          `json:"Schema"`
	StartupCost    float64         `json:"Startup Cost"`
	TotalCost      float64         `json:"Total Cost"`
	PlanRows       json.Number     `json:"Plan Rows"`
	PlanWidth      json.Number     `json:"Plan Width"`
	ActualStartup  float64         `json:"Actual Startup Time"`
	ActualTotal    float64         `json:"Actual Total Time"`
	ActualRows     json.Number     `json:"Actual Rows"`
	ActualLoops    json.Number     `json:"Actual Loops"`
	IndexName      string          `json:"Index Name"`
	Filter         string          `json:"Filter"`
	HashCond       string          `json:"Hash Cond"`
	JoinType       string          `json:"Join Type"`
	Strategy       string          `json:"Strategy"`
	SharedHit      json.Number     `json:"Shared Hit Blocks"`
	SharedRead     json.Number     `json:"Shared Read Blocks"`
	Output         []string        `json:"Output"`
	Plans          []json.RawMessage `json:"Plans"`
}

// parsePostgresPlanNode 递归解析 PG Plan 节点。
func parsePostgresPlanNode(planRaw json.RawMessage, parentID string, result *connection.ExplainResult, warnings *[]string) {
	var node pgPlanNode
	if err := json.Unmarshal(planRaw, &node); err != nil {
		*warnings = append(*warnings, fmt.Sprintf("PG Plan 节点反序列化失败：%v", err))
		return
	}

	en := connection.ExplainNode{
		OpType:     classifyPostgresNodeType(node.NodeType, node.IndexName),
		OpDetail:   node.NodeType,
		Table:      pickPostgresTableName(node),
		Index:      node.IndexName,
		EstRows:    parseExplainInt64(string(node.PlanRows)),
		ActualRows: parseExplainInt64(string(node.ActualRows)),
		Loops:      parseExplainInt64(string(node.ActualLoops)),
		Cost:       node.StartupCost + node.TotalCost,
		DurationMs: node.ActualTotal,
	}
	if node.Strategy != "" {
		en.Extra = map[string]any{"strategy": node.Strategy}
	}
	if node.Filter != "" {
		if en.Extra == nil {
			en.Extra = map[string]any{}
		}
		en.Extra["filter"] = node.Filter
	}
	if node.HashCond != "" {
		if en.Extra == nil {
			en.Extra = map[string]any{}
		}
		en.Extra["hashCond"] = node.HashCond
	}
	if node.JoinType != "" {
		if en.Extra == nil {
			en.Extra = map[string]any{}
		}
		en.Extra["joinType"] = node.JoinType
	}

	// BufferHit 命中率：Shared Hit / (Shared Hit + Shared Read)
	hit := parseExplainInt64(string(node.SharedHit))
	read := parseExplainInt64(string(node.SharedRead))
	if hit+read > 0 {
		en.BufferHit = float64(hit) / float64(hit+read)
		if en.BufferHit < 0.5 {
			en.Flags = append(en.Flags, connection.ExplainFlagLowBufferHit)
		}
	}

	if en.OpType == connection.ExplainOpScan {
		en.Flags = append(en.Flags, connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex)
	}

	// Sort/Hash Join 等可能用临时表
	ntLower := strings.ToLower(node.NodeType)
	if strings.Contains(ntLower, "sort") {
		en.Flags = append(en.Flags, connection.ExplainFlagFilesort)
	}
	if strings.Contains(ntLower, "materialize") || strings.Contains(ntLower, "hash") {
		en.Flags = append(en.Flags, connection.ExplainFlagTempTable)
	}

	nodeID := appendExplainChild(result, parentID, en)
	for _, childRaw := range node.Plans {
		parsePostgresPlanNode(childRaw, nodeID, result, warnings)
	}
}

// classifyPostgresNodeType 把 PG Node Type 归一化到通用 OpType。
// 例如 Seq Scan → SCAN；Index Scan/Index Only Scan → INDEX_SCAN/INDEX_ONLY；
// Hash Join/Nested Loop/Merge Join → JOIN；Aggregate/GroupAggregate → AGGREGATE；Sort → SORT。
func classifyPostgresNodeType(nodeType, indexName string) string {
	nt := strings.ToLower(strings.TrimSpace(nodeType))
	switch {
	case strings.Contains(nt, "seq scan"):
		return connection.ExplainOpScan
	case strings.Contains(nt, "index only scan"):
		return connection.ExplainOpIndexOnly
	case strings.Contains(nt, "index scan"), strings.Contains(nt, "bitmap index"):
		return connection.ExplainOpIndexScan
	case strings.Contains(nt, "join"):
		return connection.ExplainOpJoin
	case strings.Contains(nt, "aggregate"), strings.Contains(nt, "group"):
		return connection.ExplainOpAggregate
	case strings.Contains(nt, "sort"):
		return connection.ExplainOpSort
	case strings.Contains(nt, "limit"):
		return connection.ExplainOpLimit
	case strings.Contains(nt, "subquery"), strings.Contains(nt, "subplan"):
		return connection.ExplainOpSubquery
	case strings.Contains(nt, "union"):
		return connection.ExplainOpUnion
	case strings.Contains(nt, "window"):
		return connection.ExplainOpWindow
	case strings.Contains(nt, "materialize"):
		return connection.ExplainOpMaterialize
	case strings.Contains(nt, "result"), strings.Contains(nt, "filter"):
		return connection.ExplainOpFilter
	default:
		return connection.ExplainOpOther
	}
}

// pickPostgresTableName 提取 PG Plan 中的表名（Schema.RelationName 或仅 RelationName）。
func pickPostgresTableName(node pgPlanNode) string {
	if node.RelationName == "" {
		return ""
	}
	if node.Schema != "" {
		return node.Schema + "." + node.RelationName
	}
	return node.RelationName
}
