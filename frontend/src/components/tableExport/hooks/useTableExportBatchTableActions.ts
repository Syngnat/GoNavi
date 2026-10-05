import { useMemo, useEffect } from 'react';
import { message } from 'antd';
import { t } from '../../../i18n';
import { resolveExportElapsedMs } from '../../../utils/exportProgress';
import {
  resolveProgressHint,
  resolveOutputLabel,
  resolveBatchTablesTargetName,
  resolveBatchDatabasesTargetName,
  buildTableExportHistoryEntry,
  formatWorkbenchProgressSummary,
} from '../tableExportWorkbenchModel';
import { buildSQLFileExecutionWorkbenchTab } from '../../../utils/sqlFileExecutionTab';
import Modal from '../../common/ResizableDraggableModal';
import { isDatabaseVisible } from '../../../utils/databaseVisibility';
import { supportsTableTruncateAction } from '../../tableDataDangerActions';
import { confirmProductionMutation } from '../../../utils/productionRiskConfirm';
import { TruncateTables, ClearTables, DropTable } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import type { TableExportStateApi } from './useTableExportState';
import type { TableExportWorkbenchBodyProps } from '../../TableExportWorkbench';

export interface UseTableExportBatchTableActionsInput {
  isBatchDeleteIntent: TableExportStateApi['isBatchDeleteIntent'];
  isSingleWorkbench: TableExportStateApi['isSingleWorkbench'];
  scope: TableExportStateApi['scope'];
  activeScopeQuery: TableExportStateApi['activeScopeQuery'];
  isDirectSQLWorkbench: TableExportStateApi['isDirectSQLWorkbench'];
  batchDatabaseModeMeta: TableExportStateApi['batchDatabaseModeMeta'];
  isBatchTablesWorkbench: TableExportStateApi['isBatchTablesWorkbench'];
  batchTableModeMeta: TableExportStateApi['batchTableModeMeta'];
  progressState: TableExportStateApi['progressState'];
  nowTick: TableExportStateApi['nowTick'];
  workbenchMode: TableExportStateApi['workbenchMode'];
  tab: TableExportWorkbenchBodyProps['tab'];
  isDirectSchemaWorkbench: TableExportStateApi['isDirectSchemaWorkbench'];
  selectedDbName: TableExportStateApi['selectedDbName'];
  selectedObjectNames: TableExportStateApi['selectedObjectNames'];
  selectedDatabaseNames: TableExportStateApi['selectedDatabaseNames'];
  format: TableExportStateApi['format'];
  history: TableExportStateApi['history'];
  activeScopeLabel: TableExportStateApi['activeScopeLabel'];
  upsertTableExportHistory: TableExportStateApi['upsertTableExportHistory'];
  exportHistoryKey: TableExportStateApi['exportHistoryKey'];
  isBatchDatabasesWorkbench: TableExportStateApi['isBatchDatabasesWorkbench'];
  batchTableMode: TableExportStateApi['batchTableMode'];
  batchDatabaseMode: TableExportStateApi['batchDatabaseMode'];
  effectiveConnectionId: TableExportStateApi['effectiveConnectionId'];
  addTab: TableExportStateApi['addTab'];
  effectiveDbName: TableExportStateApi['effectiveDbName'];
  availableObjects: TableExportStateApi['availableObjects'];
  isRunning: TableExportStateApi['isRunning'];
  destructiveOperation: TableExportStateApi['destructiveOperation'];
  loadingDatabases: TableExportStateApi['loadingDatabases'];
  loadingObjects: TableExportStateApi['loadingObjects'];
  databaseLoadError: TableExportStateApi['databaseLoadError'];
  objectLoadError: TableExportStateApi['objectLoadError'];
  columnLoadError: TableExportStateApi['columnLoadError'];
  connectionConfig: TableExportStateApi['connectionConfig'];
  activeScopeOption: TableExportStateApi['activeScopeOption'];
  loadingColumns: TableExportStateApi['loadingColumns'];
  selectedColumns: TableExportStateApi['selectedColumns'];
  isDirectDatabaseWorkbench: TableExportStateApi['isDirectDatabaseWorkbench'];
  connectionCapabilities: TableExportStateApi['connectionCapabilities'];
  connection: TableExportStateApi['connection'];
  setDestructiveOperation: TableExportStateApi['setDestructiveOperation'];
  addSqlLog: TableExportStateApi['addSqlLog'];
  setAvailableObjects: TableExportStateApi['setAvailableObjects'];
  setSelectedObjectNames: TableExportStateApi['setSelectedObjectNames'];
}

export const useTableExportBatchTableActions = ({
  isBatchDeleteIntent, isSingleWorkbench, scope, activeScopeQuery, isDirectSQLWorkbench,
  batchDatabaseModeMeta, isBatchTablesWorkbench, batchTableModeMeta, progressState, nowTick,
  workbenchMode, tab, isDirectSchemaWorkbench, selectedDbName, selectedObjectNames,
  selectedDatabaseNames, format, history, activeScopeLabel, upsertTableExportHistory,
  exportHistoryKey, isBatchDatabasesWorkbench, batchTableMode, batchDatabaseMode,
  effectiveConnectionId, addTab, effectiveDbName, availableObjects, isRunning, destructiveOperation,
  loadingDatabases, loadingObjects, databaseLoadError, objectLoadError, columnLoadError,
  connectionConfig, activeScopeOption, loadingColumns, selectedColumns, isDirectDatabaseWorkbench,
  connectionCapabilities, connection, setDestructiveOperation, addSqlLog, setAvailableObjects,
  setSelectedObjectNames,
}: UseTableExportBatchTableActionsInput) => {
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
      || (progressState.status !== 'done' && progressState.status !== 'error' && progressState.status !== 'cancelled')
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
  return {
    exportStrategyLabel, currentElapsedMs, currentProgressHint, progressOutputLabel,
    fallbackTargetName, fallbackFormat, historyEntries, currentScopeLabel, currentStrategyLabel,
    currentProgressSummary, isSingleFileBackup, openBackupRestoreWorkbench, selectedTableNames,
    isConfigurationLocked, hasBatchTableMetadataError, hasBatchDatabaseMetadataError, canStart,
    confirmDestructiveAction, handleTruncateSelectedTables, handleClearSelectedTables,
    handleDeleteSelectedTables,
  };
};

export type TableExportBatchTableActionsApi = ReturnType<typeof useTableExportBatchTableActions>;
