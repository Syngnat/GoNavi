import { Segmented } from 'antd';
import { t } from '../../i18n';
import {
  type BatchWorkbenchIntent,
  Text,
  resolveObjectTypeLabel,
} from './tableExportWorkbenchOptions';
import type { TableExportStateApi } from './hooks/useTableExportState';
import type { TableExportBatchTableActionsApi } from './hooks/useTableExportBatchTableActions';
import type { TableExportWorkbenchBodyProps } from '../TableExportWorkbench';

export interface TableExportIntentSectionProps {
  headingColor: TableExportStateApi['headingColor'];
  isBatchWorkbench: TableExportStateApi['isBatchWorkbench'];
  secondaryTextColor: TableExportStateApi['secondaryTextColor'];
  batchIntent: TableExportStateApi['batchIntent'];
  isConfigurationLocked: TableExportBatchTableActionsApi['isConfigurationLocked'];
  setBatchIntent: TableExportStateApi['setBatchIntent'];
  isSingleWorkbench: TableExportStateApi['isSingleWorkbench'];
  tab: TableExportWorkbenchBodyProps['tab'];
  connection: TableExportStateApi['connection'];
  hostSummary: TableExportStateApi['hostSummary'];
  isDirectSQLWorkbench: TableExportStateApi['isDirectSQLWorkbench'];
  batchDatabaseModeMeta: TableExportStateApi['batchDatabaseModeMeta'];
  effectiveDbName: TableExportStateApi['effectiveDbName'];
  isDirectSchemaWorkbench: TableExportStateApi['isDirectSchemaWorkbench'];
  isBatchTablesWorkbench: TableExportStateApi['isBatchTablesWorkbench'];
  selectedDbName: TableExportStateApi['selectedDbName'];
  selectedObjectNames: TableExportStateApi['selectedObjectNames'];
  selectedDatabaseNames: TableExportStateApi['selectedDatabaseNames'];
}

export const TableExportIntentSection = ({
  headingColor, isBatchWorkbench, secondaryTextColor, batchIntent, isConfigurationLocked,
  setBatchIntent, isSingleWorkbench, tab, connection, hostSummary, isDirectSQLWorkbench,
  batchDatabaseModeMeta, effectiveDbName, isDirectSchemaWorkbench, isBatchTablesWorkbench,
  selectedDbName, selectedObjectNames, selectedDatabaseNames,
}: TableExportIntentSectionProps) => (
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
);
