import { describe, expect, it } from 'vitest';

import {
  formatHiddenTabCount,
  resolveTabOverflowLayout,
} from './tabOverflowLayout';

const tabs = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `t${i}` }));

describe('resolveTabOverflowLayout', () => {
  it('shows everything when the strip has room', () => {
    const layout = resolveTabOverflowLayout({
      tabs: tabs(5), activeTabId: 't0', availableWidth: 2000, tabWidth: 200,
    });
    expect(layout.visible).toHaveLength(5);
    expect(layout.hidden).toHaveLength(0);
    expect(layout.capacity).toBe(5);
  });

  // 首帧宽度还没测出来时不能把 tab 收起来，否则会闪一下再展开。
  it('renders everything while the width is still unmeasured', () => {
    [0, -1, Number.NaN].forEach((width) => {
      const layout = resolveTabOverflowLayout({
        tabs: tabs(5), activeTabId: 't0', availableWidth: width as number, tabWidth: 200,
      });
      expect(layout.visible).toHaveLength(5);
      expect(layout.hidden).toHaveLength(0);
    });
  });

  it('hides the overflow in original order', () => {
    const layout = resolveTabOverflowLayout({
      tabs: tabs(10), activeTabId: 't0', availableWidth: 620, tabWidth: 200,
      moreButtonWidth: 52,
    });
    expect(layout.capacity).toBe(2);
    expect(layout.visible.map((tab) => tab.id)).toEqual(['t0', 't1']);
    expect(layout.hidden.map((tab) => tab.id)).toEqual(['t2', 't3', 't4', 't5', 't6', 't7', 't8', 't9']);
  });

  // 激活项必须可见：否则用户看不到自己在哪，也没法点关闭。
  it('always keeps the active tab visible', () => {
    const layout = resolveTabOverflowLayout({
      tabs: tabs(10), activeTabId: 't7', availableWidth: 420, tabWidth: 200,
      moreButtonWidth: 52,
    });
    expect(layout.capacity).toBe(1);
    expect(layout.visible.map((tab) => tab.id)).toEqual(['t7']);
  });

  it('grows the visible window around the active tab', () => {
    const layout = resolveTabOverflowLayout({
      tabs: tabs(10), activeTabId: 't5', availableWidth: 620, tabWidth: 200,
      moreButtonWidth: 52,
    });
    expect(layout.capacity).toBe(2);
    // 先右后左：激活项右侧的优先保住。
    expect(layout.visible.map((tab) => tab.id)).toEqual(['t5', 't6']);
  });

  it('falls back to the head of the list without an active tab', () => {
    const layout = resolveTabOverflowLayout({
      tabs: tabs(6), availableWidth: 620, tabWidth: 200, moreButtonWidth: 52,
    });
    expect(layout.visible.map((tab) => tab.id)).toEqual(['t0', 't1']);
  });

  it('shows nothing in the strip when even one tab does not fit', () => {
    const layout = resolveTabOverflowLayout({
      tabs: tabs(3), activeTabId: 't1', availableWidth: 100, tabWidth: 200,
      moreButtonWidth: 52,
    });
    expect(layout.visible).toHaveLength(0);
    expect(layout.hidden).toHaveLength(3);
  });

  it('does not reserve the more button when everything fits', () => {
    // 可用宽度刚好放下 3 个，但扣掉「更多」按钮就不够。此时不该出现按钮，
    // 也不能因此把 tab 收起来。
    const layout = resolveTabOverflowLayout({
      tabs: tabs(3), activeTabId: 't0', availableWidth: 600, tabWidth: 200,
      moreButtonWidth: 52,
    });
    expect(layout.visible).toHaveLength(3);
    expect(layout.hidden).toHaveLength(0);
  });

  it('handles an empty list', () => {
    const layout = resolveTabOverflowLayout({
      tabs: [], availableWidth: 600, tabWidth: 200,
    });
    expect(layout.visible).toHaveLength(0);
    expect(layout.capacity).toBe(0);
  });
});

describe('formatHiddenTabCount', () => {
  it('caps at 99+ so the button width stays stable', () => {
    expect(formatHiddenTabCount(1)).toBe('1');
    expect(formatHiddenTabCount(99)).toBe('99');
    expect(formatHiddenTabCount(100)).toBe('99+');
    expect(formatHiddenTabCount(1234)).toBe('99+');
  });
});
