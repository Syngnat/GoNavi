import { requireRecord } from '../apiResult';
import { parsePluginAIProviderType } from './identity';
import { invalidPluginAICatalog, isPluginModelId, pluginAIText } from './validation';
import type { PluginAIModel, PluginAIProviderView } from './types';

export const MAX_PLUGIN_AI_PROVIDERS = 4096;
// The host reads at most 5 MiB of raster bytes (internal/plugin/icon.go) and expands them to a
// base64 data URL, so the ceiling has to cover 4/3 of that plus the prefix — a smaller value
// here would reject an icon the package scanner just accepted and drop the whole catalog.
const MAX_PLUGIN_AI_ICON_LENGTH = Math.ceil((5 << 20) * 4 / 3) + 64;
const PLUGIN_AI_ICON = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
function decodeModels(value: unknown): readonly PluginAIModel[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return invalidPluginAICatalog();
  const seen = new Set<string>();
  return Object.freeze(value.map((raw) => {
    const model = requireRecord(raw);
    if (!isPluginModelId(model.id) || seen.has(model.id) || !pluginAIText(model.name, 256)
      || typeof model.contextWindow !== 'number' || !Number.isInteger(model.contextWindow) || model.contextWindow < 1024 || model.contextWindow > 262144
      || typeof model.maxOutputTokens !== 'number' || !Number.isInteger(model.maxOutputTokens) || model.maxOutputTokens < 1
      || model.maxOutputTokens > 65536 || model.maxOutputTokens > model.contextWindow) return invalidPluginAICatalog();
    seen.add(model.id);
    return Object.freeze({ id: model.id, name: model.name, contextWindow: model.contextWindow, maxOutputTokens: model.maxOutputTokens });
  }));
}
export function decodePluginAIProviders(data: unknown): readonly PluginAIProviderView[] {
  const page = requireRecord(data);
  if (!Array.isArray(page.items) || page.items.length > MAX_PLUGIN_AI_PROVIDERS) return invalidPluginAICatalog();
  const seen = new Set<string>(); const counts = new Map<string, number>();
  return Object.freeze(page.items.map((raw): PluginAIProviderView => {
    const value = requireRecord(raw); const identity = parsePluginAIProviderType(value.type);
    if (!identity || value.pluginId !== identity.pluginId || value.id !== identity.id || !pluginAIText(value.name, 256)
      || typeof value.supportsTools !== 'boolean' || typeof value.supportsImages !== 'boolean' || !pluginAIText(value.version, 128)
      || typeof value.digest !== 'string' || value.digest.length !== 64 || !/^[a-f0-9]{64}$/.test(value.digest)
      || typeof value.generation !== 'number' || !Number.isSafeInteger(value.generation) || value.generation < 0
      || typeof value.available !== 'boolean' || typeof value.state !== 'string'
      || !['disabled', 'starting', 'running', 'stopping', 'faulted', 'blocked'].includes(value.state)
      || (value.available && (value.state !== 'running' || value.generation === 0))
      || (value.reason !== undefined && !pluginAIText(value.reason, 256))
      || (value.icon !== undefined && (typeof value.icon !== 'string' || value.icon.length > MAX_PLUGIN_AI_ICON_LENGTH || !PLUGIN_AI_ICON.test(value.icon)))
      || (value.defaultBaseUrl !== undefined
        && (typeof value.defaultBaseUrl !== 'string' || value.defaultBaseUrl.length > 2048 || !/^https?:\/\/[^\s]+$/.test(value.defaultBaseUrl)))) return invalidPluginAICatalog();
    const count = (counts.get(identity.pluginId) ?? 0) + 1;
    if (seen.has(identity.type) || count > 8) return invalidPluginAICatalog();
    seen.add(identity.type); counts.set(identity.pluginId, count);
    return Object.freeze({ ...identity, name: value.name, icon: value.icon as string | undefined,
      defaultBaseUrl: value.defaultBaseUrl as string | undefined, models: decodeModels(value.models), supportsTools: value.supportsTools,
      supportsImages: value.supportsImages, version: value.version, digest: value.digest, generation: value.generation,
      available: value.available, state: value.state as PluginAIProviderView['state'], reason: value.reason as string | undefined });
  }));
}
export const pluginAIProviderSnapshotKey = (item: PluginAIProviderView | undefined): string => item ? JSON.stringify(item) : '';
