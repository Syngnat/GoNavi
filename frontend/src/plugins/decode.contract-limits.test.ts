import { describe, expect, it } from 'vitest';
import { decodeInspection, decodeManifest } from './decode';
import { validateUINode } from './uiValidation';

const inspection = (contributes: Record<string, unknown>, permissions: string[]) => ({
  manifest: { schemaVersion: 1, apiVersion: 1, id: 'example.contract', name: 'Contract', version: '1.0.0', permissions, contributes },
  digest: 'a'.repeat(64), sourcePath: 'fixture', sizeBytes: 10,
});
const htmlPage = (id: string, source: string) => ({ id, title: id, html: { source } });
// 宿主允许声明式表格 panel 到 500 行 × 32 列（frontend/src/plugins/uiValidation.ts:5）。
const tablePage = (rows: number, columns: number, cell: string | number = 'v') => ({
  id: 'grid',
  title: 'Grid',
  body: {
    type: 'table',
    columns: Array.from({ length: columns }, (_, index) => ({ key: `c${index}`, title: `C${index}` })),
    rows: Array.from({ length: rows }, () => Object.fromEntries(Array.from({ length: columns }, (_, index) => [`c${index}`, cell]))),
  },
});

describe('manifest contract limits', () => {
  it('accepts an inline page at the host HTML allowance', () => {
    const log2SQL = '<p>' + 'a'.repeat(43114) + '</p>';
    const permissions = ['ui.pages', 'ui.html-panel'];
    expect(decodeInspection(inspection({ pages: [htmlPage('log2sql', log2SQL)] }, permissions)).manifest.contributes?.pages?.[0].id).toBe('log2sql');
    const exact = 'a'.repeat(256 << 10);
    expect(decodeInspection(inspection({ pages: [htmlPage('max', exact)] }, permissions)).manifest.contributes?.pages?.[0].id).toBe('max');
  });
  it('accepts a legal large table page', () => {
    expect(decodeInspection(inspection({ pages: [tablePage(500, 32)] }, ['ui.pages'])).manifest.contributes?.pages).toHaveLength(1);
  });
  it.each([[3, 375003], [7, 874811]])('accepts %i numeric table pages within the actual manifest byte budget', (pageCount, expectedBytes) => {
    const pages = Array.from({ length: pageCount }, (_, index) => ({ ...tablePage(500, 32, 0), id: `grid-${index}` }));
    for (const page of pages) expect(validateUINode(page.body, new Set()).type).toBe('table');
    const payload = inspection({ pages }, ['ui.pages']);
    expect(new TextEncoder().encode(JSON.stringify(payload.manifest))).toHaveLength(expectedBytes);
    expect(decodeManifest(payload.manifest).contributes?.pages).toHaveLength(pageCount);
    expect(decodeInspection(payload).manifest.contributes?.pages).toHaveLength(pageCount);
  });
});

describe('manifest payload limits', () => {
  it('rejects numeric table pages once the actual manifest exceeds 1 MiB', () => {
    const pages = Array.from({ length: 9 }, (_, index) => ({ ...tablePage(500, 32, 0), id: `grid-${index}` }));
    for (const page of pages) expect(validateUINode(page.body, new Set()).type).toBe('table');
    const payload = inspection({ pages }, ['ui.pages']);
    expect(new TextEncoder().encode(JSON.stringify(payload.manifest))).toHaveLength(1124715);
    expect(() => decodeManifest(payload.manifest)).toThrow('plugin.ui.invalid_data');
    expect(() => decodeInspection(payload)).toThrow('plugin.ui.invalid_data');
  });
  it('rejects a manifest past the host manifest budget', () => {
    const pages = Array.from({ length: 5 }, (_, index) => htmlPage(`page${index}`, 'a'.repeat(220 << 10)));
    expect(() => decodeInspection(inspection({ pages }, ['ui.pages', 'ui.html-panel']))).toThrow('plugin.ui.invalid_data');
  });
  it('rejects a single string past the host HTML allowance', () => {
    const oversized = 'a'.repeat((256 << 10) + 1);
    expect(() => decodeInspection(inspection({ pages: [htmlPage('big', oversized)] }, ['ui.pages', 'ui.html-panel']))).toThrow();
  });
  it('rejects a page body nested past the manifest depth budget', () => {
    let body: Record<string, unknown> = { type: 'text', text: 'leaf' };
    for (let level = 0; level < 70; level += 1) body = { type: 'column', children: [body] };
    expect(() => decodeInspection(inspection({ pages: [{ id: 'deep', title: 'Deep', body }] }, ['ui.pages']))).toThrow('plugin.ui.invalid_data');
  });
});
