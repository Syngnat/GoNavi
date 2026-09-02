package app

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"GoNavi-Wails/internal/db"
	"GoNavi-Wails/internal/syncjob"
)

type dataSyncRetryTestReporter struct {
	logs int
}

func (*dataSyncRetryTestReporter) ReportProgress(syncjob.RunProgress) error { return nil }
func (*dataSyncRetryTestReporter) SaveCheckpoint(syncjob.Checkpoint) error  { return nil }
func (*dataSyncRetryTestReporter) AppendErrorRow(syncjob.ErrorRow) error    { return nil }
func (r *dataSyncRetryTestReporter) Emit(syncjob.RunEventType, string, json.RawMessage) error {
	r.logs++
	return nil
}

func TestExecuteDataSyncMappingWithRetryStopsOnUnknownWrite(t *testing.T) {
	reporter := &dataSyncRetryTestReporter{}
	attempts := 0
	cause := errors.New("write response lost")
	definition := syncjob.JobDefinition{Options: syncjob.ExecutionOptions{
		MaxRetries: 3,
		SyncMode:   "insert_update",
	}}
	outcome, err := executeDataSyncMappingWithRetry(context.Background(), definition, reporter, func() (syncjob.ExecutionOutcome, error) {
		attempts++
		return syncjob.ExecutionOutcome{Resumable: true}, db.MarkWriteOutcomeUnknown(cause)
	})
	if !errors.Is(err, cause) || !db.IsWriteOutcomeUnknown(err) {
		t.Fatalf("retry result error = %T %v", err, err)
	}
	if attempts != 1 {
		t.Fatalf("attempts = %d, want 1", attempts)
	}
	if outcome.Resumable {
		t.Fatalf("outcome = %#v, unknown write must not be resumable", outcome)
	}
	if reporter.logs != 0 {
		t.Fatalf("retry logs = %d, want 0", reporter.logs)
	}
}
