import { getConnectionTypeDefaultPort as getDefaultPortByType } from "../../utils/connectionTypeCatalog";
import {
  isMySQLCompatibleType,
  isFileDatabaseType,
  singleHostUriSchemesByType,
  supportsConnectionParamsForType,
  supportsSSLForType,
} from "../../utils/connectionTypeCapabilities";
import { parseRedisUriToFormValues } from "../../utils/redisConnectionUri";
import {
  findRegistryUriScheme,
  getRegistryExtraHostsParam,
  usesHttpRegistryUri,
  usesTrinoStyleConnection,
  withRegistryUriScheme,
} from "../../utils/dataSourceRegistry/uriScheme";
import { extractNacosConnectionScope } from "../../utils/nacosConnectionScope";
import {
  MAX_URI_LENGTH,
  MAX_URI_HOSTS,
  isValidUriHostEntry,
  normalizeAddressList,
  parseHostPort,
  normalizeOceanBaseProtocolValue,
  serializeConnectionParams,
  safeDecode,
  normalizeMongoSrvHostList,
  MAX_TIMEOUT_SECONDS,
  normalizeUriBool,
  getPulsarDefaultPort,
  normalizeClickHouseProtocolValue,
} from "./connectionModalUriHosts";
import {
  parseMultiHostUri,
  extractSSLPathValuesFromParams,
  parseSingleHostUri,
  parseTrinoUriToValues,
  parseClickHouseHTTPUriToValues,
  normalizeNacosContextPath,
  mergeRegistryExtraHosts,
} from "./connectionModalUriSchemes";
import { normalizeFileDbPath, resolveOracleConnectionTarget } from "./connectionModalUriParams";
import { isElasticsearchFamilyType } from "../../utils/elasticsearchFamily";

export const parseUriToValues = (
  uriText: string,
  type: string,
): Record<string, any> | null => {
  const trimmedUri = withRegistryUriScheme(type, String(uriText || "").trim());
  if (!trimmedUri) {
    return null;
  }
  if (trimmedUri.length > MAX_URI_LENGTH) {
    return null;
  }

  if (isMySQLCompatibleType(type)) {
    const mysqlDefaultPort = getDefaultPortByType(type);
    const registryScheme = findRegistryUriScheme(type, trimmedUri);
    const parsed =
      parseMultiHostUri(trimmedUri, "mysql") ||
      parseMultiHostUri(trimmedUri, "goldendb") ||
      parseMultiHostUri(trimmedUri, "greatdb") ||
      parseMultiHostUri(trimmedUri, "gdb") ||
      parseMultiHostUri(trimmedUri, "jdbc:mysql") ||
      parseMultiHostUri(trimmedUri, "oceanbase") ||
      parseMultiHostUri(trimmedUri, "jdbc:oceanbase") ||
      parseMultiHostUri(trimmedUri, "starrocks") ||
      parseMultiHostUri(trimmedUri, "jdbc:starrocks") ||
      parseMultiHostUri(trimmedUri, "diros") ||
      parseMultiHostUri(trimmedUri, "doris") ||
      (registryScheme ? parseMultiHostUri(trimmedUri, registryScheme) : null);
    if (!parsed) {
      return null;
    }
    if (!parsed.hosts.length || parsed.hosts.length > MAX_URI_HOSTS) {
      return null;
    }
    if (parsed.hosts.some((entry) => !isValidUriHostEntry(entry))) {
      return null;
    }
    const hostList = normalizeAddressList(parsed.hosts, mysqlDefaultPort);
    if (!hostList.length) {
      return null;
    }
    const primary = parseHostPort(
      hostList[0] || `localhost:${mysqlDefaultPort}`,
      mysqlDefaultPort,
    );
    const timeoutValue = Number(parsed.params.get("timeout"));
    const topology = String(
      parsed.params.get("topology") || "",
    ).toLowerCase();
    const tlsValue = String(
      parsed.params.get("tls") || parsed.params.get("useSSL") || "",
    )
      .trim()
      .toLowerCase();
    const parsedOceanBaseProtocol =
      type === "oceanbase"
        ? normalizeOceanBaseProtocolValue(
            parsed.params.get("protocol") ||
              parsed.params.get("oceanBaseProtocol") ||
              parsed.params.get("oceanbaseProtocol") ||
              parsed.params.get("tenantMode") ||
              parsed.params.get("compatMode") ||
              parsed.params.get("mode"),
          )
        : undefined;
    const sslMode =
      tlsValue === "true"
        ? "required"
        : tlsValue === "skip-verify"
          ? "skip-verify"
          : tlsValue === "preferred"
            ? "preferred"
            : "disable";
    return {
      host: primary?.host || "localhost",
      port: primary?.port || mysqlDefaultPort,
      user: parsed.username,
      password: parsed.password,
      database: parsed.database || "",
      useSSL: sslMode !== "disable",
      sslMode,
      ...extractSSLPathValuesFromParams(parsed.params, type),
      oceanBaseProtocol: parsedOceanBaseProtocol,
      mysqlTopology:
        parsedOceanBaseProtocol === "oracle"
          ? "single"
          : hostList.length > 1 || topology === "replica"
            ? "replica"
            : "single",
      mysqlReplicaHosts: hostList.slice(1),
      connectionParams: serializeConnectionParams(parsed.params),
      timeout:
        Number.isFinite(timeoutValue) && timeoutValue > 0
          ? Math.min(3600, Math.trunc(timeoutValue))
          : undefined,
    };
  }

  if (isFileDatabaseType(type)) {
    const rawPath = trimmedUri
      .replace(/^sqlite:\/\//i, "")
      .replace(/^duckdb:\/\//i, "")
      .trim();
    if (!rawPath) {
      return null;
    }
    return { host: normalizeFileDbPath(safeDecode(rawPath)) };
  }

  if (type === "redis") {
    return parseRedisUriToFormValues(trimmedUri);
  }

  if (type === "mongodb") {
    const parsed =
      parseMultiHostUri(trimmedUri, "mongodb") ||
      parseMultiHostUri(trimmedUri, "mongodb+srv");
    if (!parsed) {
      return null;
    }
    if (!parsed.hosts.length || parsed.hosts.length > MAX_URI_HOSTS) {
      return null;
    }
    if (parsed.hosts.some((entry) => !isValidUriHostEntry(entry))) {
      return null;
    }
    const isSrv = trimmedUri.toLowerCase().startsWith("mongodb+srv://");
    const hostList = isSrv
      ? normalizeMongoSrvHostList(parsed.hosts, 27017)
      : normalizeAddressList(parsed.hosts, 27017);
    if (!hostList.length) {
      return null;
    }
    const primary = isSrv
      ? { host: hostList[0] || "localhost", port: 27017 }
      : parseHostPort(hostList[0] || "localhost:27017", 27017);
    const timeoutMs = Number(
      parsed.params.get("connectTimeoutMS") ||
        parsed.params.get("serverSelectionTimeoutMS"),
    );
    const tlsText = String(
      parsed.params.get("tls") || parsed.params.get("ssl") || "",
    )
      .trim()
      .toLowerCase();
    const tlsInsecureText = String(
      parsed.params.get("tlsInsecure") ||
        parsed.params.get("sslInsecure") ||
        "",
    )
      .trim()
      .toLowerCase();
    const tlsEnabled =
      tlsText === "1" ||
      tlsText === "true" ||
      tlsText === "yes" ||
      tlsText === "on";
    const tlsInsecure =
      tlsInsecureText === "1" ||
      tlsInsecureText === "true" ||
      tlsInsecureText === "yes" ||
      tlsInsecureText === "on";
    return {
      host: primary?.host || "localhost",
      port: primary?.port || 27017,
      user: parsed.username,
      password: parsed.password,
      database: parsed.database || "",
      useSSL: tlsEnabled,
      sslMode: tlsEnabled
        ? tlsInsecure
          ? "skip-verify"
          : "required"
        : "disable",
      ...extractSSLPathValuesFromParams(parsed.params, type),
      mongoTopology:
        hostList.length > 1 || !!parsed.params.get("replicaSet")
          ? "replica"
          : "single",
      mongoHosts: hostList.slice(1),
      mongoSrv: isSrv,
      mongoReplicaSet: parsed.params.get("replicaSet") || "",
      mongoAuthSource: parsed.params.get("authSource") || "",
      mongoReadPreference: parsed.params.get("readPreference") || "primary",
      mongoAuthMechanism: parsed.params.get("authMechanism") || "",
      connectionParams: serializeConnectionParams(parsed.params),
      timeout:
        Number.isFinite(timeoutMs) && timeoutMs > 0
          ? Math.min(MAX_TIMEOUT_SECONDS, Math.ceil(timeoutMs / 1000))
          : undefined,
      savePassword: true,
    };
  }

  if (type === "kafka") {
    const defaultPort = getDefaultPortByType(type);
    const parsed =
      parseMultiHostUri(trimmedUri, "kafka") ||
      parseMultiHostUri(trimmedUri, "apache-kafka") ||
      parseMultiHostUri(trimmedUri, "apache_kafka");
    if (!parsed) {
      return null;
    }
    if (!parsed.hosts.length || parsed.hosts.length > MAX_URI_HOSTS) {
      return null;
    }
    if (parsed.hosts.some((entry) => !isValidUriHostEntry(entry))) {
      return null;
    }
    const hostList = normalizeAddressList(parsed.hosts, defaultPort);
    if (!hostList.length) {
      return null;
    }
    const primary = parseHostPort(
      hostList[0] || `localhost:${defaultPort}`,
      defaultPort,
    );
    const tlsEnabled = normalizeUriBool(
      parsed.params.get("tls") ||
        parsed.params.get("ssl") ||
        parsed.params.get("useSSL") ||
        parsed.params.get("use_ssl"),
    );
    const skipVerify = normalizeUriBool(
      parsed.params.get("skip_verify") || parsed.params.get("skipVerify"),
    );
    const topology = String(parsed.params.get("topology") || "")
      .trim()
      .toLowerCase();
    const timeoutValue = Number(parsed.params.get("timeout"));
    return {
      host: primary?.host || "localhost",
      port: primary?.port || defaultPort,
      user: parsed.username,
      password: parsed.password,
      database: parsed.database || "",
      useSSL: tlsEnabled,
      sslMode: tlsEnabled ? (skipVerify ? "skip-verify" : "required") : "disable",
      ...extractSSLPathValuesFromParams(parsed.params, type),
      kafkaTopology:
        topology === "cluster" || hostList.length > 1 ? "cluster" : "single",
      kafkaHosts: hostList.slice(1),
      connectionParams: serializeConnectionParams(parsed.params),
      timeout:
        Number.isFinite(timeoutValue) && timeoutValue > 0
          ? Math.min(MAX_TIMEOUT_SECONDS, Math.trunc(timeoutValue))
          : undefined,
    };
  }

  if (type === "mqtt") {
    const defaultPort = getDefaultPortByType(type);
    const parsed =
      parseMultiHostUri(trimmedUri, "mqtt") ||
      parseMultiHostUri(trimmedUri, "mqtts") ||
      parseMultiHostUri(trimmedUri, "tcp") ||
      parseMultiHostUri(trimmedUri, "ssl") ||
      parseMultiHostUri(trimmedUri, "tls");
    if (!parsed) {
      return null;
    }
    if (!parsed.hosts.length || parsed.hosts.length > MAX_URI_HOSTS) {
      return null;
    }
    if (parsed.hosts.some((entry) => !isValidUriHostEntry(entry))) {
      return null;
    }
    const hostList = normalizeAddressList(parsed.hosts, defaultPort);
    if (!hostList.length) {
      return null;
    }
    const primary = parseHostPort(
      hostList[0] || `localhost:${defaultPort}`,
      defaultPort,
    );
    const lowerUri = trimmedUri.toLowerCase();
    const tlsEnabled =
      lowerUri.startsWith("mqtts://") ||
      lowerUri.startsWith("ssl://") ||
      lowerUri.startsWith("tls://") ||
      normalizeUriBool(
        parsed.params.get("tls") ||
          parsed.params.get("ssl") ||
          parsed.params.get("useSSL") ||
          parsed.params.get("use_ssl"),
      );
    const skipVerify = normalizeUriBool(
      parsed.params.get("skip_verify") || parsed.params.get("skipVerify"),
    );
    const topology = String(parsed.params.get("topology") || "")
      .trim()
      .toLowerCase();
    const timeoutValue = Number(parsed.params.get("timeout"));
    return {
      host: primary?.host || "localhost",
      port: primary?.port || defaultPort,
      user: parsed.username,
      password: parsed.password,
      database: parsed.database || "",
      useSSL: tlsEnabled,
      sslMode: tlsEnabled ? (skipVerify ? "skip-verify" : "required") : "disable",
      ...extractSSLPathValuesFromParams(parsed.params, type),
      mqttTopology:
        topology === "cluster" || hostList.length > 1 ? "cluster" : "single",
      mqttHosts: hostList.slice(1),
      connectionParams: serializeConnectionParams(parsed.params),
      timeout:
        Number.isFinite(timeoutValue) && timeoutValue > 0
          ? Math.min(MAX_TIMEOUT_SECONDS, Math.trunc(timeoutValue))
          : undefined,
    };
  }

  if (type === "rocketmq") {
    const defaultPort = getDefaultPortByType(type);
    const parsed =
      parseMultiHostUri(trimmedUri, "rocketmq") ||
      parseMultiHostUri(trimmedUri, "rmq");
    if (!parsed) {
      return null;
    }
    if (!parsed.hosts.length || parsed.hosts.length > MAX_URI_HOSTS) {
      return null;
    }
    if (parsed.hosts.some((entry) => !isValidUriHostEntry(entry))) {
      return null;
    }
    const hostList = normalizeAddressList(parsed.hosts, defaultPort);
    if (!hostList.length) {
      return null;
    }
    const primary = parseHostPort(
      hostList[0] || `localhost:${defaultPort}`,
      defaultPort,
    );
    const topology = String(parsed.params.get("topology") || "")
      .trim()
      .toLowerCase();
    const timeoutValue = Number(parsed.params.get("timeout"));
    return {
      host: primary?.host || "localhost",
      port: primary?.port || defaultPort,
      user: parsed.username,
      password: parsed.password,
      database: parsed.database || "",
      rocketmqTopology:
        topology === "cluster" || hostList.length > 1 ? "cluster" : "single",
      rocketmqHosts: hostList.slice(1),
      connectionParams: serializeConnectionParams(parsed.params),
      timeout:
        Number.isFinite(timeoutValue) && timeoutValue > 0
          ? Math.min(MAX_TIMEOUT_SECONDS, Math.trunc(timeoutValue))
          : undefined,
    };
  }

  if (type === "rabbitmq") {
    const defaultPort = getDefaultPortByType(type);
    const parsed = parseSingleHostUri(
      trimmedUri,
      ["rabbitmq", "http", "https"],
      defaultPort,
    );
    if (!parsed) {
      return null;
    }
    const lowerUri = trimmedUri.toLowerCase();
    const tlsEnabled =
      lowerUri.startsWith("https://") ||
      normalizeUriBool(
        parsed.params.get("tls") ||
          parsed.params.get("ssl") ||
          parsed.params.get("useSSL") ||
          parsed.params.get("use_ssl"),
      );
    const skipVerify = normalizeUriBool(
      parsed.params.get("skip_verify") || parsed.params.get("skipVerify"),
    );
    const timeoutValue = Number(parsed.params.get("timeout"));
    return {
      host: parsed.host,
      port: parsed.port,
      user: parsed.username,
      password: parsed.password,
      database: parsed.database || "",
      useSSL: tlsEnabled,
      sslMode: tlsEnabled ? (skipVerify ? "skip-verify" : "required") : "disable",
      ...extractSSLPathValuesFromParams(parsed.params, type),
      connectionParams: serializeConnectionParams(parsed.params),
      timeout:
        Number.isFinite(timeoutValue) && timeoutValue > 0
          ? Math.min(MAX_TIMEOUT_SECONDS, Math.trunc(timeoutValue))
          : undefined,
    };
  }

  if (type === "pulsar") {
    const tlsParams = new URLSearchParams(trimmedUri.split("?")[1] || "");
    const tlsEnabled = trimmedUri.toLowerCase().startsWith("pulsar+ssl://") ||
      normalizeUriBool(tlsParams.get("tls") || tlsParams.get("ssl"));
    const defaultPort = getPulsarDefaultPort(tlsEnabled);
    const parsed = parseSingleHostUri(trimmedUri, ["pulsar", "pulsar+ssl"], defaultPort);
    if (!parsed) return null;
    return {
      host: parsed.host,
      port: parsed.port,
      user: parsed.username,
      password: parsed.password,
      database: parsed.database || "",
      useSSL: tlsEnabled,
      sslMode: normalizeUriBool(parsed.params.get("skip_verify")) ? "skip-verify" : tlsEnabled ? "required" : "preferred",
      connectionParams: serializeConnectionParams(parsed.params),
      ...extractSSLPathValuesFromParams(parsed.params, type),
    };
  }

  if (usesTrinoStyleConnection(type)) {
    return parseTrinoUriToValues(trimmedUri, type);
  }

  if (type === "clickhouse") {
    const httpValues = parseClickHouseHTTPUriToValues(trimmedUri);
    if (httpValues) {
      return httpValues;
    }
  }

  if (type === "nacos") {
    const parsed = parseSingleHostUri(
      trimmedUri,
      ["http", "https", "nacos"],
      getDefaultPortByType(type),
    );
    if (!parsed) {
      return null;
    }
    const {
      connectionParams: paramsWithoutScope,
      scope,
    } = extractNacosConnectionScope(parsed.params.toString());
    const params = new URLSearchParams(paramsWithoutScope);
    const contextPath = normalizeNacosContextPath(
      parsed.database
        ? `/${parsed.database}`
        : parsed.hasExplicitPath
          ? "/"
          : params.get("contextPath") || "/nacos",
    );
    params.set("contextPath", contextPath);
    const useSSL = trimmedUri.toLowerCase().startsWith("https://");
    return {
      host: parsed.host,
      port: parsed.port,
      user: parsed.username,
      password: parsed.password,
      useSSL,
      sslMode: useSSL ? "required" : "disable",
      nacosNamespaceId: scope.namespaceId,
      connectionParams: params.toString(),
    };
  }

  const singleHostSchemes = singleHostUriSchemesByType[type];
  if (singleHostSchemes && singleHostSchemes.length > 0) {
    const parsed = parseSingleHostUri(
      trimmedUri,
      singleHostSchemes,
      getDefaultPortByType(type),
    );
    if (!parsed) {
      return null;
    }
    const oracleTarget =
      type === "oracle"
        ? resolveOracleConnectionTarget(parsed.params.toString())
        : null;
    if (
      type === "oracle" &&
      !String(parsed.database || "").trim() &&
      !oracleTarget?.sid
    ) {
      // Oracle 必须提供 Service Name path 或 SID 查询参数之一。
      return null;
    }
    const parsedValues: Record<string, any> = {
      host: parsed.host,
      port: parsed.port,
      user: parsed.username,
      password: parsed.password,
      database:
        oracleTarget?.mode === "sid" ? oracleTarget.sid : parsed.database,
      ...(oracleTarget ? { oracleMode: oracleTarget.mode } : {}),
    };
    if (supportsConnectionParamsForType(type)) {
      mergeRegistryExtraHosts(parsed.params, getRegistryExtraHostsParam(type), parsed.hosts, getDefaultPortByType(type));
      parsedValues.connectionParams = serializeConnectionParams(parsed.params);
    }

    if (supportsSSLForType(type)) {
      Object.assign(parsedValues, extractSSLPathValuesFromParams(parsed.params, type));
      const normalizeBool = (raw: unknown) => {
        const text = String(raw ?? "")
          .trim()
          .toLowerCase();
        return (
          text === "1" || text === "true" || text === "yes" || text === "on"
        );
      };
      if (
        type === "postgres" ||
        type === "kingbase" ||
        type === "highgo" ||
        type === "vastbase" ||
        type === "opengauss" ||
        type === "gaussdb"
      ) {
        const sslMode = String(parsed.params.get("sslmode") || "")
          .trim()
          .toLowerCase();
        if (sslMode) {
          parsedValues.useSSL = sslMode !== "disable" && sslMode !== "false";
          parsedValues.sslMode =
            sslMode === "disable" || sslMode === "false"
              ? "disable"
              : "required";
        }
      } else if (type === "sqlserver") {
        const encrypt = String(parsed.params.get("encrypt") || "")
          .trim()
          .toLowerCase();
        const trust = String(
          parsed.params.get("TrustServerCertificate") ||
            parsed.params.get("trustservercertificate") ||
            "",
        )
          .trim()
          .toLowerCase();
        const encrypted =
          encrypt === "true" ||
          encrypt === "mandatory" ||
          encrypt === "yes" ||
          encrypt === "1" ||
          encrypt === "strict";
        if (encrypted) {
          parsedValues.useSSL = true;
          parsedValues.sslMode =
            trust === "true" || trust === "1" || trust === "yes"
              ? "skip-verify"
              : "required";
        } else if (encrypt) {
          parsedValues.useSSL = false;
          parsedValues.sslMode = "disable";
        }
      } else if (type === "clickhouse") {
        parsedValues.clickHouseProtocol = normalizeClickHouseProtocolValue(
          parsed.params.get("protocol"),
        );
        const secure = String(
          parsed.params.get("secure") || parsed.params.get("tls") || "",
        )
          .trim()
          .toLowerCase();
        const skipVerify = normalizeBool(parsed.params.get("skip_verify"));
        if (secure) {
          parsedValues.useSSL = normalizeBool(secure);
          parsedValues.sslMode = skipVerify
            ? "skip-verify"
            : parsedValues.useSSL
              ? "required"
              : "disable";
        }
      } else if (type === "dameng") {
        const certPath = String(
          parsed.params.get("SSL_CERT_PATH") ||
            parsed.params.get("ssl_cert_path") ||
            parsed.params.get("sslCertPath") ||
            "",
        ).trim();
        const keyPath = String(
          parsed.params.get("SSL_KEY_PATH") ||
            parsed.params.get("ssl_key_path") ||
            parsed.params.get("sslKeyPath") ||
            "",
        ).trim();
        parsedValues.sslCertPath = certPath;
        parsedValues.sslKeyPath = keyPath;
        if (certPath || keyPath) {
          parsedValues.useSSL = true;
          parsedValues.sslMode = "required";
        }
      } else if (type === "oracle") {
        const ssl = String(
          parsed.params.get("SSL") || parsed.params.get("ssl") || "",
        )
          .trim()
          .toLowerCase();
        const sslVerify = String(
          parsed.params.get("SSL VERIFY") ||
            parsed.params.get("ssl verify") ||
            parsed.params.get("SSL_VERIFY") ||
            parsed.params.get("ssl_verify") ||
            "",
        )
          .trim()
          .toLowerCase();
        if (ssl) {
          parsedValues.useSSL = normalizeBool(ssl);
          if (!parsedValues.useSSL) {
            parsedValues.sslMode = "disable";
          } else {
            parsedValues.sslMode = normalizeBool(sslVerify || "true")
              ? "required"
              : "skip-verify";
          }
        }
      } else if (type === "tdengine") {
        const protocol = String(parsed.params.get("protocol") || "")
          .trim()
          .toLowerCase();
        const skipVerify = normalizeBool(parsed.params.get("skip_verify"));
        if (protocol === "wss") {
          parsedValues.useSSL = true;
          parsedValues.sslMode = skipVerify ? "skip-verify" : "required";
        } else if (protocol === "ws") {
          parsedValues.useSSL = false;
          parsedValues.sslMode = "disable";
        }
      } else if (type === "chroma" || type === "qdrant" || type === "milvus" || isElasticsearchFamilyType(type) || usesHttpRegistryUri(type)) {
        const tls = String(
          parsed.params.get("tls") ||
            parsed.params.get("ssl") ||
            parsed.params.get("useSSL") ||
            parsed.params.get("use_ssl") ||
            "",
        )
          .trim()
          .toLowerCase();
        const skipVerify = normalizeBool(
          parsed.params.get("skip_verify") || parsed.params.get("skipVerify"),
        );
        const enabled = tls ? normalizeBool(tls) : trimmedUri.toLowerCase().startsWith("https://");
        parsedValues.useSSL = enabled;
        parsedValues.sslMode = enabled ? (skipVerify ? "skip-verify" : "required") : "disable";
      }
    }
    return parsedValues;
  }

  return null;
};
