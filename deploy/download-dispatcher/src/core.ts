const NODE_IDS = ["dmit", "bero"] as const;
const LEGACY_DISABLED_BERO_BASE_URL = "https://bero-disabled.invalid";
const BERO_PROXY_BASE_URL = "https://origin-download.syngnat.top:8443";
const CHANNELS = ["stable", "dev"] as const;
const SUCCESS_THRESHOLD = 2;
const FAILURE_THRESHOLD = 3;
const RANGE_PROBE_BYTES = 1024;
const ROUTING_STATE_MAX_AGE_MS = 12 * 60 * 1000;
const PUBLICATION_VERIFICATION_MAX_AGE_MS = 15 * 60 * 1000;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

type NodeId = (typeof NODE_IDS)[number];
type Channel = (typeof CHANNELS)[number];

type EdgeConfig = {
  baseUrl: string;
  enabled: boolean;
};

type PublicationControl = {
  schemaVersion: 1;
  channel: Channel;
  generation: string;
  appTag: string;
  driverTag: string | null;
  verifiedAt: string | null;
  probePath: string;
  probeSize: number;
  probeSha256: string;
  nodes: Record<NodeId, EdgeConfig>;
};

type NodeHealth = {
  generation: string;
  healthy: boolean;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  checkedAt: string;
  detail: string;
};

type RoutingState = {
  schemaVersion: 1;
  channel: Channel;
  generation: string;
  control: PublicationControl;
  nodes: Record<NodeId, NodeHealth>;
  checkedAt: string;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && CHANNELS.includes(value as Channel);
}

function isNodeId(value: unknown): value is NodeId {
  return typeof value === "string" && NODE_IDS.includes(value as NodeId);
}

function normalizeHttpsBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return null;
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function isBeroProxyBaseUrl(value: string): boolean {
  return value === BERO_PROXY_BASE_URL;
}

function parseStrictUTCTimestamp(value: string): number | null {
  if (!UTC_TIMESTAMP_PATTERN.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const canonical = new Date(milliseconds).toISOString();
  if (value !== canonical && value !== canonical.replace(".000Z", "Z")) return null;
  return milliseconds;
}

function validateControl(value: unknown, expectedChannel: Channel): PublicationControl {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.channel !== expectedChannel) {
    throw new Error("invalid publication control envelope");
  }
  if (
    typeof value.generation !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.generation)
    || typeof value.probePath !== "string"
    || !isAllowedAssetPath(value.probePath)
    || typeof value.probeSize !== "number"
    || !Number.isSafeInteger(value.probeSize)
    || value.probeSize <= 0
    || typeof value.probeSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.probeSha256)
    || !isRecord(value.nodes)
  ) {
    throw new Error("invalid publication control metadata");
  }

  const nodes = {} as Record<NodeId, EdgeConfig>;
  for (const nodeId of NODE_IDS) {
    const rawNode = value.nodes[nodeId];
    // A control written before the Bero fallback remains readable, but its old
    // netcup node is intentionally not reused: that generation is not verified
    // on Bero yet and must fall back to GitHub until the next publication.
    if (rawNode === undefined && nodeId === "bero") {
      nodes[nodeId] = { baseUrl: LEGACY_DISABLED_BERO_BASE_URL, enabled: false };
      continue;
    }
    if (!isRecord(rawNode) || typeof rawNode.enabled !== "boolean") {
      throw new Error(`invalid edge config for ${nodeId}`);
    }
    const baseUrl = normalizeHttpsBaseUrl(rawNode.baseUrl);
    if (!baseUrl) {
      throw new Error(`invalid HTTPS base URL for ${nodeId}`);
    }
    if (nodeId === "bero" && !isBeroProxyBaseUrl(baseUrl)) {
      throw new Error("bero base URL must be a separate HTTPS hostname");
    }
    nodes[nodeId] = { baseUrl, enabled: rawNode.enabled };
  }

  const probe = parseAssetCoordinates(value.probePath);
  if (!probe || probe.channel !== expectedChannel || probe.immutable?.kind !== "app") {
    throw new Error("publication control probe must be an immutable app asset");
  }
  const appTag = typeof value.appTag === "string" ? value.appTag : probe.immutable.tag;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(appTag) || appTag !== probe.immutable.tag) {
    throw new Error("invalid publication control app tag");
  }
  const driverTag = typeof value.driverTag === "string" && value.driverTag !== "" ? value.driverTag : null;
  if (driverTag !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(driverTag)) {
    throw new Error("invalid publication control driver tag");
  }
  let verifiedAt: string | null = null;
  if (value.verifiedAt !== undefined) {
    if (typeof value.verifiedAt !== "string" || parseStrictUTCTimestamp(value.verifiedAt) === null) {
      throw new Error("invalid publication control verification time");
    }
    verifiedAt = value.verifiedAt;
  }

  return {
    schemaVersion: 1,
    channel: expectedChannel,
    generation: value.generation,
    appTag,
    driverTag,
    verifiedAt,
    probePath: value.probePath,
    probeSize: value.probeSize,
    probeSha256: value.probeSha256,
    nodes,
  };
}

function controlsShareRoutingIdentity(left: PublicationControl, right: PublicationControl): boolean {
  if (
    left.channel !== right.channel
    || left.generation !== right.generation
    || left.appTag !== right.appTag
    || left.driverTag !== right.driverTag
    || left.probePath !== right.probePath
    || left.probeSize !== right.probeSize
    || left.probeSha256 !== right.probeSha256
  ) {
    return false;
  }
  return NODE_IDS.every((nodeId) => {
    const leftNode = left.nodes[nodeId];
    const rightNode = right.nodes[nodeId];
    return leftNode.baseUrl === rightNode.baseUrl && leftNode.enabled === rightNode.enabled;
  });
}

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

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total) || start < 0 || end < start || total <= end) {
    return null;
  }
  return { start, end, total };
}

export function isReadyHealthPayload(value: unknown, channel: Channel, generation: string): boolean {
  if (!isRecord(value) || value.status !== "ok" || value.ready !== true || !isRecord(value.channels)) {
    return false;
  }
  const channelHealth = value.channels[channel];
  return isRecord(channelHealth) && channelHealth.generation === generation;
}

export async function probeEdge(
  control: PublicationControl,
  nodeId: NodeId,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; detail: string }> {
  const node = control.nodes[nodeId];
  if (!node.enabled) return { ok: false, detail: "disabled by publication control" };

  try {
    const healthResponse = await fetchImpl(node.baseUrl + "/healthz", {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      // Workers supports only follow/manual; manual makes a redirect fail the status checks below.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (!healthResponse.ok) return { ok: false, detail: `healthz status ${healthResponse.status}` };
    const healthValue: unknown = await healthResponse.json();
    if (!isReadyHealthPayload(healthValue, control.channel, control.generation)) {
      return { ok: false, detail: "healthz is not ready for generation" };
    }

    const rangeEnd = Math.min(control.probeSize, RANGE_PROBE_BYTES) - 1;
    const rangeResponse = await fetchImpl(node.baseUrl + control.probePath, {
      headers: {
        Range: `bytes=0-${rangeEnd}`,
        "Cache-Control": "no-cache",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const contentRange = parseContentRange(rangeResponse.headers.get("Content-Range"));
    const body = await rangeResponse.arrayBuffer();
    if (
      rangeResponse.status !== 206
      || !contentRange
      || contentRange.start !== 0
      || contentRange.end !== rangeEnd
      || contentRange.total !== control.probeSize
      || Number(rangeResponse.headers.get("Content-Length")) !== rangeEnd + 1
      || body.byteLength !== rangeEnd + 1
    ) {
      return { ok: false, detail: "immutable Range verification failed" };
    }
    return { ok: true, detail: "ok" };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : "probe failed" };
  }
}

export function nextNodeHealth(
  previous: NodeHealth | undefined,
  generation: string,
  sample: { ok: boolean; detail: string },
  checkedAt: string,
): NodeHealth {
  if (previous?.generation !== generation) {
    return {
      generation,
      healthy: false,
      consecutiveFailures: sample.ok ? 0 : 1,
      consecutiveSuccesses: sample.ok ? 1 : 0,
      checkedAt,
      detail: sample.detail,
    };
  }
  if (sample.ok) {
    const successes = previous.consecutiveSuccesses + 1;
    return {
      generation,
      healthy: previous.healthy || successes >= SUCCESS_THRESHOLD,
      consecutiveFailures: 0,
      consecutiveSuccesses: successes,
      checkedAt,
      detail: sample.detail,
    };
  }
  const failures = previous.consecutiveFailures + 1;
  return {
    generation,
    healthy: previous.healthy && failures < FAILURE_THRESHOLD,
    consecutiveFailures: failures,
    consecutiveSuccesses: 0,
    checkedAt,
    detail: sample.detail,
  };
}

async function readRoutingState(env: Env, channel: Channel): Promise<RoutingState | null> {
  const value: unknown = await env.ROUTING_STATE.get(`routing:${channel}`, "json");
  if (!isRecord(value) || value.schemaVersion !== 1 || value.channel !== channel || !isRecord(value.nodes) || !isRecord(value.control)) {
    return null;
  }
  try {
    const control = validateControl(value.control, channel);
    if (value.generation !== control.generation) return null;
    const nodes = {} as Record<NodeId, NodeHealth>;
    for (const nodeId of NODE_IDS) {
      const raw = value.nodes[nodeId];
      if (raw === undefined && nodeId === "bero") {
        nodes[nodeId] = {
          generation: control.generation,
          healthy: false,
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
          checkedAt: "",
          detail: "disabled by legacy publication control",
        };
        continue;
      }
      if (
        !isRecord(raw)
        || typeof raw.generation !== "string"
        || typeof raw.healthy !== "boolean"
        || typeof raw.consecutiveFailures !== "number"
        || typeof raw.consecutiveSuccesses !== "number"
        || typeof raw.checkedAt !== "string"
        || typeof raw.detail !== "string"
      ) {
        return null;
      }
      nodes[nodeId] = {
        generation: raw.generation,
        healthy: raw.healthy,
        consecutiveFailures: raw.consecutiveFailures,
        consecutiveSuccesses: raw.consecutiveSuccesses,
        checkedAt: raw.checkedAt,
        detail: raw.detail,
      };
    }
    return {
      schemaVersion: 1,
      channel,
      generation: control.generation,
      control,
      nodes,
      checkedAt: typeof value.checkedAt === "string" ? value.checkedAt : "",
    };
  } catch {
    return null;
  }
}

async function readCurrentControl(env: Env, channel: Channel): Promise<PublicationControl | null> {
  const value: unknown = await env.ROUTING_STATE.get(`control:${channel}`, "json");
  if (value === null) return null;
  try {
    return validateControl(value, channel);
  } catch {
    return null;
  }
}

function routingStateMatchesControl(state: RoutingState, control: PublicationControl): boolean {
  return state.generation === control.generation && controlsShareRoutingIdentity(state.control, control);
}

export async function refreshChannel(
  env: Env,
  channel: Channel,
  fetchImpl: typeof fetch = fetch,
): Promise<RoutingState> {
  const controlValue: unknown = await env.ROUTING_STATE.get(`control:${channel}`, "json");
  if (controlValue === null) throw new Error(`publication control is missing for ${channel}`);
  const control = validateControl(controlValue, channel);
  const previous = await readRoutingState(env, channel);
  const previousForControl = previous && routingStateMatchesControl(previous, control) ? previous : null;
  const checkedAt = new Date().toISOString();
  const probeResults = await Promise.all(NODE_IDS.map((nodeId) => probeEdge(control, nodeId, fetchImpl)));
  const nodes = {} as Record<NodeId, NodeHealth>;
  for (let index = 0; index < NODE_IDS.length; index += 1) {
    const nodeId = NODE_IDS[index];
    const result = probeResults[index];
    if (!previousForControl && result.ok && isPublicationVerificationFresh(control.verifiedAt)) {
      nodes[nodeId] = {
        generation: control.generation,
        healthy: true,
        consecutiveFailures: 0,
        consecutiveSuccesses: SUCCESS_THRESHOLD,
        checkedAt,
        detail: result.detail,
      };
      continue;
    }
    nodes[nodeId] = nextNodeHealth(previousForControl?.nodes[nodeId], control.generation, result, checkedAt);
  }
  const state: RoutingState = {
    schemaVersion: 1,
    channel,
    generation: control.generation,
    control,
    nodes,
    checkedAt,
  };
  await env.ROUTING_STATE.put(`routing:${channel}`, JSON.stringify(state));
  console.log(JSON.stringify({
    message: "routing health refreshed",
    channel,
    generation: control.generation,
    nodes: Object.fromEntries(NODE_IDS.map((nodeId) => [nodeId, nodes[nodeId].healthy])),
  }));
  return state;
}

export function orderedNodeIds(): NodeId[] {
  return ["dmit", "bero"];
}

export function isRoutingStateFresh(checkedAt: string, now: number = Date.now()): boolean {
  const checkedAtMillis = Date.parse(checkedAt);
  return Number.isFinite(checkedAtMillis)
    && checkedAtMillis <= now
    && now - checkedAtMillis <= ROUTING_STATE_MAX_AGE_MS;
}

export function isPublicationVerificationFresh(verifiedAt: string | null, now: number = Date.now()): boolean {
  if (verifiedAt === null) return false;
  const verifiedAtMillis = parseStrictUTCTimestamp(verifiedAt);
  return verifiedAtMillis !== null
    && verifiedAtMillis <= now
    && now - verifiedAtMillis <= PUBLICATION_VERIFICATION_MAX_AGE_MS;
}

function joinBaseAndPath(baseUrl: string, relativePath: string): string {
  return baseUrl.replace(/\/+$/, "") + relativePath;
}

export function selectLegacyRedirectCandidate<T extends { source: string }>(candidates: T[]): T {
  return candidates.find((candidate) => candidate.source === "dmit")
    ?? candidates.find((candidate) => candidate.source === "bero")
    ?? candidates[0];
}

async function resolveDownload(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const coordinates = parseAssetCoordinates(url.searchParams.get("path") ?? "");
  if (!coordinates) {
    return Response.json({ error: "invalid asset path" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const requiresCurrentDevApp = url.searchParams.get("require-current") === "1";
  if (requiresCurrentDevApp && (coordinates.channel !== "dev" || coordinates.immutable?.kind !== "app")) {
    return Response.json(
      {
        error: "require-current is only supported for immutable dev app assets",
        code: "invalid_current_asset_request",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const [control, state] = await Promise.all([
    readCurrentControl(env, coordinates.channel),
    readRoutingState(env, coordinates.channel),
  ]);
  const requestedDevAppTag = requiresCurrentDevApp && coordinates.immutable?.kind === "app"
    ? coordinates.immutable.tag
    : null;
  if (requiresCurrentDevApp && requestedDevAppTag !== null) {
    if (!control) {
      return Response.json(
        { error: "current dev app asset is temporarily unavailable", code: "current_asset_unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (requestedDevAppTag !== control.appTag) {
      return Response.json(
        {
          error: "requested dev app asset is no longer current",
          code: "current_asset_mismatch",
          requestedTag: requestedDevAppTag,
          currentTag: control.appTag,
        },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }
  }
  const candidates: Array<{ source: string; url: string }> = [];
  const activeTag = coordinates.immutable?.kind === "app"
    ? control?.appTag
    : coordinates.immutable?.kind === "driver"
      ? control?.driverTag
      : null;
  const isCurrentImmutable = coordinates.immutable === null || activeTag === coordinates.immutable.tag;
  const currentState = control && state && routingStateMatchesControl(state, control) ? state : null;
  const stateIsFresh = currentState !== null && isRoutingStateFresh(currentState.checkedAt);
  // A CI proof can bridge only the no-state publication gap. It must never
  // override an existing (including stale or unhealthy) health observation.
  const canBootstrapFromPublication = currentState === null
    && control !== null
    && isPublicationVerificationFresh(control.verifiedAt);
  if (control && isCurrentImmutable) {
    for (const nodeId of orderedNodeIds()) {
      const node = currentState?.nodes[nodeId];
      const config = control.nodes[nodeId];
      const isHealthyInCurrentState = stateIsFresh
        && node !== undefined
        && node.healthy
        && node.generation === control.generation;
      if (config.enabled && (isHealthyInCurrentState || canBootstrapFromPublication)) {
        candidates.push({ source: nodeId, url: joinBaseAndPath(config.baseUrl, coordinates.relativePath) });
      }
    }
  }
  // A gated request has already proven that its immutable dev tag is current.
  // Keep its edge preference, but retain GitHub as the final availability fallback.
  candidates.push({ source: "github", url: coordinates.githubUrl });

  const wantsJSON = url.searchParams.get("format") === "json";
  const selected = wantsJSON ? candidates[0] : selectLegacyRedirectCandidate(candidates);
  console.log(JSON.stringify({
    message: "download source selected",
    channel: coordinates.channel,
    generation: control?.generation ?? "",
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
        generation: control?.generation ?? "",
        candidates,
      },
      { headers },
    );
  }
  return new Response(null, { status: 302, headers });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
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
  return resolveDownload(request, env);
}

export { CHANNELS };
