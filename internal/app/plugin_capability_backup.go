package app

import "context"

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
	return a.cloudBackupStatusFromConfig(config, dirty), ""
}
