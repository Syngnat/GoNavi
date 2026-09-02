import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import type { ProviderEndpointType } from '../utils/aiProviderEndpoints';

const mocks = vi.hoisted(() => ({
  values: {} as Record<string, any>,
  listeners: new Set<() => void>(),
  form: {
    resetFields: vi.fn(), setFieldsValue: vi.fn(), setFieldValue: vi.fn(),
    getFieldsValue: vi.fn(), getFieldValue: vi.fn(), validateFields: vi.fn(),
  },
  service: {
    AIGetProviders: vi.fn(), AIGetActiveProvider: vi.fn(), AIGetEditableProvider: vi.fn(),
    AISetActiveProvider: vi.fn(), AISaveProvider: vi.fn(), AIDeleteProvider: vi.fn(), AITestProvider: vi.fn(),
    AIGetMCPClientInstallStatuses: vi.fn(), AIGetMCPServers: vi.fn(), AIListMCPTools: vi.fn(), AIGetMCPHTTPServerStatus: vi.fn(),
    AIGetRunPolicy: vi.fn(), AISaveRunPolicy: vi.fn(), AIGetAgentLedgerStatus: vi.fn(),
  },
  resolve: vi.fn(),
  messages: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
  modal: { confirm: vi.fn() },
  providerProps: {} as any,
  runPolicyProps: {} as any,
  sidebarProps: {} as any,
}));

vi.mock('antd', async () => {
  const { useSyncExternalStore } = await import('react');
  const Form = Object.assign(() => null, {
    useForm: () => [mocks.form],
    useWatch: (name: string) => useSyncExternalStore(
      (listener) => { mocks.listeners.add(listener); return () => { mocks.listeners.delete(listener); }; },
      () => mocks.values[name],
    ),
  });
  return { Form, message: { useMessage: () => [mocks.messages, null] } };
});
vi.mock('../i18n/provider', async () => {
  const { t } = await import('../i18n/catalog');
  const translate = (key: string, params?: any) => t('en-US', key, params);
  return { useI18n: () => ({ t: translate }) };
});
vi.mock('../store', () => ({ useStore: (select: any) => select({ aiChatOpenMode: 'dock', setAIChatOpenMode: vi.fn() }) }));
vi.mock('./ai/aiSettingsModalConfig', async (original) => ({ ...await original<object>(), waitForAIService: mocks.resolve }));
vi.mock('./ai/AISettingsProvidersSection', () => ({ default: (props: any) => { mocks.providerProps = props; return null; } }));
vi.mock('./ai/AISettingsSidebar', async (original) => ({ ...await original<object>(), default: (props: any) => { mocks.sidebarProps = props; return null; } }));
vi.mock('./ai/AIBuiltinToolsCatalog', () => ({ default: () => null }));
vi.mock('./ai/AISettingsMCPSection', () => ({ default: () => null }));
vi.mock('./ai/AISettingsSafetySection', () => ({ default: () => null }));
vi.mock('./ai/AISettingsContextSection', () => ({ default: () => null }));
vi.mock('./ai/AISettingsRunPolicySection', () => ({ default: (props: any) => { mocks.runPolicyProps = props; return null; } }));
vi.mock('./ai/AISettingsPromptsSection', () => ({ default: () => null }));
vi.mock('./ai/AISettingsSkillsSection', () => ({ default: () => null }));
vi.mock('./common/ResizableDraggableModal', () => ({ default: Object.assign(() => null, { useModal: () => [mocks.modal, null] }) }));

import { AISettingsContent } from './AISettingsModal';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const providers = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: `Alias ${id}`, type: 'custom', apiFormat: 'codex-cli', authMode: 'local-cli', apiKey: '', model: '', models: [] }));
const passed = { success: true, message: 'Local sign-in checked; model response not verified', checkKind: 'local-auth', modelVerified: false };
const capability = { apiFormat: 'codex-cli', defaultModel: 'configured-model', defaultEffort: 'high', supportsEffort: true, effortValues: ['low', 'high'] };
const theme = buildOverlayWorkbenchTheme(false);
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const change = (patch: Record<string, unknown>) => {
  mocks.form.setFieldsValue(patch);
  mocks.providerProps.onValuesChange(patch);
};

describe('AISettingsContent provider async behavior', () => {
  let renderer: ReactTestRenderer | undefined;
  const mount = async (active = true, focusProviderId?: string, onLeaveGuardChange?: (guard: any) => void) => {
    await act(async () => { renderer = create(<AISettingsContent active={active} darkMode={false} overlayTheme={theme} focusProviderId={focusProviderId} onLeaveGuardChange={onLeaveGuardChange} confirmationZIndex={25200} />); });
    await flush();
  };
  const edit = async (index = 0) => { await act(async () => { await mocks.providerProps.onEditProvider(providers[index]); }); };
  const editAPI = async () => {
    const api = { id: 'api', name: 'Origin', type: 'custom', apiFormat: 'openai', authMode: 'api-key',
      baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', hasSecret: true,
      headers: { 'X-Api-Key': 'fixture-header', 'X-Team': 'fixture' }, model: 'default', models: ['default', 'sql', 'hidden'],
      customModels: ['mine'], disabledModels: ['hidden'], inlineCompletionModel: 'sql', maxTokens: 1024, temperature: 0.2 };
    mocks.service.AIGetProviders.mockResolvedValue([...providers, api, { ...api, id: 'prior-copy', name: 'Origin · Copy' }]);
    mocks.service.AIGetEditableProvider.mockImplementation(async (id) => id === api.id ? api : providers.find((provider) => provider.id === id));
    await mount();
    await act(async () => { await mocks.providerProps.onEditProvider(api); });
    return api;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.values = {};
    mocks.listeners.clear();
    mocks.runPolicyProps = {};
    const publish = () => mocks.listeners.forEach((listener) => listener());
    mocks.form.resetFields.mockImplementation(() => { mocks.values = {}; publish(); });
    mocks.form.setFieldsValue.mockImplementation((patch) => { mocks.values = { ...mocks.values, ...patch }; publish(); });
    mocks.form.setFieldValue.mockImplementation((key, value) => mocks.form.setFieldsValue({ [key]: value }));
    mocks.form.getFieldValue.mockImplementation((key) => mocks.values[key]);
    mocks.form.getFieldsValue.mockImplementation(() => ({ ...mocks.values }));
    mocks.form.validateFields.mockImplementation(async () => ({ ...mocks.values }));
    mocks.resolve.mockResolvedValue(mocks.service);
    mocks.modal.confirm.mockImplementation((options) => { options.onOk(); return { destroy: vi.fn() }; });
    mocks.service.AIGetProviders.mockResolvedValue(providers);
    mocks.service.AIGetActiveProvider.mockResolvedValue('a');
    mocks.service.AIGetEditableProvider.mockImplementation(async (id) => providers.find((provider) => provider.id === id));
    mocks.service.AITestProvider.mockResolvedValue(passed);
    mocks.service.AIGetMCPClientInstallStatuses.mockResolvedValue([]);
    mocks.service.AIGetMCPServers.mockResolvedValue([]);
    mocks.service.AIListMCPTools.mockResolvedValue([]);
    mocks.service.AIGetMCPHTTPServerStatus.mockResolvedValue({});
    mocks.service.AIGetRunPolicy.mockResolvedValue({
      schemaVersion: 1,
      revision: 7,
      policy: {
        defaultDispatchMode: 'queue', softToolRoundLimit: 10, maxToolRounds: 15,
        maxConsecutiveFailedToolRounds: 3, maxToolNudges: 2, maxModelRetriesPerTurn: 1,
        maxActiveDuration: 30 * 60 * 1_000_000_000, modelTurnTimeout: 0,
        modelIdleTimeout: 0, defaultToolTimeout: 0, maxTotalTokens: 0,
        maxToolResultBytes: 1024 * 1024,
      },
      runtime: {
        controlPollInterval: 200_000_000,
        workspaceSnapshotRenewInterval: 5_000_000_000,
        workspaceSnapshotLeaseDuration: 15_000_000_000,
        policyWatchInterval: 500_000_000,
      },
    });
    mocks.service.AIGetAgentLedgerStatus.mockResolvedValue({ state: 'ready' });
    mocks.service.AISaveRunPolicy.mockImplementation(async (request) => ({
      schemaVersion: 1,
      revision: request.expectedRevision + 1,
      policy: request.policy,
      runtime: request.runtime,
    }));
    vi.stubGlobal('window', { go: { aiservice: { Service: mocks.service } }, dispatchEvent: vi.fn() });
    vi.stubGlobal('CustomEvent', class { constructor(public type: string) {} });
  });
  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it('loads providers without starting MCP detection; detection is lazy and does not block providers', async () => {
    mocks.service.AIGetMCPClientInstallStatuses.mockReturnValue(deferred().promise);
    await mount();
    expect(mocks.providerProps.providers).toHaveLength(4);
    expect(mocks.providerProps.providersLoading).toBe(false);
    expect(mocks.service.AIGetMCPClientInstallStatuses).not.toHaveBeenCalled();
    expect(mocks.service.AIListMCPTools).not.toHaveBeenCalled();
    await act(async () => { mocks.sidebarProps.onSelectSection('mcp'); });
    expect(mocks.service.AIGetMCPClientInstallStatuses).toHaveBeenCalledTimes(1);
    expect(mocks.providerProps.providers).toHaveLength(4);
    await act(async () => { mocks.sidebarProps.onSelectSection('providers'); });
    expect(mocks.service.AIGetMCPClientInstallStatuses).toHaveBeenCalledTimes(1);
  });

  it('loads and saves the shared run policy lazily, retaining explicit zero limits', async () => {
    await mount();
    expect(mocks.service.AIGetRunPolicy).not.toHaveBeenCalled();
    expect(mocks.service.AIGetAgentLedgerStatus).not.toHaveBeenCalled();

    mocks.service.AIGetAgentLedgerStatus.mockResolvedValueOnce({ state: 'locked' });
    await act(async () => { mocks.sidebarProps.onSelectSection('run_policy'); });
    await flush();
    expect(mocks.service.AIGetRunPolicy).toHaveBeenCalledTimes(1);
    expect(mocks.service.AIGetAgentLedgerStatus).toHaveBeenCalledTimes(1);
    expect(mocks.runPolicyProps.ledgerState).toBe('locked');
    expect(mocks.runPolicyProps.policy).toMatchObject({
      maxActiveDuration: 30 * 60 * 1_000_000_000,
      modelTurnTimeout: 0,
      modelIdleTimeout: 0,
      defaultToolTimeout: 0,
      maxTotalTokens: 0,
    });
    expect(mocks.runPolicyProps.runtime).toEqual({
      controlPollInterval: 200_000_000,
      workspaceSnapshotRenewInterval: 5_000_000_000,
      workspaceSnapshotLeaseDuration: 15_000_000_000,
      policyWatchInterval: 500_000_000,
    });

    await act(async () => {
      mocks.runPolicyProps.onChange({
        ...mocks.runPolicyProps.policy,
        defaultDispatchMode: 'steer',
        modelTurnTimeout: 0,
        modelIdleTimeout: 0,
        defaultToolTimeout: 0,
        maxTotalTokens: 0,
      });
    });
    await act(async () => { mocks.runPolicyProps.onSave(); await Promise.resolve(); await Promise.resolve(); });

    expect(mocks.service.AISaveRunPolicy).toHaveBeenCalledWith({
      expectedRevision: 7,
      policy: expect.objectContaining({
        defaultDispatchMode: 'steer',
        modelTurnTimeout: 0,
        modelIdleTimeout: 0,
        defaultToolTimeout: 0,
        maxTotalTokens: 0,
      }),
      runtime: {
        controlPollInterval: 200_000_000,
        workspaceSnapshotRenewInterval: 5_000_000_000,
        workspaceSnapshotLeaseDuration: 15_000_000_000,
        policyWatchInterval: 500_000_000,
      },
    });
  });

  it('serializes writes and coalesces B → C → D to B then D, marking only acknowledged state', async () => {
    const first = deferred<void>(); const last = deferred<void>();
    mocks.service.AISetActiveProvider.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    await mount();
    await act(async () => { void mocks.providerProps.onSetActiveProvider('b'); });
    await act(async () => { void mocks.providerProps.onSetActiveProvider('c'); void mocks.providerProps.onSetActiveProvider('d'); });
    expect(mocks.service.AISetActiveProvider.mock.calls).toEqual([['b']]);
    expect(mocks.providerProps.activeProviderId).toBe('a');
    expect(mocks.providerProps.pendingProviderId).toBe('d');
    await act(async () => { first.resolve(); });
    expect(mocks.service.AISetActiveProvider.mock.calls).toEqual([['b'], ['d']]);
    expect(mocks.providerProps.activeProviderId).toBe('b');
    await act(async () => { last.resolve(); });
    expect(mocks.providerProps.activeProviderId).toBe('d');
    expect(mocks.providerProps.pendingProviderId).toBe('');
    expect(mocks.service.AITestProvider).not.toHaveBeenCalled();
    expect(mocks.messages.success).toHaveBeenCalledTimes(1);
  });

  it('can return to the original provider while another switch is in flight', async () => {
    const first = deferred<void>();
    mocks.service.AISetActiveProvider.mockReturnValueOnce(first.promise);
    await mount();
    await act(async () => { void mocks.providerProps.onSetActiveProvider('b'); });
    await act(async () => { void mocks.providerProps.onSetActiveProvider('a'); });
    await act(async () => { first.resolve(); });
    expect(mocks.service.AISetActiveProvider.mock.calls).toEqual([['b'], ['a']]);
    expect(mocks.providerProps.activeProviderId).toBe('a');
  });

  it('preserves the confirmed active provider on persistence failure and permits a retry', async () => {
    mocks.service.AISetActiveProvider.mockRejectedValueOnce(new Error('disk write failed'));
    await mount();
    await act(async () => { await mocks.providerProps.onSetActiveProvider('b'); });
    expect(mocks.providerProps.activeProviderId).toBe('a');
    expect(mocks.messages.error).toHaveBeenCalledWith('disk write failed');
    expect(window.dispatchEvent).not.toHaveBeenCalled();
    await act(async () => { await mocks.providerProps.onSetActiveProvider('c'); });
    expect(mocks.providerProps.activeProviderId).toBe('c');
  });

  it('ignores an older provider reload that completes after a switch', async () => {
    await mount();
    const oldList = deferred<any[]>(); const oldCurrent = deferred<string>();
    mocks.service.AIGetProviders.mockReturnValueOnce(oldList.promise);
    mocks.service.AIGetActiveProvider.mockReturnValueOnce(oldCurrent.promise);
    await act(async () => { mocks.providerProps.onReloadProviders(); });
    await act(async () => { await mocks.providerProps.onSetActiveProvider('b'); });
    await act(async () => { oldList.resolve(providers); oldCurrent.resolve('a'); });
    expect(mocks.providerProps.activeProviderId).toBe('b');
    expect(mocks.providerProps.providersLoading).toBe(false);
  });

  it('never changes the current marker just to focus a provider', async () => {
    await mount(true, 'b');
    expect(mocks.providerProps.activeProviderId).toBe('a');
    expect(mocks.service.AISetActiveProvider).not.toHaveBeenCalled();
  });

  it('clears loading when a read started during a switch is superseded by its commit', async () => {
    const switching = deferred<void>(); const stale = deferred<any[]>();
    mocks.service.AISetActiveProvider.mockReturnValueOnce(switching.promise);
    await mount();
    await act(async () => { void mocks.providerProps.onSetActiveProvider('b'); });
    mocks.service.AIGetProviders.mockReturnValueOnce(stale.promise);
    await act(async () => { mocks.providerProps.onReloadProviders(); });
    expect(mocks.providerProps.providersLoading).toBe(true);
    await act(async () => { switching.resolve(); });
    expect(mocks.providerProps.providersLoading).toBe(false);
    await act(async () => { stale.resolve(providers); });
    expect(mocks.providerProps.activeProviderId).toBe('b');
  });

  it('shows a load error rather than an empty-provider success when the bridge is missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.resolve.mockResolvedValue(null);
    await mount();
    expect(mocks.providerProps.loadError).toContain('bridge is unavailable');
    expect(mocks.providerProps.providersLoading).toBe(false);
    expect(mocks.service.AIGetProviders).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('reports an unavailable bridge instead of claiming a successful switch, test, or save', async () => {
    await mount(); await edit();
    mocks.resolve.mockResolvedValue(null);
    await act(async () => { await mocks.providerProps.onSetActiveProvider('b'); await mocks.providerProps.onTestProvider(); await mocks.providerProps.onSaveProvider(); });
    expect(mocks.providerProps.activeProviderId).toBe('a');
    expect(mocks.providerProps.testStatus).toBe('error');
    expect(mocks.providerProps.isEditing).toBe(true);
    expect(mocks.service.AISetActiveProvider).not.toHaveBeenCalled();
    expect(mocks.service.AITestProvider).not.toHaveBeenCalled();
    expect(mocks.service.AISaveProvider).not.toHaveBeenCalled();
    expect(mocks.messages.success).not.toHaveBeenCalled();
  });

  it.each(['parameters', 'preset', 'cancel', 'another provider', 'close'] as const)('discards a test response after changing %s', async (kind) => {
    const check = deferred<typeof passed>();
    mocks.service.AITestProvider.mockReturnValue(check.promise);
    await mount(); await edit();
    await act(async () => { void mocks.providerProps.onTestProvider(); });
    expect(mocks.providerProps.testing).toBe(true);
    await act(async () => {
      if (kind === 'parameters') change({ model: 'changed' });
      if (kind === 'preset') mocks.providerProps.onPresetChange('grok');
      if (kind === 'cancel') mocks.providerProps.onCancelEdit();
      if (kind === 'another provider') await mocks.providerProps.onEditProvider(providers[1]);
      if (kind === 'close') renderer!.update(<AISettingsContent active={false} darkMode={false} overlayTheme={theme} />);
    });
    await act(async () => { check.resolve(passed); });
    expect(mocks.providerProps.testStatus).toBe('idle');
    expect(mocks.providerProps.testResult).toBeNull();
    expect(mocks.providerProps.testing).toBe(false);
  });

  it('invalidates a successful check on edits and refuses a legacy unscoped success', async () => {
    await mount(); await edit();
    await act(async () => { await mocks.providerProps.onTestProvider(); });
    expect(mocks.providerProps.testStatus).toBe('success');
    expect(mocks.providerProps.testResult.modelVerified).toBe(false);
    await act(async () => { change({ effort: 'low' }); });
    expect(mocks.providerProps.testStatus).toBe('idle');
    mocks.service.AITestProvider.mockResolvedValue({ success: true, message: 'connected' });
    await act(async () => { await mocks.providerProps.onTestProvider(); });
    expect(mocks.providerProps.testStatus).toBe('error');
    expect(mocks.providerProps.testResult.message).toContain('scope');
  });

  it('keeps test and save loading independent and discards the old test after saving a fresh editor session', async () => {
    const check = deferred<typeof passed>(); const save = deferred<void>();
    mocks.service.AITestProvider.mockReturnValue(check.promise);
    mocks.service.AISaveProvider.mockReturnValue(save.promise);
    await mount(); await edit();
    await act(async () => { void mocks.providerProps.onTestProvider(); });
    expect(mocks.providerProps.testing).toBe(true);
    expect(mocks.providerProps.loading).toBe(false);
    await act(async () => { void mocks.providerProps.onSaveProvider(); });
    expect(mocks.providerProps.loading).toBe(true);
    expect(mocks.providerProps.testing).toBe(true);
    await act(async () => { save.resolve(); });
    await act(async () => { check.resolve(passed); });
    expect(mocks.providerProps.isEditing).toBe(true);
    expect(mocks.providerProps.dirty).toBe(false);
    expect(mocks.providerProps.testStatus).toBe('idle');
  });

  it('preserves aliases for built-in providers and uses the preset label when a new alias is blank', async () => {
    await mount();
    await act(async () => { await mocks.providerProps.onAddProvider(); change({ apiKey: 'fixture-key', name: 'My OpenAI Alias' }); });
    await act(async () => { await mocks.providerProps.onSaveProvider(); });
    expect(mocks.service.AISaveProvider.mock.calls[0][0].name).toBe('My OpenAI Alias');
    await edit();
    await act(async () => { await mocks.providerProps.onSaveProvider(); });
    expect(mocks.service.AISaveProvider.mock.calls[1][0].name).toBe('Alias a');
    await act(async () => { await mocks.providerProps.onAddProvider(); change({ apiKey: 'fixture-key', name: '' }); });
    await act(async () => { await mocks.providerProps.onSaveProvider(); });
    expect(mocks.service.AISaveProvider.mock.calls[2][0].name).toBe('OpenAI');
  });

  it('prefills only new untouched CLI fields and clears incompatible effort on preset changes', async () => {
    await mount();
    await act(async () => { await mocks.providerProps.onAddProvider('grok'); });
    await act(async () => { mocks.providerProps.onCLIDefaults({ ...capability, apiFormat: 'grok-cli' }); });
    expect(mocks.values).toMatchObject({ model: 'configured-model', effort: 'high' });
    await act(async () => { mocks.providerProps.onPresetChange('claude-subscription'); });
    expect(mocks.values.effort).toBeUndefined();
    await act(async () => { change({ model: 'typed-model', effort: '' }); });
    await act(async () => { mocks.providerProps.onCLIDefaults({ ...capability, apiFormat: 'claude-cli' }); });
    expect(mocks.values).toMatchObject({ model: 'typed-model', effort: '' });
    await act(async () => { change({ model: '' }); mocks.providerProps.onCLIDefaults({ ...capability, apiFormat: 'claude-cli' }); });
    expect(mocks.values.model).toBe('');
    await edit();
    await act(async () => { mocks.providerProps.onCLIDefaults(capability); });
    expect(mocks.values.model).toBe('');
  });

  it('preserves unmounted saved fields and explicitly clears effort when leaving a CLI preset', async () => {
    mocks.service.AIGetEditableProvider.mockResolvedValue({ ...providers[0], maxTokens: 8192, temperature: 0.25, effort: 'high' });
    await mount(); await edit();
    mocks.form.validateFields.mockResolvedValueOnce({ presetKey: 'codex', name: 'Renamed alias' });
    await act(async () => { await mocks.providerProps.onSaveProvider(); });
    expect(mocks.service.AISaveProvider.mock.calls[0][0]).toMatchObject({ maxTokens: 8192, temperature: 0.25, effort: 'high', name: 'Renamed alias' });
    await edit();
    await act(async () => { mocks.providerProps.onPresetChange('openai'); change({ apiKey: 'fixture-key' }); });
    mocks.form.validateFields.mockResolvedValueOnce({ presetKey: 'openai', apiKey: 'fixture-key' });
    await act(async () => { await mocks.providerProps.onSaveProvider(); });
    expect(mocks.service.AISaveProvider.mock.calls[1][0].effort).toBe('');
  });

  it('ignores a late editable-provider fetch when a new edit session has started', async () => {
    const old = deferred<any>();
    mocks.service.AIGetEditableProvider.mockReturnValueOnce(old.promise);
    await mount();
    await act(async () => { void mocks.providerProps.onEditProvider(providers[0]); });
    await act(async () => { await mocks.providerProps.onAddProvider(); });
    await act(async () => { old.resolve(providers[0]); });
    expect(mocks.providerProps.editingProvider.id).toBe('');
  });

  it('does not dispatch a test after its pending form validation becomes stale', async () => {
    const validation = deferred<Record<string, unknown>>();
    await mount(); await edit();
    mocks.form.validateFields.mockReturnValueOnce(validation.promise);
    await act(async () => { void mocks.providerProps.onTestProvider(); });
    await act(async () => { mocks.providerProps.onCancelEdit(); });
    await act(async () => { validation.resolve({ presetKey: 'codex' }); });
    expect(mocks.service.AITestProvider).not.toHaveBeenCalled();
  });

  it('does not open a duplicate CLI draft or convert another draft to an existing CLI', async () => {
    await mount();
    await act(async () => { await mocks.providerProps.onAddProvider('codex'); });
    expect(mocks.providerProps.isEditing).toBe(false);
    expect(mocks.messages.error).toHaveBeenCalledWith(expect.stringContaining('already added'));
    await act(async () => { await mocks.providerProps.onAddProvider('openai'); change({ name: 'API draft', apiKey: 'fixture-key' }); });
    const draft = { ...mocks.values };
    await act(async () => { mocks.providerProps.onPresetChange('codex'); });
    expect(mocks.values).toEqual(draft);
    expect(mocks.service.AISaveProvider).not.toHaveBeenCalled();
    expect(mocks.service.AITestProvider).not.toHaveBeenCalled();
  });

  it('rejects duplicate CLI payloads from stale form data before saving or checking', async () => {
    await mount();
    await act(async () => {
      await mocks.providerProps.onAddProvider();
      change({ presetKey: 'codex', type: 'custom', apiFormat: 'codex-cli', authMode: 'local-cli' });
    });
    await act(async () => { await mocks.providerProps.onSaveProvider(); await mocks.providerProps.onTestProvider(); });
    expect(mocks.service.AISaveProvider).not.toHaveBeenCalled();
    expect(mocks.service.AITestProvider).not.toHaveBeenCalled();
    expect(mocks.providerProps.isEditing).toBe(true);
    expect(mocks.providerProps.testResult.message).toContain('already added');
  });

  it('still creates another configuration for an already added API provider', async () => {
    mocks.service.AIGetProviders.mockResolvedValue([...providers,
      { id: 'api-saved', type: 'openai', name: 'Existing API', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1' },
    ]);
    await mount();
    await act(async () => { await mocks.providerProps.onAddProvider('openai'); change({ name: 'Another API', apiKey: 'fixture-key' }); });
    await act(async () => { await mocks.providerProps.onSaveProvider(); });
    expect(mocks.service.AISaveProvider).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringMatching(/^provider-/), name: 'Another API', type: 'openai' }));
  });

  it('keeps the open draft while an existing provider becomes the default', async () => {
    const pending = deferred<void>();
    mocks.service.AISetActiveProvider.mockReturnValue(pending.promise);
    await mount(); await edit();
    await act(async () => { change({ name: 'Unsaved alias' }); void mocks.providerProps.onSetActiveProvider('b'); });
    expect(mocks.providerProps.activeProviderId).toBe('a');
    expect(mocks.values.name).toBe('Unsaved alias');
    await act(async () => { pending.resolve(); });
    expect(mocks.providerProps.activeProviderId).toBe('b');
    expect(mocks.providerProps.editingProvider.id).toBe('a');
    expect(mocks.values.name).toBe('Unsaved alias');
    expect(mocks.service.AITestProvider).not.toHaveBeenCalled();
    expect(mocks.service.AISaveProvider).not.toHaveBeenCalled();
  });

  it.each([false, true])('acknowledges deletion without closing a newer editor (new editor: %s)', async (openAnotherEditor) => {
    const deleting = deferred<void>();
    mocks.service.AIDeleteProvider.mockReturnValue(deleting.promise);
    await mount(); await edit(1);
    await act(async () => { void mocks.providerProps.onDeleteProvider('b'); });
    expect(mocks.providerProps.isEditing).toBe(true);
    if (openAnotherEditor) await edit(2);
    mocks.service.AIGetProviders.mockResolvedValue(providers.filter((provider) => provider.id !== 'b'));
    await act(async () => { deleting.resolve(); });
    await flush();
    expect(mocks.providerProps.providers.map((provider: any) => provider.id)).toEqual(['a', 'c', 'd']);
    expect(mocks.providerProps.isEditing).toBe(openAnotherEditor);
    if (openAnotherEditor) {
      expect(mocks.providerProps.editingProvider.id).toBe('c');
      expect(mocks.values.name).toBe('Alias c');
    }
  });

  it.each<[string, ProviderEndpointType, string, string | undefined, string]>([
    ['openai', 'openai-responses', 'openai', 'openai-responses', 'https://api.openai.com/v1'],
    ['deepseek', 'openai', 'openai', 'openai', 'https://api.deepseek.com'],
    ['deepseek', 'openai-responses', 'openai', 'openai-responses', 'https://api.deepseek.com'],
    ['moonshot', 'anthropic', 'anthropic', undefined, 'https://api.moonshot.cn/anthropic'],
    ['moonshot', 'openai', 'openai', undefined, 'https://api.moonshot.cn/v1'],
    ['minimax', 'openai', 'openai', undefined, 'https://api.minimax.io/v1'],
    ['minimax', 'anthropic', 'anthropic', undefined, 'https://api.minimax.io/anthropic'],
    ['qwen-bailian', 'openai', 'openai', undefined, 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
    ['qwen-bailian', 'anthropic', 'anthropic', undefined, 'https://dashscope.aliyuncs.com/apps/anthropic'],
    ['qwen-coding-plan', 'cli', 'custom', 'claude-cli', 'https://coding.dashscope.aliyuncs.com/apps/anthropic'],
    ['gemini', 'gemini', 'gemini', undefined, 'https://generativelanguage.googleapis.com'],
    ['cursor', 'cursor-agent', 'custom', 'cursor-agent', 'https://api.cursor.com/v1'],
  ])('tests and saves %s using the chosen %s endpoint', async (presetKey, endpoint, type, apiFormat, baseUrl) => {
    await mount();
    await act(async () => { await mocks.providerProps.onAddProvider(presetKey, endpoint); });
    expect(mocks.values).toMatchObject({ presetKey, type, baseUrl });
    await act(async () => { change({ apiKey: 'fixture-key', model: 'user-selected-model' }); });
    await act(async () => { await mocks.providerProps.onTestProvider(); });
    const expected = { type, apiFormat, baseUrl, model: 'user-selected-model', apiKey: 'fixture-key' };
    expect(mocks.service.AITestProvider).toHaveBeenCalledWith(expect.objectContaining(expected));
    await act(async () => { await mocks.providerProps.onSaveProvider(); });
    expect(mocks.service.AISaveProvider).toHaveBeenCalledWith(expect.objectContaining(expected));
    expect(mocks.service.AISetActiveProvider).not.toHaveBeenCalled();
  });

  it('preserves vendor fields but invalidates a pending check when its endpoint changes', async () => {
    const pending = deferred<typeof passed>();
    mocks.service.AITestProvider.mockReturnValueOnce(pending.promise);
    await mount();
    await act(async () => { await mocks.providerProps.onAddProvider('minimax', 'anthropic'); });
    await act(async () => { change({ baseUrl: 'https://api.minimaxi.com/anthropic', name: 'My model alias', model: 'pinned-model', models: ['favorite'], apiKey: 'fixture-key', maxTokens: 800, temperature: 0.2 }); });
    await act(async () => { void mocks.providerProps.onTestProvider(); });
    expect(mocks.providerProps.testing).toBe(true);
    await act(async () => { mocks.providerProps.onPresetChange('minimax', 'openai'); });
    expect(mocks.values).toMatchObject({ type: 'openai', apiFormat: 'openai', baseUrl: 'https://api.minimaxi.com/v1', name: 'My model alias', model: 'pinned-model', models: ['favorite'], apiKey: 'fixture-key', maxTokens: 800, temperature: 0.2 });
    await act(async () => { pending.resolve(passed); });
    expect(mocks.providerProps.testStatus).toBe('idle');
    expect(mocks.providerProps.testResult).toBeNull();
    expect(mocks.providerProps.testing).toBe(false);
    await act(async () => { await mocks.providerProps.onSaveProvider(); });
    expect(mocks.service.AISaveProvider).toHaveBeenCalledWith(expect.objectContaining({ type: 'openai', baseUrl: 'https://api.minimaxi.com/v1', model: 'pinned-model', name: 'My model alias', maxTokens: 800, temperature: 0.2 }));
  });

  it('retains a saved Bailian Chat endpoint instead of silently converting it to Messages', async () => {
    const saved = { id: 'bailian', name: 'Existing alias', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: '', hasSecret: true, model: 'saved-model' };
    mocks.service.AIGetEditableProvider.mockResolvedValue(saved);
    await mount();
    await act(async () => { await mocks.providerProps.onEditProvider(saved); });
    expect(mocks.values).toMatchObject({ presetKey: 'qwen-bailian', type: 'openai', apiFormat: 'openai', baseUrl: saved.baseUrl, model: 'saved-model' });
    await act(async () => { await mocks.providerProps.onSaveProvider(); });
    expect(mocks.service.AISaveProvider).toHaveBeenCalledWith(expect.objectContaining({ type: 'openai', baseUrl: saved.baseUrl, name: 'Existing alias', model: 'saved-model', apiKey: '', hasSecret: true }));
  });

  it('does not carry a Responses format into a Chat-only preset and rejects incompatible pairs', async () => {
    await mount();
    await act(async () => { await mocks.providerProps.onAddProvider('openai', 'openai-responses'); });
    const previous = { ...mocks.values };
    await act(async () => { mocks.providerProps.onPresetChange('qwen-coding-plan', 'openai'); });
    expect(mocks.values).toEqual(previous);
    await act(async () => { mocks.providerProps.onPresetChange('zhipu', 'openai'); });
    expect(mocks.values).toMatchObject({ presetKey: 'zhipu', type: 'openai', apiFormat: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' });
    expect(mocks.service.AITestProvider).not.toHaveBeenCalled();
    expect(mocks.service.AISaveProvider).not.toHaveBeenCalled();
  });

  it('saves an API copy with independent preferences and credentials without modifying the source or default', async () => {
    const original = await editAPI();
    await act(async () => change({ customModels: ['mine', 'copy-model'], disabledModels: ['hidden', 'mine'] }));
    await act(async () => { await mocks.providerProps.onSaveProviderAsCopy(); });
    const saved = mocks.service.AISaveProvider.mock.calls[0][0];
    expect(saved).toMatchObject({ name: 'Origin · Copy 2', model: 'default', inlineCompletionModel: 'sql', apiKey: 'fixture-key', headers: original.headers,
      maxTokens: 1024, temperature: 0.2, customModels: ['mine', 'copy-model'], disabledModels: ['hidden', 'mine'] });
    expect(saved.id).toMatch(/^provider-/);
    expect(saved.id).not.toBe(original.id);
    expect(saved.secretRef).toBeUndefined();
    expect(original).toMatchObject({ name: 'Origin', customModels: ['mine'], disabledModels: ['hidden'] });
    expect(mocks.service.AISetActiveProvider).not.toHaveBeenCalled();
    expect(mocks.providerProps.activeProviderId).toBe('a');
    expect(mocks.providerProps.editingProvider.id).toBe(saved.id);
    expect(mocks.providerProps.dirty).toBe(false);
  });

  it('leaves the original dirty draft open if saving a copy fails', async () => {
    await editAPI();
    mocks.service.AISaveProvider.mockRejectedValue(new Error('disk full'));
    await act(async () => change({ name: 'Unsaved draft' }));
    await act(async () => { await mocks.providerProps.onSaveProviderAsCopy(); });
    expect(mocks.providerProps.editingProvider.id).toBe('api');
    expect(mocks.values.name).toBe('Unsaved draft');
    expect(mocks.providerProps.dirty).toBe(true);
    expect(mocks.messages.error).toHaveBeenCalledWith('disk full');
    expect(mocks.service.AISetActiveProvider).not.toHaveBeenCalled();
  });

  it('refuses copies when source credentials cannot be resolved, and refuses CLI copies', async () => {
    await editAPI();
    mocks.service.AIGetEditableProvider.mockRejectedValueOnce(new Error('credentials unavailable'));
    await act(async () => { await mocks.providerProps.onSaveProviderAsCopy(); });
    expect(mocks.service.AISaveProvider).not.toHaveBeenCalled();
    expect(mocks.providerProps.editingProvider.id).toBe('api');
    await edit();
    await act(async () => { await mocks.providerProps.onSaveProviderAsCopy(); });
    expect(mocks.service.AISaveProvider).not.toHaveBeenCalled();
    expect(mocks.messages.error).toHaveBeenLastCalledWith(expect.stringContaining('existing CLI'));
  });

  it('rejects disabled defaults and SQL models before any save and preserves optional metadata on an ordinary save', async () => {
    await editAPI();
    for (const model of ['default', 'sql']) {
      await act(async () => change({ disabledModels: [model] }));
      await act(async () => { await mocks.providerProps.onSaveProvider(); });
      expect(mocks.service.AISaveProvider).not.toHaveBeenCalled();
    }
    await act(async () => change({ disabledModels: ['hidden'] }));
    await act(async () => { await mocks.providerProps.onSaveProvider(); });
    expect(mocks.service.AISaveProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'api', customModels: ['mine'], disabledModels: ['hidden'], maxTokens: 1024, temperature: 0.2, inlineCompletionModel: 'sql' }));
  });

  it('does not create a second record when input changes during the first save', async () => {
    const pending = deferred<void>();
    mocks.service.AISaveProvider.mockReturnValueOnce(pending.promise);
    await mount();
    await act(async () => { await mocks.providerProps.onAddProvider('openai'); change({ name: 'Snapshot', apiKey: 'fixture-key' }); });
    await act(async () => { void mocks.providerProps.onSaveProvider(); });
    const id = mocks.service.AISaveProvider.mock.calls[0][0].id;
    await act(async () => change({ name: 'Newer draft' }));
    await act(async () => pending.resolve());
    expect(mocks.providerProps.editingProvider.id).toBe(id);
    expect(mocks.values.name).toBe('Newer draft');
    expect(mocks.providerProps.dirty).toBe(true);
    await act(async () => { await mocks.providerProps.onSaveProvider(); });
    expect(mocks.service.AISaveProvider.mock.calls[1][0]).toMatchObject({ id, name: 'Newer draft' });
    expect(mocks.providerProps.dirty).toBe(false);
  });

  it('does not write an obsolete draft while waiting for the service bridge', async () => {
    await editAPI();
    const pending = deferred<any>();
    mocks.resolve.mockReturnValueOnce(pending.promise);
    await act(async () => { void mocks.providerProps.onSaveProvider(); });
    await act(async () => change({ name: 'Changed before write' }));
    await act(async () => pending.resolve(mocks.service));
    expect(mocks.service.AISaveProvider).not.toHaveBeenCalled();
    expect(mocks.providerProps.dirty).toBe(true);
    expect(mocks.messages.warning).toHaveBeenCalledWith(expect.stringContaining('changed before saving'));
  });

  it('guards internal navigation and the host close action, preserving drafts when cancelled', async () => {
    let guard: any;
    const register = vi.fn((next) => { guard = next; });
    const confirmations: any[] = [];
    mocks.modal.confirm.mockImplementation((options) => { confirmations.push(options); return { destroy: vi.fn() }; });
    await mount(true, undefined, register); await edit();
    expect(guard()).toBe(true);
    await act(async () => change({ name: 'Do not lose this' }));
    await act(async () => { mocks.sidebarProps.onSelectSection('mcp'); });
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0].zIndex).toBe(25200);
    expect(mocks.service.AIGetMCPClientInstallStatuses).not.toHaveBeenCalled();
    await act(async () => confirmations[0].onCancel());
    expect(mocks.values.name).toBe('Do not lose this');
    expect(mocks.providerProps.dirty).toBe(true);
    let leaving!: Promise<boolean>;
    await act(async () => { leaving = guard(); });
    await act(async () => confirmations[1].onOk());
    expect(await leaving).toBe(true);
    expect(mocks.providerProps.isEditing).toBe(false);
    expect(mocks.providerProps.dirty).toBe(false);
    await act(async () => renderer!.unmount()); renderer = undefined;
    expect(register).toHaveBeenLastCalledWith(null);
  });

  it.each(['disabledModels', 'customModels'])('does not prompt after a legacy %s preference returns to empty', async (field) => {
    let guard: any;
    await mount(true, undefined, (next) => { guard = next; }); await edit();
    await act(async () => { await mocks.providerProps.onTestProvider(); });
    expect(mocks.providerProps.testStatus).toBe('success');
    await act(async () => change({ [field]: ['temporary-model'] }));
    expect(mocks.providerProps.dirty).toBe(true);
    await act(async () => change({ [field]: [] }));
    expect(mocks.providerProps.dirty).toBe(false);
    expect(guard()).toBe(true);
    expect(mocks.modal.confirm).not.toHaveBeenCalled();
    expect(mocks.values[field]).toEqual([]);
    expect(mocks.providerProps.testStatus).toBe('idle');
    expect(mocks.providerProps.testResult).toBeNull();
    expect(mocks.service.AISaveProvider).not.toHaveBeenCalled();
  });

  it('hides the provider panel instead of stacking it above other settings sections', async () => {
    await mount();
    const panel = () => renderer!.root.findByProps({ id: 'gonavi-ai-settings-panel-providers' });
    expect(panel().props.hidden).toBe(false);
    expect(panel().props.className).toBe('gonavi-ai-settings-panel-providers');
    expect(panel().props.style?.display).not.toBe('flex');
    await act(async () => mocks.sidebarProps.onSelectSection('safety'));
    expect(panel().props.hidden).toBe(true);
    expect(panel().props.style?.display).not.toBe('flex');
    expect(renderer!.root.findByProps({ id: 'gonavi-ai-settings-panel-safety' }).props.hidden).toBe(false);
    expect(mocks.providerProps).toEqual(expect.objectContaining({ isEditing: false }));
  });

  it('does not mark untouched CLI discovery as a user edit or overwrite an edited field', async () => {
    await mount();
    await act(async () => { await mocks.providerProps.onAddProvider('grok'); mocks.providerProps.onCLIDefaults({ ...capability, apiFormat: 'grok-cli' }); });
    expect(mocks.providerProps.dirty).toBe(false);
    await act(async () => change({ model: 'mine' }));
    await act(async () => mocks.providerProps.onCLIDefaults({ ...capability, apiFormat: 'grok-cli', defaultModel: 'late-default' }));
    expect(mocks.values.model).toBe('mine');
    expect(mocks.providerProps.dirty).toBe(true);
  });
});
