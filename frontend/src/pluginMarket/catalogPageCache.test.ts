import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogPage } from './types';
import { CATALOG_MAX_BYTES, CATALOG_MAX_PAGES, CATALOG_MAX_REQUESTS, CATALOG_STORAGE_PREFIX, CATALOG_TTL_MS, catalogCacheStats, clearCatalogPages, peekCatalogPage, requestCatalogPage, syncCatalogSources } from './catalogPageCache';
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return Array.from(this.data.keys())[index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}
const page = (): CatalogPage => ({ items: [], sourceId: 'source' });
const plugin = { id: 'test.one', name: 'One', author: '', publisherId: '', description: '', version: '1.0.0', official: true,
  platforms: [], ratingAverage: 0, ratingCount: 0, downloadCount: 0, updatedAt: 'now' };
let storage: MemoryStorage;
beforeEach(() => { vi.useFakeTimers(); storage = new MemoryStorage(); vi.stubGlobal('localStorage', storage); clearCatalogPages(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('bounded public catalog cache', () => {
  it('reuses fresh pages and supports explicit refresh', async () => {
    const load = vi.fn(async () => page()); await requestCatalogPage('one', load); await requestCatalogPage('one', load);
    expect(load).toHaveBeenCalledTimes(1); await requestCatalogPage('one', load, { force: true }); expect(load).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + CATALOG_TTL_MS + 1); await requestCatalogPage('one', load); expect(load).toHaveBeenCalledTimes(3);
  });
  it('bounds LRU entry count and payload size', async () => {
    for (let index = 0; index < CATALOG_MAX_PAGES + 8; index++) await requestCatalogPage('key-' + index, async () => page());
    expect(catalogCacheStats().pages).toBe(CATALOG_MAX_PAGES); expect(peekCatalogPage('key-0')).toBeUndefined();
    await requestCatalogPage('oversized', async () => ({ ...page(), error: 'x'.repeat(CATALOG_MAX_BYTES) }));
    expect(peekCatalogPage('oversized')).toBeUndefined(); expect(catalogCacheStats().bytes).toBeLessThanOrEqual(CATALOG_MAX_BYTES);
  });
  it('coalesces pending identical requests and limits concurrent requests', async () => {
    const releases: (() => void)[] = []; const load = vi.fn(() => new Promise<CatalogPage>((resolve) => releases.push(() => resolve(page()))));
    const all = Array.from({ length: 6 }, (_, i) => requestCatalogPage('pending-' + i, load));
    const same = requestCatalogPage('pending-0', load); expect(load).toHaveBeenCalledTimes(CATALOG_MAX_REQUESTS);
    releases.splice(0).forEach((release) => release()); await Promise.resolve(); await Promise.resolve();
    expect(load).toHaveBeenCalledTimes(6); releases.splice(0).forEach((release) => release()); await Promise.all([...all, same]);
    expect(catalogCacheStats().running).toBe(0);
  });
  it('drops canceled queued subscribers before making any RPC', async () => {
    const releases: (() => void)[] = []; const load = () => new Promise<CatalogPage>((resolve) => releases.push(() => resolve(page())));
    const active = Array.from({ length: CATALOG_MAX_REQUESTS }, (_, i) => requestCatalogPage('active-' + i, load));
    const controller = new AbortController(); const queuedLoad = vi.fn(async () => page());
    const canceled = requestCatalogPage('canceled', queuedLoad, { signal: controller.signal }); const rejection = expect(canceled).rejects.toMatchObject({ name: 'AbortError' }); controller.abort(); await rejection;
    releases.forEach((release) => release()); await Promise.all(active); expect(queuedLoad).not.toHaveBeenCalled();
  });
  it('never lets an invalidated in-flight response repopulate the cache', async () => {
    let complete: (value: CatalogPage) => void = () => {}; const pending = requestCatalogPage('old', () => new Promise((resolve) => { complete = resolve; }));
    clearCatalogPages(); complete(page()); await pending; expect(peekCatalogPage('old')).toBeUndefined();
  });
  it('invalidates when saved source identities or opt-in change', async () => {
    syncCatalogSources('enabled-a'); await requestCatalogPage('a', async () => page()); syncCatalogSources('disabled-a'); expect(peekCatalogPage('a')).toBeUndefined();
  });
  it('prevents one slow source from occupying all request slots', async () => {
    let finish: (value: CatalogPage) => void = () => {};
    const slow = requestCatalogPage('slow-old', () => new Promise((resolve) => { finish = resolve; }), { sourceId: 'slow' });
    const queuedLoad = vi.fn(async () => page());
    const queued = requestCatalogPage('slow-new', queuedLoad, { sourceId: 'slow' });
    const fastLoad = vi.fn(async () => page()); await requestCatalogPage('fast', fastLoad, { sourceId: 'fast' });
    expect(fastLoad).toHaveBeenCalledOnce(); expect(queuedLoad).not.toHaveBeenCalled();
    finish(page()); await Promise.all([slow, queued]); expect(queuedLoad).toHaveBeenCalledOnce();
  });
  it('restores a compact page from localStorage after a restart and refreshes it', async () => {
    // 故意写入一个不完整的 manifest，证明持久化时会剥离它（重启恢复时解码仍能通过）。
    const withManifest = { ...page(), items: [{ ...plugin, manifest: { name: 'secret' } }] } as unknown as CatalogPage;
    await requestCatalogPage('restart', async () => withManifest);
    const name = CATALOG_STORAGE_PREFIX + 'restart';
    const raw = storage.getItem(name);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).page.items[0].manifest).toBeUndefined();
    vi.resetModules();
    const fresh = await import('./catalogPageCache');
    const restored = fresh.peekCatalogPage('restart');
    expect(restored?.page?.items).toHaveLength(1);
    expect(restored?.page?.items[0].manifest).toBeUndefined();
    expect(restored?.validUntil).toBe(0);
    const load = vi.fn(async () => ({ ...page(), items: [{ ...plugin, name: 'Fresh' }] }));
    await expect(fresh.requestCatalogPage('restart', load)).resolves.toMatchObject({ items: [{ name: 'Fresh' }] });
    expect(load).toHaveBeenCalledOnce();
    fresh.clearCatalogPages();
  });
  it('keeps transient search and paged results out of localStorage', async () => {
    await requestCatalogPage('transient', async () => page(), { persist: false });
    expect(storage.getItem(CATALOG_STORAGE_PREFIX + 'transient')).toBeNull();
    expect(peekCatalogPage('transient')?.page).toEqual(page());
  });
  it('drops corrupt persisted pages and clears persisted pages on reset', async () => {
    const broken = CATALOG_STORAGE_PREFIX + 'broken';
    storage.setItem(broken, '{not json');
    expect(peekCatalogPage('broken')).toBeUndefined();
    expect(storage.getItem(broken)).toBeNull();
    await requestCatalogPage('clear', async () => page());
    expect(storage.length).toBeGreaterThan(0);
    clearCatalogPages();
    const remaining = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    expect(remaining.every((name) => !name?.startsWith(CATALOG_STORAGE_PREFIX))).toBe(true);
  });

});
