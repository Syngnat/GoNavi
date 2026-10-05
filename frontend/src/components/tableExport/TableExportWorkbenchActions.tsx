import { Button } from 'antd';
import { DeleteOutlined, ExportOutlined } from '@ant-design/icons';
import { Text } from './tableExportWorkbenchOptions';
import { t } from '../../i18n';
import { supportsTableTruncateAction } from '../tableDataDangerActions';
import type { TableExportStateApi } from './hooks/useTableExportState';
import type { TableExportBatchTableActionsApi } from './hooks/useTableExportBatchTableActions';
import type { TableExportRunActionsApi } from './hooks/useTableExportRunActions';

export interface TableExportWorkbenchActionsProps {
  dividerColor: TableExportStateApi['dividerColor'];
  isSingleWorkbench: TableExportStateApi['isSingleWorkbench'];
  isBatchDatabasesWorkbench: TableExportStateApi['isBatchDatabasesWorkbench'];
  isDirectSQLWorkbench: TableExportStateApi['isDirectSQLWorkbench'];
  activeScopeCount: TableExportStateApi['activeScopeCount'];
  exportStrategyLabel: TableExportBatchTableActionsApi['exportStrategyLabel'];
  secondaryTextColor: TableExportStateApi['secondaryTextColor'];
  isBatchDeleteIntent: TableExportStateApi['isBatchDeleteIntent'];
  isBatchTablesWorkbench: TableExportStateApi['isBatchTablesWorkbench'];
  connectionConfig: TableExportStateApi['connectionConfig'];
  connectionCapabilities: TableExportStateApi['connectionCapabilities'];
  isConfigurationLocked: TableExportBatchTableActionsApi['isConfigurationLocked'];
  hasBatchTableMetadataError: TableExportBatchTableActionsApi['hasBatchTableMetadataError'];
  selectedTableNames: TableExportBatchTableActionsApi['selectedTableNames'];
  destructiveOperation: TableExportStateApi['destructiveOperation'];
  handleTruncateSelectedTables: TableExportBatchTableActionsApi['handleTruncateSelectedTables'];
  handleClearSelectedTables: TableExportBatchTableActionsApi['handleClearSelectedTables'];
  handleDeleteSelectedTables: TableExportBatchTableActionsApi['handleDeleteSelectedTables'];
  hasBatchDatabaseMetadataError: TableExportBatchTableActionsApi['hasBatchDatabaseMetadataError'];
  selectedDatabaseNames: TableExportStateApi['selectedDatabaseNames'];
  handleDeleteSelectedDatabases: TableExportRunActionsApi['handleDeleteSelectedDatabases'];
  isBatchExportIntent: TableExportStateApi['isBatchExportIntent'];
  canStart: TableExportBatchTableActionsApi['canStart'];
  isRunning: TableExportStateApi['isRunning'];
  handleStartExport: TableExportRunActionsApi['handleStartExport'];
}

export const TableExportWorkbenchActions = ({
  dividerColor, isSingleWorkbench, isBatchDatabasesWorkbench, isDirectSQLWorkbench,
  activeScopeCount, exportStrategyLabel, secondaryTextColor, isBatchDeleteIntent,
  isBatchTablesWorkbench, connectionConfig, connectionCapabilities, isConfigurationLocked,
  hasBatchTableMetadataError, selectedTableNames, destructiveOperation,
  handleTruncateSelectedTables, handleClearSelectedTables, handleDeleteSelectedTables,
  hasBatchDatabaseMetadataError, selectedDatabaseNames, handleDeleteSelectedDatabases,
  isBatchExportIntent, canStart, isRunning, handleStartExport,
}: TableExportWorkbenchActionsProps) => (
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
);
