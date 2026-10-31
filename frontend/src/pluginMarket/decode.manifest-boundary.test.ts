import { describe, expect, it } from 'vitest';
import { decodeCatalog, decodeMarketPlugin } from './decode';

// 信封字段与上限对齐 Go 侧 validateItem（internal/pluginmarket/catalog.go:145）。
const plugin = {
  id: 'com.gonavi.page-studio',
  name: 'Page Studio',
  description: 'Declarative page contribution fixture.',
  author: 'GoNavi',
  publisherId: 'com.gonavi',
  official: true,
  version: '1.0.0',
  platforms: ['windows/amd64'],
  ratingAverage: 4.5,
  ratingCount: 12,
  downloadCount: 340,
  updatedAt: '2026-10-26T07:25:05.322986Z',
};

// 宿主允许声明式页面嵌套 16 层节点（frontend/src/plugins/decode.ts:97）。
const pageBody = (levels: number) => {
  let body: Record<string, unknown> = { type: 'text', text: 'leaf' };
  for (let level = 0; level < levels; level += 1) body = { type: 'column', children: [body] };
  return body;
};

const manifest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  apiVersion: 1,
  id: 'com.gonavi.page-studio',
  name: 'Page Studio',
  version: '1.0.0',
  description: 'Declarative page contribution fixture.',
  author: 'GoNavi',
  permissions: ['ui.pages'],
  contributes: { pages: [{ id: 'studio', title: 'Studio', body: pageBody(16) }] },
  ...overrides,
});

describe('marketplace manifest boundary', () => {
  it('accepts a 375003-byte manifest with three numeric table pages in detail and catalog', () => {
    const pages = Array.from({ length: 3 }, (_, pageIndex) => ({
      id: `grid-${pageIndex}`, title: 'Grid',
      body: {
        type: 'table',
        columns: Array.from({ length: 32 }, (_, index) => ({ key: `c${index}`, title: `C${index}` })),
        rows: Array.from({ length: 500 }, () => Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`c${index}`, 0]))),
      },
    }));
    const numeric = { schemaVersion: 1, apiVersion: 1, id: 'example.contract', name: 'Contract', version: '1.0.0', permissions: ['ui.pages'], contributes: { pages } };
    expect(new TextEncoder().encode(JSON.stringify(numeric))).toHaveLength(375003);
    const data = { ...plugin, id: numeric.id, name: numeric.name, manifest: numeric };
    expect(decodeMarketPlugin(data).manifest?.contributes?.pages).toHaveLength(3);
    expect(decodeCatalog({ items: [data] }).items[0].manifest?.contributes?.pages).toHaveLength(3);
  });
  it('keeps a 256 KiB HTML manifest and a 32 KiB market description without trimming other fields', () => {
    const source = 'a'.repeat(256 << 10);
    const data = {
      ...plugin, description: 'd'.repeat(32 << 10), sourceId: 's'.repeat(64), category: 'tools', minHostVersion: '0.1.0',
      manifest: manifest({ permissions: ['ui.pages', 'ui.html-panel'], contributes: { pages: [{ id: 'html', title: 'HTML', html: { source } }] } }),
    };
    const decoded = decodeMarketPlugin(data);
    expect(decoded).toMatchObject({ description: data.description, sourceId: data.sourceId, category: data.category, minHostVersion: data.minHostVersion });
    expect(decoded.manifest?.contributes?.pages?.[0].html?.source).toBe(source);
  });
  it('accepts a detail whose declarative page body nests to the host limit', () => {
    const decoded = decodeMarketPlugin({ ...plugin, manifest: manifest() });
    expect(decoded.manifest?.contributes?.pages?.[0].id).toBe('studio');
  });
  it('accepts a host-sized manifest description', () => {
    const long = 'd'.repeat(9000);
    expect(decodeMarketPlugin({ ...plugin, manifest: manifest({ description: long }) }).manifest?.description).toHaveLength(9000);
  });
  it('applies the same budget to catalog items', () => {
    const page = decodeCatalog({ items: [{ ...plugin, manifest: manifest() }], stale: false, sourceId: 'com.gonavi' });
    expect(page.items[0].manifest?.contributes?.pages?.[0].title).toBe('Studio');
  });
});

describe('marketplace metadata limits', () => {
  it('measures the artifact platform limit in UTF-8 bytes', () => {
    const platform = '中'.repeat(21) + 'a';
    const artifact = { url: 'https://example.com/plugin.zip', sha256: 'a'.repeat(64), sizeBytes: 1, platform, version: plugin.version };
    expect(new TextEncoder().encode(platform)).toHaveLength(64);
    expect(decodeMarketPlugin({ ...plugin, artifact }).artifact?.platform).toBe(platform);
    expect(() => decodeMarketPlugin({ ...plugin, artifact: { ...artifact, platform: platform + 'a' } }))
      .toThrow('plugin.error.invalid_response');
  });
  it('measures each market platform limit in UTF-8 bytes', () => {
    const exact = '中'.repeat(21) + 'a';
    expect(new TextEncoder().encode(exact)).toHaveLength(64);
    expect(decodeMarketPlugin({ ...plugin, platforms: [exact] }).platforms).toEqual([exact]);
    expect(() => decodeMarketPlugin({ ...plugin, platforms: [exact + 'a'] })).toThrow('plugin.error.invalid_response');
  });
  it('accepts 64 platforms but rejects one more platform', () => {
    const platforms = Array.from({ length: 64 }, (_, index) => `platform-${index}`);
    expect(decodeMarketPlugin({ ...plugin, platforms }).platforms).toEqual(platforms);
    expect(() => decodeMarketPlugin({ ...plugin, platforms: [...platforms, 'extra'] })).toThrow('plugin.error.invalid_response');
  });
  it.each(['detail', 'catalog'])('accepts a 32 KiB market description and rejects one more UTF-8 byte in %s', (path) => {
    const description = '中'.repeat(10922) + 'aa';
    expect(new TextEncoder().encode(description)).toHaveLength(32 << 10);
    const data = { ...plugin, description };
    const decoded = path === 'detail' ? decodeMarketPlugin(data) : decodeCatalog({ items: [data] }).items[0];
    expect(decoded.description).toBe(description);
    const oversized = { ...data, description: description + 'a' };
    expect(() => path === 'detail' ? decodeMarketPlugin(oversized) : decodeCatalog({ items: [oversized] }))
      .toThrow('plugin.error.invalid_response');
  });
  it.each(['name', 'author', 'publisherId'])('rejects a 9000-byte market %s in detail and catalog', (field) => {
    const data = { ...plugin, [field]: 'a'.repeat(9000) };
    expect(() => decodeMarketPlugin(data)).toThrow('plugin.error.invalid_response');
    expect(() => decodeCatalog({ items: [data] })).toThrow('plugin.error.invalid_response');
  });
  it.each([['name', 256], ['author', 512], ['publisherId', 256], ['category', 128], ['minHostVersion', 128]] as const)
    ('measures the market %s limit in UTF-8 bytes', (field, limit) => {
      const exact = '中'.repeat(Math.floor(limit / 3)) + 'a'.repeat(limit % 3);
      expect(new TextEncoder().encode(exact)).toHaveLength(limit);
      const data = { ...plugin, [field]: exact };
      expect(decodeMarketPlugin(data)[field]).toBe(exact);
      expect(decodeCatalog({ items: [data] }).items[0][field]).toBe(exact);
      const oversized = { ...data, [field]: exact + 'a' };
      expect(() => decodeMarketPlugin(oversized)).toThrow('plugin.error.invalid_response');
      expect(() => decodeCatalog({ items: [oversized] })).toThrow('plugin.error.invalid_response');
    });
});

describe('marketplace payload limits', () => {
  it('rejects a market string above the manifest text cap', () => {
    expect(() => decodeMarketPlugin({ ...plugin, manifest: manifest({ description: 'a'.repeat((256 << 10) + 1) }) }))
      .toThrow('plugin.ui.invalid_data');
  });
  it('rejects an envelope beyond the detail byte budget', () => {
    const big = 'a'.repeat(240 << 10);
    expect(() => decodeMarketPlugin({ ...plugin, name: big, description: big, author: big, publisherId: big, version: big }))
      .toThrow('plugin.ui.invalid_data');
  });
  it('rejects prototype pollution keys', () => {
    const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => decodeMarketPlugin({ ...plugin, manifest: manifest({ extra: polluted }) }))
      .toThrow('plugin.ui.invalid_data');
  });
  it('rejects cyclic payloads', () => {
    const cyclic: Record<string, unknown> = { ...plugin, manifest: manifest() };
    cyclic.self = cyclic;
    expect(() => decodeMarketPlugin(cyclic)).toThrow('plugin.ui.invalid_data');
  });
  it('rejects a page body deeper than the host node limit', () => {
    expect(() => decodeMarketPlugin({ ...plugin, manifest: manifest({ contributes: { pages: [{ id: 'deep', title: 'Deep', body: pageBody(17) }] } }) }))
      .toThrow(/invalid_response/);
  });
  it('rejects a payload nested past the manifest depth budget', () => {
    let nested: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 70; level += 1) nested = { nested };
    expect(() => decodeMarketPlugin({ ...plugin, manifest: manifest({ extra: nested }) }))
      .toThrow('plugin.ui.invalid_data');
  });
});
