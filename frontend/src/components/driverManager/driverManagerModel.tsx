import { Typography } from 'antd';
import { InfoCircleFilled } from '@ant-design/icons';
import { t } from '../../i18n';
import type { DriverProgressStatus } from '../../utils/driverProgress';

export const { Paragraph, Text } = Typography;

export type DriverListSortKey = 'name' | 'status' | 'size' | 'version';

const parseDriverPackageSizeBytes = (value?: string): number => {
  const raw = String(value || '').trim();
  if (!raw || raw === '-') return -1;
  const matched = raw.match(/^([\d.]+)\s*(B|KB|MB|GB|TB)?$/i);
  if (!matched) return -1;
  const amount = Number(matched[1]);
  if (!Number.isFinite(amount)) return -1;
  const unit = String(matched[2] || 'B').toUpperCase();
  const factor = unit === 'KB' ? 1024
    : unit === 'MB' ? 1024 ** 2
      : unit === 'GB' ? 1024 ** 3
        : unit === 'TB' ? 1024 ** 4
          : 1;
  return amount * factor;
};

const driverStatusSortRank = (row: DriverStatusRow): number => {
  // 与列表圆点 / 详情 Tag 一致：需重装（含可选更新）优先于仍可连接，避免橙色混进绿色里
  if (row.needsUpdate || row.optionalUpdate) return 0;
  if (row.builtIn || row.connectable) return 1;
  if (row.packageInstalled) return 2;
  return 3;
};

export const compareDriverRows = (left: DriverStatusRow, right: DriverStatusRow, sortKey: DriverListSortKey): number => {
  if (sortKey === 'status') {
    const byStatus = driverStatusSortRank(left) - driverStatusSortRank(right);
    if (byStatus !== 0) return byStatus;
  } else if (sortKey === 'size') {
    const bySize = parseDriverPackageSizeBytes(right.packageSizeText) - parseDriverPackageSizeBytes(left.packageSizeText);
    if (bySize !== 0) return bySize;
  } else if (sortKey === 'version') {
    const leftVersion = String(left.installedVersion || left.pinnedVersion || '');
    const rightVersion = String(right.installedVersion || right.pinnedVersion || '');
    const byVersion = leftVersion.localeCompare(rightVersion, undefined, { numeric: true, sensitivity: 'base' });
    if (byVersion !== 0) return byVersion;
  }
  const byName = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  if (byName !== 0) return byName;
  return left.type.localeCompare(right.type, undefined, { sensitivity: 'base' });
};

export type DriverStatusRow = {
  type: string;
  name: string;
  builtIn: boolean;
  pinnedVersion?: string;
  installedVersion?: string;
  packageSizeText?: string;
  runtimeAvailable: boolean;
  packageInstalled: boolean;
  connectable: boolean;
  defaultDownloadUrl?: string;
  installDir?: string;
  packagePath?: string;
  executablePath?: string;
  downloadedAt?: string;
  agentRevision?: string;
  expectedRevision?: string;
  needsUpdate?: boolean;
  optionalUpdate?: boolean;
  updateReason?: string;
  affectedConnections?: number;
  activeConnections?: number;
  reasonCode?: string;
  message?: string;
};

export type DriverProgressEvent = {
  taskId?: string;
  driverType?: string;
  status?: DriverProgressStatus;
  message?: string;
  percent?: number;
};

export type DriverActionKind = '' | 'install' | 'remove' | 'local';
export type DriverBatchActionKind = '' | 'install-all' | 'reinstall-updates' | 'remove-all';

export type DriverBatchProgressState = {
  total: number;
  completed: number;
  success: number;
  failed: number;
  skipped: number;
  currentDriverType: string;
  currentDriverName: string;
  currentMessage: string;
};

export type DriverLogEntry = {
  time: string;
  text: string;
  signature: string;
};

export type DriverNetworkProbe = {
  probeCode?: string;
  name: string;
  url: string;
  reachable: boolean;
  httpStatus?: number;
  latencyMs?: number;
  tcpLatencyMs?: number;
  httpLatencyMs?: number;
  method?: string;
  error?: string;
};

export type DriverNetworkStatus = {
  reachable: boolean;
  summary: string;
  recommendedProxy: boolean;
  proxyConfigured: boolean;
  mirrorReachable?: boolean;
  fallbackChecked?: boolean;
  fallbackReachable?: boolean;
  usingFallback?: boolean;
  downloadChainReachable?: boolean;
  downloadRequiredHosts?: string[];
  proxyEnv?: Record<string, string>;
  checks: DriverNetworkProbe[];
  checkedAt?: string;
  logPath?: string;
};

const DRIVER_NETWORK_PROBE_LABEL_KEYS: Record<string, string> = {
  download_mirror: 'driver_manager.backend.network.probe.download_mirror',
  github_api: 'driver_manager.backend.network.probe.github_api',
  github_release: 'driver_manager.backend.network.probe.github_driver_release',
  github_release_asset: 'driver_manager.backend.network.probe.github_release_asset_domain',
  go_module_proxy: 'driver_manager.backend.network.probe.go_module_proxy',
};

export const resolveDriverNetworkProbeLabel = (probe: DriverNetworkProbe): string => {
  const key = DRIVER_NETWORK_PROBE_LABEL_KEYS[String(probe.probeCode || '').trim()];
  return key ? t(key) : String(probe.name || '').trim();
};

export const parseOptionalLatency = (value: unknown): number | undefined => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
};

export const sharedInfoAlertIcon = <InfoCircleFilled style={{ fontSize: 24 }} />;

const DRIVER_DOWNLOAD_SOURCE_META: Record<string, { labelKey: string; darkDot: string; lightDot: string }> = {
  cst: { labelKey: 'app.download_source.option.cst', darkDot: '#f59e0b', lightDot: '#d97706' },
  bero: { labelKey: 'app.download_source.option.bero', darkDot: '#38bdf8', lightDot: '#0284c7' },
  github: { labelKey: 'app.download_source.option.github', darkDot: '#cbd5e1', lightDot: '#475569' },
};

export const resolveDriverDownloadSourceMeta = (value: unknown) => {
  const normalized = String(value || '').trim().toLowerCase();
  return DRIVER_DOWNLOAD_SOURCE_META[normalized] || DRIVER_DOWNLOAD_SOURCE_META.cst;
};

export type DriverVersionOption = {
  version: string;
  downloadUrl: string;
  packageSizeText?: string;
  recommended?: boolean;
  source?: string;
  year?: string;
  displayLabel?: string;
};

export const buildVersionOptionKey = (option: DriverVersionOption) => `${option.version}@@${option.downloadUrl}`;
export const buildVersionSizeLoadingKey = (driverType: string, optionKey: string) => `${driverType}@@${optionKey}`;
export const buildFallbackVersionOptions = (row: DriverStatusRow): DriverVersionOption[] => {
  const pinnedVersion = String(row.pinnedVersion || '').trim();
  const installedVersion = String(row.installedVersion || '').trim();
  const version = row.needsUpdate
    ? pinnedVersion || installedVersion
    : installedVersion || pinnedVersion;
  const downloadUrl = String(row.defaultDownloadUrl || '').trim();
  if (!version && !downloadUrl) {
    return [];
  }
  const recommended = !!version && version === pinnedVersion;
  const baseLabel = version || t('driver.modal.version.default');
  return [{
    version,
    downloadUrl,
    recommended,
    source: 'status-fallback',
    displayLabel: recommended
      ? `${baseLabel}${t('driver_manager.version.recommended_suffix')}`
      : baseLabel,
  }];
};
export const mergeFallbackVersionOptions = (
  row: DriverStatusRow,
  options: DriverVersionOption[],
): DriverVersionOption[] => {
  const fallbackOption = buildFallbackVersionOptions(row)[0];
  if (!fallbackOption) {
    return options;
  }
  const fallbackVersion = String(fallbackOption.version || '').trim();
  const fallbackExists = fallbackVersion
    ? options.some((item) => String(item.version || '').trim() === fallbackVersion)
    : options.some((item) => buildVersionOptionKey(item) === buildVersionOptionKey(fallbackOption));
  return fallbackExists ? options : [...options, fallbackOption];
};
export const resolvePreferredVersionOption = (
  row: DriverStatusRow,
  options: DriverVersionOption[],
  selectedKey?: string,
): DriverVersionOption | undefined => {
  if (selectedKey) {
    const exactMatch = options.find((item) => buildVersionOptionKey(item) === selectedKey);
    if (exactMatch) {
      return exactMatch;
    }
    const separatorIndex = selectedKey.indexOf('@@');
    const selectedVersion = separatorIndex >= 0
      ? selectedKey.slice(0, separatorIndex).trim()
      : '';
    if (selectedVersion) {
      const versionMatch = options.find((item) => String(item.version || '').trim() === selectedVersion);
      if (versionMatch) {
        return versionMatch;
      }
    }
  }
  return (
    (row.needsUpdate ? options.find((item) => item.version === row.pinnedVersion) : undefined) ||
    (row.needsUpdate ? options.find((item) => item.recommended) : undefined) ||
    options.find((item) => item.version === row.installedVersion) ||
    options.find((item) => item.version === row.pinnedVersion) ||
    options.find((item) => item.recommended) ||
    options[0]
  );
};
