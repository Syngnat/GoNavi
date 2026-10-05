import { useCallback } from 'react';
import type { DriverStatusRow, DriverBatchActionKind } from './driverManagerModel';
import { isDriverDownloadActive } from './driverDownloadCancellation';
import { message } from 'antd';
import { createDriverBatchProgress } from './driverManagerMessages';
import { t } from '../../i18n';
import {
  isSlimBuildInstallUnavailable,
  formatDriverBatchSkipSummary,
} from './driverLocalInstallPolicy';
import Modal from '../common/ResizableDraggableModal';
import { isDriverReinstallTarget } from './driverOptionalUpdate';
import type { DriverManagerStateApi } from './useDriverManagerState';
import type { DriverManagerProgressApi } from './useDriverManagerProgress';
import type { DriverManagerInstallApi } from './useDriverManagerInstall';
import type { DriverManagerStatusLoadingApi } from './useDriverManagerStatusLoading';
import type { DriverManagerRowsApi } from './useDriverManagerRows';
import type { DriverManagerRemovalApi } from './useDriverManagerRemoval';

export interface UseDriverManagerBatchInput {
  progressMapRef: DriverManagerStateApi['progressMapRef'];
  setBatchAction: DriverManagerStateApi['setBatchAction'];
  setBatchProgress: DriverManagerStateApi['setBatchProgress'];
  batchCancellation: DriverManagerProgressApi['batchCancellation'];
  appendOperationLog: DriverManagerProgressApi['appendOperationLog'];
  installDriver: DriverManagerInstallApi['installDriver'];
  refreshStatus: DriverManagerStatusLoadingApi['refreshStatus'];
  cancelAllDriverDownloads: DriverManagerProgressApi['cancelAllDriverDownloads'];
  rows: DriverManagerStateApi['rows'];
  runAfterDriverInterruptionConfirmation: DriverManagerInstallApi['runAfterDriverInterruptionConfirmation'];
  reinstallableRows: DriverManagerRowsApi['reinstallableRows'];
  installableRows: DriverManagerRowsApi['installableRows'];
  removableRows: DriverManagerRowsApi['removableRows'];
  removeDriver: DriverManagerRemovalApi['removeDriver'];
  progressMap: DriverManagerStateApi['progressMap'];
  optionalUpdateDismissedRevisions: DriverManagerStateApi['optionalUpdateDismissedRevisions'];
}

export const useDriverManagerBatch = ({
  progressMapRef,
  setBatchAction,
  setBatchProgress,
  batchCancellation,
  appendOperationLog,
  installDriver,
  refreshStatus,
  cancelAllDriverDownloads,
  rows,
  runAfterDriverInterruptionConfirmation,
  reinstallableRows,
  installableRows,
  removableRows,
  removeDriver,
  progressMap,
  optionalUpdateDismissedRevisions,
}: UseDriverManagerBatchInput) => {
  const runBatchInstall = useCallback(async (
    targetRows: DriverStatusRow[],
    actionKind: DriverBatchActionKind,
    emptyMessage: string,
    successLabel: string,
  ) => {
    // 排掉正在单装/单删的驱动：批量已放开全局门控，不排除会对同类型重复触发。
    // 在启动前一次性过滤而非循环内 continue —— 后者会让进度总数与实际处理数
    // 不一致，把「正在装」误报成「失败」或「未处理」。
    const rowsToProcess = targetRows.filter((row) => !isDriverDownloadActive(progressMapRef.current[row.type]));
    if (rowsToProcess.length === 0) {
      message.info(emptyMessage);
      return;
    }

    setBatchAction(actionKind);
    setBatchProgress(createDriverBatchProgress(rowsToProcess.length, t('driver.modal.batch.prepare', { action: successLabel })));
    batchCancellation.reset();
    let successCount = 0;
    let failCount = 0;
    let slimSkipCount = 0;
    let unfinishedCount = 0;
    try {
      for (const row of rowsToProcess) {
        if (batchCancellation.isRequested()) {
          unfinishedCount += 1;
          continue;
        }
        if (isSlimBuildInstallUnavailable(row)) {
          slimSkipCount += 1;
          appendOperationLog(row.type, t('driver.modal.operationLog.autoInstall.slimSkipped'));
          setBatchProgress((prev) => {
            if (!prev) {
              return prev;
            }
            const completed = Math.min(prev.total, prev.completed + 1);
            return {
              ...prev,
              completed,
              skipped: prev.skipped + 1,
              currentDriverType: '',
              currentDriverName: '',
              currentMessage: t('driver.modal.batch.driverSkipped', { name: row.name }),
            };
          });
          continue;
        }
        setBatchProgress((prev) => {
          if (!prev) {
            return prev;
          }
          return {
            ...prev,
            currentDriverType: row.type,
            currentDriverName: row.name,
            currentMessage: t('driver.modal.batch.driverRunning', { action: successLabel, name: row.name }),
          };
        });
        const ok = await installDriver(row, { silentToast: true, skipRefresh: true, awaitCompletion: true });
        const canceled = !ok && batchCancellation.isRequested();
        if (ok) {
          successCount += 1;
          await refreshStatus(false, { showLoading: false, fresh: true });
        } else if (canceled) {
          unfinishedCount += 1;
        } else {
          failCount += 1;
        }
        setBatchProgress((prev) => {
          if (!prev) {
            return prev;
          }
          const completed = Math.min(prev.total, prev.completed + 1);
          return {
            ...prev,
            completed,
            success: prev.success + (ok ? 1 : 0),
            failed: prev.failed + (ok || canceled ? 0 : 1),
            currentDriverType: '',
            currentDriverName: '',
            currentMessage: ok
              ? t('driver.modal.batch.driverCompleted', { name: row.name })
              : canceled
                ? t('driver_manager.batch.driver.canceled', { name: row.name })
                : t('driver.modal.batch.driverFailed', { name: row.name }),
          };
        });
      }
      // 批量收尾：整批过程共享一个在途请求，不复用才能反映最终状态。
      await refreshStatus(false, { fresh: true });
    } finally {
      setBatchAction('');
      setBatchProgress(null);
    }

    const skipTip = formatDriverBatchSkipSummary(0, slimSkipCount);
    if (batchCancellation.isRequested()) {
      batchCancellation.reset();
      message.warning(t('driver_manager.batch.result.canceled', { action: successLabel, success: successCount, failed: failCount, remaining: unfinishedCount, skip: skipTip }));
      return;
    }
    if (failCount === 0) {
      message.success(t('driver.modal.batch.actionResult.success', { action: successLabel, success: successCount, skip: skipTip }));
      return;
    }
    if (successCount > 0) {
      message.warning(t('driver.modal.batch.actionResult.partial', { action: successLabel, success: successCount, failed: failCount, skip: skipTip }));
      return;
    }
    message.error(t('driver.modal.batch.actionResult.failed', { action: successLabel, failed: failCount, skip: skipTip }));
  }, [appendOperationLog, batchCancellation, installDriver, refreshStatus]);

  const cancelBatchDownloads = useCallback(() => {
    setBatchProgress((prev) => (prev ? { ...prev, currentMessage: t('driver_manager.batch.cancel_requested') } : prev));
    void cancelAllDriverDownloads((driverType) => rows.find((row) => row.type === driverType)?.name || driverType);
  }, [cancelAllDriverDownloads, rows]);

  const reinstallNeededDrivers = useCallback(() => {
    runAfterDriverInterruptionConfirmation(reinstallableRows, () => runBatchInstall(
      reinstallableRows,
      'reinstall-updates',
      t('driver.modal.info.noReinstallableDrivers'),
      t('driver.modal.batch.action.reinstallUpdates'),
    ));
  }, [reinstallableRows, runAfterDriverInterruptionConfirmation, runBatchInstall]);

  const installAllDrivers = useCallback(async () => {
    await runBatchInstall(
      installableRows,
      'install-all',
      t('driver.modal.info.noInstallableDrivers'),
      t('driver.modal.batch.action.installAll'),
    );
  }, [installableRows, runBatchInstall]);

  const removeAllDrivers = useCallback(() => {
    if (removableRows.length === 0) {
      message.info(t('driver.modal.info.noRemovableDrivers'));
      return;
    }

    Modal.confirm({
      title: t('driver.modal.confirm.removeAll.title'),
      content: t('driver.modal.confirm.removeAll.content', { count: removableRows.length }),
      okText: t('driver.modal.confirm.removeAll.ok'),
      okButtonProps: { danger: true },
      cancelText: t('common.action.cancel'),
      onOk: async () => {
        // 同批量安装：先排掉在途驱动，既不重复触发，也不把「正在装」误报成失败。
        const rowsToRemove = removableRows.filter((row) => !isDriverDownloadActive(progressMapRef.current[row.type]));
        setBatchAction('remove-all');
        setBatchProgress(createDriverBatchProgress(rowsToRemove.length, t('driver.modal.batch.prepareRemoveAll')));
        let successCount = 0;
        let failCount = 0;
        try {
          for (const row of rowsToRemove) {
            setBatchProgress((prev) => {
              if (!prev) {
                return prev;
              }
              return {
                ...prev,
                currentDriverType: row.type,
                currentDriverName: row.name,
                currentMessage: t('driver.modal.batch.driverRemoving', { name: row.name }),
              };
            });
            const ok = await removeDriver(row, { silentToast: true, skipRefresh: true });
            if (ok) {
              successCount += 1;
              await refreshStatus(false, { showLoading: false, fresh: true });
            } else {
              failCount += 1;
            }
            setBatchProgress((prev) => {
              if (!prev) {
                return prev;
              }
              const completed = Math.min(prev.total, prev.completed + 1);
              return {
                ...prev,
                completed,
                success: prev.success + (ok ? 1 : 0),
                failed: prev.failed + (ok ? 0 : 1),
                currentDriverType: '',
                currentDriverName: '',
                currentMessage: ok
                  ? t('driver.modal.batch.driverCompleted', { name: row.name })
                  : t('driver.modal.batch.driverRemoveFailed', { name: row.name }),
              };
            });
          }
          await refreshStatus(false, { fresh: true });
        } finally {
          setBatchAction('');
          setBatchProgress(null);
        }

        if (failCount === 0) {
          message.success(t('driver.modal.batch.removeAll.success', { success: successCount }));
          return;
        }
        if (successCount > 0) {
          message.warning(t('driver.modal.batch.removeAll.partial', { success: successCount, failed: failCount }));
          return;
        }
        message.error(t('driver.modal.batch.removeAll.failed', { failed: failCount }));
      },
    });
  }, [refreshStatus, removableRows, removeDriver]);

  const resolveDriverListTone = (row: DriverStatusRow) => {
    const progressState = progressMap[row.type];
    if (progressState?.status === 'error') return 'error';
    if (isDriverDownloadActive(progressState)) return 'checking';
    if (isDriverReinstallTarget(row, optionalUpdateDismissedRevisions)) return 'warning';
    // 真实可用性优先于进度态：progressMap.status === 'done' 只是「本次会话装过」的
    // 动作记录，驱动可能已被卸载、或安装产物不完整。让它压过 connectable 会点出
    // 假绿点 —— 目录已删除的驱动仍显示为可用，直到重开页面才露出真身。
    if (row.builtIn || row.connectable) return 'ok';
    if (row.packageInstalled) return 'warning';
    return 'idle';
  };
  return {
    cancelBatchDownloads,
    reinstallNeededDrivers,
    installAllDrivers,
    removeAllDrivers,
    resolveDriverListTone,
  };
};

export type DriverManagerBatchApi = ReturnType<typeof useDriverManagerBatch>;
