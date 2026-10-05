package app

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

// 崖山 23.1 的 EXPLAIN 原样输出（单列文本）：表格边框用 + 与 -，谓词在 Operation Information 段；
// 表格后面有一行以 NUL 开头的残行。
const yashanDBExplainSample = "PLAN_DESCRIPTION\n" +
	"SQL hash value: 3967204905\n" +
	"Optimizer: ADOPT_C\n" +
	" \n" +
	"+----+--------------------------------+----------------------+------------+----------+-------------+--------------------------------+\n" +
	"| Id | Operation type                 | Name                 | Owner      | Rows     | Cost(%CPU)  | Partition info                 |\n" +
	"+----+--------------------------------+----------------------+------------+----------+-------------+--------------------------------+\n" +
	"|  0 | SELECT STATEMENT               |                      |            |          |             |                                |\n" +
	"|  1 |  SORT                          |                      |            |      1000|      147( 0)|                                |\n" +
	"|  2 |   HASH GROUP                   |                      |            |      1000|      133( 0)|                                |\n" +
	"|  3 |    NESTED LOOPS INNER          |                      |            |     10890|      128( 0)|                                |\n" +
	"|* 4 |     INDEX FAST FULL SCAN       | SYS_C_31             | GONAVI     |     33000|       93( 0)|                                |\n" +
	"|* 5 |     TABLE ACCESS BY INDEX ROWID| PG_T                 | GONAVI     |          |             |                                |\n" +
	"|* 6 |      INDEX UNIQUE SCAN         | SYS_C_31             | GONAVI     |         1|       13( 0)|                                |\n" +
	"+----+--------------------------------+----------------------+------------+----------+-------------+--------------------------------+\n" +
	"\x00----+--------------------------------+----------------------+------------+----------+-------------+--------------------------------+\n" +
	"Operation Information (identified by operation id):\n" +
	"---------------------------------------------------\n" +
	"   2 - Group Expression: (\"T\".\"V\")\n" +
	"   4 - Predicate : filter(\"U\".\"ID\"+1 > 2)\n" +
	"   5 - Predicate : filter(\"T\".\"ID\" > 2)\n" +
	"   6 - Predicate : access(\"T\".\"ID\" = \"U\".\"ID\"+1)\n"

func TestParseYashanDBExplainBuildsTreeWithPredicates(t *testing.T) {
	result, err := parseExplainRaw("yashandb", "SELECT 1", yashanDBExplainSample, connection.ExplainFormatText)
	if err != nil {
		t.Fatal(err)
	}
	if result.DBType != "yashandb" || len(result.Warnings) != 0 {
		t.Fatalf("result %+v", result)
	}
	if len(result.Nodes) != 7 {
		t.Fatalf("nodes = %d, want 7: %+v", len(result.Nodes), result.Nodes)
	}
	byDetail := map[string]connection.ExplainNode{}
	for _, node := range result.Nodes {
		byDetail[node.OpDetail] = node
	}
	scan := byDetail["INDEX UNIQUE SCAN"]
	lookup := byDetail["TABLE ACCESS BY INDEX ROWID"]
	if scan.ParentID != lookup.ID || scan.Index != "SYS_C_31" || scan.EstRows != 1 {
		t.Fatalf("index scan %+v under %+v", scan, lookup)
	}
	if filter, _ := scan.Extra["filter"].(string); !strings.Contains(filter, `access("T"."ID" = "U"."ID"+1)`) {
		t.Fatalf("predicate %+v", scan.Extra)
	}
	if sortNode := byDetail["SORT"]; sortNode.Cost != 147 || sortNode.ParentID != byDetail["SELECT STATEMENT"].ID {
		t.Fatalf("sort %+v", sortNode)
	}
	if _, ok := byDetail["HASH GROUP"].Extra["filter"]; ok {
		t.Fatalf("group expression must not be treated as a predicate: %+v", byDetail["HASH GROUP"])
	}
}

func TestParseYashanDBExplainWarnsOnUnknownOutput(t *testing.T) {
	result, err := parseExplainRaw("yashandb", "SELECT 1", "PLAN\nsomething else\n", connection.ExplainFormatText)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Nodes) != 0 || len(result.Warnings) == 0 || result.RawFormat != connection.ExplainFormatText {
		t.Fatalf("result %+v", result)
	}
}

func TestBuildExplainQueryForYashanDBUsesPlainExplain(t *testing.T) {
	wrapped, post, _, cleanup, err := buildExplainQuery("yashandb", "SELECT * FROM t;")
	if err != nil || wrapped != "EXPLAIN SELECT * FROM t" || len(post) != 0 || len(cleanup) != 0 {
		t.Fatalf("wrapped=%q post=%v cleanup=%v err=%v", wrapped, post, cleanup, err)
	}
}
