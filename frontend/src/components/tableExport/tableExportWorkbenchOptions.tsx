import React from 'react';
import { Typography } from 'antd';
import type {
  TableExportHistoryEntry,
  TabData,
  TableExportScopeOption,
  TableExportScope,
  SavedConnection,
} from '../../types';
import { getColumnDefinitionName } from '../../utils/columnDefinition';
import { t } from '../../i18n';
import { type DataExportFormat, DATA_EXPORT_FORMAT_OPTIONS } from '../DataExportDialog';

export const { Text, Paragraph, Title } = Typography;
export const EMPTY_HISTORY: TableExportHistoryEntry[] = [];
// includeSql 为 false 时不提供 SQL 格式：非 SQL 数据源生成的 INSERT 无法回灌。
export const createTableExportFormatOptions = (includeSql = true): Array<{ value: DataExportFormat; label: string }> => [
  ...DATA_EXPORT_FORMAT_OPTIONS,
  ...(includeSql ? [{ value: 'sql' as DataExportFormat, label: t('data_export.label.sql_file') }] : []),
];

export type ExportWorkbenchMode = NonNullable<TabData['exportWorkbenchMode']>;
export type BatchTableExportMode = 'schema' | 'dataOnly' | 'backup';
export type BatchDatabaseExportMode = 'schema' | 'backup';
export type BatchWorkbenchIntent = 'export' | 'delete';
export type BatchDestructiveOperation = 'truncate-tables' | 'clear-tables' | 'delete-tables' | 'delete-databases';
export type SelectOption = { value: string; label: React.ReactNode; title: string; objectType?: 'table' | 'view' };

export type BatchWorkbenchObject = {
  name: string;
  objectType: 'table' | 'view';
};

const createDefaultScopeOptions = (): TableExportScopeOption[] => [
  {
    value: 'all',
    label: t('data_export.workbench.scope.all.label'),
    description: t('data_export.workbench.scope.all.description'),
  },
];

const SELECT_ELLIPSIS_LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  width: '100%',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export const createBatchTableExportModeOptions = (): Array<{ value: BatchTableExportMode; label: string; description: string }> => [
  {
    value: 'schema',
    label: t('data_export.workbench.batch_tables.mode.schema.label'),
    description: t('data_export.workbench.batch_tables.mode.schema.description'),
  },
  {
    value: 'dataOnly',
    label: t('data_export.workbench.batch_tables.mode.data_only.label'),
    description: t('data_export.workbench.batch_tables.mode.data_only.description'),
  },
  {
    value: 'backup',
    label: t('data_export.workbench.batch_tables.mode.backup.label'),
    description: t('data_export.workbench.batch_tables.mode.backup.description'),
  },
];

export const createBatchDatabaseExportModeOptions = (): Array<{ value: BatchDatabaseExportMode; label: string; description: string }> => [
  {
    value: 'schema',
    label: t('data_export.workbench.batch_databases.mode.schema.label'),
    description: t('data_export.workbench.batch_databases.mode.schema.description'),
  },
  {
    value: 'backup',
    label: t('data_export.workbench.batch_databases.mode.backup.label'),
    description: t('data_export.workbench.batch_databases.mode.backup.description'),
  },
];

export const normalizeScopeOptions = (input: TabData['tableExportScopeOptions']): TableExportScopeOption[] => {
  if (!Array.isArray(input) || input.length === 0) {
    return createDefaultScopeOptions();
  }
  return input;
};

export const resolveInitialScope = (
  scopeOptions: TableExportScopeOption[],
  preferred?: TableExportScope,
): TableExportScope => {
  if (preferred && scopeOptions.some((item) => item.value === preferred && !item.disabled)) {
    return preferred;
  }
  return scopeOptions.find((item) => !item.disabled)?.value || 'all';
};

export const resolveTableExportColumnNames = (definitions: unknown): string[] => {
  if (!Array.isArray(definitions)) return [];
  const seen = new Set<string>();
  const columns: string[] = [];
  definitions.forEach((definition) => {
    const column = getColumnDefinitionName(definition);
    if (!column || seen.has(column)) return;
    seen.add(column);
    columns.push(column);
  });
  return columns;
};

export const normalizeConnectionConfig = (connection: SavedConnection) => ({
  ...connection.config,
  port: Number(connection.config.port),
  password: connection.config.password || '',
  database: connection.config.database || '',
  useSSH: connection.config.useSSH || false,
  ssh: connection.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
});

export const formatDateTime = (timestamp: number): string => {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
};

export const resolveWorkbenchMode = (tab: TabData): ExportWorkbenchMode => tab.exportWorkbenchMode || 'single';

export const resolveObjectTypeLabel = (objectType?: TabData['objectType']): string => {
  if (objectType === 'view') return t('data_export.workbench.object_type.view');
  if (objectType === 'materialized-view') return t('data_export.workbench.object_type.materialized_view');
  return t('data_export.workbench.object_type.table');
};

export const renderSelectLabel = (text: string): React.ReactNode => (
  <span title={text} style={SELECT_ELLIPSIS_LABEL_STYLE}>
    {text}
  </span>
);

export const toSortedSelectOptions = (values: string[]): SelectOption[] =>
  values
    .filter((value) => String(value || '').trim())
    .map((value) => ({
      value: String(value).trim(),
      label: renderSelectLabel(String(value).trim()),
      title: String(value).trim(),
    }))
    .sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
