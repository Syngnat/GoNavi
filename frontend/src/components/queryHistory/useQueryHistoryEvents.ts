import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TabData } from '../../types';
import {
  buildSQLAuditFilterPayload,
  DEFAULT_SQL_AUDIT_FILTER,
  normalizeSQLAuditPage,
  type SQLAuditFilter,
  type SQLAuditPage,
} from '../audit/sqlAuditModel';
import {
  requireSQLAuditMethod,
  unwrapSQLAuditResult,
  type SQLAuditBackend,
} from '../audit/sqlAuditRpc';
import { deriveQueryHistoryStatusCounts, type QueryHistoryStatusCounts } from './queryHistoryModel';

const SEARCH_DEBOUNCE_MS = 250;

const EMPTY_PAGE: SQLAuditPage = {
  items: [],
  total: 0,
  page: 1,
  pageSize: DEFAULT_SQL_AUDIT_FILTER.pageSize,
  summary: { totalEvents: 0, successCount: 0, errorCount: 0, transactionCount: 0, cancelledCount: 0 },
};

const EMPTY_COUNTS: QueryHistoryStatusCounts = { all: 0, success: 0, error: 0, cancelled: 0 };

const buildInitialFilter = (tab: TabData): SQLAuditFilter => ({
  ...DEFAULT_SQL_AUDIT_FILTER,
  connectionId: String(tab.connectionId || '').trim(),
  database: String(tab.dbName || '').trim(),
});

export interface QueryHistoryEventsState {
  filter: SQLAuditFilter;
  page: SQLAuditPage;
  counts: QueryHistoryStatusCounts;
  loading: boolean;
  error: string;
  hasActiveFilters: boolean;
  /** 每次手动刷新自增，供依赖刷新的兄弟组件（如健康度提示）联动 */
  reloadKey: number;
  setFilterField: <K extends keyof SQLAuditFilter>(key: K, value: SQLAuditFilter[K]) => void;
  setPagination: (page: number, pageSize: number) => void;
  resetFilters: () => void;
  reload: () => void;
}

/**
 * 执行历史数据源：筛选、防抖搜索、分页、状态计数。
 * 状态计数不随「状态」筛选变化，所以选中某个状态时会额外发一次不带状态的汇总请求。
 */
export function useQueryHistoryEvents(tab: TabData, backend: SQLAuditBackend): QueryHistoryEventsState {
  const [filter, setFilter] = useState<SQLAuditFilter>(() => buildInitialFilter(tab));
  const [debouncedSearch, setDebouncedSearch] = useState(filter.search);
  const [page, setPage] = useState<SQLAuditPage>(EMPTY_PAGE);
  const [counts, setCounts] = useState<QueryHistoryStatusCounts>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const requestSequenceRef = useRef(0);

  useEffect(() => {
    setFilter((current) => ({
      ...current,
      connectionId: String(tab.connectionId || '').trim(),
      database: String(tab.dbName || '').trim(),
      page: 1,
    }));
  }, [tab.connectionId, tab.dbName, tab.sqlAuditRequestKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(filter.search), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [filter.search]);

  const requestFilter = useMemo<SQLAuditFilter>(() => ({ ...filter, search: debouncedSearch }), [debouncedSearch, filter]);

  useEffect(() => {
    const requestSequence = ++requestSequenceRef.current;
    const isCurrent = () => requestSequence === requestSequenceRef.current;
    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const getEvents = requireSQLAuditMethod(backend, 'GetSQLAuditEvents');
        const pagePayload = buildSQLAuditFilterPayload(requestFilter, { executionHistory: true });
        const countsPayload = buildSQLAuditFilterPayload(
          { ...requestFilter, status: '', page: 1, pageSize: 1 },
          { executionHistory: true },
        );
        const [pageResult, countsResult] = await Promise.all([
          getEvents(pagePayload),
          requestFilter.status ? getEvents(countsPayload).catch(() => null) : Promise.resolve(null),
        ]);
        if (!isCurrent()) return;
        const nextPage = normalizeSQLAuditPage(unwrapSQLAuditResult(pageResult), requestFilter);
        const countsSource = countsResult
          ? normalizeSQLAuditPage(unwrapSQLAuditResult(countsResult), requestFilter)
          : nextPage;
        setPage(nextPage);
        setCounts(deriveQueryHistoryStatusCounts(countsSource.summary));
      } catch (cause) {
        if (!isCurrent()) return;
        setPage({ ...EMPTY_PAGE, page: requestFilter.page, pageSize: requestFilter.pageSize });
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (isCurrent()) setLoading(false);
      }
    };
    void load();
    return () => {
      requestSequenceRef.current += 1;
    };
  }, [backend, reloadKey, requestFilter]);

  const setFilterField = useCallback(<K extends keyof SQLAuditFilter>(key: K, value: SQLAuditFilter[K]) => {
    setFilter((current) => ({ ...current, [key]: value, page: 1 }));
  }, []);

  const setPagination = useCallback((nextPage: number, pageSize: number) => {
    setFilter((current) => ({ ...current, page: nextPage, pageSize }));
  }, []);

  const resetFilters = useCallback(() => {
    setFilter((current) => ({ ...DEFAULT_SQL_AUDIT_FILTER, pageSize: current.pageSize }));
  }, []);

  const reload = useCallback(() => setReloadKey((current) => current + 1), []);

  const hasActiveFilters = Boolean(
    filter.search
    || filter.connectionId
    || filter.database
    || filter.status
    || filter.fromTimestamp
    || filter.toTimestamp,
  );

  return { filter, page, counts, loading, error, hasActiveFilters, reloadKey, setFilterField, setPagination, resetFilters, reload };
}
