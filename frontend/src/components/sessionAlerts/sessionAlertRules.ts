import { useSyncExternalStore } from 'react';

// Per-connection alert rules, kept in this browser profile. The monitor and the
// settings popover share one in-memory copy so a change applies immediately.

export interface SessionAlertRule {
  enabled: boolean;
  lockWaitEnabled: boolean;
  lockWaitSeconds: number;
  longTransactionEnabled: boolean;
  longTransactionMinutes: number;
}

export type SessionAlertRules = Readonly<Record<string, SessionAlertRule>>;

export const DEFAULT_SESSION_ALERT_RULE: SessionAlertRule = {
  enabled: false,
  lockWaitEnabled: true,
  lockWaitSeconds: 30,
  longTransactionEnabled: true,
  longTransactionMinutes: 10,
};

export const LOCK_WAIT_SECONDS_RANGE = { min: 5, max: 3_600 } as const;
export const LONG_TRANSACTION_MINUTES_RANGE = { min: 1, max: 1_440 } as const;

const STORAGE_KEY = 'gonavi.sessionAlerts.v1';
const STORAGE_VERSION = 1;

const clamp = (value: unknown, range: { min: number; max: number }, fallback: number): number => {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(number)));
};

export const sanitizeSessionAlertRule = (value: unknown): SessionAlertRule => {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    enabled: source.enabled === true,
    lockWaitEnabled: source.lockWaitEnabled !== false,
    lockWaitSeconds: clamp(source.lockWaitSeconds, LOCK_WAIT_SECONDS_RANGE, DEFAULT_SESSION_ALERT_RULE.lockWaitSeconds),
    longTransactionEnabled: source.longTransactionEnabled !== false,
    longTransactionMinutes: clamp(
      source.longTransactionMinutes,
      LONG_TRANSACTION_MINUTES_RANGE,
      DEFAULT_SESSION_ALERT_RULE.longTransactionMinutes,
    ),
  };
};

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

const readPersistedRules = (): SessionAlertRules => {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { version?: number; rules?: Record<string, unknown> };
    if (parsed?.version !== STORAGE_VERSION || !parsed.rules || typeof parsed.rules !== 'object') return {};
    const rules: Record<string, SessionAlertRule> = {};
    Object.entries(parsed.rules).forEach(([connectionId, rule]) => {
      if (connectionId.trim()) rules[connectionId] = sanitizeSessionAlertRule(rule);
    });
    return rules;
  } catch {
    return {};
  }
};

let currentRules: SessionAlertRules = readPersistedRules();
const listeners = new Set<() => void>();

const publish = (next: SessionAlertRules) => {
  currentRules = next;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, rules: next }));
  } catch {
    // Storage full or blocked: the rule still applies for this session.
  }
  listeners.forEach((listener) => listener());
};

export const getSessionAlertRules = (): SessionAlertRules => currentRules;

export const getSessionAlertRule = (connectionId: string): SessionAlertRule => (
  currentRules[connectionId] ?? DEFAULT_SESSION_ALERT_RULE
);

export const saveSessionAlertRule = (connectionId: string, rule: SessionAlertRule): void => {
  const id = connectionId.trim();
  if (!id) return;
  publish({ ...currentRules, [id]: sanitizeSessionAlertRule(rule) });
};

export const subscribeSessionAlertRules = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useSessionAlertRules = (): SessionAlertRules => (
  useSyncExternalStore(subscribeSessionAlertRules, getSessionAlertRules, getSessionAlertRules)
);

/** Test seam: reload from storage, as a fresh app start would. */
export const reloadSessionAlertRulesForTest = (): void => {
  currentRules = readPersistedRules();
};
