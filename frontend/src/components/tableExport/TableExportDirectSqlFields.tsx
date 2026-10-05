import { Select, Checkbox, Alert } from 'antd';
import { t } from '../../i18n';
import {
  createBatchDatabaseExportModeOptions,
  type BatchDatabaseExportMode,
} from './tableExportWorkbenchOptions';
import { shouldIncludeDatabaseContextByDefault } from './tableExportWorkbenchModel';
import type { TableExportStateApi } from './hooks/useTableExportState';
import type { TableExportBatchTableActionsApi } from './hooks/useTableExportBatchTableActions';

export interface TableExportDirectSqlFieldsProps {
  secondaryTextColor: TableExportStateApi['secondaryTextColor'];
  batchDatabaseMode: TableExportStateApi['batchDatabaseMode'];
  isConfigurationLocked: TableExportBatchTableActionsApi['isConfigurationLocked'];
  setBatchDatabaseMode: TableExportStateApi['setBatchDatabaseMode'];
  setIncludeDatabaseContext: TableExportStateApi['setIncludeDatabaseContext'];
  batchDatabaseModeMeta: TableExportStateApi['batchDatabaseModeMeta'];
  isDirectDatabaseWorkbench: TableExportStateApi['isDirectDatabaseWorkbench'];
  supportsDatabaseContextOption: TableExportStateApi['supportsDatabaseContextOption'];
  includeDatabaseContext: TableExportStateApi['includeDatabaseContext'];
  includeDropIfExists: TableExportStateApi['includeDropIfExists'];
  setIncludeDropIfExists: TableExportStateApi['setIncludeDropIfExists'];
}

export const TableExportDirectSqlFields = ({
  secondaryTextColor, batchDatabaseMode, isConfigurationLocked, setBatchDatabaseMode,
  setIncludeDatabaseContext, batchDatabaseModeMeta, isDirectDatabaseWorkbench,
  supportsDatabaseContextOption, includeDatabaseContext, includeDropIfExists,
  setIncludeDropIfExists,
}: TableExportDirectSqlFieldsProps) => (
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
);
