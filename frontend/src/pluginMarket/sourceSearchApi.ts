import { PluginMarketSourceSearch } from '../../wailsjs/go/app/App';
import { PluginAPIError, requireRecord } from '../plugins/apiResult';
import { isRecord } from '../plugins/jsonBoundary';
import { marketCatalogResult } from './catalogResult';
import { normalizeCatalogFilters, type CatalogFilters } from './catalogFilters';
import type { MarketSort } from './types';

export async function searchSourceCatalog(sourceId: string, query: string, sort: MarketSort, cursor: string, filters: CatalogFilters) {
  const response = requireRecord(await PluginMarketSourceSearch(sourceId, query, sort, cursor, normalizeCatalogFilters(filters)));
  if (response.success === false && isRecord(response.data) && response.data.error === 'filters_unsupported' && response.data.stale !== true) {
    throw new PluginAPIError('plugin.market.filters_unsupported');
  }
  const page = await marketCatalogResult(Promise.resolve(response));
  if (page.filterVersion !== 1) throw new PluginAPIError('plugin.market.filters_unsupported');
  if (page.sourceId !== sourceId || page.items.length > 24 || page.items.some((item) => item.sourceId !== sourceId)) throw new PluginAPIError('plugin.error.invalid_response');
  return page;
}
