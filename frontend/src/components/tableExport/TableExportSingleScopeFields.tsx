import { Select, Checkbox, Alert, InputNumber } from 'antd';
import { t } from '../../i18n';
import type { TableExportScope } from '../../types';
import { createTableExportFormatOptions } from './tableExportWorkbenchOptions';
import {
  type DataExportFormat,
  DataExportColumnSelect,
  resolveDataExportColumns,
  MAX_XLSX_ROWS_PER_SHEET,
  DEFAULT_XLSX_ROWS_PER_SHEET,
} from '../DataExportDialog';
import type { TableExportStateApi } from './hooks/useTableExportState';
import type { TableExportBatchTableActionsApi } from './hooks/useTableExportBatchTableActions';

export interface TableExportSingleScopeFieldsProps {
  secondaryTextColor: TableExportStateApi['secondaryTextColor'];
  scope: TableExportStateApi['scope'];
  isConfigurationLocked: TableExportBatchTableActionsApi['isConfigurationLocked'];
  scopeOptions: TableExportStateApi['scopeOptions'];
  setScope: TableExportStateApi['setScope'];
  activeScopeOption: TableExportStateApi['activeScopeOption'];
  format: TableExportStateApi['format'];
  setFormat: TableExportStateApi['setFormat'];
  activeScopeQuery: TableExportStateApi['activeScopeQuery'];
  includeDropIfExists: TableExportStateApi['includeDropIfExists'];
  setIncludeDropIfExists: TableExportStateApi['setIncludeDropIfExists'];
  availableColumns: TableExportStateApi['availableColumns'];
  selectedColumns: TableExportStateApi['selectedColumns'];
  loadingColumns: TableExportStateApi['loadingColumns'];
  setSelectedColumns: TableExportStateApi['setSelectedColumns'];
  xlsxMaxRowsPerSheet: TableExportStateApi['xlsxMaxRowsPerSheet'];
  setXlsxMaxRowsPerSheet: TableExportStateApi['setXlsxMaxRowsPerSheet'];
  supportsSqlFormat?: boolean;
}

export const TableExportSingleScopeFields = ({
  secondaryTextColor, scope, isConfigurationLocked, scopeOptions, setScope, activeScopeOption,
  format, setFormat, activeScopeQuery, includeDropIfExists, setIncludeDropIfExists,
  availableColumns, selectedColumns, loadingColumns, setSelectedColumns, xlsxMaxRowsPerSheet,
  setXlsxMaxRowsPerSheet, supportsSqlFormat = true,
}: TableExportSingleScopeFieldsProps) => (
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
        options={createTableExportFormatOptions(supportsSqlFormat)}
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
        <DataExportColumnSelect
          availableColumns={availableColumns}
          value={selectedColumns}
          loading={loadingColumns}
          disabled={isConfigurationLocked}
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
);
