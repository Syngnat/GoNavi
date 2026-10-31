package app

import (
	"context"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/marketfilter"
	"GoNavi-Wails/internal/pluginmarket"
)

// PluginMarketSourceSearch searches a registered source using full-catalog predicates.
func (a *App) PluginMarketSourceSearch(sourceID, query, order, cursor string, filters marketfilter.Filters) connection.QueryResult {
	return a.pluginMarketSourceSearchContext(a.pluginContext(), sourceID, query, order, cursor, filters)
}
func (a *App) pluginMarketSourceSearchContext(ctx context.Context, sourceID, query, order, cursor string, filters marketfilter.Filters) connection.QueryResult {
	return a.marketSourceCall(ctx, sourceID, func(ctx context.Context, s *pluginmarket.Service) (any, error) {
		return s.CatalogFiltered(ctx, query, order, cursor, filters)
	})
}
