import { describe, expect, it } from 'vitest';

import {
  mapImportLogicalTypeToSqlType,
  prepareImportTableColumns,
  resolveImportTableTypeFamily,
  type ImportInferredColumn,
  type ImportTableSchemaInference,
} from './importTableTypeMapping';

const column = (
  logicalType: ImportInferredColumn['logicalType'],
  overrides: Partial<ImportInferredColumn> = {},
): ImportInferredColumn => ({
  name: logicalType,
  sourceName: logicalType,
  logicalType,
  nullable: true,
  ...overrides,
});

const map = (
  logicalType: ImportInferredColumn['logicalType'],
  dialect: string,
  overrides: Partial<ImportInferredColumn> = {},
) => mapImportLogicalTypeToSqlType(column(logicalType, overrides), dialect);

const inference = (columns: ImportInferredColumn[]): ImportTableSchemaInference => ({
  tableName: 'imported_data',
  columns,
  warnings: [],
  sampledRows: 3,
  sampleLimit: 500,
});

describe('importTableTypeMapping', () => {
  it.each([
    ['mysql', 'mysql'],
    ['mariadb', 'mysql'],
    ['oceanbase', 'mysql'],
    ['tidb', 'mysql'],
    ['gbase8a', 'mysql'],
    ['starrocks', 'mysql'],
    ['diros', 'mysql'],
    ['sphinx', 'mysql'],
  ])('normalizes %s to the MySQL family', (dialect, family) => {
    expect(resolveImportTableTypeFamily(dialect)).toBe(family);
  });

  it.each([
    ['postgres', 'postgres'],
    ['kingbase', 'postgres'],
    ['highgo', 'postgres'],
    ['vastbase', 'postgres'],
    ['opengauss', 'postgres'],
    ['gaussdb', 'postgres'],
    ['cockroachdb', 'postgres'],
    ['kwdb', 'postgres'],
    ['timescaledb', 'postgres'],
    ['gbase8c', 'postgres'],
  ])('normalizes %s to the PostgreSQL family', (dialect, family) => {
    expect(resolveImportTableTypeFamily(dialect)).toBe(family);
  });

  it('maps the MySQL family with clamped decimal precision and text capacity', () => {
    expect(map('integer', 'mysql')).toBe('bigint');
    expect(map('decimal', 'mysql')).toBe('decimal(30,10)');
    expect(map('decimal', 'mysql', { precision: 80, scale: 40 })).toBe('decimal(65,30)');
    expect(map('boolean', 'mysql')).toBe('tinyint(1)');
    expect(map('date', 'mysql')).toBe('date');
    expect(map('datetime', 'mysql')).toBe('datetime(6)');
    expect(map('time', 'mysql')).toBe('time(6)');
    expect(map('uuid', 'mysql')).toBe('char(36)');
    expect(map('json', 'mysql')).toBe('json');
    expect(map('text', 'mysql', { maxLength: 200 })).toBe('varchar(255)');
    expect(map('text', 'mysql', { maxLength: 500 })).toBe('longtext');
    expect(map('longtext', 'mysql')).toBe('longtext');
    expect(map('integer', 'gbase8a')).toBe('bigint');
    expect(map('text', 'starrocks', { maxLength: 500 })).toBe('longtext');
  });

  it('maps the PostgreSQL family', () => {
    expect(map('integer', 'postgres')).toBe('bigint');
    expect(map('decimal', 'postgres')).toBe('numeric(30,10)');
    expect(map('decimal', 'gbase8c', { precision: 18, scale: 4 })).toBe('numeric(18,4)');
    expect(map('boolean', 'kingbase')).toBe('boolean');
    expect(map('date', 'highgo')).toBe('date');
    expect(map('datetime', 'vastbase')).toBe('timestamp(6)');
    expect(map('time', 'opengauss')).toBe('time(6)');
    expect(map('uuid', 'timescaledb')).toBe('uuid');
    expect(map('json', 'cockroachdb')).toBe('jsonb');
    expect(map('text', 'postgres', { maxLength: 300 })).toBe('text');
    expect(map('longtext', 'kwdb')).toBe('text');
  });

  it('maps Oracle-compatible dialects with safe downgrades', () => {
    expect(map('integer', 'oracle')).toBe('NUMBER(19)');
    expect(map('decimal', 'oracle')).toBe('NUMBER(30,10)');
    expect(map('boolean', 'dameng')).toBe('NUMBER(1)');
    expect(map('date', 'yashandb')).toBe('DATE');
    expect(map('datetime', 'oracle')).toBe('TIMESTAMP(6)');
    expect(map('time', 'oracle')).toBe('VARCHAR2(255)');
    expect(map('uuid', 'oracle')).toBe('VARCHAR2(36)');
    expect(map('json', 'dameng')).toBe('CLOB');
    expect(map('text', 'yashandb', { maxLength: 300 })).toBe('CLOB');
    expect(map('longtext', 'oracle')).toBe('CLOB');
  });

  it('maps SQL Server types', () => {
    expect(map('integer', 'sqlserver')).toBe('BIGINT');
    expect(map('decimal', 'sqlserver')).toBe('DECIMAL(30,10)');
    expect(map('boolean', 'sqlserver')).toBe('BIT');
    expect(map('date', 'sqlserver')).toBe('DATE');
    expect(map('datetime', 'sqlserver')).toBe('DATETIME2(6)');
    expect(map('time', 'sqlserver')).toBe('TIME(6)');
    expect(map('uuid', 'sqlserver')).toBe('NVARCHAR(36)');
    expect(map('json', 'sqlserver')).toBe('NVARCHAR(MAX)');
    expect(map('text', 'sqlserver', { maxLength: 300 })).toBe('NVARCHAR(MAX)');
    expect(map('longtext', 'sqlserver')).toBe('NVARCHAR(MAX)');
  });

  it('maps SQLite, Firebird and GBase 8s affinities', () => {
    expect(map('integer', 'sqlite')).toBe('INTEGER');
    expect(map('decimal', 'sqlite')).toBe('NUMERIC');
    expect(map('boolean', 'sqlite')).toBe('INTEGER');
    expect(map('datetime', 'sqlite')).toBe('TEXT');
    expect(map('uuid', 'sqlite')).toBe('TEXT');
    expect(map('json', 'sqlite')).toBe('TEXT');
    expect(map('longtext', 'sqlite')).toBe('TEXT');

    expect(map('integer', 'firebird')).toBe('BIGINT');
    expect(map('decimal', 'gbase8s')).toBe('DECIMAL(18,4)');
    expect(map('boolean', 'firebird')).toBe('SMALLINT');
    expect(map('datetime', 'gbase8s')).toBe('DATETIME YEAR TO FRACTION(5)');
    expect(map('time', 'firebird')).toBe('TIME');
    expect(map('uuid', 'gbase8s')).toBe('VARCHAR(36)');
    expect(map('json', 'firebird')).toBe('BLOB SUB_TYPE TEXT');
    expect(map('longtext', 'gbase8s')).toBe('TEXT');
    expect(map('binary', 'gbase8s')).toBe('BLOB');
  });

  it('maps analytics and time-series dialects', () => {
    expect(map('integer', 'hive')).toBe('BIGINT');
    expect(map('decimal', 'hive')).toBe('DECIMAL(38,18)');
    expect(map('boolean', 'hive')).toBe('BOOLEAN');
    expect(map('datetime', 'hive')).toBe('TIMESTAMP');
    expect(map('json', 'hive')).toBe('STRING');
    expect(map('binary', 'hive')).toBe('BINARY');

    expect(map('integer', 'clickhouse')).toBe('Int64');
    expect(map('decimal', 'clickhouse')).toBe('Decimal(30,10)');
    expect(map('boolean', 'clickhouse')).toBe('UInt8');
    expect(map('date', 'clickhouse')).toBe('Date');
    expect(map('datetime', 'clickhouse')).toBe('DateTime64(6)');
    expect(map('uuid', 'clickhouse')).toBe('String');

    expect(map('integer', 'questdb')).toBe('LONG');
    expect(map('decimal', 'questdb')).toBe('DOUBLE');
    expect(map('boolean', 'questdb')).toBe('BOOLEAN');
    expect(map('date', 'questdb')).toBe('DATE');
    expect(map('datetime', 'questdb')).toBe('TIMESTAMP');
    expect(map('uuid', 'questdb')).toBe('UUID');

    expect(map('integer', 'greptimedb')).toBe('BIGINT');
    expect(map('decimal', 'greptimedb')).toBe('DECIMAL(38,18)');
    expect(map('boolean', 'greptimedb')).toBe('BOOLEAN');
    expect(map('datetime', 'greptimedb')).toBe('TIMESTAMP');
    expect(map('binary', 'greptimedb')).toBe('BINARY');

    expect(map('integer', 'tdengine')).toBe('BIGINT');
    expect(map('decimal', 'tdengine')).toBe('DOUBLE');
    expect(map('boolean', 'tdengine')).toBe('BOOL');
    expect(map('date', 'tdengine')).toBe('TIMESTAMP');
    expect(map('text', 'tdengine')).toBe('VARCHAR(255)');
    expect(map('json', 'tdengine')).toBe('NCHAR(255)');
  });

  it('falls back to MySQL-compatible types for an unknown dialect', () => {
    expect(map('integer', 'custom', { name: 'id', sourceName: 'id' })).toBe('bigint');
    expect(map('json', 'custom')).toBe('json');
  });

  it('forces and moves the TDengine timestamp column to the first position', () => {
    const prepared = prepareImportTableColumns(inference([
      column('integer', { name: 'value', sourceName: 'value' }),
      column('datetime', { name: 'created_at', sourceName: 'created at' }),
      column('text', { name: 'label', sourceName: 'label' }),
    ]), 'tdengine');

    expect(prepared.tdengineTimestampKey).toBe('import-column-1');
    expect(prepared.columns.map((item) => item.name)).toEqual(['created_at', 'value', 'label']);
    expect(prepared.columns[0]).toMatchObject({
      type: 'TIMESTAMP',
      timestampRequired: true,
    });
  });

  it('prefers declared header types and comments over inferred types', () => {
    const prepared = prepareImportTableColumns(inference([
      column('text', {
        name: 'name',
        sourceName: '姓名 varchar(50) 客户姓名',
        declaredType: 'varchar(50)',
        comment: '客户姓名',
      }),
      column('integer', {
        name: 'age',
        sourceName: 'age int 年龄',
        declaredType: 'int',
        comment: '年龄',
      }),
    ]), 'mysql');

    expect(prepared.columns[0]).toMatchObject({ type: 'varchar(50)', comment: '客户姓名' });
    expect(prepared.columns[1]).toMatchObject({ type: 'int', comment: '年龄' });
  });

  it('marks the GreptimeDB time index column and reports when it is missing', () => {
    const prepared = prepareImportTableColumns(inference([
      column('text', { name: 'host', sourceName: 'host' }),
      column('datetime', { name: 'ts', sourceName: 'ts' }),
      column('decimal', { name: 'cpu', sourceName: 'cpu' }),
    ]), 'greptimedb');

    expect(prepared.greptimeTimestampKey).toBe('import-column-1');
    expect(prepared.greptimeTimestampMissing).toBe(false);
    expect(prepared.columns.map((item) => item.name)).toEqual(['ts', 'host', 'cpu']);
    expect(prepared.columns[0]).toMatchObject({
      type: 'TIMESTAMP TIME INDEX',
      timestampRequired: true,
    });

    const missing = prepareImportTableColumns(inference([
      column('text', { name: 'host', sourceName: 'host' }),
      column('decimal', { name: 'cpu', sourceName: 'cpu' }),
    ]), 'greptimedb');
    expect(missing.greptimeTimestampKey).toBeNull();
    expect(missing.greptimeTimestampMissing).toBe(true);
  });

  it('reports a missing TDengine timestamp column without inventing one', () => {
    const prepared = prepareImportTableColumns(inference([
      column('integer', { name: 'value', sourceName: 'value' }),
      column('time', { name: 'time_only', sourceName: 'time_only' }),
      column('text', { name: 'label', sourceName: 'label' }),
    ]), 'tdengine');

    expect(prepared.tdengineTimestampKey).toBeNull();
    expect(prepared.columns.some((item) => item.timestampRequired)).toBe(false);
    expect(prepared.columns.map((item) => item.name)).toEqual(['value', 'time_only', 'label']);
  });
});
