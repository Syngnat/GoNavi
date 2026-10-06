import { useEffect, useRef } from 'react';
import type { SavedConnection } from '../../types';
import { normalizeLockWaitPayload } from '../sessionWorkbench/lockWaitModel';
import { normalizeDatabaseSession } from '../sessionWorkbench/sessionWorkbenchModel';
import { listDatabaseLockWaits, listDatabaseLongTransactions } from '../sessionWorkbench/sessionWorkbenchRpc';
import {
  freshSessionAlerts,
  isSessionAlertRuleActive,
  lockWaitAlerts,
  longTransactionAlerts,
  type SessionAlert,
  type SessionAlertCheck,
} from './sessionAlertEvaluation';
import type { SessionAlertRule, SessionAlertRules } from './sessionAlertRules';

export const SESSION_ALERT_INTERVAL_MS = 60_000;
/** The first check waits a little so it does not compete with app startup. */
export const SESSION_ALERT_FIRST_CHECK_MS = 8_000;

const record = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' ? value as Record<string, unknown> : {}
);

/**
 * Run the enabled checks for one connection. A check that fails reports
 * nothing and is left out of `checked`, so its earlier findings stand.
 */
export const checkSessionAlerts = async (
  connection: SavedConnection,
  rule: SessionAlertRule,
): Promise<SessionAlertCheck> => {
  const alerts: SessionAlert[] = [];
  const checked: SessionAlertCheck['checked'] = [];
  if (rule.lockWaitEnabled) {
    try {
      const result = await listDatabaseLockWaits(connection.config, '');
      const payload = normalizeLockWaitPayload(result?.data);
      if (result?.success === true && payload.capability.supported) {
        alerts.push(...lockWaitAlerts(connection.id, payload.waits, rule.lockWaitSeconds));
        checked.push('lockWait');
      }
    } catch {
      // A connection that cannot be reached right now is retried next round.
    }
  }
  if (rule.longTransactionEnabled) {
    try {
      const result = await listDatabaseLongTransactions(connection.config, '');
      const payload = record(result?.data);
      const capability = record(payload.capability);
      const rows = Array.isArray(payload.transactions) ? payload.transactions : [];
      if (result?.success === true && capability.supported === true) {
        alerts.push(...longTransactionAlerts(
          connection.id,
          rows.map(normalizeDatabaseSession),
          rule.longTransactionMinutes,
        ));
        checked.push('longTransaction');
      }
    } catch {
      // Same as above.
    }
  }
  return { alerts, checked };
};

export interface UseSessionAlertMonitorOptions {
  connections: SavedConnection[];
  rules: SessionAlertRules;
  onAlerts: (alerts: SessionAlert[], connection: SavedConnection) => void;
  /** Every completed round, so the alert history can follow problems until they end. */
  onCheck?: (check: SessionAlertCheck, connection: SavedConnection) => void;
  check?: typeof checkSessionAlerts;
}

/**
 * Poll every watched connection once a minute while GoNavi is open and hand
 * each problem to `onAlerts` once, until it clears.
 */
export const useSessionAlertMonitor = ({
  connections,
  rules,
  onAlerts,
  onCheck,
  check = checkSessionAlerts,
}: UseSessionAlertMonitorOptions): void => {
  const latest = useRef({ connections, rules, onAlerts, onCheck, check });
  latest.current = { connections, rules, onAlerts, onCheck, check };
  const reportedKeys = useRef(new Map<string, Set<string>>());
  const watchedSignature = connections
    .filter((connection) => isSessionAlertRuleActive(rules[connection.id]))
    .map((connection) => connection.id)
    .sort()
    .join('\u0000');

  useEffect(() => {
    if (!watchedSignature) {
      reportedKeys.current.clear();
      return undefined;
    }
    let cancelled = false;
    let running = false;
    const runChecks = async () => {
      if (running) return;
      running = true;
      try {
        const { connections: current, rules: currentRules } = latest.current;
        const watched = current.filter((connection) => isSessionAlertRuleActive(currentRules[connection.id]));
        const watchedIds = new Set(watched.map((connection) => connection.id));
        [...reportedKeys.current.keys()].forEach((id) => {
          if (!watchedIds.has(id)) reportedKeys.current.delete(id);
        });
        // One connection at a time: SSH tunnels reject parallel handshakes.
        for (const connection of watched) {
          if (cancelled) return;
          const rule = latest.current.rules[connection.id];
          if (!isSessionAlertRuleActive(rule)) continue;
          const result = await latest.current.check(connection, rule);
          if (cancelled) return;
          const { fresh, keys } = freshSessionAlerts(
            reportedKeys.current.get(connection.id) ?? new Set(),
            result.alerts,
            result.checked,
          );
          reportedKeys.current.set(connection.id, keys);
          latest.current.onCheck?.(result, connection);
          if (fresh.length > 0) latest.current.onAlerts(fresh, connection);
        }
      } finally {
        running = false;
      }
    };
    const first = setTimeout(() => { void runChecks(); }, SESSION_ALERT_FIRST_CHECK_MS);
    const interval = setInterval(() => { void runChecks(); }, SESSION_ALERT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [watchedSignature]);
};
