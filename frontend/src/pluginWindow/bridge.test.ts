import { describe, expect, it, vi } from 'vitest';
import { createPluginBridge, type FetchBridge } from './bridge';
import { bridgePrefix } from './protocol';

const identity = () => new Response(JSON.stringify({ pluginId: 'test.one', generation: 2, title: 'Fixture' }));

describe('plugin-scoped browser bridge', () => {
  it('offers no App reflection or plugin-ID selection', async () => {
    const fetcher = vi.fn<FetchBridge>().mockImplementation(async (url) => {
      return url === bridgePrefix + 'bootstrap' ? identity() : new Response('{"result":42}');
    });
    const bridge = createPluginBridge(fetcher, () => 'call-1');
    expect(Object.isFrozen(bridge)).toBe(true);
    // capability 与 pick 都是受控路由，不引入 App 反射。
    expect(Object.keys(bridge)).toEqual(['ready', 'invoke', 'capability', 'pickFile', 'pickFolder', 'close']);
    expect(await bridge.ready).toEqual({ pluginId: 'test.one', generation: 2, title: 'Fixture' });
    expect(await bridge.invoke('echo', { a: 1 })).toEqual({ result: 42 });
    const call = fetcher.mock.calls[1];
    expect(call[0]).toBe(bridgePrefix + 'invoke');
    expect(JSON.parse(String(call[1]?.body))).toEqual({ id: 'call-1', command: 'echo', arguments: { a: 1 } });
    expect(call[1]?.credentials).toBe('omit');
    expect(JSON.stringify(call)).not.toContain('token');
  });

  it('routes host capabilities through the capability bridge', async () => {
    const fetcher = vi.fn<FetchBridge>().mockImplementation(async (url) => {
      return url === bridgePrefix + 'bootstrap'
        ? identity()
        : new Response(JSON.stringify({ ok: true, data: { tables: ['users'] } }));
    });
    const bridge = createPluginBridge(fetcher, () => 'cap-1');
    await expect(bridge.capability('metadata.tables', { connectionId: 'conn-1', database: 'app' }))
      .resolves.toEqual({ ok: true, data: { tables: ['users'] } });
    const call = fetcher.mock.calls[1];
    expect(call[0]).toBe(bridgePrefix + 'capability');
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      id: 'cap-1',
      method: 'metadata.tables',
      arguments: { connectionId: 'conn-1', database: 'app' },
    });
  });

  it('rejects an empty capability method before sending', async () => {
    const fetcher = vi.fn<FetchBridge>().mockResolvedValue(identity());
    const bridge = createPluginBridge(fetcher, () => 'unused');
    await expect(bridge.capability('')).rejects.toThrow('invalid_method');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('routes native pickers locally and maps cancel to null', async () => {
    const fetcher = vi.fn<FetchBridge>().mockImplementation(async (url) => {
      if (url === bridgePrefix + 'bootstrap') return identity();
      if (url === bridgePrefix + 'pick-file') return new Response('{"path":"C:\\\\tmp\\\\a.zip"}');
      if (url === bridgePrefix + 'pick-folder') return new Response('{"path":""}');
      return new Response('{"result":42}');
    });
    const bridge = createPluginBridge(fetcher, () => 'call-1');
    expect(await bridge.pickFile({ title: 'up' })).toBe('C:\\tmp\\a.zip');
    const fileCall = fetcher.mock.calls.find(c => c[0] === bridgePrefix + 'pick-file');
    expect(JSON.parse(String(fileCall?.[1]?.body))).toEqual({ title: 'up' });
    expect(await bridge.pickFolder()).toBeNull();
  });

  it('sends explicit cancellation when a caller aborts', async () => {
    const fetcher = vi.fn<FetchBridge>().mockImplementation(async (url, init) => {
      if (url === bridgePrefix + 'bootstrap') return identity();
      if (url === bridgePrefix + 'cancel') return new Response(null, { status: 204 });
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const bridge = createPluginBridge(fetcher, () => 'blocking');
    const controller = new AbortController();
    const result = bridge.invoke('wait', null, { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    const cancel = fetcher.mock.calls.find(([url]) => url === bridgePrefix + 'cancel');
    expect(JSON.parse(String(cancel?.[1]?.body))).toEqual({ id: 'blocking' });
  });

  it('does not submit an already-aborted call', async () => {
    const fetcher = vi.fn<FetchBridge>().mockResolvedValue(identity());
    const bridge = createPluginBridge(fetcher, () => 'unused');
    const controller = new AbortController(); controller.abort();
    await expect(bridge.invoke('echo', null, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('caps pending invocations independently of close', async () => {
    const controllers = Array.from({ length: 8 }, () => new AbortController());
    let id = 0;
    const fetcher = vi.fn<FetchBridge>().mockImplementation(async (url, init) => {
      if (url === bridgePrefix + 'bootstrap') return identity();
      if (url === bridgePrefix + 'close' || url === bridgePrefix + 'cancel') return new Response(null, { status: 204 });
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const bridge = createPluginBridge(fetcher, () => String(++id));
    const calls = controllers.map((controller) => bridge.invoke('wait', null, { signal: controller.signal }).catch(() => undefined));
    await expect(bridge.invoke('extra')).rejects.toThrow('too_many_requests');
    await expect(bridge.close()).resolves.toBeUndefined();
    controllers.forEach((controller) => controller.abort());
    await Promise.all(calls);
  });
});
