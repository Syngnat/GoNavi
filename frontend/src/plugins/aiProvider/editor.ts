import type { AIProviderConfig } from '../../types';
import type { ProviderEditorSession } from '../../utils/aiProviderEditorState';
import { rowsFromRecord } from '../../utils/aiProviderKeyValue';
import { normalizeProviderModels } from '../../utils/aiProviderManagement';
import { PluginAPIError } from '../apiResult';
import { clearedPluginProviderSettings, hasForeignPluginProviderSettings, pluginProviderHeaders, validatePluginProviderConfig } from './configValidation';
import type { PluginAIProviderView } from './types';

export function pluginProviderEditorSession(provider: AIProviderConfig, source?: PluginAIProviderView): ProviderEditorSession {
  // The shipped gateway is a real default, not a placeholder: an empty field would silently
  // depend on the plugin's own fallback, so prefill it and let the user overwrite it.
  const baseUrl = provider.baseUrl || source?.defaultBaseUrl || '';
  return { editingProvider: { ...provider, baseUrl, presetKey: provider.type },
    formValues: { ...provider, baseUrl, presetKey: provider.type,
      apiFormat: provider.apiFormat ?? '', headerRows: rowsFromRecord(provider.headers), cliEnvRows: rowsFromRecord(provider.cliEnv) }, isEditing: true, testStatus: 'idle' };
}
export function newPluginProviderSession(provider: PluginAIProviderView): ProviderEditorSession {
  return pluginProviderEditorSession({ id: '', type: provider.type, name: provider.name, apiKey: '', baseUrl: provider.defaultBaseUrl || '', model: provider.models[0].id,
    ...clearedPluginProviderSettings, authMode: 'api-key', maxTokens: 0, temperature: 0.7 });
}
export function buildPluginProviderPayload(values: Record<string, unknown>, editing: AIProviderConfig | null, purpose: 'save' | 'test', source?: PluginAIProviderView): AIProviderConfig {
  const raw: Record<string, unknown> = { ...editing, ...values };
  if (['type', 'name', 'apiKey', 'baseUrl', 'model', 'inlineCompletionModel'].some((key) => raw[key] !== undefined && typeof raw[key] !== 'string')) throw new PluginAPIError('plugin.ai_provider.error.config');
  // Fields the plugin surface never renders are rejected rather than silently
  // discarded; the editor retries once after clearing them.
  if (hasForeignPluginProviderSettings(raw, source?.supportsImages === true)) throw new PluginAPIError('plugin.ai_provider.error.unsupported_settings');
  const text = (key: string, fallback = '') => typeof raw[key] === 'string' ? raw[key] as string : fallback;
  const type = text('type');
  if (editing?.id && editing.type !== type) throw new PluginAPIError('plugin.ai_provider.error.identity');
  const apiKey = text('apiKey');
  const headers = pluginProviderHeaders(values.headerRows, raw.headers as Record<string, string> | undefined);
  const sendHeaders = Object.keys(headers).length > 0 || !editing?.id || raw.pluginUnsupportedCleared === true || Object.keys(editing.headers ?? {}).length > 0;
  const result: AIProviderConfig = { id: editing?.id || text('id'), type, name: text('name'), apiKey,
    hasSecret: apiKey !== '' || Boolean(editing?.hasSecret || editing?.secretRef || editing?.apiKey), secretRef: editing?.secretRef,
    baseUrl: text('baseUrl'), apiFormat: '', cliPath: '', cliEnv: raw.pluginUnsupportedCleared === true ? {} : undefined,
    effort: '', thinkingIntensity: '', headerTimeoutSeconds: 0, model: text('model'), inlineCompletionModel: text('inlineCompletionModel'), authMode: 'api-key',
    headers: sendHeaders ? headers : undefined, supportsImages: source?.supportsImages ?? false, models: [], maxTokens: 0,
    temperature: raw.temperature === undefined ? 0.7 : Number(raw.temperature), contextWindow: raw.contextWindow === undefined ? 0 : Number(raw.contextWindow),
    customModels: normalizeProviderModels(raw.customModels) };
  validatePluginProviderConfig(result);
  if (purpose === 'test') {
    const model = source?.models.find((item) => item.id === result.model);
    if (!source?.available || source.type !== type || !model) throw new PluginAPIError('plugin.ai_provider.error.unavailable');
    // 声明的窗口是默认值不是上限：网关别名在 models.dev 公共目录里可能写着更大的窗口，
    // 用户按目录改成 1M 是明确选择，取值范围由 validatePluginProviderConfig 兜底。
  }
  return result;
}
