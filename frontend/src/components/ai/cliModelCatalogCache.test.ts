import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_MODEL_CATALOG_CACHE_KEY, CLI_MODEL_CATALOG_CACHE_MAX_AGE_MS, readCachedCLIModelCatalog, writeCachedCLIModelCatalog } from './cliModelCatalogCache';

describe('cliModelCatalogCache', () => {
  let stored: Map<string, string>;
  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => stored.get(key) || null, setItem: (key: string, value: string) => stored.set(key, value) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stores usable catalogs per API format and reads them back', () => {
    writeCachedCLIModelCatalog('grok-cli', { models: ['grok-4'], source: 'cli', stale: false }, 10);
    writeCachedCLIModelCatalog('codex-cli', { models: ['gpt-5'], source: 'cache', stale: false }, 20);
    expect(readCachedCLIModelCatalog('grok-cli', 20)).toEqual({ models: ['grok-4'], source: 'cli', stale: false });
    expect(readCachedCLIModelCatalog('codex-cli', 20)).toEqual({ models: ['gpt-5'], source: 'cache', stale: false });
    expect(readCachedCLIModelCatalog('cursor-cli', 20)).toBeNull();
    expect(JSON.parse(stored.get(CLI_MODEL_CATALOG_CACHE_KEY)!)['grok-cli'].fetchedAt).toBe(10);
  });

  it('never caches stale, empty or unscoped results so they retry on their own', () => {
    writeCachedCLIModelCatalog('grok-cli', { models: ['old'], source: 'cache', stale: true });
    writeCachedCLIModelCatalog('claude-cli', { models: [], source: 'none', stale: false });
    writeCachedCLIModelCatalog('', { models: ['x'], source: 'cli', stale: false });
    expect(stored.has(CLI_MODEL_CATALOG_CACHE_KEY)).toBe(false);
  });

  it('ignores corrupt storage', () => {
    stored.set(CLI_MODEL_CATALOG_CACHE_KEY, '{not json');
    expect(readCachedCLIModelCatalog('grok-cli')).toBeNull();
    stored.set(CLI_MODEL_CATALOG_CACHE_KEY, JSON.stringify({ 'grok-cli': { catalog: { models: 'nope' } } }));
    expect(readCachedCLIModelCatalog('grok-cli')).toBeNull();
  });

  it('expires catalogs so newly released Codex models are synchronized automatically', () => {
    writeCachedCLIModelCatalog('codex-cli', { models: ['old-model'], source: 'app-server', stale: false }, 100);
    expect(readCachedCLIModelCatalog('codex-cli', 100 + CLI_MODEL_CATALOG_CACHE_MAX_AGE_MS)).not.toBeNull();
    expect(readCachedCLIModelCatalog('codex-cli', 101 + CLI_MODEL_CATALOG_CACHE_MAX_AGE_MS)).toBeNull();
  });
});
