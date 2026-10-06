package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// Captured from MySQL 8.4 EXPLAIN ANALYZE.
const mysqlTreeJoinSample = `-> Limit: 5 row(s)  (cost=3884 rows=1) (actual time=10.9..10.9 rows=1 loops=1)
    -> Group aggregate: sum(i.amount)  (cost=3884 rows=1) (actual time=10.9..10.9 rows=1 loops=1)
        -> Nested loop inner join  (cost=3550 rows=3341) (actual time=1.8..10.4 rows=4960 loops=1)
            -> Covering index lookup on c using idx_city (city='bj')  (cost=41.3 rows=400) (actual time=0.0126..0.114 rows=400 loops=1)
            -> Filter: (i.amount > 500.00)  (cost=6.27 rows=8.35) (actual time=0.0228..0.0249 rows=12.4 loops=400)
                -> Index lookup on i using idx_customer (customer_id=c.id)  (cost=6.27 rows=25.1) (actual time=0.0211..0.0228 rows=25 loops=400)
`

const mysqlTreeSubquerySample = `-> Append  (cost=0.1..987302 rows=9.87e+6) (actual time=9.34..10.7 rows=52 loops=1)
    -> Stream results  (cost=987302 rows=9.87e+6) (actual time=9.33..10.7 rows=51 loops=1)
        -> Nested loop inner join  (cost=987302 rows=9.87e+6) (actual time=9.29..10.3 rows=51 loops=1)
            -> Covering index scan on c using idx_city  (cost=202 rows=2000) (actual time=0.0242..0.351 rows=2000 loops=1)
            -> Single-row index lookup on <subquery3> using <auto_distinct_key> (customer_id=c.id)  (cost=5468..5468 rows=1) (actual time=0.00481..0.00481 rows=0.0255 loops=2000)
                -> Materialize with deduplication  (cost=5468..5468 rows=4935) (actual time=9.16..9.16 rows=51 loops=1)
                    -> Table scan on items  (cost=4975 rows=49345) (actual time=0.263..5.63 rows=50000 loops=1)
        -> Select #2 (subquery in projection; dependent)
            -> Aggregate: count(0)  (cost=5.27 rows=1) (actual time=0.00606..0.00611 rows=1 loops=51)
                -> Covering index lookup on i using idx_customer (customer_id=c.id)  (cost=2.76 rows=25.1) (never executed)
    -> Stream results  (cost=0..0 rows=1) (actual time=0.0057..0.00584 rows=1 loops=1)
        -> Rows fetched before execution  (cost=0..0 rows=1) (actual time=73e-6..126e-6 rows=1 loops=1)
`

func findExplainNode(t *testing.T, nodes []connection.ExplainNode, detailPrefix string) connection.ExplainNode {
	t.Helper()
	for _, node := range nodes {
		if strings.HasPrefix(node.OpDetail, detailPrefix) {
			return node
		}
	}
	t.Fatalf("no step %q in %+v", detailPrefix, nodes)
	return connection.ExplainNode{}
}

func TestParseMySQLTreeExplainBuildsMeasuredSteps(t *testing.T) {
	result, err := parseExplainRawWithText("mysql", "SELECT ...", mysqlTreeJoinSample, connection.ExplainFormatText, defaultExplainBackendText)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(result.Nodes) != 6 {
		t.Fatalf("want 6 steps, got %d: %+v", len(result.Nodes), result.Nodes)
	}
	root := result.Nodes[0]
	if root.ParentID != "" || root.OpType != connection.ExplainOpLimit || root.Cost != 3884 {
		t.Fatalf("root = %+v", root)
	}
	lookup := findExplainNode(t, result.Nodes, "Index lookup on i")
	filter := findExplainNode(t, result.Nodes, "Filter:")
	if lookup.ParentID != filter.ID || filter.ParentID != findExplainNode(t, result.Nodes, "Nested loop").ID {
		t.Fatalf("indentation not followed: lookup=%+v filter=%+v", lookup, filter)
	}
	if lookup.Table != "i" || lookup.Index != "idx_customer" || lookup.EstRows != 25 || lookup.ActualRows != 25 || lookup.Loops != 400 || lookup.DurationMs != 0.0228 {
		t.Fatalf("lookup step = %+v", lookup)
	}
	covering := findExplainNode(t, result.Nodes, "Covering index lookup")
	if covering.OpType != connection.ExplainOpIndexOnly || covering.Table != "c" || covering.Index != "idx_city" {
		t.Fatalf("covering step = %+v", covering)
	}
	if result.Stats.TotalDurationMs != 10.9 || result.Stats.TotalCost != 3884 {
		t.Fatalf("stats = %+v", result.Stats)
	}
}

func TestParseMySQLTreeExplainHandlesGroupingLinesAndInternalTables(t *testing.T) {
	result, err := parseMySQLTreeExplain("mysql", "SELECT ...", mysqlTreeSubquerySample)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	stream := findExplainNode(t, result.Nodes, "Stream results")
	label := findExplainNode(t, result.Nodes, "Select #2")
	if label.ParentID != stream.ID || label.Loops != 0 || label.DurationMs != 0 {
		t.Fatalf("grouping line should hang under its parent without metrics: %+v", label)
	}
	aggregate := findExplainNode(t, result.Nodes, "Aggregate: count(0)")
	if aggregate.ParentID != label.ID {
		t.Fatalf("subquery steps belong to the grouping line: %+v", aggregate)
	}
	never := findExplainNode(t, result.Nodes, "Covering index lookup on i")
	if never.Loops != 0 || never.Extra["neverExecuted"] != true {
		t.Fatalf("never executed step = %+v", never)
	}
	if top := result.Nodes[0]; top.EstRows != 9870000 || top.Cost != 987302 {
		t.Fatalf("exponent rows / ranged cost not read: %+v", top)
	}
	internal := findExplainNode(t, result.Nodes, "Single-row index lookup on <subquery3>")
	if internal.Table != "" || internal.Extra["internalTable"] != "<subquery3>" || hasFlag(internal.Flags, connection.ExplainFlagFullScan) {
		t.Fatalf("internal table step = %+v", internal)
	}
	scan := findExplainNode(t, result.Nodes, "Table scan on items")
	if scan.Table != "items" || !hasFlag(scan.Flags, connection.ExplainFlagFullScan) || scan.ActualRows != 50000 {
		t.Fatalf("scan step = %+v", scan)
	}
	fetched := findExplainNode(t, result.Nodes, "Rows fetched before execution")
	if fetched.DurationMs <= 0 || fetched.DurationMs > 0.001 {
		t.Fatalf("tiny exponent times not read: %+v", fetched)
	}
}

func TestParseMySQLTreeExplainSkipsInternalTemporaryScan(t *testing.T) {
	raw := "-> Table scan on <temporary>  (actual time=48.5..48.5 rows=5 loops=1)\n" +
		"    -> Aggregate using temporary table  (actual time=48.5..48.5 rows=5 loops=1)\n"
	result, err := parseMySQLTreeExplain("mysql", "SELECT ...", raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	scan := result.Nodes[0]
	if scan.Table != "" || scan.OpType == connection.ExplainOpScan || hasFlag(scan.Flags, connection.ExplainFlagFullScan) || !hasFlag(scan.Flags, connection.ExplainFlagTempTable) {
		t.Fatalf("reading MySQL's own temp table is not a full scan: %+v", scan)
	}
	if len(result.Nodes) != 2 || result.Nodes[1].ParentID != scan.ID {
		t.Fatalf("steps = %+v", result.Nodes)
	}
}

func TestParseExplainInt64ReadsExponentNotation(t *testing.T) {
	for input, want := range map[string]int64{"9.87e+6": 9870000, "74e-6": 0, "1.5E3": 1500, "12.9": 12, "400": 400} {
		if got := parseExplainInt64(input); got != want {
			t.Fatalf("parseExplainInt64(%q) = %d, want %d", input, got, want)
		}
	}
}
