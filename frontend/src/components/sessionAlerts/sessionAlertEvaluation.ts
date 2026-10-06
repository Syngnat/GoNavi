import { buildLockWaitTree, type DatabaseLockWait, type LockWaitTreeRow } from '../sessionWorkbench/lockWaitModel';
import type { DatabaseSession } from '../sessionWorkbench/sessionWorkbenchModel';
import type { SessionAlertRule } from './sessionAlertRules';

export type SessionAlertKind = 'lockWait' | 'longTransaction';

export interface SessionAlert {
  /** Stable identity: the same problem keeps its key across checks. */
  key: string;
  kind: SessionAlertKind;
  connectionId: string;
  /** The session to act on: the root blocker, or the transaction's session. */
  sessionId: string;
  user?: string;
  state?: string;
  statement?: string;
  durationMs: number;
  /** Lock waits only: sessions queued behind the blocker, and the table. */
  blockedCount?: number;
  objectName?: string;
}

const descendantWaits = (row: LockWaitTreeRow): DatabaseLockWait[] => (row.children ?? []).flatMap((child) => [
  ...(child.wait ? [child.wait] : []),
  ...descendantWaits(child),
]);

/**
 * One alert per root blocker whose chain has a wait past the threshold: that is
 * the session to deal with, however many sessions queue behind it.
 */
export const lockWaitAlerts = (
  connectionId: string,
  waits: DatabaseLockWait[],
  thresholdSeconds: number,
): SessionAlert[] => {
  const thresholdMs = thresholdSeconds * 1_000;
  if (!waits.some((wait) => (wait.waitDurationMs ?? 0) >= thresholdMs)) return [];
  return buildLockWaitTree(waits).rows.flatMap((root): SessionAlert[] => {
    const chain = descendantWaits(root);
    const longest = chain.reduce((max, wait) => Math.max(max, wait.waitDurationMs ?? 0), 0);
    if (longest < thresholdMs) return [];
    return [{
      key: `lock:${connectionId}:${root.session.instanceId ?? ''}:${root.session.sessionId ?? ''}`,
      kind: 'lockWait',
      connectionId,
      sessionId: root.session.sessionId ?? '',
      user: root.session.user,
      state: root.session.state,
      statement: root.session.statement,
      durationMs: longest,
      blockedCount: root.blockedCount,
      objectName: chain.find((wait) => wait.objectName)?.objectName,
    }];
  });
};

export const longTransactionAlerts = (
  connectionId: string,
  transactions: DatabaseSession[],
  thresholdMinutes: number,
): SessionAlert[] => transactions
  .filter((transaction) => (transaction.durationMs ?? 0) >= thresholdMinutes * 60_000 && transaction.sessionId)
  .map((transaction) => ({
    key: `trx:${connectionId}:${transaction.instanceId ?? ''}:${transaction.sessionId}:${transaction.serialNumber ?? ''}`,
    kind: 'longTransaction',
    connectionId,
    sessionId: transaction.sessionId ?? '',
    user: transaction.user,
    state: transaction.state,
    statement: transaction.statement,
    durationMs: transaction.durationMs ?? 0,
  }));

/** One round of checks on a connection. */
export interface SessionAlertCheck {
  alerts: SessionAlert[];
  /** Kinds whose check ran; a failed check says nothing about its problems. */
  checked: SessionAlertKind[];
}

export const ALL_SESSION_ALERT_KINDS: readonly SessionAlertKind[] = ['lockWait', 'longTransaction'];

export const sessionAlertKindOfKey = (key: string): SessionAlertKind => (key.startsWith('lock:') ? 'lockWait' : 'longTransaction');

/**
 * Alerts not raised before. A problem that clears and comes back is new again,
 * because the keys of the current check replace the previous ones. Keys of a
 * kind whose check failed are kept: an unreachable server has not solved them,
 * and they must not be raised again once it answers.
 */
export const freshSessionAlerts = (
  previousKeys: ReadonlySet<string>,
  alerts: SessionAlert[],
  checked: readonly SessionAlertKind[] = ALL_SESSION_ALERT_KINDS,
): { fresh: SessionAlert[]; keys: Set<string> } => {
  const keys = new Set(alerts.map((alert) => alert.key));
  previousKeys.forEach((key) => {
    if (!checked.includes(sessionAlertKindOfKey(key))) keys.add(key);
  });
  return { fresh: alerts.filter((alert) => !previousKeys.has(alert.key)), keys };
};

export const isSessionAlertRuleActive = (rule: SessionAlertRule | undefined): rule is SessionAlertRule => Boolean(
  rule?.enabled && (rule.lockWaitEnabled || rule.longTransactionEnabled),
);
