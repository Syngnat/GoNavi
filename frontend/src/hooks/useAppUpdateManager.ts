import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { message } from 'antd';
import { EventsOn } from '../../wailsjs/runtime';
import { useStore } from '../store';
import { resolveAboutDisplayVersion } from '../utils/appVersionDisplay';

type Translator = (key: string, params?: Record<string, any>) => string;

export type UpdateChannel = 'latest' | 'dev';

export type UpdateInstallMode = 'portable' | 'msi' | 'unknown';
export type UpdatePackageType = 'portable' | 'msi' | 'dmg' | 'archive' | 'unknown';
export type UpdateInstallAction = 'restart' | 'install-and-restart' | 'launch-installer';

export type UpdateInfo = {
  hasUpdate: boolean;
  channel?: UpdateChannel | string;
  currentVersion: string;
  latestVersion: string;
  releaseName?: string;
  releasePublishedAt?: string;
  releaseNotesUrl?: string;
  /** Markdown 更新日志正文（来自 latest.json / GitHub release body） */
  releaseNotes?: string;
  assetName?: string;
  assetUrl?: string;
  assetSize?: number;
  sha256?: string;
  downloaded?: boolean;
  downloadPath?: string;
  installMode?: UpdateInstallMode | string;
  packageType?: UpdatePackageType | string;
  autoRelaunch?: boolean;
};

type UpdateDownloadProgressEvent = {
  taskId?: string;
  status?: 'start' | 'downloading' | 'done' | 'error';
  percent?: number;
  downloaded?: number;
  total?: number;
  message?: string;
  info?: UpdateInfo;
};

type UpdateDownloadResultData = {
  info?: UpdateInfo;
  downloadPath?: string;
  installLogPath?: string;
  installTarget?: string;
  platform?: string;
  autoRelaunch?: boolean;
  installMode?: UpdateInstallMode | string;
  packageType?: UpdatePackageType | string;
};

type UpdateDownloadTaskStatus = 'start' | 'downloading' | 'done' | 'error';

type UpdateDownloadProgressState = {
  open: boolean;
  version: string;
  key: string;
  status: 'idle' | UpdateDownloadTaskStatus;
  percent: number;
  downloaded: number;
  total: number;
  message: string;
};

type UpdateDownloadTaskSnapshot = {
  taskId: string;
  status: UpdateDownloadTaskStatus;
  percent: number;
  downloaded: number;
  total: number;
  message?: string;
  running: boolean;
  info?: UpdateInfo;
  result?: UpdateDownloadResultData;
};

type UpdateDownloadTaskSession = {
  epoch: number;
  channel: UpdateChannel;
  enforceChannel: boolean;
};

type UpdateDownloadTaskSnapshotSource = 'hydration' | 'start' | 'event';

/** 启动发现更新时打开「设置中心-关于」页（替代旧版关于弹窗） */
export type UpdateCenterBridge = {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
};

type UseAppUpdateManagerOptions = {
  runtimeBuildType: string;
  t: Translator;
  updateCenterBridgeRef?: MutableRefObject<UpdateCenterBridge | null>;
  /** 手动「检查更新」发现新版本时，触发打开更新日志弹窗的桥接回调 */
  onManualCheckHasUpdateRef?: MutableRefObject<(() => void) | null>;
};

type AboutInfo = {
  version: string;
  author: string;
  buildTime?: string;
  repoUrl?: string;
  issueUrl?: string;
  releaseUrl?: string;
  communityUrl?: string;
};

const DEFAULT_ABOUT_INFO: AboutInfo = {
  version: '',
  author: 'Syngnat',
  repoUrl: 'https://github.com/Syngnat/GoNavi',
  issueUrl: 'https://github.com/Syngnat/GoNavi/issues',
  releaseUrl: 'https://github.com/Syngnat/GoNavi/releases',
  communityUrl: 'https://aibook.ren',
};

const createEmptyDownloadProgress = (): UpdateDownloadProgressState => ({
  open: false,
  version: '',
  key: '',
  status: 'idle',
  percent: 0,
  downloaded: 0,
  total: 0,
  message: '',
});

const normalizeUpdateChannel = (value: unknown): UpdateChannel =>
  String(value || '').trim().toLowerCase() === 'dev' ? 'dev' : 'latest';

const normalizeUpdateInstallMode = (value: unknown): UpdateInstallMode => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'portable' || normalized === 'msi' ? normalized : 'unknown';
};

const normalizeUpdatePackageType = (value: unknown): UpdatePackageType => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'portable' || normalized === 'msi' || normalized === 'dmg' || normalized === 'archive'
    ? normalized
    : 'unknown';
};

const normalizeUpdateInfo = (value: unknown): UpdateInfo => {
  const source = (value && typeof value === 'object' ? value : {}) as UpdateInfo;
  return {
    ...source,
    channel: normalizeUpdateChannel(source.channel),
    installMode: normalizeUpdateInstallMode(source.installMode),
    packageType: normalizeUpdatePackageType(source.packageType),
  };
};

const isUpdateDownloadTaskStatus = (value: unknown): value is UpdateDownloadTaskStatus => (
  value === 'start' || value === 'downloading' || value === 'done' || value === 'error'
);

const isUpdateDownloadTaskActive = (status: UpdateDownloadTaskStatus | 'idle' | undefined): boolean => (
  status === 'start' || status === 'downloading'
);

const isUpdateDownloadTaskTerminal = (status: UpdateDownloadTaskStatus | 'idle' | undefined): boolean => (
  status === 'done' || status === 'error'
);

const normalizeFiniteNonNegativeNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const normalizeMaybeUpdateInfo = (value: unknown): UpdateInfo | undefined => (
  value && typeof value === 'object' ? normalizeUpdateInfo(value) : undefined
);

const normalizeUpdateDownloadResultData = (value: unknown): UpdateDownloadResultData | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const info = normalizeMaybeUpdateInfo(source.info);
  const result: UpdateDownloadResultData = {
    info,
    downloadPath: String(source.downloadPath || '').trim() || undefined,
    installLogPath: String(source.installLogPath || '').trim() || undefined,
    installTarget: String(source.installTarget || '').trim() || undefined,
    platform: String(source.platform || '').trim() || undefined,
    installMode: String(source.installMode || '').trim() || undefined,
    packageType: String(source.packageType || '').trim() || undefined,
    autoRelaunch: typeof source.autoRelaunch === 'boolean' ? source.autoRelaunch : undefined,
  };
  return info
    || result.downloadPath
    || result.installLogPath
    || result.installTarget
    || result.platform
    || result.installMode
    || result.packageType
    || typeof result.autoRelaunch === 'boolean'
    ? result
    : undefined;
};

const normalizeUpdateDownloadTaskSnapshot = (value: unknown): UpdateDownloadTaskSnapshot | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const source = value as Record<string, unknown>;
  const taskId = String(source.taskId || '').trim();
  const status = String(source.status || '').trim().toLowerCase();
  if (!taskId || !isUpdateDownloadTaskStatus(status)) {
    return null;
  }
  const result = normalizeUpdateDownloadResultData(source.result);
  return {
    taskId,
    status,
    percent: Math.min(100, normalizeFiniteNonNegativeNumber(source.percent)),
    downloaded: normalizeFiniteNonNegativeNumber(source.downloaded),
    total: normalizeFiniteNonNegativeNumber(source.total),
    message: String(source.message || '').trim() || undefined,
    running: source.running === true,
    info: normalizeMaybeUpdateInfo(source.info) || result?.info,
    result,
  };
};

export const resolveUpdateInstallAction = (
  info: Pick<UpdateInfo, 'packageType' | 'autoRelaunch'> | null | undefined,
): UpdateInstallAction => {
  if (normalizeUpdatePackageType(info?.packageType) !== 'msi') {
    return 'restart';
  }
  return info?.autoRelaunch === false ? 'launch-installer' : 'install-and-restart';
};

const buildUpdateKey = (
  info: Pick<UpdateInfo, 'channel' | 'latestVersion' | 'assetName' | 'packageType'> | null | undefined,
): string =>
  info?.latestVersion
    ? [
      normalizeUpdateChannel(info.channel),
      String(info.latestVersion || '').trim(),
      normalizeUpdatePackageType(info.packageType),
      String(info.assetName || '').trim().toLowerCase(),
    ].join(':')
    : '';

const isUnknownAboutValue = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return normalized === 'unknown' || normalized === '未知' || normalized === 'common.unknown';
};

const normalizeAboutText = (value: unknown): string =>
  String(value || '').trim();

const normalizeAboutVersion = (value: unknown): string => {
  const text = normalizeAboutText(value);
  if (!text || text === '0.0.0' || isUnknownAboutValue(text)) {
    return '';
  }
  return text;
};

const normalizeAboutInfo = (value: unknown): AboutInfo => {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const version = normalizeAboutVersion(source.version);
  const author = normalizeAboutText(source.author);
  const buildTime = normalizeAboutText(source.buildTime);
  const repoUrl = normalizeAboutText(source.repoUrl);
  const issueUrl = normalizeAboutText(source.issueUrl);
  const releaseUrl = normalizeAboutText(source.releaseUrl);
  const communityUrl = normalizeAboutText(source.communityUrl);

  return {
    ...DEFAULT_ABOUT_INFO,
    version,
    author: author && !isUnknownAboutValue(author) ? author : DEFAULT_ABOUT_INFO.author,
    buildTime: buildTime || undefined,
    repoUrl: repoUrl || DEFAULT_ABOUT_INFO.repoUrl,
    issueUrl: issueUrl || DEFAULT_ABOUT_INFO.issueUrl,
    releaseUrl: releaseUrl || DEFAULT_ABOUT_INFO.releaseUrl,
    communityUrl: communityUrl || DEFAULT_ABOUT_INFO.communityUrl,
  };
};

export const useAppUpdateManager = ({
  runtimeBuildType,
  t,
  updateCenterBridgeRef,
  onManualCheckHasUpdateRef,
}: UseAppUpdateManagerOptions) => {
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
  const [isAboutOpen, setIsAboutOpen] = useState(false);
  const isAboutOpenRef = useRef(false);

  const isUpdateCenterOpen = useCallback(() => {
    return Boolean(updateCenterBridgeRef?.current?.isOpen?.() || isAboutOpenRef.current);
  }, [updateCenterBridgeRef]);

  // 仅打开关于 UI；应用信息加载由 prepareAboutSurface / isAboutOpen effect 负责
  const openUpdateCenter = useCallback(() => {
    if (updateCenterBridgeRef?.current?.open) {
      updateCenterBridgeRef.current.open();
      return;
    }
    // 兼容：未接线时回退旧版关于弹窗
    setIsAboutOpen(true);
  }, [updateCenterBridgeRef]);

  const closeUpdateCenter = useCallback(() => {
    updateCenterBridgeRef?.current?.close?.();
    setIsAboutOpen(false);
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
    isAboutOpenRef.current = isAboutOpen;
  }, [isAboutOpen]);

  useEffect(() => {
    if (isAboutOpen) {
      setAboutUpdateStatus(formatAboutUpdateStatus(lastUpdateInfo));
      void loadAboutInfo();
    }
  }, [formatAboutUpdateStatus, isAboutOpen, lastUpdateInfo, loadAboutInfo]);

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

  useEffect(() => {
    let offDownloadProgress: any = null;
    try {
      offDownloadProgress = EventsOn('update:download-progress', (event: UpdateDownloadProgressEvent) => {
        if (!event) return;
        const session = captureUpdateDownloadTaskSession();
        const taskId = String(event.taskId || '').trim();
        if (taskId) {
          const task = normalizeUpdateDownloadTaskSnapshot({
            taskId,
            status: event.status || 'downloading',
            percent: event.percent,
            downloaded: event.downloaded,
            total: event.total,
            message: event.message,
            info: event.info,
          });
          if (!task) {
            return;
          }
          const eventKey = buildUpdateKey(task.info);
          if (updateInstallTriggeredVersionRef.current
            && eventKey
            && updateInstallTriggeredVersionRef.current === eventKey) {
            return;
          }
          applyUpdateDownloadTaskSnapshot(task, {
            session,
            source: 'event',
            notifyTerminal: true,
            suppressOpen: updateDownloadTaskHydratingRef.current && !updateDownloadProgressRef.current.open,
          });
          return;
        }

        // Older backends did not include taskId. Keep their event stream
        // usable only when there is no task-scoped download to protect a new
        // background task from stale legacy events.
        if (updateDownloadTaskIdRef.current) {
          return;
        }
        const eventInfo = event.info && typeof event.info === 'object'
          ? normalizeUpdateInfo(event.info)
          : null;
        const eventKey = buildUpdateKey(eventInfo);
        if (hasExplicitUpdateChannelIntentRef.current
          && eventInfo
          && normalizeUpdateChannel(eventInfo.channel) !== session.channel) {
          return;
        }
        // A legacy event has no task ID to bind to an epoch. It can only win
        // the initial hydration/start race; after a reset it is unsafe to
        // treat it as a new task.
        if (!updateDownloadTaskHydratingRef.current && !updateDownloadInFlightRef.current) {
          return;
        }
        const expectedKey = updateDownloadProgressRef.current.key;
        if (expectedKey && eventKey && eventKey !== expectedKey) {
          return;
        }
        if (eventInfo) {
          setLastUpdateInfo((current) => {
            if (buildUpdateKey(current) === eventKey
              && Boolean(current?.downloaded) === Boolean(eventInfo.downloaded)
              && current?.downloadPath === eventInfo.downloadPath) {
              return current;
            }
            return eventInfo;
          });
          setUpdateChannelState(normalizeUpdateChannel(eventInfo.channel));
          setInstallMode(normalizeUpdateInstallMode(eventInfo.installMode));
        }
        const status = event.status || 'downloading';
        const nextStatus: 'idle' | 'start' | 'downloading' | 'done' | 'error' =
          status === 'start' || status === 'downloading' || status === 'done' || status === 'error'
            ? status
            : 'downloading';
        const downloaded = typeof event.downloaded === 'number' ? event.downloaded : 0;
        const total = typeof event.total === 'number' ? event.total : 0;
        const percentRaw = typeof event.percent === 'number'
          ? event.percent
          : (total > 0 ? (downloaded / total) * 100 : 0);
        const percent = Math.max(0, Math.min(100, percentRaw));
        const previousProgress = updateDownloadProgressRef.current;
        // 用户已确认安装时，不让残留的下载事件把 100% 就绪态打回中间态文案。
        if (updateInstallTriggeredVersionRef.current
          && previousProgress.key
          && updateInstallTriggeredVersionRef.current === previousProgress.key) {
          return;
        }
        const eventMessage = String(event.message || '');
        let eventMessageText = eventMessage;
        if (!eventMessageText) {
          if (nextStatus === 'done') {
            eventMessageText = resolveUpdateInstallAction(eventInfo || lastUpdateInfo) === 'restart'
              ? t('app.about.download_progress.ready_to_restart')
              : t('app.about.download_progress.ready_to_install');
          } else if (nextStatus === 'start' || nextStatus === 'downloading') {
            eventMessageText = t('app.about.download_progress.downloading');
          }
        }
        const nextProgress: UpdateDownloadProgressState = {
          open: previousProgress.open || !updateUserDismissedRef.current,
          version: eventInfo?.latestVersion || previousProgress.version,
          key: eventKey || previousProgress.key,
          status: nextStatus,
          percent: nextStatus === 'done' ? 100 : percent,
          downloaded: nextStatus === 'done' && total > 0 ? total : downloaded,
          total: total > 0 ? total : previousProgress.total,
          message: eventMessageText,
        };
        updateDownloadTaskStatusRef.current = nextStatus;
        updateDownloadProgressRef.current = nextProgress;
        setUpdateDownloadProgress(nextProgress);
      });
    } catch (e) {
      console.warn('Wails API: EventsOn unavailable', e);
    }
    return () => {
      if (offDownloadProgress) offDownloadProgress();
    };
  }, [applyUpdateDownloadTaskSnapshot, captureUpdateDownloadTaskSession, lastUpdateInfo?.autoRelaunch, lastUpdateInfo?.packageType, t]);

  // The listener is registered in the effect above first. Hydrating second
  // avoids a replay gap if a background task changes state during mount.
  useEffect(() => {
    void refreshUpdateDownloadTask({ restoreInBackground: true });
  }, [refreshUpdateDownloadTask]);

  const updateInstallAction = resolveUpdateInstallAction(lastUpdateInfo);

  return {
    aboutDisplayVersion,
    aboutInfo,
    aboutLoading,
    aboutUpdateStatus,
    canShowProgressEntry,
    changeUpdateChannel,
    checkForUpdates,
    downloadUpdate,
    formatBytes,
    handleInstallFromProgress,
    hideUpdateDownloadProgress,
    isAboutOpen,
    isBackgroundProgressForLatestUpdate,
    isCheckingForUpdates,
    isLatestUpdateDownloaded,
    isUpdateChannelLoading,
    isUpdateChannelSaving,
    installMode,
    lastUpdateInfo,
    markUpdateProgressDismissed,
    muteLatestUpdate,
    openDownloadedUpdateDirectory,
    prepareAboutSurface,
    setIsAboutOpen,
    showUpdateDownloadProgress,
    updateChannel,
    updateDownloadProgress,
    updateInstallAction,
  };
};
