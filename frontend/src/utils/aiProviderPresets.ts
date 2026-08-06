import type { AIProviderAuthMode, AIProviderConfig, AIProviderType } from '../types';

export const LEGACY_QWEN_BAILIAN_OPENAI_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const LEGACY_QWEN_CODING_PLAN_OPENAI_BASE_URL = 'https://coding.dashscope.aliyuncs.com/v1';
export const QWEN_BAILIAN_ANTHROPIC_BASE_URL = 'https://dashscope.aliyuncs.com/apps/anthropic';
export const QWEN_CODING_PLAN_ANTHROPIC_BASE_URL = 'https://coding.dashscope.aliyuncs.com/apps/anthropic';
export const QWEN_BAILIAN_MODELS_BASE_URL = LEGACY_QWEN_BAILIAN_OPENAI_BASE_URL;

export const QWEN_CODING_PLAN_MODELS = [
  'qwen3.5-plus',
  'kimi-k2.5',
  'glm-5',
  'MiniMax-M2.5',
  'qwen3-max-2026-01-23',
  'qwen3-coder-next',
  'qwen3-coder-plus',
  'glm-4.7',
];

const CUSTOM_LIKE_PRESET_KEYS = new Set(['custom', 'ollama', 'codebuddy', 'cursor', 'codex', 'claude-subscription']);
const OPTIONAL_MODEL_PRESET_KEYS = new Set(['cursor', 'codex', 'claude-subscription']);

export interface ResolvePresetModelSelectionInput {
  presetKey: string;
  presetDefaultModel: string;
  presetModels: string[];
  valuesModel?: string;
  customModels?: string[];
}

export interface ResolvePresetModelSelectionResult {
  model: string;
  models: string[];
}

export interface ProviderPresetEndpoint {
  backendType: AIProviderType;
  baseUrl: string;
}

export interface ResolvePresetBaseURLInput {
  presetKey: string;
  presetDefaultBaseUrl: string;
  presetEndpoints?: ProviderPresetEndpoint[];
  valuesBaseUrl?: string;
}

export interface ResolvePresetTransportInput {
  presetKey?: string;
  presetBackendType: AIProviderType;
  presetFixedApiFormat?: string;
  presetEndpoints?: ProviderPresetEndpoint[];
  valuesBaseUrl?: string;
  valuesApiFormat?: string;
}

export interface ResolvePresetTransportResult {
  type: AIProviderType;
  apiFormat?: string;
}

export interface ProviderPresetMatcher {
  key: string;
  backendType: AIProviderType;
  defaultBaseUrl: string;
  endpoints?: ProviderPresetEndpoint[];
  fixedApiFormat?: string;
  authMode?: AIProviderAuthMode;
}

export type ProviderPresetCandidate = Pick<
  AIProviderConfig,
  'type' | 'baseUrl' | 'apiFormat' | 'authMode'
> & Partial<Pick<AIProviderConfig, 'apiKey' | 'hasSecret' | 'secretRef'>>;

export const isLocalCLISubscriptionProvider = (
  provider: Pick<AIProviderConfig, 'type' | 'apiFormat' | 'authMode'>,
): boolean => {
  const providerType = String(provider.type || '').trim().toLowerCase();
  const authMode = String(provider.authMode || '').trim().toLowerCase();
  const apiFormat = String(provider.apiFormat || '').trim().toLowerCase();
  return providerType === 'custom'
    && authMode === 'local-cli'
    && (apiFormat === 'codex-cli' || apiFormat === 'claude-cli');
};

export const getProviderHostname = (raw?: string): string => {
  if (!raw) return '';
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
};

export const getProviderFingerprint = (raw?: string): string => {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const normalizedPath = url.pathname.replace(/\/+$/, '').toLowerCase();
    return `${url.hostname.toLowerCase()}${normalizedPath}`;
  } catch {
    return '';
  }
};

export const matchQwenPresetKey = (provider: ProviderPresetCandidate): string | null => {
  const fingerprint = getProviderFingerprint(provider.baseUrl);

  if (
    fingerprint !== ''
    && fingerprint === getProviderFingerprint(QWEN_BAILIAN_ANTHROPIC_BASE_URL)
    && provider.type === 'anthropic'
  ) {
    return 'qwen-bailian';
  }

  if (
    fingerprint !== ''
    && fingerprint === getProviderFingerprint(LEGACY_QWEN_BAILIAN_OPENAI_BASE_URL)
    && provider.type === 'openai'
  ) {
    return 'qwen-bailian';
  }

  if (
    fingerprint !== ''
    && fingerprint === getProviderFingerprint(QWEN_CODING_PLAN_ANTHROPIC_BASE_URL)
    && provider.type === 'custom'
    && provider.apiFormat === 'claude-cli'
  ) {
    return 'qwen-coding-plan';
  }

  if (
    fingerprint !== ''
    && fingerprint === getProviderFingerprint(LEGACY_QWEN_CODING_PLAN_OPENAI_BASE_URL)
    && provider.type === 'openai'
  ) {
    return 'qwen-coding-plan';
  }

  return null;
};

export const resolveProviderPresetKey = (
  provider: ProviderPresetCandidate,
  presets: ProviderPresetMatcher[],
  fallbackKey = 'custom',
): string => {
  const qwenPresetKey = matchQwenPresetKey(provider);
  if (qwenPresetKey) {
    return qwenPresetKey;
  }

  const fingerprint = getProviderFingerprint(provider.baseUrl);
  const hasStoredSecret = provider.hasSecret === true
    || Boolean(String(provider.secretRef || '').trim())
    || Boolean(String(provider.apiKey || '').trim());
  const inferredAuthMode: AIProviderAuthMode = provider.authMode
    || (fingerprint === ''
      && !hasStoredSecret
      && ['codex-cli', 'claude-cli'].includes(provider.apiFormat || '')
      ? 'local-cli'
      : 'api-key');
  const formatOnlyPreset = presets.find((preset) =>
    preset.backendType === provider.type
    && Boolean(preset.fixedApiFormat)
    && preset.fixedApiFormat === provider.apiFormat
    && getProviderFingerprint(preset.defaultBaseUrl) === ''
    && fingerprint === ''
    && (preset.authMode || 'api-key') === inferredAuthMode,
  );
  if (formatOnlyPreset) {
    return formatOnlyPreset.key;
  }

  const exactPreset = presets.find((preset) => {
    const matchesDefaultEndpoint = preset.backendType === provider.type
      && fingerprint === getProviderFingerprint(preset.defaultBaseUrl);
    const matchesConfiguredEndpoint = preset.endpoints?.some((endpoint) =>
      endpoint.backendType === provider.type
      && fingerprint === getProviderFingerprint(endpoint.baseUrl),
    );
    return fingerprint !== ''
      && (matchesDefaultEndpoint || matchesConfiguredEndpoint)
      && (!preset.fixedApiFormat || preset.fixedApiFormat === provider.apiFormat);
  });
  if (exactPreset) {
    return exactPreset.key;
  }

  // custom 供应商必须保守处理，避免仅凭 host 错误吞掉用户显式保存的自定义配置。
  if (provider.type === 'custom') {
    return fallbackKey;
  }

  const host = getProviderHostname(provider.baseUrl);
  if (provider.type === 'anthropic' && host.endsWith('moonshot.cn')) {
    const moonshotPreset = presets.find((preset) => preset.key === 'moonshot');
    if (moonshotPreset) {
      return moonshotPreset.key;
    }
  }

  const hostPreset = presets.find((preset) =>
    preset.backendType === provider.type
    && host !== ''
    && host === getProviderHostname(preset.defaultBaseUrl)
    && (!preset.fixedApiFormat || preset.fixedApiFormat === provider.apiFormat),
  );
  if (hostPreset) {
    return hostPreset.key;
  }

  const typePreset = presets.find((preset) => preset.backendType === provider.type && !preset.fixedApiFormat);
  return typePreset?.key || fallbackKey;
};

export const resolvePresetModelSelection = ({
  presetKey,
  presetDefaultModel,
  presetModels,
  valuesModel,
  customModels,
}: ResolvePresetModelSelectionInput): ResolvePresetModelSelectionResult => {
  const isCustomLike = CUSTOM_LIKE_PRESET_KEYS.has(presetKey);
  const resolvedModels = isCustomLike ? (customModels || []) : presetModels;
  if (OPTIONAL_MODEL_PRESET_KEYS.has(presetKey)) {
    return {
      models: resolvedModels,
      model: valuesModel || '',
    };
  }
  const fallbackModel = resolvedModels.length > 0 ? resolvedModels[0] : '';
  return {
    models: resolvedModels,
    model: isCustomLike ? (valuesModel || fallbackModel) : (valuesModel || presetDefaultModel),
  };
};

export const resolvePresetBaseURL = ({
  presetKey,
  presetDefaultBaseUrl,
  presetEndpoints,
  valuesBaseUrl,
}: ResolvePresetBaseURLInput): string => {
  if (CUSTOM_LIKE_PRESET_KEYS.has(presetKey)) {
    return valuesBaseUrl || presetDefaultBaseUrl;
  }
  const valuesFingerprint = getProviderFingerprint(valuesBaseUrl);
  const matchesConfiguredEndpoint = presetEndpoints?.some((endpoint) =>
    valuesFingerprint !== ''
    && valuesFingerprint === getProviderFingerprint(endpoint.baseUrl),
  );
  if (matchesConfiguredEndpoint) {
    return valuesBaseUrl || presetDefaultBaseUrl;
  }
  return presetDefaultBaseUrl;
};

export const resolvePresetTransport = ({
  presetKey,
  presetBackendType,
  presetFixedApiFormat,
  presetEndpoints,
  valuesBaseUrl,
  valuesApiFormat,
}: ResolvePresetTransportInput): ResolvePresetTransportResult => {
  const valuesFingerprint = getProviderFingerprint(valuesBaseUrl);
  const selectedEndpoint = presetEndpoints?.find((endpoint) =>
    valuesFingerprint !== ''
    && valuesFingerprint === getProviderFingerprint(endpoint.baseUrl),
  );
  if (selectedEndpoint) {
    return {
      type: selectedEndpoint.backendType,
      apiFormat: undefined,
    };
  }

  if (presetFixedApiFormat) {
    return {
      type: presetBackendType,
      apiFormat: presetFixedApiFormat,
    };
  }

  if (presetBackendType === 'custom') {
    return {
      type: presetBackendType,
      apiFormat: valuesApiFormat || 'openai',
    };
  }

  if (
    presetBackendType === 'openai'
    && valuesApiFormat === 'openai-responses'
    && (presetKey === undefined || presetKey === 'openai')
  ) {
    return {
      type: presetBackendType,
      apiFormat: 'openai-responses',
    };
  }

  return {
    type: presetBackendType,
    apiFormat: undefined,
  };
};
