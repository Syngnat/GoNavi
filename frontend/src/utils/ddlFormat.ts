import { format, type SqlLanguage } from 'sql-formatter';
import { resolveSqlDialect } from './sqlDialect';
import { normalizeOceanBaseProtocol } from './oceanBaseProtocol';

const normalizeDbType = (dbType: string): string => String(dbType || '').trim().toLowerCase();

const resolveDdlFormatterLanguage = (
  dbType: string,
  options?: { oceanBaseProtocol?: unknown },
): SqlLanguage => {
  const rawType = normalizeDbType(dbType);
  const normalized = normalizeDbType(resolveSqlDialect(rawType, '', options));
  if (rawType === 'oceanbase' && normalizeOceanBaseProtocol(options?.oceanBaseProtocol) === 'oracle') {
    return 'plsql';
  }
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
    case 'diros':
    case 'starrocks':
    case 'oceanbase':
    case 'tidb':
      return 'mariadb';
    case 'mysql':
    case 'goldendb':
    case 'sphinx':
      return 'mysql';
    case 'sqlserver':
      return 'transactsql';
    case 'oracle':
    case 'dameng':
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

export const formatDdlForDisplay = (
  ddlText: unknown,
  dbType: string,
  options?: { oceanBaseProtocol?: unknown },
): string => {
  const raw = String(ddlText ?? '').trim();
  if (!raw) {
    return '';
  }
  const normalizedDialect = normalizeDbType(resolveSqlDialect(dbType, '', options));
  if (normalizedDialect === 'oracle' && isOracleViewDdl(raw)) {
    return raw;
  }
  const language = resolveDdlFormatterLanguage(dbType, options);
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
