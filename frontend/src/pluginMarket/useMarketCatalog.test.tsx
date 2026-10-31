import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketPlugin } from './types';
const host = vi.hoisted(() => ({ PluginMarketSettings: vi.fn(), PluginMarketConfigure: vi.fn(), PluginMarketCatalog: vi.fn(),
  PluginMarketDetail: vi.fn(), PluginMarketRatings: vi.fn(),
  PluginMarketInstall: vi.fn(), PluginMarketInspect: vi.fn(), PluginMarketCancelInspection: vi.fn() }));
vi.mock('../../wailsjs/go/app/App', () => host);
import { useMarketCatalog } from './useMarketCatalog';
const makePlugin = (id: string, official = false): MarketPlugin => ({ id, name: id, description: '', author: '', publisherId: '', official,
  version: '1.0.0', platforms: [], ratingAverage: 3.75, ratingCount: 4, downloadCount: 17, updatedAt: 'now' });
const ok = (data: unknown) => ({ success: true, data });
let renderer: ReturnType<typeof create> | undefined;
let catalog: ReturnType<typeof useMarketCatalog>;
function Harness({ source = 'https://market.test', trusted = true, sourceId }: { source?: string; trusted?: boolean; sourceId?: string }) { catalog = useMarketCatalog(source, 0, trusted, sourceId); return null; }
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); });
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; vi.useRealTimers(); });
async function mount() { await act(async () => { renderer = create(<Harness />); }); await act(async () => { await vi.advanceTimersByTimeAsync(250); }); }
describe('real marketplace catalog', () => {
  it('keeps official results first without changing real ratings, and uses real next cursor', async () => {
    host.PluginMarketCatalog.mockResolvedValueOnce(ok({ items: [makePlugin('community.one'), makePlugin('official.one', true)], nextCursor: 'cursor-2' }))
      .mockResolvedValueOnce(ok({ items: [makePlugin('community.two')], nextCursor: '' }));
    await mount();
    expect(catalog.items.map((p) => p.id)).toEqual(['official.one', 'community.one']);
    expect(catalog.items[0].ratingAverage).toBe(3.75);
    await act(async () => { catalog.more(); });
    expect(host.PluginMarketCatalog).toHaveBeenLastCalledWith('', 'updated', 'cursor-2');
    expect(catalog.items).toHaveLength(3);
  });
  it('clears spoofed official badges on custom sources', async () => {
    host.PluginMarketCatalog.mockResolvedValue(ok({ items: [makePlugin('private.spoof', true)], nextCursor: '' }));
    await act(async () => { renderer = create(<Harness trusted={false} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(catalog.items[0].official).toBe(false);
  });
  it('keeps fresh results and warns when only cache persistence fails', async () => {
    host.PluginMarketCatalog.mockResolvedValue({ success: false, data: { items: [makePlugin('fresh.result')], stale: false, error: 'cache_unavailable' } });
    await mount();
    expect(catalog.items[0].id).toBe('fresh.result');
    expect(catalog.stale).toBe(false);
    expect(catalog.error).toBe('');
    expect(catalog.warning).toBeTruthy();
    expect(catalog.warning).not.toBe('cache_unavailable');
  });
  it('shows offline errors and no fabricated catalog', async () => {
    host.PluginMarketCatalog.mockRejectedValue(new Error('offline'));
    await mount();
    expect(catalog.error).toBeTruthy();
    expect(catalog.items).toEqual([]);
  });
  it('rejects cached data whose source identity does not match the current settings', async () => {
    host.PluginMarketCatalog.mockResolvedValue(ok({ items: [makePlugin('wrong.source')], stale: true, sourceId: 'old', error: 'timeout' }));
    await act(async () => { renderer = create(<Harness sourceId="current" />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(catalog.items).toEqual([]); expect(catalog.error).toBeTruthy();
  });
  it('drops stale catalog results after source change', async () => {
    let complete: (value: unknown) => void = () => {};
    host.PluginMarketCatalog.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }))
      .mockResolvedValue(ok({ items: [], nextCursor: '' }));
    await mount();
    await act(async () => { renderer!.update(<Harness source="https://other.test" />); });
    await act(async () => { complete(ok({ items: [makePlugin('old.source')] })); await vi.advanceTimersByTimeAsync(250); });
    expect(catalog.items).toEqual([]);
  });
});
