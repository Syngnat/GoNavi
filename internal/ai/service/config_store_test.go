package aiservice

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/secretstore"
)

func TestProviderConfigStoreLoadMigratesPlaintextProviderSecrets(t *testing.T) {
	configStore := newProviderConfigStore(t.TempDir(), failOnUseSecretStore{})

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
					"X-Team":        "platform",
				},
			},
		},
	}
	data, err := json.MarshalIndent(legacy, "", "  ")
	if err != nil {
		t.Fatalf("MarshalIndent returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(configStore.configDir, aiConfigFileName), data, 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	snapshot, err := configStore.Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if len(snapshot.Providers) != 1 {
		t.Fatalf("expected 1 provider, got %d", len(snapshot.Providers))
	}
	if snapshot.Providers[0].APIKey != "sk-test" {
		t.Fatalf("expected runtime provider to restore apiKey, got %q", snapshot.Providers[0].APIKey)
	}
	if snapshot.Providers[0].Headers["Authorization"] != "Bearer test" {
		t.Fatalf("expected runtime provider to restore sensitive header, got %#v", snapshot.Providers[0].Headers)
	}

	stored, ok, err := configStore.dailySecrets.GetAIProvider("openai-main")
	if err != nil {
		t.Fatalf("GetAIProvider returned error: %v", err)
	}
	if !ok {
		t.Fatal("expected migrated provider secret bundle in daily store")
	}
	if stored.APIKey != "sk-test" {
		t.Fatalf("expected migrated apiKey in store, got %q", stored.APIKey)
	}

	rewritten, err := os.ReadFile(filepath.Join(configStore.configDir, aiConfigFileName))
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	text := string(rewritten)
	if strings.Contains(text, "sk-test") {
		t.Fatalf("expected rewritten config to be secretless, got %s", text)
	}
	if strings.Contains(text, "Bearer test") {
		t.Fatalf("expected rewritten config to remove sensitive headers, got %s", text)
	}
}

func TestProviderConfigStoreSavePersistsSecretlessMetadata(t *testing.T) {
	configStore := newProviderConfigStore(t.TempDir(), failOnUseSecretStore{})

	err := configStore.Save(ProviderConfigStoreSnapshot{
		Providers: []ai.ProviderConfig{
			{
				ID:      "openai-main",
				Type:    "openai",
				Name:    "OpenAI",
				APIKey:  "sk-test",
				BaseURL: "https://api.openai.com/v1",
				Headers: map[string]string{
					"Authorization": "Bearer test",
					"X-Team":        "platform",
				},
			},
		},
		ActiveProvider: "openai-main",
		SafetyLevel:    ai.PermissionReadOnly,
		ContextLevel:   ai.ContextSchemaOnly,
	})
	if err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	configData, err := os.ReadFile(filepath.Join(configStore.configDir, aiConfigFileName))
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	text := string(configData)
	if strings.Contains(text, "sk-test") {
		t.Fatalf("expected config file to be secretless, got %s", text)
	}
	if strings.Contains(text, "Bearer test") {
		t.Fatalf("expected config file to remove sensitive headers, got %s", text)
	}

	stored, ok, err := configStore.dailySecrets.GetAIProvider("openai-main")
	if err != nil {
		t.Fatalf("GetAIProvider returned error: %v", err)
	}
	if !ok {
		t.Fatal("expected provider secret bundle in daily store")
	}
	if stored.APIKey != "sk-test" {
		t.Fatalf("expected stored apiKey, got %q", stored.APIKey)
	}
	if stored.SensitiveHeaders["Authorization"] != "Bearer test" {
		t.Fatalf("expected stored sensitive header, got %#v", stored.SensitiveHeaders)
	}
}

func TestProviderConfigStoreSaveKeepsExistingSecretRef(t *testing.T) {
	withTestAIGOOS(t, "linux")

	store := newFakeProviderSecretStore()
	configStore := newProviderConfigStore(t.TempDir(), store)

	ref, err := secretstore.BuildRef(providerSecretKind, "openai-main")
	if err != nil {
		t.Fatalf("BuildRef returned error: %v", err)
	}
	payload, err := json.Marshal(providerSecretBundle{
		APIKey: "sk-existing",
		SensitiveHeaders: map[string]string{
			"Authorization": "Bearer existing",
		},
	})
	if err != nil {
		t.Fatalf("Marshal returned error: %v", err)
	}
	if err := store.Put(ref, payload); err != nil {
		t.Fatalf("Put returned error: %v", err)
	}

	err = configStore.Save(ProviderConfigStoreSnapshot{
		Providers: []ai.ProviderConfig{
			{
				ID:        "openai-main",
				Type:      "openai",
				Name:      "OpenAI",
				HasSecret: true,
				SecretRef: ref,
				BaseURL:   "https://gateway.openai.com/v1",
				Headers: map[string]string{
					"X-Team": "platform",
				},
			},
		},
		ActiveProvider: "openai-main",
		SafetyLevel:    ai.PermissionReadOnly,
		ContextLevel:   ai.ContextSchemaOnly,
	})
	if err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	stored, ok, err := configStore.dailySecrets.GetAIProvider("openai-main")
	if err != nil {
		t.Fatalf("GetAIProvider returned error: %v", err)
	}
	if !ok {
		t.Fatal("expected existing provider secret bundle to be migrated to daily store")
	}
	if stored.APIKey != "sk-existing" {
		t.Fatalf("expected existing apiKey to be kept, got %q", stored.APIKey)
	}

	snapshot, err := configStore.Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if len(snapshot.Providers) != 1 {
		t.Fatalf("expected 1 provider after reload, got %d", len(snapshot.Providers))
	}
	if snapshot.Providers[0].APIKey != "sk-existing" {
		t.Fatalf("expected reload to restore existing apiKey, got %q", snapshot.Providers[0].APIKey)
	}
	if snapshot.Providers[0].Headers["Authorization"] != "Bearer existing" {
		t.Fatalf("expected reload to restore existing sensitive header, got %#v", snapshot.Providers[0].Headers)
	}
}

func TestProviderConfigStoreLoadDropsLegacyKeychainReferenceOnDarwinWithoutAccess(t *testing.T) {
	withTestAIGOOS(t, "darwin")
	configStore := newProviderConfigStore(t.TempDir(), failOnUseSecretStore{})

	legacy := aiConfig{
		Providers: []ai.ProviderConfig{{
			ID:        "openai-main",
			Type:      "openai",
			Name:      "OpenAI",
			HasSecret: true,
			SecretRef: "oskeyring://gonavi/ai-provider/openai-main",
			BaseURL:   "https://api.openai.com/v1",
		}},
		ActiveProvider: "openai-main",
	}
	data, err := json.MarshalIndent(legacy, "", "  ")
	if err != nil {
		t.Fatalf("MarshalIndent returned error: %v", err)
	}
	if err := os.WriteFile(filepath.Join(configStore.configDir, aiConfigFileName), data, 0o644); err != nil {
		t.Fatalf("WriteFile returned error: %v", err)
	}

	snapshot, err := configStore.Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if len(snapshot.Providers) != 1 {
		t.Fatalf("expected 1 provider, got %d", len(snapshot.Providers))
	}
	provider := snapshot.Providers[0]
	if provider.HasSecret || provider.SecretRef != "" || provider.APIKey != "" {
		t.Fatalf("legacy Keychain provider was not cleared without Keychain access: %#v", provider)
	}

	rewritten, err := os.ReadFile(filepath.Join(configStore.configDir, aiConfigFileName))
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	if strings.Contains(string(rewritten), "oskeyring://") {
		t.Fatalf("rewritten config still contains legacy Keychain reference: %s", rewritten)
	}
}

func TestProviderConfigStoreSaveAndLoadUserPromptSettings(t *testing.T) {
	configStore := newProviderConfigStore(t.TempDir(), failOnUseSecretStore{})

	expected := ai.UserPromptSettings{
		Global:        "所有回答先给结论。",
		Database:      "生成 SQL 前先确认字段名。",
		JVM:           "优先输出资源级风险判断。",
		JVMDiagnostic: "先给诊断计划，再给命令。",
	}

	err := configStore.Save(ProviderConfigStoreSnapshot{
		Providers:          []ai.ProviderConfig{},
		ActiveProvider:     "",
		SafetyLevel:        ai.PermissionReadOnly,
		ContextLevel:       ai.ContextSchemaOnly,
		UserPromptSettings: expected,
	})
	if err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	snapshot, err := configStore.Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if snapshot.UserPromptSettings != expected {
		t.Fatalf("expected user prompt settings %#v, got %#v", expected, snapshot.UserPromptSettings)
	}

	configData, err := os.ReadFile(filepath.Join(configStore.configDir, aiConfigFileName))
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	text := string(configData)
	if !strings.Contains(text, `"userPromptSettings"`) {
		t.Fatalf("expected config file to contain userPromptSettings, got %s", text)
	}
}

func TestProviderConfigStoreSaveAndLoadMCPServers(t *testing.T) {
	configStore := newProviderConfigStore(t.TempDir(), failOnUseSecretStore{})

	expected := []ai.MCPServerConfig{
		{
			ID:             "mcp-local",
			Name:           "本地文件助手",
			Transport:      ai.MCPTransportStdio,
			Command:        "node",
			Args:           []string{"server.js", "--stdio"},
			Env:            map[string]string{"API_KEY": "test"},
			Enabled:        true,
			TimeoutSeconds: 18,
		},
	}

	err := configStore.Save(ProviderConfigStoreSnapshot{
		Providers:      []ai.ProviderConfig{},
		ActiveProvider: "",
		SafetyLevel:    ai.PermissionReadOnly,
		ContextLevel:   ai.ContextSchemaOnly,
		MCPServers:     expected,
	})
	if err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	snapshot, err := configStore.Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if !reflect.DeepEqual(snapshot.MCPServers, expected) {
		t.Fatalf("expected MCP servers %#v, got %#v", expected, snapshot.MCPServers)
	}

	configData, err := os.ReadFile(filepath.Join(configStore.configDir, aiConfigFileName))
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	if !strings.Contains(string(configData), `"mcpServers"`) {
		t.Fatalf("expected config file to contain mcpServers, got %s", string(configData))
	}
}

func TestProviderConfigStoreSaveAndLoadMCPHTTPServerConfigWithoutTokenInAIConfig(t *testing.T) {
	configStore := newProviderConfigStore(t.TempDir(), failOnUseSecretStore{})

	expected := ai.MCPHTTPServerConfig{
		Enabled:    true,
		Addr:       "127.0.0.1:9123",
		Path:       "/mcp",
		SchemaOnly: true,
		Token:      "gnv_mcp_http_secret",
	}

	err := configStore.Save(ProviderConfigStoreSnapshot{
		Providers:      []ai.ProviderConfig{},
		ActiveProvider: "",
		SafetyLevel:    ai.PermissionReadOnly,
		ContextLevel:   ai.ContextSchemaOnly,
		MCPHTTPServer:  expected,
	})
	if err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	snapshot, err := configStore.Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if !reflect.DeepEqual(snapshot.MCPHTTPServer, expected) {
		t.Fatalf("expected MCP HTTP config %#v, got %#v", expected, snapshot.MCPHTTPServer)
	}

	configData, err := os.ReadFile(filepath.Join(configStore.configDir, aiConfigFileName))
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	configText := string(configData)
	if !strings.Contains(configText, `"mcpHTTPServer"`) || !strings.Contains(configText, `"enabled": true`) {
		t.Fatalf("expected persisted MCP HTTP metadata, got %s", configText)
	}
	if strings.Contains(configText, expected.Token) {
		t.Fatalf("expected MCP HTTP token to stay out of ai config, got %s", configText)
	}
}

func TestProviderConfigStoreSaveAndLoadSkills(t *testing.T) {
	configStore := newProviderConfigStore(t.TempDir(), failOnUseSecretStore{})

	expected := []ai.SkillConfig{
		{
			ID:            "skill-sql-review",
			Name:          "SQL 审查",
			Description:   "生成 SQL 前先校验字段和风险",
			SystemPrompt:  "先确认字段，再输出 SQL。",
			Enabled:       true,
			Scopes:        []string{string(ai.SkillScopeDatabase)},
			RequiredTools: []string{"get_columns", "execute_sql"},
		},
	}

	err := configStore.Save(ProviderConfigStoreSnapshot{
		Providers:      []ai.ProviderConfig{},
		ActiveProvider: "",
		SafetyLevel:    ai.PermissionReadOnly,
		ContextLevel:   ai.ContextSchemaOnly,
		Skills:         expected,
	})
	if err != nil {
		t.Fatalf("Save returned error: %v", err)
	}

	snapshot, err := configStore.Load()
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if !reflect.DeepEqual(snapshot.Skills, expected) {
		t.Fatalf("expected skills %#v, got %#v", expected, snapshot.Skills)
	}

	configData, err := os.ReadFile(filepath.Join(configStore.configDir, aiConfigFileName))
	if err != nil {
		t.Fatalf("ReadFile returned error: %v", err)
	}
	if !strings.Contains(string(configData), `"skills"`) {
		t.Fatalf("expected config file to contain skills, got %s", string(configData))
	}
}
