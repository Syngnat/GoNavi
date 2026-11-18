import { describe, expect, it } from "vitest";

import { sanitizeSavedConnection } from "./storeConnectionConfig";

const save = (config: Record<string, unknown>, hasOpaqueURI: boolean) =>
  sanitizeSavedConnection(
    {
      id: "uri-only",
      name: "URI only",
      hasOpaqueURI,
      config,
    },
    0,
  );

describe("saved connection URI host normalization", () => {
  it("keeps an empty host for a URI-only saved connection", () => {
    const connection = save({ type: "mysql", host: "", port: 0 }, true);

    expect(connection?.config.host).toBe("");
  });

  it("keeps an explicit host even when a stored URI also exists", () => {
    const connection = save(
      { type: "mysql", host: "nginx.local", port: 13306 },
      true,
    );

    expect(connection?.config.host).toBe("nginx.local");
  });
});
