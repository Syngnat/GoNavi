import { describe, expect, it } from "vitest";
import { handleRequest, orderedNodeIds, selectLegacyRedirectCandidate } from "../src/core";

const DISPATCHER_URL = "https://download-dispatch.syngnat.top";
const CST_BASE_URL = "https://download.syngnat.top";
const BERO_BASE_URL = "https://origin-download.syngnat.top:8443";

type Candidate = { source: string; url: string };
type ResolveBody = { url: string; source: string; generation: string; candidates: Candidate[] };

function healthPayload(nodeId: string, appTag = "dev-current", generation = "dev-generation") {
  return {
    schemaVersion: 1,
    status: "ok",
    ready: true,
    nodeId,
    generation,
    channels: {
      dev: {
        schemaVersion: 2,
        generation,
        channel: "dev",
        appTag,
        driverTag: null,
        status: "active",
        verifiedAt: "2026-09-01T00:00:00Z",
      },
    },
  };
}

function createHealthFetch(options: {
  cst?: unknown | Response;
  bero?: unknown | Response;
  throwFor?: "cst" | "bero";
} = {}) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url: requestUrl, init });
    const parsed = new URL(requestUrl);
    const node = parsed.hostname === "download.syngnat.top" ? "cst" : "bero";
    if (options.throwFor === node) throw new Error(`${node} unavailable`);
    const value = options[node] ?? healthPayload(node);
    if (value instanceof Response) return value;
    return Response.json(value);
  };
  return { fetchImpl, calls };
}

function resolveRequest(path: string, options: { format?: "json"; requireCurrent?: boolean; method?: string } = {}): Request {
  const url = new URL("/v1/resolve", DISPATCHER_URL);
  url.searchParams.set("path", path);
  if (options.format) url.searchParams.set("format", options.format);
  if (options.requireCurrent) url.searchParams.set("require-current", "1");
  return new Request(url, { method: options.method ?? "GET" });
}

async function readResolve(path: string, options: { requireCurrent?: boolean; fetchImpl?: typeof fetch } = {}): Promise<{ response: Response; body: ResolveBody }> {
  const response = await handleRequest(
    resolveRequest(path, { ...options, format: "json" }),
    {} as Env,
    options.fetchImpl,
  );
  return { response, body: await response.json<ResolveBody>() };
}

describe("download dispatcher", () => {
  it("keeps the static Cst, Bero order independent of runtime state", () => {
    expect(orderedNodeIds()).toEqual(["cst", "bero"]);
  });

  it("returns exact Cst, Bero, and GitHub candidates for stable app assets", async () => {
    const path = "/gonavi/releases/download/v1.2.3/GoNavi.zip";
    const { response, body } = await readResolve(path);
    expect(response.status).toBe(200);
    expect(body).toEqual({
      url: `${CST_BASE_URL}${path}`,
      source: "cst",
      generation: "",
      candidates: [
        { source: "cst", url: `${CST_BASE_URL}${path}` },
        { source: "bero", url: `${BERO_BASE_URL}${path}` },
        { source: "github", url: "https://github.com/Syngnat/GoNavi/releases/download/v1.2.3/GoNavi.zip" },
      ],
    });
    expect(response.headers.get("Location")).toBe(`${CST_BASE_URL}${path}`);
    expect(response.headers.get("X-GoNavi-Download-Source")).toBe("cst");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("uses Cst for legacy redirects and keeps Bero ahead of GitHub", async () => {
    const path = "/drivers/releases/download/driver-v1/mysql.zip";
    const response = await handleRequest(resolveRequest(path), {} as Env);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${CST_BASE_URL}${path}`);
    expect(response.headers.get("X-GoNavi-Download-Source")).toBe("cst");
    const candidates = [
      { source: "cst", url: `${CST_BASE_URL}${path}` },
      { source: "bero", url: `${BERO_BASE_URL}${path}` },
      { source: "github", url: "https://github.com/fallback" },
    ];
    expect(selectLegacyRedirectCandidate(candidates)).toBe(candidates[0]);
    expect(selectLegacyRedirectCandidate(candidates.slice(1))).toBe(candidates[1]);
    expect(selectLegacyRedirectCandidate(candidates.slice(2))).toBe(candidates[2]);
  });

  it("keeps HEAD responses bodyless while preserving resolver metadata", async () => {
    const path = "/gonavi/releases/download/v1.2.3/GoNavi.zip";
    const response = await handleRequest(resolveRequest(path, { method: "HEAD" }), {} as Env);
    expect(response.status).toBe(302);
    expect(response.body).toBeNull();
    expect(response.headers.get("Location")).toBe(`${CST_BASE_URL}${path}`);
    expect(response.headers.get("X-GoNavi-Download-Source")).toBe("cst");
  });

  it("does not emit JSON payloads for HEAD resolver requests", async () => {
    const path = "/gonavi/releases/download/v1.2.3/GoNavi.zip";
    const response = await handleRequest(resolveRequest(path, { method: "HEAD", format: "json" }), {} as Env);
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("Location")).toBe(`${CST_BASE_URL}${path}`);
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });

  it.each([
    ["stable app", "/gonavi/releases/download/v1.2.3/GoNavi.zip"],
    ["dev app", "/gonavi/dev/releases/download/dev-2026-09-01/GoNavi.zip"],
    ["stable driver", "/drivers/releases/download/v1.2.3/mysql.zip"],
    ["dev driver", "/drivers/dev/releases/download/dev-2026-09-01/mysql.zip"],
    ["stable app manifest", "/gonavi/releases/latest/latest.json"],
    ["dev app manifest", "/gonavi/dev/releases/latest/latest-dev.json"],
    ["stable driver index", "/drivers/releases/latest/GoNavi-DriverAgents-Index.json"],
    ["dev driver index", "/drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json"],
  ])("keeps cst, bero, github for %s", async (_label, path) => {
    const { body } = await readResolve(path);
    expect(body.candidates.map((candidate) => candidate.source)).toEqual(["cst", "bero", "github"]);
    expect(body.candidates[0].url).toBe(`${CST_BASE_URL}${path}`);
    expect(body.candidates[1].url).toBe(`${BERO_BASE_URL}${path}`);
  });

  it("uses the shared current dev app tag when both origins are healthy", async () => {
    const path = "/gonavi/dev/releases/download/dev-current/GoNavi.zip";
    const { fetchImpl, calls } = createHealthFetch();
    const { response, body } = await readResolve(path, { requireCurrent: true, fetchImpl });
    expect(response.status).toBe(200);
    expect(body.candidates).toEqual([
      { source: "cst", url: `${CST_BASE_URL}${path}` },
      { source: "bero", url: `${BERO_BASE_URL}${path}` },
      { source: "github", url: "https://github.com/Syngnat/GoNavi/releases/download/dev-latest/GoNavi.zip" },
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      `${CST_BASE_URL}/healthz`,
      `${BERO_BASE_URL}/healthz`,
    ]);
    for (const call of calls) {
      expect(call.init?.redirect).toBe("manual");
      expect(new Headers(call.init?.headers).get("Accept")).toBe("application/json");
      expect(new Headers(call.init?.headers).get("Cache-Control")).toBe("no-cache, no-store");
    }
  });

  it("applies require-current to legacy redirects as well as JSON responses", async () => {
    const path = "/gonavi/dev/releases/download/dev-current/GoNavi.zip";
    const { fetchImpl } = createHealthFetch();
    const response = await handleRequest(
      resolveRequest(path, { requireCurrent: true }),
      {} as Env,
      fetchImpl,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${CST_BASE_URL}${path}`);
  });

  it("rejects a stale immutable dev app asset with the current tag", async () => {
    const path = "/gonavi/dev/releases/download/dev-stale/GoNavi.zip";
    const { fetchImpl } = createHealthFetch();
    const response = await handleRequest(
      resolveRequest(path, { requireCurrent: true }),
      {} as Env,
      fetchImpl,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "requested dev app asset is no longer current",
      code: "current_asset_mismatch",
      requestedTag: "dev-stale",
      currentTag: "dev-current",
    });
    expect(response.headers.get("Location")).toBeNull();
  });

  it("keeps the fallback chain available when one origin is unavailable", async () => {
    const path = "/gonavi/dev/releases/download/dev-current/GoNavi.zip";
    const { fetchImpl } = createHealthFetch({ throwFor: "cst" });
    const response = await handleRequest(
      resolveRequest(path, { requireCurrent: true, format: "json" }),
      {} as Env,
      fetchImpl,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      source: "cst",
      candidates: [
        { source: "cst", url: `${CST_BASE_URL}${path}` },
        { source: "bero", url: `${BERO_BASE_URL}${path}` },
        { source: "github", url: "https://github.com/Syngnat/GoNavi/releases/download/dev-latest/GoNavi.zip" },
      ],
    });
  });

  it("fails closed when static origins disagree or both are unavailable", async () => {
    const path = "/gonavi/dev/releases/download/dev-current/GoNavi.zip";
    const mismatch = createHealthFetch({ cst: healthPayload("cst", "dev-new") });
    const mismatchResponse = await handleRequest(
      resolveRequest(path, { requireCurrent: true }),
      {} as Env,
      mismatch.fetchImpl,
    );
    expect(mismatchResponse.status).toBe(503);
    await expect(mismatchResponse.json()).resolves.toEqual({
      error: "current dev app asset is temporarily unavailable",
      code: "current_asset_unavailable",
    });

    const unavailable = createHealthFetch({
      cst: new Response(null, { status: 503 }),
      bero: new Response(null, { status: 503 }),
    });
    const unavailableResponse = await handleRequest(
      resolveRequest(path, { requireCurrent: true }),
      {} as Env,
      unavailable.fetchImpl,
    );
    expect(unavailableResponse.status).toBe(503);
    expect(unavailableResponse.headers.get("Location")).toBeNull();
  });

  it("fails closed when origins share an app tag but publish different generations", async () => {
    const path = "/gonavi/dev/releases/download/dev-current/GoNavi.zip";
    const mismatchedGeneration = createHealthFetch({
      cst: healthPayload("cst", "dev-current", "generation-cst"),
      bero: healthPayload("bero", "dev-current", "generation-bero"),
    });
    const response = await handleRequest(
      resolveRequest(path, { requireCurrent: true }),
      {} as Env,
      mismatchedGeneration.fetchImpl,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "current dev app asset is temporarily unavailable",
      code: "current_asset_unavailable",
    });
  });

  it("rejects a health payload whose channel generation differs from its envelope", async () => {
    const invalidCst = healthPayload("cst");
    invalidCst.channels.dev.generation = "channel-only-generation";
    const response = await handleRequest(
      resolveRequest("/gonavi/dev/releases/download/dev-current/GoNavi.zip", { requireCurrent: true }),
      {} as Env,
      createHealthFetch({ cst: invalidCst, bero: new Response(null, { status: 503 }) }).fetchImpl,
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "current dev app asset is temporarily unavailable",
      code: "current_asset_unavailable",
    });
  });

  it.each([
    ["stable app", "/gonavi/releases/download/v1.2.3/GoNavi.zip"],
    ["dev app manifest", "/gonavi/dev/releases/latest/latest-dev.json"],
    ["dev driver", "/drivers/dev/releases/download/dev-current/mysql.zip"],
  ])("rejects require-current for %s", async (_label, path) => {
    const response = await handleRequest(
      resolveRequest(path, { requireCurrent: true }),
      {} as Env,
      async () => { throw new Error("health must not be queried"); },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "require-current is only supported for immutable dev app assets",
      code: "invalid_current_asset_request",
    });
  });

  it("does not read KV even when a legacy environment would throw", async () => {
    const failingLegacyEnv = { ROUTING_STATE: { get: async () => { throw new Error("KV unavailable"); } } } as unknown as Env;
    const response = await handleRequest(resolveRequest("/gonavi/releases/download/v1.2.3/GoNavi.zip", { format: "json" }), failingLegacyEnv);
    expect(response.status).toBe(200);
    const body = await response.json<ResolveBody>();
    expect(body.candidates.map((candidate) => candidate.source)).toEqual(["cst", "bero", "github"]);
  });

  it.each([
    "https://evil.example/file",
    "//evil.example/file",
    "/gonavi/releases/download/../secret.zip",
    "/gonavi/releases/download/v1.2.3",
    "/gonavi/releases/other/v1.2.3/file.zip",
    "/unknown/releases/download/v1.2.3/file.zip",
    "/gonavi/releases/download/v1.2.3/file%2Fname.zip",
  ])("rejects a path outside the asset allowlist: %s", async (path) => {
    const response = await handleRequest(resolveRequest(path, { format: "json" }), {} as Env);
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "invalid asset path" });
  });

  it("rejects duplicate path parameters", async () => {
    const url = new URL("/v1/resolve", DISPATCHER_URL);
    url.searchParams.append("path", "/gonavi/releases/download/v1.2.3/GoNavi.zip");
    url.searchParams.append("path", "/gonavi/releases/download/v2.0.0/GoNavi.zip");
    expect((await handleRequest(new Request(url), {} as Env)).status).toBe(400);
  });

  it("serves health, rejects unknown routes, and limits methods", async () => {
    const health = await handleRequest(new Request(`${DISPATCHER_URL}/healthz`), {} as Env);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok", ready: true });
    expect((await handleRequest(new Request(`${DISPATCHER_URL}/missing`), {} as Env)).status).toBe(404);
    const post = await handleRequest(new Request(`${DISPATCHER_URL}/healthz`, { method: "POST" }), {} as Env);
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD");
  });
});
