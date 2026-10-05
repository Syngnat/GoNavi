package datasource

import "testing"

func TestParseServerVersion(t *testing.T) {
	cases := map[string][]int{
		"v24.3.36":                          {24, 3, 36},
		"CockroachDB CCL v24.3.36 (x86_64)": {24, 3, 36},
		"8.0.11-TiDB-v8.5.8":                {8, 0, 11},
		"3.9.6-core":                        {3, 9, 6},
		"":                                  nil,
		"unknown":                           nil,
	}
	for input, want := range cases {
		got := ParseServerVersion(input)
		if len(got) != len(want) {
			t.Fatalf("%q => %v, want %v", input, got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("%q => %v, want %v", input, got, want)
			}
		}
	}
}

func TestCompareServerVersions(t *testing.T) {
	cases := []struct {
		left, right string
		want        int
	}{
		{"2.7.9", "3.0", -1},
		{"3.0", "3", 0},
		{"10.0.1", "9.4.3", 1},
		{"v1.39.8", "1.24", 1},
	}
	for _, tc := range cases {
		if got := CompareServerVersions(tc.left, tc.right); got != tc.want {
			t.Fatalf("compare(%q, %q) = %d, want %d", tc.left, tc.right, got, tc.want)
		}
	}
}

func TestResolveVariant(t *testing.T) {
	registry := loadFixtures(t, map[string]string{"influxdb.json": influxFixture, "cassandra.json": cassandraFixture})
	influx, _ := registry.Lookup("influxdb")
	cases := []struct {
		requested, server, want string
	}{
		{"", "1.11.9", "v1"},
		{"auto", "2.7.9", "v2"},
		{"AUTO", "3.9.6-core", "v3"},
		{"", "0.13", "v1"},
		{"", "", "v3"},
		{"v1", "3.9.6", "v1"},
	}
	for _, tc := range cases {
		got, err := influx.ResolveVariant(tc.requested, tc.server)
		if err != nil || got.ID != tc.want {
			t.Fatalf("resolve(%q, %q) = %q, %v; want %q", tc.requested, tc.server, got.ID, err, tc.want)
		}
	}
	if _, err := influx.ResolveVariant("v9", ""); err == nil {
		t.Fatal("unknown variant must fail")
	}
	cassandra, _ := registry.Lookup("cassandra")
	if _, err := cassandra.ResolveVariant("auto", "4.1"); err == nil {
		t.Fatal("auto must fail when the data source has separate builds")
	}
	if got := cassandra.AgentKeyFor(""); got != "cassandra" {
		t.Fatalf("default variant must use the default agent, got %q", got)
	}
	if got := cassandra.AgentKeyFor("LEGACY"); got != "cassandra_legacy" {
		t.Fatalf("separate build variant agent = %q", got)
	}
	if got := len(cassandra.Agents()); got != 2 {
		t.Fatalf("cassandra agents = %d", got)
	}
	if got := influx.AgentKeyFor("v3"); got != "influxdb" {
		t.Fatalf("runtime variant agent = %q", got)
	}
}

func TestMatchVariant(t *testing.T) {
	registry := loadFixtures(t, map[string]string{"influxdb.json": influxFixture, "cassandra.json": cassandraFixture})
	influx, _ := registry.Lookup("influxdb")
	cases := map[string]string{"1.11.9": "v1", "2.7.9": "v2", "3.9.6-core": "v3", "0.13": "v1", "v9.0": "v3"}
	for server, want := range cases {
		got, ok := influx.MatchVariant(server)
		if !ok || got.ID != want {
			t.Fatalf("match(%q) = %q, %v; want %q", server, got.ID, ok, want)
		}
	}
	for _, server := range []string{"", "unknown"} {
		if _, ok := influx.MatchVariant(server); ok {
			t.Fatalf("match(%q) must report no match", server)
		}
	}
	cassandra, _ := registry.Lookup("cassandra")
	if got, ok := cassandra.MatchVariant("1.2.19"); !ok || got.ID != "legacy" {
		t.Fatalf("separate build variants must still match by range, got %q, %v", got.ID, ok)
	}
}
