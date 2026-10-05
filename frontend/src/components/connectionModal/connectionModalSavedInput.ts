import type { ConnectionConfig, SavedConnection } from "../../types";
import { resolveConnectionSecretDraft } from "../../utils/connectionSecretDraft";
import { normalizeConnectionEnvironmentType } from "../../utils/connectionEnvironment";
import { isMySQLCompatibleType, isFileDatabaseType } from "../../utils/connectionTypeCapabilities";

type Translate = (key: string, params?: any) => string;

export const DEFAULT_KEEPALIVE_INTERVAL_MINUTES = 240;
export const MIN_KEEPALIVE_INTERVAL_MINUTES = 1;
export const MAX_KEEPALIVE_INTERVAL_MINUTES = 1440;

export type ConnectionSecretKey =

  | "primaryPassword"

  | "sshPassword"

  | "proxyPassword"

  | "httpTunnelPassword"

  | "mysqlReplicaPassword"

  | "mongoReplicaPassword"

  | "redisSentinelPassword"

  | "opaqueURI"

  | "opaqueDSN";

export type ConnectionSecretClearState = Record<ConnectionSecretKey, boolean>;

export const createEmptyConnectionSecretClearState =

  (): ConnectionSecretClearState => ({

    primaryPassword: false,

    sshPassword: false,

    proxyPassword: false,

    httpTunnelPassword: false,

    mysqlReplicaPassword: false,

    mongoReplicaPassword: false,

    redisSentinelPassword: false,

    opaqueURI: false,

    opaqueDSN: false,

  });
type BuildSavedConnectionInputParams = {
  config: ConnectionConfig;
  values: any;
  initialValues?: SavedConnection | null;
  clearSecrets: ConnectionSecretClearState;
  customIconType?: string;
  customIconColor?: string;
};

type GetBlockingSecretClearMessageParams = {
  values: any;
  clearSecrets: ConnectionSecretClearState;
  initialValues?: SavedConnection | null;
  translate: Translate;
};

export type BuildConnectionConfigParams = {
  values: any;
  forPersist: boolean;
  initialValues?: SavedConnection | null;
  nacosNamespaceIdTouched?: boolean;
  oracleModeTouched?: boolean;
  translate: Translate;
};

export const buildSavedConnectionInput = ({
  config,
  values,
  initialValues,
  clearSecrets,
  customIconType,
  customIconColor,
}: BuildSavedConnectionInputParams) => {
  const connectionId =
    initialValues?.id || config.id || Date.now().toString();
  const primaryDraft = resolveConnectionSecretDraft({
    hasSecret: initialValues?.hasPrimaryPassword,
    valueInput: config.password,
    clearSecret: clearSecrets.primaryPassword,
    forceClear: values.type === "mongodb" && values.savePassword === false,
  });
  const sshDraft = resolveConnectionSecretDraft({
    hasSecret: initialValues?.hasSSHPassword,
    valueInput: config.ssh?.password,
    clearSecret: clearSecrets.sshPassword,
    forceClear: !config.useSSH,
  });
  const proxyDraft = resolveConnectionSecretDraft({
    hasSecret: initialValues?.hasProxyPassword,
    valueInput: config.proxy?.password,
    clearSecret: clearSecrets.proxyPassword,
    forceClear: !config.useProxy,
  });
  const httpTunnelDraft = resolveConnectionSecretDraft({
    hasSecret: initialValues?.hasHttpTunnelPassword,
    valueInput: config.httpTunnel?.password,
    clearSecret: clearSecrets.httpTunnelPassword,
    forceClear: !config.useHttpTunnel,
  });
  const mysqlReplicaEnabled =
    isMySQLCompatibleType(config.type) && config.topology === "replica";
  const mysqlReplicaDraft = resolveConnectionSecretDraft({
    hasSecret: initialValues?.hasMySQLReplicaPassword,
    valueInput: config.mysqlReplicaPassword,
    clearSecret: clearSecrets.mysqlReplicaPassword,
    forceClear: !mysqlReplicaEnabled,
  });
  const mongoReplicaEnabled =
    config.type === "mongodb" &&
    config.topology === "replica" &&
    values.savePassword !== false;
  const mongoReplicaDraft = resolveConnectionSecretDraft({
    hasSecret: initialValues?.hasMongoReplicaPassword,
    valueInput: config.mongoReplicaPassword,
    clearSecret: clearSecrets.mongoReplicaPassword,
    forceClear: !mongoReplicaEnabled,
  });
  const redisSentinelEnabled =
    config.type === "redis" &&
    config.topology === "sentinel" &&
    values.savePassword !== false;
  const redisSentinelDraft = resolveConnectionSecretDraft({
    hasSecret: initialValues?.hasRedisSentinelPassword,
    valueInput: config.redisSentinelPassword,
    clearSecret: clearSecrets.redisSentinelPassword,
    forceClear: !redisSentinelEnabled,
  });
  const opaqueUriDraft = resolveConnectionSecretDraft({
    hasSecret: initialValues?.hasOpaqueURI,
    valueInput: config.uri,
    clearSecret: clearSecrets.opaqueURI,
    forceClear: values.type === "custom",
    trimInput: true,
  });
  const opaqueDsnDraft = resolveConnectionSecretDraft({
    hasSecret: initialValues?.hasOpaqueDSN,
    valueInput: config.dsn,
    clearSecret: clearSecrets.opaqueDSN,
    forceClear: values.type !== "custom",
    trimInput: true,
  });
  const isRedisType = values.type === "redis";
  const displayHost = String(
    (config as any).host || values.host || "",
  ).trim();
  const nextName =
    values.name ||
    (isFileDatabaseType(values.type)
      ? values.type === "duckdb"
        ? "DuckDB DB"
        : "SQLite DB"
      : values.type === "redis"
        ? `Redis ${displayHost}`
        : displayHost);

  return {
    id: connectionId,
    name: nextName,
    createdAt: initialValues?.createdAt,
    environmentType: normalizeConnectionEnvironmentType(values.environmentType),
    config: {
      ...config,
      id: connectionId,
      password: primaryDraft.value,
      ssh: {
        ...(config.ssh || {
          host: "",
          port: 22,
          user: "",
          password: "",
          keyPath: "",
          knownHostsPath: "",
          hostKeyFingerprint: "",
        }),
        password: sshDraft.value,
      },
      proxy: {
        ...(config.proxy || {
          type: "socks5",
          host: "",
          port: 1080,
          user: "",
          password: "",
        }),
        password: proxyDraft.value,
      },
      httpTunnel: {
        ...(config.httpTunnel || {
          host: "",
          port: 8080,
          user: "",
          password: "",
          encodeBase64: true,
        }),
        password: httpTunnelDraft.value,
      },
      uri: opaqueUriDraft.value,
      dsn: opaqueDsnDraft.value,
      mysqlReplicaPassword: mysqlReplicaDraft.value,
      mongoReplicaPassword: mongoReplicaDraft.value,
      redisSentinelPassword: redisSentinelDraft.value,
    },
    includeDatabases: values.includeDatabases,
    includeDatabasePatterns: values.includeDatabasePatterns,
    excludeDatabasePatterns: values.excludeDatabasePatterns,
    includeRedisDatabases: isRedisType
      ? values.includeRedisDatabases
      : undefined,
    schemaVisibilityByDatabase: initialValues?.schemaVisibilityByDatabase,
    iconType: customIconType || "",
    iconColor: customIconColor || "",
    clearPrimaryPassword: primaryDraft.clearStoredSecret,
    clearSSHPassword: sshDraft.clearStoredSecret,
    clearProxyPassword: proxyDraft.clearStoredSecret,
    clearHttpTunnelPassword: httpTunnelDraft.clearStoredSecret,
    clearMySQLReplicaPassword: mysqlReplicaDraft.clearStoredSecret,
    clearMongoReplicaPassword: mongoReplicaDraft.clearStoredSecret,
    clearRedisSentinelPassword: redisSentinelDraft.clearStoredSecret,
    clearOpaqueURI: opaqueUriDraft.clearStoredSecret,
    clearOpaqueDSN: opaqueDsnDraft.clearStoredSecret,
  };
};

export const getBlockingSecretClearMessage = ({
  values,
  clearSecrets,
  initialValues,
  translate: t,
}: GetBlockingSecretClearMessageParams): string | null => {
  if (
    clearSecrets.primaryPassword &&
    values.type !== "custom" &&
    !isFileDatabaseType(values.type) &&
    String(values.password ?? "") === ""
  ) {
    return t("connection.modal.secret.blocking.primary");
  }
  if (
    clearSecrets.sshPassword &&
    values.useSSH &&
    String(values.sshPassword ?? "") === ""
  ) {
    return t("connection.modal.secret.blocking.ssh");
  }
  if (
    clearSecrets.proxyPassword &&
    values.useProxy &&
    !values.useHttpTunnel &&
    String(values.proxyPassword ?? "") === ""
  ) {
    return t("connection.modal.secret.blocking.proxy");
  }
  if (
    clearSecrets.httpTunnelPassword &&
    values.useHttpTunnel &&
    String(values.httpTunnelPassword ?? "") === ""
  ) {
    return t("connection.modal.secret.blocking.httpTunnel");
  }
  if (
    clearSecrets.mysqlReplicaPassword &&
    isMySQLCompatibleType(values.type) &&
    values.mysqlTopology === "replica" &&
    String(values.mysqlReplicaPassword ?? "") === ""
  ) {
    return t("connection.modal.secret.blocking.mysqlReplica");
  }
  if (
    clearSecrets.mongoReplicaPassword &&
    values.type === "mongodb" &&
    values.mongoTopology === "replica" &&
    String(values.mongoReplicaPassword ?? "") === ""
  ) {
    return t("connection.modal.secret.blocking.mongoReplica");
  }
  if (
    clearSecrets.redisSentinelPassword &&
    values.type === "redis" &&
    values.redisTopology === "sentinel" &&
    String(values.redisSentinelPassword ?? "") === ""
  ) {
    return t("connection.modal.secret.blocking.redis_sentinel");
  }
  if (
    values.type === "mongodb" &&
    values.savePassword === false &&
    initialValues?.hasPrimaryPassword &&
    String(values.password ?? "") === ""
  ) {
    return t("connection.modal.secret.blocking.mongoPrimary");
  }
  return null;
};
