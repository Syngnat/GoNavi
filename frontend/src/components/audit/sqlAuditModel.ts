export type SQLAuditEventStatus = 'success' | 'error' | 'cancelled' | string;

export interface SQLAuditEvent {
  id: string;
  sequence: number;
  timestamp: number;
  eventType: string;
  status: SQLAuditEventStatus;
  connectionId: string;
  connectionFingerprint: string;
  dbType: string;
  database: string;
  queryId: string;
  transactionId: string;
  source: string;
  commitMode: string;
  boundaryMode: string;
  sqlText: string;
  sqlRedacted: boolean;
  sqlFingerprint: string;
  statementIndex: number;
  statementCount: number;
  executedCount: number;
  failedIndex: number;
  outcomeUnknown: boolean;
  durationMs: number;
  rowsAffected?: number;
  rowsReturned?: number;
  error: string;
  prevHash: string;
  hash: string;
}

export interface SQLAuditSummary {
  totalEvents: number;
  successCount: number;
  errorCount: number;
  transactionCount: number;
  cancelledCount: number;
}

export interface SQLAuditFilter {
  search: string;
  connectionId: string;
  database: string;
  dbType: string;
  eventType: string;
  status: string;
  transactionId: string;
  source: string;
  fromTimestamp?: number;
  toTimestamp?: number;
  page: number;
  pageSize: number;
}

export interface SQLAuditPage {
  items: SQLAuditEvent[];
  total: number;
  page: number;
  pageSize: number;
  summary: SQLAuditSummary;
}

export interface SQLAuditSettings {
  enabled: boolean;
  captureMode: 'redacted' | 'metadata';
  retentionDays: number;
  maxRecords: number;
}

export interface SQLAuditHealth {
  status: 'healthy' | 'degraded' | 'unknown';
  captureEnabled: boolean | null;
  captureMode: 'redacted' | 'metadata' | 'unknown';
  droppedEvents: number;
  firstFailureAt: number;
  lastFailureAt: number;
  lastSuccessAt: number;
  lastError: string;
}

export type SQLAuditHealthPhase = 'healthy' | 'disabled' | 'degraded' | 'recovered' | 'historical_gap' | 'unknown';
export type SQLAuditRecoveryState = 'complete' | 'redacted' | 'metadata';

export const DEFAULT_SQL_AUDIT_FILTER: SQLAuditFilter = {
  search: '',
  connectionId: '',
  database: '',
  dbType: '',
  eventType: '',
  status: '',
  transactionId: '',
  source: '',
  page: 1,
  pageSize: 50,
};

export const DEFAULT_SQL_AUDIT_SETTINGS: SQLAuditSettings = {
  enabled: true,
  captureMode: 'redacted',
  retentionDays: 30,
  maxRecords: 100_000,
};

export const SQL_AUDIT_EVENT_TYPES = [
  'query',
  'query_statement',
  'transaction_begin',
  'transaction_statement',
  'transaction_commit_requested',
  'transaction_commit',
  'transaction_rollback_requested',
  'transaction_rollback',
  'transaction_auto_rollback',
  'audit_gap',
  'audit_settings_change',
  'audit_clear',
] as const;

export const SQL_AUDIT_STATUSES = ['success', 'error', 'cancelled'] as const;

export const SQL_AUDIT_SOURCES = [
  'query_editor',
  'sql_file',
  'sync',
  'mcp',
  'system',
  'tab_close',
  'app_shutdown',
  'data_editor',
  'data_import',
  'table_designer',
  'object_editor',
  'message_publish',
  'ai_action',
  'application_api',
  'audit_control',
] as const;

export const getSQLAuditEnumLabelKey = (
  kind: 'event_type' | 'status' | 'source',
  value: string,
): string | null => {
  const normalized = String(value || '').trim().toLowerCase();
  const knownValues = kind === 'event_type'
    ? SQL_AUDIT_EVENT_TYPES
    : kind === 'status'
      ? SQL_AUDIT_STATUSES
      : SQL_AUDIT_SOURCES;
  return (knownValues as readonly string[]).includes(normalized)
    ? `sql_audit.${kind}.${normalized}`
    : null;
};

const toStringValue = (value: unknown): string => String(value ?? '').trim();

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const toOptionalFiniteNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

export const normalizeSQLAuditEvent = (value: unknown, index = 0): SQLAuditEvent => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawBoundaryMode = toStringValue(raw.boundaryMode);
  const boundaryMode = ['driver_api', 'text_sql', 'implicit'].includes(rawBoundaryMode)
    ? rawBoundaryMode
    : 'unknown';
  return {
    id: toStringValue(raw.id) || `sql-audit-${index + 1}`,
    sequence: Math.max(0, toFiniteNumber(raw.sequence)),
    timestamp: Math.max(0, toFiniteNumber(raw.timestamp)),
    eventType: toStringValue(raw.eventType) || 'query',
    status: toStringValue(raw.status) || 'success',
    connectionId: toStringValue(raw.connectionId),
    connectionFingerprint: toStringValue(raw.connectionFingerprint),
    dbType: toStringValue(raw.dbType),
    database: toStringValue(raw.database),
    queryId: toStringValue(raw.queryId),
    transactionId: toStringValue(raw.transactionId),
    source: toStringValue(raw.source),
    commitMode: toStringValue(raw.commitMode),
    boundaryMode,
    sqlText: typeof raw.sqlText === 'string' ? raw.sqlText : '',
    sqlRedacted: raw.sqlRedacted === true,
    sqlFingerprint: toStringValue(raw.sqlFingerprint),
    statementIndex: Math.max(0, toFiniteNumber(raw.statementIndex)),
    statementCount: Math.max(0, toFiniteNumber(raw.statementCount)),
    executedCount: Math.max(0, toFiniteNumber(raw.executedCount)),
    failedIndex: Math.max(0, toFiniteNumber(raw.failedIndex)),
    outcomeUnknown: raw.outcomeUnknown === true,
    durationMs: Math.max(0, toFiniteNumber(raw.durationMs)),
    rowsAffected: toOptionalFiniteNumber(raw.rowsAffected),
    rowsReturned: toOptionalFiniteNumber(raw.rowsReturned),
    error: toStringValue(raw.error ?? raw.errorMessage),
    prevHash: toStringValue(raw.prevHash),
    hash: toStringValue(raw.hash),
  };
};

const normalizeSQLAuditSummary = (value: unknown, total: number): SQLAuditSummary => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    totalEvents: Math.max(0, toFiniteNumber(raw.totalEvents ?? raw.total, total)),
    successCount: Math.max(0, toFiniteNumber(raw.successCount ?? raw.success)),
    errorCount: Math.max(0, toFiniteNumber(raw.errorCount ?? raw.error)),
    transactionCount: Math.max(0, toFiniteNumber(raw.transactionCount ?? raw.transactions)),
    cancelledCount: Math.max(0, toFiniteNumber(raw.cancelledCount ?? raw.cancelled)),
  };
};

export const normalizeSQLAuditPage = (value: unknown, fallback: Pick<SQLAuditFilter, 'page' | 'pageSize'>): SQLAuditPage => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const items = Array.isArray(raw.items)
    ? raw.items.map((item, index) => normalizeSQLAuditEvent(item, index))
    : [];
  const total = Math.max(items.length, toFiniteNumber(raw.total, items.length));
  return {
    items,
    total,
    page: Math.max(1, toFiniteNumber(raw.page, fallback.page)),
    pageSize: Math.max(1, toFiniteNumber(raw.pageSize, fallback.pageSize)),
    summary: normalizeSQLAuditSummary(raw.summary, total),
  };
};

export const normalizeSQLAuditSettings = (value: unknown): SQLAuditSettings => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const captureMode = raw.captureMode === 'metadata' ? 'metadata' : 'redacted';
  return {
    enabled: raw.enabled !== false,
    captureMode,
    retentionDays: Math.max(1, Math.round(toFiniteNumber(raw.retentionDays, DEFAULT_SQL_AUDIT_SETTINGS.retentionDays))),
    maxRecords: Math.max(100, Math.round(toFiniteNumber(raw.maxRecords, DEFAULT_SQL_AUDIT_SETTINGS.maxRecords))),
  };
};

export const normalizeSQLAuditHealth = (value: unknown): SQLAuditHealth => {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawStatus = toStringValue(raw.status).toLowerCase();
  const status = rawStatus === 'healthy' || rawStatus === 'degraded' ? rawStatus : 'unknown';
  const rawCaptureMode = toStringValue(raw.captureMode).toLowerCase();
  const captureMode = rawCaptureMode === 'redacted' || rawCaptureMode === 'metadata'
    ? rawCaptureMode
    : 'unknown';
  return {
    status,
    captureEnabled: typeof raw.captureEnabled === 'boolean' ? raw.captureEnabled : null,
    captureMode,
    droppedEvents: Math.max(0, Math.round(toFiniteNumber(raw.droppedEvents))),
    firstFailureAt: Math.max(0, toFiniteNumber(raw.firstFailureAt)),
    lastFailureAt: Math.max(0, toFiniteNumber(raw.lastFailureAt)),
    lastSuccessAt: Math.max(0, toFiniteNumber(raw.lastSuccessAt)),
    lastError: toStringValue(raw.lastError),
  };
};

export const getSQLAuditHealthPhase = (health: SQLAuditHealth): SQLAuditHealthPhase => {
  if (health.status === 'degraded') return 'degraded';
  if (health.status !== 'healthy') return 'unknown';
  if (health.captureEnabled === null || health.captureMode === 'unknown') return 'unknown';
  if (health.captureEnabled === false) return 'disabled';
  if (health.droppedEvents <= 0) return 'healthy';
  if (health.lastFailureAt > 0 && health.lastSuccessAt >= health.lastFailureAt) return 'recovered';
  return 'historical_gap';
};

export const buildSQLAuditFilterPayload = (
  filter: SQLAuditFilter,
  options: { executionHistory?: boolean } = {},
): Record<string, string | number | boolean> => {
  const payload: Record<string, string | number | boolean> = {
    page: Math.max(1, Math.round(filter.page)),
    pageSize: Math.max(1, Math.round(filter.pageSize)),
  };
  const stringFields = [
    'search',
    'connectionId',
    'database',
    'dbType',
    'eventType',
    'status',
    'transactionId',
    'source',
  ] as const;
  stringFields.forEach((field) => {
    const value = String(filter[field] || '').trim();
    if (value) payload[field] = value;
  });
  if (Number.isFinite(filter.fromTimestamp)) payload.fromTimestamp = Number(filter.fromTimestamp);
  if (Number.isFinite(filter.toTimestamp)) payload.toTimestamp = Number(filter.toTimestamp);
  if (options.executionHistory === true) payload.executionHistory = true;
  return payload;
};

export const getSQLAuditEventPreview = (event: SQLAuditEvent, maxLength = 180): string => {
  const normalized = event.sqlText.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
};

export const getSQLAuditRecoveryState = (
  event: Pick<SQLAuditEvent, 'sqlText' | 'sqlRedacted'>,
): SQLAuditRecoveryState => {
  if (!String(event.sqlText || '').trim()) return 'metadata';
  return event.sqlRedacted ? 'redacted' : 'complete';
};

export const isSQLAuditEventRestorable = (
  event: Pick<SQLAuditEvent, 'eventType' | 'sqlText' | 'sqlRedacted'>,
): boolean => (
  getSQLAuditRecoveryState(event) !== 'metadata'
  && ['query', 'query_statement', 'transaction_statement', 'transaction_begin']
    .includes(String(event.eventType || '').trim().toLowerCase())
);

export const getSQLAuditPrimaryRowCount = (event: Pick<SQLAuditEvent, 'rowsAffected' | 'rowsReturned'>): number => {
  const rowsReturned = Math.max(0, toFiniteNumber(event.rowsReturned));
  return rowsReturned > 0
    ? rowsReturned
    : Math.max(0, toFiniteNumber(event.rowsAffected));
};

export const sortSQLAuditTimeline = (events: SQLAuditEvent[]): SQLAuditEvent[] => (
  [...events].sort((left, right) => (
    left.sequence - right.sequence
    || left.timestamp - right.timestamp
    || left.statementIndex - right.statementIndex
  ))
);
