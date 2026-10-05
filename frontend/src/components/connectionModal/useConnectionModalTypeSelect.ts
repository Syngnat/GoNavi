import { normalizeDriverType } from "../../utils/connectionDriverType";
import { t } from "../../i18n";
import { getConnectionTypeDefaultPort as getDefaultPortByType } from "../../utils/connectionTypeCatalog";
import { buildDefaultJVMConnectionValues } from "../../utils/jvmConnectionConfig";
import { getDataSourceSpec } from "../../utils/dataSourceRegistry";
import { DEFAULT_KEEPALIVE_INTERVAL_MINUTES } from "./connectionModalHelpers";
import {
  isFileDatabaseType,
  PRIMARY_USERNAME_OPTIONAL_TYPES,
  supportsSSLForType,
} from "../../utils/connectionTypeCapabilities";
import type { ConnectionModalStateApi } from "./useConnectionModalState";
import type { ConnectionModalDriverStatusApi } from "./useConnectionModalDriverStatus";

export interface UseConnectionModalTypeSelectInput {
  driverStatusMap: ConnectionModalStateApi['driverStatusMap'];
  setTypeSelectWarning: ConnectionModalStateApi['setTypeSelectWarning'];
  setDbType: ConnectionModalStateApi['setDbType'];
  form: ConnectionModalStateApi['form'];
  setUseSSL: ConnectionModalStateApi['setUseSSL'];
  setUseSSH: ConnectionModalStateApi['setUseSSH'];
  setUseProxy: ConnectionModalStateApi['setUseProxy'];
  setUseHttpTunnel: ConnectionModalStateApi['setUseHttpTunnel'];
  setMongoMembers: ConnectionModalStateApi['setMongoMembers'];
  setActiveConfigSection: ConnectionModalStateApi['setActiveConfigSection'];
  setStep: ConnectionModalStateApi['setStep'];
  driverStatusLoaded: ConnectionModalStateApi['driverStatusLoaded'];
  refreshDriverStatus: ConnectionModalDriverStatusApi['refreshDriverStatus'];
}

export const useConnectionModalTypeSelect = ({
  driverStatusMap,
  setTypeSelectWarning,
  setDbType,
  form,
  setUseSSL,
  setUseSSH,
  setUseProxy,
  setUseHttpTunnel,
  setMongoMembers,
  setActiveConfigSection,
  setStep,
  driverStatusLoaded,
  refreshDriverStatus,
}: UseConnectionModalTypeSelectInput) => {
  const handleTypeSelect = (type: string) => {
    const normalized = normalizeDriverType(type);
    const snapshot = driverStatusMap[normalized];
    if (snapshot && !snapshot.connectable) {
      const driverName = snapshot.name || type;
      const reason =
        snapshot.message ||
        t("connection.modal.driver.unavailableFallback", {
          name: driverName,
        });
      setTypeSelectWarning({ driverName, reason });
      return;
    }
    setTypeSelectWarning(null);
    setDbType(type);
    form.setFieldsValue({
      type: type,
      clickHouseProtocol: type === "clickhouse" ? "auto" : undefined,
      oceanBaseProtocol: type === "oceanbase" ? "mysql" : undefined,
    });

    const defaultPort = getDefaultPortByType(type);
    if (type === "jvm") {
      const jvmDefaultValues = buildDefaultJVMConnectionValues();
      setUseSSL(false);
      setUseSSH(false);
      setUseProxy(false);
      setUseHttpTunnel(false);
      form.setFieldsValue({
        ...jvmDefaultValues,
        user: "",
        password: "",
        database: "",
        useSSL: false,
        sslMode: undefined,
        sslCAPath: undefined,
        sslCertPath: undefined,
        sslKeyPath: undefined,
        useSSH: false,
        sshHost: "",
        sshPort: 22,
        sshUser: "",
        sshPassword: "",
        sshKeyPath: "",
        sshKnownHostsPath: "",
        sshHostKeyFingerprint: "",
        useProxy: false,
        proxyType: "socks5",
        proxyHost: "",
        proxyPort: 1080,
        proxyUser: "",
        proxyPassword: "",
        useHttpTunnel: false,
        httpTunnelHost: "",
        httpTunnelPort: 8080,
        httpTunnelUser: "",
        httpTunnelPassword: "",
        httpTunnelEncodeBase64: true,
        timeout: 30,
        keepAliveEnabled: false,
        keepAliveIntervalMinutes: DEFAULT_KEEPALIVE_INTERVAL_MINUTES,
        keepAliveSQL: "",
        uri: "",
        connectionParams: "",
        includeDatabases: undefined,
        includeDatabasePatterns: undefined,
        excludeDatabasePatterns: undefined,
        includeRedisDatabases: undefined,
        mysqlTopology: "single",
        rocketmqTopology: "single",
        mqttTopology: "single",
        kafkaTopology: "single",
        redisTopology: "single",
        mongoTopology: "single",
        mongoSrv: false,
        mongoReadPreference: "primary",
        mongoReplicaSet: "",
        mongoAuthSource: "",
        mongoAuthMechanism: "",
        savePassword: true,
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
        jvmEndpointTimeoutSeconds: 30,
        jvmJmxHost: "",
        jvmJmxPort: undefined,
        jvmJmxUsername: "",
        jvmJmxPassword: "",
        jvmAgentEnabled: false,
        jvmAgentBaseUrl: "",
        jvmAgentApiKey: "",
      });
    } else if (isFileDatabaseType(type)) {
      setUseSSL(false);
      setUseSSH(false);
      setUseProxy(false);
      setUseHttpTunnel(false);
      form.setFieldsValue({
        host: "",
        port: 0,
        user: "",
        password: "",
        database: "",
        useSSL: false,
        sslMode: "preferred",
        sslCAPath: "",
        sslCertPath: "",
        sslKeyPath: "",
        useSSH: false,
        sshHost: "",
        sshPort: 22,
        sshUser: "",
        sshPassword: "",
        sshKeyPath: "",
        sshKnownHostsPath: "",
        sshHostKeyFingerprint: "",
        useProxy: false,
        proxyType: "socks5",
        proxyHost: "",
        proxyPort: 1080,
        proxyUser: "",
        proxyPassword: "",
        useHttpTunnel: false,
        httpTunnelHost: "",
        httpTunnelPort: 8080,
        httpTunnelUser: "",
        httpTunnelPassword: "",
        httpTunnelEncodeBase64: true,
        keepAliveEnabled: false,
        keepAliveIntervalMinutes: DEFAULT_KEEPALIVE_INTERVAL_MINUTES,
        keepAliveSQL: "",
        mysqlTopology: "single",
        rocketmqTopology: "single",
        mqttTopology: "single",
        kafkaTopology: "single",
        redisTopology: "single",
        mongoTopology: "single",
        mongoSrv: false,
        mongoReadPreference: "primary",
        mongoReplicaSet: "",
        mongoAuthSource: "",
        mongoAuthMechanism: "",
        savePassword: true,
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
        connectionParams: "",
      });
    } else if (type !== "custom") {
      const defaultUser =
        getDataSourceSpec(type)?.ui?.defaultUser ??
        (type === "clickhouse"
          ? "default"
          : PRIMARY_USERNAME_OPTIONAL_TYPES.has(type)
            ? ""
            : "root");
      const sslCapableType = supportsSSLForType(type);
      setUseSSL(false);
      setUseHttpTunnel(false);
      form.setFieldsValue({
        user: defaultUser,
        database: "",
        nacosNamespaceId: "",
        port: defaultPort,
        useSSL: sslCapableType ? false : undefined,
        sslMode: sslCapableType ? "preferred" : undefined,
        sslCAPath: sslCapableType ? "" : undefined,
        sslCertPath: sslCapableType ? "" : undefined,
        sslKeyPath: sslCapableType ? "" : undefined,
        useHttpTunnel: false,
        httpTunnelHost: "",
        httpTunnelPort: 8080,
        httpTunnelUser: "",
        httpTunnelPassword: "",
        httpTunnelEncodeBase64: true,
        keepAliveEnabled: false,
        keepAliveIntervalMinutes: DEFAULT_KEEPALIVE_INTERVAL_MINUTES,
        keepAliveSQL: "",
        mysqlTopology: "single",
        rocketmqTopology: "single",
        mqttTopology: "single",
        kafkaTopology: "single",
        redisTopology: "single",
        mongoTopology: "single",
        mongoSrv: false,
        mongoReadPreference: "primary",
        mongoReplicaSet: "",
        mongoAuthSource: "",
        mongoAuthMechanism: "",
        savePassword: true,
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
        connectionParams: "",
      });
    }

    setMongoMembers([]);
    setActiveConfigSection("basic");
    setStep(2);

    if (!driverStatusLoaded || !snapshot) {
      void refreshDriverStatus();
    }
  };
  return { handleTypeSelect };
};

export type ConnectionModalTypeSelectApi = ReturnType<typeof useConnectionModalTypeSelect>;
