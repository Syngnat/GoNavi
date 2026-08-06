import { format, type SqlLanguage } from 'sql-formatter';

const normalizeDbType = (dbType: string): string => String(dbType || '').trim().toLowerCase();

const resolveDdlFormatterLanguage = (dbType: string): SqlLanguage => {
  const normalized = normalizeDbType(dbType);
  switch (normalized) {
    case 'duckdb':
      return 'duckdb';
    case 'sqlite':
      return 'sqlite';
    case 'postgres':
    case 'postgresql':
    case 'kingbase':
    case 'highgo':
    case 'opengauss':
    case 'gaussdb':
    case 'vastbase':
      return 'postgresql';
    case 'mariadb':
      return 'mariadb';
    case 'mysql':
    case 'goldendb':
    case 'sphinx':
      return 'mysql';
    case 'sqlserver':
      return 'transactsql';
    case 'oracle':
    case 'dameng':
    case 'oceanbase':
      return 'plsql';
    case 'clickhouse':
      return 'clickhouse';
    default:
      return 'sql';
  }
};

const isOracleViewDdl = (sql: string): boolean => (
  /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NO\s*)?FORCE\s+)?(?:NONEDITIONABLE\s+|EDITIONABLE\s+)?(?:MATERIALIZED\s+)?VIEW\b/i.test(sql)
);

export const formatDdlForDisplay = (ddlText: unknown, dbType: string): string => {
  const raw = String(ddlText ?? '').trim();
  if (!raw) {
    return '';
  }
  if (normalizeDbType(dbType) === 'oracle' && isOracleViewDdl(raw)) {
    return raw;
  }
  const language = resolveDdlFormatterLanguage(dbType);
  try {
    return format(raw, {
      language,
      keywordCase: 'upper',
      linesBetweenQueries: 1,
    });
  } catch {
    return raw;
  }
};
