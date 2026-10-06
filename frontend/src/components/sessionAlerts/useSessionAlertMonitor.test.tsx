import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedConnection } from '../../types';
import type { SessionAlert, SessionAlertCheck } from './sessionAlertEvaluation';
import { DEFAULT_SESSION_ALERT_RULE, type SessionAlertRules } from './sessionAlertRules';
import {
  SESSION_ALERT_FIRST_CHECK_MS,
  SESSION_ALERT_INTERVAL_MS,
  useSessionAlertMonitor,
  type UseSessionAlertMonitorOptions,
} from './useSessionAlertMonitor';

vi.mock('../sessionWorkbench/sessionWorkbenchRpc', () => ({
  listDatabaseLockWaits: vi.fn(),
  listDatabaseLongTransactions: vi.fn(),
}));

const connection = (id: string) => ({ id, name: id, config: { id, type: 'mysql' } }) as unknown as SavedConnection;
const alert = (key: string): SessionAlert => ({ key, kind: 'longTransaction', connectionId: 'c1', sessionId: '7', durationMs: 900_000 });

function Probe(props: UseSessionAlertMonitorOptions) {
  useSessionAlertMonitor(props);
  return null;
}

const flush = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe('useSessionAlertMonitor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('checks only enabled connections, once a minute, and reports each problem once', async () => {
    const check = vi.fn(async (_connection: SavedConnection): Promise<SessionAlertCheck> => (
      { alerts: [alert('trx:c1::7:')], checked: ['lockWait', 'longTransaction'] }
    ));
    const onAlerts = vi.fn();
    const onCheck = vi.fn();
    const rules: SessionAlertRules = {
      c1: { ...DEFAULT_SESSION_ALERT_RULE, enabled: true },
      c2: { ...DEFAULT_SESSION_ALERT_RULE, enabled: false },
    };
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe connections={[connection('c1'), connection('c2')]} rules={rules} onAlerts={onAlerts} onCheck={onCheck} check={check} />);
    });

    await flush(SESSION_ALERT_FIRST_CHECK_MS);
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0][0].id).toBe('c1');
    expect(onAlerts).toHaveBeenCalledTimes(1);
    expect(onCheck).toHaveBeenCalledWith(expect.objectContaining({ alerts: [expect.objectContaining({ key: 'trx:c1::7:' })] }), expect.objectContaining({ id: 'c1' }));

    await flush(SESSION_ALERT_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(2);
    expect(onAlerts).toHaveBeenCalledTimes(1);

    act(() => renderer.unmount());
    await flush(SESSION_ALERT_INTERVAL_MS * 2);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('does nothing while no connection is watched', async () => {
    const check = vi.fn(async (): Promise<SessionAlertCheck> => ({ alerts: [], checked: [] }));
    act(() => {
      create(<Probe connections={[connection('c1')]} rules={{}} onAlerts={vi.fn()} check={check} />);
    });
    await flush(SESSION_ALERT_INTERVAL_MS * 2);
    expect(check).not.toHaveBeenCalled();
  });

  it('does not raise a problem again after a check of its kind failed', async () => {
    const problem = alert('trx:c1::7:');
    const rounds: SessionAlertCheck[] = [
      { alerts: [problem], checked: ['longTransaction'] },
      // The server did not answer: nothing found, nothing checked.
      { alerts: [], checked: [] },
      { alerts: [problem], checked: ['longTransaction'] },
    ];
    const check = vi.fn(async (): Promise<SessionAlertCheck> => rounds.shift() ?? { alerts: [], checked: [] });
    const onAlerts = vi.fn();
    act(() => {
      create(<Probe connections={[connection('c1')]} rules={{ c1: { ...DEFAULT_SESSION_ALERT_RULE, enabled: true } }} onAlerts={onAlerts} check={check} />);
    });
    await flush(SESSION_ALERT_FIRST_CHECK_MS);
    await flush(SESSION_ALERT_INTERVAL_MS);
    await flush(SESSION_ALERT_INTERVAL_MS);
    expect(check).toHaveBeenCalledTimes(3);
    expect(onAlerts).toHaveBeenCalledTimes(1);
  });
});
