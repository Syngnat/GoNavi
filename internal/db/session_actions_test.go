package db

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

type sessionActionTestDatabase struct {
	Database
	query func(context.Context, string) ([]map[string]interface{}, []string, error)
	exec  func(context.Context, string) (int64, error)
}

func (d *sessionActionTestDatabase) QueryContext(ctx context.Context, query string) ([]map[string]interface{}, []string, error) {
	return d.query(ctx, query)
}

func (d *sessionActionTestDatabase) ExecContext(ctx context.Context, query string) (int64, error) {
	return d.exec(ctx, query)
}

func TestBuildSessionActionStatement(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		engine  string
		request connection.SessionActionRequest
		wantSQL string
		query   bool
	}{
		{name: "mysql cancel", engine: "mysql", request: actionRequest(connection.SessionActionCancelQuery, "12", ""), wantSQL: "KILL QUERY 12"},
		{name: "mysql terminate", engine: "mysql", request: actionRequest(connection.SessionActionTerminateSession, "12", ""), wantSQL: "KILL CONNECTION 12"},
		{name: "doris query id", engine: "doris", request: actionRequest(connection.SessionActionCancelQuery, "12", "query-1:2"), wantSQL: "KILL QUERY 'query-1:2'"},
		{name: "postgres cancel", engine: "postgres", request: actionRequest(connection.SessionActionCancelQuery, "42", ""), wantSQL: "SELECT pg_cancel_backend(42) AS action_succeeded", query: true},
		{name: "postgres terminate", engine: "postgres", request: actionRequest(connection.SessionActionTerminateSession, "42", ""), wantSQL: "SELECT pg_terminate_backend(42) AS action_succeeded", query: true},
		{name: "oracle terminate", engine: "oracle", request: connection.SessionActionRequest{Action: connection.SessionActionTerminateSession, SessionID: "5", SerialNumber: "7", InstanceID: "2"}, wantSQL: "ALTER SYSTEM KILL SESSION '5,7,@2' IMMEDIATE"},
		{name: "oceanbase oracle terminate", engine: "oceanbase-oracle", request: connection.SessionActionRequest{Action: connection.SessionActionTerminateSession, SessionID: "8", SerialNumber: "11", InstanceID: "2"}, wantSQL: "ALTER SYSTEM KILL SESSION '8,11,@2' IMMEDIATE"},
		{name: "sqlserver terminate", engine: "sqlserver", request: actionRequest(connection.SessionActionTerminateSession, "51", ""), wantSQL: "KILL 51"},
		{name: "dameng terminate", engine: "dameng", request: actionRequest(connection.SessionActionTerminateSession, "91", ""), wantSQL: "CALL SP_CLOSE_SESSION(91)"},
		{name: "clickhouse quote", engine: "clickhouse", request: actionRequest(connection.SessionActionCancelQuery, "", "query'7"), wantSQL: "KILL QUERY WHERE query_id = 'query''7' SYNC"},
		{name: "trino quote", engine: "trino", request: actionRequest(connection.SessionActionCancelQuery, "", "query'7"), wantSQL: "CALL system.runtime.kill_query(query_id => 'query''7', message => 'Cancelled from GoNavi session workbench')"},
		{name: "tdengine cancel", engine: "tdengine", request: actionRequest(connection.SessionActionCancelQuery, "session-1", "query-1"), wantSQL: "KILL QUERY 'query-1'"},
		{name: "tdengine terminate", engine: "tdengine", request: actionRequest(connection.SessionActionTerminateSession, "42", "query-1"), wantSQL: "KILL CONNECTION 42"},
		{name: "iotdb cancel", engine: "iotdb", request: actionRequest(connection.SessionActionCancelQuery, "", "query-3"), wantSQL: "KILL QUERY query-3"},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			spec := sessionSpec{engine: test.engine, capability: connection.SessionCapability{Supported: true, CanCancelQuery: true, CanTerminateSession: true}}
			statement, err := buildSessionActionStatement(spec, test.request)
			if err != nil {
				t.Fatalf("build action: %v", err)
			}
			if statement.sql != test.wantSQL || statement.expectBoolean != test.query {
				t.Fatalf("statement = %+v, want SQL %q query=%v", statement, test.wantSQL, test.query)
			}
		})
	}
}

func TestBuildSessionActionStatementRejectsWrongIdentifierOrInjection(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		engine  string
		request connection.SessionActionRequest
	}{
		{name: "numeric injection", engine: "mysql", request: actionRequest(connection.SessionActionTerminateSession, "1; DROP TABLE users", "")},
		{name: "query id cannot replace mysql session id", engine: "mysql", request: actionRequest(connection.SessionActionCancelQuery, "", "query-1")},
		{name: "session id cannot replace clickhouse query id", engine: "clickhouse", request: actionRequest(connection.SessionActionCancelQuery, "12", "")},
		{name: "Doris rejects quote", engine: "doris", request: actionRequest(connection.SessionActionCancelQuery, "12", `query"1`)},
		{name: "string control character", engine: "trino", request: actionRequest(connection.SessionActionCancelQuery, "", "query\n1")},
		{name: "Oracle serial missing", engine: "oracle", request: connection.SessionActionRequest{Action: connection.SessionActionTerminateSession, SessionID: "5", InstanceID: "2"}},
		{name: "Oracle instance missing", engine: "oracle", request: connection.SessionActionRequest{Action: connection.SessionActionTerminateSession, SessionID: "5", SerialNumber: "7"}},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			spec := sessionSpec{engine: test.engine, capability: connection.SessionCapability{Supported: true, CanCancelQuery: true, CanTerminateSession: true}}
			if _, err := buildSessionActionStatement(spec, test.request); err == nil {
				t.Fatal("expected identifier validation error")
			}
		})
	}
}

func TestBuildSessionActionStatementHonorsSingleActionAdapters(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		engine  string
		request connection.SessionActionRequest
	}{
		{name: "oracle cancel", engine: "oracle", request: actionRequest(connection.SessionActionCancelQuery, "5", "")},
		{name: "oceanbase oracle cancel", engine: "oceanbase-oracle", request: actionRequest(connection.SessionActionCancelQuery, "5", "")},
		{name: "sqlserver cancel", engine: "sqlserver", request: actionRequest(connection.SessionActionCancelQuery, "5", "")},
		{name: "dameng cancel", engine: "dameng", request: actionRequest(connection.SessionActionCancelQuery, "5", "")},
		{name: "clickhouse terminate", engine: "clickhouse", request: actionRequest(connection.SessionActionTerminateSession, "", "query-1")},
		{name: "trino terminate", engine: "trino", request: actionRequest(connection.SessionActionTerminateSession, "", "query-1")},
		{name: "iotdb terminate", engine: "iotdb", request: actionRequest(connection.SessionActionTerminateSession, "", "query-1")},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			capability := sessionSpecFor(connection.ConnectionConfig{Type: test.engine}).capability
			if _, err := buildSessionActionStatement(sessionSpec{engine: test.engine, capability: capability}, test.request); err == nil {
				t.Fatal("expected unsupported action error")
			}
		})
	}
}

func TestBuildSessionActionStatementRejectsUnsupportedCapabilityEvenWhenActionFlagsAreSet(t *testing.T) {
	t.Parallel()

	capability := connection.SessionCapability{
		Supported:           false,
		CanCancelQuery:      true,
		CanTerminateSession: true,
		CancelTarget:        connection.SessionActionTargetSessionID,
		TerminateTarget:     connection.SessionActionTargetSessionID,
	}
	for _, action := range []connection.SessionAction{
		connection.SessionActionCancelQuery,
		connection.SessionActionTerminateSession,
	} {
		if _, err := buildSessionActionStatement(sessionSpec{
			engine:     "mysql",
			capability: capability,
		}, connection.SessionActionRequest{
			Action:    action,
			SessionID: "42",
		}); !errors.Is(err, errSessionActionUnsupported) {
			t.Fatalf("action %q error = %v, want unsupported", action, err)
		}
	}
}

func TestExecuteSessionActionStatementRequiresContextAwareExec(t *testing.T) {
	t.Parallel()

	database := struct{ Database }{}
	err := executeSessionActionStatement(context.Background(), &database, sessionActionStatement{sql: "KILL 1"})
	if !errors.Is(err, errSessionExecContextUnsupported) {
		t.Fatalf("error = %v", err)
	}
}

func TestExecuteSessionActionStatementChecksServerBoolean(t *testing.T) {
	t.Parallel()

	database := &sessionActionTestDatabase{
		query: func(_ context.Context, query string) ([]map[string]interface{}, []string, error) {
			if !strings.Contains(query, "pg_cancel_backend") {
				t.Fatalf("query = %q", query)
			}
			return []map[string]interface{}{{"action_succeeded": false}}, nil, nil
		},
		exec: func(context.Context, string) (int64, error) {
			t.Fatal("ExecContext should not be called")
			return 0, nil
		},
	}
	err := executeSessionActionStatement(context.Background(), database, sessionActionStatement{
		sql:           "SELECT pg_cancel_backend(42) AS action_succeeded",
		expectBoolean: true,
	})
	if err == nil || !strings.Contains(err.Error(), "rejected") {
		t.Fatalf("error = %v", err)
	}
}

func actionRequest(action connection.SessionAction, sessionID, queryID string) connection.SessionActionRequest {
	return connection.SessionActionRequest{Action: action, SessionID: sessionID, QueryID: queryID}
}
