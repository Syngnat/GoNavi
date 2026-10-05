import { type RedisListSortOrder, isRedisKeyGoneErrorMessage } from './redisViewerHelpers';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { message } from 'antd';
import { useCallback } from 'react';
import { applyRenamedRedisKeyState } from '../redisViewerTree';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisViewerStylesApi } from './useRedisViewerStyles';
import type { RedisViewerImportExportApi } from './useRedisViewerImportExport';
import type { RedisViewerKeyLoadingApi } from './useRedisViewerKeyLoading';
import type { RedisViewerProps } from '../RedisViewer';

export interface UseRedisViewerKeyActionsInput {
    listSortOrder: RedisViewerStateApi['listSortOrder'];
    setListSortOrder: RedisViewerStateApi['setListSortOrder'];
    getConfig: RedisViewerStylesApi['getConfig'];
    setValueLoading: RedisViewerStateApi['setValueLoading'];
    setKeyValue: RedisViewerStateApi['setKeyValue'];
    setSelectedKey: RedisViewerStateApi['setSelectedKey'];
    removeMissingKeyFromView: RedisViewerImportExportApi['removeMissingKeyFromView'];
    tr: RedisViewerStateApi['tr'];
    redisDB: RedisViewerProps['redisDB'];
    confirmRedisMutation: RedisViewerKeyLoadingApi['confirmRedisMutation'];
    setKeys: RedisViewerStateApi['setKeys'];
    selectedKey: RedisViewerStateApi['selectedKey'];
    setSelectedKeys: RedisViewerStateApi['setSelectedKeys'];
    ttlForm: RedisViewerStateApi['ttlForm'];
    setTtlModalOpen: RedisViewerStateApi['setTtlModalOpen'];
    handleRefresh: RedisViewerKeyLoadingApi['handleRefresh'];
    editValue: RedisViewerStateApi['editValue'];
    keyValue: RedisViewerStateApi['keyValue'];
    setEditModalOpen: RedisViewerStateApi['setEditModalOpen'];
    newKeyForm: RedisViewerStateApi['newKeyForm'];
    setNewKeyModalOpen: RedisViewerStateApi['setNewKeyModalOpen'];
    setTreeContextMenu: RedisViewerStateApi['setTreeContextMenu'];
    setRenameTargetKey: RedisViewerStateApi['setRenameTargetKey'];
    renameKeyForm: RedisViewerStateApi['renameKeyForm'];
    setRenameKeyModalOpen: RedisViewerStateApi['setRenameKeyModalOpen'];
    renameTargetKey: RedisViewerStateApi['renameTargetKey'];
    keys: RedisViewerStateApi['keys'];
    selectedKeys: RedisViewerStateApi['selectedKeys'];
}

export const useRedisViewerKeyActions = ({
    listSortOrder,
    setListSortOrder,
    getConfig,
    setValueLoading,
    setKeyValue,
    setSelectedKey,
    removeMissingKeyFromView,
    tr,
    redisDB,
    confirmRedisMutation,
    setKeys,
    selectedKey,
    setSelectedKeys,
    ttlForm,
    setTtlModalOpen,
    handleRefresh,
    editValue,
    keyValue,
    setEditModalOpen,
    newKeyForm,
    setNewKeyModalOpen,
    setTreeContextMenu,
    setRenameTargetKey,
    renameKeyForm,
    setRenameKeyModalOpen,
    renameTargetKey,
    keys,
    selectedKeys,
}: UseRedisViewerKeyActionsInput) => {
    const loadKeyValue = async (key: string, requestedListSortOrder: RedisListSortOrder = listSortOrder) => {
        const config = getConfig();
        if (!config) return;

        setValueLoading(true);
        try {
            const appApi = (window as any).go.app.App;
            const rpcConfig = buildRpcConnectionConfig(config);
            const res = requestedListSortOrder === 'descend'
                ? await appApi.RedisGetListValue(rpcConfig, key, true)
                : await appApi.RedisGetValue(rpcConfig, key);
            if (res.success) {
                setKeyValue(res.data);
                setSelectedKey(key);
                setListSortOrder(res.data?.type === 'list' ? requestedListSortOrder : null);
            } else {
                const messageText = String(res.message || '');
                if (isRedisKeyGoneErrorMessage(messageText)) {
                    removeMissingKeyFromView(key);
                    message.warning(tr('redis_viewer.message.key_missing_removed'));
                } else {
                    message.error(tr('redis_viewer.message.value_load_failed', { detail: messageText }));
                }
            }
        } catch (e: any) {
            const messageText = e?.message || String(e);
            if (isRedisKeyGoneErrorMessage(messageText)) {
                removeMissingKeyFromView(key);
                message.warning(tr('redis_viewer.message.key_missing_removed'));
            } else {
                message.error(tr('redis_viewer.message.value_load_failed', { detail: messageText }));
            }
        } finally {
            setValueLoading(false);
        }
    };

    const handleDeleteKeys = async (keysToDelete: string[]) => {
        const config = getConfig();
        if (!config) return;
        if (!await confirmRedisMutation(`db${redisDB} / ${keysToDelete.join(', ')}`)) return;

        try {
            const res = await (window as any).go.app.App.RedisDeleteKeys(buildRpcConnectionConfig(config), keysToDelete);
            if (res.success) {
                setKeys(prev => prev.filter(k => !keysToDelete.includes(k.key)));
                if (selectedKey && keysToDelete.includes(selectedKey)) {
                    setSelectedKey(null);
                    setKeyValue(null);
                    setListSortOrder(null);
                }
                setSelectedKeys([]);
                message.success(tr('redis_viewer.message.deleted_keys', { count: res.data.deleted }));
            } else {
                message.error(tr('redis_viewer.message.delete_failed', { detail: res.message }));
            }
        } catch (e: any) {
            message.error(tr('redis_viewer.message.delete_failed', { detail: e?.message || String(e) }));
        }
    };

    const handleDeleteCurrentKey = async () => {
        if (!selectedKey) return;
        await handleDeleteKeys([selectedKey]);
    };

    const handleSetTTL = async () => {
        const config = getConfig();
        if (!config || !selectedKey) return;

        try {
            const values = await ttlForm.validateFields();
            if (!await confirmRedisMutation(`db${redisDB} / ${selectedKey}`)) return;
            const res = await (window as any).go.app.App.RedisSetTTL(buildRpcConnectionConfig(config), selectedKey, values.ttl);
            if (res.success) {
                setTtlModalOpen(false);
                await Promise.all([loadKeyValue(selectedKey), handleRefresh()]);
                message.success(tr('redis_viewer.message.ttl_set_success'));
            } else {
                message.error(tr('redis_viewer.message.set_failed', { detail: res.message }));
            }
        } catch (e: any) {
            message.error(tr('redis_viewer.message.set_failed', { detail: e?.message || String(e) }));
        }
    };

    const handleSaveString = async () => {
        const config = getConfig();
        if (!config || !selectedKey) return;

        try {
            if (!await confirmRedisMutation(`db${redisDB} / ${selectedKey}`)) return;
            const res = await (window as any).go.app.App.RedisSetString(buildRpcConnectionConfig(config), selectedKey, editValue, keyValue?.ttl || -1);
            if (res.success) {
                setEditModalOpen(false);
                await loadKeyValue(selectedKey);
                message.success(tr('redis_viewer.message.save_success'));
            } else {
                message.error(tr('redis_viewer.message.save_failed', { detail: res.message }));
            }
        } catch (e: any) {
            message.error(tr('redis_viewer.message.save_failed', { detail: e?.message || String(e) }));
        }
    };

    const handleCreateKey = async () => {
        const config = getConfig();
        if (!config) return;

        try {
            const values = await newKeyForm.validateFields();
            if (!await confirmRedisMutation(`db${redisDB} / ${values.key}`)) return;
            const res = await (window as any).go.app.App.RedisSetString(buildRpcConnectionConfig(config), values.key, values.value, values.ttl || -1);
            if (res.success) {
                setNewKeyModalOpen(false);
                newKeyForm.resetFields();
                await handleRefresh();
                message.success(tr('redis_viewer.message.create_success'));
            } else {
                message.error(tr('redis_viewer.message.create_failed', { detail: res.message }));
            }
        } catch (e: any) {
            message.error(tr('redis_viewer.message.create_failed', { detail: e?.message || String(e) }));
        }
    };

    const openRenameKeyModal = useCallback((rawKey: string) => {
        setTreeContextMenu(null);
        setRenameTargetKey(rawKey);
        renameKeyForm.setFieldsValue({ key: rawKey });
        setRenameKeyModalOpen(true);
    }, [renameKeyForm]);

    const handleRenameKey = async () => {
        const config = getConfig();
        if (!config || !renameTargetKey) return;

        try {
            const values = await renameKeyForm.validateFields();
            const nextKey = String(values.key || '').trim();
            if (!nextKey) {
                message.warning(tr('redis_viewer.message.new_key_name_required'));
                return;
            }
            if (nextKey === renameTargetKey) {
                message.warning(tr('redis_viewer.message.rename_same_key'));
                return;
            }

            const existsRes = await (window as any).go.app.App.RedisKeyExists(buildRpcConnectionConfig(config), nextKey);
            if (!existsRes?.success) {
                message.error(tr('redis_viewer.message.key_check_failed', { detail: existsRes?.message || 'Unknown error' }));
                return;
            }
            if (existsRes?.data?.exists) {
                message.error(tr('redis_viewer.message.target_key_exists', { key: nextKey }));
                return;
            }
            if (!await confirmRedisMutation(`db${redisDB} / ${renameTargetKey} -> ${nextKey}`)) return;

            const res = await (window as any).go.app.App.RedisRenameKey(buildRpcConnectionConfig(config), renameTargetKey, nextKey);
            if (res.success) {
                const nextState = applyRenamedRedisKeyState(
                    {
                        keys,
                        selectedKey,
                        selectedKeys,
                    },
                    renameTargetKey,
                    nextKey
                );
                setKeys(nextState.keys);
                setSelectedKey(nextState.selectedKey);
                setSelectedKeys(Array.from(new Set(nextState.selectedKeys)));
                setRenameKeyModalOpen(false);
                setRenameTargetKey(null);
                renameKeyForm.resetFields();
                await Promise.all([
                    selectedKey === renameTargetKey ? loadKeyValue(nextKey) : Promise.resolve(),
                    handleRefresh(),
                ]);
                message.success(tr('redis_viewer.message.rename_success'));
            } else {
                message.error(tr('redis_viewer.message.rename_failed', { detail: res.message }));
            }
        } catch (e: any) {
            message.error(tr('redis_viewer.message.rename_failed', { detail: e?.message || String(e) }));
        }
    };

    const getTypeColor = (type: string) => {
        switch (type) {
            case 'string': return 'green';
            case 'hash': return 'blue';
            case 'list': return 'orange';
            case 'set': return 'purple';
            case 'zset': return 'magenta';
            case 'stream': return 'cyan';
            default: return 'default';
        }
    };

    const formatTTL = useCallback((ttl: number) => {
        if (ttl === -1) return tr('redis_viewer.ttl.forever');
        if (ttl === -2) return tr('redis_viewer.ttl.expired');
        if (ttl < 60) return tr('redis_viewer.ttl.seconds', { seconds: ttl });
        if (ttl < 3600) return tr('redis_viewer.ttl.minutes_seconds', { minutes: Math.floor(ttl / 60), seconds: ttl % 60 });
        if (ttl < 86400) return tr('redis_viewer.ttl.hours_minutes', { hours: Math.floor(ttl / 3600), minutes: Math.floor((ttl % 3600) / 60) });
        return tr('redis_viewer.ttl.days_hours', { days: Math.floor(ttl / 86400), hours: Math.floor((ttl % 86400) / 3600) });
    }, [tr]);
    return {
        loadKeyValue,
        handleDeleteKeys,
        handleDeleteCurrentKey,
        handleSetTTL,
        handleSaveString,
        handleCreateKey,
        openRenameKeyModal,
        handleRenameKey,
        getTypeColor,
        formatTTL,
    };
};

export type RedisViewerKeyActionsApi = ReturnType<typeof useRedisViewerKeyActions>;
