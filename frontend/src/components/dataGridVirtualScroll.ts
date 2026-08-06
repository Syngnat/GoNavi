export interface FixedVirtualRangeInput {
  itemCount: number;
  itemHeight: number;
  viewportHeight: number;
  scrollTop: number;
}

export interface FixedVirtualRange {
  scrollHeight: number;
  start: number;
  end: number;
  offset: number;
}

const DATA_GRID_FIXED_CELL_SELECTOR = [
  '.ant-table-tbody-virtual-holder-inner .ant-table-cell-fix-left',
  '.ant-table-tbody-virtual-holder-inner .ant-table-cell-fix-left-first',
  '.ant-table-tbody-virtual-holder-inner .ant-table-cell-fix-left-last',
  '.ant-table-tbody-virtual-holder-inner .ant-table-cell-fix-right',
  '.ant-table-tbody-virtual-holder-inner .ant-table-cell-fix-right-first',
  '.ant-table-tbody-virtual-holder-inner .ant-table-cell-fix-right-last',
  '.ant-table-tbody-virtual-holder-inner .ant-table-selection-column',
].join(',');

const normalizeHorizontalOffset = (offset: number): number => (
  Number.isFinite(offset) ? Math.max(0, offset) : 0
);

const queryDataGridFixedCells = (root: ParentNode): NodeListOf<HTMLElement> => (
  root.querySelectorAll<HTMLElement>(DATA_GRID_FIXED_CELL_SELECTOR)
);

/**
 * Keeps fixed cells visually pinned during a continuous horizontal preview.
 * Writing the inherited ancestor variable here would invalidate every cell in
 * the virtual body, so only the currently mounted fixed cells are touched.
 */
export const applyDataGridFixedCellPreviewOffset = (
  root: ParentNode,
  offset: number,
): number => {
  const transform = `translate3d(${normalizeHorizontalOffset(offset)}px, 0, 0)`;
  const cells = queryDataGridFixedCells(root);
  cells.forEach((cell) => {
    if (
      cell.style.getPropertyValue('transform') !== transform
      || cell.style.getPropertyPriority('transform') !== 'important'
    ) {
      cell.style.setProperty('transform', transform, 'important');
    }
  });
  return cells.length;
};

/**
 * Persists the settled offset for rows mounted by later vertical scrolling,
 * then releases the per-cell preview overrides.
 */
export const commitDataGridFixedCellOffset = (
  root: ParentNode,
  inner: HTMLElement,
  offset: number,
): number => {
  const scrollVar = `${normalizeHorizontalOffset(offset)}px`;
  if (inner.style.getPropertyValue('--gn-datagrid-h-scroll') !== scrollVar) {
    inner.style.setProperty('--gn-datagrid-h-scroll', scrollVar);
  }
  const cells = queryDataGridFixedCells(root);
  cells.forEach((cell) => {
    if (cell.style.getPropertyValue('transform')) {
      cell.style.removeProperty('transform');
    }
  });
  return cells.length;
};

/**
 * Mirrors rc-virtual-list's visible range semantics for a fixed-height list,
 * but calculates the range arithmetically instead of scanning every item.
 */
export const calculateFixedVirtualRange = ({
  itemCount,
  itemHeight,
  viewportHeight,
  scrollTop,
}: FixedVirtualRangeInput): FixedVirtualRange => {
  const count = Number.isFinite(itemCount) ? Math.max(0, Math.floor(itemCount)) : 0;
  const height = Number.isFinite(itemHeight) ? Math.max(0, itemHeight) : 0;
  const viewport = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  if (count === 0 || height <= 0) {
    return {
      scrollHeight: count * height,
      start: 0,
      end: count - 1,
      offset: 0,
    };
  }

  const scrollHeight = count * height;
  const maxScrollTop = Math.max(0, scrollHeight - viewport);
  const requestedScrollTop = Number.isFinite(scrollTop)
    ? scrollTop
    : scrollTop === Number.POSITIVE_INFINITY
      ? maxScrollTop
      : 0;
  const clampedScrollTop = Math.max(0, Math.min(maxScrollTop, requestedScrollTop));

  // rc-virtual-list keeps the item ending exactly at scrollTop in its range.
  const start = Math.min(count - 1, Math.max(0, Math.ceil(clampedScrollTop / height) - 1));
  // Keep the same additional cached row rendered by rc-virtual-list.
  const end = Math.min(count - 1, Math.floor((clampedScrollTop + viewport) / height) + 1);

  return {
    scrollHeight,
    start,
    end,
    offset: start * height,
  };
};

export interface DataGridIdleCommitSchedulerOptions<T> {
  delayMs: number;
  onCommit: (value: T) => void;
  canCommit?: () => boolean;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface DataGridIdleCommitScheduler<T> {
  schedule: (value: T) => void;
  flush: () => boolean;
  cancel: () => void;
  hasPending: () => boolean;
}

export interface DataGridVisualFrameGuardOptions<T> {
  onFrame: (value: T) => void;
  shouldContinue?: () => boolean;
  onStop?: () => void;
  trailingFrameCount?: number;
  requestFrame?: (callback: (timestamp: number) => void) => unknown;
  cancelFrame?: (handle: unknown) => void;
}

export interface DataGridVisualFrameGuard<T> {
  update: (value: T) => void;
  start: () => boolean;
  cancel: () => void;
  hasPending: () => boolean;
}

const NO_PENDING_IDLE_COMMIT = Symbol('data-grid-no-pending-idle-commit');

/**
 * Coalesces a continuous stream of visual scroll previews into one commit
 * after the stream has been idle. Only one timer is live at any time.
 */
export const createDataGridIdleCommitScheduler = <T>({
  delayMs,
  onCommit,
  canCommit = () => true,
  now = () => Date.now(),
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}: DataGridIdleCommitSchedulerOptions<T>): DataGridIdleCommitScheduler<T> => {
  const delay = Math.max(0, Number.isFinite(delayMs) ? delayMs : 0);
  let timer: unknown = null;
  let timerToken = 0;
  let pending: T | typeof NO_PENDING_IDLE_COMMIT = NO_PENDING_IDLE_COMMIT;
  let lastScheduleTime = 0;

  const armTimer = (waitMs: number) => {
    const token = ++timerToken;
    timer = setTimer(() => runTimer(token), Math.max(0, waitMs));
  };

  const runTimer = (token: number) => {
    if (token !== timerToken) return;
    timer = null;
    if (pending === NO_PENDING_IDLE_COMMIT) return;

    const remaining = lastScheduleTime + delay - now();
    if (remaining > 0 || !canCommit()) {
      armTimer(remaining > 0 ? remaining : delay);
      return;
    }

    const value = pending;
    pending = NO_PENDING_IDLE_COMMIT;
    onCommit(value);
  };

  return {
    schedule(value) {
      pending = value;
      lastScheduleTime = now();
      if (timer === null) {
        armTimer(delay);
      }
    },
    flush() {
      if (pending === NO_PENDING_IDLE_COMMIT || !canCommit()) {
        return false;
      }
      timerToken += 1;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      const value = pending;
      pending = NO_PENDING_IDLE_COMMIT;
      onCommit(value);
      return true;
    },
    cancel() {
      timerToken += 1;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      pending = NO_PENDING_IDLE_COMMIT;
    },
    hasPending() {
      return pending !== NO_PENDING_IDLE_COMMIT;
    },
  };
};

const NO_VISUAL_FRAME_GUARD_VALUE = Symbol('data-grid-no-visual-frame-guard-value');

/**
 * Keeps reasserting the latest visual scroll offset while an async internal
 * commit can still repaint an older offset into the DOM.
 */
export const createDataGridVisualFrameGuard = <T>({
  onFrame,
  shouldContinue = () => false,
  onStop = () => {},
  trailingFrameCount = 1,
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (handle) => globalThis.cancelAnimationFrame(handle as number),
}: DataGridVisualFrameGuardOptions<T>): DataGridVisualFrameGuard<T> => {
  const trailingFrames = Number.isFinite(trailingFrameCount)
    ? Math.max(0, Math.floor(trailingFrameCount))
    : 0;
  let active = false;
  let frame: unknown = null;
  let frameToken = 0;
  let remainingTrailingFrames = 0;
  let latestValue: T | typeof NO_VISUAL_FRAME_GUARD_VALUE = NO_VISUAL_FRAME_GUARD_VALUE;

  const armFrame = () => {
    const token = ++frameToken;
    frame = requestFrame(() => {
      if (token !== frameToken) return;
      frame = null;
      if (latestValue === NO_VISUAL_FRAME_GUARD_VALUE) {
        active = false;
        return;
      }

      onFrame(latestValue);
      if (shouldContinue()) {
        remainingTrailingFrames = trailingFrames;
        armFrame();
        return;
      }
      if (remainingTrailingFrames > 0) {
        remainingTrailingFrames -= 1;
        armFrame();
        return;
      }
      active = false;
      onStop();
    });
  };

  return {
    update(value) {
      latestValue = value;
    },
    start() {
      if (latestValue === NO_VISUAL_FRAME_GUARD_VALUE) {
        return false;
      }
      active = true;
      remainingTrailingFrames = trailingFrames;
      if (frame === null) {
        armFrame();
      }
      return true;
    },
    cancel() {
      active = false;
      frameToken += 1;
      if (frame !== null) {
        cancelFrame(frame);
        frame = null;
      }
      remainingTrailingFrames = 0;
      latestValue = NO_VISUAL_FRAME_GUARD_VALUE;
    },
    hasPending() {
      return active;
    },
  };
};
