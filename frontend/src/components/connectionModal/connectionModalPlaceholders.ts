import { t } from '../../i18n';
import { isMySQLCompatibleType, isFileDatabaseType } from '../../utils/connectionTypeCapabilities';
import { getConnectionTypeDefaultPort as getDefaultPortByType } from '../../utils/connectionTypeCatalog';
import type { OceanBaseProtocolChoice } from './connectionModalUri';

export const getUriPlaceholder = (dbType: string) => {
  if (isMySQLCompatibleType(dbType)) {
    const defaultPort = getDefaultPortByType(dbType);
    const scheme =
      dbType === "diros" ? "doris" : dbType === "starrocks" ? "starrocks" : dbType === "oceanbase" ? "oceanbase" : dbType === "goldendb" ? "goldendb" : "mysql";
    if (dbType === "oceanbase") {
      return `${scheme}://sys%40oracle001:pass@127.0.0.1:${defaultPort}?protocol=oracle`;
    }
    return `${scheme}://user:pass@127.0.0.1:${defaultPort},127.0.0.2:${defaultPort}/db_name?topology=replica`;
  }
  if (isFileDatabaseType(dbType)) {
    return dbType === "duckdb"
      ? "duckdb:///Users/name/demo.duckdb"
      : "sqlite:///Users/name/demo.sqlite";
  }
  if (dbType === "mongodb") {
    return "mongodb+srv://user:pass@cluster0.example.com/db_name?authSource=admin&authMechanism=SCRAM-SHA-256";
  }
  if (dbType === "clickhouse") {
    return "clickhouse://default:pass@127.0.0.1:9000/default";
  }
  if (dbType === "trino") {
    return "http://user@127.0.0.1:8080?catalog=hive&schema=default&source=GoNavi";
  }
  if (dbType === "chroma") {
    return "http://127.0.0.1:8000/default_database?tenant=default_tenant";
  }
  if (dbType === "qdrant") {
    return "http://127.0.0.1:6333";
  }
  if (dbType === "milvus") {
    return "http://127.0.0.1:19530/default";
  }
  if (dbType === "iotdb") {
    return "iotdb://root:root@127.0.0.1:6667/root.sg";
  }
  if (dbType === "rocketmq") {
    return "rocketmq://accessKey:secretKey@127.0.0.1:9876,127.0.0.2:9876/orders.events?topology=cluster&groupId=gonavi&namespace=prod&tag=TagA&pullBatchSize=32&startOffset=latest";
  }
  if (dbType === "mqtt") {
    return "mqtt://user:pass@127.0.0.1:1883/devices%2F%2B%2Ftelemetry?topology=cluster&clientId=gonavi-desktop&qos=1";
  }
  if (dbType === "kafka") {
    return "kafka://user:pass@127.0.0.1:9092,127.0.0.2:9092/orders.events?topology=cluster&groupId=analytics&mechanism=scram-sha-256";
  }
  if (dbType === "rabbitmq") {
    return "rabbitmq://guest:guest@127.0.0.1:15672/%2F?defaultQueue=orders.queue&exchange=events.topic&timeout=30";
  }
  if (dbType === "redis") {
    return t("connection.modal.example.or", {
      first:
        "redis://:pass@127.0.0.1:6379,127.0.0.2:6379/0?topology=cluster",
      second:
        "redis://:pass@10.0.0.1:26379,10.0.0.2:26379/0?topology=sentinel&master=mymaster",
    });
  }
  if (dbType === "pulsar") {
    return "pulsar://127.0.0.1:6650/public/default/orders.events?token=TOKEN";
  }
  if (dbType === "nacos") {
    return "http://nacos:nacos@127.0.0.1:8848/nacos?namespaceId=dev";
  }
  if (dbType === "oracle") {
    return "oracle://user:pass@127.0.0.1:1521/ORCLPDB1";
  }
  if (dbType === "iris") {
    return "iris://user:pass@127.0.0.1:1972/USER";
  }
  if (dbType === "cache") {
    return "cache://user:pass@127.0.0.1:1972/USER";
  }
  if (dbType === "opengauss") {
    return "opengauss://user:pass@127.0.0.1:5432/db_name";
  }
  if (dbType === "gaussdb") {
    return "gaussdb://user:pass@127.0.0.1:5432/db_name";
  }
  return t("connection.modal.example", {
    value: "postgres://user:pass@127.0.0.1:5432/db_name",
  });
};

export const getConnectionParamsPlaceholder = (
  dbType: string,
  oceanBaseProtocol: OceanBaseProtocolChoice,
) => {
  if (dbType === "oceanbase") {
    return oceanBaseProtocol === "oracle"
      ? "PREFETCH_ROWS=5000"
      : "useUnicode=true&characterEncoding=utf8&autoReconnect=true&useSSL=false";
  }
  if (isMySQLCompatibleType(dbType)) {
    return "useUnicode=true&characterEncoding=utf8&autoReconnect=true&useSSL=false";
  }
  switch (dbType) {
    case "postgres":
    case "kingbase":
    case "highgo":
    case "vastbase":
    case "opengauss":
    case "gaussdb":
      return "application_name=GoNavi&statement_timeout=30000";
    case "oracle":
      return "PREFETCH_ROWS=5000&TRACE FILE=/tmp/go-ora.trc";
    case "sqlserver":
      return "app name=GoNavi&packet size=32767";
    case "iris":
    case "cache":
      return "timeout=30";
    case "clickhouse":
      return "max_execution_time=60&compress=lz4";
    case "trino":
      return "session_properties=query_max_execution_time:30m&query_timeout=30s";
    case "mongodb":
      return "retryWrites=true&readPreference=secondaryPreferred";
    case "chroma":
      return "tenant=default_tenant&apiKey=...";
    case "qdrant":
      return "apiKey=...";
    case "milvus":
      return "token=...";
    case "dameng":
      return "schema=SYSDBA";
    case "tdengine":
      return "timezone=Asia%2FShanghai";
    case "iotdb":
      return "fetchSize=1024&timeZone=Asia%2FShanghai";
    case "rocketmq":
      return "groupId=gonavi&namespace=prod&tag=TagA&pullBatchSize=32&startOffset=latest";
    case "mqtt":
      return "topics=devices%2F%2B%2Ftelemetry,%24SYS%2F%23&clientId=gonavi-desktop&qos=1&cleanSession=true&fetchWaitMs=4000";
    case "kafka":
      return "groupId=gonavi&mechanism=scram-sha-256&clientId=gonavi-desktop&startOffset=latest";
    case "rabbitmq":
      return "defaultQueue=orders.queue&exchange=events.topic&managementPathPrefix=/rabbitmq";
    case "pulsar":
      return "token=TOKEN&startOffset=earliest";
    case "nacos":
      return "contextPath=/nacos";
    default:
      return "key=value&another=value";
  }
};
