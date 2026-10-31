package pluginmarket

import (
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"
)

func TestCatalogDiscoversPublishedPluginsRequiringNewerHost(t *testing.T) {
	for _, hostVersion := range []string{"0.0.1-test", "0.6.5", "1.1.5-dev.20", "1.1.5"} {
		t.Run(hostVersion, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				query := r.URL.Query()
				if r.URL.Path != "/api/v1/plugins" || query.Get("platform") != runtime.GOOS+"/"+runtime.GOARCH || query.Get("limit") != "24" {
					t.Errorf("unexpected catalog request: %s", r.URL)
				}
				if query.Get("q") != "nginx" || query.Get("sort") != "updated" {
					t.Errorf("search/sort lost: %s", r.URL)
				}
				items := []Item{}
				if query.Get("hostVersion") == "" || query.Get("hostVersion") == "1.1.5" {
					item := fixtureItem("com.gonavi.nginx-inspector", true)
					item.MinHostVersion = "1.1.5"
					items = append(items, item)
				}
				writeTestJSON(t, w, http.StatusOK, CatalogPage{Items: items})
			}))
			defer server.Close()
			service := newTestService(t, server.URL, true)
			service.hostVersion = hostVersion
			page, err := service.Catalog(t.Context(), "nginx", "updated", "")
			if err != nil || len(page.Items) != 1 {
				t.Fatalf("published plugin hidden for host %q: page=%+v, err=%v", hostVersion, page, err)
			}
			if page.Items[0].MinHostVersion != "1.1.5" {
				t.Fatal("discovery discarded minimum host requirement")
			}
		})
	}
}
