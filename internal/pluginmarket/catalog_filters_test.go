package pluginmarket

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"GoNavi-Wails/internal/marketfilter"
)

func TestFilteredCatalogForwardsCanonicalConditionsAndRequiresAcknowledgement(t *testing.T) {
	var acknowledged atomic.Bool
	acknowledged.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("filtersVersion") != "1" || q.Get("author") != "GoNavi" || q.Get("official") != "official" || len(q["categories"]) != 2 || len(q["platforms"]) != 2 || q.Get("platform") != "" {
			t.Errorf("filters not forwarded: %s", r.URL)
		}
		page := CatalogPage{Items: []Item{fixtureItem("test.filtered", true)}}
		if acknowledged.Load() {
			page.FilterVersion = 1
		}
		writeTestJSON(t, w, 200, page)
	}))
	defer server.Close()
	s := newTestService(t, server.URL, true)
	filters := marketfilter.Filters{Categories: []string{"skill", "ops"}, Platforms: []string{"windows/amd64", "darwin/arm64"}, Official: "official", Author: " GoNavi "}
	page, err := s.CatalogFiltered(t.Context(), "test", "updated", "", filters)
	if err != nil || len(page.Items) != 1 || page.FilterVersion != 1 {
		t.Fatalf("page=%+v err=%v", page, err)
	}
	acknowledged.Store(false)
	stale, err := s.CatalogFiltered(t.Context(), "test", "updated", "", filters)
	if !errors.Is(err, ErrFiltersUnsupported) || !stale.Stale || len(stale.Items) != 1 {
		t.Fatalf("filtered cache not explicit: %+v %v", stale, err)
	}
	unsupported, err := s.CatalogFiltered(t.Context(), "different", "updated", "", filters)
	if !errors.Is(err, ErrFiltersUnsupported) || len(unsupported.Items) != 0 {
		t.Fatalf("ignored source filters accepted: %+v %v", unsupported, err)
	}
}
func TestPrivateSourceIdentityCannotSpoofOfficialFilter(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Query().Get("official") != "" {
			t.Error("private publishers treated as host official")
		}
		writeTestJSON(t, w, 200, CatalogPage{FilterVersion: 1, Items: []Item{fixtureItem("test.private", true)}})
	}))
	defer server.Close()
	s := newTestService(t, server.URL, false)
	page, err := s.CatalogFiltered(t.Context(), "", "updated", "", marketfilter.Filters{Official: "official"})
	if err != nil || len(page.Items) != 0 || calls.Load() != 0 {
		t.Fatalf("private source promoted: %+v %v", page, err)
	}
	page, err = s.CatalogFiltered(t.Context(), "", "updated", "", marketfilter.Filters{Official: "community", Platforms: []string{"all"}})
	if err != nil || len(page.Items) != 1 || page.Items[0].Official {
		t.Fatalf("third-party identity mismatch: %+v %v", page, err)
	}
}
