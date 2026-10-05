import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useStore } from '../../../store';
import {
  resolveWorkbenchMode,
  type SelectOption,
  type BatchTableExportMode,
  type BatchDatabaseExportMode,
  type BatchWorkbenchIntent,
  type BatchDestructiveOperation,
  renderSelectLabel,
  normalizeConnectionConfig,
  EMPTY_HISTORY,
  normalizeScopeOptions,
  resolveInitialScope,
  resolveTableExportColumnNames,
  toSortedSelectOptions,
} from '../tableExportWorkbenchOptions';
import {
  shouldIncludeDatabaseContextByDefault,
  resolveBatchWorkbenchObjects,
  resolveBatchTableModeMeta,
  resolveBatchDatabaseModeMeta,
} from '../tableExportWorkbenchModel';
import { getDataSourceCapabilities } from '../../../utils/dataSourceCapabilities';
import { getDataSourceSpec } from '../../../utils/dataSourceRegistry';
import { buildExportWorkbenchHistoryKey } from '../../../utils/tableExportTab';
import type { TableExportScope } from '../../../types';
import {
  type DataExportFormat,
  DEFAULT_DATA_EXPORT_FORMAT,
  DEFAULT_XLSX_ROWS_PER_SHEET,
} from '../../DataExportDialog';
import { useExportProgressRunner } from '../../useExportProgressRunner';
import { DBGetColumns, DBGetDatabases, DBGetTables } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { t } from '../../../i18n';
import { isDatabaseVisible, filterVisibleDatabaseNames } from '../../../utils/databaseVisibility';
import { loadViews } from '../../sidebar/sidebarMetadataLoaders';
import { resolveConnectionHostSummary } from '../../../utils/tabDisplay';
import type { TableExportWorkbenchBodyProps } from '../../TableExportWorkbench';

export interface UseTableExportStateInput {
  tab: TableExportWorkbenchBodyProps['tab'];
}

export const useTableExportState = ({ tab }: UseTableExportStateInput) => {
  const connections = useStore((state) => state.connections);
  const upsertTableExportHistory = useStore((state) => state.upsertTableExportHistory);
  const addTab = useStore((state) => state.addTab);
  const addSqlLog = useStore((state) => state.addSqlLog);
  const workbenchMode = resolveWorkbenchMode(tab);
  const isSingleWorkbench = workbenchMode === 'single';
  const isBatchTablesWorkbench = workbenchMode === 'batch-tables';
  const isBatchDatabasesWorkbench = workbenchMode === 'batch-databases';
  const isDirectDatabaseWorkbench = workbenchMode === 'database';
  const isDirectSchemaWorkbench = workbenchMode === 'schema';
  const isDirectSQLWorkbench = isDirectDatabaseWorkbench || isDirectSchemaWorkbench;
  const hasFixedConnection = isSingleWorkbench || isDirectSQLWorkbench;

  const [selectedConnectionId, setSelectedConnectionId] = useState(() => String(tab.connectionId || '').trim());
  const [selectedDbName, setSelectedDbName] = useState(() => String(tab.dbName || '').trim());
  const selectedDbNameRef = useRef(selectedDbName);
  selectedDbNameRef.current = selectedDbName;
  const [availableDatabases, setAvailableDatabases] = useState<SelectOption[]>([]);
  const [availableObjects, setAvailableObjects] = useState<SelectOption[]>([]);
  const [availableColumns, setAvailableColumns] = useState<string[]>([]);
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [selectedObjectNames, setSelectedObjectNames] = useState<string[]>(() => tab.tableExportInitialObjectNames || []);
  const [selectedDatabaseNames, setSelectedDatabaseNames] = useState<string[]>(() => tab.tableExportInitialDatabaseNames || []);
  const [batchTableMode, setBatchTableMode] = useState<BatchTableExportMode>(() => tab.tableExportContentMode || 'schema');
  const [batchDatabaseMode, setBatchDatabaseMode] = useState<BatchDatabaseExportMode>(() => (
    tab.tableExportContentMode === 'backup' ? 'backup' : 'schema'
  ));
  const [batchIntent, setBatchIntent] = useState<BatchWorkbenchIntent>('export');
  const [includeDropIfExists, setIncludeDropIfExists] = useState(tab.tableExportIncludeDropIfExists === true);
  const [includeDatabaseContext, setIncludeDatabaseContext] = useState(() => (
    shouldIncludeDatabaseContextByDefault(tab.tableExportContentMode === 'backup' ? 'backup' : 'schema')
  ));
  const [loadingDatabases, setLoadingDatabases] = useState(false);
  const [loadingObjects, setLoadingObjects] = useState(false);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [databaseLoadError, setDatabaseLoadError] = useState('');
  const [objectLoadError, setObjectLoadError] = useState('');
  const [columnLoadError, setColumnLoadError] = useState('');
  const [databaseReloadRevision, setDatabaseReloadRevision] = useState(0);
  const [objectReloadRevision, setObjectReloadRevision] = useState(0);
  const [columnReloadRevision, setColumnReloadRevision] = useState(0);
  const successfulColumnRequestKeyRef = useRef('');
  const [destructiveOperation, setDestructiveOperation] = useState<BatchDestructiveOperation | null>(null);
  const [appliedLaunchKey, setAppliedLaunchKey] = useState(() => (
    String(tab.tableExportRequestKey || tab.tableExportLaunchKey || '').trim()
  ));

  const syncBatchWorkbenchTabContext = useCallback((connectionId: string, dbName?: string) => {
    if (!isBatchTablesWorkbench && !isBatchDatabasesWorkbench) return;
    const nextConnectionId = String(connectionId || '').trim();
    const nextDbName = isBatchTablesWorkbench ? String(dbName || '').trim() : '';
    const currentConnectionId = String(tab.connectionId || '').trim();
    const currentDbName = isBatchTablesWorkbench ? String(tab.dbName || '').trim() : '';
    if (currentConnectionId === nextConnectionId && currentDbName === nextDbName) return;

    addTab({
      id: tab.id,
      title: tab.title,
      type: tab.type,
      exportWorkbenchMode: tab.exportWorkbenchMode,
      connectionId: nextConnectionId,
      dbName: nextDbName || undefined,
    });
  }, [addTab, isBatchDatabasesWorkbench, isBatchTablesWorkbench, tab.connectionId, tab.dbName, tab.exportWorkbenchMode, tab.id, tab.title, tab.type]);

  const effectiveConnectionId = hasFixedConnection ? String(tab.connectionId || '').trim() : selectedConnectionId;
  const effectiveDbName = hasFixedConnection ? String(tab.dbName || '').trim() : selectedDbName;
  const selectableConnections = useMemo(
    () => (isBatchTablesWorkbench || isBatchDatabasesWorkbench
      ? connections.filter((item) => getDataSourceCapabilities(item.config).supportsSqlQueryExport)
      : connections),
    [connections, isBatchDatabasesWorkbench, isBatchTablesWorkbench],
  );
  const connection = useMemo(
    () => selectableConnections.find((item) => item.id === effectiveConnectionId),
    [effectiveConnectionId, selectableConnections],
  );
  const connectionOptions = useMemo(
    () =>
      selectableConnections.map((item) => ({
        value: item.id,
        label: renderSelectLabel(item.name),
        title: item.name,
      })),
    [selectableConnections],
  );
  const connectionConfig = useMemo(
    () => (connection ? normalizeConnectionConfig(connection) : null),
    [connection],
  );
  // 写 USE / CREATE DATABASE 的选项：MySQL 与借用 MySQL 方言的描述表类型（TiDB、GBase 8a）。
  const supportsDatabaseContextOption = (() => {
    const type = String(connectionConfig?.type || '').trim().toLowerCase();
    return type === 'mysql' || getDataSourceSpec(type)?.ddlDialect === 'mysql';
  })();
  const connectionCapabilities = useMemo(
    () => getDataSourceCapabilities(connection?.config),
    [connection?.config],
  );
  const exportHistoryKey = useMemo(
    () => buildExportWorkbenchHistoryKey({
      connectionId: effectiveConnectionId,
      dbName: isBatchDatabasesWorkbench ? undefined : effectiveDbName,
      tableName: isSingleWorkbench ? tab.tableName : undefined,
      schemaName: tab.schemaName,
      exportWorkbenchMode: workbenchMode,
    }),
    [effectiveConnectionId, effectiveDbName, isBatchDatabasesWorkbench, isSingleWorkbench, tab.schemaName, tab.tableName, workbenchMode],
  );
  const history = useStore((state) => state.tableExportHistories[exportHistoryKey] || EMPTY_HISTORY);
  // Theme tokens only — flat surface, no floating white cards.
  const shellBg = 'var(--gn-bg-panel-2, var(--ant-color-bg-layout, transparent))';
  const dividerColor = 'var(--gn-br-1, var(--ant-color-border-secondary, rgba(15,23,42,0.08)))';
  const headingColor = 'var(--gn-fg-1, var(--ant-color-text, inherit))';
  const secondaryTextColor = 'var(--gn-fg-3, var(--ant-color-text-secondary, inherit))';
  const pillBg = 'var(--gn-bg-active, var(--ant-color-fill-tertiary, transparent))';

  const scopeOptions = useMemo(
    () => normalizeScopeOptions(tab.tableExportScopeOptions),
    [tab.tableExportScopeOptions],
  );
  const [scope, setScope] = useState<TableExportScope>(() => resolveInitialScope(scopeOptions, tab.tableExportInitialScope));
  const [format, setFormat] = useState<DataExportFormat>(DEFAULT_DATA_EXPORT_FORMAT);
  const [xlsxMaxRowsPerSheet, setXlsxMaxRowsPerSheet] = useState<number>(DEFAULT_XLSX_ROWS_PER_SHEET);
  useEffect(() => {
    // 非 SQL 数据源不提供 SQL 格式（从“备份 / 复制 INSERT”等入口带进来的 sql 格式改回默认格式）。
    if (format === 'sql' && connection && !connectionCapabilities.supportsSqlQueryExport) {
      setFormat(DEFAULT_DATA_EXPORT_FORMAT);
    }
  }, [connection, connectionCapabilities.supportsSqlQueryExport, format]);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const {
    state: progressState,
    logs: progressLogs,
    reset,
    cancelExport,
    runExportWithProgress,
    isRunning,
  } = useExportProgressRunner({
    taskKey: tab.id,
    requestKey: tab.tableExportRequestKey,
  });

  useEffect(() => {
    const launchKey = String(tab.tableExportRequestKey || tab.tableExportLaunchKey || '').trim();
    if (!launchKey || launchKey === appliedLaunchKey || isRunning) {
      return;
    }
    setSelectedConnectionId(String(tab.connectionId || '').trim());
    setSelectedDbName(String(tab.dbName || '').trim());
    setSelectedObjectNames(tab.tableExportInitialObjectNames || []);
    setSelectedDatabaseNames(tab.tableExportInitialDatabaseNames || []);
    setBatchTableMode(tab.tableExportContentMode || 'schema');
    const nextDatabaseMode = tab.tableExportContentMode === 'backup' ? 'backup' : 'schema';
    setBatchDatabaseMode(nextDatabaseMode);
    setIncludeDropIfExists(tab.tableExportIncludeDropIfExists === true);
    setIncludeDatabaseContext(shouldIncludeDatabaseContextByDefault(nextDatabaseMode));
    setAppliedLaunchKey(launchKey);
  }, [
    appliedLaunchKey,
    isRunning,
    tab.connectionId,
    tab.dbName,
    tab.tableExportContentMode,
    tab.tableExportIncludeDropIfExists,
    tab.tableExportInitialDatabaseNames,
    tab.tableExportInitialObjectNames,
    tab.tableExportLaunchKey,
    tab.tableExportRequestKey,
  ]);

  useEffect(() => {
    if (hasFixedConnection || selectableConnections.length === 0) {
      return;
    }
    if (selectableConnections.some((item) => item.id === selectedConnectionId)) {
      return;
    }
    setSelectedConnectionId(selectableConnections[0].id);
    setSelectedDbName('');
    setSelectedObjectNames([]);
    setSelectedDatabaseNames([]);
    syncBatchWorkbenchTabContext(selectableConnections[0].id);
  }, [hasFixedConnection, selectableConnections, selectedConnectionId, syncBatchWorkbenchTabContext]);

  useEffect(() => {
    setScope((prev) => {
      if (scopeOptions.some((item) => item.value === prev && !item.disabled)) {
        return prev;
      }
      return resolveInitialScope(scopeOptions, tab.tableExportInitialScope);
    });
  }, [scopeOptions, tab.tableExportInitialScope]);

  useEffect(() => {
    const objectName = String(tab.tableName || '').trim();
    if (!isSingleWorkbench || !connectionConfig || !objectName) {
      successfulColumnRequestKeyRef.current = '';
      setAvailableColumns([]);
      setSelectedColumns([]);
      setColumnLoadError('');
      setLoadingColumns(false);
      return undefined;
    }

    let alive = true;
    const requestKey = [effectiveConnectionId, effectiveDbName, objectName].join('\u0000');
    if (successfulColumnRequestKeyRef.current && successfulColumnRequestKeyRef.current !== requestKey) {
      successfulColumnRequestKeyRef.current = '';
      setAvailableColumns([]);
      setSelectedColumns([]);
    }
    setLoadingColumns(true);
    setColumnLoadError('');
    DBGetColumns(buildRpcConnectionConfig(connectionConfig) as any, effectiveDbName, objectName)
      .then((res) => {
        if (!alive) return;
        if (!res.success) {
          setAvailableColumns([]);
          setColumnLoadError(res.message || t('data_export.message.load_columns_failed'));
          return;
        }
        const nextColumns = resolveTableExportColumnNames(res.data);
        if (nextColumns.length === 0) {
          setAvailableColumns([]);
          setColumnLoadError(t('data_export.message.load_columns_failed'));
          return;
        }
        const availableNameSet = new Set(nextColumns);
        const preserveExistingSelection = successfulColumnRequestKeyRef.current === requestKey;
        setAvailableColumns(nextColumns);
        setSelectedColumns((prev) => (
          preserveExistingSelection
            ? prev.filter((name) => availableNameSet.has(name))
            : nextColumns
        ));
        successfulColumnRequestKeyRef.current = requestKey;
      })
      .catch((error: any) => {
        if (!alive) return;
        setAvailableColumns([]);
        setColumnLoadError(error?.message || t('data_export.message.load_columns_failed'));
      })
      .finally(() => {
        if (alive) setLoadingColumns(false);
      });

    return () => {
      alive = false;
    };
  }, [columnReloadRevision, connectionConfig, effectiveConnectionId, effectiveDbName, isSingleWorkbench, tab.tableName]);

  useEffect(() => {
    if (!progressState.startedAt || progressState.finishedAt > 0) return undefined;
    const timer = globalThis.setInterval(() => {
      setNowTick(Date.now());
    }, 1000);
    return () => {
      globalThis.clearInterval(timer);
    };
  }, [progressState.startedAt, progressState.finishedAt, isRunning]);

  useEffect(() => {
    if ((!isBatchTablesWorkbench && !isBatchDatabasesWorkbench) || !connectionConfig) {
      if (isBatchTablesWorkbench || isBatchDatabasesWorkbench) {
        setAvailableDatabases([]);
        setAvailableObjects([]);
        setSelectedObjectNames([]);
        setSelectedDatabaseNames([]);
        setDatabaseLoadError('');
        setObjectLoadError('');
      }
      return;
    }
    let alive = true;
    const requestedDbName = selectedDbNameRef.current;
    setAvailableDatabases([]);
    setLoadingDatabases(true);
    setDatabaseLoadError('');
    if (isBatchTablesWorkbench && requestedDbName && !isDatabaseVisible(connection, requestedDbName)) {
      setSelectedDbName('');
      setAvailableObjects([]);
      setSelectedObjectNames([]);
    } else if (isBatchDatabasesWorkbench) {
      setSelectedDatabaseNames((prev) => filterVisibleDatabaseNames(connection, prev));
    }
    DBGetDatabases(buildRpcConnectionConfig(connectionConfig) as any)
      .then((res) => {
        if (!alive) return;
        if (!res.success) {
          setAvailableDatabases([]);
          setDatabaseLoadError(res.message || t('data_export.message.load_databases_failed'));
          return;
        }
        const dbRows: any[] = Array.isArray(res.data) ? res.data : [];
        let nextOptions = dbRows
          .map((row) => String(row.Database || row.database || '').trim())
          .filter(Boolean);
        nextOptions = filterVisibleDatabaseNames(connection, nextOptions);
        const normalizedOptions = toSortedSelectOptions(nextOptions);
        setAvailableDatabases(normalizedOptions);
        if (isBatchTablesWorkbench) {
          const hasCurrentDb = normalizedOptions.some((item) => item.value === requestedDbName);
          if (!hasCurrentDb) {
            setSelectedDbName('');
            setAvailableObjects([]);
            setSelectedObjectNames([]);
          }
        } else {
          const availableNameSet = new Set(normalizedOptions.map((item) => item.value));
          setSelectedDatabaseNames((prev) => prev.filter((name) => availableNameSet.has(name)));
        }
      })
      .catch((error: any) => {
        if (!alive) return;
        setAvailableDatabases([]);
        setDatabaseLoadError(error?.message || t('data_export.message.load_databases_failed'));
      })
      .finally(() => {
        if (alive) {
          setLoadingDatabases(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [
    connection?.excludeDatabasePatterns,
    connection?.includeDatabasePatterns,
    connection?.includeDatabases,
    connectionConfig,
    databaseReloadRevision,
    isBatchDatabasesWorkbench,
    isBatchTablesWorkbench,
  ]);

  useEffect(() => {
    if (!isBatchTablesWorkbench || !connectionConfig || !selectedDbName) {
      if (isBatchTablesWorkbench) {
        setAvailableObjects([]);
        setSelectedObjectNames([]);
        setObjectLoadError('');
      }
      return;
    }
    let alive = true;
    setLoadingObjects(true);
    setObjectLoadError('');
    Promise.all([
      DBGetTables(buildRpcConnectionConfig(connectionConfig) as any, selectedDbName),
      loadViews(connection, selectedDbName).catch(() => ({ views: [], supported: false })),
    ])
      .then(([res, viewResult]) => {
        if (!alive) return;
        if (!res.success) {
          setAvailableObjects([]);
          setObjectLoadError(res.message || t('data_export.message.load_objects_failed'));
          return;
        }
        const nextOptions = resolveBatchWorkbenchObjects(
          res.data,
          Array.isArray(viewResult.views) ? viewResult.views : [],
        ).map((item) => ({
          value: item.name,
          label: renderSelectLabel(item.name),
          title: item.name,
          objectType: item.objectType,
        }));
        setAvailableObjects(nextOptions);
        const availableNameSet = new Set(nextOptions.map((item) => item.value));
        setSelectedObjectNames((prev) => prev.filter((name) => availableNameSet.has(name)));
      })
      .catch((error: any) => {
        if (!alive) return;
        setAvailableObjects([]);
        setObjectLoadError(error?.message || t('data_export.message.load_objects_failed'));
      })
      .finally(() => {
        if (alive) {
          setLoadingObjects(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [connection, connectionConfig, isBatchTablesWorkbench, objectReloadRevision, selectedDbName]);

  const hostSummary = useMemo(
    () => resolveConnectionHostSummary(connection?.config),
    [connection?.config],
  );
  const activeScopeOption = useMemo(
    () => scopeOptions.find((item) => item.value === scope),
    [scope, scopeOptions],
  );
  const activeScopeQuery = useMemo(
    () => String(tab.tableExportQueryByScope?.[scope] || '').trim(),
    [scope, tab.tableExportQueryByScope],
  );
  const singleScopeRowCount = useMemo(() => {
    const raw = tab.tableExportRowCountByScope?.[scope];
    return Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : undefined;
  }, [scope, tab.tableExportRowCountByScope]);
  const singleTotalRowsKnown = typeof singleScopeRowCount === 'number';
  const singleScopeLabel = activeScopeOption?.label || scope;
  const batchTableModeMeta = resolveBatchTableModeMeta(batchTableMode);
  const batchDatabaseModeMeta = resolveBatchDatabaseModeMeta(batchDatabaseMode);
  const isBatchWorkbench = isBatchTablesWorkbench || isBatchDatabasesWorkbench;
  const isBatchExportIntent = !isBatchWorkbench || batchIntent === 'export';
  const isBatchDeleteIntent = isBatchWorkbench && batchIntent === 'delete';
  const activeScopeLabel = isSingleWorkbench
    ? singleScopeLabel
    : isDirectSQLWorkbench
      ? (isDirectSchemaWorkbench ? String(tab.schemaName || '').trim() : t('data_export.label.database'))
    : isBatchTablesWorkbench
      ? t('data_export.workbench.scope.selected_objects', { count: selectedObjectNames.length })
      : t('data_export.workbench.scope.selected_databases', { count: selectedDatabaseNames.length });
  const activeScopeCount = isSingleWorkbench
    ? singleScopeRowCount
    : isDirectSQLWorkbench
      ? undefined
    : (isBatchTablesWorkbench ? selectedObjectNames.length : selectedDatabaseNames.length);
  const totalRowsKnown = isSingleWorkbench
    ? singleTotalRowsKnown
    : !isDirectSQLWorkbench;
  return {
    upsertTableExportHistory, addTab, addSqlLog, workbenchMode, isSingleWorkbench,
    isBatchTablesWorkbench, isBatchDatabasesWorkbench, isDirectDatabaseWorkbench,
    isDirectSchemaWorkbench, isDirectSQLWorkbench, selectedConnectionId, setSelectedConnectionId,
    selectedDbName, setSelectedDbName, availableDatabases, setAvailableDatabases, availableObjects,
    setAvailableObjects, availableColumns, selectedColumns, setSelectedColumns, selectedObjectNames,
    setSelectedObjectNames, selectedDatabaseNames, setSelectedDatabaseNames, batchTableMode,
    setBatchTableMode, batchDatabaseMode, setBatchDatabaseMode, batchIntent, setBatchIntent,
    includeDropIfExists, setIncludeDropIfExists, includeDatabaseContext, setIncludeDatabaseContext,
    loadingDatabases, loadingObjects, loadingColumns, databaseLoadError, setDatabaseLoadError,
    objectLoadError, setObjectLoadError, columnLoadError, setDatabaseReloadRevision,
    setObjectReloadRevision, setColumnReloadRevision, destructiveOperation, setDestructiveOperation,
    appliedLaunchKey, syncBatchWorkbenchTabContext, effectiveConnectionId, effectiveDbName,
    connection, connectionOptions, connectionConfig, supportsDatabaseContextOption,
    connectionCapabilities, exportHistoryKey, history, shellBg, dividerColor, headingColor,
    secondaryTextColor, pillBg, scopeOptions, scope, setScope, format, setFormat,
    xlsxMaxRowsPerSheet, setXlsxMaxRowsPerSheet, nowTick, progressState, progressLogs, reset,
    cancelExport, runExportWithProgress, isRunning, hostSummary, activeScopeOption,
    activeScopeQuery, singleScopeRowCount, singleTotalRowsKnown, batchTableModeMeta,
    batchDatabaseModeMeta, isBatchWorkbench, isBatchExportIntent, isBatchDeleteIntent,
    activeScopeLabel, activeScopeCount,
  };
};

export type TableExportStateApi = ReturnType<typeof useTableExportState>;
