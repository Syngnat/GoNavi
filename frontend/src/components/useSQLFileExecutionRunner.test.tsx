import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCurrentLanguage } from '../i18n';
import { useSQLFileExecutionRunner } from './useSQLFileExecutionRunner';

const runtimeApi = vi.hoisted(() => {
  let progressHandler: ((event: any) => void) | null = null;
  return {
    EventsOn: vi.fn((eventName: string, handler: (event: any) => void) => {
      if (eventName === 'sqlfile:progress') {
        progressHandler = handler;
      }
      return () => {
        if (progressHandler === handler) {
          progressHandler = null;
        }
      };
    }),
    emitProgress: (event: any) => {
      progressHandler?.(event);
    },
    reset: () => {
      progressHandler = null;
    },
  };
});

const messageApi = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../wailsjs/runtime/runtime', () => runtimeApi);

vi.mock('antd', () => ({
  message: messageApi,
}));

describe('useSQLFileExecutionRunner', () => {
  let runner: ReturnType<typeof useSQLFileExecutionRunner> | null = null;
  let renderer: ReactTestRenderer | null = null;
  let now = 1_000;

  const renderRunner = (showToast = false) => {
    const Harness = () => {
      runner = useSQLFileExecutionRunner({ showToast });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });
  };

  beforeEach(() => {
    runner = null;
    renderer = null;
    now = 1_000;
    setCurrentLanguage('zh-CN');
    runtimeApi.reset();
    runtimeApi.EventsOn.mockClear();
    messageApi.warning.mockReset();
    messageApi.success.mockReset();
    messageApi.error.mockReset();
    messageApi.info.mockReset();
    vi.useFakeTimers();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    setCurrentLanguage('en-US');
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts only one backend execution when called twice before React commits running state', async () => {
    renderRunner();

    let resolveFirstRun!: (value: { success: boolean; message: string }) => void;
    const pendingFirstRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveFirstRun = resolve;
    });
    const firstRun = vi.fn(async () => pendingFirstRun);
    const secondRun = vi.fn(async () => ({ success: true, message: 'must not run' }));
    let firstPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    let secondResult: { success: boolean; message: string } | null | undefined;

    await act(async () => {
      firstPromise = runner?.runSQLFileExecutionWithProgress({
        title: 'first.sql',
        filePath: 'D:/sql/first.sql',
        run: firstRun,
      }) || null;
      secondResult = await runner?.runSQLFileExecutionWithProgress({
        title: 'second.sql',
        filePath: 'D:/sql/second.sql',
        run: secondRun,
      });
    });

    expect(secondResult).toBeNull();
    expect(firstRun).toHaveBeenCalledTimes(1);
    expect(secondRun).not.toHaveBeenCalled();

    await act(async () => {
      resolveFirstRun({ success: true, message: 'done' });
      await firstPromise;
    });
  });

  it('keeps reset and rerun locked until the backend RPC settles after a terminal progress event', async () => {
    renderRunner();

    let resolveFirstRun!: (value: { success: boolean; message: string }) => void;
    const pendingFirstRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveFirstRun = resolve;
    });
    const firstRun = vi.fn(async () => pendingFirstRun);
    const secondRun = vi.fn(async () => ({ success: true, message: 'must not run' }));
    let firstPromise: Promise<{ success: boolean; message: string } | null> | null = null;

    await act(async () => {
      firstPromise = runner?.runSQLFileExecutionWithProgress({
        title: 'first.sql',
        filePath: 'D:/sql/first.sql',
        run: firstRun,
      }) || null;
      await Promise.resolve();
    });
    const firstJobId = runner?.state.jobId || '';

    act(() => {
      runtimeApi.emitProgress({ jobId: firstJobId, status: 'done', percent: 100 });
      vi.advanceTimersByTime(20);
    });
    expect(runner?.state.status).toBe('done');
    expect(runner?.isRunning).toBe(true);

    act(() => {
      runner?.reset();
    });
    expect(runner?.state.jobId).toBe(firstJobId);

    let secondResult: { success: boolean; message: string } | null | undefined;
    await act(async () => {
      secondResult = await runner?.runSQLFileExecutionWithProgress({
        title: 'second.sql',
        filePath: 'D:/sql/second.sql',
        run: secondRun,
      });
    });
    expect(secondResult).toBeNull();
    expect(secondRun).not.toHaveBeenCalled();

    await act(async () => {
      resolveFirstRun({ success: true, message: 'done' });
      await firstPromise;
    });
    expect(runner?.isRunning).toBe(false);

    act(() => {
      runner?.reset();
    });
    expect(runner?.state.status).toBe('idle');
  });

  it('keeps the active task cancellable when reset is requested before the RPC settles', async () => {
    renderRunner();

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });
    const cancel = vi.fn(async () => undefined);
    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runSQLFileExecutionWithProgress({
        title: 'active.sql',
        filePath: 'D:/sql/active.sql',
        run: async () => pendingRun,
        cancel,
      }) || null;
      await Promise.resolve();
    });
    const jobId = runner?.state.jobId || '';

    act(() => {
      runner?.reset();
    });
    expect(runner?.state.jobId).toBe(jobId);
    await act(async () => {
      await runner?.cancelExecution();
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledWith(jobId);

    await act(async () => {
      resolveRun({ success: false, message: '\u5df2\u53d6\u6d88' });
      await runPromise;
    });
  });

  it('starts timing after backend progress arrives and keeps execution details in sync', async () => {
    renderRunner();

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });

    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runSQLFileExecutionWithProgress({
        title: 'seed.sql',
        filePath: 'D:/sql/seed.sql',
        fileSizeMB: '512.5',
        run: async () => pendingRun,
      }) || null;
      await Promise.resolve();
    });

    expect(runner?.state.status).toBe('start');
    expect(runner?.state.stage).toBe('准备执行');
    expect(runner?.state.startedAt).toBe(0);
    expect(runner?.state.filePath).toBe('D:/sql/seed.sql');

    const jobId = runner?.state.jobId || '';
    now = 8_000;
    act(() => {
      runtimeApi.emitProgress({
        jobId,
        status: 'running',
        executed: 120,
        failed: 1,
        total: 500,
        percent: 24,
        currentSQL: 'insert into demo values (1)',
      });
      vi.advanceTimersByTime(20);
    });

    expect(runner?.state.status).toBe('running');
    expect(runner?.state.startedAt).toBe(8_000);
    expect(runner?.state.executed).toBe(120);
    expect(runner?.state.failed).toBe(1);
    expect(runner?.state.total).toBe(500);
    expect(runner?.state.percent).toBe(24);
    expect(runner?.state.currentSQL).toContain('insert into demo');

    now = 14_000;
    await act(async () => {
      resolveRun({ success: true, message: '执行完成' });
      await runPromise;
    });

    expect(runner?.state.status).toBe('done');
    expect(runner?.state.finishedAt).toBe(14_000);
    expect(runner?.state.message).toBe('执行完成');
  });

  it('keeps the task stopping after cancel acknowledgement until a terminal signal arrives', async () => {
    renderRunner();

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });
    const cancelSpy = vi.fn();

    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runSQLFileExecutionWithProgress({
        title: 'seed.sql',
        filePath: 'D:/sql/seed.sql',
        run: async () => pendingRun,
        cancel: async (jobId) => {
          cancelSpy(jobId);
        },
      }) || null;
      await Promise.resolve();
    });

    const jobId = runner?.state.jobId || '';
    await act(async () => {
      await runner?.cancelExecution();
    });

    expect(cancelSpy).toHaveBeenCalledWith(jobId);
    expect(runner?.state.status).toBe('stopping');
    expect(runner?.isRunning).toBe(true);

    act(() => {
      runtimeApi.emitProgress({
        jobId,
        status: 'running',
        executed: 10,
        percent: 100,
      });
      vi.advanceTimersByTime(20);
    });
    expect(runner?.state.status).toBe('stopping');

    now = 6_000;
    act(() => {
      runtimeApi.emitProgress({
        jobId,
        status: 'cancelled',
        executed: 11,
        percent: 100,
      });
      vi.advanceTimersByTime(20);
    });
    expect(runner?.state.status).toBe('cancelled');
    expect(runner?.state.executed).toBe(11);

    await act(async () => {
      resolveRun({ success: false, message: '已取消' });
      await runPromise;
    });

    expect(runner?.state.status).toBe('cancelled');
    expect(runner?.state.finishedAt).toBe(6_000);
  });

  it('uses the structured cancelled result independently of the active language', async () => {
    setCurrentLanguage('en-US');
    renderRunner();

    await act(async () => {
      await runner?.runSQLFileExecutionWithProgress({
        title: 'cancelled.sql',
        filePath: 'D:/sql/cancelled.sql',
        run: async () => ({
          success: false,
          message: 'Execution cancelled',
          data: { cancelled: true },
        }),
      });
    });

    expect(runner?.state.status).toBe('cancelled');
    expect(runner?.state.message).toBe('Execution cancelled');
  });

  it('does not rerun after cancel acknowledgement and lets a completed RPC win the race', async () => {
    renderRunner();

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });
    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runSQLFileExecutionWithProgress({
        title: 'cancel-race.sql',
        filePath: 'D:/sql/cancel-race.sql',
        run: async () => pendingRun,
        cancel: async () => undefined,
      }) || null;
      await Promise.resolve();
    });

    await act(async () => {
      await runner?.cancelExecution();
    });
    const rerun = vi.fn().mockResolvedValue({ success: true, message: 'unexpected rerun' });
    let rerunResult: { success: boolean; message: string } | null | undefined;
    await act(async () => {
      rerunResult = await runner?.runSQLFileExecutionWithProgress({
        title: 'cancel-race.sql',
        filePath: 'D:/sql/cancel-race.sql',
        run: rerun,
      });
    });
    expect(rerunResult).toBeNull();
    expect(rerun).not.toHaveBeenCalled();

    now = 7_000;
    await act(async () => {
      resolveRun({ success: true, message: 'completed before cancellation took effect' });
      await runPromise;
    });
    expect(runner?.state.status).toBe('done');
    expect(runner?.state.finishedAt).toBe(7_000);
    expect(runner?.isRunning).toBe(false);
  });

  it('keeps a running task below 100 percent until completion', async () => {
    renderRunner();

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });

    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runSQLFileExecutionWithProgress({
        title: 'small-prefetched.sql',
        filePath: 'D:/sql/small-prefetched.sql',
        run: async () => pendingRun,
      }) || null;
      await Promise.resolve();
    });

    const jobId = runner?.state.jobId || '';
    act(() => {
      runtimeApi.emitProgress({
        jobId,
        status: 'running',
        executed: 28,
        failed: 0,
        percent: 100,
      });
      vi.advanceTimersByTime(20);
    });

    expect(runner?.state.status).toBe('running');
    expect(runner?.state.percent).toBe(99);

    await act(async () => {
      resolveRun({ success: true, message: '执行完成' });
      await runPromise;
    });

    expect(runner?.state.status).toBe('done');
    expect(runner?.state.percent).toBe(100);
  });

  it('keeps 100 percent when the whole file completed with failed statements', async () => {
    renderRunner();

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });

    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runSQLFileExecutionWithProgress({
        title: 'completed-with-errors.sql',
        filePath: 'D:/sql/completed-with-errors.sql',
        run: async () => pendingRun,
      }) || null;
      await Promise.resolve();
    });

    act(() => {
      runtimeApi.emitProgress({
        jobId: runner?.state.jobId,
        status: 'done',
        executed: 27,
        failed: 1,
        percent: 100,
      });
      vi.advanceTimersByTime(20);
    });

    await act(async () => {
      resolveRun({ success: false, message: '1 statement failed' });
      await runPromise;
    });

    expect(runner?.state.status).toBe('error');
    expect(runner?.state.failed).toBe(1);
    expect(runner?.state.percent).toBe(100);
  });

  it('keeps the RPC error status when a queued done event flushes later', async () => {
    renderRunner();

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });

    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runSQLFileExecutionWithProgress({
        title: 'queued-done.sql',
        filePath: 'D:/sql/queued-done.sql',
        run: async () => pendingRun,
      }) || null;
      await Promise.resolve();
    });

    act(() => {
      runtimeApi.emitProgress({
        jobId: runner?.state.jobId,
        status: 'done',
        executed: 27,
        failed: 1,
        percent: 100,
      });
    });
    await act(async () => {
      resolveRun({ success: false, message: '1 statement failed' });
      await runPromise;
    });
    act(() => {
      vi.advanceTimersByTime(20);
    });

    expect(runner?.state.status).toBe('error');
    expect(runner?.state.failed).toBe(1);
    expect(runner?.state.percent).toBe(100);
  });

  it('keeps the complete RPC summary when a queued terminal error event flushes later', async () => {
    renderRunner();

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });

    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runSQLFileExecutionWithProgress({
        title: 'queued-error.sql',
        filePath: 'D:/sql/queued-error.sql',
        run: async () => pendingRun,
      }) || null;
      await Promise.resolve();
    });

    act(() => {
      runtimeApi.emitProgress({
        jobId: runner?.state.jobId,
        status: 'error',
        executed: 8,
        failed: 1,
        percent: 42,
        error: 'raw statement error',
      });
    });
    await act(async () => {
      resolveRun({ success: false, message: 'complete stop-on-error summary' });
      await runPromise;
    });
    act(() => {
      vi.advanceTimersByTime(20);
    });

    expect(runner?.state.status).toBe('error');
    expect(runner?.state.message).toBe('complete stop-on-error summary');
  });

  it('tracks source bytes, throughput and ETA for large SQL files', async () => {
    renderRunner();

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });
    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runSQLFileExecutionWithProgress({
        title: 'large.sql',
        filePath: 'D:/sql/large.sql',
        run: async () => pendingRun,
      }) || null;
      await Promise.resolve();
    });

    const jobId = runner?.state.jobId || '';
    now = 8_000;
    act(() => {
      runtimeApi.emitProgress({ jobId, status: 'running', bytesRead: 0, totalBytes: 20 * 1024 * 1024 });
      vi.advanceTimersByTime(20);
    });
    now = 18_000;
    act(() => {
      runtimeApi.emitProgress({ jobId, status: 'running', bytesRead: 10 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 });
      vi.advanceTimersByTime(20);
    });

    expect(runner?.state.bytesRead).toBe(10 * 1024 * 1024);
    expect(runner?.state.totalBytes).toBe(20 * 1024 * 1024);
    expect(runner?.state.bytesPerSecond).toBe(1024 * 1024);
    expect(runner?.state.etaSeconds).toBe(10);

    await act(async () => {
      resolveRun({ success: true, message: 'done' });
      await runPromise;
    });
  });
});
