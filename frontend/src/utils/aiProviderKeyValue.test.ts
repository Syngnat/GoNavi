import { describe, expect, it } from 'vitest';

import { recordFromRows, rowsFromRecord } from '../utils/aiProviderKeyValue';

describe('aiProviderKeyValue', () => {
  it('round-trips named rows and drops blank names', () => {
    expect(recordFromRows(rowsFromRecord({ Authorization: 'Bearer x', 'X-Team': 'db' }))).toEqual({
      Authorization: 'Bearer x',
      'X-Team': 'db',
    });
    expect(recordFromRows([{ id: '1', name: '  ', value: 'secret' }, { id: '2', name: 'X-Trace', value: '1' }])).toEqual({
      'X-Trace': '1',
    });
  });
});
