package app

import (
	"context"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/sqlaudit"
	"GoNavi-Wails/internal/webidentity"
)

func TestScriptAuditEventsCarryActorAndSource(t *testing.T) {
	application := NewApp()
	ctx := webidentity.WithActor(context.Background(), webidentity.Actor{
		Username: "Alice",
		Role:     webidentity.RoleAdmin,
	})
	ctx = scriptWorkbenchContextWithRun(ctx, "script-run-1")
	config := connection.ConnectionConfig{ID: "saved-1", Type: "postgres", Database: "app"}

	statementEvent := application.buildParameterizedStatementAuditEvent(
		ctx,
		config,
		"postgres",
		"query-1",
		"tx-1",
		"script",
		time.Now(),
		parameterizedStatement{text: "SELECT id FROM users WHERE id IN (:ids)"},
		1,
		1,
		time.Now(),
		nil,
	)
	if statementEvent.UserName != "alice" || statementEvent.Source != "script" || statementEvent.RunID != "script-run-1" {
		t.Fatalf("statement audit actor/source/run = %q/%q/%q, want alice/script/script-run-1", statementEvent.UserName, statementEvent.Source, statementEvent.RunID)
	}

	var events []sqlaudit.Event
	observer := application.sqlAuditTransactionStatementObserver(
		config,
		"app",
		"postgres",
		"query-2",
		"tx-2",
		sqlaudit.BoundaryModeDriverAPI,
		"script",
		"Bob",
		"script-run-2",
		&events,
	)
	observer(managedSQLStatementObservation{
		Statement:      "UPDATE users SET status = :status",
		StatementIndex: 1,
		StatementCount: 1,
		Duration:       time.Millisecond,
	})
	if len(events) != 1 || events[0].UserName != "Bob" || events[0].Source != "script" || events[0].RunID != "script-run-2" {
		t.Fatalf("transaction audit events = %+v, want Bob/script/script-run-2", events)
	}
}
