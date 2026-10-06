import { describe, expect, it } from 'vitest';
import type { DatabaseLockWait } from '../sessionWorkbench/lockWaitModel';
import {
  freshSessionAlerts,
  isSessionAlertRuleActive,
  lockWaitAlerts,
  longTransactionAlerts,
} from './sessionAlertEvaluation';
import { DEFAULT_SESSION_ALERT_RULE } from './sessionAlertRules';

const edge = (waiting: string, blocking: string, waitDurationMs: number, extra: Partial<DatabaseLockWait> = {}): DatabaseLockWait => ({
  key: `${waiting}<-${blocking}`,
  waitingSessionId: waiting,
  blockingSessionId: blocking,
  waitDurationMs,
  ...extra,
});

describe('lockWaitAlerts', () => {
  it('raises one alert per root blocker once any wait in its chain passes the threshold', () => {
    const waits = [
      edge('10', '9', 45_000, { blockingUser: 'app', blockingState: 'Sleep', blockingStatement: "UPDATE orders SET status='x'", objectName: 'shop.orders' }),
      edge('11', '10', 5_000),
      edge('21', '20', 3_000),
    ];
    const alerts = lockWaitAlerts('c1', waits, 30);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      key: 'lock:c1::9',
      kind: 'lockWait',
      sessionId: '9',
      user: 'app',
      durationMs: 45_000,
      blockedCount: 2,
      objectName: 'shop.orders',
    });
  });

  it('stays quiet below the threshold', () => {
    expect(lockWaitAlerts('c1', [edge('10', '9', 29_000)], 30)).toEqual([]);
    expect(lockWaitAlerts('c1', [], 30)).toEqual([]);
  });
});

describe('longTransactionAlerts', () => {
  it('reports transactions open longer than the threshold, keyed by session identity', () => {
    const alerts = longTransactionAlerts('c1', [
      { key: 'a', sessionId: '7', serialNumber: '3', user: 'app', state: 'INACTIVE', durationMs: 11 * 60_000 },
      { key: 'b', sessionId: '8', durationMs: 9 * 60_000 },
    ], 10);
    expect(alerts).toEqual([expect.objectContaining({ key: 'trx:c1::7:3', sessionId: '7', durationMs: 660_000 })]);
  });
});

describe('freshSessionAlerts', () => {
  it('reports a problem once and again only after it cleared', () => {
    const alert = longTransactionAlerts('c1', [{ key: 'a', sessionId: '7', durationMs: 20 * 60_000 }], 10)[0];
    const first = freshSessionAlerts(new Set(), [alert]);
    expect(first.fresh).toEqual([alert]);
    const second = freshSessionAlerts(first.keys, [alert]);
    expect(second.fresh).toEqual([]);
    const cleared = freshSessionAlerts(second.keys, []);
    expect(freshSessionAlerts(cleared.keys, [alert]).fresh).toEqual([alert]);
  });
});

describe('isSessionAlertRuleActive', () => {
  it('needs the rule switched on and at least one check selected', () => {
    expect(isSessionAlertRuleActive(undefined)).toBe(false);
    expect(isSessionAlertRuleActive(DEFAULT_SESSION_ALERT_RULE)).toBe(false);
    expect(isSessionAlertRuleActive({ ...DEFAULT_SESSION_ALERT_RULE, enabled: true })).toBe(true);
    expect(isSessionAlertRuleActive({
      ...DEFAULT_SESSION_ALERT_RULE, enabled: true, lockWaitEnabled: false, longTransactionEnabled: false,
    })).toBe(false);
  });
});
