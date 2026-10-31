import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIProviderConfig } from '../../types';
import type { AISettingsProvidersSectionProps } from './AISettingsProvidersSection';
const state = vi.hoisted(() => ({ values: {} as Record<string, unknown>, listeners: new Set<() => void>(), list: vi.fn(), builtin: vi.fn(), changed: vi.fn() }));
vi.mock('../../plugins/aiProvider/api', () => ({ fetchPluginAIProviders: state.list }));
vi.mock('../../i18n/provider', () => ({ useOptionalI18n: () => ({ t: (key: string) => key }) }));
vi.mock('./AISettingsProvidersSection', () => ({ default: (props: unknown) => { state.builtin(props); return null; } }));
vi.mock('antd', async () => {
  const React = await import('react');
  const Box = ({ children, ...props }: Record<string, unknown>) => React.createElement('div', props, children as React.ReactNode);
  const Input = Object.assign((props: Record<string, unknown>) => React.createElement('input', props), { Password: (props: Record<string, unknown>) => React.createElement('input', props) });
  const Form = Object.assign(Box, { Item: Box, useWatch: () => React.useSyncExternalStore((listener) => { state.listeners.add(listener); return () => state.listeners.delete(listener); }, () => state.values) });
  return { Alert: Box, Button: ({ children, ...props }: Record<string, unknown>) => React.createElement('button', props, children as React.ReactNode),
    Form, Input, InputNumber: Input, Select: Box, Space: Box, Tag: Box, Typography: { Text: Box }, Modal: Box, Popconfirm: Box,
    Slider: (props: Record<string, unknown>) => React.createElement('input', { type: 'range', ...props }),
    Collapse: Object.assign(Box, { Panel: Box }) };
});
import AISettingsPluginProviderSection from './AISettingsPluginProviderSection';
import { AIPluginProviderScope } from '../../plugins/aiProvider/context';
import { decodePluginAIProviders } from '../../plugins/aiProvider/decode';
import { buildPluginProviderPayload, pluginProviderEditorSession } from '../../plugins/aiProvider/editor';
const provider: AIProviderConfig = { id: 'saved', type: 'plugin:example.ai:chat', name: 'Saved', apiKey: '', hasSecret: true, secretRef: 'private-ref', baseUrl: '', model: 'model', maxTokens: 0, temperature: 0.7 };
const source = decodePluginAIProviders({ items: [{ type: provider.type, pluginId: 'example.ai', id: 'chat', name: 'Native provider', models: [{ id: 'model', name: 'Model', contextWindow: 4096, maxOutputTokens: 1024 }], supportsTools: true, supportsImages: false, version: '1.0.0', digest: 'a'.repeat(64), generation: 1, state: 'running', available: true }] });
let renderer: ReactTestRenderer; let submitted: AIProviderConfig | undefined;
const form = { getFieldsValue: () => state.values, setFieldsValue: (patch: Record<string, unknown>) => { state.values = { ...state.values, ...patch }; state.listeners.forEach((listener) => listener()); } };
async function mount(saved = provider) {
  state.values = pluginProviderEditorSession(saved).formValues!;
  const props = { providers: [saved], editingProvider: saved, watchedPresetKey: saved.type, isEditing: true, form, loading: false, testing: false,
    testStatus: 'idle', testResult: null, primaryPasswordVisible: false, onPrimaryPasswordVisibleChange: vi.fn(), onValuesChange: state.changed,
    onCancelEdit: vi.fn(), onTestProvider: vi.fn(), onSaveProvider: () => { submitted = buildPluginProviderPayload(state.values, saved, 'save'); },
  } as unknown as AISettingsProvidersSectionProps;
  await act(async () => { renderer = create(<AIPluginProviderScope active><AISettingsPluginProviderSection {...props} /></AIPluginProviderScope>); });
}
beforeEach(() => { vi.clearAllMocks(); submitted = undefined; state.list.mockResolvedValue(source); });
afterEach(() => { act(() => renderer?.unmount()); });
describe('actual plugin provider wrapper and explicit correction UI', () => {
  it('keeps the saved secret reference and never projects opaque headers', async () => {
    await mount(); expect(state.builtin).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType('button').some((button) => button.children.includes('plugin.ai_provider.api_key_replace'))).toBe(true);
    expect(buildPluginProviderPayload(state.values, provider, 'save').headers).toBeUndefined();
    expect(renderer.root.findAllByType('button').some((button) => button.children.includes('plugin.ai_provider.clear_unsupported'))).toBe(false);
    const save = renderer.root.findAllByType('button').find((button) => button.children.includes('common.save'))!; act(() => save.props.onClick());
    expect(submitted).toMatchObject({ type: provider.type, model: 'model', apiKey: '', hasSecret: true, secretRef: 'private-ref' });
  });
  it('clears options the plugin surface never renders when saving instead of offering a clear button', async () => {
    await mount({ ...provider, apiFormat: 'openai', thinkingIntensity: 'medium', supportsImages: true, headerTimeoutSeconds: 3, cliEnv: { PRIVATE: 'never projected' } });
    expect(state.builtin).not.toHaveBeenCalled(); expect(state.values).toMatchObject({ apiFormat: 'openai', thinkingIntensity: 'medium', supportsImages: true, headerTimeoutSeconds: 3 });
    const save = renderer.root.findAllByType('button').find((button) => button.children.includes('common.save'))!; act(() => save.props.onClick());
    expect(state.values).toMatchObject({ apiFormat: '', thinkingIntensity: '', supportsImages: false, headerTimeoutSeconds: 0, cliEnv: {} });
    expect(submitted).toMatchObject({ apiFormat: '', thinkingIntensity: '', headerTimeoutSeconds: 0, supportsImages: false });
  });
  it.each(['Plugin:example.ai:chat', ' plugin:example.ai:chat ', 'plugin:gone.ai:missing'])('preserves unavailable raw identity %s without a builtin editor or model defaults', async (type) => {
    state.list.mockResolvedValue([]); await mount({ ...provider, type, model: 'old-model' }); expect(state.builtin).not.toHaveBeenCalled();
    expect(state.values).toMatchObject({ type, model: 'old-model', secretRef: 'private-ref', apiFormat: '' });
    const test = renderer.root.findAllByType('button').find((button) => button.children.includes('plugin.ai_provider.test'))!; expect(test.props.disabled).toBe(true);
  });
  it('forwards installed plugin providers into the add-provider plugin group', async () => {
    const props = { providers: [], editingProvider: null, isEditing: false, form, loading: false, testing: false, testStatus: 'idle', testResult: null,
      primaryPasswordVisible: false, onPrimaryPasswordVisibleChange: vi.fn(), onCancelEdit: vi.fn(), onTestProvider: vi.fn(), onSaveProvider: vi.fn(),
    } as unknown as AISettingsProvidersSectionProps;
    await act(async () => { renderer = create(<AIPluginProviderScope active><AISettingsPluginProviderSection {...props} /></AIPluginProviderScope>); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const calls = state.builtin.mock.calls;
    const last = calls.length ? calls[calls.length - 1][0] as { pluginPresets?: unknown } : undefined;
    expect(last?.pluginPresets).toEqual([{ key: provider.type, label: 'Native provider · example.ai', available: true, iconSrc: undefined, detail: undefined }]);
  });
});
