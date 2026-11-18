import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TABLE_OVERVIEW_COMPACT_COLUMNS,
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
});
