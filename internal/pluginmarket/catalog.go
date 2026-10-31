package pluginmarket

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"runtime"
	"sort"
)

// Catalog returns a current page, or the matching last-good page marked stale together with the fetch error.
func (s *Service) Catalog(ctx context.Context, query, order, cursor string) (CatalogPage, error) {
	values, err := s.catalogQuery(query, order, cursor)
	if err != nil {
		return CatalogPage{}, err
	}
	return s.fetchCatalogPage(ctx, values, false)
}

func (s *Service) fetchCatalogPage(ctx context.Context, values url.Values, filtered bool) (CatalogPage, error) {
	source, err := s.snapshot()
	if err != nil {
		return CatalogPage{Items: []Item{}, Error: errorCode(err)}, err
	}
	return s.fetchCatalogPageFrom(ctx, source, values, filtered)
}

func (s *Service) fetchCatalogPageFrom(ctx context.Context, source sourceSnapshot, values url.Values, filtered bool) (CatalogPage, error) {
	var page CatalogPage
	err := s.requestJSON(ctx, source, http.MethodGet, "/plugins", values, nil, &page)
	if err == nil && filtered && page.FilterVersion != 1 {
		err = ErrFiltersUnsupported
	}
	if err == nil {
		err = validatePage(&page, source)
	}
	if err != nil {
		return s.cachedFallback(source, values.Encode(), err)
	}
	if err = s.checkSource(source); err != nil {
		return CatalogPage{Items: []Item{}, Error: errorCode(err)}, err
	}
	page.Stale = false
	page.Error = ""
	fetched := s.now().UTC()
	page.CachedAt = &fetched
	if err = s.cachePage(source, values.Encode(), page); err != nil {
		if errors.Is(err, ErrSourceChanged) {
			return CatalogPage{Items: []Item{}, Error: errorCode(err)}, err
		}
		page.Error = "cache_unavailable"
		return page, err
	}
	return page, nil
}

func (s *Service) catalogQuery(query, order, cursor string) (url.Values, error) {
	if len(query) > 512 || len(cursor) > 1024 {
		return nil, ErrInvalidRequest
	}
	if order == "" {
		order = "updated"
	}
	if order != "updated" && order != "rating" && order != "downloads" {
		return nil, ErrInvalidRequest
	}
	// Discovery includes newer-host releases; the runtime still enforces manifest compatibility.
	return url.Values{"q": {query}, "sort": {order}, "cursor": {cursor}, "limit": {"24"},
		"platform": {runtime.GOOS + "/" + runtime.GOARCH}}, nil
}

// Detail fetches a published entry without pretending that unavailable details are a successful empty result.
func (s *Service) Detail(ctx context.Context, id string) (Item, error) {
	if !validID(id) {
		return Item{}, ErrInvalidRequest
	}
	source, err := s.snapshot()
	if err != nil {
		return Item{}, err
	}
	var item Item
	if err = s.requestJSON(ctx, source, http.MethodGet, "/plugins/"+id, nil, nil, &item); err != nil {
		return Item{}, err
	}
	if err = validateItem(&item, source); err != nil {
		return Item{}, err
	}
	if item.ID != id {
		return Item{}, ErrInvalidResponse
	}
	if err = s.checkSource(source); err != nil {
		return Item{}, err
	}
	return item, nil
}

// Ratings fetches the service's actual visible ratings, never local synthesized stars.
func (s *Service) Ratings(ctx context.Context, id string) ([]Rating, error) {
	if !validID(id) {
		return nil, ErrInvalidRequest
	}
	source, err := s.snapshot()
	if err != nil {
		return nil, err
	}
	var ratings []Rating
	if err = s.requestJSON(ctx, source, http.MethodGet, "/plugins/"+id+"/ratings", nil, nil, &ratings); err != nil {
		return nil, err
	}
	if ratings == nil || len(ratings) > 1000 {
		return nil, ErrInvalidResponse
	}
	for _, rating := range ratings {
		if !validRating(rating, id) {
			return nil, ErrInvalidResponse
		}
	}
	if err = s.checkSource(source); err != nil {
		return nil, err
	}
	return ratings, nil
}

func validatePage(page *CatalogPage, source sourceSnapshot) error {
	if page.Items == nil || len(page.Items) > 100 || len(page.NextCursor) > 1024 {
		return ErrInvalidResponse
	}
	seen := make(map[string]bool, len(page.Items))
	for i := range page.Items {
		if err := validateItem(&page.Items[i], source); err != nil {
			return err
		}
		if seen[page.Items[i].ID] {
			return ErrInvalidResponse
		}
		seen[page.Items[i].ID] = true
	}
	sort.SliceStable(page.Items, func(i, j int) bool { return page.Items[i].Official && !page.Items[j].Official })
	page.SourceID = source.id
	return nil
}

func validateItem(item *Item, source sourceSnapshot) error {
	if !validID(item.ID) || !validVersion(item.Version) || len(item.Name) == 0 || len(item.Name) > 256 ||
		len(item.Description) > 32<<10 || len(item.Author) > 512 || len(item.PublisherID) > 256 || len(item.Category) > 128 ||
		len(item.MinHostVersion) > 128 || item.RatingAverage < 0 || item.RatingAverage > 5 || item.RatingCount < 0 || item.DownloadCount < 0 ||
		len(item.Platforms) > 64 || len(item.Manifest) > 512<<10 {
		return ErrInvalidResponse
	}
	for _, platform := range item.Platforms {
		if len(platform) > 64 {
			return ErrInvalidResponse
		}
	}
	if item.Artifact != nil {
		if err := validateArtifact(*item.Artifact, item.Version); err != nil {
			return err
		}
		artifactURL, err := sameOrigin(source.base, item.Artifact.URL)
		if err != nil || item.Artifact.URL == "" {
			return ErrInvalidResponse
		}
		item.Artifact.URL = artifactURL
	}
	item.Official = item.Official && source.trusted
	item.SourceID = source.id
	return nil
}

func validRating(rating Rating, id string) bool {
	return rating.PluginID == id && len(rating.UserID) > 0 && len(rating.UserID) <= 256 && rating.Stars >= 1 && rating.Stars <= 5 &&
		len(rating.Body) <= 4000 && (rating.Version == "" || validVersion(rating.Version))
}
