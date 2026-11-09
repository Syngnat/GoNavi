import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketPlugin } from './types';

const api = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock('./sourceApi', () => ({ sourceMarketAPI: () => ({ detail: api.detail }) }));
import { resolveMarketPluginIcon } from './marketPluginIcon';

const sourceId = 'a'.repeat(64);
const plugin: MarketPlugin = {
  id: 'gh-author.tool', name: 'Tool', description: '', author: '', publisherId: 'gh-author', official: false,
  version: '1.0.0', platforms: ['any'], ratingAverage: 0, ratingCount: 0, downloadCount: 0, updatedAt: 'now',
  sourceUrl: 'https://github.com/author/tool', manifest: { schemaVersion: 1, apiVersion: 1, id: 'gh-author.tool', name: 'Tool', version: '1.0.0', icon: 'frontend/icon.png', permissions: [] },
};

const hualongPlugin: MarketPlugin = {
  ...plugin,
  id: 'com.gonavi.hualong-ai',
  name: '華龍算力',
  official: true,
  version: '1.2.2',
  sourceUrl: 'https://github.com/Syngnat/GoNavi-Plugin-Market',
  manifest: {
    schemaVersion: 1,
    apiVersion: 1,
    id: 'com.gonavi.hualong-ai',
    name: '華龍算力',
    version: '1.2.2',
    permissions: [],
    contributes: {
      aiProviders: [{ id: 'hualong', name: '華龍算力', command: 'provider', icon: 'icons/provider.png', supportsTools: true, supportsImages: false, models: [] }],
    },
  },
};

beforeEach(() => { api.detail.mockReset(); });

describe('resolve market plugin icon', () => {
  it('offers the AI provider icon under the official plugin directory first', async () => {
    await expect(resolveMarketPluginIcon(hualongPlugin, sourceId)).resolves.toEqual([
      'https://raw.githubusercontent.com/Syngnat/GoNavi-Plugin-Market/HEAD/plugins/hualong-ai-provider/icons/provider.png',
      'https://raw.githubusercontent.com/Syngnat/GoNavi-Plugin-Market/HEAD/plugins/hualong-ai/icons/provider.png',
      'https://raw.githubusercontent.com/Syngnat/GoNavi-Plugin-Market/HEAD/icons/provider.png',
    ]);
    expect(api.detail).not.toHaveBeenCalled();
  });

  it('reads the AI provider icon from detail when the catalog row has no manifest', async () => {
    api.detail.mockResolvedValue(hualongPlugin);
    await expect(resolveMarketPluginIcon({ ...hualongPlugin, manifest: undefined }, sourceId)).resolves.toEqual([
      'https://raw.githubusercontent.com/Syngnat/GoNavi-Plugin-Market/HEAD/plugins/hualong-ai-provider/icons/provider.png',
      'https://raw.githubusercontent.com/Syngnat/GoNavi-Plugin-Market/HEAD/plugins/hualong-ai/icons/provider.png',
      'https://raw.githubusercontent.com/Syngnat/GoNavi-Plugin-Market/HEAD/icons/provider.png',
    ]);
    expect(api.detail).toHaveBeenCalledWith(hualongPlugin.id);
  });

  it('uses the manifest declaration without fetching the detail again', async () => {
    await expect(resolveMarketPluginIcon(plugin, sourceId)).resolves.toEqual([
      'https://raw.githubusercontent.com/author/tool/HEAD/frontend/icon.png',
      'https://raw.githubusercontent.com/author/tool/HEAD/frontend/public/icon.png',
    ]);
    expect(api.detail).not.toHaveBeenCalled();
  });

  it('reads the manifest icon from the source detail when the catalog row has none', async () => {
    api.detail.mockResolvedValue({ ...plugin, manifest: { ...plugin.manifest, icon: 'icons/logo.png' } });
    await expect(resolveMarketPluginIcon({ ...plugin, manifest: undefined }, sourceId)).resolves.toEqual([
      'https://raw.githubusercontent.com/author/tool/HEAD/icons/logo.png',
    ]);
    expect(api.detail).toHaveBeenCalledWith(plugin.id);
  });

  it('returns no candidates when the source is not a GitHub repository', async () => {
    await expect(resolveMarketPluginIcon({ ...plugin, sourceUrl: 'https://example.com/author/tool' }, sourceId)).resolves.toEqual([]);
  });

  it('surfaces detail failures so the caller can retry without caching an empty result', async () => {
    api.detail.mockRejectedValue(new Error('market unavailable'));
    await expect(resolveMarketPluginIcon({ ...plugin, manifest: undefined, sourceUrl: '' }, sourceId)).rejects.toThrow('market unavailable');
  });
});
