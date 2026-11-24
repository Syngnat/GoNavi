import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TABLE_OVERVIEW_COMPACT_COLUMNS,
  sanitizeTableOverviewCompactColumnWidths,
  sanitizeTableOverviewCompactColumns,
} from './tableOverviewCompactColumns';

describe('table overview compact columns', () => {
  it('shows charset and collation by default', () => {
    expect(DEFAULT_TABLE_OVERVIEW_COMPACT_COLUMNS).toEqual(expect.arrayContaining([
      'charset',
      'collation',
    ]));
  });

  it('drops unknown keys, removes duplicates, and always keeps the name column', () => {
    expect(sanitizeTableOverviewCompactColumns([
      'collation',
      'unknown',
      'collation',
      'rows',
    ])).toEqual(['name', 'rows', 'collation']);
  });

  it('falls back to every default column for malformed persisted data', () => {
    expect(sanitizeTableOverviewCompactColumns({ columns: ['rows'] })).toEqual(
      DEFAULT_TABLE_OVERVIEW_COMPACT_COLUMNS,
    );
  });

  it('keeps finite column widths and clamps them to the supported range', () => {
    expect(sanitizeTableOverviewCompactColumnWidths({
      name: 320.4,
      comment: 12,
      rows: 5000,
      unknown: 240,
      dataSize: Number.NaN,
      indexSize: '180',
    })).toEqual({
      name: 320,
      comment: 64,
      rows: 2000,
    });
  });

  it('falls back to automatic widths for malformed persisted data', () => {
    expect(sanitizeTableOverviewCompactColumnWidths(null)).toEqual({});
    expect(sanitizeTableOverviewCompactColumnWidths(['name'])).toEqual({});
  });
});
