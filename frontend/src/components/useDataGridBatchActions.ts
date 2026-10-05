import { useCallback, useEffect } from 'react';
import type React from 'react';
import { message } from 'antd';
import {
  collectDataGridFillTemplateTargetRowKeys,
  filterDataGridCellSelectionToVisibleRows,
} from './DataGridCore';
import type { Item } from './DataGridCore';
import { createCellSelectionHandlers } from './dataGrid/batchActions/cellSelectionHandlers';
import { createCellSelectionInteraction } from './dataGrid/batchActions/cellSelectionInteraction';

export type CellSelectionAutoScrollRect = Pick<
  DOMRect,
  'top' | 'right' | 'bottom' | 'left'
> & Partial<Pick<DOMRect, 'width' | 'height'>>;

export type CellSelectionAutoScrollViewport = {
  rect: CellSelectionAutoScrollRect;
  scrollTop: number;
  scrollLeft: number;
  maxScrollTop: number;
  maxScrollLeft: number;
};

export type CellSelectionAutoScrollController = {
  getViewport: () => CellSelectionAutoScrollViewport | null;
  scrollBy: (deltaX: number, deltaY: number) => boolean;
};

export type DataGridBatchActionsContext = Record<string, any> & {
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
  cellSelectionAnchorSourceRef: React.MutableRefObject<'user' | 'page-find' | null>;
  cellEditModeRef: React.MutableRefObject<boolean>;
  cellSelectionAutoScrollRafRef: React.MutableRefObject<number | null>;
  cellSelectionAutoScrollControllerRef?: React.MutableRefObject<CellSelectionAutoScrollController | null>;
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
    cellSelectionAutoScrollControllerRef,
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
    cellSelectionAnchorSourceRef,
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
    cellSelectionAnchorSourceRef.current = null;
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

    const {
      isInteractiveTarget, getCellInfo, getCellInfoFromPoint, applySelectionUpdate,
      scheduleSelectionUpdate, stopAutoScroll, getScrollViewport, ensureAutoScroll,
      beginCellSelection, selectSingleCell,
    } = createCellSelectionInteraction({ container, ctx });

    const {
      onKeyDown, onMouseDown, onMouseMove, onMouseUp, onClickCapture, onScroll, onPaste,
    } = createCellSelectionHandlers({
      isInteractiveTarget, selectSingleCell, container, getCellInfo, applySelectionUpdate,
      beginCellSelection, ensureAutoScroll, getScrollViewport, getCellInfoFromPoint,
      scheduleSelectionUpdate, stopAutoScroll, ctx,
    });

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
    cellSelectionAnchorSourceRef.current = 'user';
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
