import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionAlert } from './sessionAlertEvaluation';
import { freshSessionAlerts } from './sessionAlertEvaluation';
import {
  clearSessionAlertHistory,
  getSessionAlertHistory,
  recordSessionAlertCheck,
  reloadSessionAlertHistoryForTest,
  SESSION_ALERT_RECORD_STALE_MS,
} from './sessionAlertHistory';
import { sessionAlertRecordStatus } from './SessionAlertHistoryPanel';

vi.mock('./SessionAlertHost', () => ({ openSessionAlert: vi.fn() }));

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
};

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 9, 6, 2, 0, 0);
const c1 = { id: 'c1', name: 'prod-mysql' };
const lockAlert = (durationMs: number, blockedCount = 1): SessionAlert => ({
  key: 'lock:c1::9', kind: 'lockWait', connectionId: 'c1', sessionId: '9', user: 'app',
  statement: 'UPDATE orders SET status = 1', objectName: 'shop.orders', durationMs, blockedCount,
});
const trxAlert = (durationMs: number): SessionAlert => ({
  key: 'trx:c1::7:', kind: 'longTransaction', connectionId: 'c1', sessionId: '7', durationMs,
});

describe('session alert history', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    reloadSessionAlertHistoryForTest(T0);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('follows a problem from the first check that saw it to the first that did not', () => {
    recordSessionAlertCheck(c1, { alerts: [lockAlert(40_000)], checked: ['lockWait'] }, T0);
    recordSessionAlertCheck(c1, { alerts: [lockAlert(100_000, 3)], checked: ['lockWait'] }, T0 + MINUTE);
    let [record] = getSessionAlertHistory();
    expect(record).toMatchObject({
      connectionName: 'prod-mysql', sessionId: '9', startedAt: T0 - 40_000, lastSeenAt: T0 + MINUTE,
      peakDurationMs: 100_000, blockedCount: 3, objectName: 'shop.orders',
    });
    expect(record.endedAt).toBeUndefined();
    expect(sessionAlertRecordStatus(record, T0 + MINUTE)).toBe('ongoing');

    recordSessionAlertCheck(c1, { alerts: [], checked: ['lockWait'] }, T0 + 2 * MINUTE);
    [record] = getSessionAlertHistory();
    expect(record.endedAt).toBe(T0 + 2 * MINUTE);
    expect(sessionAlertRecordStatus(record, T0 + 2 * MINUTE)).toBe('ended');
    expect(getSessionAlertHistory()).toHaveLength(1);
  });

  it('keeps a problem open when its kind could not be checked', () => {
    recordSessionAlertCheck(c1, { alerts: [lockAlert(40_000), trxAlert(11 * MINUTE)], checked: ['lockWait', 'longTransaction'] }, T0);
    // The lock-wait query failed; only transactions were checked, and none remain.
    recordSessionAlertCheck(c1, { alerts: [], checked: ['longTransaction'] }, T0 + MINUTE);
    const byKind = Object.fromEntries(getSessionAlertHistory().map((record) => [record.kind, record]));
    expect(byKind.lockWait.endedAt).toBeUndefined();
    expect(byKind.longTransaction.endedAt).toBe(T0 + MINUTE);
  });

  it('opens a new record when a problem comes back after it ended', () => {
    recordSessionAlertCheck(c1, { alerts: [lockAlert(40_000)], checked: ['lockWait'] }, T0);
    recordSessionAlertCheck(c1, { alerts: [], checked: ['lockWait'] }, T0 + MINUTE);
    recordSessionAlertCheck(c1, { alerts: [lockAlert(35_000)], checked: ['lockWait'] }, T0 + 10 * MINUTE);
    const records = getSessionAlertHistory();
    expect(records).toHaveLength(2);
    expect(records[0].startedAt).toBe(T0 + 10 * MINUTE - 35_000);
    expect(records[0].endedAt).toBeUndefined();
  });

  it('closes what an earlier run left open, and drops records past 30 days', () => {
    recordSessionAlertCheck(c1, { alerts: [lockAlert(40_000)], checked: ['lockWait'] }, T0);
    const later = T0 + SESSION_ALERT_RECORD_STALE_MS + MINUTE;
    expect(sessionAlertRecordStatus(getSessionAlertHistory()[0], later)).toBe('unchecked');
    reloadSessionAlertHistoryForTest(later);
    const [record] = getSessionAlertHistory();
    expect(record).toMatchObject({ endedAt: T0, endUnobserved: true });
    expect(sessionAlertRecordStatus(record, later)).toBe('endedUnobserved');

    reloadSessionAlertHistoryForTest(T0 + 31 * 24 * 60 * MINUTE);
    expect(getSessionAlertHistory()).toHaveLength(0);
  });

  it('clears one connection or all of them', () => {
    recordSessionAlertCheck(c1, { alerts: [lockAlert(40_000)], checked: ['lockWait'] }, T0);
    recordSessionAlertCheck({ id: 'c2', name: 'pg' }, {
      alerts: [{ ...trxAlert(11 * MINUTE), key: 'trx:c2::7:', connectionId: 'c2' }],
      checked: ['longTransaction'],
    }, T0);
    clearSessionAlertHistory('c1');
    expect(getSessionAlertHistory().map((record) => record.connectionId)).toEqual(['c2']);
    clearSessionAlertHistory();
    expect(getSessionAlertHistory()).toHaveLength(0);
  });
});

describe('freshSessionAlerts with failed checks', () => {
  it('keeps the keys of a kind that was not checked', () => {
    const previous = new Set(['lock:c1::9', 'trx:c1::7:']);
    const { fresh, keys } = freshSessionAlerts(previous, [], ['longTransaction']);
    expect(fresh).toEqual([]);
    expect([...keys]).toEqual(['lock:c1::9']);
  });
});
