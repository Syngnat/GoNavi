package db

import (
	"context"
	"errors"
	"strings"
	"testing"

	"GoNavi-Wails/internal/connection"
)

func TestOceanBaseSessionSpecsUseTenantProcesslistView(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		protocol     string
		wantView     string
		wantSelf     string
		wantFallback string
	}{
		{
			name:         "mysql tenant",
			protocol:     "mysql",
			wantView:     "FROM oceanbase.GV$OB_PROCESSLIST",
			wantSelf:     "ID <> CONNECTION_ID()",
			wantFallback: "INFORMATION_SCHEMA.PROCESSLIST",
		},
		{
			name:         "oracle tenant",
			protocol:     "oracle",
			wantView:     "FROM SYS.GV$OB_PROCESSLIST",
			wantSelf:     "SYS_CONTEXT('USERENV', 'SID')",
			wantFallback: "SHOW FULL PROCESSLIST",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			spec := sessionSpecFor(connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: test.protocol})
			if !strings.Contains(spec.listQuery, test.wantView) || !strings.Contains(spec.listQuery, test.wantSelf) {
				t.Fatalf("list query must read the cluster-wide view and skip its own session:\n%s", spec.listQuery)
			}
			lowered := strings.ToLower(spec.listQuery)
			// Oracle tenants have neither view; querying them failed on every
			// real OceanBase Oracle server.
			if strings.Contains(lowered, "gv$session") || strings.Contains(lowered, "gv$sql") {
				t.Fatalf("OceanBase must not use Oracle's session views:\n%s", spec.listQuery)
			}
			if len(spec.fallbackListQueries) != 1 || !strings.Contains(spec.fallbackListQueries[0], test.wantFallback) {
				t.Fatalf("fallback queries = %q, want one containing %q", spec.fallbackListQueries, test.wantFallback)
			}
		})
	}
}

func TestOceanBaseOracleSessionQueryQuotesUserColumn(t *testing.T) {
	t.Parallel()

	spec := oceanBaseOracleSessionSpec()
	// A bare USER is Oracle's USER function and would report the current
	// login for every row instead of each session's owner.
	if !strings.Contains(spec.listQuery, `"USER" AS user_name`) {
		t.Fatalf("USER column must be quoted:\n%s", spec.listQuery)
	}
}

func TestOceanBaseOracleShowProcesslistFallbackReadsSeconds(t *testing.T) {
	t.Parallel()

	spec := oceanBaseOracleSessionSpec()
	sessions := normalizeSessionRows(spec, []map[string]interface{}{{
		"Id": "3221487722", "User": "SYS", "db": "SYS", "Command": "Sleep", "Time": "93", "Info": nil,
	}}, "")
	if len(sessions) != 1 {
		t.Fatalf("sessions = %+v", sessions)
	}
	if sessions[0].SessionID != "3221487722" || sessions[0].User != "SYS" || sessions[0].DurationMs != 93000 {
		t.Fatalf("SHOW FULL PROCESSLIST row normalized to %+v", sessions[0])
	}

	primary := normalizeSessionRows(spec, []map[string]interface{}{{
		"SESSION_ID": "3221659094", "USER_NAME": "SYS", "DURATION_MS": "4000", "STATE": "Query",
	}}, "")
	if primary[0].DurationMs != 4000 {
		t.Fatalf("primary query duration must stay in milliseconds, got %d", primary[0].DurationMs)
	}
}

func TestListSessionsFallsBackWhenProcesslistViewIsMissing(t *testing.T) {
	t.Parallel()

	var queries []string
	database := &sessionActionTestDatabase{
		query: func(_ context.Context, query string) ([]map[string]interface{}, []string, error) {
			queries = append(queries, query)
			if strings.Contains(query, "GV$OB_PROCESSLIST") {
				return nil, nil, errors.New("ORA-00942: table or view does not exist")
			}
			return []map[string]interface{}{{"Id": 7, "User": "SYS", "Command": "Query", "Time": 2}}, nil, nil
		},
	}
	config := connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "oracle"}
	payload, err := NewSessionOperator(database, config).ListSessions(context.Background())
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	if len(queries) != 2 || queries[1] != "SHOW FULL PROCESSLIST" {
		t.Fatalf("queries = %q", queries)
	}
	if len(payload.Sessions) != 1 || payload.Sessions[0].SessionID != "7" || payload.Sessions[0].DurationMs != 2000 {
		t.Fatalf("sessions = %+v", payload.Sessions)
	}
}

func TestListSessionsReportsPrimaryErrorWhenEveryQueryFails(t *testing.T) {
	t.Parallel()

	database := &sessionActionTestDatabase{
		query: func(_ context.Context, query string) ([]map[string]interface{}, []string, error) {
			if strings.Contains(query, "GV$OB_PROCESSLIST") {
				return nil, nil, errors.New("primary view failed")
			}
			return nil, nil, errors.New("fallback failed")
		},
	}
	config := connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "mysql"}
	_, err := NewSessionOperator(database, config).ListSessions(context.Background())
	if err == nil || !strings.Contains(err.Error(), "primary view failed") {
		t.Fatalf("error = %v, want the primary view error", err)
	}
}

func TestListSessionsSkipsFallbackAfterCancellation(t *testing.T) {
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
	config := connection.ConnectionConfig{Type: "oceanbase", OceanBaseProtocol: "oracle"}
	if _, err := NewSessionOperator(database, config).ListSessions(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v", err)
	}
	if calls != 1 {
		t.Fatalf("a cancelled request must not try the fallback, calls = %d", calls)
	}
}
