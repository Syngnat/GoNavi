package app

import (
	"context"
	"io"
	"testing"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/synccdc"
	"GoNavi-Wails/internal/syncjob"
)

type appTestCDCAdapter struct{}

func (appTestCDCAdapter) Name() string          { return "test-change-stream" }
func (appTestCDCAdapter) SourceTypes() []string { return []string{"test-cdc-source"} }
func (appTestCDCAdapter) Probe(context.Context, connection.ConnectionConfig) (synccdc.Capability, error) {
	return synccdc.Capability{Adapter: "test-change-stream", Supported: true, Ready: true}, nil
}

type appCaptureCDCProbeAdapter struct {
	database string
}

func (a *appCaptureCDCProbeAdapter) Name() string { return "capture-change-stream" }

// Keep the fake on a test-only source key: NewRegistry already owns mongodb via
// the production adapter, while this test resolves the fake explicitly by name.
func (a *appCaptureCDCProbeAdapter) SourceTypes() []string { return []string{"capture-cdc-source"} }
func (a *appCaptureCDCProbeAdapter) Probe(_ context.Context, config connection.ConnectionConfig) (synccdc.Capability, error) {
	a.database = config.Database
	return synccdc.Capability{Adapter: a.Name(), Supported: true, Ready: true}, nil
}
func (a *appCaptureCDCProbeAdapter) BeginSnapshot(context.Context, synccdc.Request) (synccdc.Barrier, error) {
	return synccdc.Barrier{}, nil
}
func (a *appCaptureCDCProbeAdapter) Open(context.Context, synccdc.Request, synccdc.Position) (synccdc.Stream, error) {
	return nil, io.EOF
}
func (appTestCDCAdapter) BeginSnapshot(context.Context, synccdc.Request) (synccdc.Barrier, error) {
	return synccdc.Barrier{}, nil
}
func (appTestCDCAdapter) Open(context.Context, synccdc.Request, synccdc.Position) (synccdc.Stream, error) {
	return nil, io.EOF
}

func TestProbeDataSyncCDCUsesInjectedRegistry(t *testing.T) {
	registry := synccdc.NewRegistry()
	if err := registry.Register(appTestCDCAdapter{}); err != nil {
		t.Fatalf("register test adapter: %v", err)
	}
	application := NewApp()
	application.dataSyncCDCRegistry = registry
	capability, err := application.probeDataSyncCDC(connection.ConnectionConfig{Type: "test-cdc-source"}, "test-change-stream")
	if err != nil {
		t.Fatalf("probeDataSyncCDC returned error: %v", err)
	}
	if !capability.Supported || !capability.Ready || capability.Adapter != "test-change-stream" {
		t.Fatalf("unexpected CDC capability: %#v", capability)
	}
}

func TestProbeDataSyncCDCAutomaticallyResolvesTheSourceAdapter(t *testing.T) {
	registry := synccdc.NewRegistry()
	if err := registry.Register(appTestCDCAdapter{}); err != nil {
		t.Fatalf("register test adapter: %v", err)
	}
	application := NewApp()
	application.dataSyncCDCRegistry = registry
	capability, err := application.probeDataSyncCDC(connection.ConnectionConfig{Type: "test-cdc-source"}, "")
	if err != nil {
		t.Fatalf("probeDataSyncCDC auto resolution returned error: %v", err)
	}
	if capability.Adapter != "test-change-stream" || !capability.Supported || !capability.Ready {
		t.Fatalf("unexpected auto-resolved CDC capability: %#v", capability)
	}
}

func TestDefaultDataSyncCDCRegistryIncludesMongoDB(t *testing.T) {
	names := NewApp().dataSyncCDCAdapters().Names()
	for _, name := range names {
		if name == "mongodb-change-stream" {
			return
		}
	}
	t.Fatalf("default CDC adapters = %#v, want mongodb-change-stream", names)
}

func TestDataSyncCDCProbeUsesSelectedDatabaseInsteadOfSavedDefault(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	if _, err := application.SaveConnection(connection.SavedConnectionInput{
		ID: "capture-source", Name: "capture", Config: connection.ConnectionConfig{ID: "capture-source", Type: "capture-cdc-source", Database: "default_db"},
	}); err != nil {
		t.Fatalf("save mongo connection: %v", err)
	}
	adapter := &appCaptureCDCProbeAdapter{}
	registry := synccdc.NewRegistry()
	if err := registry.Register(adapter); err != nil {
		t.Fatalf("register capture adapter: %v", err)
	}
	application.dataSyncCDCRegistry = registry
	result := application.DataSyncCDCProbe("capture-source", "selected_db", "", "")
	if !result.Success {
		t.Fatalf("probe selected database: %s", result.Message)
	}
	if adapter.database != "selected_db" {
		t.Fatalf("probed database = %q, want selected_db", adapter.database)
	}
}

func TestDataSyncJobPreflightProbesSelectedCDCSourceDatabase(t *testing.T) {
	application := NewAppWithSecretStore(newFakeAppSecretStore())
	application.configDir = t.TempDir()
	if _, err := application.SaveConnection(connection.SavedConnectionInput{
		ID: "capture-source", Name: "capture", Config: connection.ConnectionConfig{ID: "capture-source", Type: "capture-cdc-source", Database: "default_db"},
	}); err != nil {
		t.Fatalf("save source connection: %v", err)
	}
	if _, err := application.SaveConnection(connection.SavedConnectionInput{
		ID: "capture-target", Name: "target", Config: connection.ConnectionConfig{ID: "capture-target", Type: "mysql", Database: "target_db"},
	}); err != nil {
		t.Fatalf("save target connection: %v", err)
	}
	adapter := &appCaptureCDCProbeAdapter{}
	registry := synccdc.NewRegistry()
	if err := registry.Register(adapter); err != nil {
		t.Fatalf("register capture adapter: %v", err)
	}
	application.dataSyncCDCRegistry = registry

	definition := syncjob.JobDefinition{
		Name: "capture CDC", Lifecycle: syncjob.JobLifecycleReady,
		Kind: syncjob.JobKindReconcile, IncrementalMode: syncjob.IncrementalCDC,
		Source: syncjob.EndpointRef{ConnectionID: "capture-source", Database: "selected_db"},
		Target: syncjob.EndpointRef{ConnectionID: "capture-target", Database: "target_db"},
		Mappings: []syncjob.TableMapping{{
			SourceTable: "events", TargetTable: "events", Enabled: true,
			KeyColumns: []string{"id"}, Columns: []syncjob.ColumnMapping{{Source: "id", Target: "id"}},
		}},
		Options:  syncjob.ExecutionOptions{Content: "data", SyncMode: "insert_update", TargetTableStrategy: "existing_only", BatchSize: 1000, ErrorPolicy: syncjob.ErrorPolicyStop, RetryBackoffMillis: 500},
		Schedule: syncjob.ScheduleSpec{Kind: syncjob.ScheduleManual},
		CDC:      &syncjob.CDCSpec{},
	}
	_ = application.preflightDataSyncJob(definition, time.Now())
	if adapter.database != "selected_db" {
		t.Fatalf("preflight probed database = %q, want selected_db", adapter.database)
	}
}
