import { isMysqlFamilyDialect, isOracleLikeDialect, isPgLikeDialect, isSqlServerDialect, resolveSqlDialect } from './sqlDialect';

const SQL_SERVER_VALUES = new Set(['CURRENT_TIMESTAMP', 'CURRENT_USER', 'SESSION_USER', 'SYSTEM_USER', 'USER']);
const ORACLE_VALUES = new Set(['SYSDATE', 'SYSTIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'USER']);
const PG_SESSION_VALUES = new Set(['CURRENT_USER', 'SESSION_USER', 'USER', 'CURRENT_ROLE', 'CURRENT_SCHEMA', 'CURRENT_CATALOG']);
const TEMPORAL_VALUES = new Set(['CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP']);

// 这些无括号值表达式看起来像标识符，不能当成源列；引号或限定名不会命中。
export const isQueryResultBareValueKeyword = (expression: string, dbType = ''): boolean => {
  const value = expression.trim().toUpperCase();
  if (value === 'NULL') return true;
  if (isSqlServerDialect(dbType)) return SQL_SERVER_VALUES.has(value);
  if (isOracleLikeDialect(dbType)) return ORACLE_VALUES.has(value);
  const dialect = resolveSqlDialect(dbType);
  const mysql = isMysqlFamilyDialect(dbType);
  const postgres = isPgLikeDialect(dbType);
  if (value === 'TRUE' || value === 'FALSE') return true;
  if (TEMPORAL_VALUES.has(value) && (mysql || postgres || ['sqlite', 'duckdb', 'trino', 'presto'].includes(dialect))) return true;
  if ((value === 'LOCALTIME' || value === 'LOCALTIMESTAMP') && (mysql || postgres || dialect === 'duckdb')) return true;
  if (mysql && value === 'CURRENT_USER') return true;
  return postgres && PG_SESSION_VALUES.has(value);
};
