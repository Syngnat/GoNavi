import type { TabData } from '../../types';

export type ScriptVisibility = 'private' | 'shared';
export const SCRIPT_MAX_OUTPUT_STREAMS = 32;
export const SCRIPT_MAX_LOG_ENTRIES = 500;

export interface ScriptConnectionBinding {
  alias: string;
  connectionId?: string;
  database?: string;
}

export interface ScriptInputBinding {
  alias: string;
  path?: string;
  reference?: string;
  name?: string;
  sheetName?: string;
  encoding?: string;
  delimiter?: string;
  headerRow?: number;
}

export interface ScriptRunLimitValues {
  timeoutMs?: number;
  maxDbCalls?: number;
  maxOutputRows?: number;
  memoryLimitBytes?: number;
}

export interface ScriptLibraryScript {
  id: string;
  name: string;
  description?: string;
  code: string;
  owner: string;
  visibility: ScriptVisibility;
  folderId?: string;
  connections: ScriptConnectionBinding[];
  inputs: ScriptInputBinding[];
  allowWrite: boolean;
  batchSize: number;
  inListLimit: number;
  runLimits?: ScriptRunLimitValues;
  revision: number;
  canEdit?: boolean;
  canShare?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ScriptLibraryFolder {
  id: string;
  name: string;
  parentId?: string;
  owner: string;
  visibility: ScriptVisibility;
  revision: number;
  canEdit?: boolean;
  canShare?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ScriptLibrarySnapshot {
  owner: string;
  scripts: ScriptLibraryScript[];
  folders: ScriptLibraryFolder[];
  canWrite: boolean;
  canShare: boolean;
  sharedOnly: boolean;
  canManageShared?: boolean;
  sharedScriptingDisabled?: boolean;
}

export interface SaveScriptInput {
  id?: string;
  name: string;
  description?: string;
  code: string;
  visibility: ScriptVisibility;
  folderId?: string;
  connections: ScriptConnectionBinding[];
  inputs: ScriptInputBinding[];
  allowWrite: boolean;
  batchSize: number;
  inListLimit: number;
  runLimits?: ScriptRunLimitValues;
  revision: number;
}

export interface SaveScriptFolderInput {
  id?: string;
  name: string;
  parentId?: string;
  visibility: ScriptVisibility;
  revision: number;
}

export interface DeleteScriptInput {
  id: string;
  revision: number;
}

export interface ShareScriptInput {
  id: string;
  revision: number;
  visibility: ScriptVisibility;
}

export interface ScriptRunLimits {
  timeoutMs: number;
  maxDbCalls: number;
  maxOutputRows?: number;
  memoryLimitBytes?: number;
  defaultBatch: number;
  maxBatch: number;
  defaultInList: number;
  maxInList: number;
  defaultQueryRows: number;
  maxQueryRows: number;
}

export interface ScriptRunRequest {
  scriptId?: string;
  script: string;
  connections: ScriptConnectionBinding[];
  inputs: ScriptInputBinding[];
  allowWrite: boolean;
  confirmationToken?: string;
  limits: ScriptRunLimits;
}

export interface ScriptWriteAuthorizationRequest {
  scriptId?: string;
  script: string;
  connections: ScriptConnectionBinding[];
  inputs: ScriptInputBinding[];
  allowWrite: boolean;
  batchSize: number;
  inListLimit: number;
  timeoutMs: number;
  maxDbCalls?: number;
  maxOutputRows?: number;
  memoryLimitBytes?: number;
}

export interface ScriptWriteAuthorization {
  requiresConfirmation?: boolean;
  confirmationToken?: string;
}

export type ScriptCellValue = string | number | boolean | null | undefined;
export type ScriptResultRow = Record<string, ScriptCellValue>;

export interface ScriptOutputPage {
  outputId: string;
  name: string;
  columns: string[];
  rows: ScriptResultRow[];
  page: number;
  pageSize: number;
  totalRows: number;
  truncated?: boolean;
}

export interface ScriptAuditEntry {
  id: string;
  at: number;
  connectionAlias: string;
  database: string;
  sql: string;
  durationMs: number;
  rowCount?: number;
  write: boolean;
}

export interface ScriptLogEntry {
  id: string;
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export interface ScriptRunProgress {
  current: number;
  total?: number;
  message?: string;
  startedAt: number;
  elapsedMs: number;
}

export interface ScriptRunResult {
  success: boolean;
  message?: string;
  errorKind?: 'script' | 'backend' | string;
  durationMs: number;
  cancelled?: boolean;
  timedOut?: boolean;
  memoryExceeded?: boolean;
  outcomeUnknown?: boolean;
  auditsTruncated?: boolean;
  logsTruncated?: boolean;
  outputsTruncated?: boolean;
}

export type ScriptRunEvent =
  | { type: 'log'; log: ScriptLogEntry }
  | { type: 'progress'; progress: ScriptRunProgress }
  | { type: 'output'; output: ScriptOutputPage }
  | { type: 'audit'; audit: ScriptAuditEntry }
  | { type: 'result'; result: ScriptRunResult };

export interface ScriptRunObserver {
  onEvent: (event: ScriptRunEvent) => void;
}

export interface ScriptRunReceipt {
  runId: string;
  startedAt: number;
}

export interface ScriptWorkbenchAdapter {
  listLibrary(): Promise<ScriptLibrarySnapshot>;
  getScript(id: string): Promise<ScriptLibraryScript>;
  saveScript(input: SaveScriptInput): Promise<ScriptLibraryScript>;
  saveFolder(input: SaveScriptFolderInput): Promise<ScriptLibraryFolder>;
  deleteScript(input: DeleteScriptInput): Promise<void>;
  deleteFolder(input: DeleteScriptInput): Promise<void>;
  shareScript(input: ShareScriptInput): Promise<ScriptLibraryScript>;
  shareFolder(input: ShareScriptInput): Promise<ScriptLibraryFolder>;
  chooseInputFile(): Promise<ScriptInputBinding | null>;
  listInputSheets(input: ScriptInputBinding): Promise<string[]>;
  authorizeWrite(
    request: ScriptWriteAuthorizationRequest,
    signal?: AbortSignal,
  ): Promise<ScriptWriteAuthorization>;
  runScript(
    request: ScriptRunRequest,
    observer: ScriptRunObserver,
    signal?: AbortSignal,
  ): Promise<ScriptRunReceipt>;
  cancelRun(runId: string, signal?: AbortSignal): Promise<void>;
  getOutputPage(outputId: string, page: number, pageSize: number, signal?: AbortSignal): Promise<ScriptOutputPage>;
  dispose?: () => void;
}

export type ScriptRunStatus =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'memory_exceeded'
  | 'outcome_unknown';

export interface ScriptWorkbenchProps {
  tab: TabData;
  isActive?: boolean;
  adapter?: ScriptWorkbenchAdapter;
}

export interface ScriptDraft {
  draftInstanceId: string;
  id?: string;
  owner?: string;
  canEdit?: boolean;
  canShare?: boolean;
  name: string;
  description: string;
  source: string;
  visibility: ScriptVisibility;
  folderId?: string;
  revision: number;
  connections: ScriptConnectionBinding[];
  inputs: ScriptInputBinding[];
  allowWrite: boolean;
  batchSize: number;
  inListLimit: number;
  runLimits?: ScriptRunLimitValues;
}

export interface ScriptDraftSnapshot {
  draft: ScriptDraft;
  epoch: number;
  dirty: boolean;
}
