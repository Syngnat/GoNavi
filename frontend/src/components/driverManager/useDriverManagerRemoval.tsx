import { useCallback } from 'react';
import { t } from '../../i18n';
import { OpenDriverDownloadDirectory, RemoveDriverPackage } from '../../../wailsjs/go/app/App';
import { message, Tag } from 'antd';
import {
  type DriverStatusRow,
  buildVersionSizeLoadingKey,
  buildVersionOptionKey,
} from './driverManagerModel';
import Modal from '../common/ResizableDraggableModal';
import { isDriverDownloadActive } from './driverDownloadCancellation';
import { isOptionalUpdateVisible } from './driverOptionalUpdate';
import { resolveDriverProgressDisplay } from '../../utils/driverProgress';
import type { DriverManagerStateApi } from './useDriverManagerState';
import type { DriverManagerProgressApi } from './useDriverManagerProgress';
import type { DriverManagerStatusLoadingApi } from './useDriverManagerStatusLoading';

export interface UseDriverManagerRemovalInput {
  downloadDir: DriverManagerStateApi['downloadDir'];
  resolveDriverErrorMessage: DriverManagerStateApi['resolveDriverErrorMessage'];
  setActionState: DriverManagerStateApi['setActionState'];
  appendOperationLog: DriverManagerProgressApi['appendOperationLog'];
  clearDriverProgress: DriverManagerStateApi['clearDriverProgress'];
  refreshStatus: DriverManagerStatusLoadingApi['refreshStatus'];
  versionMap: DriverManagerStateApi['versionMap'];
  selectedVersionMap: DriverManagerStateApi['selectedVersionMap'];
  versionSizeLoadingMap: DriverManagerStateApi['versionSizeLoadingMap'];
  progressMap: DriverManagerStateApi['progressMap'];
  optionalUpdateDismissedRevisions: DriverManagerStateApi['optionalUpdateDismissedRevisions'];
}

export const useDriverManagerRemoval = ({
  downloadDir,
  resolveDriverErrorMessage,
  setActionState,
  appendOperationLog,
  clearDriverProgress,
  refreshStatus,
  versionMap,
  selectedVersionMap,
  versionSizeLoadingMap,
  progressMap,
  optionalUpdateDismissedRevisions,
}: UseDriverManagerRemovalInput) => {
  const openDriverDirectory = useCallback(async () => {
    const fallbackMessage = t('driver.modal.error.openDirectory');
    try {
      const res = await OpenDriverDownloadDirectory(downloadDir);
      if (!res?.success) {
        message.error(resolveDriverErrorMessage(
          res?.message,
          fallbackMessage,
          'driver.modal.error.openDirectoryWithDetail',
          undefined,
          [
            'driver_manager.backend.error.create_directory_failed',
            'driver_manager.backend.error.open_directory_failed',
          ],
        ));
        return;
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error || t('driver.modal.error.unknown'));
      message.error(resolveDriverErrorMessage(
        errMsg,
        fallbackMessage,
        'driver.modal.error.openDirectoryWithDetail',
        undefined,
        [
          'driver_manager.backend.error.create_directory_failed',
          'driver_manager.backend.error.open_directory_failed',
        ],
      ));
    }
  }, [downloadDir, resolveDriverErrorMessage]);

  const removeDriver = useCallback(async (
    row: DriverStatusRow,
    options?: { silentToast?: boolean; skipRefresh?: boolean },
  ) => {
    setActionState({ driverType: row.type, kind: 'remove' });
    appendOperationLog(row.type, t('driver.modal.operationLog.remove.start'));
    try {
      const result = await RemoveDriverPackage(row.type, downloadDir);
      if (!result?.success) {
        const errText = resolveDriverErrorMessage(
          result?.message,
          t('driver.modal.error.removeDriver', { name: row.name }),
          undefined,
          { name: row.name },
          [
            'driver_manager.backend.error.remove_package_failed',
          ],
        );
        appendOperationLog(row.type, `[ERROR] ${errText}`);
        if (!options?.silentToast) {
          message.error(errText);
        }
        return false;
      }
      appendOperationLog(row.type, t('driver.modal.operationLog.remove.done'));
      if (!options?.silentToast) {
        message.success(t('driver.modal.success.removeDriver', { name: row.name }));
      }
      clearDriverProgress(row.type);
      if (!options?.skipRefresh) {
        await refreshStatus(false, { fresh: true });
      }
      return true;
    } finally {
      setActionState({ driverType: '', kind: '' });
    }
  }, [appendOperationLog, clearDriverProgress, downloadDir, refreshStatus, resolveDriverErrorMessage]);

  const confirmRemoveDriver = useCallback((row: DriverStatusRow) => {
    Modal.confirm({
      title: t('driver.modal.confirm.remove.title'),
      content: t('driver.modal.confirm.remove.content', { name: row.name }),
      okText: t('driver.modal.confirm.remove.ok'),
      okButtonProps: { danger: true },
      cancelText: t('common.action.cancel'),
      onOk: () => removeDriver(row),
    });
  }, [removeDriver, t]);

  const resolvePackageSizeText = (row: DriverStatusRow): string => {
    if (row.builtIn) {
      return row.packageSizeText || '-';
    }
    const options = versionMap[row.type] || [];
    const selectedKey = selectedVersionMap[row.type];
    const loadingKey = buildVersionSizeLoadingKey(row.type, selectedKey || '');
    const selectedOption =
      options.find((item) => buildVersionOptionKey(item) === selectedKey) ||
      options.find((item) => item.recommended) ||
      options[0];
    const anyKnownSize = options.find((item) => String(item.packageSizeText || '').trim())?.packageSizeText;
    if (selectedKey && versionSizeLoadingMap[loadingKey]) {
      return t('driver.modal.card.versionSizeCalculating');
    }
    return selectedOption?.packageSizeText || anyKnownSize || row.packageSizeText || '-';
  };

  const resolveDriverStatusTag = (row: DriverStatusRow) => {
    if (row.builtIn) {
      return <Tag color="success">{t('driver.modal.card.builtInUsable')}</Tag>;
    }
    const progress = progressMap[row.type];
    if (isDriverDownloadActive(progress)) {
      return <Tag color="processing">{t('driver.modal.card.installing', { percent: resolveDriverProgress(row).percent })}</Tag>;
    }
    if (row.needsUpdate || isOptionalUpdateVisible(row, optionalUpdateDismissedRevisions)) {
      return <Tag color="warning">{t('driver.modal.stats.needsUpdate')}</Tag>;
    }
    if (row.connectable) {
      return <Tag color="success">{t('driver.modal.card.enabled')}</Tag>;
    }
    if (row.packageInstalled) {
      return <Tag color="warning">{t('driver.modal.card.installed')}</Tag>;
    }
    return <Tag>{t('driver.modal.card.notEnabled')}</Tag>;
  };

  const resolveDriverProgress = (row: DriverStatusRow) => resolveDriverProgressDisplay(progressMap[row.type], !!(row.connectable || row.packageInstalled));
  return {
    openDriverDirectory,
    removeDriver,
    confirmRemoveDriver,
    resolvePackageSizeText,
    resolveDriverStatusTag,
    resolveDriverProgress,
  };
};

export type DriverManagerRemovalApi = ReturnType<typeof useDriverManagerRemoval>;
