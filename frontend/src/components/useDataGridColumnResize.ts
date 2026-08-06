import React, { useCallback, useEffect, useRef } from 'react';
import {
  MIN_DATA_TABLE_COLUMN_WIDTH,
  resolveDataTableColumnWidth,
} from '../utils/dataGridDisplay';
import { calculateAutoFitColumnWidth } from './dataGridAutoWidth';
import { DEFAULT_GRID_MONO_FONT_FAMILY, GONAVI_ROW_NUMBER_COLUMN_KEY } from './DataGridCore';

const ROW_NUMBER_DEFAULT_WIDTH = 36;
const ROW_NUMBER_MIN_WIDTH = 28;
const ROW_NUMBER_MAX_WIDTH = 120;

type UseDataGridColumnResizeContext = Record<string, any>;
type ColumnResizePreviewTargetKind = 'width' | 'width-and-flex' | 'delta-width' | 'table-width' | 'sticky-left';
type ColumnResizePreviewTarget = {
  element: HTMLElement;
  initialWidth: string;
  initialWidthPriority: string;
  initialMinWidth: string;
  initialMinWidthPriority: string;
  initialFlex: string;
  initialLeft: string;
  kind: ColumnResizePreviewTargetKind;
  baseValue?: number;
};
type ColumnResizePreview = {
  minimumRenderedWidth: number | null;
  renderedWidth: number | null;
  targets: ColumnResizePreviewTarget[];
};
type ColumnResizeDragState = {
  startX: number;
  startWidth: number;
  minWidth: number;
  key: string;
  preview: ColumnResizePreview | null;
};
type ColumnResizeListeners = {
  blur: () => void;
  move: (event: MouseEvent) => void;
  up: (event: MouseEvent) => void;
};

const resolveColumnResizeWidth = (dragState: ColumnResizeDragState, clientX: number): number => {
  const deltaX = clientX - dragState.startX;
  const isRowNumberColumn = dragState.key === GONAVI_ROW_NUMBER_COLUMN_KEY;
  const baseMinWidth = isRowNumberColumn ? ROW_NUMBER_MIN_WIDTH : MIN_DATA_TABLE_COLUMN_WIDTH;
  const minWidth = Math.max(baseMinWidth, dragState.minWidth);
  const maxWidth = isRowNumberColumn ? ROW_NUMBER_MAX_WIDTH : Number.POSITIVE_INFINITY;
  return Math.min(maxWidth, Math.max(minWidth, dragState.startWidth + deltaX));
};

const parseInlinePixelValue = (value: string, fallback: number): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const createColumnResizePreview = (
  eventTarget: EventTarget | null,
  key: string,
): ColumnResizePreview | null => {
  const handleElement = eventTarget as HTMLElement | null;
  const headerCell = handleElement?.closest?.('th') as HTMLTableCellElement | null;
  const sourceTable = headerCell?.closest?.('table') as HTMLTableElement | null;
  if (!headerCell || !sourceTable || headerCell.cellIndex < 0) return null;

  const renderedWidth = headerCell.getBoundingClientRect?.().width;
  const tableWrapper = sourceTable.closest('.ant-table-wrapper');
  const tableRoot = (tableWrapper || sourceTable) as HTMLElement;
  const targets: ColumnResizePreviewTarget[] = [];
  const targetKeys = new Map<HTMLElement, Set<ColumnResizePreviewTargetKind>>();
  const addTarget = (
    element: HTMLElement | null,
    kind: ColumnResizePreviewTargetKind,
    baseValue?: number,
  ) => {
    if (!element) return;
    const kinds = targetKeys.get(element) ?? new Set<ColumnResizePreviewTargetKind>();
    if (kinds.has(kind)) return;
    kinds.add(kind);
    targetKeys.set(element, kinds);
    targets.push({
      element,
      initialWidth: element.style.width,
      initialWidthPriority: element.style.getPropertyPriority?.('width') ?? '',
      initialMinWidth: element.style.minWidth,
      initialMinWidthPriority: element.style.getPropertyPriority?.('min-width') ?? '',
      initialFlex: element.style.flex,
      initialLeft: element.style.left,
      kind,
      baseValue,
    });
  };

  const tables = Array.from(tableRoot.querySelectorAll('table')) as HTMLTableElement[];
  if (!tables.includes(sourceTable)) tables.push(sourceTable);
  tables.forEach((table) => {
    const tableWidth = parseInlinePixelValue(table.style.width, table.getBoundingClientRect?.().width ?? 0);
    addTarget(table, 'table-width', tableWidth);
    const columns = Array.from(table.querySelectorAll('colgroup > col')) as HTMLElement[];
    addTarget(columns[headerCell.cellIndex] ?? null, 'width');
  });

  const tableSurface = tableWrapper?.closest('.data-grid-table-wrap') as HTMLElement | null;
  const externalScrollInner = tableSurface?.querySelector(
    '.data-grid-external-horizontal-scroll-inner',
  ) as HTMLElement | null;
  if (externalScrollInner) {
    const externalWidth = parseInlinePixelValue(
      externalScrollInner.style.width,
      externalScrollInner.getBoundingClientRect?.().width ?? 0,
    );
    addTarget(externalScrollInner, 'delta-width', externalWidth);
  }

  const fixedHeaderCells = Array.from(headerCell.parentElement?.children ?? []) as HTMLElement[];
  const headerCellIndex = fixedHeaderCells.indexOf(headerCell);
  const hasLaterResizableColumn = headerCellIndex >= 0 && fixedHeaderCells
    .slice(headerCellIndex + 1)
    .some((cell) => !!cell.querySelector?.('.react-resizable-handle'));
  const isViewportFillColumn = !hasLaterResizableColumn
    && !headerCell.classList?.contains('ant-table-cell-fix-left')
    && !headerCell.classList?.contains('ant-table-cell-fix-right');
  if (headerCell.classList?.contains('ant-table-cell-fix-left') && headerCellIndex >= 0) {
    fixedHeaderCells.slice(headerCellIndex + 1).forEach((cell) => {
      if (!cell.classList?.contains('ant-table-cell-fix-left')) return;
      const left = parseInlinePixelValue(cell.style.left, cell.getBoundingClientRect?.().left ?? 0);
      addTarget(cell, 'sticky-left', left);
    });
  }

  const virtualRows = Array.from(
    tableRoot.querySelectorAll('.ant-table-tbody-virtual .ant-table-row'),
  ) as HTMLElement[];
  virtualRows.forEach((row) => {
    const cells = Array.from(row.children) as HTMLElement[];
    const targetCell = cells.find((cell) => (
      key === GONAVI_ROW_NUMBER_COLUMN_KEY
        ? cell.classList?.contains('data-grid-row-number-cell')
        : cell.getAttribute?.('data-col-name') === key
    ));
    if (!targetCell) return;

    addTarget(targetCell, 'width-and-flex');
    const rowWidth = parseInlinePixelValue(row.style.width, row.getBoundingClientRect?.().width ?? 0);
    addTarget(row, 'delta-width', rowWidth);

    if (targetCell.classList?.contains('ant-table-cell-fix-left')) {
      const targetIndex = cells.indexOf(targetCell);
      cells.slice(targetIndex + 1).forEach((cell) => {
        if (!cell.classList?.contains('ant-table-cell-fix-left')) return;
        const left = parseInlinePixelValue(cell.style.left, cell.getBoundingClientRect?.().left ?? 0);
        addTarget(cell, 'sticky-left', left);
      });
    }
  });

  const standardRows = Array.from(
    tableRoot.querySelectorAll('.ant-table-tbody > .ant-table-row'),
  ) as HTMLElement[];
  standardRows.forEach((row) => {
    const cells = Array.from(row.children) as HTMLElement[];
    const targetCell = cells.find((cell) => (
      key === GONAVI_ROW_NUMBER_COLUMN_KEY
        ? cell.classList?.contains('data-grid-row-number-cell')
        : cell.getAttribute?.('data-col-name') === key
    ));
    if (!targetCell?.classList?.contains('ant-table-cell-fix-left')) return;

    const targetIndex = cells.indexOf(targetCell);
    cells.slice(targetIndex + 1).forEach((cell) => {
      if (!cell.classList?.contains('ant-table-cell-fix-left')) return;
      const left = parseInlinePixelValue(cell.style.left, cell.getBoundingClientRect?.().left ?? 0);
      addTarget(cell, 'sticky-left', left);
    });
  });

  if (!targets.some(({ kind }) => kind === 'width')) {
    addTarget(headerCell, 'width');
  }

  const resolvedRenderedWidth = Number.isFinite(renderedWidth) && renderedWidth > 0
    ? renderedWidth
    : null;
  const tableWidth = sourceTable.getBoundingClientRect?.().width;
  const viewportWidth = sourceTable.parentElement?.getBoundingClientRect?.().width;
  const availableShrink = Number.isFinite(tableWidth) && Number.isFinite(viewportWidth)
    ? Math.max(0, (tableWidth as number) - (viewportWidth as number))
    : null;

  return {
    targets,
    minimumRenderedWidth: isViewportFillColumn
      && resolvedRenderedWidth !== null
      && availableShrink !== null
      ? Math.max(0, Math.ceil(resolvedRenderedWidth - availableShrink))
      : null,
    renderedWidth: resolvedRenderedWidth,
  };
};

const applyColumnResizePreview = (
  preview: ColumnResizePreview | null,
  width: number,
  startWidth: number,
) => {
  if (!preview) return;
  const delta = width - startWidth;
  preview.targets.forEach(({ element, kind, baseValue }) => {
    if (kind === 'width') {
      element.style.width = `${width}px`;
      return;
    }
    if (kind === 'width-and-flex') {
      element.style.width = `${width}px`;
      element.style.flex = `0 0 ${width}px`;
      return;
    }
    const nextValue = (baseValue ?? 0) + delta;
    if (kind === 'table-width') {
      element.style.setProperty('width', `${nextValue}px`, 'important');
      element.style.setProperty('min-width', `${nextValue}px`, 'important');
      return;
    }
    if (kind === 'delta-width') {
      element.style.width = `${nextValue}px`;
      return;
    }
    element.style.left = `${nextValue}px`;
  });
};

const restoreColumnResizePreview = (preview: ColumnResizePreview | null) => {
  if (!preview) return;
  preview.targets.forEach(({
    element,
    initialWidth,
    initialWidthPriority,
    initialMinWidth,
    initialMinWidthPriority,
    initialFlex,
    initialLeft,
  }) => {
    element.style.width = initialWidth;
    if (initialWidthPriority) {
      element.style.setProperty('width', initialWidth, initialWidthPriority);
    }
    element.style.minWidth = initialMinWidth;
    if (initialMinWidthPriority) {
      element.style.setProperty('min-width', initialMinWidth, initialMinWidthPriority);
    }
    element.style.flex = initialFlex;
    element.style.left = initialLeft;
  });
};

export const useDataGridColumnResize = (ctx: UseDataGridColumnResizeContext) => {
  const {
    columnMetaMap,
    columnMetaMapByLowerName,
    columnWidths,
    containerRef,
    dataTableDensity,
    densityParams,
    displayColumnNames,
    displayData,
    displayDataRef,
    setColumnWidths,
    showColumnComment,
    showColumnType,
  } = ctx;

  const draggingRef = useRef<ColumnResizeDragState | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const latestClientXRef = useRef<number | null>(null);
  const isResizingRef = useRef(false);
  const resizeGateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeBodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);
  const resizeListenersRef = useRef<ColumnResizeListeners | null>(null);
  const setColumnWidthsRef = useRef(setColumnWidths);
  const lastPreviewResizeWidthRef = useRef<number | null>(null);
  const autoFitCanvasRef = useRef<HTMLCanvasElement | null>(null);
  setColumnWidthsRef.current = setColumnWidths;

  const previewResizeWidth = useCallback((dragState: ColumnResizeDragState, clientX: number) => {
    const newWidth = resolveColumnResizeWidth(dragState, clientX);
    if (lastPreviewResizeWidthRef.current === newWidth) return newWidth;
    lastPreviewResizeWidthRef.current = newWidth;
    applyColumnResizePreview(dragState.preview, newWidth, dragState.startWidth);
    return newWidth;
  }, []);

  const commitResizeWidth = useCallback((dragState: ColumnResizeDragState, newWidth: number) => {
    setColumnWidthsRef.current((prev: Record<string, number>) => (
      prev[dragState.key] === newWidth
        ? prev
        : { ...prev, [dragState.key]: newWidth }
    ));
  }, []);

  const flushResizeFrame = useCallback(() => {
    resizeRafRef.current = null;
    if (!draggingRef.current) return;
    if (latestClientXRef.current === null) return;
    const dragState = draggingRef.current;
    const clientX = latestClientXRef.current;
    previewResizeWidth(dragState, clientX);
  }, [previewResizeWidth]);

  const detachResizeListeners = useCallback(() => {
    const listeners = resizeListenersRef.current;
    if (!listeners) return;
    resizeListenersRef.current = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('mousemove', listeners.move);
      document.removeEventListener('mouseup', listeners.up);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('blur', listeners.blur);
    }
  }, []);

  const restoreResizeBodyStyles = useCallback(() => {
    const previous = resizeBodyStyleRef.current;
    resizeBodyStyleRef.current = null;
    if (!previous || typeof document === 'undefined') return;
    document.body.style.cursor = previous.cursor;
    document.body.style.userSelect = previous.userSelect;
  }, []);

  const finishResize = useCallback((clientX?: number, commit = true, deferGateReset = true) => {
    const dragState = draggingRef.current;
    const latestClientX = latestClientXRef.current;
    draggingRef.current = null;

    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
    }
    latestClientXRef.current = null;
    detachResizeListeners();
    restoreResizeBodyStyles();

    if (resizeGateTimeoutRef.current !== null) {
      clearTimeout(resizeGateTimeoutRef.current);
      resizeGateTimeoutRef.current = null;
    }
    if (deferGateReset) {
      resizeGateTimeoutRef.current = setTimeout(() => {
        resizeGateTimeoutRef.current = null;
        isResizingRef.current = false;
      }, 100);
    } else {
      isResizingRef.current = false;
    }

    if (commit && dragState) {
      const finalClientX = Number.isFinite(clientX) ? clientX as number : latestClientX ?? dragState.startX;
      const finalWidth = resolveColumnResizeWidth(dragState, finalClientX);
      restoreColumnResizePreview(dragState.preview);
      if (finalWidth !== dragState.startWidth) {
        commitResizeWidth(dragState, finalWidth);
      }
    } else if (dragState) {
      restoreColumnResizePreview(dragState.preview);
    }
    lastPreviewResizeWidthRef.current = null;
  }, [commitResizeWidth, detachResizeListeners, previewResizeWidth, restoreResizeBodyStyles]);

  const handleResizeStart = useCallback((key: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    finishResize(undefined, false, false);
    isResizingRef.current = true;

    const startX = e.clientX;
    // 序号列默认宽度与数据列不同，不能走 density 默认列宽
    const isRowNumberColumn = key === GONAVI_ROW_NUMBER_COLUMN_KEY;
    const declaredWidth = isRowNumberColumn
      ? (typeof columnWidths[key] === 'number' && columnWidths[key] > 0 ? columnWidths[key] : ROW_NUMBER_DEFAULT_WIDTH)
      : resolveDataTableColumnWidth({
          manualWidth: columnWidths[key],
          density: dataTableDensity,
        });
    const preview = createColumnResizePreview(e.currentTarget, key);
    const renderedWidth = preview?.renderedWidth;
    const currentWidth = renderedWidth && renderedWidth > 0 ? renderedWidth : declaredWidth;
    const baseMinWidth = isRowNumberColumn ? ROW_NUMBER_MIN_WIDTH : MIN_DATA_TABLE_COLUMN_WIDTH;
    // The last flexible column can absorb unused viewport width. It cannot be
    // rendered narrower until the declared table width fills the viewport, so
    // keep that displayed floor during preview to avoid release-time snapping.
    const minWidth = Math.max(baseMinWidth, preview?.minimumRenderedWidth ?? baseMinWidth);
    draggingRef.current = {
      startX,
      startWidth: currentWidth,
      minWidth,
      key,
      preview,
    };
    lastPreviewResizeWidthRef.current = currentWidth;
    latestClientXRef.current = startX;

    const handleMove = (event: MouseEvent) => {
      if (!draggingRef.current) return;
      latestClientXRef.current = event.clientX;
      if (event.buttons === 0) {
        finishResize(event.clientX);
        return;
      }
      if (resizeRafRef.current !== null) return;
      resizeRafRef.current = requestAnimationFrame(flushResizeFrame);
    };
    const handleUp = (event: MouseEvent) => finishResize(event.clientX);
    const handleBlur = () => finishResize();

    resizeListenersRef.current = {
      blur: handleBlur,
      move: handleMove,
      up: handleUp,
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    window.addEventListener('blur', handleBlur);
    resizeBodyStyleRef.current = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [columnWidths, containerRef, dataTableDensity, finishResize, flushResizeFrame]);

  useEffect(() => () => {
    finishResize(undefined, false, false);
  }, [finishResize]);

  const measureTextWidth = useCallback((text: string, font: string) => {
    if (typeof document === 'undefined') {
      return text.length * 8;
    }
    if (!autoFitCanvasRef.current) {
      autoFitCanvasRef.current = document.createElement('canvas');
    }
    const context = autoFitCanvasRef.current.getContext('2d');
    if (!context) {
      return text.length * 8;
    }
    context.font = font;
    return context.measureText(text).width;
  }, []);

  const buildAutoFitMeasurer = useCallback((element: HTMLElement | null, fallbackFont: string) => {
    let font = fallbackFont;
    if (typeof window !== 'undefined' && element) {
      const computed = window.getComputedStyle(element);
      const weight = computed.fontWeight || '400';
      const size = computed.fontSize || '13px';
      const family = computed.fontFamily || DEFAULT_GRID_MONO_FONT_FAMILY;
      font = `${weight} ${size} ${family}`;
    }
    return (text: string) => measureTextWidth(text, font);
  }, [measureTextWidth]);

  const autoFitDoneRef = useRef<string>('');
  useEffect(() => {
    if (displayColumnNames.length === 0 || displayData.length === 0) return;
    const sig = displayColumnNames.join(',');
    if (autoFitDoneRef.current === sig) return;
    const font = `${densityParams.dataFontSize}px ${DEFAULT_GRID_MONO_FONT_FAMILY}`;
    const newWidths: Record<string, number> = {};
    displayColumnNames.forEach((key: string) => {
      const autoWidth = calculateAutoFitColumnWidth({
        headerTexts: [key],
        valueTexts: displayData.slice(0, 200).map((row: any) => row?.[key]),
        measureHeaderText: (text) => measureTextWidth(text, `600 ${font}`),
        measureCellText: (text) => measureTextWidth(text, `400 ${font}`),
        minWidth: MIN_DATA_TABLE_COLUMN_WIDTH,
        maxWidth: 600,
        defaultWidth: densityParams.defaultColumnWidth,
      });
      newWidths[key] = autoWidth;
    });
    autoFitDoneRef.current = sig;
    setColumnWidths((prev: Record<string, number>) => ({ ...newWidths, ...prev }));
  }, [displayColumnNames, displayData, densityParams, measureTextWidth, setColumnWidths]);

  const autoFitColumnWidth = useCallback((key: string, headerEl?: HTMLElement | null) => {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) return;
    const sampleCell = Array.from(
      containerRef.current?.querySelectorAll('.ant-table-cell[data-col-name]') || [],
    ).find((node) => (node as HTMLElement).getAttribute('data-col-name') === normalizedKey) as HTMLElement | undefined;

    const meta = columnMetaMap[normalizedKey] || columnMetaMapByLowerName[normalizedKey.toLowerCase()];
    const headerTexts = [normalizedKey];
    if (showColumnType && meta?.type) headerTexts.push(meta.type);
    if (showColumnComment && meta?.comment) headerTexts.push(meta.comment);

    const defaultWidth = resolveDataTableColumnWidth({
      manualWidth: columnWidths[normalizedKey],
      density: dataTableDensity,
    });
    const containerWidth = containerRef.current?.clientWidth ?? 0;
    const nextWidth = calculateAutoFitColumnWidth({
      headerTexts,
      valueTexts: displayDataRef.current.slice(0, 200).map((row: any) => row?.[normalizedKey]),
      measureHeaderText: buildAutoFitMeasurer(headerEl ?? null, `600 ${densityParams.dataFontSize}px ${DEFAULT_GRID_MONO_FONT_FAMILY}`),
      measureCellText: buildAutoFitMeasurer(sampleCell ?? null, `400 ${densityParams.dataFontSize}px ${DEFAULT_GRID_MONO_FONT_FAMILY}`),
      defaultWidth,
      minWidth: MIN_DATA_TABLE_COLUMN_WIDTH,
      maxWidth: Math.max(720, Math.floor(containerWidth * 0.85)),
    });

    setColumnWidths((prev: Record<string, number>) => ({ ...prev, [normalizedKey]: nextWidth }));
  }, [
    buildAutoFitMeasurer,
    columnMetaMap,
    columnMetaMapByLowerName,
    columnWidths,
    dataTableDensity,
    densityParams.dataFontSize,
    showColumnComment,
    showColumnType,
    setColumnWidths,
  ]);

  const handleResizeAutoFit = useCallback((key: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // 序号列双击还原默认窄宽，不按数据内容撑开
    if (key === GONAVI_ROW_NUMBER_COLUMN_KEY) {
      setColumnWidths((prev: Record<string, number>) => ({ ...prev, [key]: ROW_NUMBER_DEFAULT_WIDTH }));
      return;
    }
    const handleEl = e.currentTarget as HTMLElement | null;
    const headerEl = handleEl?.closest('th') as HTMLElement | null;
    autoFitColumnWidth(key, headerEl);
  }, [autoFitColumnWidth, setColumnWidths]);

  return {
    autoFitColumnWidth,
    handleResizeAutoFit,
    handleResizeStart,
    isResizingRef,
  };
};
