import { describe, expect, it } from "vitest";

import {
  extractNacosConnectionScope,
  resolveNacosConnectionScope,
  setNacosConnectionScope,
} from "./nacosConnectionScope";

describe("nacosConnectionScope", () => {
  it("keeps an explicitly configured public namespace distinct from no scope", () => {
    expect(resolveNacosConnectionScope("contextPath=/nacos")).toEqual({
      configured: false,
      namespaceId: "",
      requestNamespaceId: "",
    });
    expect(
      resolveNacosConnectionScope(
        "contextPath=%2Fnacos&namespaceId=public",
      ),
    ).toEqual({
      configured: true,
      namespaceId: "public",
      requestNamespaceId: "",
    });
  });

  it("sets and clears a namespace without dropping other Nacos parameters", () => {
    const scoped = setNacosConnectionScope(
      "contextPath=/registry&custom=value",
      "  team/dev  ",
    );

    expect(new URLSearchParams(scoped).get("contextPath")).toBe("/registry");
    expect(new URLSearchParams(scoped).get("custom")).toBe("value");
    expect(new URLSearchParams(scoped).get("namespaceId")).toBe("team/dev");

    const cleared = setNacosConnectionScope(scoped, "");
    expect(new URLSearchParams(cleared).get("contextPath")).toBe("/registry");
    expect(new URLSearchParams(cleared).get("custom")).toBe("value");
    expect(new URLSearchParams(cleared).has("namespaceId")).toBe(false);
  });

  it("extracts the dedicated scope from the advanced connection parameters", () => {
    expect(
      extractNacosConnectionScope(
        "contextPath=/nacos;namespaceId=dev-team\ncustom=value",
      ),
    ).toEqual({
      connectionParams: "contextPath=%2Fnacos&custom=value",
      scope: {
        configured: true,
        namespaceId: "dev-team",
        requestNamespaceId: "dev-team",
      },
    });
  });
});
