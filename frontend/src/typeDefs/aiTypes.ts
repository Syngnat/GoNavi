import type { JVMAIPlanContext, JVMDiagnosticPlanContext } from './workbenchTypes';

// --- AI Types ---

export type AIProviderType = "openai" | "anthropic" | "gemini" | "custom";
export type AIProviderAuthMode = "api-key" | "bearer" | "local-cli";
export type AISafetyLevel = "readonly" | "readwrite" | "full";
export type AIContextLevel = "schema_only" | "with_samples" | "with_results";

/**
 * A context item is either a durable schema attachment or an explicitly
 * attached editor selection.  The optional fields keep the legacy table
 * contract (`dbName`, `tableName`, `ddl`) JSON-compatible while allowing the
 * composer to describe other bounded sources without another store.
 */
// "chat_quote" is a passage the person quoted from an earlier answer.
export type AIContextItemKind = "table_schema" | "editor_selection" | "chat_quote";

export interface AIEditorSelection {
  tabId: string;
  tabTitle?: string;
  connectionId?: string;
  dbName?: string;
  language?: string;
  text: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
  truncated?: boolean;
}

export interface AIResultMaskingSettings {
  enabled: boolean;
  fullMaskFields: string[];
  partialMaskFields: string[];
}

export interface AIContextItem {
  dbName: string;
  tableName: string;
  ddl: string;
  kind?: AIContextItemKind;
  /** Human-readable source label shown in the composer chip. */
  label?: string;
  /** Original bounded content for non-table context items. */
  content?: string;
  /** For a quoted passage: the message it came from. */
  quoteOf?: string;
  source?: Pick<AIEditorSelection, "tabId" | "tabTitle" | "connectionId" | "dbName" | "language"
    | "startLine" | "startColumn" | "endLine" | "endColumn" | "truncated">;
}

export interface AIProviderConfig {
  id: string;
  type: AIProviderType;
  name: string;
  apiKey: string;
  authMode?: AIProviderAuthMode;
  secretRef?: string;
  hasSecret?: boolean;
  baseUrl: string;
  model: string;
  inlineCompletionModel?: string;
  models?: string[];
  /** Per-configuration suggestions only; absent fields preserve legacy behavior. */
  disabledModels?: string[];
  customModels?: string[];
  /**
   * 用户从模型列表里删除的模型：删除后不再出现在列表里（含内置预设与上游同步来的同名项），
   * 因此需要持久化。与 disabledModels 的区别是「删除」而非「停用」。
   */
  removedModels?: string[];
  apiFormat?: string; // openai 可选 openai-responses；custom 支持 openai/anthropic/gemini/CLI 等格式
  headers?: Record<string, string>;
  maxTokens: number;
  contextWindow?: number;
  /** false: the model reads text only, so images are not sent to it (the desktop recognizes their text instead). */
  supportsImages?: boolean;
  cliPath?: string;
  cliEnv?: Record<string, string>;
  temperature: number;
  /** API 供应商的思考强度；合法值域由供应商 profile 决定。 */
  thinkingIntensity?: string;
  /**
   * 本机 CLI 供应商的推理档位。合法值域由目标 CLI 决定，三个 CLI 两两不同，
   * 候选值来自后端 AIGetCLICapabilities，前端不维护副本。空表示沿用 CLI 默认。
   */
  effort?: string;
}

export interface AIUserPromptSettings {
  global: string;
  database: string;
  jvm: string;
  jvmDiagnostic: string;
}

export type AIMCPTransport = "stdio";

export interface AIMCPServerConfig {
  id: string;
  name: string;
  transport: AIMCPTransport;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
  timeoutSeconds: number;
}

export interface AIMCPToolDescriptor {
  alias: string;
  serverId: string;
  serverName: string;
  originalName: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

export interface AIMCPToolCallResult {
  alias: string;
  serverId: string;
  serverName: string;
  originalName: string;
  title?: string;
  content: string;
  structuredContent?: any;
  isError: boolean;
}

export interface AIMCPClientInstallStatus {
  client: string;
  displayName: string;
  installMode?: 'auto' | 'remote';
  installed: boolean;
  matchesCurrent: boolean;
  clientDetected?: boolean;
  clientCommand?: string;
  clientPath?: string;
  message: string;
  configPath?: string;
  command?: string;
  args?: string[];
}

export interface AIMCPHTTPServerStatus {
  /** 用户持久化的启用意图；与真实进程运行状态分离。 */
  enabled?: boolean;
  running: boolean;
  addr: string;
  path: string;
  url: string;
  schemaOnly: boolean;
  token?: string;
  authorizationHeader?: string;
  startedAt?: number;
  message: string;
}

export type AISkillScope = "global" | "database" | "jvm" | "jvmDiagnostic";

export interface AISkillConfig {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;
  enabled: boolean;
  scopes: AISkillScope[];
  requiredTools?: string[];
}

export interface AIToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

// "context" is a bound editor selection or table schema shown as a chip on the message.
export type AIChatAttachmentKind = "image" | "markdown" | "text" | "pdf" | "word" | "excel" | "document" | "context";

export interface AIChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AIChatAttachmentKind;
  dataUrl?: string;
  text?: string;
  textTruncated?: boolean;
  extractWarning?: string;
  /** Set when kind is "context". */
  contextKind?: "editor_selection" | "table_schema" | "chat_quote";
  contextLines?: number;
  /** Text recognized in an image for a model that cannot see images (see components/ai/ocr). */
  ocr?: AIChatAttachmentOcr;
}

export type AIChatAttachmentOcrStatus = "waiting" | "needs_install" | "running" | "done" | "no_text" | "failed";

export interface AIChatAttachmentOcr {
  status: AIChatAttachmentOcrStatus;
  /** The recognized text, once status is "done". */
  text?: string;
  error?: string;
}

export type ChatPhase =
  | "idle"
  | "queued"
  | "connecting"
  | "thinking"
  | "generating"
  | "tool_calling";

/**
 * A user-visible, redacted projection of one Agent Harness run step. Keep
 * provider reasoning, tool arguments, tool output, and raw errors out of
 * this type: those belong to their existing dedicated UI paths.
 */
export type AIChatRunActivityKind = "model" | "tool" | "approval" | "workspace" | "retry" | "run";
export type AIChatRunActivityStatus = "active" | "waiting" | "completed" | "failed" | "canceled";

export interface AIChatRunActivity {
  /** Stable only within a run; it is not rendered to the user. */
  id: string;
  kind: AIChatRunActivityKind;
  status: AIChatRunActivityStatus;
  timestamp: number;
  /** A catalog tool name, safe to expose without its arguments or results. */
  toolName?: string;
  /** Harness retry attempt, when the activity represents a retry. */
  attempt?: number;
  /** Stable failure code only; raw provider messages stay in `rawError`. */
  errorCode?: string;
}

export interface AIChatTokenUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Undefined means the provider did not expose cache-hit usage. */
  cachedTokens?: number;
}

export interface AIChatMessage {
  id: string;
  /** Harness run that owns this transient or durable message, when known. */
  runId?: string;
  role: "user" | "assistant" | "system" | "tool";
  phase?: ChatPhase;
  content: string;
  thinking?: string;
  reasoning_content?: string;
  timestamp: number;
  loading?: boolean;
  images?: string[]; // base64 encoded images with data URI prefix
  attachments?: AIChatAttachment[];
  tool_calls?: AIToolCall[];
  /** Provider-reported usage aggregated across all model turns in this reply. */
  tokenUsage?: AIChatTokenUsage;
  /** Redacted, ordered execution steps retained with this assistant message. */
  runActivities?: AIChatRunActivity[];
  /** Time the AI actually spent on this reply (model and tools, approval waits excluded). */
  processingMs?: number;
  tool_call_id?: string;
  tool_name?: string; // used for UI display
  rawError?: string; // 存储未清洗的原始错误信息，用于用户复制排查
  excludeFromAIContext?: boolean; // 纯 UI 状态或错误消息，不回灌给模型
  success?: boolean; // 标记探针执行是否成功
  jvmPlanContext?: JVMAIPlanContext;
  jvmDiagnosticPlanContext?: JVMDiagnosticPlanContext;
}

export interface AISafetyResult {
  allowed: boolean;
  operationType: "query" | "dml" | "ddl" | "other";
  requiresConfirm: boolean;
  warningMessage?: string;
}
