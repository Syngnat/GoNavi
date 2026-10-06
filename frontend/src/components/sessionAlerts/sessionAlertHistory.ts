import { useSyncExternalStore } from 'react';
import type { SessionAlert, SessionAlertCheck, SessionAlertKind } from './sessionAlertEvaluation';

// 提醒记录：每个被提醒过的问题记一条，跟到它消失为止，事后能查清谁在什么时候堵了多久。
// 存在本机浏览器配置里（与提醒规则同处），保留 30 天、最多 300 条。

export interface SessionAlertRecord {
  id: string;
  key: string;
  kind: SessionAlertKind;
  connectionId: string;
  connectionName: string;
  sessionId: string;
  user?: string;
  state?: string;
  statement?: string;
  objectName?: string;
  /** Most sessions seen queued behind the blocker. */
  blockedCount?: number;
  /** When the wait or transaction began, worked back from its duration when first seen. */
  startedAt: number;
  lastSeenAt: number;
  /** Longest duration a check saw: the problem lasted at least this long. */
  peakDurationMs: number;
  /** First check that no longer found it; the problem ended between lastSeenAt and this. */
  endedAt?: number;
  /** GoNavi was not checking when it ended (closed, or alerts turned off): endedAt is lastSeenAt. */
  endUnobserved?: boolean;
}

const STORAGE_KEY = 'gonavi.sessionAlertHistory.v1';
const STORAGE_VERSION = 1;
const MAX_RECORDS = 300;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const STATEMENT_CHARS = 500;
/** An open record not seen for this long is no longer being checked. */
export const SESSION_ALERT_RECORD_STALE_MS = 3 * 60 * 1000;

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is SessionAlertRecord => {
  const record = value as SessionAlertRecord;
  return Boolean(record) && typeof record.id === 'string' && typeof record.key === 'string'
    && (record.kind === 'lockWait' || record.kind === 'longTransaction')
    && typeof record.connectionId === 'string' && typeof record.startedAt === 'number'
    && typeof record.lastSeenAt === 'number' && typeof record.peakDurationMs === 'number';
};

/** Drop expired records and cap the list; newest first. */
const prune = (records: SessionAlertRecord[], now: number): SessionAlertRecord[] => records
  .filter((record) => now - (record.endedAt ?? record.lastSeenAt) <= RETENTION_MS)
  .sort((left, right) => right.startedAt - left.startedAt)
  .slice(0, MAX_RECORDS);

/** Open records left by an earlier run ended while nobody was checking. */
const closeAbandoned = (records: SessionAlertRecord[], now: number): SessionAlertRecord[] => records.map((record) => (
  record.endedAt === undefined && now - record.lastSeenAt > SESSION_ALERT_RECORD_STALE_MS
    ? { ...record, endedAt: record.lastSeenAt, endUnobserved: true }
    : record
));

const readPersisted = (now: number): SessionAlertRecord[] => {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version?: number; records?: unknown[] };
    if (parsed?.version !== STORAGE_VERSION || !Array.isArray(parsed.records)) return [];
    return prune(closeAbandoned(parsed.records.filter(isRecord), now), now);
  } catch {
    return [];
  }
};

let currentRecords: readonly SessionAlertRecord[] = readPersisted(Date.now());
const listeners = new Set<() => void>();

const publish = (next: SessionAlertRecord[]) => {
  currentRecords = next;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, records: next }));
  } catch {
    // Storage full or unavailable: the history still works for this session.
  }
  listeners.forEach((listener) => listener());
};

export const getSessionAlertHistory = (): readonly SessionAlertRecord[] => currentRecords;

export const subscribeSessionAlertHistory = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useSessionAlertHistory = (): readonly SessionAlertRecord[] => useSyncExternalStore(
  subscribeSessionAlertHistory,
  getSessionAlertHistory,
  getSessionAlertHistory,
);

const truncate = (text: string | undefined) => {
  const value = String(text ?? '').trim();
  return value.length > STATEMENT_CHARS ? `${value.slice(0, STATEMENT_CHARS)}…` : value || undefined;
};

const newRecord = (alert: SessionAlert, connectionName: string, now: number): SessionAlertRecord => {
  const startedAt = Math.min(now, now - Math.max(0, alert.durationMs));
  return {
    id: `${alert.key}@${startedAt}`,
    key: alert.key,
    kind: alert.kind,
    connectionId: alert.connectionId,
    connectionName,
    sessionId: alert.sessionId,
    user: alert.user,
    state: alert.state,
    statement: truncate(alert.statement),
    objectName: alert.objectName,
    blockedCount: alert.blockedCount,
    startedAt,
    lastSeenAt: now,
    peakDurationMs: Math.max(0, alert.durationMs),
  };
};

/**
 * Fold one round of checks into the history: open a record for a problem seen
 * for the first time, keep an open one up to date, and close the open records
 * of a checked kind that the round no longer found.
 */
export const recordSessionAlertCheck = (
  connection: { id: string; name: string },
  check: SessionAlertCheck,
  now: number = Date.now(),
): void => {
  const open = new Map<string, number>();
  const records = [...currentRecords];
  records.forEach((record, index) => {
    if (record.connectionId === connection.id && record.endedAt === undefined) open.set(record.key, index);
  });
  const seen = new Set<string>();
  check.alerts.forEach((alert) => {
    seen.add(alert.key);
    const index = open.get(alert.key);
    if (index === undefined) {
      records.push(newRecord(alert, connection.name, now));
      return;
    }
    const record = records[index];
    records[index] = {
      ...record,
      connectionName: connection.name || record.connectionName,
      lastSeenAt: now,
      peakDurationMs: Math.max(record.peakDurationMs, alert.durationMs),
      blockedCount: Math.max(record.blockedCount ?? 0, alert.blockedCount ?? 0) || undefined,
      statement: record.statement ?? truncate(alert.statement),
      objectName: record.objectName ?? alert.objectName,
    };
  });
  open.forEach((index, key) => {
    if (!seen.has(key) && check.checked.includes(records[index].kind)) {
      records[index] = { ...records[index], endedAt: now };
    }
  });
  if (check.alerts.length === 0 && open.size === 0) return;
  publish(prune(records, now));
};

/** Forget the records of one connection, or all of them. */
export const clearSessionAlertHistory = (connectionId?: string): void => {
  publish(connectionId ? currentRecords.filter((record) => record.connectionId !== connectionId) : []);
};

export const reloadSessionAlertHistoryForTest = (now: number = Date.now()): void => {
  currentRecords = readPersisted(now);
};
