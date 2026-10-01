import {
  isMysqlFamilyDialect,
  isOracleLikeDialect,
  isPgLikeDialect,
  isSqlServerDialect,
  resolveSqlDialect,
  type ColumnTypeOption,
} from './sqlDialect';

export type ColumnDefaultOption = ColumnTypeOption;

type ColumnDefaultKind = 'time' | 'numeric' | 'bool' | 'uuid' | 'json' | 'text' | 'other';

const COMMON_DEFAULT_VALUES = ['CURRENT_TIMESTAMP', 'NULL', '0', "''"];

const PG_DEFAULT_VALUES = [
  'now()',
  'LOCALTIMESTAMP',
  'LOCALTIME',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP(0)',
  'CURRENT_TIMESTAMP(6)',
  'clock_timestamp()',
  'TRUE',
  'FALSE',
  '1',
  "nextval('seq_name')",
  'gen_random_uuid()',
  'uuid_generate_v4()',
  'CURRENT_USER',
  'SESSION_USER',
  'CURRENT_SCHEMA',
  "'{}'::jsonb",
  "'[]'::jsonb",
];

const ORACLE_COMPAT_DEFAULT_VALUES = [
  'SYSDATE',
  'SYSTIMESTAMP',
  'USER',
  'SYS_GUID()',
  'seq_name.NEXTVAL',
  'EMPTY_CLOB()',
  'EMPTY_BLOB()',
];

const MYSQL_DEFAULT_VALUES = [
  'NOW()',
  'CURRENT_TIMESTAMP(6)',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'UTC_TIMESTAMP',
  'UNIX_TIMESTAMP()',
  'UUID()',
  'CURRENT_USER',
  'USER()',
  'DATABASE()',
  '1',
  'TRUE',
  'FALSE',
  'JSON_OBJECT()',
  'JSON_ARRAY()',
  "b'0'",
];

const DORIS_DEFAULT_VALUES = [
  'NOW()',
  'CURRENT_DATE',
  'UUID()',
  'TRUE',
  'FALSE',
  '1',
];

const ORACLE_DEFAULT_VALUES = [
  'SYSDATE',
  'SYSTIMESTAMP',
  'CURRENT_DATE',
  'LOCALTIMESTAMP',
  'USER',
  'SYS_GUID()',
  'seq_name.NEXTVAL',
  'EMPTY_CLOB()',
  'EMPTY_BLOB()',
  '1',
];

const DAMENG_EXTRA_DEFAULT_VALUES = ['NOW()', 'GETDATE()'];

const SQLSERVER_DEFAULT_VALUES = [
  'GETDATE()',
  'GETUTCDATE()',
  'SYSDATETIME()',
  'SYSUTCDATETIME()',
  'NEWID()',
  'NEWSEQUENTIALID()',
  '1',
  'USER_NAME()',
  'SUSER_SNAME()',
  'SYSTEM_USER',
  'HOST_NAME()',
  'DB_NAME()',
  'SCHEMA_NAME()',
];

const SQLITE_DEFAULT_VALUES = [
  'CURRENT_DATE',
  'CURRENT_TIME',
  "datetime('now')",
  "date('now')",
  "time('now')",
  "datetime('now', 'localtime')",
  '1',
];

const DUCKDB_DEFAULT_VALUES = [
  'now()',
  'today()',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'gen_random_uuid()',
  'uuid()',
  'TRUE',
  'FALSE',
  '1',
];

const CLICKHOUSE_DEFAULT_VALUES = [
  'now()',
  'now64()',
  'today()',
  'yesterday()',
  'generateUUIDv4()',
  '1',
  '[]',
  'map()',
];

const TDENGINE_DEFAULT_VALUES = ['NOW', 'NOW()', 'TODAY', '1'];

const IOTDB_DEFAULT_VALUES = ['now()'];

const PG_ORACLE_COMPAT_DIALECTS = new Set(['kingbase', 'vastbase', 'opengauss', 'gaussdb']);

const TIME_DEFAULT_PATTERN = /^(CURRENT_(?:TIMESTAMP|DATE|TIME)(?:\(\d+\))?|LOCALTIMESTAMP|LOCALTIME|NOW(?:\(\))?|SYSDATE(?:\(\))?|SYSTIMESTAMP|GETDATE\(\)|GETUTCDATE\(\)|SYSDATETIME\(\)|SYSUTCDATETIME\(\)|UTC_TIMESTAMP|UNIX_TIMESTAMP\(\)|clock_timestamp\(\)|timezone\(|datetime\(|date\(|time\(|today\(\)|yesterday\(\)|now64\(\)|TODAY)$/i;

const toOptions = (values: string[]): ColumnDefaultOption[] => values.map((value) => ({ value }));

const uniqueValues = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
};

const dialectDefaultValues = (dialect: string): readonly string[] => {
  if (PG_ORACLE_COMPAT_DIALECTS.has(dialect)) {
    return [...PG_DEFAULT_VALUES, ...ORACLE_COMPAT_DEFAULT_VALUES];
  }
  if (isPgLikeDialect(dialect)) return PG_DEFAULT_VALUES;
  if (dialect === 'diros' || dialect === 'starrocks') return DORIS_DEFAULT_VALUES;
  if (isMysqlFamilyDialect(dialect)) return MYSQL_DEFAULT_VALUES;
  if (dialect === 'dameng') return [...ORACLE_DEFAULT_VALUES, ...DAMENG_EXTRA_DEFAULT_VALUES];
  if (isOracleLikeDialect(dialect)) return ORACLE_DEFAULT_VALUES;
  if (isSqlServerDialect(dialect) || dialect === 'iris') return SQLSERVER_DEFAULT_VALUES;
  if (dialect === 'sqlite') return SQLITE_DEFAULT_VALUES;
  if (dialect === 'duckdb') return DUCKDB_DEFAULT_VALUES;
  if (dialect === 'clickhouse') return CLICKHOUSE_DEFAULT_VALUES;
  if (dialect === 'tdengine') return TDENGINE_DEFAULT_VALUES;
  if (dialect === 'iotdb') return IOTDB_DEFAULT_VALUES;
  return [];
};

const classifyColumnType = (columnType: string): ColumnDefaultKind => {
  const typeName = String(columnType || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!typeName) return 'other';
  if (/\b(uuid|uniqueidentifier)\b/.test(typeName)) return 'uuid';
  if (/\bjsonb?\b/.test(typeName)) return 'json';
  if (/\b(bool|boolean)\b/.test(typeName) || /^tinyint\s*\(\s*1\s*\)/.test(typeName)) return 'bool';
  if (/\b(timestamp|timestamptz|datetime|datetime2|datetimeoffset|smalldatetime|date|time|interval|year)\b/.test(typeName)) {
    return 'time';
  }
  if (/\b(u?int\d*|tinyint|smallint|mediumint|bigint|integer|serial|bigserial|decimal|numeric|number|float|double|real|money|byteint|largeint)\b/.test(typeName)) {
    return 'numeric';
  }
  if (/\b(char|varchar|text|clob|nclob|string|nchar|nvarchar|ntext|name)\b/.test(typeName)) return 'text';
  return 'other';
};

const classifyDefaultValue = (value: string): ColumnDefaultKind | 'null' | 'empty' | 'sequence' | 'session' => {
  const normalized = value.trim();
  if (!normalized || normalized === "''") return 'empty';
  if (/^null$/i.test(normalized)) return 'null';
  if (/^(true|false)$/i.test(normalized)) return 'bool';
  if (/^(0|1)$/.test(normalized) || /^b'0'$/i.test(normalized)) return 'numeric';
  if (/nextval\s*\(|\.nextval\b/i.test(normalized)) return 'sequence';
  if (/uuid|guid|newid|newsequentialid/i.test(normalized)) return 'uuid';
  if (/json|::jsonb?|'{}'|'\[\]'|map\s*\(/i.test(normalized)) return 'json';
  if (TIME_DEFAULT_PATTERN.test(normalized)) return 'time';
  if (/user|schema|database|host_name|suser|db_name|system_user/i.test(normalized)) return 'session';
  return 'other';
};

const defaultSortScore = (value: string, columnKind: ColumnDefaultKind): number => {
  const valueKind = classifyDefaultValue(value);
  if (valueKind === columnKind) return 0;
  if (columnKind === 'text' && valueKind === 'empty') return 0;
  if (columnKind === 'numeric' && valueKind === 'sequence') return 1;
  if (valueKind === 'null') return 2;
  return 3;
};

const sortDefaultValues = (values: string[], columnType: string): string[] => {
  const columnKind = classifyColumnType(columnType);
  if (columnKind === 'other') return values;
  return values
    .map((value, index) => ({ value, index, score: defaultSortScore(value, columnKind) }))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((item) => item.value);
};

export const COMMON_COLUMN_DEFAULT_OPTIONS = toOptions(COMMON_DEFAULT_VALUES);

export const resolveColumnDefaultOptions = (dbType: string, columnType = ''): ColumnDefaultOption[] => {
  const dialect = resolveSqlDialect(dbType);
  const values = uniqueValues([
    ...COMMON_DEFAULT_VALUES,
    ...dialectDefaultValues(dialect),
  ]);
  return toOptions(sortDefaultValues(values, columnType));
};
