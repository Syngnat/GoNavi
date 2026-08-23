import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { message } from 'antd';
import { TabData, ColumnDefinition, IndexDefinition } from '../types';
import { useStore } from '../store';
import { DBQuery, DBGetColumns, DBGetIndexes } from '../../wailsjs/go/app/App';
import DataGrid, { GONAVI_ROW_KEY } from './DataGrid';
import { buildOrderBySQL, buildPaginatedSelectSQL, buildWhereSQL, hasExplicitSort, quoteIdentPart, quoteQualifiedIdent, reverseOrderBySQL, withSortBufferTuningSQL, type FilterCondition } from '../utils/sql';
import { buildMongoCountCommand, buildMongoFilter, buildMongoFindCommand, buildMongoSort } from '../utils/mongodb';
import { buildOracleApproximateTotalSql, parseApproximateTableCountRow, resolveApproximateTableCountStrategy } from '../utils/approximateTableCount';
import { getDataSourceCapabilities, resolveDataSourceType } from '../utils/dataSourceCapabilities';
import { resolveDataViewerAutoFetchAction } from '../utils/dataViewerAutoFetch';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { resolveLanguage, t as translate, type I18nParams } from '../i18n';
import {
  buildEffectiveFilterConditions,
  normalizeQuickWhereCondition,
  validateQuickWhereCondition,
} from '../utils/dataGridWhereFilter';
import {
  DUCKDB_ROWID_LOCATOR_COLUMN,
  ORACLE_ROWID_LOCATOR_COLUMN,
  buildAllColumnsLocator,
  resolveEditRowLocator,
  type EditRowLocator,
} from '../utils/rowLocator';
import { isOracleLikeDialect } from '../utils/sqlDialect';
import {
  getColumnDefinitionKey,
  getColumnDefinitionName,
  getColumnDefinitionType,
} from '../utils/columnDefinition';
import { splitQualifiedNameLast, splitQualifiedNameSegments } from '../utils/qualifiedName';
import { requestTableMetadata } from '../utils/tableMetadataRequestCache';

type ViewerPaginationState = {
  current: number;
  pageSize: number;
  total: number;
  totalKnown: boolean;
  totalApprox: boolean;
  approximateTotal?: number;
  totalCountLoading: boolean;
  totalCountCancelled: boolean;
};

type DataViewerFetchOptions = {
  refreshTotal?: boolean;
  navigateToLastPage?: boolean;
};

type DataViewerTranslator = (key: string, params?: I18nParams) => string;

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

const isKnownTotalFreshForPage = (total: unknown, minExpectedTotal: number): boolean => {
  const parsedTotal = toNonNegativeFiniteNumber(total);
  return parsedTotal !== null && parsedTotal >= minExpectedTotal;
};

const buildDataViewerReadOnlyLocator = (reason: string): EditRowLocator => ({
  strategy: 'none',
  columns: [],
  valueColumns: [],
  readOnly: true,
  reason,
});

const READ_ONLY_REASON_NO_SAFE_LOCATOR = '\u672a\u68c0\u6d4b\u5230\u4e3b\u952e\u6216\u53ef\u7528\u552f\u4e00\u7d22\u5f15\uff0c\u65e0\u6cd5\u5b89\u5168\u63d0\u4ea4\u4fee\u6539\u3002';
const READ_ONLY_REASON_ORACLE_ROWID_MISSING = '\u672a\u68c0\u6d4b\u5230\u4e3b\u952e\u6216\u53ef\u7528\u552f\u4e00\u7d22\u5f15\uff0c\u4e14\u7ed3\u679c\u4e2d\u7f3a\u5c11 Oracle ROWID\uff0c\u65e0\u6cd5\u5b89\u5168\u63d0\u4ea4\u4fee\u6539\u3002';
const READ_ONLY_REASON_PRIMARY_KEY_MISSING_PREFIX = '\u7ed3\u679c\u96c6\u4e2d\u7f3a\u5c11\u4e3b\u952e\u5217 ';
const READ_ONLY_REASON_SAFE_SUBMIT_SUFFIX = '\uff0c\u65e0\u6cd5\u5b89\u5168\u63d0\u4ea4\u4fee\u6539\u3002';

const localizeDataViewerReadOnlyReason = (reason: string | undefined, tr: DataViewerTranslator): string => {
  const text = String(reason || '').trim();
  if (!text) return tr('data_viewer.read_only.reason.no_safe_locator');
  if (text === READ_ONLY_REASON_NO_SAFE_LOCATOR) {
    return tr('data_viewer.read_only.reason.no_safe_locator');
  }
  if (text === READ_ONLY_REASON_ORACLE_ROWID_MISSING) {
    return tr('data_viewer.read_only.reason.oracle_rowid_missing');
  }
  if (text.startsWith(READ_ONLY_REASON_PRIMARY_KEY_MISSING_PREFIX) && text.endsWith(READ_ONLY_REASON_SAFE_SUBMIT_SUFFIX)) {
    const columns = text.slice(READ_ONLY_REASON_PRIMARY_KEY_MISSING_PREFIX.length, -READ_ONLY_REASON_SAFE_SUBMIT_SUFFIX.length);
    return tr('data_viewer.read_only.reason.primary_key_column_missing', { columns });
  }
  return text;
};

const localizeDataViewerReadOnlyLocator = (locator: EditRowLocator, tr: DataViewerTranslator): EditRowLocator => {
  if (!locator.readOnly) return locator;
  return { ...locator, reason: localizeDataViewerReadOnlyReason(locator.reason, tr) };
};

const warnDataViewerReadOnly = (
  kind: 'table' | 'collection',
  target: string,
  reason: string | undefined,
  tr: DataViewerTranslator,
) => {
  const key = kind === 'table'
    ? 'data_viewer.read_only.warning.table'
    : 'data_viewer.read_only.warning.collection';
  message.warning(tr(key, {
    target,
    reason: localizeDataViewerReadOnlyReason(reason, tr),
  }));
};

const formatDataViewerTableName = (dbName: string, tableName: string): string => (
  dbName ? `${dbName}.${tableName}` : tableName
);

const getTableColumnNames = (columns: ColumnDefinition[] | undefined): string[] => (
  (columns || [])
    .map(getColumnDefinitionName)
    .filter(Boolean)
);

const MONGODB_ID_COLUMN = '_id';
const MONGODB_ID_LOCATOR_COLUMN = '__gonavi_mongodb_id_locator__';

const buildMongoDataViewerEditLocator = (resultColumns: string[], tr: DataViewerTranslator): EditRowLocator => {
  const columns = (resultColumns || [])
    .map((column) => String(column || '').trim())
    .filter(Boolean);
  const idColumn = columns.find((column) => column.toLowerCase() === MONGODB_ID_COLUMN);
  if (!idColumn) {
    return buildDataViewerReadOnlyLocator(tr('data_viewer.read_only.reason.mongo_id_missing'));
  }

  const locatorValueColumn = columns.find((column) => column === MONGODB_ID_LOCATOR_COLUMN) || idColumn;
  const writableColumns: Record<string, string> = {};
  columns.forEach((column) => {
    const normalized = String(column || '').trim();
    if (
      !normalized ||
      normalized === GONAVI_ROW_KEY ||
      normalized === MONGODB_ID_LOCATOR_COLUMN ||
      normalized.toLowerCase() === MONGODB_ID_COLUMN
    ) return;
    writableColumns[normalized] = normalized;
  });

  return {
    strategy: 'primary-key',
    columns: [MONGODB_ID_COLUMN],
    valueColumns: [locatorValueColumn],
    hiddenColumns: locatorValueColumn === MONGODB_ID_LOCATOR_COLUMN ? [MONGODB_ID_LOCATOR_COLUMN] : undefined,
    writableColumns,
    readOnly: false,
  };
};

const resolveDataViewerOrderFallbackColumns = (locator: EditRowLocator | undefined, pkColumns: string[]): string[] => {
  if (locator && !locator.readOnly && locator.strategy !== 'oracle-rowid') {
    return locator.valueColumns.length > 0 ? locator.valueColumns : locator.columns;
  }
  return pkColumns;
};

const buildDataViewerBaseSelectSQL = (
  dbType: string,
  tableName: string,
  whereSQL: string,
  locator?: EditRowLocator,
): string => {
  const quotedTableName = quoteQualifiedIdent(dbType, tableName);
  if (locator?.strategy !== 'oracle-rowid' && locator?.strategy !== 'duckdb-rowid') {
    return `SELECT * FROM ${quotedTableName} ${whereSQL}`;
  }

  const alias = 'gonavi_row_source';
  if (locator?.strategy === 'duckdb-rowid') {
    const duckdbRowIDAlias = quoteIdentPart(dbType, DUCKDB_ROWID_LOCATOR_COLUMN);
    return `SELECT ${alias}.*, ${alias}.rowid AS ${duckdbRowIDAlias} FROM ${quotedTableName} ${alias} ${whereSQL}`;
  }

  const oracleRowIDAlias = quoteIdentPart(dbType, ORACLE_ROWID_LOCATOR_COLUMN);
  return `SELECT ${alias}.*, ${alias}.ROWID AS ${oracleRowIDAlias} FROM ${quotedTableName} ${alias} ${whereSQL}`;
};

const resolveDuckDBSchemaAndTable = (dbName: string, tableName: string) => {
  const rawTable = String(tableName || '').trim();
  if (!rawTable) return { schemaName: 'main', pureTableName: '' };

  const segments = splitQualifiedNameSegments(rawTable);
  if (segments.length >= 2) {
    return {
      schemaName: segments[segments.length - 2],
      pureTableName: segments[segments.length - 1],
    };
  }

  const fallbackParsed = splitQualifiedNameLast(String(dbName || '').trim());
  const fallbackSchema = fallbackParsed.objectName || String(dbName || '').trim() || 'main';
  return { schemaName: fallbackSchema, pureTableName: segments[0] || rawTable };
};

const escapeSQLLiteral = (value: string): string => String(value || '').replace(/'/g, "''");

const isDuckDBUnsupportedTypeError = (msg: string): boolean => /unsupported\s*type:\s*duckdb\./i.test(String(msg || ''));

const DATA_VIEWER_TIMEOUT_KEYWORDS = [
  '\u8d85\u65f6',
  '\u903e\u6642',
  'タイムアウト',
  'zeitüberschreitung',
  'тайм-аут',
];

const isDuckDBComplexColumnType = (columnType?: string): boolean => {
  const raw = String(columnType || '').trim().toLowerCase();
  if (!raw) return false;
  return raw.includes('map') || raw.includes('struct') || raw.includes('union') || raw.includes('array') || raw.includes('list');
};

const formatDataViewerQueryError = (dbType: string, messageText: unknown, tr: DataViewerTranslator): string => {
  const rawMessage = String(messageText || tr('data_viewer.message.query_failed')).trim() || tr('data_viewer.message.query_failed');
  const lower = rawMessage.toLowerCase();
  const hasLocalizedTimeoutKeyword = DATA_VIEWER_TIMEOUT_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()));
  const isTimeout = lower.includes('context deadline exceeded') || lower.includes('deadline exceeded') || lower.includes('timeout') || lower.includes('timed out') || hasLocalizedTimeoutKeyword;
  const isDuckDBInterrupted = String(dbType || '').trim().toLowerCase() === 'duckdb' && (lower.includes('interrupt error') || lower.includes('interrupted'));
  if (isTimeout || isDuckDBInterrupted) {
    if (String(dbType || '').trim().toLowerCase() === 'duckdb') {
      return tr('data_viewer.message.duckdb_query_timeout');
    }
    return tr('data_viewer.message.query_timeout');
  }
  return rawMessage;
};

type ViewerFilterSnapshot = {
  showFilter: boolean;
  conditions: FilterCondition[];
  quickWhereCondition: string;
  currentPage: number;
  pageSize: number;
  sortInfo: Array<{ columnKey: string, order: string, enabled?: boolean }>;
  scrollTop: number;
  scrollLeft: number;
};

type ViewerScrollSnapshot = {
  top: number;
  left: number;
};

const viewerFilterSnapshotsByTab = new Map<string, ViewerFilterSnapshot>();
const MAX_VIEWER_FILTER_SNAPSHOTS = 64;
const VIEWER_SCROLL_SNAPSHOT_PERSIST_DELAY_MS = 160;
const shouldDeferInitialDataViewerFetch = (initialViewMode?: TabData['initialViewMode']): boolean => (
  initialViewMode === 'fields'
);

const trimViewerFilterSnapshots = () => {
  while (viewerFilterSnapshotsByTab.size > MAX_VIEWER_FILTER_SNAPSHOTS) {
    const oldestKey = viewerFilterSnapshotsByTab.keys().next().value;
    if (!oldestKey) {
      break;
    }
    viewerFilterSnapshotsByTab.delete(oldestKey);
  }
};

const setViewerFilterSnapshot = (
  tabId: string,
  snapshot: ViewerFilterSnapshot,
) => {
  const normalizedTabId = String(tabId || '').trim();
  if (!normalizedTabId) return;
  if (viewerFilterSnapshotsByTab.has(normalizedTabId)) {
    viewerFilterSnapshotsByTab.delete(normalizedTabId);
  }
  viewerFilterSnapshotsByTab.set(normalizedTabId, snapshot);
  trimViewerFilterSnapshots();
};

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
    valueSelection: cond?.valueSelection ? {
      values: Array.from(new Set((cond.valueSelection.values || []).map((value) => String(value)))),
      ...(cond.valueSelection.includeNull ? { includeNull: true } : {}),
      ...(cond.valueSelection.includeEmpty ? { includeEmpty: true } : {}),
    } : undefined,
  }));
};

const getViewerFilterSnapshot = (tabId: string): ViewerFilterSnapshot => {
  const cached = viewerFilterSnapshotsByTab.get(String(tabId || '').trim());
  if (!cached) {
    return { showFilter: false, conditions: [], quickWhereCondition: '', currentPage: 1, pageSize: 100, sortInfo: [], scrollTop: 0, scrollLeft: 0 };
  }
  return {
    showFilter: cached.showFilter === true,
    conditions: normalizeViewerFilterConditions(cached.conditions),
    quickWhereCondition: normalizeQuickWhereCondition(cached.quickWhereCondition),
    currentPage: Number.isFinite(Number(cached.currentPage)) && Number(cached.currentPage) > 0 ? Number(cached.currentPage) : 1,
    pageSize: Number.isFinite(Number(cached.pageSize)) && Number(cached.pageSize) > 0 ? Number(cached.pageSize) : 100,
    sortInfo: Array.isArray(cached.sortInfo)
      ? cached.sortInfo.filter(s => s && s.columnKey && (s.order === 'ascend' || s.order === 'descend'))
          .map(s => ({ columnKey: String(s.columnKey), order: s.order }))
      : (cached.sortInfo && (cached.sortInfo as any).columnKey ? [{ columnKey: String((cached.sortInfo as any).columnKey), order: (cached.sortInfo as any).order }] : []),
    scrollTop: Number.isFinite(Number(cached.scrollTop)) ? Number(cached.scrollTop) : 0,
    scrollLeft: Number.isFinite(Number(cached.scrollLeft)) ? Number(cached.scrollLeft) : 0,
  };
};

const DataViewer: React.FC<{ tab: TabData; isActive?: boolean }> = React.memo(({ tab, isActive = true }) => {
  const initialViewerSnapshot = useMemo(() => getViewerFilterSnapshot(tab.id), [tab.id]);
  const viewerLoadContextKey = `${tab.id}|${tab.connectionId}|${tab.dbName || ''}|${tab.tableName || ''}|${tab.objectType || 'table'}`;
  const deferInitialDataFetch = shouldDeferInitialDataViewerFetch(tab.initialViewMode);
  const [data, setData] = useState<any[]>([]);
  const [columnNames, setColumnNames] = useState<string[]>([]);
  const [pkColumns, setPkColumns] = useState<string[]>([]);
  const [editLocator, setEditLocator] = useState<EditRowLocator | undefined>(undefined);
  const [loadingState, setLoading] = useState(() => !deferInitialDataFetch);
  const loadingContextKeyRef = useRef(viewerLoadContextKey);
  const loading = loadingContextKeyRef.current === viewerLoadContextKey
    ? loadingState
    : !deferInitialDataFetch;
  const connections = useStore(state => state.connections);
  const addSqlLog = useStore(state => state.addSqlLog);
  const appearance = useStore(state => state.appearance);
  const languagePreference = useStore(state => state.languagePreference);
  const language = resolveLanguage(languagePreference);
  const tr = useCallback((key: string, params?: I18nParams) => translate(key, params, language), [language]);
  const isV2Ui = appearance?.uiVersion === 'v2';
  const fetchSeqRef = useRef(0);
  const countSeqRef = useRef(0);
  const countKeyRef = useRef<string>('');
  const duckdbApproxSeqRef = useRef(0);
  const duckdbApproxKeyRef = useRef<string>('');
  const oracleApproxSeqRef = useRef(0);
  const oracleApproxKeyRef = useRef<string>('');
  const autoCountKeyRef = useRef<string>('');
  const manualCountSeqRef = useRef(0);
  const manualCountKeyRef = useRef<string>('');
  const pkSeqRef = useRef(0);
  const pkKeyRef = useRef<string>('');
  const latestConfigRef = useRef<any>(null);
  const latestDbTypeRef = useRef<string>('');
  const latestDbNameRef = useRef<string>('');
  const latestCountSqlRef = useRef<string>('');
  const latestCountKeyRef = useRef<string>('');
  const scrollSnapshotRef = useRef<ViewerScrollSnapshot>({
    top: initialViewerSnapshot.scrollTop,
    left: initialViewerSnapshot.scrollLeft,
  });
  const pendingScrollSnapshotPersistRef = useRef<ViewerScrollSnapshot | null>(null);
  const scrollSnapshotPersistTimerRef = useRef<number | null>(null);
  const initialLoadRef = useRef(false);
  const skipNextAutoFetchRef = useRef(false);
  const deferredInitialFetchRef = useRef(shouldDeferInitialDataViewerFetch(tab.initialViewMode));

  const [pagination, setPagination] = useState<ViewerPaginationState>({
      current: initialViewerSnapshot.currentPage,
      pageSize: initialViewerSnapshot.pageSize,
      total: 0,
      totalKnown: false,
      totalApprox: false,
      totalCountLoading: false,
      totalCountCancelled: false,
  });

  const [sortInfo, setSortInfo] = useState<Array<{ columnKey: string, order: string, enabled?: boolean }>>(initialViewerSnapshot.sortInfo);
  
  const [showFilter, setShowFilter] = useState<boolean>(initialViewerSnapshot.showFilter);
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>(initialViewerSnapshot.conditions);
  const [quickWhereCondition, setQuickWhereCondition] = useState<string>(initialViewerSnapshot.quickWhereCondition);
  const duckdbSafeSelectCacheRef = useRef<Record<string, string>>({});
  const currentConnConfig = connections.find(c => c.id === tab.connectionId)?.config;
  const currentConnCaps = getDataSourceCapabilities(currentConnConfig);
  // Ordinary views can reject physical ROWID (for example Oracle join views), so
  // browse them without attempting the editable-table locator optimization.
  const forceReadOnly = currentConnCaps.forceReadOnlyQueryResult || tab.objectType === 'view';
  const preferManualTotalCount = currentConnCaps.preferManualTotalCount;
  const supportsApproximateTableCount = currentConnCaps.supportsApproximateTableCount;
  const supportsApproximateTotalPages = currentConnCaps.supportsApproximateTotalPages;
  const persistViewerSnapshot = useCallback((tabId: string, overrides?: Partial<ViewerFilterSnapshot>) => {
    const normalizedTabId = String(tabId || '').trim();
    if (!normalizedTabId) return;
    setViewerFilterSnapshot(normalizedTabId, {
      showFilter,
      conditions: normalizeViewerFilterConditions(filterConditions),
      quickWhereCondition: normalizeQuickWhereCondition(quickWhereCondition),
      currentPage: pagination.current,
      pageSize: pagination.pageSize,
      sortInfo,
      scrollTop: scrollSnapshotRef.current.top,
      scrollLeft: scrollSnapshotRef.current.left,
      ...overrides,
    });
  }, [showFilter, filterConditions, quickWhereCondition, pagination.current, pagination.pageSize, sortInfo]);

  useEffect(() => {
    const snapshot = getViewerFilterSnapshot(tab.id);
    setShowFilter(snapshot.showFilter);
    setFilterConditions(snapshot.conditions);
    setQuickWhereCondition(snapshot.quickWhereCondition);
    setSortInfo(snapshot.sortInfo);
    scrollSnapshotRef.current = { top: snapshot.scrollTop, left: snapshot.scrollLeft };
    initialLoadRef.current = false;
  }, [tab.id]);

  useEffect(() => {
    persistViewerSnapshot(tab.id);
  }, [persistViewerSnapshot]);

  useEffect(() => {
    return () => {
      if (scrollSnapshotPersistTimerRef.current !== null) {
        window.clearTimeout(scrollSnapshotPersistTimerRef.current);
        scrollSnapshotPersistTimerRef.current = null;
      }
      const pendingScrollSnapshot = pendingScrollSnapshotPersistRef.current;
      pendingScrollSnapshotPersistRef.current = null;
      persistViewerSnapshot(tab.id, pendingScrollSnapshot ? {
        scrollTop: pendingScrollSnapshot.top,
        scrollLeft: pendingScrollSnapshot.left,
      } : undefined);
    };
  }, [tab.id, persistViewerSnapshot]);

  useEffect(() => {
    const snapshot = getViewerFilterSnapshot(tab.id);
    setPkColumns([]);
    setEditLocator(undefined);
    pkKeyRef.current = '';
    countKeyRef.current = '';
    duckdbApproxKeyRef.current = '';
    oracleApproxKeyRef.current = '';
    autoCountKeyRef.current = '';
    manualCountKeyRef.current = '';
    duckdbSafeSelectCacheRef.current = {};
    latestConfigRef.current = null;
    latestDbTypeRef.current = '';
    latestDbNameRef.current = '';
    latestCountSqlRef.current = '';
    latestCountKeyRef.current = '';
    scrollSnapshotRef.current = { top: snapshot.scrollTop, left: snapshot.scrollLeft };
    initialLoadRef.current = false;
    deferredInitialFetchRef.current = shouldDeferInitialDataViewerFetch(tab.initialViewMode);
    skipNextAutoFetchRef.current = true;
    setPagination(prev => ({
      ...prev,
      current: snapshot.currentPage,
      pageSize: snapshot.pageSize,
      total: 0,
      totalKnown: false,
      totalApprox: false,
      approximateTotal: undefined,
      totalCountLoading: false,
      totalCountCancelled: false,
    }));
  }, [tab.id, tab.connectionId, tab.dbName, tab.tableName, tab.objectType]);

  const handleTableScrollSnapshotChange = useCallback((snapshot: ViewerScrollSnapshot) => {
    scrollSnapshotRef.current = snapshot;
    pendingScrollSnapshotPersistRef.current = snapshot;
    if (scrollSnapshotPersistTimerRef.current !== null) return;
    scrollSnapshotPersistTimerRef.current = window.setTimeout(() => {
      scrollSnapshotPersistTimerRef.current = null;
      const pendingScrollSnapshot = pendingScrollSnapshotPersistRef.current;
      pendingScrollSnapshotPersistRef.current = null;
      if (!pendingScrollSnapshot) return;
      persistViewerSnapshot(tab.id, {
        scrollTop: pendingScrollSnapshot.top,
        scrollLeft: pendingScrollSnapshot.left,
      });
    }, VIEWER_SCROLL_SNAPSHOT_PERSIST_DELAY_MS);
  }, [tab.id, persistViewerSnapshot]);

  const handleManualTotalCount = useCallback(async () => {
    const config = latestConfigRef.current;
    const dbName = latestDbNameRef.current;
    const countSql = latestCountSqlRef.current;
    const countKey = latestCountKeyRef.current;

    if (!config || !countSql || !countKey) {
      message.warning(tr('data_viewer.message.result_not_ready'));
      return;
    }

    manualCountKeyRef.current = countKey;
    const countSeq = ++manualCountSeqRef.current;
    const countStart = Date.now();
    setPagination(prev => ({ ...prev, totalCountLoading: true, totalCountCancelled: false }));
    const countConfig = buildRpcConnectionConfig(config, { timeout: 120, queryTimeout: 120 });

    try {
      const resCount = await DBQuery(countConfig as any, dbName, countSql);
      const countDuration = Date.now() - countStart;
      addSqlLog({
        id: `log-${Date.now()}-manual-count`,
        timestamp: Date.now(),
        sql: countSql,
        status: resCount?.success ? 'success' : 'error',
        duration: countDuration,
        message: resCount?.success ? '' : String(resCount?.message || tr('data_viewer.message.total_count_failed')),
        dbName
      });

      if (manualCountSeqRef.current !== countSeq) return;
      if (manualCountKeyRef.current !== countKey) return;

      if (!resCount?.success) {
        setPagination(prev => ({ ...prev, totalCountLoading: false }));
        message.error(String(resCount?.message || tr('data_viewer.message.total_count_failed')));
        return;
      }
      if (!Array.isArray(resCount.data) || resCount.data.length === 0) {
        setPagination(prev => ({ ...prev, totalCountLoading: false }));
        return;
      }

      const total = parseTotalFromCountRow(resCount.data[0]);
      if (total === null) {
        setPagination(prev => ({ ...prev, totalCountLoading: false }));
        message.error(tr('data_viewer.message.total_count_parse_failed'));
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
    } catch (e: any) {
      if (manualCountSeqRef.current !== countSeq) return;
      if (manualCountKeyRef.current !== countKey) return;
      setPagination(prev => ({ ...prev, totalCountLoading: false }));
      message.error(tr('data_viewer.message.total_count_failed_detail', { detail: String(e?.message || e) }));
    }
  }, [addSqlLog, tr]);

  const handleCancelManualTotalCount = useCallback(() => {
    manualCountSeqRef.current++;
    setPagination(prev => ({ ...prev, totalCountLoading: false, totalCountCancelled: true }));
  }, []);

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
      : buildOrderBySQL(dbType, sortInfo, resolveDataViewerOrderFallbackColumns(editLocatorForQuery, pkColumnsForQuery));
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
                fallbackSql = buildPaginatedSelectSQL(dbType, fallbackSql, buildOrderBySQL(dbType, sortInfo, resolveDataViewerOrderFallbackColumns(editLocatorForQuery, pkColumnsForQuery)), size + 1, offset);
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
  }, [connections, tab, sortInfo, filterConditions, quickWhereCondition, pkColumns, editLocator, forceReadOnly, pagination.total, pagination.totalKnown, pagination.totalApprox, pagination.approximateTotal, preferManualTotalCount, supportsApproximateTableCount, supportsApproximateTotalPages, tr]);
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
  const handleLastPage = useCallback((pageSize: number) => (
    fetchData(1, pageSize, { navigateToLastPage: true })
  ), [fetchData]);
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
    sql += buildOrderBySQL(dbType, sortInfo, resolveDataViewerOrderFallbackColumns(editLocator, pkColumns));
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
  }, [tab.id, tab.connectionId, tab.dbName, tab.tableName, tab.objectType, sortInfo, filterConditions, quickWhereCondition]); // Initial load and re-load on sort/filter

  return (
    <div className={isV2Ui ? 'gn-v2-data-viewer' : undefined} style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, height: '100%', width: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <DataGrid
          data={data}
          columnNames={columnNames}
          loading={loading}
          tableName={tab.tableName}
          objectType={tab.objectType || 'table'}
          exportScope="table"
          dbName={tab.dbName}
          schemaName={tab.schemaName}
          connectionId={tab.connectionId}
          pkColumns={pkColumns}
          editLocator={editLocator}
          onReload={handleReload}
          onSort={handleSort}
          onPageChange={handlePageChange}
          onLastPage={handleLastPage}
          pagination={pagination}
          onRequestTotalCount={preferManualTotalCount ? handleManualTotalCount : undefined}
          onCancelTotalCount={preferManualTotalCount ? handleCancelManualTotalCount : undefined}
          showFilter={showFilter}
          onToggleFilter={handleToggleFilter}
          onApplyFilter={handleApplyFilter}
          appliedFilterConditions={filterConditions}
          quickWhereCondition={quickWhereCondition}
          onApplyQuickWhereCondition={handleApplyQuickWhereCondition}
          readOnly={forceReadOnly || !editLocator || editLocator.readOnly}
          sortInfoExternal={sortInfo}
          exportSqlWithFilter={exportSqlWithFilter || undefined}
          scrollSnapshot={scrollSnapshotRef.current}
          onScrollSnapshotChange={handleTableScrollSnapshotChange}
          isActive={isActive}
          enableSqlLogEvent
          initialViewMode={tab.initialViewMode}
          initialViewModeRequestId={tab.initialViewModeRequestId}
          onDataViewActivate={handleDataViewActivate}
      />
    </div>
  );
});

export default DataViewer;
