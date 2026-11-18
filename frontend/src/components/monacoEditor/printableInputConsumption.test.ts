import { describe, expect, it } from 'vitest';

import { isPrintableInputConsumedWithoutTextChange } from './printableInputConsumption';

const charAt = (value: string) => (offset: number) => value.charAt(offset);

describe('printableInputConsumption', () => {
  it('treats an unchanged text with a forward caret as consumed by the editor', () => {
    expect(isPrintableInputConsumedWithoutTextChange(
      { valueLengthBefore: 2, offsetBefore: 1, text: ')' },
      2,
      2,
      charAt('()'),
    )).toBe(true);
  });

  it('does not treat an unchanged caret as consumed', () => {
    expect(isPrintableInputConsumedWithoutTextChange(
      { valueLengthBefore: 2, offsetBefore: 2, text: 'c' },
      2,
      2,
      charAt('ab'),
    )).toBe(false);
  });

  it('does not treat a caret moved onto another character as consumed', () => {
    // 光标只是被移动到了别的字符上，输入本身仍然丢失，必须照常兜底。
    expect(isPrintableInputConsumedWithoutTextChange(
      { valueLengthBefore: 2, offsetBefore: 1, text: 'a' },
      2,
      2,
      charAt('xy'),
    )).toBe(false);
  });

  it('does not treat a changed text as consumed', () => {
    expect(isPrintableInputConsumedWithoutTextChange(
      { valueLengthBefore: 0, offsetBefore: 0, text: '(' },
      1,
      1,
      charAt('()'),
    )).toBe(false);
  });

  it('does not treat an unknown offset as consumed', () => {
    expect(isPrintableInputConsumedWithoutTextChange(
      { valueLengthBefore: 2, offsetBefore: 1, text: ')' },
      2,
      undefined,
      charAt('()'),
    )).toBe(false);
    expect(isPrintableInputConsumedWithoutTextChange(
      { valueLengthBefore: 2, offsetBefore: 1, text: ')' },
      2,
      Number.NaN,
      charAt('()'),
    )).toBe(false);
  });

  it('only consumes a single-character input at the caret', () => {
    expect(isPrintableInputConsumedWithoutTextChange(
      { valueLengthBefore: 2, offsetBefore: 0, text: '()' },
      2,
      2,
      charAt('()'),
    )).toBe(false);
  });
});