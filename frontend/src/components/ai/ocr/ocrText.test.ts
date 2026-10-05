import { describe, expect, it } from 'vitest';

import { MAX_RECOGNIZED_CHARS, hasMeaningfulText, normalizeRecognizedText } from './ocrText';

describe('normalizeRecognizedText', () => {
  it('removes the spaces the recognizer puts between Chinese characters, and only those', () => {
    expect(normalizeRecognizedText('查 询 订 单 表，统 计 总 额')).toBe('查询订单表，统计总额');
    // Spaces between Latin words, and between Latin and Chinese, stay: they may be real.
    expect(normalizeRecognizedText('SELECT 客户名称 FROM orders')).toBe('SELECT 客户名称 FROM orders');
    expect(normalizeRecognizedText('错误 1146: 表 不存在')).toBe('错误 1146: 表不存在');
  });

  it('tidies line endings, trailing blanks and runs of empty lines', () => {
    expect(normalizeRecognizedText('a  \r\nb\t\r\n\r\n\r\n\r\nc\n')).toBe('a\nb\n\nc');
    expect(normalizeRecognizedText('  \n \n')).toBe('');
    expect(normalizeRecognizedText(undefined as unknown as string)).toBe('');
  });

  it('keeps the indentation of code', () => {
    expect(normalizeRecognizedText('SELECT *\n    FROM t')).toBe('SELECT *\n    FROM t');
  });

  it('cuts what is too long, and says so', () => {
    const long = normalizeRecognizedText('x'.repeat(MAX_RECOGNIZED_CHARS + 500));
    expect(long.length).toBeLessThanOrEqual(MAX_RECOGNIZED_CHARS + 2);
    expect(long.endsWith('…')).toBe(true);
    expect(normalizeRecognizedText('short')).toBe('short');
  });
});

describe('hasMeaningfulText', () => {
  it('needs a letter or a digit in any script', () => {
    expect(hasMeaningfulText('SELECT 1')).toBe(true);
    expect(hasMeaningfulText('订单')).toBe(true);
    expect(hasMeaningfulText('Привет')).toBe(true);
    expect(hasMeaningfulText('')).toBe(false);
    expect(hasMeaningfulText(' .,;-_|~ \n')).toBe(false);
  });
});
