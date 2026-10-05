import {
  ROCKETMQ_KEYWORDS,
  MQTT_KEYWORDS,
  KAFKA_KEYWORDS,
  RABBITMQ_KEYWORDS,
  PULSAR_KEYWORDS,
} from './messageSqlKeywords';
import {
  type SqlFunctionCompletion,
  resolveSqlDialect,
  unique,
  isMysqlFamilyDialect,
  isPgLikeDialect,
  isOracleLikeDialect,
} from './sqlDialectCore';

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

/**
 * 补全候选的常用词权重（#1328）。
 *
 * COMMON_KEYWORDS 本身按手工常用度排序（SELECT、FROM、WHERE 在前），直接
 * 取下标作权重；方言关键字与其余词表条目排在常用词之后。调用方把权重拼进
 * Monaco 的 sortText（组前缀 + 权重 + 词），让常用词不再依赖字母序巧合。
 */
const UNRANKED_KEYWORD_PRIORITY = '99';

export const sqlKeywordPriority = (keyword: string): string => {
  const normalized = String(keyword || '').trim().toUpperCase();
  const index = COMMON_KEYWORDS.indexOf(normalized);
  return index >= 0 ? String(index).padStart(2, '0') : UNRANKED_KEYWORD_PRIORITY;
};

export type SqlServerVersion = { major: number; minor: number };

/**
 * 从数据库返回的版本串解析主次版本号。取第一个「主.次」形式的数字组：
 * "Oracle Database 11g ... 11.2.0.4.0" → {11, 2}（11g 无小数点，不会被误取），
 * "Microsoft SQL Server 2019 (RTM) - 15.0.1000.0" → {15, 0}（年份 2019 无小数点，
 * 同样不会被误取），"5.7.44-log" → {5, 7}。无小数点或解析不出返回 null，调用方按
 * 「版本未知」处理——不过滤，避免把可用候选误藏。
 */
export const parseSqlServerVersion = (version?: string | null): SqlServerVersion | null => {
  const match = String(version || '').match(/(\d+)\.(\d+)/);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  if (!Number.isFinite(major) || major <= 0) return null;
  return { major, minor: Number.isFinite(minor) ? minor : 0 };
};

/**
 * 方言函数的最低服务端版本（#1328）：只有引用明确、误判代价小的条目才收。
 *
 * 只按函数名精确过滤——关键字级的版本门控是危险的：OFFSET、FETCH、ROWS 这类
 * 词在不同版本里语义不同（Oracle 的 FETCH 在游标语法里早已存在），按单词
 * 过滤会把合法候选藏掉。版本未知或无法解析时不过滤；新条目随 PR 补充并注明
 * 版本依据。
 */
const SQL_FUNCTION_MIN_VERSIONS: Record<string, Record<string, SqlServerVersion>> = {
  sqlserver: {
    // IIF: SQL Server 2012 (11.0)
    IIF: { major: 11, minor: 0 },
    // STRING_AGG: SQL Server 2017 (14.0)
    STRING_AGG: { major: 14, minor: 0 },
  },
};

const meetsMinimumVersion = (parsed: SqlServerVersion, minimum: SqlServerVersion): boolean => (
  parsed.major > minimum.major || (parsed.major === minimum.major && parsed.minor >= minimum.minor)
);

export const filterFunctionsByMinimumVersion = (
  functions: SqlFunctionCompletion[],
  dialect: string,
  serverVersion?: string | null,
): SqlFunctionCompletion[] => {
  const gates = SQL_FUNCTION_MIN_VERSIONS[dialect];
  if (!gates) return functions;
  const parsed = parseSqlServerVersion(serverVersion);
  if (!parsed) return functions;
  return functions.filter((func) => {
    const minimum = gates[func.name];
    return minimum ? meetsMinimumVersion(parsed, minimum) : true;
  });
};

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
  if (dialect === 'pulsar') return PULSAR_KEYWORDS.slice();
  return COMMON_KEYWORDS;
};
