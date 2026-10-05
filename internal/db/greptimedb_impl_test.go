//go:build gonavi_full_drivers || gonavi_greptimedb_driver

package db

import "testing"

func TestParseGreptimeDBVersion(t *testing.T) {
	cases := map[string]string{
		"8.4.2-GreptimeDB-1.2.1":  "1.2.1",
		"8.4.2-greptimedb-0.17.2": "0.17.2",
		"8.0.32":                  "",
	}
	for banner, want := range cases {
		if got := parseGreptimeDBVersion(banner); got != want {
			t.Fatalf("parseGreptimeDBVersion(%q) = %q, want %q", banner, got, want)
		}
	}
}

func TestGreptimeDBIdentifierAndFilters(t *testing.T) {
	if got := quoteGreptimeDBIdentifier("public", "cpu`load"); got != "`public`.`cpu``load`" {
		t.Fatalf("quote = %s", got)
	}
	if got := greptimeDBTableFilter("", "o'clock"); got != "table_schema = 'public' AND table_name = 'o''clock'" {
		t.Fatalf("filter = %s", got)
	}
}
