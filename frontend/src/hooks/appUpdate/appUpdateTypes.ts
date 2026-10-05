import type { MutableRefObject } from 'react';

type Translator = (key: string, params?: Record<string, any>) => string;

export type UpdateChannel = 'latest' | 'dev';

export type UpdateInstallMode = 'portable' | 'msi' | 'unknown';
export type UpdatePackageType = 'portable' | 'msi' | 'dmg' | 'archive' | 'unknown';

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

export type UpdateDownloadProgressEvent = {
  taskId?: string;
  status?: 'start' | 'downloading' | 'done' | 'error';
  percent?: number;
  downloaded?: number;
  total?: number;
  message?: string;
  info?: UpdateInfo;
};

export type UpdateDownloadResultData = {
  info?: UpdateInfo;
  downloadPath?: string;
  installLogPath?: string;
  installTarget?: string;
  platform?: string;
  autoRelaunch?: boolean;
  installMode?: UpdateInstallMode | string;
  packageType?: UpdatePackageType | string;
};

export type UpdateDownloadTaskStatus = 'start' | 'downloading' | 'done' | 'error';

export type UpdateDownloadProgressState = {
  open: boolean;
  version: string;
  key: string;
  status: 'idle' | UpdateDownloadTaskStatus;
  percent: number;
  downloaded: number;
  total: number;
  message: string;
};

export type UpdateDownloadTaskSnapshot = {
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

export type UpdateDownloadTaskSession = {
  epoch: number;
  channel: UpdateChannel;
  enforceChannel: boolean;
};

export type UpdateDownloadTaskSnapshotSource = 'hydration' | 'start' | 'event';

/** 启动发现更新时打开「设置中心-关于」页（替代旧版关于弹窗） */
export type UpdateCenterBridge = {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
};

export type UseAppUpdateManagerOptions = {
  runtimeBuildType: string;
  t: Translator;
  updateCenterBridgeRef?: MutableRefObject<UpdateCenterBridge | null>;
  /** 手动「检查更新」发现新版本时，触发打开更新日志弹窗的桥接回调 */
  onManualCheckHasUpdateRef?: MutableRefObject<(() => void) | null>;
};

export type AboutInfo = {
  version: string;
  author: string;
  buildTime?: string;
  repoUrl?: string;
  issueUrl?: string;
  releaseUrl?: string;
  communityUrl?: string;
};

export const DEFAULT_ABOUT_INFO: AboutInfo = {
  version: '',
  author: 'Syngnat',
  repoUrl: 'https://github.com/Syngnat/GoNavi',
  issueUrl: 'https://github.com/Syngnat/GoNavi/issues',
  releaseUrl: 'https://github.com/Syngnat/GoNavi/releases',
  communityUrl: 'https://aibook.ren',
};

export const createEmptyDownloadProgress = (): UpdateDownloadProgressState => ({
  open: false,
  version: '',
  key: '',
  status: 'idle',
  percent: 0,
  downloaded: 0,
  total: 0,
  message: '',
});
