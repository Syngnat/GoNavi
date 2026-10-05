import { DBQuery } from '../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { resolveSqlDialect, quoteSqlIdentifierPart } from '../../utils/sqlDialect';
import { buildMySQLCompatibleViewMetadataSqls } from '../../utils/sidebarMetadata';
import { ORACLE_ROUTINE_OBJECT_TYPES, ORACLE_ROUTINE_TYPE_COLUMN } from '../../utils/oracleRoutineObjects';
import {
    type MetadataIdentityMode,
    getMetadataIdentityMode,
    buildMetadataIdentityKey,
} from '../../utils/metadataIdentity';
import {
    splitQualifiedNameSegments,
    splitQualifiedNameSegmentsDetailed,
} from '../../utils/qualifiedName';
import { t as translate } from '../../i18n';
import { escapeMetadataSqlLiteral } from './queryEditorSelectRewrite';
import type { CompletionColumnMeta, CompletionTableMeta } from './queryEditorCompletionCandidates';

export type MetadataQuerySpec = {
    sql: string;
    inferredType?: 'FUNCTION' | 'PROCEDURE';
};

export type MetadataQueryResult = {
    rows: Record<string, any>[];
    inferredType?: 'FUNCTION' | 'PROCEDURE';
};

export const normalizeMetadataDialect = (conn: any): string => {
    const type = String(conn?.config?.type || '').trim().toLowerCase();
    const driver = String(conn?.config?.driver || '').trim();
    const dialect = resolveSqlDialect(type, driver, {
        oceanBaseProtocol: conn?.config?.oceanBaseProtocol,
    });
    if (dialect === 'diros' || dialect === 'sphinx' || dialect === 'mariadb' || dialect === 'oceanbase') return 'mysql';
    if (dialect === 'dameng') return 'oracle';
    return String(dialect || '').toLowerCase();
};

export const buildCompletionTableCommentSQL = (dialect: string, dbName: string): string => {
    const db = String(dbName || '').trim();
    const escapedDb = escapeMetadataSqlLiteral(db);
    switch (dialect) {
        case 'mysql':
        case 'starrocks':
            return `SELECT TABLE_NAME AS table_name, TABLE_COMMENT AS table_comment FROM information_schema.tables WHERE table_schema = '${escapedDb}' AND table_type = 'BASE TABLE' ORDER BY table_name`;
        case 'postgres':
        case 'kingbase':
        case 'vastbase':
        case 'highgo':
        case 'opengauss':
        case 'gaussdb':
            return `SELECT n.nspname || '.' || c.relname AS table_name, obj_description(c.oid, 'pg_class') AS table_comment FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY n.nspname, c.relname`;
        case 'sqlserver':
            return `SELECT s.name + '.' + t.name AS table_name, CONVERT(nvarchar(4000), ep.value) AS table_comment FROM sys.tables t JOIN sys.schemas s ON t.schema_id = s.schema_id LEFT JOIN sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description' WHERE t.type = 'U' ORDER BY s.name, t.name`;
        case 'clickhouse':
            return `SELECT name AS table_name, comment AS table_comment FROM system.tables WHERE database = '${escapedDb}' AND engine NOT IN ('View', 'MaterializedView') ORDER BY name`;
        case 'oracle': {
            const owner = escapedDb.toUpperCase();
            return `SELECT table_name, comments AS table_comment FROM all_tab_comments WHERE owner = '${owner}' ORDER BY table_name`;
        }
        default:
            return '';
    }
};

export const getCaseInsensitiveValue = (row: Record<string, any>, keys: string[]): any => {
    for (const key of keys) {
        for (const rowKey of Object.keys(row || {})) {
            if (rowKey.toLowerCase() === key.toLowerCase()) {
                return row[rowKey];
            }
        }
    }
    return undefined;
};

export const normalizeCommentText = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value).trim();
    if (!text || text.toLowerCase() === '<nil>') return '';
    return text;
};

export const buildCompletionDocumentation = (comment?: string): string | undefined => {
    const text = normalizeCommentText(comment);
    return text ? translate('query_editor.completion.documentation.comment', { comment: text }) : undefined;
};

export const appendCommentToDetail = (detail: string, comment?: string): string => {
    const text = normalizeCommentText(comment);
    return text ? `${detail} - ${text}` : detail;
};

const buildColumnCompletionTableLabel = (column: CompletionColumnMeta): string => {
    return normalizeCommentText(column.tableName);
};

export const buildColumnCompletionDetail = (column: CompletionColumnMeta): string => {
    const typeText = normalizeCommentText(column.type);
    const tableLabel = buildColumnCompletionTableLabel(column);
    const detail = [
        tableLabel,
        typeText ? `[${typeText}]` : '',
    ].filter(Boolean).join(' ') || translate('query_editor.object_info.column');

    return appendCommentToDetail(detail, column.comment);
};

export const buildColumnCompletionDocumentation = (column: CompletionColumnMeta): string | undefined => {
    const typeText = normalizeCommentText(column.type);
    const dbName = normalizeCommentText(column.dbName);
    const tableName = normalizeCommentText(column.tableName);
    const comment = normalizeCommentText(column.comment);
    const lines = [
        typeText ? `${translate('query_editor.object_info.label.type')}: ${typeText}` : '',
        dbName ? `${translate('query_editor.object_info.label.database')}: ${dbName}` : '',
        tableName ? `${translate('query_editor.object_info.label.table')}: ${tableName}` : '',
        comment ? translate('query_editor.completion.documentation.comment', { comment }) : '',
    ].filter(Boolean);

    return lines.length > 0 ? lines.join('\n\n') : undefined;
};

export const stripCompletionIdentifierQuotes = (ident: string): string => {
    let raw = String(ident || '').trim();
    if (!raw) return raw;
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '`' && last === '`') || (first === '"' && last === '"')) {
        raw = raw.slice(1, -1);
    }
    return raw.trim();
};

export const normalizeCompletionQualifiedName = (ident: string): string => {
    const raw = String(ident || '').trim();
    if (!raw) return raw;
    return splitQualifiedNameSegments(raw).filter(Boolean).join('.');
};

export const getCompletionQualifiedNameLastPart = (qualified: string): string => {
    const parts = splitQualifiedNameSegments(qualified).filter(Boolean);
    return parts[parts.length - 1] || '';
};

export const splitCompletionSchemaAndTable = (
    qualified: string,
    knownDbName = '',
): { schema: string; table: string } => {
    const parts = splitQualifiedNameSegments(qualified).filter(Boolean);
    if (parts.length === 0) return { schema: '', table: '' };

    const dbName = String(knownDbName || '').trim();
    if (dbName) {
        const normalizedDbName = dbName.toLowerCase();
        if (parts.length === 2 && parts[0].toLowerCase() === normalizedDbName) {
            return { schema: dbName, table: parts[1] };
        }

        const dbNameParts = dbName.split('.').map((part) => part.trim()).filter(Boolean);
        const prefixParts = parts.slice(0, dbNameParts.length);
        if (
            parts.length === dbNameParts.length + 1
            && prefixParts.join('.').toLowerCase() === normalizedDbName
        ) {
            return { schema: dbName, table: parts[parts.length - 1] };
        }
    }

    if (parts.length >= 2) {
        return {
            schema: parts[parts.length - 2] || '',
            table: parts[parts.length - 1] || '',
        };
    }
    return { schema: '', table: parts[0] || '' };
};

// The caller passes the cached current-database partition. Schema duplicate detection therefore
// reads only that partition once instead of walking every visible database on each keystroke.
const completionTableSchemaCountCache = new WeakMap<
    CompletionTableMeta[],
    Map<MetadataIdentityMode, Map<string, number>>
>();

export const getCompletionTableSchemaCounts = (
    currentDatabaseTables: CompletionTableMeta[],
    metadataDialect = '',
): Map<string, number> => {
    const identityMode = getMetadataIdentityMode(metadataDialect);
    let indexes = completionTableSchemaCountCache.get(currentDatabaseTables);
    if (!indexes) {
        indexes = new Map<MetadataIdentityMode, Map<string, number>>();
        completionTableSchemaCountCache.set(currentDatabaseTables, indexes);
    }
    const cached = indexes.get(identityMode);
    if (cached) return cached;

    const counts = new Map<string, number>();
    currentDatabaseTables.forEach((table) => {
        const parsed = splitCompletionSchemaAndTable(table.tableName || '', table.dbName);
        const pureTable = buildMetadataIdentityKey(
            metadataDialect,
            parsed.table || table.tableName,
        );
        if (!pureTable) return;
        counts.set(pureTable, (counts.get(pureTable) || 0) + 1);
    });
    indexes.set(identityMode, counts);
    return counts;
};

export const getFirstRowValue = (row: Record<string, any>): string => {
    for (const value of Object.values(row || {})) {
        if (value !== undefined && value !== null) {
            const normalized = String(value).trim();
            if (normalized !== '') return normalized;
        }
    }
    return '';
};

export const getMySQLShowTablesName = (row: Record<string, any>): string => {
    for (const key of Object.keys(row || {})) {
        if (!key.toLowerCase().startsWith('tables_in_')) continue;
        const value = row[key];
        if (value === undefined || value === null) continue;
        const normalized = String(value).trim();
        if (normalized !== '') return normalized;
    }
    return '';
};

export const normalizeMetadataQuerySpecs = (specs: MetadataQuerySpec[]): MetadataQuerySpec[] => {
    const seen = new Set<string>();
    const normalized: MetadataQuerySpec[] = [];
    specs.forEach((spec) => {
        const sql = String(spec.sql || '').trim();
        if (!sql) return;
        const key = `${spec.inferredType || ''}@@${sql}`;
        if (seen.has(key)) return;
        seen.add(key);
        normalized.push({ sql, inferredType: spec.inferredType });
    });
    return normalized;
};

export const buildQualifiedCompletionName = (
    schemaName: string,
    objectName: string,
    rawDialect = '',
): string => {
    const schema = String(schemaName || '').trim();
    const object = String(objectName || '').trim();
    if (!object) return '';
    // A dot inside a delimited identifier (for example `"order.items"`) is
    // part of the object name, not a qualification separator.
    if (!schema) return object;
    const dialect = String(rawDialect || '').trim();
    const segments = splitQualifiedNameSegmentsDetailed(object, dialect);
    if (segments.length > 1 && segments.some((segment) => segment.quoted)) return object;
    if (segments.length > 1) {
        return dialect
            ? `${schema}.${quoteSqlIdentifierPart(resolveSqlDialect(dialect), object)}`
            : object;
    }
    return `${schema}.${object}`;
};

export const buildCompletionViewsMetadataQuerySpecs = (
    dialect: string,
    dbName: string,
    options?: { includeCurrentOwnerFallback?: boolean },
): MetadataQuerySpec[] => {
    const safeDbName = escapeMetadataSqlLiteral(dbName);
    switch (dialect) {
        case 'mysql':
        case 'starrocks': {
            return normalizeMetadataQuerySpecs(
                buildMySQLCompatibleViewMetadataSqls(dbName).map((sql) => ({ sql })),
            );
        }
        case 'postgres':
        case 'kingbase':
        case 'highgo':
        case 'vastbase':
        case 'opengauss':
        case 'gaussdb':
            return [{ sql: `SELECT schemaname AS schema_name, viewname AS view_name FROM pg_catalog.pg_views WHERE schemaname != 'information_schema' AND schemaname NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY schemaname, viewname` }];
        case 'sqlserver':
            return [{ sql: `SELECT s.name AS schema_name, v.name AS view_name FROM sys.views v JOIN sys.schemas s ON v.schema_id = s.schema_id ORDER BY s.name, v.name` }];
        case 'oracle': {
            const includeCurrentOwnerFallback = options?.includeCurrentOwnerFallback !== false;
            if (!includeCurrentOwnerFallback && safeDbName) {
                return [{
                    sql: `SELECT OWNER AS schema_name, VIEW_NAME AS view_name FROM ALL_VIEWS WHERE OWNER = '${safeDbName.toUpperCase()}' ORDER BY VIEW_NAME`,
                }];
            }
            return normalizeMetadataQuerySpecs([
                { sql: 'SELECT VIEW_NAME AS view_name FROM USER_VIEWS ORDER BY VIEW_NAME' },
                { sql: 'SELECT OWNER AS schema_name, VIEW_NAME AS view_name FROM ALL_VIEWS WHERE OWNER = USER ORDER BY VIEW_NAME' },
                {
                    sql: safeDbName
                        ? `SELECT OWNER AS schema_name, VIEW_NAME AS view_name FROM ALL_VIEWS WHERE OWNER = '${safeDbName.toUpperCase()}' ORDER BY VIEW_NAME`
                        : '',
                },
            ]);
        }
        case 'sqlite':
            return [{ sql: 'SELECT name AS view_name FROM sqlite_master WHERE type = \'view\' ORDER BY name' }];
        case 'duckdb':
            return [{ sql: `SELECT table_schema AS schema_name, table_name AS view_name FROM information_schema.views WHERE table_schema NOT IN ('information_schema', 'pg_catalog') ORDER BY table_schema, table_name` }];
        default:
            return [];
    }
};

export const buildCompletionSynonymsMetadataQuerySpecs = (dialect: string): MetadataQuerySpec[] => {
    if (dialect !== 'oracle') {
        return [];
    }
    return [{
        sql: `SELECT OWNER AS synonym_owner, SYNONYM_NAME AS synonym_name,
  TABLE_OWNER AS target_schema_name, TABLE_NAME AS target_name
FROM ALL_SYNONYMS
WHERE DB_LINK IS NULL
  AND TABLE_NAME IS NOT NULL
ORDER BY CASE WHEN OWNER = USER THEN 0 WHEN OWNER = 'PUBLIC' THEN 1 ELSE 2 END, SYNONYM_NAME`,
    }];
};

export const buildCompletionMaterializedViewsMetadataQuerySpecs = (dialect: string, dbName: string): MetadataQuerySpec[] => {
    if (dialect !== 'starrocks') {
        return [];
    }
    const safeDbName = escapeMetadataSqlLiteral(dbName);
    const dbIdent = String(dbName || '').replace(/`/g, '``').trim();
    return normalizeMetadataQuerySpecs([
        {
            sql: safeDbName
                ? `SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS object_name FROM information_schema.tables WHERE TABLE_SCHEMA = '${safeDbName}' AND UPPER(TABLE_TYPE) LIKE '%MATERIALIZED%' ORDER BY TABLE_NAME`
                : '',
        },
        { sql: dbIdent ? `SHOW MATERIALIZED VIEWS FROM \`${dbIdent}\`` : '' },
        { sql: 'SHOW MATERIALIZED VIEWS' },
    ]);
};

export const buildCompletionTriggersMetadataQuerySpecs = (dialect: string, dbName: string): MetadataQuerySpec[] => {
    const safeDbName = escapeMetadataSqlLiteral(dbName);
    switch (dialect) {
        case 'mysql':
        case 'starrocks': {
            const dbIdent = String(dbName || '').replace(/`/g, '``').trim();
            return normalizeMetadataQuerySpecs([
                {
                    sql: safeDbName
                        ? `SELECT TRIGGER_NAME AS trigger_name, EVENT_OBJECT_TABLE AS table_name, TRIGGER_SCHEMA AS schema_name FROM information_schema.triggers WHERE trigger_schema = '${safeDbName}' ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`
                        : '',
                },
                { sql: dbIdent ? `SHOW TRIGGERS FROM \`${dbIdent}\`` : '' },
                { sql: 'SHOW TRIGGERS' },
            ]);
        }
        case 'postgres':
        case 'kingbase':
        case 'highgo':
        case 'vastbase':
        case 'opengauss':
        case 'gaussdb':
            return [{ sql: `SELECT DISTINCT event_object_schema AS schema_name, event_object_table AS table_name, trigger_name FROM information_schema.triggers WHERE trigger_schema NOT IN ('pg_catalog', 'information_schema') AND trigger_schema NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY event_object_schema, event_object_table, trigger_name` }];
        case 'sqlserver':
            return [{ sql: `SELECT s.name AS schema_name, t.name AS table_name, tr.name AS trigger_name FROM sys.triggers tr JOIN sys.tables t ON tr.parent_id = t.object_id JOIN sys.schemas s ON t.schema_id = s.schema_id WHERE tr.parent_class = 1 ORDER BY s.name, t.name, tr.name` }];
        case 'oracle':
            if (!safeDbName) {
                return [{ sql: 'SELECT TRIGGER_NAME AS trigger_name, TABLE_NAME AS table_name FROM USER_TRIGGERS ORDER BY TABLE_NAME, TRIGGER_NAME' }];
            }
            return [{ sql: `SELECT OWNER AS schema_name, TABLE_NAME AS table_name, TRIGGER_NAME AS trigger_name FROM ALL_TRIGGERS WHERE OWNER = '${safeDbName.toUpperCase()}' ORDER BY TABLE_NAME, TRIGGER_NAME` }];
        case 'sqlite':
            return [{ sql: 'SELECT name AS trigger_name, tbl_name AS table_name FROM sqlite_master WHERE type = \'trigger\' ORDER BY tbl_name, name' }];
        default:
            return [];
    }
};

export const buildCompletionFunctionsMetadataQuerySpecs = (
    dialect: string,
    dbName: string,
    options?: { includeCurrentOwnerFallback?: boolean },
): MetadataQuerySpec[] => {
    const safeDbName = escapeMetadataSqlLiteral(dbName);
    switch (dialect) {
        case 'mysql':
        case 'starrocks':
            return normalizeMetadataQuerySpecs([
                {
                    sql: safeDbName
                        ? `SELECT ROUTINE_NAME AS routine_name, ROUTINE_TYPE AS routine_type, ROUTINE_SCHEMA AS schema_name FROM information_schema.routines WHERE routine_schema = '${safeDbName}' ORDER BY ROUTINE_TYPE, ROUTINE_NAME`
                        : '',
                },
                {
                    sql: safeDbName ? `SHOW FUNCTION STATUS WHERE Db = '${safeDbName}'` : 'SHOW FUNCTION STATUS',
                    inferredType: 'FUNCTION',
                },
                {
                    sql: safeDbName ? `SHOW PROCEDURE STATUS WHERE Db = '${safeDbName}'` : 'SHOW PROCEDURE STATUS',
                    inferredType: 'PROCEDURE',
                },
            ]);
        case 'postgres':
        case 'kingbase':
        case 'highgo':
        case 'vastbase':
        case 'opengauss':
        case 'gaussdb':
            return normalizeMetadataQuerySpecs([
                {
                    sql: `SELECT n.nspname AS schema_name, p.proname AS routine_name, CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS routine_type FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY n.nspname, routine_type, p.proname`,
                },
                {
                    sql: `SELECT r.routine_schema AS schema_name, r.routine_name AS routine_name, COALESCE(NULLIF(UPPER(r.routine_type), ''), 'FUNCTION') AS routine_type FROM information_schema.routines r WHERE r.routine_schema NOT IN ('pg_catalog', 'information_schema') AND r.routine_schema NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY r.routine_schema, routine_type, r.routine_name`,
                },
                {
                    sql: `SELECT n.nspname AS schema_name, p.proname AS routine_name, 'FUNCTION' AS routine_type FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg|_%' ESCAPE '|' ORDER BY n.nspname, p.proname`,
                },
            ]);
        case 'sqlserver':
            return [{ sql: `SELECT s.name AS schema_name, o.name AS routine_name, CASE o.type WHEN 'P' THEN 'PROCEDURE' WHEN 'FN' THEN 'FUNCTION' WHEN 'IF' THEN 'FUNCTION' WHEN 'TF' THEN 'FUNCTION' END AS routine_type FROM sys.objects o JOIN sys.schemas s ON o.schema_id = s.schema_id WHERE o.type IN ('P','FN','IF','TF') ORDER BY o.type, s.name, o.name` }];
        case 'oracle':
            if (options?.includeCurrentOwnerFallback === false && safeDbName) {
                return [{
                    sql: `SELECT OWNER AS schema_name, OBJECT_NAME AS routine_name, ${ORACLE_ROUTINE_TYPE_COLUMN} FROM ALL_OBJECTS WHERE OWNER = '${safeDbName.toUpperCase()}' AND OBJECT_TYPE IN ${ORACLE_ROUTINE_OBJECT_TYPES} ORDER BY OBJECT_TYPE, OBJECT_NAME`,
                }];
            }
            return normalizeMetadataQuerySpecs([
                { sql: `SELECT OBJECT_NAME AS routine_name, ${ORACLE_ROUTINE_TYPE_COLUMN} FROM USER_OBJECTS WHERE OBJECT_TYPE IN ${ORACLE_ROUTINE_OBJECT_TYPES} ORDER BY OBJECT_TYPE, OBJECT_NAME` },
                { sql: `SELECT OWNER AS schema_name, OBJECT_NAME AS routine_name, ${ORACLE_ROUTINE_TYPE_COLUMN} FROM ALL_OBJECTS WHERE OWNER = USER AND OBJECT_TYPE IN ${ORACLE_ROUTINE_OBJECT_TYPES} ORDER BY OBJECT_TYPE, OBJECT_NAME` },
                {
                    sql: safeDbName
                        ? `SELECT OWNER AS schema_name, OBJECT_NAME AS routine_name, ${ORACLE_ROUTINE_TYPE_COLUMN} FROM ALL_OBJECTS WHERE OWNER = '${safeDbName.toUpperCase()}' AND OBJECT_TYPE IN ${ORACLE_ROUTINE_OBJECT_TYPES} ORDER BY OBJECT_TYPE, OBJECT_NAME`
                        : '',
                },
            ]);
        case 'duckdb':
            return [{
                sql: `SELECT schema_name, function_name AS routine_name, 'FUNCTION' AS routine_type FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND COALESCE(macro_definition, '') <> '' ORDER BY schema_name, function_name`,
                inferredType: 'FUNCTION',
            }];
        default:
            return [];
    }
};

export const buildCompletionSequencesMetadataQuerySpecs = (dialect: string, dbName: string): MetadataQuerySpec[] => {
    const safeDbName = escapeMetadataSqlLiteral(dbName);
    switch (dialect) {
        case 'oracle':
        case 'dm':
        case 'dameng':
            return normalizeMetadataQuerySpecs([
                {
                    sql: safeDbName
                        ? `SELECT SEQUENCE_OWNER AS schema_name, SEQUENCE_NAME AS sequence_name FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = '${safeDbName.toUpperCase()}' ORDER BY SEQUENCE_NAME`
                        : `SELECT SEQUENCE_NAME AS sequence_name FROM USER_SEQUENCES ORDER BY SEQUENCE_NAME`,
                },
            ]);
        default:
            return [];
    }
};

export const buildCompletionPackagesMetadataQuerySpecs = (dialect: string, dbName: string): MetadataQuerySpec[] => {
    const safeDbName = escapeMetadataSqlLiteral(dbName);
    switch (dialect) {
        case 'oracle':
        case 'dm':
        case 'dameng':
            return normalizeMetadataQuerySpecs([
                {
                    sql: safeDbName
                        ? `SELECT OWNER AS schema_name, OBJECT_NAME AS package_name FROM ALL_OBJECTS WHERE OWNER = '${safeDbName.toUpperCase()}' AND OBJECT_TYPE = 'PACKAGE' ORDER BY OBJECT_NAME`
                        : `SELECT OBJECT_NAME AS package_name FROM USER_OBJECTS WHERE OBJECT_TYPE = 'PACKAGE' ORDER BY OBJECT_NAME`,
                },
            ]);
        default:
            return [];
    }
};

export const queryCompletionMetadataRowsBySpecs = async (
    config: Record<string, any>,
    dbName: string,
    specs: MetadataQuerySpec[],
): Promise<MetadataQueryResult[]> => {
    const normalizedSpecs = normalizeMetadataQuerySpecs(specs);
    if (normalizedSpecs.length === 0) {
        return [];
    }
    // Compatibility specs can be complementary (Oracle owners) as well as
    // fallbacks. The same SSH tunnel/driver connection is often the shared
    // bottleneck, so serialise requests to avoid queueing and contention while
    // retaining every successful result in declaration order.
    const rpcConfig = buildRpcConnectionConfig(config) as any;
    const results: MetadataQueryResult[] = [];
    for (const spec of normalizedSpecs) {
        try {
            const result = await DBQuery(rpcConfig, dbName, spec.sql);
            if (result.success && Array.isArray(result.data)) {
                results.push({
                    rows: result.data as Record<string, any>[],
                    inferredType: spec.inferredType,
                });
            }
        } catch {
            // 忽略单条元数据查询失败，继续使用其它兼容查询结果。
        }
    }
    return results;
};
