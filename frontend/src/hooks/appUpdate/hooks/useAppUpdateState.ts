import { useRef, useCallback, useState, useEffect } from 'react';
import { message } from 'antd';
import { useStore } from '../../../store';
import {
  type UpdateChannel,
  type UpdateDownloadProgressState,
  type UpdateDownloadResultData,
  type UpdateInstallMode,
  type AboutInfo,
  DEFAULT_ABOUT_INFO,
  type UpdateInfo,
  createEmptyDownloadProgress,
  type UpdateDownloadTaskSession,
  type UpdateDownloadTaskSnapshot,
  type UpdateDownloadTaskSnapshotSource,
} from '../appUpdateTypes';
import { resolveAboutDisplayVersion } from '../../../utils/appVersionDisplay';
import {
  normalizeAboutVersion,
  buildUpdateKey,
  resolveUpdateInstallAction,
  normalizeUpdateInfo,
  normalizeUpdateChannel,
  isUpdateDownloadTaskTerminal,
  isUpdateDownloadTaskActive,
  normalizeUpdateInstallMode,
  normalizeUpdateDownloadTaskSnapshot,
} from '../appUpdateNormalizers';
import type { UseAppUpdateManagerOptions } from '../appUpdateTypes';

export interface UseAppUpdateStateInput {
  updateCenterBridgeRef: UseAppUpdateManagerOptions['updateCenterBridgeRef'];
  runtimeBuildType: UseAppUpdateManagerOptions['runtimeBuildType'];
  t: UseAppUpdateManagerOptions['t'];
}

export const useAppUpdateState = ({ updateCenterBridgeRef, runtimeBuildType, t }: UseAppUpdateStateInput) => {
  const autoCheckForUpdates = useStore((state) => state.autoCheckForUpdates);
  const autoCheckForUpdatesIntervalMinutes = useStore(
    (state) => state.autoCheckForUpdatesIntervalMinutes,
  );
  const updateCheckInFlightRef = useRef(false);
  const updateCheckCompletionRef = useRef<Promise<void> | null>(null);
  const updateDownloadInFlightRef = useRef(false);
  // A task can outlive this hook, so every local ownership change gets a new
  // epoch. This prevents a response/event from a previous channel from being
  // adopted after the user has already switched channels.
  const updateDownloadTaskEpochRef = useRef(0);
  const updateDownloadTaskEpochByIdRef = useRef(new Map<string, number>());
  const intendedUpdateChannelRef = useRef<UpdateChannel>('latest');
  const hasExplicitUpdateChannelIntentRef = useRef(false);
  const updateChannelChangeRequestRef = useRef(0);
  const updateDownloadHydrationRequestRef = useRef(0);
  const updateDownloadStartRequestRef = useRef(0);
  const updateDownloadTaskIdRef = useRef<string | null>(null);
  const updateDownloadTaskStatusRef = useRef<UpdateDownloadProgressState['status']>('idle');
  const updateDownloadTaskHydratingRef = useRef(true);
  const updateUserDismissedRef = useRef(false);
  const updateDownloadedVersionRef = useRef<string | null>(null);
  const updateInstallTriggeredVersionRef = useRef<string | null>(null);
  const updateDownloadMetaRef = useRef<UpdateDownloadResultData | null>(null);
  const updateNotifiedVersionRef = useRef<string | null>(null);
  const updateMutedVersionRef = useRef<string | null>(null);
  const isUpdateCenterOpen = useCallback(() => {
    return Boolean(updateCenterBridgeRef?.current?.isOpen?.());
  }, [updateCenterBridgeRef]);

  const openUpdateCenter = useCallback(() => {
    updateCenterBridgeRef?.current?.open?.();
  }, [updateCenterBridgeRef]);

  const closeUpdateCenter = useCallback(() => {
    updateCenterBridgeRef?.current?.close?.();
  }, [updateCenterBridgeRef]);

  const [aboutLoading, setAboutLoading] = useState(false);
  const [updateChannel, setUpdateChannelState] = useState<UpdateChannel>('latest');
  const [installMode, setInstallMode] = useState<UpdateInstallMode>('unknown');
  const [isUpdateChannelLoading, setIsUpdateChannelLoading] = useState(false);
  const [isUpdateChannelSaving, setIsUpdateChannelSaving] = useState(false);
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false);
  const [aboutInfo, setAboutInfo] = useState<AboutInfo>(() => DEFAULT_ABOUT_INFO);
  const [aboutUpdateStatus, setAboutUpdateStatus] = useState<string>('');
  const [lastUpdateInfo, setLastUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateDownloadProgress, setUpdateDownloadProgress] = useState(createEmptyDownloadProgress);
  const updateDownloadProgressRef = useRef<UpdateDownloadProgressState>(updateDownloadProgress);
  const aboutDisplayVersion = resolveAboutDisplayVersion(
    runtimeBuildType,
    normalizeAboutVersion(aboutInfo.version) || normalizeAboutVersion(lastUpdateInfo?.currentVersion),
  );
  const lastUpdateKey = buildUpdateKey(lastUpdateInfo);

  useEffect(() => {
    updateDownloadProgressRef.current = updateDownloadProgress;
  }, [updateDownloadProgress]);

  const formatAboutUpdateStatus = useCallback((info: UpdateInfo | null): string => {
    if (!info) {
      return t('app.about.update_status.not_checked');
    }
    if (info.hasUpdate) {
      const localDownloaded = updateDownloadedVersionRef.current === buildUpdateKey(info);
      const hasDownloaded = Boolean(info.downloaded) || localDownloaded;
      if (!hasDownloaded) {
        return t('app.about.update_status.new_version_not_downloaded', { version: info.latestVersion });
      }
      return resolveUpdateInstallAction(info) === 'restart'
        ? t('app.about.update_status.new_version_ready_restart', { version: info.latestVersion })
        : t('app.about.update_status.new_version_ready_install', { version: info.latestVersion });
    }
    return t('app.about.update_status.latest', { version: info.currentVersion || t('common.unknown') });
  }, [t]);

  const formatBytes = useCallback((bytes?: number) => {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024;
      idx++;
    }
    return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
  }, []);

  const captureUpdateDownloadTaskSession = useCallback((): UpdateDownloadTaskSession => ({
    epoch: updateDownloadTaskEpochRef.current,
    channel: intendedUpdateChannelRef.current,
    enforceChannel: hasExplicitUpdateChannelIntentRef.current,
  }), []);

  const isCurrentUpdateDownloadTaskSession = useCallback((session: UpdateDownloadTaskSession): boolean => (
    session.epoch === updateDownloadTaskEpochRef.current
      && (!session.enforceChannel || session.channel === intendedUpdateChannelRef.current)
  ), []);

  const advanceUpdateDownloadTaskSession = useCallback((): UpdateDownloadTaskSession => {
    updateDownloadTaskEpochRef.current += 1;
    // Keep the taskId -> epoch history. Clearing only the current ID used to
    // make a queued event from the old task look like a brand-new task.
    updateDownloadTaskIdRef.current = null;
    updateDownloadTaskStatusRef.current = 'idle';
    updateDownloadHydrationRequestRef.current += 1;
    updateDownloadTaskHydratingRef.current = false;
    updateDownloadStartRequestRef.current += 1;
    updateDownloadInFlightRef.current = false;
    return captureUpdateDownloadTaskSession();
  }, [captureUpdateDownloadTaskSession]);

  const resetLocalUpdateArtifacts = useCallback(() => {
    advanceUpdateDownloadTaskSession();
    updateDownloadedVersionRef.current = null;
    updateInstallTriggeredVersionRef.current = null;
    updateDownloadMetaRef.current = null;
    const emptyProgress = createEmptyDownloadProgress();
    updateDownloadProgressRef.current = emptyProgress;
    setUpdateDownloadProgress(emptyProgress);
  }, [advanceUpdateDownloadTaskSession]);

  const resolveUpdateDownloadTaskInfo = useCallback((task: UpdateDownloadTaskSnapshot): UpdateInfo | undefined => {
    const baseInfo = task.result?.info || task.info;
    if (!baseInfo) {
      return undefined;
    }
    return normalizeUpdateInfo({
      ...baseInfo,
      downloaded: task.status === 'done' ? true : Boolean(baseInfo.downloaded),
      downloadPath: task.result?.downloadPath || baseInfo.downloadPath,
      installMode: task.result?.installMode || baseInfo.installMode,
      packageType: task.result?.packageType || baseInfo.packageType,
      autoRelaunch: task.result?.autoRelaunch ?? baseInfo.autoRelaunch,
    });
  }, []);

  const resolveUpdateDownloadTaskMessage = useCallback((
    task: UpdateDownloadTaskSnapshot,
    info: UpdateInfo | undefined,
  ): string => {
    if (task.message) {
      return task.message;
    }
    if (task.status === 'done') {
      return resolveUpdateInstallAction(info) === 'restart'
        ? t('app.about.download_progress.ready_to_restart')
        : t('app.about.download_progress.ready_to_install');
    }
    if (task.status === 'start' || task.status === 'downloading') {
      return t('app.about.download_progress.downloading');
    }
    return t('common.unknown');
  }, [t]);

  const canApplyUpdateDownloadTaskSnapshot = useCallback((
    task: UpdateDownloadTaskSnapshot,
    session: UpdateDownloadTaskSession,
    source: UpdateDownloadTaskSnapshotSource,
  ): boolean => {
    if (!isCurrentUpdateDownloadTaskSession(session)) {
      return false;
    }
    const taskEpoch = updateDownloadTaskEpochByIdRef.current.get(task.taskId);
    if (taskEpoch !== undefined && taskEpoch !== session.epoch) {
      return false;
    }
    if (session.enforceChannel
      && task.info
      && normalizeUpdateChannel(task.info.channel) !== session.channel) {
      return false;
    }
    if (taskEpoch === undefined && source === 'event') {
      // Events can win the initial hydration/start RPC race, but once that
      // window has passed an unknown task is necessarily stale noise.
      if (!updateDownloadTaskHydratingRef.current && !updateDownloadInFlightRef.current) {
        return false;
      }
      const expectedKey = updateDownloadProgressRef.current.key;
      const taskKey = buildUpdateKey(task.info);
      if (expectedKey && (!taskKey || taskKey !== expectedKey)) {
        return false;
      }
    }
    return true;
  }, [isCurrentUpdateDownloadTaskSession]);

  const applyUpdateDownloadTaskSnapshot = useCallback((
    task: UpdateDownloadTaskSnapshot,
    options: {
      session: UpdateDownloadTaskSession;
      source: UpdateDownloadTaskSnapshotSource;
      notifyTerminal?: boolean;
      suppressOpen?: boolean;
    },
  ): boolean => {
    if (!canApplyUpdateDownloadTaskSnapshot(task, options.session, options.source)) {
      return false;
    }
    const knownTaskId = updateDownloadTaskIdRef.current;
    const previousTaskStatus = updateDownloadTaskStatusRef.current;
    const previousProgress = updateDownloadProgressRef.current;
    if (knownTaskId === task.taskId && isUpdateDownloadTaskTerminal(previousTaskStatus)) {
      return false;
    }
    if (knownTaskId === task.taskId
      && previousTaskStatus === 'downloading'
      && task.status === 'start') {
      return false;
    }
    if (knownTaskId && knownTaskId !== task.taskId && isUpdateDownloadTaskActive(previousTaskStatus)) {
      return false;
    }

    const isSameTask = knownTaskId === task.taskId;
    const resolvedInfo = resolveUpdateDownloadTaskInfo(task);
    const taskKey = buildUpdateKey(resolvedInfo);
    const preserveMonotonicProgress = isSameTask
      && isUpdateDownloadTaskActive(previousTaskStatus)
      && isUpdateDownloadTaskActive(task.status);
    const total = task.total > 0
      ? task.total
      : (resolvedInfo?.assetSize || previousProgress.total);
    const downloaded = task.status === 'done' && total > 0
      ? total
      : (preserveMonotonicProgress
        ? Math.max(previousProgress.downloaded, task.downloaded)
        : task.downloaded);
    const percent = task.status === 'done'
      ? 100
      : (preserveMonotonicProgress
        ? Math.max(previousProgress.percent, task.percent)
        : task.percent);
    const nextProgress: UpdateDownloadProgressState = {
      open: options?.suppressOpen
        ? previousProgress.open
        : (previousProgress.open || !updateUserDismissedRef.current),
      version: resolvedInfo?.latestVersion || previousProgress.version,
      key: taskKey || previousProgress.key,
      status: task.status,
      percent,
      downloaded,
      total,
      message: resolveUpdateDownloadTaskMessage(task, resolvedInfo),
    };

    updateDownloadTaskIdRef.current = task.taskId;
    updateDownloadTaskEpochByIdRef.current.set(task.taskId, options.session.epoch);
    updateDownloadTaskStatusRef.current = task.status;
    updateDownloadProgressRef.current = nextProgress;
    setUpdateDownloadProgress(nextProgress);

    if (resolvedInfo) {
      if (!hasExplicitUpdateChannelIntentRef.current) {
        intendedUpdateChannelRef.current = normalizeUpdateChannel(resolvedInfo.channel);
      }
      setLastUpdateInfo(resolvedInfo);
      setUpdateChannelState(normalizeUpdateChannel(resolvedInfo.channel));
      setInstallMode(normalizeUpdateInstallMode(resolvedInfo.installMode));
      if (task.status === 'done') {
        const downloadedKey = buildUpdateKey(resolvedInfo);
        if (downloadedKey) {
          updateDownloadedVersionRef.current = downloadedKey;
        }
        updateDownloadMetaRef.current = {
          ...(task.result || {}),
          info: resolvedInfo,
          downloadPath: task.result?.downloadPath || resolvedInfo.downloadPath,
          installMode: task.result?.installMode || resolvedInfo.installMode,
          packageType: task.result?.packageType || resolvedInfo.packageType,
          autoRelaunch: task.result?.autoRelaunch ?? resolvedInfo.autoRelaunch,
        };
      }
      setAboutUpdateStatus(formatAboutUpdateStatus(resolvedInfo));
    }

    const enteredTerminal = isUpdateDownloadTaskTerminal(task.status)
      && !isUpdateDownloadTaskTerminal(previousTaskStatus);
    if (options?.notifyTerminal && enteredTerminal) {
      if (task.status === 'done') {
        const installAction = resolveUpdateInstallAction(resolvedInfo);
        void message.success({
          content: installAction === 'restart'
            ? (resolvedInfo?.downloadPath
              ? t('app.about.message.download_ready_restart_with_path', { path: resolvedInfo.downloadPath })
              : t('app.about.message.download_ready_restart'))
            : (resolvedInfo?.downloadPath
              ? t('app.about.message.download_ready_install_with_path', { path: resolvedInfo.downloadPath })
              : t('app.about.message.download_ready_install')),
          duration: 4,
        });
      } else {
        void message.error({
          content: t('app.about.message.download_failed_with_error', {
            error: task.message || t('common.unknown'),
          }),
          duration: 4,
        });
      }
    }
    return true;
  }, [canApplyUpdateDownloadTaskSnapshot, formatAboutUpdateStatus, resolveUpdateDownloadTaskInfo, resolveUpdateDownloadTaskMessage, t]);

  const refreshUpdateDownloadTask = useCallback(async (
    options?: { restoreInBackground?: boolean; session?: UpdateDownloadTaskSession },
  ): Promise<boolean> => {
    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.GetUpdateDownloadTask !== 'function') {
      return false;
    }
    const session = options?.session || captureUpdateDownloadTaskSession();
    const hydrationRequest = options?.restoreInBackground
      ? ++updateDownloadHydrationRequestRef.current
      : null;
    if (options?.restoreInBackground) {
      updateDownloadTaskHydratingRef.current = true;
    }
    try {
      const response = await backendApp.GetUpdateDownloadTask();
      if (!isCurrentUpdateDownloadTaskSession(session)) {
        return false;
      }
      if (!response?.success) {
        return false;
      }
      const task = normalizeUpdateDownloadTaskSnapshot(response?.data?.task ?? response?.data);
      if (task && options?.restoreInBackground && !updateDownloadProgressRef.current.open) {
        // A restored root did not explicitly ask to show this surface. Keep it
        // in the background just like a user-dismissed progress dialog; the
        // About page still exposes the task through "download progress".
        updateUserDismissedRef.current = true;
      }
      return task
        ? applyUpdateDownloadTaskSnapshot(task, {
          session,
          source: 'hydration',
          suppressOpen: options?.restoreInBackground,
        })
        : false;
    } catch (error) {
      console.warn('Wails API: GetUpdateDownloadTask unavailable', error);
      return false;
    } finally {
      if (options?.restoreInBackground
        && hydrationRequest === updateDownloadHydrationRequestRef.current) {
        updateDownloadTaskHydratingRef.current = false;
      }
    }
  }, [applyUpdateDownloadTaskSnapshot, captureUpdateDownloadTaskSession, isCurrentUpdateDownloadTaskSession]);
  return {
    autoCheckForUpdates, autoCheckForUpdatesIntervalMinutes, updateCheckInFlightRef,
    updateCheckCompletionRef, updateDownloadInFlightRef, intendedUpdateChannelRef,
    hasExplicitUpdateChannelIntentRef, updateChannelChangeRequestRef, updateDownloadStartRequestRef,
    updateDownloadTaskIdRef, updateDownloadTaskStatusRef, updateDownloadTaskHydratingRef,
    updateUserDismissedRef, updateDownloadedVersionRef, updateInstallTriggeredVersionRef,
    updateDownloadMetaRef, updateNotifiedVersionRef, updateMutedVersionRef, isUpdateCenterOpen,
    openUpdateCenter, closeUpdateCenter, aboutLoading, setAboutLoading, updateChannel,
    setUpdateChannelState, installMode, setInstallMode, isUpdateChannelLoading,
    setIsUpdateChannelLoading, isUpdateChannelSaving, setIsUpdateChannelSaving,
    isCheckingForUpdates, setIsCheckingForUpdates, aboutInfo, setAboutInfo, aboutUpdateStatus,
    setAboutUpdateStatus, lastUpdateInfo, setLastUpdateInfo, updateDownloadProgress,
    setUpdateDownloadProgress, updateDownloadProgressRef, aboutDisplayVersion, lastUpdateKey,
    formatAboutUpdateStatus, formatBytes, captureUpdateDownloadTaskSession,
    isCurrentUpdateDownloadTaskSession, advanceUpdateDownloadTaskSession, resetLocalUpdateArtifacts,
    applyUpdateDownloadTaskSnapshot, refreshUpdateDownloadTask,
  };
};

export type AppUpdateStateApi = ReturnType<typeof useAppUpdateState>;
