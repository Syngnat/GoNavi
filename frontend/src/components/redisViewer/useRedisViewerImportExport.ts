import { useCallback, useMemo } from 'react';
import {
    type RedisExportScope,
    type RedisImportPreview,
    getRedisScanLoadCount,
} from './redisViewerHelpers';
import { message } from 'antd';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { downloadBrowserFileFromResult } from '../../utils/browserFileTransfer';
import type { RedisViewerStylesApi } from './useRedisViewerStyles';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisViewerKeyLoadingApi } from './useRedisViewerKeyLoading';
import type { RedisViewerProps } from '../RedisViewer';

export interface UseRedisViewerImportExportInput {
    getConfig: RedisViewerStylesApi['getConfig'];
    selectedKeys: RedisViewerStateApi['selectedKeys'];
    tr: RedisViewerStateApi['tr'];
    setExportingScope: RedisViewerStateApi['setExportingScope'];
    searchPattern: RedisViewerStateApi['searchPattern'];
    setImportModalOpen: RedisViewerStateApi['setImportModalOpen'];
    setImportPreview: RedisViewerStateApi['setImportPreview'];
    setImportSelectedKeys: RedisViewerStateApi['setImportSelectedKeys'];
    setImportPreviewLoading: RedisViewerStateApi['setImportPreviewLoading'];
    setImportConflictMode: RedisViewerStateApi['setImportConflictMode'];
    redisDB: RedisViewerProps['redisDB'];
    importPreview: RedisViewerStateApi['importPreview'];
    importSelectedKeys: RedisViewerStateApi['importSelectedKeys'];
    confirmRedisMutation: RedisViewerKeyLoadingApi['confirmRedisMutation'];
    setImportingKeys: RedisViewerStateApi['setImportingKeys'];
    importConflictMode: RedisViewerStateApi['importConflictMode'];
    setSelectedKeys: RedisViewerStateApi['setSelectedKeys'];
    setSelectedKey: RedisViewerStateApi['setSelectedKey'];
    setKeyValue: RedisViewerStateApi['setKeyValue'];
    setListSortOrder: RedisViewerStateApi['setListSortOrder'];
    setCursor: RedisViewerStateApi['setCursor'];
    loadKeys: RedisViewerKeyLoadingApi['loadKeys'];
    redisTopology: RedisViewerStateApi['redisTopology'];
    searchMode: RedisViewerStateApi['searchMode'];
    setKeys: RedisViewerStateApi['setKeys'];
}

export const useRedisViewerImportExport = ({
    getConfig,
    selectedKeys,
    tr,
    setExportingScope,
    searchPattern,
    setImportModalOpen,
    setImportPreview,
    setImportSelectedKeys,
    setImportPreviewLoading,
    setImportConflictMode,
    redisDB,
    importPreview,
    importSelectedKeys,
    confirmRedisMutation,
    setImportingKeys,
    importConflictMode,
    setSelectedKeys,
    setSelectedKey,
    setKeyValue,
    setListSortOrder,
    setCursor,
    loadKeys,
    redisTopology,
    searchMode,
    setKeys,
}: UseRedisViewerImportExportInput) => {
    const handleExportKeys = useCallback(async (scope: RedisExportScope) => {
        const config = getConfig();
        if (!config) return;

        if (scope === 'selected' && selectedKeys.length === 0) {
            message.warning(tr('redis_viewer.message.export_selection_required'));
            return;
        }

        setExportingScope(scope);
        try {
            const res = await (window as any).go.app.App.RedisExportKeys(
                buildRpcConnectionConfig(config),
                {
                    scope,
                    keys: scope === 'selected' ? selectedKeys : [],
                    pattern: searchPattern,
                },
            );
            if (res?.success) {
                if (!downloadBrowserFileFromResult(res)) {
                    message.error(tr('redis_viewer.message.export_failed', { detail: 'Browser download is unavailable' }));
                    return;
                }
                const exportedCount = Number(res?.data?.exported ?? (scope === 'selected' ? selectedKeys.length : 0));
                message.success(tr('redis_viewer.message.export_success', { count: exportedCount }));
                return;
            }
            if (String(res?.message || '').trim() === '已取消') {
                return;
            }
            message.error(tr('redis_viewer.message.export_failed', { detail: res?.message || 'Unknown error' }));
        } catch (e: any) {
            message.error(tr('redis_viewer.message.export_failed', { detail: e?.message || String(e) }));
        } finally {
            setExportingScope(null);
        }
    }, [getConfig, searchPattern, selectedKeys, tr]);

    const resetImportModalState = useCallback(() => {
        setImportModalOpen(false);
        setImportPreview(null);
        setImportSelectedKeys([]);
        setImportPreviewLoading(false);
        setImportConflictMode('overwrite');
    }, []);

    const handleChooseImportFile = useCallback(async () => {
        const config = getConfig();
        if (!config) return;

        setImportPreviewLoading(true);
        try {
            const res = await (window as any).go.app.App.RedisPreviewImportKeys(
                buildRpcConnectionConfig(config),
            );
            if (res?.success) {
                const previewData = (res.data || {}) as RedisImportPreview;
                const previewKeys = Array.isArray(previewData.keys) ? previewData.keys : [];
                const nextPreview: RedisImportPreview = {
                    file: String(previewData.file || '').trim(),
                    exportedAt: previewData.exportedAt,
                    database: Number(previewData.database ?? redisDB),
                    scope: String(previewData.scope || '').trim(),
                    pattern: String(previewData.pattern || '').trim(),
                    sourceAppName: String(previewData.sourceAppName || '').trim(),
                    total: Number(previewData.total ?? previewKeys.length),
                    keys: previewKeys,
                };
                setImportPreview(nextPreview);
                setImportSelectedKeys(previewKeys.map((item) => item.key));
                return;
            }
            if (String(res?.message || '').trim() === '已取消') {
                return;
            }
            message.error(tr('redis_viewer.message.import_failed', { detail: res?.message || 'Unknown error' }));
        } catch (e: any) {
            message.error(tr('redis_viewer.message.import_failed', { detail: e?.message || String(e) }));
        } finally {
            setImportPreviewLoading(false);
        }
    }, [getConfig, redisDB, tr]);

    const handleOpenImportModal = useCallback(() => {
        setImportModalOpen(true);
        setImportPreview(null);
        setImportSelectedKeys([]);
        setImportPreviewLoading(false);
        setImportConflictMode('overwrite');
    }, []);

    const handleConfirmImportKeys = useCallback(async () => {
        const config = getConfig();
        if (!config) return;
        if (!importPreview) {
            message.warning(tr('redis_viewer.message.import_file_required'));
            return;
        }
        if (importSelectedKeys.length === 0) {
            message.warning(tr('redis_viewer.message.import_selection_required'));
            return;
        }
        if (!await confirmRedisMutation(`db${redisDB} / ${importPreview.file}`)) return;

        setImportingKeys(true);
        try {
            const scope = importSelectedKeys.length === importPreview.keys.length ? 'all' : 'selected';
            const res = await (window as any).go.app.App.RedisImportKeys(
                buildRpcConnectionConfig(config),
                {
                    conflictMode: importConflictMode,
                    file: importPreview.file,
                    scope,
                    keys: scope === 'selected' ? importSelectedKeys : [],
                },
            );
            if (res?.success) {
                const imported = Number(res?.data?.imported ?? 0);
                const skipped = Number(res?.data?.skipped ?? 0);
                resetImportModalState();
                setSelectedKeys([]);
                setSelectedKey(null);
                setKeyValue(null);
                setListSortOrder(null);
                setCursor('0');
                await loadKeys(
                    searchPattern,
                    '0',
                    false,
                    getRedisScanLoadCount(searchPattern, false, redisTopology === 'cluster'),
                    searchMode !== 'exact' && searchPattern !== '*'
                );
                message.success(tr('redis_viewer.message.import_summary', {
                    imported,
                    skipped,
                }));
                return;
            }
            if (String(res?.message || '').trim() === '已取消') {
                return;
            }
            message.error(tr('redis_viewer.message.import_failed', { detail: res?.message || 'Unknown error' }));
        } catch (e: any) {
            message.error(tr('redis_viewer.message.import_failed', { detail: e?.message || String(e) }));
        } finally {
            setImportingKeys(false);
        }
    }, [confirmRedisMutation, getConfig, importConflictMode, importPreview, importSelectedKeys, loadKeys, redisDB, redisTopology, resetImportModalState, searchMode, searchPattern, tr]);

    const importSelectedKeySet = useMemo(() => new Set(importSelectedKeys), [importSelectedKeys]);
    const handleToggleImportPreviewKey = useCallback((key: string, checked: boolean) => {
        setImportSelectedKeys((prev) => {
            if (checked) {
                return prev.includes(key) ? prev : [...prev, key];
            }
            return prev.filter((item) => item !== key);
        });
    }, []);
    const handleSelectAllImportPreviewKeys = useCallback(() => {
        if (!importPreview) return;
        setImportSelectedKeys(importPreview.keys.map((item) => item.key));
    }, [importPreview]);
    const handleClearImportPreviewSelection = useCallback(() => {
        setImportSelectedKeys([]);
    }, []);

    const removeMissingKeyFromView = useCallback((missingKey: string) => {
        setKeys(prev => prev.filter(item => item.key !== missingKey));
        setSelectedKeys(prev => prev.filter(item => item !== missingKey));
        setSelectedKey(null);
        setKeyValue(null);
        setListSortOrder(null);
    }, []);
    return {
        handleExportKeys,
        resetImportModalState,
        handleChooseImportFile,
        handleOpenImportModal,
        handleConfirmImportKeys,
        importSelectedKeySet,
        handleToggleImportPreviewKey,
        handleSelectAllImportPreviewKeys,
        handleClearImportPreviewSelection,
        removeMissingKeyFromView,
    };
};

export type RedisViewerImportExportApi = ReturnType<typeof useRedisViewerImportExport>;
