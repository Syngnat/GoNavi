import React from 'react';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const messageApi = vi.hoisted(() => ({
  loading: vi.fn(),
  error: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('antd', () => ({ message: messageApi }));

import { useNativeMenuUpdateCheck } from './useNativeMenuUpdateCheck';

const t = (key: string, params?: Record<string, unknown>) => (
  params ? `${key}:${JSON.stringify(params)}` : key
);

const setup = (checkForUpdates: (silent: boolean, openReleaseNotes?: boolean) => Promise<void>) => {
  let run!: () => Promise<void>;
  function Harness() {
    run = useNativeMenuUpdateCheck(checkForUpdates, t);
    return null;
  }
  act(() => {
    create(<Harness />);
  });
  return () => run();
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('useNativeMenuUpdateCheck', () => {
  it('runs the same manual check as the About button and spins until it finishes', async () => {
    let finish!: () => void;
    const checkForUpdates = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const run = setup(checkForUpdates);

    let pending!: Promise<void>;
    await act(async () => {
      pending = run();
    });
    // 与关于页按钮一致：非静默检查，发现新版本时打开更新日志 / 下载弹窗。
    expect(checkForUpdates).toHaveBeenCalledWith(false, true);
    expect(messageApi.loading).toHaveBeenCalledWith(expect.objectContaining({
      content: 'app.about.update_status.checking',
      duration: 0,
    }));
    expect(messageApi.destroy).not.toHaveBeenCalled();

    await act(async () => {
      finish();
      await pending;
    });
    const key = messageApi.loading.mock.calls[0][0].key;
    expect(messageApi.destroy).toHaveBeenCalledWith(key);
    expect(messageApi.error).not.toHaveBeenCalled();
  });

  it('reports a thrown failure and still removes the spinner', async () => {
    const run = setup(vi.fn(async () => {
      throw new Error('network down');
    }));

    await act(async () => {
      await run();
    });
    expect(messageApi.error).toHaveBeenCalledWith(
      `app.about.message.check_failed_with_error:${JSON.stringify({ error: 'network down' })}`,
    );
    expect(messageApi.destroy).toHaveBeenCalledTimes(1);
  });
});
