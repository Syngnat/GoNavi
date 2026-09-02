import { describe, expect, it } from 'vitest';
import type { AIProviderConfig } from '../types';
import { buildProviderModelOptions, filterProviders, getCLIConfigPrefill, parseCLIModelCatalog, parseProviderCheckResult, providerCopyName, providerDraftFingerprint } from './aiProviderManagement';

const providers = [
  { id: 'c', name: 'Personal subscription', type: 'custom', apiFormat: 'codex-cli', model: 'model-c', models: ['extra-model'] },
  { id: 'a', name: '工作账户', type: 'custom', apiFormat: 'claude-cli', model: 'model-a' },
  { id: 'b', name: 'Shared subscription', type: 'custom', apiFormat: 'codex-cli', model: 'model-b' },
] as AIProviderConfig[];
const label = (provider: AIProviderConfig) => provider.apiFormat === 'codex-cli' ? 'Codex Subscription' : 'Claude Subscription';

describe('provider draft comparison', () => {
  it('ignores empty optional model preferences without masking real edits or mutating the payload', () => {
    const legacy = { name: 'Original', model: 'default', apiKey: 'fixture-key', models: ['one', 'two'] };
    const restored = { ...legacy, disabledModels: [], customModels: [] };
    expect(providerDraftFingerprint(restored)).toBe(providerDraftFingerprint(legacy));
    expect(restored).toHaveProperty('disabledModels', []);
    expect(restored).toHaveProperty('customModels', []);
    for (const patch of [{ disabledModels: ['one'] }, { customModels: ['custom'] }, { model: 'other' }, { apiKey: 'changed' }, { models: ['two', 'one'] }]) {
      expect(providerDraftFingerprint({ ...restored, ...patch })).not.toBe(providerDraftFingerprint(legacy));
    }
  });
});

describe('copy naming', () => {
  const existing = ['OpenAI', 'OpenAI · copy', 'OpenAI · copy 2'];

  it('keeps a renamed draft exactly as typed', () => {
    expect(providerCopyName('Team key', existing, 'copy')).toBe('Team key');
    expect(providerCopyName('  Team key  ', existing, 'copy')).toBe('Team key');
  });

  it('adds the suffix only when the name would collide', () => {
    expect(providerCopyName('OpenAI', existing, 'copy')).toBe('OpenAI · copy 3');
    expect(providerCopyName('OpenAI', ['OpenAI'], 'copy')).toBe('OpenAI · copy');
  });

  it('falls back to the bare suffix for an empty name', () => {
    expect(providerCopyName('   ', [], 'copy')).toBe('copy');
    expect(providerCopyName('', ['copy'], 'copy')).toBe('copy 2');
  });
});

describe('model candidates', () => {
  it('combines catalogs, saved selections and defaults without mutating or duplicating them', () => {
    const catalog = ['cache-a', 'cache-b'];
    const saved = ['custom-model', 'cache-a'];
    expect(buildProviderModelOptions(catalog, saved, ['', ' default ', null])).toEqual([
      { value: 'cache-a', label: 'cache-a' }, { value: 'cache-b', label: 'cache-b' },
      { value: 'custom-model', label: 'custom-model' }, { value: 'default', label: 'default' },
    ]);
    expect(catalog).toEqual(['cache-a', 'cache-b']);
    expect(saved).toEqual(['custom-model', 'cache-a']);
  });
  it('rejects unknown or incomplete catalog contracts and never offers stale candidates', () => {
    expect(parseCLIModelCatalog(['unscoped-model'])).toBeNull();
    expect(parseCLIModelCatalog({ models: ['model'], source: 'unknown', stale: false })).toBeNull();
    expect(parseCLIModelCatalog({ models: ['old'], source: 'cache', stale: true })).toEqual({ models: [], source: 'cache', stale: true });
  });
  it('preserves documented aliases as suggestions without claiming live discovery', () => {
    const catalog = { models: ['sonnet', 'opus', 'haiku'], source: 'aliases', stale: false };
    expect(parseCLIModelCatalog(catalog)).toEqual(catalog);
  });
});

describe('provider list search', () => {
  it.each([
    ['personal', ['c']], ['工作', ['a']], ['CODEX', ['c', 'b']], ['extra-model', ['c']],
    ['subscription model-b', ['b']], ['unknown', []], ['   ', ['c', 'a', 'b']],
  ])('matches %s without changing stored order', (query, expected) => {
    expect(filterProviders(providers, query as string, label).map((provider) => provider.id)).toEqual(expected);
    expect(providers.map((provider) => provider.id)).toEqual(['c', 'a', 'b']);
  });
  it('does not search credentials or private endpoints', () => {
    const privateConfig = [{ ...providers[0], apiKey: 'secret-token', baseUrl: 'private-host', secretRef: 'saved-secret' }];
    expect(filterProviders(privateConfig, 'secret-token', label)).toEqual([]);
    expect(filterProviders(privateConfig, 'private-host', label)).toEqual([]);
  });
});

describe('provider check contract', () => {
  it.each([
    { success: true, message: 'legacy success' },
    { success: true, message: 'skipped', checkKind: 'none', modelVerified: false },
    { success: true, message: 'login', checkKind: 'local-auth', modelVerified: true },
    { success: true, message: 'unknown', checkKind: 'other', modelVerified: false },
  ])('rejects unscoped or contradictory results', (result) => { expect(parseProviderCheckResult(result)).toBeNull(); });
  it.each(['local-auth', 'endpoint', 'model-list', 'model-response'])('preserves the %s check scope', (checkKind) => {
    const result = { success: true, message: 'fixture', checkKind, modelVerified: checkKind === 'model-response' };
    expect(parseProviderCheckResult(result)).toEqual(result);
  });
  it('does not fill unsupported effort values even when supplied as defaults', () => {
    const capability = { defaultModel: 'local-model', defaultEffort: 'max', supportsEffort: true, effortValues: ['low', 'high'] } as any;
    expect(getCLIConfigPrefill(capability, {}, new Set(), true)).toEqual({ model: 'local-model' });
  });
});
