package db

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestLockWaitCapabilityFor(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		config    connection.ConnectionConfig
		engine    string
		supported bool
		reason    string
	}{
		{name: "mysql", config: connection.ConnectionConfig{Type: "mysql"}, engine: "mysql", supported: true},
		{name: "mariadb", config: connection.ConnectionConfig{Type: "mariadb"}, engine: "mariadb", supported: true},
		{name: "postgres", config: connection.ConnectionConfig{Type: "postgresql"}, engine: "postgres", supported: true},
		{name: "kingbase", config: connection.ConnectionConfig{Type: "kingbase"}, engine: "kingbase", supported: true},
		{name: "highgo", config: connection.ConnectionConfig{Type: "highgo"}, engine: "highgo", supported: true},
		{name: "opengauss", config: connection.ConnectionConfig{Type: "opengauss"}, engine: "opengauss", supported: true},
		{name: "vastbase", config: connection.ConnectionConfig{Type: "vastbase"}, engine: "vastbase", supported: true},
		{name: "oracle", config: connection.ConnectionConfig{Type: "oracle"}, engine: "oracle", supported: true},
		{name: "sqlserver", config: connection.ConnectionConfig{Type: "sqlserver"}, engine: "sqlserver", supported: true},
		{name: "custom mysql driver", config: connection.ConnectionConfig{Type: "custom", Driver: "mysql"}, engine: "mysql", supported: true},
		{name: "oceanbase mysql", config: connection.ConnectionConfig{Type: "oceanbase"}, engine: "oceanbase-mysql", supported: true},
		{name: "oceanbase oracle", config: connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "oracle"}, engine: "oceanbase-oracle", supported: true},
		{name: "dameng", config: connection.ConnectionConfig{Type: "dameng"}, engine: "dameng", supported: true},
		{name: "yashandb", config: connection.ConnectionConfig{Type: "yashandb"}, engine: "yashandb", supported: true},
		{name: "gbase8c", config: connection.ConnectionConfig{Type: "gbase8c"}, engine: "gbase8c", supported: true},
		// Sessions are listed, but there is no waiter→holder view.
		{name: "clickhouse", config: connection.ConnectionConfig{Type: "clickhouse"}, engine: "clickhouse", reason: sessionReasonUnsupported},
		{name: "trino", config: connection.ConnectionConfig{Type: "trino"}, engine: "trino", reason: sessionReasonUnsupported},
		{name: "mongodb", config: connection.ConnectionConfig{Type: "mongodb"}, engine: "mongodb", reason: sessionReasonUnsupported},
		{name: "sqlite", config: connection.ConnectionConfig{Type: "sqlite"}, engine: "sqlite", reason: sessionReasonNotApplicable},
		{name: "redis", config: connection.ConnectionConfig{Type: "redis"}, engine: "redis", reason: sessionReasonNotApplicable},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			engine, capability := LockWaitCapabilityFor(test.config)
			if engine != test.engine {
				t.Fatalf("engine = %q, want %q", engine, test.engine)
			}
			if capability.Supported != test.supported || capability.ReasonCode != test.reason {
				t.Fatalf("capability = %+v, want supported=%v reason=%q", capability, test.supported, test.reason)
			}
		})
	}
}

func TestLockWaitSpecsCoverEverySupportedEngine(t *testing.T) {
	t.Parallel()

	for _, config := range []connection.ConnectionConfig{
		{Type: "mysql"}, {Type: "mariadb"}, {Type: "postgres"}, {Type: "kingbase"}, {Type: "highgo"},
		{Type: "opengauss"}, {Type: "vastbase"}, {Type: "gaussdb"}, {Type: "gbase8c"}, {Type: "oracle"},
		{Type: "sqlserver"}, {Type: "dameng"}, {Type: "yashandb"}, {Type: "oceanbase"},
		{Type: "oceanbase", OceanBaseProtocol: "oracle"},
	} {
		engine := config.Type
		spec := lockWaitSpecFor(config)
		if !spec.capability.Supported || len(spec.sources) == 0 {
			t.Fatalf("%s: spec = %+v", engine, spec)
		}
		for _, source := range spec.sources {
			if len(source.variants) == 0 {
				t.Fatalf("%s: a source has no query", engine)
			}
			for _, query := range source.variants {
				lowered := strings.ToLower(query)
				for _, alias := range []string{"waiting_session_id", "blocking_session_id"} {
					if !strings.Contains(lowered, alias) {
						t.Fatalf("%s query lacks %s:\n%s", engine, alias, query)
					}
				}
			}
		}
	}
}

func TestMySQLLockWaitsFallBackToLegacyInnoDBTables(t *testing.T) {
	t.Parallel()

	var queries []string
	database := &sessionActionTestDatabase{
		query: func(_ context.Context, query string) ([]map[string]interface{}, []string, error) {
			queries = append(queries, query)
			switch {
			case strings.Contains(query, "performance_schema.data_lock_waits"):
				return nil, nil, errors.New("Error 1146: Table 'performance_schema.data_lock_waits' doesn't exist")
			case strings.Contains(query, "INNODB_LOCK_WAITS"):
				return []map[string]interface{}{{
					"waiting_session_id": int64(12), "blocking_session_id": int64(9),
					"object_name": "`shop`.`orders`", "lock_type": "RECORD", "lock_mode": "X",
					"wait_ms": "7000", "blocking_ms": "93000",
				}}, nil, nil
			default:
				// performance_schema off: metadata waits are skipped, not fatal.
				return nil, nil, errors.New("performance_schema is disabled")
			}
		},
	}
	payload, err := NewLockWaitInspector(database, connection.ConnectionConfig{Type: "mysql"}).ListLockWaits(context.Background())
	if err != nil {
		t.Fatalf("ListLockWaits: %v", err)
	}
	if len(queries) != 3 {
		t.Fatalf("expected 8.0 query, legacy fallback and metadata query, got %d", len(queries))
	}
	if len(payload.Waits) != 1 {
		t.Fatalf("waits = %+v", payload.Waits)
	}
	wait := payload.Waits[0]
	if wait.WaitingSessionID != "12" || wait.BlockingSessionID != "9" || wait.ObjectName != "shop.orders" ||
		wait.WaitDurationMs != 7000 || wait.BlockingDurationMs != 93000 {
		t.Fatalf("wait = %+v", wait)
	}
}

func TestLockWaitsReportRequiredSourceFailure(t *testing.T) {
	t.Parallel()

	database := &sessionActionTestDatabase{
		query: func(_ context.Context, query string) ([]map[string]interface{}, []string, error) {
			if strings.Contains(query, "pg_blocking_pids") {
				return nil, nil, errors.New("permission denied for pg_blocking_pids")
			}
			return nil, nil, errors.New("fallback failed")
		},
	}
	_, err := NewLockWaitInspector(database, connection.ConnectionConfig{Type: "postgres"}).ListLockWaits(context.Background())
	if err == nil || !strings.Contains(err.Error(), "permission denied for pg_blocking_pids") {
		t.Fatalf("error = %v, want the primary variant error", err)
	}
}

func TestLockWaitsStopAfterCancellation(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	database := &sessionActionTestDatabase{
		query: func(context.Context, string) ([]map[string]interface{}, []string, error) {
			calls++
			cancel()
			return nil, nil, context.Canceled
		},
	}
	_, err := NewLockWaitInspector(database, connection.ConnectionConfig{Type: "mysql"}).ListLockWaits(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v", err)
	}
	if calls != 1 {
		t.Fatalf("a cancelled request must not try more queries, calls = %d", calls)
	}
}

func TestUnsupportedLockWaitsDoNotQuery(t *testing.T) {
	t.Parallel()

	database := &sessionActionTestDatabase{
		query: func(context.Context, string) ([]map[string]interface{}, []string, error) {
			t.Fatal("an unsupported engine must not run a query")
			return nil, nil, nil
		},
	}
	payload, err := NewLockWaitInspector(database, connection.ConnectionConfig{Type: "clickhouse"}).ListLockWaits(context.Background())
	if err != nil || payload.Capability.Supported || payload.Waits == nil {
		t.Fatalf("payload = %+v, err = %v", payload, err)
	}
}
