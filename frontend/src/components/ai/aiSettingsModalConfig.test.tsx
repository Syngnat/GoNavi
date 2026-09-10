import { describe, expect, it } from 'vitest';

import {
  ATLAS_CLOUD_BASE_URL,
  ATLAS_CLOUD_DEFAULT_MODEL,
  ORCAROUTER_BASE_URL,
  ORCAROUTER_DEFAULT_MODEL,
  QWEN_CODING_PLAN_ANTHROPIC_BASE_URL,
  XIAOMI_MIMO_DEFAULT_MODEL,
  XIAOMI_MIMO_OPENAI_BASE_URL,
  resolvePresetBaseURL,
  resolveProviderPresetModeKey,
  resolvePresetTransport,
} from '../../utils/aiProviderPresets';
import { t as translateCatalog } from '../../i18n/catalog';
import {
  EMPTY_MCP_SERVER,
  EMPTY_SKILL,
  MINIMAX_ENDPOINTS,
  PROVIDER_PRESETS,
  XIAOMI_MIMO_ENDPOINTS,
  findPreset,
  getProviderPresetMode,
  localizeProviderPresets,
  matchProviderPreset,
} from './aiSettingsModalConfig';

describe('aiSettingsModalConfig', () => {

  it('finds the matching preset and falls back to custom when the key is unknown', () => {
    expect(findPreset('openai').label).toBe('OpenAI');
    expect(findPreset('missing-preset').key).toBe('custom');
  });

  it('matches DeepSeek to an editable preset with Responses as the default', () => {
    const preset = matchProviderPreset({
      type: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
    });

    expect(preset).toMatchObject({
      key: 'deepseek',
      defaultApiFormat: 'openai-responses',
      defaultBaseUrl: 'https://api.deepseek.com',
      defaultModel: 'deepseek-v4-flash',
    });
  });

  it('matches legacy DeepSeek Chat Completions configs to the editable preset', () => {
    expect(matchProviderPreset({
      type: 'openai',
      apiFormat: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    }).key).toBe('deepseek');
  });

  it('uses stable Gemini and Kimi OpenAI-compatible defaults', () => {
    expect(findPreset('gemini')).toMatchObject({
      defaultModel: 'gemini-3.6-flash',
    });
    expect(findPreset('moonshot')).toMatchObject({
      backendType: 'openai',
      defaultBaseUrl: 'https://api.moonshot.cn/v1',
      defaultModel: 'kimi-k3',
    });
    expect(matchProviderPreset({
      type: 'anthropic',
      baseUrl: 'https://api.moonshot.cn/anthropic',
    }).key).toBe('moonshot');
  });

  it('matches an anthropic-compatible Coding Plan config back to the merged Qwen provider', () => {
    const provider = {
      type: 'custom' as const,
      baseUrl: QWEN_CODING_PLAN_ANTHROPIC_BASE_URL,
      apiFormat: 'claude-cli',
    };
    const preset = matchProviderPreset({
      ...provider,
    });

    expect(preset.key).toBe('qwen-bailian');
    expect(resolveProviderPresetModeKey(preset, provider)).toBe('coding-plan');
  });

  it('matches a CodeBuddy CLI provider back to the dedicated preset', () => {
    const preset = matchProviderPreset({
      type: 'custom',
      baseUrl: '',
      apiFormat: 'codebuddy-cli',
    });

    expect(preset.key).toBe('codebuddy');
  });

  it('matches a Cursor Agent provider back to the dedicated preset', () => {
    const preset = matchProviderPreset({
      type: 'custom',
      baseUrl: 'https://api.cursor.com/v1',
      apiFormat: 'cursor-agent',
    });

    expect(preset.key).toBe('cursor');
  });

  it('keeps Cursor API and local CLI as modes of one provider', () => {
    const preset = findPreset('cursor-cli');
    expect(preset.key).toBe('cursor');
    expect(getProviderPresetMode(preset, 'local-cli')).toMatchObject({
      backendType: 'custom', fixedApiFormat: 'cursor-cli', authMode: 'local-cli', defaultBaseUrl: '', defaultModel: '', models: [],
    });
    const provider = { type: 'custom' as const, apiFormat: 'cursor-cli', authMode: 'local-cli' as const, baseUrl: '' };
    expect(matchProviderPreset(provider).key).toBe('cursor');
    expect(resolveProviderPresetModeKey(preset, provider)).toBe('local-cli');
  });

  it('exposes and recognizes the Atlas Cloud preset', () => {
    const preset = findPreset('atlascloud');

    expect(preset).toMatchObject({
      label: 'Atlas Cloud',
      backendType: 'openai',
      defaultBaseUrl: ATLAS_CLOUD_BASE_URL,
      defaultModel: ATLAS_CLOUD_DEFAULT_MODEL,
    });
    expect(matchProviderPreset({
      type: 'openai',
      baseUrl: ATLAS_CLOUD_BASE_URL,
    }).key).toBe('atlascloud');
  });

  it('exposes and recognizes the OrcaRouter preset', () => {
    const preset = findPreset('orcarouter');

    expect(preset).toMatchObject({
      label: 'OrcaRouter',
      backendType: 'openai',
      defaultBaseUrl: ORCAROUTER_BASE_URL,
      defaultModel: ORCAROUTER_DEFAULT_MODEL,
    });
    expect(matchProviderPreset({
      type: 'openai',
      baseUrl: ORCAROUTER_BASE_URL,
    }).key).toBe('orcarouter');
  });

  it('exposes Xiaomi MiMo with current official endpoints and model', () => {
    const preset = findPreset('xiaomi-mimo');

    expect(preset).toMatchObject({
      label: 'Xiaomi MiMo',
      backendType: 'openai',
      defaultBaseUrl: XIAOMI_MIMO_OPENAI_BASE_URL,
      defaultModel: XIAOMI_MIMO_DEFAULT_MODEL,
    });
    expect(XIAOMI_MIMO_ENDPOINTS).toEqual([
      { backendType: 'openai', baseUrl: 'https://api.xiaomimimo.com/v1' },
      { backendType: 'anthropic', baseUrl: 'https://api.xiaomimimo.com/anthropic' },
      { backendType: 'openai', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' },
      { backendType: 'anthropic', baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic' },
    ]);

    for (const endpoint of XIAOMI_MIMO_ENDPOINTS) {
      expect(matchProviderPreset({ type: endpoint.backendType, baseUrl: endpoint.baseUrl }).key).toBe('xiaomi-mimo');
    }
  });

  it('supports every configured MiniMax region and protocol endpoint', () => {
    const preset = findPreset('minimax');

    expect(preset.defaultBaseUrl).toBe('https://api.minimax.io/anthropic');
    expect(MINIMAX_ENDPOINTS).toEqual([
      { backendType: 'anthropic', baseUrl: 'https://api.minimax.io/anthropic' },
      { backendType: 'anthropic', baseUrl: 'https://api.minimaxi.com/anthropic' },
      { backendType: 'openai', baseUrl: 'https://api.minimax.io/v1' },
      { backendType: 'openai', baseUrl: 'https://api.minimaxi.com/v1' },
    ]);

    for (const endpoint of MINIMAX_ENDPOINTS) {
      expect(matchProviderPreset({
        type: endpoint.backendType,
        baseUrl: endpoint.baseUrl,
      }).key).toBe('minimax');
    }

    const selectedBaseUrl = 'https://api.minimaxi.com/v1';
    expect(resolvePresetBaseURL({
      presetKey: preset.key,
      presetDefaultBaseUrl: preset.defaultBaseUrl,
      presetEndpoints: preset.endpoints,
      valuesBaseUrl: selectedBaseUrl,
    })).toBe(selectedBaseUrl);
    expect(resolvePresetTransport({
      presetKey: preset.key,
      presetBackendType: preset.backendType,
      presetEndpoints: preset.endpoints,
      valuesBaseUrl: selectedBaseUrl,
    })).toEqual({
      type: 'openai',
      apiFormat: undefined,
    });
  });

  it('matches local Codex under OpenAI and Claude subscription under the merged Claude provider', () => {
    expect(matchProviderPreset({
      type: 'custom',
      baseUrl: '',
      apiFormat: 'codex-cli',
      authMode: 'local-cli',
    }).key).toBe('openai');
    const provider = {
      type: 'custom',
      baseUrl: '',
      apiFormat: 'claude-cli',
      authMode: 'local-cli',
    } as const;
    const preset = matchProviderPreset(provider);
    expect(preset.key).toBe('anthropic');
    expect(resolveProviderPresetModeKey(preset, provider)).toBe('subscription');
  });

  it('preserves a legacy Claude CLI provider that still owns an API secret', () => {
    expect(matchProviderPreset({
      type: 'custom',
      baseUrl: '',
      apiFormat: 'claude-cli',
      hasSecret: true,
    }).key).toBe('custom');
  });

  it('creates MCP server drafts and skill drafts with stable defaults', () => {
    const server = EMPTY_MCP_SERVER({ name: 'Browser', args: ['stdio'] });
    const skill = EMPTY_SKILL();

    expect(server.transport).toBe('stdio');
    expect(server.timeoutSeconds).toBe(20);
    expect(server.args).toEqual(['stdio']);
    expect(skill.enabled).toBe(true);
    expect(skill.scopes).toEqual(['global']);
  });

  it('keeps the provider preset list available for the settings modal', () => {
    expect(PROVIDER_PRESETS.some((item) => item.key === 'atlascloud')).toBe(true);
    expect(PROVIDER_PRESETS.some((item) => item.key === 'orcarouter')).toBe(true);
    expect(PROVIDER_PRESETS.some((item) => item.key === 'xiaomi-mimo')).toBe(true);
    expect(PROVIDER_PRESETS.some((item) => item.key === 'codex')).toBe(false);
    expect(PROVIDER_PRESETS.some((item) => item.key === 'claude-subscription')).toBe(false);
    expect(PROVIDER_PRESETS.some((item) => item.key === 'qwen-coding-plan')).toBe(false);
    expect(PROVIDER_PRESETS.some((item) => item.key === 'volcengine-coding')).toBe(false);
    expect(PROVIDER_PRESETS.some((item) => item.key === 'cursor-cli')).toBe(false);
    expect(PROVIDER_PRESETS.some((item) => item.key === 'codebuddy')).toBe(true);
    expect(PROVIDER_PRESETS.some((item) => item.key === 'cursor')).toBe(true);
    expect(PROVIDER_PRESETS.some((item) => item.key === 'openai')).toBe(true);
    expect(PROVIDER_PRESETS.some((item) => item.key === 'custom')).toBe(true);
  });

  it('localizes provider preset card copy through existing catalog keys', () => {
    const localized = localizeProviderPresets(PROVIDER_PRESETS, (key) => translateCatalog('en-US', key));
    const qwen = localized.find((item) => item.key === 'qwen-bailian');
    const custom = localized.find((item) => item.key === 'custom');

    expect(qwen).toMatchObject({
      label: 'Qwen',
      desc: 'Bailian General / Coding Plan',
    });
    expect(qwen?.modes?.map((mode) => mode.label)).toEqual(['Qwen (Bailian General)', 'Qwen (Coding Plan)']);
    expect(custom).toMatchObject({
      label: 'Custom',
      desc: 'Custom API endpoint',
    });
    expect(localized.find((item) => item.key === 'codebuddy')).toMatchObject({
      label: 'CodeBuddy',
      desc: 'Local CodeBuddy CLI / official login session',
    });
    expect(localized.find((item) => item.key === 'cursor')).toMatchObject({
      label: 'Cursor',
      desc: 'Cloud Agents API / local CLI',
    });
    expect(localized.find((item) => item.key === 'cursor')?.modes?.[1]).toMatchObject({ label: 'Cursor CLI', authMode: 'local-cli' });
    expect(localized.find((item) => item.key === 'anthropic')).toMatchObject({
      label: 'Claude', desc: 'Claude API / local subscription',
    });
    expect(localized.find((item) => item.key === 'anthropic')?.modes?.[1]).toMatchObject({ label: 'Claude Subscription', authMode: 'local-cli' });
    expect(localized.find((item) => item.key === 'minimax')).toMatchObject({
      desc: 'M3 / M2.7 series (Anthropic-compatible)',
    });
    expect(localized.find((item) => item.key === 'xiaomi-mimo')).toMatchObject({
      label: 'Xiaomi MiMo',
      desc: 'MiMo-V2.5 series / OpenAI and Anthropic compatible',
    });
  });

  it('keeps provider preset source copy behind catalog keys', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.labelKey).toMatch(/^ai_settings\.provider_preset\.[a-z0-9_]+\.label$/);
      expect(preset.descKey).toMatch(/^ai_settings\.provider_preset\.[a-z0-9_]+\.desc$/);
    }

    [
      '通义千问（百炼通用）',
      '百炼 Anthropic 兼容 / 模型从远端拉取',
      '通义千问（Coding Plan）',
      'Claude Code CLI 代理链路 / 使用官方支持模型清单',
      '智谱 GLM',
      'Kimi K3 / OpenAI 兼容',
      'Gemini 3.6 Flash',
      '火山方舟',
      'Ark 通用推理 / 豆包模型',
      '火山 Coding Plan',
      '本地 CodeBuddy CLI / 官方登录态',
      'Cloud Agents API / 官方 API Key',
      '本地部署开源模型',
      '自定义',
      '自定义 API 端点',
    ].forEach((legacyCopy) => {
    });
  });
});
