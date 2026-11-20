import type {
  ScriptConnectionBinding,
  ScriptInputBinding,
  ScriptLibraryFolder,
  ScriptLibraryScript,
  ScriptVisibility,
} from './scriptWorkbenchTypes';

export interface QueryResult<T = unknown> {
  success?: boolean;
  message?: string;
  code?: string;
  kind?: 'script' | 'backend' | string;
  params?: Record<string, string | number>;
  data?: T;
}

export interface BackendScript extends Partial<Omit<ScriptLibraryScript, 'visibility'>> {
  visibility?: ScriptVisibility;
  connections?: ScriptConnectionBinding[];
  inputs?: ScriptInputBinding[];
}

export interface BackendSnapshot {
  owner?: string;
  scripts?: BackendScript[];
  folders?: Array<Partial<ScriptLibraryFolder>>;
  canWrite?: boolean;
  canShare?: boolean;
  sharedOnly?: boolean;
  canManageShared?: boolean;
  sharedScriptingDisabled?: boolean;
}

export interface BackendRunSnapshot {
  runId: string;
  status?: string;
  stage?: string;
  startedAt?: number;
  finishedAt?: number;
  cancelled?: boolean;
  timedOut?: boolean;
  memoryExceeded?: boolean;
  errorKind?: string;
  error?: string;
  dbCalls?: number;
  logsTruncated?: boolean;
  outputsTruncated?: boolean;
  progress?: Record<string, unknown>;
  logs?: Array<{
    sequence?: number;
    timestamp?: number;
    level?: string;
    message?: string;
  }>;
  outputs?: Array<{
    index?: number;
    name?: string;
    columns?: string[];
    rowCount?: number;
    truncated?: boolean;
  }>;
}

export interface BackendOutputPage {
  outputIndex?: number;
  name?: string;
  columns?: string[];
  rows?: Array<Record<string, unknown>>;
  total?: number;
  page?: number;
  pageSize?: number;
  truncated?: boolean;
}

export interface BackendAuditEvent {
  id?: string;
  timestamp?: number;
  connectionId?: string;
  database?: string;
  runId?: string;
  sqlText?: string;
  durationMs?: number;
  rowsReturned?: number;
  rowsAffected?: number;
  source?: string;
  userName?: string;
}

export interface BackendAuditPage {
  items?: BackendAuditEvent[];
  total?: number;
}

export interface BackendWriteAuthorization {
  required?: boolean;
  token?: string;
  requiresConfirmation?: boolean;
  confirmationToken?: string;
}
