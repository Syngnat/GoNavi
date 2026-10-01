import { useCallback } from 'react';
import { message } from 'antd';

import { t } from '../../i18n';
import { isBackendCancelledResult } from '../../utils/connectionExport';
import {
  InstallLocalDriverPackage,
  SelectDriverPackageDirectory,
  SelectDriverPackageFile,
} from '../../../wailsjs/go/app/App';
import {
  formatDriverBatchSkipSummary,
  formatDriverLogVersionTip,
  formatDriverVersionTip,
  isSlimBuildInstallUnavailable,
  resolveDriverLocalSourceLabel,
  type DriverLocalSourceCode,
} from './driverLocalInstallPolicy';
import { useDriverBatchImport } from './useDriverBatchImport';

// 本地驱动安装编排（行内单文件 / 批量目录 / 批量 ZIP 包）。
// 从 DriverManagerModal 抽出，避免继续膨胀模态文件。
//
// versionOverride：批量 ZIP 导入必须用「包内解析出的版本」，不能用下拉框里
// 用户选的版本 —— mongodb 的 v1/v2 条目名不同，用错版本会直接报“包内条目缺失”。

export type DriverLocalInstallRow = {
  type: string;
  name: string;
  builtIn: boolean;
  pinnedVersion?: string;
  installedVersion?: string;
  packageInstalled: boolean;
  connectable: boolean;
  reasonCode?: string;
};

type DriverLocalInstallOptions = {
  silentToast?: boolean;
  skipRefresh?: boolean;
  versionOverride?: string;
};

type ResolveDriverErrorMessage = (
  rawMessage: string | undefined,
  fallback: string,
  wrapperKey?: string,
  params?: Record<string, unknown>,
  detailWrapperKeys?: string[],
) => string;

export type UseDriverLocalInstallParams<TRow extends DriverLocalInstallRow> = {
  rows: TRow[];
  downloadDir: string;
  refreshStatus: (
    toastOnError?: boolean,
    options?: { showLoading?: boolean; fresh?: boolean },
  ) => Promise<void> | void;
  appendOperationLog: (driverType: string, text: string) => void;
  updateDriverProgress: (
    driverType: string,
    progress: { status: 'start' | 'done' | 'error'; message: string; percent: number },
  ) => void;
  resolveDriverErrorMessage: ResolveDriverErrorMessage;
  clearDriverDownloadTaskId: (driverType: string) => void;
  /** 本地导入不产生下载任务，用它标记当前进度归属的驱动以避免误清。 */
  tasklessProgressOwnerRef: { current: string };
  setActionState: (state: { driverType: string; kind: 'local' | '' }) => void;
  setBatchDirectoryImporting: (importing: boolean) => void;
  runAfterDriverInterruptionConfirmation: (targetRows: TRow[], action: () => void | Promise<void>) => void;
  /** 当前驱动在下拉框中选中的版本（或推荐/固定版本）。 */
  resolveLocalImportVersion: (row: TRow) => string;
};

export function useDriverLocalInstall<TRow extends DriverLocalInstallRow>({
  rows,
  downloadDir,
  refreshStatus,
  appendOperationLog,
  updateDriverProgress,
  resolveDriverErrorMessage,
  clearDriverDownloadTaskId,
  tasklessProgressOwnerRef,
  setActionState,
  setBatchDirectoryImporting,
  runAfterDriverInterruptionConfirmation,
  resolveLocalImportVersion,
}: UseDriverLocalInstallParams<TRow>) {
  const {
    progress: batchDirectoryImportProgress,
    run: runBatchImport,
    requestCancel: requestBatchDirectoryImportCancel,
    resetProgress: resetBatchProgress,
  } = useDriverBatchImport<TRow>({
    resolveRowType: (row) => String(row.type || '').trim().toLowerCase(),
    resolveRowName: (row) => String(row.name || row.type || '').trim(),
  });

  const installDriverFromLocalPath = useCallback(async (
    row: TRow,
    sourcePath: string,
    sourceLabel: DriverLocalSourceCode,
    options?: DriverLocalInstallOptions,
  ) => {
    const pathText = String(sourcePath || '').trim();
    const localizedSourceLabel = resolveDriverLocalSourceLabel(sourceLabel);
    if (!pathText) {
      if (!options?.silentToast) {
        message.error(t('driver.modal.error.invalidLocalImport', { source: localizedSourceLabel }));
      }
      return false;
    }

    const normalizedDriverType = String(row.type || '').trim().toLowerCase();
    tasklessProgressOwnerRef.current = normalizedDriverType;
    setActionState({ driverType: row.type, kind: 'local' });
    clearDriverDownloadTaskId(row.type);
    updateDriverProgress(row.type, {
      status: 'start',
      message: t('driver.modal.progress.localImport.start'),
      percent: 0,
    });
    // 批量 ZIP 导入传 versionOverride（包内解析出的版本），否则沿用下拉框选择。
    const overrideVersion = String(options?.versionOverride || '').trim();
    const selectedVersion = overrideVersion || resolveLocalImportVersion(row);
    const versionTip = formatDriverVersionTip(selectedVersion);
    const logVersionTip = formatDriverLogVersionTip(selectedVersion);
    appendOperationLog(row.type, t('driver.modal.operationLog.localImport.start', {
      version: logVersionTip,
      source: localizedSourceLabel,
      path: pathText,
    }));
    try {
      const result = await InstallLocalDriverPackage(row.type, pathText, downloadDir, selectedVersion);
      if (!result?.success) {
        const errText = resolveDriverErrorMessage(
          result?.message,
          t('driver.modal.error.localImportDriver', { name: row.name }),
          undefined,
          { name: row.name },
          [
            'driver_manager.backend.message.local_import_failed_detail',
            'driver_manager.backend.message.metadata_write_failed_detail',
          ],
        );
        appendOperationLog(row.type, `[ERROR] ${errText}`);
        updateDriverProgress(row.type, {
          status: 'error',
          message: errText,
          percent: 0,
        });
        if (!options?.silentToast) {
          message.error(errText);
        }
        return false;
      }
      const doneMessage = t('driver.modal.operationLog.localImport.done', { version: logVersionTip });
      appendOperationLog(row.type, doneMessage);
      updateDriverProgress(row.type, {
        status: 'done',
        message: doneMessage,
        percent: 100,
      });
      if (!options?.silentToast) {
        message.success(t('driver.modal.success.localImportDriver', { name: row.name, version: versionTip }));
      }
      if (!options?.skipRefresh) {
        // 刚装完：必须绕过在途复用，否则列表停在安装前。
        await refreshStatus(false, { fresh: true });
      }
      return true;
    } finally {
      if (tasklessProgressOwnerRef.current === normalizedDriverType) {
        tasklessProgressOwnerRef.current = '';
      }
      setActionState({ driverType: '', kind: '' });
    }
  }, [
    appendOperationLog,
    clearDriverDownloadTaskId,
    downloadDir,
    refreshStatus,
    resolveDriverErrorMessage,
    resolveLocalImportVersion,
    setActionState,
    tasklessProgressOwnerRef,
    updateDriverProgress,
  ]);

  const installDriverFromLocalFile = useCallback(async (row: TRow) => {
    const fileRes = await SelectDriverPackageFile(downloadDir);
    if (!fileRes?.success) {
      if (!isBackendCancelledResult(fileRes)) {
        message.error(resolveDriverErrorMessage(fileRes?.message, t('driver.modal.error.selectPackageFile')));
      }
      return;
    }
    const filePath = String((fileRes?.data as any)?.path || '').trim();
    if (!filePath) {
      message.error(t('driver.modal.error.invalidPackageFile'));
      return;
    }
    await installDriverFromLocalPath(row, filePath, 'file');
  }, [downloadDir, installDriverFromLocalPath, resolveDriverErrorMessage]);

  const requestInstallDriverFromLocalFile = useCallback((row: TRow) => {
    runAfterDriverInterruptionConfirmation([row], () => installDriverFromLocalFile(row));
  }, [installDriverFromLocalFile, runAfterDriverInterruptionConfirmation]);

  const installDriversFromDirectory = useCallback(async (options?: { forceOverwrite?: boolean }) => {
    const forceOverwriteInstalled = options?.forceOverwrite === true;
    const directoryRes = await SelectDriverPackageDirectory(downloadDir);
    if (!directoryRes?.success) {
      if (!isBackendCancelledResult(directoryRes)) {
        message.error(resolveDriverErrorMessage(directoryRes?.message, t('driver.modal.error.selectPackageDirectory')));
      }
      return;
    }

    const directoryPath = String((directoryRes?.data as any)?.path || '').trim();
    if (!directoryPath) {
      message.error(t('driver.modal.error.invalidPackageDirectory'));
      return;
    }
    const optionalRows = rows.filter((item) => !item.builtIn);
    if (optionalRows.length === 0) {
      message.info(t('driver.modal.info.noImportableDrivers'));
      return;
    }

    setBatchDirectoryImporting(true);
    resetBatchProgress();
    const result = await runBatchImport({
      rows: optionalRows,
      resolveSkipReason: (row) => {
        const alreadyInstalled = row.packageInstalled || row.connectable;
        // 已安装且未开覆盖 → 去重跳过；开了覆盖则继续往下走到 slim 判定。
        if (alreadyInstalled && !forceOverwriteInstalled) {
          return 'installed';
        }
        if (isSlimBuildInstallUnavailable(row)) {
          return 'slim';
        }
        return null;
      },
      install: async (row) => {
        const alreadyInstalled = row.packageInstalled || row.connectable;
        if (alreadyInstalled && forceOverwriteInstalled) {
          appendOperationLog(row.type, t('driver.modal.operationLog.directoryImport.forceOverwrite'));
        }
        return installDriverFromLocalPath(row, directoryPath, 'directory', { silentToast: true, skipRefresh: true });
      },
      onSettled: async () => {
        setBatchDirectoryImporting(false);
        await refreshStatus(false, { fresh: true });
        // 进度条到此收工：沿用既有批量安装的收尾口径（那边在 finally 里清），
        // 否则它会永久停在列表上方，用户以为还在装。
        resetBatchProgress();
      },
    });

    const successCount = result.success;
    const failCount = result.failed;
    const dedupeSkipCount = result.skippedTypes.installed.length;
    const slimSkipCount = result.skippedTypes.slim.length;
    // 被跳过的项也要写日志，保持与手工循环时一致的可见性。
    for (const driverType of result.skippedTypes.installed) {
      appendOperationLog(driverType, t('driver.modal.operationLog.directoryImport.skipInstalled'));
    }
    for (const driverType of result.skippedTypes.slim) {
      appendOperationLog(driverType, t('driver.modal.operationLog.directoryImport.slimSkipped'));
    }
    // 取消时只报「已装 + 未装」，不再报成功/失败口径，否则会误导成出错。
    if (result.canceled) {
      message.info(t('driver.modal.batch.directoryImport.canceled', {
        success: successCount,
        pending: Math.max(0, result.total - result.completed),
      }));
      return;
    }

    const skipTip = formatDriverBatchSkipSummary(dedupeSkipCount, slimSkipCount);

    const forceTip = forceOverwriteInstalled ? t('driver.modal.batch.forceOverwriteTip') : '';
    if (failCount === 0) {
      message.success(t('driver.modal.batch.directoryImport.success', { force: forceTip, success: successCount, skip: skipTip }));
      return;
    }
    if (successCount > 0) {
      message.warning(t('driver.modal.batch.directoryImport.partial', { force: forceTip, success: successCount, failed: failCount, skip: skipTip }));
      return;
    }
    message.error(t('driver.modal.batch.directoryImport.failed', { force: forceTip, failed: failCount, skip: skipTip }));
  }, [
    appendOperationLog,
    downloadDir,
    installDriverFromLocalPath,
    refreshStatus,
    resolveDriverErrorMessage,
    rows,
    setBatchDirectoryImporting,
  ]);

  const requestInstallDriversFromDirectory = useCallback((options?: { forceOverwrite?: boolean }) => {
    if (options?.forceOverwrite !== true) {
      void installDriversFromDirectory(options);
      return;
    }
    const overwriteRows = rows.filter((item) => (
      !item.builtIn
      && (item.packageInstalled || item.connectable)
      && !isSlimBuildInstallUnavailable(item)
    ));
    runAfterDriverInterruptionConfirmation(overwriteRows, () => installDriversFromDirectory(options));
  }, [installDriversFromDirectory, rows, runAfterDriverInterruptionConfirmation]);

  /** 用户点进度条上的取消：终止队列中尚未启动的驱动。 */
  const cancelBatchDirectoryImport = useCallback(() => {
    requestBatchDirectoryImportCancel();
  }, [requestBatchDirectoryImportCancel]);

  return {
    installDriverFromLocalPath,
    requestInstallDriverFromLocalFile,
    requestInstallDriversFromDirectory,
    cancelBatchDirectoryImport,
    batchDirectoryImportProgress,
    isSlimBuildInstallUnavailable,
  };
}
