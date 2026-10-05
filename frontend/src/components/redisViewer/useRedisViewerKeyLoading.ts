import React, { useCallback, useEffect } from 'react';
import { confirmProductionMutation } from '../../utils/productionRiskConfirm';
import { RedisKeyInfo } from '../../types';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import {
    normalizeRedisCursor,
    getRedisScanLoadCount,
    REDIS_KEY_SEARCH_MAX_RESULT_COUNT,
    mergeRedisKeyInfoLists,
} from './redisViewerHelpers';
import { message, type RadioChangeEvent } from 'antd';
import {
    type RedisSearchMode,
    normalizeRedisSearchInput,
    normalizeRedisSearchDraftChange,
} from '../../utils/redisSearchPattern';
import type { RedisViewerStateApi } from './useRedisViewerState';
import type { RedisViewerStylesApi } from './useRedisViewerStyles';
import type { RedisViewerProps } from '../RedisViewer';

export interface UseRedisViewerKeyLoadingInput {
    connection: RedisViewerStateApi['connection'];
    tr: RedisViewerStateApi['tr'];
    getConfig: RedisViewerStylesApi['getConfig'];
    redisTopology: RedisViewerStateApi['redisTopology'];
    latestLoadRequestIdRef: RedisViewerStateApi['latestLoadRequestIdRef'];
    setLoading: RedisViewerStateApi['setLoading'];
    setLoadingAllKeys: RedisViewerStateApi['setLoadingAllKeys'];
    setKeys: RedisViewerStateApi['setKeys'];
    setCursor: RedisViewerStateApi['setCursor'];
    setHasMore: RedisViewerStateApi['setHasMore'];
    redisDB: RedisViewerProps['redisDB'];
    searchPattern: RedisViewerStateApi['searchPattern'];
    searchMode: RedisViewerStateApi['searchMode'];
    setSearchInput: RedisViewerStateApi['setSearchInput'];
    setSearchPattern: RedisViewerStateApi['setSearchPattern'];
    setSearchMode: RedisViewerStateApi['setSearchMode'];
    searchInput: RedisViewerStateApi['searchInput'];
    hasMore: RedisViewerStateApi['hasMore'];
    loading: RedisViewerStateApi['loading'];
    cursor: RedisViewerStateApi['cursor'];
    setSelectedKeys: RedisViewerStateApi['setSelectedKeys'];
    keys: RedisViewerStateApi['keys'];
}

export const useRedisViewerKeyLoading = ({
    connection,
    tr,
    getConfig,
    redisTopology,
    latestLoadRequestIdRef,
    setLoading,
    setLoadingAllKeys,
    setKeys,
    setCursor,
    setHasMore,
    redisDB,
    searchPattern,
    searchMode,
    setSearchInput,
    setSearchPattern,
    setSearchMode,
    searchInput,
    hasMore,
    loading,
    cursor,
    setSelectedKeys,
    keys,
}: UseRedisViewerKeyLoadingInput) => {
    const confirmRedisMutation = useCallback((target: string) => (
        confirmProductionMutation(
            connection,
            tr('connection.production_risk.action.modify_data'),
            target,
            tr,
        )
    ), [connection, tr]);

    const scanRedisKeysPage = useCallback(async (
        config: Record<string, any>,
        pattern: string,
        fromCursor: string,
        targetCount: number
    ): Promise<{ scannedKeys: RedisKeyInfo[]; nextCursor: string }> => {
        const res = await (window as any).go.app.App.RedisScanKeys(
            buildRpcConnectionConfig(config),
            pattern,
            fromCursor,
            targetCount
        );
        if (!res?.success) {
            throw new Error(String(res?.message || 'Unknown error'));
        }
        const result = res.data;
        return {
            scannedKeys: Array.isArray(result?.keys) ? result.keys : [],
            nextCursor: normalizeRedisCursor(result?.cursor),
        };
    }, []);

    const loadKeys = useCallback(async (
        pattern: string = '*',
        fromCursor: string = '0',
        append: boolean = false,
        targetCount?: number,
        scanToCompletion: boolean = false
    ) => {
        const config = getConfig();
        if (!config) return;

        const normalizedPattern = pattern.trim() || '*';
        const effectiveTargetCount = targetCount ?? getRedisScanLoadCount(normalizedPattern, append, redisTopology === 'cluster');
        const requestId = latestLoadRequestIdRef.current + 1;
        latestLoadRequestIdRef.current = requestId;

        setLoading(true);
        setLoadingAllKeys(false);
        try {
            let scanCursor = normalizeRedisCursor(fromCursor);
            let scannedKeys: RedisKeyInfo[] = [];
            let nextCursor = scanCursor;
            const keyMap = new Map<string, RedisKeyInfo>();
            const visitedCursors = new Set<string>();

            while (true) {
                if (visitedCursors.has(scanCursor)) {
                    throw new Error(`Redis scan cursor repeated: ${scanCursor}`);
                }
                visitedCursors.add(scanCursor);

                const page = await scanRedisKeysPage(
                    config,
                    normalizedPattern,
                    scanCursor,
                    effectiveTargetCount
                );
                if (requestId !== latestLoadRequestIdRef.current) {
                    return;
                }

                scannedKeys = page.scannedKeys;
                nextCursor = page.nextCursor;
                if (nextCursor !== '0' && nextCursor === scanCursor) {
                    throw new Error(`Redis scan cursor repeated: ${nextCursor}`);
                }
                if (scanToCompletion) {
                    scannedKeys.forEach((item) => keyMap.set(item.key, item));
                    if (keyMap.size > REDIS_KEY_SEARCH_MAX_RESULT_COUNT) {
                        throw new Error(`Redis search exceeded ${REDIS_KEY_SEARCH_MAX_RESULT_COUNT} Keys`);
                    }
                }
                if (nextCursor === '0' || (!scanToCompletion && scannedKeys.length > 0)) {
                    break;
                }
                scanCursor = nextCursor;
            }

            const loadedKeys = scanToCompletion ? Array.from(keyMap.values()) : scannedKeys;
            if (append) {
                setKeys(prev => mergeRedisKeyInfoLists(prev, loadedKeys));
            } else {
                setKeys(loadedKeys);
            }
            setCursor(nextCursor);
            setHasMore(nextCursor !== '0');
        } catch (e: any) {
            if (requestId !== latestLoadRequestIdRef.current) {
                return;
            }
            message.error(tr('redis_viewer.message.load_keys_failed', { detail: e?.message || String(e) }));
        } finally {
            if (requestId === latestLoadRequestIdRef.current) {
                setLoading(false);
            }
        }
    }, [getConfig, redisTopology, scanRedisKeysPage, tr]);

    useEffect(() => {
        loadKeys(
            searchPattern,
            '0',
            false,
            getRedisScanLoadCount(searchPattern, false, redisTopology === 'cluster'),
            searchMode !== 'exact' && searchPattern !== '*'
        );
    }, [loadKeys, redisDB]);

    const executeSearch = useCallback((value: string, mode: RedisSearchMode = searchMode) => {
        const normalized = normalizeRedisSearchInput(value, mode);
        setSearchInput(normalized.keyword);
        setSearchPattern(normalized.pattern);
        setCursor('0');
        loadKeys(
            normalized.pattern,
            '0',
            false,
            getRedisScanLoadCount(normalized.pattern, false, redisTopology === 'cluster'),
            mode !== 'exact' && normalized.keyword !== ''
        );
    }, [loadKeys, redisTopology, searchMode]);

    const handleSearch = (value: string) => {
        executeSearch(value);
    };

    const handleSearchInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const normalized = normalizeRedisSearchDraftChange(event.target.value, searchMode);
        setSearchInput(normalized.keyword);
        if (!normalized.shouldSearchImmediately) {
            return;
        }
        setSearchPattern(normalized.pattern);
        setCursor('0');
        loadKeys(
            normalized.pattern,
            '0',
            false,
            getRedisScanLoadCount(normalized.pattern, false, redisTopology === 'cluster'),
            searchMode !== 'exact' && normalized.keyword !== ''
        );
    };

    const handleSearchModeChange = useCallback((event: RadioChangeEvent) => {
        const nextMode = event.target.value as RedisSearchMode;
        setSearchMode(nextMode);
        executeSearch(searchInput, nextMode);
    }, [executeSearch, searchInput]);

    const handleLoadMore = () => {
        if (!hasMore || loading) {
            return;
        }
        loadKeys(searchPattern, cursor, true, getRedisScanLoadCount(searchPattern, true, redisTopology === 'cluster'));
    };

    const handleLoadAllKeys = useCallback(async () => {
        const config = getConfig();
        if (!config || loading || !hasMore) {
            return;
        }

        const normalizedPattern = searchPattern.trim() || '*';
        const batchSize = getRedisScanLoadCount(normalizedPattern, true, redisTopology === 'cluster');
        const requestId = latestLoadRequestIdRef.current + 1;
        latestLoadRequestIdRef.current = requestId;

        setLoading(true);
        setLoadingAllKeys(true);
        try {
            let nextCursor = '0';
            const keyMap = new Map<string, RedisKeyInfo>();
            const visitedCursors = new Set<string>();

            do {
                if (visitedCursors.has(nextCursor)) {
                    throw new Error(`Redis scan cursor repeated: ${nextCursor}`);
                }
                visitedCursors.add(nextCursor);

                const { scannedKeys, nextCursor: scannedCursor } = await scanRedisKeysPage(
                    config,
                    normalizedPattern,
                    nextCursor,
                    batchSize
                );
                if (requestId !== latestLoadRequestIdRef.current) {
                    return;
                }
                scannedKeys.forEach((item) => keyMap.set(item.key, item));
                if (scannedCursor !== '0' && scannedCursor === nextCursor) {
                    throw new Error(`Redis scan cursor repeated: ${scannedCursor}`);
                }
                nextCursor = scannedCursor;
            } while (nextCursor !== '0');

            setKeys(Array.from(keyMap.values()));
            setCursor('0');
            setHasMore(false);
        } catch (e: any) {
            if (requestId !== latestLoadRequestIdRef.current) {
                return;
            }
            message.error(tr('redis_viewer.message.load_keys_failed', { detail: e?.message || String(e) }));
        } finally {
            if (requestId === latestLoadRequestIdRef.current) {
                setLoading(false);
                setLoadingAllKeys(false);
            }
        }
    }, [getConfig, hasMore, loading, redisTopology, scanRedisKeysPage, searchPattern, tr]);

    const handleRefresh = () => {
        setCursor('0');
        return loadKeys(
            searchPattern,
            '0',
            false,
            getRedisScanLoadCount(searchPattern, false, redisTopology === 'cluster'),
            searchMode !== 'exact' && searchPattern !== '*'
        );
    };

    const handleSelectAllLoadedKeys = useCallback(() => {
        setSelectedKeys(keys.map((item) => item.key));
    }, [keys]);

    const handleClearAllSelectedKeys = useCallback(() => {
        setSelectedKeys([]);
    }, []);
    return {
        confirmRedisMutation,
        loadKeys,
        executeSearch,
        handleSearch,
        handleSearchInputChange,
        handleSearchModeChange,
        handleLoadMore,
        handleLoadAllKeys,
        handleRefresh,
        handleSelectAllLoadedKeys,
        handleClearAllSelectedKeys,
    };
};

export type RedisViewerKeyLoadingApi = ReturnType<typeof useRedisViewerKeyLoading>;
