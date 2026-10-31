import { describe, expect, it } from 'vitest';
import { buildFontCatalogRows } from './catalogRows';
import type { FontEntry } from './types';

const remote: FontEntry = {
  id: 'published-jetbrains', version: '1', family: 'jetbrains mono', kind: 'mono',
  names: { 'en-US': 'JetBrains Mono' }, description: 'Test description', useCase: 'Test',
  font: { path: 'assets/' + 'a'.repeat(64) + '.ttf', sha256: 'a'.repeat(64), sizeBytes: 1, mimeType: 'font/ttf' },
  preview: { path: 'assets/' + 'b'.repeat(64) + '.ttf', sha256: 'b'.repeat(64), sizeBytes: 1, mimeType: 'font/ttf' },
  attribution: 'Test fixture', sourceUrl: 'https://example.com', rightsStatus: 'approved',
  license: { id: 'test', name: 'Test only', url: 'https://example.com/license', notice: 'Test', text: 'Test', nonCommercial: false },
};

describe('font catalog row partition and identity', () => {
  it('merges built-in and remote recommendations by family without inventing remote IDs', () => {
    const rows = buildFontCatalogRows([remote, { ...remote, version: '2' }]);
    const matching = rows.filter(row => row.family.toLowerCase() === 'jetbrains mono');
    expect(matching).toHaveLength(1);
    expect(matching[0].id).toBe('published-jetbrains');
    expect(matching[0].remote).toBe(remote);
  });

  it('keeps uninstalled recommendations visible without a remote catalog', () => {
    const rows = buildFontCatalogRows([]);
    expect(rows.some(row => row.family === 'JetBrains Mono')).toBe(true);
    expect(rows.some(row => row.family === 'Fira Code')).toBe(true);
    expect(rows.every(row => !row.remote)).toBe(true);
  });
});
