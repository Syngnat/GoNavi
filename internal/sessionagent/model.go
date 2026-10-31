package sessionagent

// 本文件是会话浏览的统一数据模型。结构与常量参考 cc-switch
// （github.com/farion1231/cc-switch，MIT）session_manager/model.rs，
// 转为 Go 惯例：变体用指针字段承载，避免扁平字段冲突。

// ─── 预览常量（照抄 cc-switch blocks.rs / utils.rs / cache.rs） ───

const (
	// PreviewLines 结果预览的最大行数。
	PreviewLines = 12
	// PreviewChars 结果预览的最大字符数。
	PreviewChars = 1200
	// InputPreviewChars 工具参数预览的最大字符数。
	InputPreviewChars = 400
	// ThinkingPreviewChars 思考正文预览的最大字符数。
	ThinkingPreviewChars = 400
	// EventPreviewChars 事件文本预览的最大字符数。
	EventPreviewChars = 400
	// TitleChars 单行标题（工具调用名、diff 文件名等）的最大字符数。
	TitleChars = 200
	// SummaryChars 列表摘要（最后一条消息预览）的最大字符数。
	SummaryChars = 160
	// QuestionPreviewChars 轮次提问预览的最大字符数。
	QuestionPreviewChars = 80
	// InlineTextMaxChars 超过此长度的折叠文本改为预览 + ContentRef。
	InlineTextMaxChars = 8 * 1024
	// MaxPageChars 按需取全文时单页最大字符数。
	MaxPageChars = 512 * 1024
	// MaxInlineTextChars 工具输入可直接内联的最大字符数；超过才走
	// ContentRef 按需读取（patch 文本通常远小于该值，直接内联省一次往返）。
	MaxInlineTextChars = 64 * 1024
	// MaxTextBytes 单次全文读取的字节上限。
	MaxTextBytes = 32 * 1024 * 1024
)

// ─── 列表条目 ───

// SessionMeta 是会话列表条目。时间戳为 Unix 毫秒；取不到的字段留空，
// 不从文件名猜测（缺失即空，前端按未知显示）。
type SessionMeta struct {
	ProviderID string `json:"providerId"`
	SessionID  string `json:"sessionId"`
	Title      string `json:"title"`
	Summary    string `json:"summary"`
	// FirstMessage 是首条真实用户消息（列表卡片"首次"行与搜索索引用）。
	FirstMessage  string `json:"firstMessage"`
	ProjectDir    string `json:"projectDir"`
	CreatedAt     int64  `json:"createdAt"`
	LastActiveAt  int64  `json:"lastActiveAt"`
	SourcePath    string `json:"sourcePath"`
	ResumeCommand string `json:"resumeCommand"`
	// ForkedFrom 是派生自哪个会话（Codex 的 forked_from_id）。非空即
	// fork 会话，列表需要区分标记。
	ForkedFrom string `json:"forkedFrom,omitempty"`
}

// ─── 详情消息 ───

// MessageRole 是消息角色。
type MessageRole string

const (
	RoleUser      MessageRole = "user"
	RoleAssistant MessageRole = "assistant"
	RoleTool      MessageRole = "tool"
	RoleSystem    MessageRole = "system"
)

// SessionMessage 是一条会话消息。Injected 标记工具注入的上下文/指令
// 包装，不是用户真实输入；Content 是纯文本投影，有 Blocks 时可留空
// （前端只渲染 blocks）。
type SessionMessage struct {
	Role      MessageRole    `json:"role"`
	Content   string         `json:"content"`
	Timestamp int64          `json:"ts"`
	ID        string         `json:"id,omitempty"`
	TurnID    string         `json:"turnId,omitempty"`
	Injected  bool           `json:"injected,omitempty"`
	Blocks    []SessionBlock `json:"blocks,omitempty"`
	Meta      *MessageMeta   `json:"meta,omitempty"`
	// Structured 是「整条正文是一个 JSON 对象」时的结构化拆解（子 Agent
	// 的结构化结论）。Content 仍保留原始正文，这里只是浏览端的展示提示。
	Structured *StructuredBody `json:"structured,omitempty"`
}

// MessageMeta 是消息级元数据（模型、token、耗时等），全部可空。
type MessageMeta struct {
	Model            string   `json:"model,omitempty"`
	InputTokens      *uint64  `json:"inputTokens,omitempty"`
	OutputTokens     *uint64  `json:"outputTokens,omitempty"`
	CacheReadTokens  *uint64  `json:"cacheReadTokens,omitempty"`
	CacheWriteTokens *uint64  `json:"cacheWriteTokens,omitempty"`
	ReasoningTokens  *uint64  `json:"reasoningTokens,omitempty"`
	CostUSD          *float64 `json:"costUsd,omitempty"`
	DurationMs       *uint64  `json:"durationMs,omitempty"`
	StopReason       string   `json:"stopReason,omitempty"`
}

// ─── 消息块 ───

// BlockType 是消息块类型。
type BlockType string

const (
	BlockText       BlockType = "text"
	BlockThinking   BlockType = "thinking"
	BlockToolCall   BlockType = "tool_call"
	BlockToolResult BlockType = "tool_result"
	BlockImage      BlockType = "image"
	BlockEvent      BlockType = "event"
	BlockStep       BlockType = "step"
)

// SessionBlock 是一条消息内的内容块。Type 决定哪个变体字段有效；
// 变体用指针承载，JSON 以 camelCase 序列化。
type SessionBlock struct {
	Type       BlockType        `json:"type"`
	Text       *TextBlock       `json:"text,omitempty"`
	Thinking   *ThinkingBlock   `json:"thinking,omitempty"`
	ToolCall   *ToolCallBlock   `json:"toolCall,omitempty"`
	ToolResult *ToolResultBlock `json:"toolResult,omitempty"`
	Image      *ImageRef        `json:"image,omitempty"`
	Event      *EventBlock      `json:"event,omitempty"`
	Step       *StepBlock       `json:"step,omitempty"`
}

// TextBlock 是正文块。Text 是预览或全文；Full 仅在文本被截断时给出。
type TextBlock struct {
	Text string      `json:"text"`
	Full *ContentRef `json:"full,omitempty"`
}

// ThinkingBlock 是思考块。Redacted 表示内容被模型加密，只能看标记。
type ThinkingBlock struct {
	Text       string      `json:"text"`
	Summary    string      `json:"summary,omitempty"`
	Redacted   bool        `json:"redacted,omitempty"`
	DurationMs *uint64     `json:"durationMs,omitempty"`
	Full       *ContentRef `json:"full,omitempty"`
}

// ToolKind 是工具分类。
type ToolKind string

const (
	ToolShell  ToolKind = "shell"
	ToolRead   ToolKind = "read"
	ToolSearch ToolKind = "search"
	ToolEdit   ToolKind = "edit"
	ToolWrite  ToolKind = "write"
	ToolWeb    ToolKind = "web"
	ToolMcp    ToolKind = "mcp"
	ToolAgent  ToolKind = "agent"
	ToolAsk    ToolKind = "ask"
	ToolTodo   ToolKind = "todo"
	ToolDiff   ToolKind = "diff"
	ToolOther  ToolKind = "other"
)

// DiffOp 是文件改动类型。
type DiffOp string

const (
	DiffAdd    DiffOp = "add"
	DiffUpdate DiffOp = "update"
	DiffDelete DiffOp = "delete"
	DiffRename DiffOp = "rename"
)

// DiffFile 是单文件改动统计。
type DiffFile struct {
	Path    string `json:"path"`
	Op      DiffOp `json:"op"`
	Added   uint32 `json:"added"`
	Removed uint32 `json:"removed"`
}

// DiffSummary 是工具调用产生的文件改动摘要。
type DiffSummary struct {
	Files   []DiffFile  `json:"files"`
	Added   uint32      `json:"added"`
	Removed uint32      `json:"removed"`
	Full    *ContentRef `json:"full,omitempty"`
}

// ToolCallBlock 是工具调用块。ID 是与结果配对的键。
type ToolCallBlock struct {
	ID            string       `json:"id"`
	RawName       string       `json:"rawName"`
	Kind          ToolKind     `json:"kind"`
	Title         string       `json:"title"`
	Detail        string       `json:"detail,omitempty"`
	Server        string       `json:"server,omitempty"`
	InputPreview  string       `json:"inputPreview,omitempty"`
	InputText     string       `json:"inputText,omitempty"`
	InputTotalLen uint32       `json:"inputTotalLen,omitempty"`
	InputFull     *ContentRef  `json:"inputFull,omitempty"`
	Diff          *DiffSummary `json:"diff,omitempty"`
	ByUser        bool         `json:"byUser,omitempty"`
}

// ToolStatus 是工具执行状态。
type ToolStatus string

const (
	ToolStatusSuccess     ToolStatus = "success"
	ToolStatusError       ToolStatus = "error"
	ToolStatusInterrupted ToolStatus = "interrupted"
	ToolStatusPending     ToolStatus = "pending"
	ToolStatusUnknown     ToolStatus = "unknown"
)

// ToolResultBlock 是工具结果块。Preview 是前若干行截断，Full 指向全文。
type ToolResultBlock struct {
	CallID     string      `json:"callId"`
	Status     ToolStatus  `json:"status"`
	Preview    string      `json:"preview,omitempty"`
	TotalLen   uint32      `json:"totalLen,omitempty"`
	LineCount  uint32      `json:"lineCount,omitempty"`
	Truncated  bool        `json:"truncated,omitempty"`
	Full       *ContentRef `json:"full,omitempty"`
	ExitCode   *int        `json:"exitCode,omitempty"`
	DurationMs *uint64     `json:"durationMs,omitempty"`
	Images     []ImageRef  `json:"images,omitempty"`
	SavedPath  string      `json:"savedPath,omitempty"`
}

// ImageSourceKind 是图片来源类别。
type ImageSourceKind string

const (
	ImageInline    ImageSourceKind = "inline"
	ImageLocalFile ImageSourceKind = "local_file"
)

// ImageRef 是图片引用。Inline 走 ContentRef，LocalFile 是本地路径。
type ImageRef struct {
	Source    ImageSourceKind `json:"source"`
	Content   *ContentRef     `json:"content,omitempty"`
	Path      string          `json:"path,omitempty"`
	MediaType string          `json:"mediaType"`
	Size      uint32          `json:"size"`
	Alt       string          `json:"alt,omitempty"`
}

// EventKind 是事件类别。
type EventKind string

const (
	EventAborted      EventKind = "aborted"
	EventCompaction   EventKind = "compaction"
	EventModelChange  EventKind = "model_change"
	EventHook         EventKind = "hook"
	EventPrLink       EventKind = "pr_link"
	EventSlashCommand EventKind = "slash_command"
	EventInfo         EventKind = "info"
	EventError        EventKind = "error"
	EventSubAgent     EventKind = "sub_agent"
	EventOther        EventKind = "other"
)

// EventBlock 是事件块。
type EventBlock struct {
	Kind EventKind   `json:"kind"`
	Text string      `json:"text,omitempty"`
	URL  string      `json:"url,omitempty"`
	Full *ContentRef `json:"full,omitempty"`
}

// StepPhase 是步骤阶段（OpenCode 专用，其余工具留空）。
type StepPhase string

const (
	StepStart  StepPhase = "start"
	StepFinish StepPhase = "finish"
)

// StepBlock 是步骤块（token/费用计量），仅部分工具产生。
type StepBlock struct {
	Phase   StepPhase `json:"phase"`
	Tokens  *uint64   `json:"tokens,omitempty"`
	CostUSD *float64  `json:"costUsd,omitempty"`
	Reason  string    `json:"reason,omitempty"`
}

// ─── 大内容引用 ───

// ContentRefKind 是大内容引用类别。
type ContentRefKind string

const (
	// ContentJSONL 指向 jsonl 源文件的字节区间 [offset, offset+len) 内
	// 的一行，pointer 是行内 JSON Pointer（RFC 6901）。
	ContentJSONL ContentRefKind = "jsonl"
	// ContentFile 指向会话目录内的相对路径文件，pointer 是文件内
	// JSON Pointer。
	ContentFile ContentRefKind = "file"
	// ContentSidecar 指向会话目录内的附属文件（整文件即内容）。
	ContentSidecar ContentRefKind = "sidecar"
)

// ContentRef 是大内容的按需引用：消息体只带预览，全文由前端按需取。
type ContentRef struct {
	Kind    ContentRefKind `json:"kind"`
	Offset  int64          `json:"offset,omitempty"`
	Length  uint32         `json:"len,omitempty"`
	RelPath string         `json:"relPath,omitempty"`
	Pointer string         `json:"pointer,omitempty"`
}

// ─── 轮次索引 ───

// TurnIndex 是一个问答轮次的索引，随详情头部下发，前端据此分组折叠。
type TurnIndex struct {
	TurnID          string `json:"turnId"`
	FirstMessageIdx int    `json:"firstMessageIndex"`
	LastMessageIdx  int    `json:"lastMessageIndex"`
	QuestionPreview string `json:"questionPreview"`
	Timestamp       int64  `json:"ts"`
	StepCount       uint32 `json:"stepCount"`
	ErrorCount      uint32 `json:"errorCount"`
	HasFinalReply   bool   `json:"hasFinalReply"`
	Aborted         bool   `json:"aborted"`
}
