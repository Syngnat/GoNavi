import React from 'react';

import {
  createDriverBatchImportProgress,
  runDriverBatchImport,
  type DriverBatchImportProgress,
  type DriverBatchImportRunResult,
  type DriverBatchImportSkipReason,
} from './driverBatchImportRunner';
import { createDriverBatchCancellation } from './driverDownloadCancellation';

// 批量本地安装（ZIP 驱动包 / 驱动目录）的进度与取消失控。
//
// 两条路径共用一份实现：它们此前各自手写「循环 + 计数 + setState」，
// 结果就是取消能力只长在其中一条上。共享后行为必然一致。

export type UseDriverBatchImportParams<TRow> = {
  /** 取行的驱动类型（统计与取消归属）。 */
  resolveRowType: (row: TRow) => string;
  /** 取行的可读名称（进度条描述）。 */
  resolveRowName?: (row: TRow) => string;
};

export type RunDriverBatchImportArgs<TRow> = {
  rows: readonly TRow[];
  resolveSkipReason: (row: TRow) => DriverBatchImportSkipReason | null;
  install: (row: TRow) => Promise<boolean>;
  /** 安装结束后的收尾（刷新状态等），取消路径同样会执行。 */
  onSettled?: (result: DriverBatchImportRunResult) => Promise<void> | void;
};

export function useDriverBatchImport<TRow>({
  resolveRowType,
  resolveRowName,
}: UseDriverBatchImportParams<TRow>) {
  const [progress, setProgress] = React.useState<DriverBatchImportProgress | null>(null);
  // 取消句柄用 ref 持有：循环体内要读到最新值，且不参与渲染依赖。
  const cancellationRef = React.useRef(createDriverBatchCancellation());

  const run = React.useCallback(async (args: RunDriverBatchImportArgs<TRow>) => {
    const cancellation = cancellationRef.current;
    // 新一轮开始前清掉上一轮的取消标记，否则第二次批量会立刻自停。
    cancellation.reset();
    setProgress(createDriverBatchImportProgress(args.rows.length));
    const result = await runDriverBatchImport<TRow>({
      rows: args.rows,
      resolveSkipReason: args.resolveSkipReason,
      install: args.install,
      cancellation,
      onProgress: setProgress,
      resolveRowName,
      resolveRowType,
    });
    // 进度条留在原位显示终态，由收尾方决定何时清空（导入弹窗还要展示汇总）。
    await args.onSettled?.(result);
    return result;
  }, [resolveRowName, resolveRowType]);

  const requestCancel = React.useCallback(() => {
    cancellationRef.current.request();
  }, []);

  const resetProgress = React.useCallback(() => {
    setProgress(null);
  }, []);

  return { progress, run, requestCancel, resetProgress };
}
