import { describe, expect, it } from 'vitest';

import { calculateImportTransferMetrics, formatImportBytes, formatImportDuration } from './importProgressMetrics';

describe('importProgressMetrics', () => {
  it('calculates a stable average throughput and ETA', () => {
    expect(calculateImportTransferMetrics({
      startedAt: 8_000,
      now: 18_000,
      bytesRead: 10 * 1024 * 1024,
      totalBytes: 20 * 1024 * 1024,
    })).toEqual({
      bytesPerSecond: 1024 * 1024,
      etaSeconds: 10,
    });
  });

  it('does not invent an ETA for unknown or stalled transfers', () => {
    expect(calculateImportTransferMetrics({ startedAt: 0, now: 5_000, bytesRead: 10, totalBytes: 100 }))
      .toEqual({ bytesPerSecond: 0, etaSeconds: 0 });
    expect(calculateImportTransferMetrics({ startedAt: 1_000, now: 2_000, bytesRead: 10, totalBytes: 0 }))
      .toEqual({ bytesPerSecond: 10, etaSeconds: 0 });
  });

  it('formats byte counts and durations compactly', () => {
    expect(formatImportBytes(1536)).toBe('1.5 KB');
    expect(formatImportBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatImportDuration(65)).toBe('1m 5s');
    expect(formatImportDuration(65, 'zh-CN')).toContain('分钟');
    expect(formatImportDuration(65, 'zh-CN')).toContain('秒');
  });
});
