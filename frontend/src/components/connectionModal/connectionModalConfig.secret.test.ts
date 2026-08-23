import { describe, expect, it } from "vitest";

import type { ConnectionConfig, SavedConnection } from "../../types";
import {
  buildSavedConnectionInput,
  createEmptyConnectionSecretClearState,
} from "./connectionModalConfig";

const createConfig = (overrides: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: "conn-password",
  type: "mysql",
  host: "db.local",
  port: 3306,
  user: "root",
  password: "",
  ...overrides,
});

const createSavedConnection = (config: ConnectionConfig): SavedConnection => ({
  id: "conn-password",
  name: "Saved host",
  environmentType: "local",
  config,
  hasPrimaryPassword: true,
});

const createValues = (overrides: Record<string, unknown> = {}) => ({
  type: "mysql",
  name: "Saved host",
  environmentType: "local",
  ...overrides,
});

describe("connection modal primary password persistence", () => {
  it("keeps a stored password when an edited connection leaves the field blank", () => {
    const config = createConfig();
    const result = buildSavedConnectionInput({
      config,
      values: createValues(),
      initialValues: createSavedConnection(config),
      clearSecrets: createEmptyConnectionSecretClearState(),
    });

    expect(result.config.password).toBe("");
    expect(result.clearPrimaryPassword).toBe(false);
  });

  it("replaces a stored password when a new value is entered", () => {
    const config = createConfig({ password: "replacement-secret" });
    const result = buildSavedConnectionInput({
      config,
      values: createValues(),
      initialValues: createSavedConnection(createConfig()),
      clearSecrets: createEmptyConnectionSecretClearState(),
    });

    expect(result.config.password).toBe("replacement-secret");
    expect(result.clearPrimaryPassword).toBe(false);
  });

  it("clears a stored password only when clearing is explicitly requested", () => {
    const config = createConfig();
    const clearSecrets = createEmptyConnectionSecretClearState();
    clearSecrets.primaryPassword = true;

    const result = buildSavedConnectionInput({
      config,
      values: createValues(),
      initialValues: createSavedConnection(config),
      clearSecrets,
    });

    expect(result.config.password).toBe("");
    expect(result.clearPrimaryPassword).toBe(true);
  });

  it("clears a MongoDB password when save password is disabled", () => {
    const config = createConfig({ type: "mongodb" });
    const result = buildSavedConnectionInput({
      config,
      values: createValues({ type: "mongodb", savePassword: false }),
      initialValues: createSavedConnection(config),
      clearSecrets: createEmptyConnectionSecretClearState(),
    });

    expect(result.config.password).toBe("");
    expect(result.clearPrimaryPassword).toBe(true);
  });

});
