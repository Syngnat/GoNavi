import { describe, expect, it } from 'vitest';
import { findPreset, PROVIDER_PRESETS } from '../components/ai/aiSettingsModalConfig';
import { getProviderEndpointType, getProviderEndpointTypes, resolveProviderEndpointConnection, type ProviderEndpointType } from './aiProviderEndpoints';

describe('provider endpoint compatibility', () => {
  it.each<[ProviderEndpointType, string[]]>([
    ['openai-responses', ['openai', 'deepseek', 'custom']],
    ['openai', ['openai', 'atlascloud', 'orcarouter', 'deepseek', 'qwen-bailian', 'zhipu', 'moonshot', 'xiaomi-mimo', 'volcengine-ark', 'minimax', 'ollama', 'custom']],
    ['anthropic', ['qwen-bailian', 'moonshot', 'xiaomi-mimo', 'anthropic', 'minimax', 'custom']],
    ['gemini', ['gemini', 'custom']],
    ['cli', ['qwen-bailian', 'anthropic', 'grok', 'codebuddy', 'cursor', 'custom']],
    ['cursor-agent', ['cursor', 'custom']],
  ])('offers only implemented %s connections in preset order', (type, expected) => {
    expect(PROVIDER_PRESETS.filter((preset) => getProviderEndpointTypes(preset).includes(type)).map((preset) => preset.key)).toEqual(expected);
  });

  it('does not promise Responses for a compatible Chat URL or direct APIs for a CLI proxy', () => {
    expect(resolveProviderEndpointConnection(findPreset('atlascloud'), 'openai-responses')).toBeUndefined();
    expect(resolveProviderEndpointConnection(findPreset('qwen-bailian'), 'cli')).toEqual({
      type: 'custom', apiFormat: 'claude-cli', baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    });
    expect(resolveProviderEndpointConnection(findPreset('anthropic'), 'cli')).toEqual({
      type: 'custom', apiFormat: 'claude-cli', baseUrl: '',
    });
    expect(resolveProviderEndpointConnection(findPreset('cursor'), 'cli')).toEqual({
      type: 'custom', apiFormat: 'cursor-cli', baseUrl: '',
    });
  });

  it('changes MiniMax protocols within the currently selected region', () => {
    expect(resolveProviderEndpointConnection(findPreset('minimax'), 'openai', 'https://api.minimaxi.com/anthropic/')).toEqual({
      type: 'openai', apiFormat: 'openai', baseUrl: 'https://api.minimaxi.com/v1',
    });
    expect(resolveProviderEndpointConnection(findPreset('minimax'), 'anthropic', 'https://api.minimax.io/v1')).toEqual({
      type: 'anthropic', apiFormat: 'anthropic', baseUrl: 'https://api.minimax.io/anthropic',
    });
  });

  it('changes Xiaomi MiMo protocols without leaving the selected billing endpoint', () => {
    expect(resolveProviderEndpointConnection(findPreset('xiaomi-mimo'), 'openai', 'https://token-plan-cn.xiaomimimo.com/anthropic')).toEqual({
      type: 'openai', apiFormat: 'openai', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    });
    expect(resolveProviderEndpointConnection(findPreset('xiaomi-mimo'), 'anthropic', 'https://api.xiaomimimo.com/v1')).toEqual({
      type: 'anthropic', apiFormat: 'anthropic', baseUrl: 'https://api.xiaomimimo.com/anthropic',
    });
  });

  it('preserves custom URLs and does not interpret a form fallback as the protocol of a native provider', () => {
    expect(resolveProviderEndpointConnection(findPreset('custom'), 'openai-responses', 'https://proxy.example/v2')).toEqual({
      type: 'custom', apiFormat: 'openai-responses', baseUrl: 'https://proxy.example/v2',
    });
    expect(getProviderEndpointType({ type: 'anthropic', apiFormat: 'openai' })).toBe('anthropic');
    expect(getProviderEndpointType({ type: 'gemini', apiFormat: 'openai' })).toBe('gemini');
    expect(getProviderEndpointType({ type: 'custom', apiFormat: 'not-implemented' })).toBeUndefined();
  });
});
