package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/db"
	syncbackend "GoNavi-Wails/internal/sync"
	"GoNavi-Wails/internal/synccdc"
	"GoNavi-Wails/internal/syncjob"
)

type executorTestCDCAdapter struct {
	position synccdc.Position
	stream   synccdc.Stream
	steps    *[]string
}

func (a *executorTestCDCAdapter) Name() string          { return "executor-test-cdc" }
func (a *executorTestCDCAdapter) SourceTypes() []string { return []string{"executor-test-source"} }
func (a *executorTestCDCAdapter) Probe(context.Context, connection.ConnectionConfig) (synccdc.Capability, error) {
	return synccdc.Capability{Adapter: a.Name(), Supported: true, Ready: true}, nil
}
func (a *executorTestCDCAdapter) BeginSnapshot(context.Context, synccdc.Request) (synccdc.Barrier, error) {
	*a.steps = append(*a.steps, "barrier")
	return synccdc.Barrier{Position: a.position}, nil
}
func (a *executorTestCDCAdapter) Open(_ context.Context, _ synccdc.Request, position synccdc.Position) (synccdc.Stream, error) {
	*a.steps = append(*a.steps, "open")
	if err := synccdc.ValidatePosition(position, a.Name()); err != nil {
		return nil, err
	}
	return a.stream, nil
}

type executorTestCDCStream struct {
	transactions []synccdc.Transaction
	index        int
	steps        *[]string
}

func (s *executorTestCDCStream) Next(context.Context) (synccdc.Transaction, error) {
	*s.steps = append(*s.steps, "next")
	if s.index >= len(s.transactions) {
		return synccdc.Transaction{}, io.EOF
	}
	transaction := s.transactions[s.index]
	s.index++
	return transaction, nil
}
func (s *executorTestCDCStream) Acknowledge(context.Context, synccdc.Position) error {
	*s.steps = append(*s.steps, "ack")
	return nil
}
func (s *executorTestCDCStream) Close() error {
	*s.steps = append(*s.steps, "close")
	return nil
}

type executorTestReporter struct {
	steps       *[]string
	checkpoints []syncjob.Checkpoint
	errors      []syncjob.ErrorRow
}

func (r *executorTestReporter) ReportProgress(syncjob.RunProgress) error {
	*r.steps = append(*r.steps, "progress")
	return nil
}
func (r *executorTestReporter) SaveCheckpoint(checkpoint syncjob.Checkpoint) error {
	r.checkpoints = append(r.checkpoints, checkpoint)
	*r.steps = append(*r.steps, "save:"+checkpoint.Phase)
	return nil
}
func (r *executorTestReporter) AppendErrorRow(row syncjob.ErrorRow) error {
	r.errors = append(r.errors, row)
	*r.steps = append(*r.steps, "error-row")
	return nil
}
func (r *executorTestReporter) Emit(syncjob.RunEventType, string, json.RawMessage) error { return nil }

func TestExecuteCDCJobPersistsBootstrapAndTargetCommitBeforeAcknowledge(t *testing.T) {
	steps := make([]string, 0, 18)
	position0 := synccdc.Position{Adapter: "executor-test-cdc", Opaque: json.RawMessage(`{"offset":0}`)}
	position1 := synccdc.Position{Adapter: "executor-test-cdc", Opaque: json.RawMessage(`{"offset":1}`)}
	position2 := synccdc.Position{Adapter: "executor-test-cdc", Opaque: json.RawMessage(`{"offset":2}`)}
	stream := &executorTestCDCStream{steps: &steps, transactions: []synccdc.Transaction{
		{
			Events: []synccdc.Event{{
				Object: synccdc.ObjectRef{Database: "source", Name: "events"}, Operation: "insert",
				Key: map[string]interface{}{"id": int64(1)}, After: map[string]interface{}{"id": int64(1), "name": "one"}, CommitTime: time.Now(),
			}},
			Position: position1,
		},
		{
			Events: []synccdc.Event{{
				Object: synccdc.ObjectRef{Database: "source", Name: "events"}, Operation: "insert",
				Key: map[string]interface{}{"id": int64(2)}, After: map[string]interface{}{"id": int64(2), "name": "two"}, CommitTime: time.Now(),
			}},
			Position: position2,
		},
	}}
	adapter := &executorTestCDCAdapter{position: position0, stream: stream, steps: &steps}
	registry := synccdc.NewRegistry()
	if err := registry.Register(adapter); err != nil {
		t.Fatalf("register adapter: %v", err)
	}
	application := NewApp()
	application.dataSyncCDCRegistry = registry
	applyCalls := 0
	application.dataSyncChangeEventRunner = func(_ context.Context, request syncbackend.ChangeEventRequest) syncbackend.ChangeEventResult {
		steps = append(steps, "apply")
		applyCalls++
		if len(request.Events) != 1 || request.Events[0].After["name"] != []string{"one", "two"}[applyCalls-1] || len(request.Sync.Mappings) != 1 || request.OnRowError == nil {
			t.Fatalf("change event request = %#v", request)
		}
		return syncbackend.ChangeEventResult{Success: true, EventsReceived: 1, EventsApplied: 1, RowsInserted: 1}
	}
	executor := appDataSyncJobExecutor{app: application}
	source := resolvedDataSyncJobEndpoint{Config: connection.ConnectionConfig{Type: "executor-test-source"}, Database: "source"}
	target := resolvedDataSyncJobEndpoint{Config: connection.ConnectionConfig{Type: "mysql"}, Database: "target"}
	definition := syncjob.JobDefinition{
		ID: "job-1", Revision: 1, Kind: syncjob.JobKindReconcile, IncrementalMode: syncjob.IncrementalCDC,
		CDC:     &syncjob.CDCSpec{Adapter: adapter.Name(), StartPosition: "latest"},
		Options: syncjob.ExecutionOptions{BatchSize: 100, SyncMode: "insert_update", TargetTableStrategy: "existing_only", ErrorPolicy: syncjob.ErrorPolicyStop},
		Mappings: []syncjob.TableMapping{{
			SourceTable: "events", TargetTable: "events", KeyColumns: []string{"id"}, Enabled: true,
			Columns: []syncjob.ColumnMapping{{Source: "id", Target: "id"}, {Source: "name", Target: "name"}},
		}},
	}
	reporter := &executorTestReporter{steps: &steps}
	outcome, err := executor.executeCDCJob(context.Background(), syncjob.ExecutionRequest{Run: syncjob.RunRecord{ID: "run-1"}, Definition: definition}, definition, definition.Mappings, source, target, reporter)
	if err == nil || !strings.Contains(err.Error(), "stream ended") {
		t.Fatalf("executeCDCJob error = %v", err)
	}
	if outcome.RowsInserted != 2 || !outcome.Resumable || applyCalls != 2 {
		t.Fatalf("outcome = %#v", outcome)
	}
	want := "barrier,save:stream_initialized,open,next,apply,save:transaction_committed,ack,progress,next,apply,save:transaction_committed,ack,progress,next,close"
	if got := strings.Join(steps, ","); got != want {
		t.Fatalf("execution order = %s, want %s", got, want)
	}
	if len(reporter.checkpoints) != 3 || reporter.checkpoints[0].BatchSequence != 0 || reporter.checkpoints[1].BatchSequence != 1 || reporter.checkpoints[2].BatchSequence != 2 {
		t.Fatalf("checkpoints = %#v", reporter.checkpoints)
	}
}

func TestExecuteCDCJobDoesNotCheckpointOrAcknowledgeUnknownWrite(t *testing.T) {
	steps := make([]string, 0, 10)
	position0 := synccdc.Position{Adapter: "executor-test-cdc", Opaque: json.RawMessage(`{"offset":0}`)}
	position1 := synccdc.Position{Adapter: "executor-test-cdc", Opaque: json.RawMessage(`{"offset":1}`)}
	stream := &executorTestCDCStream{steps: &steps, transactions: []synccdc.Transaction{{
		Events: []synccdc.Event{{
			Object: synccdc.ObjectRef{Database: "source", Name: "events"}, Operation: "insert",
			Key: map[string]interface{}{"id": int64(1)}, After: map[string]interface{}{"id": int64(1)}, CommitTime: time.Now(),
		}},
		Position: position1,
	}}}
	adapter := &executorTestCDCAdapter{position: position0, stream: stream, steps: &steps}
	registry := synccdc.NewRegistry()
	if err := registry.Register(adapter); err != nil {
		t.Fatalf("register adapter: %v", err)
	}
	application := NewApp()
	application.dataSyncCDCRegistry = registry
	application.dataSyncChangeEventRunner = func(context.Context, syncbackend.ChangeEventRequest) syncbackend.ChangeEventResult {
		steps = append(steps, "apply")
		return syncbackend.ChangeEventResult{Success: false, OutcomeUnknown: true, Message: "write response lost"}
	}
	executor := appDataSyncJobExecutor{app: application}
	source := resolvedDataSyncJobEndpoint{Config: connection.ConnectionConfig{Type: "executor-test-source"}, Database: "source"}
	target := resolvedDataSyncJobEndpoint{Config: connection.ConnectionConfig{Type: "mysql"}, Database: "target"}
	definition := syncjob.JobDefinition{
		ID: "job-unknown", Revision: 1, Kind: syncjob.JobKindReconcile, IncrementalMode: syncjob.IncrementalCDC,
		CDC:     &syncjob.CDCSpec{Adapter: adapter.Name(), StartPosition: "latest"},
		Options: syncjob.ExecutionOptions{BatchSize: 100, SyncMode: "insert_update", TargetTableStrategy: "existing_only", ErrorPolicy: syncjob.ErrorPolicyStop},
		Mappings: []syncjob.TableMapping{{
			SourceTable: "events", TargetTable: "events", KeyColumns: []string{"id"}, Enabled: true,
			Columns: []syncjob.ColumnMapping{{Source: "id", Target: "id"}},
		}},
	}
	reporter := &executorTestReporter{steps: &steps}
	outcome, err := executor.executeCDCJob(context.Background(), syncjob.ExecutionRequest{Run: syncjob.RunRecord{ID: "run-unknown"}, Definition: definition}, definition, definition.Mappings, source, target, reporter)
	if !db.IsWriteOutcomeUnknown(err) {
		t.Fatalf("executeCDCJob error = %v, want unknown write outcome", err)
	}
	if outcome.Resumable {
		t.Fatalf("outcome = %#v, unknown write must not be resumable", outcome)
	}
	if len(reporter.checkpoints) != 1 || reporter.checkpoints[0].Phase != "stream_initialized" {
		t.Fatalf("checkpoints = %#v, want only bootstrap checkpoint", reporter.checkpoints)
	}
	if got := strings.Join(steps, ","); got != "barrier,save:stream_initialized,open,next,apply,close" {
		t.Fatalf("execution order = %s, want no transaction checkpoint or acknowledge", got)
	}
}

func TestBuildDataSyncChangeEventsDoesNotAdvanceMissingUpdateImage(t *testing.T) {
	definition := syncjob.JobDefinition{Options: syncjob.ExecutionOptions{PropagateDeletes: true}}
	mappings := []syncjob.TableMapping{{SourceTable: "events", TargetTable: "events", Columns: []syncjob.ColumnMapping{{Source: "id", Target: "id"}}}}
	_, _, err := buildDataSyncChangeEvents(definition, mappings, []synccdc.Event{{
		Object: synccdc.ObjectRef{Name: "events"}, Operation: "update", Key: map[string]interface{}{"id": 1},
	}})
	if err == nil || !strings.Contains(err.Error(), "checkpoint was not advanced") {
		t.Fatalf("missing update image error = %v", err)
	}

	events, _, err := buildDataSyncChangeEvents(definition, mappings, []synccdc.Event{{
		Object: synccdc.ObjectRef{Name: "events"}, Operation: "delete", Key: map[string]interface{}{"id": 1},
	}})
	if err != nil || len(events) != 1 {
		t.Fatalf("delete conversion = %#v, err=%v", events, err)
	}
}

func TestBuildDataSyncChangeEventsMaterializesRemovedMappedFields(t *testing.T) {
	definition := syncjob.JobDefinition{Options: syncjob.ExecutionOptions{PropagateDeletes: true}}
	mappings := []syncjob.TableMapping{{
		SourceTable: "events", TargetTable: "events", Columns: []syncjob.ColumnMapping{{Source: "id", Target: "id"}, {Source: "name", Target: "name"}},
	}}
	events, _, err := buildDataSyncChangeEvents(definition, mappings, []synccdc.Event{{
		Object: synccdc.ObjectRef{Name: "events"}, Operation: "update", Key: map[string]interface{}{"id": 1}, After: map[string]interface{}{"id": 1},
	}})
	if err != nil || len(events) != 1 {
		t.Fatalf("materialize authoritative event = %#v, err=%v", events, err)
	}
	if value, exists := events[0].After["name"]; !exists || value != nil {
		t.Fatalf("removed mapped field was not materialized as nil: %#v", events[0].After)
	}
	if _, _, err := buildDataSyncChangeEvents(definition, []syncjob.TableMapping{{SourceTable: "events", TargetTable: "events"}}, []synccdc.Event{{
		Object: synccdc.ObjectRef{Name: "events"}, Operation: "update", Key: map[string]interface{}{"id": 1}, After: map[string]interface{}{"id": 1},
	}}); err == nil {
		t.Fatal("CDC without authoritative columns must fail before checkpoint advancement")
	}
}

func TestResolveDataSyncCDCPositionPrefersCompatibleCheckpoint(t *testing.T) {
	steps := make([]string, 0)
	position := synccdc.Position{Adapter: "executor-test-cdc", Opaque: json.RawMessage(`{"offset":7}`)}
	adapter := &executorTestCDCAdapter{position: position, steps: &steps}
	definition := syncjob.JobDefinition{CDC: &syncjob.CDCSpec{Adapter: adapter.Name(), StartPosition: "latest"}}
	payload, _ := json.Marshal(position)
	executor := appDataSyncJobExecutor{app: NewApp()}
	got, sequence, err := executor.resolveDataSyncCDCPosition(context.Background(), &syncjob.Checkpoint{
		Kind: "cdc", CursorType: "synccdc_position", Cursor: payload, BatchSequence: 9, SchemaHash: "plan",
	}, definition, "plan", adapter, synccdc.Request{})
	if err != nil || sequence != 9 || got.Adapter != adapter.Name() {
		t.Fatalf("checkpoint position = %#v sequence=%d err=%v", got, sequence, err)
	}
	if len(steps) != 0 {
		t.Fatalf("compatible checkpoint unexpectedly created a new latest barrier: %v", steps)
	}

	_, _, err = executor.resolveDataSyncCDCPosition(context.Background(), nil, syncjob.JobDefinition{CDC: &syncjob.CDCSpec{Adapter: adapter.Name(), StartPosition: "checkpoint"}}, "plan", adapter, synccdc.Request{})
	if err == nil || !strings.Contains(err.Error(), "requires an existing") {
		t.Fatalf("missing checkpoint error = %v", err)
	}
	if errors.Is(err, context.Canceled) {
		t.Fatal("unexpected cancellation")
	}
}
