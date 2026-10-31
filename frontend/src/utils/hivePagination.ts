import { t } from '../i18n';
import { assertHiveCountProjection, resolveHiveResultProjection, rewriteHiveResultOrder } from './hiveResultProjection';
import { findCteBodyStart, getLeadingKeyword, findTopLevelKeyword, splitSqlTail } from './sqlQueryStructure';

const quote = (name: string): string => '\x60' + name.replace(/\x60/g, '\x60\x60') + '\x60';

// Hive 1/2/3/4 and HS2-compatible engines have no shared OFFSET syntax.
// A known output projection keeps the internal row number out of grids/exports.
export const buildHivePageSQL = (
  base: string, orderBy: string, limit: number, offset: number, columns?: readonly string[], outputLabels?: readonly string[],
): string => {
  if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + limit)) throw new Error(t('connection.modal.hive.invalidOptions', { option: 'pagination' }));
  if (offset <= 0 && !outputLabels) return base + orderBy + ' LIMIT ' + limit;
  if (!columns?.length) throw new Error(t('hive.pagination.columnsRequired'));
  const names = new Set(columns.map(column => column.toLowerCase()));
  if (names.size !== columns.length || columns.some(column => !column.trim())) throw new Error(t('hive.pagination.ambiguousColumns'));
  let rowNumber = '__gonavi_hive_rn__';
  while (names.has(rowNumber.toLowerCase())) rowNumber += '_';
  const rn = quote(rowNumber);
  if (outputLabels && outputLabels.length !== columns.length) throw new Error(t('hive.pagination.ambiguousColumns'));
  const projection = columns.map((name, index) => quote(name) + (outputLabels ? ' AS ' + quote(outputLabels[index]) : '')).join(', ');
  if (offset <= 0) return 'SELECT ' + projection + ' FROM (' + base + ') AS __gonavi_hive_source__' + orderBy + ' LIMIT ' + limit;
  // Impala requires window ordering; the constant is not a stable row key.
  const windowOrder = orderBy.trim() || 'ORDER BY 1';
  return 'SELECT ' + projection + ' FROM (SELECT __gonavi_hive_source__.*, ROW_NUMBER() OVER (' + windowOrder + ') AS ' + rn
    + ' FROM (' + base + ') AS __gonavi_hive_source__) AS __gonavi_hive_page__ WHERE ' + rn + ' > ' + offset
    + ' AND ' + rn + ' <= ' + (offset + limit) + ' ORDER BY ' + rn;
};

export const hivePaginationNeedsOrder = (base: string, orderBy: string, offset: number): boolean =>
  offset > 0 && !orderBy.trim() && findTopLevelKeyword(base, 'order by', 'hive') < 0;

const splitLeadingCte = (sql: string): { prefix: string; body: string } => {
  const start = getLeadingKeyword(sql, 'hive') === 'with' ? findCteBodyStart(sql, 'hive') : 0;
  return start > 0 ? { prefix: sql.slice(0, start), body: sql.slice(start).trim() } : { prefix: '', body: sql };
};

export const buildHiveCountSQL = (sql: string, columns?: readonly string[]): string => {
  const statement = splitLeadingCte(splitSqlTail(sql, 'hive').main.trim());
  if (columns?.length) resolveHiveResultProjection(statement.body, columns);
  else assertHiveCountProjection(statement.body);
  const order = findTopLevelKeyword(statement.body, 'order by', 'hive');
  const limited = findTopLevelKeyword(statement.body, 'limit', 'hive') >= 0;
  const base = order >= 0 && !limited ? statement.body.slice(0, order).trimEnd() : statement.body;
  return statement.prefix + 'SELECT COUNT(*) AS __gonavi_total__ FROM (' + base + ') AS __gonavi_hive_count__';
};

export const buildHiveQueryPageSQL = (
  sql: string, orderBy: string, limit: number, offset: number, columns?: readonly string[],
): string => {
  let base = splitSqlTail(sql, 'hive').main.trim();
  let ordering = orderBy;
  const position = findTopLevelKeyword(base, 'order by', 'hive');
  if (!ordering.trim() && position >= 0 && findTopLevelKeyword(base.slice(position), 'limit', 'hive') < 0) {
    ordering = ' ' + base.slice(position);
    base = base.slice(0, position).trimEnd();
  }
  const statement = splitLeadingCte(base);
  const projection = columns?.length ? resolveHiveResultProjection(statement.body, columns) : undefined;
  const mappedOrder = projection ? rewriteHiveResultOrder(ordering, projection) : ordering;
  const wrapped = 'SELECT * FROM (' + statement.body + ') AS __gonavi_hive_query__';
  if (limit <= 0 && offset === 0) {
    const selected = projection?.map(item => quote(item.sourceName) + ' AS ' + quote(item.outputLabel)).join(', ') || '*';
    return statement.prefix + 'SELECT ' + selected + ' FROM (' + statement.body + ') AS __gonavi_hive_query__' + mappedOrder;
  }
  return statement.prefix + buildHivePageSQL(wrapped, mappedOrder, limit, offset, projection?.map(item => item.sourceName), projection?.map(item => item.outputLabel));
};
