import { useCallback } from 'react';
import { message } from 'antd';
import type {
  UpdateInfo,
  UpdateDownloadProgressState,
  UpdateDownloadResultData,
} from '../appUpdateTypes';
import {
  isUpdateDownloadTaskActive,
  buildUpdateKey,
  normalizeUpdateDownloadTaskSnapshot,
  normalizeUpdateInfo,
  normalizeUpdateInstallMode,
  resolveUpdateInstallAction,
} from '../appUpdateNormalizers';
import type { AppUpdateStateApi } from './useAppUpdateState';
import type { UseAppUpdateManagerOptions } from '../appUpdateTypes';

export interface UseAppUpdateDownloadInput {
  t: UseAppUpdateManagerOptions['t'];
  updateDownloadInFlightRef: AppUpdateStateApi['updateDownloadInFlightRef'];
  updateDownloadTaskStatusRef: AppUpdateStateApi['updateDownloadTaskStatusRef'];
  updateDownloadedVersionRef: AppUpdateStateApi['updateDownloadedVersionRef'];
  updateDownloadMetaRef: AppUpdateStateApi['updateDownloadMetaRef'];
  advanceUpdateDownloadTaskSession: AppUpdateStateApi['advanceUpdateDownloadTaskSession'];
  updateDownloadStartRequestRef: AppUpdateStateApi['updateDownloadStartRequestRef'];
  updateUserDismissedRef: AppUpdateStateApi['updateUserDismissedRef'];
  updateDownloadProgressRef: AppUpdateStateApi['updateDownloadProgressRef'];
  setUpdateDownloadProgress: AppUpdateStateApi['setUpdateDownloadProgress'];
  isCurrentUpdateDownloadTaskSession: AppUpdateStateApi['isCurrentUpdateDownloadTaskSession'];
  applyUpdateDownloadTaskSnapshot: AppUpdateStateApi['applyUpdateDownloadTaskSnapshot'];
  refreshUpdateDownloadTask: AppUpdateStateApi['refreshUpdateDownloadTask'];
  setInstallMode: AppUpdateStateApi['setInstallMode'];
  setLastUpdateInfo: AppUpdateStateApi['setLastUpdateInfo'];
  setAboutUpdateStatus: AppUpdateStateApi['setAboutUpdateStatus'];
  formatAboutUpdateStatus: AppUpdateStateApi['formatAboutUpdateStatus'];
  lastUpdateInfo: AppUpdateStateApi['lastUpdateInfo'];
  lastUpdateKey: AppUpdateStateApi['lastUpdateKey'];
  updateDownloadProgress: AppUpdateStateApi['updateDownloadProgress'];
  updateInstallTriggeredVersionRef: AppUpdateStateApi['updateInstallTriggeredVersionRef'];
}

export const useAppUpdateDownload = ({
  t, updateDownloadInFlightRef, updateDownloadTaskStatusRef, updateDownloadedVersionRef,
  updateDownloadMetaRef, advanceUpdateDownloadTaskSession, updateDownloadStartRequestRef,
  updateUserDismissedRef, updateDownloadProgressRef, setUpdateDownloadProgress,
  isCurrentUpdateDownloadTaskSession, applyUpdateDownloadTaskSnapshot, refreshUpdateDownloadTask,
  setInstallMode, setLastUpdateInfo, setAboutUpdateStatus, formatAboutUpdateStatus, lastUpdateInfo,
  lastUpdateKey, updateDownloadProgress, updateInstallTriggeredVersionRef,
}: UseAppUpdateDownloadInput) => {
  const downloadUpdate = useCallback(async (info: UpdateInfo, silent: boolean) => {
    if (updateDownloadInFlightRef.current || isUpdateDownloadTaskActive(updateDownloadTaskStatusRef.current)) return;
    const targetKey = buildUpdateKey(info);
    if (updateDownloadedVersionRef.current === targetKey) {
      if (!silent) {
        const cachedDownloadPath = updateDownloadMetaRef.current?.downloadPath;
        void message.info(cachedDownloadPath
          ? t('app.about.message.update_package_ready_with_path', { version: info.latestVersion, path: cachedDownloadPath })
          : t('app.about.message.update_package_ready', { version: info.latestVersion }));
        showUpdateDownloadProgress();
      }
      return;
    }
    const session = advanceUpdateDownloadTaskSession();
    const startRequest = ++updateDownloadStartRequestRef.current;
    updateDownloadInFlightRef.current = true;
    updateUserDismissedRef.current = false;
    updateDownloadMetaRef.current = null;
    const startingProgress: UpdateDownloadProgressState = {
      open: true,
      version: info.latestVersion,
      key: targetKey,
      status: 'start',
      percent: 0,
      downloaded: 0,
      total: info.assetSize || 0,
      message: t('app.about.download_progress.downloading'),
    };
    updateDownloadProgressRef.current = startingProgress;
    setUpdateDownloadProgress(startingProgress);

    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.StartUpdateDownload === 'function') {
      let startResult: any = null;
      try {
        startResult = await backendApp.StartUpdateDownload();
      } catch (error) {
        console.warn('Wails API: StartUpdateDownload unavailable', error);
      } finally {
        if (startRequest === updateDownloadStartRequestRef.current) {
          updateDownloadInFlightRef.current = false;
        }
      }
      if (!isCurrentUpdateDownloadTaskSession(session)
        || startRequest !== updateDownloadStartRequestRef.current) {
        return;
      }
      if (!startResult?.success) {
        const errorText = startResult?.message || t('common.unknown');
        updateDownloadTaskStatusRef.current = 'error';
        const nextProgress: UpdateDownloadProgressState = {
          ...updateDownloadProgressRef.current,
          status: 'error',
          message: errorText,
        };
        updateDownloadProgressRef.current = nextProgress;
        setUpdateDownloadProgress(nextProgress);
        if (!silent) {
          void message.error({ content: t('app.about.message.download_failed_with_error', { error: errorText }), duration: 4 });
        }
        return;
      }
      const task = normalizeUpdateDownloadTaskSnapshot(startResult?.data?.task ?? startResult?.data);
      if (task) {
        applyUpdateDownloadTaskSnapshot(task, { session, source: 'start' });
        return;
      }
      if (await refreshUpdateDownloadTask({ session })) {
        return;
      }
      const errorText = startResult?.message || t('common.unknown');
      updateDownloadTaskStatusRef.current = 'error';
      const nextProgress: UpdateDownloadProgressState = {
        ...updateDownloadProgressRef.current,
        status: 'error',
        message: errorText,
      };
      updateDownloadProgressRef.current = nextProgress;
      setUpdateDownloadProgress(nextProgress);
      if (!silent) {
        void message.error({ content: t('app.about.message.download_failed_with_error', { error: errorText }), duration: 4 });
      }
      return;
    }

    // Keep source-tree/browser-preview compatibility while an older backend is
    // connected. Production Wails builds use StartUpdateDownload above.
    let res: any = null;
    try {
      res = await backendApp?.DownloadUpdate?.();
    } catch (e) {
      console.warn('Wails API: DownloadUpdate unavailable', e);
    }
    if (startRequest === updateDownloadStartRequestRef.current) {
      updateDownloadInFlightRef.current = false;
    }
    if (!isCurrentUpdateDownloadTaskSession(session)
      || startRequest !== updateDownloadStartRequestRef.current) {
      return;
    }
    if (res?.success) {
      const resultData = (res?.data || {}) as UpdateDownloadResultData;
      const downloadedInfo = normalizeUpdateInfo({
        ...info,
        ...(resultData.info || {}),
        downloaded: true,
        downloadPath: resultData.downloadPath || resultData.info?.downloadPath || info.downloadPath,
        installMode: resultData.installMode || resultData.info?.installMode || info.installMode,
        packageType: resultData.packageType || resultData.info?.packageType || info.packageType,
        autoRelaunch: resultData.autoRelaunch ?? resultData.info?.autoRelaunch ?? info.autoRelaunch,
      });
      const downloadedKey = buildUpdateKey(downloadedInfo) || targetKey;
      updateDownloadMetaRef.current = resultData;
      updateDownloadedVersionRef.current = downloadedKey;
      updateDownloadTaskStatusRef.current = 'done';
      setInstallMode(normalizeUpdateInstallMode(downloadedInfo.installMode));
      const previousProgress = updateDownloadProgressRef.current;
      const total = previousProgress.total > 0 ? previousProgress.total : (info.assetSize || 0);
      const installAction = resolveUpdateInstallAction(downloadedInfo);
      const completedProgress: UpdateDownloadProgressState = {
        ...previousProgress,
        version: downloadedInfo.latestVersion,
        key: downloadedKey,
        status: 'done',
        percent: 100,
        downloaded: total,
        total,
        message: installAction === 'restart'
          ? t('app.about.download_progress.ready_to_restart')
          : t('app.about.download_progress.ready_to_install'),
        open: previousProgress.open || !updateUserDismissedRef.current,
      };
      updateDownloadProgressRef.current = completedProgress;
      setUpdateDownloadProgress(completedProgress);
      setLastUpdateInfo(downloadedInfo);
      void message.success({
        content: installAction === 'restart'
          ? (downloadedInfo.downloadPath
            ? t('app.about.message.download_ready_restart_with_path', { path: downloadedInfo.downloadPath })
            : t('app.about.message.download_ready_restart'))
          : (downloadedInfo.downloadPath
            ? t('app.about.message.download_ready_install_with_path', { path: downloadedInfo.downloadPath })
            : t('app.about.message.download_ready_install')),
        duration: 4,
      });
      setAboutUpdateStatus(formatAboutUpdateStatus(downloadedInfo));
    } else {
      updateDownloadTaskStatusRef.current = 'error';
      const failedProgress: UpdateDownloadProgressState = {
        ...updateDownloadProgressRef.current,
        status: 'error',
        message: res?.message || t('common.unknown'),
      };
      updateDownloadProgressRef.current = failedProgress;
      setUpdateDownloadProgress(failedProgress);
      void message.error({ content: t('app.about.message.download_failed_with_error', { error: res?.message || t('common.unknown') }), duration: 4 });
    }
  }, [advanceUpdateDownloadTaskSession, applyUpdateDownloadTaskSnapshot, formatAboutUpdateStatus, isCurrentUpdateDownloadTaskSession, refreshUpdateDownloadTask, t]);

  const showUpdateDownloadProgress = useCallback(() => {
    const previousProgress = updateDownloadProgressRef.current;
    if (previousProgress.status === 'idle') {
      return;
    }
    const nextProgress = { ...previousProgress, open: true };
    updateDownloadProgressRef.current = nextProgress;
    setUpdateDownloadProgress(nextProgress);
  }, []);

  const hideUpdateDownloadProgress = useCallback(() => {
    const nextProgress = { ...updateDownloadProgressRef.current, open: false };
    updateDownloadProgressRef.current = nextProgress;
    setUpdateDownloadProgress(nextProgress);
  }, []);

  const isLatestUpdateDownloaded = Boolean(lastUpdateInfo?.hasUpdate) && (
    Boolean(lastUpdateInfo?.downloaded)
    || (Boolean(lastUpdateKey) && updateDownloadedVersionRef.current === lastUpdateKey)
  );
  const isBackgroundProgressForLatestUpdate = Boolean(lastUpdateInfo?.hasUpdate)
    && Boolean(lastUpdateKey)
    && updateDownloadProgress.key === lastUpdateKey
    && (updateDownloadProgress.status === 'start'
      || updateDownloadProgress.status === 'downloading'
      || updateDownloadProgress.status === 'done'
      || updateDownloadProgress.status === 'error');
  const canShowProgressEntry = (isLatestUpdateDownloaded || isBackgroundProgressForLatestUpdate)
    && updateInstallTriggeredVersionRef.current !== (lastUpdateKey || null);

  const handleInstallFromProgress = useCallback(async (
    closeAllWindowsInstancesConfirmed = false,
    onCloseInstancesConfirmationRequired?: (instanceCount: number) => void,
  ): Promise<boolean> => {
    const canInstall = updateDownloadProgress.status === 'done'
      || (Boolean(lastUpdateInfo?.hasUpdate) && (Boolean(lastUpdateInfo?.downloaded) || updateDownloadedVersionRef.current === lastUpdateKey));
    if (!canInstall) {
      return false;
    }
    const installAction = resolveUpdateInstallAction(lastUpdateInfo);
    setUpdateDownloadProgress((prev) => ({
      ...prev,
      open: true,
      status: 'downloading',
      percent: 100,
      message: installAction === 'restart'
        ? t('app.about.download_progress.applying_restart')
        : (installAction === 'install-and-restart'
          ? t('app.about.download_progress.installing_and_restarting')
          : t('app.about.download_progress.launching_installer')),
    }));
    let res: any = null;
    try {
      res = await (window as any).go?.app?.App?.InstallUpdateAndRestart?.(closeAllWindowsInstancesConfirmed);
    } catch (error: any) {
      res = { success: false, message: error?.message || t('common.unknown') };
    }
    if (!res?.success) {
      if (res?.data?.requiresCloseConfirmation === true) {
        const parsedInstanceCount = Number(res?.data?.instanceCount);
        const instanceCount = Number.isFinite(parsedInstanceCount) && parsedInstanceCount > 0
          ? Math.floor(parsedInstanceCount)
          : 1;
        setUpdateDownloadProgress((prev) => ({
          ...prev,
          open: false,
          status: 'done',
          percent: 100,
          message: '',
        }));
        onCloseInstancesConfirmationRequired?.(instanceCount);
        return false;
      }
      if (res?.data?.cancelled === true) {
        setUpdateDownloadProgress((prev) => ({
          ...prev,
          open: true,
          status: 'done',
          percent: 100,
          message: '',
        }));
        return false;
      }
      setUpdateDownloadProgress((prev) => ({
        ...prev,
        open: true,
        status: 'error',
        message: res?.message || t('common.unknown'),
      }));
      void message.error(t('app.about.message.install_failed_with_error', { error: res?.message || t('common.unknown') }));
      return false;
    }
    updateInstallTriggeredVersionRef.current = lastUpdateKey || null;
    const completedAction = resolveUpdateInstallAction({
      packageType: res?.data?.packageType || lastUpdateInfo?.packageType,
      autoRelaunch: res?.data?.autoRelaunch ?? lastUpdateInfo?.autoRelaunch,
    });
    // 后端会退出当前进程；保留最终状态，避免退出前界面看起来像失败。
    setUpdateDownloadProgress((prev) => ({
      ...prev,
      open: true,
      status: 'done',
      percent: 100,
      message: completedAction === 'restart'
        ? t('app.about.download_progress.restarting')
        : (completedAction === 'install-and-restart'
          ? t('app.about.download_progress.restarting_after_install')
          : t('app.about.download_progress.installer_started')),
    }));
    return true;
  }, [lastUpdateInfo, lastUpdateKey, t, updateDownloadProgress.status]);

  const openDownloadedUpdateDirectory = useCallback(async () => {
    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.OpenDownloadedUpdateDirectory !== 'function') {
      void message.error(t('app.about.message.open_install_directory_failed_with_error', { error: t('common.unknown') }));
      return;
    }
    const res = await backendApp.OpenDownloadedUpdateDirectory();
    if (!res?.success) {
      void message.error(t('app.about.message.open_install_directory_failed_with_error', { error: res?.message || t('common.unknown') }));
      return;
    }
    void message.success(res?.message || t('app.about.message.install_directory_opened_manual_replace'));
  }, [t]);
  return {
    downloadUpdate, showUpdateDownloadProgress, hideUpdateDownloadProgress,
    isLatestUpdateDownloaded, isBackgroundProgressForLatestUpdate, canShowProgressEntry,
    handleInstallFromProgress, openDownloadedUpdateDirectory,
  };
};

export type AppUpdateDownloadApi = ReturnType<typeof useAppUpdateDownload>;
