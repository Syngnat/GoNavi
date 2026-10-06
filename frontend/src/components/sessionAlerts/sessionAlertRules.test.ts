import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SESSION_ALERT_RULE,
  getSessionAlertRule,
  reloadSessionAlertRulesForTest,
  sanitizeSessionAlertRule,
  saveSessionAlertRule,
  subscribeSessionAlertRules,
} from './sessionAlertRules';

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
};

describe('session alert rules', () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    reloadSessionAlertRulesForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps thresholds within range and fills defaults', () => {
    expect(sanitizeSessionAlertRule({ enabled: true, lockWaitSeconds: 1, longTransactionMinutes: 99_999 })).toEqual({
      ...DEFAULT_SESSION_ALERT_RULE,
      enabled: true,
      lockWaitSeconds: 5,
      longTransactionMinutes: 1_440,
    });
    expect(sanitizeSessionAlertRule('junk')).toEqual(DEFAULT_SESSION_ALERT_RULE);
  });

  it('persists per connection and notifies subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionAlertRules(listener);
    saveSessionAlertRule('c1', { ...DEFAULT_SESSION_ALERT_RULE, enabled: true, lockWaitSeconds: 60 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();

    reloadSessionAlertRulesForTest();
    expect(getSessionAlertRule('c1')).toMatchObject({ enabled: true, lockWaitSeconds: 60 });
    expect(getSessionAlertRule('other')).toEqual(DEFAULT_SESSION_ALERT_RULE);
  });

  it('ignores storage written by another version', () => {
    storage.setItem('gonavi.sessionAlerts.v1', JSON.stringify({ version: 99, rules: { c1: { enabled: true } } }));
    reloadSessionAlertRulesForTest();
    expect(getSessionAlertRule('c1')).toEqual(DEFAULT_SESSION_ALERT_RULE);
  });
});
