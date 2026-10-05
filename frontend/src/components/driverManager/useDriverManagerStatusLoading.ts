import { useCallback, useEffect } from 'react';
import {
  driverStatusSnapshotIntentSequence,
  setDriverStatusSnapshotIntentSequence,
  driverStatusSnapshots,
  requestDriverStatusShared,
  requestDriverNetworkStatusShared,
  setDriverNetworkSnapshotCache,
  isFreshCache,
  driverNetworkSnapshotCache,
} from './driverManagerStatusCache';
import { message } from 'antd';
import { t } from '../../i18n';
import {
  type DriverStatusRow,
  type DriverNetworkProbe,
  parseOptionalLatency,
  type DriverNetworkStatus,
  type DriverVersionOption,
  buildFallbackVersionOptions,
  mergeFallbackVersionOptions,
  resolvePreferredVersionOption,
  buildVersionOptionKey,
  buildVersionSizeLoadingKey,
  type DriverProgressEvent,
} from './driverManagerModel';
import {
  type DriverStatusSnapshot as DriverStatusSnapshotState,
  normalizeDriverStatusRequestKey,
  settleLatestDriverRequest,
  restoreDriverStatusSnapshot,
  restoreDriverNetworkSnapshot,
} from '../../utils/driverManagerRequestState';
import {
  formatDriverNetworkSummary,
  DRIVER_STATUS_CACHE_TTL_MS,
  DRIVER_NETWORK_CACHE_TTL_MS,
} from './driverManagerMessages';
import { GetDriverVersionList, GetDriverVersionPackageSize } from '../../../wailsjs/go/app/App';
import { EventsOn } from '../../../wailsjs/runtime/runtime';
import { shouldIgnoreDriverDownloadProgress } from './driverDownloadCancellation';
import type { DriverProgressState } from '../../utils/driverProgress';
import type { DriverManagerStateApi } from './useDriverManagerState';
import type { DriverManagerProgressApi } from './useDriverManagerProgress';
import type { DriverManagerModalProps } from '../DriverManagerModal';

export interface UseDriverManagerStatusLoadingInput {
  statusRequestGenerationRef: DriverManagerStateApi['statusRequestGenerationRef'];
  downloadDirRef: DriverManagerStateApi['downloadDirRef'];
  setLoading: DriverManagerStateApi['setLoading'];
  resolveDriverErrorMessage: DriverManagerStateApi['resolveDriverErrorMessage'];
  setDownloadDir: DriverManagerStateApi['setDownloadDir'];
  setRows: DriverManagerStateApi['setRows'];
  networkRequestGenerationRef: DriverManagerStateApi['networkRequestGenerationRef'];
  setNetworkChecking: DriverManagerStateApi['setNetworkChecking'];
  setNetworkStatus: DriverManagerStateApi['setNetworkStatus'];
  versionLoadPromiseMapRef: DriverManagerStateApi['versionLoadPromiseMapRef'];
  setVersionLoadingMap: DriverManagerStateApi['setVersionLoadingMap'];
  setVersionMap: DriverManagerStateApi['setVersionMap'];
  setSelectedVersionMap: DriverManagerStateApi['setSelectedVersionMap'];
  versionMap: DriverManagerStateApi['versionMap'];
  versionSizeLoadingMap: DriverManagerStateApi['versionSizeLoadingMap'];
  setVersionSizeLoadingMap: DriverManagerStateApi['setVersionSizeLoadingMap'];
  open: DriverManagerModalProps['open'];
  refreshDriverDownloadTasks: DriverManagerProgressApi['refreshDriverDownloadTasks'];
  cancelIntentsRef: DriverManagerStateApi['cancelIntentsRef'];
  tasklessProgressOwnerRef: DriverManagerStateApi['tasklessProgressOwnerRef'];
  applyTaskScopedDriverProgress: DriverManagerProgressApi['applyTaskScopedDriverProgress'];
  updateDriverProgress: DriverManagerStateApi['updateDriverProgress'];
  appendOperationLog: DriverManagerProgressApi['appendOperationLog'];
}

export const useDriverManagerStatusLoading = ({
  statusRequestGenerationRef,
  downloadDirRef,
  setLoading,
  resolveDriverErrorMessage,
  setDownloadDir,
  setRows,
  networkRequestGenerationRef,
  setNetworkChecking,
  setNetworkStatus,
  versionLoadPromiseMapRef,
  setVersionLoadingMap,
  setVersionMap,
  setSelectedVersionMap,
  versionMap,
  versionSizeLoadingMap,
  setVersionSizeLoadingMap,
  open,
  refreshDriverDownloadTasks,
  cancelIntentsRef,
  tasklessProgressOwnerRef,
  applyTaskScopedDriverProgress,
  updateDriverProgress,
  appendOperationLog,
}: UseDriverManagerStatusLoadingInput) => {
  const refreshStatus = useCallback(async (
    toastOnError = true,
    options?: { showLoading?: boolean; fresh?: boolean },
  ) => {
    const requestGeneration = statusRequestGenerationRef.current + 1;
    statusRequestGenerationRef.current = requestGeneration;
    const snapshotIntentSequence = driverStatusSnapshotIntentSequence + 1;
    setDriverStatusSnapshotIntentSequence(snapshotIntentSequence);
    const requestedDownloadDir = downloadDirRef.current;
    const requestKey = driverStatusSnapshots.beginRequest(requestedDownloadDir, snapshotIntentSequence);
    const showLoading = options?.showLoading ?? true;
    if (showLoading) {
      setLoading(true);
    }
    try {
      const res = await requestDriverStatusShared(requestedDownloadDir, { fresh: options?.fresh });
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

      // 内置驱动无需安装/更新/移除，不进入管理列表。
      const nextRows: DriverStatusRow[] = drivers
        .filter((item: any) => !item.builtIn)
        .map((item: any) => ({
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
        optionalUpdate: !!item.optionalUpdate && !item.needsUpdate,
        updateReason: String(item.updateReason || '').trim() || undefined,
        affectedConnections: Number.isFinite(Number(item.affectedConnections))
          ? Number(item.affectedConnections)
          : undefined,
        activeConnections: Number.isFinite(Number(item.activeConnections))
          ? Number(item.activeConnections)
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
      setDriverNetworkSnapshotCache({
        status: nextStatus,
        cachedAt: Date.now(),
      });
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
        if (shouldIgnoreDriverDownloadProgress(status, cancelIntentsRef.current.isRequested(driverType))) {
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
        const statusText = String(nextProgress.status || '').toUpperCase();
        const logMessageText = nextProgress.message || '-';
        appendOperationLog(
          driverType,
          logMessageText,
          `driver-progress:${statusText}:${logMessageText}`,
          'update-last',
        );
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
  return {
    refreshStatus,
    checkNetworkStatus,
    loadVersionOptions,
    loadVersionPackageSize,
  };
};

export type DriverManagerStatusLoadingApi = ReturnType<typeof useDriverManagerStatusLoading>;
