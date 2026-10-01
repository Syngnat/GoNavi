import { describe, expect, it } from 'vitest';

import { normalizeSQLAuditEvent } from '../audit/sqlAuditModel';
import {
  buildQueryHistorySqlPreview,
  deriveQueryHistoryStatusCounts,
  formatQueryHistoryDuration,
  getQueryHistoryDayOffset,
  groupQueryHistoryByDay,
  resolveQueryHistoryDurationLevel,
  resolveQueryHistoryRowMetric,
} from './queryHistoryModel';

const event = (id: string, timestamp: number) => normalizeSQLAuditEvent({ id, timestamp });

describe('queryHistoryModel', () => {
  it('derives cancelled count from the summary total', () => {
    expect(deriveQueryHistoryStatusCounts({ totalEvents: 10, successCount: 6, errorCount: 3 })).toEqual({
      all: 10,
      success: 6,
      error: 3,
      cancelled: 1,
    });
    expect(deriveQueryHistoryStatusCounts({ totalEvents: 2, successCount: 3, errorCount: 0 }).cancelled).toBe(0);
  });

  it('classifies durations and formats them compactly', () => {
    expect(resolveQueryHistoryDurationLevel(999)).toBe('normal');
    expect(resolveQueryHistoryDurationLevel(1_000)).toBe('slow');
    expect(resolveQueryHistoryDurationLevel(5_000)).toBe('critical');
    expect(formatQueryHistoryDuration(598)).toBe('598 ms');
    expect(formatQueryHistoryDuration(2_975)).toBe('2.98 s');
    expect(formatQueryHistoryDuration(12_340)).toBe('12.3 s');
    expect(formatQueryHistoryDuration(72_000)).toBe('1 m 12 s');
  });

  it('picks the most meaningful row metric', () => {
    expect(resolveQueryHistoryRowMetric({ rowsReturned: 6, rowsAffected: 0 })).toEqual({ kind: 'returned', count: 6 });
    expect(resolveQueryHistoryRowMetric({ rowsReturned: 0, rowsAffected: 5 })).toEqual({ kind: 'affected', count: 5 });
    expect(resolveQueryHistoryRowMetric({ rowsReturned: undefined, rowsAffected: 0 })).toEqual({ kind: 'affected', count: 0 });
    expect(resolveQueryHistoryRowMetric({ rowsReturned: 0, rowsAffected: undefined })).toEqual({ kind: 'returned', count: 0 });
    expect(resolveQueryHistoryRowMetric({ rowsReturned: undefined, rowsAffected: undefined })).toBeNull();
  });

  it('dedents multi-line SQL and drops blank lines for previews', () => {
    expect(buildQueryHistorySqlPreview('\n    SELECT a,\n\n      b\n    FROM t\n')).toBe('SELECT a,\n  b\nFROM t');
    expect(buildQueryHistorySqlPreview('')).toBe('');
    expect(buildQueryHistorySqlPreview('x'.repeat(2_000))).toHaveLength(900);
  });

  it('groups consecutive events by local day and reports the day offset', () => {
    const noon = new Date(2026, 8, 28, 12).getTime();
    const groups = groupQueryHistoryByDay([
      event('a', noon + 60_000),
      event('b', noon),
      event('c', noon - 86_400_000),
    ]);
    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([['a', 'b'], ['c']]);
    expect(getQueryHistoryDayOffset(groups[0].dayStart, noon)).toBe(0);
    expect(getQueryHistoryDayOffset(groups[1].dayStart, noon)).toBe(1);
  });
});
