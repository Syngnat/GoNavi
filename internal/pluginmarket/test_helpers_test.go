package pluginmarket

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"
	"time"
)

func newTestService(t *testing.T, base string, trusted bool) *Service {
	t.Helper()
	options := Options{Root: t.TempDir(), HostVersion: "1.2.3"}
	if trusted {
		options.TrustedOfficialURL = base
	}
	service, err := NewService(options)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = service.Configure(t.Context(), base); err != nil {
		t.Fatal(err)
	}
	return service
}

func writeTestJSON(t *testing.T, w http.ResponseWriter, status int, value any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		t.Errorf("write response: %v", err)
	}
}

func fixtureItem(id string, official bool) Item {
	return Item{ID: id, Name: id, Version: "1.0.0", Official: official, PublisherID: "publisher",
		Platforms: []string{"any"}, RatingAverage: 4.5, RatingCount: 2, UpdatedAt: time.Now().UTC()}
}

func assertErrorIs(t *testing.T, err, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("error = %v, want %v", err, target)
	}
}
