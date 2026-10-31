import type { AIProviderConfig } from '../../types';
import { PluginAPIError } from '../apiResult';
import { parsePluginAIProviderType } from './identity';
import { isPluginModelId, pluginAIText } from './validation';

const fail = (key: string): never => { throw new PluginAPIError('plugin.ai_provider.error.' + key); };
export function pluginProviderHeaders(rows: unknown, fallback?: Record<string, string>): Record<string, string> {
  const entries = rows === undefined ? Object.entries(fallback ?? {}).map(([name, value]) => ({ name, value })) : rows;
  if (!Array.isArray(entries) || entries.length > 32) return fail('headers');
  const result: Record<string, string> = Object.create(null); const seen = new Set<string>(); let bytes = 0;
  for (const row of entries) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return fail('headers');
    const { name: key, value } = row as Record<string, unknown>;
    if (key === '' && value === '') continue;
    if (typeof key !== 'string' || key.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$(?![\s\S])/.test(key)
      || !pluginAIText(value, 4096, false) || /[\r\n]/.test(value)) return fail('headers');
    const normalized = key.toLowerCase();
    if (seen.has(normalized) || ['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'proxy-authorization'].includes(normalized)) return fail('headers');
    seen.add(normalized); bytes += new TextEncoder().encode(key + value).length;
    if (bytes > 16 * 1024) return fail('headers'); result[key] = value;
  }
  return result;
}
export function hasForeignPluginProviderSettings(values: Record<string, unknown>, declaredImages = false): boolean {
  return ['apiFormat', 'cliPath', 'effort', 'thinkingIntensity'].some((key) => values[key] !== undefined && values[key] !== '')
    || (values.authMode !== undefined && values.authMode !== '' && values.authMode !== 'api-key')
    || (values.supportsImages !== undefined && values.supportsImages !== false && values.supportsImages !== declaredImages)
    || (values.headerTimeoutSeconds !== undefined && values.headerTimeoutSeconds !== 0)
    || (values.cliEnv != null && (typeof values.cliEnv !== 'object' || Array.isArray(values.cliEnv) || Object.keys(values.cliEnv).length > 0))
    || (Array.isArray(values.cliEnvRows) && values.cliEnvRows.some((row) => row && (row.name !== '' || row.value !== '')));
}
export function validatePluginProviderConfig(config: AIProviderConfig): void {
  if (!parsePluginAIProviderType(config.type)) return fail('identity');
  if (config.id === 'gonavi-ai') return fail('reserved_id');
  if (!pluginAIText(config.id, 128, false) || !pluginAIText(config.name, 256, false) || !isPluginModelId(config.model)
    || (config.inlineCompletionModel && !isPluginModelId(config.inlineCompletionModel))) return fail('config');
  if (!pluginAIText(config.apiKey, 16 * 1024, false) || !pluginAIText(config.baseUrl, 4096, false)) return fail('config');
  if (config.baseUrl) {
    try {
      const url = new URL(config.baseUrl);
      if (config.baseUrl !== config.baseUrl.trim() || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash || /[\r\n]/.test(config.baseUrl)) return fail('base_url');
    } catch { return fail('base_url'); }
  }
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2
    || (config.contextWindow !== undefined && (!Number.isInteger(config.contextWindow) || config.contextWindow < 0 || (config.contextWindow > 0 && config.contextWindow < 1024) || config.contextWindow > 8_000_000))) return fail('config');
}
export const clearedPluginProviderSettings = { headers: {}, headerRows: [], apiFormat: '', cliPath: '', cliEnv: {}, cliEnvRows: [], effort: '', thinkingIntensity: '', authMode: 'api-key', supportsImages: false, headerTimeoutSeconds: 0, pluginUnsupportedCleared: true };
