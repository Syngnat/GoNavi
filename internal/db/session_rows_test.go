package db

import (
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestNormalizeSessionRowsMapsAliasesAndDuration(t *testing.T) {
	t.Parallel()

	rows := []map[string]interface{}{
		{
			"Database / Tenant": []byte("sales"),
			"SESSION_ID":        int64(42),
			"Query-ID":          "query-7",
			"INST_ID":           3,
			"SERIAL#":           "99",
			"SQL_TEXT":          " select * from orders ",
			"STATUS":            "ACTIVE",
			"TIME":              "2.5",
			"USER_NAME":         "analyst",
		},
	}

	sessions := normalizeSessionRows(sessionSpec{engine: "oracle", durationUnit: sessionDurationSeconds}, rows, "fallback")
	if len(sessions) != 1 {
		t.Fatalf("sessions = %d, want 1", len(sessions))
	}
	session := sessions[0]
	if session.DatabaseOrTenant != "sales" || session.SessionID != "42" || session.QueryID != "query-7" {
		t.Fatalf("identifier mapping = %+v", session)
	}
	if session.InstanceID != "3" || session.SerialNumber != "99" {
		t.Fatalf("Oracle identifiers = %+v", session)
	}
	if session.Statement != "select * from orders" || session.State != "ACTIVE" || session.User != "analyst" {
		t.Fatalf("text mapping = %+v", session)
	}
	if session.DurationMs != 2500 {
		t.Fatalf("duration = %d, want 2500", session.DurationMs)
	}
	if session.Key != "oracle:3:42:99:query-7" {
		t.Fatalf("key = %q", session.Key)
	}
}

func TestNormalizeSessionRowsUsesFallbackAndDurationUnits(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		row  map[string]interface{}
		unit sessionDurationUnit
		want int64
	}{
		{name: "explicit milliseconds", row: map[string]interface{}{"duration_ms": int64(125)}, unit: sessionDurationSeconds, want: 125},
		{name: "seconds", row: map[string]interface{}{"elapsed": 3}, unit: sessionDurationSeconds, want: 3000},
		{name: "microseconds", row: map[string]interface{}{"exec_usec": 2500}, unit: sessionDurationMilliseconds, want: 2},
		{name: "negative clamped", row: map[string]interface{}{"duration_ms": -3}, unit: sessionDurationMilliseconds, want: 0},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			sessions := normalizeSessionRows(sessionSpec{engine: "test", durationUnit: test.unit}, []map[string]interface{}{test.row}, "tenant-a")
			if sessions[0].DatabaseOrTenant != "tenant-a" {
				t.Fatalf("database = %q", sessions[0].DatabaseOrTenant)
			}
			if sessions[0].DurationMs != test.want {
				t.Fatalf("duration = %d, want %d", sessions[0].DurationMs, test.want)
			}
		})
	}
}

func TestBuildDatabaseSessionKeyKeepsIdentifiersSeparate(t *testing.T) {
	t.Parallel()

	session := connection.DatabaseSession{SessionID: "session-1", QueryID: "query-1"}
	if got := buildDatabaseSessionKey("test", session, 0); got != "test::session-1::query-1" {
		t.Fatalf("key = %q", got)
	}
	if got := buildDatabaseSessionKey("test", connection.DatabaseSession{}, 7); got != "test:row:7" {
		t.Fatalf("fallback key = %q", got)
	}
}

func TestNormalizeSessionRowsKeepsEmptyDatabaseForAuthoritativeEngines(t *testing.T) {
	t.Parallel()

	rows := []map[string]interface{}{{"session_id": 5, "user_name": "event_scheduler"}}
	authoritative := normalizeSessionRows(sessionSpec{engine: "mysql", rowDatabaseAuthoritative: true}, rows, "default_db")
	if got := authoritative[0].DatabaseOrTenant; got != "" {
		t.Fatalf("authoritative engine borrowed the connection database: %q", got)
	}
	// Engines whose query cannot report a database keep showing the
	// connection's database as context.
	fallback := normalizeSessionRows(sessionSpec{engine: "trino"}, rows, "default_db")
	if got := fallback[0].DatabaseOrTenant; got != "default_db" {
		t.Fatalf("fallback database = %q", got)
	}
}
