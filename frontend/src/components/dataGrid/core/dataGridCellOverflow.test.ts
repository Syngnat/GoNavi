import { describe, expect, it } from 'vitest';

import { describeCellOverflow } from './dataGridCellDisplay';
import { TABLE_CELL_PREVIEW_MAX_CHARS } from './dataGridCellKeys';

describe('describeCellOverflow', () => {
  // 单元格只显示前 240 字符，用户看到 … 时分不清「显示省略」还是「值被截断」。
  // 这个函数只提供总长度，供渲染层放进 title。
  it('reports the total length for a value that the grid truncates', () => {
    const long = 'A'.repeat(60000);
    expect(describeCellOverflow(long)).toEqual({ totalChars: 60000 });
  });

  it('returns null at or below the preview limit', () => {
    expect(describeCellOverflow('A'.repeat(TABLE_CELL_PREVIEW_MAX_CHARS))).toBeNull();
    expect(describeCellOverflow('short')).toBeNull();
  });

  it('returns null for non-string values', () => {
    expect(describeCellOverflow(null)).toBeNull();
    expect(describeCellOverflow(undefined)).toBeNull();
    expect(describeCellOverflow(12345)).toBeNull();
    expect(describeCellOverflow({ a: 1 })).toBeNull();
  });

  // 长度按字符（UTF-16 code unit）算，与截断处的 slice 口径一致，
  // 否则 title 里的数字会和实际显示对不上。
  it('counts the same units the truncation slices', () => {
    const cjk = '中'.repeat(TABLE_CELL_PREVIEW_MAX_CHARS + 1);
    expect(describeCellOverflow(cjk)?.totalChars).toBe(TABLE_CELL_PREVIEW_MAX_CHARS + 1);
  });
});
