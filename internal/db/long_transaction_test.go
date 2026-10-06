package db

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestLongTransactionCapabilityFor(t *testing.T) {
	t.Parallel()

	tests := []struct {
		config    connection.ConnectionConfig
		engine    string
		supported bool
		reason    string
	}{
		{config: connection.ConnectionConfig{Type: "mysql"}, engine: "mysql", supported: true},
		{config: connection.ConnectionConfig{Type: "mariadb"}, engine: "mariadb", supported: true},
		{config: connection.ConnectionConfig{Type: "postgres"}, engine: "postgres", supported: true},
		{config: connection.ConnectionConfig{Type: "kingbase"}, engine: "kingbase", supported: true},
		{config: connection.ConnectionConfig{Type: "opengauss"}, engine: "opengauss", supported: true},
		{config: connection.ConnectionConfig{Type: "gbase8c"}, engine: "gbase8c", supported: true},
		{config: connection.ConnectionConfig{Type: "oracle"}, engine: "oracle", supported: true},
		{config: connection.ConnectionConfig{Type: "sqlserver"}, engine: "sqlserver", supported: true},
		{config: connection.ConnectionConfig{Type: "yashandb"}, engine: "yashandb", supported: true},
		{config: connection.ConnectionConfig{Type: "oceanbase"}, engine: "oceanbase-mysql", supported: true},
		// No transaction start time is exposed in a form verified so far.
		{config: connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "oracle"}, engine: "oceanbase-oracle", reason: sessionReasonUnsupported},
		{config: connection.ConnectionConfig{Type: "dameng"}, engine: "dameng", reason: sessionReasonUnsupported},
		{config: connection.ConnectionConfig{Type: "clickhouse"}, engine: "clickhouse", reason: sessionReasonUnsupported},
		{config: connection.ConnectionConfig{Type: "sqlite"}, engine: "sqlite", reason: sessionReasonNotApplicable},
	}
	for _, test := range tests {
		engine, capability := LongTransactionCapabilityFor(test.config)
		if engine != test.engine || capability.Supported != test.supported || capability.ReasonCode != test.reason {
			t.Fatalf("%+v: engine = %q capability = %+v", test.config, engine, capability)
		}
		if test.supported {
			for _, query := range longTransactionSpecFor(test.config).variants {
				if !strings.Contains(query, "duration_ms") || !strings.Contains(query, "session_id") {
					t.Fatalf("%s query lacks the shared aliases:\n%s", engine, query)
				}
			}
		}
	}
}

func TestPostgresLongTransactionsSkipBackgroundWorkers(t *testing.T) {
	t.Parallel()

	query := longTransactionSpecFor(connection.ConnectionConfig{Type: "postgres"}).variants[0]
	for _, fragment := range []string{"xact_start IS NOT NULL", "client_port IS NOT NULL", "pid <> pg_backend_pid()"} {
		if !strings.Contains(query, fragment) {
			t.Fatalf("query lacks %q:\n%s", fragment, query)
		}
	}
}

func TestLongTransactionsNormalizeRowsAndFallBack(t *testing.T) {
	t.Parallel()

	var queries []string
	database := &sessionActionTestDatabase{
		query: func(_ context.Context, query string) ([]map[string]interface{}, []string, error) {
			queries = append(queries, query)
			if strings.Contains(query, "events_statements_current") {
				return nil, nil, errors.New("performance_schema is disabled")
			}
			return []map[string]interface{}{{
				"session_id": int64(9), "user_name": "app", "database_or_tenant": "shop", "state": "Sleep",
				"duration_ms": "650000", "statement": "",
			}}, nil, nil
		},
	}
	payload, err := NewLongTransactionInspector(database, connection.ConnectionConfig{Type: "mysql"}).ListLongTransactions(context.Background())
	if err != nil {
		t.Fatalf("ListLongTransactions: %v", err)
	}
	if len(queries) != 2 || len(payload.Transactions) != 1 {
		t.Fatalf("queries = %d, transactions = %+v", len(queries), payload.Transactions)
	}
	trx := payload.Transactions[0]
	if trx.SessionID != "9" || trx.DurationMs != 650000 || trx.DatabaseOrTenant != "shop" || trx.Key == "" {
		t.Fatalf("transaction = %+v", trx)
	}
}

func TestUnsupportedLongTransactionsDoNotQuery(t *testing.T) {
	t.Parallel()

	database := &sessionActionTestDatabase{
		query: func(context.Context, string) ([]map[string]interface{}, []string, error) {
			t.Fatal("an unsupported engine must not run a query")
			return nil, nil, nil
		},
	}
	payload, err := NewLongTransactionInspector(database, connection.ConnectionConfig{Type: "dameng"}).ListLongTransactions(context.Background())
	if err != nil || payload.Capability.Supported || payload.Transactions == nil {
		t.Fatalf("payload = %+v err = %v", payload, err)
	}
}
