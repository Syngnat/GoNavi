import { describe, expect, it } from 'vitest';
import { gonaviResultRecords } from './queryWorkbench';

describe('query workbench helpers', () => {
  it('maps column-major results into named records', () => {
    const records = gonaviResultRecords({
      columns: [{ name: 'id' }, { name: 'name' }],
      rows: [[1, 'a'], [2, 'b']],
    });
    expect(records).toEqual([{ id: 1, name: 'a' }, { id: 2, name: 'b' }]);
  });

  it('suffixes duplicate column names instead of overwriting', () => {
    const records = gonaviResultRecords({
      columns: [{ name: 'id' }, { name: 'id' }, { name: '' }],
      rows: [[1, 2, 3]],
    });
    expect(records[0]).toEqual({ id: 1, id_2: 2, column: 3 });
  });

  it('returns no records without columns', () => {
    expect(gonaviResultRecords(undefined)).toEqual([]);
    expect(gonaviResultRecords({ columns: [], rows: [[1]] })).toEqual([]);
  });
});
