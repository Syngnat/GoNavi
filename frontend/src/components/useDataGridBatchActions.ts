import { useCallback, useEffect } from 'react';
import type React from 'react';
import { message } from 'antd';
import {
  collectDataGridFillTemplateTargetRowKeys,
  filterDataGridCellSelectionToVisibleRows,
} from './DataGridCore';
import type { Item } from './DataGridCore';
import { buildDataGridClipboardPasteRows, parseDataGridClipboardData } from './dataGridClipboardPaste';
import { canSelectGridCellForClipboard } from './dataGridSelectionCopy';

type DataGridBatchActionsContext = Record<string, any> & {
  CELL_SELECTION_DRAG_THRESHOLD_PX: number;
  GONAVI_ROW_KEY: string;
  addedRows: any[];
  deletedRowKeys: Set<string>;
  modifiedRows: Record<string, any>;
  selectedCells: Set<string>;
  copiedCellPatch: { sourceRowKey: string; values: Record<string, any> } | null;
  canUseCellSelectionAsFillTemplateTargets: boolean;
  displayDataRef: React.MutableRefObject<any[]>;
  currentSelectionRef: React.MutableRefObject<Set<string>>;
  rowIndexMapRef: React.MutableRefObject<Map<string, number>>;
  selectedRowKeysRef: React.MutableRefObject<React.Key[]>;
  selectionStartRef: React.MutableRefObject<{
    rowKey: string;
    colName: string;
    rowIndex: number;
    colIndex: number;
  } | null>;
  cellEditModeRef: React.MutableRefObject<boolean>;
  cellSelectionAutoScrollRafRef: React.MutableRefObject<number | null>;
  cellSelectionPointerRef: React.MutableRefObject<{ x: number; y: number } | null>;
  cellSelectionRafRef: React.MutableRefObject<number | null>;
  cellSelectionScrollRafRef: React.MutableRefObject<number | null>;
  pendingCellSelectionStartRef: React.MutableRefObject<{
    rowKey: string;
    colName: string;
    x: number;
    y: number;
  } | null>;
  suppressCellSelectionClickRef: React.MutableRefObject<boolean>;
  isDraggingRef: React.MutableRefObject<boolean>;
  columnIndexMap: Map<string, number>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  setAddedRows: React.Dispatch<React.SetStateAction<any[]>>;
  setCellContextMenu: React.Dispatch<React.SetStateAction<any>>;
  setCellEditMode: React.Dispatch<React.SetStateAction<boolean>>;
  setCopiedCellPatch: React.Dispatch<
    React.SetStateAction<{ sourceRowKey: string; values: Record<string, any> } | null>
  >;
  setModifiedColumns: React.Dispatch<React.SetStateAction<Record<string, Set<string>>>>;
  setModifiedRows: React.Dispatch<React.SetStateAction<Record<string, any>>>;
  setSelectedCells: React.Dispatch<React.SetStateAction<Set<string>>>;
  markCellSelectionDeleteEligible: (eligible: boolean) => void;
  markCellSelectionUserSelection: (active: boolean) => void;
  rowKeyStr: (key: React.Key) => string;
  resetCellSelection: (clearState?: boolean) => void;
  makeCellKey: (rowKey: string, colName: string) => string;
  splitCellKey: (cellKey: string) => { rowKey: string; colName: string } | null;
  updateCellSelection: (cells: Set<string>) => void;
  isCellValueEqualForDiff: (left: any, right: any) => boolean;
  isWritableResultColumn: (columnName: string, editLocator: any) => boolean;
  translateDataGrid: (key: string, params?: any) => string;
};

export const useDataGridBatchActions = (ctx: DataGridBatchActionsContext) => {
  const {
    CELL_SELECTION_DRAG_THRESHOLD_PX,
    GONAVI_ROW_KEY,
    addedRows,
    batchEditSetNull,
    batchEditValue,
    canModifyData,
    cancelAnimationFrame,
    cellEditModeRef,
    cellSelectionAutoScrollRafRef,
    cellSelectionPointerRef,
    cellSelectionRafRef,
    cellSelectionScrollRafRef,
    closeBatchEditModal,
    columnIndexMap,
    containerRef,
    copiedCellPatch,
    canUseCellSelectionAsFillTemplateTargets,
    currentSelectionRef,
    deletedRowKeys,
    displayColumnNames,
    displayDataRef,
    effectiveEditLocator,
    isActive,
    isCellValueEqualForDiff,
    isDraggingRef,
    isTableSurfaceActive,
    isWritableResultColumn,
    makeCellKey,
    modifiedRows,
    pendingCellSelectionStartRef,
    requestAnimationFrame,
    resetCellSelection,
    rowIndexMapRef,
    rowKeyStr,
    selectedCells,
    selectedRowKeysRef,
    selectionStartRef,
    setAddedRows,
    setCellContextMenu,
    setCellEditMode,
    setCopiedCellPatch,
    setModifiedColumns,
    setModifiedRows,
    setSelectedCells,
    markCellSelectionDeleteEligible,
    markCellSelectionUserSelection,
    splitCellKey,
    suppressCellSelectionClickRef,
    translateDataGrid,
    updateCellSelection,
  } = ctx;

const handleBatchFillCells = useCallback(() => {
    if (!canModifyData) return;
    const cellsToFill = currentSelectionRef.current;
    if (cellsToFill.size === 0) {
      void message.info(translateDataGrid('data_grid.message.select_cells_to_fill'));
      return;
    }

    const fillValue = batchEditSetNull ? null : batchEditValue;

    const addedRowMap = new Map<string, any>();
    addedRows.forEach((r) => {
      const k = r?.[GONAVI_ROW_KEY];
      if (k === undefined) return;
      addedRowMap.set(rowKeyStr(k), r);
    });

    const baseRowMap = new Map<string, any>();
    displayDataRef.current.forEach((r) => {
      const k = r?.[GONAVI_ROW_KEY];
      if (k === undefined) return;
      baseRowMap.set(rowKeyStr(k), r);
    });

    const patchesByRow = new Map<string, Record<string, any>>();
    let updatedCount = 0;

    cellsToFill.forEach((cellKey) => {
      const parts = splitCellKey(cellKey);
      if (!parts) return;
      const { rowKey, colName } = parts;
      if (!isWritableResultColumn(colName, effectiveEditLocator)) return;

      const existing = modifiedRows[rowKey];
      const baseRow = baseRowMap.get(rowKey);
      let currentVal: any;

      const addedRow = addedRowMap.get(rowKey);
      if (addedRow) {
        currentVal = addedRow?.[colName];
      } else if (existing && Object.prototype.hasOwnProperty.call(existing as any, GONAVI_ROW_KEY)) {
        currentVal = (existing as any)?.[colName];
      } else if (existing && Object.prototype.hasOwnProperty.call(existing as any, colName)) {
        currentVal = (existing as any)?.[colName];
      } else {
        currentVal = baseRow?.[colName];
      }

      const isSame = isCellValueEqualForDiff(currentVal, fillValue);
      if (isSame) return;

      const patch = patchesByRow.get(rowKey) || {};
      patch[colName] = fillValue;
      patchesByRow.set(rowKey, patch);
      updatedCount++;
    });

    if (updatedCount === 0) {
      void message.info(translateDataGrid('data_grid.message.selected_cells_no_update'));
      return;
    }

    // 仅做一次状态提交，避免大量 setState 循环
    setAddedRows(prev => prev.map(r => {
      const k = r?.[GONAVI_ROW_KEY];
      if (k === undefined) return r;
      const patch = patchesByRow.get(rowKeyStr(k));
      if (!patch) return r;
      return { ...r, ...patch };
    }));

    setModifiedRows(prev => {
      let next: Record<string, any> | null = null;

      patchesByRow.forEach((patch, keyStr) => {
        if (addedRowMap.has(keyStr)) return;

        const existing = prev[keyStr];
        const merged = existing ? { ...(existing as any), ...patch } : patch;
        if (!next) next = { ...prev };
        next[keyStr] = merged;
      });

      return next || prev;
    });

    void message.success(translateDataGrid('data_grid.message.filled_cells', { count: updatedCount }));
    closeBatchEditModal();

    // 清除选中状态
    setSelectedCells(new Set());
    markCellSelectionDeleteEligible(false);
    markCellSelectionUserSelection(false);
    currentSelectionRef.current = new Set();
    selectionStartRef.current = null;
    isDraggingRef.current = false;
    cellSelectionPointerRef.current = null;
    if (cellSelectionAutoScrollRafRef.current !== null) {
      cancelAnimationFrame(cellSelectionAutoScrollRafRef.current);
      cellSelectionAutoScrollRafRef.current = null;
    }
    updateCellSelection(new Set());
  }, [batchEditValue, batchEditSetNull, addedRows, modifiedRows, rowKeyStr, updateCellSelection, closeBatchEditModal, markCellSelectionDeleteEligible, markCellSelectionUserSelection, translateDataGrid, canModifyData, effectiveEditLocator, isWritableResultColumn, splitCellKey]);

  // Apply NULL to the active cell selection in one state transaction per store.
  // The context-menu cell is only a fallback when there is no active selection
  // (or when the user right-clicks outside the existing selection).
  const handleSetNullForSelectedCells = useCallback((
    fallbackCell?: { rowKey: React.Key; colName: string },
  ) => {
    if (!canModifyData) return;

    const fallbackKey = fallbackCell?.colName
      ? makeCellKey(rowKeyStr(fallbackCell.rowKey), fallbackCell.colName)
      : null;
    // Page Find and ordinary focus clicks also populate selectedCells, but they
    // are not editable range selections. Only use the range for a batch NULL
    // operation when it belongs to the current editable data source.
    const selection = canUseCellSelectionAsFillTemplateTargets
      ? (currentSelectionRef.current.size > 0 ? currentSelectionRef.current : selectedCells)
      : new Set<string>();
    const visibleSelection = filterDataGridCellSelectionToVisibleRows({
      cellKeys: selection,
      rows: displayDataRef.current,
      rowKeyField: GONAVI_ROW_KEY,
    });
    const targetCells = visibleSelection.size > 0 && (!fallbackKey || visibleSelection.has(fallbackKey))
      ? visibleSelection
      : fallbackKey
        ? new Set([fallbackKey])
        : visibleSelection;

    if (
      fallbackCell
      && (!fallbackKey || !visibleSelection.has(fallbackKey))
      && !isWritableResultColumn(fallbackCell.colName, effectiveEditLocator)
    ) {
      void message.info(translateDataGrid('data_grid.message.current_field_not_editable'));
      setCellContextMenu((prev: any) => ({ ...prev, visible: false }));
      return;
    }

    if (targetCells.size === 0) {
      void message.info(translateDataGrid('data_grid.message.select_cells_to_fill'));
      setCellContextMenu((prev: any) => ({ ...prev, visible: false }));
      return;
    }

    const addedRowMap = new Map<string, any>();
    addedRows.forEach((row) => {
      const key = row?.[GONAVI_ROW_KEY];
      if (key === undefined || key === null) return;
      addedRowMap.set(rowKeyStr(key), row);
    });

    const baseRowMap = new Map<string, any>();
    displayDataRef.current.forEach((row) => {
      const key = row?.[GONAVI_ROW_KEY];
      if (key === undefined || key === null) return;
      baseRowMap.set(rowKeyStr(key), row);
    });

    const patchesByRow = new Map<string, Record<string, any>>();
    let updatedCount = 0;
    Array.from(targetCells).forEach((cellKey) => {
      const parts = splitCellKey(cellKey);
      if (!parts || !isWritableResultColumn(parts.colName, effectiveEditLocator)) return;
      const { rowKey, colName } = parts;
      if (deletedRowKeys.has(rowKey)) return;
      const addedRow = addedRowMap.get(rowKey);
      const baseRow = baseRowMap.get(rowKey);
      if (!addedRow && !baseRow) return;

      const existing = modifiedRows[rowKey];
      let currentValue: any;
      if (addedRow) {
        currentValue = addedRow[colName];
      } else if (existing && Object.prototype.hasOwnProperty.call(existing as any, GONAVI_ROW_KEY)) {
        currentValue = existing[colName];
      } else if (existing && Object.prototype.hasOwnProperty.call(existing as any, colName)) {
        currentValue = existing[colName];
      } else {
        currentValue = baseRow?.[colName];
      }

      if (isCellValueEqualForDiff(currentValue, null)) return;
      const patch = patchesByRow.get(rowKey) || {};
      patch[colName] = null;
      patchesByRow.set(rowKey, patch);
      updatedCount += 1;
    });

    if (updatedCount === 0) {
      void message.info(translateDataGrid('data_grid.message.selected_cells_no_update'));
      setCellContextMenu((prev: any) => ({ ...prev, visible: false }));
      return;
    }

    setAddedRows((prev) => prev.map((row) => {
      const key = row?.[GONAVI_ROW_KEY];
      if (key === undefined || key === null) return row;
      const patch = patchesByRow.get(rowKeyStr(key));
      return patch ? { ...row, ...patch } : row;
    }));

    setModifiedRows((prev) => {
      const next = { ...prev };
      patchesByRow.forEach((patch, keyStr) => {
        if (addedRowMap.has(keyStr)) return;

        // Read the latest state inside the functional updater. A virtual-cell
        // blur/save can be queued in the same React batch as this menu action;
        // using the closure snapshot here would discard that other column.
        const existing = prev[keyStr];
        const merged = existing ? { ...(existing as any), ...patch } : { ...patch };
        const baseRow = baseRowMap.get(keyStr);
        const hasRowKey = Object.prototype.hasOwnProperty.call(merged, GONAVI_ROW_KEY);
        const changedColumns = Object.keys(merged).filter((columnName) => (
          columnName !== GONAVI_ROW_KEY
          && isWritableResultColumn(columnName, effectiveEditLocator)
          && !isCellValueEqualForDiff(baseRow?.[columnName], merged?.[columnName])
        ));
        if (changedColumns.length === 0) {
          delete next[keyStr];
          return;
        }

        next[keyStr] = hasRowKey
          ? merged
          : Object.fromEntries(changedColumns.map((columnName) => [columnName, merged[columnName]]));
      });
      return next;
    });

    setModifiedColumns((prev) => {
      const next = { ...prev };
      patchesByRow.forEach((patch, keyStr) => {
        if (addedRowMap.has(keyStr)) return;

        // Preserve columns that may have been marked by a concurrent edit and
        // only adjust the cells this NULL action actually targets.
        const columns = new Set(next[keyStr] || []);
        const baseRow = baseRowMap.get(keyStr);
        Object.keys(patch).forEach((columnName) => {
          if (isCellValueEqualForDiff(baseRow?.[columnName], null)) columns.delete(columnName);
          else columns.add(columnName);
        });
        if (columns.size > 0) next[keyStr] = columns;
        else delete next[keyStr];
      });
      return next;
    });

    setCellContextMenu((prev: any) => ({ ...prev, visible: false }));
  }, [GONAVI_ROW_KEY, addedRows, canModifyData, canUseCellSelectionAsFillTemplateTargets, currentSelectionRef, deletedRowKeys, displayDataRef, effectiveEditLocator, isCellValueEqualForDiff, isWritableResultColumn, makeCellKey, modifiedRows, rowKeyStr, selectedCells, setAddedRows, setCellContextMenu, setModifiedColumns, setModifiedRows, splitCellKey, translateDataGrid]);

  // 事件委托：在容器级别处理单元格拖选。可编辑结果会自动进入编辑模式，
  // 只读/聚合查询结果仅保留选区与复制能力，不触发任何数据修改入口。
  useEffect(() => {
    const container = containerRef.current;
    if (!isActive || !isTableSurfaceActive) return;
    if (!container) return;
    const EDGE_THRESHOLD_PX = 28;
    const MIN_SCROLL_STEP = 8;
    const MAX_SCROLL_STEP = 24;

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

    const getCellInfoFromPoint = (x: number, y: number): { rowKey: string; colName: string } | null => {
      const target = document.elementFromPoint(x, y) as HTMLElement | null;
      return getCellInfo(target);
    };

    const applySelectionUpdate = (cellInfo: { rowKey: string; colName: string }) => {
      const start = selectionStartRef.current;
      if (!start) return;

      const currentData = displayDataRef.current;
      const rowIndexMap = rowIndexMapRef.current;
      const startRowIndex = start.rowIndex;
      const endRowIndex = rowIndexMap.get(cellInfo.rowKey) ?? -1;
      if (startRowIndex === -1 || endRowIndex === -1) return;

      const startColIndex = start.colIndex;
      const endColIndex = columnIndexMap.get(cellInfo.colName) ?? -1;
      if (startColIndex === -1 || endColIndex === -1) return;

      const minRowIndex = Math.min(startRowIndex, endRowIndex);
      const maxRowIndex = Math.max(startRowIndex, endRowIndex);
      const minColIndex = Math.min(startColIndex, endColIndex);
      const maxColIndex = Math.max(startColIndex, endColIndex);

      const newSelectedCells = new Set<string>();
      for (let i = minRowIndex; i <= maxRowIndex; i++) {
        const row = currentData[i];
        const rKey = String(row?.[GONAVI_ROW_KEY]);
        for (let j = minColIndex; j <= maxColIndex; j++) {
          const colName = displayColumnNames[j];
          if (!canSelectGridCellForClipboard({
            canModifyData,
            isDisplayedColumn: true,
            isWritableColumn: isWritableResultColumn(colName, effectiveEditLocator),
          })) continue;
          newSelectedCells.add(makeCellKey(rKey, colName));
        }
      }

      currentSelectionRef.current = newSelectedCells;
      updateCellSelection(newSelectedCells);
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

    const getScrollStep = (distanceToEdge: number): number => {
      const ratio = Math.min(1, Math.max(0, distanceToEdge / EDGE_THRESHOLD_PX));
      return Math.round(MIN_SCROLL_STEP + (MAX_SCROLL_STEP - MIN_SCROLL_STEP) * ratio);
    };

    const autoScrollTick = () => {
      if (!isDraggingRef.current || !selectionStartRef.current) {
        stopAutoScroll();
        return;
      }

      const pointer = cellSelectionPointerRef.current;
      const tableBody = container.querySelector('.ant-table-body') as HTMLElement | null;
      if (!pointer || !tableBody) {
        cellSelectionAutoScrollRafRef.current = requestAnimationFrame(autoScrollTick);
        return;
      }

      const rect = tableBody.getBoundingClientRect();
      const maxScrollTop = Math.max(0, tableBody.scrollHeight - tableBody.clientHeight);
      const maxScrollLeft = Math.max(0, tableBody.scrollWidth - tableBody.clientWidth);
      let deltaY = 0;
      let deltaX = 0;

      if (pointer.y < rect.top + EDGE_THRESHOLD_PX && tableBody.scrollTop > 0) {
        const distance = rect.top + EDGE_THRESHOLD_PX - pointer.y;
        deltaY = -getScrollStep(distance);
      } else if (pointer.y > rect.bottom - EDGE_THRESHOLD_PX && tableBody.scrollTop < maxScrollTop) {
        const distance = pointer.y - (rect.bottom - EDGE_THRESHOLD_PX);
        deltaY = getScrollStep(distance);
      }

      if (pointer.x < rect.left + EDGE_THRESHOLD_PX && tableBody.scrollLeft > 0) {
        const distance = rect.left + EDGE_THRESHOLD_PX - pointer.x;
        deltaX = -getScrollStep(distance);
      } else if (pointer.x > rect.right - EDGE_THRESHOLD_PX && tableBody.scrollLeft < maxScrollLeft) {
        const distance = pointer.x - (rect.right - EDGE_THRESHOLD_PX);
        deltaX = getScrollStep(distance);
      }

      let didScroll = false;
      if (deltaY !== 0) {
        const nextTop = Math.max(0, Math.min(maxScrollTop, tableBody.scrollTop + deltaY));
        if (nextTop !== tableBody.scrollTop) {
          tableBody.scrollTop = nextTop;
          didScroll = true;
        }
      }

      if (deltaX !== 0) {
        const nextLeft = Math.max(0, Math.min(maxScrollLeft, tableBody.scrollLeft + deltaX));
        if (nextLeft !== tableBody.scrollLeft) {
          tableBody.scrollLeft = nextLeft;
          didScroll = true;
        }
      }

      if (didScroll) {
        const cellInfo = getCellInfoFromPoint(pointer.x, pointer.y);
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
      currentSelectionRef.current = nextSelection;
      setSelectedCells(nextSelection);
      markCellSelectionDeleteEligible(false);
      markCellSelectionUserSelection(false);
      updateCellSelection(nextSelection);
    };

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
      const cellInfo = getCellInfo(target) || getCellInfoFromPoint(e.clientX, e.clientY);
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
      const cellInfo = getCellInfo(target) || getCellInfoFromPoint(e.clientX, e.clientY);
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

    const onPaste = (e: ClipboardEvent) => {
      if (!canModifyData || !selectionStartRef.current) return;
      const activeElement = document.activeElement as HTMLElement | null;
      const eventTarget = e.target instanceof HTMLElement ? e.target : null;
      const nativePasteGuard = 'input, textarea, select, [contenteditable="true"], .ant-modal, .ant-dropdown, .ant-select-dropdown, .ant-picker-dropdown, .ant-popover';
      if (activeElement?.closest(nativePasteGuard) || eventTarget?.closest(nativePasteGuard)) return;

      const clipboardData = e.clipboardData;
      const matrix = parseDataGridClipboardData(clipboardData);
      if (matrix.length === 0) return;

      const currentRows = displayDataRef.current;
      const start = selectionStartRef.current;
      const startRowIndex = currentRows.findIndex((row) => rowKeyStr(row?.[GONAVI_ROW_KEY]) === start.rowKey);
      const startColumnIndex = columnIndexMap.get(start.colName) ?? -1;
      if (startRowIndex === -1 || startColumnIndex === -1) return;

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
    };

    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('mousemove', onMouseMove);
    container.addEventListener('click', onClickCapture, true);
    container.addEventListener('scroll', onScroll, true);
    document.addEventListener('mouseup', onMouseUp);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('paste', onPaste);

    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      container.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('click', onClickCapture, true);
      container.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('paste', onPaste);
      if (cellSelectionRafRef.current !== null) {
        cancelAnimationFrame(cellSelectionRafRef.current);
        cellSelectionRafRef.current = null;
      }
      if (cellSelectionScrollRafRef.current !== null) {
        cancelAnimationFrame(cellSelectionScrollRafRef.current);
        cellSelectionScrollRafRef.current = null;
      }
      stopAutoScroll();
      pendingCellSelectionStartRef.current = null;
      cellSelectionPointerRef.current = null;
      isDraggingRef.current = false;
    };
  }, [addedRows, canModifyData, deletedRowKeys, isActive, isTableSurfaceActive, displayColumnNames, columnIndexMap, effectiveEditLocator, isCellValueEqualForDiff, isWritableResultColumn, markCellSelectionDeleteEligible, markCellSelectionUserSelection, modifiedRows, rowKeyStr, selectedCells, setAddedRows, setModifiedColumns, setModifiedRows, setSelectedCells, splitCellKey, translateDataGrid, updateCellSelection]);

  const handleCopySelectedColumnsFromRow = useCallback(() => {
    const activeSelection = currentSelectionRef.current.size > 0 ? currentSelectionRef.current : selectedCells;
    if (activeSelection.size === 0) {
      void message.info(translateDataGrid('data_grid.message.select_same_row_cells_to_copy'));
      return;
    }

    const parsed = Array.from(activeSelection)
      .map((cellKey) => splitCellKey(cellKey))
      .filter((item): item is { rowKey: string; colName: string } => !!item);
    if (parsed.length === 0) {
      void message.info(translateDataGrid('data_grid.message.no_copyable_cells'));
      return;
    }

    const sourceRowKeySet = new Set(parsed.map((item) => item.rowKey));
    if (sourceRowKeySet.size !== 1) {
      void message.info(translateDataGrid('data_grid.message.copy_columns_same_row_only'));
      return;
    }

    const sourceRowKey = parsed[0].rowKey;
    const selectedColumnNames = Array.from(new Set(parsed.map((item) => item.colName)));
    if (selectedColumnNames.length === 0) {
      void message.info(translateDataGrid('data_grid.message.no_copyable_columns'));
      return;
    }

    const sourceBaseRow = displayDataRef.current.find((row) => {
      const key = row?.[GONAVI_ROW_KEY];
      return key !== undefined && key !== null && rowKeyStr(key) === sourceRowKey;
    });
    const sourceAddedRow = addedRows.find((row) => {
      const key = row?.[GONAVI_ROW_KEY];
      return key !== undefined && key !== null && rowKeyStr(key) === sourceRowKey;
    });
    const sourceModified = modifiedRows[sourceRowKey];

    const values: Record<string, any> = {};
    selectedColumnNames.forEach((colName) => {
      if (sourceAddedRow) {
        values[colName] = sourceAddedRow[colName];
        return;
      }

      if (sourceModified && Object.prototype.hasOwnProperty.call(sourceModified as any, colName)) {
        values[colName] = (sourceModified as any)[colName];
        return;
      }

      values[colName] = sourceBaseRow?.[colName];
    });

    setCopiedCellPatch({ sourceRowKey, values });
    resetCellSelection();
    void message.success(translateDataGrid('data_grid.message.copied_columns', { count: selectedColumnNames.length }));
  }, [selectedCells, rowKeyStr, addedRows, modifiedRows, resetCellSelection, translateDataGrid]);

  const handlePasteCopiedColumnsToSelectedRows = useCallback((fallbackRowKey?: React.Key) => {
    if (!copiedCellPatch || Object.keys(copiedCellPatch.values).length === 0) {
      void message.info(translateDataGrid('data_grid.message.copy_columns_first'));
      return;
    }

    const writablePatchValues = Object.fromEntries(
      Object.entries(copiedCellPatch.values)
        .filter(([colName]) => isWritableResultColumn(colName, effectiveEditLocator))
    );
    if (Object.keys(writablePatchValues).length === 0) {
      void message.info(translateDataGrid('data_grid.message.no_pasteable_editable_fields'));
      return;
    }

    const targetKeySet = fallbackRowKey !== undefined && fallbackRowKey !== null
      ? new Set([rowKeyStr(fallbackRowKey)])
      : new Set(collectDataGridFillTemplateTargetRowKeys({
          selectedRowKeys: selectedRowKeysRef.current,
          selectedCellKeys: canUseCellSelectionAsFillTemplateTargets ? selectedCells : [],
          sourceRowKey: copiedCellPatch.sourceRowKey,
          rowKeyToString: rowKeyStr,
        }));
    if (targetKeySet.size === 0) {
      void message.info(translateDataGrid('data_grid.message.select_target_rows'));
      return;
    }

    targetKeySet.delete(copiedCellPatch.sourceRowKey);
    if (targetKeySet.size === 0) {
      void message.info(translateDataGrid('data_grid.message.target_rows_cannot_only_source'));
      return;
    }

    const addedRowMap = new Map<string, any>();
    addedRows.forEach((row) => {
      const key = row?.[GONAVI_ROW_KEY];
      if (key === undefined || key === null) return;
      addedRowMap.set(rowKeyStr(key), row);
    });

    const baseRowMap = new Map<string, any>();
    displayDataRef.current.forEach((row) => {
      const key = row?.[GONAVI_ROW_KEY];
      if (key === undefined || key === null) return;
      baseRowMap.set(rowKeyStr(key), row);
    });

    const patchesByRow = new Map<string, Record<string, any>>();
    let updatedCellCount = 0;

    targetKeySet.forEach((targetRowKey) => {
      const patch: Record<string, any> = {};
      const existing = modifiedRows[targetRowKey];
      const addedRow = addedRowMap.get(targetRowKey);
      const baseRow = baseRowMap.get(targetRowKey);

      Object.entries(writablePatchValues).forEach(([colName, nextValue]) => {
        let currentValue: any;

        if (addedRow) {
          currentValue = addedRow[colName];
        } else if (existing && Object.prototype.hasOwnProperty.call(existing as any, GONAVI_ROW_KEY)) {
          currentValue = (existing as any)[colName];
        } else if (existing && Object.prototype.hasOwnProperty.call(existing as any, colName)) {
          currentValue = (existing as any)[colName];
        } else {
          currentValue = baseRow?.[colName];
        }

        if (isCellValueEqualForDiff(currentValue, nextValue)) return;
        patch[colName] = nextValue;
        updatedCellCount++;
      });

      if (Object.keys(patch).length > 0) {
        patchesByRow.set(targetRowKey, patch);
      }
    });

    if (patchesByRow.size === 0 || updatedCellCount === 0) {
      void message.info(translateDataGrid('data_grid.message.target_rows_no_update'));
      return;
    }

    setAddedRows(prev => prev.map((row) => {
      const key = row?.[GONAVI_ROW_KEY];
      if (key === undefined || key === null) return row;
      const patch = patchesByRow.get(rowKeyStr(key));
      if (!patch) return row;
      return { ...row, ...patch };
    }));

    setModifiedRows(prev => {
      let next: Record<string, any> | null = null;

      patchesByRow.forEach((patch, keyStr) => {
        if (addedRowMap.has(keyStr)) return;
        const existing = prev[keyStr];
        const merged = existing ? { ...(existing as any), ...patch } : patch;
        if (!next) next = { ...prev };
        next[keyStr] = merged;
      });

      return next || prev;
    });

    void message.success(translateDataGrid('data_grid.message.pasted_columns_to_rows', { rows: patchesByRow.size, cells: updatedCellCount }));
    setCellContextMenu((prev: any) => ({ ...prev, visible: false }));
  }, [copiedCellPatch, addedRows, modifiedRows, rowKeyStr, selectedCells, canUseCellSelectionAsFillTemplateTargets, effectiveEditLocator, translateDataGrid]);

  const selectEditableColumnCells = useCallback((columnName: string) => {
    if (
      !cellEditModeRef.current
      || !canModifyData
      || !isWritableResultColumn(columnName, effectiveEditLocator)
    ) {
      return;
    }

    resetCellSelection(false);
    const currentRows = displayDataRef.current;
    const colIndex = columnIndexMap.get(columnName) ?? -1;
    const nextSelection = new Set<string>();
    let anchorRowIndex = -1;
    for (let rowIndex = 0; rowIndex < currentRows.length; rowIndex += 1) {
      const rowKey = currentRows[rowIndex]?.[GONAVI_ROW_KEY];
      if (rowKey === undefined || rowKey === null) continue;
      if (anchorRowIndex === -1) anchorRowIndex = rowIndex;
      nextSelection.add(makeCellKey(rowKeyStr(rowKey), columnName));
    }
    if (anchorRowIndex === -1) return;

    const anchorRowKey = currentRows[anchorRowIndex]?.[GONAVI_ROW_KEY];
    if (anchorRowKey === undefined || anchorRowKey === null) return;
    selectionStartRef.current = {
      rowKey: rowKeyStr(anchorRowKey),
      colName: columnName,
      rowIndex: anchorRowIndex,
      colIndex,
    };
    currentSelectionRef.current = nextSelection;
    setSelectedCells(nextSelection);
    markCellSelectionDeleteEligible(true);
    markCellSelectionUserSelection(true);
    updateCellSelection(nextSelection);
  }, [canModifyData, effectiveEditLocator, columnIndexMap, makeCellKey, markCellSelectionDeleteEligible, markCellSelectionUserSelection, resetCellSelection, rowKeyStr, updateCellSelection]);

  // 批量填充到选中行
  const handleBatchFillToSelected = useCallback((sourceRecord: Item, dataIndex: string) => {
    if (!isWritableResultColumn(dataIndex, effectiveEditLocator)) {
      void message.info(translateDataGrid('data_grid.message.current_field_not_editable'));
      return;
    }
    const sourceValue = sourceRecord[dataIndex];
    const selKeys = selectedRowKeysRef.current;

    if (selKeys.length === 0) {
      void message.info(translateDataGrid('data_grid.message.select_rows_to_fill'));
      return;
    }

    const sourceKey = sourceRecord?.[GONAVI_ROW_KEY];
    // 过滤掉源行本身
    const targetKeys = selKeys.filter(k => k !== sourceKey);

    if (targetKeys.length === 0) {
      void message.info(translateDataGrid('data_grid.message.no_other_rows_to_fill'));
      return;
    }

    // 批量更新
    const addedKeySet = new Set<string>();
    addedRows.forEach((r) => {
      const k = r?.[GONAVI_ROW_KEY];
      if (k === undefined) return;
      addedKeySet.add(rowKeyStr(k));
    });

    const targetKeyStrList = targetKeys.map(rowKeyStr);
    const targetKeyStrSet = new Set(targetKeyStrList);
    const updatedCount = targetKeyStrSet.size;

    setAddedRows(prev => prev.map(r => {
      const k = r?.[GONAVI_ROW_KEY];
      if (k === undefined) return r;
      const keyStr = rowKeyStr(k);
      if (!targetKeyStrSet.has(keyStr)) return r;
      return { ...r, [dataIndex]: sourceValue };
    }));

    setModifiedRows(prev => {
      let next: Record<string, any> | null = null;

      targetKeyStrSet.forEach((keyStr) => {
        if (addedKeySet.has(keyStr)) return;
        const existing = prev[keyStr];
        const patch = { [dataIndex]: sourceValue };
        const merged = existing ? { ...(existing as any), ...patch } : patch;
        if (!next) next = { ...prev };
        next[keyStr] = merged;
      });

      return next || prev;
    });

    void message.success(translateDataGrid('data_grid.message.filled_rows', { count: updatedCount }));
    setCellContextMenu((prev: any) => ({ ...prev, visible: false }));
  }, [addedRows, rowKeyStr, effectiveEditLocator, translateDataGrid]);

  return {
    handleBatchFillCells,
    handleSetNullForSelectedCells,
    handleCopySelectedColumnsFromRow,
    handlePasteCopiedColumnsToSelectedRows,
    handleBatchFillToSelected,
    selectEditableColumnCells,
  };
};
