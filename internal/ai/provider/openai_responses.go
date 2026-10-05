package provider

import (
	"fmt"
	"net/http"
	"strings"

	"GoNavi-Wails/internal/ai"
)

// OpenAIResponsesProvider 实现 OpenAI Responses API，并将 Items/SSE 事件
// 适配为 GoNavi 内部统一的消息、工具调用和流式片段。
type OpenAIResponsesProvider struct {
	config  ai.ProviderConfig
	baseURL string
	client  *http.Client
}

var openAIResponsesHTTPTransport = func() http.RoundTripper {
	transport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return http.DefaultTransport
	}
	transport = transport.Clone()
	// 流式请求不能用 Client.Timeout 限制整个响应体，但仍需限制等待响应头。
	transport.ResponseHeaderTimeout = openAIHTTPTimeout
	return transport
}()

func NewOpenAIResponsesProvider(config ai.ProviderConfig) (Provider, error) {
	baseURL := normalizeOpenAIResponsesBaseURL(config.BaseURL)
	model := strings.TrimSpace(config.Model)
	if model == "" {
		return nil, fmt.Errorf("model ID is required; select or enter a model in Settings")
	}

	temperature := config.Temperature
	if temperature <= 0 {
		temperature = defaultOpenAITemperature
	}

	normalized := config
	normalized.BaseURL = baseURL
	normalized.Model = model
	normalized.Temperature = temperature
	profile := ResolveThinkingProfile(config.Type, config.APIFormat, baseURL, model)
	normalized.ThinkingIntensity = string(clampThinkingIntensityToProfile(config.ThinkingIntensity, profile))

	return &OpenAIResponsesProvider{
		config:  normalized,
		baseURL: baseURL,
		client:  newOpenAIResponsesHTTPClient(),
	}, nil
}

func newOpenAIResponsesHTTPClient() *http.Client {
	return &http.Client{
		Timeout:   openAIHTTPTimeout,
		Transport: openAIResponsesHTTPTransport,
	}
}

func openAIResponsesHTTPClientForRequest(client *http.Client, stream bool) *http.Client {
	if !stream || client == nil || client.Timeout == 0 {
		return client
	}

	// http.Client.Timeout 会一直计时到响应体读取完成，长时间正常输出的 SSE
	// 也会被截断。浅拷贝保留 Transport、重定向和 Cookie 配置，仅让本次
	// 流式请求由 request context 控制生命周期。
	streamClient := *client
	streamClient.Timeout = 0
	return &streamClient
}

func normalizeOpenAIResponsesBaseURL(raw string) string {
	baseURL := NormalizeOpenAICompatibleBaseURL(raw)
	if isDeepSeekHost(baseURL) {
		baseURL = strings.TrimSuffix(baseURL, "/v1")
	}
	return strings.TrimRight(baseURL, "/")
}

func boolPointer(value bool) *bool {
	return &value
}

func isDeepSeekResponsesBaseURL(baseURL string) bool {
	return isDeepSeekHost(baseURL)
}

func (p *OpenAIResponsesProvider) Name() string {
	if strings.TrimSpace(p.config.Name) != "" {
		return p.config.Name
	}
	return "OpenAI Responses"
}

func (p *OpenAIResponsesProvider) Validate() error {
	if strings.TrimSpace(p.config.APIKey) == "" {
		return fmt.Errorf("API key is required")
	}
	return nil
}
