import { beforeEach, describe, expect, it, vi } from 'vitest';

const wailsRuntime = vi.hoisted(() => ({ EventsOn: vi.fn() }));
const addTab = vi.hoisted(() => vi.fn());
vi.mock('../../../wailsjs/runtime', () => wailsRuntime);
vi.mock('../../store', () => ({ useStore: { getState: () => ({ addTab }) } }));
vi.mock('../../utils/pluginManagerTab', () => ({
  buildPluginManagerWorkbenchTab: () => ({ id: 'plugin-manager', type: 'plugin-manager' }),
}));

import {
  consumePendingPluginInstall,
  peekPendingPluginInstall,
  startPluginInstallDeeplinkListener,
  subscribePluginInstallDeeplink,
} from './pluginInstallDeeplink';

type Handler = (data: unknown) => void;

// openPluginWorkbenchTab 是动态导入的异步路径，投递后要冲刷微任务才能断言 addTab。
const flushAsync = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function captureHandler(): Handler {
  let handler: Handler | undefined;
  wailsRuntime.EventsOn.mockImplementation((_event: string, callback: Handler) => {
    handler = callback;
    return () => {};
  });
  const stop = startPluginInstallDeeplinkListener();
  if (!handler) throw new Error('EventsOn was not subscribed');
  wailsRuntime.EventsOn.mockClear();
  void stop;
  return handler;
}

describe('plugin install deeplink listener', () => {
  beforeEach(() => {
    wailsRuntime.EventsOn.mockReset();
    wailsRuntime.EventsOn.mockImplementation(() => () => {});
    addTab.mockClear();
    consumePendingPluginInstall();
  });

  it('records the payload, notifies listeners and opens the plugin tab', async () => {
    const seen: unknown[] = [];
    const off = subscribePluginInstallDeeplink((payload) => seen.push(payload));
    const handler = captureHandler();

    handler({ spec: 'github:a/b', id: 'com.gonavi.x', raw: 'gonavi://plugin/install?spec=github%3Aa%2Fb' });
    await flushAsync();

    expect(seen).toEqual([{ spec: 'github:a/b', id: 'com.gonavi.x' }]);
    expect(peekPendingPluginInstall()).toEqual({ spec: 'github:a/b', id: 'com.gonavi.x' });
    expect(addTab).toHaveBeenCalledWith({ id: 'plugin-manager', type: 'plugin-manager' });
    // 消费一次即清空：面板挂载读取后，重复挂载不会重放旧链接。
    expect(consumePendingPluginInstall()).toEqual({ spec: 'github:a/b', id: 'com.gonavi.x' });
    expect(consumePendingPluginInstall()).toBeNull();
    off();
  });

  it('drops empty and malformed payloads, clamping oversized ones', async () => {
    const seen: unknown[] = [];
    const off = subscribePluginInstallDeeplink((payload) => seen.push(payload));
    const handler = captureHandler();

    for (const payload of [null, undefined, 'x', 42, {}, { spec: '   ' }, { id: 7 }]) {
      handler(payload);
    }
    expect(seen).toEqual([]);
    expect(peekPendingPluginInstall()).toBeNull();
    expect(addTab).not.toHaveBeenCalled();

    // 超长 spec 在前端按上限截断（后端 Parse 会再次严格校验）。
    handler({ spec: 'a'.repeat(300) });
    await flushAsync();
    expect(seen).toEqual([{ spec: 'a'.repeat(200) }]);
    off();
  });

  it('accepts an id-only payload (market service not connected yet)', async () => {
    const seen: unknown[] = [];
    const off = subscribePluginInstallDeeplink((payload) => seen.push(payload));
    const handler = captureHandler();

    handler({ spec: '', id: 'com.gonavi.sql-insights' });
    await flushAsync();

    expect(seen).toEqual([{ id: 'com.gonavi.sql-insights' }]);
    expect(addTab).toHaveBeenCalledTimes(1);
    off();
  });
});
