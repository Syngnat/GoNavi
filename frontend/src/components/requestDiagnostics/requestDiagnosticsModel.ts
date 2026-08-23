export type RequestTraceStatus = 'running' | 'success' | 'error' | 'cancelled' | string;

export interface RequestTraceEvent {
  timestamp: number;
  name: string;
  details?: Record<string, string>;
}

export interface RequestTraceRecord {
  requestId: string;
  entry: string;
  operation: string;
  dataSourceType?: string;
  driverMode?: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  deadlineAt?: number;
  status: RequestTraceStatus;
  cancellation?: {
    requested?: boolean;
    requestedAt?: number;
    accepted?: boolean;
    outcome?: string;
  };
  responseBytes?: number;
  responseBytesExact?: boolean;
  pagination?: {
    mode?: string;
    resultSetCount?: number;
    returnedRows?: number;
    truncated?: boolean;
    pageSize?: number;
    continuationKey?: boolean;
  };
  retryCount?: number;
  error?: {
    kind?: string;
    message?: string;
  };
  events?: RequestTraceEvent[];
}

export interface RequestTracePage {
  items: RequestTraceRecord[];
  total: number;
}

export const emptyRequestTracePage = (): RequestTracePage => ({ items: [], total: 0 });

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const asNumber = (value: unknown): number => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : 0;
};

const asString = (value: unknown): string => typeof value === 'string' ? value : '';

const normalizeEvent = (value: unknown): RequestTraceEvent => {
  const raw = asRecord(value);
  const details = asRecord(raw.details);
  return {
    timestamp: asNumber(raw.timestamp),
    name: asString(raw.name),
    details: Object.keys(details).length > 0
      ? Object.fromEntries(Object.entries(details).map(([key, detail]) => [key, String(detail)]))
      : undefined,
  };
};

export const normalizeRequestTrace = (value: unknown): RequestTraceRecord => {
  const raw = asRecord(value);
  const cancellation = asRecord(raw.cancellation);
  const pagination = asRecord(raw.pagination);
  const error = asRecord(raw.error);
  return {
    requestId: asString(raw.requestId),
    entry: asString(raw.entry),
    operation: asString(raw.operation),
    dataSourceType: asString(raw.dataSourceType),
    driverMode: asString(raw.driverMode),
    startedAt: asNumber(raw.startedAt),
    finishedAt: asNumber(raw.finishedAt),
    durationMs: asNumber(raw.durationMs),
    deadlineAt: asNumber(raw.deadlineAt),
    status: asString(raw.status) || 'running',
    cancellation: {
      requested: cancellation.requested === true,
      requestedAt: asNumber(cancellation.requestedAt),
      accepted: typeof cancellation.accepted === 'boolean' ? cancellation.accepted : undefined,
      outcome: asString(cancellation.outcome),
    },
    responseBytes: asNumber(raw.responseBytes),
    responseBytesExact: raw.responseBytesExact === true,
    pagination: {
      mode: asString(pagination.mode),
      resultSetCount: asNumber(pagination.resultSetCount),
      returnedRows: asNumber(pagination.returnedRows),
      truncated: pagination.truncated === true,
      pageSize: asNumber(pagination.pageSize),
      continuationKey: pagination.continuationKey === true,
    },
    retryCount: asNumber(raw.retryCount),
    error: Object.keys(error).length > 0 ? {
      kind: asString(error.kind),
      message: asString(error.message),
    } : undefined,
    events: Array.isArray(raw.events) ? raw.events.map(normalizeEvent) : [],
  };
};

export const normalizeRequestTracePage = (value: unknown): RequestTracePage => {
  const raw = asRecord(value);
  const items = Array.isArray(raw.items) ? raw.items.map(normalizeRequestTrace) : [];
  return {
    items,
    total: Math.max(items.length, asNumber(raw.total)),
  };
};

export const requestTraceStatusColor = (status: RequestTraceStatus): string => {
  switch (status) {
    case 'success': return 'success';
    case 'error': return 'error';
    case 'cancelled': return 'warning';
    case 'running': return 'processing';
    default: return 'default';
  }
};

export const formatTraceBytes = (bytes: number, exact: boolean): string => {
  if (bytes <= 0) return '-';
  const prefix = exact ? '' : '≥ ';
  if (bytes < 1024) return `${prefix}${bytes} B`;
  if (bytes < 1024 * 1024) return `${prefix}${(bytes / 1024).toFixed(1)} KB`;
  return `${prefix}${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
