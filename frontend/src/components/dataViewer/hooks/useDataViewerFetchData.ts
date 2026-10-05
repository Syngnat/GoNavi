import { useCallback } from 'react';
import { message } from 'antd';
import {
  type DataViewerFetchOptions,
  parseTotalFromCountRow,
  isKnownTotalFreshForPage,
} from '../dataViewerTotals';
import { resolveDataSourceType } from '../../../utils/dataSourceCapabilities';
import {
  normalizeQuickWhereCondition,
  validateQuickWhereCondition,
  buildEffectiveFilterConditions,
} from '../../../utils/dataGridWhereFilter';
import {
  buildMongoFilter,
  buildMongoCountCommand,
  buildMongoSort,
  buildMongoFindCommand,
} from '../../../utils/mongodb';
import {
  buildWhereSQL,
  quoteQualifiedIdent,
  buildOrderBySQL,
  reverseOrderBySQL,
  buildPaginatedSelectSQL,
  hasExplicitSort,
  quoteIdentPart,
  withSortBufferTuningSQL,
} from '../../../utils/sql';
import {
  MONGODB_ID_COLUMN,
  getTableColumnNames,
  localizeDataViewerReadOnlyLocator,
  warnDataViewerReadOnly,
  formatDataViewerTableName,
  buildMongoDataViewerEditLocator,
} from '../dataViewerEditLocator';
import {
  type EditRowLocator,
  buildAllColumnsLocator,
  ORACLE_ROWID_LOCATOR_COLUMN,
  DUCKDB_ROWID_LOCATOR_COLUMN,
  resolveEditRowLocator,
} from '../../../utils/rowLocator';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { requestTableMetadata } from '../../../utils/tableMetadataRequestCache';
import { DBGetColumns, DBGetIndexes, DBQuery } from '../../../../wailsjs/go/app/App';
import { ColumnDefinition, IndexDefinition } from '../../../types';
import {
  getColumnDefinitionKey,
  getColumnDefinitionName,
  getColumnDefinitionType,
} from '../../../utils/columnDefinition';
import { isOracleLikeDialect } from '../../../utils/sqlDialect';
import {
  resolveDataViewerOrderFallbackColumns,
  buildDataViewerBaseSelectSQL,
  isDuckDBUnsupportedTypeError,
  isDuckDBComplexColumnType,
  resolveDuckDBSchemaAndTable,
  escapeSQLLiteral,
} from '../dataViewerQuerySql';
import { GONAVI_ROW_KEY } from '../../DataGrid';
import {
  resolveApproximateTableCountStrategy,
  parseApproximateTableCountRow,
  buildOracleApproximateTotalSql,
} from '../../../utils/approximateTableCount';
import { formatDataViewerQueryError } from '../../../utils/dataViewerQueryError';
import type { DataViewerStateApi } from './useDataViewerState';
import type { DataViewerProps } from '../../DataViewer';

export interface UseDataViewerFetchDataInput {
  tab: DataViewerProps['tab'];
  pagination: DataViewerStateApi['pagination'];
  setPagination: DataViewerStateApi['setPagination'];
  fetchSeqRef: DataViewerStateApi['fetchSeqRef'];
  loadingContextKeyRef: DataViewerStateApi['loadingContextKeyRef'];
  viewerLoadContextKey: DataViewerStateApi['viewerLoadContextKey'];
  setLoading: DataViewerStateApi['setLoading'];
  connections: DataViewerStateApi['connections'];
  tr: DataViewerStateApi['tr'];
  quickWhereCondition: DataViewerStateApi['quickWhereCondition'];
  filterConditions: DataViewerStateApi['filterConditions'];
  rabbitMQPreviewConfirmedRef: DataViewerStateApi['rabbitMQPreviewConfirmedRef'];
  ensureRabbitMQPreviewConfirmed: DataViewerStateApi['ensureRabbitMQPreviewConfirmed'];
  pkColumns: DataViewerStateApi['pkColumns'];
  setPkColumns: DataViewerStateApi['setPkColumns'];
  editLocator: DataViewerStateApi['editLocator'];
  setEditLocator: DataViewerStateApi['setEditLocator'];
  forceReadOnly: DataViewerStateApi['forceReadOnly'];
  pkKeyRef: DataViewerStateApi['pkKeyRef'];
  pkSeqRef: DataViewerStateApi['pkSeqRef'];
  countSeqRef: DataViewerStateApi['countSeqRef'];
  manualCountSeqRef: DataViewerStateApi['manualCountSeqRef'];
  duckdbApproxSeqRef: DataViewerStateApi['duckdbApproxSeqRef'];
  oracleApproxSeqRef: DataViewerStateApi['oracleApproxSeqRef'];
  countKeyRef: DataViewerStateApi['countKeyRef'];
  autoCountKeyRef: DataViewerStateApi['autoCountKeyRef'];
  manualCountKeyRef: DataViewerStateApi['manualCountKeyRef'];
  duckdbApproxKeyRef: DataViewerStateApi['duckdbApproxKeyRef'];
  oracleApproxKeyRef: DataViewerStateApi['oracleApproxKeyRef'];
  latestConfigRef: DataViewerStateApi['latestConfigRef'];
  latestDbTypeRef: DataViewerStateApi['latestDbTypeRef'];
  latestDbNameRef: DataViewerStateApi['latestDbNameRef'];
  latestCountSqlRef: DataViewerStateApi['latestCountSqlRef'];
  latestCountKeyRef: DataViewerStateApi['latestCountKeyRef'];
  addSqlLog: DataViewerStateApi['addSqlLog'];
  sortInfo: DataViewerStateApi['sortInfo'];
  supportsApproximateTotalPages: DataViewerStateApi['supportsApproximateTotalPages'];
  duckdbSafeSelectCacheRef: DataViewerStateApi['duckdbSafeSelectCacheRef'];
  setColumnNames: DataViewerStateApi['setColumnNames'];
  setData: DataViewerStateApi['setData'];
  preferManualTotalCount: DataViewerStateApi['preferManualTotalCount'];
  supportsApproximateTableCount: DataViewerStateApi['supportsApproximateTableCount'];
}

export const useDataViewerFetchData = ({
  tab, pagination, setPagination, fetchSeqRef, loadingContextKeyRef, viewerLoadContextKey,
  setLoading, connections, tr, quickWhereCondition, filterConditions, rabbitMQPreviewConfirmedRef,
  ensureRabbitMQPreviewConfirmed, pkColumns, setPkColumns, editLocator, setEditLocator,
  forceReadOnly, pkKeyRef, pkSeqRef, countSeqRef, manualCountSeqRef, duckdbApproxSeqRef,
  oracleApproxSeqRef, countKeyRef, autoCountKeyRef, manualCountKeyRef, duckdbApproxKeyRef,
  oracleApproxKeyRef, latestConfigRef, latestDbTypeRef, latestDbNameRef, latestCountSqlRef,
  latestCountKeyRef, addSqlLog, sortInfo, supportsApproximateTotalPages, duckdbSafeSelectCacheRef,
  setColumnNames, setData, preferManualTotalCount, supportsApproximateTableCount,
}: UseDataViewerFetchDataInput) => {
  const fetchData = useCallback(async (page = pagination.current, size = pagination.pageSize, options?: DataViewerFetchOptions) => {
    const navigateToLastPage = options?.navigateToLastPage === true;
    const refreshTotal = options?.refreshTotal === true || navigateToLastPage;
    const seq = ++fetchSeqRef.current;
    loadingContextKeyRef.current = viewerLoadContextKey;
    setLoading(true);
    const conn = connections.find(c => c.id === tab.connectionId);
    if (!conn) {
        message.error(tr('data_viewer.message.connection_not_found'));
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

    const dbType = resolveDataSourceType(config);
    const dbTypeLower = String(dbType || '').trim().toLowerCase();
    const isMySQLFamily = dbTypeLower === 'mysql' || dbTypeLower === 'goldendb' || dbTypeLower === 'mariadb' || dbTypeLower === 'oceanbase' || dbTypeLower === 'diros';
    const normalizedQuickWhereCondition = normalizeQuickWhereCondition(quickWhereCondition);
    const quickWhereValidation = validateQuickWhereCondition(normalizedQuickWhereCondition);
    if (!quickWhereValidation.ok) {
        message.error(quickWhereValidation.message);
        if (fetchSeqRef.current === seq) setLoading(false);
        return;
    }
    const effectiveFilterConditions = buildEffectiveFilterConditions(filterConditions, normalizedQuickWhereCondition);

    const dbName = tab.dbName || '';
    const tableName = tab.tableName || '';
    if (dbTypeLower === 'rabbitmq' && tableName && !rabbitMQPreviewConfirmedRef.current) {
        const approved = await ensureRabbitMQPreviewConfirmed(tableName);
        if (!approved || fetchSeqRef.current !== seq) {
            if (fetchSeqRef.current === seq) setLoading(false);
            return;
        }
    }
    const isMongoDB = dbTypeLower === 'mongodb';
    let mongoFilter: Record<string, unknown> | undefined;
    if (isMongoDB) {
        try {
            mongoFilter = buildMongoFilter(effectiveFilterConditions);
        } catch (e: any) {
            const detail = String(e?.message || e || tr('data_viewer.message.mongo_filter_parse_failed'));
            message.error(tr('data_viewer.message.mongo_filter_invalid_detail', { detail }));
            if (fetchSeqRef.current === seq) setLoading(false);
            return;
        }
    }

    const whereSQL = isMongoDB
      ? JSON.stringify(mongoFilter || {})
      : buildWhereSQL(dbType, effectiveFilterConditions);

    let pkColumnsForQuery = pkColumns;
    let editLocatorForQuery = editLocator;
    let deferredEditLocatorLoad: (() => Promise<void>) | null = null;
    if (isMongoDB && !forceReadOnly && tableName) {
        pkColumnsForQuery = [MONGODB_ID_COLUMN];
    }
    if (!isMongoDB && !forceReadOnly && tableName) {
        const locatorKey = `${tab.connectionId}|${dbTypeLower}|${dbName}|${tableName}`;
        if (pkKeyRef.current !== locatorKey || !editLocatorForQuery) {
            pkKeyRef.current = locatorKey;
            const locatorSeq = ++pkSeqRef.current;
            const loadEditLocator = async (): Promise<{
                primaryKeys: string[];
                locator: EditRowLocator;
            } | null> => {
                try {
                    const rpcConfig = buildRpcConnectionConfig(config) as any;
                    const [resCols, resIndexes] = await Promise.all([
                        requestTableMetadata(
                            { connectionId: tab.connectionId, dbName, tableName, kind: 'columns' },
                            () => DBGetColumns(rpcConfig, dbName, tableName),
                        ),
                        requestTableMetadata(
                            { connectionId: tab.connectionId, dbName, tableName, kind: 'indexes' },
                            () => DBGetIndexes(rpcConfig, dbName, tableName),
                        )
                            .catch((error: any) => ({ success: false, message: String(error?.message || error || 'Failed to load indexes'), data: [] })),
                    ]);
                    if (fetchSeqRef.current !== seq) return null;
                    if (pkSeqRef.current !== locatorSeq) return null;
                    if (pkKeyRef.current !== locatorKey) return null;

                    if (!resCols?.success || !Array.isArray(resCols.data)) {
                        const nextLocator = buildAllColumnsLocator([], { translate: tr });
                        setPkColumns([]);
                        setEditLocator(nextLocator);
                        if (nextLocator.reason) message.info(nextLocator.reason);
                        return { primaryKeys: [], locator: nextLocator };
                    }

                    const columnDefs = resCols.data as ColumnDefinition[];
                    const primaryKeys = columnDefs
                        .filter((column: any) => getColumnDefinitionKey(column) === 'PRI')
                        .map(getColumnDefinitionName)
                        .filter(Boolean);
                    const indexes = resIndexes?.success && Array.isArray(resIndexes.data)
                        ? resIndexes.data as IndexDefinition[]
                        : [];
                    const resultColumns = getTableColumnNames(columnDefs);
                    const locatorColumns = isOracleLikeDialect(dbType)
                        ? [...resultColumns, ORACLE_ROWID_LOCATOR_COLUMN]
                        : (String(dbType || '').trim().toLowerCase() === 'duckdb'
                            ? [...resultColumns, DUCKDB_ROWID_LOCATOR_COLUMN]
                            : resultColumns);
                    const nextLocator = localizeDataViewerReadOnlyLocator(resolveEditRowLocator({
                        dbType,
                        resultColumns: locatorColumns,
                        primaryKeys,
                        indexes,
                        allowOracleRowID: true,
                        allowDuckDBRowID: String(dbType || '').trim().toLowerCase() === 'duckdb',
                        translate: tr,
                    }), tr);

                    setPkColumns(primaryKeys);
                    setEditLocator(nextLocator);
                    if (nextLocator.readOnly) {
                        warnDataViewerReadOnly('table', formatDataViewerTableName(dbName, tableName), nextLocator.reason, tr);
                    } else if (nextLocator.strategy === 'all-columns' && nextLocator.reason) {
                        message.info(nextLocator.reason);
                    }
                    return { primaryKeys, locator: nextLocator };
                } catch {
                    if (fetchSeqRef.current !== seq) return null;
                    if (pkSeqRef.current !== locatorSeq) return null;
                    if (pkKeyRef.current !== locatorKey) return null;
                    const nextLocator = buildAllColumnsLocator([], { translate: tr });
                    setPkColumns([]);
                    setEditLocator(nextLocator);
                    if (nextLocator.reason) message.info(nextLocator.reason);
                    return { primaryKeys: [], locator: nextLocator };
                }
            };

            if (dbTypeLower === 'kingbase') {
                // Kingbase catalog metadata can be noticeably slower than the page query.
                // Keep the grid read-only briefly and enable editing when the locator arrives.
                deferredEditLocatorLoad = async () => {
                    await loadEditLocator();
                };
            } else {
                const locatorMetadata = await loadEditLocator();
                if (!locatorMetadata) return;
                pkColumnsForQuery = locatorMetadata.primaryKeys;
                editLocatorForQuery = locatorMetadata.locator;
            }
        }
    }

    const countSql = isMongoDB
      ? buildMongoCountCommand(tableName, mongoFilter || {})
      : `SELECT COUNT(*) as total FROM ${quoteQualifiedIdent(dbType, tableName)} ${whereSQL}`;
    const countKey = `${tab.connectionId}|${dbName}|${tableName}|${whereSQL}`;
    let refreshedTotal: number | null = null;

    if (navigateToLastPage) {
        countSeqRef.current++;
        manualCountSeqRef.current++;
        duckdbApproxSeqRef.current++;
        oracleApproxSeqRef.current++;
        countKeyRef.current = '';
        autoCountKeyRef.current = '';
        manualCountKeyRef.current = '';
        duckdbApproxKeyRef.current = '';
        oracleApproxKeyRef.current = '';
        setPagination(prev => ({
            ...prev,
            totalCountLoading: false,
            totalCountCancelled: false,
        }));

        latestConfigRef.current = config;
        latestDbTypeRef.current = dbTypeLower;
        latestDbNameRef.current = dbName;
        latestCountSqlRef.current = countSql;
        latestCountKeyRef.current = countKey;

        const countStart = Date.now();
        const countConfig = buildRpcConnectionConfig(config, { timeout: 120, queryTimeout: 120 });
        try {
            const resCount = await DBQuery(countConfig as any, dbName, countSql);
            addSqlLog({
                id: `log-${Date.now()}-last-page-count`,
                timestamp: Date.now(),
                sql: countSql,
                status: resCount?.success ? 'success' : 'error',
                duration: Date.now() - countStart,
                message: resCount?.success ? '' : String(resCount?.message || tr('data_viewer.message.total_count_failed')),
                dbName,
            });

            if (fetchSeqRef.current !== seq) return;
            if (!resCount?.success) {
                setPagination(prev => ({ ...prev, totalCountLoading: false }));
                message.error(String(resCount?.message || tr('data_viewer.message.total_count_failed')));
                setLoading(false);
                return;
            }
            if (!Array.isArray(resCount.data) || resCount.data.length === 0) {
                setPagination(prev => ({ ...prev, totalCountLoading: false }));
                message.error(tr('data_viewer.message.total_count_failed'));
                setLoading(false);
                return;
            }

            refreshedTotal = parseTotalFromCountRow(resCount.data[0]);
            if (refreshedTotal === null) {
                setPagination(prev => ({ ...prev, totalCountLoading: false }));
                message.error(tr('data_viewer.message.total_count_parse_failed'));
                setLoading(false);
                return;
            }
        } catch (e: any) {
            if (fetchSeqRef.current !== seq) return;
            setPagination(prev => ({ ...prev, totalCountLoading: false }));
            message.error(tr('data_viewer.message.total_count_failed_detail', { detail: String(e?.message || e) }));
            setLoading(false);
            return;
        }
    }

    const orderBySQL = isMongoDB
      ? ''
      : buildOrderBySQL(dbType, sortInfo, resolveDataViewerOrderFallbackColumns(editLocatorForQuery, pkColumnsForQuery, dbType));
    const totalRows = refreshedTotal ?? Number(pagination.total);
    const hasFiniteTotal = Number.isFinite(totalRows) && totalRows >= 0;
    const totalKnown = refreshedTotal !== null || (!refreshTotal && pagination.totalKnown && hasFiniteTotal);
    const approximateTotalRows = Number(pagination.approximateTotal);
    const hasApproximateTotalPages =
      !refreshTotal &&
      !totalKnown &&
      supportsApproximateTotalPages &&
      pagination.totalApprox &&
      Number.isFinite(approximateTotalRows) &&
      approximateTotalRows > 0;
    const effectiveTotalRows = refreshedTotal ?? (hasApproximateTotalPages ? approximateTotalRows : (refreshTotal ? 0 : totalRows));
    const totalPages = Number.isFinite(effectiveTotalRows) && effectiveTotalRows > 0 ? Math.max(1, Math.ceil(effectiveTotalRows / size)) : 0;
    const requestedPage = navigateToLastPage ? Math.max(1, totalPages) : page;
    const currentPage = totalPages > 0 ? Math.min(Math.max(1, requestedPage), totalPages) : Math.max(1, requestedPage);
    const offset = (currentPage - 1) * size;
    const isClickHouse = !isMongoDB && dbTypeLower === 'clickhouse';
    const reverseOrderSQL = isClickHouse ? reverseOrderBySQL(orderBySQL) : '';
    let useClickHouseReversePagination = false;
    let clickHouseReverseLimit = 0;
    let clickHouseReverseHasMore = false;
    let sql = '';
    if (isMongoDB) {
        const mongoSort = buildMongoSort(sortInfo, pkColumnsForQuery);
        sql = buildMongoFindCommand({
            collection: tableName,
            filter: mongoFilter || {},
            sort: mongoSort,
            limit: size + 1,
            skip: offset,
            includeObjectIDLocator: true,
        });
    } else {
        const baseSql = buildDataViewerBaseSelectSQL(dbType, tableName, whereSQL, editLocatorForQuery);
        sql = `${baseSql}${orderBySQL}`;
        // ClickHouse deep pagination with very large OFFSET can be slow. When the tail offset is smaller,
        // query in reverse ORDER BY with a smaller OFFSET, then reverse rows in the frontend.
        if (isClickHouse && totalKnown && offset > 0 && reverseOrderSQL) {
            const pageRowCount = Math.max(0, Math.min(size, totalRows - offset));
            if (pageRowCount > 0) {
                const tailOffset = Math.max(0, totalRows - (offset + pageRowCount));
                if (tailOffset < offset) {
                    sql = buildPaginatedSelectSQL(dbType, baseSql, reverseOrderSQL, pageRowCount, tailOffset);
                    useClickHouseReversePagination = true;
                    clickHouseReverseLimit = pageRowCount;
                    clickHouseReverseHasMore = currentPage < totalPages;
                }
            }
        }
        if (!useClickHouseReversePagination) {
            // 大表性能：打开表不阻塞在 COUNT(*)，先通过多取 1 条判断是否还有下一页；总数在后台统计并异步回填。
            sql = buildPaginatedSelectSQL(dbType, baseSql, orderBySQL, size + 1, offset);
        }
    }

    const requestStartTime = Date.now();
    let executedSql = sql;
    try {
        const executeDataQuery = async (querySql: string, attemptLabel: string) => {
            const startTime = Date.now();
            try {
                const result = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, querySql);
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

        const hasSort = hasExplicitSort(sortInfo);
        const isSortMemoryErr = (msg: string) => /error\s*1038|out of sort memory/i.test(String(msg || ''));
        let resData = await executeDataQuery(sql, tr('data_viewer.sql_log.phase.main_query'));
        if (deferredEditLocatorLoad) {
            void deferredEditLocatorLoad();
            deferredEditLocatorLoad = null;
        }

        if (!resData.success && dbTypeLower === 'duckdb' && isDuckDBUnsupportedTypeError(String(resData.message || ''))) {
            const cacheKey = `${tab.connectionId}|${dbName}|${tableName}`;
            let safeSelect = duckdbSafeSelectCacheRef.current[cacheKey] || '';
            if (!safeSelect) {
                try {
                    const resCols = await requestTableMetadata(
                        { connectionId: tab.connectionId, dbName, tableName, kind: 'columns' },
                        () => DBGetColumns(buildRpcConnectionConfig(config) as any, dbName, tableName),
                    );
                    if (resCols?.success && Array.isArray(resCols.data)) {
                        const columnDefs = resCols.data as ColumnDefinition[];
                        const selectParts = columnDefs.map((col) => {
                            const colName = getColumnDefinitionName(col);
                            if (!colName) return '';
                            const quotedCol = quoteIdentPart(dbType, colName);
                            if (isDuckDBComplexColumnType(getColumnDefinitionType(col))) {
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
                fallbackSql = buildPaginatedSelectSQL(dbType, fallbackSql, buildOrderBySQL(dbType, sortInfo, resolveDataViewerOrderFallbackColumns(editLocatorForQuery, pkColumnsForQuery, dbType)), size + 1, offset);
                executedSql = fallbackSql;
                resData = await executeDataQuery(fallbackSql, tr('data_viewer.sql_log.phase.complex_type_fallback_retry'));
            }
        }

        if (!resData.success && isMySQLFamily && hasSort && isSortMemoryErr(resData.message)) {
            const retrySql32MB = withSortBufferTuningSQL(dbType, sql, 32 * 1024 * 1024);
            if (retrySql32MB !== sql) {
                executedSql = retrySql32MB;
                resData = await executeDataQuery(retrySql32MB, tr('data_viewer.sql_log.phase.sort_buffer_retry', { size: '32MB' }));
            }
            if (!resData.success && isSortMemoryErr(resData.message)) {
                const retrySql128MB = withSortBufferTuningSQL(dbType, sql, 128 * 1024 * 1024);
                if (retrySql128MB !== executedSql) {
                    executedSql = retrySql128MB;
                    resData = await executeDataQuery(retrySql128MB, tr('data_viewer.sql_log.phase.sort_buffer_retry', { size: '128MB' }));
                }
            }
            if (resData.success) {
                message.warning(tr('data_viewer.message.sort_buffer_retry_succeeded'));
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
            if (isMongoDB && !forceReadOnly && tableName) {
                const nextLocator = buildMongoDataViewerEditLocator(fieldNames, tr);
                pkColumnsForQuery = nextLocator.readOnly ? [] : [MONGODB_ID_COLUMN];
                editLocatorForQuery = nextLocator;
                setPkColumns(pkColumnsForQuery);
                setEditLocator(nextLocator);
                if (nextLocator.readOnly && resultData.length > 0) {
                    warnDataViewerReadOnly('collection', formatDataViewerTableName(dbName, tableName), nextLocator.reason, tr);
                }
            }
            setColumnNames(fieldNames);
            resultData.forEach((row: any, i: number) => {
                if (row && typeof row === 'object') row[GONAVI_ROW_KEY] = `row-${offset + i}`;
            });
            setData(resultData);
            const derivedTotalKnown = !hasMore;
            const derivedTotal = derivedTotalKnown ? offset + resultData.length : currentPage * size + 1;
            const minExpectedTotal = hasMore ? offset + resultData.length + 1 : offset + resultData.length;
            if (derivedTotalKnown) countKeyRef.current = countKey;
            const staleKnownTotalForCurrentPage =
              !derivedTotalKnown &&
              pagination.totalKnown &&
              countKeyRef.current === countKey &&
              !isKnownTotalFreshForPage(pagination.total, minExpectedTotal);
            if (staleKnownTotalForCurrentPage) {
                countKeyRef.current = '';
            }
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
                        approximateTotal: undefined,
                        totalCountLoading: false,
                        totalCountCancelled: false,
                    };
                }
                if (prev.totalKnown && countKeyRef.current === countKey) {
                    // 当当前页存在“下一页”信号时，已知总数至少应大于当前页末尾。
                    // 若旧总数不满足该条件（例如清空表后又外部写入数据），降级为未知总数并重新统计。
                    if (isKnownTotalFreshForPage(prev.total, minExpectedTotal)) {
                        return { ...prev, current: currentPage, pageSize: size };
                    }
                }
                const keepTotalCounting = prev.totalCountLoading && (
                  manualCountKeyRef.current === countKey || autoCountKeyRef.current === countKey
                );
                const hasApproximateTotalForCurrentKey =
                  prev.totalApprox &&
                  (duckdbApproxKeyRef.current === countKey || oracleApproxKeyRef.current === countKey) &&
                  Number.isFinite(prev.approximateTotal) &&
                  Number(prev.approximateTotal) >= minExpectedTotal;
                if (hasApproximateTotalForCurrentKey) {
                    return {
                        ...prev,
                        current: currentPage,
                        pageSize: size,
                        total: derivedTotal,
                        totalKnown: false,
                        totalApprox: true,
                        approximateTotal: prev.approximateTotal,
                        totalCountLoading: keepTotalCounting,
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
                    approximateTotal: undefined,
                    totalCountLoading: keepTotalCounting,
                    totalCountCancelled: keepTotalCounting ? false : prev.totalCountCancelled,
                };
            });

            const shouldRunAsyncCount = !derivedTotalKnown && !preferManualTotalCount;
            if (shouldRunAsyncCount) {
                if (countKeyRef.current !== countKey) {
                    countKeyRef.current = countKey;
                    autoCountKeyRef.current = countKey;
                    const countSeq = ++countSeqRef.current;
                    const countStart = Date.now();
                    // Large-table COUNT(*) can be slow and may delay later operations in some runtimes.
                    // DuckDB large-file scenarios disable background COUNT because it can slow pagination significantly.
                    const countConfig = buildRpcConnectionConfig(config, { timeout: 5, queryTimeout: 5 });
                    setPagination(prev => ({ ...prev, totalCountLoading: true, totalCountCancelled: false }));

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
                            if (latestCountKeyRef.current !== countKey) return;

                            autoCountKeyRef.current = '';
                            if (!resCount.success) {
                                setPagination(prev => ({ ...prev, totalCountLoading: false }));
                                return;
                            }
                            if (!Array.isArray(resCount.data) || resCount.data.length === 0) {
                                setPagination(prev => ({ ...prev, totalCountLoading: false }));
                                return;
                            }

                            const total = parseTotalFromCountRow(resCount.data[0]);
                            if (total === null) {
                                setPagination(prev => ({ ...prev, totalCountLoading: false }));
                                return;
                            }

                            setPagination(prev => ({
                                ...prev,
                                total,
                                totalKnown: true,
                                totalApprox: false,
                                approximateTotal: undefined,
                                totalCountLoading: false,
                                totalCountCancelled: false,
                            }));
                        })
                        .catch(() => {
                            if (countSeqRef.current !== countSeq) return;
                            if (countKeyRef.current !== countKey) return;
                            autoCountKeyRef.current = '';
                            setPagination(prev => ({ ...prev, totalCountLoading: false }));
                            // Count failures do not block the main flow; details stay in the SQL log.
                        });
                }
            }

            if (!derivedTotalKnown) {
                const approximateCountStrategy = supportsApproximateTableCount
                  ? resolveApproximateTableCountStrategy({ dbType: dbTypeLower, whereSQL })
                  : 'none';

                if (approximateCountStrategy === 'duckdb-estimated-size' && duckdbApproxKeyRef.current !== countKey) {
                    duckdbApproxKeyRef.current = countKey;
                    const approxSeq = ++duckdbApproxSeqRef.current;
                    const { schemaName, pureTableName } = resolveDuckDBSchemaAndTable(dbName, tableName);
                    const escapedSchema = escapeSQLLiteral(schemaName);
                    const escapedTable = escapeSQLLiteral(pureTableName);
                    const approxConfig = buildRpcConnectionConfig(config, { timeout: 3, queryTimeout: 3 });
                    const approxSqlCandidates = [
                        `SELECT estimated_size AS approx_total FROM duckdb_tables() WHERE schema_name='${escapedSchema}' AND table_name='${escapedTable}' LIMIT 1`,
                        `SELECT estimated_size AS approx_total FROM duckdb_tables() WHERE table_name='${escapedTable}' ORDER BY CASE WHEN schema_name='${escapedSchema}' THEN 0 ELSE 1 END LIMIT 1`,
                    ];

                    (async () => {
                        for (const approxSql of approxSqlCandidates) {
                            try {
                                const approxRes = await DBQuery(approxConfig as any, dbName, approxSql);
                                if (duckdbApproxSeqRef.current !== approxSeq) return;
                                if (latestCountKeyRef.current !== countKey) return;
                                if (!approxRes?.success || !Array.isArray(approxRes.data) || approxRes.data.length === 0) continue;

                                const approxTotal = parseApproximateTableCountRow(approxRes.data[0]);
                                if (approxTotal === null) continue;
                                if (!Number.isFinite(approxTotal) || approxTotal < minExpectedTotal) continue;

                                setPagination(prev => {
                                    if (latestCountKeyRef.current !== countKey) return prev;
                                    if (prev.totalKnown) return prev;
                                    return {
                                        ...prev,
                                        totalKnown: false,
                                        totalApprox: true,
                                        approximateTotal: approxTotal,
                                        totalCountCancelled: false,
                                    };
                                });
                                return;
                            } catch {
                                if (duckdbApproxSeqRef.current !== approxSeq) return;
                                if (latestCountKeyRef.current !== countKey) return;
                            }
                        }
                    })();
                }

                if (approximateCountStrategy === 'oracle-num-rows' && oracleApproxKeyRef.current !== countKey) {
                    oracleApproxKeyRef.current = countKey;
                    const approxSeq = ++oracleApproxSeqRef.current;
                    const approxConfig = buildRpcConnectionConfig(config, { timeout: 3, queryTimeout: 3 });
                    const approxSql = buildOracleApproximateTotalSql({ dbName, tableName });

                    DBQuery(approxConfig as any, dbName, approxSql)
                        .then((approxRes: any) => {
                            if (oracleApproxSeqRef.current !== approxSeq) return;
                            if (latestCountKeyRef.current !== countKey) return;
                            if (!approxRes?.success || !Array.isArray(approxRes.data) || approxRes.data.length === 0) return;

                            const approxTotal = parseApproximateTableCountRow(approxRes.data[0], ['approx_total', 'num_rows', 'estimated_rows', 'row_count', 'count', 'total']);
                            if (approxTotal === null) return;
                            if (!Number.isFinite(approxTotal) || approxTotal < minExpectedTotal) return;

                            setPagination(prev => {
                                if (latestCountKeyRef.current !== countKey) return prev;
                                if (prev.totalKnown) return prev;
                                return {
                                    ...prev,
                                    totalKnown: false,
                                    totalApprox: true,
                                    approximateTotal: approxTotal,
                                    totalCountCancelled: false,
                                };
                            });
                        })
                        .catch(() => {
                            if (oracleApproxSeqRef.current !== approxSeq) return;
                            if (latestCountKeyRef.current !== countKey) return;
                        });
                }
            }
        } else {
            message.error(formatDataViewerQueryError(dbTypeLower, resData.message, tr));
        }
    } catch (e: any) {
        if (fetchSeqRef.current !== seq) return;
        message.error(formatDataViewerQueryError(dbTypeLower, e?.message || e, tr));
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
  }, [connections, ensureRabbitMQPreviewConfirmed, tab, sortInfo, filterConditions, quickWhereCondition, pkColumns, editLocator, forceReadOnly, pagination.total, pagination.totalKnown, pagination.totalApprox, pagination.approximateTotal, preferManualTotalCount, supportsApproximateTableCount, supportsApproximateTotalPages, tr]);
  return { fetchData };
};

export type DataViewerFetchDataApi = ReturnType<typeof useDataViewerFetchData>;
