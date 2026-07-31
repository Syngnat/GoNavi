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
type ColumnResizeListeners = {
  blur: () => void;
  move: (event: MouseEvent) => void;
  up: (event: MouseEvent) => void;
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

  const draggingRef = useRef<{
    startX: number;
    startWidth: number;
    key: string;
    containerLeft: number;
  } | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const resizeRafRef = useRef<number | null>(null);
  const latestClientXRef = useRef<number | null>(null);
  const isResizingRef = useRef(false);
  const resizeGateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeBodyStyleRef = useRef<{ cursor: string; userSelect: string } | null>(null);
  const resizeListenersRef = useRef<ColumnResizeListeners | null>(null);
  const setColumnWidthsRef = useRef(setColumnWidths);
  const autoFitCanvasRef = useRef<HTMLCanvasElement | null>(null);
  setColumnWidthsRef.current = setColumnWidths;

  const flushGhostPosition = useCallback(() => {
    resizeRafRef.current = null;
    if (!draggingRef.current || !ghostRef.current) return;
    if (latestClientXRef.current === null) return;
    const relativeLeft = latestClientXRef.current - draggingRef.current.containerLeft;
    ghostRef.current.style.transform = `translateX(${relativeLeft}px)`;
  }, []);

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
    if (ghostRef.current) {
      ghostRef.current.style.display = 'none';
    }
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
      const deltaX = finalClientX - dragState.startX;
      const isRowNumberColumn = dragState.key === GONAVI_ROW_NUMBER_COLUMN_KEY;
      const minWidth = isRowNumberColumn ? ROW_NUMBER_MIN_WIDTH : MIN_DATA_TABLE_COLUMN_WIDTH;
      const maxWidth = isRowNumberColumn ? ROW_NUMBER_MAX_WIDTH : Number.POSITIVE_INFINITY;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, dragState.startWidth + deltaX));
      setColumnWidthsRef.current((prev: Record<string, number>) => ({ ...prev, [dragState.key]: newWidth }));
    }
  }, [detachResizeListeners, restoreResizeBodyStyles]);

  const handleResizeStart = useCallback((key: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    finishResize(undefined, false, false);
    isResizingRef.current = true;

    const startX = e.clientX;
    // 序号列默认宽度与数据列不同，不能走 density 默认列宽
    const isRowNumberColumn = key === GONAVI_ROW_NUMBER_COLUMN_KEY;
    const currentWidth = isRowNumberColumn
      ? (typeof columnWidths[key] === 'number' && columnWidths[key] > 0 ? columnWidths[key] : ROW_NUMBER_DEFAULT_WIDTH)
      : resolveDataTableColumnWidth({
          manualWidth: columnWidths[key],
          density: dataTableDensity,
        });
    const containerLeft = containerRef.current?.getBoundingClientRect().left ?? 0;
    draggingRef.current = { startX, startWidth: currentWidth, key, containerLeft };
    latestClientXRef.current = startX;

    if (ghostRef.current && containerRef.current) {
      const relativeLeft = startX - containerLeft;
      ghostRef.current.style.transform = `translateX(${relativeLeft}px)`;
      ghostRef.current.style.display = 'block';
    }

    const handleMove = (event: MouseEvent) => {
      if (!draggingRef.current) return;
      latestClientXRef.current = event.clientX;
      if (event.buttons === 0) {
        finishResize(event.clientX);
        return;
      }
      if (resizeRafRef.current !== null) return;
      resizeRafRef.current = requestAnimationFrame(flushGhostPosition);
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
  }, [columnWidths, containerRef, dataTableDensity, finishResize, flushGhostPosition]);

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
    ghostRef,
    handleResizeAutoFit,
    handleResizeStart,
    isResizingRef,
  };
};
