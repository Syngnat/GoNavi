package hivesql

import "testing"

func TestHiveExplicitResultTypeCasts(t *testing.T) {
	cases := []struct {
		query string
		want  []string
	}{
		{"SELECT CAST(array('x') AS ARRAY<STRING>) AS a", []string{"ARRAY<STRING>"}},
		{"SELECT id,CAST(v AS MAP<STRING,DECIMAL(38,4)>) AS m FROM db.t", []string{"", "MAP<STRING,DECIMAL(38,4)>"}},
		{"WITH x AS (SELECT 1) SELECT CAST(v AS STRUCT<" + QuoteIdentifier("desc") + ":INT>) AS s FROM t", []string{"STRUCT<" + QuoteIdentifier("desc") + ":INT>"}},
	}
	for _, test := range cases {
		got, ok := ExplicitResultTypeCasts(test.query)
		if !ok || len(got) != len(test.want) {
			t.Fatalf("cast proof=%v ok=%v", got, ok)
		}
		for i, want := range test.want {
			if got[i] != want {
				t.Fatalf("cast[%d]=%q want=%q", i, got[i], want)
			}
		}
	}
	for _, query := range []string{"SELECT *, CAST(v AS ARRAY<STRING>) AS a FROM t", "SELECT CAST(v AS ARRAY<STRING>) AS a FROM t UNION ALL SELECT x FROM u", "SELECT CAST(v AS ARRAY<STRING>) FROM t", "SELECT array(v) AS a FROM t"} {
		if _, ok := ExplicitResultTypeCasts(query); ok {
			t.Fatalf("unproved cast schema accepted %s", query)
		}
	}
}

func TestHiveReadOnlyOrderingDirection(t *testing.T) {
	for _, query := range []string{"SELECT * FROM t ORDER BY id DESC, time_value ASC", "SELECT row_number() OVER (ORDER BY id DESC) AS ordinal FROM t", "SELECT CAST(v AS STRUCT<" + QuoteIdentifier("set") + ":STRING," + QuoteIdentifier("desc") + ":ARRAY<INT>>) AS s FROM t"} {
		if err := ValidateReadOnlySourceQuery(query); err != nil {
			t.Fatalf("ordinary readonly SQL rejected: %s: %v", query, err)
		}
	}
}
