import { message } from 'antd';
import { ColumnDefinition } from '../../types';
import { GONAVI_ROW_KEY } from '../DataGrid';
import type { EditRowLocator } from '../../utils/rowLocator';
import { getColumnDefinitionName } from '../../utils/columnDefinition';
import type { DataViewerTranslator } from './dataViewerTotals';

const buildDataViewerReadOnlyLocator = (reason: string): EditRowLocator => ({
  strategy: 'none',
  columns: [],
  valueColumns: [],
  readOnly: true,
  reason,
});

const READ_ONLY_REASON_NO_SAFE_LOCATOR = '\u672a\u68c0\u6d4b\u5230\u4e3b\u952e\u6216\u53ef\u7528\u552f\u4e00\u7d22\u5f15\uff0c\u65e0\u6cd5\u5b89\u5168\u63d0\u4ea4\u4fee\u6539\u3002';
const READ_ONLY_REASON_ORACLE_ROWID_MISSING = '\u672a\u68c0\u6d4b\u5230\u4e3b\u952e\u6216\u53ef\u7528\u552f\u4e00\u7d22\u5f15\uff0c\u4e14\u7ed3\u679c\u4e2d\u7f3a\u5c11 Oracle ROWID\uff0c\u65e0\u6cd5\u5b89\u5168\u63d0\u4ea4\u4fee\u6539\u3002';
const READ_ONLY_REASON_PRIMARY_KEY_MISSING_PREFIX = '\u7ed3\u679c\u96c6\u4e2d\u7f3a\u5c11\u4e3b\u952e\u5217 ';
const READ_ONLY_REASON_SAFE_SUBMIT_SUFFIX = '\uff0c\u65e0\u6cd5\u5b89\u5168\u63d0\u4ea4\u4fee\u6539\u3002';

const localizeDataViewerReadOnlyReason = (reason: string | undefined, tr: DataViewerTranslator): string => {
  const text = String(reason || '').trim();
  if (!text) return tr('data_viewer.read_only.reason.no_safe_locator');
  if (text === READ_ONLY_REASON_NO_SAFE_LOCATOR) {
    return tr('data_viewer.read_only.reason.no_safe_locator');
  }
  if (text === READ_ONLY_REASON_ORACLE_ROWID_MISSING) {
    return tr('data_viewer.read_only.reason.oracle_rowid_missing');
  }
  if (text.startsWith(READ_ONLY_REASON_PRIMARY_KEY_MISSING_PREFIX) && text.endsWith(READ_ONLY_REASON_SAFE_SUBMIT_SUFFIX)) {
    const columns = text.slice(READ_ONLY_REASON_PRIMARY_KEY_MISSING_PREFIX.length, -READ_ONLY_REASON_SAFE_SUBMIT_SUFFIX.length);
    return tr('data_viewer.read_only.reason.primary_key_column_missing', { columns });
  }
  return text;
};

export const localizeDataViewerReadOnlyLocator = (locator: EditRowLocator, tr: DataViewerTranslator): EditRowLocator => {
  if (!locator.readOnly) return locator;
  return { ...locator, reason: localizeDataViewerReadOnlyReason(locator.reason, tr) };
};

export const warnDataViewerReadOnly = (
  kind: 'table' | 'collection',
  target: string,
  reason: string | undefined,
  tr: DataViewerTranslator,
) => {
  const key = kind === 'table'
    ? 'data_viewer.read_only.warning.table'
    : 'data_viewer.read_only.warning.collection';
  message.warning(tr(key, {
    target,
    reason: localizeDataViewerReadOnlyReason(reason, tr),
  }));
};

export const formatDataViewerTableName = (dbName: string, tableName: string): string => (
  dbName ? `${dbName}.${tableName}` : tableName
);

export const getTableColumnNames = (columns: ColumnDefinition[] | undefined): string[] => (
  (columns || [])
    .map(getColumnDefinitionName)
    .filter(Boolean)
);

export const MONGODB_ID_COLUMN = '_id';
const MONGODB_ID_LOCATOR_COLUMN = '__gonavi_mongodb_id_locator__';

export const buildMongoDataViewerEditLocator = (resultColumns: string[], tr: DataViewerTranslator): EditRowLocator => {
  const columns = (resultColumns || [])
    .map((column) => String(column || '').trim())
    .filter(Boolean);
  const idColumn = columns.find((column) => column.toLowerCase() === MONGODB_ID_COLUMN);
  if (!idColumn) {
    return buildDataViewerReadOnlyLocator(tr('data_viewer.read_only.reason.mongo_id_missing'));
  }

  const locatorValueColumn = columns.find((column) => column === MONGODB_ID_LOCATOR_COLUMN) || idColumn;
  const writableColumns: Record<string, string> = {};
  columns.forEach((column) => {
    const normalized = String(column || '').trim();
    if (
      !normalized ||
      normalized === GONAVI_ROW_KEY ||
      normalized === MONGODB_ID_LOCATOR_COLUMN ||
      normalized.toLowerCase() === MONGODB_ID_COLUMN
    ) return;
    writableColumns[normalized] = normalized;
  });

  return {
    strategy: 'primary-key',
    columns: [MONGODB_ID_COLUMN],
    valueColumns: [locatorValueColumn],
    hiddenColumns: locatorValueColumn === MONGODB_ID_LOCATOR_COLUMN ? [MONGODB_ID_LOCATOR_COLUMN] : undefined,
    writableColumns,
    readOnly: false,
  };
};
