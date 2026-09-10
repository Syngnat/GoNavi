import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAIChatRuntimeResources } from './useAIChatRuntimeResources';
const runtimeService = vi.hoisted(() => ({
  AIGetProviders: vi.fn(),
  AIGetActiveProvider: vi.fn(),
  AISaveProvider: vi.fn(),
  AISetActiveProvider: vi.fn(),
  AIListModels: vi.fn(),
  AIListProviderModels: vi.fn(),
  AIGetCLIModelCatalog: vi.fn(),
  AIGetCLICapabilities: vi.fn(),
}));
const windowStub = vi.hoisted(() => ({
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
  setTimeout,
}));

let latestHook: ReturnType<typeof useAIChatRuntimeResources> | undefined;

const flushAsyncWork = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const Harness = () => {
  latestHook = useAIChatRuntimeResources({});
  return null;
};

describe('useAIChatRuntimeResources', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    latestHook = undefined;
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    runtimeService.AIGetProviders.mockResolvedValue([]);
    runtimeService.AIGetActiveProvider.mockResolvedValue('');
    runtimeService.AIListProviderModels.mockResolvedValue({ success: true, models: [] });
    runtimeService.AIGetCLIModelCatalog.mockResolvedValue({ models: [], source: 'none', stale: false });
    runtimeService.AIGetCLICapabilities.mockResolvedValue([]);
    vi.stubGlobal('window', {
      ...windowStub,
      go: {
        aiservice: {
          Service: runtimeService,
        },
      },
    });
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('uses English notice chrome for thrown model load failures while preserving raw detail', async () => {
    runtimeService.AIListModels.mockRejectedValue(new Error('HTTP 401 raw error'));

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await flushAsyncWork();

    await act(async () => {
      await latestHook!.fetchDynamicModels();
    });
    await flushAsyncWork();

    expect(latestHook!.composerNotice).toEqual({
      tone: 'error',
      title: 'Model list failed to load',
      description: 'HTTP 401 raw error',
      action: {
        key: 'reload-models',
        label: 'Reload models',
      },
    });

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('persists the selected model and activates its provider from the composer picker', async () => {
    let activeProviderId = 'provider-openai';
    const providers = [
      { id: 'provider-openai', name: 'OpenAI', type: 'openai', apiKey: '', hasSecret: true, model: 'gpt-5', models: ['gpt-5'] },
      { id: 'provider-grok', name: 'Grok', type: 'custom', apiKey: '', hasSecret: true, model: 'grok-4', models: ['grok-4', 'grok-3'] },
    ];
    runtimeService.AIGetProviders.mockResolvedValue(providers);
    runtimeService.AIGetActiveProvider.mockImplementation(async () => activeProviderId);
    runtimeService.AISaveProvider.mockResolvedValue(undefined);
    runtimeService.AISetActiveProvider.mockImplementation(async (id: string) => { activeProviderId = id; });

    let renderer: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness />); });
    await flushAsyncWork();

    expect(latestHook!.providers.map((item) => item.id)).toEqual(['provider-openai', 'provider-grok']);
    await act(async () => {
      await latestHook!.handleProviderModelChange('provider-grok', 'grok-3');
    });
    expect(runtimeService.AISaveProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'provider-grok', model: 'grok-3', hasSecret: true }));
    expect(runtimeService.AISetActiveProvider).toHaveBeenCalledWith('provider-grok');
    expect(latestHook!.activeProvider).toEqual(expect.objectContaining({ id: 'provider-grok', model: 'grok-3' }));

    await act(async () => { renderer!.unmount(); });
  });

  it('loads models for an inactive provider without changing the active provider', async () => {
    const providers = [
      { id: 'provider-openai', name: 'OpenAI', type: 'openai', apiKey: '', hasSecret: true, model: 'gpt-5', models: [] },
      { id: 'provider-deepseek', name: 'DeepSeek', type: 'openai', apiKey: '', hasSecret: true, model: 'deepseek-v4-flash', models: [] },
    ];
    runtimeService.AIGetProviders.mockResolvedValue(providers);
    runtimeService.AIGetActiveProvider.mockResolvedValue('provider-openai');
    runtimeService.AIListProviderModels.mockResolvedValue({
      success: true,
      models: ['deepseek-v4-flash', 'deepseek-reasoner'],
    });

    let renderer: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness />); });
    await flushAsyncWork();
    await act(async () => { await latestHook!.fetchProviderModels('provider-deepseek'); });

    expect(runtimeService.AIListProviderModels).toHaveBeenCalledWith(expect.objectContaining({ id: 'provider-deepseek' }));
    expect(runtimeService.AISetActiveProvider).not.toHaveBeenCalled();
    expect(latestHook!.providerModels['provider-deepseek']).toEqual(['deepseek-v4-flash', 'deepseek-reasoner']);
    await act(async () => { renderer!.unmount(); });
  });

  it('loads active Codex models and per-model effort capabilities automatically', async () => {
    runtimeService.AIGetProviders.mockResolvedValue([{
      id: 'provider-codex', name: 'Codex', type: 'custom', authMode: 'local-cli', apiFormat: 'codex-cli',
      apiKey: '', baseUrl: '', model: 'gpt-5.6-sol', models: [],
    }]);
    runtimeService.AIGetActiveProvider.mockResolvedValue('provider-codex');
    runtimeService.AIGetCLICapabilities.mockResolvedValue([{
      apiFormat: 'codex-cli', supportsEffort: true, effortValues: ['low', 'high', 'ultra'], defaultEffort: 'low',
    }]);
    runtimeService.AIGetCLIModelCatalog.mockResolvedValue({
      models: ['gpt-5.6-sol', 'gpt-5.6-terra'], source: 'app-server', stale: false,
      defaultModel: 'gpt-5.6-sol',
      modelCapabilities: { 'gpt-5.6-sol': { effortValues: ['low', 'high', 'ultra'], defaultEffort: 'low' } },
    });

    let renderer: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness />); });
    await flushAsyncWork();
    await flushAsyncWork();

    expect(runtimeService.AIGetCLIModelCatalog).toHaveBeenCalledWith(expect.objectContaining({ id: 'provider-codex' }));
    expect(latestHook!.providerModels['provider-codex']).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra']);
    expect(latestHook!.providerCatalogs['provider-codex'].modelCapabilities?.['gpt-5.6-sol'].effortValues)
      .toEqual(['low', 'high', 'ultra']);
    expect(latestHook!.cliCapabilities[0].apiFormat).toBe('codex-cli');
    await act(async () => { renderer!.unmount(); });
  });

  it('uses the default English description when the thrown model load error has no message', async () => {
    runtimeService.AIListModels.mockRejectedValue({});

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
    });
    await flushAsyncWork();

    await act(async () => {
      await latestHook!.fetchDynamicModels();
    });
    await flushAsyncWork();

    expect(latestHook!.composerNotice).toEqual({
      tone: 'error',
      title: 'Model list failed to load',
      description: 'Check the provider endpoint, API Key, or account permissions, then reopen the model dropdown.',
      action: {
        key: 'reload-models',
        label: 'Reload models',
      },
    });

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('does not require a browser window while a detached surface is rendered server-side', async () => {
    vi.unstubAllGlobals();

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Harness />);
      await Promise.resolve();
    });

    await act(async () => {
      renderer!.unmount();
    });
  });
});
