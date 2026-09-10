import React from 'react';
import {
  ApiOutlined,
  AppstoreOutlined,
  CloudOutlined,
  ExperimentOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';

import type {
  AIMCPServerConfig,
  AIProviderAuthMode,
  AIProviderConfig,
  AIProviderType,
  AISkillConfig,
  AIUserPromptSettings,
} from '../../types';
import {
  ATLAS_CLOUD_BASE_URL,
  ATLAS_CLOUD_DEFAULT_MODEL,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_RESPONSES_BASE_URL,
  LEGACY_QWEN_BAILIAN_OPENAI_BASE_URL,
  MOONSHOT_ANTHROPIC_BASE_URL,
  MOONSHOT_OPENAI_BASE_URL,
  ORCAROUTER_BASE_URL,
  ORCAROUTER_DEFAULT_MODEL,
  QWEN_BAILIAN_ANTHROPIC_BASE_URL,
  QWEN_CODING_PLAN_ANTHROPIC_BASE_URL,
  QWEN_CODING_PLAN_MODELS,
  XIAOMI_MIMO_ANTHROPIC_BASE_URL,
  XIAOMI_MIMO_DEFAULT_MODEL,
  XIAOMI_MIMO_OPENAI_BASE_URL,
  XIAOMI_MIMO_TOKEN_PLAN_ANTHROPIC_BASE_URL,
  XIAOMI_MIMO_TOKEN_PLAN_OPENAI_BASE_URL,
  resolveProviderPresetKey,
  type ProviderPresetCandidate,
  type ProviderPresetEndpoint,
  type ProviderPresetMode,
} from '../../utils/aiProviderPresets';

export interface ProviderPreset {
  key: string;
  label: string;
  labelKey: string;
  icon: React.ReactNode;
  desc: string;
  descKey: string;
  color: string;
  backendType: AIProviderType;
  fixedApiFormat?: string;
  defaultApiFormat?: string;
  authMode?: AIProviderAuthMode;
  defaultBaseUrl: string;
  endpoints?: ProviderPresetEndpoint[];
  defaultModel: string;
  models: string[];
  modeLabelKey?: string;
  defaultModeKey?: string;
  modes?: ProviderPresetMode[];
}

export const MINIMAX_ENDPOINTS: ProviderPresetEndpoint[] = [
  { backendType: 'anthropic', baseUrl: 'https://api.minimax.io/anthropic' },
  { backendType: 'anthropic', baseUrl: 'https://api.minimaxi.com/anthropic' },
  { backendType: 'openai', baseUrl: 'https://api.minimax.io/v1' },
  { backendType: 'openai', baseUrl: 'https://api.minimaxi.com/v1' },
];

export const MOONSHOT_ENDPOINTS: ProviderPresetEndpoint[] = [
  { backendType: 'openai', baseUrl: MOONSHOT_OPENAI_BASE_URL },
  { backendType: 'anthropic', baseUrl: MOONSHOT_ANTHROPIC_BASE_URL },
];

export const XIAOMI_MIMO_ENDPOINTS: ProviderPresetEndpoint[] = [
  { backendType: 'openai', baseUrl: XIAOMI_MIMO_OPENAI_BASE_URL },
  { backendType: 'anthropic', baseUrl: XIAOMI_MIMO_ANTHROPIC_BASE_URL },
  { backendType: 'openai', baseUrl: XIAOMI_MIMO_TOKEN_PLAN_OPENAI_BASE_URL },
  { backendType: 'anthropic', baseUrl: XIAOMI_MIMO_TOKEN_PLAN_ANTHROPIC_BASE_URL },
];

export const QWEN_BAILIAN_ENDPOINTS: ProviderPresetEndpoint[] = [
  { backendType: 'anthropic', baseUrl: QWEN_BAILIAN_ANTHROPIC_BASE_URL },
  { backendType: 'openai', baseUrl: LEGACY_QWEN_BAILIAN_OPENAI_BASE_URL },
];

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { key: 'openai', label: 'OpenAI', labelKey: 'ai_settings.provider_preset.openai.label', icon: <ApiOutlined />, desc: 'GPT-5.6 series', descKey: 'ai_settings.provider_preset.openai.desc', color: '#10b981', backendType: 'openai', defaultBaseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5.6', models: [] },
  { key: 'atlascloud', label: 'Atlas Cloud', labelKey: 'ai_settings.provider_preset.atlascloud.label', icon: <CloudOutlined />, desc: 'Qwen3.8 Max / OpenAI-compatible', descKey: 'ai_settings.provider_preset.atlascloud.desc', color: '#0891b2', backendType: 'openai', defaultBaseUrl: ATLAS_CLOUD_BASE_URL, defaultModel: ATLAS_CLOUD_DEFAULT_MODEL, models: [] },
  { key: 'orcarouter', label: 'OrcaRouter', labelKey: 'ai_settings.provider_preset.orcarouter.label', icon: <CloudOutlined />, desc: 'Smart routing to 200+ models / OpenAI-compatible', descKey: 'ai_settings.provider_preset.orcarouter.desc', color: '#0e7490', backendType: 'openai', defaultBaseUrl: ORCAROUTER_BASE_URL, defaultModel: ORCAROUTER_DEFAULT_MODEL, models: [] },
  { key: 'deepseek', label: 'DeepSeek', labelKey: 'ai_settings.provider_preset.deepseek.label', icon: <ThunderboltOutlined />, desc: 'DeepSeek-V4-Flash / Responses and Chat APIs', descKey: 'ai_settings.provider_preset.deepseek.desc', color: '#3b82f6', backendType: 'openai', defaultApiFormat: 'openai-responses', defaultBaseUrl: DEEPSEEK_RESPONSES_BASE_URL, defaultModel: DEEPSEEK_DEFAULT_MODEL, models: [] },
  {
    key: 'qwen-bailian', label: 'Qwen', labelKey: 'ai_settings.provider_preset.qwen_bailian.label', icon: <CloudOutlined />, desc: 'Bailian General / Coding Plan', descKey: 'ai_settings.provider_preset.qwen_bailian.desc', color: '#6366f1',
    backendType: 'anthropic', defaultBaseUrl: QWEN_BAILIAN_ANTHROPIC_BASE_URL, endpoints: QWEN_BAILIAN_ENDPOINTS, defaultModel: '', models: [],
    modeLabelKey: 'ai_settings.form.section.service_type', defaultModeKey: 'bailian', modes: [
      { key: 'bailian', label: 'Qwen (Bailian General)', labelKey: 'ai_settings.provider_mode.qwen_bailian.label', legacyPresetKey: 'qwen-bailian', backendType: 'anthropic', defaultBaseUrl: QWEN_BAILIAN_ANTHROPIC_BASE_URL, endpoints: QWEN_BAILIAN_ENDPOINTS, defaultModel: '', models: [] },
      { key: 'coding-plan', label: 'Qwen (Coding Plan)', labelKey: 'ai_settings.provider_preset.qwen_coding_plan.label', legacyPresetKey: 'qwen-coding-plan', backendType: 'custom', fixedApiFormat: 'claude-cli', defaultBaseUrl: QWEN_CODING_PLAN_ANTHROPIC_BASE_URL, endpoints: [], defaultModel: '', models: QWEN_CODING_PLAN_MODELS },
    ],
  },
  { key: 'zhipu', label: 'Zhipu GLM', labelKey: 'ai_settings.provider_preset.zhipu.label', icon: <ExperimentOutlined />, desc: 'GLM-5.2 models', descKey: 'ai_settings.provider_preset.zhipu.desc', color: '#0ea5e9', backendType: 'openai', defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5.2', models: [] },
  { key: 'moonshot', label: 'Kimi', labelKey: 'ai_settings.provider_preset.moonshot.label', icon: <ExperimentOutlined />, desc: 'Kimi K3 / OpenAI-compatible', descKey: 'ai_settings.provider_preset.moonshot.desc', color: '#0d9488', backendType: 'openai', defaultBaseUrl: MOONSHOT_OPENAI_BASE_URL, endpoints: MOONSHOT_ENDPOINTS, defaultModel: 'kimi-k3', models: [] },
  { key: 'xiaomi-mimo', label: 'Xiaomi MiMo', labelKey: 'ai_settings.provider_preset.xiaomi_mimo.label', icon: <ExperimentOutlined />, desc: 'MiMo-V2.5 series / OpenAI and Anthropic compatible', descKey: 'ai_settings.provider_preset.xiaomi_mimo.desc', color: '#ff6900', backendType: 'openai', defaultBaseUrl: XIAOMI_MIMO_OPENAI_BASE_URL, endpoints: XIAOMI_MIMO_ENDPOINTS, defaultModel: XIAOMI_MIMO_DEFAULT_MODEL, models: [] },
  {
    key: 'anthropic', label: 'Claude', labelKey: 'ai_settings.provider_preset.anthropic.label', icon: <ExperimentOutlined />, desc: 'Claude API / local subscription', descKey: 'ai_settings.provider_preset.anthropic.desc', color: '#d97706',
    backendType: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-5', models: [],
    modeLabelKey: 'ai_settings.form.connection_method', defaultModeKey: 'api', modes: [
      { key: 'api', label: 'API Key', labelKey: 'ai_settings.form.auth_api_key', legacyPresetKey: 'anthropic', backendType: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com', defaultModel: 'claude-sonnet-5', models: [] },
      { key: 'subscription', label: 'Claude Subscription', labelKey: 'ai_settings.provider_preset.claude_subscription.label', legacyPresetKey: 'claude-subscription', backendType: 'custom', fixedApiFormat: 'claude-cli', authMode: 'local-cli', defaultBaseUrl: '', endpoints: [], defaultModel: '', models: [] },
    ],
  },
  { key: 'grok', label: 'Grok Subscription', labelKey: 'ai_settings.provider_preset.grok.label', icon: <ThunderboltOutlined />, desc: 'Local Grok CLI / Grok subscription login', descKey: 'ai_settings.provider_preset.grok.desc', color: '#0f172a', backendType: 'custom', fixedApiFormat: 'grok-cli', authMode: 'local-cli', defaultBaseUrl: '', defaultModel: '', models: [] },
  { key: 'gemini', label: 'Gemini', labelKey: 'ai_settings.provider_preset.gemini.label', icon: <CloudOutlined />, desc: 'Gemini 3.6 Flash', descKey: 'ai_settings.provider_preset.gemini.desc', color: '#059669', backendType: 'gemini', defaultBaseUrl: 'https://generativelanguage.googleapis.com', defaultModel: 'gemini-3.6-flash', models: [] },
  {
    key: 'volcengine-ark', label: 'Volcengine Ark', labelKey: 'ai_settings.provider_preset.volcengine_ark.label', icon: <CloudOutlined />, desc: 'Ark general inference / Coding Plan', descKey: 'ai_settings.provider_preset.volcengine_ark.desc', color: '#0ea5e9',
    backendType: 'openai', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: '', models: [],
    modeLabelKey: 'ai_settings.form.section.service_type', defaultModeKey: 'ark', modes: [
      { key: 'ark', label: 'Volcengine Ark', labelKey: 'ai_settings.provider_preset.volcengine_ark.label', legacyPresetKey: 'volcengine-ark', backendType: 'openai', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: '', models: [] },
      { key: 'coding-plan', label: 'Volcengine Coding Plan', labelKey: 'ai_settings.provider_preset.volcengine_coding.label', legacyPresetKey: 'volcengine-coding', backendType: 'openai', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', defaultModel: '', models: [] },
    ],
  },
  {
    key: 'minimax',
    label: 'MiniMax',
    labelKey: 'ai_settings.provider_preset.minimax.label',
    icon: <ExperimentOutlined />,
    desc: 'M3 / M2.7 series (Anthropic-compatible)',
    descKey: 'ai_settings.provider_preset.minimax.desc',
    color: '#e11d48',
    backendType: 'anthropic',
    defaultBaseUrl: MINIMAX_ENDPOINTS[0].baseUrl,
    endpoints: MINIMAX_ENDPOINTS,
    defaultModel: 'MiniMax-M3',
    models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
  },
  { key: 'codebuddy', label: 'CodeBuddy', labelKey: 'ai_settings.provider_preset.codebuddy.label', icon: <ApiOutlined />, desc: 'Local CodeBuddy CLI / official login session', descKey: 'ai_settings.provider_preset.codebuddy.desc', color: '#2563eb', backendType: 'custom', fixedApiFormat: 'codebuddy-cli', defaultBaseUrl: '', defaultModel: '', models: [] },
  {
    key: 'cursor', label: 'Cursor', labelKey: 'ai_settings.provider_preset.cursor.label', icon: <ApiOutlined />, desc: 'Cloud Agents API / local CLI', descKey: 'ai_settings.provider_preset.cursor.desc', color: '#7c3aed',
    backendType: 'custom', fixedApiFormat: 'cursor-agent', defaultBaseUrl: 'https://api.cursor.com/v1', defaultModel: '', models: [],
    modeLabelKey: 'ai_settings.form.connection_method', defaultModeKey: 'api', modes: [
      { key: 'api', label: 'API Key', labelKey: 'ai_settings.form.auth_api_key', legacyPresetKey: 'cursor', backendType: 'custom', fixedApiFormat: 'cursor-agent', defaultBaseUrl: 'https://api.cursor.com/v1', defaultModel: '', models: [] },
      { key: 'local-cli', label: 'Cursor CLI', labelKey: 'ai_settings.provider_preset.cursor_cli.label', legacyPresetKey: 'cursor-cli', backendType: 'custom', fixedApiFormat: 'cursor-cli', authMode: 'local-cli', defaultBaseUrl: '', endpoints: [], defaultModel: '', models: [] },
    ],
  },
  { key: 'ollama', label: 'Ollama', labelKey: 'ai_settings.provider_preset.ollama.label', icon: <AppstoreOutlined />, desc: 'Locally deployed open-source models', descKey: 'ai_settings.provider_preset.ollama.desc', color: '#78716c', backendType: 'openai', defaultBaseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3', models: [] },
  { key: 'custom', label: 'Custom', labelKey: 'ai_settings.provider_preset.custom.label', icon: <AppstoreOutlined />, desc: 'Custom API endpoint', descKey: 'ai_settings.provider_preset.custom.desc', color: '#64748b', backendType: 'custom', defaultBaseUrl: '', defaultModel: '', models: [] },
];

type ProviderPresetTranslator = (key: string) => string;

export const localizeProviderPreset = (
  preset: ProviderPreset,
  translate: ProviderPresetTranslator,
): ProviderPreset => {
  const label = translate(preset.labelKey);
  const desc = translate(preset.descKey);
  return {
    ...preset,
    label: label && label !== preset.labelKey ? label : preset.label,
    desc: desc && desc !== preset.descKey ? desc : preset.desc,
    modes: preset.modes?.map((mode) => {
      const modeLabel = translate(mode.labelKey);
      return { ...mode, label: modeLabel && modeLabel !== mode.labelKey ? modeLabel : mode.label };
    }),
  };
};

export const localizeProviderPresets = (
  presets: ProviderPreset[],
  translate: ProviderPresetTranslator,
): ProviderPreset[] => presets.map((preset) => localizeProviderPreset(preset, translate));

const PROVIDER_PRESET_KEY_ALIASES: Record<string, string> = {
  codex: 'openai',
  'claude-subscription': 'anthropic',
  'qwen-coding-plan': 'qwen-bailian',
  'volcengine-coding': 'volcengine-ark',
  'cursor-cli': 'cursor',
};

export const normalizeProviderPresetKey = (key: string): string => PROVIDER_PRESET_KEY_ALIASES[key] || key;

export const findPreset = (key: string): ProviderPreset => {
  const normalizedKey = normalizeProviderPresetKey(key);
  return PROVIDER_PRESETS.find((preset) => preset.key === normalizedKey) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
};

export const getProviderPresetMode = (
  preset: ProviderPreset,
  modeKey?: string,
): ProviderPresetMode | undefined => preset.modes?.find((mode) => mode.key === modeKey)
  || preset.modes?.find((mode) => mode.key === preset.defaultModeKey)
  || preset.modes?.[0];

export const matchProviderPreset = (
  provider: ProviderPresetCandidate,
): ProviderPreset => {
  const presetKey = resolveProviderPresetKey(provider, PROVIDER_PRESETS, 'custom');
  return findPreset(presetKey);
};

export const EMPTY_AI_USER_PROMPT_SETTINGS: AIUserPromptSettings = {
  global: '',
  database: '',
  jvm: '',
  jvmDiagnostic: '',
};

export const EMPTY_MCP_SERVER = (seed?: Partial<AIMCPServerConfig>): AIMCPServerConfig => {
  const base: AIMCPServerConfig = {
    id: `mcp-draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    enabled: true,
    timeoutSeconds: 20,
  };
  return {
    ...base,
    ...seed,
    transport: seed?.transport || base.transport,
    args: Array.isArray(seed?.args) ? seed.args : base.args,
    env: seed?.env || base.env,
    enabled: seed?.enabled ?? base.enabled,
    timeoutSeconds: seed?.timeoutSeconds || base.timeoutSeconds,
  };
};

const waitFor = (delayMs: number) => new Promise<void>((resolve) => {
  window.setTimeout(resolve, delayMs);
});

const readAIService = () => (window as any).go?.aiservice?.Service;

export const waitForAIService = async (attempts = 6, delayMs = 80) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const service = readAIService();
    if (service) {
      return service;
    }
    if (attempt < attempts - 1) {
      await waitFor(delayMs);
    }
  }
  return readAIService();
};

export const EMPTY_SKILL = (): AISkillConfig => ({
  id: `skill-draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  name: '',
  description: '',
  systemPrompt: '',
  enabled: true,
  scopes: ['global'],
  requiredTools: [],
});
