import { describe, expect, it } from 'vitest';
import type { AIProviderAuthMode } from '../types';
import {
  ATLAS_CLOUD_BASE_URL,
  DEEPSEEK_DEFAULT_MODEL,
  DEEPSEEK_RESPONSES_BASE_URL,
  MOONSHOT_ANTHROPIC_BASE_URL,
  MOONSHOT_OPENAI_BASE_URL,
  ORCAROUTER_BASE_URL,
  LEGACY_QWEN_CODING_PLAN_OPENAI_BASE_URL,
  QWEN_BAILIAN_ANTHROPIC_BASE_URL,
  QWEN_BAILIAN_MODELS_BASE_URL,
  QWEN_CODING_PLAN_ANTHROPIC_BASE_URL,
  QWEN_CODING_PLAN_MODELS,
  XIAOMI_MIMO_ANTHROPIC_BASE_URL,
  XIAOMI_MIMO_DEFAULT_MODEL,
  XIAOMI_MIMO_OPENAI_BASE_URL,
  XIAOMI_MIMO_TOKEN_PLAN_ANTHROPIC_BASE_URL,
  XIAOMI_MIMO_TOKEN_PLAN_OPENAI_BASE_URL,
  isLocalCLISubscriptionProvider,
  getSingletonCLIIdentity,
  matchQwenPresetKey,
  matchDeepSeekPresetKey,
  resolvePresetBaseURL,
  resolvePresetModelSelection,
  resolvePresetTransport,
  resolveProviderPresetKey,
  resolveProviderPresetModeKey,
  type ProviderPresetMatcher,
} from './aiProviderPresets';

describe('singleton CLI integrations', () => {
  it.each([
    ['codex-cli', 'local-cli', 'codex-cli'],
    ['claude-cli', 'local-cli', 'claude-cli'],
    ['grok-cli', 'local-cli', 'grok-cli'],
    ['cursor-cli', 'local-cli', 'cursor-cli'],
    ['codebuddy-cli', 'api-key', 'codebuddy-cli'],
    ['claude-cli', 'api-key', ''],
    ['cursor-agent', 'api-key', ''],
    ['openai', 'api-key', ''],
    [' CODEX-CLI ', ' LOCAL-CLI ', 'codex-cli'],
  ])('classifies %s with %s authentication independently of aliases and models', (apiFormat, authMode, expected) => {
    expect(getSingletonCLIIdentity({ type: 'custom', apiFormat, authMode: authMode as AIProviderAuthMode })).toBe(expected);
  });
});

const PRESETS: ProviderPresetMatcher[] = [
  { key: 'openai', backendType: 'openai', defaultBaseUrl: 'https://api.openai.com/v1' },
  { key: 'atlascloud', backendType: 'openai', defaultBaseUrl: ATLAS_CLOUD_BASE_URL },
  { key: 'orcarouter', backendType: 'openai', defaultBaseUrl: ORCAROUTER_BASE_URL },
  { key: 'moonshot', backendType: 'openai', defaultBaseUrl: MOONSHOT_OPENAI_BASE_URL },
  {
    key: 'xiaomi-mimo', backendType: 'openai', defaultBaseUrl: XIAOMI_MIMO_OPENAI_BASE_URL,
    endpoints: [
      { backendType: 'openai', baseUrl: XIAOMI_MIMO_OPENAI_BASE_URL },
      { backendType: 'anthropic', baseUrl: XIAOMI_MIMO_ANTHROPIC_BASE_URL },
      { backendType: 'openai', baseUrl: XIAOMI_MIMO_TOKEN_PLAN_OPENAI_BASE_URL },
      { backendType: 'anthropic', baseUrl: XIAOMI_MIMO_TOKEN_PLAN_ANTHROPIC_BASE_URL },
    ],
  },
  { key: 'deepseek', backendType: 'openai', defaultBaseUrl: DEEPSEEK_RESPONSES_BASE_URL, defaultApiFormat: 'openai-responses' },
  {
    key: 'qwen-bailian', backendType: 'anthropic', defaultBaseUrl: QWEN_BAILIAN_ANTHROPIC_BASE_URL, defaultModeKey: 'bailian',
    modes: [
      { key: 'bailian', label: 'Bailian', labelKey: 'bailian', legacyPresetKey: 'qwen-bailian', backendType: 'anthropic', defaultBaseUrl: QWEN_BAILIAN_ANTHROPIC_BASE_URL, defaultModel: '', models: [] },
      { key: 'coding-plan', label: 'Coding Plan', labelKey: 'coding-plan', legacyPresetKey: 'qwen-coding-plan', backendType: 'custom', defaultBaseUrl: QWEN_CODING_PLAN_ANTHROPIC_BASE_URL, fixedApiFormat: 'claude-cli', defaultModel: '', models: [] },
    ],
  },
  { key: 'codebuddy', backendType: 'custom', defaultBaseUrl: '', fixedApiFormat: 'codebuddy-cli' },
  {
    key: 'anthropic', backendType: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com', defaultModeKey: 'api',
    modes: [
      { key: 'api', label: 'API', labelKey: 'api', legacyPresetKey: 'anthropic', backendType: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com', defaultModel: '', models: [] },
      { key: 'subscription', label: 'Subscription', labelKey: 'subscription', legacyPresetKey: 'claude-subscription', backendType: 'custom', defaultBaseUrl: '', fixedApiFormat: 'claude-cli', authMode: 'local-cli', defaultModel: '', models: [] },
    ],
  },
  {
    key: 'volcengine-ark', backendType: 'openai', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModeKey: 'ark',
    modes: [
      { key: 'ark', label: 'Ark', labelKey: 'ark', legacyPresetKey: 'volcengine-ark', backendType: 'openai', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/v3', defaultModel: '', models: [] },
      { key: 'coding-plan', label: 'Coding Plan', labelKey: 'coding-plan', legacyPresetKey: 'volcengine-coding', backendType: 'openai', defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', defaultModel: '', models: [] },
    ],
  },
  {
    key: 'cursor', backendType: 'custom', defaultBaseUrl: 'https://api.cursor.com/v1', fixedApiFormat: 'cursor-agent', defaultModeKey: 'api',
    modes: [
      { key: 'api', label: 'API', labelKey: 'api', legacyPresetKey: 'cursor', backendType: 'custom', defaultBaseUrl: 'https://api.cursor.com/v1', fixedApiFormat: 'cursor-agent', defaultModel: '', models: [] },
      { key: 'local-cli', label: 'Local CLI', labelKey: 'local-cli', legacyPresetKey: 'cursor-cli', backendType: 'custom', defaultBaseUrl: '', fixedApiFormat: 'cursor-cli', authMode: 'local-cli', defaultModel: '', models: [] },
    ],
  },
  { key: 'custom', backendType: 'custom', defaultBaseUrl: '' },
];

describe('ai provider preset helpers', () => {
  it('maps legacy Bailian compatible-mode URL back to the Bailian preset', () => {
    expect(matchQwenPresetKey({
      type: 'openai',
      baseUrl: QWEN_BAILIAN_MODELS_BASE_URL,
    })).toBe('qwen-bailian');
  });

  it('recognizes DeepSeek Chat and Responses configs as one editable preset', () => {
    expect(matchDeepSeekPresetKey({
      type: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
    })).toBe('deepseek');

    expect(matchDeepSeekPresetKey({
      type: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiFormat: 'openai',
    })).toBe('deepseek');

    expect(resolvePresetTransport({
      presetKey: 'deepseek',
      presetBackendType: 'openai',
      presetDefaultApiFormat: 'openai-responses',
      valuesBaseUrl: 'https://api.deepseek.com/v1',
    })).toEqual({
      type: 'openai',
      apiFormat: 'openai-responses',
    });

    expect(resolvePresetTransport({
      presetKey: 'deepseek',
      presetBackendType: 'openai',
      presetDefaultApiFormat: 'openai-responses',
      valuesBaseUrl: 'https://api.deepseek.com/v1',
      valuesApiFormat: 'openai',
      valuesModel: 'deepseek-v4-flash',
    })).toEqual({
      type: 'openai',
      apiFormat: 'openai',
    });
  });

  it('recognizes current Kimi OpenAI-compatible configs', () => {
    expect(resolveProviderPresetKey({
      type: 'openai',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'kimi-k3',
  }, PRESETS, 'custom')).toBe('moonshot');
  });

  it('keeps Kimi endpoint variants mapped by their actual protocol', () => {
    expect(MOONSHOT_OPENAI_BASE_URL).toBe('https://api.moonshot.cn/v1');
    expect(MOONSHOT_ANTHROPIC_BASE_URL).toBe('https://api.moonshot.cn/anthropic');
  });

  it('recognizes Xiaomi MiMo pay-as-you-go and Token Plan endpoints', () => {
    expect(XIAOMI_MIMO_OPENAI_BASE_URL).toBe('https://api.xiaomimimo.com/v1');
    expect(XIAOMI_MIMO_ANTHROPIC_BASE_URL).toBe('https://api.xiaomimimo.com/anthropic');
    expect(XIAOMI_MIMO_TOKEN_PLAN_OPENAI_BASE_URL).toBe('https://token-plan-cn.xiaomimimo.com/v1');
    expect(XIAOMI_MIMO_TOKEN_PLAN_ANTHROPIC_BASE_URL).toBe('https://token-plan-cn.xiaomimimo.com/anthropic');
    expect(XIAOMI_MIMO_DEFAULT_MODEL).toBe('mimo-v2.5-pro');

    for (const provider of [
      { type: 'openai' as const, baseUrl: XIAOMI_MIMO_OPENAI_BASE_URL },
      { type: 'anthropic' as const, baseUrl: XIAOMI_MIMO_ANTHROPIC_BASE_URL },
      { type: 'openai' as const, baseUrl: XIAOMI_MIMO_TOKEN_PLAN_OPENAI_BASE_URL },
      { type: 'anthropic' as const, baseUrl: XIAOMI_MIMO_TOKEN_PLAN_ANTHROPIC_BASE_URL },
    ]) {
      expect(resolveProviderPresetKey(provider, PRESETS, 'custom')).toBe('xiaomi-mimo');
    }
  });

  it('uses the current DeepSeek Responses endpoint and model as the preset defaults', () => {
    expect(DEEPSEEK_RESPONSES_BASE_URL).toBe('https://api.deepseek.com');
    expect(DEEPSEEK_DEFAULT_MODEL).toBe('deepseek-v4-flash');
  });

  it('maps Coding Plan Claude CLI config back to the dedicated Coding Plan preset', () => {
    expect(matchQwenPresetKey({
      type: 'custom',
      apiFormat: 'claude-cli',
      baseUrl: QWEN_CODING_PLAN_ANTHROPIC_BASE_URL,
    })).toBe('qwen-coding-plan');
  });

  it('maps legacy Coding Plan OpenAI config back to the dedicated Coding Plan preset', () => {
    expect(matchQwenPresetKey({
      type: 'openai',
      baseUrl: LEGACY_QWEN_CODING_PLAN_OPENAI_BASE_URL,
    })).toBe('qwen-coding-plan');
  });

  it('does not treat a custom OpenAI endpoint as the built-in Coding Plan preset', () => {
    expect(matchQwenPresetKey({
      type: 'custom',
      apiFormat: 'openai',
      baseUrl: LEGACY_QWEN_CODING_PLAN_OPENAI_BASE_URL,
    })).toBeNull();
  });

  it('does not keep a baked-in model list for the Coding Plan preset', () => {
    expect(QWEN_CODING_PLAN_MODELS).toEqual([
      'qwen3.5-plus',
      'kimi-k2.5',
      'glm-5',
      'MiniMax-M2.5',
      'qwen3-max-2026-01-23',
      'qwen3-coder-next',
      'qwen3-coder-plus',
      'glm-4.7',
    ]);
  });

  it('keeps built-in preset model empty when the preset intentionally requires an explicit selection', () => {
    expect(resolvePresetModelSelection({
      presetKey: 'qwen-coding-plan',
      presetDefaultModel: '',
      presetModels: QWEN_CODING_PLAN_MODELS,
      valuesModel: '',
      customModels: [],
    })).toEqual({
      model: '',
      models: QWEN_CODING_PLAN_MODELS,
    });
  });

  it('still falls back to the first configured model for custom-like presets', () => {
    expect(resolvePresetModelSelection({
      presetKey: 'custom',
      presetDefaultModel: '',
      presetModels: [],
      valuesModel: '',
      customModels: ['foo-model', 'bar-model'],
    })).toEqual({
      model: 'foo-model',
      models: ['foo-model', 'bar-model'],
    });
  });

  it('keeps Cursor model empty when only a suggested model list is configured', () => {
    expect(resolvePresetModelSelection({
      presetKey: 'cursor',
      presetDefaultModel: '',
      presetModels: [],
      valuesModel: '',
      customModels: ['composer-2', 'composer-latest'],
    })).toEqual({
      model: '',
      models: ['composer-2', 'composer-latest'],
    });
  });

  it.each(['codex', 'cursor-cli'])('keeps %s model empty so the signed-in CLI can choose automatically', (presetKey) => {
    expect(resolvePresetModelSelection({
      presetKey,
      presetDefaultModel: '',
      presetModels: [],
      valuesModel: '',
      customModels: ['gpt-5.4'],
    })).toEqual({
      model: '',
      models: ['gpt-5.4'],
    });
  });

  it('recognizes local Cursor independently of the existing Cursor cloud API', () => {
    const local = { type: 'custom' as const, apiFormat: 'cursor-cli', authMode: 'local-cli' as const, baseUrl: '' };
    expect(isLocalCLISubscriptionProvider(local)).toBe(true);
    expect(resolveProviderPresetKey(local, PRESETS, 'custom')).toBe('cursor');
    expect(resolveProviderPresetModeKey(PRESETS.find((preset) => preset.key === 'cursor')!, local)).toBe('local-cli');
    expect(resolveProviderPresetKey({ type: 'custom', apiFormat: 'cursor-agent', authMode: 'api-key', baseUrl: 'https://api.cursor.com/v1' }, PRESETS, 'custom')).toBe('cursor');
  });

  it('forces built-in presets back to their standard base URL when saving or testing', () => {
    expect(resolvePresetBaseURL({
      presetKey: 'qwen-bailian',
      presetDefaultBaseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
      valuesBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })).toBe('https://dashscope.aliyuncs.com/apps/anthropic');
  });

  it('keeps the user-entered base URL for custom-like presets', () => {
    expect(resolvePresetBaseURL({
      presetKey: 'codebuddy',
      presetDefaultBaseUrl: '',
      valuesBaseUrl: 'https://example-proxy.internal/v1',
    })).toBe('https://example-proxy.internal/v1');
  });

  it('keeps the user-entered base URL for the Cursor preset', () => {
    expect(resolvePresetBaseURL({
      presetKey: 'cursor',
      presetDefaultBaseUrl: 'https://api.cursor.com/v1',
      valuesBaseUrl: 'https://cursor-proxy.internal/v1',
    })).toBe('https://cursor-proxy.internal/v1');
  });

  it('forces qwen coding plan to save as custom plus claude-cli', () => {
    expect(resolvePresetTransport({
      presetBackendType: 'custom',
      presetFixedApiFormat: 'claude-cli',
      valuesApiFormat: 'anthropic',
    })).toEqual({
      type: 'custom',
      apiFormat: 'claude-cli',
    });
  });

  it('keeps custom preset transport editable', () => {
    expect(resolvePresetTransport({
      presetBackendType: 'custom',
      valuesApiFormat: 'gemini',
    })).toEqual({
      type: 'custom',
      apiFormat: 'gemini',
    });
  });

  it('preserves the Responses protocol for the built-in OpenAI preset', () => {
    expect(resolvePresetTransport({
      presetBackendType: 'openai',
      valuesApiFormat: 'openai-responses',
    })).toEqual({
      type: 'openai',
      apiFormat: 'openai-responses',
    });
  });

  it('keeps the legacy OpenAI protocol implicit for existing configurations', () => {
    expect(resolvePresetTransport({
      presetBackendType: 'openai',
      valuesApiFormat: 'openai',
    })).toEqual({
      type: 'openai',
      apiFormat: undefined,
    });
  });

  it('does not carry the Responses protocol into another OpenAI-compatible preset', () => {
    expect(resolvePresetTransport({
      presetKey: 'atlascloud',
      presetBackendType: 'openai',
      valuesApiFormat: 'openai-responses',
    })).toEqual({
      type: 'openai',
      apiFormat: undefined,
    });
  });

  it('defaults the DeepSeek preset to Responses when no format is selected', () => {
    expect(resolvePresetTransport({
      presetKey: 'deepseek',
      presetBackendType: 'openai',
      presetDefaultApiFormat: 'openai-responses',
      valuesBaseUrl: DEEPSEEK_RESPONSES_BASE_URL,
      valuesModel: DEEPSEEK_DEFAULT_MODEL,
    })).toEqual({
      type: 'openai',
      apiFormat: 'openai-responses',
    });
  });

  it('preserves Chat for legacy DeepSeek models without a stored format', () => {
    expect(resolvePresetTransport({
      presetKey: 'deepseek',
      presetBackendType: 'openai',
      presetDefaultApiFormat: 'openai-responses',
      valuesBaseUrl: 'https://api.deepseek.com/v1',
      valuesModel: 'deepseek-chat',
    })).toEqual({
      type: 'openai',
      apiFormat: 'openai',
    });
  });
});

describe('resolveProviderPresetKey', () => {
  it('recognizes Atlas Cloud by its OpenAI-compatible endpoint', () => {
    expect(resolveProviderPresetKey({
      type: 'openai',
      baseUrl: `${ATLAS_CLOUD_BASE_URL}/`,
    }, PRESETS, 'custom')).toBe('atlascloud');
  });

  it('recognizes OrcaRouter by its OpenAI-compatible endpoint', () => {
    expect(resolveProviderPresetKey({
      type: 'openai',
      baseUrl: `${ORCAROUTER_BASE_URL}/`,
    }, PRESETS, 'custom')).toBe('orcarouter');
  });

  it('不会把自定义 OpenAI 端点误识别成千问 Coding Plan', () => {
    const key = resolveProviderPresetKey(
      {
        type: 'custom',
        apiFormat: 'openai',
        baseUrl: LEGACY_QWEN_CODING_PLAN_OPENAI_BASE_URL,
      },
      PRESETS,
      'custom',
    );

    expect(key).toBe('custom');
  });

  it('仍然能识别当前内置的千问 Coding Plan 预设', () => {
    const key = resolveProviderPresetKey(
      {
        type: 'custom',
        apiFormat: 'claude-cli',
        baseUrl: QWEN_CODING_PLAN_ANTHROPIC_BASE_URL,
      },
      PRESETS,
      'custom',
    );

    expect(key).toBe('qwen-bailian');
  });

  it('仍然能识别当前内置的千问百炼预设', () => {
    const key = resolveProviderPresetKey(
      {
        type: 'anthropic',
        apiFormat: undefined,
        baseUrl: QWEN_BAILIAN_ANTHROPIC_BASE_URL,
      },
      PRESETS,
      'custom',
    );

    expect(key).toBe('qwen-bailian');
  });

  it('能识别没有 Base URL 的 CodeBuddy CLI 预设', () => {
    const key = resolveProviderPresetKey(
      {
        type: 'custom',
        apiFormat: 'codebuddy-cli',
        baseUrl: '',
      },
      PRESETS,
      'custom',
    );

    expect(key).toBe('codebuddy');
  });

  it('能识别 Cursor Agent 预设', () => {
    const key = resolveProviderPresetKey(
      {
        type: 'custom',
        apiFormat: 'cursor-agent',
        baseUrl: 'https://api.cursor.com/v1',
      },
      PRESETS,
      'custom',
    );

    expect(key).toBe('cursor');
  });

  it('将本机 Codex 订阅归入 OpenAI 预设', () => {
    expect(resolveProviderPresetKey({
      type: 'custom',
      apiFormat: 'codex-cli',
      authMode: 'local-cli',
      baseUrl: '',
    }, PRESETS, 'custom')).toBe('openai');
  });

  it('区分 Claude 订阅与带端点和密钥的千问 Claude CLI', () => {
    const claudeSubscription = {
      type: 'custom',
      apiFormat: 'claude-cli',
      authMode: 'local-cli',
      baseUrl: '',
    } as const;
    expect(resolveProviderPresetKey(claudeSubscription, PRESETS, 'custom')).toBe('anthropic');
    expect(resolveProviderPresetModeKey(PRESETS.find((preset) => preset.key === 'anthropic')!, claudeSubscription)).toBe('subscription');

    const qwenCodingPlan = {
      type: 'custom',
      apiFormat: 'claude-cli',
      authMode: 'api-key',
      baseUrl: QWEN_CODING_PLAN_ANTHROPIC_BASE_URL,
    } as const;
    expect(resolveProviderPresetKey(qwenCodingPlan, PRESETS, 'custom')).toBe('qwen-bailian');
    expect(resolveProviderPresetModeKey(PRESETS.find((preset) => preset.key === 'qwen-bailian')!, qwenCodingPlan)).toBe('coding-plan');
  });

  it.each([
    ['qwen-bailian', { type: 'anthropic', baseUrl: QWEN_BAILIAN_ANTHROPIC_BASE_URL }, 'bailian'],
    ['qwen-bailian', { type: 'custom', apiFormat: 'claude-cli', baseUrl: QWEN_CODING_PLAN_ANTHROPIC_BASE_URL }, 'coding-plan'],
    ['anthropic', { type: 'anthropic', baseUrl: 'https://api.anthropic.com' }, 'api'],
    ['anthropic', { type: 'custom', apiFormat: 'claude-cli', authMode: 'local-cli', baseUrl: '' }, 'subscription'],
    ['volcengine-ark', { type: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }, 'ark'],
    ['volcengine-ark', { type: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3' }, 'coding-plan'],
    ['cursor', { type: 'custom', apiFormat: 'cursor-agent', baseUrl: 'https://api.cursor.com/v1' }, 'api'],
    ['cursor', { type: 'custom', apiFormat: 'cursor-cli', authMode: 'local-cli', baseUrl: '' }, 'local-cli'],
  ] as const)('maps %s saved transport to its %s mode', (presetKey, provider, expectedMode) => {
    const preset = PRESETS.find((item) => item.key === presetKey)!;
    expect(resolveProviderPresetKey(provider, PRESETS, 'custom')).toBe(presetKey);
    expect(resolveProviderPresetModeKey(preset, provider)).toBe(expectedMode);
  });

  it('does not reclassify a legacy Claude CLI API-key provider as a subscription', () => {
    expect(resolveProviderPresetKey({
      type: 'custom',
      apiFormat: 'claude-cli',
      baseUrl: '',
      hasSecret: true,
    }, PRESETS, 'custom')).toBe('custom');

    expect(resolveProviderPresetKey({
      type: 'custom',
      apiFormat: 'claude-cli',
      baseUrl: '',
      apiKey: 'legacy-key',
    }, PRESETS, 'custom')).toBe('custom');
  });

  it('only recognizes supported custom CLI transports as local subscriptions', () => {
    expect(isLocalCLISubscriptionProvider({
      type: 'custom',
      apiFormat: 'codex-cli',
      authMode: 'local-cli',
    })).toBe(true);
    expect(isLocalCLISubscriptionProvider({
      type: 'openai',
      apiFormat: 'codex-cli',
      authMode: 'local-cli',
    })).toBe(false);
    expect(isLocalCLISubscriptionProvider({
      type: 'custom',
      apiFormat: 'openai',
      authMode: 'local-cli',
    })).toBe(false);
  });
});
