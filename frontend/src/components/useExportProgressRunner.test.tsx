import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setCurrentLanguage } from '../i18n';
import {
  EXPORT_PROGRESS_TASK_LOG_LIMIT,
  EXPORT_PROGRESS_RETAINED_TASK_LIMIT,
  createInitialExportProgressState,
  finishExportProgressTask,
  getExportProgressTaskSnapshot,
  resetExportProgressTaskStoreForTests,
  startExportProgressTask,
} from './exportProgressTaskStore';
import { useExportProgressRunner } from './useExportProgressRunner';

const runtimeApi = vi.hoisted(() => {
  let exportProgressHandler: ((event: any) => void) | null = null;
  return {
    EventsOn: vi.fn((eventName: string, handler: (event: any) => void) => {
      if (eventName === 'export:progress') {
        exportProgressHandler = handler;
      }
      return () => {
        if (exportProgressHandler === handler) {
          exportProgressHandler = null;
        }
      };
    }),
    emitExportProgress: (event: any) => {
      exportProgressHandler?.(event);
    },
    reset: () => {
      exportProgressHandler = null;
    },
  };
});

const messageApi = vi.hoisted(() => ({
  warning: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../wailsjs/runtime/runtime', () => runtimeApi);

vi.mock('antd', () => ({
  message: messageApi,
}));

describe('useExportProgressRunner', () => {
  let runner: ReturnType<typeof useExportProgressRunner> | null = null;
  let renderer: ReactTestRenderer | null = null;
  let now = 1_000;

  const renderRunner = (taskKey?: string, requestKey?: string) => {
    const Harness = () => {
      runner = useExportProgressRunner({ showToast: false, taskKey, requestKey });
      return null;
    };

    act(() => {
      renderer = create(<Harness />);
    });
  };

  beforeEach(() => {
    resetExportProgressTaskStoreForTests();
    runner = null;
    renderer = null;
    now = 1_000;
    setCurrentLanguage('zh-CN');
    runtimeApi.reset();
    runtimeApi.EventsOn.mockClear();
    messageApi.warning.mockReset();
    messageApi.success.mockReset();
    messageApi.error.mockReset();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    resetExportProgressTaskStoreForTests();
    setCurrentLanguage('en-US');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('triggers a native browser download from a successful export descriptor', async () => {
    const anchor = {
      href: '',
      download: '',
      clicked: false,
      click() { this.clicked = true; },
    };
    const body = {
      appendChild: vi.fn(),
      removeChild: vi.fn(),
    };
    vi.stubGlobal('document', {
      body,
      createElement: () => anchor,
    });
    renderRunner();

    await act(async () => {
      await runner?.runExportWithProgress({
        title: 'Web CSV export',
        targetName: 'users',
        format: 'csv',
        run: async () => ({
          success: true,
          message: '',
          data: {
            webDownload: {
              token: 'download-1',
              fileName: 'users.csv',
              mimeType: 'text/csv',
              fileSize: 42,
            },
          },
        }),
      });
    });

    expect(anchor).toMatchObject({
      href: '/__gonavi/api/download/download-1',
      download: 'users.csv',
      clicked: true,
    });
    expect(body.appendChild).toHaveBeenCalledWith(anchor);
    expect(body.removeChild).toHaveBeenCalledWith(anchor);
    expect(runner?.state.status).toBe('done');
  });

  it('starts elapsed timing only after backend progress begins and path is selected', async () => {
    renderRunner();

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });

    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runExportWithProgress({
        title: '导出 SYS.test',
        targetName: 'SYS.test',
        format: 'xlsx',
        totalRows: 500_000,
        run: async () => pendingRun,
      }) || null;
      await Promise.resolve();
    });

    expect(runner?.state.status).toBe('start');
    expect(runner?.state.stage).toBe('等待选择导出文件');
    expect(runner?.state.startedAt).toBe(0);
    expect(runner?.state.filePath).toBe('');

    const jobId = runner?.state.jobId || '';
    expect(jobId).not.toBe('');

    now = 8_000;
    act(() => {
      runtimeApi.emitExportProgress({
        jobId,
        status: 'start',
        stage: '正在准备导出',
        filePath: '/Users/yangguofeng/Desktop/SYS.test.xlsx',
      });
    });

    expect(runner?.state.status).toBe('start');
    expect(runner?.state.stage).toBe('正在准备导出');
    expect(runner?.state.startedAt).toBe(8_000);
    expect(runner?.state.filePath).toBe('/Users/yangguofeng/Desktop/SYS.test.xlsx');

    now = 13_000;
    await act(async () => {
      resolveRun({ success: true, message: '导出完成' });
      await runPromise;
    });

    expect(runner?.state.status).toBe('done');
    expect(runner?.state.startedAt).toBe(8_000);
    expect(runner?.state.finishedAt).toBe(13_000);
  });

  it('treats zero total row hints as unknown progress', async () => {
    renderRunner();

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });

    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runExportWithProgress({
        title: '导出 messages',
        targetName: 'messages',
        format: 'xlsx',
        totalRows: 0,
        run: async () => pendingRun,
      }) || null;
      await Promise.resolve();
    });

    expect(runner?.state.totalRowsKnown).toBe(false);
    expect(runner?.state.total).toBe(0);

    const jobId = runner?.state.jobId || '';
    now = 5_000;
    act(() => {
      runtimeApi.emitExportProgress({
        jobId,
        status: 'running',
        stage: '正在写入文件',
        current: 754000,
        total: 0,
        totalRowsKnown: true,
      });
    });

    expect(runner?.state.status).toBe('running');
    expect(runner?.state.current).toBe(754000);
    expect(runner?.state.totalRowsKnown).toBe(false);
    expect(runner?.state.total).toBe(0);

    now = 7_000;
    await act(async () => {
      resolveRun({ success: true, message: '导出完成' });
      await runPromise;
    });

    expect(runner?.state.status).toBe('done');
    expect(runner?.state.totalRowsKnown).toBe(false);
  });

  it('switches to exact progress when backend start events later provide total rows', async () => {
    renderRunner();

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });

    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runExportWithProgress({
        title: '导出 SYS.test',
        targetName: 'SYS.test',
        format: 'xlsx',
        run: async () => pendingRun,
      }) || null;
      await Promise.resolve();
    });

    expect(runner?.state.totalRowsKnown).toBe(false);
    expect(runner?.state.total).toBe(0);

    const jobId = runner?.state.jobId || '';
    now = 4_000;
    act(() => {
      runtimeApi.emitExportProgress({
        jobId,
        status: 'start',
        stage: '正在准备导出',
        total: 96000,
        totalRowsKnown: true,
        filePath: '/Users/yangguofeng/Desktop/SYS.test.xlsx',
      });
    });

    expect(runner?.state.totalRowsKnown).toBe(true);
    expect(runner?.state.total).toBe(96000);
    expect(runner?.state.filePath).toBe('/Users/yangguofeng/Desktop/SYS.test.xlsx');

    act(() => {
      runtimeApi.emitExportProgress({
        jobId,
        status: 'running',
        stage: '正在写入文件',
        current: 24000,
      });
    });

    expect(runner?.state.current).toBe(24000);
    expect(runner?.state.total).toBe(96000);
    expect(runner?.state.totalRowsKnown).toBe(true);

    now = 8_000;
    await act(async () => {
      resolveRun({ success: true, message: '导出完成' });
      await runPromise;
    });

    expect(runner?.state.status).toBe('done');
    expect(runner?.state.total).toBe(96000);
    expect(runner?.state.totalRowsKnown).toBe(true);
  });

  it('restores a keyed task after unmount while backend progress and completion continue', async () => {
    renderRunner('table-export::conn-1::main::users', 'launch-request-1');

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });

    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runExportWithProgress({
        title: '导出 users',
        targetName: 'users',
        format: 'csv',
        totalRows: 100,
        run: async () => pendingRun,
      }) || null;
      await Promise.resolve();
    });

    const jobId = runner?.state.jobId || '';
    expect(jobId).not.toBe('');

    act(() => {
      renderer?.unmount();
      renderer = null;
    });

    now = 4_000;
    act(() => {
      runtimeApi.emitExportProgress({
        jobId,
        status: 'running',
        stage: '正在写入 CSV',
        current: 40,
        total: 100,
        totalRowsKnown: true,
        filePath: '/tmp/users.csv',
      });
    });

    now = 8_000;
    resolveRun({ success: true, message: '导出完成' });
    await runPromise;

    runner = null;
    renderRunner('table-export::conn-1::main::users', 'launch-request-1');
    const restoredRunner = runner as ReturnType<typeof useExportProgressRunner> | null;

    expect(restoredRunner?.state).toEqual(expect.objectContaining({
      jobId,
      status: 'done',
      current: 100,
      total: 100,
      filePath: '/tmp/users.csv',
      finishedAt: 8_000,
      requestKey: 'launch-request-1',
    }));
    expect(restoredRunner?.logs.map((entry) => entry.source)).toEqual([
      'client',
      'backend',
      'result',
    ]);
  });

  it('routes concurrent progress events to multiple keyed tasks by job id', async () => {
    let firstRunner: ReturnType<typeof useExportProgressRunner> | null = null;
    let secondRunner: ReturnType<typeof useExportProgressRunner> | null = null;

    const Harness = () => {
      firstRunner = useExportProgressRunner({ showToast: false, taskKey: 'export-task-first' });
      secondRunner = useExportProgressRunner({ showToast: false, taskKey: 'export-task-second' });
      return null;
    };
    const readFirstRunner = () => {
      const current = firstRunner as ReturnType<typeof useExportProgressRunner> | null;
      if (!current) throw new Error('first runner unavailable');
      return current;
    };
    const readSecondRunner = () => {
      const current = secondRunner as ReturnType<typeof useExportProgressRunner> | null;
      if (!current) throw new Error('second runner unavailable');
      return current;
    };

    act(() => {
      renderer = create(<Harness />);
    });

    let resolveFirst!: (value: { success: boolean; message: string }) => void;
    let resolveSecond!: (value: { success: boolean; message: string }) => void;
    const firstPending = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPending = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveSecond = resolve;
    });

    let firstRunPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    let secondRunPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      firstRunPromise = readFirstRunner().runExportWithProgress({
        title: '导出 first',
        targetName: 'first',
        format: 'csv',
        run: async () => firstPending,
      });
      secondRunPromise = readSecondRunner().runExportWithProgress({
        title: '导出 second',
        targetName: 'second',
        format: 'json',
        run: async () => secondPending,
      });
      await Promise.resolve();
    });

    const firstJobId = readFirstRunner().state.jobId;
    const secondJobId = readSecondRunner().state.jobId;
    expect(firstJobId).not.toBe(secondJobId);

    act(() => {
      runtimeApi.emitExportProgress({
        jobId: secondJobId,
        status: 'running',
        stage: 'second-stage',
        current: 20,
      });
      runtimeApi.emitExportProgress({
        jobId: firstJobId,
        status: 'running',
        stage: 'first-stage',
        current: 10,
      });
    });

    expect(readFirstRunner().state.stage).toBe('first-stage');
    expect(readFirstRunner().state.current).toBe(10);
    expect(readSecondRunner().state.stage).toBe('second-stage');
    expect(readSecondRunner().state.current).toBe(20);
    expect(runtimeApi.EventsOn).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({ success: true, message: 'first done' });
      resolveSecond({ success: true, message: 'second done' });
      await Promise.all([firstRunPromise, secondRunPromise]);
    });
  });

  it('treats a new request key as reopening the running keyed task', async () => {
    renderRunner('stable-backup-task', 'backup-request-1');

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });
    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runExportWithProgress({
        title: '备份 users',
        targetName: 'users',
        format: 'sql',
        run: async () => pendingRun,
      }) || null;
      await Promise.resolve();
    });
    const jobId = runner?.state.jobId || '';

    act(() => {
      renderer?.unmount();
      renderer = null;
    });
    runner = null;
    renderRunner('stable-backup-task', 'backup-request-2');
    await act(async () => {
      await Promise.resolve();
    });
    const readReopenedRunner = () => {
      const current = runner as ReturnType<typeof useExportProgressRunner> | null;
      if (!current) throw new Error('reopened runner unavailable');
      return current;
    };

    expect(readReopenedRunner().state).toEqual(expect.objectContaining({
      jobId,
      status: 'start',
      requestKey: 'backup-request-2',
    }));
    expect(readReopenedRunner().logs).toHaveLength(1);

    await act(async () => {
      resolveRun({ success: true, message: 'done' });
      await runPromise;
    });
    expect(readReopenedRunner().state).toEqual(expect.objectContaining({
      jobId,
      status: 'done',
      requestKey: 'backup-request-2',
    }));
  });

  it('starts each keyed job with a clean current-task log', async () => {
    renderRunner('repeatable-backup-task', 'backup-request-1');

    await act(async () => {
      await runner?.runExportWithProgress({
        title: 'first backup',
        targetName: 'users',
        format: 'sql',
        run: async () => ({ success: true, message: 'done' }),
      });
    });
    const firstJobId = runner?.state.jobId || '';
    expect(runner?.logs.length).toBeGreaterThan(1);

    let resolveSecond!: (value: { success: boolean; message: string }) => void;
    const secondRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveSecond = resolve;
    });
    let secondRunPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      secondRunPromise = runner?.runExportWithProgress({
        title: 'second backup',
        targetName: 'users',
        format: 'sql',
        run: async () => secondRun,
      }) || null;
      await Promise.resolve();
    });
    const secondJobId = runner?.state.jobId || '';

    expect(secondJobId).not.toBe(firstJobId);
    expect(runner?.logs).toHaveLength(1);
    expect(runner?.logs[0]).toEqual(expect.objectContaining({
      sequence: 1,
      jobId: secondJobId,
      source: 'client',
    }));

    await act(async () => {
      resolveSecond({ success: true, message: 'done' });
      await secondRunPromise;
    });
  });

  it('clears the pending task and its log when file selection is canceled', async () => {
    renderRunner('canceled-backup-task', 'backup-request-canceled');

    await act(async () => {
      await runner?.runExportWithProgress({
        title: 'canceled backup',
        targetName: 'users',
        format: 'sql',
        run: async () => ({ success: false, message: '已取消' }),
      });
    });

    expect(runner?.state.status).toBe('idle');
    expect(runner?.state.jobId).toBe('');
    expect(runner?.logs).toEqual([]);
  });

  it('caps structured progress logs while retaining the newest stages', async () => {
    renderRunner('export-task-with-many-stages');

    let resolveRun!: (value: { success: boolean; message: string }) => void;
    const pendingRun = new Promise<{ success: boolean; message: string }>((resolve) => {
      resolveRun = resolve;
    });

    let runPromise: Promise<{ success: boolean; message: string } | null> | null = null;
    await act(async () => {
      runPromise = runner?.runExportWithProgress({
        title: '导出 many stages',
        targetName: 'many_stages',
        format: 'csv',
        run: async () => pendingRun,
      }) || null;
      await Promise.resolve();
    });

    const jobId = runner?.state.jobId || '';
    act(() => {
      for (let index = 0; index < EXPORT_PROGRESS_TASK_LOG_LIMIT + 5; index += 1) {
        runtimeApi.emitExportProgress({
          jobId,
          status: 'running',
          stage: `stage-${index}`,
          current: index,
        });
      }
    });

    expect(runner?.logs).toHaveLength(EXPORT_PROGRESS_TASK_LOG_LIMIT);
    const latestLog = runner?.logs[(runner?.logs.length || 1) - 1];
    expect(latestLog).toEqual(expect.objectContaining({
      jobId,
      source: 'backend',
      status: 'running',
      stage: `stage-${EXPORT_PROGRESS_TASK_LOG_LIMIT + 4}`,
      current: EXPORT_PROGRESS_TASK_LOG_LIMIT + 4,
    }));
    expect((runner?.logs[0]?.sequence || 0) > 1).toBe(true);

    await act(async () => {
      resolveRun({ success: true, message: 'done' });
      await runPromise;
    });
  });

  it('evicts the oldest completed retained tasks after the global limit', () => {
    for (let index = 0; index <= EXPORT_PROGRESS_RETAINED_TASK_LIMIT; index += 1) {
      const taskKey = `retained-export-${index}`;
      const jobId = `retained-job-${index}`;
      expect(startExportProgressTask(taskKey, {
        ...createInitialExportProgressState(),
        open: true,
        jobId,
        status: 'start',
      }, true)).toBe(true);
      finishExportProgressTask(taskKey, jobId, (state) => ({
        ...state,
        status: 'done',
        finishedAt: index + 1,
      }));
    }

    expect(getExportProgressTaskSnapshot('retained-export-0', true).state.status).toBe('idle');
    expect(
      getExportProgressTaskSnapshot(`retained-export-${EXPORT_PROGRESS_RETAINED_TASK_LIMIT}`, true).state.status,
    ).toBe('done');
  });
});
