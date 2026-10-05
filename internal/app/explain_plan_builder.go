package app

import "GoNavi-Wails/internal/connection"

// explainText 是执行计划解析器生成告警文案用的本地化函数（与 parseExplainRawWithText 的 text 一致）。
type explainText func(key string, params map[string]any) string

// indentedPlanBuilder 把按缩进表达层级的文本执行计划还原为节点树：新节点挂到缩进更小的最近节点下，
// 属性行写到最近一个节点上。CockroachDB 家族与 QuestDB 的文本计划共用。
type indentedPlanBuilder struct {
	result   *connection.ExplainResult
	stack    []indentedPlanFrame
	current  int
	classify func(operator string) string
}

type indentedPlanFrame struct {
	indent int
	nodeID string
}

func newIndentedPlanBuilder(result *connection.ExplainResult, classify func(operator string) string) *indentedPlanBuilder {
	return &indentedPlanBuilder{result: result, current: -1, classify: classify}
}

// addNode 追加一个算子节点并返回它（指针只在下一次 addNode 之前有效）。
func (b *indentedPlanBuilder) addNode(indent int, operator string) *connection.ExplainNode {
	for len(b.stack) > 0 && b.stack[len(b.stack)-1].indent >= indent {
		b.stack = b.stack[:len(b.stack)-1]
	}
	parentID := ""
	if len(b.stack) > 0 {
		parentID = b.stack[len(b.stack)-1].nodeID
	}
	node := connection.ExplainNode{
		OpType:   b.classify(operator),
		OpDetail: operator,
		Extra:    map[string]any{"operator": operator},
	}
	nodeID := appendExplainChild(b.result, parentID, node)
	b.stack = append(b.stack, indentedPlanFrame{indent: indent, nodeID: nodeID})
	b.current = len(b.result.Nodes) - 1
	return &b.result.Nodes[b.current]
}

// currentNode 返回最近追加的节点；还没有节点时返回 nil。
func (b *indentedPlanBuilder) currentNode() *connection.ExplainNode {
	if b.current < 0 {
		return nil
	}
	return &b.result.Nodes[b.current]
}
