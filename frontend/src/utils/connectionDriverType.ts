import type { SavedConnection } from "../types";

export type DriverStatusSnapshot = {
  type: string;
  name: string;
  connectable: boolean;
  expectedRevision?: string;
  needsUpdate?: boolean;
  updateReason?: string;
  affectedConnections?: number;
  message?: string;
};

export const normalizeDriverType = (value: string): string => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (
    normalized === "postgresql" ||
    normalized === "pg" ||
    normalized === "pq" ||
    normalized === "pgx"
  )
    return "postgres";
  if (normalized === "elastic") return "elasticsearch";
  if (normalized === "chromadb" || normalized === "chroma-db") return "chroma";
  if (normalized === "qdrantdb" || normalized === "qdrant-db") return "qdrant";
  if (normalized === "milvusdb" || normalized === "milvus-db") return "milvus";
  if (
    normalized === "rocket-mq" ||
    normalized === "rocket_mq" ||
    normalized === "apache-rocketmq" ||
    normalized === "apache_rocketmq" ||
    normalized === "rmq"
  )
    return "rocketmq";
  if (normalized === "apache-iotdb" || normalized === "apache_iotdb")
    return "iotdb";
  if (normalized === "mqtts") return "mqtt";
  if (normalized === "apache-kafka" || normalized === "apache_kafka")
    return "kafka";
  if (normalized === "rabbit-mq" || normalized === "rabbit_mq")
    return "rabbitmq";
  if (normalized === "doris") return "diros";
  if (
    normalized === "open_gauss" ||
    normalized === "open-gauss" ||
    normalized === "opengauss"
  )
    return "opengauss";
  if (
    normalized === "gaussdb" ||
    normalized === "gauss_db" ||
    normalized === "gauss-db"
  )
    return "gaussdb";
  if (
    normalized === "goldendb" ||
    normalized === "greatdb" ||
    normalized === "gdb"
  )
    return "goldendb";
  if (
    normalized === "intersystems" ||
    normalized === "intersystemsiris" ||
    normalized === "inter-systems" ||
    normalized === "inter-systems-iris"
  )
    return "iris";
  if (
    normalized === "cache" ||
    normalized === "caché" ||
    normalized === "intersystems cache" ||
    normalized === "intersystems caché" ||
    normalized === "intersystems-cache" ||
    normalized === "intersystems-caché" ||
    normalized === "intersystemscache" ||
    normalized === "intersystemscaché" ||
    normalized === "inter-systems-cache" ||
    normalized === "inter-systems-caché" ||
    normalized === "intersystems-cache-database" ||
    normalized === "cache-db" ||
    normalized === "cachedb"
  )
    return "cache";
  return normalized;
};

export const resolveConnectionDriverType = (
  type: string,
  driver?: string,
): string => {
  const normalizedType = normalizeDriverType(type);
  if (normalizedType !== "custom") {
    return normalizedType;
  }
  return normalizeDriverType(driver || "");
};

export const resolveSavedConnectionDriverType = (
  conn: SavedConnection | undefined,
): string => {
  return resolveConnectionDriverType(
    conn?.config?.type || "",
    conn?.config?.driver || "",
  );
};

export const isPostgresSchemaDialect = (dialect: string): boolean =>
  [
    "postgres",
    "kingbase",
    "highgo",
    "vastbase",
    "opengauss",
    "gaussdb",
  ].includes(normalizeDriverType(dialect));

export const supportsIndependentSchemaSelection = (dialect: string): boolean =>
  [
    "postgres",
    "kingbase",
    "highgo",
    "vastbase",
    "opengauss",
    "gaussdb",
    "sqlserver",
    "iris",
    "cache",
    "duckdb",
  ].includes(normalizeDriverType(dialect));
