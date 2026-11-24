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
  scroller: HTMLDivElement;
  previousColumns: string;
  previousMinWidth: string;
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

const restoreGridVariables = (drag: DragState) => {
  if (drag.previousColumns) {
    drag.scroller.style.setProperty(COMPACT_GRID_COLUMNS_PROPERTY, drag.previousColumns);
  } else {
    drag.scroller.style.removeProperty(COMPACT_GRID_COLUMNS_PROPERTY);
  }
  if (drag.previousMinWidth) {
    drag.scroller.style.setProperty(COMPACT_GRID_MIN_WIDTH_PROPERTY, drag.previousMinWidth);
  } else {
    drag.scroller.style.removeProperty(COMPACT_GRID_MIN_WIDTH_PROPERTY);
  }
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

  const finishResize = useCallback((commitWidth?: number, restore = false) => {
    const drag = dragRef.current;
    dragRef.current = null;
    detachListeners();
    restoreBodyStyle();
    if (!drag) return;
    if (restore) {
      restoreGridVariables(drag);
      return;
    }
    const definition = resolveTableOverviewCompactColumnDefinitions(columnsRef.current)
      .find((column) => column.key === drag.key);
    if (!definition) return;
    const nextWidth = clampColumnWidth(definition, commitWidth ?? drag.latestWidth);
    if (nextWidth === drag.startWidth) {
      return;
    }
    onWidthsChangeRef.current?.({
      ...widthsRef.current,
      [drag.key]: nextWidth,
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
    const drag: DragState = {
      key,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      latestWidth: startWidth,
      scroller,
      previousColumns: scroller.style.getPropertyValue(COMPACT_GRID_COLUMNS_PROPERTY),
      previousMinWidth: scroller.style.getPropertyValue(COMPACT_GRID_MIN_WIDTH_PROPERTY),
    };
    dragRef.current = drag;

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
      applyGridVariables(activeDrag.scroller, columnsRef.current, {
        ...widthsRef.current,
        [activeDrag.key]: nextWidth,
      });
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
