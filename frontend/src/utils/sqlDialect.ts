import { resolveOceanBaseProtocolForDialect } from './oceanBaseProtocol';
import { t as translate } from '../i18n';

export type ColumnTypeOption = { value: string };

export type SqlFunctionCompletion = {
  name: string;
  detail: string;
};

export type SqlDialect =
  | 'mysql'
  | 'mariadb'
  | 'oceanbase'
  | 'diros'
  | 'starrocks'
  | 'sphinx'
  | 'postgres'
  | 'kingbase'
  | 'highgo'
  | 'vastbase'
  | 'opengauss'
  | 'gaussdb'
  | 'oracle'
  | 'dameng'
  | 'sqlserver'
  | 'iris'
  | 'sqlite'
  | 'duckdb'
  | 'clickhouse'
  | 'tdengine'
  | 'iotdb'
  | 'rocketmq'
  | 'mqtt'
  | 'kafka'
  | 'rabbitmq'
  | 'mongodb'
  | 'redis'
  | 'elasticsearch'
  | 'chroma'
  | 'qdrant'
  | 'milvus'
  | 'unknown'
  | string;

const unique = <T>(items: T[]): T[] => Array.from(new Set(items));

const optionValues = (values: string[]): ColumnTypeOption[] => values.map((value) => ({ value }));

const normalizeRawDialect = (value: string): string => String(value || '').trim().toLowerCase();

export const normalizeOceanBaseSqlProtocol = resolveOceanBaseProtocolForDialect;

export const resolveSqlDialect = (
  rawType: string,
  rawDriver = '',
  options?: { oceanBaseProtocol?: unknown },
): SqlDialect => {
  const normalized = normalizeRawDialect(rawType);
  const driver = normalizeRawDialect(rawDriver);
  const source = normalized === 'custom' ? driver : normalized;

  if (!source) return 'unknown';
  if (source === 'oceanbase' && normalizeOceanBaseSqlProtocol(options?.oceanBaseProtocol) === 'oracle') {
    return 'oracle';
  }

  switch (source) {
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
    case 'mssql':
    case 'sql_server':
    case 'sql-server':
      return 'sqlserver';
    case 'intersystems':
    case 'intersystemsiris':
    case 'inter-systems':
    case 'inter-systems-iris':
    case 'iris':
      return 'iris';
    case 'doris':
    case 'diros':
      return 'diros';
    case 'starrocks':
      return 'starrocks';
    case 'dm':
    case 'dm8':
    case 'dameng':
      return 'dameng';
    case 'sqlite3':
    case 'sqlite':
      return 'sqlite';
    case 'sphinxql':
      return 'sphinx';
    case 'kingbase8':
    case 'kingbasees':
    case 'kingbasev8':
      return 'kingbase';
    case 'gdb':
    case 'goldendb':
    case 'greatdb':
      return 'mysql';
    case 'mariadb':
    case 'oceanbase':
    case 'mysql':
    case 'sphinx':
    case 'kingbase':
    case 'highgo':
    case 'vastbase':
    case 'oracle':
    case 'duckdb':
    case 'clickhouse':
    case 'tdengine':
    case 'iotdb':
    case 'mongodb':
    case 'redis':
    case 'elasticsearch':
      return source;
    case 'elastic':
      return 'elasticsearch';
    case 'chromadb':
    case 'chroma-db':
    case 'chroma':
      return 'chroma';
    case 'qdrantdb':
    case 'qdrant-db':
    case 'qdrant':
      return 'qdrant';
    case 'milvusdb':
    case 'milvus-db':
    case 'milvus':
      return 'milvus';
    case 'apache-iotdb':
    case 'apache_iotdb':
      return 'iotdb';
    case 'rocketmq':
    case 'rocket-mq':
    case 'rocket_mq':
    case 'apache-rocketmq':
    case 'apache_rocketmq':
    case 'rmq':
      return 'rocketmq';
    case 'mqtt':
    case 'mqtts':
      return 'mqtt';
    case 'kafka':
    case 'apache-kafka':
    case 'apache_kafka':
      return 'kafka';
    case 'rabbitmq':
    case 'rabbit-mq':
    case 'rabbit_mq':
      return 'rabbitmq';
    default:
      break;
  }

  if (source.includes('opengauss') || source.includes('open_gauss') || source.includes('open-gauss')) return 'opengauss';
  if (source.includes('gaussdb') || source.includes('gauss_db') || source.includes('gauss-db')) return 'gaussdb';
  if (source.includes('postgres')) return 'postgres';
  if (source.includes('oceanbase')) return 'oceanbase';
  if (source.includes('mariadb')) return 'mariadb';
  if (source.includes('goldendb') || source.includes('greatdb')) return 'mysql';
  if (source.includes('mysql')) return 'mysql';
  if (source.includes('doris') || source.includes('diros')) return 'diros';
  if (source.includes('starrocks')) return 'starrocks';
  if (source.includes('sphinx')) return 'sphinx';
  if (source.includes('kingbase')) return 'kingbase';
  if (source.includes('highgo')) return 'highgo';
  if (source.includes('vastbase')) return 'vastbase';
  if (source.includes('oracle')) return 'oracle';
  if (source.includes('dameng') || source.includes('dm8')) return 'dameng';
  if (source.includes('sqlite')) return 'sqlite';
  if (source.includes('duckdb')) return 'duckdb';
  if (source.includes('clickhouse')) return 'clickhouse';
  if (source.includes('tdengine')) return 'tdengine';
  if (source.includes('iotdb')) return 'iotdb';
  if (source.includes('rocketmq') || source.includes('rocket-mq') || source.includes('rocket_mq') || source === 'rmq') return 'rocketmq';
  if (source.includes('mqtt')) return 'mqtt';
  if (source.includes('kafka')) return 'kafka';
  if (source.includes('rabbitmq') || source.includes('rabbit-mq') || source.includes('rabbit_mq')) return 'rabbitmq';
  if (source.includes('sqlserver') || source.includes('mssql')) return 'sqlserver';
  if (source.includes('iris') || source.includes('intersystems')) return 'iris';
  if (source.includes('elastic')) return 'elasticsearch';
  if (source.includes('chroma')) return 'chroma';
  if (source.includes('qdrant')) return 'qdrant';
  if (source.includes('milvus')) return 'milvus';

  return source;
};

export const isMysqlFamilyDialect = (dbType: string): boolean => (
  ['mysql', 'mariadb', 'oceanbase', 'diros', 'starrocks', 'sphinx', 'tidb'].includes(resolveSqlDialect(dbType))
);

export const isPgLikeDialect = (dbType: string): boolean => (
  ['postgres', 'kingbase', 'highgo', 'vastbase', 'opengauss', 'gaussdb'].includes(resolveSqlDialect(dbType))
);

export const isOracleLikeDialect = (dbType: string): boolean => (
  ['oracle', 'dameng', 'dm'].includes(resolveSqlDialect(dbType))
);

export const isSqlServerDialect = (dbType: string): boolean => resolveSqlDialect(dbType) === 'sqlserver';

export type TableAliasSyntax = 'as' | 'bare' | 'none';

export const resolveTableAliasSyntax = (dbType: string): TableAliasSyntax => {
  const dialect = resolveSqlDialect(dbType);
  if ([
    'mysql', 'mariadb', 'tidb', 'oceanbase', 'diros', 'starrocks',
    'postgres', 'kingbase', 'highgo', 'vastbase', 'opengauss', 'gaussdb',
    'sqlserver', 'sqlite', 'duckdb', 'clickhouse', 'tdengine', 'trino',
  ].includes(dialect)) {
    return 'as';
  }
  if (['oracle', 'dameng', 'sphinx', 'iris'].includes(dialect)) {
    return 'bare';
  }
  return 'none';
};

export const appendTableAlias = (tableName: string, alias: string, dbType: string): string => {
  if (!alias) return tableName;
  const syntax = resolveTableAliasSyntax(dbType);
  const prefix = tableName ? `${tableName} ` : '';
  if (syntax === 'as') return `${prefix}AS ${alias}`;
  if (syntax === 'bare') return `${prefix}${alias}`;
  return tableName;
};

export const isBacktickIdentifierDialect = (dbType: string): boolean => (
  isMysqlFamilyDialect(dbType) || ['clickhouse', 'tdengine', 'iotdb'].includes(resolveSqlDialect(dbType))
);

const stripIdentifierQuotes = (part: string): string => {
  const text = String(part || '').trim();
  if (!text) return '';
  if ((text.startsWith('`') && text.endsWith('`')) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1).trim();
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    return text.slice(1, -1).replace(/]]/g, ']').trim();
  }
  return text;
};

const escapeBacktickIdentifier = (value: string) => String(value || '').replace(/`/g, '``');
const escapeDoubleQuoteIdentifier = (value: string) => String(value || '').replace(/"/g, '""');
const escapeBracketIdentifier = (value: string) => String(value || '').replace(/]/g, ']]');

const needsPgLikeQuote = (ident: string): boolean => !/^[a-z_][a-z0-9_]*$/.test(ident);

export const unquoteSqlIdentifierPart = stripIdentifierQuotes;

export const unquoteSqlIdentifierPath = (path: string): string => (
  String(path || '')
    .trim()
    .split('.')
    .map((part) => stripIdentifierQuotes(part))
    .filter(Boolean)
    .join('.')
);

export const quoteSqlIdentifierPart = (dbType: string, part: string): string => {
  const ident = stripIdentifierQuotes(part);
  if (!ident) return '';
  const dialect = resolveSqlDialect(dbType);

  if (isBacktickIdentifierDialect(dialect)) {
    return `\`${escapeBacktickIdentifier(ident)}\``;
  }
  if (isSqlServerDialect(dialect)) {
    return `[${escapeBracketIdentifier(ident)}]`;
  }
  if (isPgLikeDialect(dialect)) {
    return needsPgLikeQuote(ident) ? `"${escapeDoubleQuoteIdentifier(ident)}"` : ident;
  }
  return `"${escapeDoubleQuoteIdentifier(ident)}"`;
};

export const quoteSqlIdentifierPath = (dbType: string, path: string): string => (
  String(path || '')
    .trim()
    .split('.')
    .map((part) => stripIdentifierQuotes(part))
    .filter(Boolean)
    .map((part) => quoteSqlIdentifierPart(dbType, part))
    .join('.')
);

const MYSQL_TYPES = optionValues([
  'tinyint',
  'tinyint(1)',
  'smallint',
  'mediumint',
  'int',
  'bigint',
  'float',
  'double',
  'decimal(10,2)',
  'char(50)',
  'varchar(255)',
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'binary(255)',
  'varbinary(255)',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
  'date',
  'time',
  'datetime',
  'timestamp',
  'year',
  'json',
  'geometry',
  'point',
  'linestring',
  'polygon',
  'multipoint',
  'multilinestring',
  'multipolygon',
  'geometrycollection',
  'enum',
  'set',
  'bit(1)',
]);

const PG_TYPES = optionValues([
  'smallint',
  'integer',
  'bigint',
  'real',
  'double precision',
  'numeric(10,2)',
  'serial',
  'bigserial',
  'char(50)',
  'varchar(255)',
  'text',
  'boolean',
  'date',
  'time',
  'timestamp',
  'timestamptz',
  'interval',
  'bytea',
  'json',
  'jsonb',
  'uuid',
  'inet',
  'cidr',
  'macaddr',
  'xml',
  'int4range',
  'tsquery',
  'tsvector',
]);

const SQLSERVER_TYPES = optionValues([
  'tinyint',
  'smallint',
  'int',
  'bigint',
  'float',
  'real',
  'decimal(10,2)',
  'numeric(10,2)',
  'money',
  'smallmoney',
  'char(50)',
  'varchar(255)',
  'varchar(max)',
  'nchar(50)',
  'nvarchar(255)',
  'nvarchar(max)',
  'text',
  'ntext',
  'date',
  'time',
  'datetime',
  'datetime2',
  'datetimeoffset',
  'smalldatetime',
  'binary(255)',
  'varbinary(255)',
  'varbinary(max)',
  'image',
  'bit',
  'uniqueidentifier',
  'xml',
]);

const SQLITE_TYPES = optionValues(['INTEGER', 'REAL', 'TEXT', 'BLOB', 'NUMERIC']);

const ORACLE_TYPES = optionValues([
  'NUMBER(10)',
  'NUMBER(10,2)',
  'FLOAT',
  'BINARY_FLOAT',
  'BINARY_DOUBLE',
  'CHAR(50)',
  'VARCHAR2(255)',
  'NVARCHAR2(255)',
  'CLOB',
  'NCLOB',
  'BLOB',
  'DATE',
  'TIMESTAMP',
  'TIMESTAMP WITH TIME ZONE',
  'RAW(255)',
  'LONG RAW',
  'XMLTYPE',
]);

const DAMENG_TYPES = optionValues([
  'INT',
  'BIGINT',
  'NUMBER(10)',
  'NUMBER(10,2)',
  'DECIMAL(10,2)',
  'CHAR(50)',
  'VARCHAR(255)',
  'VARCHAR2(255)',
  'NVARCHAR2(255)',
  'TEXT',
  'CLOB',
  'BLOB',
  'DATE',
  'TIME',
  'TIMESTAMP',
  'BIT',
]);

const DORIS_TYPES = optionValues([
  'BOOLEAN',
  'TINYINT',
  'SMALLINT',
  'INT',
  'BIGINT',
  'LARGEINT',
  'FLOAT',
  'DOUBLE',
  'DECIMAL(10,2)',
  'CHAR(50)',
  'VARCHAR(255)',
  'STRING',
  'DATE',
  'DATETIME',
  'JSON',
  'HLL',
  'BITMAP',
  'ARRAY<INT>',
  'MAP<STRING,STRING>',
  'STRUCT<name:STRING>',
]);

const STARROCKS_TYPES = optionValues([
  'BOOLEAN',
  'TINYINT',
  'SMALLINT',
  'INT',
  'BIGINT',
  'LARGEINT',
  'FLOAT',
  'DOUBLE',
  'DECIMAL(10,2)',
  'DATE',
  'DATETIME',
  'CHAR(50)',
  'VARCHAR(255)',
  'STRING',
  'JSON',
  'BITMAP',
  'HLL',
  'PERCENTILE',
  'ARRAY<INT>',
  'MAP<STRING,STRING>',
  'STRUCT<name STRING>',
]);

const SPHINX_TYPES = optionValues([
  'text',
  'string',
  'integer',
  'bigint',
  'float',
  'bool',
  'timestamp',
  'json',
]);

const CLICKHOUSE_TYPES = optionValues([
  'Int8',
  'UInt8',
  'Int16',
  'UInt16',
  'Int32',
  'UInt32',
  'Int64',
  'UInt64',
  'Float32',
  'Float64',
  'Decimal(10,2)',
  'String',
  'FixedString(32)',
  'Date',
  'Date32',
  'DateTime',
  'DateTime64(3)',
  'UUID',
  'IPv4',
  'IPv6',
  'Array(String)',
  'Nullable(String)',
  'LowCardinality(String)',
  "Enum8('A'=1)",
]);

const TDENGINE_TYPES = optionValues([
  'TIMESTAMP',
  'BOOL',
  'TINYINT',
  'SMALLINT',
  'INT',
  'BIGINT',
  'FLOAT',
  'DOUBLE',
  'BINARY(255)',
  'NCHAR(255)',
  'VARBINARY(255)',
  'JSON',
  'GEOMETRY',
]);

const IOTDB_TYPES = optionValues([
  'BOOLEAN',
  'INT32',
  'INT64',
  'FLOAT',
  'DOUBLE',
  'TEXT',
  'STRING',
  'BLOB',
  'TIMESTAMP',
  'DATE',
]);

const DUCKDB_TYPES = optionValues([
  'BOOLEAN',
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
  'REAL',
  'DOUBLE',
  'DECIMAL(10,2)',
  'VARCHAR',
  'BLOB',
  'DATE',
  'TIME',
  'TIMESTAMP',
  'TIMESTAMPTZ',
  'INTERVAL',
  'UUID',
  'JSON',
  'STRUCT',
  'LIST',
  'MAP',
]);

const COMMON_TYPES = optionValues(['int', 'varchar(255)', 'text', 'datetime', 'decimal(10,2)', 'bigint', 'json']);

export const resolveColumnTypeOptions = (dbType: string): ColumnTypeOption[] => {
  const dialect = resolveSqlDialect(dbType);
  if (dialect === 'diros') return DORIS_TYPES;
  if (dialect === 'starrocks') return STARROCKS_TYPES;
  if (dialect === 'sphinx') return SPHINX_TYPES;
  if (isMysqlFamilyDialect(dialect)) return MYSQL_TYPES;
  if (isPgLikeDialect(dialect)) return PG_TYPES;
  if (dialect === 'oracle') return ORACLE_TYPES;
  if (dialect === 'dameng') return DAMENG_TYPES;
  if (dialect === 'sqlserver') return SQLSERVER_TYPES;
  if (dialect === 'iris') return COMMON_TYPES;
  if (dialect === 'sqlite') return SQLITE_TYPES;
  if (dialect === 'duckdb') return DUCKDB_TYPES;
  if (dialect === 'clickhouse') return CLICKHOUSE_TYPES;
  if (dialect === 'tdengine') return TDENGINE_TYPES;
  if (dialect === 'iotdb') return IOTDB_TYPES;
  return COMMON_TYPES;
};

const COMMON_KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'JOIN', 'LEFT', 'RIGHT',
  'INNER', 'OUTER', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'AS', 'AND', 'OR', 'NOT',
  'NULL', 'IS', 'IN', 'VALUES', 'SET', 'CREATE', 'TABLE', 'DROP', 'ALTER', 'ADD',
  'COLUMN', 'KEY', 'PRIMARY', 'FOREIGN', 'REFERENCES', 'CONSTRAINT', 'DEFAULT',
  'COMMENT', 'EXPLAIN', 'DISTINCT', 'UNION', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
];

const MYSQL_KEYWORDS = [
  'LIMIT', 'OFFSET', 'MODIFY', 'CHANGE', 'AUTO_INCREMENT', 'SHOW', 'DESCRIBE',
  'DESC', 'ENGINE', 'CHARSET', 'COLLATE', 'REPLACE', 'DUPLICATE KEY', 'LOCK',
  'CALL',
];

const PG_KEYWORDS = [
  'LIMIT', 'OFFSET', 'RETURNING', 'SERIAL', 'BIGSERIAL', 'BOOLEAN', 'JSONB',
  'ILIKE', 'RENAME', 'TYPE', 'CASCADE', 'RESTRICT', 'ONLY',
];

const ORACLE_KEYWORDS = [
  'ROWNUM', 'FETCH', 'FIRST', 'ROWS', 'ONLY', 'VARCHAR2', 'NVARCHAR2', 'NUMBER',
  'DATE', 'TIMESTAMP', 'CLOB', 'BLOB', 'SEQUENCE', 'SYNONYM', 'MERGE', 'MINUS',
  'CONNECT BY', 'START WITH', 'MODIFY', 'RENAME',
];

const SQLSERVER_KEYWORDS = [
  'TOP', 'OFFSET', 'FETCH', 'NEXT', 'ROWS', 'ONLY', 'IDENTITY', 'NVARCHAR',
  'DATETIME2', 'BIT', 'GO', 'EXEC', 'PROCEDURE', 'WITH', 'NOLOCK', 'MERGE',
];

const SQLITE_KEYWORDS = ['LIMIT', 'OFFSET', 'AUTOINCREMENT', 'PRAGMA', 'WITHOUT', 'ROWID', 'RENAME'];

const DUCKDB_KEYWORDS = ['LIMIT', 'OFFSET', 'SAMPLE', 'QUALIFY', 'STRUCT', 'LIST', 'MAP', 'JSON', 'UNNEST'];

const CLICKHOUSE_KEYWORDS = [
  'LIMIT', 'OFFSET', 'FORMAT', 'ENGINE', 'PARTITION', 'ORDER BY', 'PRIMARY KEY',
  'SAMPLE', 'MATERIALIZED', 'ALIAS', 'SETTINGS', 'TTL', 'CODEC',
];

const STARROCKS_KEYWORDS = [
  'LIMIT', 'OFFSET', 'ENGINE', 'OLAP', 'DUPLICATE KEY', 'PRIMARY KEY',
  'AGGREGATE KEY', 'UNIQUE KEY', 'DISTRIBUTED BY', 'HASH', 'BUCKETS',
  'PARTITION BY', 'PROPERTIES', 'MATERIALIZED VIEW', 'REFRESH ASYNC',
  'REFRESH MANUAL', 'ROLLUP', 'ADD ROLLUP', 'EXTERNAL CATALOG',
  'CREATE EXTERNAL TABLE', 'BITMAP', 'HLL',
];

const TDENGINE_KEYWORDS = ['LIMIT', 'SLIMIT', 'SOFFSET', 'TAGS', 'USING', 'INTERVAL', 'FILL', 'PARTITION BY'];

const IOTDB_KEYWORDS = [
  'LIMIT',
  'OFFSET',
  'ALIGN BY DEVICE',
  'DISABLE ALIGN',
  'GROUP BY',
  'LEVEL',
  'FILL',
  'SLIMIT',
  'SOFFSET',
  'CREATE TIMESERIES',
  'SHOW TIMESERIES',
  'SHOW DEVICES',
  'SHOW DATABASES',
  'STORAGE GROUP',
  'WITH DATATYPE',
  'ENCODING',
  'COMPRESSION',
];

const ROCKETMQ_KEYWORDS = [
  'SHOW TOPICS',
  'DESCRIBE TOPIC',
  'CONSUME',
  'FROM',
  'LIMIT',
  'OFFSET',
];

const MQTT_KEYWORDS = [
  'SHOW TOPICS',
  'DESCRIBE TOPIC',
  'CONSUME',
  'FROM',
  'LIMIT',
  'OFFSET',
];

const KAFKA_KEYWORDS = [
  'SHOW TOPICS',
  'SHOW TOPIC',
  'DESCRIBE TOPIC',
  'CONSUME',
  'GROUP',
  'FROM',
  'LIMIT',
  'OFFSET',
];

const RABBITMQ_KEYWORDS = [
  'SHOW VHOSTS',
  'SHOW QUEUES',
  'SHOW EXCHANGES',
  'DESCRIBE QUEUE',
  'DESCRIBE EXCHANGE',
  'CONSUME',
  'FROM',
  'LIMIT',
  'OFFSET',
];

export const resolveSqlKeywords = (dbType: string): string[] => {
  const dialect = resolveSqlDialect(dbType);
  if (dialect === 'starrocks') return unique([...COMMON_KEYWORDS, ...MYSQL_KEYWORDS, ...STARROCKS_KEYWORDS]);
  if (isMysqlFamilyDialect(dialect)) return unique([...COMMON_KEYWORDS, ...MYSQL_KEYWORDS]);
  if (isPgLikeDialect(dialect)) return unique([...COMMON_KEYWORDS, ...PG_KEYWORDS]);
  if (isOracleLikeDialect(dialect)) return unique([...COMMON_KEYWORDS, ...ORACLE_KEYWORDS]);
  if (dialect === 'sqlserver') return unique([...COMMON_KEYWORDS, ...SQLSERVER_KEYWORDS]);
  if (dialect === 'sqlite') return unique([...COMMON_KEYWORDS, ...SQLITE_KEYWORDS]);
  if (dialect === 'duckdb') return unique([...COMMON_KEYWORDS, ...DUCKDB_KEYWORDS]);
  if (dialect === 'clickhouse') return unique([...COMMON_KEYWORDS, ...CLICKHOUSE_KEYWORDS]);
  if (dialect === 'tdengine') return unique([...COMMON_KEYWORDS, ...TDENGINE_KEYWORDS]);
  if (dialect === 'iotdb') return unique([...COMMON_KEYWORDS, ...IOTDB_KEYWORDS]);
  if (dialect === 'rocketmq') return unique([...COMMON_KEYWORDS, ...ROCKETMQ_KEYWORDS]);
  if (dialect === 'mqtt') return unique([...COMMON_KEYWORDS, ...MQTT_KEYWORDS]);
  if (dialect === 'kafka') return unique([...COMMON_KEYWORDS, ...KAFKA_KEYWORDS]);
  if (dialect === 'rabbitmq') return unique([...COMMON_KEYWORDS, ...RABBITMQ_KEYWORDS]);
  return COMMON_KEYWORDS;
};

type SqlFunctionDetailTemplate =
  | { kind: 'scoped'; scopeKey: string; actionKey: string }
  | { kind: 'vendor'; vendor: string; actionKey: string };

type SqlFunctionDefinition = {
  name: string;
  detail: SqlFunctionDetailTemplate;
};

const scopedDetail = (scopeKey: string, actionKey: string): SqlFunctionDetailTemplate => ({ kind: 'scoped', scopeKey, actionKey });
const vendorDetail = (vendor: string, actionKey: string): SqlFunctionDetailTemplate => ({ kind: 'vendor', vendor, actionKey });
const fn = (name: string, detail: SqlFunctionDetailTemplate): SqlFunctionDefinition => ({ name, detail });

const renderSqlFunctionDetail = (detail: SqlFunctionDetailTemplate): string => {
  if (detail.kind === 'scoped') {
    return `${translate(detail.scopeKey)} - ${translate(detail.actionKey)}`;
  }
  return `${detail.vendor} - ${translate(detail.actionKey)}`;
};

const COMMON_FUNCTIONS = [
  fn('COUNT', scopedDetail('query_editor.completion.detail.aggregate', 'query_editor.completion.action.count')),
  fn('SUM', scopedDetail('query_editor.completion.detail.aggregate', 'query_editor.completion.action.sum')),
  fn('AVG', scopedDetail('query_editor.completion.detail.aggregate', 'query_editor.completion.action.average')),
  fn('MAX', scopedDetail('query_editor.completion.detail.aggregate', 'query_editor.completion.action.maximum')),
  fn('MIN', scopedDetail('query_editor.completion.detail.aggregate', 'query_editor.completion.action.minimum')),
  fn('CONCAT', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.concatenation')),
  fn('SUBSTRING', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.substring_extraction')),
  fn('SUBSTR', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.substring_extraction')),
  fn('LENGTH', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.length')),
  fn('UPPER', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.uppercase')),
  fn('LOWER', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.lowercase')),
  fn('TRIM', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.space_trimming')),
  fn('LTRIM', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.left_space_trimming')),
  fn('RTRIM', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.right_space_trimming')),
  fn('REPLACE', scopedDetail('query_editor.completion.detail.string', 'query_editor.completion.action.replacement')),
  fn('ABS', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.absolute_value')),
  fn('CEIL', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.round_up')),
  fn('CEILING', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.round_up')),
  fn('FLOOR', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.round_down')),
  fn('ROUND', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.rounding')),
  fn('MOD', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.modulo')),
  fn('POWER', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.power_operation')),
  fn('SQRT', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.square_root')),
  fn('LOG', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.logarithm')),
  fn('EXP', scopedDetail('query_editor.completion.detail.math', 'query_editor.completion.action.e_power')),
  fn('COALESCE', scopedDetail('query_editor.completion.detail.conditional', 'query_editor.completion.action.first_non_null')),
  fn('NULLIF', scopedDetail('query_editor.completion.detail.conditional', 'query_editor.completion.action.null_if_equal')),
  fn('CAST', scopedDetail('query_editor.completion.detail.conversion', 'query_editor.completion.action.type_conversion')),
  fn('CONVERT', scopedDetail('query_editor.completion.detail.conversion', 'query_editor.completion.action.type_conversion')),
  fn('ROW_NUMBER', scopedDetail('query_editor.completion.detail.window', 'query_editor.completion.action.row_number')),
  fn('RANK', scopedDetail('query_editor.completion.detail.window', 'query_editor.completion.action.rank')),
  fn('DENSE_RANK', scopedDetail('query_editor.completion.detail.window', 'query_editor.completion.action.dense_rank')),
  fn('LAG', scopedDetail('query_editor.completion.detail.window', 'query_editor.completion.action.previous_row')),
  fn('LEAD', scopedDetail('query_editor.completion.detail.window', 'query_editor.completion.action.next_row')),
  fn('FIRST_VALUE', scopedDetail('query_editor.completion.detail.window', 'query_editor.completion.action.first_value')),
  fn('LAST_VALUE', scopedDetail('query_editor.completion.detail.window', 'query_editor.completion.action.last_value')),
];

const MYSQL_FUNCTIONS = [
  fn('GROUP_CONCAT', vendorDetail('MySQL', 'query_editor.completion.action.group_concatenation')),
  fn('CONCAT_WS', vendorDetail('MySQL', 'query_editor.completion.action.concat_with_separator')),
  fn('LEFT', vendorDetail('MySQL', 'query_editor.completion.action.left_substring')),
  fn('RIGHT', vendorDetail('MySQL', 'query_editor.completion.action.right_substring')),
  fn('CHAR_LENGTH', vendorDetail('MySQL', 'query_editor.completion.action.character_length')),
  fn('REVERSE', vendorDetail('MySQL', 'query_editor.completion.action.string_reversal')),
  fn('REPEAT', vendorDetail('MySQL', 'query_editor.completion.action.string_repetition')),
  fn('LPAD', vendorDetail('MySQL', 'query_editor.completion.action.left_padding')),
  fn('RPAD', vendorDetail('MySQL', 'query_editor.completion.action.right_padding')),
  fn('INSTR', vendorDetail('MySQL', 'query_editor.completion.action.position_lookup')),
  fn('LOCATE', vendorDetail('MySQL', 'query_editor.completion.action.position_lookup')),
  fn('FIND_IN_SET', vendorDetail('MySQL', 'query_editor.completion.action.set_lookup')),
  fn('FORMAT', vendorDetail('MySQL', 'query_editor.completion.action.number_formatting')),
  fn('TRUNCATE', vendorDetail('MySQL', 'query_editor.completion.action.decimal_truncation')),
  fn('RAND', vendorDetail('MySQL', 'query_editor.completion.action.random_number')),
  fn('POW', vendorDetail('MySQL', 'query_editor.completion.action.power_operation')),
  fn('LOG2', vendorDetail('MySQL', 'query_editor.completion.action.log_base_2')),
  fn('LOG10', vendorDetail('MySQL', 'query_editor.completion.action.log_base_10')),
  fn('NOW', vendorDetail('MySQL', 'query_editor.completion.action.current_date_time')),
  fn('CURDATE', vendorDetail('MySQL', 'query_editor.completion.action.current_date')),
  fn('CURTIME', vendorDetail('MySQL', 'query_editor.completion.action.current_time')),
  fn('DATE_FORMAT', vendorDetail('MySQL', 'query_editor.completion.action.date_formatting')),
  fn('DATE_ADD', vendorDetail('MySQL', 'query_editor.completion.action.date_addition')),
  fn('DATE_SUB', vendorDetail('MySQL', 'query_editor.completion.action.date_subtraction')),
  fn('DATEDIFF', vendorDetail('MySQL', 'query_editor.completion.action.date_difference')),
  fn('TIMESTAMPDIFF', vendorDetail('MySQL', 'query_editor.completion.action.timestamp_difference')),
  fn('STR_TO_DATE', vendorDetail('MySQL', 'query_editor.completion.action.string_to_date')),
  fn('UNIX_TIMESTAMP', vendorDetail('MySQL', 'query_editor.completion.action.unix_timestamp')),
  fn('IF', vendorDetail('MySQL', 'query_editor.completion.action.conditional_check')),
  fn('IFNULL', vendorDetail('MySQL', 'query_editor.completion.action.null_replacement')),
  fn('JSON_EXTRACT', vendorDetail('MySQL', 'query_editor.completion.action.json_value_extraction')),
  fn('JSON_UNQUOTE', vendorDetail('MySQL', 'query_editor.completion.action.json_unquote')),
  fn('JSON_SET', vendorDetail('MySQL', 'query_editor.completion.action.json_value_set')),
  fn('MD5', vendorDetail('MySQL', 'query_editor.completion.action.md5_hash')),
  fn('SHA1', vendorDetail('MySQL', 'query_editor.completion.action.sha1_hash')),
  fn('SHA2', vendorDetail('MySQL', 'query_editor.completion.action.sha2_hash')),
  fn('UUID', vendorDetail('MySQL', 'query_editor.completion.action.uuid_generation')),
  fn('DATABASE', vendorDetail('MySQL', 'query_editor.completion.action.current_database')),
  fn('VERSION', vendorDetail('MySQL', 'query_editor.completion.action.version')),
  fn('LAST_INSERT_ID', vendorDetail('MySQL', 'query_editor.completion.action.last_insert_id')),
];

const PG_FUNCTIONS = [
  fn('STRING_AGG', vendorDetail('PostgreSQL', 'query_editor.completion.action.string_aggregation')),
  fn('ARRAY_AGG', vendorDetail('PostgreSQL', 'query_editor.completion.action.array_aggregation')),
  fn('BOOL_AND', vendorDetail('PostgreSQL', 'query_editor.completion.action.boolean_and_aggregation')),
  fn('BOOL_OR', vendorDetail('PostgreSQL', 'query_editor.completion.action.boolean_or_aggregation')),
  fn('POSITION', vendorDetail('PostgreSQL', 'query_editor.completion.action.position_lookup')),
  fn('EXTRACT', vendorDetail('PostgreSQL', 'query_editor.completion.action.date_field_extraction')),
  fn('DATE_TRUNC', vendorDetail('PostgreSQL', 'query_editor.completion.action.date_truncation')),
  fn('NOW', vendorDetail('PostgreSQL', 'query_editor.completion.action.current_time')),
  fn('TO_CHAR', vendorDetail('PostgreSQL', 'query_editor.completion.action.format_as_text')),
  fn('TO_DATE', vendorDetail('PostgreSQL', 'query_editor.completion.action.string_to_date')),
  fn('TO_TIMESTAMP', vendorDetail('PostgreSQL', 'query_editor.completion.action.string_to_timestamp')),
  fn('AGE', vendorDetail('PostgreSQL', 'query_editor.completion.action.time_difference')),
  fn('RANDOM', vendorDetail('PostgreSQL', 'query_editor.completion.action.random_number')),
  fn('CURRENT_DATABASE', vendorDetail('PostgreSQL', 'query_editor.completion.action.current_database')),
  fn('JSONB_EXTRACT_PATH', vendorDetail('PostgreSQL', 'query_editor.completion.action.jsonb_path_extraction')),
];

const ORACLE_FUNCTIONS = [
  fn('LISTAGG', vendorDetail('Oracle', 'query_editor.completion.action.string_aggregation')),
  fn('NVL', vendorDetail('Oracle', 'query_editor.completion.action.null_replacement')),
  fn('NVL2', vendorDetail('Oracle', 'query_editor.completion.action.null_branch')),
  fn('DECODE', vendorDetail('Oracle', 'query_editor.completion.action.condition_mapping')),
  fn('TO_DATE', vendorDetail('Oracle', 'query_editor.completion.action.string_to_date')),
  fn('TO_TIMESTAMP', vendorDetail('Oracle', 'query_editor.completion.action.string_to_timestamp')),
  fn('TO_CHAR', vendorDetail('Oracle', 'query_editor.completion.action.format_as_text')),
  fn('TO_NUMBER', vendorDetail('Oracle', 'query_editor.completion.action.number_conversion')),
  fn('TRUNC', vendorDetail('Oracle', 'query_editor.completion.action.truncate_date_or_number')),
  fn('ADD_MONTHS', vendorDetail('Oracle', 'query_editor.completion.action.month_addition')),
  fn('MONTHS_BETWEEN', vendorDetail('Oracle', 'query_editor.completion.action.month_difference')),
  fn('LAST_DAY', vendorDetail('Oracle', 'query_editor.completion.action.month_end_date')),
  fn('SYSDATE', vendorDetail('Oracle', 'query_editor.completion.action.database_current_time')),
  fn('SYSTIMESTAMP', vendorDetail('Oracle', 'query_editor.completion.action.current_timestamp')),
  fn('INSTR', vendorDetail('Oracle', 'query_editor.completion.action.position_lookup')),
  fn('REGEXP_LIKE', vendorDetail('Oracle', 'query_editor.completion.action.regex_match')),
  fn('REGEXP_REPLACE', vendorDetail('Oracle', 'query_editor.completion.action.regex_replace')),
  fn('USER', vendorDetail('Oracle', 'query_editor.completion.action.current_user')),
];

const SQLSERVER_FUNCTIONS = [
  fn('GETDATE', vendorDetail('SQL Server', 'query_editor.completion.action.current_date_time')),
  fn('SYSDATETIME', vendorDetail('SQL Server', 'query_editor.completion.action.high_precision_current_time')),
  fn('DATEADD', vendorDetail('SQL Server', 'query_editor.completion.action.date_addition')),
  fn('DATEDIFF', vendorDetail('SQL Server', 'query_editor.completion.action.date_difference')),
  fn('FORMAT', vendorDetail('SQL Server', 'query_editor.completion.action.value_formatting')),
  fn('ISNULL', vendorDetail('SQL Server', 'query_editor.completion.action.null_replacement')),
  fn('IIF', vendorDetail('SQL Server', 'query_editor.completion.action.conditional_check')),
  fn('NEWID', vendorDetail('SQL Server', 'query_editor.completion.action.guid_generation')),
  fn('STRING_AGG', vendorDetail('SQL Server', 'query_editor.completion.action.string_aggregation')),
  fn('LEFT', vendorDetail('SQL Server', 'query_editor.completion.action.left_substring')),
  fn('RIGHT', vendorDetail('SQL Server', 'query_editor.completion.action.right_substring')),
  fn('LEN', vendorDetail('SQL Server', 'query_editor.completion.action.character_length')),
  fn('CHARINDEX', vendorDetail('SQL Server', 'query_editor.completion.action.position_lookup')),
  fn('TRY_CAST', vendorDetail('SQL Server', 'query_editor.completion.action.try_conversion')),
  fn('TRY_CONVERT', vendorDetail('SQL Server', 'query_editor.completion.action.try_conversion')),
  fn('DB_NAME', vendorDetail('SQL Server', 'query_editor.completion.action.current_database')),
];

const SQLITE_FUNCTIONS = [
  fn('DATE', vendorDetail('SQLite', 'query_editor.completion.action.date_value')),
  fn('TIME', vendorDetail('SQLite', 'query_editor.completion.action.time_value')),
  fn('DATETIME', vendorDetail('SQLite', 'query_editor.completion.action.datetime_value')),
  fn('JULIANDAY', vendorDetail('SQLite', 'query_editor.completion.action.julian_day')),
  fn('STRFTIME', vendorDetail('SQLite', 'query_editor.completion.action.date_formatting')),
  fn('IFNULL', vendorDetail('SQLite', 'query_editor.completion.action.null_replacement')),
  fn('RANDOM', vendorDetail('SQLite', 'query_editor.completion.action.random_number')),
  fn('PRINTF', vendorDetail('SQLite', 'query_editor.completion.action.value_formatting')),
  fn('HEX', vendorDetail('SQLite', 'query_editor.completion.action.hexadecimal')),
  fn('QUOTE', vendorDetail('SQLite', 'query_editor.completion.action.sql_literal')),
  fn('JSON_EXTRACT', vendorDetail('SQLite', 'query_editor.completion.action.json_value_extraction')),
];

const DUCKDB_FUNCTIONS = [
  fn('LIST', vendorDetail('DuckDB', 'query_editor.completion.action.list_aggregation')),
  fn('STRUCT_PACK', vendorDetail('DuckDB', 'query_editor.completion.action.struct_construction')),
  fn('UNNEST', vendorDetail('DuckDB', 'query_editor.completion.action.list_unnest')),
  fn('STRFTIME', vendorDetail('DuckDB', 'query_editor.completion.action.date_formatting')),
  fn('EPOCH', vendorDetail('DuckDB', 'query_editor.completion.action.epoch_seconds')),
  fn('RANDOM', vendorDetail('DuckDB', 'query_editor.completion.action.random_number')),
  fn('UUID', vendorDetail('DuckDB', 'query_editor.completion.action.uuid_generation')),
];

const CLICKHOUSE_FUNCTIONS = [
  fn('now', vendorDetail('ClickHouse', 'query_editor.completion.action.current_time')),
  fn('today', vendorDetail('ClickHouse', 'query_editor.completion.action.current_date')),
  fn('toDate', vendorDetail('ClickHouse', 'query_editor.completion.action.date_conversion')),
  fn('toDateTime', vendorDetail('ClickHouse', 'query_editor.completion.action.datetime_conversion')),
  fn('formatDateTime', vendorDetail('ClickHouse', 'query_editor.completion.action.date_formatting')),
  fn('groupArray', vendorDetail('ClickHouse', 'query_editor.completion.action.array_aggregation')),
  fn('groupUniqArray', vendorDetail('ClickHouse', 'query_editor.completion.action.distinct_array_aggregation')),
  fn('uniq', vendorDetail('ClickHouse', 'query_editor.completion.action.approximate_distinct')),
  fn('uniqExact', vendorDetail('ClickHouse', 'query_editor.completion.action.exact_distinct')),
  fn('quantile', vendorDetail('ClickHouse', 'query_editor.completion.action.quantile')),
  fn('JSONExtractString', vendorDetail('ClickHouse', 'query_editor.completion.action.json_string_extraction')),
  fn('toString', vendorDetail('ClickHouse', 'query_editor.completion.action.string_conversion')),
  fn('toInt64', vendorDetail('ClickHouse', 'query_editor.completion.action.int64_conversion')),
];

const STARROCKS_FUNCTIONS = [
  fn('DATE_FORMAT', vendorDetail('StarRocks', 'query_editor.completion.action.date_formatting')),
  fn('STR_TO_DATE', vendorDetail('StarRocks', 'query_editor.completion.action.string_to_date')),
  fn('FROM_UNIXTIME', vendorDetail('StarRocks', 'query_editor.completion.action.unix_time_to_datetime')),
  fn('TO_BITMAP', vendorDetail('StarRocks', 'query_editor.completion.action.bitmap_construction')),
  fn('BITMAP_UNION', vendorDetail('StarRocks', 'query_editor.completion.action.bitmap_aggregation')),
  fn('BITMAP_COUNT', vendorDetail('StarRocks', 'query_editor.completion.action.bitmap_count')),
  fn('HLL_HASH', vendorDetail('StarRocks', 'query_editor.completion.action.hll_hash')),
  fn('HLL_UNION_AGG', vendorDetail('StarRocks', 'query_editor.completion.action.hll_aggregation')),
  fn('APPROX_COUNT_DISTINCT', vendorDetail('StarRocks', 'query_editor.completion.action.approximate_distinct_count')),
  fn('PERCENTILE_APPROX', vendorDetail('StarRocks', 'query_editor.completion.action.approximate_quantile')),
  fn('GET_JSON_STRING', vendorDetail('StarRocks', 'query_editor.completion.action.json_string_extraction')),
  fn('ARRAY_LENGTH', vendorDetail('StarRocks', 'query_editor.completion.action.array_length')),
];

const TDENGINE_FUNCTIONS = [
  fn('NOW', vendorDetail('TDengine', 'query_editor.completion.action.current_time')),
  fn('TODAY', vendorDetail('TDengine', 'query_editor.completion.action.current_date')),
  fn('TIMEDIFF', vendorDetail('TDengine', 'query_editor.completion.action.time_difference')),
  fn('ELAPSED', vendorDetail('TDengine', 'query_editor.completion.action.elapsed_time')),
  fn('SPREAD', vendorDetail('TDengine', 'query_editor.completion.action.spread')),
  fn('TWA', vendorDetail('TDengine', 'query_editor.completion.action.time_weighted_average')),
  fn('LEASTSQUARES', vendorDetail('TDengine', 'query_editor.completion.action.least_squares')),
  fn('APERCENTILE', vendorDetail('TDengine', 'query_editor.completion.action.approximate_percentile')),
  fn('FIRST', vendorDetail('TDengine', 'query_editor.completion.action.first_value')),
  fn('LAST', vendorDetail('TDengine', 'query_editor.completion.action.last_value')),
  fn('LAST_ROW', vendorDetail('TDengine', 'query_editor.completion.action.last_row')),
  fn('INTERP', vendorDetail('TDengine', 'query_editor.completion.action.interpolation')),
  fn('RATE', vendorDetail('TDengine', 'query_editor.completion.action.rate_of_change')),
  fn('IRATE', vendorDetail('TDengine', 'query_editor.completion.action.instant_rate_of_change')),
];

const IOTDB_FUNCTIONS = [
  fn('NOW', vendorDetail('IoTDB', 'query_editor.completion.action.current_time')),
  fn('DATE_BIN', vendorDetail('IoTDB', 'query_editor.completion.action.date_truncation')),
  fn('DIFF', vendorDetail('IoTDB', 'query_editor.completion.action.time_difference')),
  fn('TIME_DIFFERENCE', vendorDetail('IoTDB', 'query_editor.completion.action.time_difference')),
  fn('DERIVATIVE', vendorDetail('IoTDB', 'query_editor.completion.action.rate_of_change')),
  fn('NON_NEGATIVE_DERIVATIVE', vendorDetail('IoTDB', 'query_editor.completion.action.rate_of_change')),
  fn('TOP_K', vendorDetail('IoTDB', 'query_editor.completion.action.maximum')),
  fn('BOTTOM_K', vendorDetail('IoTDB', 'query_editor.completion.action.minimum')),
  fn('M4', vendorDetail('IoTDB', 'query_editor.completion.action.approximate_quantile')),
  fn('EQUAL_SIZE_BUCKET_RANDOM_SAMPLE', vendorDetail('IoTDB', 'query_editor.completion.action.random_number')),
];

const mergeFunctions = (items: SqlFunctionDefinition[]): SqlFunctionCompletion[] => {
  const seen = new Set<string>();
  const result: SqlFunctionCompletion[] = [];
  for (const item of items) {
    const key = item.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      name: item.name,
      detail: renderSqlFunctionDetail(item.detail),
    });
  }
  return result;
};

export const resolveSqlFunctions = (dbType: string): SqlFunctionCompletion[] => {
  const dialect = resolveSqlDialect(dbType);
  if (dialect === 'starrocks') return mergeFunctions([...COMMON_FUNCTIONS, ...MYSQL_FUNCTIONS, ...STARROCKS_FUNCTIONS]);
  if (isMysqlFamilyDialect(dialect)) return mergeFunctions([...COMMON_FUNCTIONS, ...MYSQL_FUNCTIONS]);
  if (isPgLikeDialect(dialect)) return mergeFunctions([...COMMON_FUNCTIONS, ...PG_FUNCTIONS]);
  if (isOracleLikeDialect(dialect)) return mergeFunctions([...COMMON_FUNCTIONS, ...ORACLE_FUNCTIONS]);
  if (dialect === 'sqlserver') return mergeFunctions([...COMMON_FUNCTIONS, ...SQLSERVER_FUNCTIONS]);
  if (dialect === 'sqlite') return mergeFunctions([...COMMON_FUNCTIONS, ...SQLITE_FUNCTIONS]);
  if (dialect === 'duckdb') return mergeFunctions([...COMMON_FUNCTIONS, ...DUCKDB_FUNCTIONS]);
  if (dialect === 'clickhouse') return mergeFunctions([...COMMON_FUNCTIONS, ...CLICKHOUSE_FUNCTIONS]);
  if (dialect === 'tdengine') return mergeFunctions([...COMMON_FUNCTIONS, ...TDENGINE_FUNCTIONS]);
  if (dialect === 'iotdb') return mergeFunctions([...COMMON_FUNCTIONS, ...IOTDB_FUNCTIONS]);
  return mergeFunctions(COMMON_FUNCTIONS);
};
