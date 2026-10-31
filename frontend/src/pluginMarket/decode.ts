import { PluginAPIError, requireRecord } from '../plugins/apiResult';
import { boundedJSON } from '../plugins/jsonBoundary';
import { decodeManifest, MANIFEST_JSON_LIMITS } from '../plugins/decode';
import type { CatalogPage, MarketPlugin, MarketRating, MarketSettings } from './types';

// A detail carries the full manifest plus the envelope validateItem bounds on the Go side:
// a 32 KiB description and roughly 3 KiB of other scalars (internal/pluginmarket/catalog.go:145),
// which is how the 40 KiB allowance is sized. The manifest still passes its own tighter budget
// inside decodeManifest, so this outer pass covers manifest plus envelope without becoming unbounded.
const MARKET_ENVELOPE_BYTES = 40 * 1024;
// Market payloads wrap the manifest in four more levels (page -> versions/detail -> row -> plugin
// -> manifest), so the outer depth takes the manifest budget plus that envelope; an outer pass
// tighter than decodeManifest would reject manifests the decoder itself accepts.
const MARKET_ENVELOPE_DEPTH = MANIFEST_JSON_LIMITS.depth + 4;
// Every JSON value uses at least one byte; the explicit value cap must not reject a legal manifest.
export const MARKET_JSON_LIMITS = {
  bytes: MANIFEST_JSON_LIMITS.bytes + MARKET_ENVELOPE_BYTES,
  text: MANIFEST_JSON_LIMITS.text,
  depth: MARKET_ENVELOPE_DEPTH,
  values: MANIFEST_JSON_LIMITS.values,
} as const;
// The version page holds up to 100 rows (internal/pluginmarket/versions.go:51) of full items, so its
// byte budget is the host response read cap of 2 MiB (internal/pluginmarket/service.go:16, http.go:45);
// a larger response never reaches the UI. Per row the manifest budget still applies through
// decodeMarketPlugin.
export const MARKET_VERSION_PAGE_JSON_LIMITS = {
  bytes: 2 << 20,
  text: MARKET_JSON_LIMITS.text,
  depth: MARKET_JSON_LIMITS.depth,
  values: 2 << 20,
} as const;
// Go string lengths are UTF-8 bytes (internal/pluginmarket/catalog.go:145-152), not manifest text limits.
const MARKET_METADATA_TEXT_LIMITS = { name: 256, description: 32 << 10, author: 512, publisherId: 256, category: 128, minHostVersion: 128 } as const;
const invalid = (): never => { throw new PluginAPIError('plugin.error.invalid_response'); };
export function safeHTTPURL(value: string): boolean {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}
export function decodeMarketPlugin(data: unknown): MarketPlugin {
  boundedJSON(data, MARKET_JSON_LIMITS.bytes, MARKET_JSON_LIMITS.text, MARKET_JSON_LIMITS.depth, MARKET_JSON_LIMITS.values);
  const raw = requireRecord(data);
  const p: Record<string, unknown> = { ...raw, platforms: raw.platforms ?? [] };
  if (['id', 'name', 'description', 'author', 'publisherId', 'version', 'updatedAt'].some((key) => typeof p[key] !== 'string')
    || typeof p.official !== 'boolean' || !Array.isArray(p.platforms) || p.platforms.length > 64 || p.platforms.some((item) => typeof item !== 'string')
    || typeof p.ratingAverage !== 'number' || p.ratingAverage < 0 || p.ratingAverage > 5
    || !Number.isSafeInteger(p.ratingCount) || Number(p.ratingCount) < 0
    || !Number.isSafeInteger(p.downloadCount) || Number(p.downloadCount) < 0) invalid();
  const encoder = new TextEncoder();
  for (const [key, limit] of Object.entries(MARKET_METADATA_TEXT_LIMITS)) {
    const value = p[key];
    if (value != null && (typeof value !== 'string' || encoder.encode(value).length > limit)) invalid();
  }
  if ((p.platforms as string[]).some((platform) => encoder.encode(platform).length > 64)) invalid();
  if (p.sourceId != null && typeof p.sourceId !== 'string') invalid();
  if (p.manifest != null) p.manifest = decodeManifest(p.manifest);
  if (p.artifact != null) {
    const a = requireRecord(p.artifact);
    if (typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(a.sha256) || typeof a.version !== 'string'
      || typeof a.url !== 'string' || typeof a.platform !== 'string' || encoder.encode(a.platform).length > 64
      || typeof a.sizeBytes !== 'number' || a.sizeBytes < 0) invalid();
  }
  return p as unknown as MarketPlugin;
}
export function decodeCatalog(data: unknown): CatalogPage {
  const page = requireRecord(data);
  if (!Array.isArray(page.items) || page.items.length > 100 || (page.nextCursor != null && typeof page.nextCursor !== 'string')) return invalid();
  if (page.stale != null && typeof page.stale !== 'boolean') invalid();
  for (const key of ['error', 'cachedAt', 'sourceId']) if (page[key] != null && (typeof page[key] !== 'string' || String(page[key]).length > 4096)) invalid();
  return { ...page, items: page.items.map(decodeMarketPlugin) } as CatalogPage;
}
export function decodeRating(data: unknown): MarketRating {
  boundedJSON(data);
  const r = requireRecord(data);
  if (['userId', 'pluginId', 'body', 'version', 'updatedAt'].some((key) => typeof r[key] !== 'string')
    || !Number.isInteger(r.stars) || Number(r.stars) < 1 || Number(r.stars) > 5) invalid();
  return r as unknown as MarketRating;
}
export function decodeRatings(data: unknown): MarketRating[] {
  if (!Array.isArray(data) || data.length > 1000) return invalid();
  return data.map(decodeRating);
}
export function decodeSettings(data: unknown): MarketSettings {
  const s = requireRecord(data);
  if (typeof s.baseUrl !== 'string' || (s.trustedOfficial != null && typeof s.trustedOfficial !== 'boolean')) invalid();
  if (s.sourceId != null && typeof s.sourceId !== 'string') invalid();
  return s as unknown as MarketSettings;
}
