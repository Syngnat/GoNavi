package aiservice

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/runharness"
	"GoNavi-Wails/internal/dailysecret"
)

func builtinLegacyTestService(t *testing.T) *Service {
	t.Helper()
	t.Setenv("GONAVI_AI_GATEWAY_URL", "https://ai.syngnat.top")
	s := NewServiceWithSecretStore(nil)
	s.configDir = t.TempDir()
	s.providers = []ai.ProviderConfig{{ID: "provider-legacy", Type: "custom", Name: "GoNavi AI", AuthMode: "bearer", APIFormat: "openai", BaseURL: "https://ai.syngnat.top/v1", Model: "gonavi-sql"}}
	s.activeProvider = "provider-legacy"
	if err := s.dailySecretStore().PutAIProvider(builtinAIAccountKey, dailysecret.ProviderBundle{
		APIKey: "access-fixture", SensitiveHeaders: map[string]string{"refresh-token": "refresh-fixture", "expires-at": time.Now().Add(time.Hour).Format(time.RFC3339)},
	}); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestBuiltinLegacyProviderUsesAccountTokenForTestAndAgentBinding(t *testing.T) {
	s := builtinLegacyTestService(t)
	oldDo := builtinAIHTTPDo
	builtinAIHTTPDo = func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != "Bearer access-fixture" {
			t.Error("account token missing from gateway request")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"dailyTokenLimit":60000,"rolling5hTokenLimit":20000}`))}, nil
	}
	t.Cleanup(func() { builtinAIHTTPDo = oldDo })
	list := s.AIGetProviders()
	if len(list) != 1 || !list[0].HasSecret {
		t.Fatal("logged-in legacy provider is still missing its secret")
	}
	if result := s.AITestProvider(list[0]); result["success"] != true {
		t.Fatalf("legacy connection test failed: %v", result["message"])
	}
	input := runharness.AgentInputRequest{Provider: "provider-legacy", SessionID: "session-legacy"}
	if err := s.bindAgentProviderInput(&input); err != nil {
		t.Fatalf("bind desktop agent: %v", err)
	}
	// This is the binding used by the real desktop send path, not the legacy chat path.
	binding, ok := input.ProviderBindingForHost()
	if !ok {
		t.Fatal("provider binding missing")
	}
	var cfg ai.ProviderConfig
	if err := json.Unmarshal(binding.Config, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "access-fixture" || cfg.BaseURL != "https://ai.syngnat.top/v1" {
		t.Fatal("agent binding does not contain the built-in endpoint and access token")
	}
	// The product token is the only header the built-in provider sends besides the bearer token.
	for name := range cfg.Headers {
		if !strings.EqualFold(name, "User-Agent") {
			t.Fatalf("refresh token metadata must never become inference headers: %q", name)
		}
	}
}
