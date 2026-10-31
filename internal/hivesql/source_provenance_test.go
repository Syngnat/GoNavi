package hivesql

import "testing"

func TestHiveDerivedPaginationAndProbeSourceProof(t *testing.T) {
	base := "SELECT * FROM analytics.events"
	rn := QuoteIdentifier("__gonavi_hive_rn__")
	page := "SELECT " + QuoteIdentifier("id") + ", " + QuoteIdentifier("tags") + " FROM (SELECT __gonavi_hive_source__.*, ROW_NUMBER() OVER (ORDER BY 1) AS " + rn + " FROM (" + base + ") AS __gonavi_hive_source__) AS __gonavi_hive_page__ WHERE " + rn + " > 10 AND " + rn + " <= 20 ORDER BY " + rn
	cases := []struct {
		query    string
		wildcard bool
		names    []string
	}{
		{"SELECT * FROM (" + base + ") AS probe LIMIT 0", true, nil},
		{page, false, []string{"id", "tags"}},
		{"WITH c AS (SELECT id, tags AS renamed FROM analytics.events) SELECT id, renamed FROM c", false, []string{"id", "tags"}},
		{"SELECT x.renamed FROM (SELECT tags AS renamed, map('unknown',1) AS omitted FROM analytics.events) x", false, []string{"tags"}},
		{"WITH c AS (SELECT CAST(array('x') AS ARRAY<STRING>) AS a) SELECT a FROM c", false, []string{""}},
	}
	for _, test := range cases {
		got, ok := DirectSourceProjection(test.query)
		if !ok || got.Wildcard != test.wildcard {
			t.Fatalf("derived proof=%+v ok=%v query=%s", got, ok, test.query)
		}
		for i, name := range test.names {
			if got.Columns[i].Name != name {
				t.Fatalf("derived origin lost=%+v", got)
			}
		}
		if got.Table != "" && got.Table != "events" {
			t.Fatalf("wrong physical origin=%+v", got)
		}
	}
	for _, query := range []string{"SELECT * FROM (SELECT * FROM a JOIN b ON a.id=b.id) x", "WITH x AS (SELECT * FROM x) SELECT * FROM x", "WITH x AS (SELECT * FROM y),y AS (SELECT * FROM x) SELECT * FROM x", "SELECT * FROM (SELECT * FROM a UNION ALL SELECT * FROM b) x", "SELECT unknown FROM (SELECT map('x',1) AS unknown FROM t) x"} {
		if proof, ok := DirectSourceProjection(query); ok {
			t.Fatalf("ambiguous derived chain accepted: %+v SQL=%s", proof, query)
		}
	}
}
