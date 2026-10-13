import { describe, expect, it } from 'vitest';

import { normalizeTableInfoDetails } from './backendTableInfo';

describe('normalizeTableInfoDetails', () => {
  it('keeps non-empty strings and finite numbers, drops the rest', () => {
    const details = normalizeTableInfoDetails({
      engine: 'InnoDB',
      comment: '  订单表  ',
      collation: '',
      rowFormat: undefined,
      rows: 12345,
      dataLength: '4096',
      indexLength: 'not-a-number',
      autoIncrement: '1001',
      createTime: null,
      updateTime: '2024-05-01 10:00:00',
    });
    expect(details).toEqual({
      engine: 'InnoDB',
      comment: '订单表',
      rows: 12345,
      dataLength: 4096,
      autoIncrement: '1001',
      updateTime: '2024-05-01 10:00:00',
    });
  });

  it('returns an all-optional empty object for an empty payload', () => {
    expect(normalizeTableInfoDetails({})).toEqual({});
  });
});
