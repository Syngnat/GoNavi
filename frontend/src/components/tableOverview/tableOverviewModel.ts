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
    /** 表级默认字符集；非 MySQL 系或取不到时为空串。 */
    charset: string;
    /** 表级默认排序规则；与 charset 成对出现。 */
    collation: string;
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

const TABLE_LIST_OVERVIEW_DIALECTS = new Set([
    'tdengine', 'sqlite', 'sqlite3', 'milvus', 'milvusdb', 'milvus-db',
    // 以下方言既没有 information_schema，也没有 internal/datasource/specs 描述文件可以覆盖表状态
    // 查询，只能在这里显式列出；否则表概览会回落到信息模式 SQL：轻则报「获取表信息失败」，
    // 重则被驱动当成元数据查询直接返回空结果，界面静默显示空列表。
    'mongodb',
    // 向量库与时序库：只有各自的集合 / 设备列表接口，没有关系型元数据。
    'chroma', 'qdrant', 'iotdb',
    // Elasticsearch 与 OpenSearch 的元数据方言都归一为 elasticsearch（见 opensearch 描述文件的
    // ddlDialect / family），两者共用同一个驱动的索引枚举接口。
    'elasticsearch',
    // 消息队列与 Redis：各自的 topic / queue / key 枚举接口就是表概览的数据来源，驱动不接受
    // SQL 元数据查询（Redis 的表清单走后端 DBGetTables 的 ScanKeys 分支）。
    'kafka', 'pulsar', 'rocketmq', 'mqtt', 'rabbitmq', 'redis',
    // HiveServer2 没有可用的 information_schema；Hive 4 会把 information_schema.tables
    // 解析成库 information_schema、表 tables，并报 Table not found 'tables'。
    // 表概览改为走驱动的 GetTables 表名列表。
    'hive',
]);

/** 表概览改用 DBGetTables 表名列表的方言：没有 information_schema 的 TDengine / SQLite / Milvus /
 * MongoDB / Chroma / Qdrant / IoTDB / Elasticsearch（含 OpenSearch），消息队列（Kafka、Pulsar、
 * RocketMQ、MQTT、RabbitMQ）与 Redis，
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
    TABLE_COLLATION AS table_collation,
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

/**
 * 从排序规则名反推字符集。
 *
 * MySQL 的排序规则名总是「字符集_后缀」；但后缀本身可能带下划线
 * （utf8mb4_0900_ai_ci），所以不能用 split('_')[0]，要按已知字符集前缀匹配。
 */
const KNOWN_CHARSETS = [
    'utf8mb4', 'utf8mb3', 'utf8', 'ucs2', 'utf16', 'utf16le', 'utf32',
    'latin1', 'latin2', 'latin5', 'latin7', 'ascii', 'binary', 'cp1250',
    'cp1251', 'cp1256', 'cp1257', 'cp850', 'cp852', 'cp866', 'dec8',
    'gb18030', 'gb2312', 'gbk', 'greek', 'hebrew', 'euckr', 'eucjpms',
    'sjis', 'ujis', 'koi8r', 'koi8u', 'macce', 'macroman', 'swe7',
    'armscii8', 'geostd8', 'keybcs2', 'tis620',
];

export const collationToCharset = (collation: string): string => {
    const value = String(collation || '').trim().toLowerCase();
    if (!value) return '';
    const match = KNOWN_CHARSETS
        .filter((charset) => value === charset || value.startsWith(`${charset}_`))
        // 取最长匹配：utf8mb4 必须先于 utf8 命中。
        .sort((left, right) => right.length - left.length)[0];
    return match || '';
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
            // information_schema.tables 只有 TABLE_COLLATION；字符集是它的前缀
            // （utf8mb4_0900_ai_ci → utf8mb4），单独再查一列会多一次往返。
            charset: collationToCharset(strVal(['Table_collation', 'table_collation', 'TABLE_COLLATION'])),
            collation: strVal(['Table_collation', 'table_collation', 'TABLE_COLLATION']),
            createTime: strVal(['Create_time', 'create_time']),
            updateTime: strVal(['Update_time', 'update_time']),
        };
    }).filter(t => t.name);
};
