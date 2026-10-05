package aiservice

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
	"GoNavi-Wails/shared/i18n"
)

func resolveModelsURL(config ai.ProviderConfig) string {
	config = normalizeProviderConfig(config)
	providerType := normalizedProviderType(config)
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")

	switch providerType {
	case "anthropic":
		if isMoonshotAnthropicProvider(config) {
			return "https://api.moonshot.cn/v1/models"
		}
		if isDashScopeBailianAnthropicProvider(config) {
			return "https://dashscope.aliyuncs.com/compatible-mode/v1/models"
		}
		if baseURL == "" {
			baseURL = "https://api.anthropic.com"
		}
		if !strings.HasSuffix(baseURL, "/v1") && !strings.Contains(baseURL, "/v1/") {
			baseURL = baseURL + "/v1"
		}
		return baseURL + "/models"
	case "gemini":
		if baseURL == "" {
			baseURL = "https://generativelanguage.googleapis.com"
		}
		return baseURL + "/v1beta/models?key=" + config.APIKey
	case "cursor-agent":
		return provider.ResolveCursorAPIEndpoint(baseURL, "models")
	case "codex-cli", "codebuddy-cli", "cursor-cli":
		return ""
	case "openai":
		if isDeepSeekResponsesProvider(config) {
			return "https://api.deepseek.com/models"
		}
		fallthrough
	default:
		return provider.ResolveOpenAICompatibleEndpoint(baseURL, "models")
	}
}

func newModelsRequest(config ai.ProviderConfig, localizer *i18n.Localizer) (*http.Request, error) {
	config = normalizeProviderConfig(config)
	url := resolveModelsURL(config)
	if strings.TrimSpace(url) == "" {
		return nil, fmt.Errorf("create request failed: %s", serviceTextFromLocalizer(localizer, "ai_service.backend.error.models_remote_unsupported", nil))
	}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request failed: %w", err)
	}

	switch normalizedProviderType(config) {
	case "anthropic":
		if strings.EqualFold(strings.TrimSpace(config.AuthMode), "bearer") {
			req.Header.Set("Authorization", "Bearer "+config.APIKey)
		} else if isDashScopeBailianAnthropicProvider(config) {
			req.Header.Set("Authorization", "Bearer "+config.APIKey)
		} else {
			provider.ApplyAnthropicAuthHeaders(req.Header, config.BaseURL, config.APIKey)
		}
	case "gemini":
		// Gemini 使用 query string 传递 key，无需额外鉴权头
	case "cursor-agent":
		req.Header.Set("Authorization", "Bearer "+config.APIKey)
	default:
		req.Header.Set("Authorization", "Bearer "+config.APIKey)
	}

	for k, v := range config.Headers {
		req.Header.Set(k, v)
	}

	return req, nil
}

func resolveAnthropicMessagesURL(baseURL string) string {
	url := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if url == "" {
		url = "https://api.anthropic.com"
	}
	if strings.HasSuffix(url, "/messages") {
		return url
	}
	if strings.HasSuffix(url, "/v1") {
		return url + "/messages"
	}
	return url + "/v1/messages"
}

func newProviderHealthCheckRequest(config ai.ProviderConfig) (*http.Request, error) {
	config = normalizeProviderConfig(config)
	if isMiniMaxAnthropicProvider(config) || isDashScopeBailianAnthropicProvider(config) || isDashScopeCodingPlanAnthropicProvider(config) {
		return newAnthropicMessagesHealthCheckRequest(config)
	}
	return newModelsRequest(config, nil)
}

func newAnthropicMessagesHealthCheckRequest(config ai.ProviderConfig) (*http.Request, error) {
	body := map[string]interface{}{
		"model":      config.Model,
		"max_tokens": 1,
		"messages": []map[string]string{
			{"role": "user", "content": "ping"},
		},
	}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("serialize request failed: %w", err)
	}
	req, err := http.NewRequest("POST", resolveAnthropicMessagesURL(config.BaseURL), strings.NewReader(string(bodyBytes)))
	if err != nil {
		return nil, fmt.Errorf("create request failed: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if strings.EqualFold(strings.TrimSpace(config.AuthMode), "bearer") {
		req.Header.Set("Authorization", "Bearer "+config.APIKey)
	} else {
		provider.ApplyAnthropicAuthHeaders(req.Header, config.BaseURL, config.APIKey)
	}
	for k, v := range config.Headers {
		req.Header.Set(k, v)
	}
	return req, nil
}

// fetchModels 从供应商 API 获取可用模型列表
var fetchModelsFunc = fetchModels

func fetchModels(config ai.ProviderConfig, localizer *i18n.Localizer) ([]string, error) {
	providerType := normalizedProviderType(config)
	if staticModels := defaultStaticModelsForProvider(config); len(staticModels) > 0 {
		return staticModels, nil
	}

	switch providerType {
	case "openai":
		return fetchOpenAIModels(config, localizer)
	case "anthropic":
		return fetchAnthropicModels(config, localizer)
	case "gemini":
		return fetchGeminiModels(config, localizer)
	case "cursor-agent":
		return fetchCursorModels(config, localizer)
	case "codex-cli", "codebuddy-cli", "cursor-cli":
		return append([]string(nil), config.Models...), nil
	default:
		return fetchOpenAIModels(config, localizer)
	}
}

// fetchOpenAIModels 获取 OpenAI 兼容 API 的模型列表
func fetchOpenAIModels(config ai.ProviderConfig, localizer *i18n.Localizer) ([]string, error) {
	req, err := newModelsRequest(config, localizer)
	if err != nil {
		return nil, localizeModelListRequestCreateError(localizer, err)
	}

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, localizeModelListRequestError(localizer, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, localizeModelListHTTPStatusError(localizer, resp.StatusCode, body)
	}

	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, localizeModelListParseError(localizer, err)
	}

	models := make([]string, 0, len(result.Data))
	for _, m := range result.Data {
		models = append(models, m.ID)
	}
	return models, nil
}

// fetchAnthropicModels 获取 Anthropic API 的模型列表
func fetchAnthropicModels(config ai.ProviderConfig, localizer *i18n.Localizer) ([]string, error) {
	req, err := newModelsRequest(config, localizer)
	if err != nil {
		return nil, localizeModelListRequestCreateError(localizer, err)
	}

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, localizeModelListRequestError(localizer, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, localizeModelListHTTPStatusError(localizer, resp.StatusCode, body)
	}

	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, localizeModelListParseError(localizer, err)
	}

	models := make([]string, 0, len(result.Data))
	for _, m := range result.Data {
		models = append(models, m.ID)
	}
	return models, nil
}

// fetchGeminiModels 获取 Gemini API 的模型列表
func fetchGeminiModels(config ai.ProviderConfig, localizer *i18n.Localizer) ([]string, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	if baseURL == "" {
		baseURL = "https://generativelanguage.googleapis.com"
	}

	req, err := http.NewRequest("GET", baseURL+"/v1beta/models?key="+config.APIKey, nil)
	if err != nil {
		return nil, localizeModelListRequestCreateError(localizer, err)
	}

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, localizeModelListRequestError(localizer, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, localizeModelListHTTPStatusError(localizer, resp.StatusCode, body)
	}

	var result struct {
		Models []struct {
			Name string `json:"name"` // e.g. "models/gemini-2.5-flash"
		} `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, localizeModelListParseError(localizer, err)
	}

	models := make([]string, 0, len(result.Models))
	for _, m := range result.Models {
		// 去掉 "models/" 前缀
		name := m.Name
		if strings.HasPrefix(name, "models/") {
			name = strings.TrimPrefix(name, "models/")
		}
		models = append(models, name)
	}
	return models, nil
}

func fetchCursorModels(config ai.ProviderConfig, localizer *i18n.Localizer) ([]string, error) {
	req, err := newModelsRequest(config, localizer)
	if err != nil {
		return nil, localizeModelListRequestCreateError(localizer, err)
	}

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, localizeModelListRequestError(localizer, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return nil, localizeModelListHTTPStatusError(localizer, resp.StatusCode, body)
	}

	var result struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, localizeModelListParseError(localizer, err)
	}

	models := make([]string, 0, len(result.Items))
	for _, item := range result.Items {
		if strings.TrimSpace(item.ID) != "" {
			models = append(models, item.ID)
		}
	}
	return models, nil
}
