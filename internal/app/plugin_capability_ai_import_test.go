package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/plugin"
)

type stubAIProviderStore struct {
	providers []ai.ProviderConfig
	saved     []ai.ProviderConfig
	failSave  bool
}

func (s *stubAIProviderStore) ListProviders() []ai.ProviderConfig {
	return append([]ai.ProviderConfig(nil), s.providers...)
}

func (s *stubAIProviderStore) SaveProvider(config ai.ProviderConfig) (ai.ProviderConfig, error) {
	if s.failSave {
		return ai.ProviderConfig{}, errors.New("save failed")
	}
	if strings.TrimSpace(config.ID) == "" {
		config.ID = fmt.Sprintf("provider-generated-%d", len(s.saved)+1)
	}
	s.saved = append(s.saved, config)
	s.providers = append(s.providers, config)
	return config, nil
}

type importCapabilityEnvelope struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data"`
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

// callImportCapability 走真实的能力分发路径（含权限与参数校验），只把写入端口换成桩。
func callImportCapability(t *testing.T, a *App, permissions []string, arguments string) (pluginAIProviderImportResult, string, string) {
	t.Helper()
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.ai", permissions...),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	raw, err := a.pluginCapabilityCall(context.Background(), status, pluginCapabilityChannelWindow, "ai.providers.import", json.RawMessage(arguments))
	if err != nil {
		t.Fatal(err)
	}
	var envelope importCapabilityEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("decode envelope: %v (%s)", err, raw)
	}
	if !envelope.OK {
		return pluginAIProviderImportResult{}, envelope.Error.Code, string(raw)
	}
	var result pluginAIProviderImportResult
	if err := json.Unmarshal(envelope.Data, &result); err != nil {
		t.Fatalf("decode result: %v (%s)", err, envelope.Data)
	}
	return result, "", string(raw)
}

func TestPluginCapabilityAIProvidersImportReportsPerItem(t *testing.T) {
	a := newPluginTestApp(t)
	store := &stubAIProviderStore{providers: []ai.ProviderConfig{{ID: "provider-existing", Name: "百倍", BaseURL: "https://sub.100xlabs.space"}}}
	a.SetAIProviderStore(store)

	const secret = "sk-test-import-key-0001"
	arguments := `{"providers":[` +
		`{"name":"千刀","baseUrl":"https://api.zzzcoding.org","apiFormat":"anthropic","model":"claude-opus-5","models":["claude-opus-5","claude-opus-5",""],"apiKey":"` + secret + `","temperature":0.7},` +
		`{"name":"百倍","baseUrl":"https://sub.100xlabs.space/","apiFormat":"anthropic"},` +
		`{"name":"坏地址","baseUrl":"ftp://example.com","apiFormat":"openai"}` +
		`]}`

	result, code, raw := callImportCapability(t, a, []string{plugin.AIProvidersWritePermission}, arguments)
	if code != "" {
		t.Fatalf("unexpected failure code %q", code)
	}
	if result.Imported != 1 || result.Skipped != 1 || result.Failed != 1 {
		t.Fatalf("counts = imported:%d skipped:%d failed:%d", result.Imported, result.Skipped, result.Failed)
	}
	if len(result.Items) != 3 {
		t.Fatalf("items = %d", len(result.Items))
	}
	if result.Items[0].Status != pluginAIProviderImportStatusImported || result.Items[0].ProviderID == "" {
		t.Fatalf("first item = %+v", result.Items[0])
	}
	if result.Items[1].Status != pluginAIProviderImportStatusSkipped || result.Items[1].Reason != pluginAIProviderImportReasonDuplicate {
		t.Fatalf("duplicate item = %+v", result.Items[1])
	}
	if result.Items[2].Status != pluginAIProviderImportStatusFailed || result.Items[2].Reason != pluginAIProviderImportReasonInvalidBaseURL {
		t.Fatalf("invalid item = %+v", result.Items[2])
	}
	if len(store.saved) != 1 {
		t.Fatalf("saved = %d, want 1", len(store.saved))
	}
	saved := store.saved[0]
	if saved.Type != "custom" || saved.AuthMode != "api-key" || saved.APIFormat != "anthropic" {
		t.Fatalf("saved provider shape = %+v", saved)
	}
	if saved.APIKey != secret {
		t.Fatalf("credential was not forwarded to the host store")
	}
	if len(saved.Models) != 1 || saved.Models[0] != "claude-opus-5" {
		t.Fatalf("deduplicated models = %v", saved.Models)
	}
	// 导入能力的返回体绝不能把刚写进去的凭据读回去。
	if strings.Contains(raw, secret) || strings.Contains(raw, "apiKey") {
		t.Fatalf("import result leaked credential material: %s", raw)
	}
}

func TestPluginCapabilityAIProvidersImportOverwriteReusesExistingID(t *testing.T) {
	a := newPluginTestApp(t)
	store := &stubAIProviderStore{providers: []ai.ProviderConfig{{ID: "provider-existing", Name: "百倍", BaseURL: "https://sub.100xlabs.space"}}}
	a.SetAIProviderStore(store)

	result, code, _ := callImportCapability(t, a, []string{plugin.AIProvidersWritePermission},
		`{"providers":[{"name":"百倍","baseUrl":"https://sub.100xlabs.space","apiFormat":"anthropic","overwrite":true}]}`)
	if code != "" {
		t.Fatalf("unexpected failure code %q", code)
	}
	if result.Imported != 1 || result.Skipped != 0 {
		t.Fatalf("counts = imported:%d skipped:%d", result.Imported, result.Skipped)
	}
	if len(store.saved) != 1 || store.saved[0].ID != "provider-existing" {
		t.Fatalf("overwrite must reuse the existing provider id: %+v", store.saved)
	}
	if result.Items[0].ProviderID != "provider-existing" {
		t.Fatalf("provider id in result = %q", result.Items[0].ProviderID)
	}
}

func TestPluginCapabilityAIProvidersImportRejectsBadArguments(t *testing.T) {
	oversized := make([]string, 0, pluginAIProviderImportMaxItems+1)
	for i := 0; i <= pluginAIProviderImportMaxItems; i++ {
		oversized = append(oversized, fmt.Sprintf(`{"name":"n%d","baseUrl":"https://example.com","apiFormat":"openai"}`, i))
	}
	cases := []struct {
		name      string
		arguments string
		want      string
	}{
		{name: "empty object", arguments: `{}`, want: "invalid_arguments"},
		{name: "no providers", arguments: `{"providers":[]}`, want: "invalid_arguments"},
		{name: "unknown field", arguments: `{"providers":[],"extra":true}`, want: "invalid_arguments"},
		{name: "too many providers", arguments: `{"providers":[` + strings.Join(oversized, ",") + `]}`, want: "too_many_providers"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			a := newPluginTestApp(t)
			a.SetAIProviderStore(&stubAIProviderStore{})
			_, code, _ := callImportCapability(t, a, []string{plugin.AIProvidersWritePermission}, test.arguments)
			if code != test.want {
				t.Fatalf("code = %q, want %q", code, test.want)
			}
		})
	}
}

func TestPluginCapabilityAIProvidersImportRejectsUnsupportedFormatPerItem(t *testing.T) {
	a := newPluginTestApp(t)
	store := &stubAIProviderStore{}
	a.SetAIProviderStore(store)

	result, code, _ := callImportCapability(t, a, []string{plugin.AIProvidersWritePermission},
		`{"providers":[{"name":"cli","baseUrl":"https://example.com","apiFormat":"codex-cli"}]}`)
	if code != "" {
		t.Fatalf("unexpected failure code %q", code)
	}
	if result.Failed != 1 || result.Items[0].Reason != pluginAIProviderImportReasonInvalidFormat {
		t.Fatalf("result = %+v", result)
	}
	if len(store.saved) != 0 {
		t.Fatalf("unsupported format must not reach the store")
	}
}

func TestPluginCapabilityAIProvidersImportRequiresPermission(t *testing.T) {
	a := newPluginTestApp(t)
	a.SetAIProviderStore(&stubAIProviderStore{})

	_, code, _ := callImportCapability(t, a, []string{plugin.PagesPermission},
		`{"providers":[{"name":"x","baseUrl":"https://example.com","apiFormat":"openai"}]}`)
	if code != "permission_denied" {
		t.Fatalf("code = %q, want permission_denied", code)
	}
}

func TestPluginCapabilityAIProvidersImportFailsClosedWithoutStore(t *testing.T) {
	a := newPluginTestApp(t)
	_, code, _ := callImportCapability(t, a, []string{plugin.AIProvidersWritePermission},
		`{"providers":[{"name":"x","baseUrl":"https://example.com","apiFormat":"openai"}]}`)
	if code != "internal" {
		t.Fatalf("code = %q, want internal", code)
	}
}

func TestPluginCapabilityAIProvidersImportReportsSaveFailure(t *testing.T) {
	a := newPluginTestApp(t)
	a.SetAIProviderStore(&stubAIProviderStore{failSave: true})

	result, code, _ := callImportCapability(t, a, []string{plugin.AIProvidersWritePermission},
		`{"providers":[{"name":"x","baseUrl":"https://example.com","apiFormat":"openai"}]}`)
	if code != "" {
		t.Fatalf("unexpected failure code %q", code)
	}
	if result.Failed != 1 || result.Items[0].Reason != pluginAIProviderImportReasonSaveFailed {
		t.Fatalf("result = %+v", result)
	}
}

func TestPluginCapabilityAIProvidersImportCatalogEntry(t *testing.T) {
	spec, ok := defaultPluginCapabilities()["ai.providers.import"]
	if !ok {
		t.Fatal("ai.providers.import is not registered")
	}
	if spec.Permission != plugin.AIProvidersWritePermission {
		t.Fatalf("permission = %q", spec.Permission)
	}
	if !spec.Mutating {
		t.Fatal("import capability must be marked mutating")
	}
	for _, channel := range []pluginCapabilityChannel{pluginCapabilityChannelPage, pluginCapabilityChannelWindow, pluginCapabilityChannelBackend} {
		if spec.Channels&channel == 0 {
			t.Fatalf("channel %v is not served", channel)
		}
	}
}

// TestPluginCapabilityAIProvidersImportRejectsOversizedAPIKey 密钥超长逐条失败，
// reason 是贴切的 invalid_api_key，而不是含混的 save_failed（那条其实根本没走到保存）。
func TestPluginCapabilityAIProvidersImportRejectsOversizedAPIKey(t *testing.T) {
	a := newPluginTestApp(t)
	store := &stubAIProviderStore{}
	a.SetAIProviderStore(store)
	oversized := strings.Repeat("x", pluginAIProviderImportAPIKeyMax+1)
	result, code, _ := callImportCapability(t, a, []string{plugin.AIProvidersWritePermission},
		`{"providers":[{"name":"x","baseUrl":"https://example.com","apiFormat":"openai","apiKey":"`+oversized+`"}]}`)
	if code != "" {
		t.Fatalf("unexpected failure code %q", code)
	}
	if result.Failed != 1 || result.Items[0].Reason != pluginAIProviderImportReasonInvalidAPIKey {
		t.Fatalf("result = %+v", result)
	}
	if len(store.saved) != 0 {
		t.Fatal("超长密钥不该落库")
	}
}

// TestPluginCapabilityAIProvidersImportDuplicateIgnoresURLCredentials 既有供应商地址带凭据
// （用户把 key 粘进了 URL）时，导入去凭据后的同一地址仍要判成重复，而不是又建一条。
func TestPluginCapabilityAIProvidersImportDuplicateIgnoresURLCredentials(t *testing.T) {
	a := newPluginTestApp(t)
	store := &stubAIProviderStore{providers: []ai.ProviderConfig{{ID: "provider-existing", Name: "千刀", BaseURL: "https://user:pass@api.zzzcoding.org/v1/"}}}
	a.SetAIProviderStore(store)
	result, code, _ := callImportCapability(t, a, []string{plugin.AIProvidersWritePermission},
		`{"providers":[{"name":"千刀","baseUrl":"https://api.zzzcoding.org/v1","apiFormat":"anthropic"}]}`)
	if code != "" {
		t.Fatalf("unexpected failure code %q", code)
	}
	if result.Skipped != 1 || result.Items[0].Reason != pluginAIProviderImportReasonDuplicate {
		t.Fatalf("带凭据的既有地址应判为重名同址：%+v", result)
	}
	if len(store.saved) != 0 {
		t.Fatal("命中重复时不该再建一条")
	}
}

// TestPluginImportedProviderHeadersOverLimitFailClosed 超过上限（16 组）时不允许静默截断：
// 自定义头常常承载鉴权，丢掉一个就会产出一条看起来正常、实际调不通的供应商，还不留痕迹。
// 因此超限整条失败（reason=too_many_headers）；恰好 16 组则必须全保留且每次一致
// （map 迭代顺序随机，不排序会让「留下了哪些头」不确定）。
func TestPluginImportedProviderHeadersOverLimitFailClosed(t *testing.T) {
	over := map[string]string{}
	for i := 0; i < pluginAIProviderImportHeadersMax+4; i++ {
		over[fmt.Sprintf("x-h-%02d", i)] = "v"
	}
	if headers, reason := pluginImportedProviderHeaders(over); headers != nil || reason != pluginAIProviderImportReasonTooManyHeaders {
		t.Fatalf("超限应整条失败且不下发头：headers=%v reason=%q", headers, reason)
	}

	exact := map[string]string{}
	for i := 0; i < pluginAIProviderImportHeadersMax; i++ {
		exact[fmt.Sprintf("x-h-%02d", i)] = "v"
	}
	first, reason := pluginImportedProviderHeaders(exact)
	if reason != "" || len(first) != pluginAIProviderImportHeadersMax {
		t.Fatalf("恰好 %d 组应全保留：headers=%d reason=%q", pluginAIProviderImportHeadersMax, len(first), reason)
	}
	for i := 0; i < 10; i++ {
		again, _ := pluginImportedProviderHeaders(exact)
		if len(again) != len(first) {
			t.Fatal("两次保留的头数量不同")
		}
		for key := range first {
			if _, ok := again[key]; !ok {
				t.Fatalf("两次保留的头集合不同：%v vs %v", first, again)
			}
		}
	}
}

// TestPluginImportedProviderHeadersAreCaseInsensitive HTTP 头大小写不敏感：
// X-Foo 与 x-foo 只保留一个，避免语义重复的头被同时下发。
func TestPluginImportedProviderHeadersAreCaseInsensitive(t *testing.T) {
	result, reason := pluginImportedProviderHeaders(map[string]string{"X-Foo": "1", "x-foo": "2", "X-Bar": "3"})
	if reason != "" {
		t.Fatalf("大小写去重不该判失败：reason=%q", reason)
	}
	if len(result) != 2 {
		t.Fatalf("headers = %v, want 2 项（大小写不同的同名头只留一个）", result)
	}
	if _, ok := result["X-Bar"]; !ok {
		t.Error("X-Bar 应保留")
	}
}

// TestPluginCapabilityAIProvidersImportRejectsTooManyHeaders 走真实能力分发路径：
// 一条带 20 组自定义头的条目按 too_many_headers 记为失败，同批其它条目照常导入。
func TestPluginCapabilityAIProvidersImportRejectsTooManyHeaders(t *testing.T) {
	a := newPluginTestApp(t)
	store := &stubAIProviderStore{}
	a.SetAIProviderStore(store)

	headers := make([]string, 0, 20)
	for i := 0; i < 20; i++ {
		headers = append(headers, fmt.Sprintf(`"x-h-%02d":"v"`, i))
	}
	arguments := `{"providers":[` +
		`{"name":"头太多","baseUrl":"https://many.example/v1","apiFormat":"openai","headers":{` + strings.Join(headers, ",") + `}},` +
		`{"name":"正常","baseUrl":"https://ok.example/v1","apiFormat":"openai","headers":{"X-Tenant":"acme"}}` +
		`]}`
	result, code, _ := callImportCapability(t, a, []string{plugin.AIProvidersWritePermission}, arguments)
	if code != "" {
		t.Fatalf("unexpected failure code %q", code)
	}
	if result.Failed != 1 || result.Items[0].Reason != pluginAIProviderImportReasonTooManyHeaders {
		t.Fatalf("超限条目应记 too_many_headers：%+v", result.Items[0])
	}
	if result.Imported != 1 || result.Items[1].Status != pluginAIProviderImportStatusImported {
		t.Fatalf("同批其它条目必须照常导入：%+v", result.Items[1])
	}
	if len(store.saved) != 1 || store.saved[0].Headers["X-Tenant"] != "acme" {
		t.Fatalf("正常条目的自定义头应原样落库：%+v", store.saved)
	}
}
