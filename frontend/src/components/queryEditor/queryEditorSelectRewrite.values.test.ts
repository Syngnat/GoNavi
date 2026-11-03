import { describe, expect, it } from 'vitest';
import { parseSimpleSelectInfo, resolveSelectItemInfo } from './queryEditorSelectRewrite';

describe('bare SQL values are not writable columns', () => {
  it.each(['NULL', 'TRUE', 'FALSE', 'CURRENT_DATE'])('does not map %s to a writable source', value => {
    const info = parseSimpleSelectInfo(`SELECT ${value} AS status FROM customers`, 'mysql');
    expect(info?.writableColumns).toEqual({});
  });

  it('keeps quoted and qualified value-like names as real columns', () => {
    expect(resolveSelectItemInfo('"NULL" AS status')).toMatchObject({ sourceName: 'NULL' });
    expect(resolveSelectItemInfo('c.NULL AS status')).toMatchObject({ sourceName: 'NULL' });
  });
});
