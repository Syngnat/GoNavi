import type { DataSyncUnmigratedIndex, DataSyncValidationIssue } from './model';

export type DataSyncPreflightIndexItem = DataSyncUnmigratedIndex & {
  mappingId?: string;
};

const singleLine = (value: string): string =>
  String(value || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();

export const collectDataSyncPreflightIndexes = (
  issues: DataSyncValidationIssue[],
): DataSyncPreflightIndexItem[] =>
  issues.flatMap((issue) => {
    const index = issue.detail?.unmigratedIndex;
    return issue.code === 'unmigrated_index' && index
      ? [{ ...index, columns: Array.isArray(index.columns) ? index.columns : [], mappingId: issue.mappingId }]
      : [];
  });

const copyableStatement = (value: string): string => {
  const statement = value.trim();
  try {
    const parsed = JSON.parse(statement);
    if (parsed && typeof parsed === 'object') return statement;
  } catch {
    // SQL statements are not JSON and use a trailing semicolon below.
  }
  return statement.endsWith(';') ? statement : `${statement};`;
};

export const buildDataSyncPreflightRemediationSQL = (
  indexes: DataSyncPreflightIndexItem[],
): string =>
  indexes
    .flatMap((index) => {
      const statements = (Array.isArray(index.remediationStatements) ? index.remediationStatements : [])
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map(copyableStatement);
      return statements.length > 0
        ? [`-- ${singleLine(index.name)}: ${singleLine(index.reason)}`, ...statements]
        : [];
    })
    .join('\n\n');

export const formatDataSyncPreflightIndexColumns = (
  columns: DataSyncUnmigratedIndex['columns'],
): string =>
  (Array.isArray(columns) ? columns : [])
    .map((column) =>
      column.prefixLength && column.prefixLength > 0
        ? `${column.name}(${column.prefixLength})`
        : column.name,
    )
    .join(', ');
