package aiservice

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/shared/i18n"
)

func TestAITestProviderUsesCodexCLIAndClearsAPISecrets(t *testing.T) {
	original := codexCLIHealthCheckFunc
	defer func() { codexCLIHealthCheckFunc = original }()

	var received ai.ProviderConfig
	codexCLIHealthCheckFunc = func(config ai.ProviderConfig) error {
		received = config
		return nil
	}

	service := newProviderManagementTestService(t)
	result := service.AITestProvider(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "codex-cli",
		AuthMode:  "local-cli",
		APIKey:    "must-not-be-used",
		SecretRef: "provider-secret",
		HasSecret: true,
		BaseURL:   "https://api.example.invalid",
		Headers:   map[string]string{"Authorization": "Bearer old"},
	})

	if result["success"] != true {
		t.Fatalf("expected Codex CLI health check success, got %#v", result)
	}
	if received.APIKey != "" || received.SecretRef != "" || received.HasSecret || received.BaseURL != "" || len(received.Headers) != 0 {
		t.Fatalf("expected local CLI health check to stay credentialless, got %#v", received)
	}
}

func TestCodexCLIRejectsMismatchedAPIKeyAuthBeforeSaveOrTest(t *testing.T) {
	original := codexCLIHealthCheckFunc
	defer func() { codexCLIHealthCheckFunc = original }()
	healthCheckCalled := false
	codexCLIHealthCheckFunc = func(ai.ProviderConfig) error {
		healthCheckCalled = true
		return nil
	}

	service := newProviderManagementTestService(t)
	service.configDir = t.TempDir()
	invalid := ai.ProviderConfig{
		ID:        "provider-invalid-codex",
		Type:      "custom",
		Name:      "Invalid Codex",
		APIFormat: "codex-cli",
		AuthMode:  "api-key",
		APIKey:    "must-not-be-stored",
	}

	if err := service.AISaveProvider(invalid); err == nil || !strings.Contains(err.Error(), "local-cli") {
		t.Fatalf("expected save to reject mismatched Codex auth, got %v", err)
	}
	if len(service.providers) != 0 {
		t.Fatalf("invalid Codex provider must not be persisted: %#v", service.providers)
	}
	result := service.AITestProvider(invalid)
	if result["success"] != false || !strings.Contains(fmt.Sprint(result["message"]), "local-cli") {
		t.Fatalf("expected test to reject mismatched Codex auth, got %#v", result)
	}
	if healthCheckCalled {
		t.Fatal("Codex health check must not run for mismatched API-key auth")
	}
}

func TestAITestProviderUsesClaudeSubscriptionWithoutChangingQwenCLI(t *testing.T) {
	originalProxyCheck := claudeCLIHealthCheckFunc
	originalLocalCheck := claudeCLILocalAuthCheckFunc
	defer func() {
		claudeCLIHealthCheckFunc = originalProxyCheck
		claudeCLILocalAuthCheckFunc = originalLocalCheck
	}()

	var receivedProxy []ai.ProviderConfig
	var receivedLocal []ai.ProviderConfig
	claudeCLIHealthCheckFunc = func(config ai.ProviderConfig) error {
		receivedProxy = append(receivedProxy, config)
		return nil
	}
	claudeCLILocalAuthCheckFunc = func(config ai.ProviderConfig) error {
		receivedLocal = append(receivedLocal, config)
		return nil
	}

	service := newProviderManagementTestService(t)
	localResult := service.AITestProvider(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "claude-cli",
		AuthMode:  "local-cli",
		APIKey:    "must-not-be-used",
		BaseURL:   "https://proxy.example.invalid",
	})
	qwenResult := service.AITestProvider(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "claude-cli",
		APIKey:    "qwen-key",
		BaseURL:   dashScopeCodingPlanAnthropicBaseURL,
	})

	if localResult["success"] != true || qwenResult["success"] != true || len(receivedLocal) != 1 || len(receivedProxy) != 1 {
		t.Fatalf("unexpected health check results: local=%#v qwen=%#v receivedLocal=%#v receivedProxy=%#v", localResult, qwenResult, receivedLocal, receivedProxy)
	}
	if receivedLocal[0].APIKey != "" || receivedLocal[0].SecretRef != "" || receivedLocal[0].HasSecret || receivedLocal[0].BaseURL != "" || len(receivedLocal[0].Headers) != 0 {
		t.Fatalf("expected subscription credentials to be cleared, got %#v", receivedLocal[0])
	}
	if receivedProxy[0].APIKey != "qwen-key" || receivedProxy[0].BaseURL != dashScopeCodingPlanAnthropicBaseURL {
		t.Fatalf("expected Qwen Claude CLI proxy credentials to remain intact, got %#v", receivedProxy[0])
	}
	if receivedProxy[0].Model != dashScopeCodingPlanModels[0] {
		t.Fatalf("expected Qwen probe model, got %#v", receivedProxy[0])
	}
}

func TestAISaveProviderRemovesExistingSecretWhenSwitchingToLocalCLIAuth(t *testing.T) {
	service := newProviderManagementTestService(t)
	service.configDir = t.TempDir()
	service.providers = []ai.ProviderConfig{{
		ID:        "provider-existing",
		Type:      "openai",
		Name:      "OpenAI",
		APIKey:    "old-api-key",
		HasSecret: true,
		BaseURL:   "https://api.openai.com/v1",
	}}

	err := service.AISaveProvider(ai.ProviderConfig{
		ID:        "provider-existing",
		Type:      "custom",
		Name:      "Codex subscription",
		AuthMode:  "local-cli",
		APIFormat: "codex-cli",
		APIKey:    "stale-form-secret",
		HasSecret: true,
		SecretRef: "stale-secret-ref",
		BaseURL:   "https://stale.example.invalid",
	})
	if err != nil {
		t.Fatalf("save local CLI provider: %v", err)
	}
	if len(service.providers) != 1 {
		t.Fatalf("expected one provider, got %#v", service.providers)
	}
	stored := service.providers[0]
	if stored.APIKey != "" || stored.SecretRef != "" || stored.HasSecret || stored.BaseURL != "" {
		t.Fatalf("expected saved subscription provider to be credentialless, got %#v", stored)
	}
}

func TestAISaveProviderKeepsHiddenCLIEnvironmentWhenEditingLocalCLI(t *testing.T) {
	service := newProviderManagementTestService(t)
	service.configDir = t.TempDir()
	initial := ai.ProviderConfig{
		ID: "provider-codex", Type: "custom", Name: "Codex subscription",
		AuthMode: "local-cli", APIFormat: "codex-cli", Model: "first",
		CLIEnv: map[string]string{"GONAVI_PRIVATE_TOKEN": "secret-value"},
	}
	if err := service.AISaveProvider(initial); err != nil {
		t.Fatal(err)
	}
	view := service.AIGetProviders()[0]
	if !view.HasSecret || len(view.CLIEnv) != 0 {
		t.Fatalf("public view = %#v, want hidden CLI environment marker", view)
	}
	view.Model = "second"
	if err := service.AISaveProvider(view); err != nil {
		t.Fatal(err)
	}
	if got := service.providers[0].CLIEnv["GONAVI_PRIVATE_TOKEN"]; got != "secret-value" {
		t.Fatalf("hidden CLI environment was lost during edit: %q", got)
	}
}

func TestLocalCLITestRestoresHiddenEnvironmentWithoutAPISecrets(t *testing.T) {
	original := codexCLIHealthCheckFunc
	t.Cleanup(func() { codexCLIHealthCheckFunc = original })
	var received ai.ProviderConfig
	codexCLIHealthCheckFunc = func(config ai.ProviderConfig) error {
		received = config
		return nil
	}
	service := newProviderManagementTestService(t)
	service.configDir = t.TempDir()
	if err := service.AISaveProvider(ai.ProviderConfig{
		ID: "provider-codex", Type: "custom", AuthMode: "local-cli", APIFormat: "codex-cli",
		CLIEnv: map[string]string{
			"CODEX_HOME":     "/private/codex-home",
			"OPENAI_API_KEY": "cli-managed-key",
		},
	}); err != nil {
		t.Fatal(err)
	}
	view := service.AIGetProviders()[0]
	if result := service.AITestProvider(view); result["success"] != true {
		t.Fatalf("provider test failed: %#v", result)
	}
	if received.CLIEnv["CODEX_HOME"] != "/private/codex-home" {
		t.Fatalf("hidden CLI environment was not restored: %#v", received.CLIEnv)
	}
	if received.CLIEnv["OPENAI_API_KEY"] != "cli-managed-key" {
		t.Fatalf("CLI API key environment was not restored: %#v", received.CLIEnv)
	}
	if received.APIKey != "" || received.BaseURL != "" || len(received.Headers) != 0 {
		t.Fatalf("API secrets reached subscription test: %#v", received)
	}
}

func TestAIListModelsReturnsConfiguredLocalCLIModelsWithoutRemoteFetch(t *testing.T) {
	originalFetch := fetchModelsFunc
	defer func() { fetchModelsFunc = originalFetch }()
	fetchModelsFunc = func(config ai.ProviderConfig, localizer *i18n.Localizer) ([]string, error) {
		t.Fatalf("local CLI model list must not use a remote endpoint: %#v", config)
		return nil, nil
	}

	service := newProviderManagementTestService(t)
	service.providers = []ai.ProviderConfig{{
		ID:        "provider-codex",
		Type:      "custom",
		Name:      "Codex subscription",
		AuthMode:  "local-cli",
		APIFormat: "codex-cli",
		Models:    []string{"gpt-5-codex"},
	}}
	service.activeProvider = "provider-codex"

	result := service.AIListModels()
	if result["success"] != true || result["source"] != "static" {
		t.Fatalf("expected static local CLI models, got %#v", result)
	}
	models, ok := result["models"].([]string)
	if !ok || len(models) != 1 || models[0] != "gpt-5-codex" {
		t.Fatalf("unexpected model list: %#v", result["models"])
	}
}

func TestResolveModelsURLPreservesNonLocalClaudeCLICompatibleEndpoint(t *testing.T) {
	url := resolveModelsURL(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "claude-cli",
		BaseURL:   "https://proxy.example/v1",
	})
	if url != "https://proxy.example/v1/models" {
		t.Fatalf("expected non-local Claude CLI proxy models endpoint, got %q", url)
	}
}

func TestFetchModelsPreservesNonLocalClaudeCLICompatibleRequest(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("expected /v1/models request, got %q", r.URL.Path)
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer proxy-key" {
			t.Errorf("expected proxy API key, got %q", auth)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"qwen-proxy-model"}]}`))
	}))
	defer server.Close()

	models, err := fetchModels(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "claude-cli",
		BaseURL:   server.URL + "/v1",
		APIKey:    "proxy-key",
	}, nil)
	if err != nil {
		t.Fatalf("fetch non-local Claude CLI proxy models: %v", err)
	}
	if len(models) != 1 || models[0] != "qwen-proxy-model" {
		t.Fatalf("unexpected proxy model list: %#v", models)
	}
}

func TestLocalCLIAuthRequiresExplicitCredentialSource(t *testing.T) {
	if isLocalCLIAuthProvider(ai.ProviderConfig{Type: "custom", APIFormat: "claude-cli"}) {
		t.Fatal("Qwen/custom Claude CLI must not become subscription auth implicitly")
	}
	if !isLocalCLIAuthProvider(ai.ProviderConfig{Type: "custom", APIFormat: "claude-cli", AuthMode: "local-cli"}) {
		t.Fatal("expected explicit Claude local CLI auth to be recognized")
	}
	if !isLocalCLIAuthProvider(ai.ProviderConfig{Type: "custom", APIFormat: "codex-cli", AuthMode: "LOCAL-CLI"}) {
		t.Fatal("expected Codex local CLI auth to be case-insensitive")
	}
}
