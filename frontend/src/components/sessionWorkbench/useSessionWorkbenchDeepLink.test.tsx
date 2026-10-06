import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { useSessionWorkbenchDeepLink } from './useSessionWorkbenchDeepLink';

type Props = Parameters<typeof useSessionWorkbenchDeepLink>[0];

function Probe(props: Props) {
  useSessionWorkbenchDeepLink(props);
  return null;
}

const settledWorkbench = (overrides: Partial<Props['workbench']> = {}): Props['workbench'] => ({
  selectedConnectionId: 'c1',
  setSelectedConnectionId: vi.fn(),
  payload: { engine: 'mysql', capability: { supported: true, canCancelQuery: true, canTerminateSession: true }, sessions: [], scopedDatabase: '' },
  loading: false,
  setFilter: vi.fn(),
  setRunningOnly: vi.fn(),
  refresh: vi.fn(async () => true),
  ...overrides,
});

describe('useSessionWorkbenchDeepLink', () => {
  it('switches view, filters and reloads the list when the connection is already loaded', () => {
    const setView = vi.fn();
    const workbench = settledWorkbench();
    act(() => {
      create(<Probe
        tab={{ connectionId: 'c1', sessionWorkbenchView: 'lockWaits', sessionWorkbenchFilter: '9', sessionWorkbenchRequestKey: 'k1' }}
        workbench={workbench}
        setView={setView}
      />);
    });
    expect(setView).toHaveBeenCalledWith('lockWaits');
    expect(workbench.setFilter).toHaveBeenCalledWith('9');
    expect(workbench.setRunningOnly).toHaveBeenCalledWith(false);
    // The alerted session may be newer than the list on screen.
    expect(workbench.refresh).toHaveBeenCalledTimes(1);
  });

  it('waits for the new connection to load before filtering', () => {
    const setView = vi.fn();
    const setFilter = vi.fn();
    const refresh = vi.fn(async () => true);
    const oldPayload = settledWorkbench().payload;
    let renderer!: ReactTestRenderer;
    const tab = { connectionId: 'c2', sessionWorkbenchView: 'sessions' as const, sessionWorkbenchFilter: '7', sessionWorkbenchRequestKey: 'k2' };
    act(() => {
      renderer = create(<Probe tab={tab} workbench={settledWorkbench({ payload: oldPayload, setFilter, refresh })} setView={setView} />);
    });
    expect(setFilter).not.toHaveBeenCalled();

    // The connection switches and reloads; the old list must not take the filter.
    act(() => renderer.update(<Probe tab={tab} workbench={settledWorkbench({ selectedConnectionId: 'c2', payload: null, loading: true, setFilter, refresh })} setView={setView} />));
    expect(setFilter).not.toHaveBeenCalled();
    const fresh = { ...oldPayload!, sessions: [] };
    act(() => renderer.update(<Probe tab={tab} workbench={settledWorkbench({ selectedConnectionId: 'c2', payload: fresh, setFilter, refresh })} setView={setView} />));
    expect(setFilter).toHaveBeenCalledWith('7');

    // The same link is applied only once.
    act(() => renderer.update(<Probe tab={tab} workbench={settledWorkbench({ selectedConnectionId: 'c2', payload: { ...fresh }, setFilter, refresh })} setView={setView} />));
    expect(setFilter).toHaveBeenCalledTimes(1);
    // The connection switch already loads a fresh list.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('switches back to the linked connection when the picker was moved away from it', () => {
    const setSelectedConnectionId = vi.fn();
    const setFilter = vi.fn();
    const tab = { connectionId: 'c2', sessionWorkbenchView: 'sessions' as const, sessionWorkbenchFilter: '7', sessionWorkbenchRequestKey: 'k3' };
    const onOther = settledWorkbench({ selectedConnectionId: 'c1', setSelectedConnectionId, setFilter });
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<Probe tab={tab} workbench={onOther} setView={vi.fn()} />);
    });
    act(() => renderer.update(<Probe tab={tab} workbench={{ ...onOther }} setView={vi.fn()} />));
    expect(setSelectedConnectionId).toHaveBeenCalledWith('c2');
    expect(setFilter).not.toHaveBeenCalled();
  });
});
