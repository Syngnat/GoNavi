import { useCallback, useEffect } from 'react';
import { message } from 'antd';
import {
  normalizeUpdateInfo,
  normalizeUpdateChannel,
  normalizeUpdateInstallMode,
  buildUpdateKey,
  normalizeAboutInfo,
} from '../appUpdateNormalizers';
import {
  createEmptyDownloadProgress,
  DEFAULT_ABOUT_INFO,
  type UpdateChannel,
} from '../appUpdateTypes';
import type { AppUpdateStateApi } from './useAppUpdateState';
import type { UseAppUpdateManagerOptions } from '../appUpdateTypes';

export interface UseAppUpdateCheckInput {
  t: UseAppUpdateManagerOptions['t'];
  onManualCheckHasUpdateRef: UseAppUpdateManagerOptions['onManualCheckHasUpdateRef'];
  updateCheckInFlightRef: AppUpdateStateApi['updateCheckInFlightRef'];
  updateCheckCompletionRef: AppUpdateStateApi['updateCheckCompletionRef'];
  captureUpdateDownloadTaskSession: AppUpdateStateApi['captureUpdateDownloadTaskSession'];
  updateChannelChangeRequestRef: AppUpdateStateApi['updateChannelChangeRequestRef'];
  setIsCheckingForUpdates: AppUpdateStateApi['setIsCheckingForUpdates'];
  setAboutUpdateStatus: AppUpdateStateApi['setAboutUpdateStatus'];
  isCurrentUpdateDownloadTaskSession: AppUpdateStateApi['isCurrentUpdateDownloadTaskSession'];
  hasExplicitUpdateChannelIntentRef: AppUpdateStateApi['hasExplicitUpdateChannelIntentRef'];
  intendedUpdateChannelRef: AppUpdateStateApi['intendedUpdateChannelRef'];
  setUpdateChannelState: AppUpdateStateApi['setUpdateChannelState'];
  setInstallMode: AppUpdateStateApi['setInstallMode'];
  isUpdateCenterOpen: AppUpdateStateApi['isUpdateCenterOpen'];
  updateDownloadedVersionRef: AppUpdateStateApi['updateDownloadedVersionRef'];
  updateDownloadMetaRef: AppUpdateStateApi['updateDownloadMetaRef'];
  setUpdateDownloadProgress: AppUpdateStateApi['setUpdateDownloadProgress'];
  setLastUpdateInfo: AppUpdateStateApi['setLastUpdateInfo'];
  formatAboutUpdateStatus: AppUpdateStateApi['formatAboutUpdateStatus'];
  updateMutedVersionRef: AppUpdateStateApi['updateMutedVersionRef'];
  updateNotifiedVersionRef: AppUpdateStateApi['updateNotifiedVersionRef'];
  openUpdateCenter: AppUpdateStateApi['openUpdateCenter'];
  setAboutLoading: AppUpdateStateApi['setAboutLoading'];
  setAboutInfo: AppUpdateStateApi['setAboutInfo'];
  lastUpdateInfo: AppUpdateStateApi['lastUpdateInfo'];
  setIsUpdateChannelLoading: AppUpdateStateApi['setIsUpdateChannelLoading'];
  resetLocalUpdateArtifacts: AppUpdateStateApi['resetLocalUpdateArtifacts'];
  setIsUpdateChannelSaving: AppUpdateStateApi['setIsUpdateChannelSaving'];
  installMode: AppUpdateStateApi['installMode'];
  lastUpdateKey: AppUpdateStateApi['lastUpdateKey'];
  closeUpdateCenter: AppUpdateStateApi['closeUpdateCenter'];
  updateUserDismissedRef: AppUpdateStateApi['updateUserDismissedRef'];
  autoCheckForUpdates: AppUpdateStateApi['autoCheckForUpdates'];
  autoCheckForUpdatesIntervalMinutes: AppUpdateStateApi['autoCheckForUpdatesIntervalMinutes'];
}

export const useAppUpdateCheck = ({
  t, onManualCheckHasUpdateRef, updateCheckInFlightRef, updateCheckCompletionRef,
  captureUpdateDownloadTaskSession, updateChannelChangeRequestRef, setIsCheckingForUpdates,
  setAboutUpdateStatus, isCurrentUpdateDownloadTaskSession, hasExplicitUpdateChannelIntentRef,
  intendedUpdateChannelRef, setUpdateChannelState, setInstallMode, isUpdateCenterOpen,
  updateDownloadedVersionRef, updateDownloadMetaRef, setUpdateDownloadProgress, setLastUpdateInfo,
  formatAboutUpdateStatus, updateMutedVersionRef, updateNotifiedVersionRef, openUpdateCenter,
  setAboutLoading, setAboutInfo, lastUpdateInfo, setIsUpdateChannelLoading,
  resetLocalUpdateArtifacts, setIsUpdateChannelSaving, installMode, lastUpdateKey,
  closeUpdateCenter, updateUserDismissedRef, autoCheckForUpdates,
  autoCheckForUpdatesIntervalMinutes,
}: UseAppUpdateCheckInput) => {
  const checkForUpdates = useCallback(async (silent: boolean, openReleaseNotes = false) => {
    if (updateCheckInFlightRef.current) {
      return updateCheckCompletionRef.current || Promise.resolve();
    }
    const session = captureUpdateDownloadTaskSession();
    const channelChangeRequest = updateChannelChangeRequestRef.current;
    let resolveCompletion: (() => void) | null = null;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    updateCheckCompletionRef.current = completion;
    const finishUpdateCheck = () => {
      updateCheckInFlightRef.current = false;
      setIsCheckingForUpdates(false);
      if (updateCheckCompletionRef.current === completion) {
        updateCheckCompletionRef.current = null;
      }
      resolveCompletion?.();
    };
    updateCheckInFlightRef.current = true;
    setIsCheckingForUpdates(true);
    if (!silent) {
      setAboutUpdateStatus(t('app.about.update_status.checking'));
    }
    const updateAPI = (window as any).go.app.App;
    const checkFn = silent && typeof updateAPI.CheckForUpdatesSilently === 'function'
      ? updateAPI.CheckForUpdatesSilently
      : updateAPI.CheckForUpdates;
    let res: any = null;
    try {
      res = await checkFn();
    } catch (error) {
      finishUpdateCheck();
      throw error;
    }
    if (!isCurrentUpdateDownloadTaskSession(session)
      || channelChangeRequest !== updateChannelChangeRequestRef.current) {
      finishUpdateCheck();
      return;
    }
    if (!res?.success) {
      if (!silent) {
        const error = res?.message || t('common.unknown');
        void message.error(t('app.about.message.check_failed_with_error', { error }));
        setAboutUpdateStatus(t('app.about.update_status.check_failed', { error }));
      }
      finishUpdateCheck();
      return;
    }
    const info = normalizeUpdateInfo(res.data || {});
    if (!info) {
      finishUpdateCheck();
      return;
    }
    const infoChannel = normalizeUpdateChannel(info.channel);
    if (!hasExplicitUpdateChannelIntentRef.current) {
      intendedUpdateChannelRef.current = infoChannel;
      hasExplicitUpdateChannelIntentRef.current = true;
    } else if (infoChannel !== intendedUpdateChannelRef.current) {
      // A successful explicit channel change has already retired the old
      // session. Do not let an unexpected/old check reply select another one.
      finishUpdateCheck();
      return;
    }
    setUpdateChannelState(infoChannel);
    setInstallMode(normalizeUpdateInstallMode(info.installMode));
    const aboutOpen = isUpdateCenterOpen();
    if (info.hasUpdate) {
      const infoKey = buildUpdateKey(info);
      if (!info.downloaded && updateDownloadedVersionRef.current === infoKey) {
        updateDownloadedVersionRef.current = null;
        updateDownloadMetaRef.current = null;
      }
      const localDownloaded = updateDownloadedVersionRef.current === infoKey;
      const hasDownloaded = Boolean(info.downloaded) || localDownloaded;
      if (hasDownloaded) {
        const downloadPath = info.downloadPath || updateDownloadMetaRef.current?.downloadPath || '';
        updateDownloadedVersionRef.current = infoKey;
        updateDownloadMetaRef.current = {
          ...(updateDownloadMetaRef.current || {}),
          info,
          downloadPath: downloadPath || undefined,
        };
        setUpdateDownloadProgress((prev) => {
          if (prev.status === 'start' || prev.status === 'downloading') {
            return prev;
          }
          const total = info.assetSize || prev.total || 0;
          return {
            ...prev,
            open: prev.open && prev.key === infoKey,
            version: info.latestVersion,
            key: infoKey,
            status: 'done',
            percent: 100,
            downloaded: total,
            total,
            message: '',
          };
        });
        setLastUpdateInfo({
          ...info,
          downloaded: true,
          downloadPath: downloadPath || undefined,
        });
      } else {
        if (updateDownloadedVersionRef.current !== infoKey) {
          updateDownloadMetaRef.current = null;
        }
        setUpdateDownloadProgress((prev) => {
          if (prev.status === 'start' || prev.status === 'downloading') {
            return prev;
          }
          return {
            ...prev,
            open: false,
            version: info.latestVersion,
            key: infoKey,
            status: 'idle',
            percent: 0,
            downloaded: 0,
            total: info.assetSize || 0,
            message: '',
          };
        });
        setLastUpdateInfo(info);
      }
      const statusText = formatAboutUpdateStatus({ ...info, downloaded: hasDownloaded });
      if (!silent) {
        void message.info(t('app.about.message.new_version_found', { version: info.latestVersion }));
        setAboutUpdateStatus(statusText);
        // 仅当显式请求打开更新日志时（如用户点击「检查更新」按钮），才触发弹窗；
        // 通道切换后的自动复查等场景不传 openReleaseNotes，避免越界打开弹窗（#818）
        if (openReleaseNotes) {
          onManualCheckHasUpdateRef?.current?.();
        }
      }
      if (silent && aboutOpen) {
        setAboutUpdateStatus(statusText);
      }
      if (silent && !aboutOpen && updateMutedVersionRef.current !== infoKey && updateNotifiedVersionRef.current !== infoKey) {
        updateNotifiedVersionRef.current = infoKey;
        // 启动/后台检查发现更新时，打开设置中心「关于」页，不再弹旧版关于对话框
        openUpdateCenter();
      }
    } else if (!silent) {
      setUpdateDownloadProgress((prev) => {
        if (prev.status === 'start' || prev.status === 'downloading') {
          return prev;
        }
        return createEmptyDownloadProgress();
      });
      setLastUpdateInfo(info);
      const text = formatAboutUpdateStatus(info);
      void message.success(text);
      setAboutUpdateStatus(text);
    } else if (silent && aboutOpen) {
      setUpdateDownloadProgress((prev) => {
        if (prev.status === 'start' || prev.status === 'downloading') {
          return prev;
        }
        return createEmptyDownloadProgress();
      });
      setLastUpdateInfo(info);
      const text = formatAboutUpdateStatus(info);
      setAboutUpdateStatus(text);
    } else {
      setLastUpdateInfo(info);
    }
    finishUpdateCheck();
  }, [captureUpdateDownloadTaskSession, formatAboutUpdateStatus, isCurrentUpdateDownloadTaskSession, isUpdateCenterOpen, onManualCheckHasUpdateRef, openUpdateCenter, t]);

  const loadAboutInfo = useCallback(async () => {
    setAboutLoading(true);
    try {
      const backendApp = (window as any).go?.app?.App;
      if (typeof backendApp?.GetAppInfo !== 'function') {
        setAboutInfo(DEFAULT_ABOUT_INFO);
        return;
      }
      const res = await backendApp.GetAppInfo();
      if (res?.success) {
        setAboutInfo(normalizeAboutInfo(res.data));
      } else {
        setAboutInfo(DEFAULT_ABOUT_INFO);
        void message.error(t('app.about.message.load_failed', { error: res?.message || t('common.unknown') }));
      }
    } catch (e: any) {
      setAboutInfo(DEFAULT_ABOUT_INFO);
      const error = e?.message || t('common.unknown');
      void message.error(t('app.about.message.load_failed', { error }));
    } finally {
      setAboutLoading(false);
    }
  }, [t]);

  /** 关于页（设置中心或旧弹窗）打开时刷新状态与应用信息 */
  const prepareAboutSurface = useCallback(() => {
    setAboutUpdateStatus(formatAboutUpdateStatus(lastUpdateInfo));
    void loadAboutInfo();
  }, [formatAboutUpdateStatus, lastUpdateInfo, loadAboutInfo]);

  const loadUpdateChannel = useCallback(async () => {
    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.GetUpdateChannel !== 'function') {
      return;
    }
    const session = captureUpdateDownloadTaskSession();
    const channelChangeRequest = updateChannelChangeRequestRef.current;
    setIsUpdateChannelLoading(true);
    try {
      const res = await backendApp.GetUpdateChannel();
      if (!res?.success
        || !isCurrentUpdateDownloadTaskSession(session)
        || channelChangeRequest !== updateChannelChangeRequestRef.current) {
        return;
      }
      const channel = normalizeUpdateChannel(res?.data?.channel);
      if (hasExplicitUpdateChannelIntentRef.current
        && channel !== intendedUpdateChannelRef.current) {
        return;
      }
      if (!hasExplicitUpdateChannelIntentRef.current) {
        intendedUpdateChannelRef.current = channel;
      }
      setUpdateChannelState(channel);
      setInstallMode(normalizeUpdateInstallMode(res?.data?.installMode));
    } catch (e) {
      console.warn('Wails API: GetUpdateChannel unavailable', e);
    } finally {
      setIsUpdateChannelLoading(false);
    }
  }, [captureUpdateDownloadTaskSession, isCurrentUpdateDownloadTaskSession]);

  const changeUpdateChannel = useCallback(async (nextChannel: UpdateChannel | string) => {
    const normalizedChannel = normalizeUpdateChannel(nextChannel);
    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.SetUpdateChannel !== 'function') {
      intendedUpdateChannelRef.current = normalizedChannel;
      hasExplicitUpdateChannelIntentRef.current = true;
      setUpdateChannelState(normalizedChannel);
      resetLocalUpdateArtifacts();
      setLastUpdateInfo(null);
      setAboutUpdateStatus(t('app.about.update_status.not_checked'));
      return;
    }

    // Ignore check replies already in flight while SetUpdateChannel is
    // pending. The download epoch itself advances only after the backend has
    // accepted the explicit channel change.
    const channelChangeRequest = ++updateChannelChangeRequestRef.current;
    setIsUpdateChannelSaving(true);
    try {
      const res = await backendApp.SetUpdateChannel(normalizedChannel);
      if (channelChangeRequest !== updateChannelChangeRequestRef.current) {
        return;
      }
      if (!res?.success) {
        void message.error(t('app.about.message.channel_switch_failed_with_error', { error: res?.message || t('common.unknown') }));
        return;
      }

      const effectiveChannel = normalizeUpdateChannel(res?.data?.channel || normalizedChannel);
      intendedUpdateChannelRef.current = effectiveChannel;
      hasExplicitUpdateChannelIntentRef.current = true;
      setUpdateChannelState(effectiveChannel);
      setInstallMode(normalizeUpdateInstallMode(res?.data?.installMode || installMode));
      resetLocalUpdateArtifacts();
      setLastUpdateInfo(null);
      setAboutUpdateStatus(t('app.about.update_status.not_checked'));
      // A prior check may still own the single-flight slot. Its response is
      // request-invalidated above, then we run one real check for the newly
      // accepted channel before this action resolves.
      const pendingCheck = updateCheckCompletionRef.current;
      if (pendingCheck) {
        await pendingCheck;
      }
      await checkForUpdates(false);
    } catch (e: any) {
      const error = e?.message || t('common.unknown');
      void message.error(t('app.about.message.channel_switch_failed_with_error', { error }));
    } finally {
      setIsUpdateChannelSaving(false);
    }
  }, [checkForUpdates, installMode, resetLocalUpdateArtifacts, t]);

  const muteLatestUpdate = useCallback(() => {
    if (lastUpdateKey) {
      updateMutedVersionRef.current = lastUpdateKey;
    }
    closeUpdateCenter();
  }, [closeUpdateCenter, lastUpdateKey]);

  const markUpdateProgressDismissed = useCallback(() => {
    updateUserDismissedRef.current = true;
  }, []);

  useEffect(() => {
    void loadUpdateChannel();
  }, [loadUpdateChannel]);

  useEffect(() => {
    if (!autoCheckForUpdates) {
      return;
    }
    const intervalMs = Math.max(1, autoCheckForUpdatesIntervalMinutes) * 60 * 1000;
    const startupTimer = window.setTimeout(() => {
      void checkForUpdates(true);
    }, 2000);
    const interval = window.setInterval(() => {
      void checkForUpdates(true);
    }, intervalMs);
    return () => {
      window.clearTimeout(startupTimer);
      window.clearInterval(interval);
    };
  }, [autoCheckForUpdates, autoCheckForUpdatesIntervalMinutes, checkForUpdates]);
  return {
    checkForUpdates, prepareAboutSurface, changeUpdateChannel, muteLatestUpdate,
    markUpdateProgressDismissed,
  };
};

export type AppUpdateCheckApi = ReturnType<typeof useAppUpdateCheck>;
