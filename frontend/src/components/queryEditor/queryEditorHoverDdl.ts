import { DBShowCreateTable } from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { isPostgresSchemaDialect } from '../../utils/connectionDriverType';
import { buildMetadataIdentityKey } from '../../utils/metadataIdentity';
import { resolveSqlDialect } from '../../utils/sqlDialect';
import { formatDdlForDisplay } from '../../utils/ddlFormat';
import {
    SIDEBAR_DATABASE_REFRESH_EVENT,
    normalizeSidebarDatabaseRefreshRequest,
} from '../../utils/sidebarDatabaseRefresh';
import {
    splitQueryIdentifierPathSegments,
    normalizeMetadataDialect,
    getQueryEditorObjectResolveText,
    getQueryEditorModelValueLength,
    getQueryEditorDocumentOffsetAtPosition,
} from './QueryEditorHelpers';
import {
    sharedQueryEditorMetadataGeneration,
    sharedQueryEditorMetadataContextKey,
    sharedCurrentConnectionId,
    sharedConnections,
    _g,
    sharedQueryEditorMetadataReloadRequestListeners,
} from './queryEditorCompletionState';
import { invalidateSharedLazyTablesCache } from './queryEditorLazyTablesCache';

const QUERY_EDITOR_HOVER_DDL_CACHE_LIMIT = 100;
export const sharedQueryEditorHoverDdlCache = new Map<string, string>();
export const sharedQueryEditorHoverDdlRequests = new Map<string, Promise<string>>();
export const sharedQueryEditorHoverDdlRevisionByConnection = new Map<string, number>();
const sharedQueryEditorHoverDdlConfigRevisionByObject = new WeakMap<object, number>();
let nextQueryEditorHoverDdlConfigRevision = 1;

export type QueryEditorMetadataRequestSnapshot = {
    generation: number;
    connectionId: string;
    connectionConfig: unknown;
};

const buildQueryEditorTableMetadataKey = (
    connectionId: string,
    dbName: string,
    metadataDialect = '',
): string => (
    `${String(connectionId || '').trim()}\u0000${buildMetadataIdentityKey(metadataDialect, dbName)}`
);

export const normalizeQueryEditorTableTargetName = (
    tableName: string,
    metadataDialect = '',
): string => {
    const rawTableName = String(tableName || '').trim();
    if (!rawTableName) return '';

    const segments = splitQueryIdentifierPathSegments(rawTableName, metadataDialect);
    if (segments.length === 0) {
        return isPostgresSchemaDialect(metadataDialect)
            ? rawTableName.replace(/\s*\.\s*/g, '.')
            : rawTableName.replace(/\s*\.\s*/g, '.').toLowerCase();
    }

    // PostgreSQL folds only unquoted SQL identifiers. Other metadata dialects
    // retain the historical folded cache identity even if the source used
    // delimiter quotes.
    return JSON.stringify(segments.map((segment) => ({
        kind: isPostgresSchemaDialect(metadataDialect) && segment.quoted ? 'quoted' : 'folded',
        value: isPostgresSchemaDialect(metadataDialect) && segment.quoted
            ? segment.raw
            : segment.value.toLowerCase(),
    })));
};

export const buildQueryEditorTableTargetKey = (
    connectionId: string,
    dbName: string,
    tableName: string,
    metadataDialect = '',
): string => (
    `${buildQueryEditorTableMetadataKey(connectionId, dbName, metadataDialect)}\u0000${normalizeQueryEditorTableTargetName(tableName, metadataDialect)}`
);

export const isSharedQueryEditorMetadataRequestCurrent = (
    snapshot: QueryEditorMetadataRequestSnapshot,
    contextKey: string,
): boolean => (
    snapshot.generation === sharedQueryEditorMetadataGeneration
    && contextKey === sharedQueryEditorMetadataContextKey
    && snapshot.connectionId === sharedCurrentConnectionId
    && sharedConnections.find((connection) => connection.id === snapshot.connectionId)?.config === snapshot.connectionConfig
);

export const isSharedQueryEditorHoverDdlRequestCurrent = (
    snapshot: QueryEditorMetadataRequestSnapshot,
    contextKey: string,
): boolean => (
    snapshot.generation === sharedQueryEditorMetadataGeneration
    && contextKey === sharedQueryEditorMetadataContextKey
    && snapshot.connectionId === sharedCurrentConnectionId
    && sharedConnections.find((connection) => connection.id === snapshot.connectionId)?.config === snapshot.connectionConfig
);

const buildQueryEditorHoverDdlCacheKey = (
    snapshot: QueryEditorMetadataRequestSnapshot,
    dbName: string,
    tableName: string,
    connectionRevision: number,
): string => (
    `${String(snapshot.connectionId || '').trim()}\u0000${connectionRevision}\u0000${getQueryEditorHoverDdlConfigRevision(snapshot.connectionConfig)}\u0000${buildQueryEditorTableTargetKey(
        snapshot.connectionId,
        dbName,
        tableName,
        normalizeMetadataDialect({ config: snapshot.connectionConfig }),
    )}`
);

const getQueryEditorHoverDdlConnectionRevision = (connectionId: string): number => (
    sharedQueryEditorHoverDdlRevisionByConnection.get(String(connectionId || '').trim()) || 0
);

const getQueryEditorHoverDdlConfigRevision = (connectionConfig: unknown): number => {
    if (!connectionConfig || typeof connectionConfig !== 'object') return 0;
    const configObject = connectionConfig as object;
    const existing = sharedQueryEditorHoverDdlConfigRevisionByObject.get(configObject);
    if (existing !== undefined) return existing;
    const revision = nextQueryEditorHoverDdlConfigRevision++;
    sharedQueryEditorHoverDdlConfigRevisionByObject.set(configObject, revision);
    return revision;
};

export const invalidateQueryEditorHoverDdlCacheForConnection = (connectionId: string) => {
    const normalizedConnectionId = String(connectionId || '').trim();
    if (!normalizedConnectionId) return;

    sharedQueryEditorHoverDdlRevisionByConnection.set(
        normalizedConnectionId,
        getQueryEditorHoverDdlConnectionRevision(normalizedConnectionId) + 1,
    );
    const cacheKeyPrefix = `${normalizedConnectionId}\u0000`;
    for (const key of sharedQueryEditorHoverDdlCache.keys()) {
        if (key.startsWith(cacheKeyPrefix)) {
            sharedQueryEditorHoverDdlCache.delete(key);
        }
    }
};

export const installQueryEditorHoverDdlCacheInvalidationListener = () => {
    if (typeof window === 'undefined') return;

    const listenerState = _g.__gonaviQueryEditorHoverDdlCacheInvalidationListener;
    if (typeof listenerState?.listener === 'function') {
        const target = listenerState.target || window;
        target.removeEventListener?.(SIDEBAR_DATABASE_REFRESH_EVENT, listenerState.listener);
    }

    const listener = (event: Event) => {
        const request = normalizeSidebarDatabaseRefreshRequest((event as CustomEvent).detail);
        if (!request) return;
        invalidateQueryEditorHoverDdlCacheForConnection(request.connectionId);
        invalidateSharedLazyTablesCache(request.connectionId, request.dbName);
        // 每个编辑器实例按自己的连接上下文判断是否重载。不能依赖共享的「最后活跃」连接，
        // 否则连接 A 在后台发生结构变化、当前 Query Tab 是连接 B 时，A 切回后会永久复用旧 metadata。
        sharedQueryEditorMetadataReloadRequestListeners.forEach((listener) => listener(request));
    };
    window.addEventListener(SIDEBAR_DATABASE_REFRESH_EVENT, listener);
    _g.__gonaviQueryEditorHoverDdlCacheInvalidationListener = { listener, target: window };
};

export const uninstallQueryEditorHoverDdlCacheInvalidationListener = () => {
    const listenerState = _g.__gonaviQueryEditorHoverDdlCacheInvalidationListener;
    if (typeof listenerState?.listener === 'function') {
        const target = listenerState.target || (typeof window === 'undefined' ? null : window);
        target?.removeEventListener?.(SIDEBAR_DATABASE_REFRESH_EVENT, listenerState.listener);
    }
    _g.__gonaviQueryEditorHoverDdlCacheInvalidationListener = undefined;
};

// Ctrl+点击/mousemove 热路径禁止整篇读取模型（大文档性能约束，见 external-sql-save 测试）：
// 用光标上方有限行拼接探针文本，既支持表来源前缀与跨行限定名判断，又不触发 getValueLength/getValue
const QUERY_EDITOR_TABLE_SOURCE_PROBE_LINE_WINDOW = 8;
export const buildQueryEditorTableSourceProbeContext = (
    model: any,
    position: { lineNumber: number; column: number },
): { text: string; lineNumber: number; context: { text: string; offset: number } } => {
    const safeLineNumber = Math.max(1, Math.floor(Number(position?.lineNumber) || 1));
    const fromLine = Math.max(1, safeLineNumber - QUERY_EDITOR_TABLE_SOURCE_PROBE_LINE_WINDOW);
    const lines: string[] = [];
    for (let lineNumber = fromLine; lineNumber <= safeLineNumber; lineNumber += 1) {
        lines.push(String(model?.getLineContent?.(lineNumber) || ''));
    }
    const text = lines.join('\n');
    const offset = lines.slice(0, -1).reduce((acc, line) => acc + line.length + 1, 0)
        + Math.max(0, Math.floor(Number(position?.column) || 1) - 1);
    return {
        text,
        lineNumber: lines.length,
        context: { text, offset },
    };
};

export const buildQueryEditorDecorationProbeContext = (
    lines: string[],
    lineStartOffsets: number[],
    lineNumber: number,
    column: number,
): { text: string; lineNumber: number; context: { text: string; offset: number } } => {
    const safeLineIndex = Math.max(0, Math.min(lines.length - 1, Math.floor(Number(lineNumber) || 1) - 1));
    const fromLineIndex = Math.max(0, safeLineIndex - QUERY_EDITOR_TABLE_SOURCE_PROBE_LINE_WINDOW);
    const toLineIndex = Math.min(lines.length - 1, safeLineIndex + QUERY_EDITOR_TABLE_SOURCE_PROBE_LINE_WINDOW);
    const text = lines.slice(fromLineIndex, toLineIndex + 1).join('\n');
    const offset = (lineStartOffsets[safeLineIndex] || 0)
        - (lineStartOffsets[fromLineIndex] || 0)
        + Math.max(0, Math.floor(Number(column) || 1) - 1);
    return {
        text,
        lineNumber: safeLineIndex - fromLineIndex + 1,
        context: { text, offset },
    };
};

type QueryEditorObjectResolveContext = {
    text: string;
    lineNumber: number;
    documentContext: { text: string; offset: number };
};

// Hover 可读取完整短文档；大文档则只取光标附近的小窗口，并把行号和 offset 换算到同一局部坐标系。
// 不能把 Monaco 全文 offset 传给单行 fallback，否则限定名窗口会被夹到行尾。
export const buildQueryEditorObjectResolveContext = (
    model: any,
    position: { lineNumber: number; column: number },
    lineContent: string,
): QueryEditorObjectResolveContext => {
    const resolvedText = getQueryEditorObjectResolveText(model, lineContent);
    const modelLength = getQueryEditorModelValueLength(model);
    const usesFullDocument = modelLength !== null
        ? resolvedText.length === modelLength
        : resolvedText !== lineContent || Number(model?.getLineCount?.() || 1) <= 1;
    if (usesFullDocument) {
        const offset = typeof model?.getOffsetAt === 'function'
            ? model.getOffsetAt(position)
            : getQueryEditorDocumentOffsetAtPosition(resolvedText, position.lineNumber, position.column);
        return {
            text: resolvedText,
            lineNumber: position.lineNumber,
            documentContext: { text: resolvedText, offset },
        };
    }

    const safeLineNumber = Math.max(1, Math.floor(Number(position?.lineNumber) || 1));
    const lineCount = Math.max(safeLineNumber, Math.floor(Number(model?.getLineCount?.()) || safeLineNumber));
    const fromLine = Math.max(1, safeLineNumber - QUERY_EDITOR_TABLE_SOURCE_PROBE_LINE_WINDOW);
    const toLine = Math.min(lineCount, safeLineNumber + QUERY_EDITOR_TABLE_SOURCE_PROBE_LINE_WINDOW);
    const lines: string[] = [];
    for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
        lines.push(String(model?.getLineContent?.(lineNumber) || ''));
    }
    const localLineNumber = safeLineNumber - fromLine + 1;
    const offset = lines
        .slice(0, localLineNumber - 1)
        .reduce((acc, line) => acc + line.length + 1, 0)
        + Math.max(0, Math.floor(Number(position?.column) || 1) - 1);
    const text = lines.join('\n');
    return {
        text,
        lineNumber: localLineNumber,
        documentContext: { text, offset },
    };
};

const readQueryEditorHoverDdlCache = (key: string): string | undefined => {
    const cached = sharedQueryEditorHoverDdlCache.get(key);
    if (cached === undefined) return undefined;

    sharedQueryEditorHoverDdlCache.delete(key);
    sharedQueryEditorHoverDdlCache.set(key, cached);
    return cached;
};

const cacheQueryEditorHoverDdl = (key: string, ddl: string) => {
    sharedQueryEditorHoverDdlCache.delete(key);
    sharedQueryEditorHoverDdlCache.set(key, ddl);
    if (sharedQueryEditorHoverDdlCache.size > QUERY_EDITOR_HOVER_DDL_CACHE_LIMIT) {
        const oldestKey = sharedQueryEditorHoverDdlCache.keys().next().value;
        if (oldestKey !== undefined) {
            sharedQueryEditorHoverDdlCache.delete(oldestKey);
        }
    }
};

export const loadQueryEditorHoverDdl = async (
    snapshot: QueryEditorMetadataRequestSnapshot,
    dbName: string,
    tableName: string,
): Promise<string> => {
    const connectionRevision = getQueryEditorHoverDdlConnectionRevision(snapshot.connectionId);
    const key = buildQueryEditorHoverDdlCacheKey(snapshot, dbName, tableName, connectionRevision);
    const cached = readQueryEditorHoverDdlCache(key);
    if (cached !== undefined) return cached;

    // Keep completed DDL stable across tab/context round trips. In-flight
    // requests remain generation-scoped so an old request cannot be reused by
    // a context that left and later returned to the same database.
    const requestKey = `${key}\u0000${snapshot.generation}`;
    const pending = sharedQueryEditorHoverDdlRequests.get(requestKey);
    if (pending) return pending;

    const request = (async () => {
        try {
            const result = await DBShowCreateTable(
                buildRpcConnectionConfig(snapshot.connectionConfig as any) as any,
                dbName,
                tableName,
            );
            if (!result?.success) return '';

            const ddl = formatDdlForDisplay(
                result.data,
                resolveSqlDialect(
                    String((snapshot.connectionConfig as any)?.type || ''),
                    String((snapshot.connectionConfig as any)?.driver || ''),
                    { oceanBaseProtocol: (snapshot.connectionConfig as any)?.oceanBaseProtocol },
                ),
                { oceanBaseProtocol: (snapshot.connectionConfig as any)?.oceanBaseProtocol },
            );
            // Cache a completed response under the request generation even if
            // the initiating hover moved away. The provider still checks its
            // current context before rendering, while a later request can
            // safely reuse this result only when its generation matches.
            if (
                !ddl
                || connectionRevision !== getQueryEditorHoverDdlConnectionRevision(snapshot.connectionId)
                || snapshot.generation !== sharedQueryEditorMetadataGeneration
                || snapshot.connectionId !== sharedCurrentConnectionId
                || sharedConnections.find((connection) => connection.id === snapshot.connectionId)?.config !== snapshot.connectionConfig
            ) return '';

            cacheQueryEditorHoverDdl(key, ddl);
            return ddl;
        } catch {
            return '';
        }
    })();
    sharedQueryEditorHoverDdlRequests.set(requestKey, request);
    try {
        return await request;
    } finally {
        if (sharedQueryEditorHoverDdlRequests.get(requestKey) === request) {
            sharedQueryEditorHoverDdlRequests.delete(requestKey);
        }
    }
};

export const buildQueryEditorHoverDdlMarkdown = (ddl: string): string => {
    const fenceLength = Math.max(
        3,
        ...Array.from(String(ddl || '').matchAll(/`+/g), (match) => match[0].length + 1),
    );
    const fence = '`'.repeat(fenceLength);
    return `${fence}sql\n${ddl}\n${fence}`;
};
