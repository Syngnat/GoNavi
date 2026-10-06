package app

import (
	"math"
	"slices"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func explainNodeByID(result connection.ExplainResult, id string) connection.ExplainNode {
	for _, node := range result.Nodes {
		if node.ID == id {
			return node
		}
	}
	return connection.ExplainNode{}
}

func TestAnnotateExplainHotspotsSubtractsChildrenFromCumulativeCost(t *testing.T) {
	t.Parallel()

	// Hash Join (100) over Seq Scan orders (70) and Hash (20) over Seq Scan users (18).
	result := connection.ExplainResult{Nodes: []connection.ExplainNode{
		{ID: "n1", OpType: connection.ExplainOpJoin, Cost: 100},
		{ID: "n2", ParentID: "n1", OpType: connection.ExplainOpScan, Table: "orders", Cost: 70},
		{ID: "n3", ParentID: "n1", OpType: connection.ExplainOpOther, Cost: 20},
		{ID: "n4", ParentID: "n3", OpType: connection.ExplainOpScan, Table: "users", Cost: 18},
	}, Stats: connection.ExplainStats{TotalCost: 208}}

	annotateExplainHotspots(&result, true)

	want := map[string]float64{"n1": 0.1, "n2": 0.7, "n3": 0.02, "n4": 0.18}
	for id, share := range want {
		if got := explainNodeByID(result, id).CostShare; math.Abs(got-share) > 1e-9 {
			t.Fatalf("%s share = %v, want %v", id, got, share)
		}
	}
	if result.HotspotBasis != explainHotspotBasisCost {
		t.Fatalf("basis = %q", result.HotspotBasis)
	}
	// Summing cumulative costs counted the scans twice; the plan costs 100.
	if result.Stats.TotalCost != 100 {
		t.Fatalf("total cost = %v, want the root cost 100", result.Stats.TotalCost)
	}
	if !slices.Contains(explainNodeByID(result, "n2").Flags, connection.ExplainFlagHighCost) {
		t.Fatal("the dominant scan must be flagged HIGH_COST")
	}
	for _, id := range []string{"n1", "n3", "n4"} {
		if slices.Contains(explainNodeByID(result, id).Flags, connection.ExplainFlagHighCost) {
			t.Fatalf("%s must not be flagged", id)
		}
	}
}

func TestAnnotateExplainHotspotsUsesPerNodeCostAsIs(t *testing.T) {
	t.Parallel()

	// MySQL classic JSON: read_cost per table, structural nodes without cost.
	result := connection.ExplainResult{Nodes: []connection.ExplainNode{
		{ID: "n1", OpType: connection.ExplainOpJoin},
		{ID: "n2", ParentID: "n1", OpType: connection.ExplainOpScan, Cost: 30},
		{ID: "n3", ParentID: "n1", OpType: connection.ExplainOpIndexScan, Cost: 10},
	}, Stats: connection.ExplainStats{TotalCost: 52.5}}

	annotateExplainHotspots(&result, false)

	if got := explainNodeByID(result, "n2").CostShare; got != 0.75 {
		t.Fatalf("scan share = %v", got)
	}
	if explainNodeByID(result, "n1").CostShare != 0 {
		t.Fatal("a step without its own cost has no share")
	}
	if result.Stats.TotalCost != 52.5 {
		t.Fatalf("the parser's query cost must be kept, got %v", result.Stats.TotalCost)
	}
}

func TestAnnotateExplainHotspotsReadsMySQLTreeCostsFromExtras(t *testing.T) {
	t.Parallel()

	result := connection.ExplainResult{Nodes: []connection.ExplainNode{
		{ID: "n1", OpType: connection.ExplainOpSort, Cost: 50},
		{ID: "n2", ParentID: "n1", OpType: connection.ExplainOpScan, Extra: map[string]any{"estimatedTotalCost": 45.0}},
	}, Stats: connection.ExplainStats{TotalCost: 50}}

	annotateExplainHotspots(&result, false)

	if got := explainNodeByID(result, "n2").CostShare; got != 0.9 {
		t.Fatalf("the v2 tree is cumulative: scan share = %v, want 0.9", got)
	}
	if result.Stats.TotalCost != 50 {
		t.Fatalf("total cost = %v", result.Stats.TotalCost)
	}
}

func TestAnnotateExplainHotspotsFallsBackToRowsRead(t *testing.T) {
	t.Parallel()

	result := connection.ExplainResult{Nodes: []connection.ExplainNode{
		{ID: "n1", OpType: connection.ExplainOpJoin, EstRows: 10},
		{ID: "n2", ParentID: "n1", OpType: connection.ExplainOpScan, EstRows: 9000},
		{ID: "n3", ParentID: "n1", OpType: connection.ExplainOpIndexScan, EstRows: 1000},
	}}

	annotateExplainHotspots(&result, false)

	if result.HotspotBasis != explainHotspotBasisRows {
		t.Fatalf("basis = %q", result.HotspotBasis)
	}
	if got := explainNodeByID(result, "n2").CostShare; got != 0.9 {
		t.Fatalf("scan share = %v", got)
	}
	if explainNodeByID(result, "n1").CostShare != 0 {
		t.Fatal("only access steps read rows")
	}
}

func TestAnnotateExplainHotspotsLeavesPlansWithoutSignalAlone(t *testing.T) {
	t.Parallel()

	result := connection.ExplainResult{Nodes: []connection.ExplainNode{{ID: "n1", OpType: connection.ExplainOpOther}}}
	annotateExplainHotspots(&result, true)
	if result.HotspotBasis != "" || result.Nodes[0].CostShare != 0 || len(result.Nodes[0].Flags) != 0 {
		t.Fatalf("result = %+v", result)
	}
}

func TestPostgresPlanCostIsTotalCostAndHotspotsAreAnnotated(t *testing.T) {
	t.Parallel()

	raw := `[{"Plan": {"Node Type": "Hash Join", "Startup Cost": 5.0, "Total Cost": 100.0, "Plan Rows": 10,
		"Plans": [
			{"Node Type": "Seq Scan", "Relation Name": "orders", "Startup Cost": 0.0, "Total Cost": 80.0, "Plan Rows": 5000},
			{"Node Type": "Hash", "Startup Cost": 2.0, "Total Cost": 2.0, "Plan Rows": 20,
				"Plans": [{"Node Type": "Index Scan", "Relation Name": "users", "Index Name": "users_pkey", "Startup Cost": 0.0, "Total Cost": 2.0, "Plan Rows": 20}]}
		]}}]`
	result, err := parseExplainRaw("postgres", "SELECT 1", raw, connection.ExplainFormatJSON)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	root := result.Nodes[0]
	if root.Cost != 100 || root.Extra["startupCost"] != 5.0 {
		t.Fatalf("root cost = %v extra = %v; Total Cost already includes startup", root.Cost, root.Extra)
	}
	if result.Stats.TotalCost != 100 {
		t.Fatalf("total cost = %v, want 100", result.Stats.TotalCost)
	}
	scan := result.Nodes[1]
	if scan.Table != "orders" || scan.CostShare != 0.8 || !slices.Contains(scan.Flags, connection.ExplainFlagHighCost) {
		t.Fatalf("scan = %+v", scan)
	}
}

func TestMySQLTableNodeKeepsRowsProducedPerJoin(t *testing.T) {
	t.Parallel()

	node := buildMySQLTableNode(&mysqlTableNode{
		TableName:           "customers",
		AccessType:          "eq_ref",
		Key:                 "PRIMARY",
		RowsExaminedPerScan: "1",
		RowsProducedPerJoin: "600",
	})
	if node.EstRows != 1 || node.Extra["rowsProduced"] != int64(600) {
		t.Fatalf("node = %+v; the edge must carry the 600 rows produced, not the 1 row per lookup", node)
	}
}
