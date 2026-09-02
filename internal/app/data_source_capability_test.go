package app

import (
	"errors"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
)

func TestDataSourceCapabilityResolvesBuiltinAndDriverAgentProfiles(t *testing.T) {
	application := NewApp()
	cases := []struct {
		name                      string
		config                    connection.ConnectionConfig
		wantType                  string
		query                     bool
		metadata                  bool
		transaction               bool
		primaryVisibility         bool
		primaryKind               string
		secondarySchemaVisibility bool
		schemaCaseSensitive       bool
	}{
		{
			name:              "builtin mysql",
			config:            connection.ConnectionConfig{Type: "mysql"},
			wantType:          "mysql",
			query:             true,
			metadata:          true,
			transaction:       true,
			primaryVisibility: true,
			primaryKind:       "database",
		},
		{
			name:                      "builtin postgres navigation",
			config:                    connection.ConnectionConfig{Type: "postgres"},
			wantType:                  "postgres",
			query:                     true,
			metadata:                  true,
			transaction:               true,
			primaryVisibility:         true,
			primaryKind:               "database",
			secondarySchemaVisibility: true,
			schemaCaseSensitive:       true,
		},
		{
			name:                      "builtin duckdb navigation",
			config:                    connection.ConnectionConfig{Type: "duckdb"},
			wantType:                  "duckdb",
			query:                     true,
			metadata:                  true,
			transaction:               true,
			primaryVisibility:         true,
			primaryKind:               "database",
			secondarySchemaVisibility: true,
			schemaCaseSensitive:       false,
		},
		{
			name:        "driver agent sqlite alias",
			config:      connection.ConnectionConfig{Type: "sqlite3"},
			wantType:    "sqlite",
			query:       true,
			metadata:    true,
			transaction: true,
			primaryKind: "none",
		},
		{
			name:              "custom oceanbase oracle",
			config:            connection.ConnectionConfig{Type: "custom", Driver: "oceanbase", OceanBaseProtocol: "oracle"},
			wantType:          "oracle",
			query:             true,
			metadata:          true,
			transaction:       true,
			primaryVisibility: true,
			primaryKind:       "owner",
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			capability := application.DataSourceCapability(tc.config)
			if capability.DatabaseType != tc.wantType {
				t.Fatalf("database type = %q, want %q", capability.DatabaseType, tc.wantType)
			}
			if capability.Query.Supported != tc.query || capability.Metadata.Supported != tc.metadata || capability.Transaction.Supported != tc.transaction {
				t.Fatalf("capability = %#v, want query=%t metadata=%t transaction=%t", capability, tc.query, tc.metadata, tc.transaction)
			}
			if capability.Navigation.PrimaryVisibilitySupported != tc.primaryVisibility ||
				capability.Navigation.PrimaryKind != tc.primaryKind ||
				capability.Navigation.SecondarySchemaVisibilitySupported != tc.secondarySchemaVisibility ||
				capability.Navigation.SchemaIdentifierCaseSensitive != tc.schemaCaseSensitive {
				t.Fatalf("navigation = %#v, want primaryVisibility=%t primaryKind=%q secondarySchemaVisibility=%t schemaCaseSensitive=%t", capability.Navigation, tc.primaryVisibility, tc.primaryKind, tc.secondarySchemaVisibility, tc.schemaCaseSensitive)
			}
		})

	}
}

func TestDataSourceQueryGateRejectsUnsupportedSourceBeforeCreatingConnection(t *testing.T) {
	originalNewDatabaseFunc := newDatabaseFunc
	t.Cleanup(func() { newDatabaseFunc = originalNewDatabaseFunc })
	connectionCreated := false
	newDatabaseFunc = func(string) (db.Database, error) {
		connectionCreated = true
		return nil, errors.New("database constructor must not be reached")
	}

	application := NewApp()
	config := connection.ConnectionConfig{Type: "redis"}
	wantMessage := application.appText("query_editor.message.unsupported_source", nil)
	cases := []struct {
		name string
		run  func() connection.QueryResult
	}{
		{name: "query", run: func() connection.QueryResult { return application.DBQuery(config, "", "GET sample") }},
		{name: "query with cancel", run: func() connection.QueryResult {
			return application.DBQueryWithCancel(config, "", "GET sample", "capability-query")
		}},
		{name: "multi query", run: func() connection.QueryResult {
			return application.DBQueryMulti(config, "", "GET sample", "capability-multi")
		}},
		{name: "isolated query", run: func() connection.QueryResult { return application.DBQueryIsolated(config, "", "GET sample") }},
		{name: "managed transaction", run: func() connection.QueryResult {
			return application.DBQueryMultiTransactional(config, "", "SET sample value", "capability-transaction")
		}},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			connectionCreated = false
			result := tc.run()
			if result.Success {
				t.Fatalf("unsupported source unexpectedly succeeded: %#v", result)
			}
			if result.Message != wantMessage {
				t.Fatalf("message = %q, want %q", result.Message, wantMessage)
			}
			if connectionCreated {
				t.Fatal("unsupported source reached the database constructor")
			}
		})
	}
}
