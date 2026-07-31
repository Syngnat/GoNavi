import { describe, expect, it } from "vitest";

import { buildConnectionConfig } from "./connectionModalConfig";

const translate = (key: string) => key;

const buildBaseValues = () => ({
  type: "mysql",
  host: "db.local",
  port: 3306,
  user: "root",
  password: "",
  database: "",
  useSSL: false,
  useSSH: false,
  useProxy: false,
  useHttpTunnel: false,
  timeout: 30,
  keepAliveEnabled: false,
  keepAliveIntervalMinutes: 240,
  keepAliveSQL: "",
  savePassword: true,
  uri: "",
  connectionParams: "",
  sslMode: "preferred",
  sslCAPath: "",
  sslCertPath: "",
  sslKeyPath: "",
  sshHost: "",
  sshPort: 22,
  sshUser: "",
  sshPassword: "",
  sshKeyPath: "",
  proxyType: "socks5",
  proxyHost: "",
  proxyPort: 1080,
  proxyUser: "",
  proxyPassword: "",
  httpTunnelHost: "",
  httpTunnelPort: 8080,
  httpTunnelUser: "",
  httpTunnelPassword: "",
  mysqlTopology: "single",
  rocketmqTopology: "single",
  mqttTopology: "single",
  kafkaTopology: "single",
  redisTopology: "single",
  mongoTopology: "single",
  mongoSrv: false,
  mongoReadPreference: "primary",
  mongoAuthMechanism: "",
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
});

describe("connectionModalConfig keepalive", () => {
  it("keeps keepalive settings for network connections", async () => {
    const config = await buildConnectionConfig({
      values: {
        ...buildBaseValues(),
        keepAliveEnabled: true,
        keepAliveIntervalMinutes: 15,
        keepAliveSQL: "  SELECT 1  ",
      },
      forPersist: true,
      translate,
    });

    expect(config.keepAliveEnabled).toBe(true);
    expect(config.keepAliveIntervalMinutes).toBe(15);
    expect(config.keepAliveSQL).toBe("SELECT 1");
  });

  it("forces file database keepalive off", async () => {
    const config = await buildConnectionConfig({
      values: {
        ...buildBaseValues(),
        type: "sqlite",
        host: "D:/tmp/demo.db",
        port: 0,
        keepAliveEnabled: true,
        keepAliveIntervalMinutes: 15,
      },
      forPersist: true,
      translate,
    });

    expect(config.keepAliveEnabled).toBe(false);
    expect(config.keepAliveIntervalMinutes).toBe(15);
    expect(config.keepAliveSQL).toBe("");
  });

  it("keeps custom SQL while disabled and rejects unsafe SQL when enabled", async () => {
    const disabledConfig = await buildConnectionConfig({
      values: {
        ...buildBaseValues(),
        keepAliveEnabled: false,
        keepAliveSQL: "  SELECT 1  ",
      },
      forPersist: true,
      translate,
    });

    expect(disabledConfig.keepAliveSQL).toBe("SELECT 1");
    await expect(buildConnectionConfig({
      values: {
        ...buildBaseValues(),
        keepAliveEnabled: true,
        keepAliveSQL: "DELETE FROM accounts",
      },
      forPersist: true,
      translate,
    })).rejects.toThrow("connection.modal.network.keepAliveSQL.readOnly");
  });

  it("drops stale custom SQL for unsupported datasource types without blocking save", async () => {
    const config = await buildConnectionConfig({
      values: {
        ...buildBaseValues(),
        type: "redis",
        port: 6379,
        keepAliveEnabled: true,
        keepAliveSQL: "DELETE FROM accounts",
      },
      forPersist: true,
      translate,
    });

    expect(config.keepAliveEnabled).toBe(true);
    expect(config.keepAliveSQL).toBe("");
  });

  it("persists protection only for datasource types that support production guard", async () => {
    const protection = {
      restrictDataEdit: true,
      restrictStructureEdit: true,
      restrictScriptExecution: true,
      restrictDataImport: true,
    };
    const sqlConfig = await buildConnectionConfig({
      values: {
        ...buildBaseValues(),
        type: "postgres",
        ...protection,
      },
      forPersist: true,
      translate,
    });
    const redisConfig = await buildConnectionConfig({
      values: {
        ...buildBaseValues(),
        type: "redis",
        port: 6379,
        ...protection,
      },
      forPersist: true,
      translate,
    });
    const nacosConfig = await buildConnectionConfig({
      values: {
        ...buildBaseValues(),
        type: "nacos",
        port: 8848,
        ...protection,
      },
      forPersist: true,
      translate,
    });

    expect(sqlConfig.protection).toEqual(protection);
    expect(sqlConfig.readOnly).toBe(true);
    expect(redisConfig.protection).toBeUndefined();
    expect(redisConfig.readOnly).toBe(false);
    expect(nacosConfig.protection).toEqual({
      restrictDataEdit: true,
      restrictStructureEdit: true,
      restrictScriptExecution: false,
      restrictDataImport: true,
    });
    expect(nacosConfig.readOnly).toBe(false);
  });
});
