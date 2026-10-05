package aiservice

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/runharness"
	"GoNavi-Wails/internal/dailysecret"
)

func writeAIConfigFixture(t *testing.T, dir string, providers []ai.ProviderConfig, active string) {
	t.Helper()
	data, err := json.Marshal(map[string]any{
		"schemaVersion":  aiConfigSchemaVersion,
		"providers":      providers,
		"activeProvider": active,
		"safetyLevel":    "readonly",
		"contextLevel":   "schema_only",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, aiConfigFileName), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// A stale in-memory copy of the account token must never be written back over
// the freshly refreshed one when unrelated provider settings are saved.
func TestBuiltinAITokenSurvivesUnrelatedConfigSave(t *testing.T) {
	t.Setenv("GONAVI_AI_GATEWAY_URL", "https://ai.example.test")
	dir := t.TempDir()
	writeAIConfigFixture(t, dir, []ai.ProviderConfig{
		{ID: "gonavi-ai", Type: "custom", Name: "GoNavi AI", AuthMode: "bearer", APIFormat: "openai", BaseURL: "https://ai.example.test/v1", Model: "gonavi-sql", HasSecret: true},
		{ID: "other", Type: "openai", Name: "Other", BaseURL: "https://api.example.test/v1", Model: "m"},
	}, "gonavi-ai")
	s := NewServiceWithSecretStore(nil)
	s.configDir = dir
	if err := s.dailySecretStore().PutAIProvider(builtinAIAccountKey, dailysecret.ProviderBundle{
		APIKey:           "access-old",
		SensitiveHeaders: map[string]string{builtinAIRefreshTokenKey: "refresh-old", builtinAITokenExpiresKey: time.Now().Add(-time.Hour).Format(time.RFC3339)},
	}); err != nil {
		t.Fatal(err)
	}
	s.loadConfig()

	previous := builtinAIHTTPDo
	builtinAIHTTPDo = func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"access_token":"access-new","refresh_token":"refresh-new","token_type":"Bearer","expires_in":3600}`))}, nil
	}
	t.Cleanup(func() { builtinAIHTTPDo = previous })

	status, err := s.AIGetBuiltinAIStatus()
	if err != nil || !status.Authenticated {
		t.Fatalf("status = %+v err=%v", status, err)
	}
	// Any later settings write persists the whole provider list.
	if err := s.AISetActiveProvider("other"); err != nil {
		t.Fatal(err)
	}
	if err := s.AISetActiveProvider("gonavi-ai"); err != nil {
		t.Fatal(err)
	}
	bundle, ok, err := s.builtinAIToken()
	if err != nil || !ok {
		t.Fatalf("token missing: ok=%v err=%v", ok, err)
	}
	if bundle.APIKey != "access-new" || bundle.SensitiveHeaders[builtinAIRefreshTokenKey] != "refresh-new" {
		t.Fatalf("refreshed token was overwritten by a stale copy: %+v", bundle)
	}
}

// A saved record without address/model, under a random legacy id, must still
// resolve to a usable gateway provider at send time.
func TestBuiltinAIPartialLegacyRecordResolvesForAgentSend(t *testing.T) {
	t.Setenv("GONAVI_AI_GATEWAY_URL", "https://ai.example.test")
	dir := t.TempDir()
	writeAIConfigFixture(t, dir, []ai.ProviderConfig{
		{ID: "provider-ab12cd34", Type: "custom", Name: "GoNavi AI", AuthMode: "bearer", APIFormat: "openai"},
	}, "provider-ab12cd34")
	s := NewServiceWithSecretStore(nil)
	s.configDir = dir
	s.loadConfig()
	if err := s.dailySecretStore().PutAIProvider(builtinAIAccountKey, dailysecret.ProviderBundle{
		APIKey:           "access-1",
		SensitiveHeaders: map[string]string{builtinAIRefreshTokenKey: "refresh-1", builtinAITokenExpiresKey: time.Now().Add(time.Hour).Format(time.RFC3339)},
	}); err != nil {
		t.Fatal(err)
	}
	list := s.AIGetProviders()
	if len(list) != 1 || list[0].ID != builtinAIProviderID || !list[0].HasSecret || list[0].BaseURL != "https://ai.example.test/v1" || list[0].Model != "gonavi-sql" {
		t.Fatalf("legacy record was not completed: %+v", list)
	}
	if got := s.AIGetActiveProvider(); got != builtinAIProviderID {
		t.Fatalf("active provider = %q", got)
	}
	input := runharness.AgentInputRequest{SessionID: "session-partial"}
	if err := s.bindAgentProviderInput(&input); err != nil {
		t.Fatalf("bind agent provider: %v", err)
	}
	binding, ok := input.ProviderBindingForHost()
	if !ok {
		t.Fatal("binding missing")
	}
	var cfg ai.ProviderConfig
	if err := json.Unmarshal(binding.Config, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.APIKey != "access-1" || cfg.BaseURL != "https://ai.example.test/v1" || cfg.Model != "gonavi-sql" || cfg.ContextWindow != builtinAIContextWindow {
		t.Fatalf("binding is not a complete gateway provider: %+v", cfg)
	}
}
