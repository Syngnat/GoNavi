import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { message } from 'antd';
import { TabData, ColumnDefinition } from '../types';
import { useStore } from '../store';
import { DBQuery, DBGetColumns } from '../../wailsjs/go/app/App';
import DataGrid, { GONAVI_ROW_KEY } from './DataGrid';
import { buildOrderBySQL, buildWhereSQL, quoteIdentPart, quoteQualifiedIdent, withSortBufferTuningSQL, type FilterCondition } from '../utils/sql';
import { buildMongoCountCommand, buildMongoFilter, buildMongoFindCommand, buildMongoSort } from '../utils/mongodb';
import { getDataSourceCapabilities } from '../utils/dataSourceCapabilities';

type ViewerPaginationState = {
  current: number;
  pageSize: number;
  total: number;
  totalKnown: boolean;
  totalApprox: boolean;
  totalCountLoading: boolean;
  totalCountCancelled: boolean;
};

const JS_MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

const isIntegerText = (text: string): boolean => /^[+-]?\d+$/.test(text);

const toNonNegativeFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
  }
  if (typeof value === 'bigint') {
    return value >= 0n && value <= JS_MAX_SAFE_INTEGER_BIGINT ? Number(value) : null;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (isIntegerText(text)) {
      try {
        const parsedBigInt = BigInt(text);
        if (parsedBigInt < 0n || parsedBigInt > JS_MAX_SAFE_INTEGER_BIGINT) {
          return null;
        }
        return Number(parsedBigInt);
      } catch {
        return null;
      }
    }
    const parsed = Number(text);
    return Number.isFinite(parsed) && parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : null;
  }
  return null;
};

const parseTotalFromCountRow = (row: any): number | null => {
  if (!row || typeof row !== 'object') return null;
  const entries = Object.entries(row as Record<string, unknown>);
  if (entries.length === 0) return null;

  for (const [key, raw] of entries) {
    const normalized = String(key || '').trim().toLowerCase();
    if (normalized === 'total' || normalized === 'count' || normalized.includes('count')) {
      const parsed = toNonNegativeFiniteNumber(raw);
      if (parsed !== null) return parsed;
    }
  }

  for (const [, raw] of entries) {
    const parsed = toNonNegativeFiniteNumber(raw);
    if (parsed !== null) return parsed;
  }

  return null;
};

const parseDuckDBApproxTotalRow = (row: any): number | null => {
  if (!row || typeof row !== 'object') return null;
  const entries = Object.entries(row as Record<string, unknown>);
  if (entries.length === 0) return null;

  const preferredKeys = ['approx_total', 'estimated_size', 'estimated_rows', 'row_count', 'count', 'total'];
  for (const preferred of preferredKeys) {
    for (const [key, raw] of entries) {
      if (String(key || '').trim().toLowerCase() !== preferred) continue;
      const parsed = toNonNegativeFiniteNumber(raw);
      if (parsed !== null) return parsed;
    }
  }

  for (const [key, raw] of entries) {
    const normalized = String(key || '').trim().toLowerCase();
    if (normalized.includes('estimate') || normalized.includes('row') || normalized.includes('count') || normalized.includes('total')) {
      const parsed = toNonNegativeFiniteNumber(raw);
      if (parsed !== null) return parsed;
    }
  }
  return null;
};

const normalizeDuckDBIdentifier = (raw: string): string => {
  const text = String(raw || '').trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === '`' && last === '`')) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
};

const resolveDuckDBSchemaAndTable = (dbName: string, tableName: string) => {
  const rawTable = String(tableName || '').trim();
  if (!rawTable) return { schemaName: 'main', pureTableName: '' };

  const parts = rawTable.split('.');
  if (parts.length >= 2) {
    const pureTableName = normalizeDuckDBIdentifier(parts[parts.length - 1]);
    const schemaName = normalizeDuckDBIdentifier(parts[parts.length - 2]);
    if (schemaName && pureTableName) {
      return { schemaName, pureTableName };
    }
  }

  const fallbackSchema = normalizeDuckDBIdentifier(String(dbName || '').trim()) || 'main';
  return { schemaName: fallbackSchema, pureTableName: normalizeDuckDBIdentifier(rawTable) };
};

const escapeSQLLiteral = (value: string): string => String(value || '').replace(/'/g, "''");

const isDuckDBUnsupportedTypeError = (msg: string): boolean => /unsupported\s*type:\s*duckdb\./i.test(String(msg || ''));

const isDuckDBComplexColumnType = (columnType?: string): boolean => {
  const raw = String(columnType || '').trim().toLowerCase();
  if (!raw) return false;
  return raw.includes('map') || raw.includes('struct') || raw.includes('union') || raw.includes('array') || raw.includes('list');
};

const reverseOrderBySQL = (orderBySQL: string): string => {
  const raw = String(orderBySQL || '').trim();
  if (!raw) return '';
  const body = raw.replace(/^order\s+by\s+/i, '').trim();
  if (!body) return '';

  const parts = body
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (/\s+asc$/i.test(part)) return part.replace(/\s+asc$/i, ' DESC');
      if (/\s+desc$/i.test(part)) return part.replace(/\s+desc$/i, ' ASC');
      return `${part} DESC`;
    });
  if (parts.length === 0) return '';
  return ` ORDER BY ${parts.join(', ')}`;
};

type ViewerFilterSnapshot = {
  showFilter: boolean;
  conditions: FilterCondition[];
};

const viewerFilterSnapshotsByTab = new Map<string, ViewerFilterSnapshot>();

const normalizeViewerFilterConditions = (conditions: FilterCondition[] | undefined): FilterCondition[] => {
  if (!Array.isArray(conditions)) return [];
  return conditions.map((cond) => ({
    id: Number.isFinite(Number(cond?.id)) ? Number(cond?.id) : undefined,
    enabled: cond?.enabled !== false,
    logic: String(cond?.logic || '').trim().toUpperCase() === 'OR' ? 'OR' : 'AND',
    column: String(cond?.column || ''),
    op: String(cond?.op || '='),
    value: String(cond?.value ?? ''),
    value2: String(cond?.value2 ?? ''),
  }));
};

const getViewerFilterSnapshot = (tabId: string): ViewerFilterSnapshot => {
  const cached = viewerFilterSnapshotsByTab.get(String(tabId || '').trim());
  if (!cached) {
    return { showFilter: false, conditions: [] };
  }
  return {
    showFilter: cached.showFilter === true,
    conditions: normalizeViewerFilterConditions(cached.conditions),
  };
};

const DataViewer: React.FC<{ tab: TabData }> = ({ tab }) => {
  const [data, setData] = useState<any[]>([]);
  const [columnNames, setColumnNames] = useState<string[]>([]);
  const [pkColumns, setPkColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const connections = useStore(state => state.connections);
  const addSqlLog = useStore(state => state.addSqlLog);
  const fetchSeqRef = useRef(0);
  const countSeqRef = useRef(0);
  const countKeyRef = useRef<string>('');
  const duckdbApproxSeqRef = useRef(0);
  const duckdbApproxKeyRef = useRef<string>('');
  const manualCountSeqRef = useRef(0);
  const manualCountKeyRef = useRef<string>('');
  const pkSeqRef = useRef(0);
  const pkKeyRef = useRef<string>('');
  const latestConfigRef = useRef<any>(null);
  const latestDbTypeRef = useRef<string>('');
  const latestDbNameRef = useRef<string>('');
  const latestCountSqlRef = useRef<string>('');
  const latestCountKeyRef = useRef<string>('');

  const [pagination, setPagination] = useState<ViewerPaginationState>({
      current: 1,
      pageSize: 100,
      total: 0,
      totalKnown: false,
      totalApprox: false,
      totalCountLoading: false,
      totalCountCancelled: false,
  });

  const [sortInfo, setSortInfo] = useState<{ columnKey: string, order: string } | null>(null);
  
  const [showFilter, setShowFilter] = useState<boolean>(() => getViewerFilterSnapshot(tab.id).showFilter);
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>(() => getViewerFilterSnapshot(tab.id).conditions);
  const duckdbSafeSelectCacheRef = useRef<Record<string, string>>({});
  const currentConnConfig = connections.find(c => c.id === tab.connectionId)?.config;
  const currentConnCaps = getDataSourceCapabilities(currentConnConfig);
  const currentConnType = currentConnCaps.type;
  const forceReadOnly = currentConnCaps.forceReadOnlyQueryResult;

  useEffect(() => {
    const snapshot = getViewerFilterSnapshot(tab.id);
    setShowFilter(snapshot.showFilter);
    setFilterConditions(snapshot.conditions);
  }, [tab.id]);

  useEffect(() => {
    viewerFilterSnapshotsByTab.set(tab.id, {
      showFilter,
      conditions: normalizeViewerFilterConditions(filterConditions),
    });
  }, [tab.id, showFilter, filterConditions]);

  useEffect(() => {
    setPkColumns([]);
    pkKeyRef.current = '';
    countKeyRef.current = '';
    duckdbApproxKeyRef.current = '';
    manualCountKeyRef.current = '';
    duckdbSafeSelectCacheRef.current = {};
    latestConfigRef.current = null;
    latestDbTypeRef.current = '';
    latestDbNameRef.current = '';
    latestCountSqlRef.current = '';
    latestCountKeyRef.current = '';
    setPagination(prev => ({
      ...prev,
      current: 1,
      total: 0,
      totalKnown: false,
      totalApprox: false,
      totalCountLoading: false,
      totalCountCancelled: false,
    }));
  }, [tab.connectionId, tab.dbName, tab.tableName]);

  const handleDuckDBManualCount = useCallback(async () => {
    if (latestDbTypeRef.current !== 'duckdb') {
      return;
    }
    const config = latestConfigRef.current;
    const dbName = latestDbNameRef.current;
    const countSql = latestCountSqlRef.current;
    const countKey = latestCountKeyRef.current;

    if (!config || !countSql || !countKey) {
      message.warning('当前结果集尚未就绪，请先执行一次加载');
      return;
    }

    manualCountKeyRef.current = countKey;
    const countSeq = ++manualCountSeqRef.current;
    const countStart = Date.now();
    setPagination(prev => ({ ...prev, totalCountLoading: true, totalCountCancelled: false }));
    const countConfig: any = { ...(config as any), timeout: 120 };

    try {
      const resCount = await DBQuery(countConfig as any, dbName, countSql);
      const countDuration = Date.now() - countStart;
      addSqlLog({
        id: `log-${Date.now()}-duckdb-manual-count`,
        timestamp: Date.now(),
        sql: countSql,
        status: resCount?.success ? 'success' : 'error',
        duration: countDuration,
        message: resCount?.success ? '' : String(resCount?.message || '统计失败'),
        dbName
      });

      if (manualCountSeqRef.current !== countSeq) return;
      if (manualCountKeyRef.current !== countKey) return;

      if (!resCount?.success) {
        setPagination(prev => ({ ...prev, totalCountLoading: false }));
        message.error(String(resCount?.message || '统计总数失败'));
        return;
      }
      if (!Array.isArray(resCount.data) || resCount.data.length === 0) {
        setPagination(prev => ({ ...prev, totalCountLoading: false }));
        return;
      }

      const total = parseTotalFromCountRow(resCount.data[0]);
      if (total === null) {
        setPagination(prev => ({ ...prev, totalCountLoading: false }));
        message.error('统计结果解析失败');
        return;
      }

      setPagination(prev => ({
        ...prev,
        total,
        totalKnown: true,
        totalApprox: false,
        totalCountLoading: false,
        totalCountCancelled: false,
      }));
    } catch (e: any) {
      if (manualCountSeqRef.current !== countSeq) return;
      if (manualCountKeyRef.current !== countKey) return;
      setPagination(prev => ({ ...prev, totalCountLoading: false }));
      message.error(`统计总数失败: ${String(e?.message || e)}`);
    }
  }, [addSqlLog]);

  const handleDuckDBCancelManualCount = useCallback(() => {
    manualCountSeqRef.current++;
    setPagination(prev => ({ ...prev, totalCountLoading: false, totalCountCancelled: true }));
  }, []);

  const fetchData = useCallback(async (page = pagination.current, size = pagination.pageSize) => {
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    const conn = connections.find(c => c.id === tab.connectionId);
    if (!conn) {
        message.error("Connection not found");
        if (fetchSeqRef.current === seq) setLoading(false);
        return;
    }

    const config = { 
        ...conn.config, 
        port: Number(conn.config.port),
        password: conn.config.password || "",
        database: conn.config.database || "",
        useSSH: conn.config.useSSH || false,
        ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
    };

    const dbType = config.type || '';
    const dbTypeLower = String(dbType || '').trim().toLowerCase();
    const isMySQLFamily = dbTypeLower === 'mysql' || dbTypeLower === 'mariadb' || dbTypeLower === 'diros';

    const dbName = tab.dbName || '';
    const tableName = tab.tableName || '';
    const isMongoDB = dbTypeLower === 'mongodb';
    let mongoFilter: Record<string, unknown> | undefined;
    if (isMongoDB) {
        try {
            mongoFilter = buildMongoFilter(filterConditions);
        } catch (e: any) {
            message.error(`Mongo 筛选条件无效：${String(e?.message || e || '解析失败')}`);
            if (fetchSeqRef.current === seq) setLoading(false);
            return;
        }
    }

    const whereSQL = isMongoDB
      ? JSON.stringify(mongoFilter || {})
      : buildWhereSQL(dbType, filterConditions);
    const countSql = isMongoDB
      ? buildMongoCountCommand(tableName, mongoFilter || {})
      : `SELECT COUNT(*) as total FROM ${quoteQualifiedIdent(dbType, tableName)} ${whereSQL}`;
    const orderBySQL = isMongoDB ? '' : buildOrderBySQL(dbType, sortInfo, pkColumns);
    const totalRows = Number(pagination.total);
    const hasFiniteTotal = Number.isFinite(totalRows) && totalRows >= 0;
    const totalKnown = pagination.totalKnown && hasFiniteTotal;
    const totalPages = hasFiniteTotal ? Math.max(1, Math.ceil(totalRows / size)) : 0;
    const currentPage = totalPages > 0 ? Math.min(Math.max(1, page), totalPages) : Math.max(1, page);
    const offset = (currentPage - 1) * size;
    const isClickHouse = !isMongoDB && dbTypeLower === 'clickhouse';
    const reverseOrderSQL = isClickHouse ? reverseOrderBySQL(orderBySQL) : '';
    let useClickHouseReversePagination = false;
    let clickHouseReverseLimit = 0;
    let clickHouseReverseHasMore = false;
    let sql = '';
    if (isMongoDB) {
        const mongoSort = buildMongoSort(sortInfo, pkColumns);
        sql = buildMongoFindCommand({
            collection: tableName,
            filter: mongoFilter || {},
            sort: mongoSort,
            limit: size + 1,
            skip: offset,
        });
    } else {
        const baseSql = `SELECT * FROM ${quoteQualifiedIdent(dbType, tableName)} ${whereSQL}`;
        sql = `${baseSql}${orderBySQL}`;
        // ClickHouse 深分页在超大 OFFSET 下容易超时。对于总数已知且存在 ORDER BY 的场景，
        // 当“尾部偏移”小于“头部偏移”时，改为反向 ORDER BY + 小 OFFSET，并在前端翻转结果。
        if (isClickHouse && totalKnown && offset > 0 && reverseOrderSQL) {
            const pageRowCount = Math.max(0, Math.min(size, totalRows - offset));
            if (pageRowCount > 0) {
                const tailOffset = Math.max(0, totalRows - (offset + pageRowCount));
                if (tailOffset < offset) {
                    sql = `${baseSql}${reverseOrderSQL} LIMIT ${pageRowCount} OFFSET ${tailOffset}`;
                    useClickHouseReversePagination = true;
                    clickHouseReverseLimit = pageRowCount;
                    clickHouseReverseHasMore = currentPage < totalPages;
                }
            }
        }
        if (!useClickHouseReversePagination) {
            // 大表性能：打开表不阻塞在 COUNT(*)，先通过多取 1 条判断是否还有下一页；总数在后台统计并异步回填。
            sql += ` LIMIT ${size + 1} OFFSET ${offset}`;
        }
    }

    const requestStartTime = Date.now();
    let executedSql = sql;
    try {
        const executeDataQuery = async (querySql: string, attemptLabel: string) => {
            const startTime = Date.now();
            try {
                const result = await DBQuery(config as any, dbName, querySql);
                addSqlLog({
                    id: `log-${Date.now()}-data`,
                    timestamp: Date.now(),
                    sql: querySql,
                    status: result.success ? 'success' : 'error',
                    duration: Date.now() - startTime,
                    message: result.success ? '' : `${attemptLabel}: ${result.message}`,
                    affectedRows: Array.isArray(result.data) ? result.data.length : undefined,
                    dbName
                });
                return result;
            } catch (e: any) {
                const errMessage = String(e?.message || e || 'query failed');
                addSqlLog({
                    id: `log-${Date.now()}-data`,
                    timestamp: Date.now(),
                    sql: querySql,
                    status: 'error',
                    duration: Date.now() - startTime,
                    message: `${attemptLabel}: ${errMessage}`,
                    dbName
                });
                return { success: false, message: errMessage, data: [], fields: [] };
            }
        };

        const hasSort = !!sortInfo?.columnKey && (sortInfo?.order === 'ascend' || sortInfo?.order === 'descend');
        const isSortMemoryErr = (msg: string) => /error\s*1038|out of sort memory/i.test(String(msg || ''));
        let resData = await executeDataQuery(sql, '主查询');

        if (!resData.success && dbTypeLower === 'duckdb' && isDuckDBUnsupportedTypeError(String(resData.message || ''))) {
            const cacheKey = `${tab.connectionId}|${dbName}|${tableName}`;
            let safeSelect = duckdbSafeSelectCacheRef.current[cacheKey] || '';
            if (!safeSelect) {
                try {
                    const resCols = await DBGetColumns(config as any, dbName, tableName);
                    if (resCols?.success && Array.isArray(resCols.data)) {
                        const columnDefs = resCols.data as ColumnDefinition[];
                        const selectParts = columnDefs.map((col) => {
                            const colName = String(col?.name || '').trim();
                            if (!colName) return '';
                            const quotedCol = quoteIdentPart(dbType, colName);
                            if (isDuckDBComplexColumnType(col?.type)) {
                                return `CAST(${quotedCol} AS VARCHAR) AS ${quotedCol}`;
                            }
                            return quotedCol;
                        }).filter(Boolean);
                        if (selectParts.length > 0) {
                            safeSelect = selectParts.join(', ');
                            duckdbSafeSelectCacheRef.current[cacheKey] = safeSelect;
                        }
                    }
                } catch {
                    // ignore and keep original error path
                }
            }

            if (safeSelect) {
                let fallbackSql = `SELECT ${safeSelect} FROM ${quoteQualifiedIdent(dbType, tableName)} ${whereSQL}`;
                fallbackSql += buildOrderBySQL(dbType, sortInfo, pkColumns);
                fallbackSql += ` LIMIT ${size + 1} OFFSET ${offset}`;
                executedSql = fallbackSql;
                resData = await executeDataQuery(fallbackSql, '复杂类型降级重试');
            }
        }

        if (!resData.success && isMySQLFamily && hasSort && isSortMemoryErr(resData.message)) {
            const retrySql32MB = withSortBufferTuningSQL(dbType, sql, 32 * 1024 * 1024);
            if (retrySql32MB !== sql) {
                executedSql = retrySql32MB;
                resData = await executeDataQuery(retrySql32MB, '重试(32MB sort_buffer)');
            }
            if (!resData.success && isSortMemoryErr(resData.message)) {
                const retrySql128MB = withSortBufferTuningSQL(dbType, sql, 128 * 1024 * 1024);
                if (retrySql128MB !== executedSql) {
                    executedSql = retrySql128MB;
                    resData = await executeDataQuery(retrySql128MB, '重试(128MB sort_buffer)');
                }
            }
            if (resData.success) {
                message.warning('已自动提升排序缓冲并重试成功。');
            }
        }
        
        if (pkColumns.length === 0) {
            const pkKey = `${tab.connectionId}|${dbName}|${tableName}`;
            if (pkKeyRef.current !== pkKey) {
                pkKeyRef.current = pkKey;
                const pkSeq = ++pkSeqRef.current;
                DBGetColumns(config as any, dbName, tableName)
                    .then((resCols: any) => {
                        if (pkSeqRef.current !== pkSeq) return;
                        if (pkKeyRef.current !== pkKey) return;
                        if (!resCols?.success) return;
                        const pks = (resCols.data as ColumnDefinition[]).filter((c: any) => c.key === 'PRI').map((c: any) => c.name);
                        setPkColumns(pks);
                    })
                    .catch(() => {
                        if (pkSeqRef.current !== pkSeq) return;
                        if (pkKeyRef.current !== pkKey) return;
                    });
            }
        }

        if (resData.success) {
            let resultData = resData.data as any[];
            if (!Array.isArray(resultData)) resultData = [];

            if (useClickHouseReversePagination) {
                // 反向查询后恢复为原排序方向，保证用户看到的仍是“最后一页正序数据”。
                resultData = resultData.slice(0, clickHouseReverseLimit).reverse();
            }

            const hasMore = useClickHouseReversePagination ? clickHouseReverseHasMore : resultData.length > size;
            if (hasMore) resultData = resultData.slice(0, size);

            let fieldNames = resData.fields || [];
            if (fieldNames.length === 0 && resultData.length > 0) {
                fieldNames = Object.keys(resultData[0]);
            }
            if (fetchSeqRef.current !== seq) return;
            setColumnNames(fieldNames);
            resultData.forEach((row: any, i: number) => {
                if (row && typeof row === 'object') row[GONAVI_ROW_KEY] = `row-${offset + i}`;
            });
            setData(resultData);
            const countKey = `${tab.connectionId}|${dbName}|${tableName}|${whereSQL}`;
            const derivedTotalKnown = !hasMore;
            const derivedTotal = derivedTotalKnown ? offset + resultData.length : currentPage * size + 1;
            const isDuckDB = dbTypeLower === 'duckdb';
            const minExpectedTotal = hasMore ? offset + resultData.length + 1 : offset + resultData.length;
            if (derivedTotalKnown) countKeyRef.current = countKey;
            latestConfigRef.current = config;
            latestDbTypeRef.current = dbTypeLower;
            latestDbNameRef.current = dbName;
            latestCountSqlRef.current = countSql;
            latestCountKeyRef.current = countKey;

            setPagination(prev => {
                if (derivedTotalKnown) {
                    return {
                        ...prev,
                        current: currentPage,
                        pageSize: size,
                        total: derivedTotal,
                        totalKnown: true,
                        totalApprox: false,
                        totalCountLoading: false,
                        totalCountCancelled: false,
                    };
                }
                if (prev.totalKnown && countKeyRef.current === countKey) {
                    if (!isDuckDB) {
                        return { ...prev, current: currentPage, pageSize: size };
                    }
                    // 当当前页存在“下一页”信号时，已知总数至少应大于当前页末尾。
                    // 若旧总数不满足该条件（例如历史统计值为 0），降级为未知总数并回退到 derivedTotal。
                    if (Number.isFinite(prev.total) && prev.total >= minExpectedTotal) {
                        return { ...prev, current: currentPage, pageSize: size };
                    }
                }
                const keepManualCounting = prev.totalCountLoading && manualCountKeyRef.current === countKey;
                if (isDuckDB && prev.totalApprox && duckdbApproxKeyRef.current === countKey && Number.isFinite(prev.total) && prev.total >= minExpectedTotal) {
                    return {
                        ...prev,
                        current: currentPage,
                        pageSize: size,
                        totalKnown: false,
                        totalApprox: true,
                        totalCountLoading: keepManualCounting,
                        totalCountCancelled: false,
                    };
                }
                return {
                    ...prev,
                    current: currentPage,
                    pageSize: size,
                    total: derivedTotal,
                    totalKnown: false,
                    totalApprox: false,
                    totalCountLoading: keepManualCounting,
                    totalCountCancelled: keepManualCounting ? false : prev.totalCountCancelled,
                };
            });

            const shouldRunAsyncCount = !derivedTotalKnown && !isDuckDB;
            if (shouldRunAsyncCount) {
                if (countKeyRef.current !== countKey) {
                    countKeyRef.current = countKey;
                    const countSeq = ++countSeqRef.current;
                    const countStart = Date.now();
                    // 大表 COUNT(*) 可能非常慢，且在部分运行时环境下会影响后续操作响应；
                    // DuckDB 大文件场景下该统计会显著拖慢翻页，已禁用后台 COUNT。
                    const countConfig: any = { ...(config as any), timeout: 5 };

                    DBQuery(countConfig, dbName, countSql)
                        .then((resCount: any) => {
                            const countDuration = Date.now() - countStart;

                            addSqlLog({
                                id: `log-${Date.now()}-count`,
                                timestamp: Date.now(),
                                sql: countSql,
                                status: resCount.success ? 'success' : 'error',
                                duration: countDuration,
                                message: resCount.success ? '' : resCount.message,
                                dbName
                            });

                            if (countSeqRef.current !== countSeq) return;
                            if (countKeyRef.current !== countKey) return;

                            if (!resCount.success) return;
                            if (!Array.isArray(resCount.data) || resCount.data.length === 0) return;

                            const total = parseTotalFromCountRow(resCount.data[0]);
                            if (total === null) return;

                            setPagination(prev => ({
                                ...prev,
                                total,
                                totalKnown: true,
                                totalApprox: false,
                                totalCountLoading: false,
                                totalCountCancelled: false,
                            }));
                        })
                        .catch(() => {
                            if (countSeqRef.current !== countSeq) return;
                            if (countKeyRef.current !== countKey) return;
                            // 统计失败不影响主流程，不弹窗；可在日志里查看。
                        });
                }
            }

            if (isDuckDB && !derivedTotalKnown && whereSQL.trim() === '' && duckdbApproxKeyRef.current !== countKey) {
                duckdbApproxKeyRef.current = countKey;
                const approxSeq = ++duckdbApproxSeqRef.current;
                const { schemaName, pureTableName } = resolveDuckDBSchemaAndTable(dbName, tableName);
                const escapedSchema = escapeSQLLiteral(schemaName);
                const escapedTable = escapeSQLLiteral(pureTableName);
                const approxConfig: any = { ...(config as any), timeout: 3 };
                const approxSqlCandidates = [
                    `SELECT estimated_size AS approx_total FROM duckdb_tables() WHERE schema_name='${escapedSchema}' AND table_name='${escapedTable}' LIMIT 1`,
                    `SELECT estimated_size AS approx_total FROM duckdb_tables() WHERE table_name='${escapedTable}' ORDER BY CASE WHEN schema_name='${escapedSchema}' THEN 0 ELSE 1 END LIMIT 1`,
                ];

                (async () => {
                    for (const approxSql of approxSqlCandidates) {
                        try {
                            const approxRes = await DBQuery(approxConfig as any, dbName, approxSql);
                            if (duckdbApproxSeqRef.current !== approxSeq) return;
                            if (countKeyRef.current !== countKey) return;
                            if (!approxRes?.success || !Array.isArray(approxRes.data) || approxRes.data.length === 0) continue;

                            const approxTotal = parseDuckDBApproxTotalRow(approxRes.data[0]);
                            if (approxTotal === null) continue;
                            if (!Number.isFinite(approxTotal) || approxTotal < minExpectedTotal) continue;

                            setPagination(prev => {
                                if (countKeyRef.current !== countKey) return prev;
                                if (prev.totalKnown) return prev;
                                return {
                                    ...prev,
                                    total: approxTotal,
                                    totalKnown: false,
                                    totalApprox: true,
                                    totalCountCancelled: false,
                                };
                            });
                            return;
                        } catch {
                            if (duckdbApproxSeqRef.current !== approxSeq) return;
                            if (countKeyRef.current !== countKey) return;
                        }
                    }
                })();
            }
        } else {
            message.error(String(resData.message || '查询失败'));
        }
    } catch (e: any) {
        if (fetchSeqRef.current !== seq) return;
        message.error("Error fetching data: " + e.message);
        addSqlLog({
            id: `log-${Date.now()}-error`,
            timestamp: Date.now(),
            sql: executedSql,
            status: 'error',
            duration: Date.now() - requestStartTime,
            message: e.message,
            dbName
        });
    }
    if (fetchSeqRef.current === seq) setLoading(false);
  }, [connections, tab, sortInfo, filterConditions, pkColumns, pagination.total, pagination.totalKnown]); 
  // 依赖 pkColumns：在无手动排序时可回退到主键稳定排序。
  // 主键信息只会在首次加载后更新一次，避免循环查询。

  // Handlers memoized
  const handleReload = useCallback(() => {
    fetchData(pagination.current, pagination.pageSize);
  }, [fetchData, pagination.current, pagination.pageSize]);
  const handleSort = useCallback((field: string, order: string) => {
    const normalizedOrder = order === 'ascend' || order === 'descend' ? order : '';
    const normalizedField = String(field || '').trim();
    if (!normalizedField || !normalizedOrder) {
      setSortInfo(null);
      return;
    }
    setSortInfo({ columnKey: normalizedField, order: normalizedOrder });
  }, []);
  const handlePageChange = useCallback((page: number, size: number) => fetchData(page, size), [fetchData]);
  const handleToggleFilter = useCallback(() => setShowFilter(prev => !prev), []);
  const handleApplyFilter = useCallback((conditions: FilterCondition[]) => setFilterConditions(conditions), []);

  const exportSqlWithFilter = useMemo(() => {
    const tableName = String(tab.tableName || '').trim();
    const dbType = String(currentConnConfig?.type || '').trim();
    if (!tableName || !dbType) return '';

    const whereSQL = buildWhereSQL(dbType, filterConditions);
    if (!whereSQL) return '';

    let sql = `SELECT * FROM ${quoteQualifiedIdent(dbType, tableName)} ${whereSQL}`;
    sql += buildOrderBySQL(dbType, sortInfo, pkColumns);
    const normalizedType = dbType.toLowerCase();
    const hasExplicitSort = !!sortInfo?.columnKey && (sortInfo?.order === 'ascend' || sortInfo?.order === 'descend');
    if (hasExplicitSort && (normalizedType === 'mysql' || normalizedType === 'mariadb')) {
      sql = withSortBufferTuningSQL(normalizedType, sql, 32 * 1024 * 1024);
    }
    return sql;
  }, [tab.tableName, currentConnConfig?.type, filterConditions, sortInfo, pkColumns]);

  useEffect(() => {
    fetchData(1, pagination.pageSize); 
  }, [tab, sortInfo, filterConditions]); // Initial load and re-load on sort/filter

  return (
    <div style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, height: '100%', width: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <DataGrid
          data={data}
          columnNames={columnNames}
          loading={loading}
          tableName={tab.tableName}
          exportScope="table"
          dbName={tab.dbName}
          connectionId={tab.connectionId}
          pkColumns={pkColumns}
          onReload={handleReload}
          onSort={handleSort}
          onPageChange={handlePageChange}
          pagination={pagination}
          onRequestTotalCount={currentConnType === 'duckdb' ? handleDuckDBManualCount : undefined}
          onCancelTotalCount={currentConnType === 'duckdb' ? handleDuckDBCancelManualCount : undefined}
          showFilter={showFilter}
          onToggleFilter={handleToggleFilter}
          onApplyFilter={handleApplyFilter}
          appliedFilterConditions={filterConditions}
          readOnly={forceReadOnly}
          sortInfoExternal={sortInfo}
          exportSqlWithFilter={exportSqlWithFilter || undefined}
      />
    </div>
  );
};

export default DataViewer;
