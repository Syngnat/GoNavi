import {
  isMysqlFamilyDialect,
  isOracleLikeDialect,
  isPgLikeDialect,
  isSqlServerDialect,
  resolveSqlDialect,
} from '../../utils/sqlDialect';
import { resolveColumnTypeOptions } from '../../utils/sqlDialectColumnTypes';
import {
  IMPORT_LOGICAL_TYPES,
  type ImportInferredColumn,
  type ImportLogicalType,
  type ImportTableColumnDraft,
  type ImportTableSchemaInference,
  type ImportTableTypeFamily,
  type SqlDialectOptions,
} from './importTableTypeMapping.types';
import { mapMysqlType } from './dialects/importTableTypesMysql';
import { mapPostgresType } from './dialects/importTableTypesPostgres';
import { mapOracleType } from './dialects/importTableTypesOracle';
import { mapSqlServerType } from './dialects/importTableTypesSqlServer';
import { mapSqliteType } from './dialects/importTableTypesSqlite';
import { mapFirebirdType } from './dialects/importTableTypesFirebird';
import { mapGbase8sType } from './dialects/importTableTypesGbase8s';
import { mapHiveType } from './dialects/importTableTypesHive';
import { mapClickHouseType } from './dialects/importTableTypesClickHouse';
import { mapQuestDbType } from './dialects/importTableTypesQuestDb';
import { mapGreptimeDbType } from './dialects/importTableTypesGreptimeDb';
import { mapTdengineType } from './dialects/importTableTypesTdengine';

export type {
  ImportLogicalType,
  ImportInferredColumn,
  ImportTableSchemaInference,
  ImportAutoCreateTableDraft,
  ImportTableCreatePayload,
  ImportTableColumnDraft,
  ImportTableTypeFamily,
} from './importTableTypeMapping.types';

export const resolveImportTableTypeFamily = (
  dbType: string,
  driver = '',
  options?: SqlDialectOptions,
): ImportTableTypeFamily => {
  const dialect = resolveSqlDialect(dbType, driver, options);
  if (dialect === 'greptimedb') return 'greptimedb';
  if (dialect === 'questdb') return 'questdb';
  if (dialect === 'tdengine') return 'tdengine';
  if (dialect === 'clickhouse') return 'clickhouse';
  if (dialect === 'hive') return 'hive';
  if (dialect === 'firebird') return 'firebird';
  if (dialect === 'gbase8s') return 'gbase8s';
  if (dialect === 'sqlite') return 'sqlite';
  if (dialect === 'duckdb') return 'duckdb';
  if (isMysqlFamilyDialect(dialect)) return 'mysql';
  if (isPgLikeDialect(dialect)) return 'postgres';
  if (isOracleLikeDialect(dialect)) return 'oracle';
  if (isSqlServerDialect(dialect)) return 'sqlserver';
  return 'standard';
};

export const mapImportLogicalTypeToSqlType = (
  column: ImportInferredColumn,
  dbType: string,
  driver = '',
  options?: SqlDialectOptions,
): string => {
  switch (resolveImportTableTypeFamily(dbType, driver, options)) {
    case 'mysql':
      return mapMysqlType(column);
    case 'postgres':
    case 'duckdb':
      return mapPostgresType(column);
    case 'oracle':
      return mapOracleType(column);
    case 'sqlserver':
      return mapSqlServerType(column);
    case 'sqlite':
      return mapSqliteType(column);
    case 'firebird':
      return mapFirebirdType(column);
    case 'gbase8s':
      return mapGbase8sType(column);
    case 'hive':
      return mapHiveType(column);
    case 'clickhouse':
      return mapClickHouseType(column);
    case 'questdb':
      return mapQuestDbType(column);
    case 'greptimedb':
      return mapGreptimeDbType(column);
    case 'tdengine':
      return mapTdengineType(column);
    default:
      return mapMysqlType(column);
  }
};

export const supportsImportTableColumnComment = (
  dbType: string,
  driver = '',
  options?: SqlDialectOptions,
): boolean => {
  const family = resolveImportTableTypeFamily(dbType, driver, options);
  // 这四类方言的建表 DDL 生成器会输出列注释：MySQL 内联，其余走独立的
  // COMMENT ON / sp_addextendedproperty 语句（后端只放行这两类后续语句）。
  return family === 'mysql' || family === 'postgres' || family === 'oracle' || family === 'sqlserver';
};

export const buildImportTableTypeOptions = (
  dbType: string,
  driver = '',
  options?: SqlDialectOptions,
): string[] => {
  const sampleColumn = (logicalType: ImportLogicalType): ImportInferredColumn => ({
    name: logicalType,
    sourceName: logicalType,
    logicalType,
    nullable: true,
  });
  const dialect = resolveSqlDialect(dbType, driver, options);
  return Array.from(new Set([
    ...IMPORT_LOGICAL_TYPES.map((logicalType) => (
      mapImportLogicalTypeToSqlType(sampleColumn(logicalType), dialect)
    )),
    ...resolveColumnTypeOptions(dialect).map((option) => option.value),
  ])).filter(Boolean);
};

export const prepareImportTableColumns = (
  inference: ImportTableSchemaInference,
  dbType: string,
  driver = '',
  options?: SqlDialectOptions,
): {
  columns: ImportTableColumnDraft[];
  tdengineTimestampKey: string | null;
  greptimeTimestampKey: string | null;
  greptimeTimestampMissing: boolean;
} => {
  const family = resolveImportTableTypeFamily(dbType, driver, options);
  const columns = inference.columns.map((column, index) => ({
    key: `import-column-${index}`,
    name: column.name,
    sourceName: column.sourceName,
    logicalType: column.logicalType,
    type: String(column.declaredType || '').trim()
      || mapImportLogicalTypeToSqlType(column, dbType, driver, options),
    nullable: column.nullable !== false,
    primaryKey: false,
    comment: String(column.comment || ''),
    maxLength: column.maxLength,
    precision: column.precision,
    scale: column.scale,
    timestampRequired: false,
  }));

  if (family === 'greptimedb') {
    const timestampIndex = columns.findIndex((column) => (
      column.logicalType === 'date' || column.logicalType === 'datetime'
    ));
    if (timestampIndex < 0) {
      return {
        columns,
        tdengineTimestampKey: null,
        greptimeTimestampKey: null,
        greptimeTimestampMissing: true,
      };
    }
    const timestampColumn = {
      ...columns[timestampIndex],
      type: 'TIMESTAMP TIME INDEX',
      timestampRequired: true,
    };
    return {
      columns: [
        timestampColumn,
        ...columns.slice(0, timestampIndex),
        ...columns.slice(timestampIndex + 1),
      ],
      tdengineTimestampKey: null,
      greptimeTimestampKey: timestampColumn.key,
      greptimeTimestampMissing: false,
    };
  }

  if (family !== 'tdengine') {
    return {
      columns,
      tdengineTimestampKey: null,
      greptimeTimestampKey: null,
      greptimeTimestampMissing: false,
    };
  }

  const timestampIndex = columns.findIndex((column) => (
    column.logicalType === 'date' || column.logicalType === 'datetime'
  ));
  if (timestampIndex < 0) {
    return {
      columns,
      tdengineTimestampKey: null,
      greptimeTimestampKey: null,
      greptimeTimestampMissing: false,
    };
  }
  const timestampColumn = {
    ...columns[timestampIndex],
    type: 'TIMESTAMP',
    timestampRequired: true,
  };
  return {
    columns: [
      timestampColumn,
      ...columns.slice(0, timestampIndex),
      ...columns.slice(timestampIndex + 1),
    ],
    tdengineTimestampKey: timestampColumn.key,
    greptimeTimestampKey: null,
    greptimeTimestampMissing: false,
  };
};
