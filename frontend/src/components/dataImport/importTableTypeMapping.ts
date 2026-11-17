import { isMysqlFamilyDialect, isOracleLikeDialect, isPgLikeDialect, isSqlServerDialect, resolveSqlDialect } from '../../utils/sqlDialect';
import { resolveColumnTypeOptions } from '../../utils/sqlDialectColumnTypes';

export type ImportLogicalType =
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'uuid'
  | 'json'
  | 'text'
  | 'longtext'
  | 'binary'
  | (string & {});

export interface ImportInferredColumn {
  name: string;
  sourceName: string;
  logicalType: ImportLogicalType;
  nullable: boolean;
  maxLength?: number;
  precision?: number;
  scale?: number;
}

export interface ImportTableSchemaInference {
  tableName: string;
  columns: ImportInferredColumn[];
  warnings: string[];
  sampledRows: number;
  sampleLimit: number;
}

export interface ImportAutoCreateTableDraft {
  tableName: string;
  sql: string;
  columns: string[];
}

export interface ImportTableColumnDraft {
  key: string;
  name: string;
  sourceName: string;
  logicalType: ImportLogicalType;
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  comment: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
  timestampRequired?: boolean;
}

export type ImportTableTypeFamily =
  | 'mysql'
  | 'postgres'
  | 'oracle'
  | 'sqlserver'
  | 'sqlite'
  | 'firebird'
  | 'gbase8s'
  | 'hive'
  | 'clickhouse'
  | 'questdb'
  | 'greptimedb'
  | 'tdengine'
  | 'duckdb'
  | 'standard';

type SqlDialectOptions = {
  oceanBaseProtocol?: unknown;
};

const IMPORT_LOGICAL_TYPES: ImportLogicalType[] = [
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'time',
  'uuid',
  'json',
  'text',
  'longtext',
  'binary',
];

const asPositiveInteger = (value: unknown, fallback: number): number => {
  const numberValue = Math.trunc(Number(value));
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : fallback;
};

const asNonNegativeInteger = (value: unknown, fallback: number): number => {
  const numberValue = Math.trunc(Number(value));
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : fallback;
};

const decimalParts = (
  column: Pick<ImportInferredColumn, 'precision' | 'scale'>,
  defaultPrecision: number,
  defaultScale: number,
  maxPrecision: number,
  maxScale: number,
): { precision: number; scale: number } => {
  let precision = Math.min(maxPrecision, asPositiveInteger(column.precision, defaultPrecision));
  let scale = Math.min(maxScale, asNonNegativeInteger(column.scale, defaultScale));
  if (scale > precision) {
    if (precision < maxPrecision) {
      precision = Math.min(maxPrecision, scale);
    } else {
      scale = precision;
    }
  }
  return { precision, scale };
};

const decimalType = (
  name: string,
  column: Pick<ImportInferredColumn, 'precision' | 'scale'>,
  defaultPrecision: number,
  defaultScale: number,
  maxPrecision: number,
  maxScale: number,
): string => {
  const parts = decimalParts(column, defaultPrecision, defaultScale, maxPrecision, maxScale);
  return `${name}(${parts.precision},${parts.scale})`;
};

const isLongText = (column: Pick<ImportInferredColumn, 'logicalType' | 'maxLength'>): boolean => (
  column.logicalType === 'longtext' || asNonNegativeInteger(column.maxLength, 0) > 255
);

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
  switch (dialect) {
    default:
      return 'standard';
  }
};

const mapMysqlType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'bigint';
    case 'decimal':
      return decimalType('decimal', column, 30, 10, 65, 30);
    case 'boolean':
      return 'tinyint(1)';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime(6)';
    case 'time':
      return 'time(6)';
    case 'uuid':
      return 'char(36)';
    case 'json':
      return 'json';
    case 'longtext':
      return 'longtext';
    case 'text':
      return isLongText(column) ? 'longtext' : 'varchar(255)';
    case 'binary':
      return 'varbinary(255)';
    default:
      return isLongText(column) ? 'longtext' : 'varchar(255)';
  }
};

const mapPostgresType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'bigint';
    case 'decimal':
      return decimalType('numeric', column, 30, 10, 65, 30);
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'datetime':
      return 'timestamp(6)';
    case 'time':
      return 'time(6)';
    case 'uuid':
      return 'uuid';
    case 'json':
      return 'jsonb';
    case 'longtext':
      return 'text';
    case 'text':
      return isLongText(column) ? 'text' : 'varchar(255)';
    case 'binary':
      return 'bytea';
    default:
      return isLongText(column) ? 'text' : 'varchar(255)';
  }
};

const mapOracleType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'NUMBER(19)';
    case 'decimal':
      return decimalType('NUMBER', column, 30, 10, 38, 30);
    case 'boolean':
      return 'NUMBER(1)';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'TIMESTAMP(6)';
    case 'time':
      return 'VARCHAR2(255)';
    case 'uuid':
      return 'VARCHAR2(36)';
    case 'json':
      return 'CLOB';
    case 'longtext':
      return 'CLOB';
    case 'text':
      return isLongText(column) ? 'CLOB' : 'VARCHAR2(255)';
    case 'binary':
      return 'BLOB';
    default:
      return isLongText(column) ? 'CLOB' : 'VARCHAR2(255)';
  }
};

const mapSqlServerType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'BIGINT';
    case 'decimal':
      return decimalType('DECIMAL', column, 30, 10, 38, 30);
    case 'boolean':
      return 'BIT';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'DATETIME2(6)';
    case 'time':
      return 'TIME(6)';
    case 'uuid':
      return 'NVARCHAR(36)';
    case 'json':
      return 'NVARCHAR(MAX)';
    case 'longtext':
      return 'NVARCHAR(MAX)';
    case 'text':
      return isLongText(column) ? 'NVARCHAR(MAX)' : 'NVARCHAR(255)';
    case 'binary':
      return 'VARBINARY(MAX)';
    default:
      return isLongText(column) ? 'NVARCHAR(MAX)' : 'NVARCHAR(255)';
  }
};

const mapSqliteType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'INTEGER';
    case 'decimal':
      return 'NUMERIC';
    case 'boolean':
      return 'INTEGER';
    case 'longtext':
      return 'TEXT';
    case 'binary':
      return 'BLOB';
    default:
      return 'TEXT';
  }
};

const mapFirebirdType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'BIGINT';
    case 'decimal':
      return decimalType('DECIMAL', column, 18, 4, 18, 4);
    case 'boolean':
      return 'SMALLINT';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'TIMESTAMP';
    case 'time':
      return 'TIME';
    case 'uuid':
      return 'VARCHAR(36)';
    case 'json':
    case 'longtext':
      return 'BLOB SUB_TYPE TEXT';
    case 'text':
      return isLongText(column) ? 'BLOB SUB_TYPE TEXT' : 'VARCHAR(255)';
    case 'binary':
      return 'BLOB';
    default:
      return isLongText(column) ? 'BLOB SUB_TYPE TEXT' : 'VARCHAR(255)';
  }
};

const mapGbase8sType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'BIGINT';
    case 'decimal':
      return decimalType('DECIMAL', column, 18, 4, 32, 32);
    case 'boolean':
      return 'SMALLINT';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'DATETIME YEAR TO FRACTION(5)';
    case 'time':
      return 'DATETIME HOUR TO SECOND';
    case 'uuid':
      return 'VARCHAR(36)';
    case 'json':
    case 'longtext':
    case 'text':
      return 'TEXT';
    case 'binary':
      return 'BLOB';
    default:
      return isLongText(column) ? 'TEXT' : 'VARCHAR(255)';
  }
};

const mapHiveType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'BIGINT';
    case 'decimal':
      return decimalType('DECIMAL', column, 38, 18, 38, 18);
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'TIMESTAMP';
    case 'binary':
      return 'BINARY';
    default:
      return 'STRING';
  }
};

const mapClickHouseType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'Int64';
    case 'decimal':
      return decimalType('Decimal', column, 30, 10, 76, 30);
    case 'boolean':
      return 'UInt8';
    case 'date':
      return 'Date';
    case 'datetime':
      return 'DateTime64(6)';
    default:
      return 'String';
  }
};

const mapQuestDbType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'LONG';
    case 'decimal':
      return 'DOUBLE';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'TIMESTAMP';
    case 'uuid':
      return 'UUID';
    default:
      return 'STRING';
  }
};

const mapGreptimeDbType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'BIGINT';
    case 'decimal':
      return decimalType('DECIMAL', column, 38, 18, 38, 18);
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'TIMESTAMP';
    case 'binary':
      return 'BINARY';
    default:
      return 'STRING';
  }
};

const mapTdengineType = (column: ImportInferredColumn): string => {
  switch (column.logicalType) {
    case 'integer':
      return 'BIGINT';
    case 'decimal':
      return 'DOUBLE';
    case 'boolean':
      return 'BOOL';
    case 'date':
    case 'datetime':
    case 'time':
      return 'TIMESTAMP';
    case 'text':
      return 'VARCHAR(255)';
    default:
      return 'NCHAR(255)';
  }
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
    type: mapImportLogicalTypeToSqlType(column, dbType, driver, options),
    nullable: column.nullable !== false,
    primaryKey: false,
    comment: '',
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
