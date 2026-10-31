import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const requests = vi.hoisted(() => ({ catalog: vi.fn() }));
vi.mock('./sourceApi', () => ({ sourceMarketAPI: (id: string) => ({ catalog: (...args: unknown[]) => requests.catalog(id, ...args) }) }));
import { useSourceCatalog } from './useSourceCatalog';
import { CATALOG_TTL_MS, clearCatalogPages } from './catalogPageCache';
let output: ReturnType<typeof useSourceCatalog>;
function Harness({ id = 'reentry' }: { id?: string }) { output = useSourceCatalog(id, true, '', 'updated', 0); return null; }
const plugin = { id: 'test.one', name: 'One', author: '', publisherId: '', description: '', version: '1.0.0', official: true,
  platforms: [], ratingAverage: 0, ratingCount: 0, downloadCount: 0, updatedAt: 'now' };
let renderer: ReturnType<typeof create> | undefined;
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); }
beforeEach(() => { vi.useFakeTimers(); clearCatalogPages(); vi.resetAllMocks(); requests.catalog.mockResolvedValue({ items: [plugin], nextCursor: '' }); });
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; vi.useRealTimers(); });
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

});
