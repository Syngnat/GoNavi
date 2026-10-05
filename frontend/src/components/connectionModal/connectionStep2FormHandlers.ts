import type { FormProps } from "antd";
import { getPulsarPortAfterSSLChange } from "./connectionModalUri";
import {
  readKafkaSecurityProtocol,
  writeKafkaSecurityProtocol,
  readKafkaAuthMechanism,
} from "./ConnectionModalKafkaAuth";
import { normalizeEditableJVMModes } from "../../utils/jvmConnectionConfig";
import { supportsRedisSshTunnel } from "../../utils/redisTopologySsh";
import type { ConnectionStep2StateApi } from "./useConnectionStep2State";
import type { ConnectionModalStep2Props } from "./ConnectionModalStep2";

export interface CreateConnectionStep2FormHandlersInput {
  isPulsar: ConnectionModalStep2Props['isPulsar'];
  pulsarPortEditedRef: ConnectionStep2StateApi['pulsarPortEditedRef'];
  testResult: ConnectionModalStep2Props['testResult'];
  setTestResult: ConnectionModalStep2Props['setTestResult'];
  setTestErrorLogOpen: ConnectionModalStep2Props['setTestErrorLogOpen'];
  setUriFeedback: ConnectionModalStep2Props['setUriFeedback'];
  form: ConnectionModalStep2Props['form'];
  isKafka: ConnectionModalStep2Props['isKafka'];
  setUseSSL: ConnectionModalStep2Props['setUseSSL'];
  setActiveNetworkConfig: ConnectionModalStep2Props['setActiveNetworkConfig'];
  setUseSSH: ConnectionModalStep2Props['setUseSSH'];
  setUseProxy: ConnectionModalStep2Props['setUseProxy'];
  setUseHttpTunnel: ConnectionModalStep2Props['setUseHttpTunnel'];
  setDbType: ConnectionModalStep2Props['setDbType'];
  buildRedisDatabaseList: ConnectionModalStep2Props['buildRedisDatabaseList'];
  setRedisDbList: ConnectionModalStep2Props['setRedisDbList'];
  normalizeRedisDatabaseSelection: ConnectionModalStep2Props['normalizeRedisDatabaseSelection'];
  setMongoMembers: ConnectionModalStep2Props['setMongoMembers'];
}

export const createConnectionStep2FormHandlers = ({
  isPulsar,
  pulsarPortEditedRef,
  testResult,
  setTestResult,
  setTestErrorLogOpen,
  setUriFeedback,
  form,
  isKafka,
  setUseSSL,
  setActiveNetworkConfig,
  setUseSSH,
  setUseProxy,
  setUseHttpTunnel,
  setDbType,
  buildRedisDatabaseList,
  setRedisDbList,
  normalizeRedisDatabaseSelection,
  setMongoMembers,
}: CreateConnectionStep2FormHandlersInput) => {
  const handleStep2ValuesChange = (changed: Parameters<NonNullable<FormProps['onValuesChange']>>[0]) => {
    if (isPulsar && changed.port !== undefined) {
      pulsarPortEditedRef.current = true;
    }
    if (testResult) {
      setTestResult(null);
      setTestErrorLogOpen(false);
    }
    if (
      changed.uri !== undefined ||
      changed.connectionParams !== undefined ||
      changed.type !== undefined ||
      changed.oceanBaseProtocol !== undefined
    ) {
      setUriFeedback(null);
    }
    if (changed.useSSL !== undefined) {
      if (isPulsar) {
        const currentPort = Number(form.getFieldValue("port"));
        const nextPort = getPulsarPortAfterSSLChange(
          currentPort,
          !!changed.useSSL,
          pulsarPortEditedRef.current,
        );
        if (Number.isFinite(currentPort) && nextPort !== currentPort) {
          form.setFieldValue("port", nextPort);
        }
      }
      if (isKafka) {
        const params = form.getFieldValue("connectionParams");
        const uri = form.getFieldValue("uri");
        const sasl = readKafkaSecurityProtocol(uri, params).startsWith("SASL_");
        form.setFieldValue("connectionParams", writeKafkaSecurityProtocol(params, `${sasl ? "SASL_" : ""}${changed.useSSL ? "SSL" : "PLAINTEXT"}`, readKafkaAuthMechanism(uri, params)));
      }
      setUseSSL(changed.useSSL);
      if (changed.useSSL) setActiveNetworkConfig("ssl");
    }
    if (changed.useSSH !== undefined) {
      setUseSSH(changed.useSSH);
      if (changed.useSSH) setActiveNetworkConfig("ssh");
    }
    if (changed.useProxy !== undefined) {
      const enabledProxy = !!changed.useProxy;
      setUseProxy(enabledProxy);
      if (enabledProxy) setActiveNetworkConfig("proxy");
      if (enabledProxy && form.getFieldValue("useHttpTunnel")) {
        form.setFieldValue("useHttpTunnel", false);
        setUseHttpTunnel(false);
      }
    }
    if (changed.proxyType !== undefined) {
      const nextType = String(
        changed.proxyType || "socks5",
      ).toLowerCase();
      if (nextType === "http") {
        const currentPort = Number(form.getFieldValue("proxyPort") || 0);
        if (!currentPort || currentPort === 1080) {
          form.setFieldValue("proxyPort", 8080);
        }
      } else {
        const currentPort = Number(form.getFieldValue("proxyPort") || 0);
        if (!currentPort || currentPort === 8080) {
          form.setFieldValue("proxyPort", 1080);
        }
      }
    }
    if (changed.useHttpTunnel !== undefined) {
      const enabledHttpTunnel = !!changed.useHttpTunnel;
      setUseHttpTunnel(enabledHttpTunnel);
      if (enabledHttpTunnel) setActiveNetworkConfig("httpTunnel");
      if (enabledHttpTunnel && form.getFieldValue("useProxy")) {
        form.setFieldValue("useProxy", false);
        setUseProxy(false);
      }
    }
    if (changed.type !== undefined) setDbType(changed.type);
    if (changed.jvmAllowedModes !== undefined) {
      const resolvedModes = normalizeEditableJVMModes(
        changed.jvmAllowedModes,
      );
      const currentPreferredMode = String(
        form.getFieldValue("jvmPreferredMode") || "",
      )
        .trim()
        .toLowerCase();
      const resolvedPreferredMode =
        resolvedModes.find((mode) => mode === currentPreferredMode) ||
        resolvedModes[0];
      form.setFieldValue("jvmAllowedModes", resolvedModes);
      form.setFieldValue("jvmPreferredMode", resolvedPreferredMode);
      form.setFieldValue(
        "jvmEndpointEnabled",
        resolvedModes.includes("endpoint"),
      );
      form.setFieldValue(
        "jvmAgentEnabled",
        resolvedModes.includes("agent"),
      );
    }
    if (changed.redisTopology !== undefined) {
      const nextRedisTopology = String(
        changed.redisTopology || "single",
      ).toLowerCase();
      const currentRedisPort = Number(form.getFieldValue("port") || 0);
      if (
        nextRedisTopology === "sentinel" &&
        (!currentRedisPort || currentRedisPort === 6379)
      ) {
        form.setFieldValue("port", 26379);
      } else if (
        nextRedisTopology !== "sentinel" &&
        currentRedisPort === 26379
      ) {
        form.setFieldValue("port", 6379);
      }
      const supportedDbs = buildRedisDatabaseList(
        form.getFieldValue("redisDB"),
        form.getFieldValue("includeRedisDatabases"),
      );
      setRedisDbList(supportedDbs);
      form.setFieldValue(
        "includeRedisDatabases",
        normalizeRedisDatabaseSelection(
          form.getFieldValue("includeRedisDatabases"),
          supportedDbs,
        ),
      );
      // Cluster/Sentinel 与 SSH 组合后端不支持：切换拓扑时关闭 SSH 开关，
      // 已填写的隧道字段保留在表单中，切回单机拓扑可恢复。
      if (
        !supportsRedisSshTunnel(nextRedisTopology) &&
        form.getFieldValue("useSSH")
      ) {
        form.setFieldValue("useSSH", false);
      }
    }
    if (
      changed.type !== undefined ||
      changed.host !== undefined ||
      changed.port !== undefined ||
      changed.mongoHosts !== undefined ||
      changed.mongoTopology !== undefined ||
      changed.mongoSrv !== undefined
    ) {
      setMongoMembers([]);
    }
  };

  const step2InitialValues = {
    type: "mysql",
    host: "localhost",
    port: 3306,
    database: "",
    user: "root",
    useSSL: false,
    sslMode: "preferred",
    sslCAPath: "",
    sslCertPath: "",
    sslKeyPath: "",
    useSSH: false,
    sshPort: 22,
    sshKnownHostsPath: "",
    sshHostKeyFingerprint: "",
    useProxy: false,
    proxyType: "socks5",
    proxyPort: 1080,
    useHttpTunnel: false,
    httpTunnelPort: 8080,
    httpTunnelEncodeBase64: true,
    timeout: 30,
    keepAliveEnabled: false,
    keepAliveIntervalMinutes: 240,
    keepAliveSQL: "",
    uri: "",
    connectionParams: "",
    restrictDataEdit: false,
    restrictStructureEdit: false,
    restrictScriptExecution: false,
    restrictDataImport: false,
    oceanBaseProtocol: "mysql",
    oracleMode: "service",
    mysqlTopology: "single",
    rocketmqTopology: "single",
    mqttTopology: "single",
    kafkaTopology: "single",
    redisTopology: "single",
    mongoTopology: "single",
    mongoSrv: false,
    mongoReadPreference: "primary",
    mongoAuthMechanism: "",
    savePassword: true,
    connectAndExpandAfterSave: true,
    mysqlReplicaHosts: [],
    rocketmqHosts: [],
    mqttHosts: [],
    kafkaHosts: [],
    redisHosts: [],
    redisSentinelMaster: "",
    redisSentinelUser: "",
    redisSentinelPassword: "",
    mongoHosts: [],
    mysqlReplicaUser: "",
    mysqlReplicaPassword: "",
    mongoReplicaUser: "",
    mongoReplicaPassword: "",
    redisDB: 0,
    jvmReadOnly: true,
    jvmAllowedModes: ["jmx"],
    jvmPreferredMode: "jmx",
    jvmEnvironment: "dev",
    jvmEndpointEnabled: false,
    jvmEndpointBaseUrl: "",
    jvmEndpointApiKey: "",
    jvmAgentEnabled: false,
    jvmAgentBaseUrl: "",
    jvmAgentApiKey: "",
    jvmDiagnosticEnabled: false,
    jvmDiagnosticTransport: "agent-bridge",
    jvmDiagnosticBaseUrl: "",
    jvmDiagnosticTargetId: "",
    jvmDiagnosticApiKey: "",
    jvmDiagnosticAllowObserveCommands: true,
    jvmDiagnosticAllowTraceCommands: false,
    jvmDiagnosticAllowMutatingCommands: false,
    jvmDiagnosticTimeoutSeconds: 15,
    jvmEndpointTimeoutSeconds: 30,
    jvmJmxHost: "",
    jvmJmxPort: undefined,
    jvmJmxUsername: "",
    jvmJmxPassword: "",
  };
  return { handleStep2ValuesChange, step2InitialValues };
};

export type ConnectionStep2FormHandlersApi = ReturnType<typeof createConnectionStep2FormHandlers>;
