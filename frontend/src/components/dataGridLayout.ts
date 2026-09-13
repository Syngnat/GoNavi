export interface TableBodyBottomPaddingOptions {
  hasHorizontalOverflow: boolean;
  floatingScrollbarHeight: number;
  floatingScrollbarGap: number;
}

export interface VirtualTableScrollXOptions {
  totalWidth: number;
  tableViewportWidth: number;
  isMacLike: boolean;
}

export interface DataGridHorizontalWheelIntentOptions {
  deltaX: number;
  deltaY: number;
  shiftKey: boolean;
}

export interface DataGridNativeHorizontalWheelOptions extends DataGridHorizontalWheelIntentOptions {
  nativeHorizontalEnabled: boolean;
}

export interface DataGridNativeHorizontalWheelDispatchOptions {
  delta: number;
  currentScrollLeft: number;
  maxScrollLeft: number;
}

export interface DataGridHorizontalRangeCommitOptions {
  nextOffset: number;
  lastCommittedOffset: number;
  thresholdPx: number;
}

export interface ExternalHorizontalScrollInnerWidthOptions {
  tableScrollWidth: number;
  trackInset: number;
}

export interface ExternalHorizontalScrollMetricsOptions extends ExternalHorizontalScrollInnerWidthOptions {
  tableViewportWidth: number;
  measuredScrollWidth: number;
  measuredClientWidth: number;
  measuredTrackClientWidth?: number;
}

export interface ExternalHorizontalScrollMetrics {
  visible: boolean;
  innerWidth: number;
  maxScrollLeft: number;
}

export interface DataGridColumnQuickFindScrollLeftOptions {
  currentScrollLeft: number;
  columnLeft: number;
  columnWidth: number;
  viewportWidth: number;
  scrollWidth: number;
}

const MIN_SCROLLBAR_CLEARANCE = 8;
const FLOATING_SCROLLBAR_VISUAL_EXTRA = 4;
const HORIZONTAL_WHEEL_MIN_DELTA = 0.5;
const HORIZONTAL_WHEEL_DOMINANCE_RATIO = 1.35;

export const calculateTableBodyBottomPadding = ({
  hasHorizontalOverflow,
  floatingScrollbarHeight,
  floatingScrollbarGap,
}: TableBodyBottomPaddingOptions): number => {
  if (!hasHorizontalOverflow) {
    return 0;
  }

  const safeScrollbarHeight = Math.max(0, Math.ceil(floatingScrollbarHeight));
  const safeScrollbarGap = Math.max(0, Math.ceil(floatingScrollbarGap));

  return safeScrollbarHeight + FLOATING_SCROLLBAR_VISUAL_EXTRA + safeScrollbarGap + MIN_SCROLLBAR_CLEARANCE;
};

export const calculateVirtualTableScrollX = ({
  totalWidth,
  tableViewportWidth,
  isMacLike,
}: VirtualTableScrollXOptions): number => {
  const safeTotalWidth = Math.max(0, Math.ceil(totalWidth));
  const safeViewportWidth = Math.max(0, Math.floor(tableViewportWidth));

  if (safeViewportWidth > 0 && safeTotalWidth < safeViewportWidth) {
    return safeViewportWidth;
  }

  if (isMacLike && safeViewportWidth > 0 && safeTotalWidth > safeViewportWidth) {
    return safeTotalWidth + 2;
  }

  return safeTotalWidth;
};

/** 兼容 antd ColumnType.key（React.Key = string | number | bigint） */
export type AbsorbExtraColumnKey = string | number | bigint;

export type AbsorbExtraColumnWidthOptions<T extends { key?: AbsorbExtraColumnKey; width?: number | string }> = {
  columns: T[];
  selectionColumnWidth: number;
  tableViewportWidth: number;
  /** 这些列保持声明宽度，不参与吸收多余空间（如行号列） */
  fixedColumnKeys?: Iterable<string>;
  defaultColumnWidth: number;
};

/**
 * 少字段时 rc-table 会把 scroll.x 扩到视口并均摊拉宽所有列。
 * 将「视口 − 声明总宽」的差额加到最后一个非固定数据列，避免行号/勾选列被一起撑宽。
 */
export const absorbExtraWidthIntoFlexibleColumns = <T extends { key?: AbsorbExtraColumnKey; width?: number | string }>({
  columns,
  selectionColumnWidth,
  tableViewportWidth,
  fixedColumnKeys,
  defaultColumnWidth,
}: AbsorbExtraColumnWidthOptions<T>): T[] => {
  if (!Array.isArray(columns) || columns.length === 0) {
    return columns;
  }

  const safeViewport = Math.max(0, Math.floor(Number(tableViewportWidth) || 0));
  const safeSelection = Math.max(0, Math.ceil(Number(selectionColumnWidth) || 0));
  const safeDefault = Math.max(1, Math.ceil(Number(defaultColumnWidth) || 1));
  const fixedKeys = new Set(
    Array.from(fixedColumnKeys || [], (key) => String(key || '').trim()).filter(Boolean),
  );

  const resolveWidth = (column: T): number => {
    const raw = Number(column.width);
    return Number.isFinite(raw) && raw > 0 ? Math.ceil(raw) : safeDefault;
  };

  const declaredTotal = columns.reduce((sum, column) => sum + resolveWidth(column), 0) + safeSelection;
  if (safeViewport <= 0 || declaredTotal >= safeViewport) {
    return columns;
  }

  let flexibleIndex = -1;
  for (let index = columns.length - 1; index >= 0; index -= 1) {
    const key = String(columns[index]?.key ?? '').trim();
    if (!fixedKeys.has(key)) {
      flexibleIndex = index;
      break;
    }
  }
  if (flexibleIndex < 0) {
    return columns;
  }

  const extra = safeViewport - declaredTotal;
  return columns.map((column, index) => {
    if (index !== flexibleIndex) {
      return column;
    }
    return {
      ...column,
      width: resolveWidth(column) + extra,
    };
  });
};

export const calculateExternalHorizontalScrollInnerWidth = ({
  tableScrollWidth,
  trackInset,
}: ExternalHorizontalScrollInnerWidthOptions): number => {
  const safeTableScrollWidth = Math.max(0, Math.ceil(tableScrollWidth));
  const safeTrackInset = Math.max(0, Math.ceil(trackInset));

  return Math.max(1, safeTableScrollWidth - safeTrackInset * 2);
};

export const resolveExternalHorizontalScrollMetrics = ({
  tableScrollWidth,
  tableViewportWidth,
  measuredScrollWidth,
  measuredClientWidth,
  measuredTrackClientWidth,
  trackInset,
}: ExternalHorizontalScrollMetricsOptions): ExternalHorizontalScrollMetrics => {
  const safeTableScrollWidth = Math.max(0, Math.ceil(tableScrollWidth));
  const safeViewportWidth = Math.max(0, Math.floor(tableViewportWidth));
  const safeMeasuredScrollWidth = Math.max(0, Math.ceil(measuredScrollWidth));
  const safeMeasuredClientWidth = Math.max(0, Math.floor(measuredClientWidth));
  const safeMeasuredTrackClientWidth = Math.max(0, Math.floor(measuredTrackClientWidth || 0));
  const safeTrackInset = Math.max(0, Math.ceil(trackInset));
  const calculatedMaxScrollLeft = safeViewportWidth > 0
    ? Math.max(0, safeTableScrollWidth - safeViewportWidth)
    : 0;
  const measuredMaxScrollLeft = Math.max(0, safeMeasuredScrollWidth - safeMeasuredClientWidth);
  const maxScrollLeft = Math.max(calculatedMaxScrollLeft, measuredMaxScrollLeft);
  const innerWidth = safeViewportWidth > 0
    ? Math.max(1, safeMeasuredTrackClientWidth || (safeViewportWidth - safeTrackInset * 2)) + maxScrollLeft
    : calculateExternalHorizontalScrollInnerWidth({ tableScrollWidth, trackInset });

  return {
    visible: maxScrollLeft > 1,
    innerWidth,
    maxScrollLeft,
  };
};

export const resolveDataGridColumnQuickFindScrollLeft = ({
  currentScrollLeft,
  columnLeft,
  columnWidth,
  viewportWidth,
  scrollWidth,
}: DataGridColumnQuickFindScrollLeftOptions): number => {
  const safeViewportWidth = Math.max(0, Math.floor(viewportWidth));
  const safeScrollWidth = Math.max(0, Math.ceil(scrollWidth));
  const maxScrollLeft = Math.max(0, safeScrollWidth - safeViewportWidth);

  if (safeViewportWidth <= 0 || maxScrollLeft <= 0) {
    return 0;
  }

  const safeCurrentScrollLeft = Number.isFinite(currentScrollLeft)
    ? Math.max(0, Math.min(maxScrollLeft, currentScrollLeft))
    : 0;
  const safeColumnLeft = Number.isFinite(columnLeft) ? columnLeft : safeCurrentScrollLeft;
  const safeColumnWidth = Math.max(0, Number.isFinite(columnWidth) ? columnWidth : 0);

  if (safeColumnWidth >= safeViewportWidth) {
    return Math.max(0, Math.min(maxScrollLeft, safeColumnLeft));
  }

  const centeredScrollLeft = safeColumnLeft - (safeViewportWidth - safeColumnWidth) / 2;
  return Math.max(0, Math.min(maxScrollLeft, centeredScrollLeft));
};

export const resolveDataGridHorizontalWheelDelta = ({
  deltaX,
  deltaY,
  shiftKey,
}: DataGridHorizontalWheelIntentOptions): number => {
  const safeDeltaX = Number.isFinite(deltaX) ? deltaX : 0;
  const safeDeltaY = Number.isFinite(deltaY) ? deltaY : 0;
  const absX = Math.abs(safeDeltaX);
  const absY = Math.abs(safeDeltaY);

  if (shiftKey && absY >= HORIZONTAL_WHEEL_MIN_DELTA) {
    return safeDeltaY;
  }

  if (absX < HORIZONTAL_WHEEL_MIN_DELTA) {
    return 0;
  }

  // 触摸板纵向滚动常会夹带微小 deltaX。
  // 只有横向位移明显占优时才拦截为横向滚动，避免误伤垂直滚动流畅度。
  if (absY > 0 && absX < absY * HORIZONTAL_WHEEL_DOMINANCE_RATIO) {
    return 0;
  }

  return safeDeltaX;
};

export const shouldLetNativeHorizontalWheelPass = ({
  deltaX,
  deltaY,
  shiftKey,
  nativeHorizontalEnabled,
}: DataGridNativeHorizontalWheelOptions): boolean => {
  if (!nativeHorizontalEnabled || shiftKey) {
    return false;
  }
  return resolveDataGridHorizontalWheelDelta({ deltaX, deltaY, shiftKey: false }) !== 0;
};

export const resolveNativeHorizontalWheelScrollLeft = ({
  delta,
  currentScrollLeft,
  maxScrollLeft,
}: DataGridNativeHorizontalWheelDispatchOptions): number => {
  const safeDelta = Number.isFinite(delta) ? delta : 0;
  const safeCurrent = Number.isFinite(currentScrollLeft) ? Math.max(0, currentScrollLeft) : 0;
  const safeMax = Number.isFinite(maxScrollLeft) ? Math.max(0, maxScrollLeft) : 0;
  return Math.max(0, Math.min(safeMax, safeCurrent + safeDelta));
};

export const shouldCommitVirtualHorizontalRange = ({
  nextOffset,
  lastCommittedOffset,
  thresholdPx,
}: DataGridHorizontalRangeCommitOptions): boolean => {
  const safeNext = Number.isFinite(nextOffset) ? nextOffset : 0;
  const safeLast = Number.isFinite(lastCommittedOffset) ? lastCommittedOffset : 0;
  const safeThreshold = Number.isFinite(thresholdPx) ? Math.max(0, thresholdPx) : 0;
  return Math.abs(safeNext - safeLast) >= safeThreshold;
};
