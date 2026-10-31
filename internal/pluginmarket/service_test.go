package pluginmarket

import (
	"context"
	"errors"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNormalizeBase(t *testing.T) {
	tests := []struct {
		name, raw, want string
		invalid         bool
	}{
		{name: "unconfigured"},
		{name: "https", raw: " HTTPS://Market.Example:443/api/v1/ ", want: "https://market.example"},
		{name: "prefix", raw: "https://market.example/private/api/v1", want: "https://market.example/private"},
		{name: "loopback", raw: "http://127.0.0.1:8080/", want: "http://127.0.0.1:8080"},
		{name: "ipv6 loopback", raw: "http://[::1]:8080", want: "http://[::1]:8080"},
		{name: "localhost", raw: "http://localhost:8080", want: "http://localhost:8080"},
		{name: "remote plaintext", raw: "http://market.example", invalid: true},
		{name: "LAN plaintext", raw: "http://192.168.1.2", invalid: true},
		{name: "host spoof", raw: "http://localhost.example", invalid: true},
		{name: "credentials", raw: "https://user:password@market.example", invalid: true},
		{name: "fragment", raw: "https://market.example/#token", invalid: true},
		{name: "query", raw: "https://market.example/?token=secret", invalid: true},
		{name: "empty query", raw: "https://market.example/?", invalid: true},
		{name: "file", raw: "file:///tmp/market", invalid: true},
		{name: "relative", raw: "market.example", invalid: true},
		{name: "parent path", raw: "https://market.example/api/../other", invalid: true},
		{name: "encoded path", raw: "https://market.example/%2e%2e/other", invalid: true},
		{name: "bad port", raw: "https://market.example:65536", invalid: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := normalizeBase(test.raw)
			if test.invalid {
				assertErrorIs(t, err, ErrInvalidURL)
				return
			}
			if err != nil || got != test.want {
				t.Fatalf("normalize = %q, %v; want %q", got, err, test.want)
			}
		})
	}
}

func TestConfigurePersistenceAndAtomicRollback(t *testing.T) {
	root := t.TempDir()
	service, err := NewService(Options{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	settings, err := service.Settings()
	if err != nil || settings.BaseURL != "" || settings.TrustedOfficial {
		t.Fatalf("default settings = %+v, %v", settings, err)
	}
	if _, err = service.Configure(t.Context(), "https://a.example/api/v1"); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Configure(t.Context(), "https://b.example"); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewService(Options{Root: root})
	if err != nil {
		t.Fatal(err)
	}
	settings, err = restarted.Settings()
	if err != nil || settings.BaseURL != "https://b.example" || settings.SourceID != sourceID(settings.BaseURL) {
		t.Fatalf("reloaded = %+v, %v", settings, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err = service.Configure(ctx, "https://c.example")
	assertErrorIs(t, err, context.Canceled)
	path := filepath.Join(root, "settings.json")
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Configure(t.Context(), "https://c.example"); err == nil {
		t.Fatal("expected persistence error")
	}
	settings, err = service.Settings()
	if err != nil || settings.BaseURL != "https://b.example" {
		t.Fatalf("failed write changed memory: %+v, %v", settings, err)
	}
	temporary, err := filepath.Glob(filepath.Join(root, ".market-state-*"))
	if err != nil || len(temporary) != 0 {
		t.Fatalf("temporary state leaked: %v, %v", temporary, err)
	}
}

func TestCorruptStateFailsClosed(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "settings.json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewService(Options{Root: root}); err == nil {
		t.Fatal("corruption silently reset settings")
	}
}

func TestRequestsRejectRedirects(t *testing.T) {
	var destinationHits, customRedirects atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { destinationHits.Add(1); w.WriteHeader(204) }))
	defer destination.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL+"/?sensitive=should-not-leak", http.StatusTemporaryRedirect)
	}))
	defer origin.Close()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	original := &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { customRedirects.Add(1); return nil }}
	service, err := NewService(Options{Root: t.TempDir(), Client: original})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Configure(t.Context(), origin.URL); err != nil {
		t.Fatal(err)
	}
	_, err = service.Detail(t.Context(), "publisher.plugin")
	assertErrorIs(t, err, ErrRedirect)
	if strings.Contains(err.Error(), "sensitive") {
		t.Fatal("error leaked the redirect target")
	}
	if destinationHits.Load() != 0 || customRedirects.Load() != 0 {
		t.Fatal("redirect was followed")
	}
	if original.Jar != jar || original.Timeout != 0 {
		t.Fatal("caller-owned client mutated")
	}
	if service.client.Jar != nil || service.client.Timeout != apiTimeout || service.downloadClient.Timeout != downloadTimeout {
		t.Fatal("client bounds missing")
	}
}

func TestRequestCancellationPropagates(t *testing.T) {
	done := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done(); close(done) }))
	defer server.Close()
	service := newTestService(t, server.URL, false)
	ctx, cancel := context.WithTimeout(t.Context(), 50*time.Millisecond)
	defer cancel()
	_, err := service.Detail(ctx, "publisher.plugin")
	assertErrorIs(t, err, context.DeadlineExceeded)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("request context not canceled")
	}
}

func TestResponseBoundsAndJSONFailures(t *testing.T) {
	tests := []struct {
		name, body string
		want       error
	}{
		{name: "missing items", body: "{}", want: ErrInvalidResponse},
		{name: "null", body: "null", want: ErrInvalidResponse},
		{name: "null items", body: `{"items":null}`, want: ErrInvalidResponse},
		{name: "malformed", body: "{", want: ErrInvalidResponse},
		{name: "trailing JSON", body: `{"items":[]}{}`, want: ErrInvalidResponse},
		{name: "too large", body: strings.Repeat("a", maxJSONBytes+1), want: ErrResponseTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, err := w.Write([]byte(test.body))
				if err != nil && !errors.Is(err, context.Canceled) {
					return
				}
			}))
			defer server.Close()
			service := newTestService(t, server.URL, false)
			page, err := service.Catalog(t.Context(), "", "", "")
			assertErrorIs(t, err, test.want)
			if page.Stale || page.Error == "" {
				t.Fatalf("bad fallback metadata: %+v", page)
			}
		})
	}
}

func TestStructuredErrorDoesNotEchoMessage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(t, w, 403, map[string]string{"code": "forbidden", "message": "bearer-secret"})
	}))
	defer server.Close()
	service := newTestService(t, server.URL, false)
	_, err := service.Detail(t.Context(), "publisher.plugin")
	var api *APIError
	if !errors.As(err, &api) || api.StatusCode != 403 || api.Code != "forbidden" || strings.Contains(err.Error(), "bearer-secret") {
		t.Fatalf("API error = %v", err)
	}
}
