package app

import (
	"context"
	"errors"
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

func (a *App) probeDataSyncCDC(config connection.ConnectionConfig, adapterName string) (synccdc.Capability, error) {
	adapterName = strings.TrimSpace(adapterName)
	if adapterName == "" {
		return synccdc.Capability{}, errors.New("CDC adapter is required")
	}
	adapter, err := a.dataSyncCDCAdapters().Get(adapterName)
	if err != nil {
		return synccdc.Capability{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), dataSyncCDCProbeTimeout)
	defer cancel()
	return adapter.Probe(ctx, config)
}

func (a *App) DataSyncCDCAdapterList() connection.QueryResult {
	return connection.QueryResult{Success: true, Data: a.dataSyncCDCAdapters().Names()}
}

func (a *App) DataSyncCDCProbe(connectionID, database, schema, adapterName string) connection.QueryResult {
	endpoint, err := a.resolveDataSyncJobEndpoint(connectionID, database, schema)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	capability, err := a.probeDataSyncCDC(normalizeMetadataRunConfig(endpoint.Config, endpoint.Database), adapterName)
	if err != nil {
		return connection.QueryResult{Success: false, Message: err.Error()}
	}
	return connection.QueryResult{Success: true, Data: capability}
}
