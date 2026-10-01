import { describe, expect, it } from 'vitest';
import { displaySessionState, sessionStateLabelKey } from './sessionStateLabel';
import { filterSessions } from './sessionWorkbenchModel';

const translate = (key: string): string => `T(${key})`;

describe('sessionStateLabel', () => {
  it('maps engine spellings onto one translation key', () => {
    expect(sessionStateLabelKey('Daemon')).toBe('session_workbench.state.daemon');
    expect(sessionStateLabelKey('Sleep')).toBe('session_workbench.state.sleep');
    expect(sessionStateLabelKey('sleeping')).toBe('session_workbench.state.sleep');
    expect(sessionStateLabelKey('Binlog Dump GTID')).toBe('session_workbench.state.binlog_dump');
    expect(sessionStateLabelKey('idle in transaction')).toBe('session_workbench.state.idle_in_transaction');
    expect(sessionStateLabelKey('idle in transaction (aborted)'))
      .toBe('session_workbench.state.idle_in_transaction_aborted');
    expect(sessionStateLabelKey('WAITING_FOR_RESOURCES')).toBe('session_workbench.state.waiting_for_resources');
  });

  it('falls back to the raw server value for unknown states', () => {
    expect(sessionStateLabelKey('Some Vendor State')).toBeNull();
    expect(displaySessionState(' Some Vendor State ', translate)).toBe('Some Vendor State');
    expect(displaySessionState(undefined, translate)).toBe('');
    expect(displaySessionState('Daemon', translate)).toBe('T(session_workbench.state.daemon)');
  });

  it('lets the session filter match the localized state text', () => {
    const sessions = [
      { key: 'a', state: 'Daemon' },
      { key: 'b', state: 'Query' },
    ];
    const label = (state: string | undefined): string => (
      state === 'Daemon' ? '后台线程' : state || ''
    );
    expect(filterSessions(sessions, '后台', label)).toEqual([sessions[0]]);
    expect(filterSessions(sessions, 'daemon', label)).toEqual([sessions[0]]);
  });
});
