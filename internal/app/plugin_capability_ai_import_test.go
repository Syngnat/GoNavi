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
	// onSave 在每次写入前回调，供测试注入「写入过程中取消」这类时序。
	onSave func()
}

func (s *stubAIProviderStore) ListProviders() []ai.ProviderConfig {
	return append([]ai.ProviderConfig(nil), s.providers...)
}

func (s *stubAIProviderStore) SaveProvider(config ai.ProviderConfig) (ai.ProviderConfig, error) {
	if s.onSave != nil {
		s.onSave()
	}
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
	return callImportCapabilityContext(t, a, context.Background(), permissions, arguments)
}

// callImportCapabilityContext 与上面同路径，但允许注入会被取消的 context，
// 用来验证「取消后不再继续写入」。
func callImportCapabilityContext(t *testing.T, a *App, ctx context.Context, permissions []string, arguments string) (pluginAIProviderImportResult, string, string) {
	t.Helper()
	status := plugin.Status{
		Manifest:       pluginPageTestManifest("test.ai", permissions...),
		Generation:     1,
		State:          plugin.StateRunning,
		DesiredEnabled: true,
	}
	raw, err := a.pluginCapabilityCall(ctx, status, pluginCapabilityChannelWindow, "ai.providers.import", json.RawMessage(arguments))
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

// TestPluginCapabilityAIProvidersImportKeepsLongAuthHeaders 长凭据头必须原样落库：
// Authorization 里的 JWT 动辄几百到上千字节，此前 256 字节以上的值被静默丢掉，
// 结果是「导入成功但鉴权头为空」——看起来成了，实际调不通。值上限现为 4096 字节。
func TestPluginCapabilityAIProvidersImportKeepsLongAuthHeaders(t *testing.T) {
	a := newPluginTestApp(t)
	store := &stubAIProviderStore{}
	a.SetAIProviderStore(store)

	token := strings.Repeat("a", 900)
	arguments := `{"providers":[{"name":"长令牌站","baseUrl":"https://long.example/v1","apiFormat":"openai","headers":{"Authorization":"Bearer ` + token + `"}}]}`
	result, code, _ := callImportCapability(t, a, []string{plugin.AIProvidersWritePermission}, arguments)
	if code != "" {
		t.Fatalf("unexpected failure code %q", code)
	}
	if result.Imported != 1 {
		t.Fatalf("counts = %+v", result)
	}
	if len(store.saved) != 1 {
		t.Fatalf("saved = %d, want 1", len(store.saved))
	}
	got := store.saved[0].Headers["Authorization"]
	if got != "Bearer "+token {
		t.Fatalf("长凭据头没有原样落库：长度 %d, want %d", len(got), len("Bearer ")+len(token))
	}
}

// TestPluginCapabilityAIProvidersImportRejectsUnusableHeaders 无法在边界内安全落库的请求头
// 必须按该条失败（reason invalid_headers），不允许静默丢弃——静默丢头等于把「供应商不可用」
// 伪装成「导入成功」。
func TestPluginCapabilityAIProvidersImportRejectsUnusableHeaders(t *testing.T) {
	oversized := strings.Repeat("v", 4097)
	cases := []struct {
		name      string
		headers   string
		wantIndex int
	}{
		{name: "value too long", headers: `{"Authorization":"` + oversized + `"}`, wantIndex: 0},
		{name: "key too long", headers: `{"` + strings.Repeat("k", 257) + `":"v"}`, wantIndex: 0},
		{name: "empty key", headers: `{"":"v"}`, wantIndex: 0},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			a := newPluginTestApp(t)
			store := &stubAIProviderStore{}
			a.SetAIProviderStore(store)
			arguments := `{"providers":[{"name":"坏头站","baseUrl":"https://bad-header.example/v1","apiFormat":"openai","headers":` + test.headers + `}]}`
			result, code, _ := callImportCapability(t, a, []string{plugin.AIProvidersWritePermission}, arguments)
			if code != "" {
				t.Fatalf("unexpected failure code %q", code)
			}
			if result.Failed != 1 || result.Items[test.wantIndex].Reason != pluginAIProviderImportReasonInvalidHeaders {
				t.Fatalf("应记 invalid_headers：%+v", result.Items)
			}
			if len(store.saved) != 0 {
				t.Fatalf("失败条目不得落库：%+v", store.saved)
			}
		})
	}
}

// TestPluginCapabilityAIProvidersImportStopsOnCancel 取消后不得继续写入，且已写入的条目
// 必须如实回报（不是「什么都没有」的 internal）：调用方要能知道落了几条、分别是什么结果。
func TestPluginCapabilityAIProvidersImportStopsOnCancel(t *testing.T) {
	a := newPluginTestApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	store := &stubAIProviderStore{onSave: func() { cancel() }}
	a.SetAIProviderStore(store)

	arguments := `{"providers":[` +
		`{"name":"一","baseUrl":"https://one.example/v1","apiFormat":"openai"},` +
		`{"name":"二","baseUrl":"https://two.example/v1","apiFormat":"openai"},` +
		`{"name":"三","baseUrl":"https://three.example/v1","apiFormat":"openai"}]}`
	result, code, _ := callImportCapabilityContext(t, a, ctx, []string{plugin.AIProvidersWritePermission}, arguments)
	if code != "" {
		t.Fatalf("取消是正常结果而不是传输失败，code = %q", code)
	}
	if len(store.saved) != 1 {
		t.Fatalf("取消后仍写入 %d 条，want 1", len(store.saved))
	}
	if result.Imported != 1 || !result.Cancelled {
		t.Fatalf("应回报 1 条已导入且标记 cancelled：%+v", result)
	}
	// 「一个请求条目一条结果」这条不能因为取消就破：已写入的照实记 imported，没来得及处理的记
	// cancelled，调用方才能逐条对账自己勾的东西到底落了几条。
	if len(result.Items) != 3 {
		t.Fatalf("items = %d, want 3", len(result.Items))
	}
	if result.Items[0].Status != pluginAIProviderImportStatusImported {
		t.Fatalf("第 1 条应记 imported：%+v", result.Items[0])
	}
	for _, index := range []int{1, 2} {
		if result.Items[index].Status != pluginAIProviderImportStatusFailed ||
			result.Items[index].Reason != pluginAIProviderImportReasonCancelled {
			t.Fatalf("第 %d 条应记 failed/cancelled：%+v", index+1, result.Items[index])
		}
	}
}

// TestPluginCapabilityAIProvidersImportBoundsEchoedNames 失败条目回显的名称必须有界：
// 入参名字没有长度上限（只受 MaxArgsBytes 约束），原样回显会让 100 条就能撑破 64 KiB 结果上限，
// 整批变成 result_too_large、连成功/失败明细都没有。
func TestPluginCapabilityAIProvidersImportBoundsEchoedNames(t *testing.T) {
	a := newPluginTestApp(t)
	store := &stubAIProviderStore{}
	a.SetAIProviderStore(store)

	hugeName := strings.Repeat("n", 200_000)
	arguments := `{"providers":[` +
		`{"name":"` + hugeName + `","baseUrl":"https://huge.example/v1","apiFormat":"openai"},` +
		`{"name":"正常","baseUrl":"https://ok.example/v1","apiFormat":"openai"}]}`
	result, code, raw := callImportCapability(t, a, []string{plugin.AIProvidersWritePermission}, arguments)
	if code != "" {
		t.Fatalf("超长名字不该把整批打成 %q", code)
	}
	if result.Failed != 1 || result.Items[0].Reason != pluginAIProviderImportReasonInvalidName {
		t.Fatalf("超长名字应记 invalid_name：%+v", result.Items[0])
	}
	if len(result.Items[0].Name) > 256 {
		t.Fatalf("回显名字未截断：%d 字节", len(result.Items[0].Name))
	}
	if result.Imported != 1 || result.Items[1].Status != pluginAIProviderImportStatusImported {
		t.Fatalf("同批其它条目必须照常导入：%+v", result.Items[1])
	}
	if len(raw) > pluginAIProviderImportMaxResultBytes {
		t.Fatalf("返回体 %d 字节，超过能力上限 %d", len(raw), pluginAIProviderImportMaxResultBytes)
	}
}

// TestPluginCapabilityAIProvidersImportIdentityKeepsPathCase 路径大小写是区分不同供应商的：
// /tenant/A 与 /tenant/a 是两个地址，此前整串 ToLower 会把它们合成一条，覆盖模式还会改错条目。
func TestPluginCapabilityAIProvidersImportIdentityKeepsPathCase(t *testing.T) {
	a := newPluginTestApp(t)
	store := &stubAIProviderStore{}
	a.SetAIProviderStore(store)

	arguments := `{"providers":[` +
		`{"name":"租户站","baseUrl":"https://api.example.com/tenant/A","apiFormat":"openai"},` +
		`{"name":"租户站","baseUrl":"https://api.example.com/tenant/a","apiFormat":"openai"}]}`
	result, code, _ := callImportCapability(t, a, []string{plugin.AIProvidersWritePermission}, arguments)
	if code != "" {
		t.Fatalf("unexpected failure code %q", code)
	}
	if result.Imported != 2 || result.Skipped != 0 {
		t.Fatalf("路径大小写不同的地址必须算两条：%+v", result)
	}
	if len(store.saved) != 2 {
		t.Fatalf("saved = %d, want 2", len(store.saved))
	}
	// 主机名大小写不敏感这条不能被改坏：同一主机不同大小写仍算重复。
	a2 := newPluginTestApp(t)
	store2 := &stubAIProviderStore{}
	a2.SetAIProviderStore(store2)
	result2, code2, _ := callImportCapability(t, a2, []string{plugin.AIProvidersWritePermission},
		`{"providers":[{"name":"主机站","baseUrl":"https://API.example.com/x","apiFormat":"openai"},{"name":"主机站","baseUrl":"https://api.example.com/x","apiFormat":"openai"}]}`)
	if code2 != "" {
		t.Fatalf("unexpected failure code %q", code2)
	}
	if result2.Imported != 1 || result2.Skipped != 1 {
		t.Fatalf("主机名大小写不同仍算重复：%+v", result2)
	}
}
