package aiservice

import (
	"context"
	"errors"
	"strings"

	"GoNavi-Wails/internal/ai"
	aicontext "GoNavi-Wails/internal/ai/context"
	"GoNavi-Wails/internal/ai/provider"
	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/logger"
)

// AISetActiveProvider 设置活动 Provider
func (s *Service) AISetActiveProvider(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	found := false
	for _, config := range s.providers {
		if config.ID == id && id != "" {
			found = true
			break
		}
	}
	if !found && id == builtinAIProviderID {
		found = s.addBuiltinAIProviderLocked()
	}
	if !found {
		return s.serviceErrorLocked("ai_service.backend.error.active_provider_not_found", nil, errors.New("provider not found"))
	}
	if s.activeProvider == id {
		return nil
	}
	previous := s.activeProvider
	s.activeProvider = id
	if err := s.saveConfig(); err != nil {
		s.activeProvider = previous
		return err
	}
	return nil
}

// AIGetActiveProvider 获取活动 Provider ID
func (s *Service) AIGetActiveProvider() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.activeProvider
}

// AIGetBuiltinPrompts 返回内部置的各类系统提示词，用于前端展示或查询
func (s *Service) AIGetBuiltinPrompts() map[string]string {
	localizer := s.serviceLocalizerForLanguage()
	return aicontext.GetBuiltinPromptsWithTitleLookup(func(key string) string {
		return serviceTextFromLocalizer(localizer, key, nil)
	})
}

// AIGetUserPromptSettings 获取用户级自定义提示词配置
func (s *Service) AIGetUserPromptSettings() ai.UserPromptSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.userPromptSettings
}

// AISaveUserPromptSettings 保存用户级自定义提示词配置
func (s *Service) AISaveUserPromptSettings(settings ai.UserPromptSettings) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.userPromptSettings = normalizeUserPromptSettings(settings)
	return s.saveConfig()
}

// AIGetResultMaskingSettings returns the global rules applied only to built-in
// execute_sql responses.
func (s *Service) AIGetResultMaskingSettings() ai.ResultMaskingSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return ai.NormalizeResultMaskingSettings(s.resultMasking)
}

// AISaveResultMaskingSettings validates and persists the global masking rules.
func (s *Service) AISaveResultMaskingSettings(settings ai.ResultMaskingSettings) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	previous := s.resultMasking
	s.resultMasking = ai.NormalizeResultMaskingSettings(settings)
	if err := s.saveConfig(); err != nil {
		s.resultMasking = previous
		return err
	}
	return nil
}

// AIGetContextLevel 获取上下文传递级别
func (s *Service) AIGetContextLevel() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return string(s.contextLevel)
}

// AIGetCLICapabilities 返回各本机 CLI 的模型/档位能力与预填值，供设置界面渲染。
// 前端据此决定是否显示档位控件、给哪些候选值，以及模型是手填还是可枚举；
// 它不得自己维护一份值域副本——那会随上游 CLI 版本漂移而失真。
func (s *Service) AIGetCLICapabilities() []ai.CLICapabilityView {
	return provider.CLICapabilityViews()
}

// AIGetModelContextProfile 返回模型的默认上下文窗口与可选档位（token）。
// 数值只在 Go 侧的规则表里维护，前端据此显示上限并决定是否出现档位切换。
func (s *Service) AIGetModelContextProfile(config ai.ProviderConfig) ai.ModelContextProfile {
	return ai.ResolveModelContextProfile(config.Model)
}

// AIListCLIModels 保留列表接口；新设置页使用含来源的 AIGetCLIModelCatalog。
func (s *Service) AIListCLIModels(apiFormat string) ([]string, error) {
	capability, ok := provider.LookupCLICapability(apiFormat)
	if !ok {
		return nil, nil
	}
	catalog, err := capability.ModelCatalog(context.Background())
	return catalog.Models, err
}

// AIGetCLIModelCatalog distinguishes documented aliases, local caches, and CLI enumeration.
// Suggestions do not attest to login, entitlement, or a model response.
func (s *Service) AIGetCLIModelCatalog(config ai.ProviderConfig) (map[string]interface{}, error) {
	if isLocalCLIAuthProvider(config) {
		config = s.applyStoredLocalCLIExecutionConfig(clearLocalCLIProviderSecrets(config))
	}
	catalog := provider.CLIModelCatalog{Models: []string{}, Source: "none"}
	capability, ok := provider.LookupCLICapability(config.APIFormat)
	var err error
	if ok {
		catalog, err = capability.ModelCatalogWithConfig(context.Background(), config)
	}
	return cliModelCatalogResponse(catalog), err
}

func cliModelCatalogResponse(catalog provider.CLIModelCatalog) map[string]interface{} {
	models := catalog.Models
	if models == nil {
		models = []string{}
	}
	result := map[string]interface{}{
		"models": models, "source": catalog.Source, "stale": catalog.Stale,
	}
	if catalog.DefaultModel != "" {
		result["defaultModel"] = catalog.DefaultModel
	}
	if len(catalog.ModelCapabilities) > 0 {
		result["modelCapabilities"] = catalog.ModelCapabilities
	}
	return result
}

// AISetContextLevel 设置上下文传递级别
func (s *Service) AISetContextLevel(level string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	switch ai.ContextLevel(level) {
	case ai.ContextSchemaOnly, ai.ContextWithSamples, ai.ContextWithResults:
		s.contextLevel = ai.ContextLevel(level)
	default:
		s.contextLevel = ai.ContextSchemaOnly
	}
	_ = s.saveConfig()
}

// AICheckSQL 检查 SQL 的安全性
func (s *Service) AICheckSQL(sql string) ai.SafetyResult {
	s.mu.RLock()
	result := s.guard.Check(sql)
	localizer := s.serviceLocalizerForLanguageLocked()
	s.mu.RUnlock()

	if result.WarningMessage != "" {
		result.WarningMessage = serviceTextFromLocalizer(localizer, result.WarningMessage, nil)
	}

	return result
}

func (s *Service) getActiveProvider() (provider.Provider, error) {
	p, _, err := s.getActiveProviderRuntime()
	if err != nil && localizedAIServiceErrorKey(err) == "ai_service.backend.error.provider_not_configured" {
		return nil, err
	}
	return p, err
}

func (s *Service) loadConfig() {
	snapshot, err := NewProviderConfigStoreWithLanguage(s.configDir, s.secretStore, s.serviceLanguage()).Load()
	if err != nil {
		logger.Error(err, "加载 AI 配置失败")
		return
	}

	s.providers = snapshot.Providers
	s.activeProvider = snapshot.ActiveProvider
	s.migrateBuiltinAIProviders()
	s.safetyLevel = snapshot.SafetyLevel
	s.guard.SetPermissionLevel(s.safetyLevel)
	s.contextLevel = snapshot.ContextLevel
	s.userPromptSettings = snapshot.UserPromptSettings
	s.mcpServers = normalizeMCPServerConfigs(snapshot.MCPServers)
	s.mcpHTTPConfig = normalizeMCPHTTPServerConfig(snapshot.MCPHTTPServer)
	s.skills = normalizeSkillConfigs(snapshot.Skills, s.serviceLocalizerForLanguage())
	s.resultMasking = ai.NormalizeResultMaskingSettings(snapshot.ResultMasking)

	status := mcpHTTPStatusFromConfig(s.mcpHTTPConfig, s.serviceText("ai_settings.mcp_http.status.not_running", nil))
	s.mcpHTTPMu.Lock()
	if s.mcpHTTP == nil {
		s.mcpHTTPLast = status
	}
	s.mcpHTTPMu.Unlock()
}

func (s *Service) saveConfig() error {
	err := NewProviderConfigStoreWithLanguage(s.configDir, s.secretStore, s.serviceLanguageLocked()).Save(ProviderConfigStoreSnapshot{
		Providers:          s.providers,
		ActiveProvider:     s.activeProvider,
		SafetyLevel:        s.safetyLevel,
		ContextLevel:       s.contextLevel,
		UserPromptSettings: s.userPromptSettings,
		MCPServers:         s.mcpServers,
		MCPHTTPServer:      s.mcpHTTPConfig,
		Skills:             s.skills,
		ResultMasking:      s.resultMasking,
	})
	if err == nil && s.configChanged != nil {
		s.configChanged()
	}
	return err
}

const maxUserPromptChars = 16000

func normalizeUserPromptSettings(settings ai.UserPromptSettings) ai.UserPromptSettings {
	return ai.UserPromptSettings{
		Global:        normalizeUserPromptText(settings.Global),
		Database:      normalizeUserPromptText(settings.Database),
		JVM:           normalizeUserPromptText(settings.JVM),
		JVMDiagnostic: normalizeUserPromptText(settings.JVMDiagnostic),
	}
}

func normalizeUserPromptText(value string) string {
	normalized := strings.ReplaceAll(value, "\r\n", "\n")
	normalized = strings.TrimSpace(normalized)
	if len(normalized) > maxUserPromptChars {
		return normalized[:maxUserPromptChars]
	}
	return normalized
}

func resolveConfigDir() string {
	return appdata.MustResolveActiveRoot()
}

func maskAPIKey(apiKey string) string {
	if len(apiKey) <= 8 {
		return "****"
	}
	return apiKey[:4] + "****" + apiKey[len(apiKey)-4:]
}

func isMaskedAPIKey(apiKey string) bool {
	return strings.Contains(apiKey, "****")
}

func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
