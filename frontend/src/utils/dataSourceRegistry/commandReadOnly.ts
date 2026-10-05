// 非 SQL 查询语言的描述表数据源按方言判定语句是否只读（只读保护、写操作提示与事务托管共用）。
// 规则与 Go 侧一致：Weaviate 见 internal/db/weaviate_command.go，InfluxDB 见 internal/db/influxdb_command.go，
// etcd 见 internal/db/etcd_command.go，ZooKeeper 见 internal/db/zookeeper_command.go，
// Meilisearch 见 internal/db/meilisearch_command.go，Typesense 见 internal/db/typesense_command.go。
// 分类器返回 undefined 表示交给通用 SQL 规则（如 InfluxQL、InfluxDB 3.x 的 SQL）。

type ReadOnlyClassifier = (statement: string) => boolean | undefined;

const WEAVIATE_REST_LINE = /^(GET|HEAD|POST|PUT|PATCH|DELETE)\s+(\/\S*)\s*$/i;

/** Weaviate：GraphQL（没有 mutation）、GET / HEAD 与 POST /v1/graphql 的 REST 请求、SELECT 为只读。 */
export const isReadOnlyWeaviateCommand = (statement: string): boolean => {
  const text = String(statement || '').trim();
  if (!text || text.startsWith('{') || /^query[\s{]/i.test(text)) {
    return true;
  }
  const match = WEAVIATE_REST_LINE.exec(text.split('\n', 1)[0].trim());
  if (match) {
    const method = match[1].toUpperCase();
    let path = match[2].split('?')[0];
    if (path !== '/v1' && !path.startsWith('/v1/')) {
      path = `/v1${path}`;
    }
    return method === 'GET' || method === 'HEAD' || (method === 'POST' && path === '/v1/graphql');
  }
  return /^select\b/i.test(text);
};

const FLUX_WRITE_CALL = /(^|[^A-Za-z0-9_])(to|wideTo)\s*\(/i;

/** 识别 Flux：以 import 或 from( 开头，或含管道符 |>。 */
export const isInfluxFluxQuery = (statement: string): boolean => {
  const text = String(statement || '').trim();
  return /^import[\s"]/i.test(text) || /^from\s*\(/i.test(text) || text.includes('|>');
};

/** InfluxDB：Flux 只在调用 to() / wideTo() 时写数据；InfluxQL 与 SQL 交给通用规则。 */
const classifyInfluxDBStatement = (statement: string): boolean | undefined => (
  isInfluxFluxQuery(statement) ? !FLUX_WRITE_CALL.test(statement) : undefined
);

const ETCD_READ_COMMANDS = new Set(['get', 'ls', 'version', 'watch', 'select']);
const ETCD_READ_SUBCOMMANDS: Record<string, string[]> = {
  lease: ['list', 'timetolive'],
  member: ['list'],
  endpoint: ['status', 'health', 'hashkv'],
  alarm: ['list'],
  user: ['list', 'get'],
  role: ['list', 'get'],
};

/** etcd：etcdctl 风格命令，get / ls / watch / version、数据浏览的 SELECT 与各类 list / status 查询为只读。 */
export const isReadOnlyEtcdCommand = (statement: string): boolean => {
  const [name = '', sub = ''] = String(statement || '').trim().split(/\s+/, 2).map((token) => token.toLowerCase());
  if (ETCD_READ_COMMANDS.has(name)) return true;
  return (ETCD_READ_SUBCOMMANDS[name] ?? []).includes(sub);
};

const ZOOKEEPER_READ_COMMANDS = new Set([
  'ls', 'ls2', 'get', 'stat', 'getacl', 'sync', 'addauth', 'version', 'config', 'getallchildrennumber', 'getephemerals',
  'listquota', 'select',
]);
// 四字命令里只有 crst / srst（重置服务端统计）是写操作。
const ZOOKEEPER_READ_FOUR_LETTER_WORDS = new Set([
  'srvr', 'stat', 'ruok', 'conf', 'envi', 'mntr', 'cons', 'wchs', 'wchc', 'wchp', 'dump', 'isro', 'dirs', 'gtmk',
]);

/** ZooKeeper：zkCli 风格命令，ls / get / stat / getAcl 等查询、只读四字命令与数据浏览的 SELECT 为只读。 */
export const isReadOnlyZooKeeperCommand = (statement: string): boolean => {
  const [name = '', word = ''] = String(statement || '').trim().split(/\s+/, 2).map((token) => token.toLowerCase());
  if (name === '4lw') return ZOOKEEPER_READ_FOUR_LETTER_WORDS.has(word);
  return ZOOKEEPER_READ_COMMANDS.has(name) || ZOOKEEPER_READ_FOUR_LETTER_WORDS.has(name);
};

// Meilisearch 里 POST 但只读的接口：搜索、多索引搜索、分面搜索、相似文档与按条件取文档。
const MEILISEARCH_READ_POST = /^\/(multi-search|indexes\/[^/]+\/(search|facet-search|similar|documents\/fetch))\/?$/;

/** Meilisearch：每个「METHOD /path」请求行都是 GET / HEAD 或搜索类 POST 时只读；非 REST 文本只有 SELECT 只读。 */
export const isReadOnlyMeilisearchCommand = (statement: string): boolean => {
  const text = String(statement || '').trim();
  const lines = text.split(/\r?\n/);
  if (!WEAVIATE_REST_LINE.test(lines[0].trim())) {
    return /^select\b/i.test(text);
  }
  const requests = lines
    .map((line) => WEAVIATE_REST_LINE.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null);
  return requests.every((match) => {
    const method = match[1].toUpperCase();
    return method === 'GET' || method === 'HEAD' || (method === 'POST' && MEILISEARCH_READ_POST.test(match[2].split('?')[0]));
  });
};

/** Typesense：每个「METHOD /path」请求行都是 GET / HEAD（含搜索与导出）或 POST /multi_search 时只读；非 REST 文本只有 SELECT 只读。 */
export const isReadOnlyTypesenseCommand = (statement: string): boolean => {
  const text = String(statement || '').trim();
  const lines = text.split(/\r?\n/);
  if (!WEAVIATE_REST_LINE.test(lines[0].trim())) {
    return /^select\b/i.test(text);
  }
  return lines
    .map((line) => WEAVIATE_REST_LINE.exec(line.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .every((match) => {
      const method = match[1].toUpperCase();
      return method === 'GET' || method === 'HEAD' || (method === 'POST' && match[2].split('?')[0].replace(/\/$/, '') === '/multi_search');
    });
};

const REGISTRY_READ_ONLY_CLASSIFIERS: Record<string, ReadOnlyClassifier> = {
  weaviate: isReadOnlyWeaviateCommand,
  influxdb: classifyInfluxDBStatement,
  etcd: isReadOnlyEtcdCommand,
  zookeeper: isReadOnlyZooKeeperCommand,
  meilisearch: isReadOnlyMeilisearchCommand,
  typesense: isReadOnlyTypesenseCommand,
};

/** 返回该方言的只读判定函数；SQL 方言返回 undefined，交给通用 SQL 规则。 */
export const resolveRegistryReadOnlyClassifier = (dialect: string): ReadOnlyClassifier | undefined =>
  REGISTRY_READ_ONLY_CLASSIFIERS[String(dialect || '').trim().toLowerCase()];
