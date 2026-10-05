import { ColumnDefinition } from '../../types';
import { buildMetadataIdentityKey } from '../../utils/metadataIdentity';
import { resolveSqlDialect } from '../../utils/sqlDialect';
import {
    buildQueryEditorMetadataCacheScope,
    queryEditorColumnsCache as boundedColumnsCache,
    queryEditorLazyTablesCache as boundedLazyTablesCache,
} from './queryEditorMetadataCaches';
import {
    QUERY_EDITOR_COMPLETION_SUGGESTION_LIMIT,
    normalizeMetadataDialect,
} from './QueryEditorHelpers';
import { canExecuteQueryEditorSQLWithoutDatabase } from './queryEditorDatabaseRequirement';
import {
    sharedConnections,
    sharedLazyTablesRevisionByKey,
    sharedCurrentConnectionId,
    sharedLazyTablesInFlight,
    sharedActiveEditorModelUri,
} from './queryEditorCompletionState';

export const createSqlCompletionResult = (suggestions: any[], retriggerOnContinue = false) => ({
    suggestions,
    // Monaco otherwise keeps filtering a cached list locally. Re-run strict
    // object-name contexts as the prefix grows, and re-run any full 200-item
    // window so omitted candidates can enter the next result.
    incomplete: suggestions.length > 0
        && (retriggerOnContinue || suggestions.length >= QUERY_EDITOR_COMPLETION_SUGGESTION_LIMIT),
});
export const createEmptySqlCompletionResult = () => createSqlCompletionResult([]);
export const isSqlCompletionRequestCancelled = (token?: { isCancellationRequested?: boolean } | null) =>
    Boolean(token?.isCancellationRequested);
export const clearRecord = (record: Record<string, unknown>) => {
    Object.keys(record).forEach((key) => {
        delete record[key];
    });
};

const splitSharedLazyTablesCacheKey = (key: string): { connectionId: string; dbName: string } => {
    const separator = String(key || '').indexOf('|');
    if (separator < 0) {
        return { connectionId: String(key || ''), dbName: '' };
    }
    const rest = String(key || '').slice(separator + 1);
    return {
        connectionId: String(key || '').slice(0, separator),
        dbName: rest.split('|', 1)[0] || '',
    };
};

export const buildSharedLazyTablesCacheKey = (
    connectionId: string,
    dbName: string,
    metadataDialect = '',
): string => (
    `${String(connectionId || '').trim()}|${buildMetadataIdentityKey(metadataDialect, dbName)}`
);

const isSharedLazyTablesCacheKeyForRequest = (
    key: string,
    connectionId: string,
    dbName?: string,
): boolean => {
    const parts = splitSharedLazyTablesCacheKey(key);
    if (parts.connectionId !== connectionId) return false;
    const metadataDialect = normalizeMetadataDialect(
        sharedConnections.find((connection) => connection.id === connectionId),
    );
    const requestedDbKey = buildMetadataIdentityKey(metadataDialect, dbName);
    return !requestedDbKey
        || buildMetadataIdentityKey(metadataDialect, parts.dbName) === requestedDbKey;
};

export const getSharedLazyTablesRevision = (cacheKey: string): number => (
    sharedLazyTablesRevisionByKey[cacheKey] || 0
);

// 每编辑器仍持有自己的 columns ref（用于失效），同时把当前连接的条目镜像进
// 共享的带容量缓存：#1254 之前这里是全量赋值给一个无限增长的普通对象。
export const mirrorColumnsCacheIntoBoundedCache = (cache: Record<string, ColumnDefinition[]>) => {
    const connectionId = String(sharedCurrentConnectionId || '').trim();
    if (!connectionId) return;
    const scope = buildQueryEditorMetadataCacheScope(connectionId, '');
    Object.entries(cache).forEach(([key, value]) => {
        if (!Array.isArray(value)) return;
        boundedColumnsCache.set(key, scope, value);
    });
};

const invalidateSharedLazyTablesCacheKey = (cacheKey: string) => {
    const normalizedCacheKey = String(cacheKey || '').trim();
    if (!normalizedCacheKey) return;
    boundedLazyTablesCache.delete(normalizedCacheKey);
    sharedLazyTablesRevisionByKey[normalizedCacheKey] = getSharedLazyTablesRevision(normalizedCacheKey) + 1;
    Object.keys(sharedLazyTablesInFlight).forEach((inFlightKey) => {
        const inFlightCacheKey = inFlightKey.replace(/\|\d+$/, '');
        if (inFlightCacheKey === normalizedCacheKey) {
            delete sharedLazyTablesInFlight[inFlightKey];
        }
    });
};

export const invalidateSharedLazyTablesCache = (connectionId: string, dbName?: string) => {
    const normalizedConnectionId = String(connectionId || '').trim();
    if (!normalizedConnectionId) return;

    const cacheKeys = new Set([
        ...Object.keys(sharedLazyTablesRevisionByKey),
    ]);
    Object.keys(sharedLazyTablesInFlight).forEach((inFlightKey) => {
        // In-flight keys append the metadata generation to the cache key.
        const cacheKey = inFlightKey.replace(/\|\d+$/, '');
        if (!isSharedLazyTablesCacheKeyForRequest(cacheKey, normalizedConnectionId, dbName)) return;
        cacheKeys.add(cacheKey);
    });
    cacheKeys.forEach((cacheKey) => {
        if (!isSharedLazyTablesCacheKeyForRequest(cacheKey, normalizedConnectionId, dbName)) return;
        invalidateSharedLazyTablesCacheKey(cacheKey);
    });
};
export const QUERY_EDITOR_SQL_SNIPPET_SUGGEST_DETAIL_MIN_HEIGHT = 260;
export const QUERY_EDITOR_TABLE_NAVIGATION_VALIDATION_TIMEOUT_MS = 5_000;

export const isConnectionScopedQueryEditorMetadata = (connection: any): boolean => (
    resolveSqlDialect(
        String(connection?.config?.type || ''),
        String(connection?.config?.driver || ''),
        { oceanBaseProtocol: connection?.config?.oceanBaseProtocol },
    ) === 'sqlite'
);

export const canUseQueryEditorDatabaseContext = (connection: any, dbName: unknown, sql?: string): boolean => {
    if (Boolean(String(dbName ?? '').trim())) return true;
    if (isConnectionScopedQueryEditorMetadata(connection)) return true;
    if (!sql || !sql.trim()) return false;
    // 未选库时放行整段都免库的 SQL（SHOW DATABASES、SELECT 1、USE 等，见 issue #1355）。
    return canExecuteQueryEditorSQLWithoutDatabase(sql, resolveSqlDialect(
        String(connection?.config?.type || ''),
        String(connection?.config?.driver || ''),
        { oceanBaseProtocol: connection?.config?.oceanBaseProtocol },
    ));
};

// Monaco language providers are registered globally, while each QueryEditor
// owns a separate model. Ignore callbacks for a non-active model so the active
// tab's shared metadata cannot leak into a concurrently mounted/floating tab.
export const isSharedQueryEditorModelCurrent = (model: any): boolean => {
    const activeModelUri = String(sharedActiveEditorModelUri || '').trim();
    if (!activeModelUri) return true;
    const modelUri = String(model?.uri?.toString?.() || '').trim();
    return !modelUri || modelUri === activeModelUri;
};
