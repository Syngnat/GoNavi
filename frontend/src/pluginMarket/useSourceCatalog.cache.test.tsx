import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const requests = vi.hoisted(() => ({ catalog: vi.fn() }));
vi.mock('./sourceApi', () => ({ sourceMarketAPI: (id: string) => ({ catalog: (...args: unknown[]) => requests.catalog(id, ...args) }) }));
import { useSourceCatalog } from './useSourceCatalog';
import { CATALOG_STORAGE_PREFIX, CATALOG_TTL_MS, clearCatalogPages } from './catalogPageCache';
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}
let output: ReturnType<typeof useSourceCatalog>;
function Harness({ id = 'reentry' }: { id?: string }) { output = useSourceCatalog(id, true, '', 'updated', 0); return null; }
const plugin = { id: 'test.one', name: 'One', author: '', publisherId: '', description: '', version: '1.0.0', official: true,
  platforms: [], ratingAverage: 0, ratingCount: 0, downloadCount: 0, updatedAt: 'now' };
let renderer: ReturnType<typeof create> | undefined;
let storage: MemoryStorage;
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); }
beforeEach(() => { vi.useFakeTimers(); storage = new MemoryStorage(); vi.stubGlobal('localStorage', storage); clearCatalogPages(); vi.resetAllMocks(); requests.catalog.mockResolvedValue({ items: [plugin], nextCursor: '' }); });
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('catalog reentry request budget', () => {
  it('does not issue a second catalog request on an immediate reentry', async () => {
    await act(async () => { renderer = create(<Harness />); }); await tick();
    expect(requests.catalog).toHaveBeenCalledTimes(1);
    await act(async () => { renderer!.unmount(); renderer = create(<Harness />); }); await tick();
    expect(requests.catalog).toHaveBeenCalledTimes(1);
    expect(output.items).toHaveLength(1); expect(output.loading).toBe(false);
  });
  it('coalesces the same source page requested by two mounted views', async () => {
    await act(async () => { renderer = create(<><Harness id="shared-request" /><Harness id="shared-request" /></>); }); await tick();
    expect(requests.catalog).toHaveBeenCalledTimes(1);
  });
  it('keeps stale cards visible while revalidating and manual refresh bypasses TTL', async () => {
    await act(async () => { renderer = create(<Harness id="stale" />); }); await tick();
    await act(async () => { output.reload(); }); await tick(); expect(requests.catalog).toHaveBeenCalledTimes(2);
    await act(async () => { renderer!.unmount(); }); renderer = undefined;
    vi.setSystemTime(Date.now() + CATALOG_TTL_MS + 1);
    let complete: (page: { items: typeof plugin[] }) => void = () => {};
    requests.catalog.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await act(async () => { renderer = create(<Harness id="stale" />); });
    expect(output.items).toHaveLength(1); expect(output.loading).toBe(false); expect(output.refreshing).toBe(true);
    await tick(); expect(requests.catalog).toHaveBeenCalledTimes(3);
    await act(async () => { complete({ items: [{ ...plugin, name: 'Updated' }] }); });
    expect(output.items[0].name).toBe('Updated'); expect(output.refreshing).toBe(false);
  });
  it('retains last-good cards on a background failure and backs off repeated entries', async () => {
    await act(async () => { renderer = create(<Harness id="offline-cache" />); }); await tick();
    await act(async () => { renderer!.unmount(); }); renderer = undefined;
    vi.setSystemTime(Date.now() + CATALOG_TTL_MS + 1); requests.catalog.mockRejectedValue(new Error('offline'));
    await act(async () => { renderer = create(<Harness id="offline-cache" />); }); await tick();
    expect(output.items).toHaveLength(1); expect(output.stale).toBe(true); expect(output.error).toBeTruthy();
    await act(async () => { renderer!.unmount(); renderer = create(<Harness id="offline-cache" />); }); await tick();
    expect(requests.catalog).toHaveBeenCalledTimes(2); expect(output.loading).toBe(false);
  });
  it('paints a persisted page immediately after a restart and refreshes it in the background', async () => {
    const key = JSON.stringify(['restart', true, '', 'updated', '']);
    storage.setItem(CATALOG_STORAGE_PREFIX + key, JSON.stringify({ savedAt: Date.now(), page: { items: [plugin], sourceId: 'restart' } }));
    let complete: (page: { items: typeof plugin[] }) => void = () => {};
    requests.catalog.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await act(async () => { renderer = create(<Harness id="restart" />); });
    expect(output.items).toHaveLength(1); expect(output.loading).toBe(false); expect(output.refreshing).toBe(true);
    await tick();
    expect(requests.catalog).toHaveBeenCalledTimes(1);
    await act(async () => { complete({ items: [{ ...plugin, name: 'Updated' }] }); });
    expect(output.items[0].name).toBe('Updated'); expect(output.refreshing).toBe(false);
  });

});
