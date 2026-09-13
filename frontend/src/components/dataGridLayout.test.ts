import { describe, expect, it } from 'vitest';

import {
  absorbExtraWidthIntoFlexibleColumns,
  calculateExternalHorizontalScrollInnerWidth,
  calculateTableBodyBottomPadding,
  calculateVirtualTableScrollX,
  resolveExternalHorizontalScrollMetrics,
  resolveDataGridColumnQuickFindScrollLeft,
  resolveDataGridHorizontalWheelDelta,
  resolveNativeHorizontalWheelScrollLeft,
  shouldCommitVirtualHorizontalRange,
  shouldLetNativeHorizontalWheelPass,
} from './dataGridLayout';

describe('dataGridLayout helpers', () => {
  it('returns zero bottom padding without horizontal overflow', () => {
    expect(calculateTableBodyBottomPadding({
      hasHorizontalOverflow: false,
      floatingScrollbarHeight: 10,
      floatingScrollbarGap: 6,
    })).toBe(0);
  });

  it('adds safe area when horizontal overflow exists', () => {
    expect(calculateTableBodyBottomPadding({
      hasHorizontalOverflow: true,
      floatingScrollbarHeight: 10,
      floatingScrollbarGap: 6,
    })).toBe(28);
    expect(calculateTableBodyBottomPadding({
      hasHorizontalOverflow: true,
      floatingScrollbarHeight: 14,
      floatingScrollbarGap: 4,
    })).toBe(30);
  });

  it('keeps scroll width aligned with viewport or content width', () => {
    expect(calculateVirtualTableScrollX({ totalWidth: 646, tableViewportWidth: 1200, isMacLike: false })).toBe(1200);
    expect(calculateVirtualTableScrollX({ totalWidth: 646, tableViewportWidth: 0, isMacLike: false })).toBe(646);
    expect(calculateVirtualTableScrollX({ totalWidth: 1200, tableViewportWidth: 800, isMacLike: true })).toBe(1202);
  });

  it('absorbs leftover viewport width into the last flexible data column only', () => {
    const columns = [
      { key: '__gonavi_row_number__', width: 36 },
      { key: 'id', width: 180 },
      { key: 'name', width: 160 },
    ];
    const next = absorbExtraWidthIntoFlexibleColumns({
      columns,
      selectionColumnWidth: 46,
      tableViewportWidth: 1200,
      fixedColumnKeys: ['__gonavi_row_number__'],
      defaultColumnWidth: 180,
    });
    // 1200 - (36 + 180 + 160 + 46) = 778 → 加到最后一列 name
    expect(next[0].width).toBe(36);
    expect(next[1].width).toBe(180);
    expect(next[2].width).toBe(160 + 778);
  });

  it('does not change columns when content already fills the viewport', () => {
    const columns = [
      { key: '__gonavi_row_number__', width: 36 },
      { key: 'id', width: 900 },
    ];
    const next = absorbExtraWidthIntoFlexibleColumns({
      columns,
      selectionColumnWidth: 46,
      tableViewportWidth: 800,
      fixedColumnKeys: ['__gonavi_row_number__'],
      defaultColumnWidth: 180,
    });
    expect(next).toEqual(columns);
  });

  it('keeps external horizontal scrollbar range aligned with table content range', () => {
    expect(calculateExternalHorizontalScrollInnerWidth({
      tableScrollWidth: 4563,
      trackInset: 10,
    })).toBe(4543);

    expect(calculateExternalHorizontalScrollInnerWidth({
      tableScrollWidth: 18,
      trackInset: 10,
    })).toBe(1);
  });

  it('uses measured DOM overflow when stretched columns exceed the theoretical table width', () => {
    expect(resolveExternalHorizontalScrollMetrics({
      tableScrollWidth: 1537,
      tableViewportWidth: 1537,
      measuredScrollWidth: 1539,
      measuredClientWidth: 1526,
      measuredTrackClientWidth: 1517,
      trackInset: 10,
    })).toEqual({
      visible: true,
      innerWidth: 1530,
      maxScrollLeft: 13,
    });
  });

  it('resolves quick-find target scrollLeft by centering the target column when possible', () => {
    expect(resolveDataGridColumnQuickFindScrollLeft({
      currentScrollLeft: 0,
      columnLeft: 900,
      columnWidth: 120,
      viewportWidth: 600,
      scrollWidth: 2000,
    })).toBe(660);

    expect(resolveDataGridColumnQuickFindScrollLeft({
      currentScrollLeft: 0,
      columnLeft: 40,
      columnWidth: 120,
      viewportWidth: 600,
      scrollWidth: 2000,
    })).toBe(0);

    expect(resolveDataGridColumnQuickFindScrollLeft({
      currentScrollLeft: 200,
      columnLeft: 1750,
      columnWidth: 140,
      viewportWidth: 600,
      scrollWidth: 2000,
    })).toBe(1400);
  });

  it('falls back safely when quick-find scroll metrics are degenerate', () => {
    expect(resolveDataGridColumnQuickFindScrollLeft({
      currentScrollLeft: 120,
      columnLeft: 900,
      columnWidth: 720,
      viewportWidth: 600,
      scrollWidth: 2000,
    })).toBe(900);

    expect(resolveDataGridColumnQuickFindScrollLeft({
      currentScrollLeft: 120,
      columnLeft: Number.NaN,
      columnWidth: Number.NaN,
      viewportWidth: 0,
      scrollWidth: 2000,
    })).toBe(0);
  });

  it('only treats wheel gestures as horizontal when the horizontal intent is strong enough', () => {
    expect(resolveDataGridHorizontalWheelDelta({
      deltaX: 18,
      deltaY: 3,
      shiftKey: false,
    })).toBe(18);

    expect(resolveDataGridHorizontalWheelDelta({
      deltaX: 2,
      deltaY: 24,
      shiftKey: false,
    })).toBe(0);

    expect(resolveDataGridHorizontalWheelDelta({
      deltaX: 0.2,
      deltaY: 16,
      shiftKey: false,
    })).toBe(0);

    expect(resolveDataGridHorizontalWheelDelta({
      deltaX: 0,
      deltaY: 20,
      shiftKey: true,
    })).toBe(20);
  });

  it('lets native compositor horizontal wheel pass on Mac-like virtual tables', () => {
    expect(shouldLetNativeHorizontalWheelPass({
      deltaX: 18,
      deltaY: 3,
      shiftKey: false,
      nativeHorizontalEnabled: true,
    })).toBe(true);

    expect(shouldLetNativeHorizontalWheelPass({
      deltaX: 18,
      deltaY: 3,
      shiftKey: true,
      nativeHorizontalEnabled: true,
    })).toBe(false);

    expect(shouldLetNativeHorizontalWheelPass({
      deltaX: 18,
      deltaY: 3,
      shiftKey: false,
      nativeHorizontalEnabled: false,
    })).toBe(false);
  });

  it('applies native horizontal wheel deltas onto the holder scrollLeft', () => {
    expect(resolveNativeHorizontalWheelScrollLeft({
      delta: 48,
      currentScrollLeft: 120,
      maxScrollLeft: 800,
    })).toBe(168);

    expect(resolveNativeHorizontalWheelScrollLeft({
      delta: 48,
      currentScrollLeft: 780,
      maxScrollLeft: 800,
    })).toBe(800);
  });

  it('commits the virtual column window before the retained overscan is exhausted', () => {
    expect(shouldCommitVirtualHorizontalRange({
      nextOffset: 480,
      lastCommittedOffset: 0,
      thresholdPx: 480,
    })).toBe(true);

    expect(shouldCommitVirtualHorizontalRange({
      nextOffset: 400,
      lastCommittedOffset: 0,
      thresholdPx: 480,
    })).toBe(false);
  });
});
