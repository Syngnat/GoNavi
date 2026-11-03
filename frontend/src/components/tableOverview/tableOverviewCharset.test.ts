import { describe, expect, it } from 'vitest';

import { collationToCharset, parseTableStats } from './tableOverviewModel';

describe('collationToCharset', () => {
  // 排序规则名是「字符集_后缀」，但后缀本身可能带下划线，
  // 所以不能简单 split('_')[0]。
  it('resolves the charset from a collation name', () => {
    expect(collationToCharset('utf8mb4_0900_ai_ci')).toBe('utf8mb4');
    expect(collationToCharset('utf8mb4_general_ci')).toBe('utf8mb4');
    expect(collationToCharset('utf8_general_ci')).toBe('utf8');
    expect(collationToCharset('latin1_swedish_ci')).toBe('latin1');
    expect(collationToCharset('gbk_chinese_ci')).toBe('gbk');
  });

  // utf8mb4 必须优先于 utf8 命中，否则 utf8mb4_* 会被截成 utf8。
  it('prefers the longest charset prefix', () => {
    expect(collationToCharset('utf8mb4_bin')).toBe('utf8mb4');
    expect(collationToCharset('utf16le_general_ci')).toBe('utf16le');
  });

  it('returns an empty string for unknown or empty input', () => {
    expect(collationToCharset('')).toBe('');
    expect(collationToCharset('   ')).toBe('');
    expect(collationToCharset('mystery_ci')).toBe('');
  });
});

describe('parseTableStats charset fields', () => {
  it('reads the table collation and derives the charset', () => {
    const [row] = parseTableStats('mysql', [{
      table_name: 'orders',
      engine: 'InnoDB',
      table_collation: 'utf8mb4_unicode_ci',
    }]);
    expect(row!.collation).toBe('utf8mb4_unicode_ci');
    expect(row!.charset).toBe('utf8mb4');
  });

  it('leaves both fields empty when the dialect reports no collation', () => {
    const [row] = parseTableStats('postgres', [{ table_name: 'orders' }]);
    expect(row!.charset).toBe('');
    expect(row!.collation).toBe('');
  });
});
