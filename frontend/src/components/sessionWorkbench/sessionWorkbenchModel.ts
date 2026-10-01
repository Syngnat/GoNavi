import type { SavedConnection } from '../../types';
import type { I18nParams } from '../../i18n/types';

export type SessionAction = 'cancelQuery' | 'terminateSession';
export type SessionActionTarget = 'sessionId' | 'queryId';
export type SessionReasonCode = 'unsupported' | 'not_applicable' | string;
export type SessionTranslate = (key: string, params?: I18nParams) => string;

export interface SessionCapability {
  supported: boolean;
  canCancelQuery: boolean;
  canTerminateSession: boolean;
  cancelTarget?: SessionActionTarget | string;
  terminateTarget?: SessionActionTarget | string;
  terminateRequiresInstanceAndSerial?: boolean;
  reasonCode?: SessionReasonCode;
}

export interface DatabaseSession {
  key: string;
  databaseOrTenant?: string;
  sessionId?: string;
  queryId?: string;
  instanceId?: string;
  serialNumber?: string;
  statement?: string;
  state?: string;
  durationMs?: number;
  user?: string;
}

export interface SessionListPayload {
  engine: string;
  capability: SessionCapability;
  sessions: DatabaseSession[];
  /** Database this listing was read from; PostgreSQL-lineage servers scope here. */
  scopedDatabase: string;
}

export interface SessionActionRequest {
  action: SessionAction;
  sessionId?: string;
  queryId?: string;
  instanceId?: string;
  serialNumber?: string;
}

export interface SessionQueryResult {
  success?: boolean;
  message?: string;
  data?: unknown;
  /** The server call completed for a previous connection/database scope. */
  stale?: boolean;
}

export const SESSION_ACTIONS: readonly SessionAction[] = [
  'cancelQuery',
  'terminateSession',
];

export type SessionStateTone = 'idle' | 'active' | 'busy' | 'danger' | 'neutral';

const text = (value: unknown): string => String(value ?? '').trim();

const stateIncludes = (value: string, tokens: readonly string[]): boolean => (
  tokens.some((token) => value === token || value.includes(token))
);

/** Map engine-specific session status text onto a stable color tone. */
export const sessionStateTone = (state: string | undefined): SessionStateTone => {
  const value = text(state).toLowerCase();
  if (!value) return 'neutral';
  if (stateIncludes(value, ['killed', 'killing', 'sniped', 'aborted', 'abort', 'error', 'failed'])) {
    return 'danger';
  }
  if (
    value.includes('idle in transaction')
    || stateIncludes(value, ['lock', 'locked', 'blocked', 'blocking', 'suspended'])
  ) {
    return 'busy';
  }
  if (stateIncludes(value, ['sleep', 'sleeping', 'idle', 'inactive', 'dormant', 'cached'])) {
    return 'idle';
  }
  if (stateIncludes(value, ['active', 'running', 'query', 'execute', 'executing', 'connect'])) {
    return 'active';
  }
  return 'neutral';
};

const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' ? value as Record<string, unknown> : {}
);

const booleanValue = (value: unknown): boolean => value === true;

const numberValue = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

export const normalizeSessionCapability = (value: unknown): SessionCapability => {
  const source = record(value);
  return {
    supported: booleanValue(source.supported),
    canCancelQuery: booleanValue(source.canCancelQuery),
    canTerminateSession: booleanValue(source.canTerminateSession),
    cancelTarget: text(source.cancelTarget) || undefined,
    terminateTarget: text(source.terminateTarget) || undefined,
    terminateRequiresInstanceAndSerial: booleanValue(source.terminateRequiresInstanceAndSerial),
    reasonCode: text(source.reasonCode) || undefined,
  };
};

export const normalizeDatabaseSession = (value: unknown, index: number): DatabaseSession => {
  const source = record(value);
  const key = text(source.key) || `session-row-${index}`;
  return {
    key,
    databaseOrTenant: text(source.databaseOrTenant) || undefined,
    sessionId: text(source.sessionId) || undefined,
    queryId: text(source.queryId) || undefined,
    instanceId: text(source.instanceId) || undefined,
    serialNumber: text(source.serialNumber) || undefined,
    statement: text(source.statement) || undefined,
    state: text(source.state) || undefined,
    durationMs: numberValue(source.durationMs),
    user: text(source.user) || undefined,
  };
};

/** Normalize the database catalog returned by DBListSessionDatabases. */
export const normalizeSessionDatabaseNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  value.forEach((entry) => {
    const name = text(entry);
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  });
  return names;
};

export const normalizeSessionPayload = (value: unknown): SessionListPayload => {
  const source = record(value);
  const rawSessions = Array.isArray(source.sessions) ? source.sessions : [];
  return {
    engine: text(source.engine),
    capability: normalizeSessionCapability(source.capability),
    sessions: rawSessions.map(normalizeDatabaseSession),
    scopedDatabase: text(source.scopedDatabase),
  };
};

export const readSessionPayload = (result: SessionQueryResult): SessionListPayload => (
  normalizeSessionPayload(result.data)
);

export const isRedisConnection = (connection: SavedConnection): boolean => {
  const values = [connection.config?.type, connection.config?.driver]
    .map((value) => text(value).toLowerCase().replace(/[_\s-]+/g, ''));
  return values.some((value) => value === 'redis' || value === 'rediss' || value.startsWith('redis'));
};

export const sessionConnections = (connections: SavedConnection[]): SavedConnection[] => (
  connections.filter((connection) => !isRedisConnection(connection))
);

const targetForAction = (
  capability: SessionCapability,
  action: SessionAction,
): string => action === 'cancelQuery'
  ? text(capability.cancelTarget)
  : text(capability.terminateTarget);

/**
 * Resolve the exact server identifier declared by the adapter. Deliberately
 * there is no `queryId || sessionId` fallback here.
 */
export const resolveSessionActionTarget = (
  capability: SessionCapability,
  action: SessionAction,
  session: DatabaseSession,
): string => {
  const target = targetForAction(capability, action);
  if (target === 'sessionId') return text(session.sessionId);
  if (target === 'queryId') return text(session.queryId);
  return '';
};

/**
 * MySQL-family servers list internal threads (e.g. the event scheduler) with
 * COMMAND = 'Daemon'. The server rejects KILL on them with "Unknown thread
 * id", so offering an action would only ever produce an error.
 */
export const isServerInternalSession = (session: DatabaseSession): boolean => (
  text(session.state).toLowerCase() === 'daemon'
);

export const canRunSessionAction = (
  capability: SessionCapability,
  action: SessionAction,
  session: DatabaseSession,
): boolean => {
  if (isServerInternalSession(session)) return false;
  const enabled = action === 'cancelQuery'
    ? capability.supported && capability.canCancelQuery
    : capability.supported && capability.canTerminateSession;
  if (!enabled || !resolveSessionActionTarget(capability, action, session)) return false;
  if (action === 'terminateSession' && capability.terminateRequiresInstanceAndSerial) {
    return Boolean(text(session.instanceId) && text(session.serialNumber));
  }
  return true;
};

export const availableSessionActions = (
  capability: SessionCapability,
  session: DatabaseSession,
): SessionAction[] => SESSION_ACTIONS.filter((action) => canRunSessionAction(capability, action, session));

export const buildSessionActionRequest = (
  capability: SessionCapability,
  action: SessionAction,
  session: DatabaseSession,
): SessionActionRequest | null => {
  const target = resolveSessionActionTarget(capability, action, session);
  if (!target || !canRunSessionAction(capability, action, session)) return null;
  return {
    action,
    sessionId: session.sessionId,
    queryId: session.queryId,
    instanceId: session.instanceId,
    serialNumber: session.serialNumber,
  };
};

export const filterSessions = (
  sessions: DatabaseSession[],
  filter: string,
  /** Localized state text, so the filter matches what the table shows. */
  stateLabel?: (state: string | undefined) => string,
): DatabaseSession[] => {
  const query = text(filter).toLowerCase();
  if (!query) return sessions;
  return sessions.filter((session) => [
    stateLabel?.(session.state),
    session.key,
    session.databaseOrTenant,
    session.sessionId,
    session.queryId,
    session.instanceId,
    session.serialNumber,
    session.statement,
    session.state,
    session.user,
  ].some((value) => text(value).toLowerCase().includes(query)));
};

export const truncateSessionStatement = (statement: string | undefined, maxLength = 180): string => {
  const value = text(statement);
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
};

const LONG_DURATION_UNITS: ReadonlyArray<{ key: string; seconds: number }> = [
  { key: 'session_workbench.duration.days', seconds: 86_400 },
  { key: 'session_workbench.duration.hours', seconds: 3_600 },
  { key: 'session_workbench.duration.minutes', seconds: 60 },
  { key: 'session_workbench.duration.seconds', seconds: 1 },
];

/**
 * Durations of a minute or more read as the two most significant non-zero
 * units ("1 d 6 h", "12 min 30 s") instead of one long decimal such as
 * "1830.8 min".
 */
const formatLongSessionDuration = (
  durationMs: number,
  translate: SessionTranslate,
): string => {
  let remaining = Math.round(durationMs / 1_000);
  const parts: string[] = [];
  for (const unit of LONG_DURATION_UNITS) {
    const value = Math.floor(remaining / unit.seconds);
    remaining -= value * unit.seconds;
    if (value > 0) parts.push(translate(unit.key, { value }));
    if (parts.length === 2) break;
    // Only the unit directly below the leading one is worth showing.
    if (parts.length === 1 && value === 0) break;
  }
  return parts.join(' ');
};

export const formatSessionDuration = (
  durationMs: number | undefined,
  translate: SessionTranslate,
): string => {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return translate('session_workbench.value.empty');
  }
  if (durationMs >= 60_000) return formatLongSessionDuration(durationMs, translate);
  if (durationMs >= 1_000) {
    return translate('session_workbench.duration.seconds', {
      value: (durationMs / 1_000).toFixed(1),
    });
  }
  return translate('session_workbench.duration.milliseconds', {
    value: Math.round(durationMs),
  });
};

export const displaySessionValue = (
  value: string | undefined,
  translate: SessionTranslate,
): string => text(value) || translate('session_workbench.value.empty');

export const actionLabelKey = (action: SessionAction): string => action === 'cancelQuery'
  ? 'session_workbench.action.cancel_query'
  : 'session_workbench.action.terminate_session';

export const actionHelperKey = (action: SessionAction): string => action === 'cancelQuery'
  ? 'session_workbench.action.cancel_helper'
  : 'session_workbench.action.terminate_helper';

export const actionConfirmTitleKey = (action: SessionAction): string => action === 'cancelQuery'
  ? 'session_workbench.confirm.cancel_title'
  : 'session_workbench.confirm.terminate_title';

export const actionSubmitKey = (action: SessionAction): string => action === 'cancelQuery'
  ? 'session_workbench.confirm.submit_cancel'
  : 'session_workbench.confirm.submit_terminate';

export const sessionActionDisplayId = (
  capability: SessionCapability,
  action: SessionAction,
  session: DatabaseSession,
): string => {
  const target = resolveSessionActionTarget(capability, action, session);
  if (action !== 'terminateSession' || !capability.terminateRequiresInstanceAndSerial) {
    return target;
  }
  const instanceId = text(session.instanceId);
  const serialNumber = text(session.serialNumber);
  return target && instanceId && serialNumber
    ? `${target},${serialNumber},@${instanceId}`
    : '';
};
