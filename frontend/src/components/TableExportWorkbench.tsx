import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Empty, InputNumber, Segmented, Select, Tooltip, Typography, message } from 'antd';
import Modal from './common/ResizableDraggableModal';
import { ClockCircleOutlined, DeleteOutlined, ExportOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  ClearTables,
  DBGetColumns,
  DBGetDatabases,
  DBGetTables,
  DropDatabase,
  DropTable,
  TruncateTables,
  ExportDatabaseSQLWithOptions,
  ExportDatabasesSQLWithOptions,
  ExportQueryWithOptions,
  ExportSchemaSQLWithOptions,
  ExportTableWithOptions,
  ExportTablesSQLWithOptions,
} from '../../wailsjs/go/app/App';
import { useStore } from '../store';
import type {
  SavedConnection,
  TabData,
  TableExportHistoryEntry,
  TableExportScope,
  TableExportScopeOption,
} from '../types';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { filterVisibleDatabaseNames, isDatabaseVisible } from '../utils/databaseVisibility';
import { getDataSourceCapabilities } from '../utils/dataSourceCapabilities';
import { getColumnDefinitionName } from '../utils/columnDefinition';
import { resolveConnectionHostSummary } from '../utils/tabDisplay';
import { buildExportWorkbenchHistoryKey } from '../utils/tableExportTab';
import { normalizeTableNamesFromMetadataRows } from '../utils/tableMetadataRows';
import type { SidebarViewMetadataEntry } from '../utils/sidebarMetadata';
import { buildSQLFileExecutionWorkbenchTab } from '../utils/sqlFileExecutionTab';
import {
  formatExportElapsed,
  formatExportProgressRows,
  resolveExportElapsedMs,
  type ExportProgressStatus,
} from '../utils/exportProgress';
import { t } from '../i18n';
import { supportsTableTruncateAction } from './tableDataDangerActions';
import {
  DATA_EXPORT_FORMAT_OPTIONS,
  DEFAULT_DATA_EXPORT_FORMAT,
  DEFAULT_XLSX_ROWS_PER_SHEET,
  MAX_XLSX_ROWS_PER_SHEET,
  resolveDataExportColumns,
  type DataExportFormat,
} from './DataExportDialog';
import ExportProgressBar from './ExportProgressBar';
import { useExportProgressRunner } from './useExportProgressRunner';
import type { ExportProgressState } from './useExportProgressRunner';
import { loadViews } from './sidebar/sidebarMetadataLoaders';
import { confirmProductionMutation } from '../utils/productionRiskConfirm';

const { Text, Paragraph, Title } = Typography;
const EMPTY_HISTORY: TableExportHistoryEntry[] = [];
const createTableExportFormatOptions = (): Array<{ value: DataExportFormat; label: string }> => [
  ...DATA_EXPORT_FORMAT_OPTIONS,
  { value: 'sql', label: t('data_export.label.sql_file') },
];

type ExportWorkbenchMode = NonNullable<TabData['exportWorkbenchMode']>;
type BatchTableExportMode = 'schema' | 'dataOnly' | 'backup';
type BatchDatabaseExportMode = 'schema' | 'backup';
type BatchWorkbenchIntent = 'export' | 'delete';
type BatchDestructiveOperation = 'truncate-tables' | 'clear-tables' | 'delete-tables' | 'delete-databases';
type SelectOption = { value: string; label: React.ReactNode; title: string; objectType?: 'table' | 'view' };

export type BatchWorkbenchObject = {
  name: string;
  objectType: 'table' | 'view';
};

const createDefaultScopeOptions = (): TableExportScopeOption[] => [
  {
    value: 'all',
    label: t('data_export.workbench.scope.all.label'),
    description: t('data_export.workbench.scope.all.description'),
  },
];

const SELECT_ELLIPSIS_LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  width: '100%',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const createBatchTableExportModeOptions = (): Array<{ value: BatchTableExportMode; label: string; description: string }> => [
  {
    value: 'schema',
    label: t('data_export.workbench.batch_tables.mode.schema.label'),
    description: t('data_export.workbench.batch_tables.mode.schema.description'),
  },
  {
    value: 'dataOnly',
    label: t('data_export.workbench.batch_tables.mode.data_only.label'),
    description: t('data_export.workbench.batch_tables.mode.data_only.description'),
  },
  {
    value: 'backup',
    label: t('data_export.workbench.batch_tables.mode.backup.label'),
    description: t('data_export.workbench.batch_tables.mode.backup.description'),
  },
];

const createBatchDatabaseExportModeOptions = (): Array<{ value: BatchDatabaseExportMode; label: string; description: string }> => [
  {
    value: 'schema',
    label: t('data_export.workbench.batch_databases.mode.schema.label'),
    description: t('data_export.workbench.batch_databases.mode.schema.description'),
  },
  {
    value: 'backup',
    label: t('data_export.workbench.batch_databases.mode.backup.label'),
    description: t('data_export.workbench.batch_databases.mode.backup.description'),
  },
];

const normalizeScopeOptions = (input: TabData['tableExportScopeOptions']): TableExportScopeOption[] => {
  if (!Array.isArray(input) || input.length === 0) {
    return createDefaultScopeOptions();
  }
  return input;
};

const resolveInitialScope = (
  scopeOptions: TableExportScopeOption[],
  preferred?: TableExportScope,
): TableExportScope => {
  if (preferred && scopeOptions.some((item) => item.value === preferred && !item.disabled)) {
    return preferred;
  }
  return scopeOptions.find((item) => !item.disabled)?.value || 'all';
};

export const resolveTableExportColumnNames = (definitions: unknown): string[] => {
  if (!Array.isArray(definitions)) return [];
  const seen = new Set<string>();
  const columns: string[] = [];
  definitions.forEach((definition) => {
    const column = getColumnDefinitionName(definition);
    if (!column || seen.has(column)) return;
    seen.add(column);
    columns.push(column);
  });
  return columns;
};

const normalizeConnectionConfig = (connection: SavedConnection) => ({
  ...connection.config,
  port: Number(connection.config.port),
  password: connection.config.password || '',
  database: connection.config.database || '',
  useSSH: connection.config.useSSH || false,
  ssh: connection.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
});

const formatDateTime = (timestamp: number): string => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
};

const resolveWorkbenchMode = (tab: TabData): ExportWorkbenchMode => tab.exportWorkbenchMode || 'single';

const resolveObjectTypeLabel = (objectType?: TabData['objectType']): string => {
  if (objectType === 'view') return t('data_export.workbench.object_type.view');
  if (objectType === 'materialized-view') return t('data_export.workbench.object_type.materialized_view');
  return t('data_export.workbench.object_type.table');
};

const resolveStatusMeta = (status: ExportProgressStatus): { label: string; border: string; bg: string; text: string } => {
  const meta: Record<ExportProgressStatus, { label: string; border: string; bg: string; text: string }> = {
    idle: { label: t('data_export.progress.status.idle'), border: 'rgba(148, 163, 184, 0.35)', bg: 'rgba(148, 163, 184, 0.12)', text: '#475467' },
    start: { label: t('data_export.progress.status.start'), border: 'rgba(59, 130, 246, 0.3)', bg: 'rgba(59, 130, 246, 0.12)', text: '#1d4ed8' },
    running: { label: t('data_export.progress.status.running'), border: 'rgba(16, 185, 129, 0.3)', bg: 'rgba(16, 185, 129, 0.14)', text: '#047857' },
    finalizing: { label: t('data_export.progress.status.finalizing'), border: 'rgba(249, 115, 22, 0.3)', bg: 'rgba(249, 115, 22, 0.12)', text: '#c2410c' },
    done: { label: t('data_export.progress.status.done'), border: 'rgba(34, 197, 94, 0.3)', bg: 'rgba(34, 197, 94, 0.14)', text: '#15803d' },
    error: { label: t('data_export.progress.status.error'), border: 'rgba(239, 68, 68, 0.32)', bg: 'rgba(239, 68, 68, 0.12)', text: '#dc2626' },
  };
  return meta[status] || meta.idle;
};

const renderStatusPill = (status: ExportProgressStatus) => {
  const meta = resolveStatusMeta(status);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '4px 10px',
        borderRadius: 999,
        border: `1px solid ${meta.border}`,
        background: meta.bg,
        color: meta.text,
        fontSize: 12,
        lineHeight: 1.2,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {meta.label}
    </span>
  );
};

const renderSelectLabel = (text: string): React.ReactNode => (
  <span title={text} style={SELECT_ELLIPSIS_LABEL_STYLE}>
    {text}
  </span>
);

const toSortedSelectOptions = (values: string[]): SelectOption[] =>
  values
    .filter((value) => String(value || '').trim())
    .map((value) => ({
      value: String(value).trim(),
      label: renderSelectLabel(String(value).trim()),
      title: String(value).trim(),
    }))
    .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

export const resolveBatchWorkbenchObjects = (
  tableRows: unknown,
  views: SidebarViewMetadataEntry[],
): BatchWorkbenchObject[] => {
  const viewAliases = new Set<string>();
  views.forEach((view) => {
    const viewName = String(view.viewName || '').trim();
    const schemaName = String(view.schemaName || '').trim();
    if (!viewName) return;
    viewAliases.add(viewName);
    if (schemaName && !viewName.includes('.')) {
      viewAliases.add(`${schemaName}.${viewName}`);
    }
  });

  const seen = new Set<string>();
  const objects: BatchWorkbenchObject[] = [];
  normalizeTableNamesFromMetadataRows(tableRows).forEach((name) => {
    const normalizedName = String(name || '').trim();
    const key = normalizedName;
    if (!normalizedName || seen.has(key)) return;
    seen.add(key);
    objects.push({
      name: normalizedName,
      objectType: viewAliases.has(key) ? 'view' : 'table',
    });
  });

  views.forEach((view) => {
    const viewName = String(view.viewName || '').trim();
    const schemaName = String(view.schemaName || '').trim();
    if (!viewName) return;
    const qualifiedName = schemaName && !viewName.includes('.') ? `${schemaName}.${viewName}` : viewName;
    const existingName = [qualifiedName, viewName].find((name) => seen.has(name));
    if (existingName) return;
    const key = qualifiedName;
    seen.add(key);
    objects.push({ name: qualifiedName, objectType: 'view' });
  });

  return objects.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
};

const filterOptionByLabel = (input: string, option?: { title?: string; value?: string }) =>
  String(option?.title || option?.value || '').toLowerCase().includes(String(input || '').trim().toLowerCase());

const resolveBatchTableModeMeta = (mode: BatchTableExportMode) =>
  createBatchTableExportModeOptions().find((item) => item.value === mode) || createBatchTableExportModeOptions()[0];

const resolveBatchDatabaseModeMeta = (mode: BatchDatabaseExportMode) =>
  createBatchDatabaseExportModeOptions().find((item) => item.value === mode) || createBatchDatabaseExportModeOptions()[0];

const shouldIncludeDatabaseContextByDefault = (mode: BatchDatabaseExportMode): boolean => mode === 'backup';

const resolveBatchTablesTargetName = (dbName: string, objectCount: number): string => {
  const safeDbName = String(dbName || '').trim() || t('data_export.workbench.target.current_database');
  return t('data_export.workbench.target.batch_tables', { database: safeDbName, count: objectCount });
};

const resolveBatchDatabasesTargetName = (databaseCount: number): string => (
  t('data_export.workbench.target.batch_databases', { count: databaseCount })
);

const formatWorkbenchProgressSummary = (
  mode: ExportWorkbenchMode,
  current: number,
  total: number,
  totalRowsKnown: boolean,
): string => {
  if (mode === 'batch-tables') {
    if (!totalRowsKnown) return t('data_export.workbench.summary.batch_tables_running');
    return t('data_export.workbench.summary.batch_tables_done', {
      current: Math.min(current, total).toLocaleString(),
      total: total.toLocaleString(),
    });
  }
  if (mode === 'batch-databases') {
    if (!totalRowsKnown) return t('data_export.workbench.summary.batch_databases_running');
    return t('data_export.workbench.summary.batch_databases_done', {
      current: Math.min(current, total).toLocaleString(),
      total: total.toLocaleString(),
    });
  }
  return formatExportProgressRows(current, total, totalRowsKnown);
};

const resolveProgressHint = (mode: ExportWorkbenchMode, status: ExportProgressStatus, totalRowsKnown: boolean): string | null => {
  if (totalRowsKnown || status === 'done' || status === 'error') {
    return null;
  }
  if (mode === 'single') {
    return t('data_export.hint.rows_unknown');
  }
  return t('data_export.hint.batch_stage');
};

const resolveOutputLabel = (mode: ExportWorkbenchMode): string => (
  mode === 'batch-databases' ? t('data_export.label.directory') : t('data_export.label.file')
);

export const buildTableExportHistoryEntry = ({
  progressState,
  existingEntry,
  fallbackTargetName,
  fallbackFormat,
  scope,
  scopeLabel,
  strategyLabel,
}: {
  progressState: ExportProgressState;
  existingEntry?: TableExportHistoryEntry;
  fallbackTargetName: string;
  fallbackFormat: string;
  scope: string;
  scopeLabel: string;
  strategyLabel: string;
}): TableExportHistoryEntry => ({
  jobId: progressState.jobId,
  targetName: progressState.targetName || fallbackTargetName || t('data_export.progress.value.target_fallback'),
  startedAt: progressState.startedAt || existingEntry?.startedAt || 0,
  finishedAt: progressState.finishedAt || existingEntry?.finishedAt || 0,
  format: progressState.format || existingEntry?.format || fallbackFormat,
  scope,
  scopeLabel: existingEntry?.scopeLabel || scopeLabel,
  strategyLabel: existingEntry?.strategyLabel || strategyLabel,
  status: progressState.status as ExportProgressStatus,
  stage: progressState.stage,
  current: progressState.current,
  total: progressState.total,
  totalRowsKnown: progressState.totalRowsKnown,
  filePath: progressState.filePath,
  message: progressState.message,
});

const TableExportWorkbench: React.FC<{ tab: TabData }> = ({ tab }) => {
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
  const supportsDatabaseContextOption = String(connectionConfig?.type || '').trim().toLowerCase() === 'mysql';
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
  const [nowTick, setNowTick] = useState(() => Date.now());
  const {
    state: progressState,
    logs: progressLogs,
    reset,
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
  const exportStrategyLabel = isBatchDeleteIntent
    ? t('data_export.workbench.strategy.batch_delete')
    : isSingleWorkbench
    ? (scope === 'all' && !activeScopeQuery
      ? t('data_export.workbench.strategy.full_table')
      : t('data_export.workbench.strategy.query_replay'))
    : isDirectSQLWorkbench
      ? t('data_export.workbench.strategy.batch_databases', { mode: batchDatabaseModeMeta.label })
    : (isBatchTablesWorkbench
      ? t('data_export.workbench.strategy.batch_tables', { mode: batchTableModeMeta.label })
      : t('data_export.workbench.strategy.batch_databases', { mode: batchDatabaseModeMeta.label }));
  const currentElapsedMs = useMemo(
    () => resolveExportElapsedMs(progressState.startedAt, progressState.finishedAt, nowTick),
    [nowTick, progressState.finishedAt, progressState.startedAt],
  );

  const currentProgressHint = resolveProgressHint(workbenchMode, progressState.status, progressState.totalRowsKnown);
  const progressOutputLabel = resolveOutputLabel(workbenchMode);
  const fallbackTargetName = isSingleWorkbench
    ? (tab.tableName || t('data_export.progress.value.target_fallback'))
    : isDirectSQLWorkbench
      ? ([tab.dbName, isDirectSchemaWorkbench ? tab.schemaName : ''].filter(Boolean).join('.') || t('data_export.workbench.target.current_database'))
    : (isBatchTablesWorkbench ? resolveBatchTablesTargetName(selectedDbName, selectedObjectNames.length) : resolveBatchDatabasesTargetName(selectedDatabaseNames.length));
  const fallbackFormat = isSingleWorkbench ? String(format || '').toUpperCase() : 'SQL';

  useEffect(() => {
    const jobId = String(progressState.jobId || '').trim();
    if (
      !jobId
      || (progressState.status !== 'done' && progressState.status !== 'error')
    ) return;
    const existingEntry = history.find((item) => item.jobId === jobId);
    const entry = buildTableExportHistoryEntry({
      progressState,
      existingEntry,
      fallbackTargetName,
      fallbackFormat,
      scope: isSingleWorkbench ? scope : (isBatchTablesWorkbench ? 'selectedObjects' : 'selectedDatabases'),
      scopeLabel: activeScopeLabel,
      strategyLabel: exportStrategyLabel,
    });
    upsertTableExportHistory(exportHistoryKey, entry);
  }, [
    activeScopeLabel,
    exportHistoryKey,
    exportStrategyLabel,
    fallbackFormat,
    fallbackTargetName,
    history,
    isBatchDatabasesWorkbench,
    isBatchTablesWorkbench,
    isSingleWorkbench,
    progressState.current,
    progressState.filePath,
    progressState.finishedAt,
    progressState.format,
    progressState.jobId,
    progressState.message,
    progressState.stage,
    progressState.startedAt,
    progressState.status,
    progressState.targetName,
    progressState.total,
    progressState.totalRowsKnown,
    scope,
    upsertTableExportHistory,
  ]);

  const historyEntries = useMemo(
    () => history.filter((entry) => entry.jobId !== progressState.jobId),
    [history, progressState.jobId],
  );
  const currentHistoryEntry = useMemo(
    () => history.find((entry) => entry.jobId === progressState.jobId),
    [history, progressState.jobId],
  );
  const currentScopeLabel = currentHistoryEntry?.scopeLabel || activeScopeLabel;
  const currentStrategyLabel = currentHistoryEntry?.strategyLabel || exportStrategyLabel;
  const currentProgressSummary = formatWorkbenchProgressSummary(
    workbenchMode,
    progressState.current,
    progressState.total,
    progressState.totalRowsKnown,
  );
  const completedBackupFilePath = String(progressState.filePath || '').trim();
  const isSingleFileBackup = progressState.status === 'done'
    && completedBackupFilePath.toLowerCase().endsWith('.sql')
    && !isBatchDatabasesWorkbench
    && (
      (isSingleWorkbench && String(progressState.format || '').toLowerCase() === 'sql')
      || (isBatchTablesWorkbench && batchTableMode === 'backup')
      || (isDirectSQLWorkbench && batchDatabaseMode === 'backup')
    );

  const openBackupRestoreWorkbench = (filePath = completedBackupFilePath) => {
    const normalizedFilePath = String(filePath || '').trim();
    if (!normalizedFilePath.toLowerCase().endsWith('.sql') || !effectiveConnectionId) {
      return;
    }
    const pathParts = normalizedFilePath.split(/[\\/]/);
    addTab(buildSQLFileExecutionWorkbenchTab({
      connectionId: effectiveConnectionId,
      dbName: effectiveDbName || undefined,
      filePath: normalizedFilePath,
      fileName: pathParts[pathParts.length - 1] || undefined,
      autoStart: false,
    }));
  };

  const selectedTableNames = useMemo(() => {
    const selectedNameSet = new Set(selectedObjectNames);
    return availableObjects
      .filter((item) => item.objectType === 'table' && selectedNameSet.has(item.value))
      .map((item) => item.value);
  }, [availableObjects, selectedObjectNames]);
  const isConfigurationLocked = isRunning
    || destructiveOperation !== null
    || loadingDatabases
    || loadingObjects;
  const hasBatchTableMetadataError = Boolean(databaseLoadError || objectLoadError);
  const hasBatchDatabaseMetadataError = Boolean(databaseLoadError);
  const hasBlockingMetadataError = (isSingleWorkbench && !!columnLoadError)
    || (isBatchTablesWorkbench && hasBatchTableMetadataError)
    || (isBatchDatabasesWorkbench && hasBatchDatabaseMetadataError);

  const canStart = useMemo(() => {
    if (!connectionConfig || isConfigurationLocked || hasBlockingMetadataError) {
      return false;
    }
    if (isSingleWorkbench) {
      return !!tab.tableName
        && !!scope
        && !activeScopeOption?.disabled
        && !loadingColumns
        && selectedColumns.length > 0
        && (scope === 'all' || !!activeScopeQuery);
    }
    if (isBatchTablesWorkbench) {
      return !!selectedDbName && selectedObjectNames.length > 0;
    }
    if (isDirectSQLWorkbench) {
      return !!effectiveDbName && (!isDirectSchemaWorkbench || !!String(tab.schemaName || '').trim());
    }
    return selectedDatabaseNames.length > 0;
  }, [
    activeScopeOption?.disabled,
    activeScopeQuery,
    connectionConfig,
    effectiveDbName,
    hasBlockingMetadataError,
    isBatchTablesWorkbench,
    isDirectDatabaseWorkbench,
    isDirectSQLWorkbench,
    isDirectSchemaWorkbench,
    isConfigurationLocked,
    isSingleWorkbench,
    loadingColumns,
    scope,
    selectedDatabaseNames.length,
    selectedDbName,
    selectedColumns.length,
    selectedObjectNames.length,
    tab.tableName,
    tab.schemaName,
  ]);

  const confirmDestructiveAction = (options: {
    title: string;
    content: string;
    okText?: string;
  }): Promise<boolean> => new Promise((resolve) => {
    Modal.confirm({
      ...options,
      okText: options.okText || t('sidebar.action.delete'),
      okButtonProps: { danger: true },
      cancelText: t('sidebar.action.cancel'),
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });

  const runBatchTableDataAction = async (
    action: 'truncate' | 'clear',
  ) => {
    if (
      connectionCapabilities.forceReadOnlyQueryResult
      || !connectionConfig
      || !connection
      || !selectedDbName
      || !isDatabaseVisible(connection, selectedDbName)
      || selectedTableNames.length === 0
      || hasBatchTableMetadataError
      || isConfigurationLocked
    ) return;
    if (action === 'truncate' && !supportsTableTruncateAction(connectionConfig.type, connectionConfig.driver)) {
      return;
    }

    const isTruncate = action === 'truncate';
    const confirmed = await confirmDestructiveAction({
      title: isTruncate
        ? t('sidebar.modal.confirm_truncate_selected_tables.title')
        : t('sidebar.modal.confirm_clear_selected_tables.title'),
      content: isTruncate
        ? t('sidebar.modal.confirm_truncate_selected_tables.content', {
          connection: connection?.name || effectiveConnectionId,
          database: selectedDbName,
          count: selectedTableNames.length,
        })
        : t('sidebar.modal.confirm_clear_selected_tables.content', {
          connection: connection?.name || effectiveConnectionId,
          database: selectedDbName,
        }),
      okText: t('sidebar.action.continue'),
    });
    if (!confirmed) return;
    if (!await confirmProductionMutation(
      connection,
      t('connection.production_risk.action.execute_sql'),
      [selectedDbName, selectedTableNames.join(', ')].filter(Boolean).join(' / '),
      t,
    )) return;

    setDestructiveOperation(isTruncate ? 'truncate-tables' : 'clear-tables');
    const hide = message.loading(
      isTruncate
        ? t('sidebar.message.truncating_selected_tables', { count: selectedTableNames.length })
        : t('sidebar.message.clearing_selected_tables', { count: selectedTableNames.length }),
      0,
    );
    const startTime = Date.now();
    const method = isTruncate ? TruncateTables : ClearTables;
    const actionLabel = isTruncate ? 'Truncate' : 'Clear';
    try {
      const res = await method(
        buildRpcConnectionConfig(connectionConfig) as any,
        selectedDbName,
        selectedTableNames,
      );
      const duration = Date.now() - startTime;
      if (res.success) {
        message.success(
          isTruncate
            ? t('sidebar.message.truncate_selected_tables_success', { count: selectedTableNames.length })
            : t('sidebar.message.clear_success'),
        );
        const executedSQLs = Array.isArray((res.data as any)?.executedSQLs)
          ? (res.data as any).executedSQLs
          : [];
        addSqlLog({
          id: `batch-${isTruncate ? 'truncate' : 'clear'}-${Date.now()}`,
          timestamp: Date.now(),
          sql: executedSQLs.length > 0
            ? `/* ${actionLabel} Tables (${selectedTableNames.length} tables) */\n${executedSQLs.join(';\n')};`
            : `/* ${actionLabel} Tables (${selectedTableNames.length} tables) */\n${selectedTableNames.join('; ')}`,
          status: 'success',
          duration,
          message: res.message,
          dbName: selectedDbName,
          affectedRows: Number((res.data as any)?.count || 0),
        });
      } else if (res.message !== '已取消') {
        message.error(
          isTruncate
            ? t('sidebar.message.truncate_selected_tables_failed', { error: res.message })
            : t('sidebar.message.clear_failed', { error: res.message }),
        );
        addSqlLog({
          id: `batch-${isTruncate ? 'truncate' : 'clear'}-${Date.now()}`,
          timestamp: Date.now(),
          sql: `/* ${actionLabel} Tables (${selectedTableNames.length} tables) - FAILED */\n${selectedTableNames.join('; ')}`,
          status: 'error',
          duration,
          message: res.message,
          dbName: selectedDbName,
        });
      }
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorMessage = error?.message || String(error);
      message.error(
        isTruncate
          ? t('sidebar.message.truncate_selected_tables_failed', { error: errorMessage })
          : t('sidebar.message.clear_failed', { error: errorMessage }),
      );
      addSqlLog({
        id: `batch-${isTruncate ? 'truncate' : 'clear'}-${Date.now()}`,
        timestamp: Date.now(),
        sql: `/* ${actionLabel} Tables (${selectedTableNames.length} tables) - ERROR */\n${selectedTableNames.join('; ')}`,
        status: 'error',
        duration,
        message: errorMessage,
        dbName: selectedDbName,
      });
    } finally {
      hide();
      setDestructiveOperation(null);
    }
  };

  const handleTruncateSelectedTables = async () => {
    await runBatchTableDataAction('truncate');
  };

  const handleClearSelectedTables = async () => {
    await runBatchTableDataAction('clear');
  };

  const handleDeleteSelectedTables = async () => {
    if (
      connectionCapabilities.forceReadOnlyStructureDesigner
      || !connectionConfig
      || !connection
      || !selectedDbName
      || !isDatabaseVisible(connection, selectedDbName)
      || selectedTableNames.length === 0
      || hasBatchTableMetadataError
      || isConfigurationLocked
    ) return;
    const confirmed = await confirmDestructiveAction({
      title: t('sidebar.modal.confirm_delete_selected_tables.title'),
      content: t('sidebar.modal.confirm_delete_selected_tables.content', {
        connection: connection?.name || effectiveConnectionId,
        database: selectedDbName,
        count: selectedTableNames.length,
      }),
    });
    if (!confirmed) return;
    if (!await confirmProductionMutation(
      connection,
      t('connection.production_risk.action.execute_sql'),
      [selectedDbName, selectedTableNames.join(', ')].filter(Boolean).join(' / '),
      t,
    )) return;

    setDestructiveOperation('delete-tables');
    const hide = message.loading(t('sidebar.message.deleting_selected_tables', { count: selectedTableNames.length }), 0);
    const startTime = Date.now();
    const succeededNames: string[] = [];
    let failed: { table: string; error: string } | null = null;
    try {
      for (const tableName of selectedTableNames) {
        const res = await DropTable(
          buildRpcConnectionConfig(connectionConfig) as any,
          selectedDbName,
          tableName,
        );
        if (!res.success) {
          failed = { table: tableName, error: res.message || t('common.unknown') };
          break;
        }
        succeededNames.push(tableName);
      }
    } catch (error: any) {
      failed = {
        table: selectedTableNames[succeededNames.length] || selectedTableNames[0],
        error: error?.message || String(error),
      };
    } finally {
      hide();
      setDestructiveOperation(null);
    }

    if (succeededNames.length > 0) {
      const succeededNameSet = new Set(succeededNames);
      setAvailableObjects((prev) => prev.filter((item) => !succeededNameSet.has(item.value)));
      setSelectedObjectNames((prev) => prev.filter((name) => !succeededNameSet.has(name)));
    }
    const duration = Date.now() - startTime;
    addSqlLog({
      id: `batch-drop-tables-${Date.now()}`,
      timestamp: Date.now(),
      sql: `/* Drop Tables (${selectedTableNames.length} tables) */\n${selectedTableNames.map((name) => `DROP TABLE ${name}`).join(';\n')};`,
      status: failed ? 'error' : 'success',
      duration,
      message: failed?.error || t('sidebar.message.delete_tables_success', { count: succeededNames.length }),
      dbName: selectedDbName,
      affectedRows: succeededNames.length,
    });
    if (failed) {
      message.error(t('sidebar.message.delete_tables_failed', {
        table: failed.table,
        error: failed.error,
      }));
      return;
    }
    message.success(t('sidebar.message.delete_tables_success', { count: succeededNames.length }));
  };

  const handleDeleteSelectedDatabases = async () => {
    if (
      !connectionCapabilities.supportsDropDatabase
      || !connectionConfig
      || !connection
      || selectedDatabaseNames.length === 0
      || filterVisibleDatabaseNames(connection, selectedDatabaseNames).length !== selectedDatabaseNames.length
      || hasBatchDatabaseMetadataError
      || isConfigurationLocked
    ) return;
    const confirmed = await confirmDestructiveAction({
      title: t('sidebar.modal.confirm_delete_selected_databases.title'),
      content: t('sidebar.modal.confirm_delete_selected_databases.content', {
        connection: connection?.name || effectiveConnectionId,
        count: selectedDatabaseNames.length,
      }),
    });
    if (!confirmed) return;
    if (!await confirmProductionMutation(
      connection,
      t('connection.production_risk.action.execute_sql'),
      selectedDatabaseNames.join(', '),
      t,
    )) return;

    setDestructiveOperation('delete-databases');
    const hide = message.loading(t('sidebar.message.deleting_selected_databases', { count: selectedDatabaseNames.length }), 0);
    const startTime = Date.now();
    const succeededNames: string[] = [];
    let failed: { database: string; error: string } | null = null;
    try {
      for (const databaseName of selectedDatabaseNames) {
        const res = await DropDatabase(buildRpcConnectionConfig(connectionConfig) as any, databaseName);
        if (!res.success) {
          failed = { database: databaseName, error: res.message || t('common.unknown') };
          break;
        }
        succeededNames.push(databaseName);
      }
    } catch (error: any) {
      failed = {
        database: selectedDatabaseNames[succeededNames.length] || selectedDatabaseNames[0],
        error: error?.message || String(error),
      };
    } finally {
      hide();
      setDestructiveOperation(null);
    }

    if (succeededNames.length > 0) {
      const succeededNameSet = new Set(succeededNames);
      setAvailableDatabases((prev) => prev.filter((item) => !succeededNameSet.has(item.value)));
      setSelectedDatabaseNames((prev) => prev.filter((name) => !succeededNameSet.has(name)));
    }
    const duration = Date.now() - startTime;
    addSqlLog({
      id: `batch-drop-databases-${Date.now()}`,
      timestamp: Date.now(),
      sql: `/* Drop Databases (${selectedDatabaseNames.length} databases) */\n${selectedDatabaseNames.map((name) => `DROP DATABASE ${name}`).join(';\n')};`,
      status: failed ? 'error' : 'success',
      duration,
      message: failed?.error || t('sidebar.message.delete_databases_success', { count: succeededNames.length }),
      affectedRows: succeededNames.length,
    });
    if (failed) {
      message.error(t('sidebar.message.delete_databases_failed', {
        database: failed.database,
        error: failed.error,
      }));
      return;
    }
    message.success(t('sidebar.message.delete_databases_success', { count: succeededNames.length }));
  };

  const handleStartSingleExport = async () => {
    if (!connectionConfig || !!columnLoadError || loadingColumns || selectedColumns.length === 0) {
      return;
    }
    const objectName = String(tab.tableName || '').trim();
    if (!objectName) {
      return;
    }
    await runExportWithProgress({
      title: tab.title || t('data_export.workbench.task.export_target', { name: objectName }),
      targetName: objectName,
      format,
      totalRows: singleScopeRowCount,
      run: (jobId) => {
        const options = {
          format,
          columns: selectedColumns,
          xlsxMaxRowsPerSheet,
          insertSQLTargetTable: format === 'sql' ? objectName : undefined,
          jobId,
          totalRowsHint: singleTotalRowsKnown ? singleScopeRowCount : 0,
          totalRowsKnown: singleTotalRowsKnown,
          includeDropIfExists: false,
        };
        if (scope !== 'all' && activeScopeQuery) {
          return ExportQueryWithOptions(
            buildRpcConnectionConfig(connectionConfig) as any,
            tab.dbName || '',
            activeScopeQuery,
            objectName,
            options as any,
          );
        }
        if (scope === 'all' && activeScopeQuery) {
          return ExportQueryWithOptions(
            buildRpcConnectionConfig(connectionConfig) as any,
            tab.dbName || '',
            activeScopeQuery,
            objectName,
            options as any,
          );
        }
        return ExportTableWithOptions(
          buildRpcConnectionConfig(connectionConfig) as any,
          tab.dbName || '',
          objectName,
          {
            ...options,
            includeDropIfExists: format === 'sql' && !activeScopeQuery && includeDropIfExists,
          } as any,
        );
      },
    });
  };

  const handleStartBatchTablesExport = async () => {
    if (
      !connectionConfig
      || !connection
      || !selectedDbName
      || !isDatabaseVisible(connection, selectedDbName)
      || selectedObjectNames.length === 0
      || loadingDatabases
      || loadingObjects
      || hasBatchTableMetadataError
    ) {
      return;
    }
    const includeSchema = batchTableMode !== 'dataOnly';
    const includeData = batchTableMode !== 'schema';
    await runExportWithProgress({
      title: `${batchTableModeMeta.label} · ${selectedDbName}`,
      targetName: resolveBatchTablesTargetName(selectedDbName, selectedObjectNames.length),
      format: 'sql',
      totalRows: selectedObjectNames.length,
      run: (jobId) =>
        ExportTablesSQLWithOptions(
          buildRpcConnectionConfig(connectionConfig) as any,
          selectedDbName,
          selectedObjectNames,
          includeSchema,
          includeData,
          {
            format: 'sql',
            jobId,
            totalRowsHint: selectedObjectNames.length,
            totalRowsKnown: true,
            includeDropIfExists: includeSchema && includeDropIfExists,
          } as any,
        ),
    });
  };

  const handleStartBatchDatabasesExport = async () => {
    if (
      !connectionConfig
      || !connection
      || selectedDatabaseNames.length === 0
      || filterVisibleDatabaseNames(connection, selectedDatabaseNames).length !== selectedDatabaseNames.length
      || loadingDatabases
      || hasBatchDatabaseMetadataError
    ) {
      return;
    }
    const includeData = batchDatabaseMode === 'backup';
    await runExportWithProgress({
      title: batchDatabaseModeMeta.label,
      targetName: resolveBatchDatabasesTargetName(selectedDatabaseNames.length),
      format: 'sql',
      totalRows: selectedDatabaseNames.length,
      run: (jobId) =>
        ExportDatabasesSQLWithOptions(
          buildRpcConnectionConfig(connectionConfig) as any,
          selectedDatabaseNames,
          includeData,
          {
            format: 'sql',
            jobId,
            totalRowsHint: selectedDatabaseNames.length,
            totalRowsKnown: true,
            includeDropIfExists,
            includeDatabaseContext,
          } as any,
        ),
    });
  };

  const handleStartDirectDatabaseExport = async () => {
    if (!connectionConfig || !effectiveDbName) {
      return;
    }
    const includeData = batchDatabaseMode === 'backup';
    await runExportWithProgress({
      title: tab.title || t('data_export.workbench.task.export_target', { name: effectiveDbName }),
      targetName: effectiveDbName,
      format: 'sql',
      run: (jobId) => ExportDatabaseSQLWithOptions(
        buildRpcConnectionConfig(connectionConfig) as any,
        effectiveDbName,
        includeData,
        {
          format: 'sql',
          jobId,
          totalRowsHint: 0,
          totalRowsKnown: false,
          includeDropIfExists,
          includeDatabaseContext,
        } as any,
      ),
    });
  };

  const handleStartDirectSchemaExport = async () => {
    const schemaName = String(tab.schemaName || '').trim();
    if (!connectionConfig || !effectiveDbName || !schemaName) {
      return;
    }
    const includeData = batchDatabaseMode === 'backup';
    await runExportWithProgress({
      title: tab.title || t('data_export.workbench.task.export_target', { name: `${effectiveDbName}.${schemaName}` }),
      targetName: `${effectiveDbName}.${schemaName}`,
      format: 'sql',
      run: (jobId) => ExportSchemaSQLWithOptions(
        buildRpcConnectionConfig(connectionConfig, { database: effectiveDbName }) as any,
        effectiveDbName,
        schemaName,
        includeData,
        {
          format: 'sql',
          jobId,
          totalRowsHint: 0,
          totalRowsKnown: false,
          includeDropIfExists,
        } as any,
      ),
    });
  };

  const handleStartExport = async () => {
    if (isSingleWorkbench) {
      await handleStartSingleExport();
      return;
    }
    if (isBatchTablesWorkbench) {
      await handleStartBatchTablesExport();
      return;
    }
    if (isDirectDatabaseWorkbench) {
      await handleStartDirectDatabaseExport();
      return;
    }
    if (isDirectSchemaWorkbench) {
      await handleStartDirectSchemaExport();
      return;
    }
    await handleStartBatchDatabasesExport();
  };

  const lastAutoStartRequestKeyRef = useRef('');
  useEffect(() => {
    const requestKey = String(tab.tableExportRequestKey || '').trim();
    if (
      !requestKey
      || requestKey !== appliedLaunchKey
      || requestKey === lastAutoStartRequestKeyRef.current
      || requestKey === String(progressState.requestKey || '').trim()
      || !canStart
      || isRunning
    ) {
      return;
    }
    lastAutoStartRequestKeyRef.current = requestKey;
    void handleStartExport();
  }, [appliedLaunchKey, canStart, isRunning, progressState.requestKey, tab.tableExportRequestKey]);

  const headerBadges = useMemo(() => {
    if (isSingleWorkbench) {
      return [
        `${resolveObjectTypeLabel(tab.objectType)} · ${tab.tableName || '-'}`,
        `${t('data_export.label.database')} · ${tab.dbName || '-'}`,
        `${t('data_export.label.connection')} · ${connection?.name || '-'}`,
        `${t('data_export.label.host')} · ${hostSummary || '-'}`,
      ];
    }
    if (isBatchTablesWorkbench) {
      return [
        `${t('data_export.label.mode')} · ${t('data_export.workbench.mode.batch_tables')}`,
        `${t('data_export.label.database')} · ${selectedDbName || '-'}`,
        `${t('data_export.label.connection')} · ${connection?.name || '-'}`,
        `${t('data_export.label.object_count')} · ${selectedObjectNames.length}`,
        `${t('data_export.label.host')} · ${hostSummary || '-'}`,
      ];
    }
    if (isDirectSQLWorkbench) {
      return [
        `${t('data_export.label.database')} · ${effectiveDbName || '-'}`,
        ...(isDirectSchemaWorkbench ? [`${t('data_export.label.schema')} · ${tab.schemaName || '-'}`] : []),
        `${t('data_export.label.connection')} · ${connection?.name || '-'}`,
        `${t('data_export.label.host')} · ${hostSummary || '-'}`,
      ];
    }
    return [
      `${t('data_export.label.mode')} · ${t('data_export.workbench.mode.batch_databases')}`,
      `${t('data_export.label.connection')} · ${connection?.name || '-'}`,
      `${t('data_export.label.selected_databases')} · ${selectedDatabaseNames.length}`,
      `${t('data_export.label.host')} · ${hostSummary || '-'}`,
    ];
  }, [
    connection?.name,
    effectiveDbName,
    hostSummary,
    isBatchTablesWorkbench,
    isDirectDatabaseWorkbench,
    isDirectSQLWorkbench,
    isDirectSchemaWorkbench,
    isSingleWorkbench,
    selectedDatabaseNames.length,
    selectedDbName,
    selectedObjectNames.length,
    tab.dbName,
    tab.objectType,
    tab.schemaName,
    tab.tableName,
  ]);

  return (
    <div
      data-export-workbench="true"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: shellBg }}
    >
      <div
        style={{
          padding: '16px 20px 14px',
          borderBottom: `0.5px solid ${dividerColor}`,
          background: 'transparent',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <Title level={4} style={{ margin: 0, color: headingColor }}>
            {isBatchTablesWorkbench
              ? t('sidebar.action.batch_tables')
              : isBatchDatabasesWorkbench
                ? t('sidebar.action.batch_databases')
                : t('data_export.workbench.title')}
          </Title>
          <div style={{ marginTop: 6, color: secondaryTextColor, fontSize: 13 }}>
            {isBatchTablesWorkbench
              ? (isBatchDeleteIntent
                ? t('data_export.workbench.intent.batch_tables_delete_description')
                : t('sidebar.modal.batch_tables.description'))
              : isBatchDatabasesWorkbench
                ? (isBatchDeleteIntent
                  ? t('data_export.workbench.intent.batch_databases_delete_description')
                  : t('sidebar.modal.batch_databases.description'))
                : t('data_export.workbench.subtitle')}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {headerBadges.map((label) => (
            <span
              key={label}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '6px 10px',
                borderRadius: 999,
                background: pillBg,
                color: headingColor,
                fontSize: 12,
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </span>
          ))}
        </div>
      </div>

      <div
        data-export-workbench-layout="true"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(280px, 340px) minmax(0, 1fr)',
          gap: 0,
          alignItems: 'start',
        }}
      >
        <section
          data-export-workbench-config="true"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            minHeight: 0,
            maxHeight: '100%',
            overflow: 'auto',
            padding: '16px 18px 20px',
            borderRadius: 0,
            background: 'transparent',
            border: 'none',
            borderRight: `0.5px solid ${dividerColor}`,
            pointerEvents: isConfigurationLocked ? 'none' : 'auto',
            opacity: isConfigurationLocked ? 0.78 : 1,
          }}
          aria-disabled={isConfigurationLocked}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: headingColor, marginBottom: 10 }}>{t('data_export.workbench.section.config')}</div>
            {isBatchWorkbench ? (
              <div data-batch-intent-switch="true" style={{ marginBottom: 14 }}>
                <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>
                  {t('data_export.workbench.intent.label')}
                </div>
                <Segmented
                  block
                  value={batchIntent}
                  disabled={isConfigurationLocked}
                  options={[
                    { label: t('data_export.workbench.intent.export'), value: 'export' },
                    { label: t('data_export.workbench.intent.delete'), value: 'delete' },
                  ]}
                  onChange={(value) => setBatchIntent(value as BatchWorkbenchIntent)}
                />
              </div>
            ) : null}
            {isSingleWorkbench ? (
              <div style={{ display: 'grid', gridTemplateColumns: '84px minmax(0, 1fr)', rowGap: 10, columnGap: 12 }}>
                <Text type="secondary">{t('data_export.label.object')}</Text>
                <Text>{tab.tableName || '-'}</Text>

                <Text type="secondary">{t('data_export.label.type')}</Text>
                <Text>{resolveObjectTypeLabel(tab.objectType)}</Text>

                <Text type="secondary">{t('data_export.label.connection')}</Text>
                <Text>{connection?.name || '-'}</Text>

                <Text type="secondary">{t('data_export.label.database')}</Text>
                <Text>{tab.dbName || '-'}</Text>

                <Text type="secondary">{t('data_export.label.host')}</Text>
                <Text>{hostSummary || '-'}</Text>
              </div>
            ) : isDirectSQLWorkbench ? (
              <div style={{ display: 'grid', gridTemplateColumns: '84px minmax(0, 1fr)', rowGap: 10, columnGap: 12 }}>
                <Text type="secondary">{t('data_export.label.mode')}</Text>
                <Text>{batchDatabaseModeMeta.label}</Text>

                <Text type="secondary">{t('data_export.label.connection')}</Text>
                <Text>{connection?.name || '-'}</Text>

                <Text type="secondary">{t('data_export.label.database')}</Text>
                <Text>{effectiveDbName || '-'}</Text>

                {isDirectSchemaWorkbench ? (
                  <>
                    <Text type="secondary">{t('data_export.label.schema')}</Text>
                    <Text>{tab.schemaName || '-'}</Text>
                  </>
                ) : null}

                <Text type="secondary">{t('data_export.label.host')}</Text>
                <Text>{hostSummary || '-'}</Text>
              </div>
            ) : isBatchTablesWorkbench ? (
              <div style={{ display: 'grid', gridTemplateColumns: '84px minmax(0, 1fr)', rowGap: 10, columnGap: 12 }}>
                <Text type="secondary">{t('data_export.label.mode')}</Text>
                <Text>{t('data_export.workbench.mode.batch_tables')}</Text>

                <Text type="secondary">{t('data_export.label.connection')}</Text>
                <Text>{connection?.name || '-'}</Text>

                <Text type="secondary">{t('data_export.label.database')}</Text>
                <Text>{selectedDbName || '-'}</Text>

                <Text type="secondary">{t('data_export.label.object_count')}</Text>
                <Text>{selectedObjectNames.length}</Text>

                <Text type="secondary">{t('data_export.label.host')}</Text>
                <Text>{hostSummary || '-'}</Text>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '84px minmax(0, 1fr)', rowGap: 10, columnGap: 12 }}>
                <Text type="secondary">{t('data_export.label.mode')}</Text>
                <Text>{t('data_export.workbench.mode.batch_databases')}</Text>

                <Text type="secondary">{t('data_export.label.connection')}</Text>
                <Text>{connection?.name || '-'}</Text>

                <Text type="secondary">{t('data_export.label.selected_databases')}</Text>
                <Text>{selectedDatabaseNames.length}</Text>

                <Text type="secondary">{t('data_export.label.host')}</Text>
                <Text>{hostSummary || '-'}</Text>
              </div>
            )}
          </div>

          {!connectionConfig ? (
            <Alert
              type="warning"
              showIcon
              message={t('data_export.workbench.alert.connection_missing_title')}
              description={t('data_export.workbench.alert.connection_missing_description')}
            />
          ) : null}

          {databaseLoadError ? (
            <Alert
              type="error"
              showIcon
              message={t('data_export.workbench.alert.database_load_failed')}
              description={databaseLoadError}
              action={(
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  data-export-retry-databases="true"
                  disabled={isRunning || destructiveOperation !== null || loadingDatabases}
                  loading={loadingDatabases}
                  onClick={() => setDatabaseReloadRevision((current) => current + 1)}
                >
                  {t('common.retry')}
                </Button>
              )}
            />
          ) : null}

          {objectLoadError ? (
            <Alert
              type="error"
              showIcon
              message={t('data_export.workbench.alert.object_load_failed')}
              description={objectLoadError}
              action={(
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  data-export-retry-objects="true"
                  disabled={isRunning || destructiveOperation !== null || loadingObjects}
                  loading={loadingObjects}
                  onClick={() => setObjectReloadRevision((current) => current + 1)}
                >
                  {t('common.retry')}
                </Button>
              )}
            />
          ) : null}

          {columnLoadError ? (
            <Alert
              type="error"
              showIcon
              message={t('data_export.dialog.field.columns')}
              description={columnLoadError}
              action={(
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  data-export-retry-columns="true"
                  disabled={isRunning || loadingColumns}
                  loading={loadingColumns}
                  onClick={() => setColumnReloadRevision((current) => current + 1)}
                >
                  {t('common.retry')}
                </Button>
              )}
            />
          ) : null}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {isSingleWorkbench ? (
              <>
                <div>
                  <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.export_scope')}</div>
                  <Select
                    style={{ width: '100%' }}
                    value={scope}
                    disabled={isConfigurationLocked}
                    options={scopeOptions.map((item) => ({
                      value: item.value,
                      label: item.label,
                      disabled: item.disabled,
                    }))}
                    onChange={(next) => setScope(next as TableExportScope)}
                  />
                  {activeScopeOption?.description ? (
                    <div style={{ marginTop: 6, fontSize: 12, color: secondaryTextColor }}>
                      {activeScopeOption.description}
                    </div>
                  ) : null}
                </div>

                <div>
                  <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.format')}</div>
                  <Select
                    style={{ width: '100%' }}
                    value={format}
                    disabled={isConfigurationLocked}
                    options={createTableExportFormatOptions()}
                    onChange={(next) => setFormat(next as DataExportFormat)}
                  />
                </div>

                {format === 'sql' && !activeScopeQuery ? (
                  <div>
                    <Checkbox
                      checked={includeDropIfExists}
                      disabled={isConfigurationLocked}
                      onChange={(event) => setIncludeDropIfExists(event.target.checked)}
                    >
                      {t('data_export.sql_options.drop_if_exists.label')}
                    </Checkbox>
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginTop: 8 }}
                      message={t('data_export.sql_options.drop_if_exists.description')}
                    />
                  </div>
                ) : null}

                {format !== 'sql' || activeScopeQuery ? (
                  <div>
                    <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.dialog.field.columns')}</div>
                    <Select
                      style={{ width: '100%' }}
                      mode="multiple"
                      value={selectedColumns}
                      loading={loadingColumns}
                      disabled={isConfigurationLocked}
                      options={availableColumns.map((column) => ({ value: column, label: column }))}
                      maxTagCount="responsive"
                      onChange={(columns) => setSelectedColumns(
                        resolveDataExportColumns(columns, availableColumns) || [],
                      )}
                    />
                    <div style={{ marginTop: 6, fontSize: 12, color: secondaryTextColor }}>
                      {t('data_export.dialog.field.columns_help')}
                    </div>
                  </div>
                ) : null}

                {format === 'xlsx' ? (
                  <div>
                    <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.xlsx_max_rows')}</div>
                    <InputNumber
                      min={1}
                      max={MAX_XLSX_ROWS_PER_SHEET}
                      step={100000}
                      value={xlsxMaxRowsPerSheet}
                      disabled={isConfigurationLocked}
                      style={{ width: '100%' }}
                      onChange={(value) => {
                        const next = Number(value);
                        setXlsxMaxRowsPerSheet(
                          Number.isFinite(next) && next > 0
                            ? Math.min(MAX_XLSX_ROWS_PER_SHEET, Math.trunc(next))
                            : DEFAULT_XLSX_ROWS_PER_SHEET,
                        );
                      }}
                    />
                    <div style={{ marginTop: 6, fontSize: 12, color: secondaryTextColor }}>
                      {t('data_export.dialog.field.xlsx_max_rows_help', {
                        maxRows: MAX_XLSX_ROWS_PER_SHEET.toLocaleString(),
                      })}
                    </div>
                  </div>
                ) : null}
              </>
            ) : isDirectSQLWorkbench ? (
              <>
                <div>
                  <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.export_content')}</div>
                  <Select
                    style={{ width: '100%' }}
                    value={batchDatabaseMode}
                    disabled={isConfigurationLocked}
                    options={createBatchDatabaseExportModeOptions().map((item) => ({ value: item.value, label: item.label }))}
                    onChange={(next) => {
                      const nextMode = next as BatchDatabaseExportMode;
                      setBatchDatabaseMode(nextMode);
                      setIncludeDatabaseContext(shouldIncludeDatabaseContextByDefault(nextMode));
                    }}
                  />
                  <div style={{ marginTop: 6, fontSize: 12, color: secondaryTextColor }}>
                    {batchDatabaseModeMeta.description}
                  </div>
                </div>

                {isDirectDatabaseWorkbench && supportsDatabaseContextOption ? (
                  <div>
                    <Checkbox
                      data-export-include-database-context="true"
                      checked={includeDatabaseContext}
                      disabled={isConfigurationLocked}
                      onChange={(event) => setIncludeDatabaseContext(event.target.checked)}
                    >
                      {t('data_export.sql_options.database_context.label')}
                    </Checkbox>
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginTop: 8 }}
                      message={t('data_export.sql_options.database_context.description')}
                    />
                  </div>
                ) : null}

                <div>
                  <Checkbox
                    checked={includeDropIfExists}
                    disabled={isConfigurationLocked}
                    onChange={(event) => setIncludeDropIfExists(event.target.checked)}
                  >
                    {t('data_export.sql_options.drop_if_exists.label')}
                  </Checkbox>
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginTop: 8 }}
                    message={t('data_export.sql_options.drop_if_exists.description')}
                  />
                </div>

                <div>
                  <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.format')}</div>
                  <Select
                    style={{ width: '100%' }}
                    value="sql"
                    disabled
                    options={[{ value: 'sql', label: t('data_export.label.sql_file') }]}
                  />
                </div>
              </>
            ) : isBatchTablesWorkbench ? (
              <>
                <div>
                  <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.connection')}</div>
                  <Tooltip title={connection?.name || undefined}>
                    <div>
                      <Select
                        style={{ width: '100%' }}
                        value={selectedConnectionId || undefined}
                        disabled={isConfigurationLocked}
                        placeholder={t('data_export.workbench.placeholder.select_connection')}
                        options={connectionOptions}
                        showSearch
                        optionFilterProp="title"
                        filterOption={filterOptionByLabel as any}
                        onChange={(next) => {
                          const nextConnectionId = String(next || '').trim();
                          setSelectedConnectionId(nextConnectionId);
                          setSelectedDbName('');
                          setSelectedObjectNames([]);
                          setAvailableObjects([]);
                          setObjectLoadError('');
                          syncBatchWorkbenchTabContext(nextConnectionId);
                        }}
                      />
                    </div>
                  </Tooltip>
                </div>

                <div>
                  <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.database')}</div>
                  <Tooltip title={selectedDbName || undefined}>
                    <div>
                      <Select
                        style={{ width: '100%' }}
                        value={selectedDbName || undefined}
                        disabled={isConfigurationLocked}
                        placeholder={loadingDatabases
                          ? t('data_export.workbench.placeholder.loading_databases')
                          : t('data_export.workbench.placeholder.select_database')}
                        loading={loadingDatabases}
                        options={availableDatabases}
                        showSearch
                        optionFilterProp="title"
                        filterOption={filterOptionByLabel as any}
                        onChange={(next) => {
                          const nextDbName = String(next || '').trim();
                          setSelectedDbName(nextDbName);
                          setSelectedObjectNames([]);
                          setObjectLoadError('');
                          syncBatchWorkbenchTabContext(selectedConnectionId, nextDbName);
                        }}
                      />
                    </div>
                  </Tooltip>
                </div>

                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                    <div style={{ fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.object')}</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button
                        size="small"
                        type="text"
                        disabled={isConfigurationLocked || availableObjects.length === 0}
                        onClick={() => setSelectedObjectNames(availableObjects.map((item) => item.value))}
                      >
                        {t('data_export.action.select_all')}
                      </Button>
                      <Button
                        size="small"
                        type="text"
                        disabled={isConfigurationLocked || selectedObjectNames.length === 0}
                        onClick={() => setSelectedObjectNames([])}
                      >
                        {t('data_export.action.clear')}
                      </Button>
                    </div>
                  </div>
                  <Select
                    style={{ width: '100%' }}
                    mode="multiple"
                    value={selectedObjectNames}
                    placeholder={selectedDbName
                      ? (loadingObjects
                        ? t('data_export.workbench.placeholder.loading_objects')
                        : t('data_export.workbench.placeholder.select_object'))
                      : t('data_export.workbench.placeholder.select_database_first')}
                    loading={loadingObjects}
                    options={availableObjects}
                    disabled={isConfigurationLocked || !selectedDbName}
                    showSearch
                    optionFilterProp="title"
                    filterOption={filterOptionByLabel as any}
                    maxTagCount="responsive"
                    onChange={(next) => setSelectedObjectNames((next as string[]).map((item) => String(item).trim()).filter(Boolean))}
                  />
                  <div style={{ marginTop: 6, fontSize: 12, color: secondaryTextColor }}>
                    {t('data_export.workbench.helper.available_objects', {
                      available: availableObjects.length,
                      selected: selectedObjectNames.length,
                    })}
                  </div>
                </div>

                {isBatchExportIntent ? (
                  <>
                    <div>
                      <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.export_content')}</div>
                      <Select
                        style={{ width: '100%' }}
                        value={batchTableMode}
                        disabled={isConfigurationLocked}
                        options={createBatchTableExportModeOptions().map((item) => ({ value: item.value, label: item.label }))}
                        onChange={(next) => setBatchTableMode(next as BatchTableExportMode)}
                      />
                      <div style={{ marginTop: 6, fontSize: 12, color: secondaryTextColor }}>
                        {batchTableModeMeta.description}
                      </div>
                    </div>

                    {batchTableMode !== 'dataOnly' ? (
                      <div>
                        <Checkbox
                          checked={includeDropIfExists}
                          disabled={isConfigurationLocked}
                          onChange={(event) => setIncludeDropIfExists(event.target.checked)}
                        >
                          {t('data_export.sql_options.drop_if_exists.label')}
                        </Checkbox>
                        <Alert
                          type="warning"
                          showIcon
                          style={{ marginTop: 8 }}
                          message={t('data_export.sql_options.drop_if_exists.description')}
                        />
                      </div>
                    ) : null}

                    <div>
                      <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.format')}</div>
                      <Select
                        style={{ width: '100%' }}
                        value="sql"
                        disabled
                        options={[{ value: 'sql', label: t('data_export.label.sql_file') }]}
                      />
                    </div>
                  </>
                ) : (
                  <Alert
                    type="warning"
                    showIcon
                    message={t('data_export.workbench.intent.batch_tables_delete_description')}
                  />
                )}
              </>
            ) : (
              <>
                <div>
                  <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.connection')}</div>
                  <Tooltip title={connection?.name || undefined}>
                    <div>
                      <Select
                        style={{ width: '100%' }}
                        value={selectedConnectionId || undefined}
                        disabled={isConfigurationLocked}
                        placeholder={t('data_export.workbench.placeholder.select_connection')}
                        options={connectionOptions}
                        showSearch
                        optionFilterProp="title"
                        filterOption={filterOptionByLabel as any}
                        onChange={(next) => {
                          const nextConnectionId = String(next || '').trim();
                          setSelectedConnectionId(nextConnectionId);
                          setSelectedDatabaseNames([]);
                          setDatabaseLoadError('');
                          syncBatchWorkbenchTabContext(nextConnectionId);
                        }}
                      />
                    </div>
                  </Tooltip>
                </div>

                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                    <div style={{ fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.database')}</div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button
                        size="small"
                        type="text"
                        disabled={isConfigurationLocked || availableDatabases.length === 0}
                        onClick={() => setSelectedDatabaseNames(availableDatabases.map((item) => item.value))}
                      >
                        {t('data_export.action.select_all')}
                      </Button>
                      <Button
                        size="small"
                        type="text"
                        disabled={isConfigurationLocked || selectedDatabaseNames.length === 0}
                        onClick={() => setSelectedDatabaseNames([])}
                      >
                        {t('data_export.action.clear')}
                      </Button>
                    </div>
                  </div>
                  <Select
                    style={{ width: '100%' }}
                    mode="multiple"
                    value={selectedDatabaseNames}
                    placeholder={loadingDatabases
                      ? t('data_export.workbench.placeholder.loading_databases')
                      : t('data_export.workbench.placeholder.select_database')}
                    loading={loadingDatabases}
                    options={availableDatabases}
                    disabled={isConfigurationLocked}
                    showSearch
                    optionFilterProp="title"
                    filterOption={filterOptionByLabel as any}
                    maxTagCount="responsive"
                    onChange={(next) => setSelectedDatabaseNames((next as string[]).map((item) => String(item).trim()).filter(Boolean))}
                  />
                  <div style={{ marginTop: 6, fontSize: 12, color: secondaryTextColor }}>
                    {isBatchExportIntent
                      ? t('data_export.workbench.helper.batch_database_output')
                      : t('data_export.workbench.helper.batch_databases_delete')}
                  </div>
                </div>

                {isBatchExportIntent ? (
                  <>
                    <div>
                      <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.export_content')}</div>
                      <Select
                        style={{ width: '100%' }}
                        value={batchDatabaseMode}
                        disabled={isConfigurationLocked}
                        options={createBatchDatabaseExportModeOptions().map((item) => ({ value: item.value, label: item.label }))}
                        onChange={(next) => {
                          const nextMode = next as BatchDatabaseExportMode;
                          setBatchDatabaseMode(nextMode);
                          setIncludeDatabaseContext(shouldIncludeDatabaseContextByDefault(nextMode));
                        }}
                      />
                      <div style={{ marginTop: 6, fontSize: 12, color: secondaryTextColor }}>
                        {batchDatabaseModeMeta.description}
                      </div>
                    </div>

                    {supportsDatabaseContextOption ? (
                      <div>
                        <Checkbox
                          data-export-include-database-context="true"
                          checked={includeDatabaseContext}
                          disabled={isConfigurationLocked}
                          onChange={(event) => setIncludeDatabaseContext(event.target.checked)}
                        >
                          {t('data_export.sql_options.database_context.label')}
                        </Checkbox>
                        <Alert
                          type="info"
                          showIcon
                          style={{ marginTop: 8 }}
                          message={t('data_export.sql_options.database_context.description')}
                        />
                      </div>
                    ) : null}

                    <div>
                      <Checkbox
                        checked={includeDropIfExists}
                        disabled={isConfigurationLocked}
                        onChange={(event) => setIncludeDropIfExists(event.target.checked)}
                      >
                        {t('data_export.sql_options.drop_if_exists.label')}
                      </Checkbox>
                      <Alert
                        type="warning"
                        showIcon
                        style={{ marginTop: 8 }}
                        message={t('data_export.sql_options.drop_if_exists.description')}
                      />
                    </div>

                    <div>
                      <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.format')}</div>
                      <Select
                        style={{ width: '100%' }}
                        value="sql"
                        disabled
                        options={[{ value: 'sql', label: t('data_export.label.sql_file') }]}
                      />
                    </div>
                  </>
                ) : (
                  <Alert
                    type="warning"
                    showIcon
                    message={t('data_export.workbench.intent.batch_databases_delete_description')}
                  />
                )}
              </>
            )}
          </div>

          {isSingleWorkbench && scope !== 'all' && !activeScopeQuery ? (
            <Alert
              type="info"
              showIcon
              message={t('data_export.workbench.alert.scope_unavailable_title')}
              description={t('data_export.workbench.alert.scope_unavailable_description')}
            />
          ) : null}

          <div
            data-export-workbench-actions="true"
            style={{
              marginTop: 4,
              padding: '14px 0 0',
              borderRadius: 0,
              background: 'transparent',
              border: 'none',
              borderTop: `0.5px solid ${dividerColor}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              flex: '0 0 auto',
            }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: '96px minmax(0, 1fr)', rowGap: 6, columnGap: 8 }}>
              <Text type="secondary">{isSingleWorkbench
                ? t('data_export.label.estimated_rows')
                : (isBatchDatabasesWorkbench
                  ? t('data_export.label.selected_databases')
                  : (isDirectSQLWorkbench ? t('data_export.label.database') : t('data_export.label.object')))}</Text>
              <Text>
                {typeof activeScopeCount === 'number'
                  ? activeScopeCount.toLocaleString()
                  : t('data_export.value.unestimated')}
              </Text>

              <Text type="secondary">{t('data_export.label.strategy')}</Text>
              <Text>{exportStrategyLabel}</Text>
            </div>
            <div style={{ fontSize: 12, color: secondaryTextColor }}>
              {isBatchDeleteIntent
                ? (isBatchTablesWorkbench
                  ? t('data_export.workbench.helper.batch_tables_delete')
                  : t('data_export.workbench.helper.batch_databases_delete'))
                : isSingleWorkbench
                ? t('data_export.workbench.helper.single_export_start')
                : isDirectSQLWorkbench
                  ? t('data_export.workbench.helper.single_export_start')
                : isBatchTablesWorkbench
                  ? t('data_export.workbench.helper.batch_tables_start')
                  : t('data_export.workbench.helper.batch_databases_start')}
            </div>
            {isBatchDeleteIntent && isBatchTablesWorkbench ? (
              <div data-batch-table-danger-actions="true" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {supportsTableTruncateAction(connectionConfig?.type || '', connectionConfig?.driver) ? (
                  <Button
                    danger
                    size="large"
                    icon={<DeleteOutlined />}
                    data-batch-truncate-tables="true"
                    disabled={connectionCapabilities.forceReadOnlyQueryResult || isConfigurationLocked || hasBatchTableMetadataError || selectedTableNames.length === 0}
                    loading={destructiveOperation === 'truncate-tables'}
                    onClick={() => { void handleTruncateSelectedTables(); }}
                    style={{ flex: 1 }}
                  >
                    {t('sidebar.action.truncate_tables')}
                  </Button>
                ) : null}
                <Button
                  danger
                  size="large"
                  icon={<DeleteOutlined />}
                  data-batch-clear-tables="true"
                  disabled={connectionCapabilities.forceReadOnlyQueryResult || isConfigurationLocked || hasBatchTableMetadataError || selectedTableNames.length === 0}
                  loading={destructiveOperation === 'clear-tables'}
                  onClick={() => { void handleClearSelectedTables(); }}
                  style={{ flex: 1 }}
                >
                  {t('sidebar.action.clear_tables')}
                </Button>
                <Button
                  danger
                  type="primary"
                  size="large"
                  icon={<DeleteOutlined />}
                  data-batch-delete-tables="true"
                  disabled={connectionCapabilities.forceReadOnlyStructureDesigner || isConfigurationLocked || hasBatchTableMetadataError || selectedTableNames.length === 0}
                  loading={destructiveOperation === 'delete-tables'}
                  onClick={() => { void handleDeleteSelectedTables(); }}
                  style={{ flex: 1 }}
                >
                  {t('sidebar.action.delete_tables')}
                </Button>
              </div>
            ) : null}
            {isBatchDeleteIntent && isBatchDatabasesWorkbench ? (
              <div data-batch-database-danger-actions="true">
                <Button
                  danger
                  type="primary"
                  size="large"
                  block
                  icon={<DeleteOutlined />}
                  data-batch-delete-databases="true"
                  disabled={!connectionCapabilities.supportsDropDatabase || isConfigurationLocked || hasBatchDatabaseMetadataError || selectedDatabaseNames.length === 0}
                  loading={destructiveOperation === 'delete-databases'}
                  onClick={() => { void handleDeleteSelectedDatabases(); }}
                >
                  {t('sidebar.action.delete_database_count', { count: selectedDatabaseNames.length })}
                </Button>
              </div>
            ) : null}
            {isBatchExportIntent ? (
              <Button
                type="primary"
                size="large"
                icon={<ExportOutlined />}
                disabled={!canStart}
                loading={isRunning}
                onClick={() => {
                  void handleStartExport();
                }}
              >
                {t('data_export.action.start')}
              </Button>
            ) : null}
          </div>
        </section>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0, minHeight: 0, height: '100%' }}>
          <section
            data-export-workbench-progress-panel="true"
            style={{
              padding: '16px 20px 18px',
              borderRadius: 0,
              background: 'transparent',
              border: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              flex: '0 0 auto',
              minHeight: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: headingColor }}>{t('data_export.workbench.section.current_task')}</div>
                  {renderStatusPill(progressState.status)}
                </div>
                <Title level={5} style={{ margin: '10px 0 0', color: headingColor }}>
                  {progressState.title || tab.title || t('data_export.progress.value.task_fallback')}
                </Title>
                <div style={{ marginTop: 6, color: secondaryTextColor, fontSize: 13 }}>
                  {progressState.jobId
                    ? `${progressState.targetName || fallbackTargetName} · ${currentScopeLabel} · ${progressState.format || fallbackFormat}`
                    : t('data_export.workbench.description.current_task_empty')}
                </div>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, minmax(120px, auto))',
                  gap: '12px 18px',
                  alignSelf: 'stretch',
                }}
              >
                <div>
                  <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 4 }}>{t('data_export.label.elapsed')}</div>
                  <div style={{ color: headingColor, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <ClockCircleOutlined />
                    {progressState.startedAt ? formatExportElapsed(currentElapsedMs) : '--:--'}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 4 }}>{t('data_export.label.started_at')}</div>
                  <div style={{ color: headingColor, fontWeight: 600 }}>{formatDateTime(progressState.startedAt)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 4 }}>{t('data_export.label.export_scope')}</div>
                  <div style={{ color: headingColor, fontWeight: 600 }}>{progressState.jobId ? currentScopeLabel : '-'}</div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 4 }}>{t('data_export.label.strategy')}</div>
                  <div style={{ color: headingColor, fontWeight: 600 }}>{progressState.jobId ? currentStrategyLabel : '-'}</div>
                </div>
              </div>
            </div>

            {progressState.jobId ? (
              <>
                <div data-export-workbench-main-progress="true">
                  <ExportProgressBar
                    status={progressState.status}
                    current={progressState.current}
                    total={progressState.total}
                    totalRowsKnown={progressState.totalRowsKnown}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 0.9fr)', gap: 18 }}>
                  <div>
                    <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 6 }}>{t('data_export.label.current_stage')}</div>
                    <Text data-export-workbench-stage="true">
                      {progressState.stage || resolveStatusMeta(progressState.status).label || t('data_export.value.waiting_to_start')}
                    </Text>
                    <div style={{ fontSize: 12, color: secondaryTextColor, margin: '12px 0 6px' }}>{t('data_export.label.progress_summary')}</div>
                    <Text>{currentProgressSummary}</Text>
                    {currentProgressHint ? (
                      <div style={{ marginTop: 6, fontSize: 12, color: secondaryTextColor }}>
                        {currentProgressHint}
                      </div>
                    ) : null}
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 6 }}>{progressOutputLabel}</div>
                    {progressState.filePath ? (
                      <Paragraph style={{ marginBottom: 0, wordBreak: 'break-all' }}>{progressState.filePath}</Paragraph>
                    ) : (
                      <Text type="secondary">{t('data_export.value.waiting_target_path')}</Text>
                    )}
                  </div>
                </div>

                {progressState.message ? (
                  <Alert
                    type={progressState.status === 'error' ? 'error' : 'info'}
                    showIcon
                    message={progressState.message}
                  />
                ) : null}

                {progressLogs.length > 0 ? (
                  <div data-export-workbench-logs="true">
                    <div style={{ fontSize: 12, color: secondaryTextColor, marginBottom: 8 }}>
                      {t('data_export.workbench.section.logs')}
                    </div>
                    <div
                      style={{
                        maxHeight: 180,
                        overflow: 'auto',
                        padding: '4px 0',
                        borderRadius: 0,
                        background: 'transparent',
                        border: 'none',
                        borderTop: `0.5px solid ${dividerColor}`,
                      }}
                    >
                      {progressLogs.slice(-50).map((entry, index) => (
                        <div
                          key={`${entry.jobId}-${entry.sequence}`}
                          style={{
                            display: 'grid',
                            gridTemplateColumns: '72px minmax(0, 1fr)',
                            gap: 10,
                            padding: '8px 0',
                            borderTop: index === 0 ? 'none' : `1px solid ${dividerColor}`,
                            fontSize: 12,
                          }}
                        >
                          <Text type="secondary">
                            {new Date(entry.timestamp).toLocaleTimeString(undefined, { hour12: false })}
                          </Text>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ color: headingColor, wordBreak: 'break-word' }}>
                              {entry.stage || resolveStatusMeta(entry.status).label}
                            </div>
                            {entry.message ? (
                              <div style={{ marginTop: 3, color: entry.status === 'error' ? '#dc2626' : secondaryTextColor, wordBreak: 'break-word' }}>
                                {entry.message}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {(progressState.status === 'done' || progressState.status === 'error') ? (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                    {isSingleFileBackup ? (
                      <Button
                        data-export-restore-backup={true}
                        icon={<ReloadOutlined />}
                        onClick={() => openBackupRestoreWorkbench()}
                      >
                        {t('data_export.action.restore_backup')}
                      </Button>
                    ) : null}
                    <Button icon={<ReloadOutlined />} onClick={reset}>{t('data_export.action.clear_progress')}</Button>
                  </div>
                ) : null}
              </>
            ) : (
              <div data-export-workbench-current-empty="true">
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={t('data_export.workbench.empty.not_started')}
                />
              </div>
            )}
          </section>

          <section
            data-export-workbench-history="true"
            style={{
              padding: '14px 20px 18px',
              borderRadius: 0,
              background: 'transparent',
              border: 'none',
              borderTop: `0.5px solid ${dividerColor}`,
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: headingColor }}>{t('data_export.workbench.section.history')}</div>
                <div style={{ marginTop: 4, fontSize: 12, color: secondaryTextColor }}>
                  {t('data_export.workbench.description.history')}
                </div>
              </div>
              <div style={{ color: secondaryTextColor, fontSize: 12 }}>
                {t('data_export.workbench.history.count', { count: historyEntries.length })}
              </div>
            </div>

            {historyEntries.length > 0 ? (
              <div data-export-workbench-history-list="true" style={{ display: 'flex', flexDirection: 'column' }}>
                {historyEntries.map((entry, index) => (
                  <div
                    key={entry.jobId}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1.15fr) minmax(280px, 0.85fr)',
                      gap: 18,
                      padding: '14px 0',
                      borderTop: index === 0 ? 'none' : `1px solid ${dividerColor}`,
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <Text strong>{entry.targetName}</Text>
                        {renderStatusPill(entry.status)}
                        <span style={{ fontSize: 12, color: secondaryTextColor }}>
                          {entry.scopeLabel} · {entry.format || '-'}
                        </span>
                      </div>
                      <div style={{ marginTop: 6, fontSize: 13, color: headingColor }}>
                        {entry.stage || resolveStatusMeta(entry.status).label}
                      </div>
                      <div style={{ marginTop: 4, fontSize: 12, color: secondaryTextColor }}>
                        {formatWorkbenchProgressSummary(workbenchMode, entry.current, entry.total, entry.totalRowsKnown)}
                      </div>
                      {entry.message ? (
                        <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626' }}>{entry.message}</div>
                      ) : null}
                    </div>

                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '80px minmax(0, 1fr)', rowGap: 6, columnGap: 10 }}>
                        <Text type="secondary">{t('data_export.label.started_at')}</Text>
                        <Text>{formatDateTime(entry.startedAt)}</Text>

                        <Text type="secondary">{t('data_export.label.elapsed')}</Text>
                        <Text>{formatExportElapsed(resolveExportElapsedMs(entry.startedAt, entry.finishedAt, nowTick))}</Text>

                        <Text type="secondary">{isBatchDatabasesWorkbench ? t('data_export.label.directory') : t('data_export.label.file')}</Text>
                        <Paragraph style={{ marginBottom: 0, wordBreak: 'break-all' }}>
                          {entry.filePath || '-'}
                        </Paragraph>
                      </div>
                      {entry.status === 'done'
                        && !isBatchDatabasesWorkbench
                        && String(entry.filePath || '').trim().toLowerCase().endsWith('.sql') ? (
                          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                            <Button
                              size="small"
                              data-export-history-restore={entry.jobId}
                              icon={<ReloadOutlined />}
                              onClick={() => openBackupRestoreWorkbench(entry.filePath)}
                            >
                              {t('data_export.action.restore_backup')}
                            </Button>
                          </div>
                        ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ padding: '6px 0 2px', color: secondaryTextColor, fontSize: 13 }}>
                {t('data_export.workbench.empty.history')}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default TableExportWorkbench;
