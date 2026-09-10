import { describe, expect, it } from 'vitest';

import {
  DATA_GRID_SELECTION_AUTO_SCROLL_EDGE_THRESHOLD_PX,
  DATA_GRID_SELECTION_AUTO_SCROLL_MAX_STEP,
  DATA_GRID_SELECTION_AUTO_SCROLL_MIN_STEP,
  clampDataGridSelectionAutoScrollDelta,
  getDataGridSelectionAutoScrollStep,
} from './dataGridSelectionAutoScroll';

describe('dataGridSelectionAutoScroll helpers', () => {
  it('returns no scroll step for a negative edge distance', () => {
    expect(getDataGridSelectionAutoScrollStep(-1)).toBe(0);
    expect(getDataGridSelectionAutoScrollStep(0)).toBe(0);
    expect(getDataGridSelectionAutoScrollStep(Number.NaN)).toBe(0);
    expect(getDataGridSelectionAutoScrollStep(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('uses the configured constants and quadratic distance curve', () => {
    expect(DATA_GRID_SELECTION_AUTO_SCROLL_EDGE_THRESHOLD_PX).toBe(64);
    expect(DATA_GRID_SELECTION_AUTO_SCROLL_MIN_STEP).toBe(4);
    expect(DATA_GRID_SELECTION_AUTO_SCROLL_MAX_STEP).toBe(48);
    expect(getDataGridSelectionAutoScrollStep(1)).toBe(4);
    expect(getDataGridSelectionAutoScrollStep(32)).toBe(15);
    expect(getDataGridSelectionAutoScrollStep(64)).toBe(48);
    expect(getDataGridSelectionAutoScrollStep(100)).toBe(48);
    expect(getDataGridSelectionAutoScrollStep(32, 0)).toBe(15);
  });

  it('saturates oversized distances at the maximum step', () => {
    expect(getDataGridSelectionAutoScrollStep(Number.POSITIVE_INFINITY)).toBe(
      DATA_GRID_SELECTION_AUTO_SCROLL_MAX_STEP,
    );
    expect(getDataGridSelectionAutoScrollStep(10_000)).toBe(
      DATA_GRID_SELECTION_AUTO_SCROLL_MAX_STEP,
    );
  });

  it('clamps positive and negative deltas symmetrically at scroll boundaries', () => {
    const step = getDataGridSelectionAutoScrollStep(
      DATA_GRID_SELECTION_AUTO_SCROLL_EDGE_THRESHOLD_PX / 2,
    );

    expect(clampDataGridSelectionAutoScrollDelta(step, 50, 100)).toBe(
      -clampDataGridSelectionAutoScrollDelta(-step, 50, 100),
    );
    expect(clampDataGridSelectionAutoScrollDelta(step, 90, 100)).toBe(10);
    expect(clampDataGridSelectionAutoScrollDelta(-step, 5, 100)).toBe(-5);
    expect(clampDataGridSelectionAutoScrollDelta(step, 100, 100)).toBe(0);
    expect(clampDataGridSelectionAutoScrollDelta(-step, 0, 100)).toBe(0);
    expect(clampDataGridSelectionAutoScrollDelta(Number.NaN, 50, 100)).toBe(0);
    expect(clampDataGridSelectionAutoScrollDelta(step, Number.NaN, 100)).toBe(0);
    expect(clampDataGridSelectionAutoScrollDelta(step, 50, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('returns enough delta to recover an out-of-range current scroll position', () => {
    const delta = clampDataGridSelectionAutoScrollDelta(-4, 110, 100);

    expect(delta).toBe(-10);
    expect(110 + delta).toBe(100);
  });
});
