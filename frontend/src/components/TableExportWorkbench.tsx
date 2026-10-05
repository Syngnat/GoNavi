import React from 'react';
import { Alert, Button, message } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { TabData } from '../types';
import { t } from '../i18n';
import BatchConnectionWorkbench from './BatchConnectionWorkbench';
import { resolveWorkbenchMode } from './tableExport/tableExportWorkbenchOptions';
import { useTableExportState } from './tableExport/hooks/useTableExportState';
import {
  useTableExportBatchTableActions,
} from './tableExport/hooks/useTableExportBatchTableActions';
import { useTableExportRunActions } from './tableExport/hooks/useTableExportRunActions';
import { TableExportWorkbenchHeader } from './tableExport/TableExportWorkbenchHeader';
import { TableExportIntentSection } from './tableExport/TableExportIntentSection';
import { TableExportSingleScopeFields } from './tableExport/TableExportSingleScopeFields';
import { TableExportDirectSqlFields } from './tableExport/TableExportDirectSqlFields';
import { TableExportBatchTablesFields } from './tableExport/TableExportBatchTablesFields';
import { TableExportBatchDatabasesFields } from './tableExport/TableExportBatchDatabasesFields';
import { TableExportWorkbenchActions } from './tableExport/TableExportWorkbenchActions';
import { TableExportProgressPanel } from './tableExport/TableExportProgressPanel';
import { TableExportHistoryPanel } from './tableExport/TableExportHistoryPanel';
export { resolveTableExportColumnNames } from './tableExport/tableExportWorkbenchOptions';
export type { BatchWorkbenchObject } from './tableExport/tableExportWorkbenchOptions';
export {
  resolveBatchWorkbenchObjects,
  buildTableExportHistoryEntry,
} from './tableExport/tableExportWorkbenchModel';

export interface TableExportWorkbenchBodyProps { tab: TabData }

const TableExportWorkbenchBody: React.FC<TableExportWorkbenchBodyProps> = ({ tab }) => {
  const {
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
  } = useTableExportState({ tab });
  const {
    exportStrategyLabel, currentElapsedMs, currentProgressHint, progressOutputLabel,
    fallbackTargetName, fallbackFormat, historyEntries, currentScopeLabel, currentStrategyLabel,
    currentProgressSummary, isSingleFileBackup, openBackupRestoreWorkbench, selectedTableNames,
    isConfigurationLocked, hasBatchTableMetadataError, hasBatchDatabaseMetadataError, canStart,
    confirmDestructiveAction, handleTruncateSelectedTables, handleClearSelectedTables,
    handleDeleteSelectedTables,
  } = useTableExportBatchTableActions({
    isBatchDeleteIntent, isSingleWorkbench, scope, activeScopeQuery, isDirectSQLWorkbench,
    batchDatabaseModeMeta, isBatchTablesWorkbench, batchTableModeMeta, progressState, nowTick,
    workbenchMode, tab, isDirectSchemaWorkbench, selectedDbName, selectedObjectNames,
    selectedDatabaseNames, format, history, activeScopeLabel, upsertTableExportHistory,
    exportHistoryKey, isBatchDatabasesWorkbench, batchTableMode, batchDatabaseMode,
    effectiveConnectionId, addTab, effectiveDbName, availableObjects, isRunning,
    destructiveOperation, loadingDatabases, loadingObjects, databaseLoadError, objectLoadError,
    columnLoadError, connectionConfig, activeScopeOption, loadingColumns, selectedColumns,
    isDirectDatabaseWorkbench, connectionCapabilities, connection, setDestructiveOperation,
    addSqlLog, setAvailableObjects, setSelectedObjectNames,
  });

  const { handleDeleteSelectedDatabases, handleStartExport, headerBadges } = useTableExportRunActions({
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
  });

  return (
    <div
      data-export-workbench="true"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: shellBg }}
    >
      <TableExportWorkbenchHeader
        dividerColor={dividerColor} headingColor={headingColor}
        isBatchTablesWorkbench={isBatchTablesWorkbench}
        isBatchDatabasesWorkbench={isBatchDatabasesWorkbench}
        secondaryTextColor={secondaryTextColor} isBatchDeleteIntent={isBatchDeleteIntent}
        headerBadges={headerBadges} pillBg={pillBg}
      />

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
          <TableExportIntentSection
            headingColor={headingColor} isBatchWorkbench={isBatchWorkbench}
            secondaryTextColor={secondaryTextColor} batchIntent={batchIntent}
            isConfigurationLocked={isConfigurationLocked} setBatchIntent={setBatchIntent}
            isSingleWorkbench={isSingleWorkbench} tab={tab} connection={connection}
            hostSummary={hostSummary} isDirectSQLWorkbench={isDirectSQLWorkbench}
            batchDatabaseModeMeta={batchDatabaseModeMeta} effectiveDbName={effectiveDbName}
            isDirectSchemaWorkbench={isDirectSchemaWorkbench}
            isBatchTablesWorkbench={isBatchTablesWorkbench} selectedDbName={selectedDbName}
            selectedObjectNames={selectedObjectNames}
            selectedDatabaseNames={selectedDatabaseNames}
          />

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
              <TableExportSingleScopeFields
                secondaryTextColor={secondaryTextColor} scope={scope}
                isConfigurationLocked={isConfigurationLocked} scopeOptions={scopeOptions}
                setScope={setScope} activeScopeOption={activeScopeOption} format={format}
                setFormat={setFormat} activeScopeQuery={activeScopeQuery}
                includeDropIfExists={includeDropIfExists}
                setIncludeDropIfExists={setIncludeDropIfExists}
                availableColumns={availableColumns} selectedColumns={selectedColumns}
                loadingColumns={loadingColumns} setSelectedColumns={setSelectedColumns}
                xlsxMaxRowsPerSheet={xlsxMaxRowsPerSheet}
                setXlsxMaxRowsPerSheet={setXlsxMaxRowsPerSheet}
                supportsSqlFormat={connectionCapabilities.supportsSqlQueryExport}
              />
            ) : isDirectSQLWorkbench ? (
              <TableExportDirectSqlFields
                secondaryTextColor={secondaryTextColor} batchDatabaseMode={batchDatabaseMode}
                isConfigurationLocked={isConfigurationLocked}
                setBatchDatabaseMode={setBatchDatabaseMode}
                setIncludeDatabaseContext={setIncludeDatabaseContext}
                batchDatabaseModeMeta={batchDatabaseModeMeta}
                isDirectDatabaseWorkbench={isDirectDatabaseWorkbench}
                supportsDatabaseContextOption={supportsDatabaseContextOption}
                includeDatabaseContext={includeDatabaseContext}
                includeDropIfExists={includeDropIfExists}
                setIncludeDropIfExists={setIncludeDropIfExists}
              />
            ) : isBatchTablesWorkbench ? (
              <TableExportBatchTablesFields
                secondaryTextColor={secondaryTextColor} connection={connection}
                selectedConnectionId={selectedConnectionId}
                isConfigurationLocked={isConfigurationLocked}
                connectionOptions={connectionOptions}
                setSelectedConnectionId={setSelectedConnectionId}
                setSelectedDbName={setSelectedDbName}
                setSelectedObjectNames={setSelectedObjectNames}
                setAvailableObjects={setAvailableObjects} setObjectLoadError={setObjectLoadError}
                syncBatchWorkbenchTabContext={syncBatchWorkbenchTabContext}
                selectedDbName={selectedDbName} loadingDatabases={loadingDatabases}
                availableDatabases={availableDatabases} availableObjects={availableObjects}
                selectedObjectNames={selectedObjectNames} loadingObjects={loadingObjects}
                isBatchExportIntent={isBatchExportIntent} batchTableMode={batchTableMode}
                setBatchTableMode={setBatchTableMode} batchTableModeMeta={batchTableModeMeta}
                includeDropIfExists={includeDropIfExists}
                setIncludeDropIfExists={setIncludeDropIfExists}
              />
            ) : (
              <TableExportBatchDatabasesFields
                secondaryTextColor={secondaryTextColor} connection={connection}
                selectedConnectionId={selectedConnectionId}
                isConfigurationLocked={isConfigurationLocked}
                connectionOptions={connectionOptions}
                setSelectedConnectionId={setSelectedConnectionId}
                setSelectedDatabaseNames={setSelectedDatabaseNames}
                setDatabaseLoadError={setDatabaseLoadError}
                syncBatchWorkbenchTabContext={syncBatchWorkbenchTabContext}
                availableDatabases={availableDatabases}
                selectedDatabaseNames={selectedDatabaseNames} loadingDatabases={loadingDatabases}
                isBatchExportIntent={isBatchExportIntent} batchDatabaseMode={batchDatabaseMode}
                setBatchDatabaseMode={setBatchDatabaseMode}
                setIncludeDatabaseContext={setIncludeDatabaseContext}
                batchDatabaseModeMeta={batchDatabaseModeMeta}
                supportsDatabaseContextOption={supportsDatabaseContextOption}
                includeDatabaseContext={includeDatabaseContext}
                includeDropIfExists={includeDropIfExists}
                setIncludeDropIfExists={setIncludeDropIfExists}
              />
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

          <TableExportWorkbenchActions
            dividerColor={dividerColor} isSingleWorkbench={isSingleWorkbench}
            isBatchDatabasesWorkbench={isBatchDatabasesWorkbench}
            isDirectSQLWorkbench={isDirectSQLWorkbench} activeScopeCount={activeScopeCount}
            exportStrategyLabel={exportStrategyLabel} secondaryTextColor={secondaryTextColor}
            isBatchDeleteIntent={isBatchDeleteIntent}
            isBatchTablesWorkbench={isBatchTablesWorkbench} connectionConfig={connectionConfig}
            connectionCapabilities={connectionCapabilities}
            isConfigurationLocked={isConfigurationLocked}
            hasBatchTableMetadataError={hasBatchTableMetadataError}
            selectedTableNames={selectedTableNames} destructiveOperation={destructiveOperation}
            handleTruncateSelectedTables={handleTruncateSelectedTables}
            handleClearSelectedTables={handleClearSelectedTables}
            handleDeleteSelectedTables={handleDeleteSelectedTables}
            hasBatchDatabaseMetadataError={hasBatchDatabaseMetadataError}
            selectedDatabaseNames={selectedDatabaseNames}
            handleDeleteSelectedDatabases={handleDeleteSelectedDatabases}
            isBatchExportIntent={isBatchExportIntent} canStart={canStart} isRunning={isRunning}
            handleStartExport={handleStartExport}
          />
        </section>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, minWidth: 0, minHeight: 0, height: '100%' }}>
          <TableExportProgressPanel
            headingColor={headingColor} progressState={progressState} tab={tab}
            secondaryTextColor={secondaryTextColor} fallbackTargetName={fallbackTargetName}
            currentScopeLabel={currentScopeLabel} fallbackFormat={fallbackFormat}
            currentElapsedMs={currentElapsedMs} currentStrategyLabel={currentStrategyLabel}
            isRunning={isRunning} cancelExport={cancelExport}
            currentProgressSummary={currentProgressSummary}
            currentProgressHint={currentProgressHint} progressOutputLabel={progressOutputLabel}
            progressLogs={progressLogs} dividerColor={dividerColor}
            isSingleFileBackup={isSingleFileBackup}
            openBackupRestoreWorkbench={openBackupRestoreWorkbench} reset={reset}
          />

          <TableExportHistoryPanel
            dividerColor={dividerColor} headingColor={headingColor}
            secondaryTextColor={secondaryTextColor} historyEntries={historyEntries}
            workbenchMode={workbenchMode} nowTick={nowTick}
            isBatchDatabasesWorkbench={isBatchDatabasesWorkbench}
            openBackupRestoreWorkbench={openBackupRestoreWorkbench}
          />
        </div>
      </div>
    </div>
  );
};

const TableExportWorkbench: React.FC<{ tab: TabData }> = ({ tab }) => (
  resolveWorkbenchMode(tab) === 'batch-connections'
    ? <BatchConnectionWorkbench tab={tab} />
    : <TableExportWorkbenchBody tab={tab} />
);

export default TableExportWorkbench;
