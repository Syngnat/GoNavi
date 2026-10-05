package aiservice

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"GoNavi-Wails/internal/ai"
	"GoNavi-Wails/internal/ai/provider"
	"GoNavi-Wails/internal/ai/runharness"
	"GoNavi-Wails/internal/ai/safety"
	"GoNavi-Wails/internal/logger"
	"GoNavi-Wails/internal/secretstore"
	"GoNavi-Wails/shared/i18n"
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
	resultMasking      ai.ResultMaskingSettings
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
	builtinLookupCache             builtinAILookupCache // see builtin_ai_tables.go
	agentApprovalHandler           runharness.ApprovalHandler
	autoApproval                   autoApprovalState
	agentHarnessInitialized        bool
	agentHarnessInitialization     error
	agentHarnessShutdown           bool
	agentDataMaintenanceMu         sync.Mutex
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
	mcpHTTPShuttingDown      bool
	mcpHTTPCrashCount        int
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

var claudeCLILocalAuthCheckFunc = func(config ai.ProviderConfig) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return provider.CheckClaudeCLILocalAuthWithConfig(ctx, config)
}

var codexCLIHealthCheckFunc = func(config ai.ProviderConfig) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return provider.CheckCodexCLIAuthWithConfig(ctx, config)
}

var grokCLIHealthCheckFunc = func(config ai.ProviderConfig) error {
	return provider.CheckGrokCLIModelsWithConfig(context.Background(), config)
}

var cursorCLIHealthCheckFunc = func(config ai.ProviderConfig) error {
	return provider.CheckCursorCLIAuthWithConfig(context.Background(), config)
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
	return NewServiceWithSecretStore(newDefaultAISecretStore())
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

// --- Provider 管理 ---

// --- 上下文控制 ---

// --- 内部方法 ---

// --- 配置持久化 ---

// --- 工具函数 ---
