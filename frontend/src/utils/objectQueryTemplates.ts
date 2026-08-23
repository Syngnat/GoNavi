import { DBGetColumns } from '../../wailsjs/go/app/App';
import { getColumnDefinitionName } from './columnDefinition';
import { buildRpcConnectionConfig } from './connectionRpcConfig';
import { quoteIdentPart, quoteQualifiedIdent } from './sql';

const MESSAGE_QUEUE_DB_TYPES = new Set(['rocketmq', 'mqtt', 'kafka', 'rabbitmq']);

const isMessageQueueDbType = (dbType: string): boolean => (
  MESSAGE_QUEUE_DB_TYPES.has(String(dbType || '').trim().toLowerCase())
);

export const isElasticsearchDbType = (dbType: string): boolean => (
  ['elastic', 'elasticsearch'].includes(String(dbType || '').trim().toLowerCase())
);

export const extractTableSelectColumnNames = (columns: unknown): string[] => {
  if (!Array.isArray(columns)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const column of columns) {
    const name = getColumnDefinitionName(column);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
};

export const buildTableSelectQuery = (
  dbType: string,
  tableName: string,
  columns: string[] = [],
): string => {
  const normalizedTableName = String(tableName || '').trim();
  if (!normalizedTableName) {
    if (isElasticsearchDbType(dbType)) {
      return '';
    }
    return 'SELECT * FROM ';
  }

  if (isElasticsearchDbType(dbType)) {
    return `GET /${normalizedTableName}/_search\n{\n  "query": {\n    "match_all": {}\n  }\n}\n`;
  }

  const quotedTable = quoteQualifiedIdent(dbType, normalizedTableName);
  const limitSuffix = isMessageQueueDbType(dbType) ? ' LIMIT 100' : '';
  const normalizedColumns = columns
    .map((column) => String(column || '').trim())
    .filter(Boolean);

  if (normalizedColumns.length === 0) {
    return `SELECT * FROM ${quotedTable}${limitSuffix};`;
  }

  const selectList = normalizedColumns
    .map((column) => quoteIdentPart(dbType, column))
    .join(',\n  ');
  return `SELECT\n  ${selectList}\nFROM ${quotedTable}${limitSuffix};`;
};

type BuildContextualNewQueryTemplateOptions = {
  dbType: string;
  tableName: string;
  customTemplate?: string | null;
};

/**
 * Build the initial query for a new tab opened while a table-like data tab is active.
 * A custom template is only augmented when it explicitly ends at a FROM insertion point.
 */
export const buildContextualNewQueryTemplate = ({
  dbType,
  tableName,
  customTemplate,
}: BuildContextualNewQueryTemplateOptions): string | null => {
  const normalizedTableName = String(tableName || '').trim();
  if (!normalizedTableName) return null;
  if (isElasticsearchDbType(dbType) || customTemplate === null || customTemplate === undefined) {
    return buildTableSelectQuery(dbType, normalizedTableName);
  }

  const template = String(customTemplate)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  if (!/\bfrom\s*$/i.test(template)) return null;
  return `${template}${quoteQualifiedIdent(dbType, normalizedTableName)}`;
};

type ResolveTableSelectQueryOptions = {
  dbType: string;
  tableName: string;
  dbName?: string;
  connectionConfig?: unknown;
};

/**
 * Build a SELECT template for "new query" from a table/view.
 * Prefers expanding all column names; falls back to SELECT * when metadata is unavailable.
 */
export const resolveTableSelectQuery = async ({
  dbType,
  tableName,
  dbName = '',
  connectionConfig,
}: ResolveTableSelectQueryOptions): Promise<string> => {
  const normalizedTableName = String(tableName || '').trim();
  if (!normalizedTableName) {
    return buildTableSelectQuery(dbType, normalizedTableName);
  }

  // Message-queue "tables" are topics/queues; column expansion is not meaningful.
  if (isElasticsearchDbType(dbType) || isMessageQueueDbType(dbType) || !connectionConfig) {
    return buildTableSelectQuery(dbType, normalizedTableName);
  }

  try {
    const res = await DBGetColumns(
      buildRpcConnectionConfig(connectionConfig as any) as any,
      String(dbName || ''),
      normalizedTableName,
    );
    if (res?.success && Array.isArray(res.data)) {
      const columnNames = extractTableSelectColumnNames(res.data);
      if (columnNames.length > 0) {
        return buildTableSelectQuery(dbType, normalizedTableName, columnNames);
      }
    }
  } catch {
    // Fall back to SELECT * when metadata lookup fails.
  }

  return buildTableSelectQuery(dbType, normalizedTableName);
};
