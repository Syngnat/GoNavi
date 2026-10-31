package pluginmarket

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestVersionsAreSourceBoundAndCompatibilityChecked(t *testing.T) {
	items := []Item{{ID: "acme.example", Name: "Example", Version: "1.2.0", MinHostVersion: "1.0.0", Platforms: []string{"any"}}, {ID: "acme.example", Name: "Example", Version: "2.0.0", MinHostVersion: "9.0.0", Platforms: []string{"any"}}, {ID: "acme.example", Name: "Example", Version: "1.3.0-rc.1", Platforms: []string{"any"}}, {ID: "acme.example", Name: "Example", Version: "1.1.0", Platforms: []string{"other/cpu"}}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeTestJSON(t, w, 200, items) }))
	defer server.Close()
	service := newTestService(t, server.URL, true)
	page, err := service.Versions(context.Background(), "acme.example")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Versions) != 4 || page.Versions[0].Plugin.Version != "2.0.0" {
		t.Fatalf("unexpected versions: %+v", page)
	}
	byVersion := map[string]VersionChoice{}
	for _, v := range page.Versions {
		byVersion[v.Plugin.Version] = v
		if v.Plugin.SourceID == "" {
			t.Fatal("missing source fence")
		}
	}
	if byVersion["2.0.0"].Compatible || byVersion["2.0.0"].Reason != "host_version" {
		t.Fatal("newer-host release allowed")
	}
	if byVersion["1.1.0"].Compatible || byVersion["1.1.0"].Reason != "platform" {
		t.Fatal("foreign platform allowed")
	}
	if !byVersion["1.2.0"].Compatible || !byVersion["1.3.0-rc.1"].Compatible {
		t.Fatal("compatible release rejected")
	}
}
func TestVersionHistoryFallbackIsExplicit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/versions") {
			writeTestJSON(t, w, 404, map[string]string{"code": "not_found"})
			return
		}
		writeTestJSON(t, w, 200, Item{ID: "acme.example", Name: "Example", Version: "1.0.0", Platforms: []string{"any"}})
	}))
	defer server.Close()
	service := newTestService(t, server.URL, true)
	page, err := service.Versions(context.Background(), "acme.example")
	if err != nil || len(page.Versions) != 1 || page.Warning != "versions_unavailable" {
		t.Fatalf("fallback=%+v err=%v", page, err)
	}
}
func TestVersionsRejectForeignIdentityAndDuplicateVersions(t *testing.T) {
	for _, foreign := range []bool{true, false} {
		t.Run(map[bool]string{true: "foreign identity", false: "duplicate version"}[foreign], func(t *testing.T) {
			items := []Item{{ID: "acme.example", Name: "Example", Version: "1.0.0", Platforms: []string{"any"}}}
			if foreign {
				items[0].ID = "other.example"
			} else {
				items = append(items, items[0])
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeTestJSON(t, w, 200, items) }))
			defer server.Close()
			service := newTestService(t, server.URL, false)
			_, err := service.Versions(context.Background(), "acme.example")
			if !errors.Is(err, ErrInvalidResponse) {
				t.Fatalf("unsafe version response accepted: %v", err)
			}
		})
	}
}

func TestVersionsTreatDevelopmentHostsAsCompatible(t *testing.T) {
	for _, host := range []string{"dev-6748d9e", "0.0.1-test"} {
		t.Run(host, func(t *testing.T) {
			items := []Item{
				{ID: "acme.example", Name: "Example", Version: "2.0.0", MinHostVersion: "9.9.9", Platforms: []string{"any"}},
				{ID: "acme.example", Name: "Example", Version: "1.0.0", MinHostVersion: "9.9.9", Platforms: []string{"other/cpu"}},
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeTestJSON(t, w, 200, items) }))
			defer server.Close()
			service := newTestService(t, server.URL, true)
			service.hostVersion = host
			page, err := service.Versions(context.Background(), "acme.example")
			if err != nil {
				t.Fatal(err)
			}
			for _, choice := range page.Versions {
				if choice.Plugin.Version == "2.0.0" && (!choice.Compatible || choice.Reason != "") {
					t.Fatalf("dev host %q rejected a compatible version: %+v", host, choice)
				}
				if choice.Plugin.Version == "1.0.0" && (choice.Compatible || choice.Reason != "platform") {
					t.Fatalf("dev host %q ignored the platform mismatch: %+v", host, choice)
				}
			}
		})
	}
}
