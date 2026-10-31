import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JSONValue } from '../plugins/types';
import { PAGE_CALL_TYPE, PAGE_MAX_ARGUMENT_BYTES, PAGE_RESULT_TYPE } from './bridgeProtocol';
import { createPageBridge } from './pageBridgeCore';

const TOKEN = 'frame-token-1';
const translate = (key: string) => key;
const describeError = (error: unknown) => (error instanceof Error ? error.message : 'plugin.pages.error.bridge');
const message = (id: string, over: Record<string, unknown> = {}) => ({
  type: PAGE_CALL_TYPE,
  token: TOKEN,
  id,
  method: 'app.info',
  arguments: {},
  ...over,
});

const setup = (call: (method: string, argumentsJSON: string) => Promise<JSONValue> = vi.fn(), extra: Record<string, unknown> = {}) => {
  const post = vi.fn();
  const onNotify = vi.fn();
  const bridge = createPageBridge({ token: TOKEN, post, call, translate, describeError, onNotify, ...extra });
  return { post, call, onNotify, bridge };
};

const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('page bridge pump', () => {
  it('resolves one call with the host value', async () => {
    const call = vi.fn().mockResolvedValue({ hostVersion: '1.0.0' });
    const { post, bridge } = setup(call);
    bridge.handle(message('r1'));
    expect(call).toHaveBeenCalledWith('app.info', '{}');
    await flush();
    expect(post).toHaveBeenCalledWith({ type: PAGE_RESULT_TYPE, id: 'r1', ok: true, value: { hostVersion: '1.0.0' } });
  });

  it('forwards the localized failure text when the host rejects', async () => {
    const call = vi.fn().mockRejectedValue(new Error('The plugin is not running.'));
    const { post, bridge } = setup(call);
    bridge.handle(message('r1'));
    await flush();
    expect(post).toHaveBeenCalledWith({ type: PAGE_RESULT_TYPE, id: 'r1', ok: false, error: 'The plugin is not running.' });
  });

  it('drops a message that does not carry this frame token without any reply', async () => {
    const call = vi.fn();
    const { post, bridge } = setup(call);
    bridge.handle(message('stale', { token: undefined }));
    bridge.handle(message('foreign', { token: 'another-frame' }));
    await flush();
    expect(call).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('caps one page at eight concurrent calls and answers the ninth locally', async () => {
    const resolvers: Array<(value: JSONValue) => void> = [];
    const call = vi.fn(() => new Promise<JSONValue>((resolve) => { resolvers.push(resolve); }));
    const { post, bridge } = setup(call);
    for (let index = 0; index < 8; index += 1) bridge.handle(message('r' + index));
    expect(call).toHaveBeenCalledTimes(8);
    bridge.handle(message('r8'));
    expect(post).toHaveBeenCalledWith({ type: PAGE_RESULT_TYPE, id: 'r8', ok: false, error: 'plugin.pages.error.bridge' });
    resolvers[0]({ index: 0 });
    await flush();
    expect(post).toHaveBeenCalledWith({ type: PAGE_RESULT_TYPE, id: 'r0', ok: true, value: { index: 0 } });
  });

  it('times out a slow call and ignores a response that arrives afterwards', async () => {
    let resolveLate: (value: JSONValue) => void = () => undefined;
    const call = vi.fn(() => new Promise<JSONValue>((resolve) => { resolveLate = resolve; }));
    const { post, bridge } = setup(call);
    bridge.handle(message('slow'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(post).toHaveBeenCalledWith({ type: PAGE_RESULT_TYPE, id: 'slow', ok: false, error: 'plugin.pages.error.timeout' });
    resolveLate({ late: true });
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('drops every late response and timer after the page unmounts', async () => {
    let resolveLate: (value: JSONValue) => void = () => undefined;
    const call = vi.fn(() => new Promise<JSONValue>((resolve) => { resolveLate = resolve; }));
    const { post, bridge } = setup(call);
    bridge.handle(message('r1'));
    bridge.dispose();
    resolveLate({ late: true });
    await vi.advanceTimersByTimeAsync(30_000);
    bridge.handle(message('r2'));
    expect(post).not.toHaveBeenCalled();
  });

  it('answers a malformed or oversized request instead of hanging the page promise', async () => {
    const { post, bridge } = setup();
    bridge.handle(message('big', { arguments: { text: 'x'.repeat(PAGE_MAX_ARGUMENT_BYTES) } }));
    bridge.handle(message('bad', { method: 'Not A Method' }));
    expect(post).toHaveBeenNthCalledWith(1, { type: PAGE_RESULT_TYPE, id: 'big', ok: false, error: 'plugin.pages.error.bridge' });
    expect(post).toHaveBeenNthCalledWith(2, { type: PAGE_RESULT_TYPE, id: 'bad', ok: false, error: 'plugin.pages.error.bridge' });
  });

  it('handles ui.notify locally and still answers the page', () => {
    const { post, onNotify, bridge } = setup();
    bridge.handle(message('n1', { method: 'ui.notify', arguments: { message: 'Saved', type: 'success' } }));
    expect(onNotify).toHaveBeenCalledWith('Saved', 'success');
    expect(post).toHaveBeenCalledWith({ type: PAGE_RESULT_TYPE, id: 'n1', ok: true, value: null });
    bridge.handle(message('n2', { method: 'ui.notify', arguments: { message: 42 } }));
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenLastCalledWith({ type: PAGE_RESULT_TYPE, id: 'n2', ok: false, error: 'plugin.pages.error.bridge' });
  });

  it('rejects a second request that reuses an in-flight id', async () => {
    const call = vi.fn(() => new Promise<JSONValue>(() => undefined));
    const { post, bridge } = setup(call);
    bridge.handle(message('dup'));
    bridge.handle(message('dup'));
    expect(post).toHaveBeenCalledWith({ type: PAGE_RESULT_TYPE, id: 'dup', ok: false, error: 'plugin.pages.error.bridge' });
  });
});

describe('page bridge rate limits', () => {
  it('allows 30 calls per ten seconds and rejects the 31st', async () => {
    let clock = 1_000;
    const call = vi.fn().mockResolvedValue({ ok: true });
    const { post, bridge } = setup(call, { now: () => clock });
    for (let index = 0; index < 30; index += 1) {
      bridge.handle(message('r' + index));
      await flush();
    }
    expect(call).toHaveBeenCalledTimes(30);
    bridge.handle(message('r30'));
    expect(post).toHaveBeenLastCalledWith({ type: PAGE_RESULT_TYPE, id: 'r30', ok: false, error: 'plugin.pages.error.bridge' });
    expect(call).toHaveBeenCalledTimes(30);
    clock += 10_001;
    bridge.handle(message('r31'));
    await flush();
    expect(call).toHaveBeenCalledTimes(31);
    expect(post).toHaveBeenLastCalledWith({ type: PAGE_RESULT_TYPE, id: 'r31', ok: true, value: { ok: true } });
  });

  it('allows 10 notifications per ten seconds and rejects the 11th', () => {
    let clock = 5_000;
    const { post, onNotify, bridge } = setup(vi.fn(), { now: () => clock });
    for (let index = 0; index < 10; index += 1) {
      bridge.handle(message('n' + index, { method: 'ui.notify', arguments: { message: 'tick' } }));
    }
    expect(onNotify).toHaveBeenCalledTimes(10);
    bridge.handle(message('n10', { method: 'ui.notify', arguments: { message: 'tick' } }));
    expect(onNotify).toHaveBeenCalledTimes(10);
    expect(post).toHaveBeenLastCalledWith({ type: PAGE_RESULT_TYPE, id: 'n10', ok: false, error: 'plugin.pages.error.bridge' });
    clock += 10_001;
    bridge.handle(message('n11', { method: 'ui.notify', arguments: { message: 'tick' } }));
    expect(onNotify).toHaveBeenCalledTimes(11);
  });
});
