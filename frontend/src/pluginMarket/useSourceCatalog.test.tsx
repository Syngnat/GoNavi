import { act, create } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketPlugin, MarketSort } from './types';
const requests = vi.hoisted(() => ({ catalog: vi.fn() }));
vi.mock('./sourceApi', () => ({ sourceMarketAPI: (id: string) => ({ catalog: (...args: unknown[]) => requests.catalog(id, ...args) }) }));
import { useSourceCatalog } from './useSourceCatalog';
import { CATALOG_TTL_MS, clearCatalogPages } from './catalogPageCache';
const outputs = new Map<string, ReturnType<typeof useSourceCatalog>>();
function Harness({ id = 'a', query = '', sort = 'updated', revision = 0 }: { id?: string; query?: string; sort?: MarketSort; revision?: number }) {
  outputs.set(id, useSourceCatalog(id, id === 'a', query, sort, revision)); return null;
}
const item = (id: string): MarketPlugin => ({ id, name: id, author: '', publisherId: '', description: '', version: '1.0.0', official: true,
  platforms: [], ratingAverage: 0, ratingCount: 0, downloadCount: 0, updatedAt: 'now' });
let renderer: ReturnType<typeof create> | undefined;
const output = (id = 'a') => outputs.get(id)!;
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(250); }); }
async function mount() { await act(async () => { renderer = create(<Harness />); }); await tick(); }
beforeEach(() => { vi.useFakeTimers(); clearCatalogPages(); vi.resetAllMocks(); outputs.clear(); });
afterEach(() => { if (renderer) act(() => renderer!.unmount()); renderer = undefined; vi.useRealTimers(); });
describe('independent bounded source pages', () => {
  it('replaces each page instead of accumulating cards and supports back navigation', async () => {
    requests.catalog.mockResolvedValueOnce({ items: Array.from({ length: 24 }, (_, i) => item('test.first-' + i)), nextCursor: 'second' })
      .mockResolvedValueOnce({ items: [item('test.last')], nextCursor: '' })
      .mockResolvedValueOnce({ items: [item('test.first')], nextCursor: 'second' });
    await mount(); expect(output().items).toHaveLength(24);
    await act(async () => { output().next(); }); await tick();
    expect(output().page).toBe(2); expect(output().items.map((p) => p.id)).toEqual(['test.last']);
    expect(requests.catalog).toHaveBeenLastCalledWith('a', '', 'updated', 'second');
    await act(async () => { output().previous(); }); await tick();
    expect(output().page).toBe(1); expect(output().items[0].id).toBe('test.first-0'); expect(requests.catalog).toHaveBeenCalledTimes(2);
  });
  it('isolates source failures and cursor state for duplicate plugin IDs', async () => {
    requests.catalog.mockImplementation((id: string) => id === 'b' ? Promise.reject(new Error('private offline')) : Promise.resolve({ items: [item('test.same')], nextCursor: 'a-next' }));
    await act(async () => { renderer = create(<><Harness id="a" /><Harness id="b" /></>); }); await tick();
    expect(output('a').items).toHaveLength(1); expect(output('a').error).toBe(''); expect(output('b').error).toBeTruthy(); expect(output('b').error).not.toContain('private offline');
    expect(output('b').items).toEqual([]); expect(output('b').page).toBe(1);
  });
  it('retains identical plugin IDs independently and removes custom-source official claims', async () => {
    requests.catalog.mockResolvedValue({ items: [item('test.same')] });
    await act(async () => { renderer = create(<><Harness id="a" /><Harness id="b" /></>); }); await tick();
    expect(output('a').items[0].id).toBe(output('b').items[0].id);
    expect(output('a').items[0].official).toBe(true); expect(output('b').items[0].official).toBe(false);
  });
  it('resets to the first cursor for shared search and sort changes', async () => {
    requests.catalog.mockResolvedValue({ items: [item('test.item')], nextCursor: 'more' }); await mount();
    await act(async () => { output().next(); }); await tick(); expect(output().page).toBe(2);
    await act(async () => { renderer!.update(<Harness query="nginx" sort="downloads" />); }); await tick();
    expect(output().page).toBe(1); expect(requests.catalog).toHaveBeenLastCalledWith('a', 'nginx', 'downloads', '');
  });
  it('drops late responses after the search changes', async () => {
    let complete: (page: { items: MarketPlugin[] }) => void = () => {};
    requests.catalog.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; })).mockResolvedValue({ items: [item('test.new')] });
    await mount(); await act(async () => { renderer!.update(<Harness query="new" />); complete({ items: [item('test.old')] }); }); await tick();
    expect(output().items.map((p) => p.id)).toEqual(['test.new']);
  });
  it('does not advance using cached or cyclic cursors', async () => {
    requests.catalog.mockResolvedValue({ items: [item('test.cached')], nextCursor: 'more', stale: true, error: 'timeout' });
    await mount(); expect(output().canNext).toBe(false);
    await act(async () => { output().next(); }); expect(output().page).toBe(1);
  });
  it('keeps the current cursor on refresh', async () => {
    requests.catalog.mockResolvedValue({ items: [item('test.item')], nextCursor: 'second' }); await mount();
    await act(async () => { output().next(); }); await tick();
    await act(async () => { renderer!.update(<Harness revision={1} />); }); await tick();
    expect(output().page).toBe(2); expect(requests.catalog).toHaveBeenLastCalledWith('a', '', 'updated', 'second');
  });
});
