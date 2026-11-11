import { getDataSourceDialectFamily, getDataSourceSpec, getDataSourceSpecByDialect } from './dataSourceRegistry';
import { pluginDataSourceConfigType, parsePluginDataSourceType } from '../plugins/dataSource/identity';
import { resolveOceanBaseProtocolForDialect } from './oceanBaseProtocol';
import { splitQualifiedNameSegmentsDetailed, splitQualifiedNameSegments } from './qualifiedName';
import { quoteInterSystemsIdent } from './intersystemsIdentifiers';

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
  const pluginType = pluginDataSourceConfigType({ type: rawType, driver: rawDriver });
  if (pluginType) return parsePluginDataSourceType(pluginType)?.dialect ?? 'unknown';
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
  isMysqlFamilyDialect(dbType) || ['clickhouse', 'tdengine', 'iotdb', 'hive'].includes(resolveSqlDialect(dbType))
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

// Oracle 家族：裸标识符会被折叠为大写，双引号则精确匹配、区分大小写。
//
// 判断依据是「这个名字能不能裸写后仍指向同一个对象」：
//   - 全大写（`ORDERS`）：裸写折叠后仍是 `ORDERS`，不加引号。
//   - 小写或混合大小写（`orders`、`Order_Items`）：只有带引号才指向原对象；
//     裸写会被折叠成 `ORDERS`，反而查不到（正是 ORA-00942 的来源）。
//   - 含空格、连字符、中文等裸名不允许的字符：必须加引号。
//
// 注意不能只看「是否是合法裸名」——`orders` 语法上合法，语义上却是另一个对象。
const ORACLE_BARE_IDENT_RE = /^[A-Z_][A-Z0-9_$#]*$/;
const needsOracleQuote = (ident: string): boolean => !ORACLE_BARE_IDENT_RE.test(ident);

export const unquoteSqlIdentifierPart = stripIdentifierQuotes;

export const unquoteSqlIdentifierPath = (path: string, dbType = ''): string => (
  splitQualifiedNameSegments(path, dbType).filter(Boolean).join('.')
);

export const quoteSqlIdentifierPart = (
  dbType: string,
  part: string,
  options?: { oceanBaseProtocol?: unknown },
): string => {
  // OceanBase 的方言取决于连接协议：不传协议就退化为 mysql（反引号），
  // 在 Oracle 租户上会直接产生非法标识符。调用方知道协议时必须传进来。
  const dialect = resolveSqlDialect(dbType, '', options);
  const ident = stripIdentifierQuotes(part, dialect);
  if (!ident) return '';

  // 调用方原本已显式定界（`"Order Items"`）时必须保留定界语义：Oracle 家族会
  // 区分大小写，剥掉引号再决定就是猜。这里先判断来源是否带引号。
  const sourceWasQuoted = (() => {
    const text = String(part || '').trim();
    if (!text) return false;
    const segments = splitQualifiedNameSegmentsDetailed(text, dialect);
    return segments.length === 1 && Boolean(segments[0].quoted);
  })();

  if (isBacktickIdentifierDialect(dialect)) {
    return `\`${escapeBacktickIdentifier(ident)}\``;
  }
  if (isOracleLikeDialect(dialect)) {
    // Oracle 家族按需定界：来源已定界或裸名不合法时才加双引号。
    return sourceWasQuoted || needsOracleQuote(ident)
      ? `"${escapeDoubleQuoteIdentifier(ident)}"`
      : ident;
  }
  if (isSqlServerDialect(dialect)) {
    return `[${escapeBracketIdentifier(ident)}]`;
  }
  // IRIS/Caché 的双引号只在服务端开启 DelimitedIds 时才是标识符定界符；关闭时会被当成
  // 字符串字面量（`FROM "BDA_Store"` 报 LITERAL ('BDA_Store') found）。裸名在两种配置下
  // 都能解析且大小写不敏感，所以按需加引号，规则与 PostgreSQL 的大小写折叠不同。
  if (dialect === 'iris') {
    return quoteInterSystemsIdent(ident);
  }
  // 描述表声明“按需加引号”的自有方言（如 GBase 8s）与 PostgreSQL 规则一致。
  if (isPgLikeDialect(dialect) || getDataSourceSpecByDialect(dialect)?.ui?.quoting === 'pg') {
    return needsPgLikeQuote(ident) ? `"${escapeDoubleQuoteIdentifier(ident)}"` : ident;
  }
  return `"${escapeDoubleQuoteIdentifier(ident)}"`;
};

export const quoteSqlIdentifierPath = (
  dbType: string,
  path: string,
  options?: { oceanBaseProtocol?: unknown },
): string => {
  const dialect = resolveSqlDialect(dbType, '', options);
  return splitQualifiedNameSegmentsDetailed(path, dialect)
    .filter((segment) => Boolean(segment.value))
    .map((segment) => quoteSqlIdentifierPart(dialect, segment.raw))
    .join('.');
};
