import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogPage } from './types';
import { CATALOG_MAX_BYTES, CATALOG_MAX_PAGES, CATALOG_MAX_REQUESTS, CATALOG_TTL_MS, catalogCacheStats, clearCatalogPages, peekCatalogPage, requestCatalogPage, syncCatalogSources } from './catalogPageCache';
const page = (): CatalogPage => ({ items: [], sourceId: 'source' });
beforeEach(() => { vi.useFakeTimers(); clearCatalogPages(); });
afterEach(() => vi.useRealTimers());
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

});
