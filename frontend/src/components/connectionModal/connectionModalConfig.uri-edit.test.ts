import { describe, expect, it } from "vitest";

import { buildConnectionConfig } from "./connectionModalConfig";

const translate = (key: string) => key;

const baseValues = () => ({
  type: "mysql",
  host: "old.local",
  port: 3306,
  user: "old-user",
  password: "old-password",
  database: "old-db",
  uri: "mysql://new-user:new-password@new.local:13306/new-db",
  timeout: 30,
  useSSL: false,
  useSSH: false,
  useProxy: false,
  useHttpTunnel: false,
  savePassword: true,
  connectionParams: "",
  mysqlTopology: "single",
  mysqlReplicaHosts: [],
});

describe("connectionModalConfig URI edit precedence", () => {
  it("applies the edited URI over stale host fields when the URI field was touched", async () => {
    const config = await buildConnectionConfig({
      values: baseValues(),
      forPersist: true,
      uriTouched: true,
      translate,
    });

    expect(config).toMatchObject({
      host: "new.local",
      port: 13306,
      user: "new-user",
      password: "new-password",
      database: "new-db",
      uri: "mysql://new-user:new-password@new.local:13306/new-db",
    });
  });

  it("keeps explicit host fields when the URI was not touched", async () => {
    const config = await buildConnectionConfig({
      values: baseValues(),
      forPersist: true,
      translate,
    });

    expect(config).toMatchObject({
      host: "old.local",
      port: 3306,
      user: "old-user",
      database: "old-db",
    });
  });
});
