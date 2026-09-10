import { buildPaginatedSelectSQL } from './sql';
import { resolveSqlDialect } from './sqlDialect';
import { applyQueryAutoLimit, findTopLevelKeyword, getLeadingKeyword, splitSqlTail } from './queryAutoLimit';

const AI_READONLY_SQL_KEYWORDS = new Set(['select', 'show', 'describe', 'desc', 'explain', 'with', 'pragma', 'values']);

const trimSQLStatement = (sql: string): string => String(sql || '').trim().replace(/;\s*$/, '').trim();

const isAIReadonlySQL = (sql: string, dialect: string): boolean => {
  const firstWord = getLeadingKeyword(trimSQLStatement(sql), dialect);
  return AI_READONLY_SQL_KEYWORDS.has(firstWord);
};

const hasExistingRowLimit = (dialect: string, sql: string): boolean => {
  const text = splitSqlTail(trimSQLStatement(sql), dialect).main;
  if (!text) return false;
  if (findTopLevelKeyword(text, 'limit', dialect) >= 0) return true;
  if (findTopLevelKeyword(text, 'fetch', dialect) >= 0) return true;
  if (findTopLevelKeyword(text, 'top', dialect) >= 0) return true;
  return (dialect === 'oracle' || dialect === 'dameng')
    && findTopLevelKeyword(text, 'rownum', dialect) >= 0;
};

const preserveAIExplicitZeroOffset = (dialect: string, sql: string): string => {
  if (dialect === 'oracle' || dialect === 'dameng' || dialect === 'sqlserver' || dialect === 'mssql') {
    return sql;
  }
  const { main, tail } = splitSqlTail(sql, dialect);
  const limitPos = findTopLevelKeyword(main, 'limit', dialect);
  if (limitPos < 0 || findTopLevelKeyword(main, 'offset', dialect) >= 0) return sql;
  const limitMatch = main.slice(limitPos).match(/^limit\s+\d+/i);
  if (!limitMatch) return sql;
  const insertAt = limitPos + limitMatch[0].length;
  return `${main.slice(0, insertAt)} OFFSET 0${main.slice(insertAt)}${tail}`;
};

export const buildAIReadonlyPreviewSQL = (
  dbType: string,
  sql: string,
  limit = 50,
  driver = '',
  options?: { oceanBaseProtocol?: unknown },
): string => {
  const baseSQL = trimSQLStatement(sql);
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const dialect = resolveSqlDialect(dbType, driver, options);
  if (!baseSQL || safeLimit <= 0 || !isAIReadonlySQL(baseSQL, dialect) || hasExistingRowLimit(dialect, baseSQL)) {
    return baseSQL;
  }
  if (getLeadingKeyword(baseSQL, dialect) === 'select') {
    const result = applyQueryAutoLimit(baseSQL, dialect, safeLimit);
    return result.applied ? preserveAIExplicitZeroOffset(dialect, result.sql) : result.sql;
  }
  return buildPaginatedSelectSQL(dialect, baseSQL, '', safeLimit, 0);
};
