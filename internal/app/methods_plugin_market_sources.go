package app

import (
	"context"

	"GoNavi-Wails/internal/connection"
	"GoNavi-Wails/internal/pluginmarket"
)

func (a *App) marketSourceCall(ctx context.Context, sourceID string, call func(context.Context, *pluginmarket.Service) (any, error)) connection.QueryResult {
	return a.marketCall(ctx, func(ctx context.Context, root *pluginmarket.Service) (any, error) {
		source, err := root.ForSource(sourceID)
		if err != nil {
			return nil, err
		}
		return call(ctx, source)
	})
}

// PluginMarketSources returns saved sources without credentials or network access.
func (a *App) PluginMarketSources() connection.QueryResult {
	return a.marketCall(a.pluginContext(), func(_ context.Context, s *pluginmarket.Service) (any, error) { return s.Sources(), nil })
}

// PluginMarketSaveSources atomically saves endpoints and their network opt-in.
func (a *App) PluginMarketSaveSources(sources []pluginmarket.SourceConfig) connection.QueryResult {
	return a.pluginMarketSaveSourcesContext(a.pluginContext(), sources)
}

func (a *App) pluginMarketSaveSourcesContext(ctx context.Context, sources []pluginmarket.SourceConfig) connection.QueryResult {
	if !a.pluginManagementAllowed() {
		return a.pluginFailure("management_denied")
	}
	return a.marketCall(ctx, func(ctx context.Context, s *pluginmarket.Service) (any, error) {
		rows, err := s.SaveSources(ctx, sources)
		if err == nil {
			a.cancelDisabledMarketApprovals(rows)
		}
		return rows, err
	})
}

// PluginMarketSourceSettings returns the session state for one enabled source.
func (a *App) PluginMarketSourceSettings(sourceID string) connection.QueryResult {
	return a.marketSourceCall(a.pluginContext(), sourceID, func(_ context.Context, s *pluginmarket.Service) (any, error) { return s.Settings() })
}

// PluginMarketSourceCatalog fetches one independent page from a registered source.
func (a *App) PluginMarketSourceCatalog(sourceID, query, sort, cursor string) connection.QueryResult {
	return a.marketSourceCall(a.pluginContext(), sourceID, func(ctx context.Context, s *pluginmarket.Service) (any, error) {
		return s.Catalog(ctx, query, sort, cursor)
	})
}

// PluginMarketSourceDetail returns details bound to the selected registered source.
func (a *App) PluginMarketSourceDetail(sourceID, id string) connection.QueryResult {
	return a.marketSourceCall(a.pluginContext(), sourceID, func(ctx context.Context, s *pluginmarket.Service) (any, error) { return s.Detail(ctx, id) })
}

// PluginMarketSourceRatings returns ratings from one source without combining identities.
func (a *App) PluginMarketSourceRatings(sourceID, id string) connection.QueryResult {
	return a.marketSourceCall(a.pluginContext(), sourceID, func(ctx context.Context, s *pluginmarket.Service) (any, error) { return s.Ratings(ctx, id) })
}
