import { describe, expect, it } from 'vitest';

import { formatTokenCount } from './aiObservabilityFormatting';

describe('AI observability number formatting', () => {
  it('formats token counts with locale-independent K, M, and B suffixes', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1_000)).toBe('1K');
    expect(formatTokenCount(7_500)).toBe('7.5K');
    expect(formatTokenCount(75_000)).toBe('75K');
    expect(formatTokenCount(1_250_000)).toBe('1.3M');
    expect(formatTokenCount(2_500_000_000)).toBe('2.5B');
  });
});
