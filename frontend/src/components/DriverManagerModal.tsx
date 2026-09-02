import Modal from './common/ResizableDraggableModal';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Collapse, Empty, Input, Progress, Select, Space, Switch, Tag, Typography, message } from 'antd';
import { DeleteOutlined, DownloadOutlined, FileSearchOutlined, FolderOpenOutlined, InfoCircleFilled, ReloadOutlined } from '@ant-design/icons';
import { EventsOn } from '../../wailsjs/runtime/runtime';
import { messages } from '../../../shared/i18n/messages';
import { catalogs } from '../i18n/catalog';
import { useStore } from '../store';
import { t } from '../i18n';
import { normalizeOpacityForPlatform, resolveAppearanceValues } from '../utils/appearance';
import { isBackendCancelledResult } from '../utils/connectionExport';
import { normalizeDriverProgressUpdate, type DriverProgressState } from '../utils/driverProgress';
import { buildDriverManagerWorkbenchTheme } from '../utils/driverManagerWorkbenchTheme';
import {
  getDriverLocalImportButtonLabel,
  getDriverLocalImportDirectoryHelp,
  getDriverLocalImportSingleFileHelp,
} from '../utils/driverImportGuidance';
import {
  createDriverStatusSnapshotRegistry,
  normalizeDriverStatusRequestKey,
  restoreDriverNetworkSnapshot,
  restoreDriverStatusSnapshot,
  settleLatestDriverRequest,
  type DriverStatusSnapshot as DriverStatusSnapshotState,
} from '../utils/driverManagerRequestState';
import {
  CheckDriverNetworkStatus,
  DownloadDriverPackage,
  GetDriverVersionList,
  GetDriverVersionPackageSize,
  GetDriverStatusList,
  InstallLocalDriverPackage,
  ListDriverDownloadTasks,
  OpenDriverDownloadDirectory,
  RemoveDriverPackage,
  SelectDriverPackageDirectory,
  SelectDriverPackageFile,
  StartDriverPackageDownload,
} from '../../wailsjs/go/app/App';

const { Paragraph, Text } = Typography;

type DriverStatusRow = {
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
  updateReason?: string;
  affectedConnections?: number;
  reasonCode?: string;
  message?: string;
};

type DriverProgressEvent = {
  taskId?: string;
  driverType?: string;
  status?: 'start' | 'downloading' | 'done' | 'error';
  message?: string;
  percent?: number;
};

type DriverDownloadTaskSnapshot = {
  taskId: string;
  driverType: string;
  version?: string;
  downloadDir?: string;
  status: DriverProgressState['status'];
  percent: number;
  message?: string;
  running?: boolean;
  startedAt?: string;
  finishedAt?: string;
};

type DriverLocalSourceCode = 'file' | 'directory';
type DriverActionKind = '' | 'install' | 'remove' | 'local';
type DriverBatchActionKind = '' | 'install-all' | 'reinstall-updates' | 'remove-all';

type DriverBatchProgressState = {
  total: number;
  completed: number;
  success: number;
  failed: number;
  skipped: number;
  currentDriverType: string;
  currentDriverName: string;
  currentMessage: string;
};

type DriverLogEntry = {
  time: string;
  text: string;
  signature: string;
};

type DriverNetworkProbe = {
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

type DriverNetworkStatus = {
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

const resolveDriverNetworkProbeLabel = (probe: DriverNetworkProbe): string => {
  const key = DRIVER_NETWORK_PROBE_LABEL_KEYS[String(probe.probeCode || '').trim()];
  return key ? t(key) : String(probe.name || '').trim();
};

const parseOptionalLatency = (value: unknown): number | undefined => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
};

const sharedInfoAlertIcon = <InfoCircleFilled style={{ fontSize: 24 }} />;

type DriverVersionOption = {
  version: string;
  downloadUrl: string;
  packageSizeText?: string;
  recommended?: boolean;
  source?: string;
  year?: string;
  displayLabel?: string;
};

const buildVersionOptionKey = (option: DriverVersionOption) => `${option.version}@@${option.downloadUrl}`;
const buildVersionSizeLoadingKey = (driverType: string, optionKey: string) => `${driverType}@@${optionKey}`;
const buildFallbackVersionOptions = (row: DriverStatusRow): DriverVersionOption[] => {
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
const mergeFallbackVersionOptions = (
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
const resolvePreferredVersionOption = (
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
const DRIVER_STATUS_CACHE_TTL_MS = 60 * 1000;
const DRIVER_NETWORK_CACHE_TTL_MS = 5 * 60 * 1000;
const normalizeDriverSearchText = (value: string) => String(value || '').trim().toLowerCase();
const isDriverDownloadActive = (progress?: DriverProgressState): boolean => (
  progress?.status === 'start' || progress?.status === 'downloading'
);
const isDriverDownloadTerminal = (progress?: DriverProgressState): boolean => (
  progress?.status === 'done' || progress?.status === 'error'
);
const normalizeDriverDownloadTaskSnapshot = (value: unknown): DriverDownloadTaskSnapshot | null => {
  const item = (value || {}) as Record<string, unknown>;
  const taskId = String(item.taskId || '').trim();
  const driverType = String(item.driverType || '').trim().toLowerCase();
  const rawStatus = String(item.status || '').trim().toLowerCase();
  if (!taskId || !driverType || !['start', 'downloading', 'done', 'error'].includes(rawStatus)) {
    return null;
  }
  const running = typeof item.running === 'boolean' ? item.running : undefined;
  const status = running === false && (rawStatus === 'start' || rawStatus === 'downloading')
    ? 'error'
    : rawStatus;
  return {
    taskId,
    driverType,
    version: String(item.version || '').trim() || undefined,
    downloadDir: String(item.downloadDir || '').trim() || undefined,
    status: status as DriverProgressState['status'],
    percent: Math.max(0, Math.min(100, Number(item.percent || 0))),
    message: String(item.message || '').trim() || undefined,
    running,
    startedAt: String(item.startedAt || '').trim() || undefined,
    finishedAt: String(item.finishedAt || '').trim() || undefined,
  };
};
const isSlimBuildInstallUnavailable = (row: DriverStatusRow) => row.reasonCode === 'slim_build_missing_driver' && !row.packageInstalled;
const resolveDriverBatchActionLabel = (actionKind: DriverBatchActionKind) => {
  switch (actionKind) {
    case 'install-all':
      return t('driver.modal.batch.action.installAll');
    case 'reinstall-updates':
      return t('driver.modal.batch.action.reinstallUpdates');
    case 'remove-all':
      return t('driver.modal.batch.action.removeAll');
    default:
      return t('driver.modal.batch.action.default');
  }
};
const resolveDriverLocalSourceLabel = (sourceLabel: DriverLocalSourceCode) => (
  sourceLabel === 'directory' ? t('driver.modal.localSource.directory') : t('driver.modal.localSource.file')
);
const formatDriverBatchSkipSummary = (dedupeSkipCount: number, slimSkipCount: number) => {
  const skipParts: string[] = [];
  if (dedupeSkipCount > 0) {
    skipParts.push(t('driver.modal.batch.skip.dedupe', { count: dedupeSkipCount }));
  }
  if (slimSkipCount > 0) {
    skipParts.push(t('driver.modal.batch.skip.slim', { count: slimSkipCount }));
  }
  return skipParts.length > 0 ? t('driver.modal.batch.skip.summary', { summary: skipParts.join(t('driver.modal.punctuation.comma')) }) : '';
};
const formatDriverVersionTip = (version: string) => (
  version ? t('driver.modal.version.tip', { version }) : ''
);
const formatDriverLogVersionTip = (version: string) => (
  version ? t('driver.modal.operationLog.versionTip', { version }) : ''
);
const DRIVER_ERROR_DETAIL_SENTINEL = '__GONAVI_DRIVER_ERROR_DETAIL__';
const DRIVER_ERROR_DETAIL_SEPARATORS = [': ', '：', '： ', ':'];
const interpolateDriverMessageTemplate = (
  template: string,
  params?: Record<string, unknown>,
): string => template
  .replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = params?.[key];
    return value === undefined || value === null ? '' : String(value);
  })
  .replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = params?.[key];
    return value === undefined || value === null ? '' : String(value);
  });
const resolveDriverMessageKeysByValue = (
  value: string,
  params?: Record<string, unknown>,
): string[] => {
  const target = String(value || '').trim();
  if (!target) {
    return [];
  }
  const matchedKeys = new Set<string>();
  Object.values(messages).forEach((catalog) => {
    Object.entries(catalog).forEach(([key, messageText]) => {
      if (interpolateDriverMessageTemplate(String(messageText || ''), params).trim() === target) {
        matchedKeys.add(key);
      }
    });
  });
  return Array.from(matchedKeys);
};
const buildDriverErrorWrapperMatchers = (
  fallbackMessage: string,
  detailKey?: string,
  detailParams?: Record<string, unknown>,
  backendWrapperKeys?: string[],
): { exactWrappers: string[]; detailPrefixes: string[] } => {
  const exactWrappers = new Set<string>();
  const detailPrefixes = new Set<string>();

  resolveDriverMessageKeysByValue(fallbackMessage, detailParams).forEach((fallbackKey) => {
    Object.values(messages).forEach((catalog) => {
      const wrapper = interpolateDriverMessageTemplate(String(catalog[fallbackKey] || ''), detailParams).trim();
      if (!wrapper) {
        return;
      }
      exactWrappers.add(wrapper);
      DRIVER_ERROR_DETAIL_SEPARATORS.forEach((separator) => {
        detailPrefixes.add(`${wrapper}${separator}`);
      });
    });
  });

  if (detailKey) {
    const templateParams = {
      ...(detailParams || {}),
      detail: DRIVER_ERROR_DETAIL_SENTINEL,
    };
    Object.values(messages).forEach((catalog) => {
      const template = catalog[detailKey];
      if (typeof template !== 'string' || !template.includes('{detail}')) {
        return;
      }
      const renderedTemplate = interpolateDriverMessageTemplate(template, templateParams).trim();
      const detailIndex = renderedTemplate.indexOf(DRIVER_ERROR_DETAIL_SENTINEL);
      if (detailIndex < 0) {
        return;
      }
      const prefix = renderedTemplate.slice(0, detailIndex);
      if (!prefix.trim()) {
        return;
      }
      detailPrefixes.add(prefix);
      detailPrefixes.add(prefix.trimEnd());
    });
  }

  if (backendWrapperKeys && backendWrapperKeys.length > 0) {
    const templateParams = {
      ...(detailParams || {}),
      detail: DRIVER_ERROR_DETAIL_SENTINEL,
    };
    Object.values(catalogs).forEach((catalog) => {
      backendWrapperKeys.forEach((backendWrapperKey) => {
        const template = (catalog as Record<string, string>)[backendWrapperKey];
        if (typeof template !== 'string' || !template.includes('detail')) {
          return;
        }
        const renderedTemplate = interpolateDriverMessageTemplate(template, templateParams).trim();
        const detailIndex = renderedTemplate.indexOf(DRIVER_ERROR_DETAIL_SENTINEL);
        if (detailIndex < 0) {
          return;
        }
        const prefix = renderedTemplate.slice(0, detailIndex);
        if (!prefix.trim()) {
          return;
        }
        detailPrefixes.add(prefix);
        detailPrefixes.add(prefix.trimEnd());
      });
    });
  }

  return {
    exactWrappers: Array.from(exactWrappers).sort((left, right) => right.length - left.length),
    detailPrefixes: Array.from(detailPrefixes).sort((left, right) => right.length - left.length),
  };
};
const stripWrappedDriverErrorDetail = (
  rawMessage: unknown,
  fallbackMessage: string,
  detailKey?: string,
  detailParams?: Record<string, unknown>,
  backendWrapperKeys?: string[],
): { detail: string; stripped: boolean } => {
  const messageText = String(rawMessage || '').trim();
  if (!messageText) {
    return { detail: '', stripped: false };
  }

  const { exactWrappers, detailPrefixes } = buildDriverErrorWrapperMatchers(
    fallbackMessage,
    detailKey,
    detailParams,
    backendWrapperKeys,
  );
  if (exactWrappers.includes(messageText)) {
    return { detail: '', stripped: true };
  }
  for (const prefix of detailPrefixes) {
    if (!prefix || !messageText.startsWith(prefix)) {
      continue;
    }
    return {
      detail: messageText.slice(prefix.length).trim(),
      stripped: true,
    };
  }
  return { detail: messageText, stripped: false };
};
const formatDriverErrorMessageWithDetail = (
  fallbackMessage: string,
  detail: string,
): string => `${fallbackMessage}${/[\u3400-\u9fff]/.test(fallbackMessage) ? '：' : ': '}${detail}`;
export const resolveDriverErrorMessageText = (
  rawMessage: unknown,
  fallbackMessage: string,
  detailKey?: string,
  detailParams?: Record<string, unknown>,
  backendWrapperKeys?: string[],
): string => {
  const { detail, stripped } = stripWrappedDriverErrorDetail(
    rawMessage,
    fallbackMessage,
    detailKey,
    detailParams,
    backendWrapperKeys,
  );
  if (!detail) {
    return fallbackMessage;
  }
  if (!detailKey) {
    return stripped ? formatDriverErrorMessageWithDetail(fallbackMessage, detail) : detail;
  }
  return t(detailKey, {
    ...(detailParams || {}),
    detail,
  });
};
const containsCjkText = (value: string) => /[\u3400-\u9fff]/.test(value);
const appendRawNonChineseDetail = (parts: string[], value: unknown) => {
  const text = String(value || '').trim();
  if (!text || containsCjkText(text) || parts.includes(text)) {
    return;
  }
  parts.push(text);
};
const formatDriverCardStatusMessage = (row: DriverStatusRow): string => {
  const parts: string[] = [];
  if (row.builtIn) {
    parts.push(t('driver.modal.card.status.builtIn'));
  } else if (row.needsUpdate) {
    parts.push(t('driver.modal.card.status.needsUpdate'));
    if (row.agentRevision) {
      parts.push(t('driver.modal.card.status.installedRevision', { revision: row.agentRevision }));
    }
    if (row.expectedRevision) {
      parts.push(t('driver.modal.card.status.expectedRevision', { revision: row.expectedRevision }));
    }
    appendRawNonChineseDetail(parts, row.updateReason);
    appendRawNonChineseDetail(parts, row.message);
  } else if (row.connectable || row.runtimeAvailable) {
    parts.push(t('driver.modal.card.status.runtimeAvailable'));
    appendRawNonChineseDetail(parts, row.message);
  } else if (row.packageInstalled) {
    const version = row.installedVersion || row.pinnedVersion || '';
    parts.push(version
      ? t('driver.modal.card.status.installedPendingVersion', { version })
      : t('driver.modal.card.status.installedPending'));
    appendRawNonChineseDetail(parts, row.message);
  } else if (row.pinnedVersion) {
    parts.push(t('driver.modal.card.status.notEnabledVersion', { version: row.pinnedVersion }));
    appendRawNonChineseDetail(parts, row.message);
  } else {
    parts.push(t('driver.modal.card.status.notEnabled'));
    appendRawNonChineseDetail(parts, row.message);
  }
  return parts.join(' ');
};
const formatDriverNetworkSummary = (status: DriverNetworkStatus): string => {
  if (status.usingFallback || (status.mirrorReachable === false && status.fallbackReachable === true)) {
    return t('driver_manager.network.summary.mirror_fallback_available');
  }
  if (status.reachable) {
    return t(status.proxyConfigured
      ? 'driver_manager.network.summary.reachable_with_proxy'
      : 'driver_manager.network.summary.reachable');
  }
  if (status.downloadChainReachable === false) {
    return t('driver_manager.network.summary.download_chain_unreachable');
  }
  if (status.proxyConfigured) {
    return t('driver_manager.network.summary.unreachable_proxy_configured');
  }
  if (status.recommendedProxy) {
    return t('driver_manager.network.summary.proxy_recommended');
  }
  return t('driver_manager.network.summary.unreachable');
};
const createDriverBatchProgress = (total: number, currentMessage: string): DriverBatchProgressState => ({
  total,
  completed: 0,
  success: 0,
  failed: 0,
  skipped: 0,
  currentDriverType: '',
  currentDriverName: '',
  currentMessage,
});

const driverStatusSnapshots = createDriverStatusSnapshotRegistry<DriverStatusRow>();
let driverNetworkSnapshotCache: { status: DriverNetworkStatus; cachedAt: number } | null = null;
let driverStatusSnapshotIntentSequence = 0;
type DriverStatusBackendResult = Awaited<ReturnType<typeof GetDriverStatusList>>;
type DriverNetworkBackendResult = Awaited<ReturnType<typeof CheckDriverNetworkStatus>>;
const driverStatusInFlightRequests = new Map<string, Promise<DriverStatusBackendResult>>();
let driverNetworkInFlightRequest: Promise<DriverNetworkBackendResult> | null = null;

const requestDriverStatusShared = (downloadDir: string): Promise<DriverStatusBackendResult> => {
  const requestKey = normalizeDriverStatusRequestKey(downloadDir);
  const pendingRequest = driverStatusInFlightRequests.get(requestKey);
  if (pendingRequest) {
    return pendingRequest;
  }
  const request = Promise.resolve()
    .then(() => GetDriverStatusList(downloadDir, ''))
    .finally(() => {
      if (driverStatusInFlightRequests.get(requestKey) === request) {
        driverStatusInFlightRequests.delete(requestKey);
      }
    });
  driverStatusInFlightRequests.set(requestKey, request);
  return request;
};

const requestDriverNetworkStatusShared = (): Promise<DriverNetworkBackendResult> => {
  if (driverNetworkInFlightRequest) {
    return driverNetworkInFlightRequest;
  }
  const request = Promise.resolve()
    .then(() => CheckDriverNetworkStatus())
    .finally(() => {
      if (driverNetworkInFlightRequest === request) {
        driverNetworkInFlightRequest = null;
      }
    });
  driverNetworkInFlightRequest = request;
  return request;
};

const isFreshCache = (cachedAt: number, ttlMs: number): boolean => Date.now() - cachedAt <= ttlMs;

const buildVersionSelectOptions = (options: DriverVersionOption[]) => {
  type SelectOption = { value: string; label: string };
  type SelectGroup = { label: string; options: SelectOption[] };

  if (options.length === 0) {
    return [] as Array<SelectOption | SelectGroup>;
  }

  const yearGroups = new Map<string, SelectOption[]>();
  const others: SelectOption[] = [];
  options.forEach((option) => {
    const selectOption: SelectOption = {
      value: buildVersionOptionKey(option),
      label: option.displayLabel || option.version || t('driver.modal.version.default'),
    };
    const year = String(option.year || '').trim();
    if (!year) {
      others.push(selectOption);
      return;
    }
    const group = yearGroups.get(year) || [];
    group.push(selectOption);
    yearGroups.set(year, group);
  });

  const sortedYears = Array.from(yearGroups.keys()).sort((a, b) => {
    const left = Number.parseInt(a, 10);
    const right = Number.parseInt(b, 10);
    const leftValid = Number.isFinite(left);
    const rightValid = Number.isFinite(right);
    if (leftValid && rightValid) {
      return right - left;
    }
    return b.localeCompare(a);
  });

  const grouped: SelectGroup[] = sortedYears.map((year) => ({
    label: t('driver.modal.version.group.year', { year }),
    options: yearGroups.get(year) || [],
  }));
  if (others.length > 0) {
    grouped.push({ label: t('driver.modal.version.group.other'), options: others });
  }
  return grouped;
};

const DriverManagerModal: React.FC<{ open: boolean; onClose: () => void; onBack?: () => void; onOpenGlobalProxySettings?: () => void; embedded?: boolean }> = ({
  open,
  onClose,
  onBack,
  onOpenGlobalProxySettings,
  embedded = false,
}) => {
  const theme = useStore((state) => state.theme);
  const appearance = useStore((state) => state.appearance);
  const languagePreference = useStore((state) => state.languagePreference);
  void languagePreference;
  const darkMode = theme === 'dark';
  const resolvedAppearance = resolveAppearanceValues(appearance);
  const opacity = normalizeOpacityForPlatform(resolvedAppearance.opacity);
  const driverManagerTheme = useMemo(
    () => buildDriverManagerWorkbenchTheme(darkMode, opacity),
    [darkMode, opacity, appearance.uiVersion],
  );
  const [loading, setLoading] = useState(() => open && !driverStatusSnapshots.getPreferred());
  const [downloadDir, setDownloadDir] = useState(() => driverStatusSnapshots.getPreferred()?.downloadDir || '');
  const [networkChecking, setNetworkChecking] = useState(() => open && !driverNetworkSnapshotCache);
  const [networkStatus, setNetworkStatus] = useState<DriverNetworkStatus | null>(() => driverNetworkSnapshotCache?.status || null);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [rows, setRows] = useState<DriverStatusRow[]>(() => driverStatusSnapshots.getPreferred()?.rows || []);
  const [actionState, setActionState] = useState<{ driverType: string; kind: DriverActionKind }>({ driverType: '', kind: '' });
  const [batchAction, setBatchAction] = useState<DriverBatchActionKind>('');
  const [batchProgress, setBatchProgress] = useState<DriverBatchProgressState | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, DriverProgressState>>({});
  const [operationLogMap, setOperationLogMap] = useState<Record<string, DriverLogEntry[]>>({});
  const [logDriverType, setLogDriverType] = useState('');
  const [logModalOpen, setLogModalOpen] = useState(false);
  const [batchDirectoryImporting, setBatchDirectoryImporting] = useState(false);
  const [forceOverwriteInstalled, setForceOverwriteInstalled] = useState(false);
  const [versionMap, setVersionMap] = useState<Record<string, DriverVersionOption[]>>({});
  const [selectedVersionMap, setSelectedVersionMap] = useState<Record<string, string>>({});
  const [versionLoadingMap, setVersionLoadingMap] = useState<Record<string, boolean>>({});
  const [versionSizeLoadingMap, setVersionSizeLoadingMap] = useState<Record<string, boolean>>({});
  const downloadDirRef = useRef(downloadDir);
  const progressMapRef = useRef<Record<string, DriverProgressState>>({});
  const progressTaskIdMapRef = useRef<Record<string, string>>({});
  const tasklessProgressOwnerRef = useRef('');
  const versionLoadPromiseMapRef = useRef<Record<string, Promise<DriverVersionOption[]>>>({});
  const statusRequestGenerationRef = useRef(0);
  const networkRequestGenerationRef = useRef(0);
  const batchBusy = batchDirectoryImporting || batchAction !== '';
  const installMutatingBusy = batchBusy || actionState.kind !== '';
  const hasActiveDriverDownload = useMemo(
    () => Object.values(progressMap).some(isDriverDownloadActive),
    [progressMap],
  );
  const driverMutationBusy = installMutatingBusy || hasActiveDriverDownload;
  // “后台运行” must only mean a task that the backend has already accepted and
  // can restore after this component unmounts. Version resolution still happens
  // in the UI before that point, so calling it background any earlier is false.
  const canRunDriverDownloadInBackground = hasActiveDriverDownload;

  useEffect(() => {
    downloadDirRef.current = downloadDir;
  }, [downloadDir]);

  useEffect(() => () => {
    statusRequestGenerationRef.current += 1;
    networkRequestGenerationRef.current += 1;
  }, []);

  const resolveDriverErrorMessage = useCallback((
    rawMessage: unknown,
    fallbackMessage: string,
    detailKey?: string,
    detailParams?: Record<string, unknown>,
    backendWrapperKeys?: string[],
  ): string => (
    resolveDriverErrorMessageText(
      rawMessage,
      fallbackMessage,
      detailKey,
      detailParams,
      backendWrapperKeys,
    )
  ), []);

  const updateDriverProgress = useCallback((
    driverType: string,
    incoming: DriverProgressState,
    options?: { resetPrevious?: boolean },
  ) => {
    const normalized = String(driverType || '').trim().toLowerCase();
    if (!normalized) {
      return undefined;
    }
    const previousProgress = options?.resetPrevious ? undefined : progressMapRef.current[normalized];
    const nextProgress = normalizeDriverProgressUpdate(previousProgress, incoming);
    progressMapRef.current = {
      ...progressMapRef.current,
      [normalized]: nextProgress,
    };
    setProgressMap(progressMapRef.current);
    return nextProgress;
  }, []);

  const clearDriverDownloadTaskId = useCallback((driverType: string) => {
    const normalized = String(driverType || '').trim().toLowerCase();
    if (!normalized) {
      return;
    }
    const nextTaskIds = { ...progressTaskIdMapRef.current };
    delete nextTaskIds[normalized];
    progressTaskIdMapRef.current = nextTaskIds;
  }, []);

  const clearDriverProgress = useCallback((driverType: string) => {
    const normalized = String(driverType || '').trim().toLowerCase();
    if (!normalized) {
      return;
    }
    const next = { ...progressMapRef.current };
    delete next[normalized];
    progressMapRef.current = next;
    clearDriverDownloadTaskId(normalized);
    setProgressMap(next);
  }, [clearDriverDownloadTaskId]);

  const modalBodyStyle = useMemo<React.CSSProperties>(() => ({
    maxHeight: 'calc(100vh - 220px)',
    overflowY: 'auto',
    overflowX: 'hidden',
    paddingRight: 18,
    background: driverManagerTheme.pageBg,
    color: driverManagerTheme.titleText,
  }), [driverManagerTheme]);

  const managerSectionStyle = useMemo<React.CSSProperties>(() => ({
    border: embedded ? 'none' : driverManagerTheme.sectionBorder,
    borderBottom: embedded ? driverManagerTheme.sectionBorder : undefined,
    borderRadius: embedded ? 0 : 8,
    background: embedded ? 'transparent' : driverManagerTheme.sectionBg,
  }), [driverManagerTheme, embedded]);

  const managerStatStyle = useMemo<React.CSSProperties>(() => ({
    border: embedded ? 'none' : driverManagerTheme.statBorder,
    borderRadius: embedded ? 0 : 8,
    background: embedded ? 'transparent' : driverManagerTheme.statBg,
  }), [driverManagerTheme, embedded]);

  const managerUpdateNoteStyle = useMemo<React.CSSProperties>(() => ({
    border: embedded ? 'none' : driverManagerTheme.updateNoteBorder,
    borderLeft: embedded ? driverManagerTheme.updateNoteBorder : undefined,
    borderRadius: embedded ? 0 : 8,
    background: embedded ? 'transparent' : driverManagerTheme.updateNoteBg,
  }), [driverManagerTheme, embedded]);

  const appendOperationLog = useCallback((
    driverType: string,
    text: string,
    signature?: string,
    mode: 'append' | 'update-last' = 'append',
  ) => {
    const normalized = String(driverType || '').trim().toLowerCase();
    const content = String(text || '').trim();
    if (!normalized || !content) {
      return;
    }
    const sign = String(signature || content).trim() || content;
    const now = new Date().toLocaleTimeString();
    setOperationLogMap((prev) => {
      const history = prev[normalized] || [];
      if (history.length > 0) {
        const last = history[history.length - 1];
        if (last.signature === sign) {
          if (mode === 'update-last') {
            if (last.text === content) {
              return prev;
            }
            const nextHistory = [...history];
            nextHistory[nextHistory.length - 1] = {
              ...last,
              text: content,
              time: now,
            };
            return { ...prev, [normalized]: nextHistory };
          }
          return prev;
        }
      }
      const nextHistory = [
        ...history,
        {
          time: now,
          text: content,
          signature: sign,
        },
      ];
      const sliced = nextHistory.length > 200 ? nextHistory.slice(nextHistory.length - 200) : nextHistory;
      return { ...prev, [normalized]: sliced };
    });
  }, []);

  const applyTaskScopedDriverProgress = useCallback((
    taskId: string,
    driverType: string,
    incoming: DriverProgressState,
  ): { applied: boolean; progress?: DriverProgressState } => {
    const normalizedDriverType = String(driverType || '').trim().toLowerCase();
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedDriverType || !normalizedTaskId) {
      return { applied: false };
    }

    const knownTaskId = progressTaskIdMapRef.current[normalizedDriverType];
    const previousProgress = progressMapRef.current[normalizedDriverType];
    if (knownTaskId === normalizedTaskId && isDriverDownloadTerminal(previousProgress)) {
      return { applied: false, progress: previousProgress };
    }
    if (knownTaskId === normalizedTaskId && previousProgress?.status === 'downloading' && incoming.status === 'start') {
      return { applied: false, progress: previousProgress };
    }

    let resetPrevious = false;
    if (knownTaskId && knownTaskId !== normalizedTaskId) {
      if (!isDriverDownloadTerminal(previousProgress)) {
        return { applied: false, progress: previousProgress };
      }
      resetPrevious = true;
    } else if (!knownTaskId && isDriverDownloadTerminal(previousProgress)) {
      resetPrevious = true;
    }

    progressTaskIdMapRef.current = {
      ...progressTaskIdMapRef.current,
      [normalizedDriverType]: normalizedTaskId,
    };
    const progress = updateDriverProgress(normalizedDriverType, incoming, { resetPrevious });
    return { applied: !!progress, progress };
  }, [updateDriverProgress]);

  const applyDriverDownloadTaskSnapshot = useCallback((task: DriverDownloadTaskSnapshot) => {
    const application = applyTaskScopedDriverProgress(task.taskId, task.driverType, {
      status: task.status,
      message: task.message || '',
      percent: task.percent,
    });
    if (!application.applied || !application.progress) {
      return false;
    }
    const nextProgress = application.progress;
    const statusText = String(nextProgress.status || '').toUpperCase();
    const messageText = nextProgress.message || '-';
    appendOperationLog(
      task.driverType,
      `[${statusText}] ${messageText} (${Math.round(nextProgress.percent)}%)`,
      `task:${task.taskId}:${statusText}:${messageText}`,
      'update-last',
    );
    return task.status === 'done' || task.status === 'error';
  }, [appendOperationLog, applyTaskScopedDriverProgress]);

  const refreshDriverDownloadTasks = useCallback(async (): Promise<boolean> => {
    try {
      const result = await ListDriverDownloadTasks();
      if (!result?.success) {
        return false;
      }
      const rawTasks: unknown[] = Array.isArray(result.data)
        ? result.data
        : (Array.isArray((result.data as any)?.tasks) ? (result.data as any).tasks : []);
      const tasks = rawTasks
        .map(normalizeDriverDownloadTaskSnapshot)
        .filter((task): task is DriverDownloadTaskSnapshot => !!task);
      let hasTerminalTask = false;
      tasks.forEach((task) => {
        hasTerminalTask = applyDriverDownloadTaskSnapshot(task) || hasTerminalTask;
      });
      return hasTerminalTask;
    } catch (error) {
      console.warn('Wails API: ListDriverDownloadTasks unavailable', error);
      return false;
    }
  }, [applyDriverDownloadTaskSnapshot]);

  const refreshStatus = useCallback(async (
    toastOnError = true,
    options?: { showLoading?: boolean },
  ) => {
    const requestGeneration = statusRequestGenerationRef.current + 1;
    statusRequestGenerationRef.current = requestGeneration;
    const snapshotIntentSequence = driverStatusSnapshotIntentSequence + 1;
    driverStatusSnapshotIntentSequence = snapshotIntentSequence;
    const requestedDownloadDir = downloadDirRef.current;
    const requestKey = driverStatusSnapshots.beginRequest(requestedDownloadDir, snapshotIntentSequence);
    const showLoading = options?.showLoading ?? true;
    if (showLoading) {
      setLoading(true);
    }
    try {
      const res = await requestDriverStatusShared(requestedDownloadDir);
      if (requestGeneration !== statusRequestGenerationRef.current) {
        return;
      }
      if (!res?.success) {
        if (toastOnError) {
          message.error(resolveDriverErrorMessage(res?.message, t('driver.modal.error.statusFetch'), 'driver.modal.error.statusFetchWithDetail'));
        }
        return;
      }

      const data = (res?.data || {}) as any;
      const resolvedDir = String(data.downloadDir || '').trim();
      const drivers = Array.isArray(data.drivers) ? data.drivers : [];

      const effectiveDownloadDir = resolvedDir || requestedDownloadDir;
      if (resolvedDir) {
        setDownloadDir(resolvedDir);
      }

      const nextRows: DriverStatusRow[] = drivers.map((item: any) => ({
        type: String(item.type || '').trim(),
        name: String(item.name || item.type || '').trim(),
        builtIn: !!item.builtIn,
        pinnedVersion: String(item.pinnedVersion || '').trim() || undefined,
        installedVersion: String(item.installedVersion || '').trim() || undefined,
        packageSizeText: String(item.packageSizeText || '').trim() || undefined,
        runtimeAvailable: !!item.runtimeAvailable,
        packageInstalled: !!item.packageInstalled,
        connectable: !!item.connectable,
        defaultDownloadUrl: String(item.defaultDownloadUrl || '').trim() || undefined,
        installDir: String(item.installDir || '').trim() || undefined,
        packagePath: String(item.packagePath || '').trim() || undefined,
        executablePath: String(item.executablePath || '').trim() || undefined,
        downloadedAt: String(item.downloadedAt || '').trim() || undefined,
        agentRevision: String(item.agentRevision || '').trim() || undefined,
        expectedRevision: String(item.expectedRevision || '').trim() || undefined,
        needsUpdate: !!item.needsUpdate,
        updateReason: String(item.updateReason || '').trim() || undefined,
        affectedConnections: Number.isFinite(Number(item.affectedConnections))
          ? Number(item.affectedConnections)
          : undefined,
        reasonCode: String(item.reasonCode || '').trim() || undefined,
        message: String(item.message || '').trim() || undefined,
      }));
      setRows(nextRows);
      const snapshot: DriverStatusSnapshotState<DriverStatusRow> = {
        rows: nextRows,
        downloadDir: effectiveDownloadDir,
        cachedAt: Date.now(),
        intentSequence: snapshotIntentSequence,
      };
      driverStatusSnapshots.write(requestKey, snapshot);
      const resolvedRequestKey = normalizeDriverStatusRequestKey(effectiveDownloadDir);
      if (resolvedRequestKey !== requestKey) {
        driverStatusSnapshots.write(resolvedRequestKey, snapshot);
      }
    } catch (err: any) {
      if (requestGeneration === statusRequestGenerationRef.current && toastOnError) {
        message.error(t('driver.modal.error.statusFetchWithDetail', { detail: err?.message || String(err) }));
      }
    } finally {
      settleLatestDriverRequest(requestGeneration, statusRequestGenerationRef.current, setLoading);
    }
  }, [resolveDriverErrorMessage]);

  const checkNetworkStatus = useCallback(async (
    toastOnError = false,
    options?: { showLoading?: boolean },
  ) => {
    const requestGeneration = networkRequestGenerationRef.current + 1;
    networkRequestGenerationRef.current = requestGeneration;
    const showLoading = options?.showLoading ?? true;
    if (showLoading) {
      setNetworkChecking(true);
    }
    try {
      const res = await requestDriverNetworkStatusShared();
      if (requestGeneration !== networkRequestGenerationRef.current) {
        return;
      }
      if (!res?.success) {
        if (toastOnError) {
          message.error(resolveDriverErrorMessage(res?.message, t('driver.modal.error.networkCheck'), 'driver.modal.error.networkCheckWithDetail'));
        }
        return;
      }
      const data = (res?.data || {}) as any;
      const checks = Array.isArray(data.checks) ? data.checks : [];
      const normalizedChecks: DriverNetworkProbe[] = checks.map((item: any) => ({
        probeCode: String(item.probeCode || '').trim() || undefined,
        name: String(item.name || '').trim(),
        url: String(item.url || '').trim(),
        reachable: !!item.reachable,
        httpStatus: parseOptionalLatency(item.httpStatus),
        latencyMs: parseOptionalLatency(item.latencyMs),
        tcpLatencyMs: parseOptionalLatency(item.tcpLatencyMs),
        httpLatencyMs: parseOptionalLatency(item.httpLatencyMs),
        method: String(item.method || '').trim().toUpperCase() || undefined,
        error: String(item.error || '').trim() || undefined,
      }));
      const nextStatusBase: DriverNetworkStatus = {
        reachable: !!data.reachable,
        summary: '',
        recommendedProxy: !!data.recommendedProxy,
        proxyConfigured: !!data.proxyConfigured,
        mirrorReachable: typeof data.mirrorReachable === 'boolean' ? data.mirrorReachable : undefined,
        fallbackChecked: typeof data.fallbackChecked === 'boolean' ? data.fallbackChecked : undefined,
        fallbackReachable: typeof data.fallbackReachable === 'boolean' ? data.fallbackReachable : undefined,
        usingFallback: typeof data.usingFallback === 'boolean'
          ? data.usingFallback
          : data.mirrorReachable === false && data.fallbackReachable === true,
        downloadChainReachable: typeof data.downloadChainReachable === 'boolean' ? data.downloadChainReachable : undefined,
        downloadRequiredHosts: Array.isArray(data.downloadRequiredHosts)
          ? data.downloadRequiredHosts.map((item: unknown) => String(item || '').trim()).filter(Boolean)
          : undefined,
        proxyEnv: (data.proxyEnv || {}) as Record<string, string>,
        checkedAt: String(data.checkedAt || '').trim() || undefined,
        checks: normalizedChecks,
        logPath: String(data.logPath || '').trim() || undefined,
      };
      const nextStatus: DriverNetworkStatus = {
        ...nextStatusBase,
        summary: String(data.summary || '').trim() || formatDriverNetworkSummary(nextStatusBase),
      };
      setNetworkStatus(nextStatus);
      driverNetworkSnapshotCache = {
        status: nextStatus,
        cachedAt: Date.now(),
      };
    } catch (err: any) {
      if (requestGeneration === networkRequestGenerationRef.current && toastOnError) {
        message.error(t('driver.modal.error.networkCheckWithDetail', { detail: err?.message || String(err) }));
      }
    } finally {
      settleLatestDriverRequest(requestGeneration, networkRequestGenerationRef.current, setNetworkChecking);
    }
  }, [resolveDriverErrorMessage]);

  const loadVersionOptions = useCallback(async (row: DriverStatusRow, toastOnError = false) => {
    if (row.builtIn) {
      return [] as DriverVersionOption[];
    }
    const driverType = String(row.type || '').trim();
    if (!driverType) {
      return [] as DriverVersionOption[];
    }
    const pendingRequest = versionLoadPromiseMapRef.current[driverType];
    if (pendingRequest) {
      return pendingRequest;
    }

    let settlePendingRequest!: (options: DriverVersionOption[]) => void;
    const request = new Promise<DriverVersionOption[]>((resolve) => {
      settlePendingRequest = resolve;
    });
    versionLoadPromiseMapRef.current[driverType] = request;
    let requestResult = buildFallbackVersionOptions(row);
    setVersionLoadingMap((prev) => ({ ...prev, [driverType]: true }));
    try {
      const res = await GetDriverVersionList(driverType, '');
      if (!res?.success) {
        if (toastOnError) {
          message.error(resolveDriverErrorMessage(res?.message, t('driver.modal.error.versionList', { name: row.name }), 'driver.modal.error.versionListLoad', { name: row.name }));
        }
        return requestResult;
      }
      const data = (res?.data || {}) as any;
      const rawVersions = Array.isArray(data.versions) ? data.versions : [];
      const normalizedOptions: DriverVersionOption[] = rawVersions
        .map((item: any) => {
          const version = String(item.version || '').trim();
          const downloadUrl = String(item.downloadUrl || '').trim();
          if (!version && !downloadUrl) {
            return null;
          }
          return {
            version,
            downloadUrl,
            packageSizeText: String(item.packageSizeText || '').trim() || undefined,
            recommended: !!item.recommended,
            source: String(item.source || '').trim() || undefined,
            year: String(item.year || '').trim() || undefined,
            displayLabel: String(item.displayLabel || '').trim() || undefined,
          } as DriverVersionOption;
        })
        .filter((item: DriverVersionOption | null): item is DriverVersionOption => !!item);

      const options = mergeFallbackVersionOptions(row, normalizedOptions);

      requestResult = options;
      setVersionMap((prev) => ({ ...prev, [driverType]: options }));
      setSelectedVersionMap((prev) => {
        const currentKey = prev[driverType];
        const preferred = resolvePreferredVersionOption(row, options, currentKey);
        if (!preferred) {
          return prev;
        }
        const preferredKey = buildVersionOptionKey(preferred);
        return currentKey === preferredKey
          ? prev
          : { ...prev, [driverType]: preferredKey };
      });
      return requestResult;
    } catch (err: any) {
      if (toastOnError) {
        message.error(t('driver.modal.error.versionListLoad', { name: row.name, detail: err?.message || String(err) }));
      }
      return requestResult;
    } finally {
      setVersionLoadingMap((prev) => ({ ...prev, [driverType]: false }));
      settlePendingRequest(requestResult);
      if (versionLoadPromiseMapRef.current[driverType] === request) {
        delete versionLoadPromiseMapRef.current[driverType];
      }
    }
  }, [resolveDriverErrorMessage]);

  const loadVersionPackageSize = useCallback(async (row: DriverStatusRow, optionKey: string) => {
    if (row.builtIn) {
      return;
    }
    const driverType = String(row.type || '').trim();
    if (!driverType || !optionKey) {
      return;
    }

    const options = versionMap[driverType] || [];
    const selectedOption = options.find((item) => buildVersionOptionKey(item) === optionKey);
    if (!selectedOption) {
      return;
    }
    if (String(selectedOption.packageSizeText || '').trim()) {
      return;
    }

    const versionText = String(selectedOption.version || '').trim();
    if (!versionText) {
      return;
    }

    const loadingKey = buildVersionSizeLoadingKey(driverType, optionKey);
    if (versionSizeLoadingMap[loadingKey]) {
      return;
    }

    setVersionSizeLoadingMap((prev) => ({ ...prev, [loadingKey]: true }));
    try {
      const res = await GetDriverVersionPackageSize(driverType, versionText);
      if (!res?.success) {
        return;
      }
      const data = (res?.data || {}) as any;
      const sizeText = String(data.packageSizeText || '').trim();
      if (!sizeText) {
        return;
      }

      setVersionMap((prev) => {
        const current = prev[driverType] || [];
        let changed = false;
        const next = current.map((item) => {
          if (buildVersionOptionKey(item) !== optionKey) {
            return item;
          }
          if (String(item.packageSizeText || '').trim() === sizeText) {
            return item;
          }
          changed = true;
          return { ...item, packageSizeText: sizeText };
        });
        if (!changed) {
          return prev;
        }
        return { ...prev, [driverType]: next };
      });
    } finally {
      setVersionSizeLoadingMap((prev) => {
        if (!prev[loadingKey]) {
          return prev;
        }
        const next = { ...prev };
        delete next[loadingKey];
        return next;
      });
    }
  }, [versionMap, versionSizeLoadingMap]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const cachedStatus = driverStatusSnapshots.getPreferred();
    const hasCachedStatus = !!cachedStatus;
    restoreDriverStatusSnapshot(cachedStatus, {
      setRows,
      setLoading,
      setDownloadDir: (nextDownloadDir) => {
        downloadDirRef.current = nextDownloadDir;
        setDownloadDir(nextDownloadDir);
      },
    });
    const shouldRefreshStatus = !cachedStatus || !isFreshCache(cachedStatus.cachedAt, DRIVER_STATUS_CACHE_TTL_MS);
    if (shouldRefreshStatus) {
      void refreshStatus(false, { showLoading: !hasCachedStatus });
    }

    const cachedNetwork = driverNetworkSnapshotCache;
    const hasCachedNetwork = !!cachedNetwork;
    restoreDriverNetworkSnapshot(cachedNetwork, {
      setStatus: setNetworkStatus,
      setLoading: setNetworkChecking,
    });
    const shouldRefreshNetwork = !cachedNetwork || !isFreshCache(cachedNetwork.cachedAt, DRIVER_NETWORK_CACHE_TTL_MS);
    if (shouldRefreshNetwork) {
      void checkNetworkStatus(false, { showLoading: !hasCachedNetwork });
    }
    void refreshDriverDownloadTasks().then((hasTerminalTask) => {
      if (hasTerminalTask) {
        void refreshStatus(false, { showLoading: false });
      }
    });
  }, [checkNetworkStatus, open, refreshDriverDownloadTasks, refreshStatus]);

  useEffect(() => {
    let off: (() => void) | undefined;
    try {
      off = EventsOn('driver:download-progress', (event: DriverProgressEvent) => {
        if (!event) {
          return;
        }
        const driverType = String(event.driverType || '').trim().toLowerCase();
        const status = event.status;
        if (!driverType || !status) {
          return;
        }
        const taskId = String(event.taskId || '').trim();
        if (!taskId && tasklessProgressOwnerRef.current !== driverType) {
          return;
        }
        const messageText = String(event.message || '').trim();
        const percent = Math.max(0, Math.min(100, Number(event.percent || 0)));
        const incomingProgress: DriverProgressState = {
          status,
          message: messageText,
          percent,
        };
        const application = taskId
          ? applyTaskScopedDriverProgress(taskId, driverType, incomingProgress)
          : { applied: true, progress: updateDriverProgress(driverType, incomingProgress) };
        if (!application.applied || !application.progress) {
          return;
        }
        const nextProgress = application.progress;
        const progressText = `${Math.round(nextProgress.percent)}%`;
        const statusText = String(nextProgress.status || '').toUpperCase();
        const logMessageText = nextProgress.message || '-';
        const lineText = `[${statusText}] ${logMessageText} (${progressText})`;
        const lineSignature = `event:${String(event.taskId || '').trim()}:${statusText}:${logMessageText}`;
        appendOperationLog(driverType, lineText, lineSignature, 'update-last');
        if (nextProgress.status === 'done') {
          void refreshStatus(false, { showLoading: false });
        }
      });

      // The modal-open effect also hydrates tasks, but reconcile once more only
      // after this listener exists. That closes the tiny event-replay window
      // where a task completes between the first snapshot and subscription.
      if (open) {
        void refreshDriverDownloadTasks().then((hasTerminalTask) => {
          if (hasTerminalTask) {
            void refreshStatus(false, { showLoading: false });
          }
        });
      }
    } catch (error) {
      console.warn('Wails API: EventsOn unavailable', error);
    }
    return () => {
      if (off) {
        off();
      }
    };
  }, [appendOperationLog, applyTaskScopedDriverProgress, open, refreshDriverDownloadTasks, refreshStatus, updateDriverProgress]);

  const resolveLocalImportVersion = useCallback((row: DriverStatusRow) => {
    const loadedOptions = versionMap[row.type] || [];
    const options = loadedOptions.length > 0 ? loadedOptions : buildFallbackVersionOptions(row);
    const selectedOption = resolvePreferredVersionOption(row, options, selectedVersionMap[row.type]);
    return selectedOption?.version || row.pinnedVersion || '';
  }, [selectedVersionMap, versionMap]);

  const resolveSelectedVersionOption = useCallback((row: DriverStatusRow) => {
    const options = versionMap[row.type] || [];
    const selectedKey = selectedVersionMap[row.type];
    return (
      options.find((item) => buildVersionOptionKey(item) === selectedKey) ||
      options.find((item) => item.recommended) ||
      options[0]
    );
  }, [selectedVersionMap, versionMap]);

  const resolveInstalledDriverVersion = useCallback((row: DriverStatusRow) => (
    String(row.installedVersion || '').trim() || String(row.pinnedVersion || '').trim()
  ), []);

  const isDriverVersionSwitchPending = useCallback((row: DriverStatusRow) => {
    if (row.builtIn || (!row.packageInstalled && !row.connectable)) {
      return false;
    }
    const selectedVersion = String(resolveSelectedVersionOption(row)?.version || '').trim();
    const installedVersion = resolveInstalledDriverVersion(row);
    return !!selectedVersion && !!installedVersion && selectedVersion !== installedVersion;
  }, [resolveInstalledDriverVersion, resolveSelectedVersionOption]);

  const installDriver = useCallback(async (
    row: DriverStatusRow,
    actionOptions?: { silentToast?: boolean; skipRefresh?: boolean; runInline?: boolean },
  ) => {
    const normalizedDriverType = String(row.type || '').trim().toLowerCase();
    let ownsTasklessProgress = false;
    setActionState({ driverType: row.type, kind: 'install' });
    clearDriverDownloadTaskId(row.type);
    updateDriverProgress(row.type, {
      status: 'start',
      message: t('driver.modal.progress.install.start'),
      percent: 0,
    });
    appendOperationLog(row.type, t('driver.modal.operationLog.autoInstall.start'));
    try {
      let versionOptions = versionMap[row.type] || [];
      if (versionOptions.length === 0) {
        versionOptions = await loadVersionOptions(row, true);
      }
      const fallbackOptions = buildFallbackVersionOptions(row);
      const fallbackSelectedKey = fallbackOptions[0]
        ? buildVersionOptionKey(fallbackOptions[0])
        : undefined;
      const selectedOption = resolvePreferredVersionOption(
        row,
        versionOptions,
        selectedVersionMap[row.type] || fallbackSelectedKey,
      );
      const selectedVersion = selectedOption?.version || row.pinnedVersion || '';
      const selectedDownloadURL = selectedOption?.downloadUrl || row.defaultDownloadUrl || '';
      const runInline = actionOptions?.runInline === true;
      if (runInline) {
        tasklessProgressOwnerRef.current = normalizedDriverType;
        ownsTasklessProgress = true;
      }
      const result = runInline
        ? await DownloadDriverPackage(row.type, selectedVersion, selectedDownloadURL, downloadDir)
        : await StartDriverPackageDownload(row.type, selectedVersion, selectedDownloadURL, downloadDir);
      if (!result?.success) {
        const errText = resolveDriverErrorMessage(
          result?.message,
          t('driver.modal.error.installDriver', { name: row.name }),
          undefined,
          { name: row.name },
          [
            'driver_manager.backend.message.download_failed_detail',
            'driver_manager.backend.message.metadata_write_failed_detail',
          ],
        );
        appendOperationLog(row.type, `[ERROR] ${errText}`);
        updateDriverProgress(row.type, {
          status: 'error',
          message: errText,
          percent: 0,
        });
        if (!actionOptions?.silentToast) {
          message.error(errText);
        }
        return false;
      }

      if (!runInline) {
        const task = normalizeDriverDownloadTaskSnapshot((result.data as any)?.task);
        if (task) {
          applyDriverDownloadTaskSnapshot(task);
          if (task.driverType !== String(row.type || '').trim().toLowerCase()) {
            // The backend serializes driver installs because they share a
            // process-wide download directory. Do not leave a phantom local
            // task behind when another manager instance already owns it.
            clearDriverProgress(row.type);
          }
        }
        return true;
      }

      const versionTip = formatDriverVersionTip(selectedVersion);
      const logVersionTip = formatDriverLogVersionTip(selectedVersion);
      appendOperationLog(row.type, t('driver.modal.operationLog.autoInstall.done', { version: logVersionTip }));
      updateDriverProgress(row.type, {
        status: 'done',
        message: t('driver.modal.operationLog.autoInstall.done', { version: logVersionTip }),
        percent: 100,
      });
      if (!actionOptions?.silentToast) {
        message.success(t('driver.modal.success.installDriver', { name: row.name, version: versionTip }));
      }
      if (!actionOptions?.skipRefresh) {
        await refreshStatus(false);
      }
      return true;
    } catch (error) {
      const errText = error instanceof Error
        ? error.message
        : String(error || t('driver_manager.message.install_failed_fallback', { name: row.name }));
      appendOperationLog(row.type, `[ERROR] ${errText}`);
      updateDriverProgress(row.type, {
        status: 'error',
        message: errText,
        percent: 0,
      });
      if (!actionOptions?.silentToast) {
        message.error(errText);
      }
      return false;
    } finally {
      if (ownsTasklessProgress && tasklessProgressOwnerRef.current === normalizedDriverType) {
        tasklessProgressOwnerRef.current = '';
      }
      setActionState({ driverType: '', kind: '' });
    }
  }, [appendOperationLog, applyDriverDownloadTaskSnapshot, clearDriverDownloadTaskId, clearDriverProgress, downloadDir, loadVersionOptions, refreshStatus, resolveDriverErrorMessage, selectedVersionMap, updateDriverProgress, versionMap]);

  const installDriverFromLocalPath = useCallback(async (
    row: DriverStatusRow,
    sourcePath: string,
    sourceLabel: DriverLocalSourceCode,
    options?: { silentToast?: boolean; skipRefresh?: boolean },
  ) => {
    const pathText = String(sourcePath || '').trim();
    const localizedSourceLabel = resolveDriverLocalSourceLabel(sourceLabel);
    if (!pathText) {
      if (!options?.silentToast) {
        message.error(t('driver.modal.error.invalidLocalImport', { source: localizedSourceLabel }));
      }
      return false;
    }

    const normalizedDriverType = String(row.type || '').trim().toLowerCase();
    tasklessProgressOwnerRef.current = normalizedDriverType;
    setActionState({ driverType: row.type, kind: 'local' });
    clearDriverDownloadTaskId(row.type);
    updateDriverProgress(row.type, {
      status: 'start',
      message: t('driver.modal.progress.localImport.start'),
      percent: 0,
    });
    const selectedVersion = resolveLocalImportVersion(row);
    const versionTip = formatDriverVersionTip(selectedVersion);
    const logVersionTip = formatDriverLogVersionTip(selectedVersion);
    appendOperationLog(row.type, t('driver.modal.operationLog.localImport.start', {
      version: logVersionTip,
      source: localizedSourceLabel,
      path: pathText,
    }));
    try {
      const result = await InstallLocalDriverPackage(row.type, pathText, downloadDir, selectedVersion);
      if (!result?.success) {
        const errText = resolveDriverErrorMessage(
          result?.message,
          t('driver.modal.error.localImportDriver', { name: row.name }),
          undefined,
          { name: row.name },
          [
            'driver_manager.backend.message.local_import_failed_detail',
            'driver_manager.backend.message.metadata_write_failed_detail',
          ],
        );
        appendOperationLog(row.type, `[ERROR] ${errText}`);
        updateDriverProgress(row.type, {
          status: 'error',
          message: errText,
          percent: 0,
        });
        if (!options?.silentToast) {
          message.error(errText);
        }
        return false;
      }
      appendOperationLog(row.type, t('driver.modal.operationLog.localImport.done', { version: logVersionTip }));
      if (!options?.silentToast) {
        message.success(t('driver.modal.success.localImportDriver', { name: row.name, version: versionTip }));
      }
      if (!options?.skipRefresh) {
        await refreshStatus(false);
      }
      return true;
    } finally {
      if (tasklessProgressOwnerRef.current === normalizedDriverType) {
        tasklessProgressOwnerRef.current = '';
      }
      setActionState({ driverType: '', kind: '' });
    }
  }, [appendOperationLog, clearDriverDownloadTaskId, downloadDir, refreshStatus, resolveDriverErrorMessage, resolveLocalImportVersion, updateDriverProgress]);

  const installDriverFromLocalFile = useCallback(async (row: DriverStatusRow) => {
    const fileRes = await SelectDriverPackageFile(downloadDir);
    if (!fileRes?.success) {
      if (!isBackendCancelledResult(fileRes)) {
        message.error(resolveDriverErrorMessage(fileRes?.message, t('driver.modal.error.selectPackageFile')));
      }
      return;
    }
    const filePath = String((fileRes?.data as any)?.path || '').trim();
    if (!filePath) {
      message.error(t('driver.modal.error.invalidPackageFile'));
      return;
    }
    await installDriverFromLocalPath(row, filePath, 'file');
  }, [downloadDir, installDriverFromLocalPath, resolveDriverErrorMessage]);

  const installDriversFromDirectory = useCallback(async () => {
    const directoryRes = await SelectDriverPackageDirectory(downloadDir);
    if (!directoryRes?.success) {
      if (!isBackendCancelledResult(directoryRes)) {
        message.error(resolveDriverErrorMessage(directoryRes?.message, t('driver.modal.error.selectPackageDirectory')));
      }
      return;
    }

    const directoryPath = String((directoryRes?.data as any)?.path || '').trim();
    if (!directoryPath) {
      message.error(t('driver.modal.error.invalidPackageDirectory'));
      return;
    }
    const optionalRows = rows.filter((item) => !item.builtIn);
    if (optionalRows.length === 0) {
      message.info(t('driver.modal.info.noImportableDrivers'));
      return;
    }

    let successCount = 0;
    let failCount = 0;
    let dedupeSkipCount = 0;
    let slimSkipCount = 0;

    setBatchDirectoryImporting(true);
    try {
      for (const row of optionalRows) {
        const alreadyInstalled = row.packageInstalled || row.connectable;
        if (alreadyInstalled && !forceOverwriteInstalled) {
          dedupeSkipCount += 1;
          appendOperationLog(row.type, t('driver.modal.operationLog.directoryImport.skipInstalled'));
          continue;
        }
        if (alreadyInstalled && forceOverwriteInstalled) {
          appendOperationLog(row.type, t('driver.modal.operationLog.directoryImport.forceOverwrite'));
        }
        if (isSlimBuildInstallUnavailable(row)) {
          slimSkipCount += 1;
          appendOperationLog(row.type, t('driver.modal.operationLog.directoryImport.slimSkipped'));
          continue;
        }
        const ok = await installDriverFromLocalPath(row, directoryPath, 'directory', { silentToast: true, skipRefresh: true });
        if (ok) {
          successCount += 1;
        } else {
          failCount += 1;
        }
      }
      await refreshStatus(false);
    } finally {
      setBatchDirectoryImporting(false);
    }

    const skipTip = formatDriverBatchSkipSummary(dedupeSkipCount, slimSkipCount);

    const forceTip = forceOverwriteInstalled ? t('driver.modal.batch.forceOverwriteTip') : '';
    if (failCount === 0) {
      message.success(t('driver.modal.batch.directoryImport.success', { force: forceTip, success: successCount, skip: skipTip }));
      return;
    }
    if (successCount > 0) {
      message.warning(t('driver.modal.batch.directoryImport.partial', { force: forceTip, success: successCount, failed: failCount, skip: skipTip }));
      return;
    }
    message.error(t('driver.modal.batch.directoryImport.failed', { force: forceTip, failed: failCount, skip: skipTip }));
  }, [appendOperationLog, downloadDir, forceOverwriteInstalled, installDriverFromLocalPath, refreshStatus, resolveDriverErrorMessage, rows]);

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

  const openDriverLog = useCallback((driverType: string) => {
    const normalized = String(driverType || '').trim().toLowerCase();
    if (!normalized) {
      return;
    }
    setLogDriverType(normalized);
    setLogModalOpen(true);
  }, []);

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
        await refreshStatus(false);
      }
      return true;
    } finally {
      setActionState({ driverType: '', kind: '' });
    }
  }, [appendOperationLog, clearDriverProgress, downloadDir, refreshStatus, resolveDriverErrorMessage]);

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
    if (progress && (progress.status === 'start' || progress.status === 'downloading')) {
      return <Tag color="processing">{t('driver.modal.card.installing', { percent: Math.round(progress.percent) })}</Tag>;
    }
    if (row.needsUpdate) {
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

  const resolveDriverProgress = (row: DriverStatusRow) => {
    const progress = progressMap[row.type];
    let percent = 0;
    let status: 'normal' | 'exception' | 'active' | 'success' = 'normal';

    if (progress?.status === 'error') {
      percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
      status = 'exception';
    } else if (progress && (progress.status === 'start' || progress.status === 'downloading')) {
      percent = Math.max(1, Math.min(99, Math.round(progress.percent || 0)));
      status = 'active';
    } else if (progress?.status === 'done') {
      percent = 100;
      status = 'success';
    } else if (row.connectable || row.packageInstalled) {
      percent = 100;
      status = 'success';
    }

    return { percent, status };
  };

  const renderVersionControl = (row: DriverStatusRow) => {
    if (row.builtIn) {
      return <Text type="secondary">{t('driver.modal.card.noInstallNeeded')}</Text>;
    }

    const loadedOptions = versionMap[row.type] || [];
    const options = loadedOptions.length > 0 ? loadedOptions : buildFallbackVersionOptions(row);
    const preferredOption = resolvePreferredVersionOption(row, options, selectedVersionMap[row.type]);
    const selectedKey = preferredOption ? buildVersionOptionKey(preferredOption) : undefined;
    const selectOptions = buildVersionSelectOptions(options);
    const installedVersion = resolveInstalledDriverVersion(row);
    const versionSwitchPending = isDriverVersionSwitchPending(row);
    const selectedOption = resolveSelectedVersionOption(row);
    const selectedOptionFromKey = selectedKey
      ? options.find((item) => buildVersionOptionKey(item) === selectedKey)
      : undefined;
    const selectedVersionMatchesInstalled = !!installedVersion
      && String(selectedOptionFromKey?.version || '').trim() === installedVersion;
    const showInstalledVersion = !!installedVersion && !selectedVersionMatchesInstalled;
    const mongoHint = row.type === 'mongodb'
      ? t('driver.modal.card.mongodbVersionHint')
      : '';
    const versionSummaryId = `driver-manager-${row.type}-version-summary`;
    const versionHintId = `driver-manager-${row.type}-version-hint`;
    const versionDescription = [
      (row.packageInstalled || row.connectable) ? versionSummaryId : '',
      mongoHint ? versionHintId : '',
    ].filter(Boolean).join(' ');
    return (
      <div className="driver-manager-version-control">
        <Select
          size="small"
          style={{ width: '100%' }}
          loading={!!versionLoadingMap[row.type]}
          disabled={driverMutationBusy || actionState.driverType === row.type}
          placeholder={options.length > 0 ? t('driver.modal.card.versionPlaceholder.select') : t('driver.modal.card.versionPlaceholder.load')}
          value={selectedKey}
          options={selectOptions as any}
          aria-describedby={versionDescription || undefined}
          onOpenChange={(open) => {
            if (open && loadedOptions.length === 0 && !versionLoadingMap[row.type]) {
              void loadVersionOptions(row, true);
              return;
            }
            if (open && selectedKey) {
              void loadVersionPackageSize(row, selectedKey);
            }
          }}
          onChange={(value) => {
            setSelectedVersionMap((prev) => ({ ...prev, [row.type]: value }));
            void loadVersionPackageSize(row, value);
          }}
        />
        {(row.packageInstalled || row.connectable) ? (
          <Text id={versionSummaryId} type="secondary" className="driver-manager-small-text driver-manager-version-summary">
            {versionSwitchPending
              ? t('driver_manager.version.switch_pending', {
                installedVersion: installedVersion || t('driver_manager.version.current_fallback'),
                targetVersion: selectedOption?.version || t('driver_manager.version.target_fallback'),
              })
              : t(
                showInstalledVersion
                  ? 'driver_manager.version.installed_with_version'
                  : 'driver_manager.version.installed',
                {
                  version: installedVersion,
                  suffix: row.needsUpdate ? t('driver_manager.version.needs_reinstall_suffix') : '',
                },
              )}
          </Text>
        ) : null}
        {mongoHint ? <Text id={versionHintId} type="secondary" className="driver-manager-small-text">{mongoHint}</Text> : null}
      </div>
    );
  };

  const renderDriverActions = (row: DriverStatusRow) => {
    if (row.builtIn) {
      return null;
    }
    const isSlimBuildUnavailable = isSlimBuildInstallUnavailable(row);
    const loadingInstallOrRemove =
      actionState.driverType === row.type && (actionState.kind === 'install' || actionState.kind === 'remove');
    const loadingLocal = actionState.driverType === row.type && actionState.kind === 'local';
    const logs = operationLogMap[row.type] || [];
    const hasLogs = logs.length > 0;
    const versionSwitchPending = isDriverVersionSwitchPending(row);

    if (isSlimBuildUnavailable && !row.packageInstalled) {
      return <Text type="secondary">{t('driver.modal.card.fullOnly')}</Text>;
    }

    const mainAction = row.needsUpdate ? (
      <Button size={embedded ? 'small' : undefined} type="primary" icon={<DownloadOutlined />} disabled={driverMutationBusy} loading={loadingInstallOrRemove} onClick={() => installDriver(row)}>
        {t('driver.modal.card.action.reinstall')}
      </Button>
    ) : versionSwitchPending ? (
      <Button size={embedded ? 'small' : undefined} type="primary" icon={<DownloadOutlined />} disabled={driverMutationBusy} loading={loadingInstallOrRemove} onClick={() => installDriver(row)}>
        {t('driver_manager.action.switch_version')}
      </Button>
    ) : row.connectable ? (
      <Button size={embedded ? 'small' : undefined} danger icon={<DeleteOutlined />} disabled={driverMutationBusy} loading={loadingInstallOrRemove} onClick={() => removeDriver(row)}>
        {t('driver.modal.card.action.remove')}
      </Button>
    ) : (
      <Button size={embedded ? 'small' : undefined} type="primary" icon={<DownloadOutlined />} disabled={driverMutationBusy} loading={loadingInstallOrRemove} onClick={() => installDriver(row)}>
        {t('driver.modal.card.action.install')}
      </Button>
    );

    return (
      <Space size={8} wrap className="driver-manager-card-actions">
        {mainAction}
        <Button size={embedded ? 'small' : undefined} icon={<FileSearchOutlined />} disabled={driverMutationBusy} loading={loadingLocal} onClick={() => installDriverFromLocalFile(row)}>
          {getDriverLocalImportButtonLabel()}
        </Button>
        <Button size={embedded ? 'small' : undefined} type={hasLogs ? 'default' : 'text'} disabled={!hasLogs} onClick={() => openDriverLog(row.type)}>
          {t('driver_manager.action.logs')}
        </Button>
      </Space>
    );
  };

  const activeLogRow = useMemo(() => {
    if (!logDriverType) {
      return undefined;
    }
    return rows.find((item) => item.type === logDriverType);
  }, [logDriverType, rows]);
  const normalizedSearchKeyword = useMemo(() => normalizeDriverSearchText(searchKeyword), [searchKeyword]);
  const filteredRows = useMemo(() => {
    if (!normalizedSearchKeyword) {
      return rows;
    }
    return rows.filter((row) => {
      const searchableParts = [
        row.name,
        row.type,
        row.pinnedVersion,
        row.installedVersion,
        formatDriverCardStatusMessage(row),
        row.builtIn ? t('driver.modal.search.builtIn') : t('driver.modal.search.external'),
        row.needsUpdate
          ? t('driver.modal.search.reinstallRecommended')
          : row.connectable
            ? t('driver.modal.card.enabled')
            : row.packageInstalled
              ? t('driver.modal.card.installed')
              : t('driver.modal.card.notEnabled'),
      ];
      const searchableText = normalizeDriverSearchText(searchableParts.filter(Boolean).join(' '));
      return searchableText.includes(normalizedSearchKeyword);
    });
  }, [normalizedSearchKeyword, rows]);
  const filterSummaryText = useMemo(() => {
    if (normalizedSearchKeyword) {
      return t('driver.modal.summary.match', { matched: filteredRows.length, total: rows.length });
    }
    return t('driver.modal.summary.total', { count: rows.length });
  }, [filteredRows.length, normalizedSearchKeyword, rows.length]);
  const initialStatusLoading = loading && rows.length === 0;
  const statusSummary = useMemo(() => {
    const optionalRows = rows.filter((row) => !row.builtIn);
    return {
      total: rows.length,
      enabled: optionalRows.filter((row) => row.connectable).length,
      needsUpdate: optionalRows.filter((row) => row.needsUpdate).length,
      notEnabled: optionalRows.filter((row) => !row.connectable && !row.packageInstalled).length,
    };
  }, [rows]);
  const reinstallableRows = useMemo(() => rows.filter((row) => !row.builtIn && row.needsUpdate), [rows]);
  const installableRows = useMemo(
    () => rows.filter((row) => !row.builtIn && !row.connectable),
    [rows],
  );
  const removableRows = useMemo(
    () => rows.filter((row) => !row.builtIn && (row.connectable || row.packageInstalled)),
    [rows],
  );
  const batchProgressPercent = useMemo(() => {
    if (!batchProgress || batchProgress.total <= 0) {
      return 0;
    }
    const currentProgress = batchProgress.currentDriverType
      ? progressMap[batchProgress.currentDriverType]
      : undefined;
    const shouldUseCurrentProgress = batchAction === 'install-all' || batchAction === 'reinstall-updates';
    const currentContribution = shouldUseCurrentProgress && currentProgress && currentProgress.status !== 'error'
      ? Math.max(0, Math.min(100, Number(currentProgress.percent || 0))) / 100
      : 0;
    const completed = Math.max(0, Math.min(batchProgress.completed, batchProgress.total));
    const percent = ((completed + currentContribution) / batchProgress.total) * 100;
    return Math.max(0, Math.min(100, Math.round(percent)));
  }, [batchAction, batchProgress, progressMap]);
  const activeBatchDriverProgress = (batchAction === 'install-all' || batchAction === 'reinstall-updates') && batchProgress?.currentDriverType
    ? progressMap[batchProgress.currentDriverType]
    : undefined;
  const batchProgressMessage = activeBatchDriverProgress?.message || batchProgress?.currentMessage || '';

  const runBatchInstall = useCallback(async (
    targetRows: DriverStatusRow[],
    actionKind: DriverBatchActionKind,
    emptyMessage: string,
    successLabel: string,
  ) => {
    if (targetRows.length === 0) {
      message.info(emptyMessage);
      return;
    }

    setBatchAction(actionKind);
    setBatchProgress(createDriverBatchProgress(targetRows.length, t('driver.modal.batch.prepare', { action: successLabel })));
    let successCount = 0;
    let failCount = 0;
    let slimSkipCount = 0;
    try {
      for (const row of targetRows) {
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
        const ok = await installDriver(row, { silentToast: true, skipRefresh: true, runInline: true });
        if (ok) {
          successCount += 1;
          await refreshStatus(false, { showLoading: false });
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
              : t('driver.modal.batch.driverFailed', { name: row.name }),
          };
        });
      }
      await refreshStatus(false);
    } finally {
      setBatchAction('');
      setBatchProgress(null);
    }

    const skipTip = formatDriverBatchSkipSummary(0, slimSkipCount);
    if (failCount === 0) {
      message.success(t('driver.modal.batch.actionResult.success', { action: successLabel, success: successCount, skip: skipTip }));
      return;
    }
    if (successCount > 0) {
      message.warning(t('driver.modal.batch.actionResult.partial', { action: successLabel, success: successCount, failed: failCount, skip: skipTip }));
      return;
    }
    message.error(t('driver.modal.batch.actionResult.failed', { action: successLabel, failed: failCount, skip: skipTip }));
  }, [appendOperationLog, installDriver, refreshStatus]);

  const reinstallNeededDrivers = useCallback(async () => {
    await runBatchInstall(
      reinstallableRows,
      'reinstall-updates',
      t('driver.modal.info.noReinstallableDrivers'),
      t('driver.modal.batch.action.reinstallUpdates'),
    );
  }, [reinstallableRows, runBatchInstall]);

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
        setBatchAction('remove-all');
        setBatchProgress(createDriverBatchProgress(removableRows.length, t('driver.modal.batch.prepareRemoveAll')));
        let successCount = 0;
        let failCount = 0;
        try {
          for (const row of removableRows) {
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
              await refreshStatus(false, { showLoading: false });
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
          await refreshStatus(false);
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

  const renderDriverCard = (row: DriverStatusRow) => {
    const progressState = progressMap[row.type];
    const progress = resolveDriverProgress(row);
    const statusMessage = formatDriverCardStatusMessage(row);
    const affectedText = row.affectedConnections && row.affectedConnections > 0
      ? t('driver.modal.card.affectedConnections', { count: row.affectedConnections })
      : '';

    return (
      <div
        key={row.type}
        className={[
          'driver-manager-card',
          row.needsUpdate ? 'driver-manager-card-warning' : '',
          row.connectable ? 'driver-manager-card-ready' : '',
        ].filter(Boolean).join(' ')}
        style={embedded ? {
          border: 'none',
          borderBottom: driverManagerTheme.cardBorder,
          background: 'transparent',
        } : {
          border: row.needsUpdate
            ? driverManagerTheme.cardWarningBorder
            : (row.connectable ? driverManagerTheme.cardReadyBorder : driverManagerTheme.cardBorder),
          background: driverManagerTheme.cardBg,
        }}
      >
        <div className="driver-manager-card-main">
          <div className="driver-manager-card-info">
            <div className="driver-manager-title-row">
              <Text strong className="driver-manager-driver-name">{row.name}</Text>
              {resolveDriverStatusTag(row)}
            </div>
            <div className="driver-manager-meta-row">
              <Text type="secondary">{t('driver.modal.card.packageSize', { size: resolvePackageSizeText(row) })}</Text>
              <Text type="secondary">{t('driver.modal.card.version', { version: row.installedVersion || row.pinnedVersion || '-' })}</Text>
              {affectedText ? <Text type="secondary">{affectedText}</Text> : null}
            </div>
            {row.needsUpdate && statusMessage ? (
              <div className="driver-manager-update-note" style={managerUpdateNoteStyle}>
                <Paragraph
                  className="driver-manager-note-text"
                  ellipsis={{ rows: 2, expandable: true, symbol: t('driver.modal.card.expandReason') }}
                >
                  {statusMessage}
                </Paragraph>
              </div>
            ) : statusMessage ? (
              <Paragraph
                className="driver-manager-muted-message"
                type="secondary"
                ellipsis={{ rows: 2, expandable: true, symbol: t('driver.modal.card.expand') }}
              >
                {statusMessage}
              </Paragraph>
            ) : null}
          </div>

          <div className="driver-manager-card-controls">
            <div className="driver-manager-control-block driver-manager-version-block">
              <Text type="secondary" className="driver-manager-control-label">{t('driver.modal.card.versionLabel')}</Text>
              {renderVersionControl(row)}
            </div>
            {!row.builtIn && progressState ? (
              <div className="driver-manager-control-block driver-manager-progress-block">
                <div className="driver-manager-progress-header">
                  <Text type="secondary" className="driver-manager-control-label">{t('driver.modal.card.progressLabel')}</Text>
                  <Text
                    type={progress.status === 'exception' ? 'danger' : 'secondary'}
                    className="driver-manager-progress-value"
                  >
                    {Math.round(progress.percent)}%
                  </Text>
                </div>
                <Progress
                  className="driver-manager-progress"
                  percent={progress.percent}
                  status={progress.status}
                  showInfo={false}
                  size="small"
                />
                {progressState.status === 'error' && progressState.message ? (
                  <Paragraph
                    className="driver-manager-progress-error"
                    type="danger"
                    role="alert"
                    ellipsis={{ rows: 2, expandable: true, symbol: t('driver.modal.card.expand') }}
                    style={{ marginBottom: 0 }}
                  >
                    {progressState.message}
                  </Paragraph>
                ) : null}
              </div>
            ) : null}
            {renderDriverActions(row)}
          </div>
        </div>
      </div>
    );
  };

  const activeDriverLogs = operationLogMap[logDriverType] || [];
  const activeDriverLogLines = activeDriverLogs.map((item) => `[${item.time}] ${item.text}`);
  const proxyEnvEntries = Object.entries(networkStatus?.proxyEnv || {});
  const downloadRequiredHosts = (networkStatus?.downloadRequiredHosts || []).filter(Boolean);
  const showDownloadChainAlert = networkStatus?.downloadChainReachable === false;
  const networkUnreachable = networkStatus?.reachable === false;
  const usingFallback = networkStatus?.usingFallback === true
    || (networkStatus?.mirrorReachable === false && networkStatus?.fallbackReachable === true);
  const listSeparator = t('driver_manager.punctuation.list_separator');
  const downloadRequiredHostText = (downloadRequiredHosts.length > 0
    ? downloadRequiredHosts
    : [
        'download.syngnat.top',
        'github.com',
        'api.github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com',
        'proxy.golang.org',
      ]).join(listSeparator);
  const networkSummaryText = networkStatus ? formatDriverNetworkSummary(networkStatus) : '';
  const logBlockBackground = darkMode
    ? `rgba(28, 28, 28, ${Math.max(opacity, 0.82)})`
    : `rgba(255, 255, 255, ${Math.max(opacity, 0.92)})`;
  const logBlockBorderColor = darkMode ? 'rgba(255, 255, 255, 0.16)' : 'rgba(0, 0, 0, 0.12)';
  const logBlockTextColor = darkMode ? 'rgba(255, 255, 255, 0.88)' : 'rgba(0, 0, 0, 0.88)';

  const driverManagerContent = (
    <>
      <div
        className={embedded ? 'driver-manager-embedded-layout' : undefined}
        style={embedded ? undefined : { display: 'contents' }}
      >
        <div className={`driver-manager-shell${embedded ? ' is-embedded' : ''}`} data-driver-theme={driverManagerTheme.isDark ? 'dark' : 'light'}>
        <div className="driver-manager-header" style={managerSectionStyle}>
          <div className="driver-manager-heading">
            <Text type="secondary">{t('driver.modal.header.description.install')}</Text>
            <Text type="secondary">{t('driver.modal.header.description.agent')}</Text>
          </div>
          <div className="driver-manager-stats">
            <div className="driver-manager-stat" style={managerStatStyle}>
              <span>{initialStatusLoading ? '—' : statusSummary.total}</span>
              <Text type="secondary">{t('driver.modal.stats.total')}</Text>
            </div>
            <div className="driver-manager-stat" style={managerStatStyle}>
              <span>{initialStatusLoading ? '—' : statusSummary.enabled}</span>
              <Text type="secondary">{t('driver.modal.stats.enabled')}</Text>
            </div>
            <div className="driver-manager-stat driver-manager-stat-warning" style={managerStatStyle}>
              <span style={{ color: driverManagerTheme.warningText }}>{initialStatusLoading ? '—' : statusSummary.needsUpdate}</span>
              <Text type="secondary">{t('driver.modal.stats.needsUpdate')}</Text>
            </div>
            <div className="driver-manager-stat" style={managerStatStyle}>
              <span>{initialStatusLoading ? '—' : statusSummary.notEnabled}</span>
              <Text type="secondary">{t('driver.modal.stats.notEnabled')}</Text>
            </div>
          </div>
        </div>

        <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {networkStatus ? (
          networkUnreachable ? (
            <Alert
              type="error"
              showIcon
              message={showDownloadChainAlert
                ? t('driver_manager.network.alert.download_chain_unreachable')
                : t('driver_manager.network.alert.download_network_unreachable')}
              description={(
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  {showDownloadChainAlert ? (
                    <>
                      <Text>{t('driver_manager.network.chain_alert.description')}</Text>
                      {onOpenGlobalProxySettings ? (
                        <Button size="small" onClick={onOpenGlobalProxySettings}>{t('driver_manager.action.open_global_proxy_settings')}</Button>
                      ) : null}
                      <Text>{t('driver_manager.network.chain_alert.allow_hosts', { hosts: downloadRequiredHostText })}</Text>
                    </>
                  ) : (
                    <Text>{networkSummaryText}</Text>
                  )}
                  {proxyEnvEntries.length > 0 ? (
                    <Text type="secondary">
                      {t('driver_manager.network.proxy_env_detected', { keys: proxyEnvEntries.map(([key]) => key).join(listSeparator) })}
                    </Text>
                  ) : null}
                </Space>
              )}
            />
          ) : (
            <Alert
              type={usingFallback ? 'warning' : 'success'}
              showIcon
              message={networkSummaryText}
              description={(
                <Collapse
                  size="small"
                  items={[
                    {
                      key: 'checks',
                      label: t('driver_manager.network.details_label'),
                      children: (
                        <Space direction="vertical" size={4} style={{ width: '100%' }}>
                          {(networkStatus?.checks || []).length > 0
                            ? (networkStatus?.checks || []).map((probe, index) => {
                                const latency = probe.httpLatencyMs ?? probe.latencyMs ?? probe.tcpLatencyMs;
                                return (
                                  <Text key={`${probe.probeCode || probe.url || 'probe'}-${index}`} type="secondary">
                                    {t('driver_manager.network.probe_latency', {
                                      name: resolveDriverNetworkProbeLabel(probe),
                                      status: probe.reachable
                                        ? t('driver_manager.network.reachable')
                                        : t('driver_manager.network.unreachable'),
                                      latency: latency !== undefined
                                        ? t('driver_manager.network.latency_value', { latency })
                                        : '',
                                      detail: probe.error
                                        ? t('driver_manager.network.error_value', { detail: probe.error })
                                        : '',
                                    })}
                                  </Text>
                                );
                              })
                            : <Text type="secondary">{t('driver_manager.network.no_result')}</Text>}
                          {proxyEnvEntries.length > 0 ? (
                            <Text type="secondary">
                              {t('driver_manager.network.proxy_env_detected', { keys: proxyEnvEntries.map(([key]) => key).join(listSeparator) })}
                            </Text>
                          ) : (
                            <Text type="secondary">{t('driver_manager.network.no_proxy_env')}</Text>
                          )}
                        </Space>
                      ),
                    },
                  ]}
                />
              )}
            />
          )
        ) : (
          <Alert
            type="info"
            showIcon
            icon={sharedInfoAlertIcon}
            message={networkChecking ? t('driver_manager.network.checking') : t('driver_manager.network.not_checked')}
          />
        )}

        <div className="driver-manager-directory-panel" style={managerSectionStyle}>
          <Collapse
            size="small"
            ghost
            items={[
              {
                key: 'driver-directory',
                label: t('driver_manager.directory_info.title'),
                children: (
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <Text type="secondary">{t('driver_manager.directory_info.reuse_help')}</Text>
                    <Text type="secondary">{getDriverLocalImportDirectoryHelp()}</Text>
                    <Text type="secondary">{getDriverLocalImportSingleFileHelp()}</Text>
                    <Paragraph copyable={{ text: downloadDir || '-' }} style={{ marginBottom: 0 }}>
                      {t('driver_manager.directory_info.root_dir', { path: downloadDir || '-' })}
                    </Paragraph>
                    {networkStatus?.logPath ? (
                      <Paragraph copyable={{ text: networkStatus.logPath }} style={{ marginBottom: 0 }}>
                        {t('driver_manager.directory_info.log_file', { path: networkStatus.logPath })}
                      </Paragraph>
                    ) : null}
                  </Space>
                ),
              },
            ]}
          />
        </div>

        <div className="driver-manager-toolbar">
          <Input.Search
            allowClear
            placeholder={t('driver.modal.toolbar.searchPlaceholder')}
            value={searchKeyword}
            onChange={(event) => setSearchKeyword(event.target.value)}
            className="driver-manager-search"
          />
          <Space size={8} wrap className="driver-manager-toolbar-actions">
            <Text type="secondary">{t('driver.modal.toolbar.forceOverwrite')}</Text>
            <Switch
              checked={forceOverwriteInstalled}
              onChange={(checked) => setForceOverwriteInstalled(checked)}
              disabled={batchDirectoryImporting}
            />
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              disabled={driverMutationBusy || installableRows.length === 0}
              loading={batchAction === 'install-all'}
              onClick={() => void installAllDrivers()}
            >
              {t('driver.modal.toolbar.installAll')}
            </Button>
            <Button
              type={embedded ? 'default' : 'primary'}
              icon={<DownloadOutlined />}
              disabled={driverMutationBusy || reinstallableRows.length === 0}
              loading={batchAction === 'reinstall-updates'}
              onClick={() => void reinstallNeededDrivers()}
            >
              {t('driver.modal.toolbar.reinstallUpdates')}
            </Button>
            <Button
              danger
              icon={<DeleteOutlined />}
              disabled={driverMutationBusy || removableRows.length === 0}
              loading={batchAction === 'remove-all'}
              onClick={() => void removeAllDrivers()}
            >
              {t('driver.modal.toolbar.removeAll')}
            </Button>
            <Button
              icon={<FolderOpenOutlined />}
              onClick={() => void openDriverDirectory()}
            >
              {t('driver.modal.toolbar.openDirectory')}
            </Button>
            <Button
              icon={<FolderOpenOutlined />}
              loading={batchDirectoryImporting}
              disabled={batchDirectoryImporting}
              onClick={() => void installDriversFromDirectory()}
            >
              {t('driver.modal.toolbar.importDirectory')}
            </Button>
          </Space>
        </div>
        {batchProgress ? (
          <div className="driver-manager-batch-progress-panel" style={managerSectionStyle}>
            <div className="driver-manager-batch-progress-header">
              <Text strong>{resolveDriverBatchActionLabel(batchAction)}</Text>
              <Text type="secondary">{batchProgressMessage || t('driver.modal.batch.running')}</Text>
            </div>
            <Progress percent={batchProgressPercent} status="active" />
            <div className="driver-manager-batch-progress-meta">
              <Text type="secondary">{t('driver.modal.batch.processed', { completed: batchProgress.completed, total: batchProgress.total })}</Text>
              <Text type="secondary">{t('driver.modal.batch.success', { count: batchProgress.success })}</Text>
              {batchProgress.failed > 0 ? <Text type="danger">{t('driver.modal.batch.failed', { count: batchProgress.failed })}</Text> : null}
              {batchProgress.skipped > 0 ? <Text type="secondary">{t('driver.modal.batch.skipped', { count: batchProgress.skipped })}</Text> : null}
              {batchProgress.currentDriverName ? <Text type="secondary">{t('driver.modal.batch.current', { name: batchProgress.currentDriverName })}</Text> : null}
            </div>
          </div>
        ) : null}
        <div className="driver-manager-list-head">
          {!initialStatusLoading ? <Text type="secondary">{filterSummaryText}</Text> : null}
          {loading ? <Text type="secondary">{t('driver.modal.status.refreshing')}</Text> : null}
        </div>

        <div className="driver-manager-list" aria-busy={initialStatusLoading}>
          {initialStatusLoading ? null : filteredRows.length > 0 ? (
            filteredRows.map(renderDriverCard)
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={normalizedSearchKeyword
                ? t('driver.modal.empty.noMatch', { keyword: String(searchKeyword || '').trim() })
                : t('driver.modal.empty.noData')}
            />
          )}
        </div>
        </Space>
        </div>
        {embedded ? (
          <Space className="driver-manager-footer-actions" size={8} wrap style={{ justifyContent: 'flex-end', width: '100%' }}>
            {onBack ? (
              <Button key="back" onClick={onBack}>
                {t('common.back_to_settings')}
              </Button>
            ) : null}
            <Button key="refresh" icon={<ReloadOutlined />} onClick={() => refreshStatus(true)} loading={loading}>
              {t('driver.modal.footer.refresh')}
            </Button>
            <Button key="network" onClick={() => checkNetworkStatus(true)} loading={networkChecking}>
              {t('driver.modal.footer.networkCheck')}
            </Button>
            <Button key="close" type="primary" onClick={onClose}>
              {canRunDriverDownloadInBackground ? t('driver.modal.footer.background') : t('driver.modal.footer.close')}
            </Button>
          </Space>
        ) : null}
      </div>
      <Modal
        title={t('driver_manager.log_modal.title', { name: activeLogRow?.name || logDriverType })}
        open={logModalOpen}
        onCancel={() => setLogModalOpen(false)}
        footer={[
          <Button key="close-log" type="primary" onClick={() => setLogModalOpen(false)}>
            {t('common.action.close')}
          </Button>,
        ]}
        width={780}
      >
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {activeLogRow?.installDir ? (
            <Paragraph copyable={{ text: activeLogRow.installDir }} style={{ marginBottom: 0 }}>
              {t('driver_manager.log_modal.install_dir', { path: activeLogRow.installDir })}
            </Paragraph>
          ) : null}
          {activeLogRow?.executablePath ? (
            <Paragraph copyable={{ text: activeLogRow.executablePath }} style={{ marginBottom: 0 }}>
              {t('driver_manager.log_modal.executable_path', { path: activeLogRow.executablePath })}
            </Paragraph>
          ) : null}
          {activeDriverLogLines.length > 0 ? (
            <pre style={{ margin: 0, maxHeight: 360, overflow: 'auto', padding: 12, background: logBlockBackground, color: logBlockTextColor, borderRadius: 8, border: `1px solid ${logBlockBorderColor}`, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'var(--gn-font-mono)' }}>
              {activeDriverLogLines.join('\n')}
            </pre>
          ) : (
            <Text type="secondary">{t('driver_manager.log_modal.empty')}</Text>
          )}
        </Space>
      </Modal>
    </>
  );

  return embedded ? driverManagerContent : (
      <Modal
      title={(
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span>{t('driver.modal.title')}</span>
        </div>
      )}
      open={open}
      onCancel={onClose}
      width={1120}
      style={{ top: 24 }}
      className="driver-manager-modal"
      styles={{
        body: modalBodyStyle,
      }}
      destroyOnHidden
      footer={(
        <Space className="driver-manager-footer-actions" size={8}>
          <Button key="refresh" icon={<ReloadOutlined />} onClick={() => refreshStatus(true)} loading={loading}>
            {t('driver.modal.footer.refresh')}
          </Button>
          <Button key="network" onClick={() => checkNetworkStatus(true)} loading={networkChecking}>
            {t('driver.modal.footer.networkCheck')}
          </Button>
          <Button key="close" type="primary" onClick={onClose}>
            {canRunDriverDownloadInBackground ? t('driver.modal.footer.background') : t('driver.modal.footer.close')}
          </Button>
          {onBack ? (
            <Button key="back" onClick={onBack}>
              {t('common.back_to_previous')}
            </Button>
          ) : null}
        </Space>
      )}
    >
      {driverManagerContent}
    </Modal>
  );
};

export default DriverManagerModal;
