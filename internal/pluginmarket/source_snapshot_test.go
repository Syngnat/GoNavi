package pluginmarket

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

type rejectingTransport struct{ requests atomic.Int32 }

func (r *rejectingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	r.requests.Add(1)
	return nil, errors.New("unexpected network request")
}

func TestCurrentSourceIDUsesOnlyLastCommittedState(t *testing.T) {
	transport := &rejectingTransport{}
	service, err := NewService(Options{Root: t.TempDir(), Client: &http.Client{Transport: transport}})
	if err != nil {
		t.Fatal(err)
	}
	id, err := service.CurrentSourceID()
	assertErrorIs(t, err, ErrNotConfigured)
	if id != "" {
		t.Fatal("unconfigured service returned an identity")
	}
	settings, err := service.Configure(t.Context(), "https://First.Example:443/api/v1/")
	if err != nil {
		t.Fatal(err)
	}
	id, err = service.CurrentSourceID()
	if err != nil || id != settings.SourceID || id != sourceID("https://first.example") {
		t.Fatalf("source = %q, %v", id, err)
	}
	settingsPath := filepath.Join(service.root, "settings.json")
	if err = os.Remove(settingsPath); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(settingsPath, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Configure(t.Context(), "https://second.example"); err == nil {
		t.Fatal("persistence fixture did not fail")
	}
	id, err = service.CurrentSourceID()
	if err != nil || id != settings.SourceID {
		t.Fatalf("failed configuration published source = %q, %v", id, err)
	}
	if transport.requests.Load() != 0 {
		t.Fatal("source lookup performed network IO")
	}
	if err = os.Remove(settingsPath); err != nil {
		t.Fatal(err)
	}
	if _, err = service.Configure(t.Context(), ""); err != nil {
		t.Fatal(err)
	}
	id, err = service.CurrentSourceID()
	assertErrorIs(t, err, ErrNotConfigured)
	if id != "" {
		t.Fatal("disabled marketplace retained selected source identity")
	}
}

func TestCurrentSourceIDLoadsPersistedAndTrustedDefaultSources(t *testing.T) {
	service, err := NewService(Options{Root: t.TempDir(), TrustedOfficialURL: "https://official.example/api/v1"})
	if err != nil {
		t.Fatal(err)
	}
	id, err := service.CurrentSourceID()
	if err != nil || id != sourceID("https://official.example") {
		t.Fatalf("default source = %q, %v", id, err)
	}
	if _, err = service.Configure(t.Context(), "https://private.example"); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewService(Options{Root: service.root, TrustedOfficialURL: "https://official.example"})
	if err != nil {
		t.Fatal(err)
	}
	id, err = restarted.CurrentSourceID()
	if err != nil || id != sourceID("https://private.example") {
		t.Fatalf("persisted source = %q, %v", id, err)
	}
}
