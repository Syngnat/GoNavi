package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"

	"GoNavi-Wails/internal/connection"
	syncbackend "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/syncjob"
)

func TestConfigureDataSyncSnapshotErrorHandlingPersistsExplicitRetryPayload(t *testing.T) {
	steps := make([]string, 0)
	reporter := &executorTestReporter{steps: &steps}
	definition := syncjob.JobDefinition{Options: syncjob.ExecutionOptions{
		ErrorPolicy:         syncjob.ErrorPolicySkipRow,
		CaptureErrorPayload: true,
	}}
	mapping := syncjob.TableMapping{
		SourceTable: "orders", TargetTable: "orders_archive", KeyColumns: []string{"id"},
		Columns: []syncjob.ColumnMapping{{Source: "id", Target: "order_id"}, {Source: "name", Target: "name"}},
	}
	config := syncbackend.SyncConfig{Mappings: []syncbackend.SyncObjectMapping{{
		Source: syncbackend.SyncObjectRef{Name: "orders"}, Target: syncbackend.SyncObjectRef{Name: "orders_archive"},
	}}}
	configureDataSyncSnapshotErrorHandling(&config, definition, mapping, reporter)
	if config.OnRowError == nil {
		t.Fatal("skip_row did not install a quarantine callback")
	}
	if err := config.OnRowError(context.Background(), syncbackend.ChangeEventRowError{
		SourceTable: "orders", Operation: "update", Code: "apply_failed", Message: "apply failed",
		SourceKey: map[string]interface{}{"order_id": int64(7)}, Row: map[string]interface{}{"order_id": int64(7), "name": "seven"},
	}); err != nil {
		t.Fatalf("append error row: %v", err)
	}
	if len(reporter.errors) != 1 {
		t.Fatalf("persisted error rows = %d", len(reporter.errors))
	}
	row := reporter.errors[0]
	if row.PayloadPolicy != "full" || len(row.Payload) == 0 || row.PayloadHash == "" || row.PayloadSize != int64(len(row.Payload)) {
		t.Fatalf("persisted retry metadata = %#v", row)
	}
	payload, err := decodeDataSyncErrorRetryPayload(row.Payload)
	if err != nil {
		t.Fatalf("decode retry payload: %v", err)
	}
	if !payload.ProjectionApplied || payload.Event.Operation != "update" || payload.Event.After["name"] != "seven" {
		t.Fatalf("retry payload = %#v", payload)
	}
}

func TestDataSyncErrorRowRetryReplaysFullPayloadAndResolvesCAS(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	t.Cleanup(application.shutdownDataSyncJobs)
	for _, input := range []connection.SavedConnectionInput{
		{ID: "source", Name: "source", Config: connection.ConnectionConfig{ID: "source", Type: "sqlite", Database: "source.db"}},
		{ID: "target", Name: "target", Config: connection.ConnectionConfig{ID: "target", Type: "sqlite", Database: "target.db"}},
	} {
		if _, err := application.SaveConnection(input); err != nil {
			t.Fatalf("save %s connection: %v", input.ID, err)
		}
	}
	source, err := application.resolveDataSyncJobEndpoint("source", "", "")
	if err != nil {
		t.Fatalf("resolve source: %v", err)
	}
	target, err := application.resolveDataSyncJobEndpoint("target", "", "")
	if err != nil {
		t.Fatalf("resolve target: %v", err)
	}
	manager, err := application.ensureDataSyncJobManager()
	if err != nil {
		t.Fatalf("create manager: %v", err)
	}
	definition, err := manager.PutJob(context.Background(), syncjob.JobDefinition{
		Name: "retry orders", Lifecycle: syncjob.JobLifecycleReady, Kind: syncjob.JobKindReconcile, IncrementalMode: syncjob.IncrementalSnapshot,
		Source: syncjob.EndpointRef{ConnectionID: "source", ConnectionType: "sqlite", Fingerprint: source.Fingerprint},
		Target: syncjob.EndpointRef{ConnectionID: "target", ConnectionType: "sqlite", Fingerprint: target.Fingerprint},
		Mappings: []syncjob.TableMapping{{
			SourceTable: "orders", TargetTable: "orders_archive", KeyColumns: []string{"id"}, Enabled: true,
			Columns: []syncjob.ColumnMapping{{Source: "id", Target: "id"}, {Source: "name", Target: "name"}},
		}},
		Options:  syncjob.ExecutionOptions{Content: "data", SyncMode: "insert_update", TargetTableStrategy: "existing_only", BatchSize: 100, ErrorPolicy: syncjob.ErrorPolicySkipRow, CaptureErrorPayload: true},
		Schedule: syncjob.ScheduleSpec{Kind: syncjob.ScheduleManual}, ConcurrencyPolicy: "forbid", ResumePolicy: "manual",
	})
	if err != nil {
		t.Fatalf("put retry job: %v", err)
	}
	snapshot, _ := json.Marshal(definition)
	run, err := application.dataSyncJobStore.CreateRun(context.Background(), syncjob.RunRecord{
		JobID: definition.ID, JobRevision: definition.Revision, Status: syncjob.RunStatusFailed,
		DefinitionSnapshot: snapshot, SourceFingerprint: source.Fingerprint, TargetFingerprint: target.Fingerprint,
	})
	if err != nil {
		t.Fatalf("create parent run: %v", err)
	}
	event := syncbackend.DataChangeEvent{
		Object: syncbackend.SyncObjectRef{Name: "orders"}, Operation: syncbackend.ChangeEventOperationUpdate,
		Key: map[string]interface{}{"id": 7}, After: map[string]interface{}{"id": 7, "name": "seven"},
	}
	payload, _ := json.Marshal(event)
	hash := sha256.Sum256(payload)
	errorRow, err := application.dataSyncJobStore.AppendErrorRow(context.Background(), syncjob.ErrorRow{
		RunID: run.ID, JobID: definition.ID, SourceTable: "orders", TargetTable: "orders_archive", Operation: "update",
		Payload: payload, PayloadPolicy: "full", PayloadHash: "sha256:" + hex.EncodeToString(hash[:]), PayloadSize: int64(len(payload)),
		Error: "apply failed", Status: syncjob.ErrorRowPending,
	})
	if err != nil {
		t.Fatalf("append retry row: %v", err)
	}
	invalidRevision := application.DataSyncErrorRowRetry(errorRow.ID, 0, "")
	if invalidRevision.Success || !strings.Contains(invalidRevision.Message, "positive expected job revision") {
		t.Fatalf("zero revision retry = %#v", invalidRevision)
	}
	unclaimed, err := manager.GetErrorRow(context.Background(), errorRow.ID)
	if err != nil || unclaimed.Status != syncjob.ErrorRowPending || unclaimed.Attempts != 0 {
		t.Fatalf("zero revision retry mutated row = %#v, err=%v", unclaimed, err)
	}
	var replayCalls atomic.Int32
	var concurrentRetrySucceeded, concurrentDiscardSucceeded bool
	application.dataSyncChangeEventRunner = func(_ context.Context, request syncbackend.ChangeEventRequest) syncbackend.ChangeEventResult {
		if len(request.Events) != 1 || request.Events[0].After["name"] != "seven" || len(request.Sync.Mappings) != 1 {
			t.Fatalf("replay request = %#v", request)
		}
		if replayCalls.Add(1) == 1 {
			concurrentRetrySucceeded = application.DataSyncErrorRowRetry(errorRow.ID, definition.Revision, "").Success
			concurrentDiscardSucceeded = application.DataSyncErrorRowDiscard(errorRow.ID).Success
		}
		return syncbackend.ChangeEventResult{Success: true, EventsReceived: 1, EventsApplied: 1, RowsUpdated: 1}
	}
	result := application.DataSyncErrorRowRetry(errorRow.ID, definition.Revision, "")
	if !result.Success {
		t.Fatalf("retry error row: %s", result.Message)
	}
	resolved, err := manager.GetErrorRow(context.Background(), errorRow.ID)
	if err != nil || resolved.Status != syncjob.ErrorRowResolved || resolved.Attempts != 1 {
		t.Fatalf("resolved error row = %#v, err=%v", resolved, err)
	}
	if replayCalls.Load() != 1 || concurrentRetrySucceeded || concurrentDiscardSucceeded {
		t.Fatalf("retry claim was not exclusive: calls=%d nestedRetry=%v discard=%v", replayCalls.Load(), concurrentRetrySucceeded, concurrentDiscardSucceeded)
	}
	publicPayload, err := json.Marshal(result.Data)
	if err != nil {
		t.Fatalf("marshal public retry result: %v", err)
	}
	if strings.Contains(string(publicPayload), "seven") || strings.Contains(string(publicPayload), "retryOwner") {
		t.Fatalf("retry result leaked private payload or claim: %s", publicPayload)
	}

	failedRow, err := application.dataSyncJobStore.AppendErrorRow(context.Background(), syncjob.ErrorRow{
		RunID: run.ID, JobID: definition.ID, SourceTable: "orders", TargetTable: "orders_archive", Operation: "update",
		Payload: payload, PayloadPolicy: "full", PayloadHash: "sha256:" + hex.EncodeToString(hash[:]), PayloadSize: int64(len(payload)),
		Error: "apply failed", Status: syncjob.ErrorRowPending,
	})
	if err != nil {
		t.Fatalf("append failing retry row: %v", err)
	}
	application.dataSyncChangeEventRunner = func(_ context.Context, _ syncbackend.ChangeEventRequest) syncbackend.ChangeEventResult {
		return syncbackend.ChangeEventResult{Success: false, EventsReceived: 1, Message: "target rejected replay"}
	}
	failedResult := application.DataSyncErrorRowRetry(failedRow.ID, definition.Revision, "")
	if failedResult.Success {
		t.Fatal("failed replay unexpectedly succeeded")
	}
	pending, err := manager.GetErrorRow(context.Background(), failedRow.ID)
	if err != nil || pending.Status != syncjob.ErrorRowPending || pending.Attempts != 1 || pending.RetryOwner != "" || pending.RetryLeaseExpiresAt != 0 {
		t.Fatalf("failed retry row = %#v, err=%v", pending, err)
	}
}

func TestConfigureDataSyncSnapshotErrorHandlingKeepsPayloadOutByDefault(t *testing.T) {
	steps := make([]string, 0)
	reporter := &executorTestReporter{steps: &steps}
	definition := syncjob.JobDefinition{Options: syncjob.ExecutionOptions{ErrorPolicy: syncjob.ErrorPolicySkipRow}}
	mapping := syncjob.TableMapping{SourceTable: "orders", TargetTable: "orders", KeyColumns: []string{"id"}}
	config := syncbackend.SyncConfig{}
	configureDataSyncSnapshotErrorHandling(&config, definition, mapping, reporter)
	if err := config.OnRowError(context.Background(), syncbackend.ChangeEventRowError{
		SourceTable: "orders", Operation: "insert", Code: "apply_failed", Message: "apply failed",
		Row: map[string]interface{}{"id": 9, "secret": "must-not-persist"},
	}); err != nil {
		t.Fatalf("append keys-only error row: %v", err)
	}
	row := reporter.errors[0]
	if row.PayloadPolicy != "keys_only" || len(row.Payload) != 0 || row.PayloadHash == "" || row.PayloadSize == 0 {
		t.Fatalf("keys-only error row = %#v", row)
	}
}
