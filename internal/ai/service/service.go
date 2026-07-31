package aiservice

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/ai"
	aicontext "GoNavi-Wails/internal/ai/context"
	"GoNavi-Wails/internal/ai/provider"
	"GoNavi-Wails/internal/ai/safety"
	"GoNavi-Wails/internal/appdata"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/internal/uievents"
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
	streamProducers    map[string]map[*aiStreamProducer]struct{}
	streamHandoffCount int
	sessionProviders   map[string]aiSessionProviderRuntime
	mcpHTTPOpMu        sync.Mutex
	mcpHTTPStartMu     sync.Mutex
	mcpHTTPStart       *mcpHTTPStartAttempt
	mcpHTTPMu          sync.Mutex
	mcpHTTP            *mcpHTTPServerRuntime
	mcpHTTPLast        ai.MCPHTTPServerStatus
}

type aiSessionProviderRuntime struct {
	ProviderKey string
	State       json.RawMessage
	Messages    []ai.Message
}

type aiStreamProducer struct {
	cancel context.CancelFunc
	done   chan struct{}
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

	_, err = cliProvider.Chat(ctx, ai.ChatRequest{
		Messages: []ai.Message{
			{Role: "user", Content: "ping"},
		},
		MaxTokens:   1,
		Temperature: 0,
	})
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

var codebuddyCLIHealthCheckFunc = func(config ai.ProviderConfig) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cliProvider, err := provider.NewProvider(config)
	if err != nil {
		return err
	}

	_, err = cliProvider.Chat(ctx, ai.ChatRequest{
		Messages: []ai.Message{
			{Role: "user", Content: "ping"},
		},
		MaxTokens:   1,
		Temperature: 0,
	})
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
	return &Service{
		providers:        make([]ai.ProviderConfig, 0),
		safetyLevel:      ai.PermissionReadOnly,
		contextLevel:     ai.ContextSchemaOnly,
		mcpServers:       make([]ai.MCPServerConfig, 0),
		skills:           make([]ai.SkillConfig, 0),
		guard:            safety.NewGuard(ai.PermissionReadOnly),
		secretStore:      store,
		localizer:        newServiceLocalizer(),
		streamProducers:  make(map[string]map[*aiStreamProducer]struct{}),
		sessionProviders: make(map[string]aiSessionProviderRuntime),
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
	s.ctx = ctx
	s.configDir = resolveConfigDir()
	s.loadConfig()
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
	if err := validateCodexCLIProviderAuth(config); err != nil {
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

	return s.saveConfig()
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

// AITestProvider 测试 Provider 配置是否可用，仅测试端点连通性与密钥，不实际调用对话
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
			config, existingBundle := applyExistingRuntimeProviderSecrets(config, existing)
			if existingBundle.hasAny() {
				config = mergeProviderSecrets(config, existingBundle)
			} else {
				resolved, err := s.resolveProviderConfigSecrets(config)
				if err != nil {
					return map[string]interface{}{"success": false, "message": s.providerTestFailedMessage(err.Error())}
				}
				config = resolved
			}
		} else {
			resolved, err := s.resolveProviderConfigSecrets(config)
			if err != nil {
				return map[string]interface{}{"success": false, "message": s.providerTestFailedMessage(err.Error())}
			}
			config = resolved
		}
	}

	config = normalizeProviderConfig(config)
	baseURL := strings.TrimRight(strings.TrimSpace(config.BaseURL), "/")
	providerType := normalizedProviderType(config)

	client := &http.Client{Timeout: 10 * time.Second}
	var err error

	switch providerType {
	case "openai", "anthropic", "gemini", "cursor-agent":
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
			err = claudeCLILocalAuthCheckFunc(config)
		} else {
			testConfig := config
			if strings.TrimSpace(testConfig.Model) == "" && isDashScopeCodingPlanProvider(testConfig) && len(dashScopeCodingPlanModels) > 0 {
				testConfig.Model = dashScopeCodingPlanModels[0]
			}
			err = claudeCLIHealthCheckFunc(testConfig)
		}
	case "codex-cli":
		if authErr := validateCodexCLIProviderAuth(config); authErr != nil {
			err = authErr
		} else {
			err = codexCLIHealthCheckFunc(config)
		}
	case "codebuddy-cli":
		err = codebuddyCLIHealthCheckFunc(config)
	default:
		if baseURL != "" {
			req, _ := http.NewRequest("GET", baseURL, nil)
			resp, reqErr := client.Do(req)
			if reqErr != nil {
				err = reqErr
			} else {
				resp.Body.Close()
			}
		}
	}

	if err != nil {
		return map[string]interface{}{"success": false, "message": s.providerTestFailedMessage(err.Error())}
	}

	return map[string]interface{}{
		"success": true,
		"message": s.serviceText("ai_service.backend.message.provider_test_success", nil),
	}
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
	case "codex-cli", "claude-cli":
		return true
	default:
		return false
	}
}

func validateCodexCLIProviderAuth(config ai.ProviderConfig) error {
	if !strings.EqualFold(strings.TrimSpace(config.APIFormat), "codex-cli") {
		return nil
	}
	if !isLocalCLIAuthProvider(config) {
		return fmt.Errorf("Codex CLI provider requires the Codex Subscription preset with local-cli authentication")
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
	case "codex-cli", "codebuddy-cli":
		return ""
	case "openai":
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
func (s *Service) AISetActiveProvider(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.activeProvider = id
	_ = s.saveConfig()
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
			"models":  append([]string(nil), config.Models...),
			"source":  "static",
		}
	}
	if staticModels := defaultStaticModelsForProvider(config); len(staticModels) > 0 {
		return map[string]interface{}{"success": true, "models": staticModels, "source": "static"}
	}

	models, err := fetchModelsFunc(config, localizer)
	if err != nil {
		// 回退到配置中的静态模型列表
		if len(config.Models) > 0 {
			return map[string]interface{}{"success": true, "models": config.Models, "source": "static"}
		}
		return map[string]interface{}{"success": false, "models": []string{}, "error": err.Error()}
	}

	models, err = filterFetchedModelsForProvider(config, models, localizer)
	if err != nil {
		return map[string]interface{}{"success": false, "models": []string{}, "error": err.Error()}
	}

	return map[string]interface{}{"success": true, "models": models, "source": "api"}
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
	case "codex-cli", "codebuddy-cli":
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

// --- AI 对话 ---

// AIChatSend 非流式发送 AI 对话
func (s *Service) AIChatSend(messages []ai.Message, tools []ai.Tool) map[string]interface{} {
	return s.aiChatSend("", messages, tools, false, ai.ChatSendOptions{})
}

// AIChatSendWithOptions 非流式发送 AI 对话，并允许本次调用临时覆盖模型与生成参数。
func (s *Service) AIChatSendWithOptions(messages []ai.Message, tools []ai.Tool, options ai.ChatSendOptions) map[string]interface{} {
	return s.aiChatSend("", messages, tools, false, options)
}

// AIChatSendInSession 非流式发送 AI 对话，并在支持的 Provider 上复用会话态。
func (s *Service) AIChatSendInSession(sessionID string, messages []ai.Message, tools []ai.Tool) map[string]interface{} {
	return s.aiChatSend(sessionID, messages, tools, true, ai.ChatSendOptions{})
}

func (s *Service) aiChatSend(sessionID string, messages []ai.Message, tools []ai.Tool, allowSessionReuse bool, options ai.ChatSendOptions) map[string]interface{} {
	options = normalizeChatSendOptions(options)
	p, config, err := s.getActiveProviderRuntimeWithOptions(options)
	if err != nil {
		logger.Error(err, "AIChatSend 获取 Provider 失败：messages=%d tools=%d", len(messages), len(tools))
		return map[string]interface{}{"success": false, "error": err.Error()}
	}
	imageFallbackPrompt := s.serviceText(providerImageFallbackPromptKey, nil)
	imageOmittedNotice := s.serviceText(providerImageOmittedNoticeKey, nil)

	started := time.Now()
	providerName := p.Name()
	logger.Infof("AIChatSend 开始：sessionID=%s provider=%s messages=%d tools=%d sessionReuse=%t", sessionID, providerName, len(messages), len(tools), allowSessionReuse)
	requestMessages := cloneAIMessages(messages)
	var updatedProviderState json.RawMessage
	if allowSessionReuse && strings.TrimSpace(sessionID) != "" {
		if sessionAwareProvider, ok := p.(provider.SessionChatProvider); ok {
			providerKey := providerSessionKey(config)
			providerState, deltaMessages := s.resolveSessionProviderRequest(sessionID, providerKey, messages)
			requestMessages = deltaMessages
			resp, updatedState, err := sessionAwareProvider.ChatWithState(context.Background(), providerState, ai.ChatRequest{
				Messages:            requestMessages,
				Temperature:         options.Temperature,
				MaxTokens:           options.MaxTokens,
				Tools:               tools,
				ImageFallbackPrompt: imageFallbackPrompt,
				ImageOmittedNotice:  imageOmittedNotice,
			})
			if err != nil {
				logger.Warnf("AIChatSend 失败：sessionID=%s provider=%s messages=%d tools=%d duration=%s err=%s", sessionID, providerName, len(messages), len(tools), time.Since(started).Round(time.Millisecond), provider.RedactAIUpstreamLogText(err.Error()))
				return map[string]interface{}{"success": false, "error": err.Error()}
			}
			updatedProviderState = updatedState
			historyAfterSend := cloneAIMessages(messages)
			if assistantMessage, hasAssistantMessage := buildAssistantMessageFromChatResponse(resp); hasAssistantMessage {
				historyAfterSend = append(historyAfterSend, assistantMessage)
			}
			if persistErr := s.storeSessionProviderRuntime(sessionID, providerKey, updatedProviderState, historyAfterSend); persistErr != nil {
				logger.Warnf("AIChatSend 保存会话 Provider 状态失败：sessionID=%s provider=%s err=%s", sessionID, providerName, provider.RedactAIUpstreamLogText(persistErr.Error()))
			}
			logger.Infof(
				"AIChatSend 完成：sessionID=%s provider=%s messages=%d tools=%d toolCalls=%d promptTokens=%d completionTokens=%d totalTokens=%d duration=%s sessionReuse=%t",
				sessionID,
				providerName,
				len(messages),
				len(tools),
				len(resp.ToolCalls),
				resp.TokensUsed.PromptTokens,
				resp.TokensUsed.CompletionTokens,
				resp.TokensUsed.TotalTokens,
				time.Since(started).Round(time.Millisecond),
				true,
			)
			return map[string]interface{}{
				"success":           true,
				"content":           resp.Content,
				"reasoning_content": resp.ReasoningContent,
				"tool_calls":        resp.ToolCalls,
				"tokensUsed": map[string]int{
					"promptTokens":     resp.TokensUsed.PromptTokens,
					"completionTokens": resp.TokensUsed.CompletionTokens,
					"totalTokens":      resp.TokensUsed.TotalTokens,
				},
			}
		}
	}

	resp, err := p.Chat(context.Background(), ai.ChatRequest{
		Messages:            requestMessages,
		Temperature:         options.Temperature,
		MaxTokens:           options.MaxTokens,
		Tools:               tools,
		ImageFallbackPrompt: imageFallbackPrompt,
		ImageOmittedNotice:  imageOmittedNotice,
	})
	if err != nil {
		logger.Warnf("AIChatSend 失败：sessionID=%s provider=%s messages=%d tools=%d duration=%s err=%s", sessionID, providerName, len(messages), len(tools), time.Since(started).Round(time.Millisecond), provider.RedactAIUpstreamLogText(err.Error()))
		return map[string]interface{}{"success": false, "error": err.Error()}
	}
	logger.Infof(
		"AIChatSend 完成：sessionID=%s provider=%s messages=%d tools=%d toolCalls=%d promptTokens=%d completionTokens=%d totalTokens=%d duration=%s sessionReuse=%t",
		sessionID,
		providerName,
		len(messages),
		len(tools),
		len(resp.ToolCalls),
		resp.TokensUsed.PromptTokens,
		resp.TokensUsed.CompletionTokens,
		resp.TokensUsed.TotalTokens,
		time.Since(started).Round(time.Millisecond),
		false,
	)

	return map[string]interface{}{
		"success":           true,
		"content":           resp.Content,
		"reasoning_content": resp.ReasoningContent,
		"tool_calls":        resp.ToolCalls,
		"tokensUsed": map[string]int{
			"promptTokens":     resp.TokensUsed.PromptTokens,
			"completionTokens": resp.TokensUsed.CompletionTokens,
			"totalTokens":      resp.TokensUsed.TotalTokens,
		},
	}
}

// AIChatStream 流式发送 AI 对话（通过 EventsEmit 推送）
func (s *Service) AIChatStream(sessionID string, messages []ai.Message, tools []ai.Tool) {
	s.AIChatStreamWithOptions(sessionID, messages, tools, ai.ChatSendOptions{})
}

// AIChatStreamWithOptions 流式发送 AI 对话，并允许本次调用临时覆盖模型与思考强度等参数。
func (s *Service) AIChatStreamWithOptions(sessionID string, messages []ai.Message, tools []ai.Tool, options ai.ChatSendOptions) {
	options = normalizeChatSendOptions(options)
	streamCtx, cancel := context.WithCancel(context.Background())
	producer := s.registerAIStreamProducer(sessionID, cancel)
	if producer == nil {
		return
	}

	go func() {
		defer func() {
			s.finishAIStreamProducer(sessionID, producer)
			cancel() // 确保释放
		}()

		p, config, err := s.getActiveProviderRuntimeWithOptions(options)
		if err != nil {
			logger.Error(err, "AIChatStream 获取 Provider 失败：sessionID=%s messages=%d tools=%d", sessionID, len(messages), len(tools))
			uievents.Emit(s.ctx, "ai:stream:"+sessionID, map[string]interface{}{
				"error": err.Error(),
				"done":  true,
			})
			return
		}

		started := time.Now()
		providerName := p.Name()
		imageFallbackPrompt := s.serviceText(providerImageFallbackPromptKey, nil)
		imageOmittedNotice := s.serviceText(providerImageOmittedNoticeKey, nil)
		contentChunks := 0
		thinkingChunks := 0
		toolCallChunks := 0
		errorChunks := 0
		var assistantContent strings.Builder
		var assistantReasoning strings.Builder
		var assistantToolCalls []ai.ToolCall
		var updatedProviderState json.RawMessage
		requestMessages := cloneAIMessages(messages)
		logger.Infof("AIChatStream 开始：sessionID=%s provider=%s messages=%d tools=%d", sessionID, providerName, len(messages), len(tools))
		if sessionAwareProvider, ok := p.(provider.SessionStreamProvider); ok {
			providerKey := providerSessionKey(config)
			providerState, deltaMessages := s.resolveSessionProviderRequest(sessionID, providerKey, messages)
			requestMessages = deltaMessages
			updatedProviderState, err = sessionAwareProvider.ChatStreamWithState(streamCtx, providerState, ai.ChatRequest{
				Messages:            requestMessages,
				Tools:               tools,
				ImageFallbackPrompt: imageFallbackPrompt,
				ImageOmittedNotice:  imageOmittedNotice,
			}, func(chunk ai.StreamChunk) {
				if chunk.Content != "" {
					contentChunks++
					assistantContent.WriteString(chunk.Content)
				}
				if chunk.Thinking != "" || chunk.ReasoningContent != "" {
					thinkingChunks++
					if chunk.ReasoningContent != "" {
						assistantReasoning.WriteString(chunk.ReasoningContent)
					}
				}
				if len(chunk.ToolCalls) > 0 {
					toolCallChunks++
					assistantToolCalls = append([]ai.ToolCall(nil), chunk.ToolCalls...)
				}
				if chunk.Error != "" {
					errorChunks++
				}
				uievents.Emit(s.ctx, "ai:stream:"+sessionID, map[string]interface{}{
					"content":           chunk.Content,
					"thinking":          chunk.Thinking,
					"reasoning_content": chunk.ReasoningContent,
					"tool_calls":        chunk.ToolCalls,
					"done":              chunk.Done,
					"error":             chunk.Error,
				})
			})
		} else {
			err = p.ChatStream(streamCtx, ai.ChatRequest{
				Messages:            requestMessages,
				Tools:               tools,
				ImageFallbackPrompt: imageFallbackPrompt,
				ImageOmittedNotice:  imageOmittedNotice,
			}, func(chunk ai.StreamChunk) {
				if chunk.Content != "" {
					contentChunks++
					assistantContent.WriteString(chunk.Content)
				}
				if chunk.Thinking != "" || chunk.ReasoningContent != "" {
					thinkingChunks++
					if chunk.ReasoningContent != "" {
						assistantReasoning.WriteString(chunk.ReasoningContent)
					}
				}
				if len(chunk.ToolCalls) > 0 {
					toolCallChunks++
					assistantToolCalls = append([]ai.ToolCall(nil), chunk.ToolCalls...)
				}
				if chunk.Error != "" {
					errorChunks++
				}
				uievents.Emit(s.ctx, "ai:stream:"+sessionID, map[string]interface{}{
					"content":           chunk.Content,
					"thinking":          chunk.Thinking,
					"reasoning_content": chunk.ReasoningContent,
					"tool_calls":        chunk.ToolCalls,
					"done":              chunk.Done,
					"error":             chunk.Error,
				})
			})
		}

		// 当 context 被主动 cancel 的时候，不把这个视为向外抛的 error
		if err != nil && !isAIStreamCancellation(err) {
			logger.Warnf("AIChatStream 失败：sessionID=%s provider=%s messages=%d tools=%d duration=%s err=%s", sessionID, providerName, len(messages), len(tools), time.Since(started).Round(time.Millisecond), provider.RedactAIUpstreamLogText(err.Error()))
			uievents.Emit(s.ctx, "ai:stream:"+sessionID, map[string]interface{}{
				"error": err.Error(),
				"done":  true,
			})
			return
		}
		if isAIStreamCancellation(err) {
			logger.Infof("AIChatStream 已取消：sessionID=%s provider=%s duration=%s", sessionID, providerName, time.Since(started).Round(time.Millisecond))
			return
		}
		if _, ok := p.(provider.SessionStreamProvider); ok && errorChunks == 0 {
			providerKey := providerSessionKey(config)
			historyAfterStream := cloneAIMessages(messages)
			if assistantMessage, hasAssistantMessage := buildAssistantMessageFromStreamResult(assistantContent.String(), assistantReasoning.String(), assistantToolCalls); hasAssistantMessage {
				historyAfterStream = append(historyAfterStream, assistantMessage)
			}
			if persistErr := s.storeSessionProviderRuntime(sessionID, providerKey, updatedProviderState, historyAfterStream); persistErr != nil {
				logger.Warnf("AIChatStream 保存会话 Provider 状态失败：sessionID=%s provider=%s err=%s", sessionID, providerName, provider.RedactAIUpstreamLogText(persistErr.Error()))
			}
		}
		logger.Infof(
			"AIChatStream 完成：sessionID=%s provider=%s messages=%d tools=%d contentChunks=%d thinkingChunks=%d toolCallChunks=%d errorChunks=%d duration=%s",
			sessionID,
			providerName,
			len(messages),
			len(tools),
			contentChunks,
			thinkingChunks,
			toolCallChunks,
			errorChunks,
			time.Since(started).Round(time.Millisecond),
		)
	}()
}

func isAIStreamCancellation(err error) bool {
	return errors.Is(err, context.Canceled)
}

func (s *Service) registerAIStreamProducer(sessionID string, cancel context.CancelFunc) *aiStreamProducer {
	producer := &aiStreamProducer{cancel: cancel, done: make(chan struct{})}
	s.mu.Lock()
	if s.streamHandoffCount > 0 {
		s.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		return nil
	}
	if s.streamProducers == nil {
		s.streamProducers = make(map[string]map[*aiStreamProducer]struct{})
	}
	active := s.streamProducers[sessionID]
	if active == nil {
		active = make(map[*aiStreamProducer]struct{})
		s.streamProducers[sessionID] = active
	}
	previous := make([]context.CancelFunc, 0, len(active))
	for item := range active {
		if item.cancel != nil {
			previous = append(previous, item.cancel)
		}
	}
	active[producer] = struct{}{}
	s.mu.Unlock()

	// A new send supersedes older sends for the session, but the cancelled
	// producers remain registered until their goroutines have really stopped.
	for _, previousCancel := range previous {
		previousCancel()
	}
	return producer
}

func (s *Service) finishAIStreamProducer(sessionID string, producer *aiStreamProducer) {
	if producer == nil {
		return
	}
	s.mu.Lock()
	if active := s.streamProducers[sessionID]; active != nil {
		delete(active, producer)
		if len(active) == 0 {
			delete(s.streamProducers, sessionID)
		}
	}
	close(producer.done)
	s.mu.Unlock()
}

func (s *Service) snapshotAIStreamProducers(sessionID string) []*aiStreamProducer {
	s.mu.RLock()
	active := s.streamProducers[sessionID]
	producers := make([]*aiStreamProducer, 0, len(active))
	for producer := range active {
		producers = append(producers, producer)
	}
	s.mu.RUnlock()
	return producers
}

func (s *Service) snapshotAllAIStreamProducers() []*aiStreamProducer {
	s.mu.RLock()
	producers := make([]*aiStreamProducer, 0)
	for _, active := range s.streamProducers {
		for producer := range active {
			producers = append(producers, producer)
		}
	}
	s.mu.RUnlock()
	return producers
}

// AIChatCancel 立即终止某个 Session 的流式对话请求
func (s *Service) AIChatCancel(sessionID string) {
	for _, producer := range s.snapshotAIStreamProducers(sessionID) {
		if producer.cancel != nil {
			producer.cancel()
		}
	}
}

// AIChatCancelAndWait stops every active producer for one session and waits
// until all of them stop emitting events. Detached windows use this before
// handing ownership back to another WebView so no final token falls into the
// listener gap.
func (s *Service) AIChatCancelAndWait(sessionID string) bool {
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		producers := s.snapshotAIStreamProducers(sessionID)
		if len(producers) == 0 {
			return true
		}
		for _, producer := range producers {
			if producer.cancel != nil {
				producer.cancel()
			}
		}
		for _, producer := range producers {
			select {
			case <-producer.done:
			case <-timer.C:
				return false
			}
		}
	}
}

// AIChatCancelAllAndWait stops active producers across every session and waits
// until none of them can emit another event. Native window handoff uses this as
// a final guard because a previous session may outlive the current UI session.
func (s *Service) AIChatCancelAllAndWait() bool {
	s.mu.Lock()
	s.streamHandoffCount++
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.streamHandoffCount--
		s.mu.Unlock()
	}()

	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for {
		producers := s.snapshotAllAIStreamProducers()
		if len(producers) == 0 {
			return true
		}
		for _, producer := range producers {
			if producer.cancel != nil {
				producer.cancel()
			}
		}
		for _, producer := range producers {
			select {
			case <-producer.done:
			case <-timer.C:
				return false
			}
		}
	}
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

func providerSessionKey(config ai.ProviderConfig) string {
	return strings.Join([]string{
		strings.TrimSpace(config.ID),
		strings.ToLower(strings.TrimSpace(config.Type)),
		strings.ToLower(strings.TrimSpace(config.APIFormat)),
		strings.TrimSpace(config.BaseURL),
		strings.TrimSpace(config.Model),
	}, "|")
}

func cloneAIMessages(messages []ai.Message) []ai.Message {
	if len(messages) == 0 {
		return nil
	}
	cloned := make([]ai.Message, len(messages))
	for index, message := range messages {
		cloned[index] = message
		if len(message.Images) > 0 {
			cloned[index].Images = append([]string(nil), message.Images...)
		}
		if len(message.ToolCalls) > 0 {
			cloned[index].ToolCalls = append([]ai.ToolCall(nil), message.ToolCalls...)
		}
	}
	return cloned
}

func buildAssistantMessageFromStreamResult(content string, reasoning string, toolCalls []ai.ToolCall) (ai.Message, bool) {
	message := ai.Message{
		Role:             "assistant",
		Content:          content,
		ReasoningContent: reasoning,
	}
	if len(toolCalls) > 0 {
		message.ToolCalls = append([]ai.ToolCall(nil), toolCalls...)
	}
	hasPayload := strings.TrimSpace(message.Content) != "" || strings.TrimSpace(message.ReasoningContent) != "" || len(message.ToolCalls) > 0
	return message, hasPayload
}

func buildAssistantMessageFromChatResponse(resp *ai.ChatResponse) (ai.Message, bool) {
	if resp == nil {
		return ai.Message{}, false
	}
	return buildAssistantMessageFromStreamResult(resp.Content, resp.ReasoningContent, resp.ToolCalls)
}

func messagesHavePrefix(messages []ai.Message, prefix []ai.Message) bool {
	if len(prefix) == 0 {
		return true
	}
	if len(messages) < len(prefix) {
		return false
	}
	for index := range prefix {
		if !reflect.DeepEqual(messages[index], prefix[index]) {
			return false
		}
	}
	return true
}

func (s *Service) resolveSessionProviderRequest(sessionID string, providerKey string, messages []ai.Message) (json.RawMessage, []ai.Message) {
	runtimeState, ok := s.loadSessionProviderRuntime(sessionID, providerKey)
	if !ok || len(runtimeState.State) == 0 || len(runtimeState.Messages) == 0 {
		return nil, cloneAIMessages(messages)
	}
	if !messagesHavePrefix(messages, runtimeState.Messages) {
		return nil, cloneAIMessages(messages)
	}
	deltaMessages := cloneAIMessages(messages[len(runtimeState.Messages):])
	if len(deltaMessages) == 0 {
		return nil, cloneAIMessages(messages)
	}
	return runtimeState.State, deltaMessages
}

func (s *Service) loadSessionProviderRuntime(sessionID string, providerKey string) (aiSessionProviderRuntime, bool) {
	s.mu.RLock()
	runtimeState, ok := s.sessionProviders[sessionID]
	s.mu.RUnlock()
	if ok && runtimeState.ProviderKey == providerKey {
		return aiSessionProviderRuntime{
			ProviderKey: runtimeState.ProviderKey,
			State:       append(json.RawMessage(nil), runtimeState.State...),
			Messages:    cloneAIMessages(runtimeState.Messages),
		}, true
	}

	sessionData, err := s.loadSessionFile(sessionID)
	if err != nil {
		return aiSessionProviderRuntime{}, false
	}
	if strings.TrimSpace(sessionData.ProviderKey) == "" || sessionData.ProviderKey != providerKey || len(sessionData.ProviderState) == 0 {
		return aiSessionProviderRuntime{}, false
	}
	var providerMessages []ai.Message
	if len(sessionData.ProviderMessages) > 0 {
		if err := json.Unmarshal(sessionData.ProviderMessages, &providerMessages); err != nil {
			return aiSessionProviderRuntime{}, false
		}
	}

	runtimeState = aiSessionProviderRuntime{
		ProviderKey: sessionData.ProviderKey,
		State:       append(json.RawMessage(nil), sessionData.ProviderState...),
		Messages:    providerMessages,
	}
	s.mu.Lock()
	s.sessionProviders[sessionID] = runtimeState
	s.mu.Unlock()
	return aiSessionProviderRuntime{
		ProviderKey: runtimeState.ProviderKey,
		State:       append(json.RawMessage(nil), runtimeState.State...),
		Messages:    cloneAIMessages(runtimeState.Messages),
	}, true
}

func (s *Service) storeSessionProviderRuntime(sessionID string, providerKey string, state json.RawMessage, messages []ai.Message) error {
	if strings.TrimSpace(providerKey) == "" {
		return nil
	}

	runtimeState := aiSessionProviderRuntime{
		ProviderKey: providerKey,
		State:       append(json.RawMessage(nil), state...),
		Messages:    cloneAIMessages(messages),
	}
	s.mu.Lock()
	if len(state) == 0 {
		delete(s.sessionProviders, sessionID)
	} else {
		s.sessionProviders[sessionID] = runtimeState
	}
	s.mu.Unlock()

	sessionData, err := s.loadOrCreateSessionFile(sessionID)
	if err != nil {
		return err
	}
	if len(state) == 0 {
		sessionData.ProviderKey = ""
		sessionData.ProviderState = nil
		sessionData.ProviderMessages = nil
		return s.saveSessionFile(sessionID, sessionData)
	}

	sessionData.ProviderKey = providerKey
	sessionData.ProviderState = append(json.RawMessage(nil), state...)
	if len(messages) == 0 {
		sessionData.ProviderMessages = nil
	} else {
		messageBytes, err := json.Marshal(messages)
		if err != nil {
			return s.serviceError("ai_service.backend.error.session_provider_messages_serialize_failed", nil, err)
		}
		sessionData.ProviderMessages = json.RawMessage(messageBytes)
	}
	return s.saveSessionFile(sessionID, sessionData)
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

// --- 会话文件持久化 ---

// sessionFileData 会话文件的 JSON 结构
type sessionFileData struct {
	ID               string          `json:"id"`
	Title            string          `json:"title"`
	UpdatedAt        int64           `json:"updatedAt"`
	Messages         json.RawMessage `json:"messages"` // 透传前端格式，后端不解析消息体
	ProviderKey      string          `json:"providerKey,omitempty"`
	ProviderState    json.RawMessage `json:"providerState,omitempty"`
	ProviderMessages json.RawMessage `json:"providerMessages,omitempty"`
}

func (s *Service) sessionsDir() string {
	return filepath.Join(s.configDir, "sessions")
}

func (s *Service) sessionFilePath(sessionID string) string {
	return filepath.Join(s.sessionsDir(), sessionID+".json")
}

func (s *Service) loadSessionFile(sessionID string) (sessionFileData, error) {
	data, err := os.ReadFile(s.sessionFilePath(sessionID))
	if err != nil {
		return sessionFileData{}, err
	}
	var sessionData sessionFileData
	if err := json.Unmarshal(data, &sessionData); err != nil {
		return sessionFileData{}, localizedAIServiceError{
			key:     "ai_service.backend.error.session_corrupt",
			message: s.serviceText("ai_service.backend.error.session_corrupt", nil),
			cause:   err,
		}
	}
	return sessionData, nil
}

func (s *Service) ensureSessionsDir() error {
	if err := os.MkdirAll(s.sessionsDir(), 0o755); err != nil {
		return s.serviceError("ai_service.backend.error.sessions_dir_create_failed", nil, err)
	}
	return nil
}

func (s *Service) loadOrCreateSessionFile(sessionID string) (sessionFileData, error) {
	if err := s.ensureSessionsDir(); err != nil {
		return sessionFileData{}, err
	}
	sessionData, err := s.loadSessionFile(sessionID)
	if err == nil {
		return sessionData, nil
	}
	if !os.IsNotExist(err) {
		return sessionFileData{}, err
	}
	return sessionFileData{
		ID:        sessionID,
		Title:     s.serviceText("ai_chat.panel.session.default_title", nil),
		UpdatedAt: time.Now().UnixMilli(),
		Messages:  json.RawMessage("[]"),
	}, nil
}

func (s *Service) saveSessionFile(sessionID string, sessionData sessionFileData) error {
	if err := s.ensureSessionsDir(); err != nil {
		return err
	}
	if strings.TrimSpace(sessionData.ID) == "" {
		sessionData.ID = sessionID
	}
	if len(sessionData.Messages) == 0 {
		sessionData.Messages = json.RawMessage("[]")
	}
	data, err := json.Marshal(sessionData)
	if err != nil {
		return s.serviceError("ai_service.backend.error.session_serialize_failed", nil, err)
	}
	if err := os.WriteFile(s.sessionFilePath(sessionID), data, 0o644); err != nil {
		return s.serviceError("ai_service.backend.error.session_write_failed", nil, err)
	}
	return nil
}

// AIGetSessions 获取所有会话的元数据列表（不含消息体）
func (s *Service) AIGetSessions() []map[string]interface{} {
	dir := s.sessionsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []map[string]interface{}{}
	}

	var sessions []map[string]interface{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			continue
		}
		var sfd sessionFileData
		if err := json.Unmarshal(data, &sfd); err != nil {
			continue
		}
		sessions = append(sessions, map[string]interface{}{
			"id":        sfd.ID,
			"title":     sfd.Title,
			"updatedAt": sfd.UpdatedAt,
		})
	}

	// 按 updatedAt 降序排列
	for i := 0; i < len(sessions); i++ {
		for j := i + 1; j < len(sessions); j++ {
			ti, _ := sessions[i]["updatedAt"].(int64)
			tj, _ := sessions[j]["updatedAt"].(int64)
			if tj > ti {
				sessions[i], sessions[j] = sessions[j], sessions[i]
			}
		}
	}

	return sessions
}

// AILoadSession 加载指定会话的完整数据（含消息）
func (s *Service) AILoadSession(sessionID string) map[string]interface{} {
	sessionData, err := s.loadSessionFile(sessionID)
	if err != nil {
		switch localizedAIServiceErrorKey(err) {
		case "ai_service.backend.error.session_corrupt":
			return map[string]interface{}{"success": false, "error": s.serviceText("ai_service.backend.error.session_corrupt", nil)}
		default:
			return map[string]interface{}{"success": false, "error": s.serviceText("ai_service.backend.error.session_missing", nil)}
		}
	}
	return map[string]interface{}{
		"success":   true,
		"id":        sessionData.ID,
		"title":     sessionData.Title,
		"updatedAt": sessionData.UpdatedAt,
		"messages":  sessionData.Messages,
	}
}

// AISaveSession 保存会话数据到文件
func (s *Service) AISaveSession(sessionID string, title string, updatedAt float64, messagesJSON string) error {
	sessionData, err := s.loadOrCreateSessionFile(sessionID)
	if err != nil {
		switch localizedAIServiceErrorKey(err) {
		case "ai_service.backend.error.sessions_dir_create_failed",
			"ai_service.backend.error.session_serialize_failed",
			"ai_service.backend.error.session_write_failed",
			"ai_service.backend.error.session_corrupt":
			return err
		default:
			return s.serviceError("ai_service.backend.error.session_write_failed", nil, err)
		}
	}
	sessionData.ID = sessionID
	sessionData.Title = title
	sessionData.UpdatedAt = int64(updatedAt)
	sessionData.Messages = json.RawMessage(messagesJSON)
	if err := s.saveSessionFile(sessionID, sessionData); err != nil {
		switch localizedAIServiceErrorKey(err) {
		case "ai_service.backend.error.sessions_dir_create_failed",
			"ai_service.backend.error.session_serialize_failed",
			"ai_service.backend.error.session_write_failed":
			return err
		default:
			return s.serviceError("ai_service.backend.error.session_write_failed", nil, err)
		}
	}
	return nil
}

// AIDeleteSession 删除会话文件
func (s *Service) AIDeleteSession(sessionID string) error {
	if err := os.Remove(s.sessionFilePath(sessionID)); err != nil && !os.IsNotExist(err) {
		return s.serviceError("ai_service.backend.error.session_delete_failed", nil, err)
	}
	s.mu.Lock()
	delete(s.sessionProviders, sessionID)
	s.mu.Unlock()
	return nil
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
