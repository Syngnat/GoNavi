package aiservice

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/logger"

	"github.com/google/uuid"
)

// InitializeLifecycle attaches runtime context without exposing lifecycle internals to Wails bindings.
func InitializeLifecycle(s *Service, ctx context.Context) {
	s.startup(ctx)
}

// startup Wails 生命周期回调
func (s *Service) startup(ctx context.Context) {
	lifecycleCtx := ctx
	if ctx == nil {
		ctx = context.Background()
	}
	s.ctx = ctx
	if lifecycleCtx != nil {
		s.agentMu.Lock()
		if s.agentContext == nil {
			s.agentContext = lifecycleCtx
		}
		s.agentMu.Unlock()
	}
	s.configDir = resolveConfigDir()
	s.loadConfig()
	if lifecycleCtx == nil {
		logger.Warnf("未提供应用生命周期上下文，AI Agent Run Harness 未启动")
	}
	// Agent ledger initialization is deferred until an Agent API is used. Its
	// encryption key is a local private file, so this startup path never accesses
	// the system keychain or prompts during Wails development rebuilds.
	s.restoreMCPHTTPServer()
	logger.Infof("AI Service 启动完成，已加载 %d 个 Provider", len(s.providers))
}

// AIGetProviders 获取所有 Provider 配置
func (s *Service) AIGetProviders() []ai.ProviderConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]ai.ProviderConfig, len(s.providers))
	for i := range s.providers {
		result[i] = s.builtinProviderMetadata(providerMetadataView(s.providers[i]))
	}
	return result
}

// AIGetEditableProvider 获取用于编辑的 Provider 配置，包含已解析的 secret
func (s *Service) AIGetEditableProvider(id string) (ai.ProviderConfig, error) {
	s.mu.RLock()
	var found ai.ProviderConfig
	for _, providerConfig := range s.providers {
		if providerConfig.ID != id {
			continue
		}
		found = providerConfig
		break
	}
	s.mu.RUnlock()

	if strings.TrimSpace(found.ID) != "" {
		if isBuiltinAIProviderConfig(found) {
			return s.builtinProviderMetadata(found), nil
		}
		resolved, err := s.resolveProviderConfigSecrets(found)
		if err != nil {
			return ai.ProviderConfig{}, s.serviceError("ai_service.backend.error.provider_secret_read_failed", nil, err)
		}
		return resolved, nil
	}

	return ai.ProviderConfig{}, s.serviceError("ai_service.backend.error.editable_provider_not_found", nil, fmt.Errorf("%s", id))
}

// AISaveProvider 保存/更新 Provider 配置
func (s *Service) AISaveProvider(config ai.ProviderConfig) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	config = normalizeProviderConfig(config)
	if isBuiltinAIProviderConfig(config) {
		// Built-in credentials live in the account store, never in a provider record.
		return s.saveBuiltinAIProviderLocked(config)
	}
	if err := s.validateProviderModelPreferencesLocked(config); err != nil {
		return err
	}
	if err := validateLocalCLIProviderAuthMode(config); err != nil {
		return err
	}
	// These fields belonged to controls removed from the provider editor. Clear
	// them at the service boundary as well, so stale or older clients cannot keep
	// hidden values alive in memory or on disk.
	config = clearRemovedProviderEditorFields(config)
	localCLIAuth := isLocalCLIAuthProvider(config)
	if localCLIAuth {
		config = clearLocalCLIProviderSecrets(config)
	}
	if strings.TrimSpace(config.ID) == "" {
		config.ID = "provider-" + uuid.New().String()[:8]
	}

	var existing ai.ProviderConfig
	found := false
	for _, providerConfig := range s.providers {
		if providerConfig.ID == config.ID {
			existing = providerConfig
			found = true
			break
		}
	}

	// Keep historical duplicates editable, but do not add another integration
	// or convert an unrelated provider into a CLI already present on this host.
	identity := singletonCLIProviderIdentity(config)
	if identity != "" && (!found || singletonCLIProviderIdentity(existing) != identity) {
		for _, providerConfig := range s.providers {
			if providerConfig.ID != config.ID && singletonCLIProviderIdentity(providerConfig) == identity {
				return s.serviceErrorLocked("ai_service.backend.error.provider_cli_already_configured", nil, errors.New("CLI integration already configured"))
			}
		}
	}

	meta, bundle := splitProviderSecrets(config)
	preserveExistingSecrets := found && ((!localCLIAuth && !isLocalCLIAuthProvider(existing)) ||
		(localCLIAuth && singletonCLIProviderIdentity(existing) == singletonCLIProviderIdentity(config)))
	var runtimeConfig ai.ProviderConfig
	switch {
	case bundle.hasAny():
		mergedBundle := bundle
		if preserveExistingSecrets && existing.HasSecret {
			_, existingBundle := splitProviderSecrets(existing)
			mergedBundle = mergeProviderSecretBundles(existingBundle, bundle)
		}
		if found && strings.TrimSpace(meta.SecretRef) == "" {
			meta.SecretRef = existing.SecretRef
		}
		storedMeta, err := s.persistProviderSecretBundle(meta, mergedBundle)
		if err != nil {
			return s.serviceErrorLocked("ai_service.backend.error.provider_secret_save_failed", nil, err)
		}
		runtimeConfig = mergeProviderSecrets(storedMeta, mergedBundle)
	case preserveExistingSecrets && (config.HasSecret || existing.HasSecret):
		meta.SecretRef = existing.SecretRef
		meta.HasSecret = config.HasSecret || existing.HasSecret
		meta, existingBundle := applyExistingRuntimeProviderSecrets(meta, existing)
		if existingBundle.hasAny() {
			runtimeConfig = mergeProviderSecrets(meta, existingBundle)
		} else {
			resolved, err := s.resolveProviderConfigSecretsLocked(meta)
			if err != nil {
				return s.serviceErrorLocked("ai_service.backend.error.provider_secret_saved_read_failed", nil, err)
			}
			runtimeConfig = resolved
		}
	default:
		runtimeConfig = meta
	}

	if !runtimeConfig.HasSecret && found {
		if err := s.dailySecretStore().DeleteAIProvider(existing.ID); err != nil {
			return s.serviceErrorLocked("ai_service.backend.error.provider_secret_delete_failed", nil, err)
		}
	}
	if !runtimeConfig.HasSecret {
		runtimeConfig.SecretRef = ""
	}

	runtimeConfig = normalizeProviderConfig(runtimeConfig)
	previousProviders := append([]ai.ProviderConfig(nil), s.providers...)
	if found {
		for i := range s.providers {
			if s.providers[i].ID == runtimeConfig.ID {
				s.providers[i] = runtimeConfig
				break
			}
		}
	} else {
		s.providers = append(s.providers, runtimeConfig)
	}

	if err := s.saveConfig(); err != nil {
		s.providers = previousProviders
		return err
	}
	return nil
}

// AIDeleteProvider 删除 Provider
func (s *Service) AIDeleteProvider(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	newProviders := make([]ai.ProviderConfig, 0, len(s.providers))
	var removed ai.ProviderConfig
	removedFound := false
	for _, providerConfig := range s.providers {
		if providerConfig.ID == id {
			removed = providerConfig
			removedFound = true
			continue
		}
		newProviders = append(newProviders, providerConfig)
	}
	if removedFound && strings.TrimSpace(removed.SecretRef) != "" {
		if err := s.secretStore.Delete(removed.SecretRef); err != nil {
			return s.serviceErrorLocked("ai_service.backend.error.provider_secret_delete_failed", nil, err)
		}
	}
	s.providers = newProviders

	if s.activeProvider == id {
		s.activeProvider = ""
		if len(s.providers) > 0 {
			s.activeProvider = s.providers[0].ID
		}
	}

	return s.saveConfig()
}

// AITestProvider 返回实际执行的检查范围。本机认证 CLI 不发送聊天消息；
// 其他兼容路径可能发送最小探测请求，只有读到模型回复才标记 modelVerified。
func (s *Service) AITestProvider(config ai.ProviderConfig) map[string]interface{} {
	if isBuiltinAIProviderConfig(config) {
		return s.testBuiltinAIProvider()
	}
	localCLIAuth := isLocalCLIAuthProvider(config)
	if localCLIAuth {
		config = clearLocalCLIProviderSecrets(config)
		config = s.applyStoredLocalCLIExecutionConfig(config)
	} else if isMaskedAPIKey(config.APIKey) {
		config.APIKey = ""
		config.HasSecret = true
	}
	if !localCLIAuth && strings.TrimSpace(config.APIKey) == "" && (config.HasSecret || strings.TrimSpace(config.SecretRef) != "") {
		s.mu.RLock()
		var existing ai.ProviderConfig
		found := false
		if strings.TrimSpace(config.SecretRef) == "" {
			for _, providerConfig := range s.providers {
				if providerConfig.ID == config.ID {
					existing = providerConfig
					found = true
					config.SecretRef = providerConfig.SecretRef
					config.HasSecret = config.HasSecret || providerConfig.HasSecret
					break
				}
			}
		} else {
			for _, providerConfig := range s.providers {
				if providerConfig.ID == config.ID {
					existing = providerConfig
					found = true
					break
				}
			}
		}
		s.mu.RUnlock()

		if found {
			var existingBundle providerSecretBundle
			config, existingBundle = applyExistingRuntimeProviderSecrets(config, existing)
			if existingBundle.hasAny() {
				config = mergeProviderSecrets(config, existingBundle)
			} else {
				resolved, err := s.resolveProviderConfigSecrets(config)
				if err != nil {
					return s.providerTestResult("none", err)
				}
				config = resolved
			}
		} else {
			resolved, err := s.resolveProviderConfigSecrets(config)
			if err != nil {
				return s.providerTestResult("none", err)
			}
			config = resolved
		}
	}

	config = normalizeProviderConfig(config)
	providerType := normalizedProviderType(config)

	client := &http.Client{Timeout: 10 * time.Second}
	var err error
	checkKind := "none"

	switch providerType {
	case "openai", "anthropic", "gemini", "cursor-agent":
		checkKind = "endpoint"
		req, reqErr := newProviderHealthCheckRequest(config)
		if reqErr != nil {
			err = s.localizeProviderHealthCheckRequestError(reqErr)
			break
		}
		resp, reqErr := client.Do(req)
		if reqErr != nil {
			err = reqErr
		} else {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
				err = fmt.Errorf("%s", s.serviceText("ai_service.backend.error.provider_auth_failed", map[string]any{
					"status": resp.StatusCode,
					"body":   "",
				}))
			} else if providerType == "gemini" && resp.StatusCode == http.StatusBadRequest {
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
				err = fmt.Errorf("%s", s.serviceText("ai_service.backend.error.provider_auth_failed", map[string]any{
					"status": resp.StatusCode,
					"body":   formatProviderHTTPBody(body),
				}))
			} else if resp.StatusCode >= 500 {
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
				err = fmt.Errorf("%s", s.serviceText("ai_service.backend.error.provider_http_server_error", map[string]any{
					"status": resp.StatusCode,
					"body":   formatProviderHTTPBody(body),
				}))
			} else if resp.StatusCode >= 400 {
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
				err = fmt.Errorf("%s", s.serviceText("ai_service.backend.error.provider_http_status_failed", map[string]any{
					"status": resp.StatusCode,
					"body":   formatProviderHTTPBody(body),
				}))
			}
		}
	case "claude-cli":
		if isLocalCLIAuthProvider(config) {
			checkKind = "local-auth"
			err = claudeCLILocalAuthCheckFunc(config)
		} else {
			checkKind = "model-response"
			testConfig := config
			if strings.TrimSpace(testConfig.Model) == "" && isDashScopeCodingPlanProvider(testConfig) && len(dashScopeCodingPlanModels) > 0 {
				testConfig.Model = dashScopeCodingPlanModels[0]
			}
			err = claudeCLIHealthCheckFunc(testConfig)
		}
	case "codex-cli":
		checkKind = "local-auth"
		if authErr := validateLocalCLIProviderAuthMode(config); authErr != nil {
			err = authErr
		} else {
			err = codexCLIHealthCheckFunc(config)
		}
	case "codebuddy-cli":
		checkKind = "model-response"
		err = codebuddyCLIHealthCheckFunc(config)
	case "grok-cli":
		checkKind = "model-list"
		if authErr := validateLocalCLIProviderAuthMode(config); authErr != nil {
			err = authErr
		} else {
			err = grokCLIHealthCheckFunc(config)
		}
	case "cursor-cli":
		checkKind = "local-auth"
		if authErr := validateLocalCLIProviderAuthMode(config); authErr != nil {
			err = authErr
		} else {
			err = cursorCLIHealthCheckFunc(config)
		}
	default:
		err = s.serviceError("ai_service.backend.error.provider_test_unsupported", map[string]any{"protocol": providerType}, errors.New("unsupported protocol"))
	}

	return s.providerTestResult(checkKind, err)
}

func (s *Service) providerTestResult(checkKind string, err error) map[string]interface{} {
	if checkKind == "none" && err == nil {
		err = s.serviceError("ai_service.backend.error.provider_test_unsupported", map[string]any{"protocol": ""}, errors.New("no check executed"))
	}
	result := map[string]interface{}{
		"success":       err == nil,
		"checkKind":     checkKind,
		"modelVerified": err == nil && checkKind == "model-response",
	}
	if err != nil {
		result["message"] = s.providerTestFailedMessage(err.Error())
		return result
	}
	messageKey := "ai_service.backend.message.provider_test_success"
	switch checkKind {
	case "local-auth":
		messageKey = "ai_service.backend.message.provider_test_local_auth_success"
	case "model-list":
		messageKey = "ai_service.backend.message.provider_test_models_success"
	case "model-response":
		messageKey = "ai_service.backend.message.provider_test_response_success"
	}
	result["message"] = s.serviceText(messageKey, nil)
	return result
}
