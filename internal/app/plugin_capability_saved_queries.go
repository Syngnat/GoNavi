package app

import (
	"context"
)

// pluginCapabilitySavedQueries exposes the user's saved SQL snippets and groups
// without credentials or filesystem paths. The host never executes them here.
func pluginCapabilitySavedQueries(_ context.Context, a *App, _ pluginCapabilityRequest) (any, string) {
	queries, err := a.GetSavedQueries()
	if err != nil {
		return nil, "internal"
	}
	groups, err := a.GetSavedQueryGroups()
	if err != nil {
		return nil, "internal"
	}
	return map[string]any{
		"queries": pluginCapabilityLimitSlice(queries, 2000),
		"groups":  pluginCapabilityLimitSlice(groups, 500),
	}, ""
}
