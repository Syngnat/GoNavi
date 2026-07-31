package app

import (
	"encoding/json"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
)

// ClickHouse EXPLAIN 解析。
//
// ClickHouse 支持多种 EXPLAIN 模式：
//   - EXPLAIN（默认 PLAN 模式）：返回 1 行 1 列，列值是缩进文本树
//   - EXPLAIN PLAN json = 1：返回 1 行 1 列，列值是 JSON 字符串
//   - EXPLAIN AST：返回抽象语法树
//   - EXPLAIN SYNTAX：返回重写后的 SQL
//   - EXPLAIN PIPELINE：返回执行算子管道
//
// 本解析器只处理 JSON 模式（由 buildExplainQuery 选用）。
//
// JSON 结构（PLAN 模式）：
//
//	{
//	  "Plan": {
//	    "Node Type": "ReadFromMergeTree",
//	    "Plans": [],
//	    "ReadType": "Default",
//	    "Parts": 12,
//	    "Index Granules": 240,
//	    "Result Schema": {...}
//	  },
//	  "Plan": {
//	    "Node Type": "Aggregating",
//	    "Aggregation": {
//	      "Keys": ["user_id"],
//	      "Functions": ["count()"]
//	    }
//	  }
//	}
//
// 注意：CH EXPLAIN JSON 的顶层是 {"Plan": {...}}，但通过 collectExplainRaw 收集后，
// 单行单列的 JSON 文本可能被多次封装。本解析器直接处理 JSON 字符串。

func parseClickHouseExplain(sourceSQL, raw string, format connection.ExplainFormat) (connection.ExplainResult, error) {
	result := connection.ExplainResult{
		DBType:    "clickhouse",
		SourceSQL: sourceSQL,
	}

	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return result, fmt.Errorf("ClickHouse EXPLAIN 输出为空")
	}

	// ClickHouse EXPLAIN JSON 可能是对象或数组形式
	var top map[string]json.RawMessage
	var topArr []map[string]json.RawMessage

	isArr := strings.HasPrefix(trimmed, "[")
	if isArr {
		if err := json.Unmarshal([]byte(trimmed), &topArr); err != nil {
			return result, fmt.Errorf("ClickHouse JSON 数组解析失败：%w", err)
		}
	} else {
		if err := json.Unmarshal([]byte(trimmed), &top); err != nil {
			return result, fmt.Errorf("ClickHouse JSON 对象解析失败：%w", err)
		}
	}

	var warnings []string
	// 兼容两种形式
	plans := []map[string]json.RawMessage{}
	if isArr {
		plans = topArr
	} else {
		plans = append(plans, top)
	}

	for _, item := range plans {
		planRaw, ok := item["Plan"]
		if !ok {
			// CH 默认 EXPLAIN 模式可能不返回 Plan 而是直接给节点字段
			planRaw, ok = jsonMarshalRaw(item)
			if !ok {
				continue
			}
		}
		parseClickHousePlan(planRaw, "", &result, &warnings)
	}

	if len(result.Nodes) == 0 {
		result.RawFormat = connection.ExplainFormatText
		result.RawPayload = raw
		result.Warnings = append(warnings, "未提取到 ClickHouse 计划节点，可能不是 PLAN 模式")
		return result, nil
	}

	result.RawFormat = connection.ExplainFormatJSON
	result.RawPayload = raw
	result.Warnings = warnings
	finalizeExplainStats(&result)
	return result, nil
}

// clickHousePlanNode 映射 CH EXPLAIN JSON 的 Plan 结构。
type clickHousePlanNode struct {
	NodeType      string            `json:"Node Type"`
	Operation     string            `json:"Operation"`
	ReadType      string            `json:"ReadType"`
	Parts         int64             `json:"Parts"`
	IndexGranules int64             `json:"Index Granules"`
	SelectedMarks int64             `json:"Selected Marks"`
	ResultSchema  map[string]any    `json:"Result Schema"`
	Aggregation   map[string]any    `json:"Aggregation"`
	Join          map[string]any    `json:"Join"`
	Expression    map[string]any    `json:"Expression"`
	Indexes       json.RawMessage   `json:"Indexes"`
	Table         string            `json:"Table"`
	Database      string            `json:"Database"`
	JoinedPlans   []json.RawMessage `json:"Joined Plans"`
	Plans         []json.RawMessage `json:"Plans"`
	Children      []json.RawMessage `json:"Children"` // 部分版本用此字段
}

// parseClickHousePlan 递归解析 CH Plan 节点。
// CH 官方 json=1 输出使用 "Plans" 数组持有子节点。
func parseClickHousePlan(planRaw json.RawMessage, parentID string, result *connection.ExplainResult, warnings *[]string) {
	var node clickHousePlanNode
	if err := json.Unmarshal(planRaw, &node); err != nil {
		*warnings = append(*warnings, fmt.Sprintf("CH Plan 节点反序列化失败：%v", err))
		return
	}

	en := connection.ExplainNode{
		OpType:   classifyClickHouseNodeType(node.NodeType),
		OpDetail: node.NodeType,
	}
	if node.Operation != "" {
		en.OpDetail = en.OpDetail + " / " + node.Operation
	}

	// 表/库信息
	if node.Table != "" {
		if node.Database != "" {
			en.Table = node.Database + "." + node.Table
		} else {
			en.Table = node.Table
		}
	}

	// 行数估算：CH 没有"估算行数"概念，用 Parts × Index Granules 作为扫描量的粗略代理
	// 这是 CH 的特点：粒度（granule）是默认 8192 行，所以 granules × 8192 ≈ 扫描行数
	if node.Parts > 0 || node.IndexGranules > 0 {
		en.EstRows = node.IndexGranules * 8192
		en.Extra = map[string]any{
			"parts":         node.Parts,
			"indexGranules": node.IndexGranules,
			"selectedMarks": node.SelectedMarks,
		}
	}

	// Aggregation/Join 等元信息
	if len(node.Aggregation) > 0 {
		if en.Extra == nil {
			en.Extra = map[string]any{}
		}
		en.Extra["aggregation"] = node.Aggregation
		en.Flags = append(en.Flags, connection.ExplainFlagTempTable)
	}
	if len(node.Join) > 0 {
		if en.Extra == nil {
			en.Extra = map[string]any{}
		}
		en.Extra["join"] = node.Join
	}

	// indexes=1 时把索引裁剪详情保留下来。字段缺失代表服务端未提供证据，
	// 不能据此把正常的 MergeTree 读取误判成全扫或未使用索引。
	indexesReported := false
	var indexes []map[string]any
	if len(node.Indexes) > 0 && string(node.Indexes) != "null" {
		if err := json.Unmarshal(node.Indexes, &indexes); err != nil {
			*warnings = append(*warnings, fmt.Sprintf("CH Indexes 反序列化失败：%v", err))
		} else {
			indexesReported = true
			if en.Extra == nil {
				en.Extra = map[string]any{}
			}
			en.Extra["indexes"] = indexes
		}
	}

	// CH 的 ReadFromMergeTree 只有在服务端给出明确证据时才标记全扫/无索引。
	if strings.Contains(strings.ToLower(node.NodeType), "readfrommergetree") {
		// 旧版本的 ReadType=Default 表示未使用 primary key 裁剪；新版本在
		// indexes=1 下返回空 Indexes，同样能明确说明没有索引参与裁剪。
		if strings.EqualFold(node.ReadType, "default") || (indexesReported && len(indexes) == 0) {
			en.Flags = append(en.Flags, connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex)
		}
	}

	// Sort/OrderBy
	if strings.Contains(strings.ToLower(node.NodeType), "sorting") || strings.Contains(strings.ToLower(node.NodeType), "orderby") {
		en.Flags = append(en.Flags, connection.ExplainFlagFilesort)
	}

	nodeID := appendExplainChild(result, parentID, en)

	// 官方 json=1 使用 "Plans"；保留 Joined Plans/Children 兼容旧版本输出。
	for _, childRaw := range node.Plans {
		parseClickHousePlan(childRaw, nodeID, result, warnings)
	}
	for _, childRaw := range node.JoinedPlans {
		parseClickHousePlan(childRaw, nodeID, result, warnings)
	}
	for _, childRaw := range node.Children {
		parseClickHousePlan(childRaw, nodeID, result, warnings)
	}
}

// classifyClickHouseNodeType 把 CH Node Type 归一化到通用 OpType。
// 参考：https://clickhouse.com/docs/en/operations/explain
func classifyClickHouseNodeType(nodeType string) string {
	nt := strings.ToLower(strings.TrimSpace(nodeType))
	switch {
	case strings.Contains(nt, "readfrommergetree"), strings.Contains(nt, "readfromstorage"), strings.Contains(nt, "readfrom"):
		return connection.ExplainOpScan
	case strings.Contains(nt, "filter"):
		return connection.ExplainOpFilter
	case strings.Contains(nt, "aggregating"), strings.Contains(nt, "aggregatingtransform"):
		return connection.ExplainOpAggregate
	case strings.Contains(nt, "sorting"), strings.Contains(nt, "orderby"):
		return connection.ExplainOpSort
	case strings.Contains(nt, "limit"):
		return connection.ExplainOpLimit
	case strings.Contains(nt, "join"):
		return connection.ExplainOpJoin
	case strings.Contains(nt, "union"), strings.Contains(nt, "concat"):
		return connection.ExplainOpUnion
	case strings.Contains(nt, "expression"), strings.Contains(nt, "computescope"):
		return connection.ExplainOpOther
	case strings.Contains(nt, "creatingsets"), strings.Contains(nt, "creatingsetandfilter"):
		return connection.ExplainOpMaterialize
	case strings.Contains(nt, "window"):
		return connection.ExplainOpWindow
	default:
		return connection.ExplainOpOther
	}
}

// jsonMarshalRaw 把已解析的 map 重新序列化为 RawMessage（辅助工具）。
func jsonMarshalRaw(m map[string]json.RawMessage) (json.RawMessage, bool) {
	if len(m) == 0 {
		return nil, false
	}
	b, err := json.Marshal(m)
	if err != nil {
		return nil, false
	}
	return b, true
}
