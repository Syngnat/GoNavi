package pluginmarket

import (
	"context"

	"GoNavi-Wails/internal/marketfilter"
)

// CatalogFiltered requires complete source-side filtering before pagination.
// Publisher identity on untrusted sources never grants the host's official badge.
func (s *Service) CatalogFiltered(ctx context.Context, query, order, cursor string, value marketfilter.Filters) (CatalogPage, error) {
	if err := ctx.Err(); err != nil {
		return CatalogPage{}, err
	}
	filters, err := marketfilter.Normalize(value)
	if err != nil {
		return CatalogPage{}, ErrInvalidRequest
	}
	source, err := s.snapshot()
	if err != nil {
		return CatalogPage{Items: []Item{}, Error: errorCode(err)}, err
	}
	values, err := s.catalogQuery(query, order, cursor)
	if err != nil {
		return CatalogPage{}, err
	}
	if !source.trusted && filters.Official == "official" {
		if err := s.checkSource(source); err != nil {
			return CatalogPage{Items: []Item{}, Error: errorCode(err)}, err
		}
		return CatalogPage{Items: []Item{}, SourceID: source.id, FilterVersion: marketfilter.Version}, nil
	}
	values.Set("filtersVersion", "1")
	for _, category := range filters.Categories {
		values.Add("categories", category)
	}
	if len(filters.Platforms) > 0 {
		values.Del("platform")
		for _, platform := range filters.Platforms {
			values.Add("platforms", platform)
		}
	}
	if source.trusted && filters.Official != "" {
		values.Set("official", filters.Official)
	}
	if filters.Author != "" {
		values.Set("author", filters.Author)
	}
	return s.fetchCatalogPageFrom(ctx, source, values, true)
}
