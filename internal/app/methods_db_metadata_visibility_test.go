package app

import (
	"encoding/json"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/secretstore"
)

func TestMetadataVisibilityScopesCatalogRequests(t *testing.T) {
	originalFactory := newDatabaseFunc
	originalDial := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalFactory
		resolveDialConfigWithProxyFunc = originalDial
	})
	inst := &fakeMetadataRetryDB{queryRows: []map[string]interface{}{{
		"schemaname": "Public", "tablename": "order.items",
		"table_schema": "Public", "table_name": "order.items",
		"column_name": "id", "data_type": "integer", "datname": "app",
	}}}
	newDatabaseFunc = func(string) (db.Database, error) { return inst, nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) { return config, nil }
	var config connection.ConnectionConfig
	err := json.Unmarshal([]byte(`{"type":"postgres","host":"127.0.0.1","port":5432,"user":"tester","database":"app","metadataScope":{"schemas":{"mode":"include","names":["Public","tenant'o"],"caseSensitive":true}}}`), &config)
	if err != nil {
		t.Fatal(err)
	}
	a := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	for _, result := range []connection.QueryResult{a.DBGetTables(config, "app"), a.DBGetAllColumns(config, "app")} {
		if !result.Success {
			t.Fatalf("catalog failed: %s", result.Message)
		}
	}
	if len(inst.queries) != 2 {
		t.Fatalf("want two scoped queries, got %v", inst.queries)
	}
	for _, query := range inst.queries {
		if !strings.Contains(query, "IN ('Public', 'tenant''o')") {
			t.Fatalf("unscoped schema query: %s", query)
		}
	}
	if inst.tableCalls != 0 || inst.allColumnCalls != 0 {
		t.Fatal("scoped request must not load the full catalog first")
	}
	if inst.connectConfig.MetadataScope != nil {
		t.Fatal("request visibility must not become part of the connection config")
	}
}

// Database discovery keeps each driver's native fallbacks (current_database(), SHOW DATABASES,
// hidden internal databases); the saved database visibility is applied by the explorer afterwards.
func TestMetadataScopeLeavesDatabaseDiscoveryNative(t *testing.T) {
	originalFactory := newDatabaseFunc
	originalDial := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalFactory
		resolveDialConfigWithProxyFunc = originalDial
	})
	inst := &fakeMetadataRetryDB{}
	newDatabaseFunc = func(string) (db.Database, error) { return inst, nil }
	resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) { return config, nil }
	var config connection.ConnectionConfig
	err := json.Unmarshal([]byte(`{"type":"postgres","host":"127.0.0.1","port":5432,"user":"tester","metadataScope":{"schemas":{"mode":"include","names":["public"],"caseSensitive":true}}}`), &config)
	if err != nil {
		t.Fatal(err)
	}
	a := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
	if result := a.DBGetDatabases(config); !result.Success {
		t.Fatalf("database discovery failed: %s", result.Message)
	}
	if len(inst.queries) != 0 {
		t.Fatalf("database discovery must not be rewritten into a catalog query: %v", inst.queries)
	}
	if inst.connectConfig.MetadataScope != nil {
		t.Fatal("request visibility must not become part of the connection config")
	}
}

func TestMetadataVisibilityCacheSeparatesSchemaScopes(t *testing.T) {
	originalFactory := newDatabaseFunc
	originalDial := resolveDialConfigWithProxyFunc
	t.Cleanup(func() {
		newDatabaseFunc = originalFactory
		resolveDialConfigWithProxyFunc = originalDial
	})
	for _, kind := range []string{"tables", "columns"} {
		t.Run(kind, func(t *testing.T) {
			inst := &fakeMetadataRetryDB{}
			newDatabaseFunc = func(string) (db.Database, error) { return inst, nil }
			resolveDialConfigWithProxyFunc = func(config connection.ConnectionConfig) (connection.ConnectionConfig, error) { return config, nil }
			a := NewAppWithSecretStore(secretstore.NewUnavailableStore("test"))
			config := connection.ConnectionConfig{Type: "postgres", Host: "localhost", Port: 5432, User: "tester", Database: "app"}
			request := func(schema string) connection.QueryResult {
				config.MetadataScope = &connection.MetadataDiscoveryScope{Schemas: &connection.MetadataSchemaScope{Mode: "include", Names: []string{schema}, CaseSensitive: true}}
				inst.queryRows = []map[string]interface{}{{"schemaname": schema, "tablename": "users", "table_schema": schema, "table_name": "users", "column_name": "id", "data_type": "int"}}
				if kind == "tables" {
					return a.DBGetTables(config, "app")
				}
				return a.DBGetAllColumns(config, "app")
			}
			for _, schema := range []string{"public", "public", "sales", "sales"} {
				result := request(schema)
				if !result.Success {
					t.Fatal(result.Message)
				}
				encoded, err := json.Marshal(result.Data)
				if err != nil {
					t.Fatal(err)
				}
				if !strings.Contains(string(encoded), schema+".users") {
					t.Fatalf("%s reused another schema's result: %s", schema, encoded)
				}
			}
			if len(inst.queries) != 2 {
				t.Fatalf("same scope should reuse cache, distinct scopes must query: %v", inst.queries)
			}
			a.invalidateMetadata(config, "app")
			if result := request("public"); !result.Success {
				t.Fatal(result.Message)
			}
			if result := request("sales"); !result.Success {
				t.Fatal(result.Message)
			}
			if len(inst.queries) != 4 {
				t.Fatalf("DDL invalidation must remove every schema scope: %v", inst.queries)
			}
		})
	}
}
