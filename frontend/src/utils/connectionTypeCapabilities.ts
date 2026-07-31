export const singleHostUriSchemesByType: Record<string, string[]> = {
  postgres: ["postgresql", "postgres"],
  opengauss: ["opengauss", "jdbc:opengauss", "postgresql", "postgres"],
  gaussdb: ["gaussdb", "postgresql", "postgres"],
  clickhouse: ["clickhouse"],
  trino: ["trino", "http", "https"],
  oracle: ["oracle"],
  sqlserver: ["sqlserver"],
  iris: ["iris", "intersystems"],
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
  nacos: ["http", "https", "nacos"],
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
      default:
        return normalized;
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
  "nacos",
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
  ].includes(normalizeConnectionType(type));

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
  normalizeConnectionType(type) === "sphinx";

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
  type === "nacos";
