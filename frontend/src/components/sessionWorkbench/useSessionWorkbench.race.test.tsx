import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionWorkbench } from './useSessionWorkbench';

const sessionRpc = vi.hoisted(() => ({
  list: vi.fn(),
  action: vi.fn(),
  state: { connections: [] as any[] },
}));

vi.mock('../../store', () => ({
  useStore: (selector: (state: unknown) => unknown) => selector(sessionRpc.state),
}));

vi.mock('./sessionWorkbenchRpc', () => ({
  listDatabaseSessions: sessionRpc.list,
  executeDatabaseSessionAction: sessionRpc.action,
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

type RpcResult = {
  success?: boolean;
  message?: string;
  data?: unknown;
};

const response = (key: string): RpcResult => ({
  success: true,
  data: {
    engine: 'mysql',
    capability: {
      supported: true,
      canCancelQuery: true,
      canTerminateSession: true,
      cancelTarget: 'sessionId',
      terminateTarget: 'sessionId',
    },
    sessions: [{ key, sessionId: key, statement: 'SELECT 1' }],
  },
});

const connections = [
  {
    id: 'connection-a',
    name: 'Connection A',
    config: { id: 'connection-a', type: 'mysql', database: 'db_a' },
  },
  {
    id: 'connection-b',
    name: 'Connection B',
    config: { id: 'connection-b', type: 'mysql', database: 'db_b' },
  },
] as any[];

describe('useSessionWorkbench request scope', () => {
  let renderer: ReactTestRenderer | null = null;
  let latest!: ReturnType<typeof useSessionWorkbench>;

  const Probe = ({ initialConnectionId = 'connection-a' }: { initialConnectionId?: string }) => {
    latest = useSessionWorkbench({ initialConnectionId });
    return null;
  };

  beforeEach(() => {
    sessionRpc.state.connections = connections;
    sessionRpc.list.mockReset();
    sessionRpc.action.mockReset();
    renderer = null;
  });

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  const render = async () => {
    await act(async () => {
      renderer = create(<Probe />);
    });
    // Flush the initial passive effect which starts the list request.
    await act(async () => {});
  };

  it('does not let an old connection response replace the selected connection', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<RpcResult>>>();
    sessionRpc.list.mockImplementation((config: { id: string }) => {
      const request = deferred<RpcResult>();
      pending.set(config.id, request);
      return request.promise;
    });

    await render();
    expect(pending.has('connection-a')).toBe(true);

    act(() => latest.setSelectedConnectionId('connection-b'));
    await act(async () => {});
    expect(pending.has('connection-b')).toBe(true);

    await act(async () => {
      pending.get('connection-b')?.resolve(response('row-b'));
    });
    await act(async () => {
      pending.get('connection-a')?.resolve(response('row-a'));
    });

    expect(latest.selectedConnectionId).toBe('connection-b');
    expect(latest.payload?.sessions[0]?.key).toBe('row-b');
  });

  it('marks an action stale and skips the old-scope refresh after switching connection', async () => {
    sessionRpc.list.mockResolvedValue(response('row-a'));
    const pendingAction = deferred<RpcResult>();
    sessionRpc.action.mockReturnValue(pendingAction.promise);

    await render();
    expect(latest.payload?.sessions[0]?.key).toBe('row-a');

    const actionPromise = latest.executeAction({
      action: 'terminateSession',
      sessionId: 'row-a',
    });

    act(() => latest.setSelectedConnectionId('connection-b'));
    await act(async () => {});
    pendingAction.resolve({ success: true, message: 'done' });
    const actionResult = await actionPromise;

    expect(actionResult.stale).toBe(true);
    expect(sessionRpc.action).toHaveBeenCalledOnce();
    // Only the new connection's automatic list request is allowed after the
    // switch; the action must not refresh connection A.
    expect(sessionRpc.list.mock.calls.map(([config]) => config.id)).toEqual([
      'connection-a',
      'connection-b',
    ]);
  });

  it('refreshes the same scope after a successful action without marking it stale', async () => {
    const pendingRefresh = deferred<RpcResult>();
    sessionRpc.list
      .mockResolvedValueOnce(response('row-a'))
      .mockReturnValueOnce(pendingRefresh.promise);
    sessionRpc.action.mockResolvedValue({ success: true, message: 'done' });

    await render();
    const actionPromise = latest.executeAction({
      action: 'terminateSession',
      sessionId: 'row-a',
    });

    await act(async () => {});
    expect(sessionRpc.list).toHaveBeenCalledTimes(2);
    await act(async () => pendingRefresh.resolve(response('row-a-after')));
    const actionResult = await actionPromise;
    expect(actionResult.stale).not.toBe(true);
    expect(latest.payload?.sessions[0]?.key).toBe('row-a-after');
  });
});
