import { describe, expect, it } from "vitest";

import { buildConnectionConfig } from "./connectionModalConfig";

const translate = (key: string) => key;

const buildOracleValues = (overrides: Record<string, unknown> = {}) => ({
  type: "oracle",
  host: "db.example.test",
  port: 1521,
  user: "system",
  password: "secret",
  database: "ORCLPDB1",
  oracleMode: "service",
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
  restrictDataEdit: false,
  restrictStructureEdit: false,
  restrictScriptExecution: false,
  restrictDataImport: false,
  ...overrides,
});

describe("connectionModalConfig Oracle SID mode", () => {
  it("keeps service-name mode untouched (SID removed from params)", async () => {
    const config = await buildConnectionConfig({
      values: buildOracleValues({
        connectionParams: "DBA_PRIVILEGE=SYSDBA&SID=ORCL",
      }),
      forPersist: true,
      oracleModeTouched: true,
      translate,
    });

    expect(config.database).toBe("ORCLPDB1");
    const params = new URLSearchParams(config.connectionParams);
    expect(params.get("DBA_PRIVILEGE")).toBe("SYSDBA");
    expect(params.has("SID")).toBe(false);
  });

  it("writes the form SID value into connectionParams and clears database", async () => {
    const config = await buildConnectionConfig({
      values: buildOracleValues({
        oracleMode: "sid",
        database: "ORCL",
        connectionParams: "DBA_PRIVILEGE=SYSDBA",
      }),
      forPersist: true,
      translate,
    });

    expect(config.database).toBe("");
    const params = new URLSearchParams(config.connectionParams);
    expect(params.get("SID")).toBe("ORCL");
    expect(params.get("DBA_PRIVILEGE")).toBe("SYSDBA");
  });

  it("replaces a legacy SID param when switching to SID mode", async () => {
    const config = await buildConnectionConfig({
      values: buildOracleValues({
        oracleMode: "sid",
        database: "ORCL",
        connectionParams: "sid=OLDDB",
      }),
      forPersist: true,
      translate,
    });

    const params = new URLSearchParams(config.connectionParams);
    expect(params.get("SID")).toBe("ORCL");
    expect(config.database).toBe("");
  });

  it("clears a SID param when switching back to service-name mode", async () => {
    const config = await buildConnectionConfig({
      values: buildOracleValues({
        oracleMode: "service",
        database: "ORCLPDB1",
        connectionParams: "SID=ORCL",
      }),
      forPersist: true,
      oracleModeTouched: true,
      translate,
    });

    expect(config.database).toBe("ORCLPDB1");
    expect(new URLSearchParams(config.connectionParams).has("SID")).toBe(false);
  });

  it("strips a SID param from the URI when switching back to service-name mode", async () => {
    const config = await buildConnectionConfig({
      values: buildOracleValues({
        oracleMode: "service",
        database: "ORCLPDB1",
        uri: "oracle://system:secret@db.example.test:1521/?SID=ORCL&DBA_PRIVILEGE=SYSDBA",
      }),
      forPersist: true,
      oracleModeTouched: true,
      translate,
    });

    expect(config.database).toBe("ORCLPDB1");
    expect(config.uri).toBe(
      "oracle://system:secret@db.example.test:1521/?DBA_PRIVILEGE=SYSDBA",
    );
  });

  it("rejects an empty SID value", async () => {
    await expect(
      buildConnectionConfig({
        values: buildOracleValues({ oracleMode: "sid", database: "" }),
        forPersist: true,
        translate,
      }),
    ).rejects.toThrow("connection.modal.field.sid.required");
  });

  it("infers SID mode when a SID URI is saved without parsing first", async () => {
    const config = await buildConnectionConfig({
      values: buildOracleValues({
        database: "STALE_SERVICE",
        connectionParams: "DBA_PRIVILEGE=SYSDBA",
        uri: "oracle://system:secret@db.example.test:1521?SID=ORCL",
      }),
      forPersist: true,
      translate,
    });

    expect(config.database).toBe("");
    expect(new URLSearchParams(config.connectionParams).get("SID")).toBe("ORCL");
    expect(new URLSearchParams(config.connectionParams).get("DBA_PRIVILEGE")).toBe(
      "SYSDBA",
    );
  });

  it("keeps an explicitly selected service name when the URI contains SID", async () => {
    const config = await buildConnectionConfig({
      values: buildOracleValues({
        database: "ORCLPDB1",
        uri: "oracle://system:secret@db.example.test:1521?SID=ORCL",
      }),
      forPersist: true,
      oracleModeTouched: true,
      translate,
    });

    expect(config.database).toBe("ORCLPDB1");
    expect(config.uri).toBe(
      "oracle://system:secret@db.example.test:1521",
    );
    expect(new URLSearchParams(config.connectionParams).has("SID")).toBe(false);
  });

  it("requires a service name when an explicit service choice conflicts with a SID URI", async () => {
    await expect(
      buildConnectionConfig({
        values: buildOracleValues({
          database: "",
          uri: "oracle://system:secret@db.example.test:1521?SID=ORCL",
        }),
        forPersist: true,
        oracleModeTouched: true,
        translate,
      }),
    ).rejects.toThrow("connection.modal.field.serviceName.required");
  });

  it("lets an explicit empty SID param override a SID from the URI", async () => {
    const config = await buildConnectionConfig({
      values: buildOracleValues({
        database: "ORCLPDB1",
        connectionParams: "SID=&DBA_PRIVILEGE=SYSDBA",
        uri: "oracle://system:secret@db.example.test:1521?SID=FROM_URI",
      }),
      forPersist: true,
      translate,
    });

    expect(config.database).toBe("ORCLPDB1");
    expect(config.uri).toBe(
      "oracle://system:secret@db.example.test:1521",
    );
    expect(new URLSearchParams(config.connectionParams).has("SID")).toBe(false);
  });

  it("does not reinterpret an overridden URI SID as a service name", async () => {
    await expect(
      buildConnectionConfig({
        values: buildOracleValues({
          database: "",
          connectionParams: "SID=",
          uri: "oracle://system:secret@db.example.test:1521?SID=FROM_URI",
        }),
        forPersist: true,
        translate,
      }),
    ).rejects.toThrow("connection.modal.field.serviceName.required");
  });

  it("does not reinterpret a service-name URI path as SID", async () => {
    await expect(
      buildConnectionConfig({
        values: buildOracleValues({
          oracleMode: "sid",
          database: "",
          uri: "oracle://system:secret@db.example.test:1521/ORCLPDB1",
        }),
        forPersist: true,
        translate,
      }),
    ).rejects.toThrow("connection.modal.field.sid.required");
  });

  it("does not replace an edited SID value with the stored connection param", async () => {
    const config = await buildConnectionConfig({
      values: buildOracleValues({
        oracleMode: "sid",
        database: "NEW_SID",
        connectionParams: "SID=OLD_SID",
      }),
      forPersist: true,
      translate,
    });

    expect(new URLSearchParams(config.connectionParams).get("SID")).toBe(
      "NEW_SID",
    );
  });
});
