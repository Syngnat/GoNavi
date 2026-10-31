import { describe, expect, it } from 'vitest';
import type { AccountKeyItem } from './aiPluginProviderAccountApi';
import { pageAccountKeys } from './pageAccountKeys';

const item = (id: string, name: string, key: string, groupName = ''): AccountKeyItem => ({
  id, name, key, groupName, status: 'active', quota: 0, quotaUsed: 0, lastUsedAt: '',
});

const items = [
  item('1', 'alpha-gpt', 'sk-aaaa1111bbbb'),
  item('2', 'beta-grok', 'sk-cccc2222dddd', 'Grok'),
  item('3', 'gamma', 'sk-eeee3333ffff'),
  item('4', 'delta', 'sk-gggg4444hhhh'),
  item('5', 'epsilon', 'sk-iiii5555jjjj'),
  item('6', 'zeta', 'sk-kkkk6666llll'),
  item('7', 'eta-search', 'sk-mmmm7777nnnn'),
];

describe('pageAccountKeys', () => {
  it('keeps five rows per page and reports the visible range', () => {
    const first = pageAccountKeys(items, '', 1);
    expect(first.slice.map((row) => row.id)).toEqual(['1', '2', '3', '4', '5']);
    expect(first).toMatchObject({ total: 7, pages: 2, from: 1, to: 5, page: 1 });
    const second = pageAccountKeys(items, '', 2);
    expect(second.slice.map((row) => row.id)).toEqual(['6', '7']);
    expect(second).toMatchObject({ from: 6, to: 7, page: 2 });
  });

  it('filters by name, group, and key suffix then resets overflow pages', () => {
    const named = pageAccountKeys(items, 'eta-search', 1);
    expect(named.slice.map((row) => row.id)).toEqual(['7']);
    expect(named.total).toBe(1);
    const grouped = pageAccountKeys(items, 'grok', 1);
    expect(grouped.slice.map((row) => row.id)).toEqual(['2']);
    const suffix = pageAccountKeys(items, 'bbbb', 9);
    expect(suffix.slice.map((row) => row.id)).toEqual(['1']);
    expect(suffix.page).toBe(1);
  });
});
