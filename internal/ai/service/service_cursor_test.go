package aiservice

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestResolveModelsURL_UsesCursorModelsEndpoint(t *testing.T) {
	url := resolveModelsURL(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "cursor-agent",
		BaseURL:   "https://api.cursor.com/v1",
	})
	if url != "https://api.cursor.com/v1/models" {
		t.Fatalf("expected cursor models endpoint, got %q", url)
	}
}

func TestAITestProvider_UsesCursorModelsEndpointAndBearerAuth(t *testing.T) {
	var (
		receivedPath          string
		receivedAuthorization string
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedPath = r.URL.Path
		receivedAuthorization = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{
				{"id": "composer-2"},
			},
		})
	}))
	defer server.Close()

	service := NewService()
	result := service.AITestProvider(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "cursor-agent",
		BaseURL:   server.URL + "/v1",
		APIKey:    "cursor-key",
	})

	if result["success"] != true {
		t.Fatalf("expected AITestProvider to succeed, got %#v", result)
	}
	if receivedPath != "/v1/models" {
		t.Fatalf("expected cursor health check to hit /v1/models, got %q", receivedPath)
	}
	if receivedAuthorization != "Bearer cursor-key" {
		t.Fatalf("expected bearer auth header, got %q", receivedAuthorization)
	}
}

func TestAIListModels_FetchesCursorModelItems(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{
				{"id": "composer-2"},
				{"id": "composer-latest"},
			},
		})
	}))
	defer server.Close()

	service := NewService()
	service.providers = []ai.ProviderConfig{
		{
			ID:        "provider-cursor",
			Type:      "custom",
			APIFormat: "cursor-agent",
			BaseURL:   server.URL + "/v1",
			APIKey:    "cursor-key",
		},
	}
	service.activeProvider = "provider-cursor"

	result := service.AIListModels()
	if result["success"] != true {
		t.Fatalf("expected AIListModels to succeed, got %#v", result)
	}

	models, ok := result["models"].([]string)
	if !ok {
		t.Fatalf("expected []string models, got %#v", result["models"])
	}
	if len(models) != 2 || models[0] != "composer-2" || models[1] != "composer-latest" {
		t.Fatalf("unexpected models: %#v", models)
	}
	if source, _ := result["source"].(string); source != "api" {
		t.Fatalf("expected api source, got %#v", result["source"])
	}
}
