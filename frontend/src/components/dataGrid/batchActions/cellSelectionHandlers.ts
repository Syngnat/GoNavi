import { message } from 'antd';
import { canSelectGridCellForClipboard } from '../../dataGridSelectionCopy';
import {
  parseDataGridClipboardData, buildDataGridClipboardPasteRows,
} from '../../dataGridClipboardPaste';
import {
  DATA_GRID_PASTE_OVERFLOW_MESSAGE_KEY, DATA_GRID_PASTE_SKIP_MESSAGE_KEYS,
  countDataGridPasteOverflow, resolveDataGridPasteGateReason, resolveDataGridPasteMatrixReason,
  traceDataGridPaste, type DataGridPasteSkipReason,
} from '../../dataGridClipboardPasteFeedback';
import type {
  CellSelectionAutoScrollViewport, CellSelectionAutoScrollController, DataGridBatchActionsContext,
} from '../../useDataGridBatchActions';

export interface CreateCellSelectionHandlersInput {
  isInteractiveTarget: (target: HTMLElement | null) => boolean;
  selectSingleCell: (cellInfo: { rowKey: string; colName: string; }) => void;
  container: HTMLDivElement;
  getCellInfo: (target: HTMLElement | null) => { rowKey: string; colName: string; } | null;
  applySelectionUpdate: (cellInfo: { rowKey: string; colName: string; }) => boolean;
  beginCellSelection: (cellInfo: { rowKey: string; colName: string; }, x: number, y: number) => void;
  ensureAutoScroll: () => void;
  getScrollViewport: () => { viewport: CellSelectionAutoScrollViewport; tableBody: HTMLElement | null; controller: CellSelectionAutoScrollController | null; } | null;
  getCellInfoFromPoint: (x: number, y: number, fallbackRect?: Pick<DOMRect, "top" | "right" | "bottom" | "left">) => { rowKey: string; colName: string; } | null;
  scheduleSelectionUpdate: (cellInfo: { rowKey: string; colName: string; }) => void;
  stopAutoScroll: () => void;
  ctx: DataGridBatchActionsContext;
}

export const createCellSelectionHandlers = ({
  isInteractiveTarget, selectSingleCell, container, getCellInfo, applySelectionUpdate,
  beginCellSelection, ensureAutoScroll, getScrollViewport, getCellInfoFromPoint,
  scheduleSelectionUpdate, stopAutoScroll, ctx,
}: CreateCellSelectionHandlersInput) => {
  const {
    currentSelectionRef, selectedCells, selectionStartRef, displayDataRef, rowKeyStr,
    GONAVI_ROW_KEY, columnIndexMap, displayColumnNames, canModifyData, isWritableResultColumn,
    effectiveEditLocator, cellSelectionAnchorSourceRef, pendingCellSelectionStartRef,
    suppressCellSelectionClickRef, cellEditModeRef, setCellEditMode, setSelectedCells,
    markCellSelectionDeleteEligible, markCellSelectionUserSelection, isDraggingRef,
    CELL_SELECTION_DRAG_THRESHOLD_PX, cellSelectionPointerRef, cellSelectionRafRef,
    cancelAnimationFrame, cellSelectionScrollRafRef, requestAnimationFrame, updateCellSelection,
    splitCellKey, addedRows, modifiedRows, deletedRowKeys, isCellValueEqualForDiff,
    translateDataGrid, setAddedRows, setModifiedRows, setModifiedColumns,
  } = ctx;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;

    const activeElement = document.activeElement as HTMLElement | null;
    const eventTarget = event.target instanceof HTMLElement ? event.target : null;
    if (isInteractiveTarget(activeElement) || isInteractiveTarget(eventTarget)) return;

    const activeSelection = currentSelectionRef.current.size > 0
      ? currentSelectionRef.current
      : selectedCells;
    const start = selectionStartRef.current;
    if (!start || activeSelection.size !== 1) return;

    const currentData = displayDataRef.current;
    const currentRowIndex = currentData.findIndex((row) => (
      rowKeyStr(row?.[GONAVI_ROW_KEY]) === start.rowKey
    ));
    const currentColumnIndex = columnIndexMap.get(start.colName) ?? -1;
    if (currentRowIndex === -1 || currentColumnIndex === -1) return;

    let nextRowIndex = currentRowIndex;
    let nextColumnIndex = currentColumnIndex;
    if (event.key === 'ArrowUp') nextRowIndex -= 1;
    if (event.key === 'ArrowDown') nextRowIndex += 1;
    if (event.key === 'ArrowLeft') nextColumnIndex -= 1;
    if (event.key === 'ArrowRight') nextColumnIndex += 1;

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const columnStep = event.key === 'ArrowLeft' ? -1 : 1;
      while (nextColumnIndex >= 0 && nextColumnIndex < displayColumnNames.length) {
        const candidateColumn = displayColumnNames[nextColumnIndex];
        if (canSelectGridCellForClipboard({
          canModifyData,
          isDisplayedColumn: true,
          isWritableColumn: isWritableResultColumn(candidateColumn, effectiveEditLocator),
        })) break;
        nextColumnIndex += columnStep;
      }
    }

    if (
      nextRowIndex < 0
      || nextRowIndex >= currentData.length
      || nextColumnIndex < 0
      || nextColumnIndex >= displayColumnNames.length
    ) {
      event.preventDefault();
      return;
    }

    const nextRow = currentData[nextRowIndex];
    const nextRowKey = nextRow?.[GONAVI_ROW_KEY];
    const nextColumnName = displayColumnNames[nextColumnIndex];
    if (nextRowKey === undefined || nextRowKey === null || !nextColumnName) return;

    event.preventDefault();
    const nextCellInfo = { rowKey: rowKeyStr(nextRowKey), colName: nextColumnName };
    selectSingleCell(nextCellInfo);

    const visibleCell = Array.from(
      container.querySelectorAll<HTMLElement>('.ant-table-cell[data-row-key][data-col-name]'),
    ).find((cell) => (
      cell.getAttribute('data-row-key') === nextCellInfo.rowKey
      && cell.getAttribute('data-col-name') === nextCellInfo.colName
    ));
    visibleCell?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (isInteractiveTarget(target)) return;
    const cellInfo = getCellInfo(target);
    if (!cellInfo) return;

    if (e.shiftKey && cellSelectionAnchorSourceRef.current === 'user' && selectionStartRef.current && applySelectionUpdate(cellInfo)) {
      e.preventDefault();
      pendingCellSelectionStartRef.current = null;
      suppressCellSelectionClickRef.current = true;
      if (canModifyData && !cellEditModeRef.current) {
        cellEditModeRef.current = true;
        setCellEditMode(true);
      }
      setSelectedCells(new Set(currentSelectionRef.current));
      markCellSelectionDeleteEligible(canModifyData);
      markCellSelectionUserSelection(true);
      return;
    }

    if (cellEditModeRef.current) {
      e.preventDefault();
      beginCellSelection(cellInfo, e.clientX, e.clientY);
      return;
    }

    pendingCellSelectionStartRef.current = { ...cellInfo, x: e.clientX, y: e.clientY };
  };

  const onMouseMove = (e: MouseEvent) => {
    const pendingStart = pendingCellSelectionStartRef.current;
    if (!isDraggingRef.current && pendingStart) {
      const dx = e.clientX - pendingStart.x;
      const dy = e.clientY - pendingStart.y;
      if (Math.hypot(dx, dy) < CELL_SELECTION_DRAG_THRESHOLD_PX) return;

      e.preventDefault();
      beginCellSelection(
        { rowKey: pendingStart.rowKey, colName: pendingStart.colName },
        e.clientX,
        e.clientY,
      );
    }

    if (!isDraggingRef.current || !selectionStartRef.current) return;
    e.preventDefault();
    cellSelectionPointerRef.current = { x: e.clientX, y: e.clientY };
    ensureAutoScroll();

    const target = e.target instanceof HTMLElement ? e.target : null;
    const scrollViewport = getScrollViewport();
    const cellInfo = getCellInfo(target) || getCellInfoFromPoint(
      e.clientX,
      e.clientY,
      scrollViewport?.viewport.rect,
    );
    if (!cellInfo) return;
    scheduleSelectionUpdate(cellInfo);
  };

  const onMouseUp = (e: MouseEvent) => {
    const pendingStart = pendingCellSelectionStartRef.current;
    pendingCellSelectionStartRef.current = null;
    if (!isDraggingRef.current) {
      if (pendingStart) {
        selectSingleCell(pendingStart);
      }
      return;
    }
    isDraggingRef.current = false;
    cellSelectionPointerRef.current = null;
    stopAutoScroll();

    if (cellSelectionRafRef.current !== null) {
      cancelAnimationFrame(cellSelectionRafRef.current);
      cellSelectionRafRef.current = null;
    }

    const target = e.target instanceof HTMLElement ? e.target : null;
    const scrollViewport = getScrollViewport();
    const cellInfo = getCellInfo(target) || getCellInfoFromPoint(
      e.clientX,
      e.clientY,
      scrollViewport?.viewport.rect,
    );
    if (cellInfo) applySelectionUpdate(cellInfo);

    if (currentSelectionRef.current.size > 0) {
      setSelectedCells(new Set(currentSelectionRef.current));
      markCellSelectionDeleteEligible(canModifyData);
      markCellSelectionUserSelection(true);
    }
  };

  const onClickCapture = (e: MouseEvent) => {
    if (!suppressCellSelectionClickRef.current) return;
    suppressCellSelectionClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  const onScroll = () => {
    if (currentSelectionRef.current.size === 0) return;
    if (cellSelectionScrollRafRef.current !== null) {
      cancelAnimationFrame(cellSelectionScrollRafRef.current);
    }
    cellSelectionScrollRafRef.current = requestAnimationFrame(() => {
      cellSelectionScrollRafRef.current = null;
      updateCellSelection(currentSelectionRef.current);
    });
  };

  const reportPasteSkipped = (
    reason: DataGridPasteSkipReason,
    e: ClipboardEvent,
    activeElement: HTMLElement | null,
  ) => {
    traceDataGridPaste(`skipped: ${reason}`, {
      clipboardTypes: e.clipboardData?.types,
      activeElement,
      canModifyData,
      cellEditMode: cellEditModeRef.current,
      hasAnchor: !!selectionStartRef.current,
    });
    void message.info(translateDataGrid(DATA_GRID_PASTE_SKIP_MESSAGE_KEYS[reason]));
  };

  const onPaste = (e: ClipboardEvent) => {
    const start = selectionStartRef.current;
    const activeElement = document.activeElement as HTMLElement | null;
    const eventTarget = e.target instanceof HTMLElement ? e.target : null;
    const nativePasteGuard = 'input, textarea, select, [contenteditable="true"], .ant-modal, .ant-dropdown, .ant-select-dropdown, .ant-picker-dropdown, .ant-popover';
    if (activeElement?.closest(nativePasteGuard) || eventTarget?.closest(nativePasteGuard)) {
      if (start) {
        traceDataGridPaste('skipped: focus is in a native editable target', {
          clipboardTypes: e.clipboardData?.types,
          activeElement,
        });
      }
      return;
    }

    const gateReason = resolveDataGridPasteGateReason({
      canModifyData,
      hasAnchor: !!start,
      cellEditMode: cellEditModeRef.current,
    });
    if (gateReason === 'ignore') return;
    if (gateReason !== null || !start) {
      reportPasteSkipped(gateReason ?? 'no-anchor', e, activeElement);
      return;
    }

    const clipboardData = e.clipboardData;
    traceDataGridPaste('received', { clipboardTypes: clipboardData?.types, activeElement });
    const matrix = parseDataGridClipboardData(clipboardData);

    const currentRows = displayDataRef.current;
    const startRowIndex = currentRows.findIndex((row) => rowKeyStr(row?.[GONAVI_ROW_KEY]) === start.rowKey);
    const startColumnIndex = columnIndexMap.get(start.colName) ?? -1;
    const matrixReason = resolveDataGridPasteMatrixReason({
      matrix,
      anchorResolved: startRowIndex !== -1 && startColumnIndex !== -1,
    });
    if (matrixReason) {
      reportPasteSkipped(matrixReason, e, activeElement);
      return;
    }

    let targetCells: Array<{ rowIndex: number; columnIndex: number }> | undefined;
    if (matrix.length === 1 && matrix[0]?.length === 1 && currentSelectionRef.current.size > 1) {
      const rowIndexes = new Map<string, number>();
      currentRows.forEach((row, rowIndex) => {
        const key = row?.[GONAVI_ROW_KEY];
        if (key !== undefined && key !== null) rowIndexes.set(rowKeyStr(key), rowIndex);
      });
      const selectedTargets = Array.from(currentSelectionRef.current).flatMap((cellKey) => {
        const cell = splitCellKey(cellKey);
        if (!cell) return [];
        const rowIndex = rowIndexes.get(cell.rowKey);
        const columnIndex = columnIndexMap.get(cell.colName);
        return rowIndex === undefined || columnIndex === undefined ? [] : [{ rowIndex, columnIndex }];
      });
      if (selectedTargets.length > 1) targetCells = selectedTargets;
    }

    const addedRowKeys = new Set<string>();
    addedRows.forEach((row) => {
      const key = row?.[GONAVI_ROW_KEY];
      if (key !== undefined && key !== null) addedRowKeys.add(rowKeyStr(key));
    });
    const result = buildDataGridClipboardPasteRows({
      matrix,
      rows: currentRows,
      columnNames: displayColumnNames,
      startRowIndex,
      startColumnIndex,
      targetCells,
      rowKeyField: GONAVI_ROW_KEY,
      addedRowKeys,
      modifiedRows,
      deletedRowKeys,
      isWritableColumn: (columnName) => isWritableResultColumn(columnName, effectiveEditLocator),
      isValueEqual: isCellValueEqualForDiff,
    });

    e.preventDefault();
    if (result.updatedCellCount === 0) {
      void message.info(translateDataGrid('data_grid.message.selected_cells_no_update'));
      return;
    }

    const pasteRowsByKey = new Map(result.rows.map((row) => [row.rowKey, row]));
    setAddedRows((prev) => prev.map((row) => {
      const key = row?.[GONAVI_ROW_KEY];
      if (key === undefined || key === null) return row;
      const pasteRow = pasteRowsByKey.get(rowKeyStr(key));
      return pasteRow?.isAdded ? { ...row, ...pasteRow.values } : row;
    }));
    setModifiedRows((prev) => {
      const next = { ...prev };
      result.rows.forEach((row) => {
        if (row.isAdded) return;
        if (Object.keys(row.modifiedValues).length === 0) delete next[row.rowKey];
        else next[row.rowKey] = row.modifiedValues;
      });
      return next;
    });
    setModifiedColumns((prev) => {
      const next = { ...prev };
      result.rows.forEach((row) => {
        if (row.isAdded) return;
        if (row.modifiedColumnNames.length === 0) delete next[row.rowKey];
        else next[row.rowKey] = new Set(row.modifiedColumnNames);
      });
      return next;
    });

    void message.success(translateDataGrid('data_grid.message.pasted_columns_to_rows', {
      rows: result.rows.length,
      cells: result.updatedCellCount,
    }));

    // 单值填充选区不受边界约束；矩阵粘贴超出表格范围的行列没有落点，需要明确告知。
    const overflow = targetCells ? { rows: 0, columns: 0 } : countDataGridPasteOverflow({
      matrix,
      startRowIndex,
      startColumnIndex,
      rowCount: currentRows.length,
      columnCount: displayColumnNames.length,
    });
    if (overflow.rows > 0 || overflow.columns > 0) {
      void message.warning(translateDataGrid(DATA_GRID_PASTE_OVERFLOW_MESSAGE_KEY, overflow));
    }
  };
  return {
    onKeyDown, onMouseDown, onMouseMove, onMouseUp, onClickCapture, onScroll, onPaste,
  };
};
