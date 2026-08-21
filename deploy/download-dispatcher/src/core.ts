const NODE_IDS = ["dmit", "bero"] as const;
const CHANNELS = ["stable", "dev"] as const;
const DMIT_BASE_URL = "https://download.syngnat.top";
const BERO_BASE_URL = "https://origin-download.syngnat.top:8443";

type NodeId = (typeof NODE_IDS)[number];
type Channel = (typeof CHANNELS)[number];

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
  if (!value.startsWith("/") || value.includes("\\") || value.includes("..")) return false;
  const parts = value.split("/").filter(Boolean);
  if (parts.length !== 5 && parts.length !== 6) return false;
  if (parts[0] === "gonavi") {
    if (parts[1] === "releases") {
      return parts.length === 5 && parts[2] === "download";
    }
    return parts.length === 6 && parts[1] === "dev" && parts[2] === "releases" && parts[3] === "download";
  }
  if (parts[0] === "drivers") {
    if (parts[1] === "releases") {
      return parts.length === 5 && parts[2] === "download";
    }
    return parts.length === 6 && parts[1] === "dev" && parts[2] === "releases" && parts[3] === "download";
  }
  return false;
}

function parseAssetCoordinates(rawPath: string): AssetCoordinates | null {
  const mutable = MUTABLE_PATHS[rawPath];
  if (mutable) return { ...mutable };
  if (!isAllowedAssetPath(rawPath)) return null;
  const parts = rawPath.split("/").filter(Boolean);
  const isDriver = parts[0] === "drivers";
  const isDev = parts[1] === "dev";
  const tagIndex = isDev ? 4 : 3;
  const assetIndex = isDev ? 5 : 4;
  const tag = parts[tagIndex];
  const asset = parts[assetIndex];
  if (!tag || !asset) return null;
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
  return candidates.find((candidate) => candidate.source === "dmit")
    ?? candidates.find((candidate) => candidate.source === "bero")
    ?? candidates[0];
}

function staticCandidates(coordinates: AssetCoordinates): Array<{ source: string; url: string }> {
  const nodes: Record<NodeId, string> = {
    dmit: DMIT_BASE_URL,
    bero: BERO_BASE_URL,
  };
  return [
    ...orderedNodeIds().map((nodeId) => ({
      source: nodeId,
      url: joinBaseAndPath(nodes[nodeId], coordinates.relativePath),
    })),
    { source: "github", url: coordinates.githubUrl },
  ];
}

async function resolveDownload(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const coordinates = parseAssetCoordinates(url.searchParams.get("path") ?? "");
  if (!coordinates) {
    return Response.json({ error: "invalid asset path" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  // The manifest supplies the immutable asset size and SHA-256. Generate the
  // complete fallback chain for every asset without a remote control plane.
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

export async function handleRequest(request: Request, _env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD", "Cache-Control": "no-store" } });
  }
  if (url.pathname === "/healthz") {
    return Response.json({ status: "ok", ready: true }, { headers: { "Cache-Control": "no-store" } });
  }
  if (url.pathname !== "/v1/resolve") {
    return Response.json({ error: "not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return resolveDownload(request);
}

export { CHANNELS };
