import { message } from 'antd';
import React from 'react';

import { t } from '../../i18n';
import { isBackendCancelledResult } from '../../utils/connectionExport';
import type { DriverPackageExportChoice } from './DriverPackageExportPicker';
import {
  buildDriverPackageExportJobId,
  exportDriverPackage,
  inspectDriverPackage,
  selectDriverPackageZipFile,
  summarizeDriverPackageImport,
} from './driverPackageTransfer';
import { useDriverBatchImport } from './useDriverBatchImport';
import type { DriverPackageInspectSummary } from './driverPackageTransfer';
import type { DriverLocalInstallRow } from './useDriverLocalInstall';

// 驱动包 ZIP 的导出 / 批量导入编排。
//
// 批量安装刻意不做成 Go 侧方法：InstallLocalDriverPackage 内部的安装锁不可重入，
// 持锁循环会死锁，不持锁则失去原子性。这里沿用「打开驱动目录」那条既有范式 ——
// 前端逐驱动串行 await，复用同一个 installDriverFromLocalPath。

/** 导入终态在屏幕上保留的时长：足够看清 100% 与「已装 N 个」，又不至于挡路。 */
const DRIVER_IMPORT_SETTLE_DISMISS_MS = 1200;

const waitForDriverImportDismiss = (): Promise<void> => (
  new Promise((resolve) => {
    setTimeout(resolve, DRIVER_IMPORT_SETTLE_DISMISS_MS);
  })
);

type InstallDriverFromLocalPath<TRow> = (
  row: TRow,
  sourcePath: string,
  sourceLabel: 'file' | 'directory',
  options?: { silentToast?: boolean; skipRefresh?: boolean; versionOverride?: string },
) => Promise<boolean>;

export type UseDriverPackageTransferParams<TRow extends DriverLocalInstallRow> = {
  rows: TRow[];
  downloadDir: string;
  /** 驱动是否处于可安装状态（未在下载/安装中）。 */
  isDriverBusy: () => boolean;
  installDriverFromLocalPath: InstallDriverFromLocalPath<TRow>;
  refreshStatus: (
    toastOnError?: boolean,
    options?: { showLoading?: boolean; fresh?: boolean },
  ) => Promise<void> | void;
  resolveDriverErrorMessage: (
    rawMessage: string | undefined,
    fallback: string,
    wrapperKey?: string,
    params?: Record<string, unknown>,
    detailWrapperKeys?: string[],
  ) => string;
  runAfterDriverInterruptionConfirmation: (targetRows: TRow[], action: () => void | Promise<void>) => void;
};

export function useDriverPackageTransfer<TRow extends DriverLocalInstallRow>({
  rows,
  downloadDir,
  isDriverBusy,
  installDriverFromLocalPath,
  refreshStatus,
  resolveDriverErrorMessage,
  runAfterDriverInterruptionConfirmation,
}: UseDriverPackageTransferParams<TRow>) {
  const [exporting, setExporting] = React.useState(false);
  const [exportPickerOpen, setExportPickerOpen] = React.useState(false);
  const [exportJobId, setExportJobId] = React.useState('');
  const [inspecting, setInspecting] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [pendingPackage, setPendingPackage] = React.useState<DriverPackageInspectSummary | null>(null);
  const [forceOverwrite, setForceOverwrite] = React.useState(false);

  const installedExportDrivers = React.useMemo<DriverPackageExportChoice[]>(
    () => rows
      .filter((row) => !row.builtIn && row.packageInstalled)
      .map((row) => ({
        type: String(row.type || '').trim(),
        name: String(row.name || row.type || '').trim(),
        version: String(row.installedVersion || '').trim() || undefined,
      }))
      .filter((row) => row.type !== ''),
    [rows],
  );
  const installedDriverCount = installedExportDrivers.length;

  const {
    progress: importProgress,
    run: runImportBatch,
    requestCancel: requestImportCancel,
    resetProgress: resetImportProgress,
  } = useDriverBatchImport<TRow>({
    resolveRowType: (row) => String(row.type || '').trim().toLowerCase(),
    resolveRowName: (row) => String(row.name || row.type || '').trim(),
  });

  const requestExportDriverPackage = React.useCallback(() => {
    if (isDriverBusy() || exporting) {
      return;
    }
    setExportPickerOpen(true);
  }, [exporting, isDriverBusy]);

  const closeExportPicker = React.useCallback(() => {
    if (exporting) {
      return;
    }
    setExportPickerOpen(false);
  }, [exporting]);

  const confirmExportDriverPackage = React.useCallback(async (driverTypes: string[]) => {
    if (isDriverBusy() || exporting) {
      return;
    }
    setExportPickerOpen(false);
    const jobId = buildDriverPackageExportJobId();
    setExporting(true);
    // jobId 一落，进度条就挂上（组件内部自带占位态），
    // 不必等后端第一条事件 —— 保存对话框期间的空窗期因此可见。
    setExportJobId(jobId);
    try {
      await exportDriverPackage(downloadDir, jobId, driverTypes);
    } finally {
      setExporting(false);
      setExportJobId('');
    }
  }, [downloadDir, exporting, isDriverBusy]);

  /** 选包 → 解析 → 打开确认弹窗；不做任何安装。 */
  const requestImportDriverPackage = React.useCallback(async () => {
    if (isDriverBusy() || inspecting) {
      return;
    }
    setInspecting(true);
    try {
      // 只允许选择 .zip / .7z 驱动包，避免把 yaml、sql 等普通文件送进导入流程。
      const picked = await selectDriverPackageZipFile(downloadDir);
      if (!picked?.success) {
        // 用户取消不提示错误。
        if (!isBackendCancelledResult(picked)) {
          message.error(resolveDriverErrorMessage(
            picked?.message,
            t('driver_manager.import.inspect_failed', { detail: '' }),
          ));
        }
        return;
      }
      const zipPath = String((picked.data as Record<string, unknown> | undefined)?.path || '').trim();
      if (!zipPath) {
        return;
      }
      const summary = await inspectDriverPackage(zipPath, downloadDir);
      if (!summary) {
        return;
      }
      setForceOverwrite(false);
      setPendingPackage(summary);
    } finally {
      setInspecting(false);
    }
  }, [downloadDir, inspecting, isDriverBusy, resolveDriverErrorMessage]);

  const closeImportModal = React.useCallback(() => {
    if (importing) {
      return;
    }
    setPendingPackage(null);
    setForceOverwrite(false);
  }, [importing]);

  /** 确认后逐驱动串行安装；已安装且未开覆盖的跳过。 */
  const confirmImportDriverPackage = React.useCallback(async () => {
    const pkg = pendingPackage;
    if (!pkg || importing) {
      return;
    }

    const rowByType = new Map<string, TRow>();
    for (const row of rows) {
      rowByType.set(String(row.type || '').trim().toLowerCase(), row);
    }

    const targets: TRow[] = [];
    let skipped = 0;
    let blocked = 0;
    for (const item of pkg.drivers) {
      if (item.platformMismatch || item.revisionMismatch) {
        blocked += 1;
        continue;
      }
      if (item.installed && !forceOverwrite) {
        skipped += 1;
        continue;
      }
      const row = rowByType.get(String(item.driverType || '').trim().toLowerCase());
      if (!row) {
        blocked += 1;
        continue;
      }
      targets.push(row);
    }

    // 弹窗表格里已按平台/revision 过滤，targets 全部可装，没有跳过项。
    const versionByType = new Map<string, string>();
    for (const item of pkg.drivers) {
      versionByType.set(
        String(item.driverType || '').trim().toLowerCase(),
        String(item.version || '').trim(),
      );
    }

    const runImport = async (): Promise<void> => {
      setImporting(true);
      // 进度状态归属本弹窗；不复用主列表的 batchProgress，
      // 否则会覆写那边正在进行的批量安装显示。
      resetImportProgress();
      await runImportBatch({
        rows: targets,
        resolveSkipReason: () => null,
        install: (row) => installDriverFromLocalPath(row, pkg.path, 'file', {
          silentToast: true,
          skipRefresh: true,
          // 必须用包内版本：下拉里选的版本与 ZIP 里实际有什么无关，
          // mongodb v1/v2 变体会因此找不到条目。
          versionOverride: versionByType.get(String(row.type || '').trim().toLowerCase()) || '',
        }),
        onSettled: async (settled) => {
          // 顺序要紧：先刷新并显示终态，最后才关弹窗。
          // 若一上来就 setPendingPackage(null)，弹窗连同其中的进度条一起卸载，
          // 单驱动包（total=1）的进度只存在几十毫秒，用户永远看不到。
          setImporting(false);
          // fresh：导入刚改完盘上状态，复用导入前的在途请求会显示成「没装上」。
          await refreshStatus(false, { fresh: true });
          // 取消不算失败：未装完的项留在「未安装」，不进 failed 计数。
          const summary = summarizeDriverPackageImport({
            success: settled.success,
            failed: settled.failed,
            skipped: skipped + settled.skipped,
            blocked,
            canceled: settled.canceled,
          });
          const text = t(summary.key, summary.params);
          if (summary.level === 'success') {
            message.success(text);
          } else if (summary.level === 'warning') {
            message.warning(text);
          } else if (summary.level === 'error') {
            message.error(text);
          } else {
            message.info(text);
          }
          // 让终态（100% + 已装 N 个）留在屏幕上，用户点确认或等一会儿再收工。
          // 直接关闭会让「导入到底成没成」变成一次闪现。
          await waitForDriverImportDismiss();
          setPendingPackage(null);
          setForceOverwrite(false);
          // 弹窗已关闭，进度条随之收工；否则残留状态会在下次打开弹窗时先闪一帧旧值。
          resetImportProgress();
        },
      });
    };

    // 覆盖正在使用的驱动需要走既有的连接占用确认，避免绕过保护。
    if (forceOverwrite) {
      runAfterDriverInterruptionConfirmation(targets, runImport);
      return;
    }
    await runImport();
  }, [
    pendingPackage,
    importing,
    forceOverwrite,
    rows,
    installDriverFromLocalPath,
    refreshStatus,
    runAfterDriverInterruptionConfirmation,
    resetImportProgress,
    runImportBatch,
  ]);

  /** 用户点弹窗上的取消：终止队列中尚未启动的驱动。 */
  const cancelDriverPackageImport = React.useCallback(() => {
    requestImportCancel();
  }, [requestImportCancel]);

  return {
    exporting,
    exportJobId,
    exportPickerOpen,
    installedExportDrivers,
    closeExportPicker,
    confirmExportDriverPackage,
    inspecting,
    importing,
    importProgress,
    pendingPackage,
    forceOverwrite,
    setForceOverwrite,
    installedDriverCount,
    requestExportDriverPackage,
    requestImportDriverPackage,
    confirmImportDriverPackage,
    cancelDriverPackageImport,
    closeImportModal,
  };
}
