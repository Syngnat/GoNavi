import { describe, expect, it } from 'vitest';
import type { AIProviderAuthMode, AIProviderType } from '../types';
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
  isLocalCLISubscriptionProvider,
  matchQwenPresetKey,
  matchDeepSeekPresetKey,
  resolvePresetBaseURL,
  resolvePresetModelSelection,
  resolvePresetTransport,
  resolveProviderPresetKey,
} from './aiProviderPresets';

type PresetMatcher = {
  key: string;
  backendType: AIProviderType;
  defaultBaseUrl: string;
  fixedApiFormat?: string;
  defaultApiFormat?: string;
  authMode?: AIProviderAuthMode;
};

const PRESETS: PresetMatcher[] = [
  { key: 'openai', backendType: 'openai', defaultBaseUrl: 'https://api.openai.com/v1' },
  { key: 'atlascloud', backendType: 'openai', defaultBaseUrl: ATLAS_CLOUD_BASE_URL },
  { key: 'orcarouter', backendType: 'openai', defaultBaseUrl: ORCAROUTER_BASE_URL },
  { key: 'moonshot', backendType: 'openai', defaultBaseUrl: MOONSHOT_OPENAI_BASE_URL },
  { key: 'deepseek', backendType: 'openai', defaultBaseUrl: DEEPSEEK_RESPONSES_BASE_URL, defaultApiFormat: 'openai-responses' },
  { key: 'qwen-bailian', backendType: 'anthropic', defaultBaseUrl: QWEN_BAILIAN_ANTHROPIC_BASE_URL },
  {
    key: 'qwen-coding-plan',
    backendType: 'custom',
    defaultBaseUrl: QWEN_CODING_PLAN_ANTHROPIC_BASE_URL,
    fixedApiFormat: 'claude-cli',
  },
  { key: 'codebuddy', backendType: 'custom', defaultBaseUrl: '', fixedApiFormat: 'codebuddy-cli' },
  { key: 'codex', backendType: 'custom', defaultBaseUrl: '', fixedApiFormat: 'codex-cli', authMode: 'local-cli' },
  { key: 'claude-subscription', backendType: 'custom', defaultBaseUrl: '', fixedApiFormat: 'claude-cli', authMode: 'local-cli' },
  { key: 'cursor', backendType: 'custom', defaultBaseUrl: 'https://api.cursor.com/v1', fixedApiFormat: 'cursor-agent' },
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

  it('keeps local CLI model empty so the signed-in CLI can choose automatically', () => {
    expect(resolvePresetModelSelection({
      presetKey: 'codex',
      presetDefaultModel: '',
      presetModels: [],
      valuesModel: '',
      customModels: ['gpt-5.4'],
    })).toEqual({
      model: '',
      models: ['gpt-5.4'],
    });
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

    expect(key).toBe('qwen-coding-plan');
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

  it('通过本机登录方式识别 Codex 订阅预设', () => {
    expect(resolveProviderPresetKey({
      type: 'custom',
      apiFormat: 'codex-cli',
      authMode: 'local-cli',
      baseUrl: '',
    }, PRESETS, 'custom')).toBe('codex');
  });

  it('区分 Claude 订阅与带端点和密钥的千问 Claude CLI', () => {
    expect(resolveProviderPresetKey({
      type: 'custom',
      apiFormat: 'claude-cli',
      authMode: 'local-cli',
      baseUrl: '',
    }, PRESETS, 'custom')).toBe('claude-subscription');

    expect(resolveProviderPresetKey({
      type: 'custom',
      apiFormat: 'claude-cli',
      authMode: 'api-key',
      baseUrl: QWEN_CODING_PLAN_ANTHROPIC_BASE_URL,
    }, PRESETS, 'custom')).toBe('qwen-coding-plan');
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
