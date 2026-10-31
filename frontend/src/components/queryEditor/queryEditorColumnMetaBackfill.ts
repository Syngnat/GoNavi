import { DBGetColumns } from '../../../wailsjs/go/app/App';
import type { ColumnDefinition } from '../../types';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import {
  extractQueryResultSourceTables,
  maskQueryResultSqlStructure,
  type QueryResultSourceTable,
} from '../../utils/queryResultTable';
import { buildColumnMetaMap, hasUsableColumnMeta, type ColumnMeta } from '../dataGridColumnMeta';
import {
  LOCATOR_META_TTL_MS,
  getLocatorMetaCacheKey,
  getLocatorMetaCached,
} from '../../utils/queryLocatorMetaCache';
import { SIDEBAR_DATABASE_REFRESH_EVENT } from '../../utils/sidebarDatabaseRefresh';
import { isOracleLikeDialect } from '../../utils/sqlDialect';
import { resolveSqlEditorOperationKeyword } from '../../utils/sqlEditorTransaction';
import { resolveOracleLikeExecutionSchemaName } from './queryEditorIdentifierPaths';
import { splitTopLevelComma } from './queryEditorSelectRewrite';
import { withSoftTimeout } from './queryEditorResultMessages';

type RpcConfigSource = Parameters<typeof buildRpcConnectionConfig>[0];
type RpcConnectionConfig = Parameters<typeof DBGetColumns>[0];

/**
 * 回填自己的软超时，比可写回定位的 1500ms 更短：
 * 执行路径上每条语句是串行构建计划的，这里的元数据只影响表头显示，不值得让执行多等。
 * 候选表并行请求，所以整段最坏耗时就是这一个值；命中缓存时近零。
 */
const COLUMN_META_BACKFILL_TIMEOUT_MS = 1000;

/** schema 推导入参：执行计划与批量回填共用同一套推导，避免两条路径默认 schema 不一致。 */
export type QueryResultBackfillSchemaInput = {
  dbType: string;
  currentDb: string;
  schemaName?: string;
  config: RpcConfigSource;
};

const isKingbaseDialect = (dbType: string): boolean => (
  ['kingbase', 'kingbase8', 'kingbasees', 'kingbasev8'].includes(String(dbType || '').trim().toLowerCase())
);

export const getQueryResultLocatorMetaCacheKey = (config: RpcConfigSource, dbName: string, tableName: string): string => {
  const key = getLocatorMetaCacheKey(config, dbName, tableName);
  if (!isKingbaseDialect(String(config.type || config.dbType || config.driver || ''))) return key;
  let uriSearchPaths: string[] = [];
  try { uriSearchPaths = new URL(String(config.uri || '')).searchParams.getAll('search_path'); } catch { /* No URI. */ }
  const explicitSearchPaths = new URLSearchParams(String(config.connectionParams || '')).getAll('search_path');
  const searchPath = explicitSearchPaths.at(-1) ?? uriSearchPaths.at(-1) ?? '';
  return `${key}|search_path=${encodeURIComponent(searchPath)}`;
};

export const resolveQueryResultBackfillDefaultSchema = ({
  dbType,
  currentDb,
  schemaName,
  config,
}: QueryResultBackfillSchemaInput): string => (
  isOracleLikeDialect(dbType)
    ? resolveOracleLikeExecutionSchemaName(config, currentDb)
    : isKingbaseDialect(dbType)
      ? ''
      : String(schemaName || '').trim()
);

/** 语句级请求：statement + schema 推导入参。 */
export type QueryResultColumnMetaBackfillRequest = QueryResultBackfillSchemaInput & {
  statement: string;
};

export type QueryResultColumnMetaBackfillParams = {
  statement: string;
  dbType: string;
  currentDb: string;
  defaultSchema: string;
  config: RpcConfigSource;
};

/**
 * 回填专用缓存：**不写** locatorMetaCache。
 * 严格路径把「columns 命中 + indexes 缺失」当成可用快照（接受 120s 内退化到全列定位），
 * 回填只拿得到 columns，若写进同一个缓存就会人为制造那段退化窗口。
 * 这里只读 locatorMetaCache（复用主键/索引快照里的列定义），写入落本模块的私有表。
 */
type BackfillCacheEntry = { ts: number; columns: ColumnDefinition[] | null };

const backfillColumnCache = new Map<string, BackfillCacheEntry>();
const backfillInFlight = new Map<string, Promise<ColumnDefinition[]>>();
const BACKFILL_CACHE_MAX_ENTRIES = 200;
/** 失败/不存在的表（CTE 名、位置词、临时对象）用更短 TTL，既不去重复打 IPC，也不会长期挡住真表。 */
const BACKFILL_NEGATIVE_TTL_MS = 30_000;

const readBackfillCache = (cacheKey: string, now = Date.now()): ColumnDefinition[] | null | undefined => {
  const entry = backfillColumnCache.get(cacheKey);
  if (!entry) return undefined;
  const ttl = entry.columns ? LOCATOR_META_TTL_MS : BACKFILL_NEGATIVE_TTL_MS;
  if (now - entry.ts > ttl) {
    backfillColumnCache.delete(cacheKey);
    return undefined;
  }
  return entry.columns;
};

const writeBackfillCache = (cacheKey: string, columns: ColumnDefinition[] | null, now = Date.now()): void => {
  backfillColumnCache.set(cacheKey, { ts: now, columns: columns && columns.length > 0 ? columns : null });
  while (backfillColumnCache.size > BACKFILL_CACHE_MAX_ENTRIES) {
    const oldest = backfillColumnCache.keys().next().value;
    if (oldest === undefined) break;
    backfillColumnCache.delete(oldest);
  }
};

let backfillInvalidationListenerAttached = false;
let backfillCacheGeneration = 0;

/** 结构变更（DDL）后列定义可能已变：与可写回定位缓存同样即时失效，而不是等 TTL。 */
const ensureBackfillCacheInvalidationListener = (): void => {
  if (backfillInvalidationListenerAttached) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  backfillInvalidationListenerAttached = true;
  window.addEventListener(SIDEBAR_DATABASE_REFRESH_EVENT, () => {
    clearQueryResultColumnMetaBackfillCache();
  });
};

/** 仅供测试：清空回填缓存与在途请求记录。 */
export const clearQueryResultColumnMetaBackfillCache = (): void => {
  backfillCacheGeneration += 1;
  backfillColumnCache.clear();
  backfillInFlight.clear();
};

/** 合并多张候选表的列元数据：按列名（大小写无关）先到先得，主表在前。 */
export const mergeColumnMetaMapsByPriority = (
  maps: Array<Record<string, ColumnMeta>>,
): Record<string, ColumnMeta> => {
  const merged: Record<string, ColumnMeta> = {};
  const seen = new Set<string>();
  maps.forEach((map) => {
    Object.entries(map || {}).forEach(([name, meta]) => {
      const key = String(name || '').trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      merged[name] = meta;
    });
  });
  return merged;
};

const fetchCandidateColumns = async (
  config: RpcConfigSource,
  ref: QueryResultSourceTable['ref'],
  cacheKey: string,
): Promise<ColumnDefinition[]> => {
  const generation = backfillCacheGeneration;
  const request = DBGetColumns(
    buildRpcConnectionConfig(config) as unknown as RpcConnectionConfig,
    ref.metadataDbName,
    ref.metadataTableName,
  );
  const res = await withSoftTimeout(
    request,
    () => ({ success: false, message: 'Timed out while loading columns', data: [] }),
    COLUMN_META_BACKFILL_TIMEOUT_MS,
  );
  const succeeded = res?.success === true;
  const columns = succeeded && Array.isArray(res.data) && res.data.length > 0
    ? res.data as ColumnDefinition[]
    : null;
  // 只有成功的结果才进缓存：软超时（冷启动首次连元数据通道常超过 1s）或请求失败时写负缓存，
  // 会把该表整段负 TTL 都锁成「无类型/注释」，表现就是同一条 SQL 时而有时而没有。
  // 成功但空结果仍按负缓存去重，那是表确实不存在（CTE 名、临时对象）。
  if (succeeded && generation === backfillCacheGeneration) {
    writeBackfillCache(cacheKey, columns);
  } else {
    // 软超时只是不再阻塞表头渲染，请求本身还在飞：等它回来补写缓存，下一次查询直接命中。
    void request
      .then((late) => {
        if (generation === backfillCacheGeneration && !backfillColumnCache.has(cacheKey)
          && late?.success && Array.isArray(late.data) && late.data.length > 0) {
          writeBackfillCache(cacheKey, late.data as ColumnDefinition[]);
        }
      })
      .catch(() => undefined);
  }
  return columns || [];
};

const loadCandidateColumns = async (
  config: RpcConfigSource,
  ref: QueryResultSourceTable['ref'],
): Promise<ColumnDefinition[]> => {
  const cacheKey = getQueryResultLocatorMetaCacheKey(config, ref.metadataDbName, ref.metadataTableName);
  // 可写回定位已经取过的列定义直接复用；只读，不改写它的快照。
  const locatorColumns = getLocatorMetaCached(cacheKey)?.columns;
  if (locatorColumns && locatorColumns.length > 0) return locatorColumns;

  const cachedColumns = readBackfillCache(cacheKey);
  if (cachedColumns !== undefined) return cachedColumns || [];

  // 连按执行时同一批表不重复打 IPC
  const inFlight = backfillInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  ensureBackfillCacheInvalidationListener();
  const request = fetchCandidateColumns(config, ref, cacheKey).finally(() => {
    if (backfillInFlight.get(cacheKey) === request) backfillInFlight.delete(cacheKey);
  });
  backfillInFlight.set(cacheKey, request);
  return request;
};

/**
 * 批量预热：多语句脚本先一次性把所有候选表取齐（并行 + 去重，只等一次超时），
 * 之后逐条合并全部命中缓存，避免每条语句各等一轮。
 */
export const prewarmQueryResultColumnMeta = async (
  requests: QueryResultColumnMetaBackfillParams[],
): Promise<void> => {
  const unique = new Map<string, { config: RpcConfigSource; ref: QueryResultSourceTable['ref'] }>();
  requests.forEach((request) => {
    extractQueryResultSourceTables(request.statement, request.dbType, request.currentDb, request.defaultSchema)
      .forEach(({ ref }) => {
        const key = getQueryResultLocatorMetaCacheKey(request.config, ref.metadataDbName, ref.metadataTableName);
        if (!unique.has(key)) unique.set(key, { config: request.config, ref });
      });
  });
  if (unique.size === 0) return;
  await Promise.all([...unique.values()].map(({ config, ref }) => (
    loadCandidateColumns(config, ref).catch(() => [] as ColumnDefinition[])
  )));
};

/**
 * 复杂查询（JOIN / GROUP BY / 派生表 / 逗号多表）无法唯一定位单表时，按列名回填列类型与注释：
 * 宽松解析出全部候选源表 → 并行取列定义 → 按候选顺序合并成「列名 → 元数据」，
 * 再把带别名的选择项按「别名 → 源列」补一份，使表头按结果列名也能查到类型。
 * 匹配不到的列（聚合别名、窗口函数、常量表达式）自然没有类型行。
 * 只服务显示，不参与可写回定位。
 */
const isSelectStatement = (statement: string, dbType: string): boolean => (
  resolveSqlEditorOperationKeyword(statement, dbType) === 'select'
);

const columnMetaKeyOf = (name: string): string => String(name || '').trim().toLowerCase();

const findColumnMeta = (
  metaMap: Record<string, ColumnMeta>,
  columnName: string,
): ColumnMeta | undefined => {
  const direct = metaMap[columnName];
  if (direct) return direct;
  const target = columnMetaKeyOf(columnName);
  if (!target) return undefined;
  const hits = Object.entries(metaMap).filter(([name]) => columnMetaKeyOf(name) === target);
  return hits.length === 1 ? hits[0][1] : undefined;
};

export type QueryResultSelectAliasEntry = {
  /** 结果集里出现的列名（别名） */
  resultColumn: string;
  /** 对应的源列名 */
  sourceColumn: string;
  /** 表达式里的表限定词（`c.name` 的 `c`），没有则为空串 */
  qualifier: string;
};

/** 最外层 SELECT 列表在原文里的区间；拿不到（如 WITH 开头）就返回 undefined。 */
const resolveOuterSelectListRange = (statement: string, dbType: string): { start: number; end: number } | undefined => {
  const structural = maskQueryResultSqlStructure(statement, dbType);
  const head = /^\s*SELECT\s+/i.exec(structural);
  if (!head) return undefined;
  const listStart = head[0].length;
  const fromMatch = /\s+FROM\s+/i.exec(structural.slice(listStart));
  if (!fromMatch) return undefined;
  return { start: listStart, end: listStart + fromMatch.index + fromMatch[0].search(/FROM/i) };
};

const SQL_IDENTIFIER_PATTERN = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[\\p{L}_][\\p{L}\\p{N}_$#]*)';
const COLUMN_PATH_ONLY_REGEX = new RegExp(`^${SQL_IDENTIFIER_PATTERN}(?:\\s*\\.\\s*${SQL_IDENTIFIER_PATTERN}){0,3}$`, 'u');
const SELECT_ITEM_AS_ALIAS_REGEX = new RegExp(`^([\\s\\S]+?)\\s+AS\\s+(${SQL_IDENTIFIER_PATTERN})\\s*$`, 'iu');
const SELECT_ITEM_BARE_ALIAS_REGEX = new RegExp(`^([\\s\\S]+?)\\s+(${SQL_IDENTIFIER_PATTERN})\\s*$`, 'u');

const stripAliasQuotes = (value: string): string => String(value || '').replace(/^["`\[]|["`\]]$/g, '');

const splitColumnPath = (expr: string): string[] => (
  expr.split('.').map((part) => stripAliasQuotes(part.trim())).filter(Boolean)
);

/**
 * 解析单个 SELECT 项：只有**纯列引用**（`c.name`、`name`，可带中文/引号别名）才产出映射；
 * 聚合、窗口、函数与常量表达式源列类型本就不同，直接跳过。
 */
const resolveSelectItemMapping = (item: string): QueryResultSelectAliasEntry | 'all' | undefined => {
  const text = String(item || '').trim();
  if (!text) return undefined;
  if (/^\*$/.test(text) || /\.\s*\*$/.test(text)) return 'all';

  const buildEntry = (expr: string, alias: string): QueryResultSelectAliasEntry | undefined => {
    if (!COLUMN_PATH_ONLY_REGEX.test(expr)) return undefined;
    const parts = splitColumnPath(expr);
    if (parts.length === 0) return undefined;
    return {
      resultColumn: alias || parts[parts.length - 1],
      sourceColumn: parts[parts.length - 1],
      qualifier: parts.length >= 2 ? parts[parts.length - 2] : '',
    };
  };

  const asMatch = SELECT_ITEM_AS_ALIAS_REGEX.exec(text);
  if (asMatch) return buildEntry(asMatch[1].trim(), stripAliasQuotes(asMatch[2]));

  if (COLUMN_PATH_ONLY_REGEX.test(text)) return buildEntry(text, '');

  // 没有 AS 的别名：只在前面是纯列引用时才认，避免把表达式误当别名映射
  const bareMatch = SELECT_ITEM_BARE_ALIAS_REGEX.exec(text);
  if (!bareMatch) return undefined;
  return buildEntry(bareMatch[1].trim(), stripAliasQuotes(bareMatch[2]));
};

/**
 * 解析最外层 SELECT 列表的「结果列名 → 源列名」：显式别名（`c.name AS 姓名`）与
 * 纯列引用（`c.name`）都会产出，聚合/窗口/函数表达式不产出（源列类型本就对不上）。
 */
export const resolveQueryResultSelectAliasEntries = (
  statement: string,
  dbType: string,
): QueryResultSelectAliasEntry[] => {
  const range = resolveOuterSelectListRange(statement, dbType);
  if (!range) return [];
  // DISTINCT 只是修饰符，不是选择项的一部分
  const listText = statement.slice(range.start, range.end).replace(/^\s*DISTINCT\s+/i, '');
  const entries: QueryResultSelectAliasEntry[] = [];
  splitTopLevelComma(listText, dbType).forEach((item) => {
    const resolved = resolveSelectItemMapping(item);
    if (!resolved || resolved === 'all') return;
    entries.push(resolved);
  });
  return entries;
};

const resolveQualifiedTableMeta = (
  tables: QueryResultSourceTable[],
  metaMaps: Array<Record<string, ColumnMeta>>,
  qualifier: string,
  sourceColumn: string,
): ColumnMeta | undefined => {
  const target = columnMetaKeyOf(qualifier);
  if (!target) return undefined;
  const candidates = tables.map((table, position) => ({ table, position })).filter(({ table, position }) => (
    Boolean(metaMaps[position])
    && (columnMetaKeyOf(table.alias) === target
      || columnMetaKeyOf(table.ref.metadataTableName.split('.').pop() || '') === target)
  ));
  if (candidates.length !== 1) return undefined;
  return findColumnMeta(metaMaps[candidates[0].position], sourceColumn);
};

export const resolveQueryResultColumnMetaByCandidateTables = async ({
  statement,
  dbType,
  currentDb,
  defaultSchema,
  config,
}: QueryResultColumnMetaBackfillParams): Promise<Record<string, ColumnMeta> | undefined> => {
  // 只有 SELECT 结果集需要列元数据；PL/SQL 块、DDL、DML 里出现的 FROM 不是结果列来源
  if (!isSelectStatement(statement, dbType)) return undefined;
  const tables = extractQueryResultSourceTables(statement, dbType, currentDb, defaultSchema);
  if (tables.length === 0) return undefined;

  const perTableColumns = await Promise.all(
    tables.map((table) => loadCandidateColumns(config, table.ref).catch(() => [] as ColumnDefinition[])),
  );
  const metaMaps = perTableColumns.map((columns) => buildColumnMetaMap(columns));
  const usableMaps = metaMaps.filter((map) => hasUsableColumnMeta(map));
  if (usableMaps.length === 0) return undefined;

  const merged = isKingbaseDialect(dbType)
    ? Object.assign({}, ...usableMaps) as Record<string, ColumnMeta>
    : mergeColumnMetaMapsByPriority(usableMaps);
  if (!isKingbaseDialect(dbType)) {
    resolveQueryResultSelectAliasEntries(statement, dbType).forEach(({ resultColumn, sourceColumn, qualifier }) => {
      if (findColumnMeta(merged, resultColumn)) return;
      const meta = resolveQualifiedTableMeta(tables, metaMaps, qualifier, sourceColumn) || findColumnMeta(merged, sourceColumn);
      if (meta) merged[resultColumn] = meta;
    });
    return merged;
  }
  Object.keys(merged).forEach((name) => {
    if (metaMaps.some((map) => !hasUsableColumnMeta(map))
      || metaMaps.filter((map) => findColumnMeta(map, name)).length !== 1) delete merged[name];
  });
  const range = resolveOuterSelectListRange(statement, dbType);
  if (!range) return undefined;
  const projected: Record<string, ColumnMeta> = {};
  const seenResults = new Set<string>();
  const duplicateResults = new Set<string>();
  const recordResultColumn = (name: string): void => {
    if (seenResults.has(name)) duplicateResults.add(name);
    seenResults.add(name);
  };
  splitTopLevelComma(statement.slice(range.start, range.end).replace(/^\s*DISTINCT\s+/i, ''), dbType).forEach((item) => {
    const mapping = resolveSelectItemMapping(item);
    if (mapping !== 'all') {
      const alias = SELECT_ITEM_AS_ALIAS_REGEX.exec(item.trim()) || SELECT_ITEM_BARE_ALIAS_REGEX.exec(item.trim());
      if (mapping) {
        recordResultColumn(mapping.resultColumn);
      } else if (alias) {
        // 表达式的显式标签不借用通配符展开或纯列引用的同名元数据。
        duplicateResults.add(stripAliasQuotes(alias[2]));
      }
      return;
    }
    const qualifier = stripAliasQuotes(item.trim().replace(/\s*\.\s*\*$/, ''));
    if (item.trim() === '*') Object.assign(projected, merged);
    const candidates = tables.map((table, index) => ({ table, index })).filter(({ table }) => (
      item.trim() === '*' || table.alias === qualifier || table.ref.metadataTableName === qualifier
        || table.ref.metadataTableName.split('.').pop() === qualifier
    ));
    if (item.trim() !== '*' && candidates.length !== 1) return;
    candidates.forEach(({ table, index }) => {
      if (item.trim() !== '*') Object.assign(projected, metaMaps[index]);
      [table.alias, table.ref.metadataTableName].filter(Boolean).forEach((prefix) => {
        Object.entries(metaMaps[index]).forEach(([name, meta]) => { projected[`${prefix}.${name}`] = meta; });
      });
    });
  });
  resolveQueryResultSelectAliasEntries(statement, dbType).forEach(({ resultColumn, sourceColumn, qualifier }) => {
    const meta = qualifier
      ? resolveQualifiedTableMeta(tables, metaMaps, qualifier, sourceColumn)
      : findColumnMeta(merged, sourceColumn);
    if (meta) {
      projected[resultColumn] = meta;
      if (resultColumn === sourceColumn) {
        tables.forEach((table, index) => {
          if (findColumnMeta(metaMaps[index], sourceColumn) !== meta) return;
          [table.alias, table.ref.metadataTableName].filter(Boolean).forEach((prefix) => {
            projected[`${prefix}.${sourceColumn}`] = meta;
          });
        });
      }
    }
  });
  Object.keys(projected).forEach((name) => {
    if (duplicateResults.has(name)) delete projected[name];
  });
  return projected;
};

/**
 * 多语句一次性回填：先并行预热全部候选表（去重、只等一次软超时），
 * 再逐条合并（全部命中缓存），避免每条语句各等一轮把执行拖慢。
 * 返回与 requests 同序的元数据映射，拿不到的为 undefined。
 */
export const resolveQueryResultColumnMetaForStatements = async (
  requests: QueryResultColumnMetaBackfillRequest[],
): Promise<Array<Record<string, ColumnMeta> | undefined>> => {
  if (requests.length === 0) return [];
  const paramsList = requests.map((request) => (isSelectStatement(request.statement, request.dbType) ? {
    statement: request.statement,
    dbType: request.dbType,
    currentDb: request.currentDb,
    defaultSchema: resolveQueryResultBackfillDefaultSchema(request),
    config: request.config,
  } : undefined));
  const selectParamsList = paramsList.filter((params): params is NonNullable<typeof params> => Boolean(params));
  await prewarmQueryResultColumnMeta(selectParamsList);
  return Promise.all(paramsList.map((params) => (
    params ? resolveQueryResultColumnMetaByCandidateTables(params).catch(() => undefined) : undefined
  )));
};
