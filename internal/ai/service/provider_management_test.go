package aiservice

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/safety"
	"GoNavi-Wails/shared/i18n"
)

func TestProviderManagementCatalogWithoutEnumeration(t *testing.T) {
	service := newProviderManagementTestService(t)
	for _, test := range []struct {
		apiFormat, source string
		models            []string
	}{
		{"claude-cli", "aliases", []string{"sonnet", "opus", "haiku"}},
		{"unregistered-cli", "none", []string{}},
	} {
		result, err := service.AIGetCLIModelCatalog(test.apiFormat)
		if err != nil || result["source"] != test.source || result["stale"] != false {
			t.Fatalf("catalog must not invent a source: %+v %v", result, err)
		}
		models, ok := result["models"].([]string)
		if !ok || !reflect.DeepEqual(models, test.models) {
			t.Fatalf("unexpected candidates for %s: %v", test.apiFormat, models)
		}
	}
	models, err := service.AIListCLIModels("claude-cli")
	if err != nil || !reflect.DeepEqual(models, []string{"sonnet", "opus", "haiku"}) {
		t.Fatalf("the list interface must expose the same aliases: %v %v", models, err)
	}
}

// Do not use NewService here: its background CLI prewarm reads the host setup.
func newProviderManagementTestService(t *testing.T) *Service {
	t.Helper()
	return &Service{configDir: t.TempDir(), localizer: newServiceLocalizer(), guard: safety.NewGuard(ai.PermissionReadOnly)}
}

func TestProviderManagementCLIUniqueIntegration(t *testing.T) {
	for _, format := range []string{"codex-cli", "claude-cli", "grok-cli", "codebuddy-cli", "cursor-cli"} {
		t.Run(format, func(t *testing.T) {
			service := newProviderManagementTestService(t)
			config := ai.ProviderConfig{ID: "original", Name: "Existing alias", Type: "custom", APIFormat: format, AuthMode: "local-cli", Model: "first-model"}
			if format == "codebuddy-cli" {
				config.AuthMode = "api-key"
			}
			if err := service.AISaveProvider(config); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(filepath.Join(service.configDir, aiConfigFileName))
			if err != nil {
				t.Fatal(err)
			}
			duplicate := config
			duplicate.ID, duplicate.Name, duplicate.Model = "another", "Different alias", "second-model"
			if err := service.AISaveProvider(duplicate); err == nil {
				t.Fatal("another alias/model must not create another CLI integration")
			}
			after, err := os.ReadFile(filepath.Join(service.configDir, aiConfigFileName))
			if err != nil || string(before) != string(after) || len(service.AIGetProviders()) != 1 {
				t.Fatal("rejected duplicate must leave memory and persisted configuration unchanged")
			}
			config.Name, config.Model = "Updated alias", "updated-model"
			if err := service.AISaveProvider(config); err != nil {
				t.Fatal("the existing CLI must remain editable:", err)
			}
			if service.AIGetProviders()[0].Model != "updated-model" {
				t.Fatal("model edit did not persist")
			}
			if err := service.AIDeleteProvider(config.ID); err != nil {
				t.Fatal(err)
			}
			if err := service.AISaveProvider(duplicate); err != nil || len(service.AIGetProviders()) != 1 {
				t.Fatal("removing a CLI must allow a new integration:", err)
			}
		})
	}
}

func TestProviderManagementCLIConcurrentAdd(t *testing.T) {
	service := newProviderManagementTestService(t)
	results := make(chan error, 2)
	var group sync.WaitGroup
	for _, id := range []string{"first", "second"} {
		group.Add(1)
		go func(id string) {
			defer group.Done()
			results <- service.AISaveProvider(ai.ProviderConfig{ID: id, Type: "custom", APIFormat: "codex-cli", AuthMode: "local-cli"})
		}(id)
	}
	group.Wait()
	close(results)
	accepted := 0
	for err := range results {
		if err == nil {
			accepted++
		}
	}
	if accepted != 1 || len(service.AIGetProviders()) != 1 {
		t.Fatal("concurrent requests must only add one CLI integration")
	}
}

func TestProviderManagementCLIFailedSaveAllowsRetry(t *testing.T) {
	service := newProviderManagementTestService(t)
	blocked := filepath.Join(service.configDir, "not-a-directory")
	if err := os.WriteFile(blocked, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	service.configDir = blocked
	config := ai.ProviderConfig{Type: "custom", APIFormat: "codex-cli", AuthMode: "local-cli"}
	if err := service.AISaveProvider(config); err == nil || len(service.AIGetProviders()) != 0 {
		t.Fatal("failed persistence must not reserve a CLI identity in memory")
	}
	service.configDir = t.TempDir()
	if err := service.AISaveProvider(config); err != nil || len(service.AIGetProviders()) != 1 {
		t.Fatal("a failed CLI save must allow retry:", err)
	}
}

func TestProviderManagementLegacyCLIDuplicatesRemainEditable(t *testing.T) {
	service := newProviderManagementTestService(t)
	cli := ai.ProviderConfig{ID: "first", Type: "custom", APIFormat: "claude-cli", AuthMode: "local-cli"}
	other := cli
	other.ID = "second"
	api := ai.ProviderConfig{ID: "api", Type: "openai", APIFormat: "openai"}
	service.providers = []ai.ProviderConfig{cli, other, api}
	other.Model = "updated-model"
	if err := service.AISaveProvider(other); err != nil || len(service.AIGetProviders()) != 3 {
		t.Fatal("legacy duplicates must not be removed or made uneditable:", err)
	}
	conversion := cli
	conversion.ID = api.ID
	if err := service.AISaveProvider(conversion); err == nil || service.AIGetProviders()[2].Type != "openai" {
		t.Fatal("converting another record must not bypass CLI uniqueness")
	}
}

func TestProviderManagementAPIAllowsMultipleConfigurations(t *testing.T) {
	for _, format := range []string{"openai", "cursor-agent", "claude-cli"} {
		t.Run(format, func(t *testing.T) {
			service := newProviderManagementTestService(t)
			for _, id := range []string{"first", "second"} {
				config := ai.ProviderConfig{ID: id, Name: id, Type: "custom", APIFormat: format, AuthMode: "api-key", BaseURL: "https://fixture.invalid/v1"}
				if err := service.AISaveProvider(config); err != nil {
					t.Fatal("API-backed integrations must remain repeatable:", err)
				}
			}
			if len(service.AIGetProviders()) != 2 {
				t.Fatal("same API provider with two configurations must be preserved")
			}
		})
	}
}

func TestProviderManagementSubscriptionCheckScopes(t *testing.T) {
	originalCodex, originalClaude, originalGrok := codexCLIHealthCheckFunc, claudeCLILocalAuthCheckFunc, grokCLIHealthCheckFunc
	originalCursor := cursorCLIHealthCheckFunc
	t.Cleanup(func() {
		codexCLIHealthCheckFunc, claudeCLILocalAuthCheckFunc, grokCLIHealthCheckFunc = originalCodex, originalClaude, originalGrok
		cursorCLIHealthCheckFunc = originalCursor
	})
	for _, test := range []struct{ format, kind string }{
		{"codex-cli", "local-auth"}, {"claude-cli", "local-auth"}, {"grok-cli", "model-list"}, {"cursor-cli", "local-auth"},
	} {
		t.Run(test.format, func(t *testing.T) {
			calls := 0
			check := func(config ai.ProviderConfig) error {
				calls++
				if config.APIKey != "" || config.SecretRef != "" || config.HasSecret || config.BaseURL != "" || len(config.Headers) > 0 {
					t.Fatal("subscription check received API credentials")
				}
				return nil
			}
			codexCLIHealthCheckFunc, claudeCLILocalAuthCheckFunc, grokCLIHealthCheckFunc = check, check, check
			cursorCLIHealthCheckFunc = check
			service := newProviderManagementTestService(t)
			result := service.AITestProvider(ai.ProviderConfig{
				Type: "custom", APIFormat: test.format, AuthMode: "local-cli",
				APIKey: "stale", SecretRef: "stale", HasSecret: true, BaseURL: "https://unused.invalid",
				Headers: map[string]string{"Authorization": "stale"},
			})
			if calls != 1 || result["success"] != true || result["checkKind"] != test.kind || result["modelVerified"] != false {
				t.Fatalf("unexpected check scope or dispatch: calls=%d result=%v", calls, result)
			}
			if !strings.Contains(result["message"].(string), "not verified") {
				t.Fatalf("message must name the unverified model response: %v", result)
			}
		})
	}
}

func TestProviderManagementCursorCLIAndCloudAPIRemainIndependent(t *testing.T) {
	service := newProviderManagementTestService(t)
	local := ai.ProviderConfig{
		ID: "local", Name: "Cursor local alias", Type: "custom", APIFormat: "cursor-cli", AuthMode: "local-cli",
		APIKey: "discarded", SecretRef: "discarded", HasSecret: true, BaseURL: "https://unused.invalid", Headers: map[string]string{"Authorization": "discarded"},
		Models: []string{"saved-model"},
	}
	for _, config := range []ai.ProviderConfig{local,
		{ID: "cloud-a", Type: "custom", APIFormat: "cursor-agent", AuthMode: "api-key", BaseURL: "https://fixture.invalid/v1"},
		{ID: "cloud-b", Type: "custom", APIFormat: "cursor-agent", AuthMode: "api-key", BaseURL: "https://fixture.invalid/v1"},
	} {
		if err := service.AISaveProvider(config); err != nil {
			t.Fatal("Cursor cloud API and local CLI must coexist:", err)
		}
	}
	saved := service.AIGetProviders()[0]
	if len(service.AIGetProviders()) != 3 || saved.APIKey != "" || saved.SecretRef != "" || saved.HasSecret || saved.BaseURL != "" || len(saved.Headers) > 0 {
		t.Fatal("local CLI must not retain stale API secrets or change other integrations")
	}
	if err := service.AISetActiveProvider("local"); err != nil {
		t.Fatal(err)
	}
	originalFetch := fetchModelsFunc
	t.Cleanup(func() { fetchModelsFunc = originalFetch })
	fetchModelsFunc = func(ai.ProviderConfig, *i18n.Localizer) ([]string, error) {
		t.Fatal("local CLI chat model list must not contact an HTTP provider")
		return nil, nil
	}
	result := service.AIListModels()
	if result["success"] != true || result["source"] != "static" || !reflect.DeepEqual(result["models"], []string{"saved-model"}) {
		t.Fatalf("chat model list must preserve the user's saved selection: %v", result)
	}
}

func TestProviderManagementCursorCLIFailureAndAuthMismatch(t *testing.T) {
	original := cursorCLIHealthCheckFunc
	t.Cleanup(func() { cursorCLIHealthCheckFunc = original })
	calls := 0
	cursorCLIHealthCheckFunc = func(ai.ProviderConfig) error { calls++; return errors.New("not signed in") }
	service := newProviderManagementTestService(t)
	config := ai.ProviderConfig{Type: "custom", APIFormat: "cursor-cli", AuthMode: "local-cli"}
	result := service.AITestProvider(config)
	if calls != 1 || result["success"] != false || result["checkKind"] != "local-auth" || result["modelVerified"] != false {
		t.Fatalf("failed Cursor login check must not claim model success: %v", result)
	}
	config.AuthMode = "api-key"
	if service.AITestProvider(config)["success"] != false || calls != 1 {
		t.Fatal("mismatched auth must fail without running the CLI")
	}
	if err := service.AISaveProvider(config); err == nil || len(service.providers) != 0 {
		t.Fatal("mismatched auth must not be saved")
	}
}

func TestProviderManagementGrokFailureAndAuthMismatch(t *testing.T) {
	original := grokCLIHealthCheckFunc
	t.Cleanup(func() { grokCLIHealthCheckFunc = original })
	calls := 0
	grokCLIHealthCheckFunc = func(ai.ProviderConfig) error { calls++; return errors.New("not logged in") }
	service := newProviderManagementTestService(t)
	config := ai.ProviderConfig{Type: "custom", APIFormat: "grok-cli", AuthMode: "local-cli"}
	result := service.AITestProvider(config)
	if calls != 1 || result["success"] != false || result["checkKind"] != "model-list" || result["modelVerified"] != false {
		t.Fatalf("failed Grok check must not claim success: %v", result)
	}
	config.AuthMode = "api-key"
	if service.AITestProvider(config)["success"] != false || calls != 1 {
		t.Fatal("Grok with mismatched auth must fail before running the check")
	}
	if err := service.AISaveProvider(config); err == nil || len(service.providers) != 0 {
		t.Fatal("Grok with mismatched auth must not be saved")
	}
}

func TestProviderManagementUnknownProtocolDoesNotProbe(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; w.WriteHeader(http.StatusOK) }))
	defer server.Close()
	service := newProviderManagementTestService(t)
	for _, endpoint := range []string{"", server.URL} {
		result := service.AITestProvider(ai.ProviderConfig{Type: "custom", APIFormat: "unknown-protocol", BaseURL: endpoint})
		if result["success"] != false || result["checkKind"] != "none" || result["modelVerified"] != false {
			t.Fatalf("unknown protocol must fail closed: %v", result)
		}
	}
	if calls != 0 || service.providerTestResult("none", nil)["success"] != false {
		t.Fatal("a check that never ran must never succeed")
	}
}

func TestProviderManagementEndpointCheckDoesNotClaimModelResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/models" {
			t.Errorf("unexpected endpoint probe: %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()
	result := newProviderManagementTestService(t).AITestProvider(ai.ProviderConfig{Type: "openai", BaseURL: server.URL + "/v1"})
	if result["success"] != true || result["checkKind"] != "endpoint" || result["modelVerified"] != false {
		t.Fatalf("endpoint check is not a model response: %v", result)
	}
}

func TestProviderManagementActiveProviderPersistence(t *testing.T) {
	service := newProviderManagementTestService(t)
	service.providers = []ai.ProviderConfig{{ID: "a", Type: "openai"}, {ID: "b", Type: "openai"}}
	service.activeProvider = "a"
	changes := 0
	service.configChanged = func() { changes++ }
	if err := service.AISetActiveProvider("b"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(service.configDir, aiConfigFileName))
	if err != nil {
		t.Fatal(err)
	}
	var saved aiConfig
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.ActiveProvider != "b" || service.AIGetActiveProvider() != "b" || changes != 1 {
		t.Fatal("active provider must be persisted before success")
	}
	if err := service.AISetActiveProvider("missing"); err == nil || service.AIGetActiveProvider() != "b" || changes != 1 {
		t.Fatal("unknown provider must not alter current selection")
	}
	if err := service.AISetActiveProvider("b"); err != nil || changes != 1 {
		t.Fatal("selecting the current provider should not write again")
	}
}

func TestProviderManagementActiveProviderRollsBackOnWriteFailure(t *testing.T) {
	service := newProviderManagementTestService(t)
	service.providers = []ai.ProviderConfig{{ID: "a", Type: "openai"}, {ID: "b", Type: "openai"}}
	service.activeProvider = "a"
	if err := os.Mkdir(filepath.Join(service.configDir, aiConfigFileName), 0o755); err != nil {
		t.Fatal(err)
	}
	service.configChanged = func() { t.Error("failed write must not emit config-changed") }
	if err := service.AISetActiveProvider("b"); err == nil {
		t.Fatal("expected write error")
	}
	if service.AIGetActiveProvider() != "a" {
		t.Fatal("failed write must restore memory")
	}
}
