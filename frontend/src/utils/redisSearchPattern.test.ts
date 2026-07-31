import { describe, expect, it } from 'vitest';

import { normalizeRedisSearchDraftChange, normalizeRedisSearchInput } from './redisSearchPattern';

describe('normalizeRedisSearchInput', () => {
  it('returns wildcard for empty input', () => {
    expect(normalizeRedisSearchInput('')).toEqual({
      keyword: '',
      pattern: '*',
    });
  });

  it('adds only a trailing wildcard for prefix matching', () => {
    expect(normalizeRedisSearchInput('order')).toEqual({
      keyword: 'order',
      pattern: '[oO][rR][dD][eE][rR]*',
    });
  });

  it('builds ascii case-insensitive patterns for letter keywords', () => {
    expect(normalizeRedisSearchInput('agent')).toEqual({
      keyword: 'agent',
      pattern: '[aA][gG][eE][nN][tT]*',
    });
  });

  it('escapes redis glob special characters as literals', () => {
    expect(normalizeRedisSearchInput('user:*:[id]?')).toEqual({
      keyword: 'user:*:[id]?',
      pattern: '[uU][sS][eE][rR]:\\*:\\[[iI][dD]\\]\\?*',
    });
  });

  it('uses literal key pattern without fuzzy wildcards in exact mode', () => {
    expect(normalizeRedisSearchInput('Order:1001', 'exact')).toEqual({
      keyword: 'Order:1001',
      pattern: 'Order:1001',
    });
  });

  it('escapes redis glob special characters in exact mode without adding wildcards', () => {
    expect(normalizeRedisSearchInput('user:*:[id]?\\raw', 'exact')).toEqual({
      keyword: 'user:*:[id]?\\raw',
      pattern: 'user:\\*:\\[id\\]\\?\\\\raw',
    });
  });

  it('marks empty draft changes for immediate reset search', () => {
    expect(normalizeRedisSearchDraftChange('')).toEqual({
      keyword: '',
      pattern: '*',
      shouldSearchImmediately: true,
    });
  });
});
