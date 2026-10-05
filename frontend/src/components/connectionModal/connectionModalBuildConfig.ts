import type { ConnectionConfig } from "../../types";
import {
  supportsConnectionKeepAliveSQL,
  MAX_CONNECTION_KEEPALIVE_SQL_LENGTH,
  isSingleReadOnlyConnectionQuery,
  supportsConnectionReadOnlyMode,
  normalizeConnectionProtectionConfig,
  deriveLegacyConnectionReadOnlyFlag,
} from "../../utils/connectionReadOnly";
import { getConnectionTypeDefaultPort as getDefaultPortByType } from "../../utils/connectionTypeCatalog";
import {
  isFileDatabaseType,
  supportsSSLForType,
  supportsSSLClientCertificateForType,
  isMySQLCompatibleType,
  supportsConnectionParamsForType,
} from "../../utils/connectionTypeCapabilities";
import {
  hasUnsupportedJVMEditableModes,
  hasUnsupportedJVMDiagnosticTransport,
  normalizeEditableJVMModes,
  buildJVMConnectionConfig,
  buildDefaultJVMConnectionValues,
} from "../../utils/jvmConnectionConfig";
import { resolveRedisConfigDraft } from "../../utils/redisConnectionUri";
import { normalizeDriverVariantValue } from "../../utils/dataSourceRegistry/driverVariant";
import { setNacosConnectionScope } from "../../utils/nacosConnectionScope";
import {
  parseUriToValues,
  resolveOracleConnectionTarget,
  normalizeClickHouseProtocolValue,
  getPulsarDefaultPort,
  normalizeOceanBaseProtocolValue,
  parseClickHouseHTTPUriToValues,
  normalizeFileDbPath,
  parseHostPort,
  toAddress,
  normalizeAddressList,
  normalizeMongoSrvHostList,
  normalizeOceanBaseConnectionParamsText,
  normalizeConnectionParamsText,
  withOracleSIDParam,
  withoutOracleSIDParam,
  withoutOracleSIDFromURI,
} from "./connectionModalUri";
import {
  type BuildConnectionConfigParams,
  MIN_KEEPALIVE_INTERVAL_MINUTES,
  MAX_KEEPALIVE_INTERVAL_MINUTES,
  DEFAULT_KEEPALIVE_INTERVAL_MINUTES,
} from "./connectionModalSavedInput";

export const buildConnectionConfig = async ({
  values,
  forPersist,
  initialValues,
  nacosNamespaceIdTouched = false,
  oracleModeTouched = false,
  translate: t,
}: BuildConnectionConfigParams): Promise<ConnectionConfig> => {
  const mergedValues = { ...values };
  if (
    String(mergedValues.type || "")
      .trim()
      .toLowerCase() === "jvm"
  ) {
    if (
      hasUnsupportedJVMEditableModes({
        allowedModes: mergedValues.jvmAllowedModes,
        preferredMode: mergedValues.jvmPreferredMode,
      })
    ) {
      throw new Error(t("connection.modal.jvm.unsupportedMode.saveTest"));
    }
    if (
      hasUnsupportedJVMDiagnosticTransport(
        mergedValues.jvmDiagnosticTransport,
      )
    ) {
      throw new Error(
        t("connection.modal.jvm.unsupportedTransport.saveTest"),
      );
    }
    const existingDiagnostic = initialValues?.config?.jvm?.diagnostic;
    if (
      mergedValues.jvmDiagnosticEnabled === undefined &&
      existingDiagnostic?.enabled !== undefined
    ) {
      mergedValues.jvmDiagnosticEnabled = existingDiagnostic.enabled;
    }
    if (
      String(mergedValues.jvmDiagnosticTransport || "").trim() === "" &&
      existingDiagnostic?.transport
    ) {
      mergedValues.jvmDiagnosticTransport = existingDiagnostic.transport;
    }
    if (
      String(mergedValues.jvmDiagnosticBaseUrl || "").trim() === "" &&
      existingDiagnostic?.baseUrl
    ) {
      mergedValues.jvmDiagnosticBaseUrl = existingDiagnostic.baseUrl;
    }
    if (
      String(mergedValues.jvmDiagnosticTargetId || "").trim() === "" &&
      existingDiagnostic?.targetId
    ) {
      mergedValues.jvmDiagnosticTargetId = existingDiagnostic.targetId;
    }
    if (
      String(mergedValues.jvmDiagnosticApiKey || "").trim() === "" &&
      existingDiagnostic?.apiKey
    ) {
      mergedValues.jvmDiagnosticApiKey = existingDiagnostic.apiKey;
    }
    if (
      mergedValues.jvmDiagnosticAllowObserveCommands === undefined &&
      existingDiagnostic?.allowObserveCommands !== undefined
    ) {
      mergedValues.jvmDiagnosticAllowObserveCommands =
        existingDiagnostic.allowObserveCommands;
    }
    if (
      mergedValues.jvmDiagnosticAllowTraceCommands === undefined &&
      existingDiagnostic?.allowTraceCommands !== undefined
    ) {
      mergedValues.jvmDiagnosticAllowTraceCommands =
        existingDiagnostic.allowTraceCommands;
    }
    if (
      mergedValues.jvmDiagnosticAllowMutatingCommands === undefined &&
      existingDiagnostic?.allowMutatingCommands !== undefined
    ) {
      mergedValues.jvmDiagnosticAllowMutatingCommands =
        existingDiagnostic.allowMutatingCommands;
    }
    if (
      (mergedValues.jvmDiagnosticTimeoutSeconds === undefined ||
        mergedValues.jvmDiagnosticTimeoutSeconds === null ||
        mergedValues.jvmDiagnosticTimeoutSeconds === "") &&
      Number(existingDiagnostic?.timeoutSeconds) > 0
    ) {
      mergedValues.jvmDiagnosticTimeoutSeconds = Number(
        existingDiagnostic?.timeoutSeconds,
      );
    }
    const resolvedJvmAllowedModes = normalizeEditableJVMModes(
      mergedValues.jvmAllowedModes,
    );
    const resolvedJvmTimeout = Number(mergedValues.timeout || 30);
    const preferredJvmMode = String(mergedValues.jvmPreferredMode || "")
      .trim()
      .toLowerCase();
    const resolvedJvmPreferredMode =
      resolvedJvmAllowedModes.find((mode) => mode === preferredJvmMode) ||
      resolvedJvmAllowedModes[0];
    return buildJVMConnectionConfig({
      ...buildDefaultJVMConnectionValues(),
      ...mergedValues,
      jvmAllowedModes: resolvedJvmAllowedModes,
      jvmPreferredMode: resolvedJvmPreferredMode,
      jvmEndpointEnabled: resolvedJvmAllowedModes.includes("endpoint"),
      jvmAgentEnabled: resolvedJvmAllowedModes.includes("agent"),
      timeout: resolvedJvmTimeout,
      jvmEndpointTimeoutSeconds: resolvedJvmTimeout,
    });
  }
  const isNacosConfig =
    String(mergedValues.type || "").trim().toLowerCase() === "nacos";
  const hasStoredNacosConnectionParams =
    isNacosConfig &&
    String(initialValues?.config?.connectionParams || "").trim() !== "";
  const hasExplicitNacosNamespaceId =
    isNacosConfig &&
    Object.prototype.hasOwnProperty.call(
      mergedValues,
      "nacosNamespaceId",
    ) &&
    mergedValues.nacosNamespaceId !== undefined &&
    (String(mergedValues.nacosNamespaceId || "").trim() !== "" ||
      nacosNamespaceIdTouched ||
      hasStoredNacosConnectionParams);
  const parsedUriValues = parseUriToValues(
    mergedValues.uri,
    mergedValues.type,
  );
  const isOracleConfig =
    String(mergedValues.type || "")
      .trim()
      .toLowerCase() === "oracle";
  const parsedOracleMode = String(parsedUriValues?.oracleMode || "")
    .trim()
    .toLowerCase();
  const currentOracleMode =
    String(mergedValues.oracleMode || "service")
      .trim()
      .toLowerCase() === "sid"
      ? "sid"
      : "service";
  const oracleTarget = isOracleConfig
    ? resolveOracleConnectionTarget(
        parsedUriValues?.connectionParams,
        mergedValues.connectionParams,
      )
    : null;
  const resolvedOracleMode = isOracleConfig
    ? oracleModeTouched || currentOracleMode === "sid"
      ? currentOracleMode
      : oracleTarget?.mode || "service"
    : "";
  if (isOracleConfig && resolvedOracleMode === "sid") {
    mergedValues.oracleMode = "sid";
    if (
      oracleTarget?.mode === "sid" &&
      (currentOracleMode !== "sid" ||
        String(mergedValues.database || "").trim() === "")
    ) {
      mergedValues.database = oracleTarget.sid;
    }
  }
  const isEmptyField = (value: unknown) =>
    value === undefined ||
    value === null ||
    value === "" ||
    value === 0 ||
    (Array.isArray(value) && value.length === 0);
  if (parsedUriValues) {
    Object.entries(parsedUriValues).forEach(([key, value]) => {
      if (
        isOracleConfig &&
        parsedOracleMode &&
        parsedOracleMode !== resolvedOracleMode &&
        (key === "database" || key === "oracleMode")
      ) {
        return;
      }
      if (key === "nacosNamespaceId" && hasExplicitNacosNamespaceId) {
        return;
      }
      if (
        key === "clickHouseProtocol" &&
        normalizeClickHouseProtocolValue((mergedValues as any)[key]) ===
          "auto" &&
        normalizeClickHouseProtocolValue(value) !== "auto"
      ) {
        (mergedValues as any)[key] = value;
        return;
      }
      if (isEmptyField((mergedValues as any)[key])) {
        (mergedValues as any)[key] = value;
      }
    });
  }

  const type = String(mergedValues.type || "").toLowerCase();
  const defaultPort = type === "pulsar"
    ? getPulsarDefaultPort(!!mergedValues.useSSL)
    : getDefaultPortByType(type);
  const selectedOceanBaseProtocol =
    type === "oceanbase"
      ? normalizeOceanBaseProtocolValue(mergedValues.oceanBaseProtocol)
      : "mysql";
  if (type === "clickhouse") {
    const requestedProtocol = normalizeClickHouseProtocolValue(
      mergedValues.clickHouseProtocol,
    );
    const hostSchemeValues = parseClickHouseHTTPUriToValues(
      mergedValues.host,
      Number(mergedValues.port || defaultPort),
    );
    if (hostSchemeValues) {
      mergedValues.host = hostSchemeValues.host;
      mergedValues.port = hostSchemeValues.port;
      if (requestedProtocol !== "native") {
        mergedValues.clickHouseProtocol = "http";
        mergedValues.useSSL = hostSchemeValues.useSSL;
        mergedValues.sslMode = hostSchemeValues.sslMode;
      } else {
        mergedValues.clickHouseProtocol = "native";
      }
      if (isEmptyField(mergedValues.user)) {
        mergedValues.user = hostSchemeValues.user;
      }
      if (isEmptyField(mergedValues.password)) {
        mergedValues.password = hostSchemeValues.password;
      }
      if (isEmptyField(mergedValues.database)) {
        mergedValues.database = hostSchemeValues.database;
      }
    }
  }
  const isFileDbType = isFileDatabaseType(type);
  const sslCapableType = supportsSSLForType(type);

  // Redis 默认不展示用户名字段；若 URI 可解析则以 URI 为准覆盖 user，
  // 同时清理历史默认值 root，避免 go-redis 发送 ACL AUTH(user, pass) 导致 WRONGPASS。
  if (type === "redis") {
    if (
      parsedUriValues &&
      Object.prototype.hasOwnProperty.call(parsedUriValues, "user")
    ) {
      mergedValues.user = String((parsedUriValues as any).user || "");
    } else if (String(mergedValues.user || "").trim() === "root") {
      mergedValues.user = "";
    }
  }
  const sslModeRaw = String(mergedValues.sslMode || "preferred")
    .trim()
    .toLowerCase();
  const sslMode: "preferred" | "required" | "skip-verify" | "disable" =
    sslModeRaw === "required"
      ? "required"
      : sslModeRaw === "skip-verify"
        ? "skip-verify"
        : sslModeRaw === "disable"
          ? "disable"
          : "preferred";
  const effectiveUseSSL = sslCapableType && !!mergedValues.useSSL;
  const sslCAPath = sslCapableType
    ? String(mergedValues.sslCAPath || "").trim()
    : "";
  const sslCertPath = sslCapableType
    ? String(mergedValues.sslCertPath || "").trim()
    : "";
  const sslKeyPath = sslCapableType
    ? String(mergedValues.sslKeyPath || "").trim()
    : "";
  if (type === "dameng" && effectiveUseSSL && (!sslCertPath || !sslKeyPath)) {
    throw new Error(t("connection.modal.validation.ssl.damengRequired"));
  }
  if (effectiveUseSSL && supportsSSLClientCertificateForType(type) && (!!sslCertPath !== !!sslKeyPath)) {
    throw new Error(t("connection.modal.validation.ssl.clientPairRequired"));
  }

  let primaryHost = "localhost";
  let primaryPort = defaultPort;
  if (isFileDbType) {
    // 文件型数据库（sqlite/duckdb）这里的 host 即数据库文件路径，不应参与 host:port 拼接与解析。
    primaryHost = normalizeFileDbPath(String(mergedValues.host || "").trim());
    primaryPort = 0;
  } else {
    const parsedPrimary = parseHostPort(
      toAddress(
        mergedValues.host || "localhost",
        Number(mergedValues.port || defaultPort),
        defaultPort,
      ),
      defaultPort,
    );
    primaryHost = parsedPrimary?.host || "localhost";
    primaryPort = parsedPrimary?.port || defaultPort;
  }

  let hosts: string[] = [];
  let topology: "single" | "replica" | "cluster" | "sentinel" | undefined;
  let replicaSet = "";
  let authSource = "";
  let readPreference = "";
  let mysqlReplicaUser = "";
  let mysqlReplicaPassword = "";
  let mongoSrvEnabled = false;
  let mongoAuthMechanism = "";
  let mongoReplicaUser = "";
  let mongoReplicaPassword = "";
  let redisSentinelMaster = "";
  let redisSentinelUser = "";
  let redisSentinelPassword = "";
  const savePassword =
    type === "mongodb" ? mergedValues.savePassword !== false : true;

  if (isMySQLCompatibleType(type) && selectedOceanBaseProtocol !== "oracle") {
    const replicas =
      mergedValues.mysqlTopology === "replica"
        ? normalizeAddressList(mergedValues.mysqlReplicaHosts, defaultPort)
        : [];
    const allHosts = normalizeAddressList(
      [`${primaryHost}:${primaryPort}`, ...replicas],
      defaultPort,
    );
    if (mergedValues.mysqlTopology === "replica" || allHosts.length > 1) {
      hosts = allHosts;
      topology = "replica";
      mysqlReplicaUser = String(mergedValues.mysqlReplicaUser || "").trim();
      mysqlReplicaPassword = String(mergedValues.mysqlReplicaPassword || "");
    } else {
      topology = "single";
    }
  }

  if (type === "kafka") {
    const brokers =
      mergedValues.kafkaTopology === "cluster"
        ? normalizeAddressList(mergedValues.kafkaHosts, defaultPort)
        : [];
    const allHosts = normalizeAddressList(
      [`${primaryHost}:${primaryPort}`, ...brokers],
      defaultPort,
    );
    if (mergedValues.kafkaTopology === "cluster" || allHosts.length > 1) {
      hosts = allHosts;
      topology = "cluster";
    } else {
      topology = "single";
    }
  }

  if (type === "mqtt") {
    const brokers =
      mergedValues.mqttTopology === "cluster"
        ? normalizeAddressList(mergedValues.mqttHosts, defaultPort)
        : [];
    const allHosts = normalizeAddressList(
      [`${primaryHost}:${primaryPort}`, ...brokers],
      defaultPort,
    );
    if (mergedValues.mqttTopology === "cluster" || allHosts.length > 1) {
      hosts = allHosts;
      topology = "cluster";
    } else {
      topology = "single";
    }
  }

  if (type === "rocketmq") {
    const nameservers =
      mergedValues.rocketmqTopology === "cluster"
        ? normalizeAddressList(mergedValues.rocketmqHosts, defaultPort)
        : [];
    const allHosts = normalizeAddressList(
      [`${primaryHost}:${primaryPort}`, ...nameservers],
      defaultPort,
    );
    if (mergedValues.rocketmqTopology === "cluster" || allHosts.length > 1) {
      hosts = allHosts;
      topology = "cluster";
    } else {
      topology = "single";
    }
  }

  if (type === "mongodb") {
    mongoSrvEnabled = !!mergedValues.mongoSrv;
    const extraHosts =
      mergedValues.mongoTopology === "replica"
        ? mongoSrvEnabled
          ? normalizeMongoSrvHostList(mergedValues.mongoHosts, defaultPort)
          : normalizeAddressList(mergedValues.mongoHosts, defaultPort)
        : [];
    const primarySeed = mongoSrvEnabled
      ? primaryHost
      : `${primaryHost}:${primaryPort}`;
    const allHosts = mongoSrvEnabled
      ? normalizeMongoSrvHostList([primarySeed, ...extraHosts], defaultPort)
      : normalizeAddressList([primarySeed, ...extraHosts], defaultPort);
    if (
      mergedValues.mongoTopology === "replica" ||
      allHosts.length > 1 ||
      mergedValues.mongoReplicaSet
    ) {
      hosts = allHosts;
      topology = "replica";
      mongoReplicaUser = String(mergedValues.mongoReplicaUser || "").trim();
      mongoReplicaPassword = String(mergedValues.mongoReplicaPassword || "");
    } else {
      topology = "single";
    }
    replicaSet = String(mergedValues.mongoReplicaSet || "").trim();
    authSource = String(
      mergedValues.mongoAuthSource || mergedValues.database || "admin",
    ).trim();
    readPreference = String(
      mergedValues.mongoReadPreference || "primary",
    ).trim();
    mongoAuthMechanism = String(mergedValues.mongoAuthMechanism || "")
      .trim()
      .toUpperCase();
  }

  if (type === "redis") {
    const redisDraft = resolveRedisConfigDraft(
      mergedValues,
      primaryHost,
      primaryPort,
      defaultPort,
    );
    primaryPort = redisDraft.primaryPort;
    hosts = redisDraft.hosts;
    topology = redisDraft.topology;
    redisSentinelMaster = redisDraft.redisSentinelMaster;
    redisSentinelUser = redisDraft.redisSentinelUser;
    redisSentinelPassword = redisDraft.redisSentinelPassword;
    mergedValues.redisDB = redisDraft.redisDB;
  }

  const effectiveUseSSH = type !== "pulsar" && !!mergedValues.useSSH;
  const sshConfig = effectiveUseSSH
    ? {
        host: mergedValues.sshHost,
        port: Number(mergedValues.sshPort),
        user: mergedValues.sshUser,
        password: mergedValues.sshPassword || "",
        keyPath: mergedValues.sshKeyPath || "",
        knownHostsPath: String(mergedValues.sshKnownHostsPath || "").trim(),
        hostKeyFingerprint: String(
          mergedValues.sshHostKeyFingerprint || "",
        ).trim(),
      }
    : {
        host: "",
        port: 22,
        user: "",
        password: "",
        keyPath: "",
        knownHostsPath: "",
        hostKeyFingerprint: "",
      };
  const effectiveUseHttpTunnel =
    !isFileDbType && type !== "pulsar" && !!mergedValues.useHttpTunnel;
  const effectiveUseProxy =
    !isFileDbType &&
    type !== "pulsar" &&
    !!mergedValues.useProxy &&
    !effectiveUseHttpTunnel;
  const proxyTypeRaw = String(
    mergedValues.proxyType || "socks5",
  ).toLowerCase();
  const proxyType: "socks5" | "http" =
    proxyTypeRaw === "http" ? "http" : "socks5";
  const proxyConfig: NonNullable<ConnectionConfig["proxy"]> =
    effectiveUseProxy
      ? {
          type: proxyType,
          host: String(mergedValues.proxyHost || "").trim(),
          port: Number(
            mergedValues.proxyPort || (proxyTypeRaw === "http" ? 8080 : 1080),
          ),
          user: String(mergedValues.proxyUser || "").trim(),
          password: mergedValues.proxyPassword || "",
        }
      : {
          type: "socks5",
          host: "",
          port: 1080,
          user: "",
          password: "",
        };
  const httpTunnelConfig: NonNullable<ConnectionConfig["httpTunnel"]> =
    effectiveUseHttpTunnel
      ? {
          host: String(mergedValues.httpTunnelHost || "").trim(),
          port: Number(mergedValues.httpTunnelPort || 8080),
          user: String(mergedValues.httpTunnelUser || "").trim(),
          password: mergedValues.httpTunnelPassword || "",
          encodeBase64: mergedValues.httpTunnelEncodeBase64 !== false,
        }
      : {
          host: "",
          port: 8080,
          user: "",
          password: "",
          encodeBase64: true,
        };
  if (effectiveUseHttpTunnel) {
    if (!httpTunnelConfig.host) {
      throw new Error(t("connection.modal.validation.httpTunnel.hostRequired"));
    }
  }

  const keepPassword = !forPersist || savePassword;
  const keepAliveEnabled =
    !isFileDatabaseType(type) &&
    type !== "jvm" &&
    type !== "nacos" &&
    !!mergedValues.keepAliveEnabled;
  const keepAliveIntervalMinutesRaw = Number(
    mergedValues.keepAliveIntervalMinutes,
  );
  const keepAliveIntervalMinutes =
    Number.isFinite(keepAliveIntervalMinutesRaw) &&
    keepAliveIntervalMinutesRaw >= MIN_KEEPALIVE_INTERVAL_MINUTES
      ? Math.min(
          Math.trunc(keepAliveIntervalMinutesRaw),
          MAX_KEEPALIVE_INTERVAL_MINUTES,
        )
      : DEFAULT_KEEPALIVE_INTERVAL_MINUTES;
  const keepAliveSQLInput = String(mergedValues.keepAliveSQL || "").trim();
  const keepAliveSQLSupported = supportsConnectionKeepAliveSQL({
    type,
    driver: mergedValues.driver,
    oceanBaseProtocol: selectedOceanBaseProtocol,
  });
  if (
    keepAliveEnabled &&
    keepAliveSQLSupported &&
    keepAliveSQLInput.length > MAX_CONNECTION_KEEPALIVE_SQL_LENGTH
  ) {
    throw new Error(t("connection.modal.network.keepAliveSQL.maxLength"));
  }
  if (
    keepAliveEnabled &&
    keepAliveSQLSupported &&
    keepAliveSQLInput &&
    !isSingleReadOnlyConnectionQuery(
      {
        type,
        driver: mergedValues.driver,
        oceanBaseProtocol: selectedOceanBaseProtocol,
      },
      keepAliveSQLInput,
    )
  ) {
    throw new Error(t("connection.modal.network.keepAliveSQL.readOnly"));
  }
  const keepAliveSQL = keepAliveSQLSupported
    ? keepAliveSQLInput.slice(0, MAX_CONNECTION_KEEPALIVE_SQL_LENGTH)
    : "";
  let normalizedConnectionParams = supportsConnectionParamsForType(type)
    ? type === "oceanbase"
      ? normalizeOceanBaseConnectionParamsText(
          mergedValues.connectionParams,
          selectedOceanBaseProtocol,
        )
      : normalizeConnectionParamsText(mergedValues.connectionParams)
    : "";
  if (
    type === "nacos" &&
    Object.prototype.hasOwnProperty.call(mergedValues, "nacosNamespaceId")
  ) {
    normalizedConnectionParams = setNacosConnectionScope(
      normalizedConnectionParams,
      mergedValues.nacosNamespaceId,
    );
  }
  if (type === "nacos" && !/(?:^|[&;])contextPath=/.test(normalizedConnectionParams)) {
    normalizedConnectionParams = normalizedConnectionParams
      ? `${normalizedConnectionParams}&contextPath=/nacos`
      : "contextPath=/nacos";
  }
  if (type === "oracle") {
    const oracleMode =
      String(mergedValues.oracleMode || "service")
        .trim()
        .toLowerCase() === "sid"
        ? "sid"
        : "service";
    const oracleTargetValue = String(mergedValues.database || "").trim();
    if (!oracleTargetValue) {
      throw new Error(
        t(
          oracleMode === "sid"
            ? "connection.modal.field.sid.required"
            : "connection.modal.field.serviceName.required",
        ),
      );
    }
    if (oracleMode === "sid") {
      // SID 模式：表单 database 字段承载 SID 值，写入 connectionParams 的 SID 参数，
      // Database（服务名）置空避免 DSN path 冗余（后端 getDSN 据此组装 (SID=...)）。
      normalizedConnectionParams = withOracleSIDParam(
        normalizedConnectionParams,
        oracleTargetValue,
      );
      mergedValues.database = "";
    } else {
      // 服务名模式：清除历史 SID 参数（含 URI query），避免 go-ora 驱动 SID 优先导致连接目标漂移。
      normalizedConnectionParams =
        withoutOracleSIDParam(normalizedConnectionParams);
      mergedValues.uri = withoutOracleSIDFromURI(mergedValues.uri);
    }
  }
  const supportsProductionGuard = supportsConnectionReadOnlyMode({
    type,
    driver: mergedValues.driver,
    oceanBaseProtocol: selectedOceanBaseProtocol,
  });
  const protection = supportsProductionGuard
    ? normalizeConnectionProtectionConfig({
        restrictDataEdit: mergedValues.restrictDataEdit === true,
        restrictStructureEdit: mergedValues.restrictStructureEdit === true,
        restrictScriptExecution:
          type !== "nacos" && mergedValues.restrictScriptExecution === true,
        restrictDataImport: mergedValues.restrictDataImport === true,
      })
    : undefined;

  return {
    type: mergedValues.type,
    host: primaryHost,
    port: Number(primaryPort || 0),
    user: mergedValues.user || "",
    password: keepPassword ? mergedValues.password || "" : "",
    savePassword: savePassword,
    database: mergedValues.database || "",
    readOnly: protection
      ? deriveLegacyConnectionReadOnlyFlag(protection)
      : false,
    protection,
    useSSL: effectiveUseSSL,
    sslMode: effectiveUseSSL ? sslMode : "disable",
    sslCAPath: sslCAPath,
    sslCertPath: sslCertPath,
    sslKeyPath: sslKeyPath,
    useSSH: effectiveUseSSH,
    ssh: sshConfig,
    useProxy: effectiveUseProxy,
    proxy: proxyConfig,
    useHttpTunnel: effectiveUseHttpTunnel,
    httpTunnel: httpTunnelConfig,
    driver: mergedValues.driver,
    dsn: mergedValues.dsn,
    connectionParams: normalizedConnectionParams,
    timeout: Number(mergedValues.timeout || 30),
    keepAliveEnabled: keepAliveEnabled,
    keepAliveIntervalMinutes: keepAliveIntervalMinutes,
    keepAliveSQL: keepAliveSQL,
    redisDB: Number.isFinite(Number(mergedValues.redisDB))
      ? Math.max(0, Math.trunc(Number(mergedValues.redisDB)))
      : 0,
    redisSentinelMaster: redisSentinelMaster,
    redisSentinelUser: redisSentinelUser,
    redisSentinelPassword: keepPassword ? redisSentinelPassword : "",
    uri: String(mergedValues.uri || "").trim(),
    clickHouseProtocol:
      type === "clickhouse"
        ? normalizeClickHouseProtocolValue(mergedValues.clickHouseProtocol)
        : undefined,
    oceanBaseProtocol:
      type === "oceanbase" ? selectedOceanBaseProtocol : undefined,
    driverVariant: normalizeDriverVariantValue(type, mergedValues.driverVariant),
    hosts: hosts,
    topology: topology,
    mysqlReplicaUser: mysqlReplicaUser,
    mysqlReplicaPassword: keepPassword ? mysqlReplicaPassword : "",
    replicaSet: replicaSet,
    authSource: authSource,
    readPreference: readPreference,
    mongoSrv: mongoSrvEnabled,
    mongoAuthMechanism: mongoAuthMechanism,
    mongoReplicaUser: mongoReplicaUser,
    mongoReplicaPassword: keepPassword ? mongoReplicaPassword : "",
  };
};
