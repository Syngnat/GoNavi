package datasource

import (
	"strings"
	"testing"
	"testing/fstest"
)

const influxFixture = `{
  "type": "influxdb",
  "aliases": ["influx", "InfluxData"],
  "displayName": "InfluxDB",
  "group": "timeseries",
  "order": 20,
  "defaultPort": 8086,
  "wire": "http",
  "dialect": "influxql",
  "agent": {"buildTag": "gonavi_influxdb_driver"},
  "variants": {
    "auto": true,
    "default": "auto",
    "items": [
      {"id": "v1", "label": "InfluxDB 1.x", "maxServer": "2.0"},
      {"id": "v2", "label": "InfluxDB 2.x", "minServer": "2.0", "maxServer": "3.0"},
      {"id": "v3", "label": "InfluxDB 3.x", "minServer": "3.0"}
    ]
  }
}`

const cassandraFixture = `{
  "type": "cassandra",
  "displayName": "Apache Cassandra",
  "group": "nosql",
  "order": 10,
  "defaultPort": 9042,
  "wire": "cql",
  "dialect": "cql",
  "proxyMode": "driver",
  "agent": {"buildTag": "gonavi_cassandra_driver"},
  "variants": {
    "default": "v2",
    "items": [
      {"id": "legacy", "label": "Cassandra 1.2 - 2.0", "build": {"key": "cassandra_legacy", "buildTag": "gonavi_cassandra_legacy_driver", "goModule": "github.com/gocql/gocql", "version": "1.7.0"}},
      {"id": "v2", "label": "Cassandra 2.1 +"}
    ]
  }
}`

func fixtureFS(files map[string]string) fstest.MapFS {
	fsys := fstest.MapFS{}
	for name, body := range files {
		fsys["specs/"+name] = &fstest.MapFile{Data: []byte(body)}
	}
	return fsys
}

func loadFixtures(t *testing.T, files map[string]string) *Registry {
	t.Helper()
	registry, err := LoadRegistry(fixtureFS(files), "specs")
	if err != nil {
		t.Fatalf("load fixtures: %v", err)
	}
	return registry
}

func TestLoadRegistryIndexesTypesAliasesAndAgents(t *testing.T) {
	registry := loadFixtures(t, map[string]string{"influxdb.json": influxFixture, "cassandra.json": cassandraFixture})
	for _, name := range []string{"influxdb", "INFLUX", " influxdata "} {
		spec, ok := registry.Lookup(name)
		if !ok || spec.Type != "influxdb" {
			t.Fatalf("lookup %q = %#v, %v", name, spec.Type, ok)
		}
	}
	if _, ok := registry.Lookup("cassandra_legacy"); ok {
		t.Fatal("agent keys must not resolve as data source aliases")
	}
	spec, agent, variant, ok := registry.LookupAgent("cassandra_legacy")
	if !ok || spec.Type != "cassandra" || agent.BuildTag != "gonavi_cassandra_legacy_driver" || variant != "legacy" {
		t.Fatalf("lookup agent = %q %#v %q %v", spec.Type, agent, variant, ok)
	}
	if _, agent, variant, ok := registry.LookupAgent("cassandra"); !ok || agent.Key != "cassandra" || variant != "" {
		t.Fatalf("default agent = %#v %q %v", agent, variant, ok)
	}
	if got := strings.Join(registry.AgentKeys(), ","); got != "cassandra,cassandra_legacy,influxdb" {
		t.Fatalf("agent keys = %s", got)
	}
	all := registry.All()
	if all[0].Type != "cassandra" || all[1].Type != "influxdb" {
		t.Fatalf("specs must be ordered by order then type: %s, %s", all[0].Type, all[1].Type)
	}
	if !all[0].UsesDriverProxy() || all[1].UsesDriverProxy() {
		t.Fatal("proxy mode not decoded")
	}
}

func TestLoadRegistryRejectsInvalidSpecs(t *testing.T) {
	mutate := func(old, replacement string) map[string]string {
		return map[string]string{"influxdb.json": strings.Replace(influxFixture, old, replacement, 1)}
	}
	cases := map[string]map[string]string{
		"unknown group":       mutate(`"group": "timeseries"`, `"group": "graph"`),
		"hyphenated type":     {"influx-db.json": strings.Replace(influxFixture, `"type": "influxdb"`, `"type": "influx-db"`, 1)},
		"file name mismatch":  {"influx.json": influxFixture},
		"bad build tag":       mutate(`"buildTag": "gonavi_influxdb_driver"`, `"buildTag": "gonavi_influx_driver"`),
		"unknown proxy mode":  mutate(`"wire": "http"`, `"wire": "http", "proxyMode": "socks"`),
		"empty range":         mutate(`"minServer": "2.0", "maxServer": "3.0"`, `"minServer": "3.0", "maxServer": "2.0"`),
		"unknown default":     mutate(`"default": "auto"`, `"default": "v9"`),
		"duplicate variant":   mutate(`{"id": "v3", "label": "InfluxDB 3.x", "minServer": "3.0"}`, `{"id": "v2", "label": "again"}`),
		"too many variants":   mutate(`{"id": "v3", "label": "InfluxDB 3.x", "minServer": "3.0"}`, `{"id": "v3", "label": "x"}, {"id": "v4", "label": "y"}`),
		"bad platform":        mutate(`"agent": {"buildTag": "gonavi_influxdb_driver"}`, `"agent": {"buildTag": "gonavi_influxdb_driver", "platforms": ["plan9/amd64"]}`),
		"foreign default key": mutate(`"agent": {"buildTag": "gonavi_influxdb_driver"}`, `"agent": {"key": "other", "buildTag": "gonavi_other_driver"}`),
		"duplicate alias": {
			"influxdb.json":  strings.Replace(influxFixture, `"aliases": ["influx", "InfluxData"]`, `"aliases": ["influx", "cassandra"]`, 1),
			"cassandra.json": cassandraFixture,
		},
		"auto with builds": {"cassandra.json": strings.Replace(cassandraFixture, `"default": "v2",`, `"auto": true, "default": "v2",`, 1)},
		"agent key clash": {
			"cassandra.json": strings.Replace(cassandraFixture, `"key": "cassandra_legacy", "buildTag": "gonavi_cassandra_legacy_driver"`, `"key": "influxdb", "buildTag": "gonavi_influxdb_driver"`, 1),
			"influxdb.json":  influxFixture,
		},
	}
	for name, files := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadRegistry(fixtureFS(files), "specs"); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestEmbeddedRegistryIsValid(t *testing.T) {
	if _, err := LoadRegistry(embeddedSpecs, specsDir); err != nil {
		t.Fatalf("embedded registry: %v", err)
	}
	for _, spec := range All() {
		if canonical, ok := Canonical(spec.Type); !ok || canonical != spec.Type {
			t.Fatalf("type %q is not canonical in embedded registry", spec.Type)
		}
	}
}
