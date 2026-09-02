package ai

// ToolCall 表示 AI 发出的工具调用
type ToolCall struct {
	ID       string           `json:"id"`
	Type     string           `json:"type"` // "function"
	Function ToolCallFunction `json:"function"`
}

// ToolCallFunction 表示单次工具调用的函数信息
type ToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// ToolFunction 表示可使用的函数定义
type ToolFunction struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Parameters  any    `json:"parameters"` // JSON Schema definitions
}

// Tool 工具申明
type Tool struct {
	Type     string       `json:"type"` // "function"
	Function ToolFunction `json:"function"`
}

// Message 表示一条对话消息
type Message struct {
	Role             string     `json:"role"` // "system" | "user" | "assistant" | "tool"
	Content          string     `json:"content"`
	Images           []string   `json:"images,omitempty"`            // base64 encoded images with data:image/png;base64,... prefix
	ToolCallID       string     `json:"tool_call_id,omitempty"`      // 当 role 为 "tool" 时必须传递
	ToolCalls        []ToolCall `json:"tool_calls,omitempty"`        // 当 role 为 "assistant" 并试图调工具时传递
	ReasoningContent string     `json:"reasoning_content,omitempty"` // DeepSeek thinking mode 工具调用链路要求原样回传
}

// ChatRequest AI 对话请求
type ChatRequest struct {
	Messages            []Message `json:"messages"`
	Temperature         float64   `json:"temperature"`
	MaxTokens           int       `json:"maxTokens"`
	Tools               []Tool    `json:"tools,omitempty"`
	ImageFallbackPrompt string    `json:"-"`
	ImageOmittedNotice  string    `json:"-"`
}

// ChatSendOptions 表示一次对话调用的临时覆盖选项，不写回 Provider 配置。
type ChatSendOptions struct {
	Model             string  `json:"model,omitempty"`
	Temperature       float64 `json:"temperature,omitempty"`
	MaxTokens         int     `json:"maxTokens,omitempty"`
	ThinkingIntensity string  `json:"thinkingIntensity,omitempty"` // 会话/面板级思考强度，仅本次请求生效
}

// ChatResponse AI 对话响应
type ChatResponse struct {
	Content          string     `json:"content"`
	ReasoningContent string     `json:"reasoning_content,omitempty"`
	TokensUsed       TokenUsage `json:"tokensUsed"`
	ToolCalls        []ToolCall `json:"tool_calls,omitempty"`
}

// TokenUsage token 用量统计
type TokenUsage struct {
	PromptTokens     int `json:"promptTokens"`
	CompletionTokens int `json:"completionTokens"`
	TotalTokens      int `json:"totalTokens"`
}

// StreamChunk 流式响应片段
type StreamChunk struct {
	Content          string     `json:"content"`
	Thinking         string     `json:"thinking,omitempty"`
	ReasoningContent string     `json:"reasoning_content,omitempty"`
	Done             bool       `json:"done"`
	Error            string     `json:"error,omitempty"`
	ToolCalls        []ToolCall `json:"tool_calls,omitempty"`
}

// ThinkingIntensity 控制模型思考/推理强度。
// 字面量按服务商差异保留，例如：
//   - OpenAI: none | minimal | low | medium | high | xhigh
//   - Anthropic: off | low | medium | high | xhigh | max
//   - DeepSeek: off | low | medium | high
//   - Gemini: off | minimal | low | medium | high
//
// 不同供应商再映射到 reasoning_effort / thinking / output_config.effort / thinking_level 等字段。
type ThinkingIntensity string

const (
	ThinkingIntensityOff    ThinkingIntensity = "off"
	ThinkingIntensityLow    ThinkingIntensity = "low"
	ThinkingIntensityMedium ThinkingIntensity = "medium"
	ThinkingIntensityHigh   ThinkingIntensity = "high"
)

// ProviderConfig AI Provider 配置
type ProviderConfig struct {
	ID                    string   `json:"id"`
	Type                  string   `json:"type"` // openai | anthropic | gemini | custom
	Name                  string   `json:"name"`
	AuthMode              string   `json:"authMode,omitempty"` // api-key | local-cli
	APIKey                string   `json:"apiKey"`
	SecretRef             string   `json:"secretRef,omitempty"`
	HasSecret             bool     `json:"hasSecret,omitempty"`
	BaseURL               string   `json:"baseUrl"`
	Model                 string   `json:"model"`
	InlineCompletionModel string   `json:"inlineCompletionModel,omitempty"`
	Models                []string `json:"models,omitempty"`
	// Optional model-picker preferences. They do not alter CLI login or account permissions.
	DisabledModels []string          `json:"disabledModels,omitempty"`
	CustomModels   []string          `json:"customModels,omitempty"`
	APIFormat      string            `json:"apiFormat,omitempty"` // openai | openai-responses | anthropic | gemini | cursor-agent | cursor-cli | codex-cli | claude-cli | codebuddy-cli | grok-cli
	Headers        map[string]string `json:"headers,omitempty"`
	MaxTokens      int               `json:"maxTokens"`
	Temperature    float64           `json:"temperature"`
	// ThinkingIntensity 可选：off/low/medium/high。空值表示沿用供应商默认（多数等价 medium）。
	ThinkingIntensity string `json:"thinkingIntensity,omitempty"`
	// Effort 是本机 CLI 供应商的推理档位。它与 ThinkingIntensity 是两条独立的链：
	// 后者面向 API 供应商，值域由 GoNavi 定义；Effort 的合法值域由目标 CLI 决定，
	// 三个 CLI 两两不同（codex 6 / claude 5 / grok 4），因此不共用同一个枚举。
	// 空值表示沿用该 CLI 自身的默认档位，不下发任何档位参数。
	Effort string `json:"effort,omitempty"`
}

// CLICapabilityView 是按 CLI 的模型/档位能力在前端的只读投影。
// 前端不得自己维护一份值域副本：值域、拒绝语义与预填来源都只有 Go 侧一个 owner，
// 复制一份必然随上游 CLI 版本漂移而失真。
type CLICapabilityView struct {
	APIFormat string `json:"apiFormat"`
	Command   string `json:"command"`
	// SupportsEffort 为 false 时前端不应显示档位控件，而不是显示一个无效的通用输入框。
	SupportsEffort bool     `json:"supportsEffort"`
	EffortValues   []string `json:"effortValues"`
	// EffortValuesVerified 为 false 表示值域来自推断，界面应提示该档位未经实测确认。
	EffortValuesVerified bool `json:"effortValuesVerified"`
	// SupportsModelDiscovery 为 true 时该 CLI 能自行枚举模型，界面可给下拉而非手填。
	SupportsModelDiscovery bool `json:"supportsModelDiscovery"`
	HasConfigSource        bool `json:"hasConfigSource"`
	// DefaultModel / DefaultEffort 来自该 CLI 自身的用户配置，仅用于预填。
	DefaultModel  string `json:"defaultModel"`
	DefaultEffort string `json:"defaultEffort"`
}

// UserPromptSettings 表示用户级自定义提示词配置
type UserPromptSettings struct {
	Global        string `json:"global"`
	Database      string `json:"database"`
	JVM           string `json:"jvm"`
	JVMDiagnostic string `json:"jvmDiagnostic"`
}

// MCPTransport 表示 MCP 服务的传输方式
type MCPTransport string

const (
	MCPTransportStdio MCPTransport = "stdio"
)

// MCPServerConfig 表示一个可配置的 MCP 服务
type MCPServerConfig struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Transport      MCPTransport      `json:"transport"`
	Command        string            `json:"command"`
	Args           []string          `json:"args,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	Enabled        bool              `json:"enabled"`
	TimeoutSeconds int               `json:"timeoutSeconds"`
}

// MCPToolDescriptor 表示暴露给模型和前端的 MCP 工具描述
type MCPToolDescriptor struct {
	Alias        string         `json:"alias"`
	ServerID     string         `json:"serverId"`
	ServerName   string         `json:"serverName"`
	OriginalName string         `json:"originalName"`
	Title        string         `json:"title,omitempty"`
	Description  string         `json:"description,omitempty"`
	InputSchema  map[string]any `json:"inputSchema,omitempty"`
}

// MCPToolCallResult 表示一次 MCP 工具调用的结果
type MCPToolCallResult struct {
	Alias             string `json:"alias"`
	ServerID          string `json:"serverId"`
	ServerName        string `json:"serverName"`
	OriginalName      string `json:"originalName"`
	Title             string `json:"title,omitempty"`
	Content           string `json:"content"`
	StructuredContent any    `json:"structuredContent,omitempty"`
	IsError           bool   `json:"isError"`
}

// MCPClientInstallResult 表示安装 GoNavi 到外部 MCP 客户端配置文件的结果。
type MCPClientInstallResult struct {
	Success    bool     `json:"success"`
	Client     string   `json:"client,omitempty"`
	Message    string   `json:"message"`
	ConfigPath string   `json:"configPath,omitempty"`
	Command    string   `json:"command,omitempty"`
	Args       []string `json:"args,omitempty"`
}

// MCPClientInstallStatus 表示 GoNavi MCP 在外部客户端中的当前安装状态。
type MCPClientInstallStatus struct {
	Client         string   `json:"client"`
	DisplayName    string   `json:"displayName"`
	InstallMode    string   `json:"installMode,omitempty"`
	Installed      bool     `json:"installed"`
	MatchesCurrent bool     `json:"matchesCurrent"`
	ClientDetected bool     `json:"clientDetected"`
	ClientCommand  string   `json:"clientCommand,omitempty"`
	ClientPath     string   `json:"clientPath,omitempty"`
	Message        string   `json:"message"`
	ConfigPath     string   `json:"configPath,omitempty"`
	Command        string   `json:"command,omitempty"`
	Args           []string `json:"args,omitempty"`
}

// MCPHTTPServerOptions 表示从客户端启动 GoNavi Streamable HTTP MCP 的参数。
type MCPHTTPServerOptions struct {
	Addr       string `json:"addr,omitempty"`
	Path       string `json:"path,omitempty"`
	Token      string `json:"token,omitempty"`
	SchemaOnly bool   `json:"schemaOnly"`
}

// MCPHTTPServerConfig 表示客户端内置 HTTP MCP 服务的持久化偏好。
// Token 仅保存在 secret store，不会序列化到 ai_config.json。
type MCPHTTPServerConfig struct {
	Enabled    bool   `json:"enabled"`
	Addr       string `json:"addr,omitempty"`
	Path       string `json:"path,omitempty"`
	SchemaOnly bool   `json:"schemaOnly"`
	Token      string `json:"-"`
}

// MCPHTTPServerStatus 表示客户端内置 HTTP MCP 服务运行状态。
type MCPHTTPServerStatus struct {
	Enabled             bool   `json:"enabled"`
	Running             bool   `json:"running"`
	Addr                string `json:"addr"`
	Path                string `json:"path"`
	URL                 string `json:"url"`
	SchemaOnly          bool   `json:"schemaOnly"`
	Token               string `json:"token,omitempty"`
	AuthorizationHeader string `json:"authorizationHeader,omitempty"`
	StartedAt           int64  `json:"startedAt,omitempty"`
	Message             string `json:"message"`
}

// ClaudeCodeMCPInstallResult 兼容旧命名，便于平滑迁移到通用结果类型。
type ClaudeCodeMCPInstallResult = MCPClientInstallResult

// SkillScope 表示 Skill 的适用场景
type SkillScope string

const (
	SkillScopeGlobal        SkillScope = "global"
	SkillScopeDatabase      SkillScope = "database"
	SkillScopeJVM           SkillScope = "jvm"
	SkillScopeJVMDiagnostic SkillScope = "jvmDiagnostic"
)

// SkillConfig 表示一个可配置的 Skill
type SkillConfig struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	Description   string   `json:"description,omitempty"`
	SystemPrompt  string   `json:"systemPrompt"`
	Enabled       bool     `json:"enabled"`
	Scopes        []string `json:"scopes,omitempty"`
	RequiredTools []string `json:"requiredTools,omitempty"`
}

// SQLPermissionLevel AI SQL 执行权限级别
type SQLPermissionLevel string

const (
	PermissionReadOnly  SQLPermissionLevel = "readonly"
	PermissionReadWrite SQLPermissionLevel = "readwrite"
	PermissionFull      SQLPermissionLevel = "full"
)

// ContextLevel AI 上下文传递级别
type ContextLevel string

const (
	ContextSchemaOnly  ContextLevel = "schema_only"
	ContextWithSamples ContextLevel = "with_samples"
	ContextWithResults ContextLevel = "with_results"
)

// SQLOperationType SQL 操作类型
type SQLOperationType string

const (
	SQLOpQuery SQLOperationType = "query" // SELECT, SHOW, DESCRIBE, EXPLAIN
	SQLOpDML   SQLOperationType = "dml"   // INSERT, UPDATE, DELETE
	SQLOpDDL   SQLOperationType = "ddl"   // CREATE, ALTER, DROP, TRUNCATE
	SQLOpOther SQLOperationType = "other"
)

// SafetyResult 安全检查结果
type SafetyResult struct {
	Allowed         bool             `json:"allowed"`
	OperationType   SQLOperationType `json:"operationType"`
	RequiresConfirm bool             `json:"requiresConfirm"`
	WarningMessage  string           `json:"warningMessage,omitempty"`
}
