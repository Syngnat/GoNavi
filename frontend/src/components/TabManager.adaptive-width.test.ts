import { describe, expect, it } from 'vitest';

import {
  V2_WORKBENCH_TAB_MAX_WIDTH,
  V2_WORKBENCH_TAB_MIN_WIDTH,
  resolveV2WorkbenchTabWidth,
} from './TabManager';

describe('v2 workbench adaptive tab width', () => {
  it('keeps the preferred width when the strip has enough room', () => {
    expect(resolveV2WorkbenchTabWidth(1600, 5)).toBe(V2_WORKBENCH_TAB_MAX_WIDTH);
    expect(resolveV2WorkbenchTabWidth(800, 2)).toBe(V2_WORKBENCH_TAB_MAX_WIDTH);
  });

  it('shares the available width equally before using overflow', () => {
    expect(resolveV2WorkbenchTabWidth(1000, 5)).toBe(199);
    expect(resolveV2WorkbenchTabWidth(1200, 10)).toBe(119);
  });

  it('stops shrinking at the readable minimum', () => {
    expect(resolveV2WorkbenchTabWidth(1000, 10)).toBe(V2_WORKBENCH_TAB_MIN_WIDTH);
    expect(resolveV2WorkbenchTabWidth(320, 8)).toBe(V2_WORKBENCH_TAB_MIN_WIDTH);
  });

  it('uses the preferred width until a measurable strip and tab count exist', () => {
    expect(resolveV2WorkbenchTabWidth(0, 4)).toBe(V2_WORKBENCH_TAB_MAX_WIDTH);
    expect(resolveV2WorkbenchTabWidth(Number.NaN, 4)).toBe(V2_WORKBENCH_TAB_MAX_WIDTH);
    expect(resolveV2WorkbenchTabWidth(1000, 0)).toBe(V2_WORKBENCH_TAB_MAX_WIDTH);
    expect(resolveV2WorkbenchTabWidth(1000, -2)).toBe(V2_WORKBENCH_TAB_MAX_WIDTH);
    expect(resolveV2WorkbenchTabWidth(1000, Number.NaN)).toBe(V2_WORKBENCH_TAB_MAX_WIDTH);
  });
});
