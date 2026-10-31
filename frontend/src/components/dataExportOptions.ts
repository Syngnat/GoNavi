import { t } from '../i18n';
import { isPluginExporterNamespace, parsePluginExporterFormat } from '../plugins/exporter/identity';
import { validExporterPin } from '../plugins/exporter/validation';
import type { ConfirmedPluginExport, FrozenExportSnapshot, PluginExporterPin } from '../plugins/exporter/types';

export const DATA_EXPORT_CSV_ENCODINGS = ['utf-8', 'utf-8-bom', 'gbk', 'gb18030', 'utf-16le'] as const;
export type DataExportCSVEncoding = typeof DATA_EXPORT_CSV_ENCODINGS[number];
export const DEFAULT_DATA_EXPORT_CSV_ENCODING: DataExportCSVEncoding = 'utf-8-bom';

export type DataExportFormat = 'csv' | 'xlsx' | 'json' | 'md' | 'html' | 'sql' | 'parquet' | (string & {});
export type DataExportScope = 'selected' | 'page' | 'all' | 'filteredAll';

export type DataExportFileOptions = {
  format: DataExportFormat;
  pluginExporter?: PluginExporterPin;
  confirmedPluginExport?: ConfirmedPluginExport;
  csvEncoding?: DataExportCSVEncoding;
  columns?: string[];
  useColumnComments?: boolean;
  columnComments?: Record<string, string>;
  xlsxMaxRowsPerSheet?: number;
  insertSQLDialect?: string;
  insertSQLTargetTable?: string;
  insertSQLColumnTypes?: Record<string, string>;
  insertSQLTargetColumns?: Record<string, string>;
  insertSQLAllowEmptyTargetTable?: boolean;
  losslessHive?: boolean;
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
  allowColumnCommentHeaders?: boolean;
  okText?: string;
  preparePluginSnapshot?: (values: DataExportDialogValues, streaming?: boolean) => FrozenExportSnapshot;
};

export const MAX_XLSX_ROWS_PER_SHEET = 1048575;
export const DEFAULT_XLSX_ROWS_PER_SHEET = MAX_XLSX_ROWS_PER_SHEET;
export const DEFAULT_DATA_EXPORT_FORMAT: DataExportFormat = 'xlsx';

export const DATA_EXPORT_FORMAT_OPTIONS: Array<{ value: DataExportFormat; label: string }> = [
  { value: 'xlsx', label: 'Excel (XLSX)' },
  { value: 'csv', label: 'CSV' },
  { value: 'parquet', get label() { return t('data_export.format.parquet'); } },
  { value: 'json', label: 'JSON' },
  { value: 'md', label: 'Markdown' },
  { value: 'html', label: 'HTML' },
];

export const INSERT_SQL_EXPORT_FORMAT_OPTION: { value: DataExportFormat; label: string } = {
  value: 'sql',
  label: 'INSERT SQL',
};

export const resolveDataExportFormatOptions = (allowInsertSql: boolean): Array<{ value: DataExportFormat; label: string }> => (
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
  if (isPluginExporterNamespace(requestedFormat) || initialValues?.pluginExporter !== undefined) return {
    format: requestedFormat, scope: initialValues?.scope ?? resolveDefaultScope(scopeOptions),
    pluginExporter: initialValues?.pluginExporter, columns: initialValues?.columns === undefined ? availableColumns : [...initialValues.columns],
  };
  const format = resolveDataExportFormatOptions(allowInsertSql).some((item) => item.value === requestedFormat)
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
    csvEncoding: initialValues?.csvEncoding || DEFAULT_DATA_EXPORT_CSV_ENCODING,
    ...(columns === undefined ? {} : { columns }),
    ...(initialValues?.useColumnComments === true ? { useColumnComments: true } : {}),
  };
};

export const validateDataExportDialogValues = (
  values: DataExportDialogValues,
  scopeOptions: DataExportScopeOption[],
  allowInsertSql = false,
  availableColumns?: string[],
  allowPluginExporter = false,
): string | null => {
  if (isPluginExporterNamespace(values.format) || values.pluginExporter !== undefined) {
    if (!allowPluginExporter || !['selected', 'page'].includes(String(values.scope))) return t('plugin.exporter.error.scope');
    if (!parsePluginExporterFormat(values.format) || !validExporterPin(values.pluginExporter)) return t('plugin.exporter.error.selection');
    const scope = scopeOptions.find((item) => item.value === values.scope);
    if (!scope || scope.disabled || !values.columns?.length || values.columns.length > 256 || new Set(values.columns).size !== values.columns.length
      || values.columns.some((column) => !availableColumns?.includes(column))) return t('plugin.exporter.error.snapshot');
    return null;
  }
  if (!resolveDataExportFormatOptions(allowInsertSql).some((item) => item.value === values.format)) {
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
  if (values.format === 'csv' && !DATA_EXPORT_CSV_ENCODINGS.includes(values.csvEncoding || DEFAULT_DATA_EXPORT_CSV_ENCODING)) {
    return t('data_export.dialog.validation.csv_encoding_required');
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

export const resolveDataExportFileOptions = <T extends DataExportFileOptions>(values: T): T => {
  if (isPluginExporterNamespace(values.format) || values.pluginExporter !== undefined) return {
    format: values.format, columns: values.columns, pluginExporter: values.pluginExporter,
    ...('scope' in values ? { scope: values.scope } : {}),
  } as T;
  const { csvEncoding, ...options } = values;
  return {
    ...options,
    ...(values.format === 'csv' ? { csvEncoding: csvEncoding || DEFAULT_DATA_EXPORT_CSV_ENCODING } : {}),
  } as T;
};
