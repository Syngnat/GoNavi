import {
    splitQueryIdentifierPathSegments,
    buildQueryEditorReferenceIdentityKeys,
    type CompletionTableMeta,
    type CompletionColumnMeta,
    buildQueryEditorIdentifierIdentityKey,
} from './QueryEditorHelpers';
import { buildMetadataIdentityKey } from '../../utils/metadataIdentity';
import {
    type QueryEditorAiTableReference,
    MAX_INLINE_SCHEMA_TABLES,
    type QueryEditorAiEditorSnapshot,
    type QueryEditorInlineCompletionIntentDetails,
    INLINE_TABLE_COMPLETION_RE,
} from './queryEditorAiAssistTypes';
import { getCurrentStatementPrefix } from './queryEditorAiInlineText';

export const schemaItemKey = (dbName: string, tableName: string, dialect = ''): string =>
    buildMetadataIdentityKey(dialect, dbName, tableName);

const INLINE_IDENTIFIER_PATTERN = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)';
const INLINE_IDENTIFIER_PATH_PATTERN = `${INLINE_IDENTIFIER_PATTERN}(?:\\s*\\.\\s*${INLINE_IDENTIFIER_PATTERN}){0,2}`;
const INLINE_COLUMN_COMPLETION_RE = new RegExp(`(${INLINE_IDENTIFIER_PATTERN})\\s*\\.\\s*([^\\s,()]*)$`, 'i');
const INLINE_TABLE_REFERENCE_RE = new RegExp(
    `\\b(?:FROM|JOIN|UPDATE|INTO|DELETE\\s+FROM|ALTER\\s+TABLE|DROP\\s+TABLE|TRUNCATE\\s+TABLE)\\s+(${INLINE_IDENTIFIER_PATH_PATTERN})(?:\\s+(?:AS\\s+)?(${INLINE_IDENTIFIER_PATTERN}))?`,
    'gi',
);
export const INLINE_CTE_NAME_RE = new RegExp(
    `(?:\\bWITH|,)\\s+(${INLINE_IDENTIFIER_PATTERN})\\s+AS\\s*\\(`,
    'gi',
);
export const INLINE_TABLE_FRAGMENT_SAFE_RE = /^[`"[\]A-Za-z0-9_$.]*$/;
export const INLINE_COLUMN_FRAGMENT_SAFE_RE = /^[`"[\]A-Za-z0-9_$]*$/;

const INLINE_TABLE_ALIAS_RESERVED_WORDS = new Set([
    'where', 'on', 'group', 'order', 'limit', 'having',
    'left', 'right', 'inner', 'outer', 'full', 'cross', 'join',
    'union', 'except', 'intersect', 'as', 'set', 'values', 'returning',
    'add', 'rename', 'modify', 'change', 'column', 'columns', 'comment',
    'cascade', 'restrict', 'restart', 'continue', 'identity', 'using',
    'when', 'then',
]);

export const stripInlineIdentifierQuotes = (part: string): string => {
    const text = String(part || '').trim();
    if (!text) return '';
    if ((text.startsWith('`') && text.endsWith('`'))
        || (text.startsWith('"') && text.endsWith('"'))
        || (text.startsWith('[') && text.endsWith(']'))) {
        return text.slice(1, -1).trim();
    }
    return text;
};

export const normalizeInlineIdentifierPath = (value: string): string => (
    String(value || '')
        .split('.')
        .map(stripInlineIdentifierQuotes)
        .filter(Boolean)
        .join('.')
);

export const getInlineIdentifierLastPart = (value: string): string => {
    const parts = normalizeInlineIdentifierPath(value).split('.').filter(Boolean);
    return parts[parts.length - 1] || '';
};

export const sameIdentifier = (left: string | undefined, right: string | undefined, dialect = ''): boolean =>
    buildMetadataIdentityKey(dialect, left) === buildMetadataIdentityKey(dialect, right);

export const defineHiddenInlineReferenceProperty = <T extends object, K extends PropertyKey, V>(
    target: T,
    key: K,
    value: V,
): T & Record<K, V> => {
    Object.defineProperty(target, key, {
        value,
        configurable: true,
        enumerable: false,
        writable: true,
    });
    return target as T & Record<K, V>;
};

export const buildInlineTableMetadataIdentityKeys = (
    dbName: string,
    tableName: string,
    dialect: string,
): string[] => {
    const rawDbName = String(dbName || '').trim();
    const rawParts = splitQueryIdentifierPathSegments(String(tableName || '').trim(), dialect)
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
            const key = buildMetadataIdentityKey(dialect, ...parts.slice(start));
            if (key) keys.add(key);
        }
    });
    return [...keys];
};

const splitInlineSchemaAndTable = (tableName: string): { schema: string; table: string } => {
    const parts = normalizeInlineIdentifierPath(tableName).split('.').filter(Boolean);
    if (parts.length < 2) {
        return { schema: '', table: parts[0] || '' };
    }
    return { schema: parts.slice(0, -1).join('.'), table: parts[parts.length - 1] || '' };
};

const resolveInlineTableReference = (
    rawTableIdent: string,
    rawAlias: string,
    currentDb: string,
    visibleDbs: string[],
    dialect: string,
): QueryEditorAiTableReference | null => {
    const tableIdent = normalizeInlineIdentifierPath(rawTableIdent);
    if (!tableIdent) return null;

    const pathSegments = splitQueryIdentifierPathSegments(rawTableIdent, dialect);
    const visibleDbByLower = new Map(
        visibleDbs
            .map((db) => String(db || '').trim())
            .filter(Boolean)
            .map((db) => [db.toLowerCase(), db] as const),
    );
    const parts = pathSegments.map((segment) => String(segment.value || '').trim()).filter(Boolean);
    let dbName = currentDb || '';
    let tableName = tableIdent;
    if (parts.length === 2) {
        const firstPartDb = visibleDbByLower.get(parts[0].toLowerCase());
        if (firstPartDb || sameIdentifier(parts[0], currentDb, dialect)) {
            dbName = firstPartDb || currentDb;
            tableName = parts[1];
        }
    } else if (parts.length >= 3) {
        dbName = visibleDbByLower.get(parts[0].toLowerCase()) || parts[0];
        tableName = parts.slice(1).join('.');
    }

    const alias = stripInlineIdentifierQuotes(rawAlias);
    const normalizedAlias = alias.toLowerCase();
    const reference = {
        dbName,
        tableName,
        alias: alias && !INLINE_TABLE_ALIAS_RESERVED_WORDS.has(normalizedAlias) ? alias : undefined,
        raw: tableIdent,
    } as QueryEditorAiTableReference;
    defineHiddenInlineReferenceProperty(reference, 'parts', parts);
    defineHiddenInlineReferenceProperty(reference, 'segments', pathSegments);
    if (reference.alias) {
        const aliasSegment = splitQueryIdentifierPathSegments(rawAlias, dialect)[0];
        if (aliasSegment) {
            defineHiddenInlineReferenceProperty(reference, 'aliasSegment', aliasSegment);
        }
    }
    return reference;
};

export const collectInlineTableReferences = (
    sql: string,
    currentDb: string,
    visibleDbs: string[],
    dialect: string,
): QueryEditorAiTableReference[] => {
    const refs: QueryEditorAiTableReference[] = [];
    const seen = new Set<string>();
    INLINE_TABLE_REFERENCE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_TABLE_REFERENCE_RE.exec(String(sql || ''))) !== null) {
        const ref = resolveInlineTableReference(match[1] || '', match[2] || '', currentDb, visibleDbs, dialect);
        if (!ref) continue;
        const key = buildQueryEditorReferenceIdentityKeys(ref, dialect)[0] || '';
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push(ref);
    }
    return refs;
};

export const tableMatchesInlineReference = (
    table: Pick<CompletionTableMeta, 'dbName' | 'tableName'>,
    ref: QueryEditorAiTableReference,
    dialect: string,
): boolean => {
    // The short table-name key is only a convenience for schema-qualified
    // metadata. It must not allow `shop.videos` to match `archive.videos`.
    // An explicit database scope on both sides is therefore authoritative.
    if (
        String(table.dbName || '').trim()
        && String(ref.dbName || '').trim()
        && !sameIdentifier(table.dbName, ref.dbName, dialect)
    ) {
        return false;
    }
    const refKeys = new Set(buildQueryEditorReferenceIdentityKeys(ref, dialect));
    if (refKeys.size === 0) return false;
    const tableKeys = buildInlineTableMetadataIdentityKeys(table.dbName, table.tableName, dialect);
    return tableKeys.some((key) => refKeys.has(key));
};

export const collectReferencedSchemaTables = (
    tables: CompletionTableMeta[],
    refs: QueryEditorAiTableReference[],
    dialect: string,
): CompletionTableMeta[] => {
    const result: CompletionTableMeta[] = [];
    const seen = new Set<string>();
    const addTable = (table: CompletionTableMeta) => {
        const key = schemaItemKey(table.dbName, table.tableName, dialect);
        if (seen.has(key)) return;
        seen.add(key);
        result.push(table);
    };

    refs.forEach((ref) => {
        const matched = tables.filter((table) => tableMatchesInlineReference(table, ref, dialect));
        if (matched.length > 0) {
            matched.forEach(addTable);
        } else {
            addTable({ dbName: ref.dbName, tableName: ref.tableName });
        }
    });

    return result.slice(0, MAX_INLINE_SCHEMA_TABLES);
};

// 大库列元数据可达数十万条，逐列正则匹配会阻塞主线程；按表名末段建一次索引，同一 columns 数组内复用。
const inlineColumnIndexCache = new WeakMap<
    CompletionColumnMeta[],
    Map<string, Map<string, CompletionColumnMeta[]>>
>();

const getInlineColumnsByTableLastPart = (
    columns: CompletionColumnMeta[],
    dialect: string,
): Map<string, CompletionColumnMeta[]> => {
    const dialectKey = String(dialect || '').trim().toLowerCase();
    let indexes = inlineColumnIndexCache.get(columns);
    if (!indexes) {
        indexes = new Map<string, Map<string, CompletionColumnMeta[]>>();
        inlineColumnIndexCache.set(columns, indexes);
    }
    const cached = indexes.get(dialectKey);
    if (cached) {
        return cached;
    }
    const index = new Map<string, CompletionColumnMeta[]>();
    columns.forEach((column) => {
        const segments = splitQueryIdentifierPathSegments(column.tableName || '', dialect);
        const lastSegment = segments[segments.length - 1];
        const lastPart = lastSegment
            ? buildMetadataIdentityKey(dialect, lastSegment.value)
            : '';
        if (!lastPart) {
            return;
        }
        const list = index.get(lastPart);
        if (list) {
            list.push(column);
        } else {
            index.set(lastPart, [column]);
        }
    });
    indexes.set(dialectKey, index);
    return index;
};

export const collectColumnsMatchingReference = (
    columns: CompletionColumnMeta[],
    ref: QueryEditorAiTableReference,
    dialect: string,
): CompletionColumnMeta[] => {
    const segments = ref.segments && ref.segments.length > 0
        ? ref.segments
        : splitQueryIdentifierPathSegments(ref.tableName || '', dialect);
    const lastSegment = segments[segments.length - 1];
    const refLastPart = lastSegment
        ? buildQueryEditorIdentifierIdentityKey([lastSegment], dialect)
        : '';
    if (!refLastPart) {
        return [];
    }
    const candidates = getInlineColumnsByTableLastPart(columns, dialect).get(refLastPart) || [];
    return candidates.filter((column) => tableMatchesInlineReference(
        { dbName: column.dbName, tableName: column.tableName },
        ref,
        dialect,
    ));
};

const collectColumnsMatchingMetadataTable = (
    columns: CompletionColumnMeta[],
    table: CompletionTableMeta,
    dialect: string,
): CompletionColumnMeta[] => {
    const tableSegments = splitQueryIdentifierPathSegments(table.tableName || '', dialect);
    const lastSegment = tableSegments[tableSegments.length - 1];
    const lastPart = lastSegment
        ? buildMetadataIdentityKey(dialect, lastSegment.value)
        : '';
    if (!lastPart) {
        return [];
    }
    const tableKeys = new Set(buildInlineTableMetadataIdentityKeys(table.dbName, table.tableName, dialect));
    const candidates = getInlineColumnsByTableLastPart(columns, dialect).get(lastPart) || [];
    return candidates.filter((column) => {
        if (
            String(column.dbName || '').trim()
            && String(table.dbName || '').trim()
            && !sameIdentifier(column.dbName, table.dbName, dialect)
        ) {
            return false;
        }
        return buildInlineTableMetadataIdentityKeys(column.dbName, column.tableName, dialect)
            .some((key) => tableKeys.has(key));
    });
};

export const filterColumnsForTables = (
    columns: CompletionColumnMeta[],
    tables: CompletionTableMeta[],
    refs: QueryEditorAiTableReference[],
    dialect: string,
): CompletionColumnMeta[] => {
    if (!columns.length || (!tables.length && !refs.length)) {
        return [];
    }
    const seen = new Set<CompletionColumnMeta>();
    const result: CompletionColumnMeta[] = [];
    const addColumns = (matchedColumns: CompletionColumnMeta[]) => {
        matchedColumns.forEach((column) => {
            if (seen.has(column)) {
                return;
            }
            seen.add(column);
            result.push(column);
        });
    };
    tables.forEach((table) => addColumns(collectColumnsMatchingMetadataTable(columns, table, dialect)));
    refs.forEach((ref) => addColumns(collectColumnsMatchingReference(columns, ref, dialect)));
    return result;
};

export const collectCurrentDatabaseTables = (
    tables: CompletionTableMeta[],
    currentDb: string,
    dialect: string,
): CompletionTableMeta[] => (
    tables
        .filter((table) => sameIdentifier(table.dbName, currentDb, dialect))
        .sort((left, right) => String(left.tableName || '').localeCompare(String(right.tableName || '')))
        .slice(0, MAX_INLINE_SCHEMA_TABLES)
);

export const resolveQueryEditorInlineCompletionIntentDetails = (
    editorSnapshot: QueryEditorAiEditorSnapshot,
    sqlDialect = '',
): QueryEditorInlineCompletionIntentDetails => {
    const statementPrefix = getCurrentStatementPrefix(editorSnapshot.prefix, sqlDialect);
    const tableMatch = statementPrefix.match(INLINE_TABLE_COMPLETION_RE);
    if (tableMatch) {
        const rawFragment = String(tableMatch[1] || '').trim();
        return {
            intent: 'table_name',
            fragment: INLINE_TABLE_FRAGMENT_SAFE_RE.test(rawFragment)
                ? normalizeInlineIdentifierPath(rawFragment)
                : '',
            qualifier: '',
        };
    }

    const columnMatch = statementPrefix.match(INLINE_COLUMN_COMPLETION_RE);
    if (columnMatch) {
        const rawFragment = String(columnMatch[2] || '').trim();
        return {
            intent: 'column_name',
            fragment: INLINE_COLUMN_FRAGMENT_SAFE_RE.test(rawFragment)
                ? stripInlineIdentifierQuotes(rawFragment).trim()
                : '',
            qualifier: normalizeInlineIdentifierPath(columnMatch[1] || ''),
        };
    }

    return {
        intent: 'general_sql',
        fragment: '',
        qualifier: '',
    };
};
