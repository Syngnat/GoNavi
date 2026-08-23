import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  isPublicationVerificationFresh,
  isReadyHealthPayload,
  isRoutingStateFresh,
  nextNodeHealth,
  orderedNodeIds,
  probeEdge,
  refreshChannel,
  selectLegacyRedirectCandidate,
} from "../src/core";

describe("download dispatcher", () => {
  afterEach(async () => {
    await Promise.all([
      env.ROUTING_STATE.delete("control:stable"),
      env.ROUTING_STATE.delete("control:dev"),
      env.ROUTING_STATE.delete("routing:stable"),
      env.ROUTING_STATE.delete("routing:dev"),
    ]);
  });

  it("keeps DMIT first and Bero second in every region", () => {
    expect(orderedNodeIds()).toEqual(["dmit", "bero"]);
  });

  it("keeps legacy 302 downloads on healthy DMIT before Bero and GitHub", () => {
    const candidates = [
      { source: "dmit", url: "https://download.syngnat.top/asset" },
      { source: "bero", url: "https://origin-download.syngnat.top:8443/asset" },
      { source: "github", url: "https://github.com/example/asset" },
    ];
    expect(selectLegacyRedirectCandidate(candidates).source).toBe("dmit");
    expect(selectLegacyRedirectCandidate(candidates.filter((candidate) => candidate.source !== "dmit")).source).toBe("bero");
    expect(selectLegacyRedirectCandidate(candidates.filter((candidate) => candidate.source === "github")).source).toBe("github");
  });

  it("opens after two successes and closes after three failures", () => {
    const generation = "stable-v1";
    let state = nextNodeHealth(undefined, generation, { ok: true, detail: "ok" }, "t1");
    expect(state.healthy).toBe(false);
    state = nextNodeHealth(state, generation, { ok: true, detail: "ok" }, "t2");
    expect(state.healthy).toBe(true);

    state = nextNodeHealth(state, generation, { ok: false, detail: "timeout" }, "t3");
    state = nextNodeHealth(state, generation, { ok: false, detail: "timeout" }, "t4");
    expect(state.healthy).toBe(true);
    state = nextNodeHealth(state, generation, { ok: false, detail: "timeout" }, "t5");
    expect(state.healthy).toBe(false);
  });

  it("immediately isolates health from an older generation", () => {
    const oldState = {
      generation: "stable-old",
      healthy: true,
      consecutiveFailures: 0,
      consecutiveSuccesses: 9,
      checkedAt: "old",
      detail: "ok",
    };
    const next = nextNodeHealth(oldState, "stable-new", { ok: true, detail: "ok" }, "new");
    expect(next.healthy).toBe(false);
    expect(next.consecutiveSuccesses).toBe(1);
  });

  it("stops routing to stale health state", () => {
    const now = Date.parse("2026-08-12T12:00:00Z");
    expect(isRoutingStateFresh("2026-08-12T11:48:01Z", now)).toBe(true);
    expect(isRoutingStateFresh("2026-08-12T11:47:59Z", now)).toBe(false);
    expect(isRoutingStateFresh("invalid", now)).toBe(false);
  });

  it("accepts only a recent, canonical CI publication verification", () => {
    const now = Date.parse("2026-08-12T12:00:00Z");
    expect(isPublicationVerificationFresh("2026-08-12T11:45:00Z", now)).toBe(true);
    expect(isPublicationVerificationFresh("2026-08-12T11:44:59Z", now)).toBe(false);
    expect(isPublicationVerificationFresh("2026-08-12T12:00:01Z", now)).toBe(false);
    expect(isPublicationVerificationFresh("2026-08-12T11:45:00.001Z", now)).toBe(true);
    expect(isPublicationVerificationFresh("2026-08-12T11:45:00+00:00", now)).toBe(false);
    expect(isPublicationVerificationFresh(null, now)).toBe(false);
  });

  it("requires ready=true and the exact channel generation", () => {
    expect(isReadyHealthPayload({
      status: "bootstrap",
      ready: false,
      channels: {},
    }, "stable", "stable-1")).toBe(false);
    expect(isReadyHealthPayload({
      status: "ok",
      ready: true,
      channels: { stable: { generation: "stable-old" } },
    }, "stable", "stable-1")).toBe(false);
    expect(isReadyHealthPayload({
      status: "ok",
      ready: true,
      channels: { stable: { generation: "stable-1" } },
    }, "stable", "stable-1")).toBe(true);
  });

  it("uses manual redirect handling for Worker edge probes", async () => {
    const requests: RequestInit[] = [];
    const control = {
      schemaVersion: 1 as const,
      channel: "dev" as const,
      generation: "dev-1",
      appTag: "dev-1",
      driverTag: null,
      probePath: "/gonavi/dev/releases/download/dev-1/GoNavi-dev-1-Windows-Amd64-Portable.exe",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
      },
    };
    const fetchImpl: typeof fetch = async (_input, init) => {
      requests.push(init ?? {});
      if (requests.length === 1) {
        return Response.json({
          status: "ok",
          ready: true,
          channels: { dev: { generation: "dev-1" } },
        });
      }
      return new Response(new Uint8Array(1024), {
        status: 206,
        headers: {
          "Content-Length": "1024",
          "Content-Range": "bytes 0-1023/1024",
        },
      });
    };

    await expect(probeEdge(control, "dmit", fetchImpl)).resolves.toEqual({ ok: true, detail: "ok" });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.redirect)).toEqual(["manual", "manual"]);
  });

  it("accepts legacy dual-node routing state but routes only through DMIT", async () => {
    const generation = "stable-legacy";
    await env.ROUTING_STATE.put("control:stable", JSON.stringify({
      schemaVersion: 1,
      channel: "stable",
      generation,
      appTag: "v1.2.3",
      driverTag: null,
      probePath: "/gonavi/releases/download/v1.2.3/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
      },
    }));
    await env.ROUTING_STATE.put("routing:stable", JSON.stringify({
      schemaVersion: 1,
      channel: "stable",
      generation,
      control: {
        schemaVersion: 1,
        channel: "stable",
        generation,
        probePath: "/gonavi/releases/download/v1.2.3/GoNavi.zip",
        probeSize: 1024,
        probeSha256: "a".repeat(64),
        nodes: {
          dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
          tencent: { baseUrl: "https://legacy-edge.invalid", enabled: true },
        },
      },
      nodes: {
        dmit: {
          generation,
          healthy: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          checkedAt: new Date().toISOString(),
          detail: "ok",
        },
        tencent: {
          generation,
          healthy: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          checkedAt: new Date().toISOString(),
          detail: "ok",
        },
      },
      checkedAt: new Date().toISOString(),
    }));

    try {
      const response = await SELF.fetch(
        "https://download-dispatch.syngnat.top/v1/resolve?format=json&path=/gonavi/releases/download/v1.2.3/GoNavi.zip",
      );
      const body = await response.json<{ candidates: Array<{ source: string }> }>();
      expect(body.candidates.map((candidate) => candidate.source)).toEqual(["dmit", "github"]);
    } finally {
      await env.ROUTING_STATE.delete("routing:stable");
    }
  });

  it("does not reuse a legacy netcup fallback before Bero receives that generation", async () => {
    const generation = "stable-legacy-netcup";
    const legacyControl = {
      schemaVersion: 1,
      channel: "stable" as const,
      generation,
      appTag: "v1.2.3",
      driverTag: null,
      probePath: "/gonavi/releases/download/v1.2.3/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
        netcup: { baseUrl: "https://origin.example", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("control:stable", JSON.stringify(legacyControl));
    await env.ROUTING_STATE.put("routing:stable", JSON.stringify({
      schemaVersion: 1,
      channel: "stable",
      generation,
      control: legacyControl,
      nodes: {
        dmit: {
          generation,
          healthy: false,
          consecutiveFailures: 3,
          consecutiveSuccesses: 0,
          checkedAt: new Date().toISOString(),
          detail: "timeout",
        },
        netcup: {
          generation,
          healthy: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          checkedAt: new Date().toISOString(),
          detail: "ok",
        },
      },
      checkedAt: new Date().toISOString(),
    }));

    const response = await SELF.fetch(
      "https://download-dispatch.syngnat.top/v1/resolve?format=json&path=/gonavi/releases/download/v1.2.3/GoNavi.zip",
    );
    const body = await response.json<{ candidates: Array<{ source: string; url: string }> }>();
    expect(body.candidates).toEqual([
      { source: "github", url: "https://github.com/Syngnat/GoNavi/releases/download/v1.2.3/GoNavi.zip" },
    ]);
  });

  it("routes healthy DMIT, then Bero, then GitHub", async () => {
    const generation = "stable-dual-edge";
    const control = {
      schemaVersion: 1,
      channel: "stable" as const,
      generation,
      appTag: "v1.2.3",
      driverTag: null,
      probePath: "/gonavi/releases/download/v1.2.3/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
        bero: { baseUrl: "https://origin-download.syngnat.top:8443", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("control:stable", JSON.stringify(control));
    await env.ROUTING_STATE.put("routing:stable", JSON.stringify({
      schemaVersion: 1,
      channel: "stable",
      generation,
      control,
      nodes: {
        dmit: {
          generation,
          healthy: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          checkedAt: new Date().toISOString(),
          detail: "ok",
        },
        bero: {
          generation,
          healthy: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          checkedAt: new Date().toISOString(),
          detail: "ok",
        },
      },
      checkedAt: new Date().toISOString(),
    }));

    const response = await SELF.fetch(
      "https://download-dispatch.syngnat.top/v1/resolve?format=json&path=/gonavi/releases/download/v1.2.3/GoNavi.zip",
    );
    const body = await response.json<{ candidates: Array<{ source: string; url: string }> }>();
    expect(body.candidates).toEqual([
      { source: "dmit", url: "https://download.syngnat.top/gonavi/releases/download/v1.2.3/GoNavi.zip" },
      { source: "bero", url: "https://origin-download.syngnat.top:8443/gonavi/releases/download/v1.2.3/GoNavi.zip" },
      { source: "github", url: "https://github.com/Syngnat/GoNavi/releases/download/v1.2.3/GoNavi.zip" },
    ]);
  });

  it("falls back to healthy Bero when DMIT is unhealthy", async () => {
    const generation = "stable-bero-fallback";
    const control = {
      schemaVersion: 1,
      channel: "stable" as const,
      generation,
      appTag: "v1.2.3",
      driverTag: null,
      probePath: "/gonavi/releases/download/v1.2.3/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
        bero: { baseUrl: "https://origin-download.syngnat.top:8443", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("control:stable", JSON.stringify(control));
    await env.ROUTING_STATE.put("routing:stable", JSON.stringify({
      schemaVersion: 1,
      channel: "stable",
      generation,
      control,
      nodes: {
        dmit: {
          generation,
          healthy: false,
          consecutiveFailures: 3,
          consecutiveSuccesses: 0,
          checkedAt: new Date().toISOString(),
          detail: "timeout",
        },
        bero: {
          generation,
          healthy: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          checkedAt: new Date().toISOString(),
          detail: "ok",
        },
      },
      checkedAt: new Date().toISOString(),
    }));

    const response = await SELF.fetch(
      "https://download-dispatch.syngnat.top/v1/resolve?path=/gonavi/releases/download/v1.2.3/GoNavi.zip",
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("X-GoNavi-Download-Source")).toBe("bero");
    expect(response.headers.get("Location")).toBe(
      "https://origin-download.syngnat.top:8443/gonavi/releases/download/v1.2.3/GoNavi.zip",
    );
  });

  it("does not accept a Bero origin IP as a public fallback URL", async () => {
    await env.ROUTING_STATE.put("control:stable", JSON.stringify({
      schemaVersion: 1,
      channel: "stable",
      generation: "stable-invalid-bero-url",
      appTag: "v1.2.3",
      driverTag: null,
      probePath: "/gonavi/releases/download/v1.2.3/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
        bero: { baseUrl: "https://94.103.173.47", enabled: true },
      },
    }));

    const response = await SELF.fetch(
      "https://download-dispatch.syngnat.top/v1/resolve?format=json&path=/gonavi/releases/download/v1.2.3/GoNavi.zip",
    );
    const body = await response.json<{ candidates: Array<{ source: string }> }>();
    expect(body.candidates.map((candidate) => candidate.source)).toEqual(["github"]);
  });

  it("routes immutable assets to DMIT only when their app or driver tag matches the active control", async () => {
    const generation = "stable-run-1";
    const control = {
      schemaVersion: 1,
      channel: "stable",
      generation,
      appTag: "v1.2.3",
      driverTag: "driver-v1",
      probePath: "/gonavi/releases/download/v1.2.3/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("control:stable", JSON.stringify(control));
    await env.ROUTING_STATE.put("routing:stable", JSON.stringify({
      schemaVersion: 1,
      channel: "stable",
      generation,
      control,
      nodes: {
        dmit: {
          generation,
          healthy: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          checkedAt: new Date().toISOString(),
          detail: "ok",
        },
      },
      checkedAt: new Date().toISOString(),
    }));

    try {
      const resolveSources = async (path: string): Promise<string[]> => {
        const response = await SELF.fetch(
          `https://download-dispatch.syngnat.top/v1/resolve?format=json&path=${encodeURIComponent(path)}`,
        );
        const body = await response.json<{ candidates: Array<{ source: string }> }>();
        return body.candidates.map((candidate) => candidate.source);
      };

      await expect(resolveSources("/gonavi/releases/download/v1.2.3/GoNavi.zip")).resolves.toEqual(["dmit", "github"]);
      await expect(resolveSources("/gonavi/releases/download/v1.2.4/GoNavi.zip")).resolves.toEqual(["github"]);
      await expect(resolveSources("/drivers/releases/download/driver-v1/mysql.zip")).resolves.toEqual(["dmit", "github"]);
      await expect(resolveSources("/drivers/releases/download/driver-v2/mysql.zip")).resolves.toEqual(["github"]);
      await expect(resolveSources("/gonavi/releases/latest/latest.json")).resolves.toEqual(["dmit", "github"]);
      await expect(resolveSources("/drivers/releases/latest/GoNavi-DriverAgents-Index.json")).resolves.toEqual(["dmit", "github"]);
    } finally {
      await env.ROUTING_STATE.delete("routing:stable");
    }
  });

  it("keeps a newly published dev tag on GitHub until the matching DMIT generation is active", async () => {
    const generation = "dev-run-1";
    const control = {
      schemaVersion: 1,
      channel: "dev",
      generation,
      appTag: "dev-current",
      driverTag: "driver-current",
      probePath: "/gonavi/dev/releases/download/dev-current/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("control:dev", JSON.stringify(control));
    await env.ROUTING_STATE.put("routing:dev", JSON.stringify({
      schemaVersion: 1,
      channel: "dev",
      generation,
      control,
      nodes: {
        dmit: {
          generation,
          healthy: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          checkedAt: new Date().toISOString(),
          detail: "ok",
        },
      },
      checkedAt: new Date().toISOString(),
    }));

    try {
      const resolveSources = async (path: string): Promise<string[]> => {
        const response = await SELF.fetch(
          `https://download-dispatch.syngnat.top/v1/resolve?format=json&path=${encodeURIComponent(path)}`,
        );
        const body = await response.json<{ candidates: Array<{ source: string }> }>();
        return body.candidates.map((candidate) => candidate.source);
      };

      await expect(resolveSources("/gonavi/dev/releases/download/dev-current/GoNavi.zip")).resolves.toEqual(["dmit", "github"]);
      await expect(resolveSources("/gonavi/dev/releases/download/dev-next/GoNavi.zip")).resolves.toEqual(["github"]);
      await expect(resolveSources("/drivers/dev/releases/download/driver-current/mysql.zip")).resolves.toEqual(["dmit", "github"]);
      await expect(resolveSources("/drivers/dev/releases/download/driver-next/mysql.zip")).resolves.toEqual(["github"]);
      await expect(resolveSources("/gonavi/dev/releases/latest/latest-dev.json")).resolves.toEqual(["dmit", "github"]);
      await expect(resolveSources("/drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json")).resolves.toEqual(["dmit", "github"]);
    } finally {
      await env.ROUTING_STATE.delete("routing:dev");
    }
  });

  it("rejects a gated stale dev app tag instead of falling back to mutable GitHub", async () => {
    const generation = "dev-gate-stale";
    const control = {
      schemaVersion: 1,
      channel: "dev",
      generation,
      appTag: "dev-current",
      driverTag: null,
      probePath: "/gonavi/dev/releases/download/dev-current/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("control:dev", JSON.stringify(control));
    await env.ROUTING_STATE.put("routing:dev", JSON.stringify({
      schemaVersion: 1,
      channel: "dev",
      generation,
      control,
      nodes: {
        dmit: {
          generation,
          healthy: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          checkedAt: new Date().toISOString(),
          detail: "ok",
        },
      },
      checkedAt: new Date().toISOString(),
    }));

    const response = await SELF.fetch(
      "https://download-dispatch.syngnat.top/v1/resolve?require-current=1&path=/gonavi/dev/releases/download/dev-stale/GoNavi.zip",
      { redirect: "manual" },
    );
    const body = await response.json<{ error: string; code: string; requestedTag: string; currentTag: string }>();
    expect(response.status).toBe(409);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({
      error: "requested dev app asset is no longer current",
      code: "current_asset_mismatch",
      requestedTag: "dev-stale",
      currentTag: "dev-current",
    });
  });

  it("redirects a gated current dev app tag directly to healthy DMIT", async () => {
    const generation = "dev-gate-current";
    const control = {
      schemaVersion: 1,
      channel: "dev",
      generation,
      appTag: "dev-current",
      driverTag: null,
      probePath: "/gonavi/dev/releases/download/dev-current/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("control:dev", JSON.stringify(control));
    await env.ROUTING_STATE.put("routing:dev", JSON.stringify({
      schemaVersion: 1,
      channel: "dev",
      generation,
      control,
      nodes: {
        dmit: {
          generation,
          healthy: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          checkedAt: new Date().toISOString(),
          detail: "ok",
        },
      },
      checkedAt: new Date().toISOString(),
    }));

    const response = await SELF.fetch(
      "https://download-dispatch.syngnat.top/v1/resolve?require-current=1&path=/gonavi/dev/releases/download/dev-current/GoNavi.zip",
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://download.syngnat.top/gonavi/dev/releases/download/dev-current/GoNavi.zip",
    );
    expect(response.headers.get("X-GoNavi-Download-Source")).toBe("dmit");
  });

  it("returns DMIT, Bero, then GitHub for a gated current dev app", async () => {
    const generation = "dev-gate-json";
    const control = {
      schemaVersion: 1,
      channel: "dev",
      generation,
      appTag: "dev-current",
      driverTag: null,
      probePath: "/gonavi/dev/releases/download/dev-current/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
        bero: { baseUrl: "https://origin-download.syngnat.top:8443", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("control:dev", JSON.stringify(control));
    await env.ROUTING_STATE.put("routing:dev", JSON.stringify({
      schemaVersion: 1,
      channel: "dev",
      generation,
      control,
      nodes: {
        dmit: {
          generation,
          healthy: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          checkedAt: new Date().toISOString(),
          detail: "ok",
        },
        bero: {
          generation,
          healthy: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          checkedAt: new Date().toISOString(),
          detail: "ok",
        },
      },
      checkedAt: new Date().toISOString(),
    }));

    const response = await SELF.fetch(
      "https://download-dispatch.syngnat.top/v1/resolve?format=json&require-current=1&path=/gonavi/dev/releases/download/dev-current/GoNavi.zip",
    );
    expect(response.status).toBe(200);
    const body = await response.json<{ candidates: Array<{ source: string; url: string }> }>();
    expect(body.candidates).toEqual([
      {
        source: "dmit",
        url: "https://download.syngnat.top/gonavi/dev/releases/download/dev-current/GoNavi.zip",
      },
      {
        source: "bero",
        url: "https://origin-download.syngnat.top:8443/gonavi/dev/releases/download/dev-current/GoNavi.zip",
      },
      {
        source: "github",
        url: "https://github.com/Syngnat/GoNavi/releases/download/dev-latest/GoNavi.zip",
      },
    ]);
  });

  it("falls back to GitHub when a gated current dev app tag has no healthy edge", async () => {
    const generation = "dev-gate-unhealthy";
    const control = {
      schemaVersion: 1,
      channel: "dev",
      generation,
      appTag: "dev-current",
      driverTag: null,
      probePath: "/gonavi/dev/releases/download/dev-current/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
        bero: { baseUrl: "https://origin-download.syngnat.top:8443", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("control:dev", JSON.stringify(control));
    await env.ROUTING_STATE.put("routing:dev", JSON.stringify({
      schemaVersion: 1,
      channel: "dev",
      generation,
      control,
      nodes: {
        dmit: {
          generation,
          healthy: false,
          consecutiveFailures: 3,
          consecutiveSuccesses: 0,
          checkedAt: new Date().toISOString(),
          detail: "timeout",
        },
        bero: {
          generation,
          healthy: false,
          consecutiveFailures: 3,
          consecutiveSuccesses: 0,
          checkedAt: new Date().toISOString(),
          detail: "timeout",
        },
      },
      checkedAt: new Date().toISOString(),
    }));

    const response = await SELF.fetch(
      "https://download-dispatch.syngnat.top/v1/resolve?require-current=1&path=/gonavi/dev/releases/download/dev-current/GoNavi.zip",
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://github.com/Syngnat/GoNavi/releases/download/dev-latest/GoNavi.zip",
    );
    expect(response.headers.get("X-GoNavi-Download-Source")).toBe("github");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("routes a freshly CI-verified current generation through DMIT before cron has state", async () => {
    const control = {
      schemaVersion: 1,
      channel: "dev",
      generation: "dev-verified-1",
      appTag: "dev-current",
      driverTag: "driver-current",
      verifiedAt: new Date().toISOString(),
      probePath: "/gonavi/dev/releases/download/dev-current/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("control:dev", JSON.stringify(control));

    const resolveSources = async (path: string): Promise<string[]> => {
      const response = await SELF.fetch(
        `https://download-dispatch.syngnat.top/v1/resolve?format=json&path=${encodeURIComponent(path)}`,
      );
      const body = await response.json<{ candidates: Array<{ source: string }> }>();
      return body.candidates.map((candidate) => candidate.source);
    };

    await expect(resolveSources("/gonavi/dev/releases/download/dev-current/GoNavi.zip")).resolves.toEqual(["dmit", "github"]);
    await expect(resolveSources("/drivers/dev/releases/download/driver-current/mysql.zip")).resolves.toEqual(["dmit", "github"]);
    await expect(resolveSources("/gonavi/dev/releases/latest/latest-dev.json")).resolves.toEqual(["dmit", "github"]);
    await expect(resolveSources("/gonavi/dev/releases/download/dev-next/GoNavi.zip")).resolves.toEqual(["github"]);
    await expect(resolveSources("/drivers/dev/releases/download/driver-next/mysql.zip")).resolves.toEqual(["github"]);
  });

  it("does not reuse an old healthy routing state after control advances", async () => {
    const oldControl = {
      schemaVersion: 1,
      channel: "dev",
      generation: "dev-old",
      appTag: "dev-old",
      driverTag: null,
      probePath: "/gonavi/dev/releases/download/dev-old/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://old-edge.example", enabled: true },
      },
    };
    const currentControl = {
      ...oldControl,
      generation: "dev-new",
      appTag: "dev-new",
      probePath: "/gonavi/dev/releases/download/dev-new/GoNavi.zip",
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("routing:dev", JSON.stringify({
      schemaVersion: 1,
      channel: "dev",
      generation: oldControl.generation,
      control: oldControl,
      nodes: {
        dmit: {
          generation: oldControl.generation,
          healthy: true,
          consecutiveFailures: 0,
          consecutiveSuccesses: 2,
          checkedAt: new Date().toISOString(),
          detail: "ok",
        },
      },
      checkedAt: new Date().toISOString(),
    }));
    await env.ROUTING_STATE.put("control:dev", JSON.stringify(currentControl));

    const response = await SELF.fetch(
      "https://download-dispatch.syngnat.top/v1/resolve?format=json&path=/gonavi/dev/releases/download/dev-new/GoNavi.zip",
    );
    const body = await response.json<{ candidates: Array<{ source: string; url: string }> }>();
    expect(body.candidates.map((candidate) => candidate.source)).toEqual(["github"]);
    expect(body.candidates.some((candidate) => candidate.url.includes("old-edge.example"))).toBe(false);
  });

  it("does not bootstrap an unverified or expired control", async () => {
    const control = {
      schemaVersion: 1,
      channel: "dev",
      generation: "dev-expired",
      appTag: "dev-current",
      driverTag: null,
      verifiedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      probePath: "/gonavi/dev/releases/download/dev-current/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("control:dev", JSON.stringify(control));

    const response = await SELF.fetch(
      "https://download-dispatch.syngnat.top/v1/resolve?format=json&path=/gonavi/dev/releases/download/dev-current/GoNavi.zip",
    );
    const body = await response.json<{ candidates: Array<{ source: string }> }>();
    expect(body.candidates.map((candidate) => candidate.source)).toEqual(["github"]);
  });

  it("does not let a fresh publication proof override a stale unhealthy state", async () => {
    const control = {
      schemaVersion: 1,
      channel: "dev",
      generation: "dev-stale-unhealthy",
      appTag: "dev-current",
      driverTag: null,
      verifiedAt: new Date().toISOString(),
      probePath: "/gonavi/dev/releases/download/dev-current/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("control:dev", JSON.stringify(control));
    await env.ROUTING_STATE.put("routing:dev", JSON.stringify({
      schemaVersion: 1,
      channel: "dev",
      generation: control.generation,
      control,
      nodes: {
        dmit: {
          generation: control.generation,
          healthy: false,
          consecutiveFailures: 3,
          consecutiveSuccesses: 0,
          checkedAt: new Date(Date.now() - 13 * 60 * 1000).toISOString(),
          detail: "timeout",
        },
      },
      checkedAt: new Date(Date.now() - 13 * 60 * 1000).toISOString(),
    }));

    const response = await SELF.fetch(
      "https://download-dispatch.syngnat.top/v1/resolve?format=json&path=/gonavi/dev/releases/download/dev-current/GoNavi.zip",
    );
    const body = await response.json<{ candidates: Array<{ source: string }> }>();
    expect(body.candidates.map((candidate) => candidate.source)).toEqual(["github"]);
  });

  it("promotes a freshly verified generation after its first successful cron probe", async () => {
    const control = {
      schemaVersion: 1,
      channel: "dev",
      generation: "dev-cron-verified",
      appTag: "dev-current",
      driverTag: null,
      verifiedAt: new Date().toISOString(),
      probePath: "/gonavi/dev/releases/download/dev-current/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("control:dev", JSON.stringify(control));
    let requests = 0;
    const fetchImpl: typeof fetch = async () => {
      requests += 1;
      if (requests === 1) {
        return Response.json({
          status: "ok",
          ready: true,
          channels: { dev: { generation: control.generation } },
        });
      }
      return new Response(new Uint8Array(1024), {
        status: 206,
        headers: {
          "Content-Length": "1024",
          "Content-Range": "bytes 0-1023/1024",
        },
      });
    };

    const state = await refreshChannel(env, "dev", fetchImpl);
    expect(requests).toBe(2);
    expect(state.nodes.dmit).toMatchObject({
      generation: control.generation,
      healthy: true,
      consecutiveFailures: 0,
      consecutiveSuccesses: 2,
    });
  });

  it("does not promote a freshly verified generation when its first cron probe fails", async () => {
    const control = {
      schemaVersion: 1,
      channel: "dev",
      generation: "dev-cron-failed",
      appTag: "dev-current",
      driverTag: null,
      verifiedAt: new Date().toISOString(),
      probePath: "/gonavi/dev/releases/download/dev-current/GoNavi.zip",
      probeSize: 1024,
      probeSha256: "a".repeat(64),
      nodes: {
        dmit: { baseUrl: "https://download.syngnat.top", enabled: true },
      },
    };
    await env.ROUTING_STATE.put("control:dev", JSON.stringify(control));
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 503 });

    const state = await refreshChannel(env, "dev", fetchImpl);
    expect(state.nodes.dmit).toMatchObject({
      generation: control.generation,
      healthy: false,
      consecutiveFailures: 1,
      consecutiveSuccesses: 0,
    });
  });

  it("reads publication control from the routing KV namespace", async () => {
    await env.ROUTING_STATE.delete("control:stable");
    await expect(refreshChannel(env, "stable")).rejects.toThrow(
      "publication control is missing for stable",
    );
  });

  it("redirects to GitHub when no healthy edge is available", async () => {
    await env.ROUTING_STATE.delete("routing:stable");
    const response = await SELF.fetch(
      "https://download-dispatch.syngnat.top/v1/resolve?path=/gonavi/releases/download/v1.2.3/GoNavi.zip",
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://github.com/Syngnat/GoNavi/releases/download/v1.2.3/GoNavi.zip",
    );
  });

  it("returns ordered fallback candidates in JSON without proxying the file", async () => {
    await env.ROUTING_STATE.delete("routing:stable");
    const response = await SELF.fetch(
      "https://download-dispatch.syngnat.top/v1/resolve?format=json&path=/gonavi/releases/download/v1.2.3/GoNavi.zip",
    );
    const body = await response.json<{ candidates: Array<{ source: string; url: string }> }>();
    expect(response.status).toBe(200);
    expect(body.candidates.map((candidate) => candidate.source)).toEqual(["github"]);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("dispatches mutable app and driver pointers through the GitHub fallback", async () => {
    await env.ROUTING_STATE.delete("routing:stable");
    for (const [path, githubSuffix] of [
      ["/gonavi/releases/latest/latest.json", "/Syngnat/GoNavi/releases/latest/download/latest.json"],
      ["/drivers/releases/latest/GoNavi-DriverAgents-Index.json", "/Syngnat/GoNavi-DriverAgents/releases/latest/download/GoNavi-DriverAgents-Index.json"],
    ]) {
      const response = await SELF.fetch(
        `https://download-dispatch.syngnat.top/v1/resolve?format=json&path=${encodeURIComponent(path)}`,
      );
      const body = await response.json<{ candidates: Array<{ source: string; url: string }> }>();
      expect(response.status).toBe(200);
      expect(body.candidates.map((candidate) => candidate.source)).toEqual(["github"]);
      expect(new URL(body.candidates[0].url).pathname).toBe(githubSuffix);
    }
  });

  it("rejects paths outside immutable release roots", async () => {
    const response = await SELF.fetch(
      "https://download-dispatch.syngnat.top/v1/resolve?path=https://evil.example/file",
    );
    expect(response.status).toBe(400);
  });
});
