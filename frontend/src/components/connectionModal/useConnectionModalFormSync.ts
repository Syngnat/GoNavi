import { useEffect } from "react";
import { createEmptyConnectionSecretClearState } from "./connectionModalConfig";
import { getConnectionTypeDefaultPort as getDefaultPortByType } from "../../utils/connectionTypeCatalog";
import { isFileDatabaseType, supportsSSLForType } from "../../utils/connectionTypeCapabilities";
import {
  buildDefaultJVMConnectionValues,
  resolveEditableJVMModeSelection,
} from "../../utils/jvmConnectionConfig";
import {
  toAddress,
  normalizeAddressList,
  parseHostPort,
  normalizeFileDbPath,
  parseUriToValues,
  resolveOracleConnectionTarget,
  normalizeClickHouseProtocolValue,
} from "./connectionModalUri";
import { resolveConnectionProtectionConfig } from "../../utils/connectionReadOnly";
import { extractNacosConnectionScope } from "../../utils/nacosConnectionScope";
import {
  normalizeConnectionEnvironmentType,
  DEFAULT_CONNECTION_ENVIRONMENT,
} from "../../utils/connectionEnvironment";
import {
  resolveOceanBaseProtocolForConfig,
  DEFAULT_KEEPALIVE_INTERVAL_MINUTES,
  buildRedisDatabaseList,
} from "./connectionModalHelpers";
import type { ConnectionModalLifecycleApi } from "./useConnectionModalLifecycle";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalDriverStatusApi } from "./useConnectionModalDriverStatus";
import type { ConnectionModalProps } from "../ConnectionModal";

export interface UseConnectionModalFormSyncInput {
  open: ConnectionModalProps['open'];
  initialValues: ConnectionModalProps['initialValues'];
  cancelActiveConnectionTest: ConnectionModalLifecycleApi['cancelActiveConnectionTest'];
  testRunIdRef: ConnectionModalStateApi['testRunIdRef'];
  oracleModeTouchedRef: ConnectionModalStateApi['oracleModeTouchedRef'];
  setSaving: ConnectionModalStateApi['setSaving'];
  setTestingConnection: ConnectionModalStateApi['setTestingConnection'];
  testInFlightRef: ConnectionModalStateApi['testInFlightRef'];
  testTimerRef: ConnectionModalStateApi['testTimerRef'];
  setTestResult: ConnectionModalStateApi['setTestResult'];
  setTestErrorLogOpen: ConnectionModalStateApi['setTestErrorLogOpen'];
  setSSHConnectionProgress: ConnectionModalStateApi['setSSHConnectionProgress'];
  setSSHProgressPanelOpen: ConnectionModalStateApi['setSSHProgressPanelOpen'];
  setSSHHostKeyTrust: ConnectionModalStateApi['setSSHHostKeyTrust'];
  setTrustingSSHHostKey: ConnectionModalStateApi['setTrustingSSHHostKey'];
  setDbList: ConnectionModalStateApi['setDbList'];
  setRedisDbList: ConnectionModalStateApi['setRedisDbList'];
  setMongoMembers: ConnectionModalStateApi['setMongoMembers'];
  setUriFeedback: ConnectionModalStateApi['setUriFeedback'];
  setCustomIconType: ConnectionModalStateApi['setCustomIconType'];
  setCustomIconColor: ConnectionModalStateApi['setCustomIconColor'];
  clearSecretsRef: ConnectionModalStateApi['clearSecretsRef'];
  setClearSecrets: ConnectionModalStateApi['setClearSecrets'];
  setTypeSelectWarning: ConnectionModalStateApi['setTypeSelectWarning'];
  setDriverStatusLoaded: ConnectionModalStateApi['setDriverStatusLoaded'];
  refreshDriverStatus: ConnectionModalDriverStatusApi['refreshDriverStatus'];
  setStep: ConnectionModalStateApi['setStep'];
  form: ConnectionModalStateApi['form'];
  setPrimaryPasswordVisible: ConnectionModalStateApi['setPrimaryPasswordVisible'];
  setUseSSL: ConnectionModalStateApi['setUseSSL'];
  setUseSSH: ConnectionModalStateApi['setUseSSH'];
  setUseProxy: ConnectionModalStateApi['setUseProxy'];
  setUseHttpTunnel: ConnectionModalStateApi['setUseHttpTunnel'];
  setDbType: ConnectionModalStateApi['setDbType'];
  setActiveNetworkConfig: ConnectionModalStateApi['setActiveNetworkConfig'];
  setActiveConfigSection: ConnectionModalStateApi['setActiveConfigSection'];
  setActiveGroup: ConnectionModalStateApi['setActiveGroup'];
  setDbTypeQuery: ConnectionModalStateApi['setDbTypeQuery'];
  primaryPasswordRevealRequestRef: ConnectionModalStateApi['primaryPasswordRevealRequestRef'];
  revealedPrimaryPasswordRef: ConnectionModalStateApi['revealedPrimaryPasswordRef'];
}

export const useConnectionModalFormSync = ({
  open,
  initialValues,
  cancelActiveConnectionTest,
  testRunIdRef,
  oracleModeTouchedRef,
  setSaving,
  setTestingConnection,
  testInFlightRef,
  testTimerRef,
  setTestResult,
  setTestErrorLogOpen,
  setSSHConnectionProgress,
  setSSHProgressPanelOpen,
  setSSHHostKeyTrust,
  setTrustingSSHHostKey,
  setDbList,
  setRedisDbList,
  setMongoMembers,
  setUriFeedback,
  setCustomIconType,
  setCustomIconColor,
  clearSecretsRef,
  setClearSecrets,
  setTypeSelectWarning,
  setDriverStatusLoaded,
  refreshDriverStatus,
  setStep,
  form,
  setPrimaryPasswordVisible,
  setUseSSL,
  setUseSSH,
  setUseProxy,
  setUseHttpTunnel,
  setDbType,
  setActiveNetworkConfig,
  setActiveConfigSection,
  setActiveGroup,
  setDbTypeQuery,
  primaryPasswordRevealRequestRef,
  revealedPrimaryPasswordRef,
}: UseConnectionModalFormSyncInput) => {
  useEffect(() => {
    cancelActiveConnectionTest();
    testRunIdRef.current += 1;
    if (open) {
      oracleModeTouchedRef.current = false;
      setSaving(false);
      setTestingConnection(false);
      testInFlightRef.current = false;
      if (testTimerRef.current !== null) {
        window.clearTimeout(testTimerRef.current);
        testTimerRef.current = null;
      }
      setTestResult(null); // Reset test result
      setTestErrorLogOpen(false);
      setSSHConnectionProgress(null);
      setSSHProgressPanelOpen(false);
      setSSHHostKeyTrust(null);
      setTrustingSSHHostKey(false);
      setDbList([]);
      setRedisDbList([]);
      setMongoMembers([]);
      setUriFeedback(null);
      setCustomIconType(undefined);
      setCustomIconColor(undefined);
      const emptyClearSecrets = createEmptyConnectionSecretClearState();
      clearSecretsRef.current = emptyClearSecrets;
      setClearSecrets(emptyClearSecrets);
      setTypeSelectWarning(null);
      setDriverStatusLoaded(false);
      void refreshDriverStatus();
      if (initialValues) {
        // Edit mode: Go directly to step 2
        setStep(2);
        const config: any = initialValues.config || {};
        const configType = String(config.type || "mysql");
        const isJvmConfigType = configType === "jvm";
        const defaultPort = getDefaultPortByType(configType);
        const isFileDbConfigType = isFileDatabaseType(configType);
        const jvmDefaultValues = buildDefaultJVMConnectionValues();
        const savedPrimaryAddress = isFileDbConfigType
          ? ""
          : toAddress(
              config.host || "localhost",
              Number(config.port || defaultPort),
              defaultPort,
            );
        const normalizedHosts = isFileDbConfigType
          ? []
          : normalizeAddressList(
              [
                savedPrimaryAddress,
                ...(Array.isArray(config.hosts) ? config.hosts : []),
              ],
              defaultPort,
            );
        const primaryAddress = isFileDbConfigType
          ? null
          : parseHostPort(
              normalizedHosts[0] ||
                savedPrimaryAddress,
              defaultPort,
            );
        const primaryHost = isFileDbConfigType
          ? normalizeFileDbPath(String(config.host || ""))
          : primaryAddress?.host || String(config.host || "localhost");
        const primaryPort = isFileDbConfigType
          ? 0
          : primaryAddress?.port || Number(config.port || defaultPort);
        const mysqlReplicaHosts =
          configType === "mysql" ||
          configType === "goldendb" ||
          configType === "mariadb" ||
          configType === "oceanbase" ||
          configType === "diros" ||
          configType === "starrocks" ||
          configType === "sphinx"
            ? normalizedHosts.slice(1)
            : [];
        const rocketmqHosts =
          configType === "rocketmq" ? normalizedHosts.slice(1) : [];
        const mqttHosts =
          configType === "mqtt" ? normalizedHosts.slice(1) : [];
        const kafkaHosts =
          configType === "kafka" ? normalizedHosts.slice(1) : [];
        const mongoHosts =
          configType === "mongodb" ? normalizedHosts.slice(1) : [];
        const redisHosts =
          configType === "redis" ? normalizedHosts.slice(1) : [];
        const mysqlIsReplica =
          String(config.topology || "").toLowerCase() === "replica" ||
          mysqlReplicaHosts.length > 0;
        const rocketmqIsCluster =
          String(config.topology || "").toLowerCase() === "cluster" ||
          rocketmqHosts.length > 0;
        const mqttIsCluster =
          String(config.topology || "").toLowerCase() === "cluster" ||
          mqttHosts.length > 0;
        const kafkaIsCluster =
          String(config.topology || "").toLowerCase() === "cluster" ||
          kafkaHosts.length > 0;
        const mongoIsReplica =
          String(config.topology || "").toLowerCase() === "replica" ||
          mongoHosts.length > 0 ||
          !!config.replicaSet;
        const redisTopologyValue = String(config.topology || "").toLowerCase();
        const redisIsSentinel = redisTopologyValue === "sentinel";
        const redisIsCluster =
          !redisIsSentinel &&
          (redisTopologyValue === "cluster" || redisHosts.length > 0);
        const {
          allowedModes: resolvedJvmAllowedModes,
          preferredMode: resolvedJvmPreferredMode,
        } = resolveEditableJVMModeSelection({
          allowedModes: config.jvm?.allowedModes,
          preferredMode: config.jvm?.preferredMode,
        });
        const resolvedJvmTimeout = isJvmConfigType
          ? Number(config.jvm?.endpoint?.timeoutSeconds || config.timeout || 30)
          : Number(config.timeout || 30);
        const hasHttpTunnel = !!config.useHttpTunnel;
        const hasProxy = !hasHttpTunnel && !!config.useProxy;
        const protection = resolveConnectionProtectionConfig(config);
        const parsedInitialUri = config.uri
          ? parseUriToValues(config.uri, configType)
          : null;
        const hasStoredConnectionParams =
          String(config.connectionParams || "").trim() !== "";
        const initialConnectionParams =
          (hasStoredConnectionParams ? config.connectionParams : "") ||
          parsedInitialUri?.connectionParams ||
          "";
        // 与后端保持相同的合并顺序：URI 参数先加载，ConnectionParams 后覆盖。
        const oracleTarget =
          configType === "oracle"
            ? resolveOracleConnectionTarget(
                parsedInitialUri?.connectionParams,
                config.connectionParams,
              )
            : null;
        const nacosConnectionScope =
          configType === "nacos"
            ? extractNacosConnectionScope(initialConnectionParams)
            : null;
        const initialNacosNamespaceId =
          configType === "nacos" && !hasStoredConnectionParams
            ? String(
                parsedInitialUri?.nacosNamespaceId ||
                  nacosConnectionScope?.scope.namespaceId ||
                  "",
              ).trim()
            : nacosConnectionScope?.scope.namespaceId || "";
        form.setFieldsValue({
          type: configType,
          name: initialValues.name,
          environmentType: normalizeConnectionEnvironmentType(
            initialValues.environmentType,
          ),
          host: primaryHost,
          port: primaryPort,
          user: config.user,
          password: config.password,
          database:
            oracleTarget?.mode === "sid"
              ? oracleTarget.sid
              : config.database,
          oracleMode: oracleTarget?.mode || "service",
          restrictDataEdit: protection.restrictDataEdit === true,
          restrictStructureEdit: protection.restrictStructureEdit === true,
          restrictScriptExecution:
            protection.restrictScriptExecution === true,
          restrictDataImport: protection.restrictDataImport === true,
          uri: config.uri || "",
          connectionParams:
            nacosConnectionScope?.connectionParams ?? initialConnectionParams,
          nacosNamespaceId: initialNacosNamespaceId,
          clickHouseProtocol:
            configType === "clickhouse"
              ? normalizeClickHouseProtocolValue(config.clickHouseProtocol)
              : "auto",
          oceanBaseProtocol:
            configType === "oceanbase"
              ? resolveOceanBaseProtocolForConfig(config)
              : "mysql",
          driverVariant: config.driverVariant,
          includeDatabases: initialValues.includeDatabases,
          includeDatabasePatterns: initialValues.includeDatabasePatterns,
          excludeDatabasePatterns: initialValues.excludeDatabasePatterns,
          includeRedisDatabases: initialValues.includeRedisDatabases,
          useSSL: !!config.useSSL,
          sslMode: config.sslMode || "preferred",
          sslCAPath: config.sslCAPath || "",
          sslCertPath: config.sslCertPath || "",
          sslKeyPath: config.sslKeyPath || "",
          useSSH: config.useSSH,
          sshHost: config.ssh?.host,
          sshPort: config.ssh?.port,
          sshUser: config.ssh?.user,
          sshPassword: config.ssh?.password,
          sshKeyPath: config.ssh?.keyPath,
          sshKnownHostsPath: config.ssh?.knownHostsPath,
          sshHostKeyFingerprint: config.ssh?.hostKeyFingerprint,
          useProxy: hasProxy,
          proxyType: config.proxy?.type || "socks5",
          proxyHost: config.proxy?.host,
          proxyPort: config.proxy?.port,
          proxyUser: config.proxy?.user,
          proxyPassword: config.proxy?.password,
          useHttpTunnel: hasHttpTunnel,
          httpTunnelHost: config.httpTunnel?.host,
          httpTunnelPort: config.httpTunnel?.port || 8080,
          httpTunnelUser: config.httpTunnel?.user,
          httpTunnelPassword: config.httpTunnel?.password,
          httpTunnelEncodeBase64:
            config.httpTunnel?.encodeBase64 !== false,
          driver: config.driver,
          dsn: config.dsn,
          timeout: resolvedJvmTimeout,
          keepAliveEnabled: !!config.keepAliveEnabled,
          keepAliveIntervalMinutes:
            Number(config.keepAliveIntervalMinutes) > 0
              ? Number(config.keepAliveIntervalMinutes)
              : DEFAULT_KEEPALIVE_INTERVAL_MINUTES,
          keepAliveSQL: config.keepAliveSQL || "",
          mysqlTopology: mysqlIsReplica ? "replica" : "single",
          mysqlReplicaHosts: mysqlReplicaHosts,
          rocketmqTopology: rocketmqIsCluster ? "cluster" : "single",
          rocketmqHosts: rocketmqHosts,
          mqttTopology: mqttIsCluster ? "cluster" : "single",
          mqttHosts: mqttHosts,
          kafkaTopology: kafkaIsCluster ? "cluster" : "single",
          kafkaHosts: kafkaHosts,
          mysqlReplicaUser: config.mysqlReplicaUser || "",
          mysqlReplicaPassword: config.mysqlReplicaPassword || "",
          mongoTopology: mongoIsReplica ? "replica" : "single",
          mongoHosts: mongoHosts,
          redisTopology: redisIsSentinel
            ? "sentinel"
            : redisIsCluster
              ? "cluster"
              : "single",
          redisHosts: redisHosts,
          redisSentinelMaster: config.redisSentinelMaster || "",
          redisSentinelUser: config.redisSentinelUser || "",
          redisSentinelPassword: config.redisSentinelPassword || "",
          mongoSrv: !!config.mongoSrv,
          mongoReplicaSet: config.replicaSet || "",
          mongoAuthSource: config.authSource || "",
          mongoReadPreference: config.readPreference || "primary",
          mongoAuthMechanism: config.mongoAuthMechanism || "",
          savePassword:
            config.savePassword !== false ||
            (config.type === "mongodb" &&
              initialValues.hasPrimaryPassword === true),
          redisDB: Number.isFinite(Number(config.redisDB))
            ? Number(config.redisDB)
            : 0,
          mongoReplicaUser: config.mongoReplicaUser || "",
          mongoReplicaPassword: config.mongoReplicaPassword || "",
          jvmReadOnly: isJvmConfigType
            ? (config.jvm?.readOnly ?? jvmDefaultValues.jvmReadOnly)
            : jvmDefaultValues.jvmReadOnly,
          jvmAllowedModes: isJvmConfigType
            ? resolvedJvmAllowedModes
            : jvmDefaultValues.jvmAllowedModes,
          jvmPreferredMode: isJvmConfigType
            ? resolvedJvmPreferredMode
            : jvmDefaultValues.jvmPreferredMode,
          jvmEnvironment: isJvmConfigType
            ? config.jvm?.environment || jvmDefaultValues.jvmEnvironment
            : jvmDefaultValues.jvmEnvironment,
          jvmEndpointEnabled: isJvmConfigType
            ? (config.jvm?.endpoint?.enabled ??
              resolvedJvmAllowedModes.includes("endpoint"))
            : jvmDefaultValues.jvmEndpointEnabled,
          jvmEndpointBaseUrl: isJvmConfigType
            ? config.jvm?.endpoint?.baseUrl || ""
            : jvmDefaultValues.jvmEndpointBaseUrl,
          jvmEndpointApiKey: isJvmConfigType
            ? config.jvm?.endpoint?.apiKey || ""
            : jvmDefaultValues.jvmEndpointApiKey,
          jvmAgentEnabled: isJvmConfigType
            ? (config.jvm?.agent?.enabled ??
              resolvedJvmAllowedModes.includes("agent"))
            : jvmDefaultValues.jvmAgentEnabled,
          jvmAgentBaseUrl: isJvmConfigType
            ? config.jvm?.agent?.baseUrl || ""
            : jvmDefaultValues.jvmAgentBaseUrl,
          jvmAgentApiKey: isJvmConfigType
            ? config.jvm?.agent?.apiKey || ""
            : jvmDefaultValues.jvmAgentApiKey,
          jvmDiagnosticEnabled: isJvmConfigType
            ? (config.jvm?.diagnostic?.enabled ??
              jvmDefaultValues.jvmDiagnosticEnabled)
            : jvmDefaultValues.jvmDiagnosticEnabled,
          jvmDiagnosticTransport: isJvmConfigType
            ? config.jvm?.diagnostic?.transport ||
              jvmDefaultValues.jvmDiagnosticTransport
            : jvmDefaultValues.jvmDiagnosticTransport,
          jvmDiagnosticBaseUrl: isJvmConfigType
            ? config.jvm?.diagnostic?.baseUrl || ""
            : jvmDefaultValues.jvmDiagnosticBaseUrl,
          jvmDiagnosticTargetId: isJvmConfigType
            ? config.jvm?.diagnostic?.targetId || ""
            : jvmDefaultValues.jvmDiagnosticTargetId,
          jvmDiagnosticApiKey: isJvmConfigType
            ? config.jvm?.diagnostic?.apiKey || ""
            : jvmDefaultValues.jvmDiagnosticApiKey,
          jvmDiagnosticAllowObserveCommands: isJvmConfigType
            ? (config.jvm?.diagnostic?.allowObserveCommands ??
              jvmDefaultValues.jvmDiagnosticAllowObserveCommands)
            : jvmDefaultValues.jvmDiagnosticAllowObserveCommands,
          jvmDiagnosticAllowTraceCommands: isJvmConfigType
            ? (config.jvm?.diagnostic?.allowTraceCommands ??
              jvmDefaultValues.jvmDiagnosticAllowTraceCommands)
            : jvmDefaultValues.jvmDiagnosticAllowTraceCommands,
          jvmDiagnosticAllowMutatingCommands: isJvmConfigType
            ? (config.jvm?.diagnostic?.allowMutatingCommands ??
              jvmDefaultValues.jvmDiagnosticAllowMutatingCommands)
            : jvmDefaultValues.jvmDiagnosticAllowMutatingCommands,
          jvmDiagnosticTimeoutSeconds: isJvmConfigType
            ? Number(
                config.jvm?.diagnostic?.timeoutSeconds ||
                  jvmDefaultValues.jvmDiagnosticTimeoutSeconds,
              )
            : jvmDefaultValues.jvmDiagnosticTimeoutSeconds,
          jvmEndpointTimeoutSeconds: resolvedJvmTimeout,
          jvmJmxHost:
            isJvmConfigType &&
            config.jvm?.jmx?.host &&
            config.jvm.jmx.host !== primaryHost
              ? config.jvm.jmx.host
              : "",
          jvmJmxPort:
            isJvmConfigType &&
            Number(config.jvm?.jmx?.port) > 0 &&
            Number(config.jvm.jmx.port) !== Number(primaryPort || defaultPort)
              ? Number(config.jvm.jmx.port)
              : undefined,
          jvmJmxUsername: isJvmConfigType
            ? config.jvm?.jmx?.username || ""
            : "",
          jvmJmxPassword: isJvmConfigType
            ? config.jvm?.jmx?.password || ""
            : "",
        });
        setPrimaryPasswordVisible(false);
        setUseSSL(!!config.useSSL);
        setCustomIconType(initialValues.iconType);
        setCustomIconColor(initialValues.iconColor);
        setUseSSH(config.useSSH || false);
        setUseProxy(hasProxy);
        setUseHttpTunnel(hasHttpTunnel);
        setDbType(configType);
        if (config.useSSL && supportsSSLForType(configType)) {
          setActiveNetworkConfig("ssl");
        } else if (config.useSSH) {
          setActiveNetworkConfig("ssh");
        } else if (hasProxy) {
          setActiveNetworkConfig("proxy");
        } else if (hasHttpTunnel) {
          setActiveNetworkConfig("httpTunnel");
        } else {
          setActiveNetworkConfig("ssl");
        }
        // 如果是 Redis 编辑模式，设置已保存的 Redis 数据库列表
        if (configType === "redis") {
          setRedisDbList(
            buildRedisDatabaseList(
              config.redisDB,
              initialValues.includeRedisDatabases,
            ),
          );
        }
      } else {
        // Create mode: Start at step 1
        setActiveConfigSection("basic");
        setStep(1);
        form.resetFields();
        form.setFieldValue(
          "environmentType",
          DEFAULT_CONNECTION_ENVIRONMENT,
        );
        setUseSSL(false);
        setUseSSH(false);
        setUseProxy(false);
        setUseHttpTunnel(false);
        setDbType("mysql");
        setActiveGroup(0);
        setDbTypeQuery("");
        setActiveConfigSection("basic");
        setActiveNetworkConfig("ssl");
        setPrimaryPasswordVisible(false);
      }
    }
  }, [open, initialValues, cancelActiveConnectionTest]);

  useEffect(() => {
    return () => {
      cancelActiveConnectionTest();
      testRunIdRef.current += 1;
      primaryPasswordRevealRequestRef.current += 1;
      revealedPrimaryPasswordRef.current = "";
      if (testTimerRef.current !== null) {
        window.clearTimeout(testTimerRef.current);
        testTimerRef.current = null;
      }
    };
  }, [cancelActiveConnectionTest]);
};

export type ConnectionModalFormSyncApi = ReturnType<typeof useConnectionModalFormSync>;
