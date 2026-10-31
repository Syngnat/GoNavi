import { describe, expect, it } from 'vitest';
import { boundedJSON } from '../plugins/jsonBoundary';
import { decodeVersionPage } from './versionsApi';

// 版本页每行都是完整市场条目（internal/pluginmarket/versions.go:15），信封字段对齐 validateItem。
const base = {
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

// 声明式页面：宿主允许 16 层节点嵌套（frontend/src/plugins/decode.ts:97）。
const pageBody = (levels: number, text = 'leaf') => {
  let body: Record<string, unknown> = { type: 'text', text };
  for (let level = 0; level < levels; level += 1) body = { type: 'column', children: [body] };
  return body;
};

const row = (version: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  plugin: {
    ...base,
    version,
    manifest: {
      schemaVersion: 1,
      apiVersion: 1,
      id: base.id,
      name: base.name,
      version,
      description: base.description,
      author: base.author,
      permissions: ['ui.pages'],
      contributes: { pages: [{ id: 'studio', title: 'Studio', body }] },
      ...extra,
    },
  },
  compatible: true,
  reason: '',
});

describe('version page manifest boundary', () => {
  it('accepts a 375003-byte manifest with three numeric table pages in a version row', () => {
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
    const entry = { plugin: { ...base, id: numeric.id, name: numeric.name, manifest: numeric }, compatible: true, reason: '' };
    expect(decodeVersionPage({ versions: [entry] }).versions[0].plugin.manifest?.contributes?.pages).toHaveLength(3);
  });
  it('accepts several versions whose manifests carry a declarative page', () => {
    const page = decodeVersionPage({ versions: ['1.0.0', '1.0.1', '1.1.0'].map((version) => row(version, pageBody(16, 'a'.repeat(9000)))) });
    expect(page.versions.map((entry) => entry.plugin.version)).toEqual(['1.0.0', '1.0.1', '1.1.0']);
  });
  it('accepts a manifest text past the general string cap', () => {
    expect(decodeVersionPage({ versions: [row('1.0.0', pageBody(1, 'a'.repeat(9000)))] }).versions).toHaveLength(1);
  });
  it('accepts a page body nested past the general depth cap', () => {
    expect(decodeVersionPage({ versions: [row('1.0.0', pageBody(16))] }).versions[0].plugin.manifest?.contributes?.pages?.[0].title).toBe('Studio');
  });
  it('accepts a manifest whose own schema uses the manifest depth budget', () => {
    let schema: Record<string, unknown> = {};
    for (let level = 0; level < 62; level += 1) schema = { properties: schema };
    const payload = { versions: [row('1.0.0', pageBody(1), { configSchema: schema })] };
    expect(() => boundedJSON(payload)).toThrow('plugin.ui.invalid_data');
    expect(decodeVersionPage(payload).versions).toHaveLength(1);
  });
  it('accepts a row whose manifest carries a host-sized inline page', () => {
    const permissions = ['ui.pages', 'ui.html-panel'];
    const log2SQL = { pages: [{ id: 'log2sql', title: 'Log2SQL', html: { source: '<p>' + 'a'.repeat(43114) + '</p>' } }] };
    expect(decodeVersionPage({ versions: [row('1.0.0', pageBody(1), { permissions, contributes: log2SQL })] })
      .versions[0].plugin.manifest?.contributes?.pages?.[0].id).toBe('log2sql');
    const exact = { pages: [{ id: 'max', title: 'Max', html: { source: 'a'.repeat(256 << 10) } }] };
    expect(decodeVersionPage({ versions: [row('1.0.0', pageBody(1), { permissions, contributes: exact })] }).versions).toHaveLength(1);
  });
  it('accepts a row whose manifest declares a host-sized table page', () => {
    const body = {
      type: 'table',
      columns: Array.from({ length: 32 }, (_, index) => ({ key: `c${index}`, title: `C${index}` })),
      rows: Array.from({ length: 500 }, () => Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`c${index}`, 'v']))),
    };
    expect(decodeVersionPage({ versions: [row('1.0.0', body)] }).versions).toHaveLength(1);
  });
});

describe('version page metadata limits', () => {
  it('accepts a 32 KiB market description and rejects one more UTF-8 byte in a version row', () => {
    const description = '中'.repeat(10922) + 'aa';
    expect(new TextEncoder().encode(description)).toHaveLength(32 << 10);
    const entry = row('1.0.0', pageBody(1));
    entry.plugin.description = description;
    expect(decodeVersionPage({ versions: [entry] }).versions[0].plugin.description).toBe(description);
    entry.plugin.description += 'a';
    expect(() => decodeVersionPage({ versions: [entry] })).toThrow('plugin.error.invalid_response');
  });
  it.each(['name', 'author', 'publisherId'] as const)('rejects a 9000-byte market %s in a version row', (field) => {
    const entry = row('1.0.0', pageBody(1));
    entry.plugin[field] = 'a'.repeat(9000);
    expect(() => decodeVersionPage({ versions: [entry] })).toThrow('plugin.error.invalid_response');
  });
});

describe('version page payload limits', () => {
  it('rejects a page beyond the host response budget', () => {
    const rows = Array.from({ length: 100 }, (_, index) => row(`1.0.${index}`, {
      type: 'column',
      children: [0, 1, 2].map(() => ({ type: 'text', text: 'a'.repeat(8000) })),
    }));
    expect(() => decodeVersionPage({ versions: rows })).toThrow('plugin.ui.invalid_data');
  });
  it('rejects a payload nested past the envelope depth budget', () => {
    let nested: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 70; level += 1) nested = { nested };
    expect(() => decodeVersionPage({ versions: [row('1.0.0', nested)] })).toThrow('plugin.ui.invalid_data');
  });
  it('rejects prototype pollution keys inside a version row', () => {
    const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(() => decodeVersionPage({ versions: [row('1.0.0', polluted)] })).toThrow('plugin.ui.invalid_data');
  });
  it('rejects cyclic version payloads', () => {
    const cyclic: Record<string, unknown> = { versions: [row('1.0.0', pageBody(1))] };
    cyclic.self = cyclic;
    expect(() => decodeVersionPage(cyclic)).toThrow('plugin.ui.invalid_data');
  });
  it('rejects a row whose manifest exceeds the item budget', () => {
    const pages = Array.from({ length: 5 }, (_, index) => ({ id: `page${index}`, title: `Page${index}`, html: { source: 'a'.repeat(220 << 10) } }));
    const extra = { permissions: ['ui.pages', 'ui.html-panel'], contributes: { pages } };
    expect(() => decodeVersionPage({ versions: [row('1.0.0', pageBody(1), extra)] })).toThrow();
  });
});
