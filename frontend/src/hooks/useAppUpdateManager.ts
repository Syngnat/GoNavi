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
  status?: 'start' | 'downloading' | 'done' | 'error';
  percent?: number;
  downloaded?: number;
  total?: number;
  message?: string;
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

const createEmptyDownloadProgress = () => ({
  open: false,
  version: '',
  key: '',
  status: 'idle' as 'idle' | 'start' | 'downloading' | 'done' | 'error',
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
  const updateDownloadInFlightRef = useRef(false);
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
  const aboutDisplayVersion = resolveAboutDisplayVersion(
    runtimeBuildType,
    normalizeAboutVersion(aboutInfo.version) || normalizeAboutVersion(lastUpdateInfo?.currentVersion),
  );
  const lastUpdateKey = buildUpdateKey(lastUpdateInfo);

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

  const resetLocalUpdateArtifacts = useCallback(() => {
    updateDownloadedVersionRef.current = null;
    updateInstallTriggeredVersionRef.current = null;
    updateDownloadMetaRef.current = null;
    setUpdateDownloadProgress(createEmptyDownloadProgress());
  }, []);

  const downloadUpdate = useCallback(async (info: UpdateInfo, silent: boolean) => {
    if (updateDownloadInFlightRef.current) return;
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
    updateDownloadInFlightRef.current = true;
    updateUserDismissedRef.current = false;
    updateDownloadMetaRef.current = null;
    setUpdateDownloadProgress({
      open: true,
      version: info.latestVersion,
      key: targetKey,
      status: 'start',
      percent: 0,
      downloaded: 0,
      total: info.assetSize || 0,
      message: '',
    });
    let res: any = null;
    try {
      res = await (window as any).go.app.App.DownloadUpdate();
    } catch (e) {
      console.warn('Wails API: DownloadUpdate unavailable', e);
    }
    updateDownloadInFlightRef.current = false;
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
      setInstallMode(normalizeUpdateInstallMode(downloadedInfo.installMode));
      setUpdateDownloadProgress((prev) => {
        const total = prev.total > 0 ? prev.total : (info.assetSize || 0);
        return {
          ...prev,
          version: downloadedInfo.latestVersion,
          key: downloadedKey,
          status: 'done',
          percent: 100,
          downloaded: total,
          total,
          message: '',
          open: prev.open || !updateUserDismissedRef.current,
        };
      });
      setLastUpdateInfo(downloadedInfo);
      const installAction = resolveUpdateInstallAction(downloadedInfo);
      // 下载到 100% 后停留在就绪态，由用户确认当前安装方式对应的更新动作。
      setUpdateDownloadProgress((prev) => ({
        ...prev,
        version: downloadedInfo.latestVersion,
        open: prev.open || !updateUserDismissedRef.current,
        status: 'done',
        percent: 100,
        downloaded: prev.total > 0 ? prev.total : (info.assetSize || prev.downloaded),
        message: installAction === 'restart'
          ? t('app.about.download_progress.ready_to_restart')
          : t('app.about.download_progress.ready_to_install'),
      }));
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
      setUpdateDownloadProgress((prev) => ({
        ...prev,
        status: 'error',
        message: res?.message || t('common.unknown'),
      }));
      void message.error({ content: t('app.about.message.download_failed_with_error', { error: res?.message || t('common.unknown') }), duration: 4 });
    }
  }, [formatAboutUpdateStatus, t]);

  const showUpdateDownloadProgress = useCallback(() => {
    setUpdateDownloadProgress((prev) => {
      if (prev.status === 'idle') return prev;
      return { ...prev, open: true };
    });
  }, []);

  const hideUpdateDownloadProgress = useCallback(() => {
    setUpdateDownloadProgress((prev) => ({ ...prev, open: false }));
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

  const handleInstallFromProgress = useCallback(async (closeAllWindowsInstancesConfirmed = false): Promise<boolean> => {
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
    if (updateCheckInFlightRef.current) return;
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
    } finally {
      updateCheckInFlightRef.current = false;
      setIsCheckingForUpdates(false);
    }
    if (!res?.success) {
      if (!silent) {
        const error = res?.message || t('common.unknown');
        void message.error(t('app.about.message.check_failed_with_error', { error }));
        setAboutUpdateStatus(t('app.about.update_status.check_failed', { error }));
      }
      return;
    }
    const info = normalizeUpdateInfo(res.data || {});
    if (!info) return;
    setUpdateChannelState(normalizeUpdateChannel(info.channel));
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
  }, [formatAboutUpdateStatus, isUpdateCenterOpen, onManualCheckHasUpdateRef, openUpdateCenter, t]);

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
    setIsUpdateChannelLoading(true);
    try {
      const res = await backendApp.GetUpdateChannel();
      if (res?.success) {
        setUpdateChannelState(normalizeUpdateChannel(res?.data?.channel));
        setInstallMode(normalizeUpdateInstallMode(res?.data?.installMode));
      }
    } catch (e) {
      console.warn('Wails API: GetUpdateChannel unavailable', e);
    } finally {
      setIsUpdateChannelLoading(false);
    }
  }, []);

  const changeUpdateChannel = useCallback(async (nextChannel: UpdateChannel | string) => {
    const normalizedChannel = normalizeUpdateChannel(nextChannel);
    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.SetUpdateChannel !== 'function') {
      setUpdateChannelState(normalizedChannel);
      resetLocalUpdateArtifacts();
      setLastUpdateInfo(null);
      setAboutUpdateStatus(t('app.about.update_status.not_checked'));
      return;
    }

    setIsUpdateChannelSaving(true);
    try {
      const res = await backendApp.SetUpdateChannel(normalizedChannel);
      if (!res?.success) {
        void message.error(t('app.about.message.channel_switch_failed_with_error', { error: res?.message || t('common.unknown') }));
        return;
      }

      const effectiveChannel = normalizeUpdateChannel(res?.data?.channel || normalizedChannel);
      setUpdateChannelState(effectiveChannel);
      setInstallMode(normalizeUpdateInstallMode(res?.data?.installMode || installMode));
      resetLocalUpdateArtifacts();
      setLastUpdateInfo(null);
      setAboutUpdateStatus(t('app.about.update_status.not_checked'));
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
        setUpdateDownloadProgress((prev) => {
          // 用户已确认安装时，不让残留的下载事件把 100% 就绪态打回中间态文案。
          if (updateInstallTriggeredVersionRef.current && prev.key && updateInstallTriggeredVersionRef.current === prev.key) {
            return prev;
          }
          const eventMessage = String(event.message || '');
          let message = eventMessage;
          if (!message) {
            if (nextStatus === 'done') {
              message = resolveUpdateInstallAction(lastUpdateInfo) === 'restart'
                ? t('app.about.download_progress.ready_to_restart')
                : t('app.about.download_progress.ready_to_install');
            } else if (nextStatus === 'start' || nextStatus === 'downloading') {
              message = t('app.about.download_progress.downloading');
            }
          }
          return {
            open: prev.open || !updateUserDismissedRef.current,
            version: prev.version,
            key: prev.key,
            status: nextStatus,
            percent: nextStatus === 'done' ? 100 : percent,
            downloaded: nextStatus === 'done' && total > 0 ? total : downloaded,
            total: total > 0 ? total : prev.total,
            message,
          };
        });
      });
    } catch (e) {
      console.warn('Wails API: EventsOn unavailable', e);
    }
    return () => {
      if (offDownloadProgress) offDownloadProgress();
    };
  }, [lastUpdateInfo?.autoRelaunch, lastUpdateInfo?.packageType, t]);

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
