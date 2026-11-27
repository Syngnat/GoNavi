import { isWebRPCAbortError } from '../../utils/webRpc';

export const QUERY_PROGRESS_EVENT_NAME = 'query:progress';

export const QUERY_EXECUTION_STALL_MS = 5000;

export type QueryExecutionProgressStatus =
  | 'running'
  | 'cancelling'
  | 'done'
  | 'cancelled'
  | 'error';

export type QueryExecutionProgressEvent = {
  queryId?: string;
  status?: QueryExecutionProgressStatus | string;
  stage?: string;
  elapsedMs?: number;
  durationMs?: number;
  hasDurationMs?: boolean;
  cancellable?: boolean;
  affectedRows?: number;
  hasAffectedRows?: boolean;
  message?: string;
  outcomeUnknown?: boolean;
  cancellationState?: string;
};

export type QueryEditorExecutionLifecycleStatus =
  | 'idle'
  | 'starting'
  | 'running'
  | 'cancelling'
  | 'stalled'
  | 'done'
  | 'cancelled'
  | 'error';

export type QueryEditorExecutionLifecycleState = {
  queryId: string;
  status: QueryEditorExecutionLifecycleStatus;
  stage: string;
  elapsedMs: number;
  durationMs: number | null;
  hasDurationMs: boolean;
  lastEventAt: number;
  cancellable: boolean;
  affectedRows: number | null;
  hasAffectedRows: boolean;
  message: string;
  outcomeUnknown: boolean;
  backendAlive: boolean;
};

export const createIdleQueryEditorExecutionLifecycle = (): QueryEditorExecutionLifecycleState => ({
  queryId: '',
  status: 'idle',
  stage: '',
  elapsedMs: 0,
  durationMs: null,
  hasDurationMs: false,
  lastEventAt: 0,
  cancellable: false,
  affectedRows: null,
  hasAffectedRows: false,
  message: '',
  outcomeUnknown: false,
  backendAlive: false,
});

export const normalizeQueryExecutionProgressEvent = (
  payload: unknown,
): QueryExecutionProgressEvent | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const event = payload as QueryExecutionProgressEvent;
  const queryId = String(event.queryId || '').trim();
  if (!queryId) {
    return null;
  }
  const rawElapsedMs = event.elapsedMs as unknown;
  const hasElapsedMs = rawElapsedMs !== undefined && rawElapsedMs !== null && rawElapsedMs !== ''
    && Number.isFinite(Number(rawElapsedMs));
  const elapsedMs = hasElapsedMs ? Math.max(0, Math.round(Number(rawElapsedMs))) : undefined;
  const rawDurationMs = event.durationMs as unknown;
  const hasDurationMs = event.hasDurationMs === true
    && rawDurationMs !== undefined
    && rawDurationMs !== null
    && rawDurationMs !== ''
    && Number.isFinite(Number(rawDurationMs))
    && Number(rawDurationMs) >= 0;
  const durationMs = hasDurationMs ? Math.round(Number(rawDurationMs)) : undefined;
  return {
    ...event,
    queryId,
    status: String(event.status || '').trim().toLowerCase(),
    stage: String(event.stage || '').trim(),
    elapsedMs,
    durationMs,
    hasDurationMs,
    cancellable: event.cancellable === true,
    affectedRows: Number.isFinite(Number(event.affectedRows)) ? Number(event.affectedRows) : undefined,
    hasAffectedRows: event.hasAffectedRows === true,
    message: String(event.message || ''),
    outcomeUnknown: event.outcomeUnknown === true,
    cancellationState: String(event.cancellationState || ''),
  };
};

export const reduceQueryEditorExecutionLifecycle = (
  current: QueryEditorExecutionLifecycleState,
  payload: unknown,
  now: number,
): QueryEditorExecutionLifecycleState => {
  const event = normalizeQueryExecutionProgressEvent(payload);
  if (!event || !event.queryId) {
    return current;
  }
  const isNewQuery = current.queryId !== event.queryId;
  if (current.queryId && isNewQuery && isActiveQueryEditorExecutionStatus(current.status)) {
    return current;
  }
  if (
    !isNewQuery
    && !isActiveQueryEditorExecutionStatus(current.status)
    && current.status !== 'idle'
    && String(event.status || '') === 'running'
  ) {
    return current;
  }
  const status = mapQueryExecutionProgressStatus(event.status, isNewQuery ? 'idle' : current.status);
  const nextElapsedMs = event.status === 'cancelling'
    ? (isNewQuery ? 0 : current.elapsedMs)
    : event.hasDurationMs
      ? (event.durationMs ?? 0)
      : typeof event.elapsedMs === 'number'
        ? event.elapsedMs
        : (isNewQuery ? 0 : current.elapsedMs);
  const nextDurationMs = event.hasDurationMs
    ? (event.durationMs ?? 0)
    : status === 'running'
      ? null
      : (isNewQuery ? null : current.durationMs);
  const nextHasDurationMs = event.hasDurationMs
    ? true
    : status === 'running'
      ? false
      : (isNewQuery ? false : current.hasDurationMs);
  return {
    queryId: event.queryId,
    status,
    stage: event.stage || (isNewQuery ? '' : current.stage),
    elapsedMs: nextElapsedMs,
    durationMs: nextDurationMs,
    hasDurationMs: nextHasDurationMs,
    lastEventAt: now,
    cancellable: event.cancellable === true,
    affectedRows: event.hasAffectedRows ? Number(event.affectedRows || 0) : (isNewQuery ? null : current.affectedRows),
    hasAffectedRows: event.hasAffectedRows === true || (!isNewQuery && current.hasAffectedRows),
    message: event.message || (isNewQuery ? '' : current.message),
    outcomeUnknown: event.outcomeUnknown === true || (!isNewQuery && current.outcomeUnknown),
    backendAlive: status === 'running' || status === 'cancelling' || status === 'stalled',
  };
};

export const markQueryEditorExecutionStalled = (
  current: QueryEditorExecutionLifecycleState,
  now: number,
  stallMs = QUERY_EXECUTION_STALL_MS,
): QueryEditorExecutionLifecycleState => {
  if (!isActiveQueryEditorExecutionStatus(current.status)) {
    return current;
  }
  if (current.status === 'stalled') {
    return current;
  }
  if (now - current.lastEventAt < stallMs) {
    return current;
  }
  return { ...current, status: 'stalled', backendAlive: true };
};

export const isTerminalQueryEditorExecutionStatus = (
  status: QueryEditorExecutionLifecycleStatus,
): boolean => status === 'done' || status === 'cancelled' || status === 'error';

export const resolveVisibleQueryEditorExecutionLifecycle = (
  loading: boolean,
  lifecycle: QueryEditorExecutionLifecycleState | null | undefined,
): QueryEditorExecutionLifecycleState | null => {
  // After a successful RPC, loading drops before the done event is applied.
  // A leftover "running" heartbeat must not keep the results banner spinning.
  if (!loading) {
    return null;
  }
  if (lifecycle && isActiveQueryEditorExecutionStatus(lifecycle.status)) {
    return lifecycle;
  }
  if (lifecycle && isTerminalQueryEditorExecutionStatus(lifecycle.status)) {
    return null;
  }
  return {
    ...createIdleQueryEditorExecutionLifecycle(),
    status: 'starting',
    backendAlive: true,
  };
};

export const isActiveQueryEditorExecutionStatus = (
  status: QueryEditorExecutionLifecycleStatus,
): boolean => status === 'starting' || status === 'running' || status === 'cancelling' || status === 'stalled';

export const shouldApplyQueryExecutionProgressEvent = (
  ownedQueryId: string,
  eventQueryId: string | undefined,
): boolean => {
  const owned = String(ownedQueryId || '').trim();
  const eventId = String(eventQueryId || '').trim();
  return Boolean(owned && eventId && owned === eventId);
};

export const shouldRetainQueryEditorRun = (
  state: QueryEditorExecutionLifecycleState | null | undefined,
): boolean => Boolean(state && isActiveQueryEditorExecutionStatus(state.status) && state.backendAlive);

// Keep loading only when the RPC vanished while the backend is still alive.
// A finished SELECT must not stay "running" just because the last event was a heartbeat.
export const shouldRetainQueryEditorRunAfterRpc = (
  rpcLostWithoutResult: boolean,
  state: QueryEditorExecutionLifecycleState | null | undefined,
): boolean => rpcLostWithoutResult && shouldRetainQueryEditorRun(state);

export const shouldFinishQueryEditorRunAfterCancelMiss = (
  result: { success?: boolean; cancellationState?: unknown } | null | undefined,
  editorStillLoading: boolean,
): boolean => {
  if (result?.success === true) {
    return false;
  }
  if (String(result?.cancellationState || '').trim().toLowerCase() === 'unsupported') {
    return false;
  }
  return editorStillLoading;
};

export const shouldRetainQueryEditorRunAfterRpcFailure = (
  error: unknown,
  state: QueryEditorExecutionLifecycleState | null | undefined,
): boolean => {
  if (!shouldRetainQueryEditorRun(state)) {
    return false;
  }
  if (isWebRPCAbortError(error) && error.dispatchState === 'not_started') {
    return false;
  }
  return true;
};

export const isQueryEditorCancelledRpcError = (error: unknown): boolean => {
  const message = String(
    (error as { message?: unknown } | null | undefined)?.message || error || '',
  ).toLowerCase();
  return message.includes('context canceled') || message.includes('context cancelled');
};

export const buildQueryEditorLifecycleAffectedRowsResult = (
  sql: string,
  state: QueryEditorExecutionLifecycleState,
): {
  key: string;
  sql: string;
  rows: Array<{ affectedRows: number }>;
  columns: string[];
  outcomeUnknown?: boolean;
  pkColumns: string[];
  readOnly: boolean;
} | null => {
  if (state.status !== 'done' || !state.hasAffectedRows) {
    return null;
  }
  return {
    key: 'result-1',
    sql,
    rows: [{ affectedRows: Number(state.affectedRows || 0) }],
    columns: ['affectedRows'],
    outcomeUnknown: state.outcomeUnknown || undefined,
    pkColumns: [],
    readOnly: true,
  };
};

export const queryEditorExecutionStatusI18nKey = (
  status: QueryEditorExecutionLifecycleStatus,
): string => {
  switch (status) {
    case 'cancelling':
      return 'query_editor.execution.status.cancelling';
    case 'stalled':
      return 'query_editor.execution.status.stalled';
    case 'done':
      return 'query_editor.execution.status.done';
    case 'cancelled':
      return 'query_editor.execution.status.cancelled';
    case 'error':
      return 'query_editor.execution.status.error';
    case 'starting':
    case 'running':
      return 'query_editor.execution.status.running';
    default:
      return '';
  }
};

/** 后端已确认仍在建连、尚未把 SQL 交给驱动；没有后端事件的执行路径返回 false。 */
export const isQueryEditorAwaitingDriver = (
  lifecycle: QueryEditorExecutionLifecycleState | null | undefined,
): boolean => Boolean(
  lifecycle
  && lifecycle.status === 'running'
  && lifecycle.stage === 'starting',
);

export const queryEditorExecutionTimerStatusI18nKey = (
  timingActive: boolean,
  lifecycle: QueryEditorExecutionLifecycleState | null | undefined,
  loading = timingActive,
): string => {
  if (!lifecycle) {
    return '';
  }
  // 后端 SQL 执行已结束但前端仍在接收或解码结果时，状态提示切为「正在接收结果」，与已定格的纯 SQL 耗时配合。
  if (loading && lifecycle.status === 'done') {
    return 'query_editor.execution.status.receiving_results';
  }
  // 其余终态在前端仍处于加载中时继续显示「正在执行 SQL」，避免与转圈状态矛盾。
  if (loading && isTerminalQueryEditorExecutionStatus(lifecycle.status)) {
    return 'query_editor.execution.status.running';
  }
  if (isActiveQueryEditorExecutionStatus(lifecycle.status) && !timingActive) {
    return '';
  }
  if (isQueryEditorAwaitingDriver(lifecycle)) {
    return 'query_editor.execution.status.connecting';
  }
  return queryEditorExecutionStatusI18nKey(lifecycle.status);
};

const mapQueryExecutionProgressStatus = (
  status: string | undefined,
  fallback: QueryEditorExecutionLifecycleStatus,
): QueryEditorExecutionLifecycleStatus => {
  switch (status) {
    case 'running':
      return 'running';
    case 'cancelling':
      return 'cancelling';
    case 'done':
      return 'done';
    case 'cancelled':
      return 'cancelled';
    case 'error':
      return 'error';
    default:
      return fallback === 'idle' ? 'running' : fallback;
  }
};
