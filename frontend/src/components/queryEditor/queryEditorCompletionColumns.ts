import {
    type MetadataIdentityMode,
    buildMetadataIdentityKey,
    getMetadataIdentityMode,
} from '../../utils/metadataIdentity';
import { splitQualifiedNameSegmentsDetailed } from '../../utils/qualifiedName';
import { type CompletionColumnMeta, splitCompletionSchemaAndTable } from './QueryEditorHelpers';
import { sharedAllColumnsData } from './queryEditorCompletionState';

export const shouldRefreshQueryEditorCompletionColumns = (
    intent: string,
    hasColumnsForDatabase: boolean,
    hasIncompleteColumnMetadata: boolean,
): boolean => (
    intent === 'column_name' && (hasIncompleteColumnMetadata || !hasColumnsForDatabase)
);

export const normalizeQueryEditorTableSuggestionText = (value: unknown): string => (
    String(value ?? '').replace(/\r\n|\r|\n/g, '').trim()
);

export const buildQueryEditorTableSuggestionLabel = (
    label: unknown,
    description?: unknown,
    useStructuredLabel = true,
): any => {
    const normalizedLabel = normalizeQueryEditorTableSuggestionText(label);
    const normalizedDescription = normalizeQueryEditorTableSuggestionText(description);
    if (!useStructuredLabel) {
        return normalizedLabel;
    }
    return {
        label: normalizedLabel,
        description: normalizedDescription,
    };
};

// AI 补全的元数据预热可能把整库列（数十万条）灌入 sharedAllColumnsData，普通补全逐列全量
// 扫描会阻塞主线程；按 (库, 表名末段) 建索引，并以数组身份为键缓存，数组重新赋值时自动失效。
const sharedColumnsIndexCache = new WeakMap<
    CompletionColumnMeta[],
    Map<MetadataIdentityMode, Map<string, CompletionColumnMeta[]>>
>();
export const dedupeCompletionColumnsByName = (
    columns: CompletionColumnMeta[],
    metadataDialect: string,
): CompletionColumnMeta[] => {
    const seen = new Set<string>();
    return columns.filter((column) => {
        const key = buildMetadataIdentityKey(metadataDialect, column.name);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};
export const buildCompletionColumnMetadataIdentityKey = (
    metadataDialect: string,
    dbName: string,
    tableName: string,
    columnName: string,
): string => buildMetadataIdentityKey(metadataDialect, dbName, tableName, columnName);

export const findSharedPreloadedColumns = (
    metadataDialect: string,
    dbName: string,
    tableName: string,
): CompletionColumnMeta[] => {
    const columns = sharedAllColumnsData;
    const identityMode = getMetadataIdentityMode(metadataDialect);
    let indexes = sharedColumnsIndexCache.get(columns);
    if (!indexes) {
        indexes = new Map<MetadataIdentityMode, Map<string, CompletionColumnMeta[]>>();
        sharedColumnsIndexCache.set(columns, indexes);
    }
    let index = indexes.get(identityMode);
    if (!index) {
        index = new Map<string, CompletionColumnMeta[]>();
        columns.forEach((column) => {
            const exactKey = buildMetadataIdentityKey(
                metadataDialect,
                column.dbName,
                column.tableName,
            );
            const lastTablePart = splitCompletionSchemaAndTable(
                column.tableName || '',
                column.dbName,
            ).table;
            const lastPartKey = buildMetadataIdentityKey(
                metadataDialect,
                column.dbName,
                lastTablePart,
            );
            const keys = lastPartKey && lastPartKey !== exactKey
                ? [exactKey, lastPartKey]
                : [exactKey];
            keys.forEach((key) => {
                const list = index!.get(key);
                if (list) {
                    list.push(column);
                } else {
                    index!.set(key, [column]);
                }
            });
        });
        indexes.set(identityMode, index);
    }
    const key = buildMetadataIdentityKey(metadataDialect, dbName, tableName);
    return dedupeCompletionColumnsByName(index.get(key) || [], metadataDialect);
};

// 普通建议的“相关列”按 SQL 中引用的表标识符（db.table / table / 纯表名）匹配，
// 同样避免对全量列做逐条正则扫描；索引以列数组身份为键缓存。
const sharedColumnsByIdentCache = new WeakMap<CompletionColumnMeta[], Map<string, Map<string, CompletionColumnMeta[]>>>();
export const buildQueryEditorMetadataIdentityKeys = (
    metadataDialect: string,
    dbName: string,
    tableName: string,
): string[] => {
    const rawDbName = String(dbName || '').trim();
    const rawParts = splitQualifiedNameSegmentsDetailed(String(tableName || '').trim(), metadataDialect)
        .map((segment) => String(segment.value || '').trim())
        .filter(Boolean);
    const variants: string[][] = [];
    if (rawParts.length > 0) {
        variants.push(rawParts);
        if (rawDbName) {
            variants.push([rawDbName, ...rawParts]);
        }
    } else if (rawDbName) {
        variants.push([rawDbName]);
    }

    const keys = new Set<string>();
    variants.forEach((parts) => {
        for (let start = 0; start < parts.length; start += 1) {
            const key = buildMetadataIdentityKey(metadataDialect, ...parts.slice(start));
            if (key) keys.add(key);
        }
    });
    return [...keys];
};

export const collectSharedColumnsForTableIdents = (
    columns: CompletionColumnMeta[],
    idents: ReadonlySet<string>,
    metadataDialect: string,
): CompletionColumnMeta[] => {
    const dialectKey = String(metadataDialect || '').trim().toLowerCase();
    let indexes = sharedColumnsByIdentCache.get(columns);
    if (!indexes) {
        indexes = new Map<string, Map<string, CompletionColumnMeta[]>>();
        sharedColumnsByIdentCache.set(columns, indexes);
    }
    let index = indexes.get(dialectKey);
    if (!index) {
        index = new Map<string, CompletionColumnMeta[]>();
        columns.forEach((column) => {
            buildQueryEditorMetadataIdentityKeys(metadataDialect, column.dbName, column.tableName).forEach((key) => {
                if (!key) {
                    return;
                }
                const list = index!.get(key);
                if (list) {
                    list.push(column);
                } else {
                    index!.set(key, [column]);
                }
            });
        });
        indexes.set(dialectKey, index);
    }
    const seen = new Set<CompletionColumnMeta>();
    const result: CompletionColumnMeta[] = [];
    idents.forEach((ident) => {
        (index!.get(ident) || []).forEach((column) => {
            if (seen.has(column)) {
                return;
            }
            seen.add(column);
            result.push(column);
        });
    });
    return result;
};
