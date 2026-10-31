import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogFilters } from './catalogFilters';
const calls = vi.hoisted(() => ({ legacy: vi.fn(), search: vi.fn() }));
vi.mock('./sourceApi', () => ({ sourceMarketAPI: () => ({ catalog: (...args: unknown[]) => calls.legacy(...args) }) }));
vi.mock('./sourceSearchApi', () => ({ searchSourceCatalog: (...args: unknown[]) => calls.search(...args) }));
import { emptyMarketFilters } from './catalogFilters';
import { clearCatalogPages } from './catalogPageCache';
import { useSourceCatalog } from './useSourceCatalog';
let catalog: ReturnType<typeof useSourceCatalog>;
function Harness({ filters = emptyMarketFilters() }: { filters?: CatalogFilters }) { catalog = useSourceCatalog('source', true, '', 'updated', 0, filters); return null; }
let renderer: ReturnType<typeof create> | undefined;
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); }
async function mount(filters?: CatalogFilters) { await act(async () => { renderer = create(<Harness filters={filters} />); }); await tick(); }
beforeEach(() => { vi.useFakeTimers(); clearCatalogPages(); vi.resetAllMocks(); calls.legacy.mockResolvedValue({ items: [] }); calls.search.mockResolvedValue({ items: [], nextCursor: 'next' }); });
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; vi.useRealTimers(); });
describe('full-filter paging and cache identity', () => {
  it('keeps default browsing compatible with older sources', async () => { await mount(); expect(calls.legacy).toHaveBeenCalledOnce(); expect(calls.search).not.toHaveBeenCalled(); });
  it('sends every condition to the explicit source search before paging', async () => {
    const filters = { ...emptyMarketFilters(), categories: ['ops'], official: 'official' as const, platforms: ['all'], author: ' Team ' };
    await mount(filters); expect(calls.legacy).not.toHaveBeenCalled();
    expect(calls.search).toHaveBeenLastCalledWith('source', '', 'updated', '', { categories: ['ops'], official: 'official', platforms: ['all'], author: 'Team' });
    await act(async () => { catalog.next(); }); await tick(); expect(catalog.page).toBe(2);
    await act(async () => { renderer!.update(<Harness filters={{ ...filters, categories: ['skill'] }} />); }); await tick();
    expect(catalog.page).toBe(1); expect(calls.search).toHaveBeenLastCalledWith('source', '', 'updated', '', { categories: ['skill'], official: 'official', platforms: ['all'], author: 'Team' });
  });
  it('does not mix caches and reuses semantically identical filter sets', async () => {
    const a = { ...emptyMarketFilters(), categories: ['ops', 'skill'] };
    await mount(a); await act(async () => { renderer!.update(<Harness filters={{ ...a, official: 'community' }} />); }); await tick();
    expect(calls.search).toHaveBeenCalledTimes(2);
    await act(async () => { renderer!.update(<Harness filters={{ ...a, categories: ['skill', 'ops'] }} />); }); await tick();
    expect(calls.search).toHaveBeenCalledTimes(2); expect(catalog.loading).toBe(false);
  });
});
