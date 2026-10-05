import React, { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { Form, message } from 'antd';
import { v4 as uuidv4 } from 'uuid';
import { useStore } from '../../../store';
import { useOptionalI18n } from '../../../i18n/provider';
import { type I18nParams, t } from '../../../i18n';
import {
  resolveAppearanceValues,
  normalizeBlurForPlatform,
  isMacLikePlatform,
} from '../../../utils/appearance';
import { buildRedisWorkbenchTheme } from '../../redisViewerWorkbenchTheme';
import { isConnectionDataImportRestricted } from '../../../utils/connectionReadOnly';
import {
  type NacosConfigItem,
  type NacosConfigDetail,
  type NacosHistoryItem,
  resolveEditorLanguage,
  type NacosConfigPage,
} from '../nacosViewerModel';
import { useNacosConfigPinning } from '../../nacos/NacosConfigPinning';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import {
  buildNacosImportSelectionRows,
  selectedNacosConfigItems,
  reconcileNacosConfigSelection,
} from '../../nacosConfigSelection';
import type { NacosViewerProps } from '../nacosViewerModel';

export interface UseNacosViewerStateInput {
  connectionId: NacosViewerProps['connectionId'];
  namespaceId: NacosViewerProps['namespaceId'];
  initialGroup: NacosViewerProps['initialGroup'];
}

export const useNacosViewerState = ({ connectionId, namespaceId, initialGroup }: UseNacosViewerStateInput) => {
  const connections = useStore((state) => state.connections);
  const appTheme = useStore((state) => state.theme);
  const appearance = useStore((state) => state.appearance);
  const i18n = useOptionalI18n();
  const i18nLanguage = i18n?.language;
  const tr = useCallback(
    (key: string, params?: I18nParams) => t(key, params, i18nLanguage),
    [i18nLanguage],
  );

  const darkMode = appTheme === 'dark';

  const resolvedAppearance = resolveAppearanceValues(appearance);
  const blur = normalizeBlurForPlatform(resolvedAppearance.blur);
  const workbenchTheme = useMemo(
    () => buildRedisWorkbenchTheme({
      darkMode,
      blur,
      disableBackdropFilter: isMacLikePlatform(),
    }),
    [blur, darkMode],
  );
  // v1 keeps raised cards; v2 is flat (same as Redis gn-v2-redis-workbench CSS).
  const workbenchCardStyle = useMemo(() => (
    {
          background: 'transparent',
          border: 'none',
          boxShadow: 'none',
          borderRadius: 0,
        }
  ), [workbenchTheme]);

  const connection = connections.find((item) => item.id === connectionId);
  const connectionProtection = connection?.config?.protection;
  const readOnly = !!connection?.config?.readOnly
    || connectionProtection?.restrictDataEdit === true;
  const importRestricted = readOnly
    || connectionProtection?.restrictDataImport === true
    || isConnectionDataImportRestricted(connection?.config);

  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [items, setItems] = useState<NacosConfigItem[]>([]);
  const pinnedItems = useNacosConfigPinning(items, connectionId, namespaceId);
  const [totalCount, setTotalCount] = useState(0);
  const [pageNo, setPageNo] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [filterDataId, setFilterDataId] = useState('');
  const [filterGroup, setFilterGroup] = useState(String(initialGroup || '').trim());
  // Suggestion catalogs for AutoComplete (dropdown + free-text fuzzy).
  const [groupSuggestions, setGroupSuggestions] = useState<string[]>([]);
  const [dataIdSuggestions, setDataIdSuggestions] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Measured scroll body height so the list fills the pane (no 100vh gap).
  const [listScrollY, setListScrollY] = useState(360);
  const listBodyRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<NacosConfigDetail | null>(null);
  const [draftContent, setDraftContent] = useState('');
  const [draftType, setDraftType] = useState('text');
  const [draftDirty, setDraftDirty] = useState(false);
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [newForm] = Form.useForm();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyItems, setHistoryItems] = useState<NacosHistoryItem[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPageNo, setHistoryPageNo] = useState(1);
  const [historyDetailOpen, setHistoryDetailOpen] = useState(false);
  const [historyDetail, setHistoryDetail] = useState<NacosHistoryItem | null>(null);
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false);
  const historyDataId = historyDetail?.dataId || detail?.dataId || '';
  const historyType = detail?.dataId === historyDataId ? detail?.type : '';
  const historyEditorLanguage = resolveEditorLanguage(historyType) === 'plaintext'
    ? resolveEditorLanguage(historyDataId.split('.').pop())
    : resolveEditorLanguage(historyType);
  const [rollingBack, setRollingBack] = useState(false);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [listenActive, setListenActive] = useState(false);
  const [publishMode, setPublishMode] = useState<'formal' | 'beta'>('formal');
  const [betaIps, setBetaIps] = useState('');
  const [betaExists, setBetaExists] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<any>(null);
  const [importConflictMode, setImportConflictMode] = useState<'skip' | 'overwrite'>('skip');
  const [importSelectedKeys, setImportSelectedKeys] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  // Left list pane width; drag divider to adjust (same pattern as Redis).
  const [leftPanelWidth, setLeftPanelWidth] = useState<number | string>('42%');
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const watchIdRef = useRef<string | null>(null);
  const detailRef = useRef<NacosConfigDetail | null>(null);
  const draftDirtyRef = useRef(false);
  const selectionGenerationRef = useRef(0);
  const listenGenerationRef = useRef(0);
  const mountedRef = useRef(true);

  const rpcConfig = useMemo(() => {
    if (!connection?.config) return null;
    return buildRpcConnectionConfig(connection.config as any);
  }, [connection?.config]);
  const selectionContextRef = useRef({
    connectionId,
    namespaceId,
    rpcConfig,
  });
  selectionContextRef.current = {
    connectionId,
    namespaceId,
    rpcConfig,
  };

  const selectedRowKey = selectedKey;
  const importSelectionRows = useMemo(
    () =>
      buildNacosImportSelectionRows(
        Array.isArray(importPreview?.items) ? importPreview.items : [],
      ),
    [importPreview],
  );
  const selectedItems = useMemo(
    () => selectedNacosConfigItems(items, selectedRowKeys),
    [items, selectedRowKeys],
  );
  const selectedCount = selectedItems.length;
  const allPageSelected = items.length > 0 && selectedCount === items.length;
  const pageSelectionIndeterminate = selectedCount > 0 && !allPageSelected;

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);
  useEffect(() => {
    draftDirtyRef.current = draftDirty;
  }, [draftDirty]);

  const stopWatch = useCallback(async (watchId: string | null) => {
    if (!watchId) return;
    try {
      await (window as any).go.app.App.NacosStopConfigListen(watchId);
    } catch {
      // Stopping a listener is best-effort during selection changes/unmount.
    }
  }, []);

  const stopListen = useCallback(async () => {
    listenGenerationRef.current += 1;
    const watchId = watchIdRef.current;
    watchIdRef.current = null;
    if (mountedRef.current) {
      setListenActive(false);
    }
    await stopWatch(watchId);
  }, [stopWatch]);

  const startListen = useCallback(
    async (target: NacosConfigDetail, selectionGeneration: number) => {
      if (!rpcConfig) return;
      const listenGeneration = ++listenGenerationRef.current;
      const previousWatchId = watchIdRef.current;
      watchIdRef.current = null;
      if (mountedRef.current) {
        setListenActive(false);
        setRemoteChanged(false);
      }
      await stopWatch(previousWatchId);
      const isCurrentListen = () => {
        const currentContext = selectionContextRef.current;
        return (
          mountedRef.current &&
          listenGenerationRef.current === listenGeneration &&
          selectionGenerationRef.current === selectionGeneration &&
          currentContext.connectionId === connectionId &&
          currentContext.namespaceId === namespaceId &&
          currentContext.rpcConfig === rpcConfig
        );
      };
      if (!isCurrentListen()) return;
      const contentMd5 = String(target.md5 || '').trim();
      const pendingWatchId = `nacos-${uuidv4()}`;
      watchIdRef.current = pendingWatchId;
      try {
        const res = await (window as any).go.app.App.NacosStartConfigListen(rpcConfig, {
          watchId: pendingWatchId,
          connectionId,
          namespaceId: namespaceId || '',
          dataId: target.dataId,
          group: target.group,
          contentMd5,
        });
        if (!res?.success) {
          if (isCurrentListen()) {
            if (watchIdRef.current === pendingWatchId) {
              watchIdRef.current = null;
            }
            setListenActive(false);
          }
          return;
        }
        const nextWatchId = String(res?.data?.watchId || '').trim();
        if (!isCurrentListen()) {
          await stopWatch(nextWatchId || null);
          return;
        }
        watchIdRef.current = nextWatchId || null;
        setListenActive(!!nextWatchId);
      } catch {
        if (isCurrentListen()) {
          if (watchIdRef.current === pendingWatchId) {
            watchIdRef.current = null;
          }
          setListenActive(false);
        }
      }
    },
    [rpcConfig, connectionId, namespaceId, stopWatch],
  );

  const mergeUniqueStrings = useCallback((prev: string[], next: string[]) => {
    if (!next.length) return prev;
    const set = new Set(prev);
    let changed = false;
    for (const raw of next) {
      const value = String(raw || '').trim();
      if (!value || set.has(value)) continue;
      set.add(value);
      changed = true;
    }
    return changed ? Array.from(set).sort((a, b) => a.localeCompare(b)) : prev;
  }, []);

  const loadFilterSuggestions = useCallback(async () => {
    if (!rpcConfig) return;
    try {
      const [groupsRes, configsRes] = await Promise.all([
        (window as any).go.app.App.NacosListConfigGroups(rpcConfig, namespaceId || ''),
        (window as any).go.app.App.NacosSearchConfigs(rpcConfig, {
          namespaceId: namespaceId || '',
          dataId: '',
          // Prefer current group filter when loading DataId options so suggestions stay relevant.
          group: String(initialGroup || filterGroup || '').trim(),
          pageNo: 1,
          pageSize: 200,
          search: 'blur',
        }),
      ]);
      if (groupsRes?.success && Array.isArray(groupsRes.data)) {
        setGroupSuggestions(
          groupsRes.data
            .map((g: unknown) => String(g || '').trim())
            .filter(Boolean)
            .sort((a: string, b: string) => a.localeCompare(b)),
        );
      }
      if (configsRes?.success) {
        const page = (configsRes.data || {}) as NacosConfigPage;
        const rows = Array.isArray(page.pageItems) ? page.pageItems : [];
        setDataIdSuggestions((prev) =>
          mergeUniqueStrings(
            prev,
            rows.map((row) => row.dataId),
          ),
        );
      }
    } catch {
      // Suggestions are best-effort; list load still works without them.
    }
  }, [rpcConfig, namespaceId, initialGroup, filterGroup, mergeUniqueStrings]);

  const loadList = useCallback(
    async (
      nextPageNo = pageNo,
      nextPageSize = pageSize,
      // Pass latest filter values on select/enter — setState is async and closure would be stale.
      filterOverride?: { dataId?: string; group?: string },
    ) => {
      if (!rpcConfig) return;
      const dataId = (filterOverride?.dataId !== undefined ? filterOverride.dataId : filterDataId).trim();
      const group = (filterOverride?.group !== undefined ? filterOverride.group : filterGroup).trim();
      setLoadingList(true);
      try {
        const res = await (window as any).go.app.App.NacosSearchConfigs(rpcConfig, {
          namespaceId: namespaceId || '',
          dataId,
          group,
          pageNo: nextPageNo,
          pageSize: nextPageSize,
          search: 'blur',
        });
        if (!res?.success) {
          message.error(
            tr('nacos_viewer.message.load_failed', {
              detail: res?.message || 'unknown',
            }),
          );
          return;
        }
        const page = (res.data || {}) as NacosConfigPage;
        const rows = Array.isArray(page.pageItems) ? page.pageItems : [];
        setItems(rows);
        setSelectedRowKeys((currentKeys) =>
          reconcileNacosConfigSelection(rows, currentKeys),
        );
        setTotalCount(Number(page.totalCount) || 0);
        setPageNo(Number(page.pageNumber) || nextPageNo);
        if (nextPageSize !== pageSize) setPageSize(nextPageSize);
        // Grow suggestion catalogs from live results.
        setDataIdSuggestions((prev) => mergeUniqueStrings(prev, rows.map((row) => row.dataId)));
        setGroupSuggestions((prev) => mergeUniqueStrings(prev, rows.map((row) => row.group)));
      } catch (error: any) {
        message.error(
          tr('nacos_viewer.message.load_failed', {
            detail: error?.message || String(error),
          }),
        );
      } finally {
        setLoadingList(false);
      }
    },
    [rpcConfig, namespaceId, filterDataId, filterGroup, pageNo, pageSize, tr, mergeUniqueStrings],
  );

  const loadBetaMeta = useCallback(
    async (
      item: { dataId: string; group: string },
      selectionGeneration = selectionGenerationRef.current,
    ) => {
      if (!rpcConfig) return;
      const requestContext = {
        connectionId,
        namespaceId,
        rpcConfig,
      };
      const isCurrentSelection = () => {
        const currentContext = selectionContextRef.current;
        return (
          mountedRef.current &&
          selectionGenerationRef.current === selectionGeneration &&
          currentContext.connectionId === requestContext.connectionId &&
          currentContext.namespaceId === requestContext.namespaceId &&
          currentContext.rpcConfig === requestContext.rpcConfig
        );
      };
      try {
        const res = await (window as any).go.app.App.NacosGetBetaConfig(
          rpcConfig,
          namespaceId || '',
          item.group,
          item.dataId,
        );
        if (!isCurrentSelection()) return;
        if (!res?.success) {
          setBetaExists(false);
          return;
        }
        const beta = res.data || {};
        setBetaExists(!!beta.exists);
        if (beta.exists) {
          setBetaIps(String(beta.betaIps || ''));
        } else {
          setBetaIps('');
        }
      } catch {
        if (isCurrentSelection()) {
          setBetaExists(false);
        }
      }
    },
    [rpcConfig, connectionId, namespaceId],
  );
  return {
    tr, darkMode, workbenchTheme, connection, readOnly, importRestricted, loadingList,
    loadingDetail, setLoadingDetail, publishing, setPublishing, items, pinnedItems, totalCount,
    pageNo, pageSize, filterDataId, setFilterDataId, filterGroup, setFilterGroup, groupSuggestions,
    dataIdSuggestions, setDataIdSuggestions, setSelectedKey, listScrollY, setListScrollY,
    listBodyRef, detail, setDetail, draftContent, setDraftContent, draftType, setDraftType,
    draftDirty, setDraftDirty, newModalOpen, setNewModalOpen, newForm, historyOpen, setHistoryOpen,
    historyLoading, setHistoryLoading, historyItems, setHistoryItems, historyTotal, setHistoryTotal,
    historyPageNo, setHistoryPageNo, historyDetailOpen, setHistoryDetailOpen, historyDetail,
    setHistoryDetail, historyDetailLoading, setHistoryDetailLoading, historyEditorLanguage,
    rollingBack, setRollingBack, remoteChanged, setRemoteChanged, listenActive, setListenActive,
    publishMode, setPublishMode, betaIps, setBetaIps, betaExists, setBetaExists, importModalOpen,
    setImportModalOpen, importPreview, setImportPreview, importConflictMode, setImportConflictMode,
    importSelectedKeys, setImportSelectedKeys, importing, setImporting, exporting, setExporting,
    deletingSelected, setDeletingSelected, selectedRowKeys, setSelectedRowKeys, leftPanelWidth,
    setLeftPanelWidth, leftPanelRef, watchIdRef, detailRef, draftDirtyRef, selectionGenerationRef,
    mountedRef, rpcConfig, selectionContextRef, selectedRowKey, importSelectionRows, selectedItems,
    selectedCount, allPageSelected, pageSelectionIndeterminate, stopListen, startListen,
    loadFilterSuggestions, loadList, loadBetaMeta,
  };
};

export type NacosViewerStateApi = ReturnType<typeof useNacosViewerState>;
