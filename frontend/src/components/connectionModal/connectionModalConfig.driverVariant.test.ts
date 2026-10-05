import { describe, expect, it } from "vitest";

import { buildConnectionConfig } from "./connectionModalConfig";
import { buildRpcConnectionConfig } from "../../utils/connectionRpcConfig";

const translate = (key: string) => key;

const baseValues = (type: string, extra: Record<string, unknown> = {}) => ({
  type,
  host: "db.internal",
  port: 4000,
  user: "root",
  password: "",
  database: "app",
  useSSL: false,
  useSSH: false,
  useProxy: false,
  useHttpTunnel: false,
  timeout: 30,
  savePassword: true,
  connectionParams: "",
  mysqlTopology: "single",
  mysqlReplicaHosts: [],
  ...extra,
});

describe("connection driver variant", () => {
  it("keeps the selected variant for registry types and through the RPC payload", async () => {
    const config = await buildConnectionConfig({
      values: baseValues("tidb", { driverVariant: "v6" }),
      forPersist: true,
      translate,
    });
    expect(config.driverVariant).toBe("v6");
    expect(buildRpcConnectionConfig(config).driverVariant).toBe("v6");
  });

  it("falls back to the declared default for missing or stale values", async () => {
    const missing = await buildConnectionConfig({ values: baseValues("tidb"), forPersist: true, translate });
    expect(missing.driverVariant).toBe("auto");
    const stale = await buildConnectionConfig({
      values: baseValues("tidb", { driverVariant: "v42" }),
      forPersist: true,
      translate,
    });
    expect(stale.driverVariant).toBe("auto");
  });

  it("never sends a variant for legacy types", async () => {
    const config = await buildConnectionConfig({
      values: baseValues("mysql", { port: 3306, driverVariant: "v6" }),
      forPersist: true,
      translate,
    });
    expect(config.driverVariant).toBeUndefined();
  });
});
