package app

import (
	"context"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/pluginmarket"
)

var marketSourceContextMethodNames = []string{"PluginMarketSourceSearch", "PluginMarketSources", "PluginMarketSaveSources", "PluginMarketSourceSettings", "PluginMarketSourceCatalog", "PluginMarketSourceDetail", "PluginMarketSourceRatings", "PluginMarketVersions", "PluginMarketSourceVersions"}

func withMarketSourceContextHandlers(a *App, handlers map[string]any) map[string]any {
	handlers["PluginMarketSourceSearch"] = a.pluginMarketSourceSearchContext
	handlers["PluginMarketSources"] = func(ctx context.Context) connection.QueryResult {
		return a.marketCall(ctx, func(_ context.Context, s *pluginmarket.Service) (any, error) { return s.Sources(), nil })
	}
	handlers["PluginMarketSaveSources"] = a.pluginMarketSaveSourcesContext
	handlers["PluginMarketSourceSettings"] = func(ctx context.Context, id string) connection.QueryResult {
		return a.marketSourceCall(ctx, id, func(_ context.Context, s *pluginmarket.Service) (any, error) { return s.Settings() })
	}
	handlers["PluginMarketSourceCatalog"] = func(ctx context.Context, id, q, order, cursor string) connection.QueryResult {
		return a.marketSourceCall(ctx, id, func(ctx context.Context, s *pluginmarket.Service) (any, error) {
			return s.Catalog(ctx, q, order, cursor)
		})
	}
	handlers["PluginMarketSourceDetail"] = func(ctx context.Context, sourceID, id string) connection.QueryResult {
		return a.marketSourceCall(ctx, sourceID, func(ctx context.Context, s *pluginmarket.Service) (any, error) { return s.Detail(ctx, id) })
	}
	handlers["PluginMarketSourceRatings"] = func(ctx context.Context, sourceID, id string) connection.QueryResult {
		return a.marketSourceCall(ctx, sourceID, func(ctx context.Context, s *pluginmarket.Service) (any, error) { return s.Ratings(ctx, id) })
	}
	return withMarketVersionContextHandlers(a, handlers)
}
