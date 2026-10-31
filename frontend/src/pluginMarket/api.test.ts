import { beforeEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({ PluginMarketSettings: vi.fn(), PluginMarketConfigure: vi.fn(), PluginMarketCatalog: vi.fn(),
  PluginMarketDetail: vi.fn(), PluginMarketRatings: vi.fn(), PluginMarketInstall: vi.fn(), PluginMarketInspect: vi.fn(), PluginMarketCancelInspection: vi.fn() }));
vi.mock('../../wailsjs/go/app/App', () => host);
import { marketAPI } from './api';
beforeEach(() => vi.resetAllMocks());
describe('market generated adapter', () => {
  it('passes query sort and real cursor without inventing records', async () => {
    host.PluginMarketCatalog.mockResolvedValue({ success: true, data: { items: [], nextCursor: 'after:12' } });
    expect(await marketAPI.catalog('hello', 'rating', 'after:8')).toEqual({ items: [], nextCursor: 'after:12' });
    expect(host.PluginMarketCatalog).toHaveBeenCalledWith('hello', 'rating', 'after:8');
  });
  it('surfaces offline and structured backend errors', async () => {
    host.PluginMarketCatalog.mockRejectedValue(new Error('offline'));
    await expect(marketAPI.catalog('', 'updated', '')).rejects.toThrow('offline');
    host.PluginMarketRatings.mockResolvedValue({ success: false, message: 'Source unavailable', data: { code: 'market_unavailable' } });
    await expect(marketAPI.ratings('test.hello')).rejects.toThrow();
  });
  it('preserves explicitly stale cache data on failed requests without marking it live', async () => {
    host.PluginMarketCatalog.mockResolvedValue({ success: false, message: 'Offline', data: { items: [], stale: true, error: 'Offline', cachedAt: '2026-01-01', sourceId: 'opaque' } });
    const page = await marketAPI.catalog('', 'updated', '');
    expect(page.stale).toBe(true); expect(page.error).toBe('Offline'); expect(page.cachedAt).toBe('2026-01-01');
    host.PluginMarketCatalog.mockResolvedValue({ success: false, data: { items: [], stale: false } });
    await expect(marketAPI.catalog('', 'updated', '')).rejects.toThrow();
  });
  it('reads public ratings without any write operation', async () => {
    const rating = { userId: 'u1', pluginId: 'test.hello', stars: 4, body: 'Helpful', version: '1.0.0', updatedAt: 'now' };
    host.PluginMarketRatings.mockResolvedValue({ success: true, data: [rating] });
    expect(await marketAPI.ratings('test.hello')).toEqual([rating]);
    expect(host.PluginMarketRatings).toHaveBeenCalledWith('test.hello');
  });
  it('reports a committed disabled install separately from provenance failure', async () => {
    const installed = { manifest: { schemaVersion: 1, apiVersion: 1, id: 'test.hello', name: 'Hello', version: '1.0.0', permissions: [] },
      digest: 'a'.repeat(64), state: 'disabled', desiredEnabled: false, generation: 1, installedAt: 'now' };
    host.PluginMarketInstall.mockResolvedValue({ success: false, data: { installed, provenanceRecorded: false } });
    await expect(marketAPI.install('test.hello', '1.0.0', 'b'.repeat(64), true, 'approval-token')).rejects.toThrow('plugin.install.partial');
  });
});
