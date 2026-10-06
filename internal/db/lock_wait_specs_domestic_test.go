package db

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestOceanBaseLockWaitQueriesFollowTheTenantMode(t *testing.T) {
	t.Parallel()

	mysql := lockWaitSpecFor(connection.ConnectionConfig{Type: "oceanbase"})
	variants := mysql.sources[0].variants
	if len(variants) != 2 {
		t.Fatalf("MySQL tenant needs a plain fallback variant, got %d", len(variants))
	}
	for _, fragment := range []string{
		"FROM oceanbase.GV$OB_LOCKS w",
		"bp.TRANS_ID = w.ID1",
		"w.TYPE = 'TX' AND w.BLOCK = 1",
		"r.TYPE = 'TR' AND r.BLOCK = 1",
		"DBA_OB_TABLE_LOCATIONS",
		"GV$OB_TRANSACTION_PARTICIPANTS",
	} {
		if !strings.Contains(variants[0], fragment) {
			t.Fatalf("MySQL tenant query lacks %q:\n%s", fragment, variants[0])
		}
	}
	if strings.Contains(variants[1], "DBA_OB_TABLE_LOCATIONS") || strings.Contains(variants[1], "PARTICIPANTS") {
		t.Fatalf("the fallback must not depend on the lookup views:\n%s", variants[1])
	}

	oracle := lockWaitSpecFor(connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "oracle"})
	query := oracle.sources[0].variants[0]
	for _, fragment := range []string{"FROM SYS.GV$OB_LOCKS w", `wp."USER" AS waiting_user`, "bp.TRANS_ID = w.ID1"} {
		if !strings.Contains(query, fragment) {
			t.Fatalf("Oracle tenant query lacks %q:\n%s", fragment, query)
		}
	}
	if strings.Contains(query, "LIMIT") || strings.Contains(query, "CONCAT(") {
		t.Fatalf("Oracle tenant query uses MySQL syntax:\n%s", query)
	}
}

func TestOceanBaseLockWaitsFallBackWithoutLookupViews(t *testing.T) {
	t.Parallel()

	var queries []string
	database := &sessionActionTestDatabase{
		query: func(_ context.Context, query string) ([]map[string]interface{}, []string, error) {
			queries = append(queries, query)
			if strings.Contains(query, "DBA_OB_TABLE_LOCATIONS") {
				return nil, nil, errors.New("Error 1142: SELECT command denied")
			}
			return []map[string]interface{}{{
				"waiting_session_id": "3221487726", "blocking_session_id": "3221487722",
				"object_name": "tablet 200051", "lock_type": "TR", "lock_mode": "X", "wait_ms": "20000",
				"blocking_state": "Sleep",
			}}, nil, nil
		},
	}
	payload, err := NewLockWaitInspector(database, connection.ConnectionConfig{Type: "oceanbase"}).ListLockWaits(context.Background())
	if err != nil {
		t.Fatalf("ListLockWaits: %v", err)
	}
	if len(queries) != 2 || len(payload.Waits) != 1 {
		t.Fatalf("queries = %d, waits = %+v", len(queries), payload.Waits)
	}
	if wait := payload.Waits[0]; wait.ObjectName != "tablet 200051" || wait.WaitDurationMs != 20000 {
		t.Fatalf("wait = %+v", wait)
	}
}

func TestDamengLockWaitQueryJoinsWaitsToSessions(t *testing.T) {
	t.Parallel()

	spec := lockWaitSpecFor(connection.ConnectionConfig{Type: "dm8"})
	if spec.engine != "dameng" || len(spec.sources[0].variants) != 2 {
		t.Fatalf("spec = %+v", spec)
	}
	query := spec.sources[0].variants[0]
	for _, fragment := range []string{"FROM V$TRXWAIT w", "ws.TRX_ID = w.ID", "bs.TRX_ID = w.WAIT_FOR_ID", "l.BLOCKED = 1", "SYSOBJECTS"} {
		if !strings.Contains(query, fragment) {
			t.Fatalf("Dameng query lacks %q:\n%s", fragment, query)
		}
	}
	if strings.Contains(spec.sources[0].variants[1], "SYSOBJECTS") {
		t.Fatal("the fallback must not read SYSOBJECTS")
	}
}

func TestYashanDBLockWaitRowsCarrySerialNumbers(t *testing.T) {
	t.Parallel()

	spec := yashanDBLockWaitSpec()
	query := spec.sources[0].variants[0]
	if !strings.Contains(query, "b.XID = w.LOCKWAIT") || !strings.Contains(query, "NVL(b.SQL_ID, b.PREV_SQL_ID)") {
		t.Fatalf("query = %s", query)
	}
	// Captured from YashanDB 23.4: session 36 waits for the idle session 35.
	waits := normalizeLockWaitRows(spec, []map[string]interface{}{{
		"WAITING_SESSION_ID": "36", "WAITING_SERIAL_NUMBER": "61", "WAITING_USER": "GONAVI",
		"WAITING_STATEMENT": "UPDATE LOCKDEMO SET STATUS = 'waiting' WHERE ID = 1", "WAIT_MS": "26000",
		"BLOCKING_SESSION_ID": "35", "BLOCKING_SERIAL_NUMBER": "17", "BLOCKING_USER": "GONAVI",
		"BLOCKING_STATE": "INACTIVE", "BLOCKING_STATEMENT": "UPDATE LOCKDEMO SET STATUS = 'held' WHERE ID = 1",
		"BLOCKING_MS": "29000", "OBJECT_NAME": "GONAVI.LOCKDEMO", "LOCK_TYPE": "row xact wait",
	}})
	if len(waits) != 1 {
		t.Fatalf("waits = %+v", waits)
	}
	wait := waits[0]
	if wait.BlockingSerialNumber != "17" || wait.WaitingSerialNumber != "61" || wait.ObjectName != "GONAVI.LOCKDEMO" ||
		wait.WaitDurationMs != 26000 || wait.BlockingDurationMs != 29000 {
		t.Fatalf("wait = %+v", wait)
	}
}

func TestYashanDBSessionsAreAddressedBySidAndSerial(t *testing.T) {
	t.Parallel()

	engine, capability := SessionCapabilityFor(connection.ConnectionConfig{Type: "yashandb"})
	if engine != "yashandb" || !capability.Supported || !capability.CanCancelQuery || !capability.CanTerminateSession ||
		!capability.RequiresSerial || capability.TerminateRequiresInstanceAndSerial {
		t.Fatalf("engine = %q capability = %+v", engine, capability)
	}
	spec := sessionSpecFor(connection.ConnectionConfig{Type: "yashandb"})
	for _, test := range []struct {
		action connection.SessionAction
		want   string
	}{
		{action: connection.SessionActionCancelQuery, want: "ALTER SYSTEM CANCEL SQL '36,61'"},
		{action: connection.SessionActionTerminateSession, want: "ALTER SYSTEM KILL SESSION '35,17'"},
	} {
		request := connection.SessionActionRequest{Action: test.action, SessionID: "36", SerialNumber: "61"}
		if test.action == connection.SessionActionTerminateSession {
			request = connection.SessionActionRequest{Action: test.action, SessionID: "35", SerialNumber: "17"}
		}
		statement, err := buildSessionActionStatement(spec, request)
		if err != nil || statement.sql != test.want {
			t.Fatalf("%s: sql = %q err = %v, want %q", test.action, statement.sql, err, test.want)
		}
	}
	if _, err := buildSessionActionStatement(spec, connection.SessionActionRequest{
		Action: connection.SessionActionTerminateSession, SessionID: "35",
	}); err == nil {
		t.Fatal("a kill without serial# could hit a reused SID")
	}
	rows := normalizeSessionRows(spec, []map[string]interface{}{{
		"SESSION_ID": "36", "SERIAL_NUMBER": "61", "USER_NAME": "GONAVI", "STATE": "ACTIVE", "DURATION_MS": "26000",
	}}, "")
	if rows[0].SerialNumber != "61" || rows[0].DurationMs != 26000 {
		t.Fatalf("row = %+v", rows[0])
	}
}

func TestGBase8cUsesTheOpenGaussSessionAndLockQueries(t *testing.T) {
	t.Parallel()

	engine, capability := SessionCapabilityFor(connection.ConnectionConfig{Type: "gbase8c"})
	if engine != "gbase8c" || !capability.CanCancelQuery || !capability.CanTerminateSession {
		t.Fatalf("engine = %q capability = %+v", engine, capability)
	}
	spec := lockWaitSpecFor(connection.ConnectionConfig{Type: "gbase8c"})
	if !spec.filterCompatibleModes || spec.sources[0].variants[0] != postgresLockTagLockWaitQuery {
		t.Fatalf("GBase 8c (openGauss kernel) must use the lock-tag query: %+v", spec)
	}
	statement, err := buildSessionActionStatement(sessionSpecFor(connection.ConnectionConfig{Type: "gbase8c"}),
		connection.SessionActionRequest{Action: connection.SessionActionTerminateSession, SessionID: "140213"})
	if err != nil || statement.sql != "SELECT pg_terminate_backend(140213) AS action_succeeded" {
		t.Fatalf("sql = %q err = %v", statement.sql, err)
	}
}
