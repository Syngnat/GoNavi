import { afterEach, describe, expect, it, vi } from 'vitest';

import { invokeAppWithSignal, isWebRPCAbortError } from './webRpc';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
});

describe('Web RPC cancellation facade', () => {
  it('passes the signal and original business arguments to the Web bridge', async () => {
    const invokeWithOptions = vi.fn().mockResolvedValue({ success: true });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __GONAVI_WEB_RPC__: { invokeWithOptions } },
    });
    const fallback = vi.fn().mockResolvedValue({ success: false });
    const controller = new AbortController();

    await expect(invokeAppWithSignal(
      'DataSyncPreview',
      [{ source: 'a' }, 'orders', 200],
      controller.signal,
      fallback,
    )).resolves.toEqual({ success: true });

    expect(invokeWithOptions).toHaveBeenCalledWith(
      'app',
      'App',
      'DataSyncPreview',
      [{ source: 'a' }, 'orders', 200],
      { signal: controller.signal },
    );
    expect(fallback).not.toHaveBeenCalled();
  });

  it('waits for the generated Wails binding even when the signal is aborted', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {},
    });
    const controller = new AbortController();
    controller.abort();
    const fallback = vi.fn().mockResolvedValue('wails-result');

    await expect(invokeAppWithSignal(
      'DBQueryWithCancel',
      [{}, 'db', 'select 1', 'query-1'],
      controller.signal,
      fallback,
    )).resolves.toBe('wails-result');
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('recognizes only the stable Web RPC abort code', () => {
    expect(isWebRPCAbortError({
      name: 'AbortError',
      code: 'WEB_RPC_ABORTED',
      dispatchState: 'possibly_dispatched',
    })).toBe(true);
    expect(isWebRPCAbortError(new DOMException('aborted', 'AbortError'))).toBe(false);
    expect(isWebRPCAbortError(new Error('WEB_RPC_ABORTED'))).toBe(false);
  });
});
