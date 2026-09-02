package aiservice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/ai"
	aicontext "GoNavi-Wails/internal/ai/context"
	"GoNavi-Wails/internal/ai/provider"
	"GoNavi-Wails/internal/ai/runharness"
	"GoNavi-Wails/internal/ai/safety"
	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/shared/i18n"

	"github.com/google/uuid"
)

// Service AI 服务，作为 Wails Binding 暴露给前端
type Service struct {
	ctx                context.Context
	mu                 sync.RWMutex
	providers          []ai.ProviderConfig
	activeProvider     string // active provider ID
	safetyLevel        ai.SQLPermissionLevel
	contextLevel       ai.ContextLevel
	userPromptSettings ai.UserPromptSettings
	mcpServers         []ai.MCPServerConfig
	mcpHTTPConfig      ai.MCPHTTPServerConfig
	skills             []ai.SkillConfig
	guard              *safety.Guard
	configDir          string // 配置存储目录
	secretStore        secretstore.SecretStore
	configChanged      func()
	localizer          *i18n.Localizer
	// agentMu protects the lifecycle-owned Harness and Ledger.  The existing
	// mu guards persisted AI configuration; keeping these locks separate means
	// a provider resolver can read configuration while a run is being closed.
	agentMu      sync.RWMutex
	agentContext context.Context
	agentHarness *runharness.AgentRunHarness
	agentLedger  *runharness.Ledger
	// agentPendingWorkspaceSnapshots keeps desktop/CLI context in memory while
	// the encrypted ledger is still unopened. Publishing workspace context is a
	// startup concern; it must not force an OS keyring access before the user
	// actually uses an Agent feature.
	agentPendingWorkspaceSnapshots map[string]runharness.WorkspaceSnapshot
	agentToolCatalog               runharness.ToolCatalog
	agentApprovalHandler           runharness.ApprovalHandler
	agentHarnessInitialized        bool
	agentHarnessInitialization     error
	agentHarnessShutdown           bool
	agentPolicyMu                  sync.Mutex
	// agentPolicyWatcherMu protects the lifecycle of the lightweight file
	// watcher that keeps an already-running desktop Harness in sync with policy
	// changes made by the standalone CLI or another process.
	agentPolicyWatcherMu     sync.Mutex
	agentPolicyWatcherCancel context.CancelFunc
	agentPolicyWatcherDone   chan struct{}
	mcpHTTPOpMu              sync.Mutex
	mcpHTTPStartMu           sync.Mutex
	mcpHTTPStart             *mcpHTTPStartAttempt
	mcpHTTPMu                sync.Mutex
	mcpHTTP                  *mcpHTTPServerRuntime
	mcpHTTPLast              ai.MCPHTTPServerStatus
}

var miniMaxAnthropicModels = []string{
	"MiniMax-M3",
	"MiniMax-M2.7",
	"MiniMax-M2.7-highspeed",
}

var dashScopeCodingPlanModels = []string{
	"qwen3.5-plus",
	"kimi-k2.5",
	"glm-5",
	"MiniMax-M2.5",
	"qwen3-max-2026-01-23",
	"qwen3-coder-next",
	"qwen3-coder-plus",
	"glm-4.7",
}

const dashScopeCodingPlanAnthropicBaseURL = "https://coding.dashscope.aliyuncs.com/apps/anthropic"

var volcengineCodingPlanAllowedExactModels = []string{
	"auto",
}

var volcengineCodingPlanAllowedModelFamilies = []string{
	"doubao-seed-2.0-code",
	"doubao-seed-2.0-pro",
	"doubao-seed-2.0-lite",
	"doubao-seed-code",
	"minimax-m2.5",
	"glm-4.7",
	"deepseek-v3.2",
	"kimi-k2",
}

const volcengineCodingPlanModelsEmptyKey = "ai_service.backend.error.volcengine_coding_models_empty"
const providerImageFallbackPromptKey = "ai_service.backend.provider.image_fallback_prompt"
const providerImageOmittedNoticeKey = "ai_service.backend.provider.image_omitted_notice"

var claudeCLIHealthCheckFunc = func(config ai.ProviderConfig) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cliProvider, err := provider.NewProvider(config)
	if err != nil {
		return err
	}

	response, err := cliProvider.Chat(ctx, ai.ChatRequest{
		Messages: []ai.Message{
			{Role: "user", Content: "ping"},
		},
		MaxTokens:   1,
		Temperature: 0,
	})
	if err == nil && (response == nil || strings.TrimSpace(response.Content) == "") {
		return fmt.Errorf("CLI returned no model response")
	}
	return err
}

var claudeCLILocalAuthCheckFunc = func(_ ai.ProviderConfig) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return provider.CheckClaudeCLILocalAuth(ctx)
}

var codexCLIHealthCheckFunc = func(config ai.ProviderConfig) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return provider.CheckCodexCLIAuth(ctx)
}

var grokCLIHealthCheckFunc = func(_ ai.ProviderConfig) error {
	return provider.CheckGrokCLIModels(context.Background())
}

var cursorCLIHealthCheckFunc = func(_ ai.ProviderConfig) error {
	return provider.CheckCursorCLIAuth(context.Background())
}

var codebuddyCLIHealthCheckFunc = func(config ai.ProviderConfig) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cliProvider, err := provider.NewProvider(config)
	if err != nil {
		return err
	}

	response, err := cliProvider.Chat(ctx, ai.ChatRequest{
		Messages: []ai.Message{
			{Role: "user", Content: "ping"},
		},
		MaxTokens:   1,
		Temperature: 0,
	})
	if err == nil && (response == nil || strings.TrimSpace(response.Content) == "") {
		return fmt.Errorf("CLI returned no model response")
	}
	return err
}

// NewService 创建 AI Service 实例
func NewService() *Service {
	return NewServiceWithSecretStore(secretstore.NewKeyringStore())
}

// NewServiceWithConfigChangeHandler creates a service that notifies the owner
// after a persisted AI configuration change succeeds.
func NewServiceWithConfigChangeHandler(handler func()) *Service {
	service := NewService()
	service.configChanged = handler
	return service
}

func NewServiceWithSecretStore(store secretstore.SecretStore) *Service {
	if store == nil {
		store = secretstore.NewUnavailableStore("secret store unavailable")
	}
	// 外部客户端探测放在后台预热，避免这 1s 量级的代价落在设置页打开的同步路径上。
	go prewarmLocalCLICommandCache()
	return &Service{
		providers:    make([]ai.ProviderConfig, 0),
		safetyLevel:  ai.PermissionReadOnly,
		contextLevel: ai.ContextSchemaOnly,
		mcpServers:   make([]ai.MCPServerConfig, 0),
		skills:       make([]ai.SkillConfig, 0),
		guard:        safety.NewGuard(ai.PermissionReadOnly),
		secretStore:  store,
		localizer:    newServiceLocalizer(),
	}
}

func newServiceLocalizer() *i18n.Localizer {
	return newServiceLocalizerForLanguage(i18n.LanguageEnUS)
}

func newServiceLocalizerForLanguage(language i18n.Language) *i18n.Localizer {
	localizer, err := i18n.NewLocalizer(language)
	if err != nil {
		logger.Warnf("加载 AI 多语言目录失败：%v", err)
		return nil
	}
	return localizer
}

func (s *Service) AISetLanguage(language string) {
	normalized, ok := i18n.NormalizeLanguage(language)
	if !ok {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.localizer == nil {
		s.localizer = newServiceLocalizer()
	}
	if s.localizer != nil {
		s.localizer.SetLanguage(normalized)
	}
}

func (s *Service) serviceTextLocked(key string, params map[string]any) string {
	if s.localizer == nil {
		s.localizer = newServiceLocalizer()
	}
	if s.localizer == nil {
		return key
	}
	return s.localizer.T(key, params)
}

func (s *Service) serviceLanguageLocked() i18n.Language {
	if s.localizer == nil {
		return i18n.LanguageEnUS
	}
	return s.localizer.Language()
}

func (s *Service) serviceLocalizerForLanguageLocked() *i18n.Localizer {
	return newServiceLocalizerForLanguage(s.serviceLanguageLocked())
}

func (s *Service) serviceLocalizerForLanguage() *i18n.Localizer {
	return newServiceLocalizerForLanguage(s.serviceLanguage())
}

func (s *Service) serviceLanguage() i18n.Language {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.serviceLanguageLocked()
}

func (s *Service) serviceText(key string, params map[string]any) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.serviceTextLocked(key, params)
}

type localizedAIServiceError struct {
	key     string
	message string
	cause   error
}

func (e localizedAIServiceError) Error() string {
	return e.message
}

func (e localizedAIServiceError) Key() string {
	return e.key
}

func (e localizedAIServiceError) Unwrap() error {
	return e.cause
}

func serviceTextWithDetail(params map[string]any, cause error) map[string]any {
	result := make(map[string]any, len(params)+1)
	for key, value := range params {
		result[key] = value
	}
	if cause != nil {
		result["detail"] = cause.Error()
	}
	return result
}

func serviceErrorFromText(key string, text string, cause error) error {
	if cause == nil {
		return nil
	}
	if text == key {
		text = fmt.Sprintf("%s: %s", key, cause.Error())
	}
	return localizedAIServiceError{key: key, message: text, cause: cause}
}

func serviceTextFromLocalizer(localizer *i18n.Localizer, key string, params map[string]any) string {
	if localizer == nil {
		localizer = newServiceLocalizer()
	}
	if localizer == nil {
		return key
	}
	return localizer.T(key, params)
}

func serviceErrorFromLocalizer(localizer *i18n.Localizer, key string, params map[string]any, cause error) error {
	return serviceErrorFromText(key, serviceTextFromLocalizer(localizer, key, serviceTextWithDetail(params, cause)), cause)
}

func (s *Service) serviceErrorLocked(key string, params map[string]any, cause error) error {
	return serviceErrorFromText(key, s.serviceTextLocked(key, serviceTextWithDetail(params, cause)), cause)
}

func (s *Service) serviceError(key string, params map[string]any, cause error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.serviceErrorLocked(key, params, cause)
}

func localizedAIServiceErrorKey(err error) string {
	var localizedErr localizedAIServiceError
	if errors.As(err, &localizedErr) {
		return localizedErr.key
	}
	return ""
}

func (s *Service) providerTestFailedMessage(detail string) string {
	return s.serviceText("ai_service.backend.error.provider_test_failed", map[string]any{"detail": detail})
}

func (s *Service) localizeProviderHealthCheckRequestError(err error) error {
	if err == nil {
		return nil
	}
	message := err.Error()
	switch {
	case strings.HasPrefix(message, "create request failed: "):
		return fmt.Errorf("%s", s.serviceText("ai_service.backend.error.provider_request_create_failed", map[string]any{
			"detail": strings.TrimPrefix(message, "create request failed: "),
		}))
	case strings.HasPrefix(message, "serialize request failed: "):
		return fmt.Errorf("%s", s.serviceText("ai_service.backend.error.provider_request_serialize_failed", map[string]any{
			"detail": strings.TrimPrefix(message, "serialize request failed: "),
		}))
	default:
		return err
	}
}

func trimLocalizedModelListRequestCreateDetail(err error) string {
	if err == nil {
		return ""
	}
	message := strings.TrimSpace(err.Error())
	for _, prefix := range []string{"create request failed: "} {
		if strings.HasPrefix(message, prefix) {
			return strings.TrimPrefix(message, prefix)
		}
	}
	return message
}

func localizeModelListRequestCreateError(localizer *i18n.Localizer, err error) error {
	if err == nil {
		return nil
	}
	key := "ai_service.backend.error.models_request_create_failed"
	text := serviceTextFromLocalizer(localizer, key, map[string]any{
		"detail": trimLocalizedModelListRequestCreateDetail(err),
	})
	return serviceErrorFromText(key, text, err)
}

func localizeModelListRequestError(localizer *i18n.Localizer, err error) error {
	return serviceErrorFromLocalizer(localizer, "ai_service.backend.error.models_request_failed", nil, err)
}

func localizeModelListHTTPStatusError(localizer *i18n.Localizer, status int, body []byte) error {
	return fmt.Errorf("%s", serviceTextFromLocalizer(localizer, "ai_service.backend.error.models_http_status_failed", map[string]any{
		"status": status,
		"body":   formatProviderHTTPBody(body),
	}))
}

func localizeModelListParseError(localizer *i18n.Localizer, err error) error {
	return serviceErrorFromLocalizer(localizer, "ai_service.backend.error.models_parse_failed", nil, err)
}

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
	// Opening the encrypted Agent ledger reads its Keychain key. Defer that
	// operation until an Agent API is actually used, rather than prompting on
	// every desktop startup or Wails development rebuild.
	s.restoreMCPHTTPServer()
	logger.Infof("AI Service 启动完成，已加载 %d 个 Provider", len(s.providers))
}

// --- Provider 管理 ---

// AIGetProviders 获取所有 Provider 配置
func (s *Service) AIGetProviders() []ai.ProviderConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]ai.ProviderConfig, len(s.providers))
	for i := range s.providers {
		result[i] = providerMetadataView(s.providers[i])
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
	if err := s.validateProviderModelPreferencesLocked(config); err != nil {
		return err
	}
	if err := validateSubscriptionCLIProviderAuth(config); err != nil {
		return err
	}
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
	var runtimeConfig ai.ProviderConfig
	switch {
	case bundle.hasAny():
		mergedBundle := bundle
		if found && existing.HasSecret {
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
	case found && !localCLIAuth && (config.HasSecret || existing.HasSecret):
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

// AITestProvider 返回实际执行的检查范围。订阅 CLI 不发送聊天消息；
// 其他兼容路径可能发送最小探测请求，只有读到模型回复才标记 modelVerified。
func (s *Service) AITestProvider(config ai.ProviderConfig) map[string]interface{} {
	localCLIAuth := isLocalCLIAuthProvider(config)
	if localCLIAuth {
		config = clearLocalCLIProviderSecrets(config)
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
		if authErr := validateSubscriptionCLIProviderAuth(config); authErr != nil {
			err = authErr
		} else {
			err = codexCLIHealthCheckFunc(config)
		}
	case "codebuddy-cli":
		checkKind = "model-response"
		err = codebuddyCLIHealthCheckFunc(config)
	case "grok-cli":
		checkKind = "model-list"
		if authErr := validateSubscriptionCLIProviderAuth(config); authErr != nil {
			err = authErr
		} else {
			err = grokCLIHealthCheckFunc(config)
		}
	case "cursor-cli":
		checkKind = "local-auth"
		if authErr := validateSubscriptionCLIProviderAuth(config); authErr != nil {
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

func validateSubscriptionCLIProviderAuth(config ai.ProviderConfig) error {
	format := strings.ToLower(strings.TrimSpace(config.APIFormat))
	if format != "codex-cli" && format != "grok-cli" && format != "cursor-cli" {
		return nil
	}
	if !isLocalCLIAuthProvider(config) {
		return fmt.Errorf("%s provider requires its Subscription preset with local-cli authentication", format)
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
	return config
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
		config.ThinkingIntensity = intensity
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
		if isDashScopeBailianAnthropicProvider(config) {
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
	provider.ApplyAnthropicAuthHeaders(req.Header, config.BaseURL, config.APIKey)
	for k, v := range config.Headers {
		req.Header.Set(k, v)
	}
	return req, nil
}

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

// AIListModels 获取当前活跃 Provider 的可用模型列表
func (s *Service) AIListModels() map[string]interface{} {
	s.mu.RLock()
	var config ai.ProviderConfig
	found := false
	localizer := s.serviceLocalizerForLanguageLocked()
	for _, p := range s.providers {
		if p.ID == s.activeProvider {
			config = p
			found = true
			break
		}
	}
	s.mu.RUnlock()

	if !found {
		return map[string]interface{}{
			"success": false,
			"models":  []string{},
			"error":   serviceTextFromLocalizer(localizer, "ai_service.backend.error.active_provider_not_found", nil),
		}
	}

	config = normalizeProviderConfig(config)
	if isLocalCLIAuthProvider(config) || normalizedProviderType(config) == "codebuddy-cli" {
		return map[string]interface{}{
			"success": true,
			"models":  selectableProviderModels(config, config.Models),
			"source":  "static",
		}
	}
	if staticModels := defaultStaticModelsForProvider(config); len(staticModels) > 0 {
		return map[string]interface{}{"success": true, "models": selectableProviderModels(config, staticModels), "source": "static"}
	}

	models, err := fetchModelsFunc(config, localizer)
	if err != nil {
		// 回退到配置中的静态模型列表
		if len(config.Models) > 0 || len(config.CustomModels) > 0 {
			return map[string]interface{}{"success": true, "models": selectableProviderModels(config, config.Models), "source": "static"}
		}
		return map[string]interface{}{"success": false, "models": []string{}, "error": err.Error()}
	}

	models, err = filterFetchedModelsForProvider(config, models, localizer)
	if err != nil {
		return map[string]interface{}{"success": false, "models": []string{}, "error": err.Error()}
	}

	return map[string]interface{}{"success": true, "models": selectableProviderModels(config, models), "source": "api"}
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

// --- 安全控制 ---

// AIGetSafetyLevel 获取当前安全级别
func (s *Service) AIGetSafetyLevel() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return string(s.safetyLevel)
}

// AISetSafetyLevel 设置安全级别
func (s *Service) AISetSafetyLevel(level string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	switch ai.SQLPermissionLevel(level) {
	case ai.PermissionReadOnly, ai.PermissionReadWrite, ai.PermissionFull:
		s.safetyLevel = ai.SQLPermissionLevel(level)
	default:
		s.safetyLevel = ai.PermissionReadOnly
	}
	s.guard.SetPermissionLevel(s.safetyLevel)
	_ = s.saveConfig()
}

// --- 上下文控制 ---

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
func (s *Service) AIGetCLIModelCatalog(apiFormat string) (map[string]interface{}, error) {
	catalog := provider.CLIModelCatalog{Models: []string{}, Source: "none"}
	capability, ok := provider.LookupCLICapability(apiFormat)
	var err error
	if ok {
		catalog, err = capability.ModelCatalog(context.Background())
	}
	return map[string]interface{}{"models": catalog.Models, "source": catalog.Source, "stale": catalog.Stale}, err
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

// --- 内部方法 ---

func (s *Service) getActiveProvider() (provider.Provider, error) {
	p, _, err := s.getActiveProviderRuntime()
	if err != nil && localizedAIServiceErrorKey(err) == "ai_service.backend.error.provider_not_configured" {
		return nil, err
	}
	return p, err
}

func (s *Service) getActiveProviderRuntime() (provider.Provider, ai.ProviderConfig, error) {
	return s.getActiveProviderRuntimeWithOptions(ai.ChatSendOptions{})
}

func (s *Service) getActiveProviderRuntimeWithOptions(options ai.ChatSendOptions) (provider.Provider, ai.ProviderConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	localizer := s.serviceLocalizerForLanguageLocked()

	if s.activeProvider == "" && len(s.providers) > 0 {
		s.activeProvider = s.providers[0].ID
	}

	for _, cfg := range s.providers {
		if cfg.ID == s.activeProvider {
			normalized := normalizeProviderConfig(applyChatSendOptionsToProviderConfig(cfg, options))
			p, err := provider.NewProvider(normalized)
			return p, normalized, err
		}
	}

	return nil, ai.ProviderConfig{}, localizedAIServiceError{
		key:     "ai_service.backend.error.provider_not_configured",
		message: serviceTextFromLocalizer(localizer, "ai_service.backend.error.provider_not_configured", nil),
	}
}

// --- 配置持久化 ---

func (s *Service) loadConfig() {
	snapshot, err := NewProviderConfigStoreWithLanguage(s.configDir, s.secretStore, s.serviceLanguage()).Load()
	if err != nil {
		logger.Error(err, "加载 AI 配置失败")
		return
	}

	s.providers = snapshot.Providers
	s.activeProvider = snapshot.ActiveProvider
	s.safetyLevel = snapshot.SafetyLevel
	s.guard.SetPermissionLevel(s.safetyLevel)
	s.contextLevel = snapshot.ContextLevel
	s.userPromptSettings = snapshot.UserPromptSettings
	s.mcpServers = normalizeMCPServerConfigs(snapshot.MCPServers)
	s.mcpHTTPConfig = normalizeMCPHTTPServerConfig(snapshot.MCPHTTPServer)
	s.skills = normalizeSkillConfigs(snapshot.Skills, s.serviceLocalizerForLanguage())

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

// --- 工具函数 ---

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
