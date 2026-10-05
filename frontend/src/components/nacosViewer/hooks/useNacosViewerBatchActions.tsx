import { message } from 'antd';
import { useCallback } from 'react';
import { confirmProductionMutation } from '../../../utils/productionRiskConfirm';
import {
  selectedNacosImportItems,
  deleteSelectedNacosConfigs,
  nacosConfigSelectionKey,
} from '../../nacosConfigSelection';
import type { NacosHistoryPage, NacosHistoryItem, NacosConfigItem } from '../nacosViewerModel';
import { NacosConfigRow } from '../../nacos/NacosConfigPinning';
import type { NacosViewerStateApi } from './useNacosViewerState';
import type { NacosViewerConfigActionsApi } from './useNacosViewerConfigActions';
import type { NacosViewerProps } from '../nacosViewerModel';

export interface UseNacosViewerBatchActionsInput {
  namespaceId: NacosViewerProps['namespaceId'];
  rpcConfig: NacosViewerStateApi['rpcConfig'];
  importPreview: NacosViewerStateApi['importPreview'];
  setImportPreview: NacosViewerStateApi['setImportPreview'];
  importRestricted: NacosViewerStateApi['importRestricted'];
  connection: NacosViewerStateApi['connection'];
  tr: NacosViewerStateApi['tr'];
  setImporting: NacosViewerStateApi['setImporting'];
  importSelectedKeys: NacosViewerStateApi['importSelectedKeys'];
  importConflictMode: NacosViewerStateApi['importConflictMode'];
  setImportModalOpen: NacosViewerStateApi['setImportModalOpen'];
  loadList: NacosViewerStateApi['loadList'];
  detail: NacosViewerStateApi['detail'];
  loadDetail: NacosViewerConfigActionsApi['loadDetail'];
  draftType: NacosViewerStateApi['draftType'];
  detailRef: NacosViewerStateApi['detailRef'];
  draftDirtyRef: NacosViewerStateApi['draftDirtyRef'];
  setDetail: NacosViewerStateApi['setDetail'];
  setSelectedKey: NacosViewerStateApi['setSelectedKey'];
  setDraftContent: NacosViewerStateApi['setDraftContent'];
  setDraftDirty: NacosViewerStateApi['setDraftDirty'];
  setRemoteChanged: NacosViewerStateApi['setRemoteChanged'];
  setBetaExists: NacosViewerStateApi['setBetaExists'];
  setBetaIps: NacosViewerStateApi['setBetaIps'];
  selectedItems: NacosViewerStateApi['selectedItems'];
  readOnly: NacosViewerStateApi['readOnly'];
  setDeletingSelected: NacosViewerStateApi['setDeletingSelected'];
  setSelectedRowKeys: NacosViewerStateApi['setSelectedRowKeys'];
  stopListen: NacosViewerStateApi['stopListen'];
  totalCount: NacosViewerStateApi['totalCount'];
  pageSize: NacosViewerStateApi['pageSize'];
  pageNo: NacosViewerStateApi['pageNo'];
  newForm: NacosViewerStateApi['newForm'];
  setNewModalOpen: NacosViewerStateApi['setNewModalOpen'];
  setHistoryLoading: NacosViewerStateApi['setHistoryLoading'];
  setHistoryItems: NacosViewerStateApi['setHistoryItems'];
  setHistoryTotal: NacosViewerStateApi['setHistoryTotal'];
  setHistoryPageNo: NacosViewerStateApi['setHistoryPageNo'];
  setHistoryOpen: NacosViewerStateApi['setHistoryOpen'];
  setHistoryDetailOpen: NacosViewerStateApi['setHistoryDetailOpen'];
  setHistoryDetailLoading: NacosViewerStateApi['setHistoryDetailLoading'];
  setHistoryDetail: NacosViewerStateApi['setHistoryDetail'];
  setRollingBack: NacosViewerStateApi['setRollingBack'];
  connectionId: NacosViewerProps['connectionId'];
  namespaceName: NacosViewerProps['namespaceName'];
  draftDirty: NacosViewerStateApi['draftDirty'];
}

export const useNacosViewerBatchActions = ({
  namespaceId, rpcConfig, importPreview, setImportPreview, importRestricted, connection, tr,
  setImporting, importSelectedKeys, importConflictMode, setImportModalOpen, loadList, detail,
  loadDetail, draftType, detailRef, draftDirtyRef, setDetail, setSelectedKey, setDraftContent,
  setDraftDirty, setRemoteChanged, setBetaExists, setBetaIps, selectedItems, readOnly,
  setDeletingSelected, setSelectedRowKeys, stopListen, totalCount, pageSize, pageNo, newForm,
  setNewModalOpen, setHistoryLoading, setHistoryItems, setHistoryTotal, setHistoryPageNo,
  setHistoryOpen, setHistoryDetailOpen, setHistoryDetailLoading, setHistoryDetail, setRollingBack,
  connectionId, namespaceName, draftDirty,
}: UseNacosViewerBatchActionsInput) => {
  const handleImport = async () => {
    if (!rpcConfig || !importPreview || importRestricted) return;
    if (!await confirmProductionMutation(
      connection,
      tr('connection.production_risk.action.modify_configuration'),
      [namespaceId, importPreview.file].filter(Boolean).join(' / '),
      tr,
    )) return;
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
      setImportModalOpen(false);
      setImportPreview(null);
      await loadList(1);
      message.success(tr('nacos_viewer.message.import_success', {
        imported: res?.data?.imported ?? 0,
        skipped: res?.data?.skipped ?? 0,
      }));
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
    if (!await confirmProductionMutation(
      connection,
      tr('connection.production_risk.action.modify_configuration'),
      `${namespaceId || 'public'} / ${selectedItems.length} configs`,
      tr,
    )) return;

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
    if (!await confirmProductionMutation(
      connection,
      tr('connection.production_risk.action.modify_configuration'),
      [namespaceId, detail.dataId, detail.group].filter(Boolean).join(' / '),
      tr,
    )) return;
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
      const deletedKey = nacosConfigSelectionKey(detail);
      setSelectedRowKeys((keys) => keys.filter((key) => String(key) !== deletedKey));
      await stopListen();
      resetDetailState();
      const remainingTotal = Math.max(0, totalCount - 1);
      const lastPage = Math.max(1, Math.ceil(remainingTotal / pageSize));
      await loadList(Math.min(pageNo, lastPage));
      message.success(tr('nacos_viewer.message.delete_success'));
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
      if (!await confirmProductionMutation(
        connection,
        tr('connection.production_risk.action.modify_configuration'),
        [namespaceId, dataId, group].filter(Boolean).join(' / '),
        tr,
      )) return;
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
      setNewModalOpen(false);
      newForm.resetFields();
      await loadList(1);
      await loadDetail({ dataId, group, type });
      message.success(tr('nacos_viewer.message.publish_success'));
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
    if (!await confirmProductionMutation(
      connection,
      tr('connection.production_risk.action.modify_configuration'),
      [namespaceId, detail.dataId, detail.group, item.id].filter(Boolean).join(' / '),
      tr,
    )) return;
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
      setHistoryOpen(false);
      setHistoryDetailOpen(false);
      await loadList(pageNo);
      await loadDetail({
        dataId: detail.dataId,
        group: detail.group,
        type: draftType || detail.type,
      });
      message.success(tr('nacos_viewer.message.rollback_success'));
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
        <NacosConfigRow row={row} connectionId={connectionId} namespaceId={namespaceId} tr={tr} />
      ),
    },
  ];

  const namespaceLabel = namespaceName || (namespaceId ? namespaceId : 'public');
  const remoteChangedHint = draftDirty
    ? tr('nacos_viewer.message.remote_changed_dirty_hint')
    : tr('nacos_viewer.message.remote_changed_clean_hint');
  return {
    handleImport, handleReloadRemote, handleDeleteSelected, handleDelete, handleCreate, loadHistory,
    openHistory, openHistoryDetail, handleRollback, columns, namespaceLabel, remoteChangedHint,
  };
};

export type NacosViewerBatchActionsApi = ReturnType<typeof useNacosViewerBatchActions>;
