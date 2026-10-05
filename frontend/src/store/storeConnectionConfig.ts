import { ConnectionConfig, SavedConnection } from "../types";
import { getDataSourceCapabilities } from "../utils/dataSourceCapabilities";
import { normalizeConnectionEnvironmentType } from "../utils/connectionEnvironment";
import {
  normalizeConnectionProtectionConfig,
  supportsConnectionKeepAliveSQL,
  MAX_CONNECTION_KEEPALIVE_SQL_LENGTH,
  resolveConnectionProtectionConfig,
  deriveLegacyConnectionReadOnlyFlag,
} from "../utils/connectionReadOnly";
import { getConnectionTypeDefaultPort } from "../utils/connectionTypeCatalog";
import { supportsSSLForType } from "../utils/connectionTypeCapabilities";
import {
  sanitizeJVMModes,
  toTrimmedString,
  normalizePort,
  sanitizeStringArray,
  normalizeConnectionType,
  sanitizeAddressList,
  normalizeClickHouseProtocol,
  resolveOceanBaseProtocol,
  indexedStoreFallback,
  sanitizeDatabasePatternArray,
  sanitizeNumberArray,
  sanitizeSchemaVisibilityByDatabase,
  sanitizeConnectionIconType,
  sanitizeConnectionIconColor,
} from "./storeConnectionSanitizers";
import {
  DEFAULT_JVM_PORT,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeIntegerInRange,
  MAX_TIMEOUT_SECONDS,
  DEFAULT_DIAGNOSTIC_TIMEOUT_SECONDS,
  MAX_DIAGNOSTIC_TIMEOUT_SECONDS,
  MAX_URI_LENGTH,
  DEFAULT_KEEPALIVE_INTERVAL_MINUTES,
  MIN_KEEPALIVE_INTERVAL_MINUTES,
  MAX_KEEPALIVE_INTERVAL_MINUTES,
  MAX_REDIS_DATABASE_INDEX,
} from "./storeConstants";

const sanitizeJVMConfig = (
  value: unknown,
  options: {
    host: string;
    port: number;
    timeout: number;
    persistSecrets: boolean;
  },
): ConnectionConfig["jvm"] => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const allowedModes = sanitizeJVMModes(raw.allowedModes);
  const preferredModeRaw = toTrimmedString(raw.preferredMode).toLowerCase();
  const preferredMode = allowedModes.includes(
    preferredModeRaw as "jmx" | "endpoint" | "agent",
  )
    ? (preferredModeRaw as "jmx" | "endpoint" | "agent")
    : allowedModes[0];
  const environmentRaw = toTrimmedString(raw.environment, "dev").toLowerCase();
  const environment: "dev" | "uat" | "prod" =
    environmentRaw === "uat"
      ? "uat"
      : environmentRaw === "prod"
        ? "prod"
        : "dev";
  const jmxRaw =
    raw.jmx && typeof raw.jmx === "object"
      ? (raw.jmx as Record<string, unknown>)
      : {};
  const endpointRaw =
    raw.endpoint && typeof raw.endpoint === "object"
      ? (raw.endpoint as Record<string, unknown>)
      : {};
  const agentRaw =
    raw.agent && typeof raw.agent === "object"
      ? (raw.agent as Record<string, unknown>)
      : {};
  const diagnosticRaw =
    raw.diagnostic && typeof raw.diagnostic === "object"
      ? (raw.diagnostic as Record<string, unknown>)
      : {};
  const diagnosticTransportRaw = toTrimmedString(
    diagnosticRaw.transport,
    "agent-bridge",
  ).toLowerCase();
  const diagnosticTransport =
    diagnosticTransportRaw === "arthas-tunnel"
      ? "arthas-tunnel"
      : "agent-bridge";
  const fallbackPort = options.port > 0 ? options.port : DEFAULT_JVM_PORT;
  const fallbackTimeout =
    options.timeout > 0 ? options.timeout : DEFAULT_TIMEOUT_SECONDS;

  return {
    environment,
    readOnly: typeof raw.readOnly === "boolean" ? raw.readOnly : true,
    allowedModes,
    preferredMode,
    jmx: {
      enabled: jmxRaw.enabled === true || allowedModes.includes("jmx"),
      host: toTrimmedString(jmxRaw.host, options.host) || options.host,
      port: normalizePort(jmxRaw.port, fallbackPort),
      username: toTrimmedString(jmxRaw.username),
      password: options.persistSecrets ? toTrimmedString(jmxRaw.password) : "",
      domainAllowlist: sanitizeStringArray(jmxRaw.domainAllowlist, 256),
    },
    endpoint: {
      enabled: endpointRaw.enabled === true,
      baseUrl: toTrimmedString(endpointRaw.baseUrl),
      apiKey: options.persistSecrets ? toTrimmedString(endpointRaw.apiKey) : "",
      timeoutSeconds: normalizeIntegerInRange(
        endpointRaw.timeoutSeconds,
        fallbackTimeout,
        1,
        MAX_TIMEOUT_SECONDS,
      ),
    },
    agent: {
      enabled: agentRaw.enabled === true,
      baseUrl: toTrimmedString(agentRaw.baseUrl),
      apiKey: options.persistSecrets ? toTrimmedString(agentRaw.apiKey) : "",
      timeoutSeconds: normalizeIntegerInRange(
        agentRaw.timeoutSeconds,
        fallbackTimeout,
        1,
        MAX_TIMEOUT_SECONDS,
      ),
    },
    diagnostic: {
      enabled: diagnosticRaw.enabled === true,
      transport: diagnosticTransport,
      baseUrl: toTrimmedString(diagnosticRaw.baseUrl),
      targetId: toTrimmedString(diagnosticRaw.targetId),
      apiKey: options.persistSecrets
        ? toTrimmedString(diagnosticRaw.apiKey)
        : "",
      allowObserveCommands: diagnosticRaw.allowObserveCommands !== false,
      allowTraceCommands: diagnosticRaw.allowTraceCommands === true,
      allowMutatingCommands: diagnosticRaw.allowMutatingCommands === true,
      timeoutSeconds: normalizeIntegerInRange(
        diagnosticRaw.timeoutSeconds,
        DEFAULT_DIAGNOSTIC_TIMEOUT_SECONDS,
        1,
        MAX_DIAGNOSTIC_TIMEOUT_SECONDS,
      ),
    },
  };
};

const sanitizeConnectionConfig = (value: unknown): ConnectionConfig => {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const type = normalizeConnectionType(raw.type);
  const defaultPort = getConnectionTypeDefaultPort(type);
  const savePassword =
    typeof raw.savePassword === "boolean" ? raw.savePassword : true;
  const mongoSrv = !!raw.mongoSrv;
  const sslCapable = supportsSSLForType(type);
  const sslModeRaw = toTrimmedString(raw.sslMode, "preferred").toLowerCase();
  const sslMode: "preferred" | "required" | "skip-verify" | "disable" =
    sslModeRaw === "required"
      ? "required"
      : sslModeRaw === "skip-verify"
        ? "skip-verify"
        : sslModeRaw === "disable"
          ? "disable"
          : "preferred";

  const sshRaw =
    raw.ssh && typeof raw.ssh === "object"
      ? (raw.ssh as Record<string, unknown>)
      : {};
  const ssh = {
    host: toTrimmedString(sshRaw.host),
    port: normalizePort(sshRaw.port, 22),
    user: toTrimmedString(sshRaw.user),
    password: toTrimmedString(sshRaw.password),
    keyPath: toTrimmedString(sshRaw.keyPath),
    knownHostsPath: toTrimmedString(sshRaw.knownHostsPath),
    hostKeyFingerprint: toTrimmedString(sshRaw.hostKeyFingerprint),
  };
  const proxyRaw =
    raw.proxy && typeof raw.proxy === "object"
      ? (raw.proxy as Record<string, unknown>)
      : {};
  const proxyTypeRaw = toTrimmedString(proxyRaw.type, "socks5").toLowerCase();
  const proxyType: "socks5" | "http" =
    proxyTypeRaw === "http" ? "http" : "socks5";
  const proxy = {
    type: proxyType,
    host: toTrimmedString(proxyRaw.host),
    port: normalizePort(proxyRaw.port, proxyTypeRaw === "http" ? 8080 : 1080),
    user: toTrimmedString(proxyRaw.user),
    password: toTrimmedString(proxyRaw.password),
  };
  const httpTunnelRaw =
    raw.httpTunnel && typeof raw.httpTunnel === "object"
      ? (raw.httpTunnel as Record<string, unknown>)
      : raw.HTTPTunnel && typeof raw.HTTPTunnel === "object"
        ? (raw.HTTPTunnel as Record<string, unknown>)
        : {};
  const httpTunnel = {
    host: toTrimmedString(httpTunnelRaw.host ?? raw.httpTunnelHost),
    port: normalizePort(httpTunnelRaw.port ?? raw.httpTunnelPort, 8080),
    user: toTrimmedString(httpTunnelRaw.user ?? raw.httpTunnelUser),
    password: toTrimmedString(httpTunnelRaw.password ?? raw.httpTunnelPassword),
    encodeBase64:
      (httpTunnelRaw.encodeBase64 ?? raw.httpTunnelEncodeBase64) !== false,
  };
  const supportsNetworkTunnel = type !== "sqlite" && type !== "duckdb";
  const useHttpTunnel =
    supportsNetworkTunnel &&
    (raw.useHttpTunnel === true || raw.UseHTTPTunnel === true);
  const useProxy = supportsNetworkTunnel && !!raw.useProxy && !useHttpTunnel;
  const normalizedProtection = normalizeConnectionProtectionConfig(
    raw.protection,
  );

  const safeConfig: ConnectionConfig & Record<string, unknown> = {
    ...raw,
    id: toTrimmedString(raw.id ?? raw.ID),
    type,
    host: toTrimmedString(raw.host, "localhost") || "localhost",
    port: normalizePort(raw.port, defaultPort),
    user: toTrimmedString(raw.user),
    password: savePassword ? toTrimmedString(raw.password) : "",
    savePassword,
    database: toTrimmedString(raw.database),
    readOnly: raw.readOnly === true,
    protection: normalizedProtection,
    useSSL: sslCapable ? !!raw.useSSL : false,
    sslMode: sslCapable ? sslMode : "disable",
    sslCAPath: sslCapable ? toTrimmedString(raw.sslCAPath) : "",
    sslCertPath: sslCapable ? toTrimmedString(raw.sslCertPath) : "",
    sslKeyPath: sslCapable ? toTrimmedString(raw.sslKeyPath) : "",
    useSSH: !!raw.useSSH,
    ssh,
    useProxy,
    proxy,
    useHttpTunnel,
    httpTunnel,
    uri: toTrimmedString(raw.uri).slice(0, MAX_URI_LENGTH),
    connectionParams: toTrimmedString(raw.connectionParams).slice(
      0,
      MAX_URI_LENGTH,
    ),
    hosts: sanitizeAddressList(raw.hosts),
    topology:
      raw.topology === "replica"
        ? "replica"
        : raw.topology === "cluster"
          ? "cluster"
          : raw.topology === "sentinel"
            ? "sentinel"
          : "single",
    mysqlReplicaUser: toTrimmedString(raw.mysqlReplicaUser),
    mysqlReplicaPassword: savePassword
      ? toTrimmedString(raw.mysqlReplicaPassword)
      : "",
    replicaSet: toTrimmedString(raw.replicaSet),
    authSource: toTrimmedString(raw.authSource),
    readPreference: toTrimmedString(raw.readPreference),
    mongoSrv,
    mongoAuthMechanism: toTrimmedString(raw.mongoAuthMechanism),
    mongoReplicaUser: toTrimmedString(raw.mongoReplicaUser),
    mongoReplicaPassword: savePassword
      ? toTrimmedString(raw.mongoReplicaPassword)
      : "",
    timeout: normalizeIntegerInRange(
      raw.timeout,
      DEFAULT_TIMEOUT_SECONDS,
      1,
      MAX_TIMEOUT_SECONDS,
    ),
    keepAliveEnabled: Boolean(raw.keepAliveEnabled),
    keepAliveIntervalMinutes: normalizeIntegerInRange(
      raw.keepAliveIntervalMinutes,
      DEFAULT_KEEPALIVE_INTERVAL_MINUTES,
      MIN_KEEPALIVE_INTERVAL_MINUTES,
      MAX_KEEPALIVE_INTERVAL_MINUTES,
    ),
    keepAliveSQL: supportsConnectionKeepAliveSQL({
      type,
      driver: toTrimmedString(raw.driver),
      oceanBaseProtocol:
        raw.oceanBaseProtocol as ConnectionConfig["oceanBaseProtocol"],
    })
      ? toTrimmedString(raw.keepAliveSQL).slice(
          0,
          MAX_CONNECTION_KEEPALIVE_SQL_LENGTH,
        )
      : "",
  };

  const resolvedProtection = resolveConnectionProtectionConfig(safeConfig);
  safeConfig.protection = resolvedProtection;
  safeConfig.readOnly = deriveLegacyConnectionReadOnlyFlag(resolvedProtection);

  if (type === "redis") {
    safeConfig.redisDB = normalizeIntegerInRange(
      raw.redisDB,
      0,
      0,
      MAX_REDIS_DATABASE_INDEX,
    );
    safeConfig.redisSentinelMaster = toTrimmedString(raw.redisSentinelMaster);
    safeConfig.redisSentinelUser = toTrimmedString(raw.redisSentinelUser);
    safeConfig.redisSentinelPassword = savePassword
      ? toTrimmedString(raw.redisSentinelPassword)
      : "";
  }

  if (type === "clickhouse") {
    safeConfig.clickHouseProtocol = normalizeClickHouseProtocol(
      raw.clickHouseProtocol,
    );
  }

  if (type === "oceanbase") {
    safeConfig.oceanBaseProtocol = resolveOceanBaseProtocol(
      raw,
      safeConfig.connectionParams || "",
      safeConfig.uri || "",
    );
  }

  if (type === "custom") {
    safeConfig.driver = toTrimmedString(raw.driver);
    safeConfig.dsn = toTrimmedString(raw.dsn).slice(0, MAX_URI_LENGTH);
  }

  if (type === "jvm") {
    safeConfig.jvm = sanitizeJVMConfig(raw.jvm, {
      host: safeConfig.host,
      port: safeConfig.port,
      timeout: safeConfig.timeout || DEFAULT_TIMEOUT_SECONDS,
      persistSecrets: savePassword,
    });
  }

  return safeConfig;
};

const resolveConnectionConfigPayload = (
  raw: Record<string, unknown>,
): unknown => {
  if (raw.config && typeof raw.config === "object") {
    return raw.config;
  }
  // 兼容历史/导入场景：连接对象可能是扁平结构（无 config 包装）。
  const hasLegacyFlatConfig =
    raw.type !== undefined ||
    raw.host !== undefined ||
    raw.port !== undefined ||
    raw.user !== undefined ||
    raw.database !== undefined;
  if (hasLegacyFlatConfig) {
    return raw;
  }
  return undefined;
};

export const sanitizeSavedConnection = (
  value: unknown,
  index: number,
): SavedConnection | null => {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const config = sanitizeConnectionConfig(resolveConnectionConfigPayload(raw));
  const id =
    toTrimmedString(raw.id, `conn-${index + 1}`) || `conn-${index + 1}`;
  const displayType = config.type === "diros" ? "doris" : config.type;
  const fallbackName = config.host
    ? `${displayType}-${config.host}`
    : indexedStoreFallback("store.fallback.connection_name", index);
  const name = toTrimmedString(raw.name, fallbackName) || fallbackName;
  const createdAtValue = Number(raw.createdAt);
  const includeDatabases = sanitizeStringArray(raw.includeDatabases, 256);
  const includeDatabasePatterns = sanitizeDatabasePatternArray(
    raw.includeDatabasePatterns,
  );
  const excludeDatabasePatterns = sanitizeDatabasePatternArray(
    raw.excludeDatabasePatterns,
  );
  const includeRedisDatabases = sanitizeNumberArray(
    raw.includeRedisDatabases,
    0,
    MAX_REDIS_DATABASE_INDEX,
  );
  const schemaVisibilityByDatabase = sanitizeSchemaVisibilityByDatabase(
    raw.schemaVisibilityByDatabase,
    getDataSourceCapabilities(config).schemaIdentifierCaseSensitive,
  );

  return {
    id,
    name,
    createdAt: Number.isFinite(createdAtValue) && createdAtValue > 0 ? createdAtValue : undefined,
    environmentType: normalizeConnectionEnvironmentType(raw.environmentType),
    config: { ...config, id: config.id || id },
    secretRef: toTrimmedString(raw.secretRef) || undefined,
    hasPrimaryPassword: raw.hasPrimaryPassword === true,
    hasSSHPassword: raw.hasSSHPassword === true,
    hasProxyPassword: raw.hasProxyPassword === true,
    hasHttpTunnelPassword: raw.hasHttpTunnelPassword === true,
    hasMySQLReplicaPassword: raw.hasMySQLReplicaPassword === true,
    hasMongoReplicaPassword: raw.hasMongoReplicaPassword === true,
    hasRedisSentinelPassword: raw.hasRedisSentinelPassword === true,
    hasOpaqueURI: raw.hasOpaqueURI === true,
    hasOpaqueDSN: raw.hasOpaqueDSN === true,
    includeDatabases:
      includeDatabases.length > 0 ? includeDatabases : undefined,
    includeDatabasePatterns:
      includeDatabasePatterns.length > 0
        ? includeDatabasePatterns
        : undefined,
    excludeDatabasePatterns:
      excludeDatabasePatterns.length > 0
        ? excludeDatabasePatterns
        : undefined,
    includeRedisDatabases:
      includeRedisDatabases.length > 0 ? includeRedisDatabases : undefined,
    schemaVisibilityByDatabase,
    iconType: sanitizeConnectionIconType(raw.iconType),
    iconColor: sanitizeConnectionIconColor(raw.iconColor),
  };
};

export const sanitizeConnections = (value: unknown): SavedConnection[] => {
  if (!Array.isArray(value)) return [];
  const result: SavedConnection[] = [];
  const idSet = new Set<string>();

  value.forEach((entry, index) => {
    const conn = sanitizeSavedConnection(entry, index);
    if (!conn) return;
    let nextId = conn.id;
    if (idSet.has(nextId)) {
      nextId = `${nextId}-${index + 1}`;
    }
    idSet.add(nextId);
    result.push({ ...conn, id: nextId });
  });

  return result;
};
