package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// 夹具来自 TiDB v8.5.8 的真实输出。
const tidbJoinPlanFixture = "id\testRows\ttask\taccess object\toperator info\n" +
	"Projection_12\t5.00\troot\t\tcap.a.c, Column#6\n" +
	"└─TopN_15\t5.00\troot\t\tcap.a.c, offset:0, count:5\n" +
	"  └─HashAgg_20\t2666.67\troot\t\tgroup by:cap.a.c, funcs:count(1)->Column#6\n" +
	"    └─HashJoin_22\t4166.67\troot\t\tinner join, equal:[eq(cap.a.id, cap.d.a_id)]\n" +
	"      ├─TableReader_39(Build)\t3333.33\troot\t\tdata:Selection_38\n" +
	"      │ └─Selection_38\t3333.33\tcop[tikv]\t\tgt(cap.a.b, 3)\n" +
	"      │   └─TableFullScan_37\t10000.00\tcop[tikv]\ttable:a\tkeep order:false, stats:pseudo\n" +
	"      └─TableReader_36(Probe)\t9990.00\troot\t\tdata:Selection_35\n" +
	"        └─Selection_35\t9990.00\tcop[tikv]\t\tnot(isnull(cap.d.a_id))\n" +
	"          └─IndexRangeScan_34\t10000.00\tcop[tikv]\ttable:d, index:idx_a(a_id)\trange:[1,1]\n"

const tidbAnalyzePlanFixture = "id\testRows\tactRows\ttask\taccess object\texecution info\toperator info\tmemory\tdisk\n" +
	"TableReader_7\t10.00\t3\troot\t\ttime:5.25ms, loops:1\tdata:Selection_6\t196 Bytes\tN/A\n" +
	"└─Selection_6\t10.00\t3\tcop[tikv]\t\ttikv_task:{time:1.28ms, loops:0}\teq(cap.a.c, \"x\")\tN/A\tN/A\n" +
	"  └─TableFullScan_5\t10000.00\t10000\tcop[tikv]\ttable:a\ttikv_task:{time:1.28ms, loops:0}\tkeep order:false\tN/A\tN/A\n"

func TestParseTiDBExplainBuildsTree(t *testing.T) {
	result := parseTiDBExplain("SELECT ...", tidbJoinPlanFixture, defaultExplainBackendText)
	if len(result.Warnings) > 0 || len(result.Nodes) != 10 {
		t.Fatalf("nodes=%d warnings=%v", len(result.Nodes), result.Warnings)
	}
	parentOf := map[string]string{}
	opOf := map[string]string{}
	for _, node := range result.Nodes {
		parentOf[node.ID] = node.ParentID
		opOf[node.ID] = node.Extra["operator"].(string)
	}
	scan := result.Nodes[6]
	if opOf[scan.ID] != "TableFullScan" || opOf[parentOf[scan.ID]] != "Selection" || opOf[parentOf[parentOf[scan.ID]]] != "TableReader" {
		t.Fatalf("full scan placed under wrong parents: %#v", scan)
	}
	build := result.Nodes[4]
	if build.Extra["role"] != "Build" || opOf[build.ParentID] != "HashJoin" {
		t.Fatalf("build side = %#v", build)
	}
	probe := result.Nodes[7]
	if probe.Extra["role"] != "Probe" || probe.ParentID != build.ParentID {
		t.Fatalf("probe side must be a sibling of build: %#v", probe)
	}
	if scan.Table != "a" || scan.EstRows != 10000 || scan.OpType != connection.ExplainOpScan || scan.Extra["task"] != "cop[tikv]" {
		t.Fatalf("scan node = %#v", scan)
	}
	rangeScan := result.Nodes[9]
	if rangeScan.Index != "idx_a" || rangeScan.Table != "d" || rangeScan.OpType != connection.ExplainOpIndexScan {
		t.Fatalf("index scan = %#v", rangeScan)
	}
	if !result.Stats.HasFullScan || len(result.Edges) != 9 {
		t.Fatalf("stats=%#v edges=%d", result.Stats, len(result.Edges))
	}
}

func TestParseTiDBExplainAnalyzeKeepsActualRows(t *testing.T) {
	result := parseTiDBExplain("SELECT ...", tidbAnalyzePlanFixture, defaultExplainBackendText)
	if len(result.Nodes) != 3 {
		t.Fatalf("nodes = %d", len(result.Nodes))
	}
	scan := result.Nodes[2]
	if scan.ActualRows != 10000 || !strings.Contains(scan.Extra["executionInfo"].(string), "tikv_task") {
		t.Fatalf("scan = %#v", scan)
	}
	if _, ok := result.Nodes[1].Extra["memory"]; ok {
		t.Fatal("N/A memory must be dropped")
	}
	if result.Nodes[0].Extra["memory"] != "196 Bytes" {
		t.Fatalf("reader memory = %#v", result.Nodes[0].Extra)
	}
}

func TestParseTiDBExplainRejectsUnknownLayout(t *testing.T) {
	result := parseTiDBExplain("SELECT 1", "QUERY PLAN\nSeq Scan on t\n", defaultExplainBackendText)
	if len(result.Nodes) != 0 || len(result.Warnings) == 0 {
		t.Fatalf("expected warning, got %#v", result)
	}
}

func TestTiDBExplainRouting(t *testing.T) {
	config := connection.ConnectionConfig{Type: "tidb"}
	if got := resolveExplainDBType(config); got != "tidb" {
		t.Fatalf("explain dialect = %q", got)
	}
	wrapped, _, format, _, err := buildExplainQuery("tidb", "SELECT 1;")
	if err != nil || wrapped != "EXPLAIN SELECT 1" || format != connection.ExplainFormatTable {
		t.Fatalf("explain query = %q %q %v", wrapped, format, err)
	}
	if !hasExecutableSQLComment("tidb", "SELECT /*T![clustered_index] 1 */ 1") {
		t.Fatal("TiDB executable comments must be treated as unsafe")
	}
	if isSafeExplainQuery("tidb", "SELECT 1; DROP TABLE t") {
		t.Fatal("multi statements must be rejected")
	}
}
