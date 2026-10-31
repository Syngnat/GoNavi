import { afterEach, describe, expect, it } from 'vitest';
import { isPluginAIProviderNamespace, parsePluginAIProviderType } from './identity';
import { decodePluginAIProviders } from './decode';
import { buildPluginProviderPayload, pluginProviderEditorSession } from './editor';
import { clearedPluginProviderSettings } from './configValidation';
import { resolveProviderPresetKey } from '../../utils/aiProviderPresets';
import { resolveProviderThinkingIntensityControl, resolveThinkingIntensityProfile, defaultThinkingIntensityForProfile } from '../../utils/aiThinkingIntensity';
import { findPreset, matchProviderPreset, PROVIDER_PRESETS } from '../../components/ai/aiSettingsModalConfig';
import { buildEditProviderEditorSession } from '../../utils/aiProviderEditorState';
import type { AIProviderConfig } from '../../types';
const type = 'plugin:example.ai:chat';
const view = { type, pluginId: 'example.ai', id: 'chat', name: 'Provider', models: [{ id: 'gpt-test', name: 'Static model', contextWindow: 4096, maxOutputTokens: 1024 }],
  supportsTools: true, supportsImages: false, version: '1.0.0', digest: 'a'.repeat(64), generation: 2, available: true, state: 'running' };
const config = (kind = type): AIProviderConfig => ({ id: 'saved', type: kind, name: 'Saved', apiKey: '', hasSecret: true, secretRef: 'private-ref', baseUrl: '', model: 'old-model', maxTokens: 0, temperature: 0.7 });
describe('plugin provider identity and immutable config', () => {
  it.each([type, 'plugin', 'Plugin:example.ai:chat', ' plugin:example.ai:chat ', 'plugin :example.ai:chat', '\u0085plugin:example.ai:chat', 'plugin\u0085:example.ai:chat', 'plugin:example.ai', 'plugin:example.ai:chat:extra'])('preserves reserved raw identity %s before all builtin presets', (raw) => {
    expect(isPluginAIProviderNamespace(raw)).toBe(true); expect(resolveProviderPresetKey({ ...config(raw), id: 'gonavi-ai' }, [], 'custom')).toBe(raw);
    expect(findPreset(raw).backendType).toBe(raw); expect(matchProviderPreset(config(raw)).key).toBe(raw);
    const session = pluginProviderEditorSession(config(raw)); expect(session.formValues).toMatchObject({ type: raw, model: 'old-model', secretRef: 'private-ref', apiFormat: '' });
    expect(buildEditProviderEditorSession({ provider: config(raw) }).formValues?.apiFormat).toBe('');
  });
  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])('rejects noncanonical trailing line terminator %j in identities, models, and digests', (ending) => {
    expect(parsePluginAIProviderType(type + ending)).toBeNull();
    expect(parsePluginAIProviderType('plugin:example.ai' + ending + ':chat')).toBeNull();
    expect(() => decodePluginAIProviders({ items: [{ ...view, digest: view.digest + ending }] })).toThrow();
    expect(() => decodePluginAIProviders({ items: [{ ...view, models: [{ ...view.models[0], id: 'model' + ending }] }] })).toThrow();
  });
  it('never mutates builtin presets or guesses plugin thinking from GPT/model/CLI names', () => {
    const before = JSON.stringify(PROVIDER_PRESETS); findPreset(type); expect(JSON.stringify(PROVIDER_PRESETS)).toBe(before);
    expect(parsePluginAIProviderType(type)).toEqual({ type, pluginId: 'example.ai', id: 'chat' });
    expect(resolveProviderThinkingIntensityControl({ ...config(), model: 'gpt-6', apiFormat: 'codex-cli', authMode: 'local-cli' })).toMatchObject({ options: [], defaultValue: '' });
    expect(defaultThinkingIntensityForProfile(resolveThinkingIntensityProfile(config()))).toBe('');
    expect(findPreset('unknown-native').key).toBe('custom');
  });
  it('keeps missing model and redacted key reference for syntax-only saves', () => {
    const result = buildPluginProviderPayload(pluginProviderEditorSession(config()).formValues!, config(), 'save');
    expect(result).toMatchObject({ type, model: 'old-model', secretRef: 'private-ref', hasSecret: true, apiKey: '' });
    expect(() => buildPluginProviderPayload(result as unknown as Record<string, unknown>, config(), 'test')).toThrow();
  });
  it.each([{ apiFormat: 'openai' }, { cliPath: '/secret-cli' }, { cliEnv: { TOKEN: 'private' } }, { effort: 'high' }, { thinkingIntensity: 'medium' }, { supportsImages: true }, { authMode: 'bearer' }, { headerTimeoutSeconds: 30 }])('refuses to silently discard unsupported saved settings %j', (patch) => {
    const saved = { ...config(), ...patch } as AIProviderConfig;
    expect(() => buildPluginProviderPayload(pluginProviderEditorSession(saved).formValues!, saved, 'save')).toThrow();
    const cleared = buildPluginProviderPayload({ ...pluginProviderEditorSession(saved).formValues, ...clearedPluginProviderSettings }, saved, 'save');
    expect(cleared.cliEnv).toEqual({}); expect(cleared.headers).toEqual({}); expect(cleared.secretRef).toBe('private-ref');
    expect(JSON.stringify(cleared)).toContain('"cliEnv":{}'); expect(JSON.stringify(cleared)).toContain('"headers":{}');
  });
  it.each([{ headerRows: [{ name: 'Host', value: 'forbidden' }] }, { headerRows: [{ name: 'Authorization', value: 'one' }, { name: 'authorization', value: 'two' }] }, { headerRows: [{ name: 'X-Key', value: 'a\r\nb' }] }, { headerRows: [{ name: 'X-Key\n', value: 'value' }] }])('rejects forbidden duplicate or injected headers', ({ headerRows }) => {
    expect(() => buildPluginProviderPayload({ ...config(), headerRows }, config(), 'save')).toThrow();
  });
  it('keeps an unchanged nonempty public-header snapshot instead of omitting it', () => {
    const saved = { ...config(), headers: { 'X-Public': 'kept' } };
    const result = buildPluginProviderPayload(pluginProviderEditorSession(saved).formValues!, saved, 'save');
    expect(result.headers).toEqual({ 'X-Public': 'kept' });
  });
  it('keeps selected key/header bytes and rejects invalid endpoint or reserved builtin identity', () => {
    const result = buildPluginProviderPayload({ ...config(), apiKey: ' key ', headerRows: [{ name: 'Authorization', value: ' value ' }] }, config(), 'save');
    expect(result.apiKey).toBe(' key '); expect(result.headers?.Authorization).toBe(' value ');
    for (const patch of [{ baseUrl: 'https://user:secret@host.test' }, { baseUrl: 'https://host.test/#fragment' }, { contextWindow: 1 }]) expect(() => buildPluginProviderPayload({ ...config(), ...patch }, config(), 'save')).toThrow();
    expect(() => buildPluginProviderPayload({ ...config(), id: 'gonavi-ai' }, { ...config(), id: 'gonavi-ai' }, 'save')).toThrow();
  });
  it.each([{ state: ['running'] }, { reason: null }, { supportsImages: 'true' }, { generation: Number.MAX_SAFE_INTEGER + 1 }, { type: 'custom' }, { models: [] }, { models: [{ id: 'x', name: 'X', contextWindow: 1024, maxOutputTokens: 1025 }] }])('rejects malformed provider metadata %j', (patch) => {
    expect(() => decodePluginAIProviders({ items: [{ ...view, ...patch }] })).toThrow();
  });
  it('derives image capability from the declaration instead of the saved config', () => {
    const [imageSource] = decodePluginAIProviders({ items: [{ ...view, supportsImages: true }] });
    const values = { ...config(), supportsImages: true };
    expect(buildPluginProviderPayload(values, config(), 'save', imageSource).supportsImages).toBe(true);
    expect(() => buildPluginProviderPayload(values, config(), 'save')).toThrow();
  });
  it('checks model ownership only on use, allows a catalog-sized context override, and keeps static catalog frozen', () => {
    const [source] = decodePluginAIProviders({ items: [view] }); expect(Object.isFrozen(source.models)).toBe(true);
    // 声明的窗口是默认值：网关别名在 models.dev 公共目录里可能更大，用户按目录改窗口不该被拦。
    const values = { ...config(), model: 'gpt-test', contextWindow: 1048576 };
    expect(() => buildPluginProviderPayload(values, config(), 'save', source)).not.toThrow();
    expect(buildPluginProviderPayload(values, config(), 'test', source).contextWindow).toBe(1048576);
    expect(() => buildPluginProviderPayload({ ...values, model: 'not-declared' }, config(), 'test', source)).toThrow();
    // 取值范围仍由 validatePluginProviderConfig 兜底。
    expect(() => buildPluginProviderPayload({ ...values, contextWindow: 1 }, config(), 'test', source)).toThrow();
  });
  it('accepts only bounded raster icon data URLs from the catalog', () => {
    const icon = 'data:image/png;base64,iVBORw0KGgo=';
    expect(decodePluginAIProviders({ items: [{ ...view, icon }] })[0].icon).toBe(icon);
    // 上限跟随宿主的 5 MiB 原始字节（base64 约 4/3），不再按 128 KiB 的 data URL 长度卡。
    const largest = 'data:image/png;base64,' + 'A'.repeat(Math.ceil((5 << 20) * 4 / 3));
    expect(decodePluginAIProviders({ items: [{ ...view, icon: largest }] })[0].icon).toBe(largest);
    for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', 'data:text/html;base64,PGgxPg==', 'javascript:alert(1)',
      'data:image/png;base64,' + 'A'.repeat(Math.ceil((5 << 20) * 4 / 3) + 128)]) {
      expect(() => decodePluginAIProviders({ items: [{ ...view, icon: bad }] })).toThrow();
    }
  });
});
