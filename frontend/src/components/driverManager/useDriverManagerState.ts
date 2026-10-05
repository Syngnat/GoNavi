import { useStore } from '../../store';
import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { buildDriverManagerWorkbenchTheme } from '../../utils/driverManagerWorkbenchTheme';
import { driverStatusSnapshots, driverNetworkSnapshotCache } from './driverManagerStatusCache';
import type {
  DriverNetworkStatus,
  DriverStatusRow,
  DriverActionKind,
  DriverBatchActionKind,
  DriverBatchProgressState,
  DriverLogEntry,
  DriverVersionOption,
  DriverListSortKey,
} from './driverManagerModel';
import {
  type DriverProgressState,
  normalizeDriverProgressUpdate,
} from '../../utils/driverProgress';
import { readOptionalUpdateDismissedRevisions } from './driverOptionalUpdate';
import {
  type DriverNetworkNoticeKind,
  readDismissedDriverNetworkNotices,
} from './driverNetworkNoticeState';
import {
  createDriverDownloadCancelIntents,
  isDriverDownloadActive,
  shouldIgnoreDriverDownloadProgress,
} from './driverDownloadCancellation';
import { resolveDriverErrorMessageText } from './driverManagerMessages';
import type { DriverManagerModalProps } from '../DriverManagerModal';

export interface UseDriverManagerStateInput {
  open: DriverManagerModalProps['open'];
}

export const useDriverManagerState = ({ open }: UseDriverManagerStateInput) => {
  const theme = useStore((state) => state.theme);
  const languagePreference = useStore((state) => state.languagePreference);
  void languagePreference;
  const darkMode = theme === 'dark';
  const driverManagerTheme = useMemo(
    () => buildDriverManagerWorkbenchTheme(darkMode),
    [darkMode],
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
  const [batchDirectoryImporting, setBatchDirectoryImporting] = useState(false);
  const [versionMap, setVersionMap] = useState<Record<string, DriverVersionOption[]>>({});
  const [selectedVersionMap, setSelectedVersionMap] = useState<Record<string, string>>({});
  const [versionLoadingMap, setVersionLoadingMap] = useState<Record<string, boolean>>({});
  const [versionSizeLoadingMap, setVersionSizeLoadingMap] = useState<Record<string, boolean>>({});
  const [optionalUpdateDismissedRevisions, setOptionalUpdateDismissedRevisions] = useState<string[]>(() => readOptionalUpdateDismissedRevisions());
  // 已关闭的网络提示条（持久化）。见 driverNetworkNoticeState.ts。
  const [dismissedNetworkNotices, setDismissedNetworkNotices] = useState<DriverNetworkNoticeKind[]>(
    () => readDismissedDriverNetworkNotices(),
  );
  const [driverFilter, setDriverFilter] = useState<'all' | 'needsUpdate' | 'enabled' | 'notEnabled'>('all');
  const [driverSortKey, setDriverSortKey] = useState<DriverListSortKey>('name');
  const [selectedDriverType, setSelectedDriverType] = useState('');
  const downloadDirRef = useRef(downloadDir);
  const progressMapRef = useRef<Record<string, DriverProgressState>>({});
  const progressTaskIdMapRef = useRef<Record<string, string>>({});
  const tasklessProgressOwnerRef = useRef('');
  const cancelIntentsRef = useRef(createDriverDownloadCancelIntents());
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
    if (shouldIgnoreDriverDownloadProgress(incoming.status, cancelIntentsRef.current.isRequested(normalized))) {
      return previousProgress;
    }
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
  }), []);
  return {
    darkMode,
    driverManagerTheme,
    loading,
    setLoading,
    downloadDir,
    setDownloadDir,
    networkChecking,
    setNetworkChecking,
    networkStatus,
    setNetworkStatus,
    searchKeyword,
    setSearchKeyword,
    rows,
    setRows,
    actionState,
    setActionState,
    batchAction,
    setBatchAction,
    batchProgress,
    setBatchProgress,
    progressMap,
    operationLogMap,
    setOperationLogMap,
    batchDirectoryImporting,
    setBatchDirectoryImporting,
    versionMap,
    setVersionMap,
    selectedVersionMap,
    setSelectedVersionMap,
    versionLoadingMap,
    setVersionLoadingMap,
    versionSizeLoadingMap,
    setVersionSizeLoadingMap,
    optionalUpdateDismissedRevisions,
    setOptionalUpdateDismissedRevisions,
    dismissedNetworkNotices,
    setDismissedNetworkNotices,
    driverFilter,
    setDriverFilter,
    driverSortKey,
    setDriverSortKey,
    selectedDriverType,
    setSelectedDriverType,
    downloadDirRef,
    progressMapRef,
    progressTaskIdMapRef,
    tasklessProgressOwnerRef,
    cancelIntentsRef,
    versionLoadPromiseMapRef,
    statusRequestGenerationRef,
    networkRequestGenerationRef,
    batchBusy,
    driverMutationBusy,
    canRunDriverDownloadInBackground,
    resolveDriverErrorMessage,
    updateDriverProgress,
    clearDriverDownloadTaskId,
    clearDriverProgress,
    modalBodyStyle,
  };
};

export type DriverManagerStateApi = ReturnType<typeof useDriverManagerState>;
