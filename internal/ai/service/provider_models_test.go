package aiservice

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/shared/i18n"
)

func TestProviderModelPreferencesPreserveLegacyLists(t *testing.T) {
	legacy := []string{" second ", "first", "first", ""}
	got := selectableProviderModels(ai.ProviderConfig{}, legacy)
	if !reflect.DeepEqual(got, legacy) {
		t.Fatalf("absent preferences must preserve legacy behavior: %v", got)
	}
	got[0] = "changed"
	if legacy[0] != " second " {
		t.Fatal("returned candidates must not alias the saved list")
	}
}

func TestProviderModelPreferencesFilterEveryListSource(t *testing.T) {
	originalFetch := fetchModelsFunc
	t.Cleanup(func() { fetchModelsFunc = originalFetch })
	for _, route := range []string{"cli", "api", "fallback", "custom-only-fallback", "vendor-static"} {
		t.Run(route, func(t *testing.T) {
			service := newProviderManagementTestService(t)
			config := ai.ProviderConfig{ID: "one", Type: "openai", APIFormat: "openai", BaseURL: "https://fixture.invalid/v1", Model: "default", Models: []string{"default", "disabled", " extra "}, DisabledModels: []string{" disabled "}, CustomModels: []string{"extra", "my-model", "", "my-model"}}
			want, source := []string{"default", "extra", "my-model"}, "static"
			calls := 0
			fetchModelsFunc = func(ai.ProviderConfig, *i18n.Localizer) ([]string, error) {
				calls++
				if route == "fallback" || route == "custom-only-fallback" {
					return nil, errors.New("offline fixture")
				}
				return []string{"default", "disabled", " extra ", "default"}, nil
			}
			switch route {
			case "cli":
				config.Type, config.APIFormat, config.AuthMode = "custom", "codex-cli", "local-cli"
			case "api":
				source = "api"
			case "custom-only-fallback":
				config.Models = nil
				want = []string{"extra", "my-model"}
			case "vendor-static":
				config.Type, config.APIFormat, config.BaseURL = "anthropic", "anthropic", "https://api.minimax.io/anthropic"
				static := defaultStaticModelsForProvider(config)
				if len(static) < 2 {
					t.Fatal("fixture must take a vendor static route")
				}
				config.Model = static[0]
				config.DisabledModels = []string{static[1]}
				want = append(append([]string{static[0]}, static[2:]...), "extra", "my-model")
			}
			service.providers, service.activeProvider = []ai.ProviderConfig{config}, config.ID
			result := service.AIListModels()
			if result["success"] != true || result["source"] != source || !reflect.DeepEqual(result["models"], want) {
				t.Fatalf("%s: unexpected choices %v; want %v", route, result, want)
			}
			if (route == "cli" || route == "vendor-static") && calls != 0 {
				t.Fatal("static lists must not fetch from an API")
			}
			if !reflect.DeepEqual(service.providers[0], config) {
				t.Fatal("reading model choices must not rewrite the stored provider")
			}
		})
	}
}

func TestProviderModelPreferencesRejectDisabledRequiredModelsBeforeWriting(t *testing.T) {
	service := newProviderManagementTestService(t)
	config := ai.ProviderConfig{ID: "one", Name: "saved", Type: "openai", Model: "default", InlineCompletionModel: "sql", APIKey: "fixture-key"}
	if err := service.AISaveProvider(config); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(service.configDir, aiConfigFileName))
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{" default ", "sql"} {
		candidate := config
		candidate.DisabledModels, candidate.APIKey, candidate.Name = []string{required}, "must-not-replace-key", "changed"
		if err := service.AISaveProvider(candidate); err == nil {
			t.Fatal("disabling a required model must be rejected")
		}
		after, err := os.ReadFile(filepath.Join(service.configDir, aiConfigFileName))
		if err != nil || string(after) != string(before) {
			t.Fatal("rejection must not modify config metadata")
		}
		editable, err := service.AIGetEditableProvider(config.ID)
		if err != nil || editable.Name != config.Name || editable.APIKey != config.APIKey {
			t.Fatal("rejection must not modify the saved provider or its credentials")
		}
	}
}

func TestProviderModelPreferencesRoundTripAndCopyIsolation(t *testing.T) {
	service := newProviderManagementTestService(t)
	original := ai.ProviderConfig{ID: "original", Name: "Original", Type: "openai", Model: "default", InlineCompletionModel: "sql", Models: []string{"default", "sql", "other"}, CustomModels: []string{"mine"}, DisabledModels: []string{"other"}, APIKey: "fixture-key", Headers: map[string]string{"X-Api-Key": "fixture-header", "X-Team": "fixture"}}
	if err := service.AISaveProvider(original); err != nil {
		t.Fatal(err)
	}
	if err := service.AISetActiveProvider(original.ID); err != nil {
		t.Fatal(err)
	}
	copy, err := service.AIGetEditableProvider(original.ID)
	if err != nil {
		t.Fatal(err)
	}
	copy.ID, copy.Name = "copy", "Copy"
	copy.DisabledModels, copy.CustomModels = []string{"mine"}, []string{"mine", "copy-only"}
	if err := service.AISaveProvider(copy); err != nil {
		t.Fatal(err)
	}
	loaded := newProviderManagementTestService(t)
	loaded.configDir = service.configDir
	loaded.loadConfig()
	if loaded.AIGetActiveProvider() != original.ID {
		t.Fatal("copy must not change the default provider")
	}
	for _, want := range []ai.ProviderConfig{original, copy} {
		got, err := loaded.AIGetEditableProvider(want.ID)
		if err != nil || !reflect.DeepEqual(got.DisabledModels, want.DisabledModels) || !reflect.DeepEqual(got.CustomModels, want.CustomModels) || got.Model != want.Model || got.InlineCompletionModel != want.InlineCompletionModel || got.APIKey != want.APIKey || !reflect.DeepEqual(got.Headers, want.Headers) {
			t.Fatalf("%s preferences, models and credentials must round-trip independently", want.ID)
		}
	}
	data, err := os.ReadFile(filepath.Join(service.configDir, aiConfigFileName))
	if err != nil || strings.Contains(string(data), "fixture-key") || strings.Contains(string(data), "fixture-header") {
		t.Fatal("copy metadata must remain secretless")
	}
}

func TestProviderModelPreferencesAbsentInLegacyJSON(t *testing.T) {
	service := newProviderManagementTestService(t)
	legacy := `{"providers":[{"id":"old","type":"openai","name":"Old","model":"pinned-default","inlineCompletionModel":"pinned-sql","models":["pinned-default","pinned-sql"]}],"activeProvider":"old"}`
	if err := os.WriteFile(filepath.Join(service.configDir, aiConfigFileName), []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	service.loadConfig()
	got := service.AIGetProviders()
	if len(got) != 1 || got[0].Model != "pinned-default" || got[0].InlineCompletionModel != "pinned-sql" || got[0].DisabledModels != nil || got[0].CustomModels != nil {
		t.Fatal("legacy config must not gain preferences or change selected models")
	}
	serialized, err := json.Marshal(got[0])
	if err != nil || strings.Contains(string(serialized), "disabledModels") || strings.Contains(string(serialized), "customModels") {
		t.Fatal("absent optional fields must remain omitted")
	}
}
