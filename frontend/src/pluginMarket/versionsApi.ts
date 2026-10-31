import { PluginMarketVersions, PluginMarketSourceVersions } from '../../wailsjs/go/app/App';
import { PluginAPIError, pluginResult, requireRecord } from '../plugins/apiResult';
import { boundedJSON } from '../plugins/jsonBoundary';
import { decodeMarketPlugin, MARKET_VERSION_PAGE_JSON_LIMITS } from './decode';
import type { MarketPlugin } from './types';
export type CompatibilityReason = '' | 'host_version' | 'host_version_unknown' | 'platform' | 'invalid_version';
export interface MarketVersionChoice { plugin: MarketPlugin; compatible: boolean; reason: CompatibilityReason }
export interface MarketVersionPage { versions: MarketVersionChoice[]; warning?: 'versions_unavailable' }
const COMPATIBILITY_REASONS = ['host_version', 'host_version_unknown', 'platform', 'invalid_version'] as const;
/** 动态拼接的 `plugin.market.versions.*` 会展开成这些字面量键，供全仓 i18n 扫描校验。 */
export const PLUGIN_MARKET_VERSION_REASON_TEXT_KEYS: readonly string[] = COMPATIBILITY_REASONS.map((reason) => `plugin.market.versions.${reason}`);
const reasons = new Set<string>(['', ...COMPATIBILITY_REASONS]);
const invalid = (): never => { throw new PluginAPIError('plugin.error.invalid_response'); };
export function decodeVersionPage(value: unknown): MarketVersionPage {
 boundedJSON(value, MARKET_VERSION_PAGE_JSON_LIMITS.bytes, MARKET_VERSION_PAGE_JSON_LIMITS.text, MARKET_VERSION_PAGE_JSON_LIMITS.depth, MARKET_VERSION_PAGE_JSON_LIMITS.values); const page = requireRecord(value);
 if (!Array.isArray(page.versions) || !page.versions.length || page.versions.length > 100 || (page.warning !== undefined && page.warning !== 'versions_unavailable')) return invalid();
 const versions = page.versions.map((entry): MarketVersionChoice => {
  const row = requireRecord(entry); const reason = row.reason ?? '';
  if (typeof row.compatible !== 'boolean' || typeof reason !== 'string' || !reasons.has(reason) || (row.compatible && reason)) return invalid();
  return { plugin: decodeMarketPlugin(row.plugin), compatible: row.compatible, reason: reason as CompatibilityReason };
 });
 return { versions, warning: page.warning as MarketVersionPage['warning'] };
}
export async function loadMarketVersions(id: string, sourceId: string, scoped: boolean): Promise<MarketVersionPage> {
 if (!/^[a-f0-9]{64}$/.test(sourceId)) throw new PluginAPIError('plugin.market.error.source_changed');
 const page = await pluginResult(scoped ? PluginMarketSourceVersions(sourceId, id) : PluginMarketVersions(id), decodeVersionPage);
 const seen = new Set<string>();
 for (const { plugin } of page.versions) {
  if (plugin.id !== id || plugin.sourceId !== sourceId || seen.has(plugin.version)) return invalid();
  seen.add(plugin.version);
 }
 return page;
}
