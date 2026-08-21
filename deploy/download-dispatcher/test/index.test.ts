import { describe, expect, it } from "vitest";
import { handleRequest, orderedNodeIds, selectLegacyRedirectCandidate } from "../src/core";

const DISPATCHER_URL = "https://download-dispatch.syngnat.top";
const DMIT_BASE_URL = "https://download.syngnat.top";
const BERO_BASE_URL = "https://origin-download.syngnat.top:8443";

type Candidate = { source: string; url: string };
type ResolveBody = {
  url: string;
  source: string;
  generation: string;
  candidates: Candidate[];
};

function resolveRequest(
  path: string,
  options: { format?: "json"; requireCurrent?: boolean; method?: string } = {},
): Request {
  const url = new URL("/v1/resolve", DISPATCHER_URL);
  url.searchParams.set("path", path);
  if (options.format) url.searchParams.set("format", options.format);
  if (options.requireCurrent) url.searchParams.set("require-current", "1");
  return new Request(url, { method: options.method ?? "GET" });
}

async function readResolve(path: string, options: { requireCurrent?: boolean } = {}): Promise<{
  response: Response;
  body: ResolveBody;
}> {
  const response = await handleRequest(resolveRequest(path, { ...options, format: "json" }), {} as Env);
  const body = await response.json<ResolveBody>();
  return { response, body };
}

describe("download dispatcher", () => {
  it("keeps the static node order independent of runtime state", () => {
    expect(orderedNodeIds()).toEqual(["dmit", "bero"]);
  });

  it("returns exact DMIT, Bero, and GitHub candidates in JSON order", async () => {
    const path = "/gonavi/releases/download/v1.2.3/GoNavi.zip";
    const { response, body } = await readResolve(path);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      url: `${DMIT_BASE_URL}${path}`,
      source: "dmit",
      generation: "",
      candidates: [
        { source: "dmit", url: `${DMIT_BASE_URL}${path}` },
        { source: "bero", url: `${BERO_BASE_URL}${path}` },
        { source: "github", url: "https://github.com/Syngnat/GoNavi/releases/download/v1.2.3/GoNavi.zip" },
      ],
    });
    expect(response.headers.get("Location")).toBe(`${DMIT_BASE_URL}${path}`);
    expect(response.headers.get("X-GoNavi-Download-Source")).toBe("dmit");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("uses DMIT for the legacy 302 and keeps Bero ahead of GitHub", async () => {
    const path = "/drivers/releases/download/driver-v1/mysql.zip";
    const response = await handleRequest(resolveRequest(path), {} as Env);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${DMIT_BASE_URL}${path}`);
    expect(response.headers.get("X-GoNavi-Download-Source")).toBe("dmit");

    const candidates = [
      { source: "dmit", url: `${DMIT_BASE_URL}${path}` },
      { source: "bero", url: `${BERO_BASE_URL}${path}` },
      { source: "github", url: "https://github.com/fallback" },
    ];
    expect(selectLegacyRedirectCandidate(candidates)).toBe(candidates[0]);
    expect(selectLegacyRedirectCandidate(candidates.slice(1))).toBe(candidates[1]);
    expect(selectLegacyRedirectCandidate(candidates.slice(2))).toBe(candidates[2]);
  });

  it("always uses the fixed Bero hostname and port", async () => {
    const path = "/gonavi/dev/releases/download/dev-2026-08-21/GoNavi.zip";
    const { body } = await readResolve(path);

    expect(body.candidates[1]).toEqual({
      source: "bero",
      url: `${BERO_BASE_URL}${path}`,
    });
    expect(body.candidates[1].url).not.toContain("94.103.173.47");
    expect(body.candidates[1].url).not.toContain("netcup");
  });

  it("ignores legacy current parameters and keeps the full candidate chain", async () => {
    const path = "/gonavi/dev/releases/download/dev-2026-08-21/GoNavi.zip";
    const { response, body } = await readResolve(path, { requireCurrent: true });

    expect(response.status).toBe(200);
    expect(body.candidates).toEqual([
      { source: "dmit", url: `${DMIT_BASE_URL}${path}` },
      { source: "bero", url: `${BERO_BASE_URL}${path}` },
      {
        source: "github",
        url: "https://github.com/Syngnat/GoNavi/releases/download/dev-latest/GoNavi.zip",
      },
    ]);
  });

  it("does not read KV even when a legacy environment would throw", async () => {
    const failingLegacyEnv = {
      ROUTING_STATE: {
        get: async () => {
          throw new Error("KV unavailable");
        },
      },
    } as unknown as Env;
    const path = "/gonavi/releases/download/v1.2.3/GoNavi.zip";
    const response = await handleRequest(resolveRequest(path, { format: "json" }), failingLegacyEnv);

    expect(response.status).toBe(200);
    const body = await response.json<ResolveBody>();
    expect(body.candidates.map((candidate) => candidate.source)).toEqual(["dmit", "bero", "github"]);
  });

  it.each([
    "https://evil.example/file",
    "/gonavi/releases/download/../secret.zip",
    "/gonavi/releases/download/v1.2.3",
    "/gonavi/releases/other/v1.2.3/file.zip",
    "/unknown/releases/download/v1.2.3/file.zip",
  ])("rejects a path outside the asset allowlist: %s", async (path) => {
    const response = await handleRequest(resolveRequest(path, { format: "json" }), {} as Env);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "invalid asset path" });
  });

  it("serves health and not-found endpoints", async () => {
    const health = await handleRequest(new Request(`${DISPATCHER_URL}/healthz`), {} as Env);
    expect(health.status).toBe(200);
    expect(health.headers.get("Cache-Control")).toBe("no-store");
    await expect(health.json()).resolves.toEqual({ status: "ok", ready: true });

    const missing = await handleRequest(new Request(`${DISPATCHER_URL}/does-not-exist`), {} as Env);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({ error: "not found" });
  });

  it("allows GET and HEAD, and rejects other methods", async () => {
    const get = await handleRequest(new Request(`${DISPATCHER_URL}/healthz`, { method: "GET" }), {} as Env);
    expect(get.status).toBe(200);

    const head = await handleRequest(new Request(`${DISPATCHER_URL}/healthz`, { method: "HEAD" }), {} as Env);
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Type")).toContain("application/json");

    const post = await handleRequest(new Request(`${DISPATCHER_URL}/healthz`, { method: "POST" }), {} as Env);
    expect(post.status).toBe(405);
    expect(post.headers.get("Allow")).toBe("GET, HEAD");
    expect(post.headers.get("Cache-Control")).toBe("no-store");
  });

  it("ignores require-current=1 for stable and mutable assets", async () => {
    const stable = await handleRequest(
      resolveRequest("/gonavi/releases/download/v1.2.3/GoNavi.zip", { requireCurrent: true }),
      {} as Env,
    );
    expect(stable.status).toBe(302);
    expect(stable.headers.get("Location")).toBe(`${DMIT_BASE_URL}/gonavi/releases/download/v1.2.3/GoNavi.zip`);

    const driver = await handleRequest(
      resolveRequest("/drivers/dev/releases/download/driver-v1/mysql.zip", { requireCurrent: true }),
      {} as Env,
    );
    expect(driver.status).toBe(302);
    expect(driver.headers.get("Location")).toBe(`${DMIT_BASE_URL}/drivers/dev/releases/download/driver-v1/mysql.zip`);
  });
});
