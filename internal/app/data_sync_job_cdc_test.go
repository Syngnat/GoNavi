package app

import (
	"context"
	"io"
	"testing"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/synccdc"
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
		ID: "mongo-source", Name: "mongo", Config: connection.ConnectionConfig{ID: "mongo-source", Type: "mongodb", Database: "default_db"},
	}); err != nil {
		t.Fatalf("save mongo connection: %v", err)
	}
	adapter := &appCaptureCDCProbeAdapter{}
	registry := synccdc.NewRegistry()
	if err := registry.Register(adapter); err != nil {
		t.Fatalf("register capture adapter: %v", err)
	}
	application.dataSyncCDCRegistry = registry
	result := application.DataSyncCDCProbe("mongo-source", "selected_db", "", adapter.Name())
	if !result.Success {
		t.Fatalf("probe selected database: %s", result.Message)
	}
	if adapter.database != "selected_db" {
		t.Fatalf("probed database = %q, want selected_db", adapter.database)
	}
}
