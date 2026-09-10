import { describe, expect, it } from "vitest";

import { buildConnectionConfig } from "./connectionModalConfig";

const translate = (key: string) => key;

const buildBaseValues = () => ({
  type: "mysql",
  host: "db.internal",
  port: 3306,
  user: "root",
  password: "",
  database: "app",
  useSSL: false,
  useSSH: false,
  useProxy: false,
  useHttpTunnel: true,
  httpTunnelHost: "https://gateway.example.com/mysql/ntunnel_mysql.php",
  httpTunnelUser: "web-user",
  httpTunnelPassword: "web-secret",
  httpTunnelEncodeBase64: true,
  timeout: 30,
  savePassword: true,
  connectionParams: "",
  mysqlTopology: "single",
  mysqlReplicaHosts: [],
});

describe("connectionModalConfig Navicat HTTP tunnel", () => {
  it("keeps the complete tunnel URL and base64 option without requiring a form port", async () => {
    const config = await buildConnectionConfig({
      values: buildBaseValues(),
      forPersist: true,
      translate,
    });

    expect(config.useHttpTunnel).toBe(true);
    expect(config.httpTunnel).toEqual({
      host: "https://gateway.example.com/mysql/ntunnel_mysql.php",
      port: 8080,
      user: "web-user",
      password: "web-secret",
      encodeBase64: true,
    });
  });

  it("preserves an explicit false base64 option and a legacy CONNECT port", async () => {
    const config = await buildConnectionConfig({
      values: {
        ...buildBaseValues(),
        httpTunnelHost: "legacy-proxy.internal",
        httpTunnelPort: 3128,
        httpTunnelEncodeBase64: false,
      },
      forPersist: true,
      translate,
    });

    expect(config.httpTunnel).toMatchObject({
      host: "legacy-proxy.internal",
      port: 3128,
      encodeBase64: false,
    });
  });

  it("defaults base64 encoding on when restoring values without the new field", async () => {
    const config = await buildConnectionConfig({
      values: {
        ...buildBaseValues(),
        httpTunnelEncodeBase64: undefined,
      },
      forPersist: true,
      translate,
    });

    expect(config.httpTunnel?.encodeBase64).toBe(true);
  });
});
