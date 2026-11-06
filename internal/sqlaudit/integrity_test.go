package sqlaudit

import (
	"context"
	"errors"
	"testing"
)

type cancelDuringSecondNextRows struct {
	cancel    context.CancelFunc
	nextCalls int
	scans     int
}

func (r *cancelDuringSecondNextRows) Next() bool {
	switch r.nextCalls {
	case 0:
		r.nextCalls++
		return true
	case 1:
		r.nextCalls++
		r.cancel()
		return true
	default:
		return false
	}
}

func (r *cancelDuringSecondNextRows) Scan(dest ...any) error {
	if len(dest) != 31 {
		return errors.New("unexpected scan destination count")
	}
	r.scans++
	event := sampleEvent("canceled-integrity", 1)
	event.Sequence = 1
	event.PrevHash = ""
	event.Hash, _ = calculateEventHash(event)
	values := []any{
		event.Sequence, event.ID, event.Timestamp, event.EventType, event.Status,
		event.ConnectionID, event.ConnectionFingerprint, event.DBType, event.Database,
		event.QueryID, event.TransactionID, event.Source, event.BoundaryMode,
		event.CommitMode, event.SQLText, boolToInt(event.SQLRedacted), event.SQLFingerprint,
		event.StatementIndex, event.StatementCount, event.ExecutedCount, event.FailedIndex,
		boolToInt(event.OutcomeUnknown), event.DurationMs, event.RowsAffected, event.RowsReturned,
		event.Error, event.PrevHash, event.Hash, event.MCPRequestID, event.MCPClient, event.UserName,
	}
	for index := range dest {
		switch target := dest[index].(type) {
		case *int64:
			*target = values[index].(int64)
		case *string:
			*target = values[index].(string)
		case *int:
			*target = values[index].(int)
		default:
			return errors.New("unexpected scan destination type")
		}
	}
	return nil
}

func (r *cancelDuringSecondNextRows) Err() error   { return nil }
func (r *cancelDuringSecondNextRows) Close() error { return nil }

func TestVerifyIntegrityContextStopsDuringScanWhenCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rows := &cancelDuringSecondNextRows{cancel: cancel}

	report, err := verifyIntegrityRows(ctx, rows, newIntegrityReport())
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("verifyIntegrityRows error = %v, want context.Canceled", err)
	}
	if report.CheckedRecords != 1 {
		t.Fatalf("canceled verification checked %d records, want 1", report.CheckedRecords)
	}
	if rows.scans != 1 || rows.nextCalls != 2 {
		t.Fatalf("scan progressed after cancellation: scans=%d nextCalls=%d", rows.scans, rows.nextCalls)
	}
}
