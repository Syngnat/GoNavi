import type { AIProviderConfig, AIProviderType } from '../types';
import { getProviderFingerprint, getProviderHostname, type ProviderPresetMatcher } from './aiProviderPresets';

// These are GoNavi's implemented connection paths, not a claim about every
// protocol offered by a vendor or the models available to a particular account.
export const PROVIDER_ENDPOINT_TYPES = ['openai-responses', 'openai', 'anthropic', 'gemini', 'cli', 'cursor-agent'] as const;
export type ProviderEndpointType = typeof PROVIDER_ENDPOINT_TYPES[number];
export type ProviderEndpointPreset = Pick<ProviderPresetMatcher, 'key' | 'defaultBaseUrl'> & Partial<ProviderPresetMatcher>;
const CLI_FORMATS = new Set(['codex-cli', 'claude-cli', 'grok-cli', 'cursor-cli', 'codebuddy-cli']);

export const getProviderEndpointType = (
  provider: Partial<Pick<AIProviderConfig, 'type' | 'apiFormat'>>,
): ProviderEndpointType | undefined => {
  const type = String(provider.type || '').toLowerCase();
  const format = String(provider.apiFormat || '').toLowerCase();
  if (CLI_FORMATS.has(type) || (type === 'custom' && CLI_FORMATS.has(format))) return 'cli';
  if (type === 'anthropic' || type === 'gemini') return type;
  if (type === 'openai') return format === 'openai-responses' ? 'openai-responses' : 'openai';
  if (type === 'custom') {
    if (!format) return 'openai';
    return PROVIDER_ENDPOINT_TYPES.find((endpoint) => endpoint !== 'cli' && endpoint === format);
  }
  return undefined;
};

export const getProviderEndpointTypes = (preset: ProviderEndpointPreset): ProviderEndpointType[] => {
  if (preset.key === 'custom') return [...PROVIDER_ENDPOINT_TYPES];
  const types = new Set<ProviderEndpointType>();
  const primary = getProviderEndpointType({ type: preset.backendType, apiFormat: preset.fixedApiFormat || preset.defaultApiFormat });
  if (primary) types.add(primary);
  preset.endpoints?.forEach((endpoint) => {
    const type = getProviderEndpointType({ type: endpoint.backendType });
    if (type) types.add(type);
  });
  // Only these built-in presets currently expose the Responses adapter. An
  // OpenAI-compatible URL alone does not establish Responses compatibility.
  if (preset.key === 'openai' || preset.key === 'deepseek') {
    types.add('openai');
    types.add('openai-responses');
  }
  return PROVIDER_ENDPOINT_TYPES.filter((type) => types.has(type));
};

export interface ProviderEndpointConnection {
  type: AIProviderType;
  apiFormat: string;
  baseUrl: string;
}

export const resolveProviderEndpointConnection = (
  preset: ProviderEndpointPreset,
  endpointType: ProviderEndpointType,
  currentBaseUrl?: string,
): ProviderEndpointConnection | undefined => {
  if (!preset.backendType || !getProviderEndpointTypes(preset).includes(endpointType)) return undefined;
  const endpoints = (preset.endpoints || []).filter((endpoint) => getProviderEndpointType({ type: endpoint.backendType }) === endpointType);
  const endpoint = endpoints.find((item) => getProviderFingerprint(item.baseUrl) === getProviderFingerprint(currentBaseUrl))
    || endpoints.find((item) => getProviderHostname(item.baseUrl) === getProviderHostname(currentBaseUrl))
    || endpoints[0];
  return {
    type: endpoint?.backendType || preset.backendType,
    apiFormat: preset.fixedApiFormat || (endpointType === 'cli' ? 'claude-cli' : endpointType),
    baseUrl: endpoint?.baseUrl || currentBaseUrl || preset.defaultBaseUrl,
  };
};
