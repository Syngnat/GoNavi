import { describe, expect, it, vi } from 'vitest';

import { createDriverBatchCancellation } from './driverDownloadCancellation';
import {
  createDriverBatchImportProgress,
  runDriverBatchImport,
  type DriverBatchImportProgress,
  type DriverBatchImportSkipReason,
} from './driverBatchImportRunner';

// 执行器是 ZIP 导入与目录导入共用的编排，取消语义集中在这里。
// 这些用例锁的是「取消在项边界生效」这条边界，改动循环体时它们应该先红。

type Row = { type: string; name: string };

const rows = (...types: string[]): Row[] => (
  types.map((type) => ({ type, name: type.toUpperCase() }))
);

const noSkip = (): DriverBatchImportSkipReason | null => null;

/** 固定成功的安装器，记录调用顺序。 */
const alwaysInstall = (calls: string[] = []) => (
  vi.fn(async (row: Row) => {
    calls.push(row.type);
    return true;
  })
);

describe('createDriverBatchImportProgress', () => {
  it('starts at zero with the given total', () => {
    expect(createDriverBatchImportProgress(3)).toEqual({
      completed: 0,
      total: 3,
      success: 0,
      failed: 0,
      skipped: 0,
      currentName: '',
    });
  });

  it('clamps a negative total to zero so percent math never divides oddly', () => {
    expect(createDriverBatchImportProgress(-5).total).toBe(0);
  });
});

describe('runDriverBatchImport', () => {
  it('runs every row in order and reports the final tally', async () => {
    const calls: string[] = [];
    const result = await runDriverBatchImport<Row>({
      rows: rows('a', 'b', 'c'),
      resolveSkipReason: noSkip,
      install: alwaysInstall(calls),
      cancellation: createDriverBatchCancellation(),
      resolveRowType: (row) => row.type,
    });

    expect(calls).toEqual(['a', 'b', 'c']);
    expect(result).toMatchObject({ completed: 3, total: 3, success: 3, failed: 0, canceled: false });
  });

  it('counts skipped rows into completed and groups them by reason', async () => {
    const install = alwaysInstall();
    const result = await runDriverBatchImport<Row>({
      rows: rows('a', 'b', 'c', 'd'),
      resolveSkipReason: (row) => {
        if (row.type === 'a') return 'installed';
        if (row.type === 'c') return 'slim';
        return null;
      },
      install,
      cancellation: createDriverBatchCancellation(),
      resolveRowType: (row) => row.type,
    });

    // 跳过项也算「已处理」，否则进度条永远到不了 100%。
    expect(result).toMatchObject({ completed: 4, total: 4, success: 2, failed: 0, skipped: 2 });
    expect(result.skippedTypes.installed).toEqual(['a']);
    expect(result.skippedTypes.slim).toEqual(['c']);
    // 被跳过的行不触发安装。
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('stops before the next row once cancellation is requested', async () => {
    const cancellation = createDriverBatchCancellation();
    const calls: string[] = [];
    const install = vi.fn(async (row: Row) => {
      calls.push(row.type);
      // 第一项装完的瞬间用户点了取消：本项已装完，后续不再启动。
      cancellation.request();
      return true;
    });

    const result = await runDriverBatchImport<Row>({
      rows: rows('a', 'b', 'c'),
      resolveSkipReason: noSkip,
      install,
      cancellation,
      resolveRowType: (row) => row.type,
    });

    expect(calls).toEqual(['a']);
    expect(install).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ completed: 1, total: 3, success: 1, canceled: true });
  });

  it('does not report cancellation when the cancellation lands after the last row finished', async () => {
    // 取消信号在「最后一项刚装完、循环尾检查」时到达 —— 实际全部装完，
    // 报「已取消」会让用户以为有驱动没装上。
    const cancellation = createDriverBatchCancellation();
    const result = await runDriverBatchImport<Row>({
      rows: rows('a', 'b'),
      resolveSkipReason: noSkip,
      install: async (row) => {
        // 只在最后一项请求取消：前面几项正常装完。
        if (row.type === 'b') {
          cancellation.request();
        }
        return true;
      },
      cancellation,
      resolveRowType: (row) => row.type,
    });

    expect(result).toMatchObject({ completed: 2, total: 2, success: 2, canceled: false });
  });

  it('reports cancellation when the signal lands mid-batch with rows still queued', async () => {
    // 与上一例的对照：同样是「装完当前项才收到信号」，但后面还有排队项，
    // 此时必须报取消 —— 确实有驱动没装上。
    const cancellation = createDriverBatchCancellation();
    const result = await runDriverBatchImport<Row>({
      rows: rows('a', 'b'),
      resolveSkipReason: noSkip,
      install: async (row) => {
        if (row.type === 'a') {
          cancellation.request();
        }
        return true;
      },
      cancellation,
      resolveRowType: (row) => row.type,
    });

    expect(result).toMatchObject({ completed: 1, total: 2, success: 1, canceled: true });
  });

  it('never starts the loop when cancellation is already requested', async () => {
    const cancellation = createDriverBatchCancellation();
    cancellation.request();
    const install = alwaysInstall();

    const result = await runDriverBatchImport<Row>({
      rows: rows('a', 'b'),
      resolveSkipReason: noSkip,
      install,
      cancellation,
      resolveRowType: (row) => row.type,
    });

    expect(install).not.toHaveBeenCalled();
    expect(result).toMatchObject({ completed: 0, total: 2, canceled: true });
  });

  it('treats a throwing installer as a failure and keeps going', async () => {
    // 单个驱动抛出不应中断整批：这是批量导入与单次安装的关键差别。
    const result = await runDriverBatchImport<Row>({
      rows: rows('a', 'b', 'c'),
      resolveSkipReason: noSkip,
      install: async (row) => {
        if (row.type === 'b') throw new Error('boom');
        return true;
      },
      cancellation: createDriverBatchCancellation(),
      resolveRowType: (row) => row.type,
    });

    expect(result).toMatchObject({ completed: 3, total: 3, success: 2, failed: 1, canceled: false });
  });

  it('counts a resolved false as a failure', async () => {
    const result = await runDriverBatchImport<Row>({
      rows: rows('a'),
      resolveSkipReason: noSkip,
      install: async () => false,
      cancellation: createDriverBatchCancellation(),
      resolveRowType: (row) => row.type,
    });

    expect(result).toMatchObject({ completed: 1, success: 0, failed: 1 });
  });

  it('publishes progress snapshots and clears the current name at the end', async () => {
    const snapshots: DriverBatchImportProgress[] = [];
    const result = await runDriverBatchImport<Row>({
      rows: rows('a', 'b'),
      resolveSkipReason: noSkip,
      install: async () => true,
      cancellation: createDriverBatchCancellation(),
      onProgress: (progress) => snapshots.push({ ...progress }),
      resolveRowName: (row) => row.name,
      resolveRowType: (row) => row.type,
    });

    // 首个快照是初始态，便于调用方立刻挂上进度条。
    expect(snapshots[0]).toMatchObject({ completed: 0, total: 2, currentName: '' });
    // 安装期间能读到正在处理谁。
    expect(snapshots.some((item) => item.currentName === 'A')).toBe(true);
    // 末尾必须清空，否则进度条会一直显示「正在处理 X」。
    expect(snapshots[snapshots.length - 1].currentName).toBe('');
    expect(result.currentName).toBe('');
  });

  it('falls back to the driver type when no name resolver is given', async () => {
    const names: string[] = [];
    await runDriverBatchImport<Row>({
      rows: rows('mariadb'),
      resolveSkipReason: noSkip,
      install: async () => true,
      cancellation: createDriverBatchCancellation(),
      onProgress: (progress) => names.push(progress.currentName),
      resolveRowType: (row) => row.type,
    });

    expect(names).toContain('mariadb');
  });

  it('handles an empty row list without publishing a bogus cancellation', async () => {
    const result = await runDriverBatchImport<Row>({
      rows: [],
      resolveSkipReason: noSkip,
      install: alwaysInstall(),
      cancellation: createDriverBatchCancellation(),
      resolveRowType: (row) => row.type,
    });

    expect(result).toMatchObject({ completed: 0, total: 0, canceled: false });
  });

  it('does not mutate the caller rows or the skip buckets of the next run', async () => {
    const cancellation = createDriverBatchCancellation();
    const first = await runDriverBatchImport<Row>({
      rows: rows('a'),
      resolveSkipReason: () => 'installed',
      install: alwaysInstall(),
      cancellation,
      resolveRowType: (row) => row.type,
    });
    // 复用同一个取消句柄跑第二轮：reset 由 hook 负责，这里只是确认桶不跨轮泄漏。
    cancellation.reset();
    const second = await runDriverBatchImport<Row>({
      rows: rows('a'),
      resolveSkipReason: () => 'slim',
      install: alwaysInstall(),
      cancellation,
      resolveRowType: (row) => row.type,
    });

    expect(first.skippedTypes.slim).toEqual([]);
    expect(second.skippedTypes.installed).toEqual([]);
    expect(second.skippedTypes.slim).toEqual(['a']);
  });
});
