package app

import (
	"context"
	"strings"
)

type pluginCapabilitySyncRunArguments struct {
	JobID string `json:"jobId,omitempty"`
	RunID string `json:"runId,omitempty"`
	Limit int    `json:"limit,omitempty"`
}

func pluginCapabilitySyncRuns(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilitySyncRunArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	limit := arguments.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	result := a.DataSyncRunList(strings.TrimSpace(arguments.JobID), limit)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilitySyncRun(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilitySyncRunArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	runID := strings.TrimSpace(arguments.RunID)
	if runID == "" || len(runID) > 256 {
		return nil, "invalid_arguments"
	}
	result := a.DataSyncRunGet(runID)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}
