import { beforeEach, describe, expect, it, vi } from 'vitest';
const host = vi.hoisted(() => ({ PluginMarketSourceSearch: vi.fn() }));
vi.mock('../../wailsjs/go/app/App', () => host);
import { searchSourceCatalog } from './sourceSearchApi';
import { emptyMarketFilters } from './catalogFilters';
const sourceId = 'a'.repeat(64);
beforeEach(() => vi.resetAllMocks());
describe('complete filter acknowledgement', () => {
  it('sends canonical filters explicitly to the registered source', async () => {
    host.PluginMarketSourceSearch.mockResolvedValue({ success: true, data: { items: [], sourceId, filterVersion: 1 } });
    await searchSourceCatalog(sourceId, 'nginx', 'rating', 'cursor', { ...emptyMarketFilters(), categories: ['skill', 'ops'], author: ' Team ' });
    expect(host.PluginMarketSourceSearch).toHaveBeenCalledWith(sourceId, 'nginx', 'rating', 'cursor', { categories: ['ops', 'skill'], platforms: [], official: '', author: 'Team' });
  });
  it.each([{ success: true, data: { items: [], sourceId } }, { success: false, data: { items: [], sourceId, error: 'filters_unsupported' } }])('rejects unsupported sources instead of showing unfiltered results', async (reply) => {
    host.PluginMarketSourceSearch.mockResolvedValue(reply);
    await expect(searchSourceCatalog(sourceId, '', 'updated', '', { ...emptyMarketFilters(), categories: ['ops'] })).rejects.toMatchObject({ key: 'plugin.market.filters_unsupported' });
  });
  it('rejects foreign result ownership', async () => {
    host.PluginMarketSourceSearch.mockResolvedValue({ success: true, data: { items: [], sourceId: 'b'.repeat(64), filterVersion: 1 } });
    await expect(searchSourceCatalog(sourceId, '', 'updated', '', emptyMarketFilters())).rejects.toThrow();
  });
});
