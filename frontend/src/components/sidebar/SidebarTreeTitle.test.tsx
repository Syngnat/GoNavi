import { describe, expect, it } from 'vitest';
import { composeSidebarTableHoverTitle } from './SidebarTreeTitle';
import { catalogs } from '../../i18n/catalog';
import { SUPPORTED_LANGUAGES } from '../../i18n/resolveLanguage';

describe('composeSidebarTableHoverTitle', () => {
  it('returns name with comment on a separate line when a comment is present', () => {
    const result = composeSidebarTableHoverTitle('orders', 'customer orders');
    expect(result).toContain('orders');
    expect(result).toContain('customer orders');
    expect(result).toContain('\n');
  });
  it('falls back to the bare name when the comment is empty', () => {
    expect(composeSidebarTableHoverTitle('orders', '')).toBe('orders');
  });
  it('falls back to the bare name when the comment is whitespace only', () => {
    expect(composeSidebarTableHoverTitle('orders', '   ')).toBe('orders');
  });
  it('falls back to the bare name when the comment is null/undefined', () => {
    expect(composeSidebarTableHoverTitle('orders')).toBe('orders');
    expect(composeSidebarTableHoverTitle('orders', null)).toBe('orders');
  });
});

describe('sidebar.tree.table_comment_tooltip i18n key', () => {
  const KEY = 'sidebar.tree.table_comment_tooltip';
  it('exists in every supported locale catalog', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(typeof (catalogs as Record<string, Record<string, string>>)[language][KEY]).toBe('string');
      expect((catalogs as Record<string, Record<string, string>>)[language][KEY].length).toBeGreaterThan(0);
    }
  });
  it('keeps the name and comment placeholders in every locale', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const value = (catalogs as Record<string, Record<string, string>>)[language][KEY];
      expect(value).toContain('{{name}}');
      expect(value).toContain('{{comment}}');
    }
  });
});
