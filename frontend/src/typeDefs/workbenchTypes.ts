import type { WorkbenchTabType } from '../tabTypes';
import type { JVMDiagnosticTransport } from './jvmTypes';

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
  /** ROW or STATEMENT when the backend exposes trigger firing granularity. */
  orientation?: string;
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
  | "cancelling"
  | "done"
  | "error"
  | "cancelled";

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
  type: WorkbenchTabType;
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
  triggerRollbackSql?: string; // Original trigger definition used after a failed replacement
  viewName?: string; // View name for view definition tabs
  viewKind?: "view" | "materialized";
  eventName?: string; // Event name for MySQL event definition tabs
  routineName?: string; // Routine name for function/procedure definition tabs
  routineType?: string; // 'FUNCTION' or 'PROCEDURE'
  sequenceName?: string; // Sequence name for sequence definition tabs
  packageName?: string; // Package name for package definition tabs
  databaseLinkName?: string; // Oracle database link name for definition tabs
  schemaName?: string; // Schema / owner name for schema-grouped objects
  sidebarLocateKey?: string; // Precise sidebar tree key for locating an object node
  savedQueryId?: string; // Saved query identity for quick-save behavior
  objectType?: 'table' | 'view' | 'materialized-view'; // Table-like object type for shared viewers
  exportWorkbenchMode?: 'single' | 'batch-tables' | 'batch-databases' | 'batch-connections' | 'database' | 'schema';
  dataSyncEntryMode?: 'sync' | 'compare' | 'schemaCompare' | 'dataCompare';
  dataSyncFocusTaskId?: string;
  dataSyncFocusStage?: 'endpoints' | 'mappings' | 'delivery' | 'trigger' | 'preflight';
  dataSyncFocusRequestId?: string;
  tableExportScopeOptions?: TableExportScopeOption[];
  tableExportInitialScope?: TableExportScope;
  tableExportQueryByScope?: Partial<Record<TableExportScope, string>>;
  tableExportRowCountByScope?: Partial<Record<TableExportScope, number>>;
  tableExportInitialObjectNames?: string[];
  tableExportInitialDatabaseNames?: string[];
  tableExportInitialConnectionIds?: string[];
  tableExportContentMode?: TableExportContentMode;
  tableExportIncludeDropIfExists?: boolean;
  tableExportLaunchKey?: string;
  tableExportRequestKey?: string;
  dataImportMode?: "table" | "database";
  dataImportLaunchKey?: string;
  dataImportRunning?: boolean;
  sqlFileExecutionRequestKey?: string;
  sqlFileExecutionFileName?: string;
  sqlFileExecutionFileSizeMB?: string;
  sqlAnalysisView?: "diagnose" | "slow-query";
  sqlAnalysisRequestKey?: string;
  sqlAuditView?: "audit" | "query-history";
  sqlAuditTransactionId?: string;
  sqlAuditRequestKey?: string;
  preserveUnboundConnection?: boolean;
  /** Message queue workbench target requested by the sidebar. */
  messageQueueTarget?: string;
  messageQueueObjectKind?: "topic-filter" | "topic" | "queue" | "exchange";
  messageQueueAction?: "open" | "consume" | "publish";
  /** Changes whenever an existing workbench should react to a new sidebar request. */
  messageQueueRequestKey?: string;
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
  parameters?: SavedQueryParam[];
}

export interface SavedQueryParam {
  name: string;
  type?: string;
  label?: string;
  default?: unknown;
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
  fileBindings?: ExternalSQLFileBinding[];
  createdAt: number;
}

export interface ExternalSQLFileBinding {
  filePath: string;
  connectionId: string;
  dbName: string;
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
