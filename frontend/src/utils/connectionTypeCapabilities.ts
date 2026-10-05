import {
  canonicalizeDataSourceType,
  getDataSourceSpec,
  isDataSourceFamily,
  isRegistryDataSource,
  listDataSourceSpecs,
  listDataSourceTypesWhere,
} from "./dataSourceRegistry";

export const PRIMARY_USERNAME_OPTIONAL_TYPES = new Set([
  "redis", "mongodb", "elasticsearch", "chroma", "qdrant", "milvus", "nacos",
  "rocketmq", "mqtt", "kafka", "rabbitmq", "pulsar",
  ...listDataSourceTypesWhere((spec) => Boolean(spec.ui?.usernameOptional)),
]);

export const singleHostUriSchemesByType: Record<string, string[]> = {
  postgres: ["postgresql", "postgres"],
  opengauss: ["opengauss", "jdbc:opengauss", "postgresql", "postgres"],
  gaussdb: ["gaussdb", "postgresql", "postgres"],
  clickhouse: ["clickhouse"],
  trino: ["trino", "http", "https"],
  oracle: ["oracle"],
  sqlserver: ["sqlserver"],
  iris: ["iris", "intersystems"],
  cache: ["cache", "intersystems-cache", "intersystemscache"],
  redis: ["redis"],
  tdengine: ["tdengine"],
  iotdb: ["iotdb"],
  dameng: ["dameng", "dm"],
  kingbase: ["kingbase"],
  highgo: ["highgo"],
  vastbase: ["vastbase"],
  elasticsearch: ["http", "https"],
  chroma: ["http", "https", "chroma"],
  qdrant: ["http", "https", "qdrant"],
  milvus: ["http", "https", "milvus"],
  rocketmq: ["rocketmq", "rmq"],
  mqtt: ["mqtt", "mqtts", "tcp", "ssl", "tls"],
  rabbitmq: ["rabbitmq", "http", "https"],
  pulsar: ["pulsar", "pulsar+ssl"],
  nacos: ["http", "https", "nacos"],
  ...Object.fromEntries(
    listDataSourceSpecs()
      .filter((spec) => (spec.ui?.uriSchemes?.length ?? 0) > 0)
      .map((spec) => [spec.type, spec.ui?.uriSchemes ?? []]),
  ),
};

const normalizeConnectionType = (type: string) =>
  {
    const normalized = String(type || "")
      .trim()
      .toLowerCase();
    switch (normalized) {
      case "goldendb":
      case "greatdb":
      case "gdb":
        return "goldendb";
      case "rocket-mq":
      case "rocket_mq":
      case "apache-rocketmq":
      case "apache_rocketmq":
      case "rmq":
        return "rocketmq";
      case "mqtts":
        return "mqtt";
      case "apache-pulsar":
      case "apache_pulsar":
        return "pulsar";
      default:
        return canonicalizeDataSourceType(normalized);
    }
  };

const sslSupportedTypes = new Set([
  "mysql",
  "goldendb",
  "mariadb",
  "oceanbase",
  "doris",
  "diros",
  "starrocks",
  "sphinx",
  "dameng",
  "clickhouse",
  "trino",
  "postgres",
  "sqlserver",
  "oracle",
  "kingbase",
  "highgo",
  "vastbase",
  "opengauss",
  "gaussdb",
  "mongodb",
  "redis",
  "tdengine",
  "elasticsearch",
  "chroma",
  "qdrant",
  "milvus",
  "mqtt",
  "kafka",
  "rabbitmq",
  "pulsar",
  "nacos",
  ...listDataSourceTypesWhere((spec) => Boolean(spec.ui?.ssl)),
]);

export const supportsSSLForType = (type: string) =>
  sslSupportedTypes.has(normalizeConnectionType(type));

const sslCAPathSupportedTypes = new Set([
  "mysql",
  "goldendb",
  "mariadb",
  "oceanbase",
  "diros",
  "starrocks",
  "sphinx",
  "clickhouse",
  "trino",
  "postgres",
  "sqlserver",
  "kingbase",
  "highgo",
  "vastbase",
  "opengauss",
  "gaussdb",
  "mongodb",
  "redis",
  "elasticsearch",
  "chroma",
  "qdrant",
  "milvus",
  "mqtt",
  "kafka",
  "rabbitmq",
  "pulsar",
  ...listDataSourceTypesWhere((spec) => Boolean(spec.ui?.sslCAPath)),
]);

const sslClientCertificateSupportedTypes = new Set([
  "mysql",
  "goldendb",
  "mariadb",
  "oceanbase",
  "diros",
  "starrocks",
  "sphinx",
  "dameng",
  "clickhouse",
  "trino",
  "postgres",
  "kingbase",
  "highgo",
  "vastbase",
  "opengauss",
  "gaussdb",
  "mongodb",
  "redis",
  "mqtt",
  "kafka",
  "rabbitmq",
  "pulsar",
  ...listDataSourceTypesWhere((spec) => Boolean(spec.ui?.sslClientCert)),
]);

export const supportsSSLCAPathForType = (type: string) =>
  sslCAPathSupportedTypes.has(normalizeConnectionType(type));

export const supportsSSLClientCertificateForType = (type: string) =>
  sslClientCertificateSupportedTypes.has(normalizeConnectionType(type));

export const isPostgresCompatibleSSLType = (type: string) =>
  [
    "postgres",
    "kingbase",
    "highgo",
    "vastbase",
    "opengauss",
    "gaussdb",
  ].includes(normalizeConnectionType(type)) || isDataSourceFamily(type, "postgres");

export const isFileDatabaseType = (type: string) =>
  type === "sqlite" || type === "duckdb";

export const isMySQLCompatibleType = (type: string) =>
  normalizeConnectionType(type) === "mysql" ||
  normalizeConnectionType(type) === "goldendb" ||
  normalizeConnectionType(type) === "mariadb" ||
  normalizeConnectionType(type) === "oceanbase" ||
  normalizeConnectionType(type) === "doris" ||
  normalizeConnectionType(type) === "diros" ||
  normalizeConnectionType(type) === "starrocks" ||
  normalizeConnectionType(type) === "sphinx" ||
  isDataSourceFamily(type, "mysql");

export const supportsConnectionParamsForType = (type: string) =>
  isMySQLCompatibleType(type) ||
  type === "postgres" ||
  type === "kingbase" ||
  type === "highgo" ||
  type === "vastbase" ||
  type === "opengauss" ||
  type === "gaussdb" ||
  type === "oracle" ||
  type === "sqlserver" ||
  type === "iris" ||
  type === "cache" ||
  type === "clickhouse" ||
  type === "trino" ||
  type === "mongodb" ||
  type === "dameng" ||
  type === "tdengine" ||
  type === "iotdb" ||
  type === "elasticsearch" ||
  type === "chroma" ||
  type === "qdrant" ||
  type === "milvus" ||
  type === "rocketmq" ||
  type === "mqtt" ||
  type === "kafka" ||
  type === "rabbitmq" ||
  type === "pulsar" ||
  type === "nacos" ||
  (isRegistryDataSource(type) && getDataSourceSpec(type)?.ui?.connectionParams !== false);
