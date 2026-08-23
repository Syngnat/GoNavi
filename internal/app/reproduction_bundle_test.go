package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/importjob"
	"GoNavi-Wails/internal/requesttrace"
	"GoNavi-Wails/internal/syncjob"
)

func TestReproductionBundleBuildsRunnableFixturesForEveryFailureKind(t *testing.T) {
	now := time.UnixMilli(1_700_000_001_000)
	traceStartedAt := now.Add(-time.Second).UnixMilli()

	cases := []struct {
		name           string
		wantKind       reproductionBundleSourceKind
		wantEvent      string
		wantCapability string
		snapshot       reproductionBundleSnapshot
	}{
		{
			name:           "query",
			wantKind:       reproductionBundleSourceQuery,
			wantEvent:      "driver.dispatched",
			wantCapability: "operation",
			snapshot: reproductionBundleSnapshotFromTrace(requesttrace.Trace{
				RequestID:      "query-private-customer-id",
				Entry:          "desktop",
				Operation:      "database.query",
				DataSourceType: "postgres",
				DriverMode:     "builtin",
				StartedAt:      traceStartedAt,
				FinishedAt:     now.UnixMilli(),
				Status:         "error",
				Error:          &requesttrace.Error{Kind: "execution", Message: "password=secret SELECT * FROM customers WHERE token='row-secret'"},
				Events: []requesttrace.Event{
					{Timestamp: traceStartedAt, Name: "request.started"},
					{Timestamp: now.UnixMilli(), Name: "driver.dispatched", Details: map[string]string{"sql": "SELECT * FROM customers"}},
				},
			}, reproductionBundleSourceQuery),
		},
		{
			name:           "mcp",
			wantKind:       reproductionBundleSourceMCP,
			wantEvent:      "request.started",
			wantCapability: "entry",
			snapshot: reproductionBundleSnapshotFromTrace(requesttrace.Trace{
				RequestID:  "request-private-mcp-id",
				Entry:      "mcp",
				Operation:  "mcp.get_objects",
				StartedAt:  traceStartedAt,
				FinishedAt: now.UnixMilli(),
				Status:     "error",
				Error:      &requesttrace.Error{Kind: "tool", Message: "postgres://user:password@private-host/db"},
				Events:     []requesttrace.Event{{Timestamp: traceStartedAt, Name: "request.started"}},
			}, reproductionBundleSourceMCP),
		},
		{
			name:           "sync",
			wantKind:       reproductionBundleSourceSync,
			wantEvent:      "failed",
			wantCapability: "jobKind",
			snapshot: reproductionBundleSnapshotFromSync(
				syncjob.RunRecord{
					ID: "sync-run-private-id", JobID: "sync-job-private-id", Status: syncjob.RunStatusFailed,
					StartedAt: traceStartedAt, FinishedAt: now.UnixMilli(), Message: "row customer@example.com failed",
				},
				syncjob.JobDefinition{
					Kind: syncjob.JobKindMigration, IncrementalMode: syncjob.IncrementalSnapshot,
					SourceQuery: "SELECT * FROM private_table WHERE token = 'secret'",
					Source:      syncjob.EndpointRef{ConnectionID: "source-private", ConnectionName: "customer prod"},
					Target:      syncjob.EndpointRef{ConnectionID: "target-private", ConnectionName: "warehouse prod"},
					Mappings: []syncjob.TableMapping{{
						SourceTable: "private_table", TargetTable: "private_target",
						Columns: []syncjob.ColumnMapping{{Source: "email", Target: "email_hash", Transform: syncjob.TransformSpec{Kind: "hash"}}},
					}},
					Options: syncjob.ExecutionOptions{SyncMode: "insert_update", BatchSize: 500, MaxRetries: 2},
				},
				[]syncjob.RunEvent{{Sequence: 1, Type: syncjob.RunEventFailed, Status: syncjob.RunStatusFailed, Message: "row private-value", CreatedAt: now.UnixMilli()}},
			),
		},
		{
			name:           "import",
			wantKind:       reproductionBundleSourceImport,
			wantEvent:      "import.failed",
			wantCapability: "importKind",
			snapshot: reproductionBundleSnapshotFromImport(importjob.Job{
				ID: "import-private-id", Kind: importjob.KindTable, Status: importjob.StatusFailed,
				Stage: "write", SourcePath: "/Users/private/customer.csv", DatabaseName: "customer_db",
				TableName: "customer_rows", ConnectionID: "private-connection", Message: "secret row value",
				Checkpoint: importjob.Checkpoint{Safe: true, SourceRow: 42}, CreatedAt: traceStartedAt, UpdatedAt: now.UnixMilli(),
				TableImportOptions: &importjob.TableImportOptions{
					ColumnMappings: map[string]string{"customer_email": "private_target"}, Delimiter: ",", Encoding: "utf-8",
					ConflictPolicy: "upsert", ConflictKeyColumns: []string{"private_key"},
				},
			}),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bundle := buildReproductionBundle(tc.snapshot, "0.9.3", now)
			if bundle.Format != reproductionBundleFormat || bundle.SchemaVersion != reproductionBundleSchemaVersion {
				t.Fatalf("unexpected bundle contract: %#v", bundle)
			}
			if bundle.Source.Kind != tc.wantKind || bundle.Source.Status != "failed" {
				t.Fatalf("unexpected source: %#v", bundle.Source)
			}
			if _, ok := bundle.Capabilities[tc.wantCapability]; !ok {
				t.Fatalf("missing capability %q: %#v", tc.wantCapability, bundle.Capabilities)
			}
			if tc.wantKind == reproductionBundleSourceSync && (bundle.Capabilities["mappingCount"] != "1" || bundle.Capabilities["columnMappingCount"] != "1" || bundle.Capabilities["transformKinds"] != "hash") {
				t.Fatalf("sync mapping summary is incomplete: %#v", bundle.Capabilities)
			}
			if tc.wantKind == reproductionBundleSourceImport && (bundle.Capabilities["columnMappingCount"] != "1" || bundle.Capabilities["delimiter"] != "comma" || bundle.Capabilities["conflictKeyCount"] != "1") {
				t.Fatalf("import option summary is incomplete: %#v", bundle.Capabilities)
			}
			if bundle.Fixture.Engine != reproductionBundleFixtureEngine || bundle.Fixture.Expected.Status != "failed" {
				t.Fatalf("fixture is not replayable: %#v", bundle.Fixture)
			}
			if !containsReproductionEvent(bundle.Events, tc.wantEvent) {
				t.Fatalf("missing event %q: %#v", tc.wantEvent, bundle.Events)
			}

			content, err := json.Marshal(bundle)
			if err != nil {
				t.Fatal(err)
			}
			for _, forbidden := range []string{
				"password", "secret", "customers", "customer@example.com", "private-host",
				"private_table", "private-value", "/Users/private", "customer_db", "customer_rows",
				"source-private", "target-private", "private-connection",
			} {
				if strings.Contains(strings.ToLower(string(content)), strings.ToLower(forbidden)) {
					t.Fatalf("bundle leaked %q: %s", forbidden, content)
				}
			}
		})
	}
}

func TestReproductionBundlePreviewAndOfflineReplayUseOnlyTheFixture(t *testing.T) {
	now := time.UnixMilli(1_700_000_001_000)
	bundle := buildReproductionBundle(reproductionBundleSnapshotFromTrace(requesttrace.Trace{
		RequestID: "query-11111111-2222-3333-4444-555555555555",
		Entry:     "desktop", Operation: "database.query", Status: "error",
		StartedAt: now.Add(-time.Second).UnixMilli(), FinishedAt: now.UnixMilli(),
		Error:  &requesttrace.Error{Kind: "execution", Message: "private error"},
		Events: []requesttrace.Event{{Timestamp: now.Add(-time.Second).UnixMilli(), Name: "request.started"}, {Timestamp: now.UnixMilli(), Name: "request.completed"}},
	}, reproductionBundleSourceQuery), "0.9.3", now)
	content, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}

	preview, err := previewReproductionBundle(string(content))
	if err != nil {
		t.Fatalf("preview failed: %v", err)
	}
	if preview.Source.Kind != reproductionBundleSourceQuery || !preview.OfflineOnly || preview.Redaction.Credentials != "excluded" {
		t.Fatalf("unexpected preview: %#v", preview)
	}

	replay, err := replayReproductionBundle(string(content))
	if err != nil {
		t.Fatalf("offline replay failed: %v", err)
	}
	if !replay.Reproduced || replay.Engine != reproductionBundleFixtureEngine || replay.Status != "failed" || replay.ErrorKind != "execution" {
		t.Fatalf("unexpected replay result: %#v", replay)
	}
	if len(replay.Events) != 2 || replay.Events[1].Name != "request.completed" {
		t.Fatalf("unexpected replay events: %#v", replay.Events)
	}
}

func TestReproductionBundleReplayDetectsExpectationMismatch(t *testing.T) {
	now := time.UnixMilli(1_700_000_001_000)
	bundle := buildReproductionBundle(reproductionBundleSnapshotFromTrace(requesttrace.Trace{
		RequestID: "query-11111111-2222-3333-4444-555555555555", Entry: "desktop", Operation: "database.query",
		Status: "error", StartedAt: now.Add(-time.Second).UnixMilli(), FinishedAt: now.UnixMilli(),
		Error: &requesttrace.Error{Kind: "execution"}, Events: []requesttrace.Event{{Timestamp: now.UnixMilli(), Name: "request.failed"}},
	}, reproductionBundleSourceQuery), "0.9.3", now)
	bundle.Fixture.Expected.EventCount++
	content, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := previewReproductionBundle(string(content)); err != nil {
		t.Fatalf("valid mismatched fixture should remain previewable: %v", err)
	}
	replay, err := replayReproductionBundle(string(content))
	if err != nil {
		t.Fatalf("mismatched fixture should run: %v", err)
	}
	if replay.Reproduced {
		t.Fatalf("mismatched fixture was reported as reproduced: %#v", replay)
	}
}

func TestReproductionBundleImportRejectsUnknownOrUnsafeContent(t *testing.T) {
	unsafe := `{"schemaVersion":1,"format":"gonavi-reproduction-bundle","appVersion":"0.9.3","source":{"kind":"query","id":"safe","status":"failed"},"capabilities":{"operation":"password=secret"},"events":[],"fixture":{"engine":"gonavi-fake-v1","input":{"sourceKind":"query","capabilities":{}},"expected":{"status":"failed","errorKind":"execution","events":[]}},"redaction":{"credentials":"excluded","dsn":"excluded","sqlLiterals":"removed","businessValues":"excluded","sensitivePaths":"excluded","rawErrorMessages":"classified_only"},"unexpected":"private"}`
	if _, err := previewReproductionBundle(unsafe); err == nil {
		t.Fatal("unsafe reproduction bundle was accepted")
	}

	now := time.UnixMilli(1_700_000_001_000)
	bundle := buildReproductionBundle(reproductionBundleSnapshotFromTrace(requesttrace.Trace{
		RequestID: "query-11111111-2222-3333-4444-555555555555", Entry: "desktop", Operation: "database.query",
		Status: "error", StartedAt: now.Add(-time.Second).UnixMilli(), FinishedAt: now.UnixMilli(),
		Error: &requesttrace.Error{Kind: "execution"}, Events: []requesttrace.Event{{Timestamp: now.UnixMilli(), Name: "request.failed"}},
	}, reproductionBundleSourceQuery), "0.9.3", now)
	bundle.Capabilities["operation"] = "password-secret"
	bundle.Fixture.Input.Capabilities["operation"] = "password-secret"
	content, err := json.Marshal(bundle)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := previewReproductionBundle(string(content)); err == nil {
		t.Fatal("known fields containing unsafe values were accepted")
	}
}

func TestAppReproductionBundleAPICoversQueryMCPImportAndSyncFailures(t *testing.T) {
	application := NewApp()
	application.configDir = t.TempDir()
	t.Cleanup(application.shutdownDataSyncJobs)
	now := time.Now()

	queryTrace := application.requestDiagnostics().Start(requesttrace.Input{
		RequestID: "query-11111111-2222-3333-4444-555555555555", Entry: "desktop", Operation: "database.query",
	})
	queryTrace.Complete(requesttrace.Completion{Status: "error", ErrorKind: "execution", ErrorMessage: "private row"})
	mcpTrace := application.requestDiagnostics().Start(requesttrace.Input{
		RequestID: "request-11111111-2222-3333-4444-555555555555", Entry: "mcp", Operation: "mcp.get_objects",
	})
	mcpTrace.Complete(requesttrace.Completion{Status: "error", ErrorKind: "tool", ErrorMessage: "secret connection"})

	importStore, err := application.ensureImportJobStore()
	if err != nil {
		t.Fatal(err)
	}
	importRecord, err := importStore.Put(importjob.Job{
		ID: "import-job-fixture", Kind: importjob.KindTable, Status: importjob.StatusFailed,
		SourcePath: "/private/customer.csv", TableName: "customers", Message: "secret row", CreatedAt: now.Add(-time.Second).UnixMilli(),
	})
	if err != nil {
		t.Fatal(err)
	}

	manager, err := application.ensureDataSyncJobManager()
	if err != nil {
		t.Fatal(err)
	}
	definition, err := manager.PutJob(context.Background(), approvalTestDefinition())
	if err != nil {
		t.Fatal(err)
	}
	definitionSnapshot, err := json.Marshal(definition)
	if err != nil {
		t.Fatal(err)
	}
	syncRun, err := application.dataSyncJobStore.CreateRun(context.Background(), syncjob.RunRecord{
		ID: "sync-run-fixture", JobID: definition.ID, JobRevision: definition.Revision,
		Status: syncjob.RunStatusFailed, Trigger: syncjob.RunTriggerManual,
		StartedAt: now.Add(-time.Second).UnixMilli(), FinishedAt: now.UnixMilli(),
		DefinitionSnapshot: definitionSnapshot, Message: "private row failed",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := application.dataSyncJobStore.AppendRunEvent(context.Background(), syncjob.RunEvent{
		RunID: syncRun.ID, JobID: syncRun.JobID, Type: syncjob.RunEventFailed,
		Status: syncjob.RunStatusFailed, Message: "customer@example.com", CreatedAt: now.UnixMilli(),
	}); err != nil {
		t.Fatal(err)
	}

	sourcesResult := application.ListReproductionBundleSources()
	if !sourcesResult.Success {
		t.Fatalf("list sources failed: %s", sourcesResult.Message)
	}
	page := sourcesResult.Data.(reproductionBundleSourcePage)
	for _, source := range []reproductionBundleSourceRef{
		{Kind: reproductionBundleSourceQuery, ID: queryTrace.ID()},
		{Kind: reproductionBundleSourceMCP, ID: mcpTrace.ID()},
		{Kind: reproductionBundleSourceImport, ID: importRecord.ID},
		{Kind: reproductionBundleSourceSync, ID: syncRun.ID},
	} {
		if !containsReproductionSource(page.Items, source) {
			t.Fatalf("source missing from page: %#v in %#v", source, page)
		}
		result := application.BuildReproductionBundle(string(source.Kind), source.ID)
		if !result.Success {
			t.Fatalf("build %s bundle failed: %s", source.Kind, result.Message)
		}
		payload := result.Data.(reproductionBundleExportPayload)
		if payload.Content == "" || payload.MimeType != "application/json;charset=utf-8" {
			t.Fatalf("invalid %s export payload: %#v", source.Kind, payload)
		}
		preview := application.PreviewReproductionBundle(payload.Content)
		if !preview.Success || !preview.Data.(reproductionBundlePreview).OfflineOnly {
			t.Fatalf("preview %s failed: %#v", source.Kind, preview)
		}
		replay := application.ReplayReproductionBundle(payload.Content)
		if !replay.Success || !replay.Data.(reproductionBundleReplayResult).Reproduced {
			t.Fatalf("replay %s failed: %#v", source.Kind, replay)
		}
	}
}

func containsReproductionSource(items []reproductionBundleSourceSummary, source reproductionBundleSourceRef) bool {
	for _, item := range items {
		if item.Kind == source.Kind && item.ID == source.ID {
			return true
		}
	}
	return false
}

func containsReproductionEvent(events []reproductionBundleEvent, name string) bool {
	for _, event := range events {
		if event.Name == name {
			return true
		}
	}
	return false
}
