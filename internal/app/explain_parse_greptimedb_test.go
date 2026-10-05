package app

import (
	"slices"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// 取自 GreptimeDB 1.2.1：EXPLAIN SELECT host, avg(cpu) FROM monitor WHERE idc = 'bj' GROUP BY host ORDER BY host
// （collectExplainRaw 把多行单元格原样写进原文）。
const greptimeDBPlanFixture = "plan_type\tplan\n" +
	"logical_plan\tMergeScan [is_placeholder=false, remote_input=[\n" +
	"Sort: monitor.host ASC NULLS LAST\n" +
	"  Projection: monitor.host, avg(monitor.cpu)\n" +
	"    Aggregate: groupBy=[[monitor.host]], aggr=[[avg(monitor.cpu)]]\n" +
	"      Filter: monitor.idc = Utf8(\"bj\")\n" +
	"        TableScan: monitor, partial_filters=[monitor.idc = Utf8(\"bj\")]\n" +
	"]]\n" +
	"physical_plan\tCooperativeExec\n" +
	"  MergeScanExec: peers=[4398046511104(1024, 0), ]\n"

func TestParseGreptimeDBExplainUsesLogicalPlan(t *testing.T) {
	result := parseGreptimeDBExplain("greptimedb", "SELECT ...", greptimeDBPlanFixture, defaultExplainBackendText)
	if len(result.Warnings) > 0 || len(result.Nodes) != 5 {
		t.Fatalf("nodes=%d warnings=%v", len(result.Nodes), result.Warnings)
	}
	byOperator := map[string]connection.ExplainNode{}
	for _, node := range result.Nodes {
		byOperator[node.Extra["operator"].(string)] = node
	}
	if sort := byOperator["Sort"]; sort.ParentID != "" || !slices.Contains(sort.Flags, connection.ExplainFlagFilesort) {
		t.Fatalf("sort must be the root and flagged: %#v", sort)
	}
	scan := byOperator["TableScan"]
	if scan.Table != "monitor" || scan.ParentID != byOperator["Filter"].ID || slices.Contains(scan.Flags, connection.ExplainFlagFullScan) {
		t.Fatalf("scan with pushed-down filters %#v", scan)
	}
	if aggregate := byOperator["Aggregate"]; aggregate.OpType != connection.ExplainOpAggregate || !strings.Contains(aggregate.OpDetail, "groupBy") {
		t.Fatalf("aggregate %#v", aggregate)
	}
}

func TestParseGreptimeDBExplainFlagsUnfilteredScans(t *testing.T) {
	raw := "plan_type\tplan\nlogical_plan\tMergeScan [is_placeholder=false, remote_input=[\nTableScan: monitor\n]]\n"
	result := parseGreptimeDBExplain("greptimedb", "SELECT * FROM monitor", raw, defaultExplainBackendText)
	if len(result.Nodes) != 1 || !slices.Contains(result.Nodes[0].Flags, connection.ExplainFlagFullScan) {
		t.Fatalf("result %#v", result)
	}
	empty := parseGreptimeDBExplain("greptimedb", "SELECT 1", "plan_type\tplan\n", defaultExplainBackendText)
	if len(empty.Nodes) != 0 || len(empty.Warnings) != 1 {
		t.Fatalf("empty plan %#v", empty)
	}
}
