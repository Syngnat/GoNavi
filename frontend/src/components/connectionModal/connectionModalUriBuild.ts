import { getConnectionTypeDefaultPort as getDefaultPortByType } from "../../utils/connectionTypeCatalog";
import {
  isMySQLCompatibleType,
  isFileDatabaseType,
  supportsSSLForType,
  isPostgresCompatibleSSLType,
  supportsConnectionParamsForType,
} from "../../utils/connectionTypeCapabilities";
import { buildRedisUriFromValues } from "../../utils/redisConnectionUri";
import {
  getRegistryExtraHostsParam,
  getRegistryUriScheme,
  usesHttpRegistryUri,
  usesTrinoStyleConnection,
} from "../../utils/dataSourceRegistry/uriScheme";
import { extractNacosConnectionScope } from "../../utils/nacosConnectionScope";
import {
  getPulsarDefaultPort,
  toAddress,
  normalizeOceanBaseProtocolValue,
  normalizeAddressList,
  parseHostPort,
  normalizeMongoSrvHostList,
  normalizeClickHouseProtocolValue,
} from "./connectionModalUriHosts";
import {
  mergeConnectionParams,
  normalizeFileDbPath,
  withOracleSIDParam,
  withoutOracleSIDParam,
} from "./connectionModalUriParams";
import {
  splitTrinoNamespace,
  appendSSLPathParamsForUri,
  encodeNacosContextPath,
  takeRegistryExtraHosts,
} from "./connectionModalUriSchemes";
import { isElasticsearchFamilyType } from "../../utils/elasticsearchFamily";

export const buildUriFromValues = (values: any) => {
  const type = String(values.type || "")
    .trim()
    .toLowerCase();
  const defaultPort = type === "pulsar"
    ? getPulsarDefaultPort(!!values.useSSL)
    : getDefaultPortByType(type);
  const host = String(values.host || "localhost").trim();
  const port = Number(values.port || defaultPort);
  const user = String(values.user || "").trim();
  const password = String(values.password || "");
  const database = String(values.database || "").trim();
  const timeout = Number(values.timeout || 30);
  const encodedAuth = user
    ? `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ""}@`
    : "";

  if (usesTrinoStyleConnection(type)) {
    const params = new URLSearchParams();
    mergeConnectionParams(params, values.connectionParams);

    const { catalog, schema } = splitTrinoNamespace(values.database);
    if (catalog) {
      params.set("catalog", catalog);
    } else {
      params.delete("catalog");
    }
    if (schema) {
      params.set("schema", schema);
    } else {
      params.delete("schema");
    }
    if (!String(params.get("source") || "").trim()) {
      params.set("source", "GoNavi");
    }

    if (values.useSSL) {
      const mode = String(values.sslMode || "required")
        .trim()
        .toLowerCase();
      if (mode === "skip-verify" || mode === "preferred") {
        params.set("skip_verify", "true");
      } else {
        params.delete("skip_verify");
      }
      appendSSLPathParamsForUri(params, type, values);
    } else {
      params.delete("skip_verify");
    }

    const query = params.toString();
    const scheme = values.useSSL ? "https" : "http";
    return `${scheme}://${encodedAuth}${toAddress(host, port, defaultPort)}${query ? `?${query}` : ""}`;
  }

  if (type === "nacos") {
    const {
      connectionParams: paramsWithoutStoredScope,
      scope: storedScope,
    } = extractNacosConnectionScope(values.connectionParams);
    const params = new URLSearchParams(paramsWithoutStoredScope);
    const contextPath = encodeNacosContextPath(
      params.get("contextPath") || "/nacos",
    );
    params.delete("contextPath");
    const hasDedicatedNamespaceId =
      Object.prototype.hasOwnProperty.call(values, "nacosNamespaceId") &&
      values.nacosNamespaceId !== undefined;
    const namespaceId = String(
      hasDedicatedNamespaceId
        ? values.nacosNamespaceId
        : storedScope.namespaceId,
    ).trim();
    if (namespaceId) {
      params.set("namespaceId", namespaceId);
    }
    const query = params.toString();
    const scheme = values.useSSL ? "https" : "http";
    return `${scheme}://${encodedAuth}${toAddress(host, port, defaultPort)}${contextPath}${query ? `?${query}` : ""}`;
  }

  if (isMySQLCompatibleType(type)) {
    const selectedOceanBaseProtocol =
      type === "oceanbase"
        ? normalizeOceanBaseProtocolValue(values.oceanBaseProtocol)
        : "mysql";
    const primary = toAddress(host, port, defaultPort);
    const replicas =
      selectedOceanBaseProtocol !== "oracle" && values.mysqlTopology === "replica"
        ? normalizeAddressList(values.mysqlReplicaHosts, defaultPort)
        : [];
    const hosts = normalizeAddressList([primary, ...replicas], defaultPort);
    const params = new URLSearchParams();
    if (hosts.length > 1 || values.mysqlTopology === "replica") {
      params.set("topology", "replica");
    }
    if (values.useSSL) {
      const mode = String(values.sslMode || "preferred")
        .trim()
        .toLowerCase();
      if (mode === "required") {
        params.set("tls", "true");
      } else if (mode === "skip-verify") {
        params.set("tls", "skip-verify");
      } else {
        params.set("tls", "preferred");
      }
    }
    appendSSLPathParamsForUri(params, type, values);
    if (Number.isFinite(timeout) && timeout > 0) {
      params.set("timeout", String(timeout));
    }
    mergeConnectionParams(params, values.connectionParams);
    if (type === "oceanbase") {
      params.set("protocol", selectedOceanBaseProtocol);
    }
    const dbPath = database ? `/${encodeURIComponent(database)}` : "/";
    const query = params.toString();
    const scheme =
      getRegistryUriScheme(type) ?? (type === "diros" ? "doris" : type === "starrocks" ? "starrocks" : type === "oceanbase" ? "oceanbase" : type === "goldendb" ? "goldendb" : "mysql");
    return `${scheme}://${encodedAuth}${hosts.join(",")}${dbPath}${query ? `?${query}` : ""}`;
  }

  if (type === "kafka") {
    const primary = toAddress(host, port, defaultPort);
    const brokers =
      values.kafkaTopology === "cluster"
        ? normalizeAddressList(values.kafkaHosts, defaultPort)
        : [];
    const allBrokers = normalizeAddressList([primary, ...brokers], defaultPort);
    const params = new URLSearchParams();
    if (allBrokers.length > 1 || values.kafkaTopology === "cluster") {
      params.set("topology", "cluster");
    }
    if (values.useSSL) {
      const mode = String(values.sslMode || "preferred")
        .trim()
        .toLowerCase();
      params.set("tls", "true");
      if (mode === "skip-verify" || mode === "preferred") {
        params.set("skip_verify", "true");
      }
      appendSSLPathParamsForUri(params, type, values);
    }
    if (Number.isFinite(timeout) && timeout > 0) {
      params.set("timeout", String(timeout));
    }
    mergeConnectionParams(params, values.connectionParams);
    const topicPath = database ? `/${encodeURIComponent(database)}` : "";
    const query = params.toString();
    return `kafka://${encodedAuth}${allBrokers.join(",")}${topicPath}${query ? `?${query}` : ""}`;
  }

  if (type === "mqtt") {
    const primary = toAddress(host, port, defaultPort);
    const brokers =
      values.mqttTopology === "cluster"
        ? normalizeAddressList(values.mqttHosts, defaultPort)
        : [];
    const allBrokers = normalizeAddressList([primary, ...brokers], defaultPort);
    const params = new URLSearchParams();
    if (allBrokers.length > 1 || values.mqttTopology === "cluster") {
      params.set("topology", "cluster");
    }
    if (values.useSSL) {
      const mode = String(values.sslMode || "preferred")
        .trim()
        .toLowerCase();
      params.set("tls", "true");
      if (mode === "skip-verify" || mode === "preferred") {
        params.set("skip_verify", "true");
      }
      appendSSLPathParamsForUri(params, type, values);
    }
    if (Number.isFinite(timeout) && timeout > 0) {
      params.set("timeout", String(timeout));
    }
    mergeConnectionParams(params, values.connectionParams);
    const topicPath = database ? `/${encodeURIComponent(database)}` : "";
    const query = params.toString();
    return `mqtt://${encodedAuth}${allBrokers.join(",")}${topicPath}${query ? `?${query}` : ""}`;
  }

  if (type === "rocketmq") {
    const primary = toAddress(host, port, defaultPort);
    const nameservers =
      values.rocketmqTopology === "cluster"
        ? normalizeAddressList(values.rocketmqHosts, defaultPort)
        : [];
    const allNameServers = normalizeAddressList([primary, ...nameservers], defaultPort);
    const params = new URLSearchParams();
    if (allNameServers.length > 1 || values.rocketmqTopology === "cluster") {
      params.set("topology", "cluster");
    }
    if (Number.isFinite(timeout) && timeout > 0) {
      params.set("timeout", String(timeout));
    }
    mergeConnectionParams(params, values.connectionParams);
    const topicPath = database ? `/${encodeURIComponent(database)}` : "";
    const query = params.toString();
    return `rocketmq://${encodedAuth}${allNameServers.join(",")}${topicPath}${query ? `?${query}` : ""}`;
  }

  if (type === "rabbitmq") {
    const address = toAddress(host, port, defaultPort);
    const params = new URLSearchParams();
    if (values.useSSL) {
      const mode = String(values.sslMode || "preferred")
        .trim()
        .toLowerCase();
      params.set("tls", "true");
      if (mode === "skip-verify" || mode === "preferred") {
        params.set("skip_verify", "true");
      }
      appendSSLPathParamsForUri(params, type, values);
    }
    if (Number.isFinite(timeout) && timeout > 0) {
      params.set("timeout", String(timeout));
    }
    mergeConnectionParams(params, values.connectionParams);
    const vhostPath = database ? `/${encodeURIComponent(database)}` : "";
    const query = params.toString();
    return `rabbitmq://${encodedAuth}${address}${vhostPath}${query ? `?${query}` : ""}`;
  }

  if (type === "redis") {
    return buildRedisUriFromValues(values);
  }

  if (isFileDatabaseType(type)) {
    const pathText = normalizeFileDbPath(String(values.host || "").trim());
    if (!pathText) {
      return `${type}://`;
    }
    return `${type}://${encodeURI(pathText)}`;
  }

  if (type === "mongodb") {
    const useSrv = !!values.mongoSrv;
    const primaryAddress = useSrv
      ? parseHostPort(host, 27017)?.host || host || "localhost"
      : toAddress(host, port, 27017);
    const extraNodes =
      values.mongoTopology === "replica"
        ? useSrv
          ? normalizeMongoSrvHostList(values.mongoHosts, 27017)
          : normalizeAddressList(values.mongoHosts, 27017)
        : [];
    const hosts = useSrv
      ? normalizeMongoSrvHostList([primaryAddress, ...extraNodes], 27017)
      : normalizeAddressList([primaryAddress, ...extraNodes], 27017);
    const scheme = useSrv ? "mongodb+srv" : "mongodb";
    const params = new URLSearchParams();
    const authSource = String(
      values.mongoAuthSource || database || "admin",
    ).trim();
    if (authSource) {
      params.set("authSource", authSource);
    }
    const replicaSet = String(values.mongoReplicaSet || "").trim();
    if (replicaSet) {
      params.set("replicaSet", replicaSet);
    }
    const readPreference = String(values.mongoReadPreference || "").trim();
    if (readPreference) {
      params.set("readPreference", readPreference);
    }
    const authMechanism = String(values.mongoAuthMechanism || "").trim();
    if (authMechanism) {
      params.set("authMechanism", authMechanism);
    }
    if (values.useSSL) {
      const mode = String(values.sslMode || "preferred")
        .trim()
        .toLowerCase();
      params.set("tls", "true");
      if (mode === "skip-verify" || mode === "preferred") {
        params.set("tlsInsecure", "true");
      } else {
        params.delete("tlsInsecure");
      }
    }
    appendSSLPathParamsForUri(params, type, values);
    if (Number.isFinite(timeout) && timeout > 0) {
      params.set("connectTimeoutMS", String(timeout * 1000));
      params.set("serverSelectionTimeoutMS", String(timeout * 1000));
    }
    mergeConnectionParams(params, values.connectionParams);
    const dbPath = database ? `/${encodeURIComponent(database)}` : "/";
    const query = params.toString();
    return `${scheme}://${encodedAuth}${hosts.join(",")}${dbPath}${query ? `?${query}` : ""}`;
  }

  const clickHouseProtocol =
    type === "clickhouse"
      ? normalizeClickHouseProtocolValue(values.clickHouseProtocol)
      : "auto";
  const scheme =
    type === "gaussdb"
      ? "gaussdb"
      : type === "postgres"
      ? "postgresql"
      : type === "chroma" || type === "qdrant" || type === "milvus" || isElasticsearchFamilyType(type) || usesHttpRegistryUri(type)
        ? values.useSSL
          ? "https"
          : "http"
      : type === "clickhouse" && clickHouseProtocol === "http"
        ? values.useSSL
          ? "https"
          : "http"
        : type;
  const oracleSIDMode =
    type === "oracle" &&
    String(values.oracleMode || "service")
      .trim()
      .toLowerCase() === "sid";
  const dbPath =
    !oracleSIDMode && database ? `/${encodeURIComponent(database)}` : "";
  const params = new URLSearchParams();
  if (supportsSSLForType(type) && values.useSSL) {
    const mode = String(values.sslMode || "preferred")
      .trim()
      .toLowerCase();
    if (isPostgresCompatibleSSLType(type)) {
      params.set(
        "sslmode",
        mode === "skip-verify"
          ? "require"
          : String(values.sslCAPath || "").trim()
            ? "verify-ca"
            : "require",
      );
      appendSSLPathParamsForUri(params, type, values);
    } else if (type === "sqlserver") {
      params.set("encrypt", "true");
      params.set(
        "TrustServerCertificate",
        mode === "skip-verify" || mode === "preferred" ? "true" : "false",
      );
      appendSSLPathParamsForUri(params, type, values);
    } else if (type === "clickhouse") {
      if (clickHouseProtocol === "http") {
        if (mode === "skip-verify" || mode === "preferred") {
          params.set("skip_verify", "true");
        }
      } else {
        params.set("secure", "true");
        if (mode === "skip-verify" || mode === "preferred") {
          params.set("skip_verify", "true");
        }
      }
      appendSSLPathParamsForUri(params, type, values);
    } else if (type === "dameng") {
      appendSSLPathParamsForUri(params, type, values);
    } else if (type === "oracle") {
      params.set("SSL", "TRUE");
      params.set("SSL VERIFY", mode === "required" ? "TRUE" : "FALSE");
    } else if (type === "tdengine") {
      params.set("protocol", "wss");
      if (mode === "skip-verify" || mode === "preferred") {
        params.set("skip_verify", "true");
      }
    } else if (type === "chroma" || type === "qdrant" || type === "milvus" || usesHttpRegistryUri(type)) {
      if (mode === "skip-verify" || mode === "preferred") {
        params.set("skip_verify", "true");
      }
      appendSSLPathParamsForUri(params, type, values);
    }
  } else if (supportsSSLForType(type)) {
    if (isPostgresCompatibleSSLType(type)) {
      params.set("sslmode", "disable");
    } else if (type === "sqlserver") {
      params.set("encrypt", "disable");
      params.set("TrustServerCertificate", "true");
    } else if (type === "tdengine") {
      params.set("protocol", "ws");
    }
  }
  if (type === "clickhouse" && clickHouseProtocol !== "auto") {
    params.set("protocol", clickHouseProtocol);
  }
  if (supportsConnectionParamsForType(type)) {
    mergeConnectionParams(params, values.connectionParams);
  }
  const primaryAddress = toAddress(host, port, defaultPort);
  const extraHosts = takeRegistryExtraHosts(params, getRegistryExtraHostsParam(type), defaultPort)
    .filter((address) => address !== primaryAddress);
  let query = params.toString();
  if (type === "oracle") {
    query = oracleSIDMode
      ? withOracleSIDParam(query, database)
      : withoutOracleSIDParam(query);
  }

  if (type === "pulsar") {
    const address = toAddress(host, port, defaultPort);
    const params = new URLSearchParams();
    if (values.useSSL) {
      params.set("tls", "true");
      if (String(values.sslMode || "required").toLowerCase() === "skip-verify") params.set("skip_verify", "true");
      appendSSLPathParamsForUri(params, type, values);
    }
    if (Number.isFinite(timeout) && timeout > 0) params.set("timeout", String(timeout));
    mergeConnectionParams(params, values.connectionParams);
    const topicPath = database ? `/${encodeURIComponent(database)}` : "";
    const query = params.toString();
    return `${values.useSSL ? "pulsar+ssl" : "pulsar"}://${encodedAuth}${address}${topicPath}${query ? `?${query}` : ""}`;
  }
  return `${scheme}://${encodedAuth}${[primaryAddress, ...extraHosts].join(",")}${dbPath}${query ? `?${query}` : ""}`;
};
