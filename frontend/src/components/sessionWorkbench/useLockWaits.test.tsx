import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_WAIT_AUTO_REFRESH_MS, useLockWaits, type LockWaitsState, type UseLockWaitsOptions } from './useLockWaits';

const rpc = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('./sessionWorkbenchRpc', () => ({
  listDatabaseLockWaits: rpc.list,
}));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const response = (waiting: string) => ({
  success: true,
  data: {
    engine: 'postgres',
    capability: { supported: true },
    waits: [{ key: waiting, waitingSessionId: waiting, blockingSessionId: '1' }],
  },
});

const connection = (id: string) => ({ id, name: id, config: { id, type: 'postgres' } }) as any;

let state: LockWaitsState;
function Probe(props: UseLockWaitsOptions) {
  state = useLockWaits(props);
  return null;
}

const mount = (props: UseLockWaitsOptions): ReactTestRenderer => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Probe {...props} />);
  });
  return renderer;
};

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
  });
};

describe('useLockWaits', () => {
  beforeEach(() => {
    rpc.list.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays idle until the lock view is opened', async () => {
    rpc.list.mockResolvedValue(response('2'));
    const renderer = mount({ connection: connection('a'), databaseName: 'shop', enabled: false, active: true });
    await flush();
    expect(rpc.list).not.toHaveBeenCalled();

    act(() => renderer.update(<Probe connection={connection('a')} databaseName="shop" enabled active />));
    await flush();
    expect(rpc.list).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'shop');
    expect(state.payload?.waits.map((wait) => wait.waitingSessionId)).toEqual(['2']);
  });

  it('drops a response that belongs to the previous connection', async () => {
    const slow = deferred<ReturnType<typeof response>>();
    rpc.list.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(response('9'));
    const renderer = mount({ connection: connection('a'), databaseName: '', enabled: true, active: true });

    act(() => renderer.update(<Probe connection={connection('b')} databaseName="" enabled active />));
    await flush();
    expect(state.payload?.waits[0].waitingSessionId).toBe('9');

    await act(async () => {
      slow.resolve(response('stale'));
      await slow.promise;
    });
    expect(state.payload?.waits[0].waitingSessionId).toBe('9');
  });

  it('reports a failed listing with the server message', async () => {
    rpc.list.mockResolvedValue({ success: false, message: 'permission denied' });
    mount({ connection: connection('a'), databaseName: '', enabled: true, active: true });
    await flush();
    expect(state.payload).toBeNull();
    expect(state.error).toBe('permission denied');
  });

  it('auto-refreshes only while enabled, active and switched on', async () => {
    vi.useFakeTimers();
    rpc.list.mockResolvedValue(response('2'));
    const renderer = mount({ connection: connection('a'), databaseName: '', enabled: true, active: true });
    await flush();
    expect(rpc.list).toHaveBeenCalledTimes(1);

    act(() => state.setAutoRefresh(true));
    await act(async () => {
      vi.advanceTimersByTime(LOCK_WAIT_AUTO_REFRESH_MS);
      await Promise.resolve();
    });
    expect(rpc.list).toHaveBeenCalledTimes(2);

    // A hidden tab stops polling.
    act(() => renderer.update(<Probe connection={connection('a')} databaseName="" enabled active={false} />));
    await act(async () => {
      vi.advanceTimersByTime(LOCK_WAIT_AUTO_REFRESH_MS * 3);
      await Promise.resolve();
    });
    expect(rpc.list).toHaveBeenCalledTimes(2);
  });
});
