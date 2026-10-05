//go:build gonavi_full_drivers || gonavi_etcd_driver

package db

import (
	"reflect"
	"testing"
)

func TestParseEtcdSelectPushesKeyConditionsIntoRanges(t *testing.T) {
	query, ok, err := parseEtcdSelect(`SELECT * FROM "/registry/pods" WHERE "key" LIKE '/registry/pods/default/%' ORDER BY "key" DESC LIMIT 50 OFFSET 100`, "/")
	if !ok || err != nil {
		t.Fatalf("parse: %v %v", ok, err)
	}
	if query.table != "/registry/pods" || !query.desc || query.orderBy != "key" || query.limit != 50 || query.offset != 100 || query.residual {
		t.Fatalf("query %+v", query)
	}
	want := []etcdKeyRange{{start: "/registry/pods/default/", end: "/registry/pods/default0"}}
	if !reflect.DeepEqual(query.keyRanges, want) {
		t.Fatalf("ranges %+v, want %+v", query.keyRanges, want)
	}

	// 表路径本身 + 子键两个区间；value 条件留在客户端过滤。
	query, _, err = parseEtcdSelect(`SELECT COUNT(*) FROM "/app" WHERE "value" LIKE '%prod%'`, "/")
	if err != nil || !query.count || !query.residual || len(query.keyRanges) != 2 || query.keyRanges[0] != (etcdKeyRange{start: "/app"}) {
		t.Fatalf("count query %+v %v", query, err)
	}
	query, _, _ = parseEtcdSelect(`SELECT * FROM "/app" WHERE "key" IN ('/app/a', '/elsewhere')`, "/")
	if !reflect.DeepEqual(query.keyRanges, []etcdKeyRange{{start: "/app/a"}}) || query.residual {
		t.Fatalf("IN outside the table must be dropped: %+v", query.keyRanges)
	}
	query, _, _ = parseEtcdSelect(`SELECT * FROM "/app" WHERE "key" >= '/app/m' AND "key" < '/app/t'`, "/")
	if !reflect.DeepEqual(query.keyRanges, []etcdKeyRange{{start: "/app/m", end: "/app/t"}}) {
		t.Fatalf("range %+v", query.keyRanges)
	}
	query, _, _ = parseEtcdSelect(`SELECT "key", "value" FROM cfg`, "/")
	if query.table != "cfg" || !reflect.DeepEqual(query.columns, []string{"key", "value"}) || query.limit != etcdDefaultSelectLimit {
		t.Fatalf("projection %+v", query)
	}
	if _, ok, _ := parseEtcdSelect("get /app --prefix", "/"); ok {
		t.Fatal("console commands are not SELECT queries")
	}
	if _, _, err := parseEtcdSelect(`SELECT * FROM "/app" WHERE "key" ~~ 'x'`, "/"); err == nil {
		t.Fatal("unsupported WHERE syntax must be reported")
	}
}

func TestMatchEtcdWhere(t *testing.T) {
	row := etcdKeyValue{key: "/app/db/url", value: []byte("jdbc:mysql://db:3306/app"), createRevision: 5, modRevision: 9, version: 3, lease: 0x694d}
	for where, want := range map[string]bool{
		`"value" LIKE 'jdbc:%'`:                  true,
		`"value" NOT LIKE '%postgres%'`:          true,
		`"version" >= 3 AND "mod_revision" < 10`: true,
		`"create_revision" BETWEEN 6 AND 8`:      false,
		`"lease" = '694d'`:                       true,
		`"key" = '/app/db/url' OR "version" > 5`: true,
		`NOT ("key" LIKE '/app/%')`:              false,
		`"version" IN (1, 2)`:                    false,
		`"value" IS NOT NULL`:                    true,
		`"key" LIKE '/app/db/ur_'`:               true,
	} {
		node, err := parseRegistryWhere(where)
		if err != nil {
			t.Fatalf("parse %q: %v", where, err)
		}
		if got := matchEtcdWhere(node, row); got != want {
			t.Errorf("%s = %v, want %v", where, got, want)
		}
	}
}

func TestSplitEtcdSegment(t *testing.T) {
	for _, tc := range []struct {
		rest     string
		topLevel bool
		segment  string
		children bool
	}{
		{"/registry/pods/x", true, "/registry", true},
		{"foo", true, "foo", false},
		{"foo/bar", true, "foo", true},
		{"/", true, "/", false},
		{"pods/default/x", false, "pods", true},
		{"name", false, "name", false},
	} {
		segment, children := splitEtcdSegment(tc.rest, "/", tc.topLevel)
		if segment != tc.segment || children != tc.children {
			t.Errorf("splitEtcdSegment(%q, %v) = %q, %v", tc.rest, tc.topLevel, segment, children)
		}
	}
}

func TestQuoteEtcdArgumentRoundTrips(t *testing.T) {
	for _, value := range []string{"plain", "with space", `{"a": 1}`, "it's", "multi\nline 'q' \"d\"", ""} {
		command, err := parseEtcdCommand("put k " + quoteShellArgument(value))
		if err != nil || len(command.args) != 2 || command.args[1] != value {
			t.Errorf("round trip %q: %+v %v", value, command.args, err)
		}
	}
}

func TestSliceEtcdPageAndSort(t *testing.T) {
	rows := []etcdKeyValue{{key: "c", version: 1}, {key: "a", version: 3}, {key: "b", version: 2}}
	sortEtcdRows(rows, "version", true)
	if rows[0].key != "a" || rows[2].key != "c" {
		t.Fatalf("sorted %+v", rows)
	}
	if page := sliceEtcdPage(rows, 1, 1); len(page) != 1 || page[0].key != "b" {
		t.Fatalf("page %+v", page)
	}
	if page := sliceEtcdPage(rows, 5, 1); len(page) != 0 {
		t.Fatalf("offset past end %+v", page)
	}
}
