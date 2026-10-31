import { beforeEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({ PluginMarketSources: vi.fn(), PluginMarketSaveSources: vi.fn(), PluginMarketSourceSettings: vi.fn(), PluginMarketSourceCatalog: vi.fn(),
  PluginMarketSourceDetail: vi.fn(), PluginMarketSourceRatings: vi.fn(), PluginMarketConfigure: vi.fn() }));
vi.mock('../../wailsjs/go/app/App', () => host);
import { decodeSources, marketSourcesAPI, sourceMarketAPI } from './sourceApi';
const a = 'a'.repeat(64); const b = 'b'.repeat(64);
const source = { baseUrl: 'https://plugin.gonavi.org', sourceId: a, enabled: true, trustedOfficial: true };
const plugin = { id: 'test.same', name: 'Same', description: '', author: 'Author', publisherId: 'author', official: true,
  version: '1.0.0', platforms: [], ratingAverage: 0, ratingCount: 0, downloadCount: 0, updatedAt: 'now', sourceId: a };
const ok = (data: unknown) => ({ success: true, data });
beforeEach(() => vi.resetAllMocks());
describe('explicit registered source adapter', () => {
  it('loads and saves typed sources without inferred defaults', async () => {
    host.PluginMarketSources.mockResolvedValue(ok([source])); host.PluginMarketSaveSources.mockResolvedValue(ok([source]));
    expect(await marketSourcesAPI.list()).toEqual([source]);
    await marketSourcesAPI.save([{ baseUrl: source.baseUrl, enabled: false }]);
    expect(host.PluginMarketSaveSources).toHaveBeenCalledWith([{ baseUrl: source.baseUrl, enabled: false }]);
  });
  it('binds catalog and settings requests to the source ID', async () => {
    host.PluginMarketSourceSettings.mockResolvedValue(ok(source));
    host.PluginMarketSourceCatalog.mockResolvedValue(ok({ sourceId: a, items: [plugin] }));
    const client = sourceMarketAPI(a); await client.settings(); await client.catalog('same', 'rating', 'next');
    expect(host.PluginMarketSourceSettings).toHaveBeenCalledWith(a);
    expect(host.PluginMarketSourceCatalog).toHaveBeenCalledWith(a, 'same', 'rating', 'next');
  });
  it.each([
    { sourceId: b, items: [plugin] }, { sourceId: a, items: [{ ...plugin, sourceId: b }] },
    { sourceId: a, items: Array.from({ length: 25 }, () => plugin) },
  ])('rejects a foreign or oversized page', async (page) => {
    host.PluginMarketSourceCatalog.mockResolvedValue(ok(page));
    await expect(sourceMarketAPI(a).catalog('', 'updated', '')).rejects.toThrow();
  });
  it('never configures the global source to perform a scoped action', async () => {
    await expect(sourceMarketAPI(a).configure('https://other.test')).rejects.toThrow();
    expect(host.PluginMarketConfigure).not.toHaveBeenCalled();
  });
  it('rejects duplicate or malformed source descriptors', () => {
    expect(() => decodeSources([source, source])).toThrow();
    expect(() => decodeSources([{ ...source, sourceId: 'bad' }])).toThrow();
    expect(() => decodeSources([{ ...source, enabled: 'yes' }])).toThrow();
  });
  it('accepts the largest source list the host contract allows', () => {
    const baseUrl = 'https://example.test/' + 'a'.repeat(2048 - 'https://example.test/'.length);
    const rows = Array.from({ length: 32 }, (_, index) => ({ ...source, baseUrl, sourceId: index.toString(16).padStart(64, '0') }));
    expect(decodeSources(rows)).toHaveLength(32);
  });
  it('still rejects a source row above the default string budget', () => {
    expect(() => decodeSources([{ ...source, baseUrl: 'https://example.test/' + 'a'.repeat(9000) }]))
      .toThrow(/plugin\.ui\.invalid_data/);
  });

});
