package app

import (
	"context"
	"fmt"
	"strings"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/jvm"
)

type jvmMonitoringService interface {
	Start(ctx context.Context, cfg connection.ConnectionConfig, requestedMode string) (jvm.MonitoringSessionSnapshot, error)
	GetHistory(connectionID string, providerMode string) (jvm.MonitoringSessionSnapshot, error)
	Stop(connectionID string, providerMode string) error
	Shutdown()
}

var currentJVMMonitoringManager jvmMonitoringService = jvm.NewMonitoringManager()

func closeJVMMonitoringSessions() {
	currentJVMMonitoringManager.Shutdown()
}

func (a *App) JVMStartMonitoring(cfg connection.ConnectionConfig) connection.QueryResult {
	resolved, err := a.resolveConnectionSecrets(cfg)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.localizeJVMError(err)}
	}
	snapshot, err := currentJVMMonitoringManager.Start(a.ctx, resolved, "")
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.localizeJVMError(err)}
	}
	return connection.QueryResult{Success: true, Data: a.localizeJVMMonitoringSnapshot(snapshot)}
}

func (a *App) JVMGetMonitoringHistory(cfg connection.ConnectionConfig, providerMode string) connection.QueryResult {
	connectionID, resolvedMode, err := resolveJVMMonitoringLookup(cfg, providerMode)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.localizeJVMError(err)}
	}

	snapshot, err := currentJVMMonitoringManager.GetHistory(connectionID, resolvedMode)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.localizeJVMError(err)}
	}
	return connection.QueryResult{Success: true, Data: a.localizeJVMMonitoringSnapshot(snapshot)}
}

func (a *App) JVMStopMonitoring(cfg connection.ConnectionConfig, providerMode string) connection.QueryResult {
	connectionID, resolvedMode, err := resolveJVMMonitoringLookup(cfg, providerMode)
	if err != nil {
		return connection.QueryResult{Success: false, Message: a.localizeJVMError(err)}
	}

	if err := currentJVMMonitoringManager.Stop(connectionID, resolvedMode); err != nil {
		return connection.QueryResult{Success: false, Message: a.localizeJVMError(err)}
	}
	return connection.QueryResult{Success: true, Data: map[string]any{
		"connectionId": connectionID,
		"providerMode": resolvedMode,
		"status":       "stopped",
	}}
}

func (a *App) localizeJVMMonitoringSnapshot(snapshot jvm.MonitoringSessionSnapshot) jvm.MonitoringSessionSnapshot {
	if len(snapshot.ProviderWarnings) == 0 {
		return snapshot
	}

	warnings := append([]string(nil), snapshot.ProviderWarnings...)
	for index, warning := range warnings {
		key, params, ok := jvm.ParseMonitoringProviderWarning(warning)
		if !ok {
			continue
		}
		warnings[index] = a.appText(key, params)
	}
	snapshot.ProviderWarnings = warnings
	return snapshot
}

func resolveJVMMonitoringLookup(cfg connection.ConnectionConfig, requestedMode string) (string, string, error) {
	normalized, resolvedMode, err := jvm.ResolveProviderMode(cfg, requestedMode)
	if err != nil {
		return "", "", err
	}
	return resolveJVMMonitoringConnectionID(normalized), resolvedMode, nil
}

func resolveJVMMonitoringConnectionID(cfg connection.ConnectionConfig) string {
	if trimmed := strings.TrimSpace(cfg.ID); trimmed != "" {
		return trimmed
	}
	host := strings.TrimSpace(cfg.Host)
	if host == "" {
		host = "unknown"
	}
	if cfg.Port > 0 {
		return fmt.Sprintf("%s:%d", host, cfg.Port)
	}
	return host
}
