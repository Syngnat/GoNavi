import { canSelectGridCellForClipboard } from '../../dataGridSelectionCopy';
import { buildDataGridCellSelectionRectangle } from '../../DataGridCore';
import {
  DATA_GRID_SELECTION_AUTO_SCROLL_EDGE_THRESHOLD_PX, getDataGridSelectionAutoScrollStep,
  clampDataGridSelectionAutoScrollDelta,
} from '../../dataGridSelectionAutoScroll';
import type {
  CellSelectionAutoScrollViewport, CellSelectionAutoScrollController, DataGridBatchActionsContext,
} from '../../useDataGridBatchActions';

export interface CreateCellSelectionInteractionInput {
  container: HTMLDivElement;
  ctx: DataGridBatchActionsContext;
}

export const createCellSelectionInteraction = ({ container, ctx }: CreateCellSelectionInteractionInput) => {
  const {
    canModifyData, columnIndexMap, isWritableResultColumn, effectiveEditLocator, selectionStartRef,
    displayDataRef, rowKeyStr, GONAVI_ROW_KEY, displayColumnNames, currentSelectionRef,
    updateCellSelection, cellSelectionRafRef, cancelAnimationFrame, requestAnimationFrame,
    cellSelectionAutoScrollRafRef, cellSelectionAutoScrollControllerRef, isDraggingRef,
    cellSelectionPointerRef, markCellSelectionUserSelection, cellEditModeRef, setCellEditMode,
    suppressCellSelectionClickRef, pendingCellSelectionStartRef, rowIndexMapRef,
    cellSelectionAnchorSourceRef, makeCellKey, setSelectedCells, markCellSelectionDeleteEligible,
  } = ctx;
  const isInteractiveTarget = (target: HTMLElement | null): boolean => {
    if (!target) return false;
    return !!target.closest('input, textarea, button, select, [contenteditable="true"], .ant-checkbox, .ant-picker, .ant-select, .ant-dropdown, .ant-modal');
  };

  const getCellElement = (target: HTMLElement | null): HTMLElement | null => {
    if (!target) return null;
    const cell = target.closest('[data-row-key][data-col-name]') as HTMLElement;
    if (!cell || !container.contains(cell)) return null;
    const colName = cell.getAttribute('data-col-name');
    if (!colName || !canSelectGridCellForClipboard({
      canModifyData,
      isDisplayedColumn: columnIndexMap.has(colName),
      isWritableColumn: isWritableResultColumn(colName, effectiveEditLocator),
    })) return null;
    return cell;
  };

  const getCellInfo = (target: HTMLElement | null): { rowKey: string; colName: string } | null => {
    const cell = getCellElement(target);
    if (!cell) return null;
    const rowKey = cell.getAttribute('data-row-key');
    const colName = cell.getAttribute('data-col-name');
    if (!rowKey || !colName) return null;
    return { rowKey, colName };
  };

  const getCellInfoFromPoint = (
    x: number,
    y: number,
    fallbackRect?: Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left'>,
  ): { rowKey: string; colName: string } | null => {
    const directCell = getCellInfo(document.elementFromPoint(x, y) as HTMLElement | null);
    if (directCell || !fallbackRect) return directCell;

    const clampToInterior = (value: number, start: number, end: number) => {
      const inset = Math.min(1, Math.max(0, (end - start) / 2));
      return Math.min(end - inset, Math.max(start + inset, value));
    };
    const fallbackX = clampToInterior(x, fallbackRect.left, fallbackRect.right);
    const fallbackY = clampToInterior(y, fallbackRect.top, fallbackRect.bottom);
    if (fallbackX === x && fallbackY === y) return null;

    return getCellInfo(document.elementFromPoint(fallbackX, fallbackY) as HTMLElement | null);
  };

  const applySelectionUpdate = (cellInfo: { rowKey: string; colName: string }): boolean => {
    const start = selectionStartRef.current;
    if (!start) return false;

    const currentData = displayDataRef.current;
    const startRowIndex = currentData.findIndex((row) => rowKeyStr(row?.[GONAVI_ROW_KEY]) === start.rowKey);
    const endRowIndex = currentData.findIndex((row) => rowKeyStr(row?.[GONAVI_ROW_KEY]) === cellInfo.rowKey);
    if (startRowIndex === -1 || endRowIndex === -1) return false;

    const startColIndex = columnIndexMap.get(start.colName) ?? -1;
    const endColIndex = columnIndexMap.get(cellInfo.colName) ?? -1;
    if (startColIndex === -1 || endColIndex === -1) return false;

    const newSelectedCells = buildDataGridCellSelectionRectangle({
      startRowIndex,
      startColIndex,
      endRowIndex,
      endColIndex,
      rows: currentData,
      columnNames: displayColumnNames,
      rowKeyField: GONAVI_ROW_KEY,
      canSelectColumn: (columnName) => canSelectGridCellForClipboard({
        canModifyData,
        isDisplayedColumn: true,
        isWritableColumn: isWritableResultColumn(columnName, effectiveEditLocator),
      }),
    });
    if (newSelectedCells.size === 0) return false;

    currentSelectionRef.current = newSelectedCells;
    updateCellSelection(newSelectedCells);
    return true;
  };

  const scheduleSelectionUpdate = (cellInfo: { rowKey: string; colName: string }) => {
    if (cellSelectionRafRef.current !== null) {
      cancelAnimationFrame(cellSelectionRafRef.current);
    }

    cellSelectionRafRef.current = requestAnimationFrame(() => {
      cellSelectionRafRef.current = null;
      applySelectionUpdate(cellInfo);
    });
  };

  const stopAutoScroll = () => {
    if (cellSelectionAutoScrollRafRef.current !== null) {
      cancelAnimationFrame(cellSelectionAutoScrollRafRef.current);
      cellSelectionAutoScrollRafRef.current = null;
    }
  };

  const getScrollViewport = (): {
    viewport: CellSelectionAutoScrollViewport;
    tableBody: HTMLElement | null;
    controller: CellSelectionAutoScrollController | null;
  } | null => {
    const controller = cellSelectionAutoScrollControllerRef?.current || null;
    const controlledViewport = controller?.getViewport() || null;
    if (controlledViewport) {
      return { viewport: controlledViewport, tableBody: null, controller };
    }

    const tableBody = container.querySelector('.ant-table-body') as HTMLElement | null;
    if (!tableBody) return null;

    const rect = tableBody.getBoundingClientRect();
    return {
      viewport: {
        rect,
        scrollTop: Number.isFinite(tableBody.scrollTop) ? tableBody.scrollTop : 0,
        scrollLeft: Number.isFinite(tableBody.scrollLeft) ? tableBody.scrollLeft : 0,
        maxScrollTop: Math.max(0, tableBody.scrollHeight - tableBody.clientHeight),
        maxScrollLeft: Math.max(0, tableBody.scrollWidth - tableBody.clientWidth),
      },
      tableBody,
      controller: null,
    };
  };

  const autoScrollTick = () => {
    if (!isDraggingRef.current || !selectionStartRef.current) {
      stopAutoScroll();
      return;
    }

    const pointer = cellSelectionPointerRef.current;
    const scrollViewport = getScrollViewport();
    if (!pointer || !scrollViewport) {
      cellSelectionAutoScrollRafRef.current = requestAnimationFrame(autoScrollTick);
      return;
    }

    const { viewport, tableBody, controller } = scrollViewport;
    const { rect, scrollTop, scrollLeft, maxScrollTop, maxScrollLeft } = viewport;
    const rectHeight = typeof rect.height === 'number' && Number.isFinite(rect.height)
      ? rect.height
      : rect.bottom - rect.top;
    const rectWidth = typeof rect.width === 'number' && Number.isFinite(rect.width)
      ? rect.width
      : rect.right - rect.left;
    const verticalEdgeThreshold = Math.min(
      DATA_GRID_SELECTION_AUTO_SCROLL_EDGE_THRESHOLD_PX,
      Math.max(0, rectHeight / 2),
    );
    const horizontalEdgeThreshold = Math.min(
      DATA_GRID_SELECTION_AUTO_SCROLL_EDGE_THRESHOLD_PX,
      Math.max(0, rectWidth / 2),
    );
    let deltaY = 0;
    let deltaX = 0;

    if (pointer.y < rect.top + verticalEdgeThreshold) {
      const distance = rect.top + verticalEdgeThreshold - pointer.y;
      deltaY = -getDataGridSelectionAutoScrollStep(distance);
    } else if (pointer.y > rect.bottom - verticalEdgeThreshold) {
      const distance = pointer.y - (rect.bottom - verticalEdgeThreshold);
      deltaY = getDataGridSelectionAutoScrollStep(distance);
    }

    if (pointer.x < rect.left + horizontalEdgeThreshold) {
      const distance = rect.left + horizontalEdgeThreshold - pointer.x;
      deltaX = -getDataGridSelectionAutoScrollStep(distance);
    } else if (pointer.x > rect.right - horizontalEdgeThreshold) {
      const distance = pointer.x - (rect.right - horizontalEdgeThreshold);
      deltaX = getDataGridSelectionAutoScrollStep(distance);
    }

    let didScroll = false;
    const clampedDeltaY = clampDataGridSelectionAutoScrollDelta(deltaY, scrollTop, maxScrollTop);
    const clampedDeltaX = clampDataGridSelectionAutoScrollDelta(deltaX, scrollLeft, maxScrollLeft);
    if (controller) {
      if (clampedDeltaX !== 0 || clampedDeltaY !== 0) {
        didScroll = controller.scrollBy(clampedDeltaX, clampedDeltaY);
      }
    } else if (tableBody) {
      if (clampedDeltaY !== 0) {
        tableBody.scrollTop = scrollTop + clampedDeltaY;
        didScroll = true;
      }
      if (clampedDeltaX !== 0) {
        tableBody.scrollLeft = scrollLeft + clampedDeltaX;
        didScroll = true;
      }
    }

    if (didScroll) {
      const cellInfo = getCellInfoFromPoint(pointer.x, pointer.y, rect);
      if (cellInfo) scheduleSelectionUpdate(cellInfo);
    }

    cellSelectionAutoScrollRafRef.current = requestAnimationFrame(autoScrollTick);
  };

  const ensureAutoScroll = () => {
    if (cellSelectionAutoScrollRafRef.current !== null) return;
    cellSelectionAutoScrollRafRef.current = requestAnimationFrame(autoScrollTick);
  };

  const beginCellSelection = (cellInfo: { rowKey: string; colName: string }, x: number, y: number) => {
    markCellSelectionUserSelection(true);
    if (canModifyData && !cellEditModeRef.current) {
      cellEditModeRef.current = true;
      setCellEditMode(true);
    }
    suppressCellSelectionClickRef.current = true;
    document.getSelection?.()?.removeAllRanges();
    pendingCellSelectionStartRef.current = null;
    isDraggingRef.current = true;
    cellSelectionPointerRef.current = { x, y };

    const currentData = displayDataRef.current;
    const nextRowIndexMap = new Map<string, number>();
    currentData.forEach((r, idx) => {
      const k = r?.[GONAVI_ROW_KEY];
      if (k === undefined) return;
      nextRowIndexMap.set(String(k), idx);
    });
    rowIndexMapRef.current = nextRowIndexMap;

    const startRowIndex = nextRowIndexMap.get(cellInfo.rowKey) ?? -1;
    const startColIndex = columnIndexMap.get(cellInfo.colName) ?? -1;
    selectionStartRef.current = { rowKey: cellInfo.rowKey, colName: cellInfo.colName, rowIndex: startRowIndex, colIndex: startColIndex };
    cellSelectionAnchorSourceRef.current = 'user';
    currentSelectionRef.current = new Set([makeCellKey(cellInfo.rowKey, cellInfo.colName)]);
    updateCellSelection(currentSelectionRef.current);
    ensureAutoScroll();
  };

  const selectSingleCell = (cellInfo: { rowKey: string; colName: string }) => {
    const currentData = displayDataRef.current;
    const rowIndex = currentData.findIndex((row) => String(row?.[GONAVI_ROW_KEY]) === cellInfo.rowKey);
    const colIndex = columnIndexMap.get(cellInfo.colName) ?? -1;
    if (rowIndex === -1 || colIndex === -1) return;

    const nextSelection = new Set([makeCellKey(cellInfo.rowKey, cellInfo.colName)]);
    selectionStartRef.current = {
      rowKey: cellInfo.rowKey,
      colName: cellInfo.colName,
      rowIndex,
      colIndex,
    };
    cellSelectionAnchorSourceRef.current = 'user';
    currentSelectionRef.current = nextSelection;
    setSelectedCells(nextSelection);
    markCellSelectionDeleteEligible(false);
    markCellSelectionUserSelection(false);
    updateCellSelection(nextSelection);
  };
  return {
    isInteractiveTarget, getCellInfo, getCellInfoFromPoint, applySelectionUpdate,
    scheduleSelectionUpdate, stopAutoScroll, getScrollViewport, ensureAutoScroll,
    beginCellSelection, selectSingleCell,
  };
};
