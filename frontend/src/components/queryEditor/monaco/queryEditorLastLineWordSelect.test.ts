/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

import { placeQueryEditorLastLineCaret, selectQueryEditorLastLineWord } from './queryEditorLastLineWordSelect';

const lineElement = (top: number, height: number) => ({
  getBoundingClientRect: () => ({ top, height, left: 0, right: 0, bottom: top + height, width: 0, x: 0, y: top }),
} as unknown as Element);

const host = (overrides: Partial<Parameters<typeof selectQueryEditorLastLineWord>[0]> = {}) => {
  const selectWord = vi.fn();
  // 真实表现：最后一行盒子（100~120）之外取不到文本节点，Monaco 得到 UNKNOWN。
  const getTargetAtClientPoint = vi.fn((_x: number, y: number) => (y >= 100 && y <= 120
    ? { type: 6, position: { lineNumber: 1, column: 5 } }
    : { type: 0 }));
  return {
    host: {
      getModel: () => ({ getLineCount: () => 1, getWordAtPosition: () => ({ startColumn: 3, endColumn: 8 }) }),
      getTargetAtClientPoint,
      queryLastRenderedLine: () => lineElement(100, 20),
      selectWord,
      ...overrides,
    },
    selectWord,
    getTargetAtClientPoint,
  };
};

describe('selectQueryEditorLastLineWord', () => {
  it('Monaco 没命中内容时把落点夹到最后一行并选词', () => {
    const ctx = host();
    expect(selectQueryEditorLastLineWord(ctx.host, 40, 200)).toBe(true);
    expect(ctx.selectWord).toHaveBeenCalledWith(1, 3, 8);
  });

  it('Monaco 已经命中内容时不介入，交给原生选词', () => {
    const ctx = host();
    expect(selectQueryEditorLastLineWord(ctx.host, 40, 105)).toBe(false);
    expect(ctx.selectWord).not.toHaveBeenCalled();
  });

  it('取不到最后一行盒子或词边界时不介入', () => {
    expect(selectQueryEditorLastLineWord(host({ queryLastRenderedLine: () => null }).host, 40, 200)).toBe(false);
    expect(selectQueryEditorLastLineWord(host({ queryLastRenderedLine: () => lineElement(100, 0) }).host, 40, 200)).toBe(false);
    expect(selectQueryEditorLastLineWord(host({
      getModel: () => ({ getLineCount: () => 1, getWordAtPosition: () => null }),
    }).host, 40, 200)).toBe(false);
    expect(selectQueryEditorLastLineWord(host({ getModel: () => null }).host, 40, 200)).toBe(false);
  });
});

describe('placeQueryEditorLastLineCaret', () => {
  it('Monaco 没命中内容时把落点夹到最后一行定位光标', () => {
    const placeCaret = vi.fn();
    const getTargetAtClientPoint = vi.fn((_x: number, y: number) => (y >= 100 && y <= 120
      ? { type: 6, position: { lineNumber: 1, column: 5 } }
      : { type: 0 }));
    expect(placeQueryEditorLastLineCaret({
      getModel: () => ({ getLineCount: () => 1 }),
      getTargetAtClientPoint,
      queryLastRenderedLine: () => lineElement(100, 20),
      placeCaret,
    }, 40, 200)).toBe(true);
    expect(placeCaret).toHaveBeenCalledWith(1, 5);
  });

  it('Monaco 已命中内容或没有最后一行盒子时不介入', () => {
    const placeCaret = vi.fn();
    const base = {
      getModel: () => ({ getLineCount: () => 1 }),
      getTargetAtClientPoint: () => ({ type: 6, position: { lineNumber: 1, column: 5 } }),
      queryLastRenderedLine: () => lineElement(100, 20),
      placeCaret,
    };
    expect(placeQueryEditorLastLineCaret(base, 40, 105)).toBe(false);
    expect(placeQueryEditorLastLineCaret({
      ...base, getTargetAtClientPoint: () => ({ type: 0 }), queryLastRenderedLine: () => null,
    }, 40, 200)).toBe(false);
    expect(placeCaret).not.toHaveBeenCalled();
  });
});
