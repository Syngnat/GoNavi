import { describe, expect, it } from "vitest";

import { buildConnectionConfig } from "./connectionModalConfig";

const translate = (key: string) => key;

const buildNacosValues = (overrides: Record<string, unknown> = {}) => ({
  type: "nacos",
  host: "nacos.example.test",
  port: 8848,
  user: "",
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
  connectionParams: "contextPath=/nacos",
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
  ...overrides,
});

describe("connectionModalConfig Nacos scope", () => {
  it("persists the dedicated namespace field in connectionParams", async () => {
    const config = await buildConnectionConfig({
      values: buildNacosValues({
        nacosNamespaceId: " dev-team ",
        connectionParams: "contextPath=/registry&custom=value",
      }),
      forPersist: true,
      translate,
    });

    const params = new URLSearchParams(config.connectionParams);
    expect(params.get("contextPath")).toBe("/registry");
    expect(params.get("custom")).toBe("value");
    expect(params.get("namespaceId")).toBe("dev-team");
  });

  it("preserves an explicit public scope and removes a cleared scope", async () => {
    const publicConfig = await buildConnectionConfig({
      values: buildNacosValues({ nacosNamespaceId: "public" }),
      forPersist: true,
      translate,
    });
    expect(
      new URLSearchParams(publicConfig.connectionParams).get("namespaceId"),
    ).toBe("public");

    const clearedConfig = await buildConnectionConfig({
      values: buildNacosValues({
        nacosNamespaceId: "",
        connectionParams: "contextPath=/nacos&namespaceId=old-scope",
        uri: "http://nacos.example.test:8848/nacos?namespaceId=old-scope",
      }),
      nacosNamespaceIdTouched: true,
      forPersist: true,
      translate,
    });
    expect(
      new URLSearchParams(clearedConfig.connectionParams).has("namespaceId"),
    ).toBe(false);
  });

  it("persists the namespace and context path parsed from a Nacos URI", async () => {
    const config = await buildConnectionConfig({
      values: buildNacosValues({
        host: "",
        nacosNamespaceId: "",
        connectionParams: "",
        uri: "http://nacos.example.test:8848/registry?namespaceId=dev&custom=value",
      }),
      nacosNamespaceIdTouched: false,
      forPersist: true,
      translate,
    });

    const params = new URLSearchParams(config.connectionParams);
    expect(config.host).toBe("nacos.example.test");
    expect(params.get("contextPath")).toBe("/registry");
    expect(params.get("namespaceId")).toBe("dev");
    expect(params.get("custom")).toBe("value");
  });
});
