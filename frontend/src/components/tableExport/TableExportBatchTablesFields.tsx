import { Tooltip, Select, Button, Checkbox, Alert, InputNumber } from 'antd';
import { t } from '../../i18n';
import { filterOptionByLabel } from './tableExportWorkbenchModel';
import {
  createBatchTableExportModeOptions,
  createTableExportFormatOptions,
  type BatchTableExportMode,
} from './tableExportWorkbenchOptions';
import {
  DataExportColumnSelect,
  DEFAULT_XLSX_ROWS_PER_SHEET,
  MAX_XLSX_ROWS_PER_SHEET,
  resolveDataExportColumns,
  type DataExportFormat,
} from '../DataExportDialog';
import type { TableExportStateApi } from './hooks/useTableExportState';
import type { TableExportBatchTableActionsApi } from './hooks/useTableExportBatchTableActions';

export interface TableExportBatchTablesFieldsProps {
  secondaryTextColor: TableExportStateApi['secondaryTextColor'];
  connection: TableExportStateApi['connection'];
  selectedConnectionId: TableExportStateApi['selectedConnectionId'];
  isConfigurationLocked: TableExportBatchTableActionsApi['isConfigurationLocked'];
  connectionOptions: TableExportStateApi['connectionOptions'];
  setSelectedConnectionId: TableExportStateApi['setSelectedConnectionId'];
  setSelectedDbName: TableExportStateApi['setSelectedDbName'];
  setSelectedObjectNames: TableExportStateApi['setSelectedObjectNames'];
  setAvailableObjects: TableExportStateApi['setAvailableObjects'];
  setObjectLoadError: TableExportStateApi['setObjectLoadError'];
  syncBatchWorkbenchTabContext: TableExportStateApi['syncBatchWorkbenchTabContext'];
  selectedDbName: TableExportStateApi['selectedDbName'];
  loadingDatabases: TableExportStateApi['loadingDatabases'];
  availableDatabases: TableExportStateApi['availableDatabases'];
  availableObjects: TableExportStateApi['availableObjects'];
  selectedObjectNames: TableExportStateApi['selectedObjectNames'];
  loadingObjects: TableExportStateApi['loadingObjects'];
  isBatchExportIntent: TableExportStateApi['isBatchExportIntent'];
  batchTableMode: TableExportStateApi['batchTableMode'];
  setBatchTableMode: TableExportStateApi['setBatchTableMode'];
  batchTableModeMeta: TableExportStateApi['batchTableModeMeta'];
  format: TableExportStateApi['format'];
  setFormat: TableExportStateApi['setFormat'];
  supportsSqlFormat: boolean;
  batchTableColumnStates: TableExportStateApi['batchTableColumnStates'];
  setBatchTableSelectedColumns: TableExportStateApi['setBatchTableSelectedColumns'];
  xlsxMaxRowsPerSheet: TableExportStateApi['xlsxMaxRowsPerSheet'];
  setXlsxMaxRowsPerSheet: TableExportStateApi['setXlsxMaxRowsPerSheet'];
  includeDropIfExists: TableExportStateApi['includeDropIfExists'];
  setIncludeDropIfExists: TableExportStateApi['setIncludeDropIfExists'];
}

export const TableExportBatchTablesFields = ({
  secondaryTextColor, connection, selectedConnectionId, isConfigurationLocked, connectionOptions,
  setSelectedConnectionId, setSelectedDbName, setSelectedObjectNames, setAvailableObjects,
  setObjectLoadError, syncBatchWorkbenchTabContext, selectedDbName, loadingDatabases,
  availableDatabases, availableObjects, selectedObjectNames, loadingObjects, isBatchExportIntent,
  batchTableMode, setBatchTableMode, batchTableModeMeta, format, setFormat, supportsSqlFormat,
  batchTableColumnStates, setBatchTableSelectedColumns, xlsxMaxRowsPerSheet,
  setXlsxMaxRowsPerSheet, includeDropIfExists, setIncludeDropIfExists,
}: TableExportBatchTablesFieldsProps) => {
  const dataFileFormat = format !== 'sql';
  const formatOptions = createTableExportFormatOptions(supportsSqlFormat).map((option) => ({
    ...option,
    disabled: option.value !== 'sql' && selectedObjectNames.length !== 1,
  }));

  return (
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
          <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.label.format')}</div>
          <Select
            style={{ width: '100%' }}
            value={format}
            disabled={isConfigurationLocked}
            options={formatOptions}
            onChange={(next) => setFormat(next as DataExportFormat)}
          />
        </div>

        {!dataFileFormat ? (
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
          </>
        ) : null}

        {dataFileFormat || batchTableMode !== 'schema' ? (
          <div>
            <div style={{ marginBottom: 6, fontSize: 12, color: secondaryTextColor }}>{t('data_export.dialog.field.columns')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {selectedObjectNames.map((tableName) => {
                const columnState = batchTableColumnStates[tableName];
                return (
                  <div key={tableName} data-batch-table-columns={tableName}>
                    <div style={{ marginBottom: 4, fontSize: 12, color: secondaryTextColor }}>{tableName}</div>
                    <DataExportColumnSelect
                      availableColumns={columnState?.availableColumns || []}
                      value={columnState?.selectedColumns || []}
                      loading={columnState?.loading === true}
                      disabled={isConfigurationLocked}
                      onChange={(columns) => setBatchTableSelectedColumns(
                        tableName,
                        resolveDataExportColumns(columns, columnState?.availableColumns || []) || [],
                      )}
                    />
                    {columnState?.error ? (
                      <div style={{ marginTop: 4, fontSize: 12, color: 'var(--ant-color-error, #ff4d4f)' }}>
                        {columnState.error}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: secondaryTextColor }}>
              {t('data_export.dialog.field.columns_help')}
            </div>
          </div>
        ) : null}

        {dataFileFormat && selectedObjectNames.length === 1 && format === 'xlsx' ? (
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
    ) : (
      <Alert
        type="warning"
        showIcon
        message={t('data_export.workbench.intent.batch_tables_delete_description')}
      />
    )}
    </>
  );
};
