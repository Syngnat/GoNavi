package hivesql

import "testing"

func TestHiveReadOnlySourceQuery(t *testing.T) {
	good := []string{
		"SELECT 1", "-- header\nSELECT 'DELETE; SET x=1' AS txt; -- footer", "SELECT id, map('k',1), array(1), named_struct('n',1) FROM t",
		"WITH c AS (SELECT id FROM t), d AS (WITH x AS (SELECT 1) SELECT * FROM x) SELECT * FROM c",
		"SELECT CAST(v AS MAP<STRING,ARRAY<STRUCT<n:DECIMAL(38,4)>>>) AS typed FROM t",
		"SELECT CASE WHEN id>0 THEN 'INSERT' ELSE 'UPDATE' END FROM t", "SELECT a.id FROM a JOIN b USING (id)",
		"SELECT 'a" + string(rune(92)) + "'b', 'it''s', " + QuoteIdentifier("SET") + " FROM t", "SELECT hex(mapping['bytes']) AS safe_payload FROM t",
	}
	for _, query := range good {
		t.Run("allow/"+query, func(t *testing.T) {
			if err := ValidateReadOnlySourceQuery(query); err != nil {
				t.Fatalf("safe query rejected: %v", err)
			}
		})
	}
	bad := []string{
		"INSERT INTO t SELECT 1", "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", "WITH x AS (DELETE FROM t) SELECT * FROM x",
		"SELECT 1 DELETE FROM t", "SELECT 1; UPDATE t SET x=1", "SELECT 1 INTO OUTFILE '/tmp/x'", "SELECT TRANSFORM(a) USING 'sh' AS x FROM t",
		"SELECT MAP(a) USING 'cat' AS x FROM t", "SELECT REDUCE(a) USING 'cat' AS x FROM t", "SELECT reflect('java.lang.Runtime','getRuntime')",
		"SELECT reflect2(x,'foo')", "SELECT java_method('a','b')", "SELECT " + QuoteIdentifier("reflect") + "('a','b')", "SELECT 'reflect'(1)",
		"SELECT 1 # hide\nDELETE FROM t", "SELECT $$hidden;DELETE FROM t$$", "SELECT 'unclosed", "SELECT 1 /* unclosed", "SELECT 1 /* nested /* x */ y */",
		"SELECT 'x\\\\'; DELETE FROM t", "SELECT (1", "WITH x AS (SELECT 1) VALUES(1)", "SELECT 1; SELECT 2", "SELECT 1 ADD JAR 'x'", "SELECT 1 DFS -rm /x",
	}
	for _, location := range []string{"SELECT ", "SELECT '", "SELECT 1 -- ", "SELECT 1 /* "} {
		bad = append(bad, location+"$"+"{hiveconf:x}")
	}
	for _, query := range bad {
		t.Run("deny/"+query, func(t *testing.T) {
			if err := ValidateReadOnlySourceQuery(query); err == nil {
				t.Fatal("unsafe or unprovable source query accepted")
			}
		})
	}
}

func TestHiveDirectSourceProjection(t *testing.T) {
	cases := []struct {
		query, database, table, alias string
		wildcard                      bool
		names                         []string
	}{
		{query: "SELECT * FROM analytics.Events", database: "analytics", table: "Events", wildcard: true},
		{query: "SELECT s.id AS event_id, s.payload FROM analytics.events AS s WHERE id>0 ORDER BY id LIMIT 10", database: "analytics", table: "events", alias: "s", names: []string{"id", "payload"}},
		{query: "SELECT e.* FROM events e", table: "events", alias: "e", wildcard: true},
		{query: "SELECT " + QuoteIdentifier("source.with.dot") + "." + QuoteIdentifier("array.col") + " AS x FROM " + QuoteIdentifier("source.with.dot"), table: "source.with.dot", names: []string{"array.col"}},
	}
	for _, test := range cases {
		got, ok := DirectSourceProjection(test.query)
		if !ok || got.Database != test.database || got.Table != test.table || got.Alias != test.alias || got.Wildcard != test.wildcard {
			t.Fatalf("proof=%+v ok=%v query=%s", got, ok, test.query)
		}
		for i, name := range test.names {
			if got.Columns[i].Name != name {
				t.Fatalf("source identity=%v", got.Columns)
			}
		}
	}
	for _, query := range []string{"SELECT map('x',1) AS x FROM t", "SELECT * FROM a JOIN b ON a.id=b.id", "SELECT foreign.payload FROM t", "SELECT * FROM a, b", "SELECT * FROM a UNION ALL SELECT * FROM b"} {
		if _, ok := DirectSourceProjection(query); ok {
			t.Fatalf("ambiguous source accepted: %s", query)
		}
	}
	if got, ok := SelectedDatabase("/*x*/USE " + QuoteIdentifier("Analytics") + ";"); !ok || got != "Analytics" {
		t.Fatalf("database=%q known=%v", got, ok)
	}
	if !ChangesDatabase("--comment\nUSE " + "$" + "{hiveconf:db}") {
		t.Fatal("dynamic USE must invalidate namespace inference")
	}
}
