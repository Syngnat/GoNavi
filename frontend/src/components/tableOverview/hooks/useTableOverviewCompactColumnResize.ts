import React, { useCallback, useEffect, useMemo, useRef } from 'react';

import {
  TABLE_OVERVIEW_COMPACT_COLUMN_WIDTH_MAX,
  type TableOverviewCompactColumn,
  type TableOverviewCompactColumnWidths,
} from '../../../utils/tableOverviewCompactColumns';
import {
  buildTableOverviewCompactGridStyle,
  resolveTableOverviewCompactColumnDefinitions,
  type TableOverviewCompactColumnDefinition,
} from '../tableOverviewCompactColumns';

const KEYBOARD_RESIZE_STEP = 16;
const KEYBOARD_RESIZE_LARGE_STEP = 48;
const AUTO_FIT_PADDING = 4;
const COMPACT_GRID_COLUMNS_PROPERTY = '--gn-table-overview-compact-columns';
const COMPACT_GRID_MIN_WIDTH_PROPERTY = '--gn-table-overview-compact-min-width';

type CompactGridStyle = React.CSSProperties & {
  '--gn-table-overview-compact-columns'?: string;
  '--gn-table-overview-compact-min-width'?: string;
};

type DragState = {
  key: TableOverviewCompactColumn;
  pointerId: number;
  startX: number;
  startWidth: number;
  latestWidth: number;
  startGuideX: number;
  guide: HTMLDivElement;
  header: HTMLElement;
  scroller: HTMLDivElement;
};

type PointerListeners = {
  move: (event: PointerEvent) => void;
  up: (event: PointerEvent) => void;
  cancel: () => void;
  blur: () => void;
};

type UseTableOverviewCompactColumnResizeInput = {
  scrollRef: React.RefObject<HTMLDivElement>;
  columns: TableOverviewCompactColumn[];
  widths: TableOverviewCompactColumnWidths;
  onWidthsChange?: (widths: TableOverviewCompactColumnWidths) => void;
};

const clampColumnWidth = (
  column: TableOverviewCompactColumnDefinition,
  width: number,
): number => Math.min(
  TABLE_OVERVIEW_COMPACT_COLUMN_WIDTH_MAX,
  Math.max(column.minWidth, Math.round(width)),
);

const resolveColumnIndex = (
  columns: TableOverviewCompactColumn[],
  key: TableOverviewCompactColumn,
): number => columns.indexOf(key);

const resolveHeaderCell = (target: EventTarget | null): HTMLElement | null => (
  target instanceof Element
    ? target.closest<HTMLElement>('[role="columnheader"]')
    : null
);

const removeResizeGuide = (guide: HTMLDivElement | null | undefined) => {
  guide?.remove();
};

const positionResizeGuide = (drag: DragState, width: number) => {
  const guideX = drag.startGuideX + width - drag.startWidth;
  drag.guide.style.transform = `translate3d(${guideX}px, 0, 0)`;
};

const applyGridVariables = (
  scroller: HTMLDivElement,
  columns: TableOverviewCompactColumn[],
  widths: TableOverviewCompactColumnWidths,
) => {
  const style = buildTableOverviewCompactGridStyle(columns, widths) as CompactGridStyle;
  scroller.style.setProperty(
    COMPACT_GRID_COLUMNS_PROPERTY,
    style['--gn-table-overview-compact-columns'] ?? '',
  );
  scroller.style.setProperty(
    COMPACT_GRID_MIN_WIDTH_PROPERTY,
    style['--gn-table-overview-compact-min-width'] ?? '',
  );
};

export const useTableOverviewCompactColumnResize = ({
  scrollRef,
  columns,
  widths,
  onWidthsChange,
}: UseTableOverviewCompactColumnResizeInput) => {
  const columnsRef = useRef(columns);
  const widthsRef = useRef(widths);
  const onWidthsChangeRef = useRef(onWidthsChange);
  const dragRef = useRef<DragState | null>(null);
  const listenersRef = useRef<PointerListeners | null>(null);
  const bodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);
  const pendingWidthsRef = useRef<TableOverviewCompactColumnWidths | null>(null);
  const commitPendingRef = useRef(false);

  columnsRef.current = columns;
  widthsRef.current = widths;
  onWidthsChangeRef.current = onWidthsChange;

  const gridStyle = useMemo(
    () => buildTableOverviewCompactGridStyle(columns, widths),
    [columns, widths],
  );

  const detachListeners = useCallback(() => {
    const listeners = listenersRef.current;
    if (!listeners || typeof document === 'undefined') {
      listenersRef.current = null;
      return;
    }
    listenersRef.current = null;
    document.removeEventListener('pointermove', listeners.move);
    document.removeEventListener('pointerup', listeners.up);
    document.removeEventListener('pointercancel', listeners.cancel);
    window.removeEventListener('blur', listeners.blur);
  }, []);

  const restoreBodyStyle = useCallback(() => {
    const previous = bodyStyleRef.current;
    bodyStyleRef.current = null;
    if (!previous || typeof document === 'undefined') return;
    document.body.style.cursor = previous.cursor;
    document.body.style.userSelect = previous.userSelect;
  }, []);

  const finishResize = useCallback((clientX?: number, restore = false) => {
    const drag = dragRef.current;
    dragRef.current = null;
    detachListeners();
    restoreBodyStyle();
    if (!drag) return;
    drag.header.removeAttribute('data-resizing');
    removeResizeGuide(drag.guide);
    if (restore) {
      return;
    }
    const definition = resolveTableOverviewCompactColumnDefinitions(columnsRef.current)
      .find((column) => column.key === drag.key);
    if (!definition) return;
    const nextWidth = clampColumnWidth(
      definition,
      Number.isFinite(clientX)
        ? drag.startWidth + (clientX as number) - drag.startX
        : drag.latestWidth,
    );
    if (nextWidth === drag.startWidth) {
      return;
    }
    const nextWidths = {
      ...widthsRef.current,
      [drag.key]: nextWidth,
    };
    widthsRef.current = nextWidths;
    applyGridVariables(drag.scroller, columnsRef.current, nextWidths);
    pendingWidthsRef.current = nextWidths;
    if (commitPendingRef.current) return;
    commitPendingRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        commitPendingRef.current = false;
        const pendingWidths = pendingWidthsRef.current;
        pendingWidthsRef.current = null;
        if (pendingWidths) onWidthsChangeRef.current?.(pendingWidths);
      });
    });
  }, [detachListeners, restoreBodyStyle]);

  const handleResizeStart = useCallback((
    key: TableOverviewCompactColumn,
    event: React.PointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0 || !onWidthsChangeRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    if (dragRef.current) finishResize(undefined, true);

    const headerCell = resolveHeaderCell(event.currentTarget);
    const scroller = scrollRef.current
      ?? headerCell?.closest<HTMLDivElement>('.gn-table-overview-compact-scroll')
      ?? null;
    if (!headerCell || !scroller) return;

    const definitions = resolveTableOverviewCompactColumnDefinitions(columnsRef.current);
    const keyIndex = resolveColumnIndex(columnsRef.current, key);
    if (keyIndex < 0) return;

    const renderedWidth = headerCell.getBoundingClientRect?.().width ?? 0;
    const requestedWidth = widthsRef.current[key];
    const startWidth = clampColumnWidth(
      definitions[keyIndex],
      renderedWidth > 0
        ? renderedWidth
        : Number.isFinite(requestedWidth)
          ? requestedWidth as number
          : definitions[keyIndex].minWidth,
    );
    const headerRect = headerCell.getBoundingClientRect?.();
    const headerRight = headerRect?.right;
    const startGuideX = typeof headerRight === 'number' && Number.isFinite(headerRight)
      ? headerRight
      : event.clientX;
    const scrollerRect = scroller.getBoundingClientRect?.();
    const guide = document.createElement('div');
    guide.setAttribute('data-table-overview-column-resize-guide', key);
    Object.assign(guide.style, {
      position: 'fixed',
      left: '0',
      top: `${scrollerRect?.top ?? 0}px`,
      width: '2px',
      height: `${scrollerRect?.height ?? 0}px`,
      background: 'var(--gn-accent, #16a34a)',
      pointerEvents: 'none',
      willChange: 'transform',
      zIndex: '40',
      transform: `translate3d(${startGuideX}px, 0, 0)`,
    });
    document.body.appendChild(guide);
    const drag: DragState = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      latestWidth: startWidth,
      startGuideX,
      guide,
      header: headerCell,
      scroller,
    };
    dragRef.current = drag;
    headerCell.setAttribute('data-resizing', 'true');

    const move = (pointerEvent: PointerEvent) => {
      const activeDrag = dragRef.current;
      if (!activeDrag || pointerEvent.pointerId !== activeDrag.pointerId) return;
      if (pointerEvent.buttons === 0) {
        finishResize(pointerEvent.clientX);
        return;
      }
      const definition = resolveTableOverviewCompactColumnDefinitions(columnsRef.current)
        .find((column) => column.key === activeDrag.key);
      if (!definition) return;
      pointerEvent.preventDefault();
      const nextWidth = clampColumnWidth(
        definition,
        activeDrag.startWidth + pointerEvent.clientX - activeDrag.startX,
      );
      activeDrag.latestWidth = nextWidth;
      positionResizeGuide(activeDrag, nextWidth);
    };
    const up = (pointerEvent: PointerEvent) => {
      const activeDrag = dragRef.current;
      if (!activeDrag || pointerEvent.pointerId !== activeDrag.pointerId) return;
      finishResize(pointerEvent.clientX);
    };
    const cancel = () => finishResize(undefined, true);
    const blur = () => finishResize();

    listenersRef.current = { move, up, cancel, blur };
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', blur);
    bodyStyleRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [finishResize, scrollRef]);

  const handleResizeKeyDown = useCallback((
    key: TableOverviewCompactColumn,
    event: React.KeyboardEvent<HTMLElement>,
  ) => {
    const isDecrease = event.key === 'ArrowLeft';
    const isIncrease = event.key === 'ArrowRight';
    if (!isDecrease && !isIncrease) return;
    const definition = resolveTableOverviewCompactColumnDefinitions(columnsRef.current)
      .find((column) => column.key === key);
    if (!definition) return;
    event.preventDefault();
    event.stopPropagation();
    const renderedWidth = resolveHeaderCell(event.currentTarget)?.getBoundingClientRect?.().width ?? 0;
    const requestedWidth = widthsRef.current[key];
    const currentWidth = renderedWidth > 0
      ? renderedWidth
      : Number.isFinite(requestedWidth)
        ? requestedWidth as number
        : definition.minWidth;
    const step = event.shiftKey ? KEYBOARD_RESIZE_LARGE_STEP : KEYBOARD_RESIZE_STEP;
    const nextWidth = clampColumnWidth(
      definition,
      currentWidth + (isIncrease ? step : -step),
    );
    onWidthsChangeRef.current?.({
      ...widthsRef.current,
      [key]: nextWidth,
    });
  }, []);

  const handleResizeAutoFit = useCallback((
    key: TableOverviewCompactColumn,
    event: React.MouseEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const definition = resolveTableOverviewCompactColumnDefinitions(columnsRef.current)
      .find((column) => column.key === key);
    const headerCell = resolveHeaderCell(event.currentTarget);
    const scroller = scrollRef.current
      ?? headerCell?.closest<HTMLDivElement>('.gn-table-overview-compact-scroll')
      ?? null;
    if (!definition || !headerCell || !scroller) return;

    const columnIndex = resolveColumnIndex(columnsRef.current, key);
    if (columnIndex < 0) return;
    const headerText = headerCell.querySelector<HTMLElement>(
      '.gn-table-overview-compact-sort-button span, .gn-table-overview-compact-plain-header',
    );
    let measuredWidth = Math.max(headerText?.scrollWidth ?? 0, headerCell.scrollWidth);
    const rows = scroller.querySelectorAll<HTMLElement>('.gn-table-overview-compact-row');
    rows.forEach((row) => {
      const cell = row.children[columnIndex] as HTMLElement | undefined;
      if (!cell) return;
      const nameText = key === 'name'
        ? cell.querySelector<HTMLElement>('span')
        : null;
      measuredWidth = Math.max(
        measuredWidth,
        cell.scrollWidth,
        nameText?.scrollWidth ?? 0,
      );
    });

    onWidthsChangeRef.current?.({
      ...widthsRef.current,
      [key]: clampColumnWidth(definition, measuredWidth + AUTO_FIT_PADDING),
    });
  }, [scrollRef]);

  useEffect(() => () => {
    finishResize(undefined, true);
  }, [finishResize]);

  return {
    gridStyle,
    handleResizeStart,
    handleResizeKeyDown,
    handleResizeAutoFit,
  };
};
