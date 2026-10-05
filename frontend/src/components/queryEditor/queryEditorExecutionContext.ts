import {
    resolveSqlDialect,
    isMysqlFamilyDialect,
    isPgLikeDialect,
    isOracleLikeDialect,
} from '../../utils/sqlDialect';
import { normalizeTableAliasPrefix } from '../../utils/tableAliasPrefix';
import {
    type QueryEditorExecutionContext,
    collectQueryEditorTableReferences,
    resolveIotdbVisibleStorageGroup,
    usesQueryEditorCatalogQualifiedTwoPartNames,
    analyzeQueryEditorTableReferences,
} from './queryEditorTableReferences';
import { maskQueryEditorSqlLiteralsAndComments } from './queryEditorSqlScan';
import {
    stripQueryIdentifierQuotesForDialect,
    splitQueryIdentifierPathSegments,
} from './queryEditorIdentifierPaths';
import { buildQueryEditorIdentifierIdentityKey } from './queryEditorReferenceIdentity';
import { getCompletionQualifiedNameLastPart } from './queryEditorCompletionMetadata';

/** Resolve the database/schema explicitly named by the SQL, without changing SQL text. */
export const resolveQueryEditorExecutionContext = (
    source: string,
    dialect: string,
    currentDb = '',
    currentSchema = '',
    visibleDbs: string[] = [],
): QueryEditorExecutionContext => {
    const normalized = String(resolveSqlDialect(dialect) || dialect || '').toLowerCase();
    const visible = new Map(visibleDbs.map((name) => [String(name).trim().toLowerCase(), String(name).trim()] as const));
    const canonical = (name: string) => visible.get(name.toLowerCase()) || name;
    const result: QueryEditorExecutionContext = {};
    const masked = maskQueryEditorSqlLiteralsAndComments(String(source || ''), normalized);
    const useMatch = (isMysqlFamilyDialect(normalized) || ['sqlserver', 'clickhouse', 'tdengine'].includes(normalized))
        && masked.match(/^\s*use\s+(`[^`]+`|"[^"]+"|\[[^\]]+\]|[A-Za-z0-9_$-]+)/i);
    if (useMatch) result.dbName = canonical(stripQueryIdentifierQuotesForDialect(useMatch[1], normalized));
    for (const reference of collectQueryEditorTableReferences(source, normalized)) {
        const parts = reference.parts.map((part) => String(part || '').trim()).filter(Boolean);
        if (parts.length < 2) continue;
        if (normalized === 'iotdb') {
            // Storage groups are multi-segment paths such as root.ln, not the
            // first identifier of a timeseries (root).
            const storageGroup = resolveIotdbVisibleStorageGroup(parts, visible);
            if (storageGroup) result.dbName = storageGroup;
        } else if (normalized === 'trino') {
            // Toolbar namespaces are catalog.schema. Two-part schema.table
            // stays in the current catalog; only catalog.schema.table can switch.
            if (parts.length >= 3) result.dbName = canonical(`${parts[0]}.${parts[1]}`);
        } else if (normalized === 'sqlserver') {
            if (parts.length >= 3) result.dbName = canonical(parts[0]);
        } else if (isPgLikeDialect(normalized)) {
            if (parts.length >= 3) {
                result.dbName = canonical(parts[0]);
                result.schemaName = parts[1];
            } else if (parts.length === 2) {
                result.schemaName = parts[0];
            }
        } else if (
            isOracleLikeDialect(normalized)
            || normalized === 'sqlite'
            || normalized === 'duckdb'
            || normalized === 'iris'
        ) {
            // owner.table / schema.table / attached-db.table is already
            // qualified. Switching the toolbar catalog reconnects or reloads
            // the wrong namespace (Oracle CURRENT_SCHEMA, IRIS namespace,
            // DuckDB/SQLite attached catalog).
            continue;
        } else if (usesQueryEditorCatalogQualifiedTwoPartNames(normalized) && parts.length === 2) {
            result.dbName = canonical(parts[0]);
        }
        if (result.dbName || result.schemaName) break;
    }
    if (result.dbName && result.dbName.toLowerCase() === String(currentDb).trim().toLowerCase()) delete result.dbName;
    if (!result.dbName && result.schemaName === String(currentSchema).trim()) delete result.schemaName;
    return result;
};

export const isQueryEditorTableSourceCompletionContext = (source: string, dbType = ''): boolean => (
    analyzeQueryEditorTableReferences(source, dbType).expectsTableSource
);

export const isQueryEditorTableAliasCompletionContext = (source: string, dbType = ''): boolean => (
    analyzeQueryEditorTableReferences(source, dbType).allowsTableAlias
);

export type QueryEditorAliasMap = Record<
    string,
    { dbName: string; tableName: string; explicitOwnerName?: string }
>;

export const buildQueryEditorAliasMap = (
    fullText: string,
    currentDb: string,
    dbType = '',
): QueryEditorAliasMap => {
    const aliasMap: QueryEditorAliasMap = {};
    for (const reference of collectQueryEditorTableReferences(fullText, dbType)) {
        const tableIdent = reference.tableIdent;
        if (!tableIdent) continue;
        const parts = reference.parts;
        let dbName = currentDb || '';
        let tableName = tableIdent;
        let explicitOwnerName = '';
        if (parts.length === 2) {
            dbName = parts[0];
            tableName = parts[1];
            explicitOwnerName = parts[0];
        } else if (parts.length >= 3) {
            dbName = parts[0];
            tableName = parts.slice(1).join('.');
        }
        const shortTable = reference.segments?.[reference.segments.length - 1]
            || splitQueryIdentifierPathSegments(parts[parts.length - 1] || '', dbType)[0];
        const aliasTarget = explicitOwnerName
            ? { dbName, tableName, explicitOwnerName }
            : { dbName, tableName };
        const shortTableKey = shortTable ? buildQueryEditorIdentifierIdentityKey([shortTable], dbType) : '';
        if (shortTableKey) aliasMap[shortTableKey] = aliasTarget;

        const aliasSegment = reference.aliasSegment;
        if (!aliasSegment && !reference.alias) continue;
        const aliasKey = aliasSegment
            ? buildQueryEditorIdentifierIdentityKey([aliasSegment], dbType)
            : buildQueryEditorIdentifierIdentityKey(splitQueryIdentifierPathSegments(reference.alias || '', dbType), dbType);
        if (aliasKey) aliasMap[aliasKey] = aliasTarget;
    }
    return aliasMap;
};

/**
 * 为 SQL 表源生成短别名。配置有效自定义前缀时从 prefix0 连续编号；否则使用
 * 表名单词首字母。同一语句中已使用的别名会避让冲突。
 */
export const buildQueryEditorTableSourceAlias = (
    tableName: string,
    statementText: string,
    dbType = '',
    customPrefix = '',
): string => {
    const prefix = normalizeTableAliasPrefix(customPrefix);
    const table = getCompletionQualifiedNameLastPart(tableName);
    const baseAlias = prefix || table
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9$]+/)
        .filter((word) => /^[A-Za-z]/.test(word))
        .map((word) => word[0].toLowerCase())
        .join('');
    if (!baseAlias) return '';

    const usedAliases = new Set(
        collectQueryEditorTableReferences(statementText, dbType)
            .map((reference) => String(reference.alias || '').trim().toLowerCase())
            .filter(Boolean),
    );
    if (prefix) {
        let suffix = 0;
        while (usedAliases.has(`${prefix}${suffix}`.toLowerCase())) {
            suffix += 1;
        }
        return `${prefix}${suffix}`;
    }

    if (!usedAliases.has(baseAlias)) return baseAlias;

    let suffix = 2;
    while (usedAliases.has(`${baseAlias}${suffix}`)) {
        suffix += 1;
    }
    return `${baseAlias}${suffix}`;
};

/**
 * 常见「schema」名：两段限定时优先当作 schema.table（PG/SQL Server），
 * 不把它们推断成需要跨库拉取的 database。
 */
export const QUERY_EDITOR_COMMON_SCHEMA_NAME_SET = new Set([
    'public',
    'dbo',
    'sys',
    'information_schema',
    'pg_catalog',
    'pg_toast',
    'mysql',
    'performance_schema',
    'sysdb',
    'guest',
]);

const QUERY_EDITOR_SCHEMA_QUALIFIED_TWO_PART_DIALECTS = new Set([
    'postgres', 'kingbase', 'highgo', 'vastbase', 'opengauss', 'gaussdb',
    'sqlserver', 'sqlite', 'duckdb', 'iris', 'trino',
]);

export const usesQueryEditorSchemaQualifiedTwoPartNames = (dialect: string): boolean => (
    QUERY_EDITOR_SCHEMA_QUALIFIED_TWO_PART_DIALECTS.has(String(resolveSqlDialect(dialect) || '').toLowerCase())
);

export const usesQueryEditorDatabaseQualifiedTwoPartNames = (dialect: string): boolean => {
    const normalizedDialect = String(resolveSqlDialect(dialect) || '').toLowerCase();
    return isMysqlFamilyDialect(normalizedDialect)
        || isOracleLikeDialect(normalizedDialect)
        || normalizedDialect === 'clickhouse'
        || normalizedDialect === 'tdengine';
};

export const collectQueryEditorReferencedDatabaseNames = (
    fullText: string,
    currentDb: string,
    visibleDbs: string[],
    dialect = '',
): string[] => {
    const result: string[] = [];
    const seen = new Set<string>();
    const addDb = (dbName: string) => {
        const normalized = String(dbName || '').trim();
        if (!normalized) return;
        const key = normalized.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        result.push(normalized);
    };

    addDb(currentDb);

    const visibleDbByLower = new Map(
        visibleDbs
            .map((db) => String(db || '').trim())
            .filter(Boolean)
            .map((db) => [db.toLowerCase(), db] as const),
    );
    const currentDbKey = String(currentDb || '').trim().toLowerCase();
    const normalizedDialect = String(resolveSqlDialect(dialect) || dialect || '').trim().toLowerCase();
    const ownerScopedDialect = new Set(['oracle', 'dameng', 'dm']).has(normalizedDialect);
    const schemaScopedDialect = ownerScopedDialect
        || usesQueryEditorSchemaQualifiedTwoPartNames(normalizedDialect);
    for (const reference of collectQueryEditorTableReferences(fullText, normalizedDialect)) {
        const tableIdent = reference.tableIdent;
        if (!tableIdent) continue;
        const parts = reference.parts.map((part) => String(part || '').trim()).filter(Boolean);
        if (parts.length < 2) continue;

        if (normalizedDialect === 'iotdb') {
            const storageGroup = resolveIotdbVisibleStorageGroup(parts, visibleDbByLower);
            if (storageGroup && storageGroup.toLowerCase() !== currentDbKey) {
                addDb(storageGroup);
            }
            continue;
        }
        if (normalizedDialect === 'trino') {
            if (parts.length >= 3) {
                const namespace = `${parts[0]}.${parts[1]}`;
                const key = namespace.toLowerCase();
                if (key !== currentDbKey) {
                    addDb(visibleDbByLower.get(key) || namespace);
                }
            }
            continue;
        }
        if (usesQueryEditorCatalogQualifiedTwoPartNames(normalizedDialect) && parts.length !== 2) {
            // catalog.db.table (StarRocks/Doris/ClickHouse) is already qualified.
            continue;
        }

        const firstPart = parts[0];
        const firstKey = firstPart.toLowerCase();
        const asVisibleDb = visibleDbByLower.get(firstKey);
        if (schemaScopedDialect) {
            // Oracle/DM expose schema owners through the UI's database picker.
            // Every qualified reference therefore identifies an owner that may
            // need its own metadata load, including schema.package.member.
            if (ownerScopedDialect) {
                if (firstKey && firstKey !== currentDbKey) {
                    addDb(asVisibleDb || firstPart);
                }
                continue;
            }
            // PostgreSQL/SQL Server/DuckDB use schema.table for two-part
            // references. Only their three-part form can carry an explicit
            // database; two-part references stay in the current database.
            if (parts.length < 3) {
                continue;
            }
            if (firstKey && firstKey !== currentDbKey && !QUERY_EDITOR_COMMON_SCHEMA_NAME_SET.has(firstKey)) {
                addDb(asVisibleDb || firstPart);
            }
            continue;
        }
        if (asVisibleDb) {
            // MySQL: db.table；PG 三段 db.schema.table 的首段也是库
            addDb(asVisibleDb);
            continue;
        }

        // 三段及以上：首段通常是 database（PG/SQL Server 跨库限定）
        if (parts.length >= 3) {
            if (firstKey && firstKey !== currentDbKey && !QUERY_EDITOR_COMMON_SCHEMA_NAME_SET.has(firstKey)) {
                addDb(firstPart);
            }
            continue;
        }

        // 两段：可能是 MySQL 的 db.table，也可能是 PG 的 schema.table。
        // - 常见 schema 名不当库拉（避免 public/dbo 误请求）
        // - 其它未知前缀：若在可见库中已处理；若不在可见库但仍不像 schema，
        //   也作为候选库名拉取（覆盖 includeDatabases 过滤后手写跨库、或列表尚未刷新）
        if (
            firstKey
            && firstKey !== currentDbKey
            && !QUERY_EDITOR_COMMON_SCHEMA_NAME_SET.has(firstKey)
        ) {
            addDb(firstPart);
        }
    }
    return result;
};
