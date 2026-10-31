package pluginmarket

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourcesDefaultAndLegacyMigration(t *testing.T) {
	for _, test := range []struct {
		name, legacy                    string
		privateEnabled, officialEnabled bool
	}{
		{name: "fresh", officialEnabled: true},
		{name: "private", legacy: "https://private.example", privateEnabled: true},
		{name: "disabled", legacy: "disabled"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			if test.legacy != "" {
				base := test.legacy
				if base == "disabled" {
					base = ""
				}
				if err := atomicJSON(filepath.Join(root, "settings.json"), diskState{Version: 1, BaseURL: base, Installs: map[string]installedSource{}}, maxStateBytes); err != nil {
					t.Fatal(err)
				}
			}
			s, err := NewService(Options{Root: root, TrustedOfficialURL: "https://plugin.gonavi.org"})
			if err != nil {
				t.Fatal(err)
			}
			sources := s.Sources()
			if len(sources) < 1 || sources[0].BaseURL != "https://plugin.gonavi.org" || !sources[0].TrustedOfficial || sources[0].Enabled != test.officialEnabled {
				t.Fatalf("sources=%+v", sources)
			}
			if test.privateEnabled && (len(sources) != 2 || !sources[1].Enabled || sources[1].TrustedOfficial) {
				t.Fatalf("legacy private=%+v", sources)
			}
		})
	}
}

func TestSourcesSaveValidateAndPersist(t *testing.T) {
	s, err := NewService(Options{Root: t.TempDir(), TrustedOfficialURL: "https://plugin.gonavi.org"})
	if err != nil {
		t.Fatal(err)
	}
	list := []SourceConfig{{BaseURL: "https://plugin.gonavi.org", Enabled: false}, {BaseURL: "https://private.example/api/v1/", Enabled: true}}
	if _, err = s.SaveSources(t.Context(), list); err != nil {
		t.Fatal(err)
	}
	reloaded, err := NewService(Options{Root: s.root, TrustedOfficialURL: s.officialURL})
	if err != nil {
		t.Fatal(err)
	}
	sources := reloaded.Sources()
	if len(sources) != 2 || sources[0].Enabled || sources[1].BaseURL != "https://private.example" || !sources[1].Enabled {
		t.Fatalf("persisted=%+v", sources)
	}
	for _, invalid := range [][]SourceConfig{
		{{BaseURL: "https://private.example", Enabled: true}},
		{{BaseURL: s.officialURL, Enabled: true}, {BaseURL: s.officialURL + "/api/v1", Enabled: true}},
		{{BaseURL: s.officialURL, Enabled: true}, {BaseURL: "http://remote.example", Enabled: true}},
	} {
		if _, err = s.SaveSources(t.Context(), invalid); err == nil {
			t.Fatalf("accepted invalid sources: %+v", invalid)
		}
	}
	if len(s.Sources()) != 2 {
		t.Fatal("failed save changed sources")
	}
}

func TestSourcesClientsAreIsolatedAndRevokedAcrossABA(t *testing.T) {
	a := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(t, w, 200, CatalogPage{Items: []Item{fixtureItem("test.same", true)}})
	}))
	defer a.Close()
	b := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeTestJSON(t, w, 200, CatalogPage{Items: []Item{fixtureItem("test.same", true)}})
	}))
	defer b.Close()
	s := newTestService(t, a.URL, true)
	list := []SourceConfig{{BaseURL: a.URL, Enabled: true}, {BaseURL: b.URL, Enabled: true}}
	if _, err := s.SaveSources(t.Context(), list); err != nil {
		t.Fatal(err)
	}
	first, err := s.ForSource(sourceID(a.URL))
	if err != nil {
		t.Fatal(err)
	}
	other, err := s.ForSource(sourceID(b.URL))
	if err != nil {
		t.Fatal(err)
	}
	for _, client := range []*Service{first, other} {
		page, err := client.Catalog(t.Context(), "", "updated", "")
		if err != nil || len(page.Items) != 1 || page.SourceID != sourceID(client.state.BaseURL) {
			t.Fatalf("page=%+v err=%v", page, err)
		}
		if page.Items[0].Official != (client == first) {
			t.Fatal("custom source spoofed official")
		}
	}
	list[0].Enabled = false
	if _, err = s.SaveSources(t.Context(), list); err != nil {
		t.Fatal(err)
	}
	if _, err = first.CurrentSourceID(); !errors.Is(err, ErrSourceChanged) {
		t.Fatalf("disabled scope still active: %v", err)
	}
	if _, err = s.ForSource(sourceID(a.URL)); err == nil {
		t.Fatal("disabled source acquired")
	}
	list[0].Enabled = true
	if _, err = s.SaveSources(t.Context(), list); err != nil {
		t.Fatal(err)
	}
	again, err := s.ForSource(sourceID(a.URL))
	if err != nil || again == first {
		t.Fatal("old scope resurrected across ABA")
	}
	if _, err = first.CurrentSourceID(); !errors.Is(err, ErrSourceChanged) {
		t.Fatal("old approval scope revived")
	}
	s.state.Installs["test.same"] = installedSource{SourceID: sourceID(a.URL), Version: "1.0.0", TransportSHA256: sourceTestDigest([]byte("a")), ContentDigest: sourceTestDigest([]byte("content"))}
	if err = other.VerifyInstallSource(t.Context(), "test.same", sourceTestDigest([]byte("content"))); !errors.Is(err, ErrSourceMismatch) {
		t.Fatalf("cross-source update accepted: %v", err)
	}
	if err = again.VerifyInstallSource(t.Context(), "test.same", sourceTestDigest([]byte("content"))); err != nil {
		t.Fatal(err)
	}
	if err = again.ForgetInstall(t.Context(), "test.same"); err != nil {
		t.Fatal(err)
	}
	if _, exists := s.state.Installs["test.same"]; exists {
		t.Fatal("global provenance not cleared")
	}
}

func TestSourcesFailedPersistenceDoesNotChangeEnabledScopes(t *testing.T) {
	s := newTestService(t, "https://plugin.gonavi.org", true)
	client, err := s.ForSource(sourceID(s.officialURL))
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(s.root, "settings.json")
	if err = os.Remove(file); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(file, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err = s.SaveSources(t.Context(), []SourceConfig{{BaseURL: s.officialURL, Enabled: false}}); err == nil {
		t.Fatal("save unexpectedly succeeded")
	}
	if _, err = client.CurrentSourceID(); err != nil {
		t.Fatalf("failed transaction revoked scope: %v", err)
	}
}

func sourceTestDigest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func TestSourcesShareDownloadAdmissionAndProvenance(t *testing.T) {
	s := newTestService(t, "https://official.example", true)
	if _, err := s.SaveSources(t.Context(), []SourceConfig{{BaseURL: s.officialURL, Enabled: true}, {BaseURL: "https://private.example", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	a, _ := s.ForSource(sourceID(s.officialURL))
	b, _ := s.ForSource(sourceID("https://private.example"))
	clients := []*Service{a, b, a, b}
	for _, client := range clients {
		snapshot, err := client.snapshot()
		if err != nil {
			t.Fatal(err)
		}
		if err = client.reserveDownload(snapshot, "test.shared"); err != nil {
			t.Fatal(err)
		}
	}
	snapshot, _ := a.snapshot()
	if err := a.reserveDownload(snapshot, "test.shared"); !errors.Is(err, ErrBusy) {
		t.Fatalf("aggregate download limit bypassed: %v", err)
	}
	for _, client := range clients {
		client.releaseDownload()
	}
	s.state.Installs["test.shared"] = installedSource{SourceID: sourceID(s.officialURL)}
	snapshot, _ = b.snapshot()
	if err := b.reserveDownload(snapshot, "test.shared"); !errors.Is(err, ErrSourceMismatch) {
		t.Fatalf("global provenance bypassed: %v", err)
	}
}

func TestSourcesRejectOversizedCanonicalURLWithoutPoisoningState(t *testing.T) {
	s := newTestService(t, "https://plugin.gonavi.org", true)
	raw := "https://private.example/" + strings.Repeat(string(rune(0x4e00)), 300)
	if _, err := s.SaveSources(t.Context(), []SourceConfig{{BaseURL: s.officialURL, Enabled: true}, {BaseURL: raw, Enabled: true}}); err == nil {
		t.Fatal("accepted URL whose canonical encoding exceeds the limit")
	}
	if len(s.Sources()) != 1 {
		t.Fatal("invalid canonical URL changed saved sources")
	}
	if _, err := NewService(Options{Root: s.root, TrustedOfficialURL: s.officialURL}); err != nil {
		t.Fatalf("source state poisoned: %v", err)
	}
}

func TestSourcesRemovingEndpointPreservesInstallProvenance(t *testing.T) {
	s := newTestService(t, "https://plugin.gonavi.org", true)
	private := "https://private.example"
	configs := []SourceConfig{{BaseURL: s.officialURL, Enabled: true}, {BaseURL: private, Enabled: true}}
	if _, err := s.SaveSources(t.Context(), configs); err != nil {
		t.Fatal(err)
	}
	digest := sourceTestDigest([]byte("installed-content"))
	s.state.Installs["test.retained"] = installedSource{SourceID: sourceID(private), Version: "1.0.0", TransportSHA256: sourceTestDigest([]byte("archive")), ContentDigest: digest}
	if _, err := s.SaveSources(t.Context(), configs[:1]); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewService(Options{Root: s.root, TrustedOfficialURL: s.officialURL})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := restarted.state.Installs["test.retained"]; !ok {
		t.Fatal("removing endpoint erased install provenance")
	}
	if _, err = restarted.SaveSources(t.Context(), configs); err != nil {
		t.Fatal(err)
	}
	client, err := restarted.ForSource(sourceID(private))
	if err != nil {
		t.Fatal(err)
	}
	if err = client.VerifyInstallSource(t.Context(), "test.retained", digest); err != nil {
		t.Fatalf("re-added original source lost provenance: %v", err)
	}
}
