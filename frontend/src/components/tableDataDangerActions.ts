import { getDataSourceSpec } from '../utils/dataSourceRegistry';

export type TableDataDangerActionKind = 'truncate' | 'clear';

type TableDataDangerActionTranslator = (key: string) => string;

const resolveCustomDriverDialect = (driver: string): string => {
  const normalized = String(driver || '').trim().toLowerCase();
  switch (normalized) {
    case 'postgresql':
    case 'postgres':
    case 'pg':
    case 'pq':
    case 'pgx':
      return 'postgres';
    case 'opengauss':
    case 'open_gauss':
    case 'open-gauss':
      return 'opengauss';
    case 'gaussdb':
    case 'gauss_db':
    case 'gauss-db':
      return 'gaussdb';
    case 'goldendb':
    case 'greatdb':
    case 'gdb':
      return 'goldendb';
    case 'dm':
    case 'dameng':
    case 'dm8':
      return 'dameng';
    case 'sqlite3':
    case 'sqlite':
      return 'sqlite';
    case 'sphinxql':
      return 'sphinx';
    case 'diros':
    case 'doris':
      return 'diros';
    case 'starrocks':
      return 'starrocks';
    case 'oceanbase':
      return 'oceanbase';
    case 'kingbase':
    case 'kingbase8':
    case 'kingbasees':
    case 'kingbasev8':
      return 'kingbase';
    case 'highgo':
      return 'highgo';
    case 'vastbase':
      return 'vastbase';
    case 'iris':
    case 'intersystems':
    case 'intersystemsiris':
    case 'inter-systems':
    case 'inter-systems-iris':
      return 'iris';
    case 'cache':
    case 'caché':
    case 'intersystems cache':
    case 'intersystems caché':
    case 'intersystems-cache':
    case 'intersystems-caché':
    case 'intersystemscache':
    case 'intersystemscaché':
    case 'inter-systems-cache':
    case 'inter-systems-caché':
    case 'intersystems-cache-database':
    case 'cache-db':
    case 'cachedb':
      return 'iris';
    default:
      break;
  }

  if (normalized.includes('opengauss') || normalized.includes('open_gauss') || normalized.includes('open-gauss')) return 'opengauss';
  if (normalized.includes('gaussdb') || normalized.includes('gauss_db') || normalized.includes('gauss-db')) return 'gaussdb';
  if (normalized.includes('goldendb') || normalized.includes('greatdb')) return 'goldendb';
  if (normalized.includes('postgres')) return 'postgres';
  if (normalized.includes('oceanbase')) return 'oceanbase';
  if (normalized.includes('kingbase')) return 'kingbase';
  if (normalized.includes('highgo')) return 'highgo';
  if (normalized.includes('vastbase')) return 'vastbase';
  if (normalized.includes('sqlite')) return 'sqlite';
  if (normalized.includes('iris') || normalized.includes('intersystems')) return 'iris';
  if (normalized.includes('sphinx')) return 'sphinx';
  if (normalized.includes('diros') || normalized.includes('doris')) return 'diros';
  if (normalized.includes('starrocks')) return 'starrocks';
  return normalized;
};

export const resolveTableDataActionDBType = (type: string, driver?: string): string => {
  const normalizedType = String(type || '').trim().toLowerCase();
  // 借用方言的描述表类型（TiDB → mysql、CockroachDB → postgres、Presto → trino）按借用方言提供清空 / 截断。
  const borrowedDialect = getDataSourceSpec(normalizedType)?.ddlDialect;
  if (borrowedDialect) {
    return borrowedDialect;
  }
  if (normalizedType !== 'custom') {
    return resolveCustomDriverDialect(normalizedType);
  }
  return resolveCustomDriverDialect(driver || '');
};

export const supportsTableTruncateAction = (type: string, driver?: string): boolean => {
  if (getDataSourceSpec(type)?.ui?.objectStatements?.truncateTable) return true;
  switch (resolveTableDataActionDBType(type, driver)) {
    case 'mysql':
    case 'goldendb':
    case 'mariadb':
    case 'oceanbase':
    case 'starrocks':
    case 'postgres':
    case 'kingbase':
    case 'highgo':
    case 'vastbase':
    case 'opengauss':
    case 'gaussdb':
    case 'sqlserver':
    case 'iris':
    case 'oracle':
    case 'dameng':
    case 'clickhouse':
    case 'duckdb':
      return true;
    default:
      return false;
  }
};

export const supportsTableClearAction = (type: string, driver?: string): boolean => {
  if (getDataSourceSpec(type)?.ui?.objectStatements?.clearTable) return true;
  switch (resolveTableDataActionDBType(type, driver)) {
    case 'mysql':
    case 'goldendb':
    case 'mariadb':
    case 'oceanbase':
    case 'diros':
    case 'starrocks':
    case 'sphinx':
    case 'postgres':
    case 'kingbase':
    case 'highgo':
    case 'vastbase':
    case 'opengauss':
    case 'gaussdb':
    case 'sqlserver':
    case 'sqlite':
    case 'duckdb':
    case 'oracle':
    case 'dameng':
    case 'iris':
    case 'tdengine':
    case 'clickhouse':
    case 'trino':
    case 'mongodb':
      return true;
    default:
      return false;
  }
};

const tableDataDangerActionCopy = (
  translate: TableDataDangerActionTranslator | undefined,
  key: string,
  fallback: string,
) => translate ? translate(key) : fallback;

export const getTableDataDangerActionMeta = (action: TableDataDangerActionKind, translate?: TableDataDangerActionTranslator): {
  label: string;
  progressLabel: string;
} => {
  if (action === 'truncate') {
    return {
      label: tableDataDangerActionCopy(translate, 'sidebar.table_action.truncate.label', 'Truncate table'),
      progressLabel: tableDataDangerActionCopy(translate, 'sidebar.table_action.truncate.progress', 'Truncating'),
    };
  }
  return {
    label: tableDataDangerActionCopy(translate, 'sidebar.table_action.clear.label', 'Clear table'),
    progressLabel: tableDataDangerActionCopy(translate, 'sidebar.table_action.clear.progress', 'Clearing'),
  };
};
