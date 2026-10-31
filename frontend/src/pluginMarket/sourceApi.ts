import {
  PluginMarketSources, PluginMarketSaveSources, PluginMarketSourceSettings, PluginMarketSourceCatalog,
  PluginMarketSourceDetail, PluginMarketSourceRatings,
} from '../../wailsjs/go/app/App';
import { PluginAPIError, pluginResult, requireRecord } from '../plugins/apiResult';
import { boundedJSON } from '../plugins/jsonBoundary';
import { decodeSettings, decodeMarketPlugin, decodeRatings, safeHTTPURL } from './decode';
import { marketAPI } from './api';
import { marketCatalogResult } from './catalogResult';
import type { MarketSource, MarketSourceConfig, MarketSort } from './types';

export function decodeSources(data: unknown): MarketSource[] {
  boundedJSON(data, 128 << 10);
  if (!Array.isArray(data) || data.length > 32) throw new PluginAPIError('plugin.error.invalid_response');
  const seen = new Set<string>();
  return data.map((value) => {
    const row = requireRecord(value);
    if (typeof row.baseUrl !== 'string' || row.baseUrl.length > 2048 || !safeHTTPURL(row.baseUrl)
      || typeof row.sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(row.sourceId) || seen.has(row.sourceId)
      || typeof row.enabled !== 'boolean' || typeof row.trustedOfficial !== 'boolean') throw new PluginAPIError('plugin.error.invalid_response');
    seen.add(row.sourceId);
    return { baseUrl: row.baseUrl, sourceId: row.sourceId, enabled: row.enabled, trustedOfficial: row.trustedOfficial };
  });
}
export const marketSourcesAPI = {
  list: () => pluginResult(PluginMarketSources(), decodeSources),
  save: (sources: MarketSourceConfig[]) => pluginResult(PluginMarketSaveSources(sources), decodeSources),
};

export function sourceMarketAPI(sourceId: string): typeof marketAPI {
  return {
    ...marketAPI,
    settings: async () => {
      const settings = await pluginResult(PluginMarketSourceSettings(sourceId), decodeSettings);
      if (settings.sourceId !== sourceId) throw new PluginAPIError('plugin.market.error.source_changed');
      return settings;
    },
    configure: async () => { throw new PluginAPIError('plugin.market.error.source_changed'); },
    catalog: async (query: string, sort: MarketSort, cursor: string) => {
      const page = await marketCatalogResult(PluginMarketSourceCatalog(sourceId, query, sort, cursor));
      if (page.sourceId !== sourceId || page.items.length > 24 || page.items.some((item) => item.sourceId !== sourceId)) {
        throw new PluginAPIError('plugin.error.invalid_response');
      }
      return page;
    },
    detail: (id) => pluginResult(PluginMarketSourceDetail(sourceId, id), decodeMarketPlugin),
    ratings: (id) => pluginResult(PluginMarketSourceRatings(sourceId, id), decodeRatings),
  };
}
