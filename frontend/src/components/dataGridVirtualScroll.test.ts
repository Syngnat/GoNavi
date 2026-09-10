import { describe, expect, it, vi } from 'vitest';

import {
  applyDataGridFixedCellPreviewOffset,
  applyDataGridVirtualInnerOffset,
  calculateFixedVirtualRange,
  commitDataGridFixedCellOffset,
  createDataGridIdleCommitScheduler,
  createDataGridVisualFrameGuard,
  readDataGridVirtualInnerOffset,
  shouldVirtualizeDataGridColumns,
  type DataGridVisualFrameGuard,
} from './dataGridVirtualScroll';

const createStyleStub = () => {
  const values = new Map<string, { value: string; priority: string }>();
  return {
    getPropertyPriority: (name: string) => values.get(name)?.priority ?? '',
    getPropertyValue: (name: string) => values.get(name)?.value ?? '',
    removeProperty: vi.fn((name: string) => {
      const previous = values.get(name)?.value ?? '';
      values.delete(name);
      return previous;
    }),
    setProperty: vi.fn((name: string, value: string, priority = '') => {
      values.set(name, { value, priority });
    }),
  };
};

describe('fixed cell horizontal preview', () => {
  it('updates one inherited variable instead of every visible fixed cell', () => {
    const inner = { style: createStyleStub() };

    expect(applyDataGridFixedCellPreviewOffset(inner as unknown as HTMLElement, 640)).toBe(1);
    expect(inner.style.setProperty).toHaveBeenCalledWith('--gn-datagrid-h-scroll', '640px');

    expect(applyDataGridFixedCellPreviewOffset(inner as unknown as HTMLElement, 640)).toBe(0);
    expect(inner.style.setProperty).toHaveBeenCalledTimes(1);
  });

  it('persists the settled offset once and releases per-cell preview styles', () => {
    const first = { style: createStyleStub() };
    const second = { style: createStyleStub() };
    const root = { querySelectorAll: vi.fn(() => [first, second]) };
    const inner = { style: createStyleStub() };
    first.style.setProperty('transform', 'translate3d(480px, 0, 0)', 'important');
    second.style.setProperty('transform', 'translate3d(480px, 0, 0)', 'important');

    expect(commitDataGridFixedCellOffset(
      root as unknown as ParentNode,
      inner as unknown as HTMLElement,
      480,
    )).toBe(2);
    expect(inner.style.setProperty).toHaveBeenCalledWith('--gn-datagrid-h-scroll', '480px');
    expect(first.style.removeProperty).toHaveBeenCalledWith('transform');
    expect(second.style.removeProperty).toHaveBeenCalledWith('transform');
  });
});

describe('virtual body horizontal offset', () => {
  it('uses compositor translate and keeps a marginLeft fallback for stale DOM', () => {
    const style = {
      translate: '',
      marginLeft: '-240px',
    };
    const inner = { style } as unknown as HTMLElement;

    expect(readDataGridVirtualInnerOffset(inner)).toBe(240);
    expect(applyDataGridVirtualInnerOffset(inner, 640)).toBe(true);
    expect(style.translate).toBe('-640px 0');
    expect(readDataGridVirtualInnerOffset(inner)).toBe(640);
    expect(applyDataGridVirtualInnerOffset(inner, 640)).toBe(false);
  });
});

describe('column virtualization threshold', () => {
  it('renders narrow tables directly and virtualizes wider tables', () => {
    expect(shouldVirtualizeDataGridColumns(16)).toBe(false);
    expect(shouldVirtualizeDataGridColumns(17)).toBe(true);
    expect(shouldVirtualizeDataGridColumns(64)).toBe(true);
  });
});

describe('calculateFixedVirtualRange', () => {
  const calculateLinearReference = ({
    itemCount,
    itemHeight,
    viewportHeight,
    scrollTop,
  }: {
    itemCount: number;
    itemHeight: number;
    viewportHeight: number;
    scrollTop: number;
  }) => {
    let itemTop = 0;
    let start: number | undefined;
    let end: number | undefined;
    let offset: number | undefined;
    for (let index = 0; index < itemCount; index += 1) {
      const bottom = itemTop + itemHeight;
      if (bottom >= scrollTop && start === undefined) {
        start = index;
        offset = itemTop;
      }
      if (bottom > scrollTop + viewportHeight && end === undefined) {
        end = index;
      }
      itemTop = bottom;
    }
    if (start === undefined) {
      start = 0;
      offset = 0;
      end = Math.ceil(viewportHeight / itemHeight);
    }
    if (end === undefined) end = itemCount - 1;
    end = Math.min(end + 1, itemCount - 1);
    return { scrollHeight: itemTop, start, end, offset };
  };

  it('calculates the visible window without inspecting row data', () => {
    expect(calculateFixedVirtualRange({
      itemCount: 1_000_000,
      itemHeight: 28,
      viewportHeight: 280,
      scrollTop: 14_000_001,
    })).toEqual({
      scrollHeight: 28_000_000,
      start: 499_991,
      end: 500_020,
      offset: 13_999_748,
    });
  });

  it('keeps the preceding row at an exact item boundary like rc-virtual-list', () => {
    expect(calculateFixedVirtualRange({
      itemCount: 100,
      itemHeight: 28,
      viewportHeight: 280,
      scrollTop: 28,
    })).toEqual({
      scrollHeight: 2_800,
      start: 0,
      end: 21,
      offset: 0,
    });
  });

  it('clamps empty and end-of-list ranges safely', () => {
    expect(calculateFixedVirtualRange({
      itemCount: 0,
      itemHeight: 28,
      viewportHeight: 280,
      scrollTop: 0,
    })).toEqual({ scrollHeight: 0, start: 0, end: -1, offset: 0 });

    expect(calculateFixedVirtualRange({
      itemCount: 100,
      itemHeight: 28,
      viewportHeight: 280,
      scrollTop: Number.POSITIVE_INFINITY,
    })).toEqual({
      scrollHeight: 2_800,
      start: 80,
      end: 99,
      offset: 2_240,
    });
  });

  it('extends the dependency visible range by one viewport for native scroll coverage', () => {
    const itemCount = 40;
    const itemHeight = 7;
    const viewportHeight = 70;
    const maxScrollTop = itemCount * itemHeight - viewportHeight;
    for (let scrollTop = 0; scrollTop <= maxScrollTop; scrollTop += 1) {
      const linear = calculateLinearReference({
        itemCount,
        itemHeight,
        viewportHeight,
        scrollTop,
      });
      const overscanRows = Math.max(6, Math.ceil(viewportHeight / itemHeight));
      expect(calculateFixedVirtualRange({
        itemCount,
        itemHeight,
        viewportHeight,
        scrollTop,
      })).toEqual({
        ...linear,
        start: Math.max(0, linear.start - (overscanRows - 1)),
        end: Math.min(itemCount - 1, linear.end + (overscanRows - 1)),
        offset: Math.max(0, linear.start - (overscanRows - 1)) * itemHeight,
      });
    }
  });

  it('keeps the recorded fifteen-row native jump covered before React commits', () => {
    const itemHeight = 28;
    const viewportHeight = 840;
    const initialRange = calculateFixedVirtualRange({
      itemCount: 1_000,
      itemHeight,
      viewportHeight,
      scrollTop: 0,
    });
    const jumpedViewportBottom = (15 * itemHeight) + viewportHeight;

    expect((initialRange.end + 1) * itemHeight).toBeGreaterThanOrEqual(jumpedViewportBottom);
  });

  it('keeps the recorded reverse jump covered while React still has the old range', () => {
    const itemHeight = 28;
    const viewportHeight = 840;
    const previousVisibleRow = 112;
    const previousRange = calculateFixedVirtualRange({
      itemCount: 1_000,
      itemHeight,
      viewportHeight,
      scrollTop: previousVisibleRow * itemHeight,
    });
    const jumpedVisibleRow = previousVisibleRow - 24;

    expect(previousRange.start).toBeLessThanOrEqual(jumpedVisibleRow);
  });
});

describe('createDataGridIdleCommitScheduler', () => {
  it('coalesces continuous previews into one idle commit', () => {
    let now = 0;
    let nextTimerId = 1;
    const timers = new Map<number, { callback: () => void; delay: number }>();
    const commits = vi.fn();
    const scheduler = createDataGridIdleCommitScheduler<number>({
      delayMs: 80,
      now: () => now,
      onCommit: commits,
      setTimer: (callback, delay) => {
        const id = nextTimerId++;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimer: (id) => (typeof id === 'number' ? timers.delete(id) : false),
    });

    for (let offset = 0; offset < 120; offset += 1) {
      now = offset;
      scheduler.schedule(offset * 10);
    }

    expect(commits).not.toHaveBeenCalled();
    expect(timers.size).toBe(1);

    const first = [...timers.entries()][0];
    timers.delete(first[0]);
    now = 120;
    first[1].callback();
    expect(commits).not.toHaveBeenCalled();
    expect(timers.size).toBe(1);

    const second = [...timers.entries()][0];
    timers.delete(second[0]);
    now = 199;
    second[1].callback();

    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits).toHaveBeenCalledWith(1_190);
    expect(timers.size).toBe(0);
  });

  it('does not let a cancelled callback interfere with newly scheduled work', () => {
    const commits = vi.fn();
    const clearTimer = vi.fn();
    const callbacks: Array<() => void> = [];
    const scheduler = createDataGridIdleCommitScheduler<number>({
      delayMs: 0,
      onCommit: commits,
      setTimer: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearTimer,
    });

    scheduler.schedule(320);
    scheduler.cancel();
    scheduler.schedule(640);
    callbacks[0]();

    expect(clearTimer).toHaveBeenCalledWith(1);
    expect(commits).not.toHaveBeenCalled();
    expect(scheduler.hasPending()).toBe(true);

    callbacks[1]();

    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits).toHaveBeenCalledWith(640);
    expect(scheduler.hasPending()).toBe(false);
  });

  it('flushes pending work exactly once and invalidates the queued timer', () => {
    const commits = vi.fn();
    const callbacks: Array<() => void> = [];
    const scheduler = createDataGridIdleCommitScheduler<number>({
      delayMs: 80,
      onCommit: commits,
      setTimer: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      clearTimer: vi.fn(),
    });

    scheduler.schedule(960);

    expect(scheduler.flush()).toBe(true);
    expect(scheduler.flush()).toBe(false);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits).toHaveBeenCalledWith(960);

    callbacks[0]();
    expect(commits).toHaveBeenCalledTimes(1);
  });
});

describe('createDataGridVisualFrameGuard', () => {
  it('reasserts the latest preview instead of an older committed offset', () => {
    const frames: Array<() => void> = [];
    const appliedOffsets: number[] = [];
    const pendingDuringFrame: boolean[] = [];
    let interactionActive = true;
    const stopped = vi.fn();
    let guard: DataGridVisualFrameGuard<number>;
    guard = createDataGridVisualFrameGuard<number>({
      onFrame: (offset) => {
        pendingDuringFrame.push(guard.hasPending());
        appliedOffsets.push(offset);
      },
      shouldContinue: () => interactionActive,
      onStop: stopped,
      requestFrame: (callback) => {
        frames.push(() => callback(0));
        return frames.length;
      },
      cancelFrame: vi.fn(),
    });

    guard.update(320);
    expect(guard.start()).toBe(true);
    guard.update(960);
    frames.shift()?.();

    expect(appliedOffsets).toEqual([960]);
    expect(guard.hasPending()).toBe(true);

    guard.update(1_280);
    frames.shift()?.();
    expect(appliedOffsets).toEqual([960, 1_280]);

    interactionActive = false;
    frames.shift()?.();
    frames.shift()?.();

    expect(appliedOffsets).toEqual([960, 1_280, 1_280, 1_280]);
    expect(pendingDuringFrame).toEqual([true, true, true, true]);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(guard.hasPending()).toBe(false);
  });

  it('invalidates a cancelled frame before a new guard run starts', () => {
    const callbacks: Array<() => void> = [];
    const appliedOffsets: number[] = [];
    const cancelFrame = vi.fn();
    const guard = createDataGridVisualFrameGuard<number>({
      onFrame: (offset) => appliedOffsets.push(offset),
      trailingFrameCount: 0,
      requestFrame: (callback) => {
        callbacks.push(() => callback(0));
        return callbacks.length;
      },
      cancelFrame,
    });

    guard.update(240);
    guard.start();
    guard.cancel();
    guard.update(720);
    guard.start();
    callbacks[0]();
    callbacks[1]();

    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(appliedOffsets).toEqual([720]);
    expect(guard.hasPending()).toBe(false);
  });
});
