package aiservice

import (
	"fmt"
	"net/http"
	"reflect"
	"sync"
	"testing"

	"GoNavi-Wails/internal/ai"
)

func TestGetActiveProviderRuntimeSerializesFallbackSelection(t *testing.T) {
	service := NewServiceWithSecretStore(nil)
	service.providers = []ai.ProviderConfig{{
		ID:          "provider-1",
		Type:        "openai",
		Name:        "test",
		APIKey:      "sk-test",
		BaseURL:     "https://example.com/v1",
		Model:       "test-model",
		MaxTokens:   64,
		Temperature: 0.1,
	}}

	const callers = 16
	var wg sync.WaitGroup
	errs := make(chan error, callers)
	wg.Add(callers)
	for range callers {
		go func() {
			defer wg.Done()
			_, config, err := service.getActiveProviderRuntime()
			if err == nil && config.ID != "provider-1" {
				err = fmt.Errorf("selected provider %q, want provider-1", config.ID)
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)

	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := service.AIGetActiveProvider(); got != "provider-1" {
		t.Fatalf("active provider = %q, want provider-1", got)
	}
}

func TestResolveModelsURL_UsesMoonshotOpenAIModelsEndpointForKimiAnthropicBaseURL(t *testing.T) {
	url := resolveModelsURL(ai.ProviderConfig{
		Type:    "anthropic",
		BaseURL: "https://api.moonshot.cn/anthropic",
	})
	if url != "https://api.moonshot.cn/v1/models" {
		t.Fatalf("expected moonshot models endpoint, got %q", url)
	}
}

func TestResolveModelsURL_UsesAnthropicModelsEndpointForOfficialAnthropic(t *testing.T) {
	url := resolveModelsURL(ai.ProviderConfig{
		Type:    "anthropic",
		BaseURL: "https://api.anthropic.com",
	})
	if url != "https://api.anthropic.com/v1/models" {
		t.Fatalf("expected anthropic models endpoint, got %q", url)
	}
}

func TestResolveModelsURL_UsesOpenAIModelsEndpointForOpenAICompatibleProvider(t *testing.T) {
	url := resolveModelsURL(ai.ProviderConfig{
		Type:    "openai",
		BaseURL: "https://api.openai.com/v1",
	})
	if url != "https://api.openai.com/v1/models" {
		t.Fatalf("expected openai models endpoint, got %q", url)
	}
}

func TestResolveModelsURL_UsesOpenAIModelsEndpointForResponsesProvider(t *testing.T) {
	url := resolveModelsURL(ai.ProviderConfig{
		Type:      "custom",
		APIFormat: "openai-responses",
		BaseURL:   "https://api.openai.com/v1",
	})
	if url != "https://api.openai.com/v1/models" {
		t.Fatalf("expected responses provider to share OpenAI models endpoint, got %q", url)
	}
}

func TestNormalizeProviderConfigRoutesDeepSeekV4FlashToResponses(t *testing.T) {
	got := normalizeProviderConfig(ai.ProviderConfig{
		Type:    "openai",
		BaseURL: "https://api.deepseek.com/v1/",
		Model:   "deepseek-v4-flash",
	})

	if got.Type != "openai" {
		t.Fatalf("expected OpenAI backend, got %q", got.Type)
	}
	if got.APIFormat != "openai-responses" {
		t.Fatalf("expected DeepSeek V4 Flash to use Responses, got %q", got.APIFormat)
	}
	if got.BaseURL != "https://api.deepseek.com" {
		t.Fatalf("expected DeepSeek Responses root base URL, got %q", got.BaseURL)
	}
}

func TestNormalizeProviderConfigPreservesExplicitDeepSeekChatSelection(t *testing.T) {
	got := normalizeProviderConfig(ai.ProviderConfig{
		Type:      "openai",
		APIFormat: "openai",
		BaseURL:   "https://api.deepseek.com",
		Model:     "deepseek-v4-flash",
	})

	if got.APIFormat != "openai" {
		t.Fatalf("explicit DeepSeek Chat selection should remain Chat Completions, got %q", got.APIFormat)
	}
	if got.BaseURL != "https://api.deepseek.com/v1" {
		t.Fatalf("explicit DeepSeek Chat selection should use the /v1 base URL, got %q", got.BaseURL)
	}
}

func TestNormalizeProviderConfigKeepsDeepSeekResponsesBaseForExplicitResponsesSelection(t *testing.T) {
	got := normalizeProviderConfig(ai.ProviderConfig{
		Type:      "openai",
		APIFormat: "openai-responses",
		BaseURL:   "https://api.deepseek.com/v1",
		Model:     "deepseek-v4-flash",
	})

	if got.APIFormat != "openai-responses" || got.BaseURL != "https://api.deepseek.com" {
		t.Fatalf("explicit DeepSeek Responses selection should use root endpoint, got %#v", got)
	}
}

func TestNormalizeProviderConfigKeepsLegacyDeepSeekChatOnChatCompletions(t *testing.T) {
	got := normalizeProviderConfig(ai.ProviderConfig{
		Type:      "openai",
		APIFormat: "openai",
		BaseURL:   "https://api.deepseek.com/v1",
		Model:     "deepseek-chat",
	})

	if got.APIFormat != "openai" || got.BaseURL != "https://api.deepseek.com/v1" {
		t.Fatalf("legacy DeepSeek chat config should remain Chat Completions, got %#v", got)
	}
}

func TestNewProviderHealthCheckRequestUsesDeepSeekModelsEndpointAfterMigration(t *testing.T) {
	req, err := newProviderHealthCheckRequest(ai.ProviderConfig{
		Type:    "openai",
		BaseURL: "https://api.deepseek.com/v1",
		Model:   "deepseek-v4-flash",
		APIKey:  "sk-test",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if req.Method != http.MethodGet || req.URL.String() != "https://api.deepseek.com/models" {
		t.Fatalf("expected DeepSeek health check to use /models, got %s %s", req.Method, req.URL.String())
	}
}

func TestNewProviderHealthCheckRequestUsesDeepSeekChatModelsEndpointWhenChatSelected(t *testing.T) {
	req, err := newProviderHealthCheckRequest(ai.ProviderConfig{
		Type:      "openai",
		APIFormat: "openai",
		BaseURL:   "https://api.deepseek.com",
		Model:     "deepseek-v4-flash",
		APIKey:    "sk-test",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if req.Method != http.MethodGet || req.URL.String() != "https://api.deepseek.com/v1/models" {
		t.Fatalf("expected DeepSeek Chat health check to use /v1/models, got %s %s", req.Method, req.URL.String())
	}
}

func TestResolveModelsURL_UsesVersionedVolcengineCodingPlanPath(t *testing.T) {
	url := resolveModelsURL(ai.ProviderConfig{
		Type:    "openai",
		BaseURL: "https://ark.cn-beijing.volces.com/api/coding/v3",
	})
	if url != "https://ark.cn-beijing.volces.com/api/coding/v3/models" {
		t.Fatalf("expected volcengine coding plan models endpoint, got %q", url)
	}
}

func TestResolveModelsURL_UsesVersionedZhipuPath(t *testing.T) {
	url := resolveModelsURL(ai.ProviderConfig{
		Type:    "openai",
		BaseURL: "https://open.bigmodel.cn/api/paas/v4",
	})
	if url != "https://open.bigmodel.cn/api/paas/v4/models" {
		t.Fatalf("expected zhipu models endpoint, got %q", url)
	}
}

func TestNewModelsRequest_StripsChatCompletionsSuffixForOpenAICompatibleProvider(t *testing.T) {
	req, err := newModelsRequest(ai.ProviderConfig{
		Type:    "openai",
		BaseURL: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
		APIKey:  "sk-test",
	}, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if req.URL.String() != "https://ark.cn-beijing.volces.com/api/v3/models" {
		t.Fatalf("expected normalized models endpoint, got %q", req.URL.String())
	}
	if got := req.Header.Get("Authorization"); got != "Bearer sk-test" {
		t.Fatalf("expected bearer auth header, got %q", got)
	}
}

func TestDefaultStaticModelsForProvider_ReturnsMiniMaxAnthropicModels(t *testing.T) {
	models := defaultStaticModelsForProvider(ai.ProviderConfig{
		Type:    "anthropic",
		BaseURL: "https://api.minimaxi.com/anthropic",
	})
	expected := []string{
		"MiniMax-M3",
		"MiniMax-M2.7",
		"MiniMax-M2.7-highspeed",
	}
	if !reflect.DeepEqual(models, expected) {
		t.Fatalf("expected MiniMax static models %v, got %v", expected, models)
	}
}

func TestDefaultStaticModelsForProvider_DoesNotReturnDashScopeBailianStaticModels(t *testing.T) {
	models := defaultStaticModelsForProvider(ai.ProviderConfig{
		Type:    "anthropic",
		BaseURL: "https://dashscope.aliyuncs.com/apps/anthropic",
	})
	if len(models) != 0 {
		t.Fatalf("expected Bailian provider to fetch models remotely, got %v", models)
	}
}

func TestApplyChatSendOptionsToProviderConfig_OverridesModelForSingleRequest(t *testing.T) {
	config := applyChatSendOptionsToProviderConfig(ai.ProviderConfig{
		Model: "chat-model",
	}, ai.ChatSendOptions{
		Model: "inline-model",
	})
	if config.Model != "inline-model" {
		t.Fatalf("expected inline model override, got %q", config.Model)
	}
}

func TestApplyChatSendOptionsToProviderConfig_OverridesThinkingIntensity(t *testing.T) {
	config := applyChatSendOptionsToProviderConfig(ai.ProviderConfig{
		Model:             "chat-model",
		ThinkingIntensity: "low",
	}, ai.ChatSendOptions{
		ThinkingIntensity: "xhigh",
	})
	if config.ThinkingIntensity != "xhigh" {
		t.Fatalf("expected thinking intensity override, got %q", config.ThinkingIntensity)
	}
	// empty override keeps provider value
	config = applyChatSendOptionsToProviderConfig(ai.ProviderConfig{
		ThinkingIntensity: "medium",
	}, ai.ChatSendOptions{})
	if config.ThinkingIntensity != "medium" {
		t.Fatalf("expected provider thinking intensity kept, got %q", config.ThinkingIntensity)
	}
}

func TestApplyChatSendOptionsToProviderConfig_KeepsConfiguredModelWhenOverrideEmpty(t *testing.T) {
	config := applyChatSendOptionsToProviderConfig(ai.ProviderConfig{
		Model: "chat-model",
	}, ai.ChatSendOptions{
		Model: "  ",
	})
	if config.Model != "chat-model" {
		t.Fatalf("expected configured model to be kept, got %q", config.Model)
	}
}

func TestNormalizeChatSendOptions_TrimsModelAndClampsNegativeNumbers(t *testing.T) {
	options := normalizeChatSendOptions(ai.ChatSendOptions{
		Model:       " inline-model ",
		MaxTokens:   -1,
		Temperature: -0.5,
	})
	if options.Model != "inline-model" {
		t.Fatalf("expected trimmed model, got %q", options.Model)
	}
	if options.MaxTokens != 0 {
		t.Fatalf("expected negative max tokens to be clamped, got %d", options.MaxTokens)
	}
	if options.Temperature != 0 {
		t.Fatalf("expected negative temperature to be clamped, got %f", options.Temperature)
	}
}

func TestNewProviderHealthCheckRequest_UsesMessagesEndpointForMiniMaxAnthropic(t *testing.T) {
	req, err := newProviderHealthCheckRequest(ai.ProviderConfig{
		Type:    "anthropic",
		BaseURL: "https://api.minimaxi.com/anthropic",
		Model:   "MiniMax-M2.7",
		APIKey:  "sk-test",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if req.Method != "POST" {
		t.Fatalf("expected POST request, got %s", req.Method)
	}
	if req.URL.String() != "https://api.minimaxi.com/anthropic/v1/messages" {
		t.Fatalf("expected MiniMax messages endpoint, got %q", req.URL.String())
	}
	if got := req.Header.Get("x-api-key"); got != "sk-test" {
		t.Fatalf("expected x-api-key header to be set, got %q", got)
	}
}

func TestNewProviderHealthCheckRequest_UsesMessagesEndpointForDashScopeAnthropic(t *testing.T) {
	req, err := newProviderHealthCheckRequest(ai.ProviderConfig{
		Type:    "anthropic",
		BaseURL: "https://dashscope.aliyuncs.com/apps/anthropic",
		Model:   "qwen3.5-plus",
		APIKey:  "sk-test",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if req.Method != "POST" {
		t.Fatalf("expected POST request, got %s", req.Method)
	}
	if req.URL.String() != "https://dashscope.aliyuncs.com/apps/anthropic/v1/messages" {
		t.Fatalf("expected DashScope messages endpoint, got %q", req.URL.String())
	}
	if got := req.Header.Get("x-api-key"); got != "sk-test" {
		t.Fatalf("expected x-api-key header to be set, got %q", got)
	}
	if got := req.Header.Get("Authorization"); got != "Bearer sk-test" {
		t.Fatalf("expected bearer authorization header, got %q", got)
	}
	if got := req.Header.Get("anthropic-version"); got != "" {
		t.Fatalf("expected no anthropic-version header for DashScope, got %q", got)
	}
}
