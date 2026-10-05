// 与 internal/datasource/specs/<type>.json 保持字段一致；Go 侧读取同一批文件。

export type DataSourceCatalogGroup =
  | 'relational'
  | 'domestic'
  | 'nosql'
  | 'search'
  | 'vector'
  | 'timeseries'
  | 'bigdata'
  | 'config_center';

export type DataSourceAgentBuild = {
  // 代理驱动键：默认代理留空（等同类型名），独立构建档位必填（如 cassandra_legacy）。
  key?: string;
  buildTag: string;
  goModule?: string;
  version?: string;
  cgo?: boolean;
  platforms?: string[];
  sourcePrefixes?: string[];
};

export type DataSourceVariant = {
  id: string;
  label: string;
  descriptionKey?: string;
  minServer?: string;
  maxServer?: string;
  build?: DataSourceAgentBuild;
};

export type DataSourceVariantSet = {
  auto?: boolean;
  default: string;
  items: DataSourceVariant[];
};

// 连接表单相关的前端声明；Go 侧忽略该段。
export type DataSourceUISpec = {
  uriSchemes?: string[];
  ssl?: boolean;
  sslCAPath?: boolean;
  sslClientCert?: boolean;
  usernameOptional?: boolean;
  connectionParams?: boolean;
  hintKey?: string;
  hint?: string;
  // 允许展示的网络安全分区（ssl、ssh、proxy、httpTunnel）；缺省表示全部。
  networkSections?: string[];
  layout?: string;
  // 标识符引号：缺省按兼容家族（mysql → 反引号，postgres → 按需双引号），其余为双引号。
  quoting?: 'backtick' | 'pg' | 'double' | 'bracket';
  // 展示 DDL 时是否用 sql-formatter 重排：服务端 DDL 已排好版且语法不在格式化器支持范围内时设为 false。
  formatDdl?: boolean;
  // 新建连接时预填的用户名（缺省 root）。
  defaultUser?: string;
  // 侧栏、对象列表与导出不显示的 schema 前缀（扩展的内部 schema，如 TimescaleDB 的 _timescaledb_ / timescaledb_）。
  hiddenSchemaPrefixes?: string[];
  // 按全名隐藏的内部 schema（GBase 8c 的 blockchain、sys 等），与前缀规则一起生效。
  hiddenSchemas?: string[];
  // 函数列表不含 CREATE EXTENSION 带入的函数（TimescaleDB 在 public 下装了上百个 time_bucket 等函数）。
  hideExtensionRoutines?: boolean;
  // 视图列表不含扩展带入的视图（GBase 8c Oracle 兼容扩展建在 public 下的 dual 等）。
  hideExtensionViews?: boolean;
  // PostgreSQL 系表统计表达式（行数 / 总大小 / 索引大小），按顺序取第一条服务端版本区间匹配的项，带区间的项只在
  // 版本已知时匹配，都不匹配时用 PostgreSQL 默认表达式；{{oid}} 是表的 pg_class.oid，{{reltuples}} 是默认行数估计。
  tableStats?: Array<{ minServer?: string; maxServer?: string; rows?: string; size?: string; indexSize?: string }>;
  // 侧栏不显示的对象分组（routines、triggers、events、sequences 等）：借用方言里有、该数据源没有的对象。
  hiddenObjectGroups?: string[];
  // 侧栏元数据查询（未借用方言的数据源）：views 按顺序尝试，第一条成功的结果生效，需返回 view_name 列；
  // tableStatus 是侧栏表状态与对象概览共用的整条查询（table_name、table_comment、table_rows、data_length、
  // index_length 等列），按服务端版本区间取第一条匹配项。语句里可用 {{database}} 引用当前库名。
  metadataQueries?: {
    views?: string[];
    // 触发器（trigger_name、table_name）、函数与存储过程（routine_name、routine_type）、序列（sequence_name），规则同 views。
    triggers?: string[];
    routines?: string[];
    sequences?: string[];
    tableStatus?: Array<{ minServer?: string; maxServer?: string; sql: string }>;
  };
  // 对象名（etcd 键路径、znode 路径）整体是一个标识符，引用时不按点拆成 schema.table。
  flatObjectNames?: boolean;
  // 连接串里第一个之外的节点存到哪个连接参数（如 ZooKeeper 的 servers），生成连接串时再并回主机段。
  extraHostsParam?: string;
  // 未借用方言的数据源的对象操作语句（renameTable、dropTable、dropView、dropRoutine、truncateTable、clearTable），由后端执行。
  objectStatements?: Record<string, string>;
  // 例程、触发器与包的定义改由驱动给出（借用方言的系统视图与该数据源不符时，如崖山的 ALL_SOURCE 没有 LINE 列）。
  driverObjectDefinitions?: boolean;
  // 连接表单里的专用参数字段（值存在连接参数文本里），如 GBase 8s 的 CSDK 目录 clientDir。
  paramFields?: Array<{ key: string; labelKey: string; helpKey?: string; placeholder?: string }>;
  // 表设计器的索引限制：可建的索引类别（NORMAL / UNIQUE / PRIMARY …）与索引方法（首项为默认），如 GBase 8a 只有普通 HASH 索引。
  indexDesign?: { kinds?: string[]; methods: string[] };
  // 表别名语法：缺省 oracle 家族为 bare，其余为 as；非 SQL 查询语言用 none。
  tableAlias?: 'as' | 'bare' | 'none';
  // 数据浏览未指定排序时不追加主键排序：引擎自身的顺序已稳定，且主键不能由服务端排序（Meilisearch、Typesense）。
  naturalOrder?: boolean;
  // 数据浏览分页语法：缺省 LIMIT n OFFSET m。
  pagination?: 'limit-offset' | 'limit-range' | 'offset-limit' | 'limit-start' | 'skip-first' | 'rows-to' | 'offset-fetch';
  // 图标：asset 指向官方 logo；缺省时使用 /db-icons/<type>.svg（可由 tools/generate-datasource-icons.py 生成字母徽标）。
  icon?: { color: string; text?: string; scale?: number; asset?: string };
};

export type DataSourceSpec = {
  type: string;
  aliases?: string[];
  displayName: string;
  group: DataSourceCatalogGroup;
  order?: number;
  defaultPort?: number;
  wire: string;
  dialect: string;
  ddlDialect?: string;
  family?: string;
  objectKind?: string;
  caseSensitiveIdentifiers?: boolean;
  versionQuery?: string;
  syntheticDatabase?: boolean;
  proxyMode?: 'forward' | 'driver';
  protection?: boolean;
  excelImport?: boolean;
  sqlFileImport?: boolean;
  // sync 声明能否作为数据同步 / 迁移的源与目标；未声明的类型不出现在同步的连接选择里。
  sync?: { source?: boolean; target?: boolean };
  agent: DataSourceAgentBuild;
  variants: DataSourceVariantSet;
  ui?: DataSourceUISpec;
};

export const DATA_SOURCE_VARIANT_AUTO = 'auto';
