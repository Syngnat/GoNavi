export type ConnectionTypeCatalogItem = {
  key: string;
  name: string;
  nameKey?: string;
};

export type ConnectionTypeCatalogTranslator = (
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
) => string;

export type ConnectionTypeCatalogGroup = {
  labelKey: string;
  label: string;
  items: ConnectionTypeCatalogItem[];
};

export const orderConnectionTypeCatalogItems = (
  items: readonly ConnectionTypeCatalogItem[],
  pinnedTypes: readonly string[],
): ConnectionTypeCatalogItem[] => {
  const pinnedRank = new Map<string, number>();
  pinnedTypes.forEach((type, index) => {
    const normalized = String(type || "").trim().toLowerCase();
    if (normalized && !pinnedRank.has(normalized)) {
      pinnedRank.set(normalized, index);
    }
  });

  return items
    .map((item, originalIndex) => ({ item, originalIndex }))
    .sort((left, right) => {
      const leftRank = pinnedRank.get(left.item.key.toLowerCase());
      const rightRank = pinnedRank.get(right.item.key.toLowerCase());
      if (leftRank !== undefined && rightRank !== undefined) {
        return leftRank - rightRank;
      }
      if (leftRank !== undefined) return -1;
      if (rightRank !== undefined) return 1;
      return left.originalIndex - right.originalIndex;
    })
    .map(({ item }) => item);
};

const translateCatalogCopy = (
  translate: ConnectionTypeCatalogTranslator | undefined,
  key: string,
  fallback: string,
): string => {
  if (!translate) return fallback;
  const translated = translate(key);
  return translated && translated !== key ? translated : fallback;
};

export const CONNECTION_TYPE_GROUPS: ConnectionTypeCatalogGroup[] = [
  {
    labelKey: 'connection_modal.step1.group.relational',
    label: 'Relational databases',
    items: [
      { key: 'mysql', name: 'MySQL' },
      { key: 'mariadb', name: 'MariaDB' },
      { key: 'diros', name: 'Doris' },
      { key: 'starrocks', name: 'StarRocks' },
      { key: 'sphinx', name: 'Sphinx' },
      { key: 'clickhouse', name: 'ClickHouse' },
      { key: 'trino', name: 'Trino' },
      { key: 'postgres', name: 'PostgreSQL' },
      { key: 'sqlserver', name: 'SQL Server' },
      { key: 'iris', name: 'InterSystems IRIS' },
      { key: 'sqlite', name: 'SQLite' },
      { key: 'duckdb', name: 'DuckDB' },
      { key: 'oracle', name: 'Oracle' },
    ],
  },
  {
    labelKey: 'connection_modal.step1.group.domestic',
    label: 'Domestic databases',
    items: [
      { key: 'oceanbase', name: 'OceanBase' },
      { key: 'dameng', name: 'Dameng (达梦)' },
      { key: 'kingbase', name: 'Kingbase (人大金仓)' },
      { key: 'highgo', name: 'HighGo (瀚高)' },
      { key: 'vastbase', name: 'Vastbase (海量)' },
      { key: 'opengauss', name: 'OpenGauss' },
      { key: 'gaussdb', name: 'GaussDB' },
      { key: 'goldendb', name: 'GoldenDB' },
    ],
  },
  {
    labelKey: 'connection_modal.step1.group.nosql',
    label: 'NoSQL',
    items: [
      { key: 'mongodb', name: 'MongoDB' },
      { key: 'redis', name: 'Redis' },
      { key: 'elasticsearch', name: 'Elasticsearch' },
    ],
  },
  {
    labelKey: 'connection_modal.step1.group.vector',
    label: 'Vector databases',
    items: [
      { key: 'chroma', name: 'Chroma' },
      { key: 'qdrant', name: 'Qdrant' },
      { key: 'milvus', name: 'Milvus' },
    ],
  },
  {
    labelKey: 'connection_modal.step1.group.timeseries',
    label: 'Time-series databases',
    items: [
      { key: 'tdengine', name: 'TDengine' },
      { key: 'iotdb', name: 'Apache IoTDB' },
    ],
  },
  {
    labelKey: 'connection_modal.step1.group.message_queue',
    label: 'Message queues',
    items: [
      { key: 'rocketmq', name: 'RocketMQ' },
      { key: 'mqtt', name: 'MQTT' },
      { key: 'kafka', name: 'Kafka' },
      { key: 'rabbitmq', name: 'RabbitMQ' },
    ],
  },
  {
    labelKey: 'connection_modal.step1.group.config_center',
    label: 'Config centers',
    items: [
      { key: 'nacos', name: 'Nacos' },
    ],
  },
  {
    labelKey: 'connection_modal.step1.group.other',
    label: 'Other',
    items: [
      { key: 'jvm', name: 'JVM Runtime', nameKey: 'connection_modal.layoutKind.jvm' },
      { key: 'custom', name: 'Custom', nameKey: 'connection_modal.db_icon_label.custom' },
    ],
  },
];

export const buildConnectionTypeGroups = (
  translate?: ConnectionTypeCatalogTranslator,
): ConnectionTypeCatalogGroup[] =>
  CONNECTION_TYPE_GROUPS.map((group) => ({
    ...group,
    label: translateCatalogCopy(translate, group.labelKey, group.label),
    items: group.items.map((item) => ({
      ...item,
      name: item.nameKey
        ? translateCatalogCopy(translate, item.nameKey, item.name)
        : item.name,
    })),
  }));

export const getConnectionTypeDefaultPort = (type: string): number => {
  switch (String(type || '').trim().toLowerCase()) {
    case 'jvm':
      return 9010;
    case 'mysql':
      return 3306;
    case 'oceanbase':
      return 2881;
    case 'goldendb':
      return 1523;
    case 'doris':
    case 'diros':
    case 'starrocks':
      return 9030;
    case 'sphinx':
      return 9306;
    case 'clickhouse':
      return 9000;
    case 'trino':
      return 8080;
    case 'postgres':
    case 'opengauss':
    case 'gaussdb':
      return 5432;
    case 'redis':
      return 6379;
    case 'tdengine':
      return 6041;
    case 'iotdb':
      return 6667;
    case 'oracle':
      return 1521;
    case 'dameng':
      return 5236;
    case 'kingbase':
      return 54321;
    case 'sqlserver':
      return 1433;
    case 'iris':
      return 1972;
    case 'mongodb':
      return 27017;
    case 'elasticsearch':
      return 9200;
    case 'chroma':
      return 8000;
    case 'qdrant':
      return 6333;
    case 'milvus':
      return 19530;
    case 'rocketmq':
      return 9876;
    case 'mqtt':
      return 1883;
    case 'kafka':
      return 9092;
    case 'rabbitmq':
      return 15672;
    case 'nacos':
      return 8848;
    case 'highgo':
      return 5866;
    case 'mariadb':
      return 3306;
    case 'vastbase':
      return 5432;
    case 'sqlite':
    case 'duckdb':
      return 0;
    default:
      return 3306;
  }
};

export const getConnectionTypeHint = (
  type: string,
  translate?: ConnectionTypeCatalogTranslator,
): string => {
  switch (String(type || '').trim().toLowerCase()) {
    case 'jvm':
      return translateCatalogCopy(translate, 'connection_modal.step1.hint.jvm', 'JMX / Endpoint / Agent');
    case 'custom':
      return translateCatalogCopy(translate, 'connection_modal.step1.hint.custom', 'Custom driver and DSN');
    case 'redis':
      return translateCatalogCopy(translate, 'connection_modal.step1.hint.redis', 'Single node / cluster');
    case 'mongodb':
      return translateCatalogCopy(translate, 'connection_modal.step1.hint.mongodb', 'Single node / replica set');
    case 'elasticsearch':
      return translateCatalogCopy(
        translate,
        'connection_modal.step1.hint.elasticsearch',
        'Index browsing, Mapping inspection, JSON DSL, and query_string queries',
      );
    case 'chroma':
      return translateCatalogCopy(
        translate,
        'connection_modal.step1.hint.chroma',
        'Collection browsing, vector retrieval, and metadata filtering',
      );
    case 'qdrant':
      return translateCatalogCopy(
        translate,
        'connection_modal.step1.hint.qdrant',
        'Collection browsing, vector search, and Payload filtering',
      );
    case 'milvus':
      return translateCatalogCopy(
        translate,
        'connection_modal.step1.hint.milvus',
        'Collection browsing, vector search, and scalar filtering',
      );
    case 'iotdb':
      return 'Storage Group / Device / Timeseries';
    case 'rocketmq':
      return 'NameServer / Topic / Consumer Group';
    case 'mqtt':
      return 'Broker / Topic Filter / QoS';
    case 'kafka':
      return 'Broker / Topic / Consumer Group';
    case 'rabbitmq':
      return 'Management API / Virtual Host / Queue';
    case 'nacos':
      return translateCatalogCopy(
        translate,
        'connection_modal.step1.hint.nacos',
        'Browse and publish configs across namespaces',
      );
    case 'oceanbase':
      return translateCatalogCopy(translate, 'connection_modal.step1.hint.oceanBase', 'MySQL / Oracle tenant');
    case 'goldendb':
      return translateCatalogCopy(
        translate,
        'connection_modal.step1.hint.goldendb',
        'MySQL compatible / distributed transactions',
      );
    case 'sqlite':
    case 'duckdb':
      return translateCatalogCopy(translate, 'connection_modal.step1.hint.file', 'Local file connection');
    case 'trino':
      return 'HTTP / HTTPS / catalog.schema';
    default:
      return translateCatalogCopy(
        translate,
        'connection_modal.step1.hint.standard',
        'Standard connection configuration',
      );
  }
};

export const getAllConnectionTypeCatalogItems = (): ConnectionTypeCatalogItem[] =>
  CONNECTION_TYPE_GROUPS.flatMap((group) => group.items);
