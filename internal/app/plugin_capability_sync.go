package app

import (
	"context"
	"strings"
)

type pluginCapabilitySyncJobArguments struct {
	JobID string `json:"jobId,omitempty"`
}

func pluginCapabilitySyncJobs(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	if len(request.Arguments) > 0 && strings.TrimSpace(string(request.Arguments)) != "{}" {
		return nil, "invalid_arguments"
	}
	result := a.DataSyncJobList()
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}

func pluginCapabilitySyncJob(_ context.Context, a *App, request pluginCapabilityRequest) (any, string) {
	var arguments pluginCapabilitySyncJobArguments
	if !decodePluginPageArguments(request.Arguments, &arguments) {
		return nil, "invalid_arguments"
	}
	jobID := strings.TrimSpace(arguments.JobID)
	if jobID == "" || len(jobID) > 256 {
		return nil, "invalid_arguments"
	}
	result := a.DataSyncJobGet(jobID)
	if !result.Success {
		return nil, "internal"
	}
	return result.Data, ""
}
