package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// 夹具来自 CockroachDB v26.3.2 的真实 EXPLAIN 输出（单列 info）。
var cockroachTextPlanFixture = strings.Join([]string{
	"info",
	"distribution: local",
	"",
	"• top-k",
	"│ order: +c",
	"│ k: 5",
	"│",
	"└── • group (hash)",
	"    │ group by: c",
	"    │",
	"    └── • hash join",
	"        │ equality: (a_id) = (id)",
	"        │ right cols are key",
	"        │",
	"        ├── • scan",
	"        │     missing stats",
	"        │     table: d@d_pkey",
	"        │     spans: FULL SCAN",
	"        │",
	"        └── • filter",
	"            │ filter: b > 3",
	"            │",
	"            └── • scan",
	"                  estimated row count: 1,000 (missing stats)",
	"                  table: a@ib",
	"                  spans: /4-",
	"",
	"index recommendations: 1",
	"1. type: index replacement",
	"   SQL commands: CREATE INDEX ON defaultdb.public.a (b) STORING (c);",
}, "\n")

// 夹具来自 KWDB 3.2.2（CockroachDB 20.x 风格的 tree | field | description 表格）。
var cockroachTablePlanFixture = strings.Join([]string{
	"tree\tfield\tdescription",
	"\tdistributed\ttrue",
	"\tvectorized\tfalse",
	"limit\t\t",
	" │\tcount\t5",
	" └── sort\t\t",
	"      │\torder\t+c",
	"      └── group\t\t",
	"           │\tgroup by\tc",
	"           └── render\t\t",
	"                └── hash-join\t\t",
	"                     │\tequality\t(a_id) = (id)",
	"                     ├── scan\t\t",
	"                     │\ttable\td@primary",
	"                     │\tspans\tFULL SCAN",
	"                     └── scan\t\t",
	"\ttable\ta@primary",
	"\tspans\tFULL SCAN",
	"\tfilter\tb > 3",
}, "\n")

func opsByID(result connection.ExplainResult) map[string]connection.ExplainNode {
	nodes := make(map[string]connection.ExplainNode, len(result.Nodes))
	for _, node := range result.Nodes {
		nodes[node.ID] = node
	}
	return nodes
}

func TestParseCockroachTextExplain(t *testing.T) {
	result := parseCockroachExplain("cockroachdb", "SELECT ...", cockroachTextPlanFixture, defaultExplainBackendText)
	if len(result.Nodes) != 6 {
		t.Fatalf("nodes = %d: %#v", len(result.Nodes), result.Nodes)
	}
	nodes := opsByID(result)
	scanD, filter, scanA := result.Nodes[3], result.Nodes[4], result.Nodes[5]
	if nodes[scanD.ParentID].Extra["operator"] != "hash join" || filter.ParentID != scanD.ParentID {
		t.Fatalf("join children misplaced: %#v %#v", scanD, filter)
	}
	if scanA.ParentID != filter.ID || scanA.Table != "a" || scanA.Index != "ib" || scanA.EstRows != 1000 {
		t.Fatalf("filtered scan = %#v", scanA)
	}
	if scanD.Table != "d" || scanD.Index != "d_pkey" || !result.Stats.HasFullScan {
		t.Fatalf("full scan = %#v stats=%#v", scanD, result.Stats)
	}
	if result.Nodes[0].OpType != connection.ExplainOpSort || result.Nodes[2].OpType != connection.ExplainOpJoin {
		t.Fatalf("operators = %q %q", result.Nodes[0].OpType, result.Nodes[2].OpType)
	}
	if len(result.Warnings) != 1 || !strings.Contains(result.Warnings[0], "CREATE INDEX ON defaultdb.public.a (b)") {
		t.Fatalf("index recommendation not surfaced: %#v", result.Warnings)
	}
}

func TestParseCockroachTableExplain(t *testing.T) {
	result := parseCockroachExplain("kwdb", "SELECT ...", cockroachTablePlanFixture, defaultExplainBackendText)
	if len(result.Nodes) != 7 {
		t.Fatalf("nodes = %d: %#v", len(result.Nodes), result.Nodes)
	}
	nodes := opsByID(result)
	lastScan := result.Nodes[6]
	if nodes[lastScan.ParentID].Extra["operator"] != "hash-join" || lastScan.Table != "a" || lastScan.Index != "primary" {
		t.Fatalf("last scan = %#v", lastScan)
	}
	if !strings.Contains(lastScan.OpDetail, "b > 3") || !result.Stats.HasFullScan {
		t.Fatalf("filter / full scan not attached: %#v", lastScan)
	}
	if result.Nodes[0].OpType != connection.ExplainOpLimit || result.Nodes[1].ParentID != result.Nodes[0].ID {
		t.Fatalf("root chain = %#v", result.Nodes[:2])
	}
}

func TestCockroachExplainRouting(t *testing.T) {
	for _, dbType := range []string{"cockroachdb", "kwdb"} {
		if !isRegistryExplainDialect(dbType) {
			t.Fatalf("%s must support diagnosis", dbType)
		}
		wrapped, _, format, _, err := buildExplainQuery(dbType, "SELECT 1;")
		if err != nil || wrapped != "EXPLAIN SELECT 1" || format != connection.ExplainFormatText {
			t.Fatalf("%s explain query = %q %q %v", dbType, wrapped, format, err)
		}
	}
	if got := resolveExplainDBType(connection.ConnectionConfig{Type: "crdb"}); got != "cockroachdb" {
		t.Fatalf("alias explain dialect = %q", got)
	}
}

func TestParseCockroachExplainUnknownLayout(t *testing.T) {
	result := parseCockroachExplain("cockroachdb", "SELECT 1", "QUERY PLAN\nSeq Scan on t", defaultExplainBackendText)
	if len(result.Nodes) != 0 || len(result.Warnings) == 0 {
		t.Fatalf("expected warning, got %#v", result)
	}
}
