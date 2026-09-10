import Modal from './common/ResizableDraggableModal';
import React, { useEffect, useMemo, useState } from 'react';
import { Button, Form, InputNumber, Select, message } from 'antd';
import { ExportOutlined } from '@ant-design/icons';
import { t } from '../i18n';

export type DataExportFormat = 'csv' | 'xlsx' | 'json' | 'md' | 'html' | 'sql';
export type DataExportScope = 'selected' | 'page' | 'all' | 'filteredAll';

export type DataExportFileOptions = {
  format: DataExportFormat;
  columns?: string[];
  xlsxMaxRowsPerSheet?: number;
  insertSQLDialect?: string;
  insertSQLTargetTable?: string;
  insertSQLColumnTypes?: Record<string, string>;
  insertSQLTargetColumns?: Record<string, string>;
  insertSQLAllowEmptyTargetTable?: boolean;
};

export type DataExportDialogValues = DataExportFileOptions & {
  scope: DataExportScope | string;
};

export type DataExportScopeOption = {
  value: DataExportScope | string;
  label: string;
  description?: string;
  disabled?: boolean;
};

export type ShowDataExportDialogOptions = {
  title: string;
  scopeOptions: DataExportScopeOption[];
  availableColumns?: string[];
  initialValues?: Partial<DataExportDialogValues>;
  allowInsertSql?: boolean;
  okText?: string;
};

export const MAX_XLSX_ROWS_PER_SHEET = 1048575;
export const DEFAULT_XLSX_ROWS_PER_SHEET = MAX_XLSX_ROWS_PER_SHEET;
export const DEFAULT_DATA_EXPORT_FORMAT: DataExportFormat = 'xlsx';

export const DATA_EXPORT_FORMAT_OPTIONS: Array<{ value: DataExportFormat; label: string }> = [
  { value: 'xlsx', label: 'Excel (XLSX)' },
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' },
  { value: 'md', label: 'Markdown' },
  { value: 'html', label: 'HTML' },
];

export const INSERT_SQL_EXPORT_FORMAT_OPTION: { value: DataExportFormat; label: string } = {
  value: 'sql',
  label: 'INSERT SQL',
};

const resolveFormatOptions = (allowInsertSql: boolean): Array<{ value: DataExportFormat; label: string }> => (
  allowInsertSql
    ? [...DATA_EXPORT_FORMAT_OPTIONS, INSERT_SQL_EXPORT_FORMAT_OPTION]
    : DATA_EXPORT_FORMAT_OPTIONS
);

const resolveDefaultScope = (scopeOptions: DataExportScopeOption[], initialScope?: string): string => {
  const matchedInitial = scopeOptions.find((item) => item.value === initialScope && !item.disabled);
  if (matchedInitial) return String(matchedInitial.value);
  const firstEnabled = scopeOptions.find((item) => !item.disabled);
  return String(firstEnabled?.value || scopeOptions[0]?.value || 'all');
};

export const resolveDataExportColumns = (
  requestedColumns: string[] | undefined,
  availableColumns: string[] | undefined,
): string[] | undefined => {
  if (!Array.isArray(availableColumns)) return undefined;

  const seenAvailable = new Set<string>();
  const normalizedAvailable = availableColumns.filter((column) => {
    const value = String(column ?? '');
    if (!value.trim() || seenAvailable.has(value)) return false;
    seenAvailable.add(value);
    return true;
  });
  if (requestedColumns === undefined) return normalizedAvailable;

  const requested = new Set(requestedColumns.map((column) => String(column ?? '')));
  return normalizedAvailable.filter((column) => requested.has(column));
};

export const normalizeDataExportDialogValues = (
  scopeOptions: DataExportScopeOption[],
  initialValues?: Partial<DataExportDialogValues>,
  allowInsertSql = false,
  availableColumns?: string[],
): DataExportDialogValues => {
  const requestedFormat = (initialValues?.format || DEFAULT_DATA_EXPORT_FORMAT) as DataExportFormat;
  const format = resolveFormatOptions(allowInsertSql).some((item) => item.value === requestedFormat)
    ? requestedFormat
    : DEFAULT_DATA_EXPORT_FORMAT;
  const scope = resolveDefaultScope(scopeOptions, initialValues?.scope ? String(initialValues.scope) : undefined);
  const xlsxMaxRowsPerSheet = Number(initialValues?.xlsxMaxRowsPerSheet) > 0
    ? Math.min(MAX_XLSX_ROWS_PER_SHEET, Math.trunc(Number(initialValues?.xlsxMaxRowsPerSheet)))
    : DEFAULT_XLSX_ROWS_PER_SHEET;
  const columns = resolveDataExportColumns(initialValues?.columns, availableColumns);
  return {
    format,
    scope,
    xlsxMaxRowsPerSheet,
    ...(columns === undefined ? {} : { columns }),
  };
};

export const validateDataExportDialogValues = (
  values: DataExportDialogValues,
  scopeOptions: DataExportScopeOption[],
  allowInsertSql = false,
  availableColumns?: string[],
): string | null => {
  if (!resolveFormatOptions(allowInsertSql).some((item) => item.value === values.format)) {
    return t('data_export.dialog.validation.format_required');
  }
  if (scopeOptions.length > 0) {
    const matchedScope = scopeOptions.find((item) => String(item.value) === String(values.scope));
    if (!matchedScope || matchedScope.disabled) {
      return t('data_export.dialog.validation.scope_required');
    }
  }
  if (Array.isArray(availableColumns) && (!Array.isArray(values.columns) || values.columns.length === 0)) {
    return t('data_export.dialog.validation.columns_required');
  }
  if (values.format === 'xlsx') {
    const rows = Math.trunc(Number(values.xlsxMaxRowsPerSheet) || 0);
    if (!Number.isFinite(rows) || rows <= 0) {
      return t('data_export.dialog.validation.xlsx_max_rows_required');
    }
    if (rows > MAX_XLSX_ROWS_PER_SHEET) {
      return t('data_export.dialog.validation.xlsx_max_rows_limit', {
        maxRows: MAX_XLSX_ROWS_PER_SHEET.toLocaleString(),
      });
    }
  }
  return null;
};

export type DataExportColumnSelectProps = {
  availableColumns: string[];
  value: string[];
  disabled?: boolean;
  loading?: boolean;
  onChange: (columns: string[]) => void;
};

export const DataExportColumnSelect: React.FC<DataExportColumnSelectProps> = ({
  availableColumns,
  value,
  disabled = false,
  loading = false,
  onChange,
}) => {
  const normalizedColumns = useMemo(
    () => resolveDataExportColumns(undefined, availableColumns) || [],
    [availableColumns],
  );
  const selectedColumns = useMemo(() => {
    const seen = new Set<string>();
    return value
      .map((column) => String(column ?? ''))
      .filter((column) => {
        if (!column.trim() || seen.has(column)) return false;
        seen.add(column);
        return true;
      });
  }, [value]);
  const selectedColumnSet = useMemo(() => new Set(selectedColumns), [selectedColumns]);
  const totalColumns = useMemo(
    () => new Set([...normalizedColumns, ...selectedColumns]).size,
    [normalizedColumns, selectedColumns],
  );
  const allSelected = normalizedColumns.length > 0
    && normalizedColumns.every((column) => selectedColumnSet.has(column));

  return (
    <div data-export-column-selector="true">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          minHeight: 28,
          marginBottom: 4,
        }}
      >
        <span
          data-export-column-selection-count="true"
          aria-live="polite"
          style={{ color: 'var(--ant-color-text-secondary, rgba(0,0,0,0.45))', fontSize: 12 }}
        >
          {t('data_export.dialog.field.columns_selected', {
            selected: selectedColumns.length,
            total: totalColumns,
          })}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <Button
            type="text"
            size="small"
            data-export-columns-select-all="true"
            disabled={disabled || loading || normalizedColumns.length === 0 || allSelected}
            onClick={() => onChange(normalizedColumns)}
          >
            {t('data_export.action.select_all')}
          </Button>
          <Button
            type="text"
            size="small"
            data-export-columns-clear="true"
            disabled={disabled || loading || selectedColumns.length === 0}
            onClick={() => onChange([])}
          >
            {t('data_export.action.clear')}
          </Button>
        </div>
      </div>
      <Select
        aria-label={t('data_export.dialog.field.columns')}
        style={{ width: '100%' }}
        mode="multiple"
        value={selectedColumns}
        loading={loading}
        disabled={disabled}
        options={normalizedColumns.map((column) => ({ value: column, label: column }))}
        placeholder={t('data_export.dialog.field.columns_placeholder')}
        showSearch
        optionFilterProp="label"
        maxTagCount="responsive"
        onChange={(columns) => onChange(resolveDataExportColumns(columns, normalizedColumns) || [])}
      />
    </div>
  );
};

const DataExportDialogContent: React.FC<{
  scopeOptions: DataExportScopeOption[];
  availableColumns?: string[];
  initialValues?: Partial<DataExportDialogValues>;
  allowInsertSql?: boolean;
  onChange: (values: DataExportDialogValues) => void;
}> = ({ scopeOptions, availableColumns, initialValues, allowInsertSql = false, onChange }) => {
  const [values, setValues] = useState<DataExportDialogValues>(() => normalizeDataExportDialogValues(
    scopeOptions,
    initialValues,
    allowInsertSql,
    availableColumns,
  ));
  const formatOptions = useMemo(() => resolveFormatOptions(allowInsertSql), [allowInsertSql]);
  useEffect(() => {
    onChange(values);
  }, [onChange, values]);

  const selectedScope = useMemo(
    () => scopeOptions.find((item) => String(item.value) === String(values.scope)),
    [scopeOptions, values.scope],
  );

  return (
    <div data-export-config-modal="true">
      <Form layout="vertical" colon={false}>
        <Form.Item label={t('data_export.dialog.field.format')} style={{ marginBottom: 16 }}>
          <Select
            value={values.format}
            options={formatOptions}
            onChange={(format) => setValues((prev) => ({ ...prev, format: format as DataExportFormat }))}
          />
        </Form.Item>

        <Form.Item label={t('data_export.dialog.field.scope')} style={{ marginBottom: 8 }}>
          <Select
            value={values.scope}
            disabled={scopeOptions.length <= 1}
            options={scopeOptions.map((item) => ({
              value: item.value,
              label: item.label,
              disabled: item.disabled,
            }))}
            onChange={(scope) => setValues((prev) => ({ ...prev, scope }))}
          />
        </Form.Item>

        {selectedScope?.description && (
          <div style={{ marginBottom: 16, color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>
            {selectedScope.description}
          </div>
        )}

        {Array.isArray(availableColumns) && (
          <Form.Item
            label={t('data_export.dialog.field.columns')}
            extra={t('data_export.dialog.field.columns_help')}
            style={{ marginBottom: 16 }}
          >
            <DataExportColumnSelect
              availableColumns={availableColumns}
              value={values.columns || []}
              onChange={(columns) => setValues((prev) => ({
                ...prev,
                columns: resolveDataExportColumns(columns, availableColumns) || [],
              }))}
            />
          </Form.Item>
        )}

        {values.format === 'xlsx' && (
          <Form.Item
            label={t('data_export.dialog.field.xlsx_max_rows')}
            extra={t('data_export.dialog.field.xlsx_max_rows_help', {
              maxRows: MAX_XLSX_ROWS_PER_SHEET.toLocaleString(),
            })}
            style={{ marginBottom: 0 }}
          >
            <InputNumber
              min={1}
              max={MAX_XLSX_ROWS_PER_SHEET}
              step={100000}
              style={{ width: '100%' }}
              value={values.xlsxMaxRowsPerSheet}
              onChange={(nextValue) => setValues((prev) => ({
                ...prev,
                xlsxMaxRowsPerSheet: Number(nextValue) > 0
                  ? Math.min(MAX_XLSX_ROWS_PER_SHEET, Math.trunc(Number(nextValue)))
                  : 0,
              }))}
            />
          </Form.Item>
        )}
      </Form>
    </div>
  );
};

export async function showDataExportDialog(
  modal: ReturnType<typeof Modal.useModal>[0],
  options: ShowDataExportDialogOptions,
): Promise<DataExportDialogValues | null> {
  const allowInsertSql = options.allowInsertSql === true;
  const initialValues = normalizeDataExportDialogValues(
    options.scopeOptions,
    options.initialValues,
    allowInsertSql,
    options.availableColumns,
  );

  return new Promise((resolve) => {
    let resolved = false;
    let latestValues = initialValues;

    const finish = (nextValue: DataExportDialogValues | null) => {
      if (resolved) return;
      resolved = true;
      resolve(nextValue);
    };

    modal.confirm({
      title: options.title,
      icon: <ExportOutlined />,
      width: 520,
      centered: true,
      maskClosable: true,
      okText: options.okText || t('data_export.dialog.action.start'),
      cancelText: t('common.cancel'),
      content: (
        <DataExportDialogContent
          scopeOptions={options.scopeOptions}
          availableColumns={options.availableColumns}
          initialValues={initialValues}
          allowInsertSql={allowInsertSql}
          onChange={(values) => {
            latestValues = values;
          }}
        />
      ),
      onOk: async () => {
        const errorMessage = validateDataExportDialogValues(
          latestValues,
          options.scopeOptions,
          allowInsertSql,
          options.availableColumns,
        );
        if (errorMessage) {
          void message.error(errorMessage);
          throw new Error(errorMessage);
        }
        finish(latestValues);
      },
      onCancel: () => {
        finish(null);
      },
    });
  });
}
