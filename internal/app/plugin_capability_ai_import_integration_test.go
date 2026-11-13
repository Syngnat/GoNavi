package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	aiservice "GoNavi-Wails/internal/ai/service"
	"GoNavi-Wails/internal/plugin"
	"GoNavi-Wails/internal/secretstore"
)

// 宿主侧的验收线：真实 AI Service、真实落盘，不用桩。它要证明三件事——
// 导入后的供应商出现在 AIGetProviders()（供应商设置页读的就是这份数据）里、
// 密钥走 secret 存储落进 daily_secrets.json、以及 ai_config.json 里不出现明文密钥。
func TestPluginCapabilityAIProvidersImportPersistsThroughActiveService(t *testing.T) {
	root := t.TempDir()
	t.Setenv("GONAVI_DATA_ROOT", root)

	service := aiservice.NewServiceWithSecretStore(secretstore.NewUnavailableStore("test"))
	aiservice.PreloadConfig(service)

	a := newPluginTestApp(t)
	a.SetAIProviderStore(NewAIServiceProviderStore(service))

	const secret = "sk-integration-import-0001"
	arguments := `{"providers":[{"name":"集成测试站","baseUrl":"https://integration.example.com/v1","apiFormat":"openai","model":"gpt-test","apiKey":"` + secret + `"}]}`

	result, code, _ := callImportCapability(t, a, []string{plugin.AIProvidersWritePermission}, arguments)
	if code != "" {
		t.Fatalf("unexpected failure code %q", code)
	}
	if result.Imported != 1 || result.Failed != 0 || result.Items[0].ProviderID == "" {
		t.Fatalf("result = %+v", result)
	}

	providers := service.AIGetProviders()
	if len(providers) != 1 {
		t.Fatalf("service provider count = %d, want 1", len(providers))
	}
	got := providers[0]
	if got.Name != "集成测试站" || got.BaseURL != "https://integration.example.com/v1" || got.APIFormat != "openai" {
		t.Fatalf("provider = %+v", got)
	}
	if !got.HasSecret {
		t.Fatal("imported provider must carry a secret flag")
	}
	if strings.TrimSpace(got.APIKey) != "" {
		t.Fatal("metadata view must not expose the credential")
	}

	configRaw, err := os.ReadFile(filepath.Join(root, "ai_config.json"))
	if err != nil {
		t.Fatalf("read ai_config.json: %v", err)
	}
	if !strings.Contains(string(configRaw), "集成测试站") {
		t.Fatal("imported provider was not persisted to ai_config.json")
	}
	if strings.Contains(string(configRaw), secret) {
		t.Fatal("ai_config.json must not contain the raw credential")
	}
	secretRaw, err := os.ReadFile(filepath.Join(root, "daily_secrets.json"))
	if err != nil {
		t.Fatalf("read daily_secrets.json: %v", err)
	}
	if !strings.Contains(string(secretRaw), secret) {
		t.Fatal("credential was not persisted through the secret store")
	}

	// 再导一次同样的条目：宿主判重后跳过，不产生第二条。
	result, code, _ = callImportCapability(t, a, []string{plugin.AIProvidersWritePermission}, arguments)
	if code != "" {
		t.Fatalf("second import failed: %q", code)
	}
	if result.Skipped != 1 || result.Imported != 0 {
		t.Fatalf("second import result = %+v", result)
	}
	if count := len(service.AIGetProviders()); count != 1 {
		t.Fatalf("duplicate import created a second provider: %d", count)
	}
}
