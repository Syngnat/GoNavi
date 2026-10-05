import { type TableOverviewViewMode, buildSidebarTablePinKey } from '../../store';
import type {
    TableOverviewSortField,
    TableOverviewSortOrder,
} from '../../utils/tableOverviewFilter';
import { resolveObjectMetadataDialect } from '../../utils/objectMetadataDialect';
import { resolvePgTableStatsSql, resolveRegistryTableStatusSql } from '../../utils/dataSourceRegistry/tableStats';
import { getDataSourceSpec } from '../../utils/dataSourceRegistry';
import { resolveRegistryReadOnlyClassifier } from '../../utils/dataSourceRegistry/commandReadOnly';
import { extractTableNameFromMetadataRow } from '../../utils/tableMetadataRows';
import { stripSchemaFromTabObjectLabel } from '../../utils/tabDisplay';

export interface TableStatRow {
    name: string;
    comment: string;
    rows: number;
    dataSize: number;
    indexSize: number;
    engine: string;
    createTime: string;
    updateTime: string;
}

export type SortField = TableOverviewSortField;
export type SortOrder = TableOverviewSortOrder;
export type ViewMode = TableOverviewViewMode;
export type OverviewContextMenuState = {
    tableName: string;
    x: number;
    y: number;
    sourceX: number;
    sourceY: number;
    maxHeight: number;
};
export type OverviewTableSection = {
    key: string;
    kind: 'pinned' | 'all';
    rows: TableStatRow[];
};

const OVERVIEW_CONTEXT_MENU_SAFE_GAP = 8;
export const OVERVIEW_CONTEXT_MENU_WIDTH = 264;
export const OVERVIEW_CONTEXT_MENU_FALLBACK_HEIGHT = 420;
export const TABLE_OVERVIEW_CARD_HEIGHT = 180;

export const resolveOverviewContextMenuPosition = (
    x: number,
    y: number,
    options?: {
        width?: number;
        height?: number;
        viewportWidth?: number;
        viewportHeight?: number;
        safeGap?: number;
    },
): { x: number; y: number; maxHeight: number } => {
    const safeGap = options?.safeGap ?? OVERVIEW_CONTEXT_MENU_SAFE_GAP;
    const viewportWidth = options?.viewportWidth ?? (typeof window === 'undefined' ? 1024 : window.innerWidth);
    const viewportHeight = options?.viewportHeight ?? (typeof window === 'undefined' ? 768 : window.innerHeight);
    const width = Math.max(0, options?.width ?? OVERVIEW_CONTEXT_MENU_WIDTH);
    const height = Math.max(0, options?.height ?? OVERVIEW_CONTEXT_MENU_FALLBACK_HEIGHT);
    const maxX = Math.max(safeGap, viewportWidth - width - safeGap);
    const maxY = Math.max(safeGap, viewportHeight - height - safeGap);
    const nextX = Math.max(safeGap, Math.min(x, maxX));
    const nextY = Math.max(safeGap, Math.min(y, maxY));
    return {
        x: nextX,
        y: nextY,
        maxHeight: Math.max(120, viewportHeight - nextY - safeGap),
    };
};

export const formatSize = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};

export const formatRows = (count: number): string => {
    if (count === undefined || count === null || !Number.isFinite(count) || count < 0) return '—';
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
    return String(count);
};

export const isOverviewTablePinned = (
    pinnedKeys: string[],
    connectionId: string | undefined,
    dbName: string | undefined,
    schemaName: string | undefined,
    tableName: string,
): boolean => {
    const key = buildSidebarTablePinKey(connectionId || '', dbName || '', tableName, schemaName || '');
    return !!key && pinnedKeys.includes(key);
};

// 与定义查看器共用的方言归类（描述表数据源按借用方言或兼容家族查）。
export const getMetadataDialect = resolveObjectMetadataDialect;

export const isSchemaScopedTableOverviewDialect = (dialect: string): boolean => [
    'postgres',
    'kingbase',
    'vastbase',
    'highgo',
    'opengauss',
    'gaussdb',
].includes(dialect);

const TABLE_LIST_OVERVIEW_DIALECTS = new Set(['tdengine', 'sqlite', 'sqlite3', 'milvus', 'milvusdb', 'milvus-db']);

/** 表概览改用 DBGetTables 表名列表的方言：没有 information_schema 的 TDengine / SQLite / Milvus，
 * 以及非 SQL 查询语言、也没有声明表状态查询的描述表数据源（etcd、ZooKeeper、Weaviate、InfluxDB 等）。 */
export const usesTableListOverview = (dialect: string, connType?: string): boolean => {
    if (TABLE_LIST_OVERVIEW_DIALECTS.has(dialect)) return true;
    return Boolean(getDataSourceSpec(connType))
        && !resolveRegistryTableStatusSql(connType, '')
        && Boolean(resolveRegistryReadOnlyClassifier(dialect));
};

export const getTableOverviewDisplayName = (dialect: string, tableName: string): string => {
    const rawName = String(tableName || '').trim();
    if (!isSchemaScopedTableOverviewDialect(dialect)) return rawName;
    return stripSchemaFromTabObjectLabel(rawName) || rawName;
};

export const buildTableStatusSQL = (dialect: string, dbName: string, schemaName?: string, connType?: string, serverVersion?: string): string => {
        const escapeLiteral = (s: string) => s.replace(/'/g, "''");
        const iotdbDevicePattern = (name: string) => {
            const normalized = String(name || '').trim().replace(/[`"]/g, '');
            if (!normalized) return '';
            return normalized.endsWith('.**') ? normalized : `${normalized}.**`;
        };
        switch (dialect) {
        case 'mysql':
        case 'starrocks':
            return `
SELECT
    TABLE_NAME AS table_name,
    TABLE_COMMENT AS table_comment,
    TABLE_ROWS AS table_rows,
    DATA_LENGTH AS data_length,
    INDEX_LENGTH AS index_length,
    ENGINE AS engine,
    CREATE_TIME AS create_time,
    UPDATE_TIME AS update_time
FROM information_schema.tables
WHERE table_schema = '${escapeLiteral(dbName)}'
  AND table_type = 'BASE TABLE'
ORDER BY table_name`;
        case 'postgres':
        case 'kingbase':
        case 'vastbase':
        case 'highgo':
        case 'opengauss':
        case 'gaussdb': {
            const schema = schemaName || 'public';
            const stats = resolvePgTableStatsSql(connType, serverVersion);
            return `
SELECT
    n.nspname || '.' || c.relname AS table_name,
    obj_description(c.oid, 'pg_class') AS table_comment,
    ${stats.rows} AS table_rows,
    ${stats.size} AS data_length,
    ${stats.indexSize} AS index_length
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname = '${escapeLiteral(schema)}'
ORDER BY c.relname`;
        }
        case 'sqlserver': {
            return `
SELECT
    s.name + '.' + t.name AS table_name,
    CONVERT(nvarchar(4000), ep.value) AS table_comment,
    SUM(p.rows) AS table_rows,
    CAST(NULL AS bigint) AS data_length,
    CAST(NULL AS bigint) AS index_length
FROM sys.tables t
JOIN sys.schemas s ON t.schema_id = s.schema_id
LEFT JOIN sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description'
LEFT JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
WHERE t.type = 'U'
GROUP BY s.name, t.name, CONVERT(nvarchar(4000), ep.value)
ORDER BY s.name, t.name`;
        }
        case 'clickhouse':
            return `SELECT name AS table_name, comment AS table_comment, total_rows AS table_rows, total_bytes AS data_length, 0 AS index_length FROM system.tables WHERE database = '${escapeLiteral(dbName)}' AND engine NOT IN ('View', 'MaterializedView') ORDER BY name`;
        case 'tdengine':
            return `SHOW TABLES FROM \`${dbName.replace(/`/g, '``')}\``;
        case 'iotdb': {
            const pattern = iotdbDevicePattern(dbName);
            return pattern ? `SHOW DEVICES ${pattern}` : 'SHOW DEVICES';
        }
        case 'dm':
        case 'oracle': {
            const owner = (schemaName || dbName).toUpperCase();
            return `SELECT table_name, comments AS table_comment, num_rows AS table_rows, NULL AS data_length, NULL AS index_length FROM all_tab_comments JOIN all_tables USING (table_name, owner) WHERE owner = '${escapeLiteral(owner)}' ORDER BY table_name`;
        }
        default:
            return resolveRegistryTableStatusSql(connType, dbName, serverVersion) || `SELECT table_name, '' AS table_comment, 0 AS table_rows, NULL AS data_length, NULL AS index_length FROM information_schema.tables WHERE table_schema = '${escapeLiteral(dbName)}' AND table_type = 'BASE TABLE' ORDER BY table_name`;
    }
};

export const parseTableStats = (dialect: string, rows: Record<string, any>[]): TableStatRow[] => {
    return rows.map((row) => {
        const get = (keys: string[]): any => {
            for (const k of keys) {
                for (const rk of Object.keys(row)) {
                    if (rk.toLowerCase() === k.toLowerCase() && row[rk] !== null && row[rk] !== undefined) return row[rk];
                }
            }
            return undefined;
        };
        const strVal = (keys: string[]) => String(get(keys) ?? '').trim();
        const numVal = (keys: string[], missingValue = 0) => {
            const v = get(keys);
            if (v === null || v === undefined || v === '') return missingValue;
            const n = Number(v);
            return isNaN(n) ? missingValue : Math.max(0, Math.round(n));
        };

        return {
            name: extractTableNameFromMetadataRow(row) || strVal(['Device', 'device']),
            comment: strVal(['Comment', 'table_comment', 'TABLE_COMMENT', 'comments']),
            rows: numVal(['Rows', 'table_rows', 'TABLE_ROWS', 'num_rows', 'reltuples', 'total_rows'], -1),
            dataSize: numVal(['Data_length', 'data_length', 'DATA_LENGTH', 'total_bytes'], -1),
            indexSize: numVal(['Index_length', 'index_length', 'INDEX_LENGTH'], -1),
            engine: strVal(['Engine', 'engine']),
            createTime: strVal(['Create_time', 'create_time']),
            updateTime: strVal(['Update_time', 'update_time']),
        };
    }).filter(t => t.name);
};
