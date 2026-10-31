package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"

	"GoNavi-Wails/internal/pluginmarket"
)

func TestMarketSourceRoutingNeverChangesLegacySelection(t *testing.T) {
	var calls atomic.Int32
	endpoint := func(name string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			if err := json.NewEncoder(w).Encode(pluginmarket.CatalogPage{Items: []pluginmarket.Item{{ID: "test.shared", Name: name, Version: "1.0.0", Official: true}}}); err != nil {
				t.Error(err)
			}
		}))
	}
	official := endpoint("official")
	defer official.Close()
	private := endpoint("private")
	defer private.Close()
	dir := t.TempDir()
	root := filepath.Join(dir, "plugin-market")
	service, err := pluginmarket.NewService(pluginmarket.Options{Root: root, TrustedOfficialURL: official.URL})
	if err != nil {
		t.Fatal(err)
	}
	configs := []pluginmarket.SourceConfig{{BaseURL: official.URL, Enabled: true}, {BaseURL: private.URL, Enabled: true}}
	sources, err := service.SaveSources(t.Context(), configs)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	app := &App{ctx: ctx, configDir: dir}
	app.pluginMarket.service = service
	app.pluginMarket.root = root
	app.pluginMarket.lifecycle = ctx
	result := app.PluginMarketSourceCatalog(sources[1].SourceID, "", "updated", "")
	page, ok := result.Data.(pluginmarket.CatalogPage)
	if !result.Success || !ok || len(page.Items) != 1 || page.Items[0].Name != "private" || page.Items[0].Official || page.SourceID != sources[1].SourceID {
		t.Fatalf("source routing result=%+v", result)
	}
	settings, err := service.Settings()
	if err != nil || settings.BaseURL != official.URL {
		t.Fatalf("legacy selection moved: %+v %v", settings, err)
	}
	configs[1].Enabled = false
	if _, err = service.SaveSources(t.Context(), configs); err != nil {
		t.Fatal(err)
	}
	if app.PluginMarketSourceCatalog(sources[1].SourceID, "", "updated", "").Success || calls.Load() != 1 {
		t.Fatal("disabled source queried")
	}
	configs[1].Enabled = true
	if _, err = service.SaveSources(t.Context(), configs); err != nil {
		t.Fatal(err)
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	result = app.marketSourceCall(canceled, sources[1].SourceID, func(ctx context.Context, s *pluginmarket.Service) (any, error) {
		return s.Catalog(ctx, "", "updated", "")
	})
	if result.Success || calls.Load() != 1 {
		t.Fatal("canceled source request reached HTTP")
	}
}
