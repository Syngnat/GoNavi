package app

import (
	"context"
	"strings"
)

// pluginCapabilityBackupStatus exposes only local scheduler state. It never
// returns endpoints, object keys, credentials or runs a remote request.
func pluginCapabilityBackupStatus(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	if len(request.Arguments) > 0 {
		var arguments map[string]any
		if !decodePluginPageArguments(request.Arguments, &arguments) || len(arguments) > 0 {
			return nil, "invalid_arguments"
		}
	}
	config, err := a.loadCloudBackupConfig()
	if err != nil {
		return nil, "internal"
	}
	dirty, _ := a.cloudBackupDirtyState()
	status := a.cloudBackupStatusFromConfig(config, dirty)
	// Sync errors can include remote endpoints, object keys or paths; expose a stable code.
	if strings.TrimSpace(status.LastSyncError) != "" {
		status.LastSyncError = "backup_failed"
	}
	return status, ""
}
