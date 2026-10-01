import type { DriverBatchCancellation } from './driverDownloadCancellation';

// 批量本地安装（ZIP 驱动包 / 驱动目录）的共享编排。
//
// 抽出理由：ZIP 导入与目录导入的循环此前各写了一遍，只有「跳过判定」与
// 「版本来源」两点差异。两份循环意味着两套取消语义、两处进度推进，迟早走形。
//
// 刻意不依赖 React：纯函数编排便于直接单测，也不需要 hook 环境。

/** 单个驱动的安装结果。 */
export type DriverBatchImportItemOutcome = 'success' | 'failed' | 'skipped';

/** 单项被跳过时的原因码，供调用方决定文案与计数归属。 */
export type DriverBatchImportSkipReason = 'installed' | 'slim' | 'unavailable';

export type DriverBatchImportProgress = {
  /** 已处理（含跳过）的项数。 */
  completed: number;
  /** 计划处理的总项数。 */
  total: number;
  success: number;
  failed: number;
  skipped: number;
  /** 当前正在安装的驱动名，用于进度条描述；空闲时为空串。 */
  currentName: string;
};

export const createDriverBatchImportProgress = (
  total: number,
  currentName = '',
): DriverBatchImportProgress => ({
  completed: 0,
  total: Math.max(0, total),
  success: 0,
  failed: 0,
  skipped: 0,
  currentName,
});

export type DriverBatchImportRunOptions<TRow> = {
  /** 待处理的行（调用方已完成平台/revision 等前置过滤）。 */
  rows: readonly TRow[];
  /**
   * 每项安装前的跳过判定。返回原因码即跳过；返回 null 表示继续安装。
   * 跳过计入 completed 与 skipped，不再调用 install。
   */
  resolveSkipReason: (row: TRow) => DriverBatchImportSkipReason | null;
  /** 实际安装；返回是否成功。 */
  install: (row: TRow) => Promise<boolean>;
  /** 取消句柄；每项 install 之前检查，已取消则剩余项不再启动。 */
  cancellation: DriverBatchCancellation;
  /** 每次状态变化后回调，用于驱动 UI。 */
  onProgress?: (progress: DriverBatchImportProgress) => void;
  /** 取当前项的可读名称（进度条展示），缺省用 driverType。 */
  resolveRowName?: (row: TRow) => string;
  /** 取行的驱动类型，用于统计与 cancel 归属。 */
  resolveRowType: (row: TRow) => string;
};

export type DriverBatchImportRunResult = DriverBatchImportProgress & {
  /** 是否因用户取消而提前结束（被取消时 completed < total）。 */
  canceled: boolean;
  /** 被跳过的驱动类型，按原因分组，便于调用方分别提示。 */
  skippedTypes: Record<DriverBatchImportSkipReason, string[]>;
};

/**
 * 逐驱动串行执行批量安装。
 *
 * 取消是协作式的：信号在**项与项之间**检查，正在安装的那一项会装完。
 * 这是刻意的 —— 每个驱动的安装在后端是一次原子替换（快照 + 提交 + 回滚），
 * 中途打断反而可能留下不一致状态；在一项边界上停下则天然干净。
 */
export const runDriverBatchImport = async <TRow,>(
  options: DriverBatchImportRunOptions<TRow>,
): Promise<DriverBatchImportRunResult> => {
  const { rows, resolveSkipReason, install, cancellation, onProgress, resolveRowType } = options;
  const resolveRowName = options.resolveRowName;

  const progress = createDriverBatchImportProgress(rows.length);
  const skippedTypes: Record<DriverBatchImportSkipReason, string[]> = {
    installed: [],
    slim: [],
    unavailable: [],
  };
  const publish = () => onProgress?.({ ...progress });
  let canceled = false;

  publish();

  for (const row of rows) {
    // 取消只在项边界生效：队列里尚未启动的驱动不再发给后端。
    if (cancellation.isRequested()) {
      canceled = true;
      break;
    }

    const rowType = resolveRowType(row);
    progress.currentName = resolveRowName ? resolveRowName(row) : rowType;

    const skipReason = resolveSkipReason(row);
    if (skipReason) {
      skippedTypes[skipReason].push(rowType);
      progress.skipped += 1;
      progress.completed += 1;
      publish();
      continue;
    }

    // 安装期间保持 currentName，让进度条显示正在处理谁。
    publish();

    let ok = false;
    try {
      ok = await install(row);
    } catch {
      // 单个驱动抛出不应中断整批：计为失败，继续下一项。
      ok = false;
    }

    // 用户可能在安装途中点了取消：该项已经装完，如实计入，但从下一项起停止。
    if (ok) {
      progress.success += 1;
    } else {
      progress.failed += 1;
    }
    progress.completed += 1;
    publish();

    if (cancellation.isRequested()) {
      canceled = true;
      break;
    }
  }

  progress.currentName = '';
  publish();
  // 取消信号可能在「最后一项刚装完、循环尾检查」时到达：此时实际已全部完成，
  // 再报「已取消」会误导用户以为有驱动没装上。
  const effectivelyCanceled = canceled && progress.completed < progress.total;
  return { ...progress, canceled: effectivelyCanceled, skippedTypes };
};
