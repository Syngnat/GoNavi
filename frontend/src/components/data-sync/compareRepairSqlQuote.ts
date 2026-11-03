import { getDataSourceSpec } from '../../utils/dataSourceRegistry';

const PG_LIKE = new Set([
  'postgres',
  'postgresql',
  'kingbase',
  'highgo',
  'opengauss',
  'gaussdb',
  'vastbase',
]);

/** 归一化方言名：描述表类型按借用方言处理（CockroachDB → postgres）。 */
export const normalizeCompareDialect = (value: string): string => {
  const dialect = String(value || '').trim().toLowerCase();
  if (dialect === 'postgresql') return 'postgres';
  if (['mssql', 'sql_server', 'sql-server'].includes(dialect)) return 'sqlserver';
  return getDataSourceSpec(dialect)?.ddlDialect || dialect;
};

export const quoteCompareIdent = (name: string, dialect: string): string => {
  const normalized = normalizeCompareDialect(dialect);
  if (PG_LIKE.has(normalized)) return `"${String(name).replace(/"/g, '""')}"`;
  return `\`${String(name).replace(/`/g, '``')}\``;
};

export const qualifyCompareTable = (
  table: string,
  schema: string,
  dialect: string,
): string => {
  const quoted = quoteCompareIdent(table, dialect);
  const schemaName = String(schema || '').trim();
  return schemaName ? `${quoteCompareIdent(schemaName, dialect)}.${quoted}` : quoted;
};
