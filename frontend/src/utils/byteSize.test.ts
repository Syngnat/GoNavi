import { describe, expect, it } from 'vitest';
import { formatBytes } from './byteSize';

describe('formatBytes', () => {
  it('scales byte counts into 1024-based units', () => {
    expect(formatBytes(38136129)).toBe('36.4 MB');
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
  });

  it('returns a placeholder for unusable input', () => {
    expect(formatBytes(undefined)).toBe('--');
    expect(formatBytes(Number.NaN)).toBe('--');
    expect(formatBytes(-1)).toBe('--');
  });
});
