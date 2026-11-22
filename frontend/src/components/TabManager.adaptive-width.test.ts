import { describe, expect, it } from 'vitest';

import {
  V2_WORKBENCH_TAB_MAX_WIDTH,
  resolveV2WorkbenchTabWidth,
} from './TabManager';

describe('v2 workbench adaptive tab width', () => {
  it('keeps the preferred width when the strip has enough room', () => {
    expect(resolveV2WorkbenchTabWidth(1600, 5)).toBe(V2_WORKBENCH_TAB_MAX_WIDTH);
    expect(resolveV2WorkbenchTabWidth(800, 2)).toBe(V2_WORKBENCH_TAB_MAX_WIDTH);
  });

  it('shares the available width equally before using overflow', () => {
    expect(resolveV2WorkbenchTabWidth(1000, 5)).toBeCloseTo(199.8);
    expect(resolveV2WorkbenchTabWidth(1200, 10)).toBeCloseTo(119.9);
  });

  it('uses the fractional remainder instead of leaving a gap after the last tab', () => {
    const availableWidth = 1718;
    const tabCount = 14;
    const tabWidth = resolveV2WorkbenchTabWidth(availableWidth, tabCount);

    expect(tabWidth).toBeCloseTo(122.642857);
    expect(availableWidth - tabWidth * tabCount).toBeCloseTo(1);
  });

  it('fits complete tabs into the overflow viewport', () => {
    expect(resolveV2WorkbenchTabWidth(1000, 10)).toBeCloseTo(966 / 8);
    expect(resolveV2WorkbenchTabWidth(320, 8)).toBeCloseTo(286 / 2);
  });

  it('does not leave a partial tab at either edge when scrolling', () => {
    const availableWidth = 1578;
    const tabCount = 15;
    const overflowViewportWidth = availableWidth - 34;
    const visibleTabCount = 13;
    const tabWidth = resolveV2WorkbenchTabWidth(availableWidth, tabCount);

    expect(tabWidth).toBeCloseTo(overflowViewportWidth / visibleTabCount);
    expect(tabWidth * visibleTabCount).toBeCloseTo(overflowViewportWidth);
    expect(tabWidth * tabCount).toBeGreaterThan(availableWidth);
  });

  it('uses the preferred width until a measurable strip and tab count exist', () => {
    expect(resolveV2WorkbenchTabWidth(0, 4)).toBe(V2_WORKBENCH_TAB_MAX_WIDTH);
    expect(resolveV2WorkbenchTabWidth(Number.NaN, 4)).toBe(V2_WORKBENCH_TAB_MAX_WIDTH);
    expect(resolveV2WorkbenchTabWidth(1000, 0)).toBe(V2_WORKBENCH_TAB_MAX_WIDTH);
    expect(resolveV2WorkbenchTabWidth(1000, -2)).toBe(V2_WORKBENCH_TAB_MAX_WIDTH);
    expect(resolveV2WorkbenchTabWidth(1000, Number.NaN)).toBe(V2_WORKBENCH_TAB_MAX_WIDTH);
  });
});
