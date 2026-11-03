import { PluginMarketVersions, PluginMarketSourceVersions } from '../../wailsjs/go/app/App';
import { PluginAPIError, pluginResult, requireRecord } from '../plugins/apiResult';
import { boundedJSON } from '../plugins/jsonBoundary';
import { decodeManifest } from '../plugins/decode';
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
  // 先按原样严格解码：元数据越界、体积超限、未知字段等一律照旧整页拒绝，不能因为
  // 「可能只是历史清单」就放行有问题的响应。
  let plugin: MarketPlugin;
  try {
   plugin = decodeMarketPlugin(row.plugin);
  } catch (cause) {
   // 只有「清单本身不再符合当前宿主契约」才降级。判断方式是单独解一次清单：它失败
   // 而元数据部分完好，才说明问题出在清单契约上。
   if (!(cause instanceof PluginAPIError) || cause.key !== 'plugin.error.invalid_response'
     || !hasUndecodableManifest(row.plugin)) throw cause;
   const degraded = degradeMarketPlugin(row.plugin);
   if (!degraded) return invalid();
   return { plugin: degraded, compatible: false, reason: 'invalid_version' };
  }
  return { plugin, compatible: row.compatible, reason: reason as CompatibilityReason };
 });
 return { versions, warning: page.warning as MarketVersionPage['warning'] };
}

/** 该行的清单存在且无法按当前契约解码；清单缺失不算。 */
function hasUndecodableManifest(value: unknown): boolean {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const manifest = (value as Record<string, unknown>).manifest;
 if (manifest == null) return false;
 try {
  decodeManifest(manifest);
  return false;
 } catch {
  return true;
 }
}

/**
 * 保留身份字段的降级条目：清单已无法按当前契约解码，页面仍要能列出这个版本并说明
 * 原因。除身份外一律清空——不可信的声明不能拿去渲染权限或发起安装。
 * 只对已确认「清单本身不可解码」的行调用，元数据仍按原值搬运，供列表显示。
 */
function degradeMarketPlugin(value: unknown): MarketPlugin | null {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
 const raw = value as Record<string, unknown>;
 const text = (key: string, limit: number) => {
  const field = raw[key];
  return typeof field === 'string' && field.length > 0 && field.length <= limit ? field : null;
 };
 const id = text('id', 256);
 const name = text('name', 256);
 const version = text('version', 128);
 const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : '';
 if (!id || !name || !version) return null;
 const platforms = Array.isArray(raw.platforms) ? raw.platforms.filter((item): item is string => typeof item === 'string') : [];
 return {
  id, name, version, updatedAt, platforms,
  description: typeof raw.description === 'string' ? raw.description : '',
  author: typeof raw.author === 'string' ? raw.author : '',
  publisherId: typeof raw.publisherId === 'string' ? raw.publisherId : '',
  official: raw.official === true,
  ratingAverage: typeof raw.ratingAverage === 'number' ? raw.ratingAverage : 0,
  ratingCount: typeof raw.ratingCount === 'number' ? raw.ratingCount : 0,
  downloadCount: typeof raw.downloadCount === 'number' ? raw.downloadCount : 0,
  sourceId: typeof raw.sourceId === 'string' ? raw.sourceId : undefined,
  minHostVersion: typeof raw.minHostVersion === 'string' ? raw.minHostVersion : undefined,
 } as unknown as MarketPlugin;
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
