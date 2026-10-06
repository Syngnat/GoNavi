package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// 规则引擎测试：验证各规则在合成 ExplainNode 上的触发与排序。

func TestRunExplainRules_FullScanLargeTableCritical(t *testing.T) {
	result := connection.ExplainResult{
		DBType:   "mysql",
		SourceSQL: "SELECT * FROM users",
		Nodes: []connection.ExplainNode{
			{
				ID:      "n1",
				OpType:  connection.ExplainOpScan,
				Table:   "users",
				EstRows: 100000,
				Flags:   []string{connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex},
			},
		},
	}
	suggestions := runExplainRules(result)
	if len(suggestions) == 0 {
		t.Fatal("全表扫描大表应触发建议")
	}
	top := suggestions[0]
	if top.Severity != connection.SeverityCritical {
		t.Fatalf("大表全表扫描应为 critical，got=%s", top.Severity)
	}
	if top.Rule != "full_scan_with_filter" && top.Rule != "full_scan_on_large_table" {
		t.Fatalf("首条建议应与全表扫描相关，got=%s", top.Rule)
	}
	if top.AffectedTable != "users" {
		t.Fatalf("AffectedTable got=%s want=users", top.AffectedTable)
	}
}

func TestRunExplainRules_FullScanSmallTableSuppressed(t *testing.T) {
	result := connection.ExplainResult{
		DBType:   "mysql",
		SourceSQL: "SELECT * FROM small_table",
		Nodes: []connection.ExplainNode{
			{
				ID:      "n1",
				OpType:  connection.ExplainOpScan,
				Table:   "small_table",
				EstRows: 100, // 远低于 1000 阈值
				Flags:   []string{connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex},
			},
		},
	}
	suggestions := runExplainRules(result)
	for _, s := range suggestions {
		if s.Rule == "full_scan_on_large_table" || s.Rule == "full_scan_with_filter" {
			t.Fatalf("小表（100 行）不应触发 full_scan 规则，got=%+v", s)
		}
	}
}

func TestRunExplainRules_FullScanWithFilterExtractsColumns(t *testing.T) {
	result := connection.ExplainResult{
		DBType:   "mysql",
		SourceSQL: "SELECT * FROM users WHERE email = 'x' AND status = 1",
		Nodes: []connection.ExplainNode{
			{
				ID:      "n1",
				OpType:  connection.ExplainOpScan,
				Table:   "users",
				EstRows: 10000,
				Flags:   []string{connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex},
				Extra:   map[string]any{"attachedCondition": "(email = 'x') AND (status = 1)"},
			},
		},
	}
	suggestions := runExplainRules(result)
	foundFilterRule := false
	for _, s := range suggestions {
		if s.Rule == "full_scan_with_filter" {
			foundFilterRule = true
			if !contains(s.Reason, "email") || !contains(s.Reason, "status") {
				t.Fatalf("Reason 应提及 email 和 status 列，got=%s", s.Reason)
			}
		}
	}
	if !foundFilterRule {
		t.Fatal("带 WHERE 的全表扫描应触发 full_scan_with_filter 规则")
	}
}

func TestRunExplainRules_FilesortOnLargeResult(t *testing.T) {
	result := connection.ExplainResult{
		DBType:   "postgres",
		SourceSQL: "SELECT * FROM t ORDER BY id",
		Nodes: []connection.ExplainNode{
			{
				ID:      "n1",
				OpType:  connection.ExplainOpSort,
				EstRows: 10000,
				Flags:   []string{connection.ExplainFlagFilesort},
			},
		},
	}
	suggestions := runExplainRules(result)
	found := false
	for _, s := range suggestions {
		if s.Rule == "filesort_on_large_result" {
			found = true
			if s.Severity != connection.SeverityWarning {
				t.Fatalf("filesort 应为 warning，got=%s", s.Severity)
			}
		}
	}
	if !found {
		t.Fatal("大结果集 filesort 应触发建议")
	}
}

func TestRunExplainRules_HighEstimationSkewRequiresAnalyze(t *testing.T) {
	result := connection.ExplainResult{
		DBType:   "postgres",
		SourceSQL: "SELECT * FROM t WHERE id > 0",
		Nodes: []connection.ExplainNode{
			{
				ID:         "n1",
				OpType:     connection.ExplainOpIndexScan,
				EstRows:    100,
				ActualRows: 50000, // 偏差 500 倍
			},
		},
	}
	suggestions := runExplainRules(result)
	found := false
	for _, s := range suggestions {
		if s.Rule == "high_estimation_skew" {
			found = true
			if s.Severity != connection.SeverityInfo {
				t.Fatalf("估算偏差应为 info，got=%s", s.Severity)
			}
		}
	}
	if !found {
		t.Fatal("估算/实际偏差 > 10x 应触发建议")
	}
}

func TestRunExplainRules_HighEstimationSkewFollowsMeasuredVerdict(t *testing.T) {
	result := connection.ExplainResult{
		DBType: "mysql",
		Nodes: []connection.ExplainNode{
			// 2300 rows expected 49478: a measured, flagged miss.
			{ID: "n1", OpType: connection.ExplainOpJoin, EstRows: 49478, ActualRows: 2300, Loops: 1},
			// 1 row expected per loop, 25 found: judged too small to matter.
			{ID: "n2", OpType: connection.ExplainOpIndexScan, EstRows: 1, ActualRows: 25, Loops: 1},
		},
	}
	annotateExplainActuals(&result)
	var reasons []string
	for _, s := range runExplainRules(result) {
		if s.Rule == "high_estimation_skew" {
			reasons = append(reasons, s.AffectedNodeID+": "+s.Reason)
		}
	}
	if len(reasons) != 1 || !strings.HasPrefix(reasons[0], "n1: ") || !strings.Contains(reasons[0], "相差约 22 倍") {
		t.Fatalf("skew advice = %q", reasons)
	}
}

func TestRunExplainRules_HighEstimationSkewAdvisesWhereTheMissStarts(t *testing.T) {
	result := connection.ExplainResult{
		DBType: "oracle",
		Nodes: []connection.ExplainNode{
			{ID: "n1", OpType: connection.ExplainOpJoin, EstRows: 1, ActualRows: 20000, Loops: 1},
			{ID: "n2", ParentID: "n1", OpType: connection.ExplainOpIndexScan, EstRows: 1, ActualRows: 20000, Loops: 1},
			{ID: "n3", ParentID: "n1", OpType: connection.ExplainOpScan, EstRows: 1, ActualRows: 2000, Loops: 1},
		},
	}
	annotateExplainActuals(&result)
	var nodes []string
	for _, s := range runExplainRules(result) {
		if s.Rule == "high_estimation_skew" {
			nodes = append(nodes, s.AffectedNodeID)
		}
	}
	// The join only inherits the scan's miss; both scans are where misses start.
	if strings.Join(nodes, ",") != "n2,n3" && strings.Join(nodes, ",") != "n3,n2" {
		t.Fatalf("skew advice on %v", nodes)
	}
}

func TestRunExplainRules_LowBufferHitRateGlobalRule(t *testing.T) {
	result := connection.ExplainResult{
		DBType:    "postgres",
		SourceSQL: "SELECT * FROM t",
		Stats: connection.ExplainStats{
			BufferHitRate: 0.2, // 20% 命中率
			RowsRead:      10000,
		},
	}
	suggestions := runExplainRules(result)
	found := false
	for _, s := range suggestions {
		if s.Rule == "low_buffer_hit_rate" {
			found = true
		}
	}
	if !found {
		t.Fatal("缓冲命中率 < 50% 应触发建议")
	}
}

func TestRunExplainRules_NestedLoopHighFanout(t *testing.T) {
	result := connection.ExplainResult{
		DBType:   "mysql",
		SourceSQL: "SELECT * FROM a JOIN b ON a.id = b.aid",
		Nodes: []connection.ExplainNode{
			{ID: "n1", OpType: connection.ExplainOpJoin, Table: ""},
			{ID: "n2", OpType: connection.ExplainOpScan, Table: "a", EstRows: 10},
			{ID: "n3", OpType: connection.ExplainOpScan, Table: "b", EstRows: 50000},
		},
		Edges: []connection.ExplainEdge{
			{From: "n1", To: "n2"},
			{From: "n1", To: "n3"},
		},
	}
	suggestions := runExplainRules(result)
	found := false
	for _, s := range suggestions {
		if s.Rule == "nested_loop_high_fanout" {
			found = true
		}
	}
	if !found {
		t.Fatal("Nested Loop 被驱动表 > 10000 行应触发 nested_loop_high_fanout")
	}
}

func TestRunExplainRules_SortBySeverity(t *testing.T) {
	result := connection.ExplainResult{
		DBType:   "mysql",
		SourceSQL: "SELECT * FROM t1 JOIN t2 ON t1.id = t2.id ORDER BY t1.name",
		Nodes: []connection.ExplainNode{
			{
				ID:      "n1",
				OpType:  connection.ExplainOpScan,
				Table:   "t1",
				EstRows: 50000,
				Flags:   []string{connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex},
			},
			{
				ID:      "n2",
				OpType:  connection.ExplainOpSort,
				EstRows: 100,
				Flags:   []string{connection.ExplainFlagFilesort},
			},
		},
	}
	suggestions := runExplainRules(result)
	if len(suggestions) < 2 {
		t.Fatalf("应触发至少 2 条建议，got=%d", len(suggestions))
	}
	// 第一条应是 critical（全表扫描）
	if suggestions[0].Severity != connection.SeverityCritical {
		t.Fatalf("首条建议应为 critical，got=%s（rule=%s）", suggestions[0].Severity, suggestions[0].Rule)
	}
}

func TestRunExplainRules_EmptyResultNoSuggestions(t *testing.T) {
	result := connection.ExplainResult{
		DBType:    "mysql",
		SourceSQL: "SELECT 1",
	}
	suggestions := runExplainRules(result)
	if len(suggestions) != 0 {
		t.Fatalf("空 ExplainResult 不应产生建议，got=%d", len(suggestions))
	}
}

// === 扩展规则测试 ===

func TestRunExplainRules_LikeLeadingWildcardCritical(t *testing.T) {
	result := connection.ExplainResult{
		DBType:   "mysql",
		SourceSQL: "SELECT * FROM users WHERE name LIKE '%john%'",
		Nodes: []connection.ExplainNode{
			{
				ID:      "n1",
				OpType:  connection.ExplainOpScan,
				Table:   "users",
				EstRows: 50000,
				Flags:   []string{connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex},
				Extra:   map[string]any{"attachedCondition": "name like '%john%'"},
			},
		},
	}
	suggestions := runExplainRules(result)
	found := false
	for _, s := range suggestions {
		if s.Rule == "like_leading_wildcard" {
			found = true
			if s.Severity != connection.SeverityCritical {
				t.Fatalf("LIKE 前缀通配应为 critical，got=%s", s.Severity)
			}
		}
	}
	if !found {
		t.Fatal("LIKE 前缀通配应触发 like_leading_wildcard 规则")
	}
}

func TestRunExplainRules_FunctionOnColumnCritical(t *testing.T) {
	result := connection.ExplainResult{
		DBType:   "mysql",
		SourceSQL: "SELECT * FROM users WHERE UPPER(name) = 'JOHN'",
		Nodes: []connection.ExplainNode{
			{
				ID:      "n1",
				OpType:  connection.ExplainOpScan,
				Table:   "users",
				EstRows: 20000,
				Flags:   []string{connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex},
				Extra:   map[string]any{"attachedCondition": "upper(name) = 'JOHN'"},
			},
		},
	}
	suggestions := runExplainRules(result)
	found := false
	for _, s := range suggestions {
		if s.Rule == "function_on_column" {
			found = true
			if s.Severity != connection.SeverityCritical {
				t.Fatalf("函数包裹列应为 critical，got=%s", s.Severity)
			}
		}
	}
	if !found {
		t.Fatal("函数包裹列应触发 function_on_column 规则")
	}
}

func TestRunExplainRules_OrConditionNoIndexWarning(t *testing.T) {
	result := connection.ExplainResult{
		DBType:   "mysql",
		SourceSQL: "SELECT * FROM users WHERE id = 1 OR name = 'x'",
		Nodes: []connection.ExplainNode{
			{
				ID:      "n1",
				OpType:  connection.ExplainOpScan,
				Table:   "users",
				EstRows: 10000,
				Flags:   []string{connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex},
				Extra:   map[string]any{"attachedCondition": "id = 1 or name = 'x'"},
			},
		},
	}
	suggestions := runExplainRules(result)
	found := false
	for _, s := range suggestions {
		if s.Rule == "or_condition_no_index" {
			found = true
		}
	}
	if !found {
		t.Fatal("全表扫描 + OR 条件应触发 or_condition_no_index 规则")
	}
}

func TestRunExplainRules_CartesianProductRiskCritical(t *testing.T) {
	result := connection.ExplainResult{
		DBType:   "mysql",
		SourceSQL: "SELECT * FROM a, b",
		Nodes: []connection.ExplainNode{
			{
				ID:      "n1",
				OpType:  connection.ExplainOpJoin,
				EstRows: 500000, // 远超阈值 100000
				Extra:   map[string]any{}, // 无 hashCond/joinType
			},
		},
	}
	suggestions := runExplainRules(result)
	found := false
	for _, s := range suggestions {
		if s.Rule == "cartesian_product_risk" {
			found = true
			if s.Severity != connection.SeverityCritical {
				t.Fatalf("笛卡尔积风险应为 critical，got=%s", s.Severity)
			}
		}
	}
	if !found {
		t.Fatal("无条件的 JOIN + 大估算应触发 cartesian_product_risk")
	}
}

func TestRunExplainRules_CartesianProductSuppressedWithCondition(t *testing.T) {
	result := connection.ExplainResult{
		DBType:   "mysql",
		SourceSQL: "SELECT * FROM a JOIN b ON a.id = b.aid",
		Nodes: []connection.ExplainNode{
			{
				ID:      "n1",
				OpType:  connection.ExplainOpJoin,
				EstRows: 500000,
				Extra:   map[string]any{"hashCond": "a.id = b.aid"}, // 有条件
			},
		},
	}
	suggestions := runExplainRules(result)
	for _, s := range suggestions {
		if s.Rule == "cartesian_product_risk" {
			t.Fatal("有 JOIN 条件时不应触发 cartesian_product_risk")
		}
	}
}

func TestRunExplainRules_FunctionOnColumnNotTriggeredForPlainColumn(t *testing.T) {
	// WHERE name = 'x' 不应触发 function_on_column
	result := connection.ExplainResult{
		DBType:   "mysql",
		SourceSQL: "SELECT * FROM users WHERE name = 'x'",
		Nodes: []connection.ExplainNode{
			{
				ID:      "n1",
				OpType:  connection.ExplainOpScan,
				Table:   "users",
				EstRows: 100,
				Flags:   []string{connection.ExplainFlagFullScan, connection.ExplainFlagNoIndex},
				Extra:   map[string]any{"attachedCondition": "name = 'x'"},
			},
		},
	}
	suggestions := runExplainRules(result)
	for _, s := range suggestions {
		if s.Rule == "function_on_column" {
			t.Fatalf("name = 'x' 不应触发 function_on_column，但触发了：%+v", s)
		}
	}
}

// contains 检查字符串包含（避免和 strings.Contains 冲突，这里独立实现）。
func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || indexOfContains(s, substr) >= 0)
}

func indexOfContains(s, substr string) int {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}
