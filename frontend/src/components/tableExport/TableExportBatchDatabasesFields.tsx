import { Tooltip, Select, Button, Checkbox, Alert } from 'antd';
import { t } from '../../i18n';
import {
  filterOptionByLabel,
  shouldIncludeDatabaseContextByDefault,
} from './tableExportWorkbenchModel';
import {
  createBatchDatabaseExportModeOptions,
  type BatchDatabaseExportMode,
} from './tableExportWorkbenchOptions';
import type { TableExportStateApi } from './hooks/useTableExportState';
import type { TableExportBatchTableActionsApi } from './hooks/useTableExportBatchTableActions';

export interface TableExportBatchDatabasesFieldsProps {
  secondaryTextColor: TableExportStateApi['secondaryTextColor'];
  connection: TableExportStateApi['connection'];
  selectedConnectionId: TableExportStateApi['selectedConnectionId'];
  isConfigurationLocked: TableExportBatchTableActionsApi['isConfigurationLocked'];
  connectionOptions: TableExportStateApi['connectionOptions'];
  setSelectedConnectionId: TableExportStateApi['setSelectedConnectionId'];
  setSelectedDatabaseNames: TableExportStateApi['setSelectedDatabaseNames'];
  setDatabaseLoadError: TableExportStateApi['setDatabaseLoadError'];
  syncBatchWorkbenchTabContext: TableExportStateApi['syncBatchWorkbenchTabContext'];
  availableDatabases: TableExportStateApi['availableDatabases'];
  selectedDatabaseNames: TableExportStateApi['selectedDatabaseNames'];
  loadingDatabases: TableExportStateApi['loadingDatabases'];
  isBatchExportIntent: TableExportStateApi['isBatchExportIntent'];
  batchDatabaseMode: TableExportStateApi['batchDatabaseMode'];
  setBatchDatabaseMode: TableExportStateApi['setBatchDatabaseMode'];
  setIncludeDatabaseContext: TableExportStateApi['setIncludeDatabaseContext'];
  batchDatabaseModeMeta: TableExportStateApi['batchDatabaseModeMeta'];
  supportsDatabaseContextOption: TableExportStateApi['supportsDatabaseContextOption'];
  includeDatabaseContext: TableExportStateApi['includeDatabaseContext'];
  includeDropIfExists: TableExportStateApi['includeDropIfExists'];
  setIncludeDropIfExists: TableExportStateApi['setIncludeDropIfExists'];
}

export const TableExportBatchDatabasesFields = ({
  secondaryTextColor, connection, selectedConnectionId, isConfigurationLocked, connectionOptions,
  setSelectedConnectionId, setSelectedDatabaseNames, setDatabaseLoadError,
  syncBatchWorkbenchTabContext, availableDatabases, selectedDatabaseNames, loadingDatabases,
  isBatchExportIntent, batchDatabaseMode, setBatchDatabaseMode, setIncludeDatabaseContext,
  batchDatabaseModeMeta, supportsDatabaseContextOption, includeDatabaseContext, includeDropIfExists,
  setIncludeDropIfExists,
}: TableExportBatchDatabasesFieldsProps) => (
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
);
