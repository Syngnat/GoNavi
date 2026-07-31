import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AutoComplete,
  Button,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  message,
} from 'antd';
import {
  DeleteOutlined,
  DownloadOutlined,
  ExperimentOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { v4 as uuidv4 } from 'uuid';
import Editor from './MonacoEditor';
import RedisResizableDivider from './RedisResizableDivider';
import { buildRedisWorkbenchTheme } from './redisViewerWorkbenchTheme';
import { EventsOn } from '../../wailsjs/runtime';
import { useStore } from '../store';
import {
  isMacLikePlatform,
  normalizeBlurForPlatform,
  normalizeOpacityForPlatform,
  resolveAppearanceValues,
} from '../utils/appearance';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import {
  isConnectionDataImportRestricted,
} from '../utils/connectionReadOnly';
import { t, type I18nParams } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import { noAutoCapInputProps } from '../utils/inputAutoCap';
import {
  buildNacosImportSelectionRows,
  deleteSelectedNacosConfigs,
  nacosConfigSelectionKey,
  reconcileNacosConfigSelection,
  selectedNacosConfigItems,
  selectedNacosImportItems,
} from './nacosConfigSelection';

type NacosConfigItem = {
  id?: string;
  dataId: string;
  group: string;
  namespaceId?: string;
  content?: string;
  type?: string;
  md5?: string;
  appName?: string;
  desc?: string;
  modifiedTime?: string;
};

type NacosConfigDetail = {
  dataId: string;
  group: string;
  namespaceId?: string;
  content: string;
  type?: string;
  md5?: string;
  appName?: string;
  desc?: string;
};

type NacosConfigPage = {
  totalCount: number;
  pageNumber: number;
  pagesAvailable: number;
  pageItems: NacosConfigItem[];
};

type NacosHistoryItem = {
  id: string;
  dataId: string;
  group: string;
  namespaceId?: string;
  md5?: string;
  content?: string;
  opType?: string;
  srcUser?: string;
  createdTime?: string;
  modifiedTime?: string;
};

type NacosHistoryPage = {
  totalCount: number;
  pageNumber: number;
  pagesAvailable: number;
  pageItems: NacosHistoryItem[];
};

type NacosViewerProps = {
  connectionId: string;
  namespaceId: string;
  namespaceName?: string;
  initialGroup?: string;
};

const CONFIG_TYPE_OPTIONS = [
  'text',
  'json',
  'yaml',
  'xml',
  'html',
  'properties',
  'toml',
].map((value) => ({ value, label: value }));

const resolveEditorLanguage = (type?: string): string => {
  const normalized = String(type || '').trim().toLowerCase();
  switch (normalized) {
    case 'json':
      return 'json';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'xml':
    case 'html':
      return 'xml';
    case 'properties':
      return 'ini';
    case 'toml':
      return 'toml';
    default:
      return 'plaintext';
  }
};

const nacosConfigChangedEventName = 'nacos:config-changed';

type NacosConfigChangedEvent = {
  watchId?: string;
  connectionId?: string;
  namespaceId?: string;
  dataId?: string;
  group?: string;
  changedAt?: number;
};

const NacosViewer: React.FC<NacosViewerProps> = ({
  connectionId,
  namespaceId,
  namespaceName,
  initialGroup,
}) => {
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
  const isV2Ui = appearance.uiVersion === 'v2';
  const resolvedAppearance = resolveAppearanceValues(appearance);
  const opacity = normalizeOpacityForPlatform(resolvedAppearance.opacity);
  const blur = normalizeBlurForPlatform(resolvedAppearance.blur);
  const workbenchTheme = useMemo(
    () => buildRedisWorkbenchTheme({
      darkMode,
      opacity,
      blur,
      disableBackdropFilter: isMacLikePlatform(),
    }),
    [blur, darkMode, opacity, appearance.uiVersion],
  );
  // v1 keeps raised cards; v2 is flat (same as Redis gn-v2-redis-workbench CSS).
  const workbenchCardStyle = useMemo(() => (
    isV2Ui
      ? {
          background: 'transparent',
          border: 'none',
          boxShadow: 'none',
          borderRadius: 0,
        }
      : {
          background: workbenchTheme.panelBg,
          border: workbenchTheme.panelBorder,
          boxShadow: `${workbenchTheme.panelInset}, ${workbenchTheme.shadow}`,
          borderRadius: 12,
          backdropFilter: workbenchTheme.backdropFilter,
          WebkitBackdropFilter: workbenchTheme.backdropFilter,
        }
  ), [isV2Ui, workbenchTheme]);

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

  const loadDetail = useCallback(
    async (item: NacosConfigItem) => {
      if (!rpcConfig) return;
      const generation = ++selectionGenerationRef.current;
      void stopListen();
      const requestContext = {
        connectionId,
        namespaceId,
        rpcConfig,
      };
      const isCurrentSelection = () => {
        const currentContext = selectionContextRef.current;
        return (
          selectionGenerationRef.current === generation &&
          currentContext.connectionId === requestContext.connectionId &&
          currentContext.namespaceId === requestContext.namespaceId &&
          currentContext.rpcConfig === requestContext.rpcConfig
        );
      };
      setLoadingDetail(true);
      try {
        const res = await (window as any).go.app.App.NacosGetConfig(
          rpcConfig,
          namespaceId || '',
          item.group,
          item.dataId,
        );
        if (!isCurrentSelection()) return;
        if (!res?.success) {
          message.error(
            tr('nacos_viewer.message.load_failed', {
              detail: res?.message || 'unknown',
            }),
          );
          return;
        }
        const next = (res.data || {}) as NacosConfigDetail;
        detailRef.current = next;
        draftDirtyRef.current = false;
        setDetail(next);
        setDraftContent(String(next.content ?? ''));
        setDraftType(String(next.type || item.type || 'text'));
        setDraftDirty(false);
        setRemoteChanged(false);
        setPublishMode('formal');
        setSelectedKey(nacosConfigSelectionKey(item));
        void startListen(next, generation);
        void loadBetaMeta(
          { dataId: next.dataId, group: next.group },
          generation,
        );
      } catch (error: any) {
        if (!isCurrentSelection()) return;
        message.error(
          tr('nacos_viewer.message.load_failed', {
            detail: error?.message || String(error),
          }),
        );
      } finally {
        if (isCurrentSelection()) {
          setLoadingDetail(false);
        }
      }
    },
    [
      rpcConfig,
      connectionId,
      namespaceId,
      tr,
      startListen,
      stopListen,
      loadBetaMeta,
    ],
  );

  useEffect(() => {
    selectionGenerationRef.current += 1;
    void stopListen();
    detailRef.current = null;
    draftDirtyRef.current = false;
    setLoadingDetail(false);
    setDetail(null);
    setSelectedKey(null);
    setDraftContent('');
    setDraftType('text');
    setDraftDirty(false);
    setRemoteChanged(false);
    setListenActive(false);
    setBetaExists(false);
    setBetaIps('');
    const nextGroup = String(initialGroup || '').trim();
    setFilterGroup(nextGroup);
    setDataIdSuggestions([]);
    setSelectedRowKeys([]);
    // Reload when switching tab identity / initial group.
    void loadList(1);
    void loadFilterSuggestions();
  }, [connectionId, namespaceId, initialGroup, rpcConfig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep table body height = available pane height (minus real pagination height).
  useEffect(() => {
    const el = listBodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;

    const measure = () => {
      const bodyHeight = el.clientHeight;
      const paginationEl = el.querySelector('.ant-pagination') as HTMLElement | null;
      const tableEl = el.querySelector('.gn-nacos-config-table .ant-table') as HTMLElement | null;
      // Prefer measured bar height; fallback covers total + size changer + border.
      const paginationH = Math.max(paginationEl?.offsetHeight ?? 0, 40);
      const gap = 10; // top border / padding of pagination row
      // The list body also includes pane padding and pagination margins. Use the
      // table's real flex slot so scroll.y cannot extend behind its clipped container.
      const next = Math.max(160, tableEl?.clientHeight || bodyHeight - paginationH - gap);
      setListScrollY((prev) => (Math.abs(prev - next) < 2 ? prev : next));
    };

    measure();
    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(measure);
    });
    observer.observe(el);
    // Pagination can mount after first paint — remeasure once settled.
    const timer = window.setTimeout(measure, 50);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [items.length, pageSize, totalCount, isV2Ui]);

  const fuzzyFilterOption = useCallback(
    (input: string, option?: { value?: string | number }) => {
      const keyword = String(input || '').trim().toLowerCase();
      if (!keyword) return true;
      const value = String(option?.value ?? '').toLowerCase();
      // Simple fuzzy: all keyword chars appear in order, or plain includes.
      if (value.includes(keyword)) return true;
      let i = 0;
      for (const ch of value) {
        if (ch === keyword[i]) i += 1;
        if (i >= keyword.length) return true;
      }
      return false;
    },
    [],
  );

  const buildSuggestionOptions = useCallback(
    (values: string[]) =>
      values.map((value) => ({
        value,
        // Full width of dropdown; ellipsis only when truly overflowing; hover still shows full name.
        label: (
          <Tooltip title={value} placement="right" mouseEnterDelay={0.25}>
            <span
              title={value}
              style={{
                display: 'block',
                width: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {value}
            </span>
          </Tooltip>
        ),
      })),
    [],
  );

  const dataIdAutoOptions = useMemo(
    () => buildSuggestionOptions(dataIdSuggestions),
    [buildSuggestionOptions, dataIdSuggestions],
  );
  const groupAutoOptions = useMemo(
    () => buildSuggestionOptions(groupSuggestions),
    [buildSuggestionOptions, groupSuggestions],
  );

  useEffect(() => {
    const off = EventsOn(nacosConfigChangedEventName, (event: NacosConfigChangedEvent) => {
      const current = detailRef.current;
      if (!current) return;
      const watchId = watchIdRef.current;
      if (!watchId) return;
      if (event?.watchId && event.watchId !== watchId) return;
      if (event?.connectionId && event.connectionId !== connectionId) return;
      if (event?.namespaceId && event.namespaceId !== namespaceId) return;
      const eventDataId = String(event?.dataId || '').trim();
      const eventGroup = String(event?.group || 'DEFAULT_GROUP').trim() || 'DEFAULT_GROUP';
      if (eventDataId && eventDataId !== current.dataId) return;
      if (eventGroup && eventGroup !== current.group) return;
      void stopListen();
      setRemoteChanged(true);
      if (!draftDirtyRef.current) {
        message.info(tr('nacos_viewer.message.remote_changed'));
      }
    });
    return () => {
      if (typeof off === 'function') off();
    };
  }, [connectionId, namespaceId, stopListen, tr]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      selectionGenerationRef.current += 1;
      void stopListen();
    };
  }, [stopListen]);

  const handlePublish = async () => {
    if (!rpcConfig || !detail) return;
    if (readOnly) {
      message.warning(tr('nacos_viewer.message.read_only'));
      return;
    }
    if (publishMode === 'beta' && !betaIps.trim()) {
      message.warning(tr('nacos_viewer.message.beta_ips_required'));
      return;
    }
    const publishTarget = detail;
    const publishSelectionGeneration = selectionGenerationRef.current;
    let publishSucceeded = false;
    setPublishing(true);
    try {
      await stopListen();
      const res = await (window as any).go.app.App.NacosPublishConfig(rpcConfig, {
        namespaceId: namespaceId || '',
        dataId: detail.dataId,
        group: detail.group,
        content: draftContent,
        type: draftType,
        appName: detail.appName || '',
        desc: detail.desc || '',
        betaIps: publishMode === 'beta' ? betaIps.trim() : '',
      });
      if (!res?.success) {
        void startListen(publishTarget, publishSelectionGeneration);
        message.error(res?.message || 'publish failed');
        return;
      }
      publishSucceeded = true;
      message.success(
        publishMode === 'beta'
          ? tr('nacos_viewer.message.beta_publish_success')
          : tr('nacos_viewer.message.publish_success'),
      );
      setDraftDirty(false);
      setRemoteChanged(false);
      await loadList(pageNo);
      await loadDetail({
        dataId: publishTarget.dataId,
        group: publishTarget.group,
        type: draftType,
      });
      await loadBetaMeta({ dataId: publishTarget.dataId, group: publishTarget.group });
    } catch (error: any) {
      if (!publishSucceeded) {
        void startListen(publishTarget, publishSelectionGeneration);
      }
      message.error(error?.message || String(error));
    } finally {
      setPublishing(false);
    }
  };

  const handleStopBeta = async () => {
    if (!rpcConfig || !detail) return;
    if (readOnly) {
      message.warning(tr('nacos_viewer.message.read_only'));
      return;
    }
    try {
      const res = await (window as any).go.app.App.NacosStopBetaConfig(
        rpcConfig,
        namespaceId || '',
        detail.group,
        detail.dataId,
      );
      if (!res?.success) {
        message.error(res?.message || 'stop beta failed');
        return;
      }
      message.success(tr('nacos_viewer.message.beta_stop_success'));
      setBetaExists(false);
      setBetaIps('');
      setPublishMode('formal');
    } catch (error: any) {
      message.error(error?.message || String(error));
    }
  };

  const handleLoadBetaContent = async () => {
    if (!rpcConfig || !detail) return;
    try {
      const res = await (window as any).go.app.App.NacosGetBetaConfig(
        rpcConfig,
        namespaceId || '',
        detail.group,
        detail.dataId,
      );
      if (!res?.success) {
        message.error(res?.message || 'load beta failed');
        return;
      }
      const beta = res.data || {};
      if (!beta.exists) {
        message.info(tr('nacos_viewer.message.beta_not_found'));
        setBetaExists(false);
        return;
      }
      setBetaExists(true);
      setBetaIps(String(beta.betaIps || ''));
      setDraftContent(String(beta.content ?? ''));
      if (beta.type) setDraftType(String(beta.type));
      setDraftDirty(true);
      setPublishMode('beta');
      message.success(tr('nacos_viewer.message.beta_loaded'));
    } catch (error: any) {
      message.error(error?.message || String(error));
    }
  };

  const handleExport = async (scope: 'all' | 'selected') => {
    if (!rpcConfig) return;
    if (scope === 'selected' && selectedItems.length === 0) {
      message.warning(tr('nacos_viewer.message.export_select_required'));
      return;
    }
    setExporting(true);
    try {
      const exportItems = selectedItems.map((item) => ({
        dataId: item.dataId,
        group: item.group,
      }));
      const res = await (window as any).go.app.App.NacosExportConfigs(rpcConfig, {
        namespaceId: namespaceId || '',
        namespaceName: namespaceName || '',
        scope,
        items: scope === 'selected' ? exportItems : [],
      });
      if (!res?.success) {
        if (res?.message && res.message !== '已取消') {
          message.error(res.message);
        }
        return;
      }
      message.success(tr('nacos_viewer.message.export_success', {
        count: res?.data?.exported ?? 0,
      }));
    } catch (error: any) {
      message.error(error?.message || String(error));
    } finally {
      setExporting(false);
    }
  };

  const handlePreviewImport = async () => {
    if (!rpcConfig || importRestricted) return;
    try {
      const res = await (window as any).go.app.App.NacosPreviewImportConfigs(
        rpcConfig,
        namespaceId || '',
      );
      if (!res?.success) {
        if (res?.message && res.message !== '已取消') {
          message.error(res.message);
        }
        return;
      }
      const preview = res.data || {};
      setImportPreview(preview);
      const keys = buildNacosImportSelectionRows(
        Array.isArray(preview.items) ? preview.items : [],
      ).map((row) => row.selectionKey);
      setImportSelectedKeys(keys);
      setImportConflictMode('skip');
      setImportModalOpen(true);
    } catch (error: any) {
      message.error(error?.message || String(error));
    }
  };

  const handleImport = async () => {
    if (!rpcConfig || !importPreview || importRestricted) return;
    setImporting(true);
    try {
      const selectedItems = selectedNacosImportItems(
        Array.isArray(importPreview.items) ? importPreview.items : [],
        importSelectedKeys,
      );
      const res = await (window as any).go.app.App.NacosImportConfigs(rpcConfig, {
        namespaceId: namespaceId || '',
        conflictMode: importConflictMode,
        file: importPreview.file,
        scope: 'selected',
        items: selectedItems,
      });
      if (!res?.success) {
        message.error(res?.message || 'import failed');
        return;
      }
      message.success(tr('nacos_viewer.message.import_success', {
        imported: res?.data?.imported ?? 0,
        skipped: res?.data?.skipped ?? 0,
      }));
      setImportModalOpen(false);
      setImportPreview(null);
      await loadList(1);
    } catch (error: any) {
      message.error(error?.message || String(error));
    } finally {
      setImporting(false);
    }
  };

  const handleReloadRemote = async () => {
    if (!detail) return;
    await loadDetail({
      dataId: detail.dataId,
      group: detail.group,
      type: draftType || detail.type,
    });
  };

  const resetDetailState = () => {
    detailRef.current = null;
    draftDirtyRef.current = false;
    setDetail(null);
    setSelectedKey(null);
    setDraftContent('');
    setDraftDirty(false);
    setRemoteChanged(false);
    setBetaExists(false);
    setBetaIps('');
  };

  const handleDeleteSelected = async () => {
    if (!rpcConfig || selectedItems.length === 0) return;
    if (readOnly) {
      message.warning(tr('nacos_viewer.message.read_only'));
      return;
    }

    const deletingItems = [...selectedItems];
    setDeletingSelected(true);
    try {
      const result = await deleteSelectedNacosConfigs(deletingItems, async (item) => {
        const res = await (window as any).go.app.App.NacosDeleteConfig(
          rpcConfig,
          namespaceId || '',
          item.group,
          item.dataId,
        );
        return {
          success: !!res?.success,
          message: res?.message,
        };
      });

      const failedKeys = result.failed.map(({ item }) => nacosConfigSelectionKey(item));
      setSelectedRowKeys(failedKeys);

      if (detail) {
        const detailKey = nacosConfigSelectionKey(detail);
        const deletedCurrentDetail = result.deleted.some(
          (item) => nacosConfigSelectionKey(item) === detailKey,
        );
        if (deletedCurrentDetail) {
          await stopListen();
          resetDetailState();
        }
      }

      if (result.deleted.length > 0) {
        const remainingTotal = Math.max(0, totalCount - result.deleted.length);
        const lastPage = Math.max(1, Math.ceil(remainingTotal / pageSize));
        await loadList(Math.min(pageNo, lastPage));
      }

      if (result.failed.length === 0) {
        message.success(tr('nacos_viewer.message.delete_selected_success', {
          count: result.deleted.length,
        }));
      } else if (result.deleted.length > 0) {
        message.warning(tr('nacos_viewer.message.delete_selected_partial', {
          deleted: result.deleted.length,
          failed: result.failed.length,
        }));
      } else {
        message.error(tr('nacos_viewer.message.delete_selected_failed', {
          count: result.failed.length,
          detail: result.failed[0]?.message || 'unknown',
        }));
      }
    } finally {
      setDeletingSelected(false);
    }
  };

  const handleDelete = async () => {
    if (!rpcConfig || !detail) return;
    if (readOnly) {
      message.warning(tr('nacos_viewer.message.read_only'));
      return;
    }
    try {
      const res = await (window as any).go.app.App.NacosDeleteConfig(
        rpcConfig,
        namespaceId || '',
        detail.group,
        detail.dataId,
      );
      if (!res?.success) {
        message.error(res?.message || 'delete failed');
        return;
      }
      message.success(tr('nacos_viewer.message.delete_success'));
      const deletedKey = nacosConfigSelectionKey(detail);
      setSelectedRowKeys((keys) => keys.filter((key) => String(key) !== deletedKey));
      await stopListen();
      resetDetailState();
      const remainingTotal = Math.max(0, totalCount - 1);
      const lastPage = Math.max(1, Math.ceil(remainingTotal / pageSize));
      await loadList(Math.min(pageNo, lastPage));
    } catch (error: any) {
      message.error(error?.message || String(error));
    }
  };

  const handleCreate = async () => {
    if (!rpcConfig) return;
    if (readOnly) {
      message.warning(tr('nacos_viewer.message.read_only'));
      return;
    }
    try {
      const values = await newForm.validateFields();
      const dataId = String(values.dataId || '').trim();
      const group = String(values.group || 'DEFAULT_GROUP').trim() || 'DEFAULT_GROUP';
      const type = String(values.type || 'text').trim() || 'text';
      const content = String(values.content ?? '');
      const res = await (window as any).go.app.App.NacosPublishConfig(rpcConfig, {
        namespaceId: namespaceId || '',
        dataId,
        group,
        content,
        type,
      });
      if (!res?.success) {
        message.error(res?.message || 'publish failed');
        return;
      }
      message.success(tr('nacos_viewer.message.publish_success'));
      setNewModalOpen(false);
      newForm.resetFields();
      await loadList(1);
      await loadDetail({ dataId, group, type });
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error?.message || String(error));
    }
  };

  const loadHistory = useCallback(
    async (page = 1) => {
      if (!rpcConfig || !detail) return;
      setHistoryLoading(true);
      try {
        const res = await (window as any).go.app.App.NacosListConfigHistory(rpcConfig, {
          namespaceId: namespaceId || '',
          dataId: detail.dataId,
          group: detail.group,
          pageNo: page,
          pageSize: 20,
        });
        if (!res?.success) {
          message.error(
            tr('nacos_viewer.message.load_failed', {
              detail: res?.message || 'unknown',
            }),
          );
          return;
        }
        const pageData = (res.data || {}) as NacosHistoryPage;
        setHistoryItems(Array.isArray(pageData.pageItems) ? pageData.pageItems : []);
        setHistoryTotal(Number(pageData.totalCount) || 0);
        setHistoryPageNo(Number(pageData.pageNumber) || page);
      } catch (error: any) {
        message.error(
          tr('nacos_viewer.message.load_failed', {
            detail: error?.message || String(error),
          }),
        );
      } finally {
        setHistoryLoading(false);
      }
    },
    [rpcConfig, detail, namespaceId, tr],
  );

  const openHistory = async () => {
    if (!detail) return;
    setHistoryOpen(true);
    await loadHistory(1);
  };

  const openHistoryDetail = async (item: NacosHistoryItem) => {
    if (!rpcConfig || !detail) return;
    setHistoryDetailOpen(true);
    setHistoryDetailLoading(true);
    try {
      const res = await (window as any).go.app.App.NacosGetConfigHistory(
        rpcConfig,
        namespaceId || '',
        detail.group,
        detail.dataId,
        item.id,
      );
      if (!res?.success) {
        message.error(res?.message || 'load history failed');
        setHistoryDetail(item);
        return;
      }
      setHistoryDetail((res.data || item) as NacosHistoryItem);
    } catch (error: any) {
      message.error(error?.message || String(error));
      setHistoryDetail(item);
    } finally {
      setHistoryDetailLoading(false);
    }
  };

  const handleRollback = async (item: NacosHistoryItem) => {
    if (!rpcConfig || !detail) return;
    if (readOnly) {
      message.warning(tr('nacos_viewer.message.read_only'));
      return;
    }
    setRollingBack(true);
    try {
      let content = item.content;
      if (!content) {
        const detailRes = await (window as any).go.app.App.NacosGetConfigHistory(
          rpcConfig,
          namespaceId || '',
          detail.group,
          detail.dataId,
          item.id,
        );
        if (!detailRes?.success) {
          message.error(detailRes?.message || 'load history failed');
          return;
        }
        content = String((detailRes.data as NacosHistoryItem)?.content ?? '');
      }
      const res = await (window as any).go.app.App.NacosPublishConfig(rpcConfig, {
        namespaceId: namespaceId || '',
        dataId: detail.dataId,
        group: detail.group,
        content: content ?? '',
        type: draftType || detail.type || 'text',
        appName: detail.appName || '',
        desc: detail.desc || '',
      });
      if (!res?.success) {
        message.error(res?.message || 'rollback failed');
        return;
      }
      message.success(tr('nacos_viewer.message.rollback_success'));
      setHistoryOpen(false);
      setHistoryDetailOpen(false);
      await loadList(pageNo);
      await loadDetail({
        dataId: detail.dataId,
        group: detail.group,
        type: draftType || detail.type,
      });
    } catch (error: any) {
      message.error(error?.message || String(error));
    } finally {
      setRollingBack(false);
    }
  };

  // List-style row: [title+group | type tag]. Type stays fully visible (not under scrollbar).
  const columns = [
    {
      title: tr('nacos_viewer.field.data_id'),
      key: 'config',
      ellipsis: true,
      render: (_: unknown, row: NacosConfigItem) => (
        <div className="gn-nacos-config-row">
          <div className="gn-nacos-config-row__main">
            <div className="gn-nacos-config-row__id" title={row.dataId}>
              {row.dataId}
            </div>
            <div className="gn-nacos-config-row__group" title={row.group}>
              {row.group || 'DEFAULT_GROUP'}
            </div>
          </div>
          {row.type ? (
            <Tag className="gn-nacos-config-row__type" bordered={false} title={row.type}>
              {row.type}
            </Tag>
          ) : null}
        </div>
      ),
    },
  ];

  const namespaceLabel = namespaceName || (namespaceId ? namespaceId : 'public');
  const remoteChangedHint = draftDirty
    ? tr('nacos_viewer.message.remote_changed_dirty_hint')
    : tr('nacos_viewer.message.remote_changed_clean_hint');

  return (
    <div
      className={isV2Ui ? 'gn-v2-nacos-workbench' : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        padding: isV2Ui ? 0 : 12,
        gap: isV2Ui ? 0 : 12,
        boxSizing: 'border-box',
        background: isV2Ui ? undefined : workbenchTheme.appBg,
        color: workbenchTheme.textPrimary,
      }}
    >
      {remoteChanged ? (
        <Alert
          type="warning"
          showIcon
          className={isV2Ui ? 'gn-v2-nacos-banner' : undefined}
          message={
            isV2Ui ? (
              <span className="gn-v2-nacos-banner__copy">
                <span className="gn-v2-nacos-banner__title">
                  {tr('nacos_viewer.message.remote_changed_banner')}
                </span>
                {draftDirty ? (
                  <span className="gn-v2-nacos-banner__hint" title={remoteChangedHint}>
                    {remoteChangedHint}
                  </span>
                ) : null}
              </span>
            ) : (
              tr('nacos_viewer.message.remote_changed_banner')
            )
          }
          description={isV2Ui ? undefined : remoteChangedHint}
          action={
            <Space size={4}>
              <Button size="small" type="primary" onClick={() => void handleReloadRemote()}>
                {tr('nacos_viewer.action.reload_remote')}
              </Button>
              <Button
                size="small"
                type={isV2Ui ? 'text' : 'default'}
                onClick={() => setRemoteChanged(false)}
              >
                {tr('nacos_viewer.action.dismiss_remote')}
              </Button>
            </Space>
          }
        />
      ) : null}

      {/* Redis-style split: left | full-height divider | right (headers share one grid row) */}
      <div
        className={isV2Ui ? 'gn-v2-nacos-split' : undefined}
        style={{
          display: isV2Ui ? undefined : 'flex',
          minHeight: 0,
          flex: 1,
          overflow: 'hidden',
          ...(isV2Ui
            ? {
                ['--gn-nacos-sidebar-width' as string]:
                  typeof leftPanelWidth === 'number' ? `${leftPanelWidth}px` : leftPanelWidth,
              }
            : {}),
        }}
      >
        <div
          ref={leftPanelRef}
          className={isV2Ui ? 'gn-v2-nacos-list-pane' : undefined}
          style={
            isV2Ui
              ? { minHeight: 0, overflow: 'hidden' }
              : {
                  ...workbenchCardStyle,
                  width: leftPanelWidth,
                  minWidth: 280,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  flexShrink: 0,
                  overflow: 'hidden',
                }
          }
        >
          <div
            className={isV2Ui ? 'gn-v2-nacos-pane-header' : undefined}
            style={
              isV2Ui
                ? { display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'stretch' }
                : { padding: 8, marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 8 }
            }
          >
            <Space wrap size={[8, 8]}>
              <Tag color="blue">{namespaceLabel}</Tag>
              {listenActive ? <Tag color="green">{tr('nacos_viewer.status.listening')}</Tag> : null}
              <Button icon={<ReloadOutlined />} onClick={() => void loadList(1)} loading={loadingList}>
                {tr('nacos_viewer.action.refresh')}
              </Button>
              <Button
                icon={<PlusOutlined />}
                disabled={readOnly}
                onClick={() => {
                  newForm.setFieldsValue({
                    dataId: '',
                    group: 'DEFAULT_GROUP',
                    type: 'text',
                    content: '',
                  });
                  setNewModalOpen(true);
                }}
              >
                {tr('nacos_viewer.action.new')}
              </Button>
              <Button
                icon={<DownloadOutlined />}
                loading={exporting}
                onClick={() => void handleExport(selectedCount > 0 ? 'selected' : 'all')}
              >
                {tr(
                  selectedCount > 0
                    ? 'nacos_viewer.action.export_selected'
                    : 'nacos_viewer.action.export_all',
                )}
              </Button>
              <Button
                icon={<UploadOutlined />}
                disabled={importRestricted}
                onClick={() => void handlePreviewImport()}
              >
                {tr('nacos_viewer.action.import')}
              </Button>
            </Space>
            <div
              className="gn-nacos-filter-row"
              style={{
                display: 'flex',
                gap: 8,
                width: '100%',
                minWidth: 0,
              }}
            >
              <AutoComplete
                allowClear
                options={dataIdAutoOptions}
                filterOption={fuzzyFilterOption}
                value={filterDataId}
                className="gn-nacos-filter-data-id"
                popupClassName="gn-nacos-filter-dropdown"
                // Match input width so option text can use the full row (no artificial 280px clip).
                popupMatchSelectWidth
                style={{ flex: '1 1 0', minWidth: 0 }}
                placeholder={tr('nacos_viewer.field.data_id')}
                {...noAutoCapInputProps}
                onChange={(value) => {
                  const next = String(value ?? '');
                  setFilterDataId(next);
                  // Clearing should re-query immediately without an extra click.
                  if (!next) void loadList(1, pageSize, { dataId: '' });
                }}
                onSelect={(value) => {
                  const next = String(value ?? '');
                  setFilterDataId(next);
                  void loadList(1, pageSize, { dataId: next });
                }}
                onInputKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void loadList(1, pageSize, { dataId: filterDataId });
                  }
                }}
                onFocus={() => {
                  if (dataIdSuggestions.length === 0) void loadFilterSuggestions();
                }}
              />
              <AutoComplete
                allowClear
                options={groupAutoOptions}
                filterOption={fuzzyFilterOption}
                value={filterGroup}
                className="gn-nacos-filter-group"
                popupClassName="gn-nacos-filter-dropdown"
                popupMatchSelectWidth
                style={{ flex: '1 1 0', minWidth: 0 }}
                placeholder={tr('nacos_viewer.field.group')}
                {...noAutoCapInputProps}
                onChange={(value) => {
                  const next = String(value ?? '');
                  setFilterGroup(next);
                  if (!next) void loadList(1, pageSize, { group: '' });
                }}
                onSelect={(value) => {
                  const next = String(value ?? '');
                  setFilterGroup(next);
                  void loadList(1, pageSize, { group: next });
                }}
                onInputKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void loadList(1, pageSize, { group: filterGroup });
                  }
                }}
                onFocus={() => {
                  if (groupSuggestions.length === 0) void loadFilterSuggestions();
                }}
              />
            </div>
            <div
              className="gn-nacos-selection-toolbar"
              style={{ borderTop: `1px solid ${workbenchTheme.divider}` }}
            >
              <div className="gn-nacos-selection-toolbar__summary">
                <Checkbox
                  checked={allPageSelected}
                  indeterminate={pageSelectionIndeterminate}
                  disabled={items.length === 0 || loadingList}
                  aria-label={tr('nacos_viewer.selection.select_page')}
                  onChange={(event) => {
                    setSelectedRowKeys(
                      event.target.checked ? items.map(nacosConfigSelectionKey) : [],
                    );
                  }}
                >
                  {tr('nacos_viewer.selection.select_page')}
                </Checkbox>
                <span
                  className="gn-nacos-selection-toolbar__count"
                  style={{ color: workbenchTheme.textMuted }}
                  aria-live="polite"
                >
                  {tr('nacos_viewer.selection.count', { count: selectedCount })}
                </span>
              </div>
              <div className="gn-nacos-selection-toolbar__actions">
                <Popconfirm
                  disabled={readOnly || selectedCount === 0}
                  title={tr('nacos_viewer.message.confirm_delete_selected', {
                    count: selectedCount,
                  })}
                  okText={tr('nacos_viewer.action.delete_selected')}
                  cancelText={tr('common.cancel')}
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void handleDeleteSelected()}
                >
                  <Button
                    danger
                    icon={<DeleteOutlined />}
                    disabled={readOnly || selectedCount === 0}
                    loading={deletingSelected}
                  >
                    {tr('nacos_viewer.action.delete_selected')}
                  </Button>
                </Popconfirm>
              </div>
            </div>
          </div>
          <div
            ref={listBodyRef}
            className={isV2Ui ? 'gn-v2-nacos-pane-body gn-v2-nacos-list-body' : undefined}
            style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: isV2Ui ? undefined : 8 }}
          >
            <Table
              className="gn-nacos-config-table"
              size="small"
              showHeader={false}
              rowKey={nacosConfigSelectionKey}
              loading={loadingList}
              dataSource={items}
              columns={columns as any}
              rowSelection={{
                selectedRowKeys: selectedRowKeys,
                onChange: (keys) => setSelectedRowKeys(keys),
                columnWidth: 36,
              }}
              pagination={{
                current: pageNo,
                pageSize,
                total: totalCount,
                size: 'small',
                // Select-only page size (no free-text that can't be applied).
                showSizeChanger: {
                  showSearch: false,
                  popupMatchSelectWidth: false,
                  placement: 'topRight',
                },
                pageSizeOptions: ['20', '50', '100', '200'],
                showLessItems: true,
                showTotal: (total, range) =>
                  total > 0
                    ? tr('nacos_viewer.pagination.range', {
                        from: range[0],
                        to: range[1],
                        total,
                      })
                    : tr('nacos_viewer.pagination.empty'),
                onChange: (page, nextSize) => {
                  const size = nextSize || pageSize;
                  if (size !== pageSize) {
                    void loadList(1, size);
                    return;
                  }
                  void loadList(page, size);
                },
                onShowSizeChange: (_current, size) => {
                  void loadList(1, size);
                },
              }}
              onRow={(record) => ({
                // Avoid browser text-selection flash when clicking rows.
                onMouseDown: (event) => {
                  if (event.detail > 1) event.preventDefault();
                },
                onClick: () => {
                  if (typeof window !== 'undefined') {
                    window.getSelection()?.removeAllRanges();
                  }
                  if (draftDirty) {
                    Modal.confirm({
                      title: tr('nacos_viewer.action.publish'),
                      content: tr('nacos_viewer.message.select_config'),
                      okText: tr('nacos_viewer.action.refresh'),
                      onOk: () => void loadDetail(record),
                    });
                    return;
                  }
                  void loadDetail(record);
                },
              })}
              rowClassName={(record) =>
                selectedRowKey === nacosConfigSelectionKey(record)
                  ? 'ant-table-row-selected gn-nacos-config-table__row--active'
                  : 'gn-nacos-config-table__row'
              }
              style={{ flex: 1, minHeight: 0 }}
              scroll={{ y: listScrollY }}
            />
          </div>
        </div>

        <RedisResizableDivider
          targetRef={leftPanelRef}
          onResizeEnd={setLeftPanelWidth}
          minWidth={280}
          maxReservedWidth={isV2Ui ? 321 : 320}
          containerWidthCssVariable={isV2Ui ? '--gn-nacos-sidebar-width' : undefined}
          title={tr('redis_viewer.tooltip.resize_panels')}
        />

        <div
          className={isV2Ui ? 'gn-v2-nacos-detail-pane' : undefined}
          style={
            isV2Ui
              ? { minHeight: 0, overflow: 'hidden' }
              : {
                  ...workbenchCardStyle,
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }
          }
        >
          <div
            className={isV2Ui ? 'gn-v2-nacos-pane-header' : undefined}
            style={isV2Ui ? undefined : { padding: 8, marginBottom: 8 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <Space wrap size={[8, 8]}>
                {detail ? (
                  <>
                    <Tag>{detail.group}</Tag>
                    <strong style={{ color: workbenchTheme.textPrimary }}>{detail.dataId}</strong>
                    {detail.md5 ? <Tag color="default">{detail.md5}</Tag> : null}
                    {betaExists ? <Tag color="purple">{tr('nacos_viewer.status.beta_active')}</Tag> : null}
                  </>
                ) : (
                  <span style={{ color: workbenchTheme.textMuted }}>{tr('nacos_viewer.message.select_config')}</span>
                )}
              </Space>
              <Space wrap size={[8, 8]}>
                <Button
                  icon={<HistoryOutlined />}
                  disabled={!detail}
                  onClick={() => void openHistory()}
                >
                  {tr('nacos_viewer.action.history')}
                </Button>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  loading={publishing}
                  disabled={readOnly || !detail || !draftDirty}
                  onClick={() => void handlePublish()}
                >
                  {publishMode === 'beta'
                    ? tr('nacos_viewer.action.publish_beta')
                    : tr('nacos_viewer.action.publish')}
                </Button>
                <Popconfirm
                  title={tr('nacos_viewer.message.confirm_delete', {
                    group: detail?.group || '',
                    dataId: detail?.dataId || '',
                  })}
                  disabled={readOnly || !detail}
                  onConfirm={() => void handleDelete()}
                >
                  <Button danger icon={<DeleteOutlined />} disabled={readOnly || !detail}>
                    {tr('nacos_viewer.action.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            </div>
          </div>

          <div
            className={isV2Ui ? 'gn-v2-nacos-pane-body' : undefined}
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: isV2Ui ? undefined : 12,
              overflow: 'hidden',
            }}
          >
            {loadingDetail ? (
              <div style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
                <Spin />
              </div>
            ) : !detail ? (
              <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: workbenchTheme.textMuted }}>
                {tr('nacos_viewer.message.select_config')}
              </div>
            ) : (
              <>
                <Space wrap>
                  <Select
                    style={{ width: 140 }}
                    value={draftType}
                    options={CONFIG_TYPE_OPTIONS}
                    disabled={readOnly}
                    onChange={(value) => {
                      setDraftType(value);
                      setDraftDirty(true);
                    }}
                  />
                  <Radio.Group
                    size="small"
                    value={publishMode}
                    onChange={(event) => setPublishMode(event.target.value)}
                    optionType="button"
                    buttonStyle="solid"
                    options={[
                      { label: tr('nacos_viewer.mode.formal'), value: 'formal' },
                      { label: tr('nacos_viewer.mode.beta'), value: 'beta' },
                    ]}
                  />
                </Space>
                {publishMode === 'beta' ? (
                  <Space wrap style={{ width: '100%' }}>
                    <Input
                      {...noAutoCapInputProps}
                      style={{ minWidth: 280, flex: 1 }}
                      placeholder={tr('nacos_viewer.field.beta_ips_placeholder')}
                      value={betaIps}
                      disabled={readOnly}
                      onChange={(event) => setBetaIps(event.target.value)}
                      prefix={<ExperimentOutlined />}
                    />
                    <Button size="small" disabled={!betaExists} onClick={() => void handleLoadBetaContent()}>
                      {tr('nacos_viewer.action.load_beta')}
                    </Button>
                    <Popconfirm
                      title={tr('nacos_viewer.message.confirm_stop_beta')}
                      disabled={readOnly || !betaExists}
                      onConfirm={() => void handleStopBeta()}
                    >
                      <Button size="small" danger disabled={readOnly || !betaExists}>
                        {tr('nacos_viewer.action.stop_beta')}
                      </Button>
                    </Popconfirm>
                  </Space>
                ) : null}
                <div style={{ flex: 1, minHeight: 240, minWidth: 0 }}>
                  <Editor
                    height="100%"
                    gonaviTypography="data"
                    language={resolveEditorLanguage(draftType)}
                    theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                    value={draftContent}
                    onChange={(value) => {
                      setDraftContent(value ?? '');
                      setDraftDirty(true);
                    }}
                    options={{
                      readOnly,
                      minimap: { enabled: false },
                      lineNumbers: 'on',
                      wordWrap: 'on',
                      fontSize: 13,
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      folding: true,
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <Modal
        title={tr('nacos_viewer.action.new')}
        open={newModalOpen}
        onCancel={() => setNewModalOpen(false)}
        onOk={() => void handleCreate()}
        destroyOnHidden
      >
        <Form form={newForm} layout="vertical" initialValues={{ group: 'DEFAULT_GROUP', type: 'text' }}>
          <Form.Item
            name="dataId"
            label={tr('nacos_viewer.field.data_id')}
            rules={[{ required: true, message: tr('nacos.backend.error.data_id_required') }]}
          >
            <Input {...noAutoCapInputProps} />
          </Form.Item>
          <Form.Item name="group" label={tr('nacos_viewer.field.group')}>
            <Input {...noAutoCapInputProps} />
          </Form.Item>
          <Form.Item name="type" label={tr('nacos_viewer.field.type')}>
            <Select options={CONFIG_TYPE_OPTIONS} />
          </Form.Item>
          <Form.Item name="content" label={tr('nacos_viewer.field.content')}>
            <Input.TextArea rows={8} {...noAutoCapInputProps} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={tr('nacos_viewer.history.title')}
        open={historyOpen}
        onCancel={() => setHistoryOpen(false)}
        footer={null}
        width={860}
        destroyOnHidden
      >
        <Table
          size="small"
          loading={historyLoading}
          rowKey={(row) => row.id}
          dataSource={historyItems}
          pagination={{
            current: historyPageNo,
            pageSize: 20,
            total: historyTotal,
            showSizeChanger: false,
            onChange: (page) => void loadHistory(page),
          }}
          columns={[
            {
              title: tr('nacos_viewer.history.column.id'),
              dataIndex: 'id',
              key: 'id',
              width: 120,
              ellipsis: true,
            },
            {
              title: tr('nacos_viewer.history.column.op'),
              dataIndex: 'opType',
              key: 'opType',
              width: 80,
              render: (value: string) => value || '-',
            },
            {
              title: tr('nacos_viewer.history.column.time'),
              dataIndex: 'modifiedTime',
              key: 'modifiedTime',
              width: 200,
              render: (_: string, row: NacosHistoryItem) => row.modifiedTime || row.createdTime || '-',
            },
            {
              title: tr('nacos_viewer.column.md5'),
              dataIndex: 'md5',
              key: 'md5',
              width: 140,
              ellipsis: true,
              render: (value: string) => value || '-',
            },
            {
              title: tr('nacos_viewer.action.history'),
              key: 'actions',
              width: 220,
              render: (_: unknown, row: NacosHistoryItem) => (
                <Space>
                  <Button size="small" onClick={() => void openHistoryDetail(row)}>
                    {tr('nacos_viewer.action.view_history')}
                  </Button>
                  <Popconfirm
                    title={tr('nacos_viewer.message.confirm_rollback', {
                      group: detail?.group || '',
                      dataId: detail?.dataId || '',
                      id: row.id,
                    })}
                    disabled={readOnly}
                    onConfirm={() => void handleRollback(row)}
                  >
                    <Button size="small" type="primary" disabled={readOnly} loading={rollingBack}>
                      {tr('nacos_viewer.action.rollback')}
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Modal>

      <Modal
        title={tr('nacos_viewer.action.view_history')}
        open={historyDetailOpen}
        onCancel={() => setHistoryDetailOpen(false)}
        width={720}
        footer={
          <Space>
            <Button onClick={() => setHistoryDetailOpen(false)}>{t('common.cancel', undefined, i18nLanguage)}</Button>
            <Popconfirm
              title={tr('nacos_viewer.message.confirm_rollback', {
                group: detail?.group || '',
                dataId: detail?.dataId || '',
                id: historyDetail?.id || '',
              })}
              disabled={readOnly || !historyDetail}
              onConfirm={() => historyDetail && void handleRollback(historyDetail)}
            >
              <Button type="primary" disabled={readOnly || !historyDetail} loading={rollingBack}>
                {tr('nacos_viewer.action.rollback')}
              </Button>
            </Popconfirm>
          </Space>
        }
      >
        {historyDetailLoading ? (
          <div style={{ minHeight: 200, display: 'grid', placeItems: 'center' }}>
            <Spin />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Space wrap>
              <Tag>{historyDetail?.id}</Tag>
              <Tag>{historyDetail?.opType || '-'}</Tag>
              <Tag>{historyDetail?.modifiedTime || historyDetail?.createdTime || '-'}</Tag>
            </Space>
            <Input.TextArea
              value={historyDetail?.content ?? ''}
              readOnly
              rows={16}
              {...noAutoCapInputProps}
            />
          </div>
        )}
      </Modal>

      <Modal
        title={tr('nacos_viewer.action.import')}
        open={importModalOpen}
        onCancel={() => setImportModalOpen(false)}
        onOk={() => void handleImport()}
        confirmLoading={importing}
        okButtonProps={{ disabled: importRestricted || importSelectedKeys.length === 0 }}
        width={820}
        destroyOnHidden
      >
        {importPreview ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Space wrap>
              <Tag>{importPreview.file}</Tag>
              <Tag color="blue">
                {tr('nacos_viewer.import.summary', {
                  total: importPreview.total ?? 0,
                  exists: importPreview.existsCount ?? 0,
                  neu: importPreview.newCount ?? 0,
                })}
              </Tag>
            </Space>
            <Radio.Group
              value={importConflictMode}
              onChange={(event) => setImportConflictMode(event.target.value)}
              options={[
                { label: tr('nacos_viewer.import.conflict_skip'), value: 'skip' },
                { label: tr('nacos_viewer.import.conflict_overwrite'), value: 'overwrite' },
              ]}
            />
            <Table
              size="small"
              rowKey="selectionKey"
              dataSource={importSelectionRows}
              pagination={{ pageSize: 8 }}
              rowSelection={{
                selectedRowKeys: importSelectedKeys,
                onChange: (keys) => setImportSelectedKeys(keys.map(String)),
              }}
              columns={[
                { title: tr('nacos_viewer.field.data_id'), dataIndex: 'dataId', ellipsis: true },
                { title: tr('nacos_viewer.field.group'), dataIndex: 'group', width: 140, ellipsis: true },
                {
                  title: tr('nacos_viewer.field.type'),
                  dataIndex: 'type',
                  width: 100,
                  render: (value: string) => value || '-',
                },
                {
                  title: tr('nacos_viewer.import.exists'),
                  dataIndex: 'exists',
                  width: 100,
                  render: (value: boolean) =>
                    value ? (
                      <Tag color="orange">{tr('nacos_viewer.import.exists_yes')}</Tag>
                    ) : (
                      <Tag color="green">{tr('nacos_viewer.import.exists_no')}</Tag>
                    ),
                },
              ]}
            />
          </div>
        ) : (
          <Spin />
        )}
      </Modal>
    </div>
  );
};

export default NacosViewer;
