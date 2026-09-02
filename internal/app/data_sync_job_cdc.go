package app

import (
	"context"
	"fmt"
	"strings"
	"time"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/synccdc"
)

const dataSyncCDCProbeTimeout = 15 * time.Second

func (a *App) dataSyncCDCAdapters() *synccdc.Registry {
	if a != nil && a.dataSyncCDCRegistry != nil {
		return a.dataSyncCDCRegistry
	}
	return synccdc.NewRegistry()
}

// resolveDataSyncCDCAdapter keeps adapter choice server-owned. The registry
// binds each executable adapter to its source family, so a task cannot select
// an unrelated implementation merely because it happens to be installed.
func (a *App) resolveDataSyncCDCAdapter(config connection.ConnectionConfig) (synccdc.Adapter, error) {
	adapter, err := a.dataSyncCDCAdapters().ResolveSource(config.Type)
	if err != nil {
		return nil, fmt.Errorf("no CDC adapter is available for source type %q: %w", strings.TrimSpace(config.Type), err)
	}
	return adapter, nil
}

func (a *App) probeDataSyncCDC(config connection.ConnectionConfig, _ string) (synccdc.Capability, error) {
	adapter, err := a.resolveDataSyncCDCAdapter(config)
	if err != nil {
		return synccdc.Capability{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), dataSyncCDCProbeTimeout)
	defer cancel()
	return adapter.Probe(ctx, config)
}

// dataSyncCDCProbeConfig keeps interactive probes and task preflight on the
// exact same database selected for the source endpoint. Custom connection
// types otherwise retain their saved default database during normalization.
func dataSyncCDCProbeConfig(endpoint resolvedDataSyncJobEndpoint) connection.ConnectionConfig {
	config := normalizeMetadataRunConfig(endpoint.Config, endpoint.Database)
	config.Database = endpoint.Database
	return config
}

func (a *App) DataSyncCDCAdapterList() connection.QueryResult {
	return connection.QueryResult{Success: true, Data: a.dataSyncCDCAdapters().Names()}
}

func (a *App) DataSyncCDCProbe(connectionID, database, schema, _ string) connection.QueryResult {
	endpoint, err := a.resolveDataSyncJobEndpoint(connectionID, database, schema)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	capability, err := a.probeDataSyncCDC(dataSyncCDCProbeConfig(endpoint), "")
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: capability}
}
