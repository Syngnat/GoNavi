import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAIChatRuntimeResources } from './useAIChatRuntimeResources';
import { notifyBuiltinAILoginWake } from './builtinAILogin';
import {
  acceptBuiltinAITerms,
  declineBuiltinAITerms,
  getBuiltinAITermsPromptOpen,
  resetBuiltinAITermsStore,
} from './builtinTerms/builtinAITermsStore';

// Node has no localStorage; the usage rules are remembered in this one.
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.has(key) ? this.data.get(key)! : null; }
  key(index: number): string | null { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
}
const runtimeService = vi.hoisted(() => ({
  AIGetProviders: vi.fn(),
  AIGetActiveProvider: vi.fn(),
  AIGetBuiltinAIStatus: vi.fn(),
  AIStartBuiltinAILogin: vi.fn(),
  AIPollBuiltinAILogin: vi.fn(),
  AISaveProvider: vi.fn(),
  AISetActiveProvider: vi.fn(),
  AIListModels: vi.fn(),
  AIListProviderModels: vi.fn(),
  AIGetCLIModelCatalog: vi.fn(),
  AIGetCLICapabilities: vi.fn(),
  AIGetModelContextProfile: vi.fn(),
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
    vi.stubGlobal('localStorage', new MemoryStorage());
    resetBuiltinAITermsStore();
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    runtimeService.AIGetProviders.mockResolvedValue([]);
    runtimeService.AIGetActiveProvider.mockResolvedValue('');
    runtimeService.AIGetBuiltinAIStatus.mockResolvedValue(undefined);
    runtimeService.AIListProviderModels.mockResolvedValue({ success: true, models: [] });
    runtimeService.AIGetCLIModelCatalog.mockResolvedValue({ models: [], source: 'none', stale: false });
    runtimeService.AIGetCLICapabilities.mockResolvedValue([]);
    runtimeService.AIGetModelContextProfile.mockResolvedValue({ defaultWindow: 258000, options: [258000] });
    vi.stubGlobal('window', {
      ...windowStub,
      go: {
        aiservice: {
          Service: runtimeService,
        },
      },
    });
  });

  const builtinProvider = {
    id: 'gonavi-ai', name: 'GoNavi AI', type: 'custom', authMode: 'bearer', apiFormat: 'openai',
    hasSecret: true, baseUrl: 'https://ai.syngnat.top/v1', model: 'gonavi-sql', models: ['gonavi-sql'],
  };

  it('uses the built-in provider exactly as the backend completed it', async () => {
    runtimeService.AIGetProviders.mockResolvedValue([builtinProvider]);
    runtimeService.AIGetActiveProvider.mockResolvedValue('gonavi-ai');

    let renderer: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness />); });
    await flushAsyncWork();

    expect(latestHook!.activeProvider).toEqual(builtinProvider);
    // Readiness must not depend on a second, front-end-only status call.
    expect(runtimeService.AIGetBuiltinAIStatus).not.toHaveBeenCalled();
    await act(async () => { renderer!.unmount(); });
  });

  it('signs in from the composer without opening a browser when the login is still valid', async () => {
    runtimeService.AIGetProviders.mockResolvedValue([{ ...builtinProvider, hasSecret: false }]);
    runtimeService.AIGetActiveProvider.mockResolvedValue('gonavi-ai');
    runtimeService.AIGetBuiltinAIStatus.mockResolvedValue({ authenticated: true, state: 'ready' });

    let renderer: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness />); });
    await flushAsyncWork();
    windowStub.dispatchEvent.mockClear();

    await act(async () => { latestHook!.handleComposerAction('builtin-login'); });
    await flushAsyncWork();

    expect(runtimeService.AIStartBuiltinAILogin).not.toHaveBeenCalled();
    expect(windowStub.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'gonavi:ai:provider-changed' }));
    await act(async () => { renderer!.unmount(); });
  });

  it('keeps a retryable login notice when the device login cannot start', async () => {
    runtimeService.AIGetProviders.mockResolvedValue([{ ...builtinProvider, hasSecret: false }]);
    runtimeService.AIGetActiveProvider.mockResolvedValue('gonavi-ai');
    runtimeService.AIGetBuiltinAIStatus.mockResolvedValue({ authenticated: false, state: 'login_required' });
    runtimeService.AIStartBuiltinAILogin.mockRejectedValue(new Error('gateway unreachable'));
    acceptBuiltinAITerms(); // the rules were accepted earlier; this test is about the sign-in failing

    let renderer: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness />); });
    await flushAsyncWork();

    await act(async () => { latestHook!.handleComposerAction('builtin-login'); });
    await flushAsyncWork();

    expect(latestHook!.composerNotice).toEqual(expect.objectContaining({
      tone: 'error',
      description: 'gateway unreachable',
      action: expect.objectContaining({ key: 'builtin-login' }),
    }));
    await act(async () => { renderer!.unmount(); });
  });

  describe('the usage rules before the first sign-in', () => {
    const signedOut = () => {
      runtimeService.AIGetProviders.mockResolvedValue([{ ...builtinProvider, hasSecret: false }]);
      runtimeService.AIGetActiveProvider.mockResolvedValue('gonavi-ai');
      runtimeService.AIGetBuiltinAIStatus.mockResolvedValue({ authenticated: false, state: 'login_required' });
      runtimeService.AIStartBuiltinAILogin.mockResolvedValue({
        deviceCode: 'dev-1', userCode: 'ABCD-EFGH', verificationUri: 'https://ai.example/device', expiresInSeconds: 600, intervalSeconds: 5,
      });
      runtimeService.AIPollBuiltinAILogin.mockResolvedValue({ status: 'authorized', authenticated: true });
    };

    it('shows the rules first and starts no sign-in until they are accepted', async () => {
      signedOut();
      let renderer: ReactTestRenderer;
      await act(async () => { renderer = create(<Harness />); });
      await flushAsyncWork();

      await act(async () => { latestHook!.handleComposerAction('builtin-login'); });
      await flushAsyncWork();
      expect(getBuiltinAITermsPromptOpen()).toBe(true);
      expect(runtimeService.AIStartBuiltinAILogin).not.toHaveBeenCalled();

      await act(async () => { acceptBuiltinAITerms(); });
      await flushAsyncWork();
      expect(runtimeService.AIStartBuiltinAILogin).toHaveBeenCalledTimes(1);
      await act(async () => { renderer!.unmount(); });
    });

    it('shows the device code while the browser step is open and clears it once signed in', async () => {
      signedOut();
      acceptBuiltinAITerms();
      let finishPoll: (value: unknown) => void = () => undefined;
      runtimeService.AIPollBuiltinAILogin.mockReturnValue(new Promise((resolve) => { finishPoll = resolve; }));
      let renderer: ReactTestRenderer;
      await act(async () => { renderer = create(<Harness />); });
      await flushAsyncWork();

      let login!: Promise<void>;
      await act(async () => { login = Promise.resolve(latestHook!.handleComposerAction('builtin-login')); });
      await flushAsyncWork();
      expect(latestHook!.composerNotice?.description).toContain('ABCD-EFGH');

      // The browser sends the person back: the wait ends at once and the poll answers.
      await act(async () => {
        notifyBuiltinAILoginWake();
        finishPoll({ status: 'authorized', authenticated: true });
        await login;
      });
      await flushAsyncWork();
      expect(latestHook!.composerNotice).toBeNull();
      await act(async () => { renderer!.unmount(); });
    });

    it('leaves the person signed out, with no error, when they decline', async () => {
      signedOut();
      let renderer: ReactTestRenderer;
      await act(async () => { renderer = create(<Harness />); });
      await flushAsyncWork();

      await act(async () => { latestHook!.handleComposerAction('builtin-login'); });
      await flushAsyncWork();
      await act(async () => { declineBuiltinAITerms(); });
      await flushAsyncWork();

      expect(runtimeService.AIStartBuiltinAILogin).not.toHaveBeenCalled();
      expect(latestHook!.composerNotice?.tone).not.toBe('error');
      await act(async () => { renderer!.unmount(); });
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

  it('loads the model context profile for the active model but does not write it from the chat', async () => {
    const provider = { id: 'provider-openai', name: 'OpenAI', type: 'openai', apiKey: '', hasSecret: true, model: 'gpt-5', contextWindow: 500_000 };
    runtimeService.AIGetProviders.mockResolvedValue([provider]);
    runtimeService.AIGetActiveProvider.mockResolvedValue('provider-openai');
    runtimeService.AISaveProvider.mockResolvedValue(undefined);
    runtimeService.AIGetModelContextProfile.mockResolvedValue({ defaultWindow: 1_000_000, options: [500_000, 1_000_000] });

    let renderer: ReactTestRenderer;
    await act(async () => { renderer = create(<Harness />); });
    await flushAsyncWork();

    expect(runtimeService.AIGetModelContextProfile).toHaveBeenCalledWith(expect.objectContaining({ id: 'provider-openai', model: 'gpt-5' }));
    expect(latestHook!.modelContextProfile).toEqual({ defaultWindow: 1_000_000, options: [500_000, 1_000_000] });
    // 档位在供应商设置里改；聊天面板只读，不暴露修改入口。
    expect(latestHook).not.toHaveProperty('handleContextWindowChange');
    expect(runtimeService.AISaveProvider).not.toHaveBeenCalled();

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
