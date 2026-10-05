package aiservice

import (
	"fmt"
	"net/url"
	"strings"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
	"GoNavi-Wails/shared/i18n"
)

func formatProviderHTTPBody(body []byte) string {
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" {
		return ""
	}
	return ": " + trimmed
}

func normalizedProviderType(config ai.ProviderConfig) string {
	providerType := strings.ToLower(strings.TrimSpace(config.Type))
	// Older custom API configurations omit apiFormat. The request provider
	// already treats that as OpenAI; checks and catalogs must use the same default.
	// An explicit unknown protocol (or an incomplete CLI record) still fails closed.
	if providerType == "custom" && strings.TrimSpace(config.APIFormat) == "" && !strings.EqualFold(strings.TrimSpace(config.AuthMode), "local-cli") {
		return "openai"
	}
	if providerType == "custom" && strings.TrimSpace(config.APIFormat) != "" {
		apiFormat := strings.ToLower(strings.TrimSpace(config.APIFormat))
		if apiFormat == "openai-responses" {
			return "openai"
		}
		return apiFormat
	}
	return providerType
}

func isLocalCLIAuthProvider(config ai.ProviderConfig) bool {
	if !strings.EqualFold(strings.TrimSpace(config.AuthMode), "local-cli") {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(config.Type), "custom") {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(config.APIFormat)) {
	case "codex-cli", "claude-cli", "grok-cli", "cursor-cli":
		return true
	default:
		return false
	}
}

func singletonCLIProviderIdentity(config ai.ProviderConfig) string {
	if normalizedProviderType(config) == "codebuddy-cli" {
		return "codebuddy-cli"
	}
	if isLocalCLIAuthProvider(config) {
		return strings.ToLower(strings.TrimSpace(config.APIFormat))
	}
	return ""
}

func validateLocalCLIProviderAuthMode(config ai.ProviderConfig) error {
	format := strings.ToLower(strings.TrimSpace(config.APIFormat))
	if format != "codex-cli" && format != "grok-cli" && format != "cursor-cli" {
		return nil
	}
	if !isLocalCLIAuthProvider(config) {
		return fmt.Errorf("%s provider requires local-cli authentication; the CLI may use OAuth or an API key", format)
	}
	return nil
}

func clearLocalCLIProviderSecrets(config ai.ProviderConfig) ai.ProviderConfig {
	config.APIKey = ""
	config.SecretRef = ""
	config.HasSecret = false
	config.BaseURL = ""
	config.Headers = nil
	return config
}

// applyStoredLocalCLIExecutionConfig restores the hidden CLI environment when
// a public, secretless provider view is submitted back by the settings UI.
// Direct-provider fields stay cleared; CLI-owned OAuth and API-key credentials
// remain available through the CLI's own store or its preserved CLIEnv.
func (s *Service) applyStoredLocalCLIExecutionConfig(config ai.ProviderConfig) ai.ProviderConfig {
	if !isLocalCLIAuthProvider(config) || len(config.CLIEnv) > 0 || strings.TrimSpace(config.ID) == "" {
		config.CLIEnv = cloneStringMap(config.CLIEnv)
		return config
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, existing := range s.providers {
		if existing.ID == config.ID && singletonCLIProviderIdentity(existing) == singletonCLIProviderIdentity(config) {
			config.CLIEnv = cloneStringMap(existing.CLIEnv)
			break
		}
	}
	return config
}

func isMiniMaxAnthropicProvider(config ai.ProviderConfig) bool {
	if normalizedProviderType(config) != "anthropic" {
		return false
	}
	baseURL := strings.ToLower(strings.TrimRight(strings.TrimSpace(config.BaseURL), "/"))
	return strings.Contains(baseURL, "api.minimax.io") || strings.Contains(baseURL, "api.minimaxi.com")
}

func isMoonshotAnthropicProvider(config ai.ProviderConfig) bool {
	if normalizedProviderType(config) != "anthropic" {
		return false
	}
	baseURL := strings.ToLower(strings.TrimRight(strings.TrimSpace(config.BaseURL), "/"))
	return strings.Contains(baseURL, "api.moonshot.cn")
}

func parseProviderBaseURL(raw string) (string, string) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", ""
	}
	return strings.ToLower(parsed.Hostname()), strings.TrimRight(strings.ToLower(parsed.Path), "/")
}

func isDashScopeBailianAnthropicProvider(config ai.ProviderConfig) bool {
	if normalizedProviderType(config) != "anthropic" {
		return false
	}
	host, path := parseProviderBaseURL(config.BaseURL)
	return host == "dashscope.aliyuncs.com" && strings.HasPrefix(path, "/apps/anthropic")
}

func isDashScopeCodingPlanAnthropicProvider(config ai.ProviderConfig) bool {
	if normalizedProviderType(config) != "anthropic" {
		return false
	}
	return isDashScopeCodingPlanProvider(config)
}

func isDashScopeCodingPlanProvider(config ai.ProviderConfig) bool {
	host, path := parseProviderBaseURL(config.BaseURL)
	return host == "coding.dashscope.aliyuncs.com" && (strings.HasPrefix(path, "/apps/anthropic") || strings.HasPrefix(path, "/v1"))
}

func isVolcengineCodingPlanProvider(config ai.ProviderConfig) bool {
	if normalizedProviderType(config) != "openai" {
		return false
	}
	host, path := parseProviderBaseURL(provider.NormalizeOpenAICompatibleBaseURL(config.BaseURL))
	return host == "ark.cn-beijing.volces.com" && path == "/api/coding/v3"
}

func filterVolcengineCodingPlanModels(models []string) []string {
	filtered := make([]string, 0, len(models))
	for _, model := range models {
		lowerModel := strings.ToLower(strings.TrimSpace(model))
		matched := false
		for _, exactModel := range volcengineCodingPlanAllowedExactModels {
			if lowerModel == exactModel {
				filtered = append(filtered, model)
				matched = true
				break
			}
		}
		if matched {
			continue
		}
		for _, family := range volcengineCodingPlanAllowedModelFamilies {
			if strings.Contains(lowerModel, family) {
				filtered = append(filtered, model)
				break
			}
		}
	}
	return filtered
}

func filterFetchedModelsForProvider(config ai.ProviderConfig, models []string, localizer *i18n.Localizer) ([]string, error) {
	if !isVolcengineCodingPlanProvider(config) {
		return models, nil
	}
	filtered := filterVolcengineCodingPlanModels(models)
	if len(filtered) == 0 {
		return nil, fmt.Errorf("%s", serviceTextFromLocalizer(localizer, volcengineCodingPlanModelsEmptyKey, nil))
	}
	return filtered, nil
}

func defaultStaticModelsForProvider(config ai.ProviderConfig) []string {
	if normalizedProviderType(config) == "codebuddy-cli" {
		return append([]string(nil), config.Models...)
	}
	if isMiniMaxAnthropicProvider(config) {
		return append([]string(nil), miniMaxAnthropicModels...)
	}
	if isDashScopeCodingPlanProvider(config) {
		return append([]string(nil), dashScopeCodingPlanModels...)
	}
	return nil
}

func normalizeProviderConfig(config ai.ProviderConfig) ai.ProviderConfig {
	config.AuthMode = strings.ToLower(strings.TrimSpace(config.AuthMode))
	switch {
	case isDeepSeekResponsesProvider(config):
		config.Type = "openai"
		config.APIFormat = "openai-responses"
		config.BaseURL = normalizeDeepSeekResponsesBaseURL(config.BaseURL)
	case isDeepSeekProvider(config):
		config.Type = "openai"
		config.APIFormat = strings.ToLower(strings.TrimSpace(config.APIFormat))
		config.BaseURL = provider.NormalizeOpenAICompatibleBaseURL(config.BaseURL)
	case isDashScopeBailianAnthropicProvider(config):
		config.Models = nil
	case isDashScopeCodingPlanProvider(config):
		config.Type = "custom"
		config.APIFormat = "claude-cli"
		config.BaseURL = dashScopeCodingPlanAnthropicBaseURL
		config.Models = append([]string(nil), dashScopeCodingPlanModels...)
	default:
		staticModels := defaultStaticModelsForProvider(config)
		if len(staticModels) > 0 && len(config.Models) == 0 {
			config.Models = staticModels
		}
	}

	model := strings.TrimSpace(config.Model)
	if isMiniMaxAnthropicProvider(config) && (model == "" || strings.HasPrefix(strings.ToLower(model), "minimax-text-")) {
		config.Model = miniMaxAnthropicModels[0]
	}
	// 三个模型名单（删除 / 停用 / 自定义）在这里统一收敛，保存在任何入口都一致。
	return normalizeProviderModelPreferences(config)
}

func isDeepSeekResponsesProvider(config ai.ProviderConfig) bool {
	if !isDeepSeekProvider(config) {
		return false
	}
	apiFormat := strings.ToLower(strings.TrimSpace(config.APIFormat))
	if apiFormat == "openai-responses" {
		return true
	}
	model := strings.ToLower(strings.TrimSpace(config.Model))
	return apiFormat == "" && model == "deepseek-v4-flash"
}

func isDeepSeekProvider(config ai.ProviderConfig) bool {
	if !strings.EqualFold(strings.TrimSpace(config.Type), "openai") {
		return false
	}
	host, _ := parseProviderBaseURL(config.BaseURL)
	return host == "api.deepseek.com"
}

func normalizeDeepSeekResponsesBaseURL(baseURL string) string {
	normalized := provider.NormalizeOpenAICompatibleBaseURL(baseURL)
	if host, _ := parseProviderBaseURL(normalized); host == "api.deepseek.com" {
		return strings.TrimSuffix(normalized, "/v1")
	}
	return strings.TrimRight(strings.TrimSpace(baseURL), "/")
}

func applyChatSendOptionsToProviderConfig(config ai.ProviderConfig, options ai.ChatSendOptions) ai.ProviderConfig {
	if model := strings.TrimSpace(options.Model); model != "" {
		config.Model = model
	}
	// 思考强度以聊天面板/会话级覆盖为准，不回写供应商配置。
	if intensity := strings.TrimSpace(options.ThinkingIntensity); intensity != "" {
		if isLocalCLIAuthProvider(config) {
			switch strings.ToLower(intensity) {
			case "off", "none", "disabled", "default":
				config.Effort = ""
			default:
				config.Effort = intensity
			}
		} else {
			config.ThinkingIntensity = intensity
		}
	}
	return config
}

func normalizeChatSendOptions(options ai.ChatSendOptions) ai.ChatSendOptions {
	options.Model = strings.TrimSpace(options.Model)
	options.ThinkingIntensity = strings.TrimSpace(options.ThinkingIntensity)
	if options.MaxTokens < 0 {
		options.MaxTokens = 0
	}
	if options.Temperature < 0 {
		options.Temperature = 0
	}
	return options
}

func applyExistingRuntimeProviderSecrets(meta ai.ProviderConfig, existing ai.ProviderConfig) (ai.ProviderConfig, providerSecretBundle) {
	existingMeta, existingBundle := splitProviderSecrets(normalizeProviderConfig(existing))
	if strings.TrimSpace(meta.SecretRef) == "" {
		meta.SecretRef = strings.TrimSpace(existingMeta.SecretRef)
	}
	meta.HasSecret = meta.HasSecret || existingMeta.HasSecret || existingBundle.hasAny()
	return meta, existingBundle
}
