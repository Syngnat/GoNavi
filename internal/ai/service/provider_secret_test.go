package aiservice

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/secretstore"
)

func withTestAIGOOS(t *testing.T, goos string) {
	t.Helper()
	previous := aiRuntimeGOOS
	aiRuntimeGOOS = func() string {
		return goos
	}
	t.Cleanup(func() {
		aiRuntimeGOOS = previous
	})
}

func TestSplitProviderSecretsStripsAPIKeyAndSensitiveHeaders(t *testing.T) {
	input := ai.ProviderConfig{
		ID:      "openai-main",
		APIKey:  "sk-test",
		BaseURL: "https://api.openai.com/v1",
		Headers: map[string]string{
			"Authorization": "Bearer test",
			"X-Team":        "db",
		},
	}

	meta, bundle := splitProviderSecrets(input)
	if meta.APIKey != "" {
		t.Fatal("apiKey should not stay in metadata")
	}
	if meta.Headers["Authorization"] != "" {
		t.Fatal("sensitive header should not stay in metadata")
	}
	if meta.Headers["X-Team"] != "db" {
		t.Fatal("non-sensitive header should stay in metadata")
	}
	if bundle.APIKey != "sk-test" {
		t.Fatal("bundle should keep apiKey")
	}
	if bundle.SensitiveHeaders["Authorization"] != "Bearer test" {
		t.Fatal("bundle should keep sensitive header")
	}
}

func TestNewDefaultAISecretStoreSkipsKeychainOnDarwin(t *testing.T) {
	withTestAIGOOS(t, "darwin")

	if _, err := newDefaultAISecretStore().Get("must-not-reach-keychain"); !secretstore.IsUnavailable(err) {
		t.Fatal("macOS AI service must not open the Keychain backend")
	}
}

func TestResolveProviderConfigSecretsRestoresStoredSecretBundle(t *testing.T) {
	service := NewServiceWithSecretStore(failOnUseSecretStore{})
	service.configDir = t.TempDir()
	if err := service.dailySecretStore().PutAIProvider("openai-main", toDailyProviderBundle(providerSecretBundle{
		APIKey: "sk-test",
		SensitiveHeaders: map[string]string{
			"Authorization": "Bearer test",
		},
	})); err != nil {
		t.Fatalf("PutAIProvider returned error: %v", err)
	}

	resolved, err := service.resolveProviderConfigSecrets(ai.ProviderConfig{
		ID:        "openai-main",
		HasSecret: true,
		Headers: map[string]string{
			"X-Team": "db",
		},
	})
	if err != nil {
		t.Fatalf("resolveProviderConfigSecrets returned error: %v", err)
	}
	if resolved.APIKey != "sk-test" {
		t.Fatalf("expected restored apiKey, got %q", resolved.APIKey)
	}
	if resolved.Headers["Authorization"] != "Bearer test" {
		t.Fatalf("expected restored sensitive header, got %#v", resolved.Headers)
	}
	if resolved.Headers["X-Team"] != "db" {
		t.Fatalf("expected non-sensitive header to survive, got %#v", resolved.Headers)
	}
}

func TestLoadConfigUsesPlaintextProviderSecretsWithoutSilentMigration(t *testing.T) {
	service := NewServiceWithSecretStore(failOnUseSecretStore{})
	service.configDir = t.TempDir()

	legacy := aiConfig{
		Providers: []ai.ProviderConfig{
			{
				ID:      "openai-main",
				Type:    "openai",
				Name:    "OpenAI",
				APIKey:  "sk-test",
				BaseURL: "https://api.openai.com/v1",
				Headers: map[string]string{
					"Authorization": "Bearer test",
					"X-Team":        "db",
				},
			},
		},
	}
	data, err := json.MarshalIndent(legacy, "", "  ")
	if err != nil {
		t.Fatalf("MarshalIndent returned error: %v", err)
	}
	configPath := filepath.Join(service.configDir, "ai_config.json")
	if err := os.WriteFile(configPath, data, 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	service.loadConfig()

	providers := service.AIGetProviders()
	if len(providers) != 1 {
		t.Fatalf("expected 1 provider, got %d", len(providers))
	}
	if providers[0].APIKey != "" {
		t.Fatalf("expected provider view to stay secretless, got %q", providers[0].APIKey)
	}
	if !providers[0].HasSecret {
		t.Fatal("expected provider view to report HasSecret=true")
	}

	if len(service.providers) != 1 {
		t.Fatalf("expected runtime providers to be loaded, got %d", len(service.providers))
	}
	if service.providers[0].APIKey != "sk-test" {
		t.Fatalf("expected runtime provider to keep plaintext apiKey, got %q", service.providers[0].APIKey)
	}
	if service.providers[0].Headers["Authorization"] != "Bearer test" {
		t.Fatalf("expected runtime provider to keep sensitive header, got %#v", service.providers[0].Headers)
	}

	stored, ok, err := service.dailySecretStore().GetAIProvider("openai-main")
	if err != nil {
		t.Fatalf("GetAIProvider returned error: %v", err)
	}
	if !ok {
		t.Fatal("expected startup load to migrate plaintext provider secret to daily store")
	}
	if stored.APIKey != "sk-test" || stored.SensitiveHeaders["Authorization"] != "Bearer test" {
		t.Fatalf("unexpected migrated provider bundle: %#v", stored)
	}

	rewritten, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	text := string(rewritten)
	if strings.Contains(text, "sk-test") {
		t.Fatalf("expected config file to be rewritten secretless, got %s", text)
	}
	if strings.Contains(text, "Bearer test") {
		t.Fatalf("expected config file to remove sensitive header, got %s", text)
	}
}

func TestAISaveProviderKeepsLegacyPlaintextSecretAfterStartupLoad(t *testing.T) {
	service := NewServiceWithSecretStore(failOnUseSecretStore{})
	service.configDir = t.TempDir()

	legacy := aiConfig{
		Providers: []ai.ProviderConfig{
			{
				ID:      "openai-main",
				Type:    "custom",
				Name:    "OpenAI",
				APIKey:  "sk-test",
				BaseURL: "",
				Headers: map[string]string{
					"Authorization": "Bearer test",
					"X-Team":        "db",
				},
			},
		},
	}
	data, err := json.MarshalIndent(legacy, "", "  ")
	if err != nil {
		t.Fatalf("MarshalIndent returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(service.configDir, aiConfigFileName), data, 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	service.loadConfig()

	if err := service.AISaveProvider(ai.ProviderConfig{
		ID:        "openai-main",
		Type:      "custom",
		Name:      "OpenAI Updated",
		BaseURL:   "",
		HasSecret: true,
		Headers: map[string]string{
			"X-Team": "platform",
		},
	}); err != nil {
		t.Fatalf("AISaveProvider returned error: %v", err)
	}

	if service.providers[0].APIKey != "sk-test" {
		t.Fatalf("expected runtime provider to keep legacy plaintext apiKey, got %q", service.providers[0].APIKey)
	}
	if service.providers[0].Headers["Authorization"] != "Bearer test" {
		t.Fatalf("expected runtime provider to keep legacy sensitive header, got %#v", service.providers[0].Headers)
	}

	stored, ok, err := service.dailySecretStore().GetAIProvider("openai-main")
	if err != nil {
		t.Fatalf("GetAIProvider returned error: %v", err)
	}
	if !ok {
		t.Fatal("expected provider secret to stay in daily store")
	}
	if stored.APIKey != "sk-test" {
		t.Fatalf("expected persisted apiKey, got %q", stored.APIKey)
	}
}

func TestAITestProviderUsesLegacyPlaintextSecretAfterStartupLoad(t *testing.T) {
	service := newProviderManagementTestService(t)
	service.secretStore = failOnUseSecretStore{}
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("Authorization") != "Bearer sk-test" || r.Header.Get("X-Api-Key") != "header-test" || r.Header.Get("X-Team") != "db" {
			t.Error("legacy API key and sensitive headers were not retained")
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()

	legacy := aiConfig{
		Providers: []ai.ProviderConfig{
			{
				ID:      "openai-main",
				Type:    "custom",
				Name:    "OpenAI",
				APIKey:  "sk-test",
				BaseURL: server.URL,
				Headers: map[string]string{
					"X-Api-Key": "header-test",
					"X-Team":    "db",
				},
			},
		},
	}
	data, err := json.MarshalIndent(legacy, "", "  ")
	if err != nil {
		t.Fatalf("MarshalIndent returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(service.configDir, aiConfigFileName), data, 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	service.loadConfig()

	result := service.AITestProvider(ai.ProviderConfig{
		ID:        "openai-main",
		Type:      "custom",
		Name:      "OpenAI",
		BaseURL:   server.URL,
		HasSecret: true,
		Headers: map[string]string{
			"X-Team": "db",
		},
	})

	if success, _ := result["success"].(bool); !success {
		t.Fatalf("expected test provider to use in-memory legacy secret, got %#v", result)
	}
	if requests.Load() != 1 || result["checkKind"] != "endpoint" || result["modelVerified"] != false {
		t.Fatal("expected exactly one local endpoint check, not a model response")
	}
}

func TestAISaveProviderPersistsSecretlessConfigAndReturnsSecretlessView(t *testing.T) {
	service := NewServiceWithSecretStore(failOnUseSecretStore{})
	service.configDir = t.TempDir()

	err := service.AISaveProvider(ai.ProviderConfig{
		ID:      "openai-main",
		Type:    "openai",
		Name:    "OpenAI",
		APIKey:  "sk-test",
		BaseURL: "https://api.openai.com/v1",
		Headers: map[string]string{
			"Authorization": "Bearer test",
			"X-Team":        "db",
		},
	})
	if err != nil {
		t.Fatalf("AISaveProvider returned error: %v", err)
	}

	providers := service.AIGetProviders()
	if len(providers) != 1 {
		t.Fatalf("expected 1 provider, got %d", len(providers))
	}
	if providers[0].APIKey != "" {
		t.Fatalf("expected secretless provider view, got %q", providers[0].APIKey)
	}
	if !providers[0].HasSecret {
		t.Fatal("expected saved provider view to report HasSecret=true")
	}
	if providers[0].Headers["Authorization"] != "" {
		t.Fatalf("expected secretless provider headers, got %#v", providers[0].Headers)
	}
	if service.providers[0].APIKey != "sk-test" {
		t.Fatalf("expected runtime provider to keep apiKey, got %q", service.providers[0].APIKey)
	}
	if service.providers[0].Headers["Authorization"] != "Bearer test" {
		t.Fatalf("expected runtime provider to keep sensitive header, got %#v", service.providers[0].Headers)
	}

	configPath := filepath.Join(service.configDir, "ai_config.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	text := string(data)
	if strings.Contains(text, "sk-test") {
		t.Fatalf("expected config file to be secretless, got %s", text)
	}
	if strings.Contains(text, "Bearer test") {
		t.Fatalf("expected config file to remove sensitive headers, got %s", text)
	}
}

func TestAISettingsSecretFailuresUseEnglishWrappers(t *testing.T) {
	configPathAsDirectory := filepath.Join(t.TempDir(), "not-a-dir")
	if err := os.WriteFile(configPathAsDirectory, []byte("blocking file"), 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	testCases := []struct {
		name              string
		run               func(t *testing.T) error
		unexpectedWrapper string
		expectedPrefix    string
		expectedRawDetail string
	}{
		{
			name: "save provider secret",
			run: func(t *testing.T) error {
				t.Helper()
				service := NewServiceWithSecretStore(failOnUseSecretStore{})
				service.configDir = configPathAsDirectory
				service.AISetLanguage("en-US")
				return service.AISaveProvider(ai.ProviderConfig{
					ID:      "openai-main",
					Type:    "openai",
					Name:    "OpenAI",
					APIKey:  "sk-test",
					BaseURL: "https://api.openai.com/v1",
				})
			},
			unexpectedWrapper: "保存 Provider secret 失败",
			expectedPrefix:    "Failed to save Provider secret: ",
			expectedRawDetail: configPathAsDirectory,
		},
		{
			name: "read editable provider secret",
			run: func(t *testing.T) error {
				t.Helper()
				service := NewServiceWithSecretStore(failOnUseSecretStore{})
				service.configDir = t.TempDir()
				service.AISetLanguage("en-US")
				service.providers = []ai.ProviderConfig{
					{
						ID:        "openai-main",
						Type:      "openai",
						Name:      "OpenAI",
						HasSecret: true,
					},
				}
				_, err := service.AIGetEditableProvider("openai-main")
				return err
			},
			unexpectedWrapper: "读取 Provider secret 失败",
			expectedPrefix:    "Failed to read Provider secret: ",
			expectedRawDetail: "file does not exist",
		},
		{
			name: "delete provider secret",
			run: func(t *testing.T) error {
				t.Helper()
				service := NewServiceWithSecretStore(failOnUseSecretStore{})
				service.configDir = t.TempDir()
				service.AISetLanguage("en-US")
				service.providers = []ai.ProviderConfig{
					{
						ID:        "openai-main",
						Type:      "openai",
						Name:      "OpenAI",
						HasSecret: true,
						SecretRef: "oskeyring://gonavi/ai-provider/openai-main",
					},
				}
				return service.AIDeleteProvider("openai-main")
			},
			unexpectedWrapper: "删除 Provider secret 失败",
			expectedPrefix:    "Failed to delete Provider secret: ",
			expectedRawDetail: "secret store should not be used",
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			err := testCase.run(t)
			if err == nil {
				t.Fatal("expected error")
			}
			message := err.Error()
			if strings.Contains(message, testCase.unexpectedWrapper) {
				t.Fatalf("expected English wrapper, got %q", message)
			}
			if !strings.HasPrefix(message, testCase.expectedPrefix) {
				t.Fatalf("expected prefix %q, got %q", testCase.expectedPrefix, message)
			}
			if !strings.Contains(message, testCase.expectedRawDetail) {
				t.Fatalf("expected raw detail %q to be preserved, got %q", testCase.expectedRawDetail, message)
			}
		})
	}
}

func TestProviderSecretHelperUnavailableStoreUsesEnglishWrapper(t *testing.T) {
	localizer := newServiceLocalizerForLanguage("en-US")
	_, err := resolveProviderConfigSecretsWithLocalizer(nil, ai.ProviderConfig{
		ID:        "openai-main",
		HasSecret: true,
	}, localizer)
	if err == nil {
		t.Fatal("expected error")
	}
	message := err.Error()
	if strings.Contains(message, "不可用") {
		t.Fatalf("expected English wrapper, got %q", message)
	}
	if !strings.HasPrefix(message, "Daily secret store is unavailable: ") {
		t.Fatalf("expected English daily secret wrapper, got %q", message)
	}
	if !strings.Contains(message, "daily secret store unavailable") {
		t.Fatalf("expected raw detail to be preserved, got %q", message)
	}
}

func TestAIGetEditableProviderReturnsResolvedSecretsForEdit(t *testing.T) {
	service := NewServiceWithSecretStore(failOnUseSecretStore{})
	service.configDir = t.TempDir()

	if err := service.AISaveProvider(ai.ProviderConfig{
		ID:      "openai-main",
		Type:    "openai",
		Name:    "OpenAI",
		APIKey:  "sk-test",
		BaseURL: "https://api.openai.com/v1",
		Headers: map[string]string{
			"Authorization": "Bearer test",
			"X-Team":        "db",
		},
	}); err != nil {
		t.Fatalf("AISaveProvider returned error: %v", err)
	}

	providers := service.AIGetProviders()
	if len(providers) != 1 {
		t.Fatalf("expected 1 provider, got %d", len(providers))
	}
	if providers[0].APIKey != "" {
		t.Fatalf("expected provider list to stay secretless, got %q", providers[0].APIKey)
	}

	editable, err := service.AIGetEditableProvider("openai-main")
	if err != nil {
		t.Fatalf("AIGetEditableProvider returned error: %v", err)
	}
	if editable.APIKey != "sk-test" {
		t.Fatalf("expected editable provider to restore apiKey, got %q", editable.APIKey)
	}
	if editable.Headers["Authorization"] != "Bearer test" {
		t.Fatalf("expected editable provider to restore sensitive header, got %#v", editable.Headers)
	}
}

func TestAIGetEditableProviderNotFoundUsesCurrentLanguageWrapper(t *testing.T) {
	service := NewServiceWithSecretStore(failOnUseSecretStore{})
	service.configDir = t.TempDir()
	service.AISetLanguage("zh-CN")

	_, err := service.AIGetEditableProvider("missing-provider")
	if err == nil {
		t.Fatal("expected error")
	}

	message := err.Error()
	if message != "未找到要编辑的 AI Provider: missing-provider" {
		t.Fatalf("expected localized wrapper with raw provider id detail, got %q", message)
	}
	if strings.Contains(message, "provider not found") {
		t.Fatalf("expected no raw English provider-not-found wrapper, got %q", message)
	}
}

func TestAISaveProviderKeepsExistingSecretWhenInputOmitsAPIKey(t *testing.T) {
	service := NewServiceWithSecretStore(failOnUseSecretStore{})
	service.configDir = t.TempDir()

	if err := service.AISaveProvider(ai.ProviderConfig{
		ID:      "openai-main",
		Type:    "openai",
		Name:    "OpenAI",
		APIKey:  "sk-original",
		BaseURL: "https://api.openai.com/v1",
		Headers: map[string]string{
			"Authorization": "Bearer original",
			"X-Team":        "db",
		},
	}); err != nil {
		t.Fatalf("initial AISaveProvider returned error: %v", err)
	}

	if err := service.AISaveProvider(ai.ProviderConfig{
		ID:        "openai-main",
		Type:      "openai",
		Name:      "OpenAI Updated",
		BaseURL:   "https://gateway.openai.com/v1",
		HasSecret: true,
		Headers: map[string]string{
			"X-Team": "platform",
		},
	}); err != nil {
		t.Fatalf("update AISaveProvider returned error: %v", err)
	}

	if service.providers[0].APIKey != "sk-original" {
		t.Fatalf("expected runtime provider to keep original apiKey, got %q", service.providers[0].APIKey)
	}
	if service.providers[0].Headers["Authorization"] != "Bearer original" {
		t.Fatalf("expected runtime provider to keep original sensitive header, got %#v", service.providers[0].Headers)
	}
	if service.providers[0].Headers["X-Team"] != "platform" {
		t.Fatalf("expected runtime provider to update non-sensitive headers, got %#v", service.providers[0].Headers)
	}
	if service.providers[0].BaseURL != "https://gateway.openai.com/v1" {
		t.Fatalf("expected runtime provider to update metadata, got %q", service.providers[0].BaseURL)
	}

	providers := service.AIGetProviders()
	if len(providers) != 1 || !providers[0].HasSecret {
		t.Fatalf("expected provider view to keep HasSecret=true, got %#v", providers)
	}
	if providers[0].APIKey != "" {
		t.Fatalf("expected provider view to stay secretless, got %q", providers[0].APIKey)
	}
}

func TestAISaveProviderMergesStoredSensitiveHeadersWhenUpdatingOnlyAPIKey(t *testing.T) {
	service := NewServiceWithSecretStore(failOnUseSecretStore{})
	service.configDir = t.TempDir()

	if err := service.AISaveProvider(ai.ProviderConfig{
		ID:      "openai-main",
		Type:    "openai",
		Name:    "OpenAI",
		APIKey:  "sk-original",
		BaseURL: "https://api.openai.com/v1",
		Headers: map[string]string{
			"Authorization": "Bearer original",
			"X-Team":        "db",
		},
	}); err != nil {
		t.Fatalf("initial AISaveProvider returned error: %v", err)
	}

	if err := service.AISaveProvider(ai.ProviderConfig{
		ID:        "openai-main",
		Type:      "openai",
		Name:      "OpenAI",
		APIKey:    "sk-updated",
		HasSecret: true,
		BaseURL:   "https://api.openai.com/v1",
		Headers: map[string]string{
			"X-Team": "db",
		},
	}); err != nil {
		t.Fatalf("update AISaveProvider returned error: %v", err)
	}

	if service.providers[0].APIKey != "sk-updated" {
		t.Fatalf("expected updated apiKey, got %q", service.providers[0].APIKey)
	}
	if service.providers[0].Headers["Authorization"] != "Bearer original" {
		t.Fatalf("expected existing sensitive header to be kept, got %#v", service.providers[0].Headers)
	}

	stored, ok, err := service.dailySecretStore().GetAIProvider("openai-main")
	if err != nil {
		t.Fatalf("GetAIProvider returned error: %v", err)
	}
	if !ok {
		t.Fatal("expected merged secret bundle in daily store")
	}
	if stored.APIKey != "sk-updated" {
		t.Fatalf("expected store to keep updated apiKey, got %q", stored.APIKey)
	}
	if stored.SensitiveHeaders["Authorization"] != "Bearer original" {
		t.Fatalf("expected store to keep existing sensitive header, got %#v", stored.SensitiveHeaders)
	}
}

type fakeProviderSecretStore struct {
	items map[string][]byte
}

func newFakeProviderSecretStore() *fakeProviderSecretStore {
	return &fakeProviderSecretStore{items: make(map[string][]byte)}
}

func (s *fakeProviderSecretStore) Put(ref string, payload []byte) error {
	s.items[ref] = append([]byte(nil), payload...)
	return nil
}

func (s *fakeProviderSecretStore) Get(ref string) ([]byte, error) {
	payload, ok := s.items[ref]
	if !ok {
		return nil, os.ErrNotExist
	}
	return append([]byte(nil), payload...), nil
}

func (s *fakeProviderSecretStore) Delete(ref string) error {
	delete(s.items, ref)
	return nil
}

func (s *fakeProviderSecretStore) HealthCheck() error {
	return nil
}

var _ secretstore.SecretStore = (*fakeProviderSecretStore)(nil)

type failOnUseSecretStore struct{}

func (s failOnUseSecretStore) Put(string, []byte) error {
	return fmt.Errorf("secret store should not be used")
}

func (s failOnUseSecretStore) Get(string) ([]byte, error) {
	return nil, fmt.Errorf("secret store should not be used")
}

func (s failOnUseSecretStore) Delete(string) error {
	return fmt.Errorf("secret store should not be used")
}

func (s failOnUseSecretStore) HealthCheck() error {
	return fmt.Errorf("secret store should not be used")
}

var _ secretstore.SecretStore = (*failOnUseSecretStore)(nil)
