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
		name        string
		config      connection.ConnectionConfig
		wantType    string
		query       bool
		metadata    bool
		transaction bool
	}{
		{
			name:        "builtin mysql",
			config:      connection.ConnectionConfig{Type: "mysql"},
			wantType:    "mysql",
			query:       true,
			metadata:    true,
			transaction: true,
		},
		{
			name:        "driver agent sqlite alias",
			config:      connection.ConnectionConfig{Type: "sqlite3"},
			wantType:    "sqlite",
			query:       true,
			metadata:    true,
			transaction: true,
		},
		{
			name:        "custom oceanbase oracle",
			config:      connection.ConnectionConfig{Type: "custom", Driver: "oceanbase", OceanBaseProtocol: "oracle"},
			wantType:    "oracle",
			query:       true,
			metadata:    true,
			transaction: true,
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
