import { describe, expect, it } from 'vitest';
import { paginateRows } from './pagedTable';

describe('plugin UI paged table helper', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'];

  it('slices the requested page and clamps an out-of-range page', () => {
    expect(paginateRows(rows, 1, 2)).toEqual(['a', 'b']);
    expect(paginateRows(rows, 3, 2)).toEqual(['e']);
    expect(paginateRows(rows, 99, 2)).toEqual(['e']);
    expect(paginateRows(rows, 0, 2)).toEqual(['a', 'b']);
  });

  it('rejects non-positive page sizes without returning the whole set', () => {
    expect(paginateRows(rows, 2, 0)).toEqual(['b']);
    expect(paginateRows([], 1, 50)).toEqual([]);
  });
});
