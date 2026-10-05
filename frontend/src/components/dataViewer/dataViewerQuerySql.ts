import { quoteQualifiedIdent, quoteIdentPart } from '../../utils/sql';
import {
  type EditRowLocator,
  DUCKDB_ROWID_LOCATOR_COLUMN,
  ORACLE_ROWID_LOCATOR_COLUMN,
} from '../../utils/rowLocator';
import { splitQualifiedNameSegments, splitQualifiedNameLast } from '../../utils/qualifiedName';
import { getDataSourceSpec } from '../../utils/dataSourceRegistry';

// 未指定排序时按主键 / 行定位列排序以稳定分页；描述表声明 ui.naturalOrder 的数据源（搜索引擎类）引擎自身的顺序已稳定，
// 主键往往不能由服务端排序，追加主键排序会退化为客户端全量排序，因此不追加。
export const resolveDataViewerOrderFallbackColumns = (
  locator: EditRowLocator | undefined,
  pkColumns: string[],
  dbType?: string,
): string[] => {
  if (getDataSourceSpec(dbType)?.ui?.naturalOrder) {
    return [];
  }
  if (locator && !locator.readOnly && locator.strategy !== 'oracle-rowid') {
    return locator.valueColumns.length > 0 ? locator.valueColumns : locator.columns;
  }
  return pkColumns;
};

export const buildDataViewerBaseSelectSQL = (
  dbType: string,
  tableName: string,
  whereSQL: string,
  locator?: EditRowLocator,
): string => {
  const quotedTableName = quoteQualifiedIdent(dbType, tableName);
  if (locator?.strategy !== 'oracle-rowid' && locator?.strategy !== 'duckdb-rowid') {
    return `SELECT * FROM ${quotedTableName} ${whereSQL}`;
  }

  const alias = 'gonavi_row_source';
  if (locator?.strategy === 'duckdb-rowid') {
    const duckdbRowIDAlias = quoteIdentPart(dbType, DUCKDB_ROWID_LOCATOR_COLUMN);
    return `SELECT ${alias}.*, ${alias}.rowid AS ${duckdbRowIDAlias} FROM ${quotedTableName} ${alias} ${whereSQL}`;
  }

  const oracleRowIDAlias = quoteIdentPart(dbType, ORACLE_ROWID_LOCATOR_COLUMN);
  return `SELECT ${alias}.*, ${alias}.ROWID AS ${oracleRowIDAlias} FROM ${quotedTableName} ${alias} ${whereSQL}`;
};

export const resolveDuckDBSchemaAndTable = (dbName: string, tableName: string) => {
  const rawTable = String(tableName || '').trim();
  if (!rawTable) return { schemaName: 'main', pureTableName: '' };

  const segments = splitQualifiedNameSegments(rawTable);
  if (segments.length >= 2) {
    return {
      schemaName: segments[segments.length - 2],
      pureTableName: segments[segments.length - 1],
    };
  }

  const fallbackParsed = splitQualifiedNameLast(String(dbName || '').trim());
  const fallbackSchema = fallbackParsed.objectName || String(dbName || '').trim() || 'main';
  return { schemaName: fallbackSchema, pureTableName: segments[0] || rawTable };
};

export const escapeSQLLiteral = (value: string): string => String(value || '').replace(/'/g, "''");

export const isDuckDBUnsupportedTypeError = (msg: string): boolean => /unsupported\s*type:\s*duckdb\./i.test(String(msg || ''));

export const isDuckDBComplexColumnType = (columnType?: string): boolean => {
  const raw = String(columnType || '').trim().toLowerCase();
  if (!raw) return false;
  return raw.includes('map') || raw.includes('struct') || raw.includes('union') || raw.includes('array') || raw.includes('list');
};
