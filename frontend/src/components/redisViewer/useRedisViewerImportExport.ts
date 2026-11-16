import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    type RedisImportProgress,
    type RedisExportScope,
    type RedisImportPreview,
    getRedisScanLoadCount,
} from './redisViewerHelpers';
import { message } from 'antd';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { useExportProgressRunner } from '../useExportProgressRunner';
import { EventsOn } from '../../../wailsjs/runtime/runtime';
import { CancelImportJob } from '../../../wailsjs/go/app/App';
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
    importingKeys: RedisViewerStateApi['importingKeys'];
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

const buildRedisTransferJobID = (operation: 'export' | 'import'): string => (
    `redis-${operation}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
);

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
    importingKeys,
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
    const {
        state: exportProgressState,
        reset: resetExportProgress,
        cancelExport,
        runExportWithProgress,
    } = useExportProgressRunner({ showToast: false });
    const [importProgress, setImportProgress] = useState<RedisImportProgress | null>(null);
    const [cancellingImport, setCancellingImport] = useState(false);
    const activeImportJobIDRef = useRef('');

    useEffect(() => {
        if (!importingKeys) return undefined;
        if (!(window as any)?.runtime?.EventsOnMultiple) return undefined;
        try {
            return EventsOn('import:progress', (data: Record<string, unknown>) => {
                if (String(data?.jobId || '').trim() !== activeImportJobIDRef.current) return;
                setImportProgress((prev) => ({
                    current: Math.max(0, Math.trunc(Number(data.current ?? prev?.current) || 0)),
                    total: Math.max(0, Math.trunc(Number(data.total ?? prev?.total) || 0)),
                    success: Math.max(0, Math.trunc(Number(data.success ?? prev?.success) || 0)),
                    skipped: Math.max(0, Math.trunc(Number(data.skipped ?? prev?.skipped) || 0)),
                    stage: String(data.stage || prev?.stage || ''),
                    status: prev?.status === 'cancelling' ? 'cancelling' : 'running',
                }));
            });
        } catch {
            return undefined;
        }
    }, [importingKeys]);

    const handleExportKeys = useCallback(async (scope: RedisExportScope) => {
        const config = getConfig();
        if (!config) return;

        if (scope === 'selected' && selectedKeys.length === 0) {
            message.warning(tr('redis_viewer.message.export_selection_required'));
            return;
        }

        setExportingScope(scope);
        try {
            const res = await runExportWithProgress({
                title: scope === 'selected'
                    ? tr('redis_viewer.action.export_selected')
                    : tr('redis_viewer.action.export_all'),
                targetName: `db${redisDB} / ${scope === 'selected' ? selectedKeys.length : 'Redis Keys'}`,
                format: 'JSON',
                totalRows: scope === 'selected' ? selectedKeys.length : undefined,
                run: (jobId) => (window as any).go.app.App.RedisExportKeys(
                    buildRpcConnectionConfig(config),
                    {
                        jobId,
                        scope,
                        keys: scope === 'selected' ? selectedKeys : [],
                        pattern: searchPattern,
                    },
                ),
            });
            if (!res) return;
            if (res.success) {
                const responseData = (res.data || {}) as Record<string, unknown>;
                const exportedCount = Number(responseData.exported ?? (scope === 'selected' ? selectedKeys.length : 0));
                message.success(tr('redis_viewer.message.export_success', { count: exportedCount }));
                return;
            }
            const canceled = (res.data as { canceled?: unknown } | undefined)?.canceled === true;
            if (canceled) {
                message.info(res.message || tr('data_export.progress.title.cancelled'));
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
    }, [getConfig, redisDB, runExportWithProgress, searchPattern, selectedKeys, tr]);

    const resetImportModalState = useCallback(() => {
        activeImportJobIDRef.current = '';
        setImportProgress(null);
        setCancellingImport(false);
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
        activeImportJobIDRef.current = '';
        setImportProgress(null);
        setCancellingImport(false);
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

        const scope = importSelectedKeys.length === importPreview.keys.length ? 'all' : 'selected';
        const jobId = buildRedisTransferJobID('import');
        activeImportJobIDRef.current = jobId;
        setCancellingImport(false);
        setImportProgress({
            current: 0,
            total: scope === 'all' ? importPreview.keys.length : importSelectedKeys.length,
            success: 0,
            skipped: 0,
            stage: tr('redis_viewer.state.import_preparing'),
            status: 'running',
        });
        setImportingKeys(true);
        try {
            const res = await (window as any).go.app.App.RedisImportKeys(
                buildRpcConnectionConfig(config),
                {
                    jobId,
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
            const resultData = (res?.data || {}) as Record<string, unknown>;
            if (resultData.canceled === true) {
                const imported = Math.max(0, Number(resultData.imported) || 0);
                const skipped = Math.max(0, Number(resultData.skipped) || 0);
                setImportProgress((prev) => prev ? {
                    ...prev,
                    current: imported + skipped,
                    total: Math.max(prev.total, Math.max(0, Number(resultData.total) || 0)),
                    success: imported,
                    skipped,
                    stage: res?.message || prev.stage,
                    status: 'cancelled',
                } : prev);
                message.info(res?.message || tr('redis_viewer.message.import_cancelled'));
                return;
            }
            if (String(res?.message || '').trim() === '已取消') {
                return;
            }
            setImportProgress((prev) => prev ? {
                ...prev,
                stage: res?.message || prev.stage,
                status: 'error',
            } : prev);
            message.error(tr('redis_viewer.message.import_failed', { detail: res?.message || 'Unknown error' }));
        } catch (e: any) {
            setImportProgress((prev) => prev ? {
                ...prev,
                stage: e?.message || String(e),
                status: 'error',
            } : prev);
            message.error(tr('redis_viewer.message.import_failed', { detail: e?.message || String(e) }));
        } finally {
            setImportingKeys(false);
            setCancellingImport(false);
            if (activeImportJobIDRef.current === jobId) {
                activeImportJobIDRef.current = '';
            }
        }
    }, [confirmRedisMutation, getConfig, importConflictMode, importPreview, importSelectedKeys, loadKeys, redisDB, redisTopology, resetImportModalState, searchMode, searchPattern, tr]);

    const handleCancelImport = useCallback(async () => {
        const jobId = activeImportJobIDRef.current;
        if (!jobId || !importingKeys || cancellingImport) return;
        setCancellingImport(true);
        setImportProgress((prev) => prev ? {
            ...prev,
            stage: tr('redis_viewer.state.import_cancelling'),
            status: 'cancelling',
        } : prev);
        try {
            const res = await CancelImportJob(jobId);
            if (res?.success) return;
            setCancellingImport(false);
            setImportProgress((prev) => prev ? { ...prev, status: 'running' } : prev);
            if (res?.message) {
                message.warning(res.message);
            }
        } catch (e: any) {
            setCancellingImport(false);
            setImportProgress((prev) => prev ? { ...prev, status: 'running' } : prev);
            message.warning(e?.message || String(e));
        }
    }, [cancellingImport, importingKeys, tr]);

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
        handleCancelImport,
        importProgress,
        cancellingImport,
        exportProgressState,
        cancelExport,
        resetExportProgress,
        importSelectedKeySet,
        handleToggleImportPreviewKey,
        handleSelectAllImportPreviewKeys,
        handleClearImportPreviewSelection,
        removeMissingKeyFromView,
    };
};

export type RedisViewerImportExportApi = ReturnType<typeof useRedisViewerImportExport>;
