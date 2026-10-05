import { useCallback, useMemo, useEffect } from 'react';
import { message } from 'antd';
import {
  type FilterCondition,
  buildWhereSQL,
  quoteQualifiedIdent,
  buildOrderBySQL,
  hasExplicitSort,
  withSortBufferTuningSQL,
} from '../../../utils/sql';
import { normalizeViewerFilterConditions } from '../dataViewerFilterSnapshots';
import {
  normalizeQuickWhereCondition,
  validateQuickWhereCondition,
  buildEffectiveFilterConditions,
} from '../../../utils/dataGridWhereFilter';
import { resolveDataSourceType } from '../../../utils/dataSourceCapabilities';
import { resolveDataViewerOrderFallbackColumns } from '../dataViewerQuerySql';
import { resolveDataViewerAutoFetchAction } from '../../../utils/dataViewerAutoFetch';
import type { DataViewerStateApi } from './useDataViewerState';
import type { DataViewerFetchDataApi } from './useDataViewerFetchData';
import type { DataViewerProps } from '../../DataViewer';

export interface UseDataViewerActionsInput {
  deferredInitialFetchRef: DataViewerStateApi['deferredInitialFetchRef'];
  initialLoadRef: DataViewerStateApi['initialLoadRef'];
  fetchData: DataViewerFetchDataApi['fetchData'];
  pagination: DataViewerStateApi['pagination'];
  countSeqRef: DataViewerStateApi['countSeqRef'];
  manualCountSeqRef: DataViewerStateApi['manualCountSeqRef'];
  duckdbApproxSeqRef: DataViewerStateApi['duckdbApproxSeqRef'];
  oracleApproxSeqRef: DataViewerStateApi['oracleApproxSeqRef'];
  countKeyRef: DataViewerStateApi['countKeyRef'];
  autoCountKeyRef: DataViewerStateApi['autoCountKeyRef'];
  manualCountKeyRef: DataViewerStateApi['manualCountKeyRef'];
  duckdbApproxKeyRef: DataViewerStateApi['duckdbApproxKeyRef'];
  oracleApproxKeyRef: DataViewerStateApi['oracleApproxKeyRef'];
  setPagination: DataViewerStateApi['setPagination'];
  setSortInfo: DataViewerStateApi['setSortInfo'];
  rocketMQTagTotalCountUnavailable: DataViewerStateApi['rocketMQTagTotalCountUnavailable'];
  tr: DataViewerStateApi['tr'];
  setShowFilter: DataViewerStateApi['setShowFilter'];
  skipNextAutoFetchRef: DataViewerStateApi['skipNextAutoFetchRef'];
  setFilterConditions: DataViewerStateApi['setFilterConditions'];
  setQuickWhereCondition: DataViewerStateApi['setQuickWhereCondition'];
  tab: DataViewerProps['tab'];
  currentConnConfig: DataViewerStateApi['currentConnConfig'];
  filterConditions: DataViewerStateApi['filterConditions'];
  quickWhereCondition: DataViewerStateApi['quickWhereCondition'];
  sortInfo: DataViewerStateApi['sortInfo'];
  editLocator: DataViewerStateApi['editLocator'];
  pkColumns: DataViewerStateApi['pkColumns'];
}

export const useDataViewerActions = ({
  deferredInitialFetchRef, initialLoadRef, fetchData, pagination, countSeqRef, manualCountSeqRef,
  duckdbApproxSeqRef, oracleApproxSeqRef, countKeyRef, autoCountKeyRef, manualCountKeyRef,
  duckdbApproxKeyRef, oracleApproxKeyRef, setPagination, setSortInfo,
  rocketMQTagTotalCountUnavailable, tr, setShowFilter, skipNextAutoFetchRef, setFilterConditions,
  setQuickWhereCondition, tab, currentConnConfig, filterConditions, quickWhereCondition, sortInfo,
  editLocator, pkColumns,
}: UseDataViewerActionsInput) => {
  // 依赖定位列：在无手动排序时可回退到安全定位列稳定排序。
  // 定位信息只会在表上下文变化后重新加载，避免循环查询。

  // Handlers memoized
  const handleDataViewActivate = useCallback(() => {
    if (!deferredInitialFetchRef.current || initialLoadRef.current) return;
    deferredInitialFetchRef.current = false;
    initialLoadRef.current = true;
    void fetchData(pagination.current, pagination.pageSize);
  }, [fetchData, pagination.current, pagination.pageSize]);
  const handleReload = useCallback(() => {
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
      totalKnown: false,
      totalApprox: false,
      approximateTotal: undefined,
      totalCountLoading: false,
      totalCountCancelled: false,
    }));
    return fetchData(pagination.current, pagination.pageSize, { refreshTotal: true });
  }, [fetchData, pagination.current, pagination.pageSize]);
  const handleSort = useCallback((field: string, order: string) => {
    // 支持多字段排序：field 为 JSON 数组字符串时解析为多字段
    try {
      const parsed = JSON.parse(field);
      if (Array.isArray(parsed)) {
        setSortInfo(parsed.filter((s: any) => s && s.columnKey && (s.order === 'ascend' || s.order === 'descend')));
        return;
      }
    } catch { /* 单字段模式 */ }
    const normalizedOrder = order === 'ascend' || order === 'descend' ? order : '';
    const normalizedField = String(field || '').trim();
    if (!normalizedField || !normalizedOrder) {
      setSortInfo([]);
      return;
    }
    setSortInfo([{ columnKey: normalizedField, order: normalizedOrder, enabled: true }]);
  }, []);
  const handlePageChange = useCallback((page: number, size: number) => fetchData(page, size), [fetchData]);
  const handleLastPage = useCallback((pageSize: number) => {
    if (rocketMQTagTotalCountUnavailable) {
      message.warning(tr('data_grid.toolbar.tag_total_unavailable_tooltip'));
      return;
    }
    fetchData(1, pageSize, { navigateToLastPage: true });
  }, [fetchData, rocketMQTagTotalCountUnavailable, tr]);
  const handleToggleFilter = useCallback(() => setShowFilter(prev => !prev), []);
  const handleApplyFilter = useCallback((conditions: FilterCondition[]) => {
    skipNextAutoFetchRef.current = false;
    initialLoadRef.current = true;
    setPagination(prev => ({
      ...prev,
      current: 1,
      totalCountLoading: false,
      totalCountCancelled: false,
    }));
    setFilterConditions(normalizeViewerFilterConditions(conditions));
  }, []);
  const handleApplyQuickWhereCondition = useCallback((condition: string) => {
    const normalized = normalizeQuickWhereCondition(condition);
    const validation = validateQuickWhereCondition(normalized);
    if (!validation.ok) {
      message.error(validation.message);
      return;
    }
    skipNextAutoFetchRef.current = false;
    initialLoadRef.current = true;
    setPagination(prev => ({
      ...prev,
      current: 1,
      totalCountLoading: false,
      totalCountCancelled: false,
    }));
    setQuickWhereCondition(normalized);
  }, []);

  const exportSqlWithFilter = useMemo(() => {
    const tableName = String(tab.tableName || '').trim();
    const dbType = resolveDataSourceType(currentConnConfig);
    if (!tableName || !dbType) return '';

    const effectiveFilterConditions = buildEffectiveFilterConditions(filterConditions, quickWhereCondition);
    const whereSQL = buildWhereSQL(dbType, effectiveFilterConditions);
    if (!whereSQL) return '';

    let sql = `SELECT * FROM ${quoteQualifiedIdent(dbType, tableName)} ${whereSQL}`;
    sql += buildOrderBySQL(dbType, sortInfo, resolveDataViewerOrderFallbackColumns(editLocator, pkColumns, dbType));
    const normalizedType = dbType.toLowerCase();
    const hasSortForBuffer = hasExplicitSort(sortInfo);
    if (hasSortForBuffer && (normalizedType === 'mysql' || normalizedType === 'mariadb')) {
      sql = withSortBufferTuningSQL(normalizedType, sql, 32 * 1024 * 1024);
    }
    return sql;
  }, [tab.tableName, currentConnConfig?.type, currentConnConfig?.driver, filterConditions, quickWhereCondition, sortInfo, editLocator, pkColumns]);

  useEffect(() => {
    if (deferredInitialFetchRef.current && !initialLoadRef.current) {
      return;
    }
    const action = resolveDataViewerAutoFetchAction({
      skipNextAutoFetch: skipNextAutoFetchRef.current,
      hasInitialLoad: initialLoadRef.current,
    });
    if (action === 'skip') {
      skipNextAutoFetchRef.current = false;
      return;
    }
    if (action === 'load-current-page') {
      initialLoadRef.current = true;
      fetchData(pagination.current, pagination.pageSize);
      return;
    }
    fetchData(1, pagination.pageSize);
  }, [tab.id, tab.connectionId, tab.dbName, tab.tableName, tab.objectType, sortInfo, filterConditions, quickWhereCondition]);
  return {
    handleDataViewActivate, handleReload, handleSort, handlePageChange, handleLastPage,
    handleToggleFilter, handleApplyFilter, handleApplyQuickWhereCondition, exportSqlWithFilter,
  };
};

export type DataViewerActionsApi = ReturnType<typeof useDataViewerActions>;
