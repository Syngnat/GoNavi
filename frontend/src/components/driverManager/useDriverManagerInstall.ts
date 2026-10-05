import { useCallback, useMemo } from 'react';
import {
  type DriverStatusRow,
  buildFallbackVersionOptions,
  resolvePreferredVersionOption,
  buildVersionOptionKey,
} from './driverManagerModel';
import { t } from '../../i18n';
import {
  shouldAbortDriverInstall,
  normalizeDriverDownloadTaskSnapshot,
  waitForDriverDownloadTask,
} from './driverDownloadCancellation';
import { StartDriverPackageDownload, ListDriverDownloadTasks } from '../../../wailsjs/go/app/App';
import { message } from 'antd';
import Modal from '../common/ResizableDraggableModal';
import { useDriverLocalInstall } from './useDriverLocalInstall';
import { useDriverPackageTransfer } from './useDriverPackageTransfer';
import { isWebRuntime } from '../../utils/browserFileTransfer';
import type { DriverManagerStateApi } from './useDriverManagerState';
import type { DriverManagerProgressApi } from './useDriverManagerProgress';
import type { DriverManagerStatusLoadingApi } from './useDriverManagerStatusLoading';

export interface UseDriverManagerInstallInput {
  versionMap: DriverManagerStateApi['versionMap'];
  selectedVersionMap: DriverManagerStateApi['selectedVersionMap'];
  installSessions: DriverManagerProgressApi['installSessions'];
  cancelIntents: DriverManagerProgressApi['cancelIntents'];
  batchCancellation: DriverManagerProgressApi['batchCancellation'];
  cancelDriverDownloadTask: DriverManagerProgressApi['cancelDriverDownloadTask'];
  setActionState: DriverManagerStateApi['setActionState'];
  clearDriverDownloadTaskId: DriverManagerStateApi['clearDriverDownloadTaskId'];
  updateDriverProgress: DriverManagerStateApi['updateDriverProgress'];
  loadVersionOptions: DriverManagerStatusLoadingApi['loadVersionOptions'];
  downloadDir: DriverManagerStateApi['downloadDir'];
  resolveDriverErrorMessage: DriverManagerStateApi['resolveDriverErrorMessage'];
  appendOperationLog: DriverManagerProgressApi['appendOperationLog'];
  applyDriverDownloadTaskSnapshot: DriverManagerProgressApi['applyDriverDownloadTaskSnapshot'];
  clearDriverProgress: DriverManagerStateApi['clearDriverProgress'];
  refreshStatus: DriverManagerStatusLoadingApi['refreshStatus'];
  rows: DriverManagerStateApi['rows'];
  tasklessProgressOwnerRef: DriverManagerStateApi['tasklessProgressOwnerRef'];
  setBatchDirectoryImporting: DriverManagerStateApi['setBatchDirectoryImporting'];
  driverMutationBusy: DriverManagerStateApi['driverMutationBusy'];
  batchDirectoryImporting: DriverManagerStateApi['batchDirectoryImporting'];
  batchBusy: DriverManagerStateApi['batchBusy'];
  actionState: DriverManagerStateApi['actionState'];
}

export const useDriverManagerInstall = ({
  versionMap,
  selectedVersionMap,
  installSessions,
  cancelIntents,
  batchCancellation,
  cancelDriverDownloadTask,
  setActionState,
  clearDriverDownloadTaskId,
  updateDriverProgress,
  loadVersionOptions,
  downloadDir,
  resolveDriverErrorMessage,
  appendOperationLog,
  applyDriverDownloadTaskSnapshot,
  clearDriverProgress,
  refreshStatus,
  rows,
  tasklessProgressOwnerRef,
  setBatchDirectoryImporting,
  driverMutationBusy,
  batchDirectoryImporting,
  batchBusy,
  actionState,
}: UseDriverManagerInstallInput) => {
  const resolveLocalImportVersion = useCallback((row: DriverStatusRow) => {
    const loadedOptions = versionMap[row.type] || [];
    const options = loadedOptions.length > 0 ? loadedOptions : buildFallbackVersionOptions(row);
    const selectedOption = resolvePreferredVersionOption(row, options, selectedVersionMap[row.type]);
    return selectedOption?.version || row.pinnedVersion || '';
  }, [selectedVersionMap, versionMap]);

  const resolveSelectedVersionOption = useCallback((row: DriverStatusRow) => {
    const options = versionMap[row.type] || [];
    const selectedKey = selectedVersionMap[row.type];
    return (
      options.find((item) => buildVersionOptionKey(item) === selectedKey) ||
      options.find((item) => item.recommended) ||
      options[0]
    );
  }, [selectedVersionMap, versionMap]);

  const resolveInstalledDriverVersion = useCallback((row: DriverStatusRow) => (
    String(row.installedVersion || '').trim() || String(row.pinnedVersion || '').trim()
  ), []);

  const isDriverVersionSwitchPending = useCallback((row: DriverStatusRow) => {
    if (row.builtIn || (!row.packageInstalled && !row.connectable)) {
      return false;
    }
    const selectedVersion = String(resolveSelectedVersionOption(row)?.version || '').trim();
    const installedVersion = resolveInstalledDriverVersion(row);
    return !!selectedVersion && !!installedVersion && selectedVersion !== installedVersion;
  }, [resolveInstalledDriverVersion, resolveSelectedVersionOption]);

  const installDriver = useCallback(async (
    row: DriverStatusRow,
    actionOptions?: { silentToast?: boolean; skipRefresh?: boolean; awaitCompletion?: boolean },
  ) => {
    const normalizedDriverType = String(row.type || '').trim().toLowerCase();
    const session = installSessions.begin(normalizedDriverType);
    cancelIntents.clear(normalizedDriverType);
    setActionState({ driverType: row.type, kind: 'install' });
    clearDriverDownloadTaskId(row.type);
    updateDriverProgress(row.type, {
      status: 'start',
      message: t('driver.modal.progress.install.start'),
      percent: 0,
    });
    try {
      let versionOptions = versionMap[row.type] || [];
      if (versionOptions.length === 0) {
        versionOptions = await loadVersionOptions(row, true);
      }
      const fallbackOptions = buildFallbackVersionOptions(row);
      const fallbackSelectedKey = fallbackOptions[0]
        ? buildVersionOptionKey(fallbackOptions[0])
        : undefined;
      const selectedOption = resolvePreferredVersionOption(
        row,
        versionOptions,
        selectedVersionMap[row.type] || fallbackSelectedKey,
      );
      const selectedVersion = selectedOption?.version || row.pinnedVersion || '';
      const selectedDownloadURL = selectedOption?.downloadUrl || row.defaultDownloadUrl || '';
      if (!installSessions.isCurrent(normalizedDriverType, session) || shouldAbortDriverInstall(normalizedDriverType, cancelIntents.isRequested, batchCancellation.isRequested())) {
        return false;
      }
      const result = await StartDriverPackageDownload(row.type, selectedVersion, selectedDownloadURL, downloadDir);
      if (!installSessions.isCurrent(normalizedDriverType, session) || shouldAbortDriverInstall(normalizedDriverType, cancelIntents.isRequested, batchCancellation.isRequested())) {
        const startedTask = normalizeDriverDownloadTaskSnapshot((result?.data as { task?: unknown } | undefined)?.task);
        if (startedTask?.taskId) {
          await cancelDriverDownloadTask(row.type, startedTask.taskId, row.name, { silentToast: true });
        }
        return false;
      }
      if (!result?.success) {
        const errText = resolveDriverErrorMessage(
          result?.message,
          t('driver.modal.error.installDriver', { name: row.name }),
          undefined,
          { name: row.name },
          [
            'driver_manager.backend.message.download_failed_detail',
            'driver_manager.backend.message.metadata_write_failed_detail',
          ],
        );
        appendOperationLog(row.type, `[ERROR] ${errText}`);
        updateDriverProgress(row.type, {
          status: 'error',
          message: errText,
          percent: 0,
        });
        if (!actionOptions?.silentToast) {
          message.error(errText);
        }
        return false;
      }

      const task = normalizeDriverDownloadTaskSnapshot((result.data as { task?: unknown } | undefined)?.task);
      if (!task) {
        return true;
      }
      applyDriverDownloadTaskSnapshot(task);
      if (task.driverType !== normalizedDriverType) {
        // The backend serializes driver installs because they share a
        // process-wide download directory. Do not leave a phantom local
        // task behind when another manager instance already owns it.
        clearDriverProgress(row.type);
        return !actionOptions?.awaitCompletion;
      }
      if (!actionOptions?.awaitCompletion) {
        return true;
      }
      const finishedTask = await waitForDriverDownloadTask(task.taskId, {
        listTasks: ListDriverDownloadTasks,
        onSnapshot: applyDriverDownloadTaskSnapshot,
      });
      if (!finishedTask) {
        appendOperationLog(row.type, `[ERROR] ${t('driver_manager.message.install_failed_fallback', { name: row.name })}`);
        return false;
      }
      if (finishedTask.status !== 'done') {
        return false;
      }
      if (!actionOptions?.skipRefresh) {
        // 变更后必须拿新数据：复用安装前的在途请求会让列表停在旧状态。
        await refreshStatus(false, { fresh: true });
      }
      return true;
    } catch (error) {
      if (!installSessions.isCurrent(normalizedDriverType, session) || shouldAbortDriverInstall(normalizedDriverType, cancelIntents.isRequested, batchCancellation.isRequested())) {
        return false;
      }
      const errText = error instanceof Error
        ? error.message
        : String(error || t('driver_manager.message.install_failed_fallback', { name: row.name }));
      appendOperationLog(row.type, `[ERROR] ${errText}`);
      updateDriverProgress(row.type, {
        status: 'error',
        message: errText,
        percent: 0,
      });
      if (!actionOptions?.silentToast) {
        message.error(errText);
      }
      return false;
    } finally {
      if (installSessions.isCurrent(normalizedDriverType, session)) setActionState({ driverType: '', kind: '' });
    }
  }, [appendOperationLog, applyDriverDownloadTaskSnapshot, batchCancellation, cancelDriverDownloadTask, cancelIntents, clearDriverDownloadTaskId, clearDriverProgress, downloadDir, installSessions, loadVersionOptions, refreshStatus, resolveDriverErrorMessage, selectedVersionMap, updateDriverProgress, versionMap]);

  const runAfterDriverInterruptionConfirmation = useCallback((
    targetRows: DriverStatusRow[],
    action: () => void | Promise<unknown>,
  ) => {
    const activeConnections = targetRows.reduce(
      (total, item) => total + Math.max(0, Number(item.activeConnections || 0)),
      0,
    );
    if (activeConnections === 0) {
      void action();
      return;
    }
    Modal.confirm({
      title: t('driver.modal.confirm.reinstallInUse.title'),
      content: t('driver.modal.confirm.reinstallInUse.content', { count: activeConnections }),
      okText: t('driver.modal.confirm.reinstallInUse.ok'),
      okButtonProps: { danger: true },
      cancelText: t('common.action.cancel'),
      onOk: action,
    });
  }, []);

  const requestInstallDriver = useCallback((row: DriverStatusRow) => {
    runAfterDriverInterruptionConfirmation([row], () => installDriver(row));
  }, [installDriver, runAfterDriverInterruptionConfirmation]);

  const {
    installDriverFromLocalPath,
    requestInstallDriverFromLocalFile,
    requestInstallDriversFromDirectory,
    cancelBatchDirectoryImport,
    batchDirectoryImportProgress,
  } = useDriverLocalInstall({
    rows: rows as DriverStatusRow[],
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
  });

  // 除导出自身以外的忙碌态：导出用它判断能否开始，否则会被自己挡住。
  const driverBusyExcludingExport = driverMutationBusy || batchDirectoryImporting;

  const {
    exporting: driverPackageExporting,
    exportJobId: driverPackageExportJobId,
    inspecting: driverPackageInspecting,
    importing: driverPackageImporting,
    importProgress: driverPackageImportProgress,
    pendingPackage: driverPackagePending,
    forceOverwrite: driverPackageForceOverwrite,
    setForceOverwrite: setDriverPackageForceOverwrite,
    installedDriverCount,
    exportPickerOpen: driverPackageExportPickerOpen,
    installedExportDrivers: driverPackageExportDrivers,
    closeExportPicker: closeDriverPackageExportPicker,
    confirmExportDriverPackage: confirmDriverPackageExport,
    requestExportDriverPackage,
    requestImportDriverPackage,
    confirmImportDriverPackage,
    cancelDriverPackageImport,
    closeImportModal: closeDriverPackageImportModal,
  } = useDriverPackageTransfer({
    rows: rows as DriverStatusRow[],
    downloadDir,
    isDriverBusy: () => driverBusyExcludingExport,
    installDriverFromLocalPath,
    refreshStatus,
    resolveDriverErrorMessage,
    runAfterDriverInterruptionConfirmation,
  });

  // 变更类操作在导出期间必须禁用：Go 侧导出取全类型排他锁，持锁期间点安装会
  // 静默阻塞到导出结束。该约束已分别落在行级（isDriverRowActionDisabled）与
  // 批量级（driverBatchOperationBusy）两处判定里，不再需要全局的合并标志。

  // 批量操作的门控：只取「多行级」互斥源 —— 另一个批量、目录导入、导出排他锁。
  // 刻意不含单驱动的在途安装/下载：它们操作的是别的驱动，Go 侧安装锁已按类型分片，
  // 用全局门控会把「删除所有驱动」也锁死（截图里 IoTDB 在装 → 删除按钮全灰）。
  const driverBatchOperationBusy = batchBusy || batchDirectoryImporting || driverPackageExporting;

  // 行级忙碌判定：Go 侧安装锁已按驱动类型分片（见 driver_install_lock.go），
  // 不同类型可并行，所以「别的驱动在装」不该禁用本行。只有三种情况要禁用本行：
  // 导出中（排他锁）、批量操作中（一次改多行）、本行自己在装/删。
  const isDriverRowActionDisabled = useCallback(
    (driverType: string): boolean => (
      driverPackageExporting
      || batchBusy
      || actionState.driverType === driverType
    ),
    [actionState.driverType, batchBusy, driverPackageExporting],
  );

  // Web 运行时没有本机保存对话框，驱动包导出/导入不可用。
  const packageTransferDisabled = useMemo(
    () => isWebRuntime() || driverBusyExcludingExport || driverPackageExporting,
    [driverBusyExcludingExport, driverPackageExporting],
  );
  const packageTransferDisabledReason = useMemo(
    () => (isWebRuntime() ? t('driver_manager.action.package_transfer_desktop_only') : ''),
    [],
  );
  return {
    resolveSelectedVersionOption,
    resolveInstalledDriverVersion,
    isDriverVersionSwitchPending,
    installDriver,
    runAfterDriverInterruptionConfirmation,
    requestInstallDriver,
    requestInstallDriverFromLocalFile,
    requestInstallDriversFromDirectory,
    cancelBatchDirectoryImport,
    batchDirectoryImportProgress,
    driverPackageExporting,
    driverPackageExportJobId,
    driverPackageInspecting,
    driverPackageImporting,
    driverPackageImportProgress,
    driverPackagePending,
    driverPackageForceOverwrite,
    setDriverPackageForceOverwrite,
    installedDriverCount,
    driverPackageExportPickerOpen,
    driverPackageExportDrivers,
    closeDriverPackageExportPicker,
    confirmDriverPackageExport,
    requestExportDriverPackage,
    requestImportDriverPackage,
    confirmImportDriverPackage,
    cancelDriverPackageImport,
    closeDriverPackageImportModal,
    driverBatchOperationBusy,
    isDriverRowActionDisabled,
    packageTransferDisabled,
    packageTransferDisabledReason,
  };
};

export type DriverManagerInstallApi = ReturnType<typeof useDriverManagerInstall>;
