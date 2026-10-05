import type { QueryResultTableRef } from '../../utils/queryResultTable';
import {
    decodeSidebarSqlEditorDragPayload,
    SIDEBAR_SQL_EDITOR_DRAG_MIME,
} from '../../utils/sidebarSqlDrag';
import type { EditRowLocator } from '../../utils/rowLocator';
import { splitQualifiedNameSegments } from '../../utils/qualifiedName';
import type { DataGridIndexedColumnMetadata } from '../dataGridColumnTypeMarker';

export const QUERY_LOCATOR_ALIAS_PREFIX = '__gonavi_locator_';
const QUERY_LOCATOR_METADATA_TIMEOUT_MS = 1500;
const SQLSERVER_MESSAGE_PREFIX_RE = /^\s*mssql:/i;

export const withSoftTimeout = <T,>(promise: Promise<T>, fallback: () => T, timeoutMs = QUERY_LOCATOR_METADATA_TIMEOUT_MS): Promise<T> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof globalThis.setTimeout !== 'function') {
        return promise.catch(() => fallback());
    }
    return new Promise<T>((resolve) => {
        let settled = false;
        const finish = (value: T) => {
            if (settled) return;
            settled = true;
            globalThis.clearTimeout(timerId);
            resolve(value);
        };
        const timerId = globalThis.setTimeout(() => {
            finish(fallback());
        }, timeoutMs);
        promise
            .then((value) => finish(value))
            .catch(() => finish(fallback()));
    });
};

const trimBoundaryBlankEntries = (entries: string[]): string[] => {
    let start = 0;
    let end = entries.length;
    while (start < end && !String(entries[start] || '').trim()) start++;
    while (end > start && !String(entries[end - 1] || '').trim()) end--;
    return entries.slice(start, end);
};

const stripSqlServerMessagePrefix = (line: string): string => (
    line.replace(SQLSERVER_MESSAGE_PREFIX_RE, '').replace(/^[ \t]/, '')
);

export const buildQueryReadOnlyLocator = (reason: string): EditRowLocator => ({
    strategy: 'none',
    columns: [],
    valueColumns: [],
    readOnly: true,
    reason,
});

export type SimpleSelectInfo = {
    selectsAll: boolean;
    selectsBareAll: boolean;
    writableColumns: Record<string, string>;
};

export type QueryStatementPlan = DataGridIndexedColumnMetadata & {
    originalSql: string;
    executedSql: string;
    tableRef?: QueryResultTableRef;
    pkColumns: string[];
    editLocator?: EditRowLocator;
    warning?: string;
};

export const stripSidebarDropIdentifierQuotes = (part: string): string => {
    const text = String(part || '').trim();
    if (!text) return '';
    if ((text.startsWith('`') && text.endsWith('`')) || (text.startsWith('"') && text.endsWith('"')) || (text.startsWith('[') && text.endsWith(']'))) {
        return text.slice(1, -1).trim();
    }
    return text;
};

export const shouldPrefixSidebarDropDatabase = (
    payloadConnectionId: string,
    payloadDbName: string,
    payloadText: string,
    currentConnectionId: string,
    currentDb: string,
): boolean => {
    const sourceDbName = String(payloadDbName || '').trim();
    if (!sourceDbName) return false;
    const normalizedSourceDbName = sourceDbName.toLowerCase();
    if (String(currentDb || '').trim().toLowerCase() === normalizedSourceDbName) return false;

    const sourceConnectionId = String(payloadConnectionId || '').trim();
    const targetConnectionId = String(currentConnectionId || '').trim();
    if (sourceConnectionId && targetConnectionId && sourceConnectionId !== targetConnectionId) return false;

    const parts = String(payloadText || '')
        .split('.')
        .map(stripSidebarDropIdentifierQuotes)
        .filter(Boolean);
    return parts[0]?.toLowerCase() !== normalizedSourceDbName;
};

export const isQueryEditorPrimaryMouseButton = (event: any): boolean => {
    if (event?.leftButton === true) return true;
    if (event?.leftButton === false) return false;

    const browserEvent = event?.browserEvent || event?.nativeEvent || event;
    if (browserEvent?.button === 0) return true;
    if (event?.button === 0) return true;
    if (browserEvent?.buttons === 1) return true;
    if (event?.buttons === 1) return true;
    return false;
};

export const hasQueryEditorCtrlMetaModifier = (event: any): boolean => {
    const candidates = [
        event,
        event?.browserEvent,
        event?.nativeEvent,
        event?.originalEvent,
    ];
    return candidates.some((candidate) => !!(candidate?.ctrlKey || candidate?.metaKey));
};

export const readSidebarSqlDropText = (
    event: DragEvent,
    currentConnectionId = '',
    currentDb = '',
): string => {
    const payload = decodeSidebarSqlEditorDragPayload(String(event.dataTransfer?.getData(SIDEBAR_SQL_EDITOR_DRAG_MIME) || ''));
    if (payload?.text) {
        if (shouldPrefixSidebarDropDatabase(payload.connectionId || '', payload.dbName || '', payload.text, currentConnectionId, currentDb)) {
            return `${String(payload.dbName || '').trim()}.${payload.text}`;
        }
        return payload.text;
    }
    return String(event.dataTransfer?.getData('text/plain') || '').trim();
};

export const stripQueryIdentifierQuotes = (part: string): string => {
    const text = String(part || '').trim();
    if (!text) return '';
    if (text.startsWith('`') && text.endsWith('`')) {
        return text.slice(1, -1).replace(/``/g, '`').trim();
    }
    if (text.startsWith('"') && text.endsWith('"')) {
        return text.slice(1, -1).replace(/""/g, '"').trim();
    }
    if (text.startsWith('[') && text.endsWith(']')) {
        return text.slice(1, -1).replace(/\]\]/g, ']').trim();
    }
    return text;
};

export const normalizeQueryResultMessageText = (
    message: unknown,
    options?: { preserveIndentation?: boolean },
): string => {
    const text = String(message ?? '').replace(/\r\n?/g, '\n');
    if (!text) return '';

    const preserveIndentation = options?.preserveIndentation === true;
    const normalizedLines = trimBoundaryBlankEntries(
        text.split('\n').map((line) => {
            if (SQLSERVER_MESSAGE_PREFIX_RE.test(line)) {
                return stripSqlServerMessagePrefix(line);
            }
            return preserveIndentation ? line : (line.trim() ? line : '');
        }),
    );
    if (normalizedLines.length === 0) return '';
    return preserveIndentation ? normalizedLines.join('\n') : normalizedLines.join('\n').trim();
};

export const normalizeQueryResultMessages = (messages: unknown): string[] => (
    Array.isArray(messages)
        ? (() => {
            const preserveIndentation = messages.some((item) => SQLSERVER_MESSAGE_PREFIX_RE.test(String(item ?? '')));
            const normalized = messages.map((item) => normalizeQueryResultMessageText(item, { preserveIndentation }));
            return preserveIndentation ? trimBoundaryBlankEntries(normalized) : normalized.filter(Boolean);
        })()
        : []
);

export const MYSQL_SYSTEM_METADATA_SCHEMAS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);
export const POSTGRES_SYSTEM_METADATA_SCHEMAS = new Set(['information_schema', 'pg_catalog']);
export const SQLITE_SYSTEM_METADATA_TABLES = new Set(['sqlite_master', 'sqlite_schema', 'sqlite_temp_master', 'sqlite_temp_schema']);

export const isSystemMetadataQueryResult = (tableRef: QueryResultTableRef, dbType: string): boolean => {
    const normalizedDbType = String(dbType || '').trim().toLowerCase();
    const metadataDbName = stripQueryIdentifierQuotes(tableRef.metadataDbName).toLowerCase();
    const metadataTableName = stripQueryIdentifierQuotes(tableRef.metadataTableName).toLowerCase();

    if (['mysql', 'goldendb', 'mariadb', 'oceanbase', 'diros', 'starrocks', 'sphinx', 'tidb'].includes(normalizedDbType)) {
        return MYSQL_SYSTEM_METADATA_SCHEMAS.has(metadataDbName);
    }
    if (['postgres', 'kingbase', 'highgo', 'vastbase', 'opengauss', 'gaussdb'].includes(normalizedDbType)) {
        return POSTGRES_SYSTEM_METADATA_SCHEMAS.has(metadataDbName);
    }
    if (normalizedDbType === 'sqlite' || normalizedDbType === 'duckdb') {
        return SQLITE_SYSTEM_METADATA_TABLES.has(metadataTableName) || metadataDbName === 'information_schema';
    }
    if (['sqlserver', 'mssql', 'sql_server', 'sql-server'].includes(normalizedDbType)) {
        // SQL Server keeps the database in metadataDbName and the schema in
        // metadataTableName (for example, appdb + sys.objects). Checking the
        // database here would let system schemas bypass the read-only guard.
        const parts = splitQualifiedNameSegments(tableRef.metadataTableName);
        const schema = String(parts.length >= 2 ? parts[0] : '').toLowerCase();
        return schema === 'information_schema' || schema === 'sys';
    }
    if (normalizedDbType === 'clickhouse') {
        return metadataDbName === 'system' || metadataDbName === 'information_schema';
    }
    return false;
};
