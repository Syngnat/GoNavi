const NODE_IDS = ["cst", "bero"] as const;
const CHANNELS = ["stable", "dev"] as const;
const CST_BASE_URL = "https://download.syngnat.top";
const BERO_BASE_URL = "https://origin-download.syngnat.top:8443";
const CURRENT_HEALTH_TIMEOUT_MS = 10_000;
const ASSET_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEV_APP_TAG_PATTERN = /^dev-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type NodeId = (typeof NODE_IDS)[number];
type Channel = "stable" | "dev";

type AssetCoordinates = {
  channel: Channel;
  immutable: { kind: "app" | "driver"; tag: string } | null;
  relativePath: string;
  githubUrl: string;
};

const MUTABLE_PATHS: Record<string, AssetCoordinates> = {
  "/gonavi/releases/latest/latest.json": {
    channel: "stable",
    immutable: null,
    relativePath: "/gonavi/releases/latest/latest.json",
    githubUrl: "https://github.com/Syngnat/GoNavi/releases/latest/download/latest.json",
  },
  "/gonavi/dev/releases/latest/latest-dev.json": {
    channel: "dev",
    immutable: null,
    relativePath: "/gonavi/dev/releases/latest/latest-dev.json",
    githubUrl: "https://github.com/Syngnat/GoNavi/releases/download/dev-latest/latest-dev.json",
  },
  "/drivers/releases/latest/GoNavi-DriverAgents-Index.json": {
    channel: "stable",
    immutable: null,
    relativePath: "/drivers/releases/latest/GoNavi-DriverAgents-Index.json",
    githubUrl: "https://github.com/Syngnat/GoNavi-DriverAgents/releases/latest/download/GoNavi-DriverAgents-Index.json",
  },
  "/drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json": {
    channel: "dev",
    immutable: null,
    relativePath: "/drivers/dev/releases/latest/GoNavi-DriverAgents-Index.json",
    githubUrl: "https://github.com/Syngnat/GoNavi-DriverAgents/releases/download/dev-latest/GoNavi-DriverAgents-Index.json",
  },
};

function isAllowedAssetPath(value: string): boolean {
  if (
    !value.startsWith("/")
    || value.startsWith("//")
    || value.endsWith("/")
    || value.includes("%")
    || value.includes("\\")
    || value.includes("\0")
  ) return false;

  const parts = value.slice(1).split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  if (parts.length !== 5 && parts.length !== 6) return false;

  if (parts[0] === "gonavi" || parts[0] === "drivers") {
    if (parts[1] === "releases") {
      return parts.length === 5 && parts[2] === "download";
    }
    return parts.length === 6
      && parts[1] === "dev"
      && parts[2] === "releases"
      && parts[3] === "download";
  }
  return false;
}

function parseAssetCoordinates(rawPath: string): AssetCoordinates | null {
  const mutable = MUTABLE_PATHS[rawPath];
  if (mutable) return { ...mutable };
  if (!isAllowedAssetPath(rawPath)) return null;

  const parts = rawPath.slice(1).split("/");
  const isDriver = parts[0] === "drivers";
  const isDev = parts[1] === "dev";
  const tag = parts[isDev ? 4 : 3];
  const asset = parts[isDev ? 5 : 4];
  const githubTag = isDev ? "dev-latest" : tag;
  const repository = isDriver ? "Syngnat/GoNavi-DriverAgents" : "Syngnat/GoNavi";

  return {
    channel: isDev ? "dev" : "stable",
    immutable: { kind: isDriver ? "driver" : "app", tag },
    relativePath: "/" + parts.map(encodeURIComponent).join("/"),
    githubUrl: `https://github.com/${repository}/releases/download/${encodeURIComponent(githubTag)}/${encodeURIComponent(asset)}`,
  };
}

function joinBaseAndPath(baseUrl: string, relativePath: string): string {
  return baseUrl.replace(/\/+$/, "") + relativePath;
}

export function orderedNodeIds(): NodeId[] {
  return [...NODE_IDS];
}

export function selectLegacyRedirectCandidate<T extends { source: string }>(candidates: T[]): T {
  return candidates.find((candidate) => candidate.source === "cst")
    ?? candidates.find((candidate) => candidate.source === "bero")
    ?? candidates[0];
}

function staticCandidates(coordinates: AssetCoordinates): Array<{ source: string; url: string }> {
  const baseUrls: Record<NodeId, string> = {
    cst: CST_BASE_URL,
    bero: BERO_BASE_URL,
  };
  return [
    ...orderedNodeIds().map((nodeId) => ({
      source: nodeId,
      url: joinBaseAndPath(baseUrls[nodeId], coordinates.relativePath),
    })),
    { source: "github", url: coordinates.githubUrl },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type CurrentDevAppHealth = {
  appTag: string;
  generation: string;
};

function parseCurrentDevAppHealth(value: unknown): CurrentDevAppHealth | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.status !== "ok" || value.ready !== true) {
    return null;
  }
  if (typeof value.generation !== "string" || !ASSET_TAG_PATTERN.test(value.generation)) {
    return null;
  }
  if (!isRecord(value.channels) || !isRecord(value.channels.dev)) return null;
  const dev = value.channels.dev;
  if (
    dev.schemaVersion !== 2
    || dev.channel !== "dev"
    || dev.status !== "active"
    || typeof dev.appTag !== "string"
    || !DEV_APP_TAG_PATTERN.test(dev.appTag)
    || typeof dev.generation !== "string"
    || !ASSET_TAG_PATTERN.test(dev.generation)
    || dev.generation !== value.generation
  ) {
    return null;
  }
  return { appTag: dev.appTag, generation: value.generation };
}

async function readCurrentDevAppTag(fetchImpl: typeof fetch): Promise<string | null> {
  const baseUrls: Record<NodeId, string> = {
    cst: CST_BASE_URL,
    bero: BERO_BASE_URL,
  };
  const healthResults = await Promise.all(NODE_IDS.map(async (nodeId): Promise<CurrentDevAppHealth | null> => {
    try {
      const response = await fetchImpl(joinBaseAndPath(baseUrls[nodeId], "/healthz"), {
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-cache, no-store",
        },
        // A redirect must not be treated as a healthy origin response.
        redirect: "manual",
        signal: AbortSignal.timeout(CURRENT_HEALTH_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      return parseCurrentDevAppHealth(await response.json());
    } catch {
      return null;
    }
  }));

  // One origin may be unavailable while the other still proves the current
  // publication. Keep the current-asset gate useful for the fallback chain;
  // only disagreeing successful observations are unsafe.
  const available = healthResults.filter((health): health is CurrentDevAppHealth => health !== null);
  if (available.length === 0) return null;
  const first = available[0];
  if (available.some((health) => health.appTag !== first.appTag || health.generation !== first.generation)) return null;
  return first.appTag;
}

function jsonError(body: Record<string, unknown>, status: number): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

async function resolveDownload(request: Request, fetchImpl: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  const pathValues = url.searchParams.getAll("path");
  const coordinates = pathValues.length === 1 ? parseAssetCoordinates(pathValues[0]) : null;
  if (!coordinates) {
    return jsonError({ error: "invalid asset path" }, 400);
  }

  if (url.searchParams.get("require-current") === "1") {
    if (
      coordinates.channel !== "dev"
      || coordinates.immutable?.kind !== "app"
      || !DEV_APP_TAG_PATTERN.test(coordinates.immutable.tag)
    ) {
      return jsonError(
        {
          error: "require-current is only supported for immutable dev app assets",
          code: "invalid_current_asset_request",
        },
        400,
      );
    }

    const currentTag = await readCurrentDevAppTag(fetchImpl);
    if (!currentTag) {
      return jsonError(
        {
          error: "current dev app asset is temporarily unavailable",
          code: "current_asset_unavailable",
        },
        503,
      );
    }
    if (coordinates.immutable.tag !== currentTag) {
      return jsonError(
        {
          error: "requested dev app asset is no longer current",
          code: "current_asset_mismatch",
          requestedTag: coordinates.immutable.tag,
          currentTag,
        },
        409,
      );
    }
  }

  const candidates = staticCandidates(coordinates);
  const wantsJSON = url.searchParams.get("format") === "json";
  const selected = wantsJSON ? candidates[0] : selectLegacyRedirectCandidate(candidates);
  console.log(JSON.stringify({
    message: "download source selected",
    channel: coordinates.channel,
    source: selected.source,
  }));
  const headers = new Headers({
    "Cache-Control": "no-store",
    Location: selected.url,
    "X-GoNavi-Download-Source": selected.source,
  });
  if (wantsJSON) {
    return Response.json(
      {
        url: selected.url,
        source: selected.source,
        generation: "",
        candidates,
      },
      { headers },
    );
  }
  return new Response(null, { status: 302, headers });
}

function stripHeadResponseBody(request: Request, response: Response): Response {
  if (request.method !== "HEAD" || response.body === null) return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function handleRequest(
  request: Request,
  _env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" },
    });
  }
  if (url.pathname === "/healthz") {
    return stripHeadResponseBody(
      request,
      Response.json({ status: "ok", ready: true }, { headers: { "Cache-Control": "no-store" } }),
    );
  }
  if (url.pathname !== "/v1/resolve") {
    return stripHeadResponseBody(
      request,
      Response.json(
        { error: "not found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      ),
    );
  }
  return stripHeadResponseBody(request, await resolveDownload(request, fetchImpl));
}

export { CHANNELS };
