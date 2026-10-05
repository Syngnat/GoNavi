import {
  type UpdateChannel,
  type UpdateInstallMode,
  type UpdatePackageType,
  type UpdateInfo,
  type UpdateDownloadTaskStatus,
  type UpdateDownloadResultData,
  type UpdateDownloadTaskSnapshot,
  type AboutInfo,
  DEFAULT_ABOUT_INFO,
} from './appUpdateTypes';

export type UpdateInstallAction = 'restart' | 'install-and-restart' | 'launch-installer';

export const normalizeUpdateChannel = (value: unknown): UpdateChannel =>
  String(value || '').trim().toLowerCase() === 'dev' ? 'dev' : 'latest';

export const normalizeUpdateInstallMode = (value: unknown): UpdateInstallMode => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'portable' || normalized === 'msi' ? normalized : 'unknown';
};

const normalizeUpdatePackageType = (value: unknown): UpdatePackageType => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'portable' || normalized === 'msi' || normalized === 'dmg' || normalized === 'archive'
    ? normalized
    : 'unknown';
};

export const normalizeUpdateInfo = (value: unknown): UpdateInfo => {
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

export const isUpdateDownloadTaskActive = (status: UpdateDownloadTaskStatus | 'idle' | undefined): boolean => (
  status === 'start' || status === 'downloading'
);

export const isUpdateDownloadTaskTerminal = (status: UpdateDownloadTaskStatus | 'idle' | undefined): boolean => (
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

export const normalizeUpdateDownloadTaskSnapshot = (value: unknown): UpdateDownloadTaskSnapshot | null => {
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

export const buildUpdateKey = (
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

export const normalizeAboutVersion = (value: unknown): string => {
  const text = normalizeAboutText(value);
  if (!text || text === '0.0.0' || isUnknownAboutValue(text)) {
    return '';
  }
  return text;
};

export const normalizeAboutInfo = (value: unknown): AboutInfo => {
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
