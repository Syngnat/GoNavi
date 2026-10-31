import { describe, expect, it } from 'vitest';
import { catalogFilterKey, emptyMarketFilters, selectedPlatforms } from './catalogFilters';
describe('canonical multi-condition filters', () => {
  it('keeps the legacy current-platform path when no extra conditions exist', () => { expect(catalogFilterKey(emptyMarketFilters())).toBe(''); });
  it('includes every server condition and ignores multi-select order', () => {
    const value = { ...emptyMarketFilters(), categories: ['skill', 'ops'], platforms: ['linux/arm64', 'windows/amd64'], official: 'official' as const, author: ' GoNavi ' };
    expect(catalogFilterKey(value)).toBe(catalogFilterKey({ ...value, categories: ['ops', 'skill', 'ops'], platforms: value.platforms.slice().reverse() }));
    for (const change of [{ author: 'Other' }, { official: 'community' as const }, { platforms: ['all'] }, { categories: ['panel'] }]) expect(catalogFilterKey({ ...value, ...change })).not.toBe(catalogFilterKey(value));
  });
  it('treats current and all as exclusive platform modes', () => {
    expect(selectedPlatforms(['current', 'windows/amd64'], [])).toEqual(['windows/amd64']);
    expect(selectedPlatforms(['windows/amd64', 'all'], ['windows/amd64'])).toEqual(['all']);
    expect(selectedPlatforms(['all', 'current'], ['all'])).toEqual([]);
  });
});
