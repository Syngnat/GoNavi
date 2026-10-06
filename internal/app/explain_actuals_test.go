package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestAnnotateExplainEstimateFlagsOnlyLargeMisses(t *testing.T) {
	cases := []struct {
		name   string
		node   connection.ExplainNode
		factor float64
		flag   bool
	}{
		{"under estimated", connection.ExplainNode{EstRows: 55, ActualRows: 1050, Loops: 1}, 1050.0 / 55, true},
		{"over estimated", connection.ExplainNode{EstRows: 20244, ActualRows: 920, Loops: 1}, 920.0 / 20244, true},
		{"close enough", connection.ExplainNode{EstRows: 6667, ActualRows: 920, Loops: 1}, 920.0 / 6667, false},
		// 1 row expected, 25 found: a large ratio over too few rows to matter...
		{"tiny volume", connection.ExplainNode{EstRows: 1, ActualRows: 25, Loops: 1}, 25, false},
		// ...unless the step runs often enough for it to add up.
		{"repeated tiny miss", connection.ExplainNode{EstRows: 1, ActualRows: 25, Loops: 400}, 25, true},
		// Under one row per loop counts as one: "0 of 1" is not a misestimate.
		{"fractional rows", connection.ExplainNode{EstRows: 1, ActualRows: 0, Loops: 2000}, 1, false},
	}
	for _, tc := range cases {
		node := tc.node
		annotateExplainEstimate(&node)
		if node.EstimateFactor != tc.factor || hasFlag(node.Flags, connection.ExplainFlagUccWarn) != tc.flag {
			t.Fatalf("%s: factor=%v flags=%v, want factor=%v flag=%t", tc.name, node.EstimateFactor, node.Flags, tc.factor, tc.flag)
		}
	}
	never := connection.ExplainNode{EstRows: 100}
	annotateExplainEstimate(&never)
	if never.EstimateFactor != 0 || len(never.Flags) != 0 {
		t.Fatalf("a step that never ran has nothing to compare: %+v", never)
	}
}

func TestAnnotateExplainActualsMarksStepsThatNeverRan(t *testing.T) {
	result := connection.ExplainResult{Nodes: []connection.ExplainNode{
		{ID: "n1", DurationMs: 1, Loops: 1, EstRows: 10},
		{ID: "n2", ParentID: "n1", EstRows: 5, Cost: 3},
		{ID: "n3", ParentID: "n1", OpDetail: "nested loop"},
		{ID: "n4", ParentID: "n1", Loops: 2, EstRows: 5},
	}}
	annotateExplainActuals(&result)
	for _, node := range result.Nodes {
		if got := node.Extra["neverExecuted"] == true; got != (node.ID == "n2") {
			t.Fatalf("%s neverExecuted=%t: %+v", node.ID, got, node)
		}
	}
}

func TestAnnotateExplainActualsAttributesSelfTime(t *testing.T) {
	result := connection.ExplainResult{Nodes: []connection.ExplainNode{
		{ID: "n1", DurationMs: 10, Loops: 1, Cost: 100},
		{ID: "n2", ParentID: "n1", DurationMs: 2, Loops: 1, Cost: 90},
		// A grouping line without time: its child's time is not n1's own.
		{ID: "n3", ParentID: "n1"},
		{ID: "n4", ParentID: "n3", DurationMs: 0.01, Loops: 400},
	}}
	annotateExplainHotspots(&result, true)
	annotateExplainActuals(&result)
	if !result.Analyzed || result.HotspotBasis != explainHotspotBasisTime {
		t.Fatalf("analyzed=%t basis=%q", result.Analyzed, result.HotspotBasis)
	}
	// n1 own time: 10 - 2 - (0.01 * 400) = 4; total self time 4 + 2 + 4 = 10.
	want := map[string]float64{"n1": 0.4, "n2": 0.2, "n3": 0, "n4": 0.4}
	for _, node := range result.Nodes {
		if node.CostShare != want[node.ID] {
			t.Fatalf("%s share = %v, want %v (%+v)", node.ID, node.CostShare, want[node.ID], result.Nodes)
		}
	}
	if !hasFlag(result.Nodes[0].Flags, connection.ExplainFlagHighCost) || hasFlag(result.Nodes[1].Flags, connection.ExplainFlagHighCost) {
		t.Fatalf("time hotspots must replace the cost ones: %+v", result.Nodes)
	}
}

func TestAnnotateExplainActualsKeepsCostBasisWithoutTimings(t *testing.T) {
	result := connection.ExplainResult{Nodes: []connection.ExplainNode{
		{ID: "n1", Cost: 100, EstRows: 10, ActualRows: 10, Loops: 1},
		{ID: "n2", ParentID: "n1", Cost: 60, EstRows: 10, ActualRows: 10, Loops: 1},
	}}
	annotateExplainHotspots(&result, true)
	annotateExplainActuals(&result)
	if result.HotspotBasis != explainHotspotBasisCost || result.Nodes[1].CostShare != 0.6 {
		t.Fatalf("basis=%q nodes=%+v", result.HotspotBasis, result.Nodes)
	}
}
