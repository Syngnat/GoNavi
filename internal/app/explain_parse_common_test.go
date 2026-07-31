package app

import (
	"fmt"
	"sync"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// TestAppendExplainChildNumbersPerResult 覆盖节点 ID 的按解析隔离。
//
// 回归背景：节点 ID 原先由包级全局计数器 explainNodeIDCounter 生成，每个方言解析器在入口
// 调用 resetExplainNodeID() 归零。DiagnoseQuery 是 Wails 绑定方法，每个前端调用都在独立
// goroutine 中派发，两次并发诊断会互相踩踏该计数器，导致同一份 ExplainResult 内出现重复
// node ID、Edges 的 From/To 指向歧义节点、前端计划图渲染错乱。
func TestAppendExplainChildNumbersPerResult(t *testing.T) {
	var first connection.ExplainResult
	rootID := appendExplainChild(&first, "", connection.ExplainNode{OpDetail: "root"})
	childID := appendExplainChild(&first, rootID, connection.ExplainNode{OpDetail: "child"})
	grandID := appendExplainChild(&first, childID, connection.ExplainNode{OpDetail: "grand"})

	if rootID != "n1" || childID != "n2" || grandID != "n3" {
		t.Fatalf("编号序列 = %s/%s/%s，期望 n1/n2/n3", rootID, childID, grandID)
	}

	// 另一份 result 必须从 n1 重新开始，不受前一份影响。
	var second connection.ExplainResult
	if got := appendExplainChild(&second, "", connection.ExplainNode{OpDetail: "root"}); got != "n1" {
		t.Fatalf("第二份 result 的首个节点 ID = %s，期望 n1（编号未按 result 隔离）", got)
	}

	// Edge 必须指向正确的父子节点。
	if len(first.Edges) != 2 {
		t.Fatalf("Edges 数量 = %d，期望 2", len(first.Edges))
	}
	if first.Edges[0].From != "n1" || first.Edges[0].To != "n2" {
		t.Errorf("Edges[0] = %s→%s，期望 n1→n2", first.Edges[0].From, first.Edges[0].To)
	}
	if first.Edges[1].From != "n2" || first.Edges[1].To != "n3" {
		t.Errorf("Edges[1] = %s→%s，期望 n2→n3", first.Edges[1].From, first.Edges[1].To)
	}
}

// TestAppendExplainChildConcurrentResultsHaveUniqueIDs 并发构建多份 ExplainResult，
// 断言每份内部的节点 ID 都不重复——这是原全局计数器方案会失败的场景。
func TestAppendExplainChildConcurrentResultsHaveUniqueIDs(t *testing.T) {
	const parsers = 8
	const nodesPerParser = 60

	results := make([]connection.ExplainResult, parsers)
	var wg sync.WaitGroup
	wg.Add(parsers)
	for i := 0; i < parsers; i++ {
		go func(idx int) {
			defer wg.Done()
			parentID := appendExplainChild(&results[idx], "", connection.ExplainNode{OpDetail: "root"})
			for n := 1; n < nodesPerParser; n++ {
				parentID = appendExplainChild(&results[idx], parentID, connection.ExplainNode{
					OpDetail: fmt.Sprintf("node-%d", n),
				})
			}
		}(i)
	}
	wg.Wait()

	for idx := range results {
		seen := make(map[string]int, nodesPerParser)
		for _, node := range results[idx].Nodes {
			seen[node.ID]++
			if seen[node.ID] > 1 {
				t.Fatalf("result[%d] 出现重复节点 ID %s（并发解析互相踩踏编号）", idx, node.ID)
			}
		}
		if len(results[idx].Nodes) != nodesPerParser {
			t.Errorf("result[%d] 节点数 = %d，期望 %d", idx, len(results[idx].Nodes), nodesPerParser)
		}
		// 每个 Edge 的两端都必须存在于本 result 的节点集合内。
		for _, edge := range results[idx].Edges {
			if _, ok := seen[edge.From]; !ok {
				t.Errorf("result[%d] Edge.From=%s 不存在于本 result 节点集合", idx, edge.From)
			}
			if _, ok := seen[edge.To]; !ok {
				t.Errorf("result[%d] Edge.To=%s 不存在于本 result 节点集合", idx, edge.To)
			}
		}
	}
}

// TestAppendExplainChildKeepsPresetNodeID 保证显式指定的 ID 不被覆盖。
func TestAppendExplainChildKeepsPresetNodeID(t *testing.T) {
	var result connection.ExplainResult
	if got := appendExplainChild(&result, "", connection.ExplainNode{ID: "custom", OpDetail: "root"}); got != "custom" {
		t.Fatalf("预设 ID 被覆盖为 %s", got)
	}
}
