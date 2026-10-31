package app

import (
	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/pluginmarket"
	"context"
)

// PluginMarketVersions returns source-validated published versions and host compatibility.
func (a *App) PluginMarketVersions(id string) connection.QueryResult {
	return a.pluginMarketVersionsContext(a.pluginContext(), id)
}
func (a *App) pluginMarketVersionsContext(ctx context.Context, id string) connection.QueryResult {
	return a.marketCall(ctx, func(ctx context.Context, s *pluginmarket.Service) (any, error) { return s.Versions(ctx, id) })
}

// PluginMarketSourceVersions reads version history from the explicitly registered source only.
func (a *App) PluginMarketSourceVersions(sourceID, id string) connection.QueryResult {
	return a.pluginMarketSourceVersionsContext(a.pluginContext(), sourceID, id)
}
func (a *App) pluginMarketSourceVersionsContext(ctx context.Context, sourceID, id string) connection.QueryResult {
	return a.marketSourceCall(ctx, sourceID, func(ctx context.Context, s *pluginmarket.Service) (any, error) { return s.Versions(ctx, id) })
}
func withMarketVersionContextHandlers(a *App, handlers map[string]any) map[string]any {
	handlers["PluginMarketVersions"] = a.pluginMarketVersionsContext
	handlers["PluginMarketSourceVersions"] = a.pluginMarketSourceVersionsContext
	return handlers
}
