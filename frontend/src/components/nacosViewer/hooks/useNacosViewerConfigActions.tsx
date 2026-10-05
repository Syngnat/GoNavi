import { useCallback, useEffect, useMemo } from 'react';
import { message, Tooltip } from 'antd';
import {
  type NacosConfigItem,
  type NacosConfigDetail,
  nacosConfigChangedEventName,
  type NacosConfigChangedEvent,
} from '../nacosViewerModel';
import { nacosConfigSelectionKey, buildNacosImportSelectionRows } from '../../nacosConfigSelection';
import { EventsOn } from '../../../../wailsjs/runtime';
import { confirmProductionMutation } from '../../../utils/productionRiskConfirm';
import type { NacosViewerStateApi } from './useNacosViewerState';
import type { NacosViewerProps } from '../nacosViewerModel';

export interface UseNacosViewerConfigActionsInput {
  connectionId: NacosViewerProps['connectionId'];
  namespaceId: NacosViewerProps['namespaceId'];
  rpcConfig: NacosViewerStateApi['rpcConfig'];
  selectionGenerationRef: NacosViewerStateApi['selectionGenerationRef'];
  stopListen: NacosViewerStateApi['stopListen'];
  selectionContextRef: NacosViewerStateApi['selectionContextRef'];
  setLoadingDetail: NacosViewerStateApi['setLoadingDetail'];
  tr: NacosViewerStateApi['tr'];
  detailRef: NacosViewerStateApi['detailRef'];
  draftDirtyRef: NacosViewerStateApi['draftDirtyRef'];
  setDetail: NacosViewerStateApi['setDetail'];
  setDraftContent: NacosViewerStateApi['setDraftContent'];
  setDraftType: NacosViewerStateApi['setDraftType'];
  setDraftDirty: NacosViewerStateApi['setDraftDirty'];
  setRemoteChanged: NacosViewerStateApi['setRemoteChanged'];
  setPublishMode: NacosViewerStateApi['setPublishMode'];
  setSelectedKey: NacosViewerStateApi['setSelectedKey'];
  startListen: NacosViewerStateApi['startListen'];
  loadBetaMeta: NacosViewerStateApi['loadBetaMeta'];
  initialGroup: NacosViewerProps['initialGroup'];
  setListenActive: NacosViewerStateApi['setListenActive'];
  setBetaExists: NacosViewerStateApi['setBetaExists'];
  setBetaIps: NacosViewerStateApi['setBetaIps'];
  setFilterGroup: NacosViewerStateApi['setFilterGroup'];
  setDataIdSuggestions: NacosViewerStateApi['setDataIdSuggestions'];
  setSelectedRowKeys: NacosViewerStateApi['setSelectedRowKeys'];
  loadList: NacosViewerStateApi['loadList'];
  loadFilterSuggestions: NacosViewerStateApi['loadFilterSuggestions'];
  listBodyRef: NacosViewerStateApi['listBodyRef'];
  setListScrollY: NacosViewerStateApi['setListScrollY'];
  items: NacosViewerStateApi['items'];
  pageSize: NacosViewerStateApi['pageSize'];
  totalCount: NacosViewerStateApi['totalCount'];
  dataIdSuggestions: NacosViewerStateApi['dataIdSuggestions'];
  groupSuggestions: NacosViewerStateApi['groupSuggestions'];
  watchIdRef: NacosViewerStateApi['watchIdRef'];
  mountedRef: NacosViewerStateApi['mountedRef'];
  detail: NacosViewerStateApi['detail'];
  readOnly: NacosViewerStateApi['readOnly'];
  publishMode: NacosViewerStateApi['publishMode'];
  betaIps: NacosViewerStateApi['betaIps'];
  connection: NacosViewerStateApi['connection'];
  setPublishing: NacosViewerStateApi['setPublishing'];
  draftContent: NacosViewerStateApi['draftContent'];
  draftType: NacosViewerStateApi['draftType'];
  pageNo: NacosViewerStateApi['pageNo'];
  namespaceName: NacosViewerProps['namespaceName'];
  selectedItems: NacosViewerStateApi['selectedItems'];
  setExporting: NacosViewerStateApi['setExporting'];
  importRestricted: NacosViewerStateApi['importRestricted'];
  setImportPreview: NacosViewerStateApi['setImportPreview'];
  setImportSelectedKeys: NacosViewerStateApi['setImportSelectedKeys'];
  setImportConflictMode: NacosViewerStateApi['setImportConflictMode'];
  setImportModalOpen: NacosViewerStateApi['setImportModalOpen'];
}

export const useNacosViewerConfigActions = ({
  connectionId, namespaceId, rpcConfig, selectionGenerationRef, stopListen, selectionContextRef,
  setLoadingDetail, tr, detailRef, draftDirtyRef, setDetail, setDraftContent, setDraftType,
  setDraftDirty, setRemoteChanged, setPublishMode, setSelectedKey, startListen, loadBetaMeta,
  initialGroup, setListenActive, setBetaExists, setBetaIps, setFilterGroup, setDataIdSuggestions,
  setSelectedRowKeys, loadList, loadFilterSuggestions, listBodyRef, setListScrollY, items, pageSize,
  totalCount, dataIdSuggestions, groupSuggestions, watchIdRef, mountedRef, detail, readOnly,
  publishMode, betaIps, connection, setPublishing, draftContent, draftType, pageNo, namespaceName,
  selectedItems, setExporting, importRestricted, setImportPreview, setImportSelectedKeys,
  setImportConflictMode, setImportModalOpen,
}: UseNacosViewerConfigActionsInput) => {
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
  }, [items.length, pageSize, totalCount]);

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
    if (!await confirmProductionMutation(
      connection,
      tr('connection.production_risk.action.modify_configuration'),
      [namespaceId, detail.dataId, detail.group].filter(Boolean).join(' / '),
      tr,
    )) return;
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
      setDraftDirty(false);
      setRemoteChanged(false);
      await loadList(pageNo);
      await loadDetail({
        dataId: publishTarget.dataId,
        group: publishTarget.group,
        type: draftType,
      });
      await loadBetaMeta({ dataId: publishTarget.dataId, group: publishTarget.group });
      message.success(
        publishMode === 'beta'
          ? tr('nacos_viewer.message.beta_publish_success')
          : tr('nacos_viewer.message.publish_success'),
      );
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
    if (!await confirmProductionMutation(
      connection,
      tr('connection.production_risk.action.modify_configuration'),
      [namespaceId, detail.dataId, detail.group].filter(Boolean).join(' / '),
      tr,
    )) return;
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
      setBetaExists(false);
      setBetaIps('');
      setPublishMode('formal');
      message.success(tr('nacos_viewer.message.beta_stop_success'));
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
  return {
    loadDetail, fuzzyFilterOption, dataIdAutoOptions, groupAutoOptions, handlePublish,
    handleStopBeta, handleLoadBetaContent, handleExport, handlePreviewImport,
  };
};

export type NacosViewerConfigActionsApi = ReturnType<typeof useNacosViewerConfigActions>;
