package app

import (
	"slices"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// 取自 QuestDB 8.3.3：EXPLAIN SELECT symbol, avg(price) FROM trades WHERE side = 'buy' SAMPLE BY 1h
const questDBGroupByPlanFixture = "QUERY PLAN\n" +
	"SelectedRecord\n" +
	"    Radix sort light\n" +
	"      keys: [ts]\n" +
	"        Async JIT Group By workers: 20\n" +
	"          keys: [symbol,ts]\n" +
	"          values: [avg(price)]\n" +
	"          filter: side='buy'\n" +
	"            PageFrame\n" +
	"                Row forward scan\n" +
	"                Frame forward scan on: trades\n"

const questDBIntervalPlanFixture = "QUERY PLAN\n" +
	"PageFrame\n" +
	"    Row forward scan\n" +
	"    Interval forward scan on: trades\n" +
	"      intervals: [(\"2026-10-03T00:00:00.000000Z\",\"2026-10-03T23:59:59.999999Z\")]\n"

func TestParseQuestDBExplainBuildsIndentedTree(t *testing.T) {
	result := parseQuestDBExplain("questdb", "SELECT ...", questDBGroupByPlanFixture, defaultExplainBackendText)
	if len(result.Warnings) > 0 || len(result.Nodes) != 6 {
		t.Fatalf("nodes=%d warnings=%v", len(result.Nodes), result.Warnings)
	}
	byOperator := map[string]connection.ExplainNode{}
	for _, node := range result.Nodes {
		byOperator[node.Extra["operator"].(string)] = node
	}
	sort := byOperator["Radix sort light"]
	if sort.OpType != connection.ExplainOpSort || !slices.Contains(sort.Flags, connection.ExplainFlagFilesort) || sort.ParentID != byOperator["SelectedRecord"].ID {
		t.Fatalf("sort node %#v", sort)
	}
	groupBy := byOperator["Async JIT Group By"]
	if groupBy.OpType != connection.ExplainOpAggregate || groupBy.Extra["workers"] != "20" || !strings.Contains(groupBy.OpDetail, "filter: side='buy'") || groupBy.ParentID != sort.ID {
		t.Fatalf("group by node %#v", groupBy)
	}
	scan := byOperator["Frame forward scan"]
	if scan.OpType != connection.ExplainOpScan || scan.Table != "trades" || !slices.Contains(scan.Flags, connection.ExplainFlagFullScan) {
		t.Fatalf("frame scan node %#v", scan)
	}
	if rowScan := byOperator["Row forward scan"]; rowScan.ParentID != byOperator["PageFrame"].ID || scan.ParentID != rowScan.ParentID {
		t.Fatalf("scans must be siblings under PageFrame: %#v / %#v", rowScan, scan)
	}
}

func TestParseQuestDBExplainIntervalScanIsNotFullScan(t *testing.T) {
	result := parseQuestDBExplain("questdb", "SELECT ...", questDBIntervalPlanFixture, defaultExplainBackendText)
	for _, node := range result.Nodes {
		if slices.Contains(node.Flags, connection.ExplainFlagFullScan) {
			t.Fatalf("interval scan must not be flagged as full scan: %#v", node)
		}
		if node.Extra["operator"] == "Interval forward scan" && (node.Table != "trades" || !strings.Contains(node.OpDetail, "intervals:")) {
			t.Fatalf("interval scan node %#v", node)
		}
	}
}

func TestParseQuestDBExplainWarnsWithoutPlanColumn(t *testing.T) {
	result := parseQuestDBExplain("questdb", "SELECT 1", "id\testRows\n1\t2", defaultExplainBackendText)
	if len(result.Nodes) != 0 || len(result.Warnings) != 1 || !strings.Contains(result.Warnings[0], "QuestDB") {
		t.Fatalf("result %#v", result)
	}
}
