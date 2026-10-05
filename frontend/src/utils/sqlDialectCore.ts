import { getDataSourceDialectFamily, getDataSourceSpec, getDataSourceSpecByDialect } from './dataSourceRegistry';
import { resolveOceanBaseProtocolForDialect } from './oceanBaseProtocol';
import { splitQualifiedNameSegmentsDetailed, splitQualifiedNameSegments } from './qualifiedName';

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
  | 'pulsar'
  | 'mongodb'
  | 'redis'
  | 'elasticsearch'
  | 'chroma'
  | 'qdrant'
  | 'milvus'
  | 'unknown'
  | string;

export const unique = <T>(items: T[]): T[] => Array.from(new Set(items));

export const optionValues = (values: string[]): ColumnTypeOption[] => values.map((value) => ({ value }));

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
  // 借用方言的描述表数据源（TiDB → mysql、CockroachDB → postgres）在编辑器、侧栏与表设计器里按兼容方言处理。
  const registrySpec = getDataSourceSpec(source);
  if (registrySpec) return registrySpec.ddlDialect || registrySpec.dialect;

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
    case 'pulsar':
    case 'apache-pulsar':
    case 'apache_pulsar':
      return 'pulsar';
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
  if (source.includes('pulsar')) return 'pulsar';
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
  || getDataSourceDialectFamily(resolveSqlDialect(dbType)) === 'mysql'
);

export const isPgLikeDialect = (dbType: string): boolean => (
  ['postgres', 'kingbase', 'highgo', 'vastbase', 'opengauss', 'gaussdb'].includes(resolveSqlDialect(dbType))
  || getDataSourceDialectFamily(resolveSqlDialect(dbType)) === 'postgres'
);

export const isOracleLikeDialect = (dbType: string): boolean => (
  ['oracle', 'dameng', 'dm'].includes(resolveSqlDialect(dbType))
  || getDataSourceDialectFamily(resolveSqlDialect(dbType)) === 'oracle'
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
  const registrySpec = getDataSourceSpecByDialect(dialect);
  if (registrySpec) {
    return registrySpec.ui?.tableAlias ?? (registrySpec.family === 'oracle' ? 'bare' : 'as');
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

const stripIdentifierQuotes = (part: string, dbType = ''): string => {
  const text = String(part || '').trim();
  if (!text) return '';
  const dialect = dbType ? resolveSqlDialect(dbType) : '';
  const segments = splitQualifiedNameSegmentsDetailed(text, dialect);
  if (segments.length === 1 && segments[0].quoted) {
    return segments[0].value;
  }
  return text;
};

const escapeBacktickIdentifier = (value: string) => String(value || '').replace(/`/g, '``');
const escapeDoubleQuoteIdentifier = (value: string) => String(value || '').replace(/"/g, '""');
const escapeBracketIdentifier = (value: string) => String(value || '').replace(/]/g, ']]');

const needsPgLikeQuote = (ident: string): boolean => !/^[a-z_][a-z0-9_]*$/.test(ident);

export const unquoteSqlIdentifierPart = stripIdentifierQuotes;

export const unquoteSqlIdentifierPath = (path: string, dbType = ''): string => (
  splitQualifiedNameSegments(path, dbType).filter(Boolean).join('.')
);

export const quoteSqlIdentifierPart = (dbType: string, part: string): string => {
  const dialect = resolveSqlDialect(dbType);
  const ident = stripIdentifierQuotes(part, dialect);
  if (!ident) return '';

  if (isBacktickIdentifierDialect(dialect)) {
    return `\`${escapeBacktickIdentifier(ident)}\``;
  }
  if (isSqlServerDialect(dialect)) {
    return `[${escapeBracketIdentifier(ident)}]`;
  }
  // 描述表声明“按需加引号”的自有方言（如 GBase 8s）与 PostgreSQL 规则一致。
  if (isPgLikeDialect(dialect) || getDataSourceSpecByDialect(dialect)?.ui?.quoting === 'pg') {
    return needsPgLikeQuote(ident) ? `"${escapeDoubleQuoteIdentifier(ident)}"` : ident;
  }
  return `"${escapeDoubleQuoteIdentifier(ident)}"`;
};

export const quoteSqlIdentifierPath = (dbType: string, path: string): string => {
  const dialect = resolveSqlDialect(dbType);
  return splitQualifiedNameSegmentsDetailed(path, dialect)
    .filter((segment) => Boolean(segment.value))
    .map((segment) => quoteSqlIdentifierPart(dialect, segment.raw))
    .join('.');
};
