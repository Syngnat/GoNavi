import { describe, expect, it } from 'vitest';

import { formatMessageTime, formatProcessingDuration } from './aiMessageTimeFormat';

const at = (year: number, month: number, day: number, h: number, m: number, s: number) =>
  new Date(year, month - 1, day, h, m, s).getTime();

describe('AI message time formatting', () => {
  const now = at(2026, 9, 30, 16, 0, 0);

  it('shows only the clock time for today', () => {
    expect(formatMessageTime(at(2026, 9, 30, 9, 5, 7), now)).toBe('09:05:07');
  });

  it('adds the date for earlier days and other years', () => {
    expect(formatMessageTime(at(2026, 9, 29, 23, 59, 1), now)).toBe('09-29 23:59:01');
    expect(formatMessageTime(at(2025, 12, 31, 8, 0, 0), now)).toBe('2025-12-31 08:00:00');
  });

  it('shows nothing for a missing time', () => {
    expect(formatMessageTime(0, now)).toBe('');
    expect(formatMessageTime(Number.NaN, now)).toBe('');
  });

  it('formats processing time with the reader language', () => {
    expect(formatProcessingDuration(6_240, 'en-US')).toBe('6.2s');
    expect(formatProcessingDuration(41_300, 'en-US')).toBe('41s');
    expect(formatProcessingDuration(125_000, 'en-US')).toBe('2m 5s');
    expect(formatProcessingDuration(120_000, 'en-US')).toBe('2m');
    expect(formatProcessingDuration(3_780_000, 'en-US')).toBe('1h 3m');
    expect(formatProcessingDuration(41_300, 'zh-CN')).toContain('41');
  });

  it('shows nothing for an unknown duration', () => {
    expect(formatProcessingDuration(0)).toBe('');
    expect(formatProcessingDuration(-5)).toBe('');
    expect(formatProcessingDuration(Number.NaN)).toBe('');
  });
});
