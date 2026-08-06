export interface SSHConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  keyPath?: string;
}

export interface ProxyConfig {
  type: "socks5" | "http";
  host: string;
  port: number;
  user?: string;
  password?: string;
}

export interface HTTPTunnelConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
}

export interface ConnectionProtectionConfig {
  restrictDataEdit?: boolean;
  restrictStructureEdit?: boolean;
  restrictScriptExecution?: boolean;
  restrictDataImport?: boolean;
}

export interface JVMJMXConfig {
  enabled?: boolean;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  domainAllowlist?: string[];
}

export interface JVMEndpointConfig {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  timeoutSeconds?: number;
}

export interface JVMAgentConfig {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  timeoutSeconds?: number;
}

export type JVMDiagnosticTransport = "agent-bridge" | "arthas-tunnel";

export interface JVMDiagnosticConfig {
  enabled?: boolean;
  transport?: JVMDiagnosticTransport;
  baseUrl?: string;
  targetId?: string;
  apiKey?: string;
  allowObserveCommands?: boolean;
  allowTraceCommands?: boolean;
  allowMutatingCommands?: boolean;
  timeoutSeconds?: number;
}

export interface JVMDiagnosticCapability {
  transport: JVMDiagnosticTransport;
  canOpenSession: boolean;
  canStream: boolean;
  canCancel: boolean;
  allowObserveCommands: boolean;
  allowTraceCommands: boolean;
  allowMutatingCommands: boolean;
  reason?: string;
}

export interface JVMDiagnosticSessionRequest {
  title?: string;
  reason?: string;
}

export interface JVMDiagnosticSessionHandle {
  sessionId: string;
  transport: string;
  startedAt: number;
}

export interface JVMDiagnosticCommandRequest {
  sessionId: string;
  commandId: string;
  command: string;
  source?: string;
  reason?: string;
}

export interface JVMDiagnosticEventChunk {
  sessionId: string;
  commandId?: string;
  event?: string;
  phase?: string;
  content?: string;
  timestamp?: number;
  metadata?: Record<string, any>;
}

export interface JVMDiagnosticAuditRecord {
  timestamp: number;
  connectionId: string;
  sessionId?: string;
  commandId?: string;
  transport: string;
  command: string;
  commandType?: string;
  source?: string;
  reason?: string;
  riskLevel?: string;
  status: string;
}

export interface JVMDiagnosticPlan {
  intent: string;
  transport: JVMDiagnosticTransport;
  command: string;
  riskLevel: "low" | "medium" | "high";
  reason: string;
  expectedSignals?: string[];
}

export interface JVMDiagnosticCommandDraft {
  sessionId?: string;
  command: string;
  source?: "manual" | "ai-plan";
  reason?: string;
}

export interface JVMConfig {
  environment?: "dev" | "uat" | "prod";
  readOnly?: boolean;
  allowedModes?: Array<"jmx" | "endpoint" | "agent">;
  preferredMode?: "jmx" | "endpoint" | "agent";
  jmx?: JVMJMXConfig;
  endpoint?: JVMEndpointConfig;
  agent?: JVMAgentConfig;
  diagnostic?: JVMDiagnosticConfig;
}

export interface JVMCapability {
  mode: "jmx" | "endpoint" | "agent";
  canBrowse: boolean;
  canWrite: boolean;
  canPreview: boolean;
  reason?: string;
  displayLabel: string;
}

export interface JVMMonitoringPoint {
  timestamp: number;
  heapUsedBytes?: number;
  heapCommittedBytes?: number;
  heapMaxBytes?: number;
  nonHeapUsedBytes?: number;
  nonHeapCommittedBytes?: number;
  gcCollectionCount?: number;
  gcCollectionTimeMs?: number;
  gcDeltaCount?: number;
  gcDeltaTimeMs?: number;
  threadCount?: number;
  daemonThreadCount?: number;
  peakThreadCount?: number;
  threadStateCounts?: Record<string, number>;
  loadedClassCount?: number;
  unloadedClassCount?: number;
  classLoadDelta?: number;
  processCpuLoad?: number;
  systemCpuLoad?: number;
  processRssBytes?: number;
  committedVirtualMemoryBytes?: number;
}

export interface JVMMonitoringRecentGCEvent {
  timestamp: number;
  name?: string;
  cause?: string;
  action?: string;
  durationMs?: number;
  beforeUsedBytes?: number;
  afterUsedBytes?: number;
}

export interface JVMMonitoringSessionState {
  connectionId: string;
  providerMode: "jmx" | "endpoint" | "agent";
  running: boolean;
  points?: JVMMonitoringPoint[];
  recentGcEvents?: JVMMonitoringRecentGCEvent[];
  availableMetrics?: string[];
  missingMetrics?: string[];
  providerWarnings?: string[];
}

export interface JVMResourceSummary {
  id: string;
  parentId?: string;
  kind: string;
  name: string;
  path: string;
  providerMode: "jmx" | "endpoint" | "agent";
  canRead: boolean;
  canWrite: boolean;
  hasChildren: boolean;
  sensitive?: boolean;
}

export interface JVMActionPayloadField {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
}

export interface JVMActionDefinition {
  action: string;
  label?: string;
  description?: string;
  dangerous?: boolean;
  payloadFields?: JVMActionPayloadField[];
  payloadExample?: Record<string, any>;
}

export interface JVMValueSnapshot {
  resourceId: string;
  kind: string;
  format: string;
  version?: string;
  value: any;
  description?: string;
  sensitive?: boolean;
  supportedActions?: JVMActionDefinition[];
  metadata?: Record<string, any>;
}

export interface JVMChangePreview {
  allowed: boolean;
  requiresConfirmation?: boolean;
  confirmationToken?: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  blockingReason?: string;
  before: JVMValueSnapshot;
  after: JVMValueSnapshot;
}

export interface JVMChangeRequest {
  providerMode: "jmx" | "endpoint" | "agent";
  resourceId: string;
  action: string;
  reason: string;
  source?: "manual" | "ai-plan";
  expectedVersion?: string;
  confirmationToken?: string;
  payload?: Record<string, any>;
}

export interface JVMApplyResult {
  status: string;
  message?: string;
  updatedValue: JVMValueSnapshot;
}

export interface JVMAuditRecord {
  timestamp: number;
  connectionId: string;
  providerMode: string;
  resourceId: string;
  action: string;
  reason: string;
  source?: string;
  result: string;
}

export interface ConnectionConfig {
  id?: string;
  type: string;
  host: string;
  port: number;
  user: string;
  password?: string;
  savePassword?: boolean;
  database?: string;
  readOnly?: boolean;
  protection?: ConnectionProtectionConfig;
  useSSL?: boolean;
  sslMode?: "preferred" | "required" | "skip-verify" | "disable";
  sslCAPath?: string;
  sslCertPath?: string;
  sslKeyPath?: string;
  useSSH?: boolean;
  ssh?: SSHConfig;
  useProxy?: boolean;
  proxy?: ProxyConfig;
  useHttpTunnel?: boolean;
  httpTunnel?: HTTPTunnelConfig;
  driver?: string;
  dsn?: string;
  connectionParams?: string;
  timeout?: number;
  keepAliveEnabled?: boolean;
  keepAliveIntervalMinutes?: number;
  keepAliveSQL?: string;
  redisDB?: number; // Redis database index
  uri?: string; // Connection URI for copy/paste
  clickHouseProtocol?: "auto" | "http" | "native"; // ClickHouse connection protocol override
  oceanBaseProtocol?: "mysql" | "oracle"; // OceanBase tenant compatibility protocol
  hosts?: string[]; // Multi-host addresses: host:port
  topology?: "single" | "replica" | "cluster" | "sentinel";
  redisSentinelMaster?: string;
  redisSentinelUser?: string;
  redisSentinelPassword?: string;
  mysqlReplicaUser?: string;
  mysqlReplicaPassword?: string;
  replicaSet?: string;
  authSource?: string;
  readPreference?: string;
  mongoSrv?: boolean;
  mongoAuthMechanism?: string;
  mongoReplicaUser?: string;
  mongoReplicaPassword?: string;
  jvm?: JVMConfig;
}

export type ConnectionEnvironmentType =
  | 'production'
  | 'test'
  | 'development'
  | 'local';

export interface MongoMemberInfo {
  host: string;
  role: string;
  state: string;
  stateCode?: number;
  healthy: boolean;
  isSelf?: boolean;
}

export interface SavedConnection {
  id: string;
  name: string;
  environmentType?: ConnectionEnvironmentType;
  config: ConnectionConfig;
  secretRef?: string;
  hasPrimaryPassword?: boolean;
  hasSSHPassword?: boolean;
  hasProxyPassword?: boolean;
  hasHttpTunnelPassword?: boolean;
  hasMySQLReplicaPassword?: boolean;
  hasMongoReplicaPassword?: boolean;
  hasRedisSentinelPassword?: boolean;
  hasOpaqueURI?: boolean;
  hasOpaqueDSN?: boolean;
  /** Legacy exact database names kept for backwards-compatible visibility rules. */
  includeDatabases?: string[];
  /** Database name masks. `*`/`%` match any text and `_` matches one character. */
  includeDatabasePatterns?: string[];
  /** Database name masks that always take precedence over include rules. */
  excludeDatabasePatterns?: string[];
  includeRedisDatabases?: number[]; // Redis databases to show
  schemaVisibilityByDatabase?: Record<string, SchemaVisibilityRule>;
  iconType?: string; // 自定义图标类型（如 'mysql','postgres'），不填则取 config.type
  iconColor?: string; // 自定义图标颜色（十六进制），不填则取类型默认色
}

export interface SchemaVisibilityRule {
  mode: 'include' | 'exclude';
  schemas: string[];
}

export interface GlobalProxyConfig extends ProxyConfig {
  enabled: boolean;
  hasPassword?: boolean;
  secretRef?: string;
}

export interface ConnectionTag {
  id: string;
  name: string;
  /**
   * Parent group id. An omitted value keeps the group at the sidebar root.
   * Hosts are always owned by exactly one direct group, while groups can nest.
   */
  parentTagId?: string;
  connectionIds: string[];
  /**
   * Direct child display order. Entries use the same `tag:<id>` and
   * `connection:<id>` tokens as the sidebar root order.
   */
  childOrder?: string[];
}

export interface ColumnDefinition {
  name: string;
  type: string;
  nullable: string;
  key: string;
  default?: string;
  hasDefault?: boolean;
  extra: string;
  comment: string;
  charset?: string;
  collation?: string;
}

export interface IndexDefinition {
  name: string;
  columnName: string;
  nonUnique: number;
  seqInIndex: number;
  indexType: string;
}

export interface ForeignKeyDefinition {
  name: string;
  columnName: string;
  refTableName: string;
  refColumnName: string;
  constraintName: string;
}

export interface TriggerDefinition {
  name: string;
  timing: string;
  event: string;
  statement: string;
}

export type TableExportScope = "selected" | "page" | "all" | "filteredAll";
export type TableExportContentMode = "schema" | "dataOnly" | "backup";

export interface TableExportScopeOption {
  value: TableExportScope;
  label: string;
  description?: string;
  disabled?: boolean;
}

export type TableExportHistoryStatus =
  | "idle"
  | "start"
  | "running"
  | "finalizing"
  | "done"
  | "error";

export interface TableExportHistoryEntry {
  jobId: string;
  targetName: string;
  startedAt: number;
  finishedAt: number;
  format: string;
  scope: string;
  scopeLabel: string;
  strategyLabel: string;
  status: TableExportHistoryStatus;
  stage: string;
  current: number;
  total: number;
  totalRowsKnown: boolean;
  filePath: string;
  message: string;
}

export interface TabData {
  id: string;
  title: string;
  type:
    | "query"
    | "table"
    | "design"
    | "data-sync"
    | "sql-file-execution"
    | "sql-analysis"
    | "sql-audit"
    | "redis-keys"
    | "redis-command"
    | "redis-monitor"
    | "nacos-config"
    | "nacos-services"
    | "trigger"
    | "view-def"
    | "event-def"
    | "routine-def"
    | "sequence-def"
    | "package-def"
    | "table-overview"
    | "table-export"
    | "data-import"
    | "jvm-overview"
    | "jvm-resource"
    | "jvm-audit"
    | "jvm-diagnostic"
    | "jvm-monitoring";
  connectionId: string;
  dbName?: string;
  tableName?: string;
  query?: string;
  resultPanelVisible?: boolean;
  queryMode?: "standard" | "object-edit";
  returnToTabId?: string;
  filePath?: string;
  initialTab?: string;
  initialViewMode?: "table" | "json" | "text" | "fields" | "ddl" | "er" | "sqlLog";
  initialViewModeRequestId?: string;
  readOnly?: boolean;
  providerMode?: "jmx" | "endpoint" | "agent";
  resourcePath?: string;
  resourceKind?: string;
  redisDB?: number; // Redis database index for redis tabs
  nacosNamespaceId?: string; // Nacos namespace id (empty string means public)
  nacosNamespaceName?: string; // Nacos namespace display name
  nacosGroup?: string; // Nacos group filter for config or service workbenches
  triggerName?: string; // Trigger name for trigger tabs
  triggerTableName?: string; // Trigger target table for trigger tabs
  viewName?: string; // View name for view definition tabs
  viewKind?: "view" | "materialized";
  eventName?: string; // Event name for MySQL event definition tabs
  routineName?: string; // Routine name for function/procedure definition tabs
  routineType?: string; // 'FUNCTION' or 'PROCEDURE'
  sequenceName?: string; // Sequence name for sequence definition tabs
  packageName?: string; // Package name for package definition tabs
  schemaName?: string; // Schema / owner name for schema-grouped objects
  sidebarLocateKey?: string; // Precise sidebar tree key for locating an object node
  savedQueryId?: string; // Saved query identity for quick-save behavior
  objectType?: 'table' | 'view' | 'materialized-view'; // Table-like object type for shared viewers
  exportWorkbenchMode?: 'single' | 'batch-tables' | 'batch-databases' | 'database' | 'schema';
  dataSyncEntryMode?: 'sync' | 'schemaCompare' | 'dataCompare';
  tableExportScopeOptions?: TableExportScopeOption[];
  tableExportInitialScope?: TableExportScope;
  tableExportQueryByScope?: Partial<Record<TableExportScope, string>>;
  tableExportRowCountByScope?: Partial<Record<TableExportScope, number>>;
  tableExportInitialObjectNames?: string[];
  tableExportInitialDatabaseNames?: string[];
  tableExportContentMode?: TableExportContentMode;
  tableExportIncludeDropIfExists?: boolean;
  tableExportLaunchKey?: string;
  tableExportRequestKey?: string;
  dataImportMode?: "table" | "database";
  dataImportLaunchKey?: string;
  dataImportRunning?: boolean;
  sqlFileExecutionRequestKey?: string;
  sqlFileExecutionFileSizeMB?: string;
  sqlAnalysisView?: "diagnose" | "slow-query";
  sqlAnalysisRequestKey?: string;
  sqlAuditTransactionId?: string;
  sqlAuditRequestKey?: string;
  formatRestoreSnapshot?: {
    query: string;
    createdAt: number;
  }; // Last SQL content before beautify, for cross-session restore
}

export interface JVMAIPlanContext {
  tabId: string;
  connectionId: string;
  providerMode: "jmx" | "endpoint" | "agent";
  resourcePath: string;
}

export interface JVMDiagnosticPlanContext {
  tabId: string;
  connectionId: string;
  transport: JVMDiagnosticTransport;
}

export interface DatabaseNode {
  title: string;
  key: string;
  isLeaf?: boolean;
  children?: DatabaseNode[];
  icon?: any;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  connectionId: string;
  dbName: string;
  createdAt: number;
  connectionFingerprint?: string;
  fingerprintVersion?: string;
  bindingStatus?: "active" | "rebound" | "orphan" | string;
  originalConnectionId?: string;
}

export interface SavedQueryGroup {
  id: string;
  name: string;
  parentGroupId?: string;
  queryIds: string[];
  /**
   * Mixed direct-child order. Tokens use `query:<id>` and `group:<id>`.
   */
  childOrder?: string[];
}

export interface SqlSnippet {
  id: string;
  prefix: string;
  name: string;
  description?: string;
  syntaxHelp?: string;
  body: string;
  isBuiltin: boolean;
  createdAt: number;
}

export interface ExternalSQLDirectory {
  id: string;
  name: string;
  path: string;
  connectionId?: string;
  dbName?: string;
  createdAt: number;
}

export interface ExternalSQLTreeEntry {
  name: string;
  path: string;
  isDir: boolean;
  children?: ExternalSQLTreeEntry[];
}

// Redis types
export interface RedisKeyInfo {
  key: string;
  type: string;
  ttl: number;
}

export interface RedisScanResult {
  keys: RedisKeyInfo[];
  cursor: string;
}

export interface RedisValue {
  type: "string" | "hash" | "list" | "set" | "zset" | "stream";
  ttl: number;
  value: any;
  length: number;
}

export interface RedisDBInfo {
  index: number;
  keys: number;
}

export interface ZSetMember {
  member: string;
  score: number;
}

export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

// --- AI Types ---

export type AIProviderType = "openai" | "anthropic" | "gemini" | "custom";
export type AIProviderAuthMode = "api-key" | "local-cli";
export type AISafetyLevel = "readonly" | "readwrite" | "full";
export type AIContextLevel = "schema_only" | "with_samples" | "with_results";

export interface AIContextItem {
  dbName: string;
  tableName: string;
  ddl: string;
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
  apiFormat?: string; // openai 可选 openai-responses；custom 支持 openai/anthropic/gemini/CLI 等格式
  headers?: Record<string, string>;
  maxTokens: number;
  temperature: number;
  /** 思考强度：off | low | medium | high；空表示供应商默认 */
  thinkingIntensity?: string;
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

export type AIChatAttachmentKind = "image" | "markdown" | "text" | "pdf" | "word" | "excel" | "document";

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
}

export type ChatPhase =
  | "idle"
  | "connecting"
  | "thinking"
  | "generating"
  | "tool_calling";

export interface AIChatMessage {
  id: string;
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
  tool_call_id?: string;
  tool_name?: string; // used for UI display
  rawError?: string; // 存储未清洗的原始错误信息，用于用户复制排查
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

export type SecurityUpdateOverallStatus =
  | "not_detected"
  | "pending"
  | "postponed"
  | "in_progress"
  | "needs_attention"
  | "completed"
  | "rolled_back";

export type SecurityUpdateIssueScope =
  | "connection"
  | "global_proxy"
  | "ai_provider"
  | "system";
export type SecurityUpdateIssueSeverity = "high" | "medium" | "low";
export type SecurityUpdateItemStatus =
  | "pending"
  | "updated"
  | "needs_attention"
  | "skipped"
  | "failed";
export type SecurityUpdateIssueReasonCode =
  | "migration_required"
  | "secret_missing"
  | "field_invalid"
  | "write_conflict"
  | "validation_failed"
  | "environment_blocked";
export type SecurityUpdateIssueAction =
  | "open_connection"
  | "open_proxy_settings"
  | "open_ai_settings"
  | "retry_update"
  | "view_details";

export interface SecurityUpdateSummary {
  total: number;
  updated: number;
  pending: number;
  skipped: number;
  failed: number;
}

export interface SecurityUpdateIssue {
  id: string;
  scope?: SecurityUpdateIssueScope;
  refId?: string;
  title?: string;
  severity?: SecurityUpdateIssueSeverity;
  status?: SecurityUpdateItemStatus;
  reasonCode?: SecurityUpdateIssueReasonCode;
  action?: SecurityUpdateIssueAction;
  message?: string;
}

export interface SecurityUpdateStatus {
  schemaVersion?: number;
  migrationId?: string;
  overallStatus: SecurityUpdateOverallStatus;
  sourceType?: "current_app_saved_config";
  reminderVisible?: boolean;
  canStart?: boolean;
  canPostpone?: boolean;
  canRetry?: boolean;
  backupAvailable?: boolean;
  backupPath?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  postponedAt?: string;
  summary: SecurityUpdateSummary;
  issues: SecurityUpdateIssue[];
  lastError?: string;
}
