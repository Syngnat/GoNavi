package pluginmarket

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCatalogOfflineCacheIsLastGoodAndSourceScoped(t *testing.T) {
	var mode atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("public catalog sent bearer")
		}
		if r.URL.Query().Has("hostVersion") || r.URL.Query().Get("limit") != "24" || r.URL.Query().Get("platform") == "" {
			t.Error("unexpected discovery filters")
		}
		switch mode.Load() {
		case 1:
			writeTestJSON(t, w, 503, map[string]string{"code": "server_busy", "message": "not cached"})
		case 2:
			writeTestJSON(t, w, 200, map[string]any{"items": nil})
		default:
			writeTestJSON(t, w, 200, CatalogPage{Items: []Item{fixtureItem("community.example", false), fixtureItem("official.example", true)}, NextCursor: "cursor-2"})
		}
	}))
	defer server.Close()
	service := newTestService(t, server.URL, true)
	page, err := service.Catalog(t.Context(), "keyword", "rating", "")
	if err != nil || page.Stale || len(page.Items) != 2 || !page.Items[0].Official || page.CachedAt == nil || page.SourceID == "" {
		t.Fatalf("live catalog = %+v, %v", page, err)
	}
	fetched := *page.CachedAt
	mode.Store(1)
	restarted, err := NewService(Options{Root: service.root, TrustedOfficialURL: server.URL, HostVersion: "1.2.3"})
	if err != nil {
		t.Fatal(err)
	}
	page, err = restarted.Catalog(t.Context(), "keyword", "rating", "")
	if err == nil || !page.Stale || page.Error != "server_busy" || !page.CachedAt.Equal(fetched) || len(page.Items) != 2 {
		t.Fatalf("offline catalog = %+v, %v", page, err)
	}
	other, err := restarted.Catalog(t.Context(), "other", "rating", "")
	if err == nil || other.Stale || len(other.Items) != 0 {
		t.Fatalf("query cache leaked: %+v, %v", other, err)
	}
	mode.Store(2)
	page, err = restarted.Catalog(t.Context(), "keyword", "rating", "")
	assertErrorIs(t, err, ErrInvalidResponse)
	if !page.Stale || page.Error != "invalid_response" || len(page.Items) != 2 {
		t.Fatalf("bad response destroyed last-good cache: %+v", page)
	}
	cacheFiles, err := filepath.Glob(filepath.Join(service.root, "cache", "*.json"))
	if err != nil || len(cacheFiles) != 1 {
		t.Fatalf("cache files = %v, %v", cacheFiles, err)
	}
	otherServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer otherServer.Close()
	if _, err = restarted.Configure(t.Context(), otherServer.URL); err != nil {
		t.Fatal(err)
	}
	page, err = restarted.Catalog(t.Context(), "keyword", "rating", "")
	if err == nil || page.Stale || len(page.Items) != 0 {
		t.Fatalf("cache crossed sources: %+v, %v", page, err)
	}
}

func TestOfficialBadgeRequiresHostOwnedTrust(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/plugins") {
			writeTestJSON(t, w, 200, CatalogPage{Items: []Item{fixtureItem("spoof.plugin", true)}})
			return
		}
		writeTestJSON(t, w, 200, fixtureItem("spoof.plugin", true))
	}))
	defer server.Close()
	for _, trusted := range []bool{false, true} {
		t.Run(fmt.Sprintf("trusted=%t", trusted), func(t *testing.T) {
			service := newTestService(t, server.URL, trusted)
			page, err := service.Catalog(t.Context(), "", "", "")
			if err != nil {
				t.Fatal(err)
			}
			item, err := service.Detail(t.Context(), "spoof.plugin")
			if err != nil {
				t.Fatal(err)
			}
			if item.Official != trusted || page.Items[0].Official != trusted || item.SourceID != sourceID(server.URL) {
				t.Fatalf("trust mismatch: %+v / %+v", page, item)
			}
		})
	}
}

func TestSourceChangeFencesInFlightCatalog(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		writeTestJSON(t, w, 200, CatalogPage{Items: []Item{fixtureItem("old.plugin", true)}})
	}))
	defer server.Close()
	service := newTestService(t, server.URL, true)
	type result struct {
		page CatalogPage
		err  error
	}
	done := make(chan result, 1)
	go func() { page, err := service.Catalog(t.Context(), "", "", ""); done <- result{page: page, err: err} }()
	<-entered
	if _, err := service.Configure(t.Context(), "https://different.example"); err != nil {
		t.Fatal(err)
	}
	close(release)
	outcome := <-done
	assertErrorIs(t, outcome.err, ErrSourceChanged)
	if len(outcome.page.Items) != 0 {
		t.Fatal("stale origin response exposed after source switch")
	}
}

func TestCacheHasBoundedPagesAndRejectsCorruption(t *testing.T) {
	var failing atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if failing.Load() {
			w.WriteHeader(503)
			return
		}
		writeTestJSON(t, w, 200, CatalogPage{Items: []Item{}})
	}))
	defer server.Close()
	service := newTestService(t, server.URL, false)
	for i := 0; i < maxCachePages+3; i++ {
		if _, err := service.Catalog(t.Context(), fmt.Sprint(i), "", ""); err != nil {
			t.Fatal(err)
		}
	}
	files, err := filepath.Glob(filepath.Join(service.root, "cache", "*.json"))
	if err != nil || len(files) != maxCachePages {
		t.Fatalf("cache files = %d, %v", len(files), err)
	}
	if _, err = service.Catalog(t.Context(), "final", "", ""); err != nil {
		t.Fatal(err)
	}
	source, err := service.snapshot()
	if err != nil {
		t.Fatal(err)
	}
	query, err := service.catalogQuery("final", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(service.cachePath(source, query.Encode()), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	failing.Store(true)
	page, err := service.Catalog(t.Context(), "final", "", "")
	assertErrorIs(t, err, ErrInvalidResponse)
	if page.Stale || len(page.Items) != 0 {
		t.Fatal("corrupt cache accepted")
	}
}

func TestRatingsReadStaysPublicAndBounded(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/plugins/publisher.plugin/ratings" {
			t.Errorf("unexpected ratings request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if r.Header.Get("Authorization") != "" {
			t.Error("public ratings read sent credentials")
		}
		writeTestJSON(t, w, 200, []Rating{{UserID: "user", PluginID: "publisher.plugin", Stars: 4, Body: "review", Version: "1.0.0"}})
	}))
	defer server.Close()
	service := newTestService(t, server.URL, false)
	ratings, err := service.Ratings(t.Context(), "publisher.plugin")
	if err != nil || len(ratings) != 1 || ratings[0].Stars != 4 {
		t.Fatalf("ratings=%+v, %v", ratings, err)
	}
	_, err = service.Ratings(t.Context(), "bad id")
	assertErrorIs(t, err, ErrInvalidRequest)
}
