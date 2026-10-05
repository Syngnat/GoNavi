import { message } from 'antd';
import { useRef, useEffect, useMemo } from 'react';
import { filterVisibleDatabaseNames, isDatabaseVisible } from '../../../utils/databaseVisibility';
import { t } from '../../../i18n';
import { confirmProductionMutation } from '../../../utils/productionRiskConfirm';
import {
  DropDatabase,
  ExportQueryWithOptions,
  ExportTableWithOptions,
  ExportTablesSQLWithOptions,
  ExportDatabasesSQLWithOptions,
  ExportDatabaseSQLWithOptions,
  ExportSchemaSQLWithOptions,
} from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import {
  resolveBatchTablesTargetName,
  resolveBatchDatabasesTargetName,
} from '../tableExportWorkbenchModel';
import { resolveObjectTypeLabel } from '../tableExportWorkbenchOptions';
import type { TableExportStateApi } from './useTableExportState';
import type { TableExportBatchTableActionsApi } from './useTableExportBatchTableActions';
import type { TableExportWorkbenchBodyProps } from '../../TableExportWorkbench';

export interface UseTableExportRunActionsInput {
  connectionCapabilities: TableExportStateApi['connectionCapabilities'];
  connectionConfig: TableExportStateApi['connectionConfig'];
  connection: TableExportStateApi['connection'];
  selectedDatabaseNames: TableExportStateApi['selectedDatabaseNames'];
  setSelectedDatabaseNames: TableExportStateApi['setSelectedDatabaseNames'];
  hasBatchDatabaseMetadataError: TableExportBatchTableActionsApi['hasBatchDatabaseMetadataError'];
  isConfigurationLocked: TableExportBatchTableActionsApi['isConfigurationLocked'];
  confirmDestructiveAction: TableExportBatchTableActionsApi['confirmDestructiveAction'];
  effectiveConnectionId: TableExportStateApi['effectiveConnectionId'];
  setDestructiveOperation: TableExportStateApi['setDestructiveOperation'];
  setAvailableDatabases: TableExportStateApi['setAvailableDatabases'];
  addSqlLog: TableExportStateApi['addSqlLog'];
  tab: TableExportWorkbenchBodyProps['tab'];
  columnLoadError: TableExportStateApi['columnLoadError'];
  loadingColumns: TableExportStateApi['loadingColumns'];
  selectedColumns: TableExportStateApi['selectedColumns'];
  runExportWithProgress: TableExportStateApi['runExportWithProgress'];
  format: TableExportStateApi['format'];
  singleScopeRowCount: TableExportStateApi['singleScopeRowCount'];
  xlsxMaxRowsPerSheet: TableExportStateApi['xlsxMaxRowsPerSheet'];
  singleTotalRowsKnown: TableExportStateApi['singleTotalRowsKnown'];
  scope: TableExportStateApi['scope'];
  activeScopeQuery: TableExportStateApi['activeScopeQuery'];
  includeDropIfExists: TableExportStateApi['includeDropIfExists'];
  selectedDbName: TableExportStateApi['selectedDbName'];
  selectedObjectNames: TableExportStateApi['selectedObjectNames'];
  loadingDatabases: TableExportStateApi['loadingDatabases'];
  loadingObjects: TableExportStateApi['loadingObjects'];
  hasBatchTableMetadataError: TableExportBatchTableActionsApi['hasBatchTableMetadataError'];
  batchTableMode: TableExportStateApi['batchTableMode'];
  batchTableModeMeta: TableExportStateApi['batchTableModeMeta'];
  batchDatabaseMode: TableExportStateApi['batchDatabaseMode'];
  batchDatabaseModeMeta: TableExportStateApi['batchDatabaseModeMeta'];
  includeDatabaseContext: TableExportStateApi['includeDatabaseContext'];
  effectiveDbName: TableExportStateApi['effectiveDbName'];
  isSingleWorkbench: TableExportStateApi['isSingleWorkbench'];
  isBatchTablesWorkbench: TableExportStateApi['isBatchTablesWorkbench'];
  isDirectDatabaseWorkbench: TableExportStateApi['isDirectDatabaseWorkbench'];
  isDirectSchemaWorkbench: TableExportStateApi['isDirectSchemaWorkbench'];
  appliedLaunchKey: TableExportStateApi['appliedLaunchKey'];
  progressState: TableExportStateApi['progressState'];
  isRunning: TableExportStateApi['isRunning'];
  canStart: TableExportBatchTableActionsApi['canStart'];
  hostSummary: TableExportStateApi['hostSummary'];
  isDirectSQLWorkbench: TableExportStateApi['isDirectSQLWorkbench'];
}

export const useTableExportRunActions = ({
  connectionCapabilities, connectionConfig, connection, selectedDatabaseNames,
  setSelectedDatabaseNames, hasBatchDatabaseMetadataError, isConfigurationLocked,
  confirmDestructiveAction, effectiveConnectionId, setDestructiveOperation, setAvailableDatabases,
  addSqlLog, tab, columnLoadError, loadingColumns, selectedColumns, runExportWithProgress, format,
  singleScopeRowCount, xlsxMaxRowsPerSheet, singleTotalRowsKnown, scope, activeScopeQuery,
  includeDropIfExists, selectedDbName, selectedObjectNames, loadingDatabases, loadingObjects,
  hasBatchTableMetadataError, batchTableMode, batchTableModeMeta, batchDatabaseMode,
  batchDatabaseModeMeta, includeDatabaseContext, effectiveDbName, isSingleWorkbench,
  isBatchTablesWorkbench, isDirectDatabaseWorkbench, isDirectSchemaWorkbench, appliedLaunchKey,
  progressState, isRunning, canStart, hostSummary, isDirectSQLWorkbench,
}: UseTableExportRunActionsInput) => {
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
  return { handleDeleteSelectedDatabases, handleStartExport, headerBadges };
};

export type TableExportRunActionsApi = ReturnType<typeof useTableExportRunActions>;
