import { describe, expect, it } from "vitest";

import { buildConnectionConfig } from "./connectionModalConfig";
import { toAddress } from "./connectionModalUri";

const translate = (key: string) => key;

const buildMQTTConfig = (host: string) =>
  buildConnectionConfig({
    values: {
      type: "mqtt",
      host,
      port: 1883,
      user: "",
      password: "",
      database: "",
      uri: "",
      connectionParams: "",
      mqttTopology: "single",
      mqttHosts: [],
      useSSL: false,
      useSSH: false,
      useProxy: false,
      useHttpTunnel: false,
      timeout: 30,
      savePassword: true,
    },
    forPersist: false,
    translate,
  });

describe("connectionModalConfig MQTT endpoint normalization", () => {
  it("keeps save, reopen, and test cycles idempotent", async () => {
    let formHost = "tcp://beebox.hmao.cn:1883:1883:1883:1883:1883";

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const config = await buildMQTTConfig(formHost);
      expect(config.host).toBe("beebox.hmao.cn");
      expect(config.port).toBe(1883);
      formHost = toAddress(config.host, config.port, 1883);
    }
  });
});
