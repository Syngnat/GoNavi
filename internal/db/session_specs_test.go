package db

import (
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestSessionCapabilityFor(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		config    connection.ConnectionConfig
		engine    string
		supported bool
		cancel    bool
		terminate bool
		reason    string
	}{
		{name: "mysql", config: connection.ConnectionConfig{Type: "mysql"}, engine: "mysql", supported: true, cancel: true, terminate: true},
		{name: "mariadb", config: connection.ConnectionConfig{Type: "mariadb"}, engine: "mariadb", supported: true, cancel: true, terminate: true},
		{name: "goldendb", config: connection.ConnectionConfig{Type: "goldendb"}, engine: "goldendb", supported: true, cancel: true, terminate: true},
		{name: "doris alias", config: connection.ConnectionConfig{Type: "doris"}, engine: "doris", supported: true, cancel: true, terminate: true},
		{name: "starrocks", config: connection.ConnectionConfig{Type: "starrocks"}, engine: "starrocks", supported: true, cancel: true, terminate: true},
		{name: "postgres alias", config: connection.ConnectionConfig{Type: "postgresql"}, engine: "postgres", supported: true, cancel: true, terminate: true},
		{name: "kingbase alias", config: connection.ConnectionConfig{Type: "kingbasees"}, engine: "kingbase", supported: true, cancel: true, terminate: true},
		{name: "highgo", config: connection.ConnectionConfig{Type: "highgo"}, engine: "highgo", supported: true, cancel: true, terminate: true},
		{name: "vastbase", config: connection.ConnectionConfig{Type: "vastbase"}, engine: "vastbase", supported: true, cancel: true, terminate: true},
		{name: "opengauss alias", config: connection.ConnectionConfig{Type: "open-gauss"}, engine: "opengauss", supported: true, cancel: true, terminate: true},
		{name: "gaussdb alias", config: connection.ConnectionConfig{Type: "gauss-db"}, engine: "gaussdb", supported: true, cancel: true, terminate: true},
		{name: "oracle", config: connection.ConnectionConfig{Type: "oracle"}, engine: "oracle", supported: true, terminate: true},
		{name: "sqlserver alias", config: connection.ConnectionConfig{Type: "sql-server"}, engine: "sqlserver", supported: true, terminate: true},
		{name: "dameng", config: connection.ConnectionConfig{Type: "dameng"}, engine: "dameng", supported: true, terminate: true},
		{name: "dameng alias", config: connection.ConnectionConfig{Type: "dm8"}, engine: "dameng", supported: true, terminate: true},
		{name: "clickhouse", config: connection.ConnectionConfig{Type: "clickhouse"}, engine: "clickhouse", supported: true, cancel: true},
		{name: "trino", config: connection.ConnectionConfig{Type: "trino"}, engine: "trino", supported: true, cancel: true},
		{name: "tdengine probe pending", config: connection.ConnectionConfig{Type: "tdengine"}, engine: "tdengine", reason: sessionReasonUnsupported},
		{name: "iotdb probe pending", config: connection.ConnectionConfig{Type: "iotdb"}, engine: "iotdb", reason: sessionReasonUnsupported},
		{name: "iotdb alias probe pending", config: connection.ConnectionConfig{Type: "apache-iotdb"}, engine: "iotdb", reason: sessionReasonUnsupported},
		{name: "mongodb unsupported", config: connection.ConnectionConfig{Type: "mongodb"}, engine: "mongodb", reason: sessionReasonUnsupported},
		{name: "elasticsearch unsupported", config: connection.ConnectionConfig{Type: "elasticsearch"}, engine: "elasticsearch", reason: sessionReasonUnsupported},
		{name: "iris unsupported", config: connection.ConnectionConfig{Type: "iris"}, engine: "iris", reason: sessionReasonUnsupported},
		{name: "sphinx unsupported", config: connection.ConnectionConfig{Type: "sphinx"}, engine: "sphinx", reason: sessionReasonUnsupported},
		{name: "sqlite not applicable", config: connection.ConnectionConfig{Type: "sqlite"}, engine: "sqlite", reason: sessionReasonNotApplicable},
		{name: "redis not applicable", config: connection.ConnectionConfig{Type: "redis"}, engine: "redis", reason: sessionReasonNotApplicable},
		{name: "custom clickhouse", config: connection.ConnectionConfig{Type: "custom", Driver: "clickhouse"}, engine: "clickhouse", supported: true, cancel: true},
		{name: "custom oceanbase oracle", config: connection.ConnectionConfig{Type: "custom", Driver: "oceanbase", OceanBaseProtocol: "oracle"}, engine: "oceanbase-oracle", supported: true, terminate: true},
		{name: "custom oceanbase oracle from params", config: connection.ConnectionConfig{Type: "custom", Driver: "oceanbase", ConnectionParams: "protocol=oracle"}, engine: "oceanbase-oracle", supported: true, terminate: true},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			engine, capability := SessionCapabilityFor(test.config)
			if engine != test.engine {
				t.Fatalf("engine = %q, want %q", engine, test.engine)
			}
			if capability.Supported != test.supported || capability.CanCancelQuery != test.cancel || capability.CanTerminateSession != test.terminate {
				t.Fatalf("capability = %+v", capability)
			}
			if capability.ReasonCode != test.reason {
				t.Fatalf("reason = %q, want %q", capability.ReasonCode, test.reason)
			}
		})
	}
}

func TestTrinoSessionSpecUsesLiveQueryTableColumns(t *testing.T) {
	t.Parallel()

	query := strings.ToLower(trinoSessionSpec().listQuery)
	if strings.Contains(query, "catalog as database_or_tenant") {
		t.Fatal("Trino runtime.queries must not reference a nonexistent catalog column")
	}
	for _, fragment := range []string{
		"'' as database_or_tenant",
		"from system.runtime.queries",
		"where \"end\" is null",
	} {
		if !strings.Contains(query, fragment) {
			t.Fatalf("Trino session query missing %q: %s", fragment, query)
		}
	}
}

func TestSessionCapabilityForOceanBaseProtocols(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		config    connection.ConnectionConfig
		engine    string
		cancel    bool
		terminate bool
	}{
		{name: "explicit mysql", config: connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "mysql"}, engine: "oceanbase-mysql", cancel: true, terminate: true},
		{name: "explicit oracle", config: connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "oracle"}, engine: "oceanbase-oracle", terminate: true},
		{name: "connection params", config: connection.ConnectionConfig{Type: "oceanbase", ConnectionParams: "protocol=oracle"}, engine: "oceanbase-oracle", terminate: true},
		{name: "uri", config: connection.ConnectionConfig{Type: "oceanbase", URI: "oceanbase://localhost/test?compatMode=oracle"}, engine: "oceanbase-oracle", terminate: true},
		{name: "default", config: connection.ConnectionConfig{Type: "oceanbase"}, engine: "oceanbase-mysql", cancel: true, terminate: true},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			engine, capability := SessionCapabilityFor(test.config)
			if engine != test.engine {
				t.Fatalf("engine = %q, want %q", engine, test.engine)
			}
			if !capability.Supported || capability.CanCancelQuery != test.cancel || capability.CanTerminateSession != test.terminate {
				t.Fatalf("capability = %+v", capability)
			}
			if test.engine == "oceanbase-oracle" && (capability.CanCancelQuery || !capability.TerminateRequiresInstanceAndSerial) {
				t.Fatalf("OceanBase Oracle capability = %+v", capability)
			}
		})
	}
}

func TestSessionCapabilityActionTargetsMatchAdapterContract(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name            string
		config          connection.ConnectionConfig
		cancelTarget    connection.SessionActionTarget
		terminateTarget connection.SessionActionTarget
	}{
		{name: "mysql", config: connection.ConnectionConfig{Type: "mysql"}, cancelTarget: connection.SessionActionTargetSessionID, terminateTarget: connection.SessionActionTargetSessionID},
		{name: "doris", config: connection.ConnectionConfig{Type: "doris"}, cancelTarget: connection.SessionActionTargetQueryID, terminateTarget: connection.SessionActionTargetSessionID},
		{name: "starrocks", config: connection.ConnectionConfig{Type: "starrocks"}, cancelTarget: connection.SessionActionTargetQueryID, terminateTarget: connection.SessionActionTargetSessionID},
		{name: "postgres", config: connection.ConnectionConfig{Type: "postgres"}, cancelTarget: connection.SessionActionTargetSessionID, terminateTarget: connection.SessionActionTargetSessionID},
		{name: "oracle", config: connection.ConnectionConfig{Type: "oracle"}, terminateTarget: connection.SessionActionTargetSessionID},
		{name: "oceanbase mysql", config: connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "mysql"}, cancelTarget: connection.SessionActionTargetSessionID, terminateTarget: connection.SessionActionTargetSessionID},
		{name: "oceanbase oracle", config: connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "oracle"}, terminateTarget: connection.SessionActionTargetSessionID},
		{name: "sqlserver", config: connection.ConnectionConfig{Type: "sqlserver"}, terminateTarget: connection.SessionActionTargetSessionID},
		{name: "dameng", config: connection.ConnectionConfig{Type: "dameng"}, terminateTarget: connection.SessionActionTargetSessionID},
		{name: "clickhouse", config: connection.ConnectionConfig{Type: "clickhouse"}, cancelTarget: connection.SessionActionTargetQueryID},
		{name: "trino", config: connection.ConnectionConfig{Type: "trino"}, cancelTarget: connection.SessionActionTargetQueryID},
		{name: "tdengine probe pending", config: connection.ConnectionConfig{Type: "tdengine"}},
		{name: "iotdb probe pending", config: connection.ConnectionConfig{Type: "iotdb"}},
		{name: "sqlite not applicable", config: connection.ConnectionConfig{Type: "sqlite"}},
		{name: "mongodb unsupported", config: connection.ConnectionConfig{Type: "mongodb"}},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, capability := SessionCapabilityFor(test.config)
			if capability.CancelTarget != test.cancelTarget {
				t.Fatalf("cancel target = %q, want %q", capability.CancelTarget, test.cancelTarget)
			}
			if capability.TerminateTarget != test.terminateTarget {
				t.Fatalf("terminate target = %q, want %q", capability.TerminateTarget, test.terminateTarget)
			}
		})
	}
}

func TestPostgresSessionDurationAnchorsIdleRowsAtStateChange(t *testing.T) {
	t.Parallel()

	for _, engine := range []string{"postgres", "kingbase", "vastbase", "opengauss", "gaussdb", "highgo"} {
		engine := engine
		t.Run(engine, func(t *testing.T) {
			t.Parallel()
			query := strings.ToLower(sessionSpecFor(connection.ConnectionConfig{Type: engine}).listQuery)
			// An idle session must not keep reporting how long ago its last
			// statement started, which is what turned idle rows into "36 d".
			if !strings.Contains(query, "when coalesce(state, '') = 'idle' then coalesce(state_change") {
				t.Fatalf("idle rows must count from state_change:\n%s", query)
			}
			if !strings.Contains(query, "when coalesce(state, '') in ('active'") {
				t.Fatalf("running rows must keep counting from query_start:\n%s", query)
			}
			if !strings.Contains(query, "order by state_change") {
				t.Fatalf("longest-running rows must sort first:\n%s", query)
			}
		})
	}
}

func TestPostgresSessionListHidesServerProcessesOnlyForPostgresLineage(t *testing.T) {
	t.Parallel()

	tests := []struct {
		engine     string
		wantFilter bool
	}{
		{engine: "postgres", wantFilter: true},
		{engine: "kingbase", wantFilter: true},
		{engine: "highgo", wantFilter: true},
		// openGauss-derived engines keep the unfiltered query.
		{engine: "opengauss", wantFilter: false},
		{engine: "gaussdb", wantFilter: false},
		{engine: "vastbase", wantFilter: false},
	}
	for _, test := range tests {
		test := test
		t.Run(test.engine, func(t *testing.T) {
			t.Parallel()
			spec := sessionSpecFor(connection.ConnectionConfig{Type: test.engine})
			if got := strings.Contains(spec.listQuery, "client_port IS NOT NULL"); got != test.wantFilter {
				t.Fatalf("client filter present = %v, want %v\n%s", got, test.wantFilter, spec.listQuery)
			}
			if !strings.Contains(spec.listQuery, "pid <> pg_backend_pid()") {
				t.Fatalf("query must still exclude its own backend:\n%s", spec.listQuery)
			}
		})
	}
}
