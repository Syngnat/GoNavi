package app

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

// Captured from MariaDB 11.4 ANALYZE FORMAT=JSON.
const mariaDBAnalyzeGroupSample = `{
  "query_optimization": {"r_total_time_ms": 0.09605179},
  "query_block": {
    "select_id": 1, "cost": 85.96082127, "r_loops": 1, "r_total_time_ms": 24.04746924,
    "filesort": {
      "sort_key": "c.city", "r_loops": 1, "r_total_time_ms": 0.012827343, "r_output_rows": 5,
      "temporary_table": {
        "nested_loop": [
          {"table": {"table_name": "i", "access_type": "index", "key": "idx_customer", "used_key_parts": ["customer_id"],
            "loops": 1, "r_loops": 1, "rows": 50220, "r_rows": 50000, "cost": 7.40393942,
            "r_table_time_ms": 5.54290706, "r_other_time_ms": 16.15849503, "filtered": 100, "r_filtered": 100, "using_index": true}},
          {"table": {"table_name": "c", "access_type": "eq_ref", "key": "PRIMARY", "used_key_parts": ["id"],
            "loops": 50220, "r_loops": 50000, "rows": 1, "r_rows": 1, "cost": 44.923692,
            "r_table_time_ms": 1.632106186, "r_other_time_ms": 0.681933251, "filtered": 100, "r_filtered": 100,
            "attached_condition": "i.customer_id + 0 = c.id"}}
        ]
      }
    }
  }
}`

const mariaDBAnalyzeFilterSample = `{
  "query_block": {
    "select_id": 1, "cost": 8.3334828, "r_loops": 1, "r_total_time_ms": 11.55576764,
    "nested_loop": [
      {"read_sorted_file": {"r_rows": 10,
        "filesort": {"sort_key": "items.created_at", "r_loops": 1, "r_total_time_ms": 11.51917051, "r_limit": 10, "r_output_rows": 11,
          "table": {"table_name": "items", "access_type": "ALL", "loops": 1, "r_loops": 1, "rows": 50220, "r_rows": 50000,
            "cost": 8.3334828, "r_table_time_ms": 6.33357996, "r_other_time_ms": 5.203504972,
            "filtered": 100, "r_filtered": 4.6, "attached_condition": "items.amount * 2 > 1900"}}}}
    ]
  }
}`

// Plain EXPLAIN FORMAT=JSON of the query above: no r_* fields at all.
const mariaDBExplainFilterSample = `{
  "query_block": {
    "select_id": 1, "cost": 8.3334828,
    "nested_loop": [
      {"read_sorted_file": {
        "filesort": {"sort_key": "items.created_at",
          "table": {"table_name": "items", "access_type": "ALL", "loops": 1, "rows": 50220, "cost": 8.3334828,
            "filtered": 100, "attached_condition": "items.amount * 2 > 1900"}}}}
    ]
  }
}`

func TestParseMariaDBExplainWalksOperationLayers(t *testing.T) {
	result, err := parseExplainRawWithText("mariadb", "SELECT ...", mariaDBAnalyzeGroupSample, connection.ExplainFormatJSON, defaultExplainBackendText)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	annotateExplainActuals(&result)
	block := result.Nodes[0]
	sort := findExplainNode(t, result.Nodes, "filesort")
	temp := findExplainNode(t, result.Nodes, "temporary table")
	join := findExplainNode(t, result.Nodes, "nested loop")
	if sort.ParentID != block.ID || temp.ParentID != sort.ID || join.ParentID != temp.ID {
		t.Fatalf("operation layers not nested: %+v", result.Nodes)
	}
	var customers connection.ExplainNode
	for _, node := range result.Nodes {
		if node.Table == "c" {
			customers = node
		}
	}
	if customers.ParentID != join.ID || customers.Loops != 50000 || customers.ActualRows != 1 || customers.EstRows != 1 {
		t.Fatalf("customers step = %+v", customers)
	}
	// MariaDB reports time over all loops; steps carry the per-loop average.
	if got := explainNodeTotalMs(customers); got < 2.31 || got > 2.32 {
		t.Fatalf("customers total time = %v", got)
	}
	if !result.Analyzed || result.HotspotBasis != explainHotspotBasisTime || result.Stats.TotalDurationMs != 24.047 {
		t.Fatalf("analyzed=%t basis=%q stats=%+v", result.Analyzed, result.HotspotBasis, result.Stats)
	}
	if sort.ActualRows != 5 || !hasFlag(sort.Flags, connection.ExplainFlagFilesort) || !hasFlag(temp.Flags, connection.ExplainFlagTempTable) {
		t.Fatalf("sort=%+v temp=%+v", sort, temp)
	}
}

func TestParseMariaDBExplainAddsFilterStepForMisjudgedSelectivity(t *testing.T) {
	result, err := parseMariaDBExplain("mariadb", "SELECT ...", mariaDBAnalyzeFilterSample)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	annotateExplainActuals(&result)
	filter := findExplainNode(t, result.Nodes, "filter")
	scan := findExplainNode(t, result.Nodes, "access_type=all")
	if scan.ParentID != filter.ID || filter.ParentID != findExplainNode(t, result.Nodes, "filesort").ID {
		t.Fatalf("filter step should sit between the sort and the scan: %+v", result.Nodes)
	}
	if filter.EstRows != 50220 || filter.ActualRows != 2300 || filter.Extra["condition"] != "items.amount * 2 > 1900" {
		t.Fatalf("filter step = %+v", filter)
	}
	if !hasFlag(filter.Flags, connection.ExplainFlagUccWarn) || hasFlag(scan.Flags, connection.ExplainFlagUccWarn) {
		t.Fatalf("the selectivity guess is wrong, the row count read is not: filter=%+v scan=%+v", filter, scan)
	}
	if scan.Extra["attachedCondition"] == nil || !hasFlag(scan.Flags, connection.ExplainFlagFullScan) {
		t.Fatalf("index advice still needs the scan's condition: %+v", scan)
	}
}

func TestParseMariaDBExplainReadsEstimatedPlansInsideSortLayers(t *testing.T) {
	result, err := parseExplainRawWithText("mariadb", "SELECT ...", mariaDBExplainFilterSample, connection.ExplainFormatJSON, defaultExplainBackendText)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	scan := findExplainNode(t, result.Nodes, "access_type=all")
	if scan.Table != "items" || scan.EstRows != 50220 || scan.Loops != 0 || result.Analyzed {
		t.Fatalf("estimated scan = %+v analyzed=%t", scan, result.Analyzed)
	}
	for _, node := range result.Nodes {
		if node.OpType == connection.ExplainOpFilter {
			t.Fatalf("a filter believed to keep every row adds no step: %+v", result.Nodes)
		}
	}
	if suggestions := runExplainRules(result); len(suggestions) == 0 {
		t.Fatalf("the full scan with a condition should still produce index advice")
	}
}

func TestIsMariaDBExplainJSONTellsDialectsApart(t *testing.T) {
	if !isMariaDBExplainJSON(mariaDBExplainFilterSample) {
		t.Fatalf("MariaDB plan not recognised")
	}
	mysql := `{"query_block": {"select_id": 1, "cost_info": {"query_cost": "1.00"}, "table": {"table_name": "t"}}}`
	if isMariaDBExplainJSON(mysql) || isMariaDBExplainJSON("[]") || isMariaDBExplainJSON("-> Limit") {
		t.Fatalf("MySQL or non-JSON plans must stay on their own parsers")
	}
}
