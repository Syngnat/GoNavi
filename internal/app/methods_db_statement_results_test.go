package app

import (
	"errors"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
)

func TestNativeStatementExecutionResultsPreserveKnownPrefix(t *testing.T) {
	statements := []string{
		"UPDATE users SET active = 1",
		"UPDATE users SET active = 2",
		"UPDATE users SET active = 3",
	}
	results := nativeStatementExecutionResults(
		statements,
		[]connection.ResultSetData{{
			StatementIndex: 1,
			Columns:        []string{"affectedRows"},
			Rows:           []map[string]interface{}{{"affectedRows": int64(2)}},
		}},
		1,
		2,
		true,
		false,
		errors.New("duplicate key"),
	)

	if len(results) != 3 {
		t.Fatalf("statement results length = %d, want 3", len(results))
	}
	if results[0].Status != connection.StatementResultSuccess {
		t.Fatalf("first status = %q, want success", results[0].Status)
	}
	if results[0].AffectedRows == nil || *results[0].AffectedRows != 2 {
		t.Fatalf("first affectedRows = %#v, want 2", results[0].AffectedRows)
	}
	if results[1].Status != connection.StatementResultFailed || results[1].Error == "" {
		t.Fatalf("second result = %#v, want failed with error", results[1])
	}
	if results[2].Status != connection.StatementResultUnknown {
		t.Fatalf("third status = %q, want unknown", results[2].Status)
	}
}

func TestNativeStatementExecutionResultsDoNotGuessWithoutExactPrefix(t *testing.T) {
	results := nativeStatementExecutionResults(
		[]string{"SELECT 1", "SELECT 2"},
		nil,
		0,
		0,
		false,
		true,
		errors.New("stream closed"),
	)

	for _, result := range results {
		if result.Status != connection.StatementResultUnknown {
			t.Fatalf("status = %q, want unknown", result.Status)
		}
	}
}

func TestNativeStatementExecutionResultsPreserveZeroAffectedRows(t *testing.T) {
	results := nativeSuccessStatementExecutionResults(
		[]string{"UPDATE users SET active = 1"},
		[]connection.ResultSetData{{
			StatementIndex: 1,
			Columns:        []string{"affectedRows"},
			Rows:           []map[string]interface{}{{"affectedRows": int64(0)}},
		}},
	)
	if len(results) != 1 || results[0].AffectedRows == nil || *results[0].AffectedRows != 0 {
		t.Fatalf("zero affected rows were lost: %#v", results)
	}
}

func TestManagedObservationStatementResultsMarkAutoRollback(t *testing.T) {
	statements := []string{
		"UPDATE users SET active = 1",
		"UPDATE users SET active = 2",
		"UPDATE users SET active = 3",
	}
	startedAt := time.Now()
	results := managedObservationStatementResults(statements, []managedSQLStatementObservation{
		{
			StatementIndex:    1,
			RowsAffected:      0,
			AffectedRowsKnown: true,
			StartedAt:         startedAt,
			CompletedAt:       startedAt.Add(10 * time.Millisecond),
			Duration:          10 * time.Millisecond,
		},
		{
			StatementIndex: 2,
			Err:            errors.New("delete failed"),
			StartedAt:      startedAt,
			CompletedAt:    startedAt.Add(20 * time.Millisecond),
			Duration:       20 * time.Millisecond,
		},
	}, connection.StatementResultRolledBack)

	if results[0].Status != connection.StatementResultRolledBack {
		t.Fatalf("first status = %q, want rolled_back", results[0].Status)
	}
	if results[0].AffectedRows == nil || *results[0].AffectedRows != 0 {
		t.Fatalf("first affectedRows = %#v, want 0", results[0].AffectedRows)
	}
	if results[1].Status != connection.StatementResultFailed {
		t.Fatalf("second status = %q, want failed", results[1].Status)
	}
	if results[2].Status != connection.StatementResultSkipped {
		t.Fatalf("third status = %q, want skipped", results[2].Status)
	}
}
