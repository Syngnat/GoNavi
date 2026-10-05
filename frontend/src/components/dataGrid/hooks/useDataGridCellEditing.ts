import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { DragEndEvent } from '@dnd-kit/core';
import { useDataGridReloadReset } from '../../useDataGridReloadReset';
import { useDataGridBatchActions } from '../../useDataGridBatchActions';
import {
    CELL_SELECTION_DRAG_THRESHOLD_PX,
    GONAVI_ROW_KEY,
    isCellValueEqualForDiff,
    makeCellKey,
    splitCellKey,
    filterDataGridCellSelectionToVisibleRows,
    resolveDataGridCellSelectionAnchor,
    DATA_EDIT_AUTO_COMMIT_DELAY_OPTIONS,
    collectDataGridCellSelectionRowKeys,
    collectDataGridFillTemplateTargetRowKeys,
    type Item,
} from '../../DataGridCore';
import { isWritableResultColumn } from '../../../utils/rowLocator';
import { filterRowsByGridConditions } from '../../../utils/dataGridClientFilter';
import { resolveGridSortInfoFromTableSorter } from '../../../utils/dataGridSort';
import { useDataGridColumnResize } from '../../useDataGridColumnResize';
import type { DataGridCellEditorStateApi } from './useDataGridCellEditorState';
import type { DataGridColumnTitlesApi } from './useDataGridColumnTitles';
import type { DataGridTableMetricsApi } from './useDataGridTableMetrics';
import type { DataGridCoreStateApi } from './useDataGridCoreState';
import type { DataGridProps } from '../../DataGridCore';

export interface UseDataGridCellEditingInput {
    setSelectedCells: DataGridCellEditorStateApi['setSelectedCells'];
    markCellSelectionDeleteEligible: DataGridColumnTitlesApi['markCellSelectionDeleteEligible'];
    markCellSelectionUserSelection: DataGridColumnTitlesApi['markCellSelectionUserSelection'];
    currentSelectionRef: DataGridCellEditorStateApi['currentSelectionRef'];
    selectionStartRef: DataGridCellEditorStateApi['selectionStartRef'];
    cellSelectionAnchorSourceRef: DataGridCellEditorStateApi['cellSelectionAnchorSourceRef'];
    pendingCellSelectionStartRef: DataGridCellEditorStateApi['pendingCellSelectionStartRef'];
    isDraggingRef: DataGridCellEditorStateApi['isDraggingRef'];
    cellSelectionPointerRef: DataGridCellEditorStateApi['cellSelectionPointerRef'];
    cellSelectionRafRef: DataGridCellEditorStateApi['cellSelectionRafRef'];
    cellSelectionScrollRafRef: DataGridCellEditorStateApi['cellSelectionScrollRafRef'];
    cellSelectionAutoScrollRafRef: DataGridCellEditorStateApi['cellSelectionAutoScrollRafRef'];
    updateCellSelection: DataGridColumnTitlesApi['updateCellSelection'];
    setCellEditMode: DataGridCellEditorStateApi['setCellEditMode'];
    cellEditModeRef: DataGridCellEditorStateApi['cellEditModeRef'];
    closeBatchEditModal: DataGridCellEditorStateApi['closeBatchEditModal'];
    data: DataGridProps['data'];
    setSelectedRowKeys: DataGridCellEditorStateApi['setSelectedRowKeys'];
    deletedRowKeys: DataGridTableMetricsApi['deletedRowKeys'];
    setDeletedRowKeys: DataGridTableMetricsApi['setDeletedRowKeys'];
    closeCellEditModeRef: DataGridCellEditorStateApi['closeCellEditModeRef'];
    cellEditMode: DataGridCellEditorStateApi['cellEditMode'];
    cellSelectionDeleteEligible: DataGridCellEditorStateApi['cellSelectionDeleteEligible'];
    cellSelectionSourceDataRef: DataGridCellEditorStateApi['cellSelectionSourceDataRef'];
    isActive: Exclude<DataGridProps['isActive'], undefined>;
    addedRows: DataGridTableMetricsApi['addedRows'];
    setAddedRows: DataGridTableMetricsApi['setAddedRows'];
    batchEditSetNull: DataGridCellEditorStateApi['batchEditSetNull'];
    batchEditValue: DataGridCellEditorStateApi['batchEditValue'];
    canModifyData: DataGridCoreStateApi['canModifyData'];
    cellSelectionAutoScrollControllerRef: DataGridCellEditorStateApi['cellSelectionAutoScrollControllerRef'];
    columnIndexMap: DataGridColumnTitlesApi['columnIndexMap'];
    containerRef: DataGridCellEditorStateApi['containerRef'];
    copiedCellPatch: DataGridCellEditorStateApi['copiedCellPatch'];
    setCopiedCellPatch: DataGridCellEditorStateApi['setCopiedCellPatch'];
    displayColumnNames: DataGridCoreStateApi['displayColumnNames'];
    displayDataRef: DataGridColumnTitlesApi['displayDataRef'];
    effectiveEditLocator: DataGridCoreStateApi['effectiveEditLocator'];
    isTableSurfaceActive: DataGridColumnTitlesApi['isTableSurfaceActive'];
    modifiedRows: DataGridTableMetricsApi['modifiedRows'];
    setModifiedRows: DataGridTableMetricsApi['setModifiedRows'];
    rowIndexMapRef: DataGridCellEditorStateApi['rowIndexMapRef'];
    rowKeyStr: DataGridColumnTitlesApi['rowKeyStr'];
    selectedCells: DataGridCellEditorStateApi['selectedCells'];
    selectedRowKeysRef: DataGridColumnTitlesApi['selectedRowKeysRef'];
    setCellContextMenu: DataGridCellEditorStateApi['setCellContextMenu'];
    setModifiedColumns: DataGridTableMetricsApi['setModifiedColumns'];
    suppressCellSelectionClickRef: DataGridCellEditorStateApi['suppressCellSelectionClickRef'];
    translateDataGrid: DataGridCoreStateApi['translateDataGrid'];
    exportScope: Exclude<DataGridProps['exportScope'], undefined>;
    filterConditions: DataGridColumnTitlesApi['filterConditions'];
    rowsBeforeClientFilter: DataGridColumnTitlesApi['rowsBeforeClientFilter'];
    dataEditTransactionOptions: DataGridCoreStateApi['dataEditTransactionOptions'];
    cellSelectionUserSourceDataRef: DataGridCellEditorStateApi['cellSelectionUserSourceDataRef'];
    selectedRowKeys: DataGridCellEditorStateApi['selectedRowKeys'];
    onSort: DataGridProps['onSort'];
    setSortInfo: DataGridCellEditorStateApi['setSortInfo'];
    sortInfo: DataGridCellEditorStateApi['sortInfo'];
    columnMetaMap: DataGridTableMetricsApi['columnMetaMap'];
    columnMetaMapByLowerName: DataGridTableMetricsApi['columnMetaMapByLowerName'];
    columnWidths: DataGridCellEditorStateApi['columnWidths'];
    setColumnWidths: DataGridCellEditorStateApi['setColumnWidths'];
    dataTableDensity: DataGridCoreStateApi['dataTableDensity'];
    densityParams: DataGridCoreStateApi['densityParams'];
    showColumnComment: DataGridCoreStateApi['showColumnComment'];
    showColumnType: DataGridCoreStateApi['showColumnType'];
    reorderVisibleColumns: DataGridCoreStateApi['reorderVisibleColumns'];
    normalizeMongoEditedRow: DataGridCoreStateApi['normalizeMongoEditedRow'];
    baseData: DataGridColumnTitlesApi['baseData'];
    cellContextMenu: DataGridCellEditorStateApi['cellContextMenu'];
    modifiedColumns: DataGridTableMetricsApi['modifiedColumns'];
}

export const useDataGridCellEditing = ({
    setSelectedCells, markCellSelectionDeleteEligible, markCellSelectionUserSelection,
    currentSelectionRef, selectionStartRef, cellSelectionAnchorSourceRef,
    pendingCellSelectionStartRef, isDraggingRef, cellSelectionPointerRef, cellSelectionRafRef,
    cellSelectionScrollRafRef, cellSelectionAutoScrollRafRef, updateCellSelection, setCellEditMode,
    cellEditModeRef, closeBatchEditModal, data, setSelectedRowKeys, deletedRowKeys,
    setDeletedRowKeys, closeCellEditModeRef, cellEditMode, cellSelectionDeleteEligible,
    cellSelectionSourceDataRef, isActive, addedRows, setAddedRows, batchEditSetNull, batchEditValue,
    canModifyData, cellSelectionAutoScrollControllerRef, columnIndexMap, containerRef,
    copiedCellPatch, setCopiedCellPatch, displayColumnNames, displayDataRef, effectiveEditLocator,
    isTableSurfaceActive, modifiedRows, setModifiedRows, rowIndexMapRef, rowKeyStr, selectedCells,
    selectedRowKeysRef, setCellContextMenu, setModifiedColumns, suppressCellSelectionClickRef,
    translateDataGrid, exportScope, filterConditions, rowsBeforeClientFilter,
    dataEditTransactionOptions, cellSelectionUserSourceDataRef, selectedRowKeys, onSort,
    setSortInfo, sortInfo, columnMetaMap, columnMetaMapByLowerName, columnWidths, setColumnWidths,
    dataTableDensity, densityParams, showColumnComment, showColumnType, reorderVisibleColumns,
    normalizeMongoEditedRow, baseData, cellContextMenu, modifiedColumns,
}: UseDataGridCellEditingInput) => {
    const resetCellSelection = useCallback((clearState: boolean = true) => {
      if (clearState) {
        setSelectedCells(new Set());
      }
      markCellSelectionDeleteEligible(false);
      markCellSelectionUserSelection(false);
      currentSelectionRef.current = new Set();
      selectionStartRef.current = null;
      cellSelectionAnchorSourceRef.current = null;
      pendingCellSelectionStartRef.current = null;
      isDraggingRef.current = false;
      cellSelectionPointerRef.current = null;
      if (cellSelectionRafRef.current !== null) {
        cancelAnimationFrame(cellSelectionRafRef.current);
        cellSelectionRafRef.current = null;
      }
      if (cellSelectionScrollRafRef.current !== null) {
        cancelAnimationFrame(cellSelectionScrollRafRef.current);
        cellSelectionScrollRafRef.current = null;
      }
      if (cellSelectionAutoScrollRafRef.current !== null) {
        cancelAnimationFrame(cellSelectionAutoScrollRafRef.current);
        cellSelectionAutoScrollRafRef.current = null;
      }
      updateCellSelection(new Set());
    }, [markCellSelectionDeleteEligible, markCellSelectionUserSelection, updateCellSelection]);

    const closeCellEditMode = useCallback(() => {
      setCellEditMode(false);
      cellEditModeRef.current = false;
      closeBatchEditModal();
      resetCellSelection();
    }, [resetCellSelection]);

    // 重新查询/刷新时重置选中与挂起删除（含索引键错位防护），逻辑见 hook 文件
    const { selectionResetSourceDataRef } = useDataGridReloadReset({
      data,
      resetCellSelection,
      setSelectedRowKeys,
      deletedRowKeys,
      setDeletedRowKeys,
    });

    useEffect(() => {
      closeCellEditModeRef.current = closeCellEditMode;
    }, [closeCellEditMode]);

    const canUseCellSelectionAsFillTemplateTargets = cellEditMode
        && cellSelectionDeleteEligible
        && cellSelectionSourceDataRef.current === data;

    // 批量填充选中的单元格
      const {
      handleBatchFillCells,
      handleSetNullForSelectedCells,
      handleCopySelectedColumnsFromRow,
      handlePasteCopiedColumnsToSelectedRows,
      handleBatchFillToSelected,
      selectEditableColumnCells,
    } = useDataGridBatchActions({
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
      isCellValueEqualForDiff,
      isDraggingRef,
      isActive,
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
    });

    const displayData = useMemo(() => {
        // 查询结果页没有服务端 WHERE 回调时，用列头筛选条件在客户端过滤当前结果集
        if (exportScope === 'queryResult' && filterConditions.length > 0) {
            return filterRowsByGridConditions(rowsBeforeClientFilter, filterConditions);
        }
        return rowsBeforeClientFilter;
    }, [exportScope, filterConditions, rowsBeforeClientFilter]);

    useEffect(() => {
        displayDataRef.current = displayData;

        if (selectionResetSourceDataRef.current === data) {
            if (currentSelectionRef.current.size === 0 && selectedCells.size === 0) {
                selectionResetSourceDataRef.current = null;
            } else {
                return;
            }
        }

        const activeSelection = currentSelectionRef.current.size > 0
            ? currentSelectionRef.current
            : selectedCells;
        if (activeSelection.size === 0) return;

        const nextRowIndexMap = new Map<string, number>();
        displayData.forEach((row, index) => {
            const rowKey = row?.[GONAVI_ROW_KEY];
            if (rowKey === undefined || rowKey === null) return;
            nextRowIndexMap.set(String(rowKey), index);
        });
        rowIndexMapRef.current = nextRowIndexMap;

        const visibleSelection = filterDataGridCellSelectionToVisibleRows({
            cellKeys: activeSelection,
            rows: displayData,
        });

        const previousAnchor = selectionStartRef.current;
        const nextAnchor = resolveDataGridCellSelectionAnchor({
            cellKeys: visibleSelection,
            rows: displayData,
            columnNames: displayColumnNames,
            preferredAnchor: previousAnchor,
        });
        const anchorChanged = previousAnchor?.rowKey !== nextAnchor?.rowKey
            || previousAnchor?.colName !== nextAnchor?.colName
            || previousAnchor?.rowIndex !== nextAnchor?.rowIndex
            || previousAnchor?.colIndex !== nextAnchor?.colIndex;
        selectionStartRef.current = nextAnchor;

        if (visibleSelection.size === 0) {
            resetCellSelection();
            return;
        }

        if (visibleSelection.size === activeSelection.size) {
            if (anchorChanged) updateCellSelection(visibleSelection);
            return;
        }

        currentSelectionRef.current = visibleSelection;
        setSelectedCells(visibleSelection);
        updateCellSelection(visibleSelection);
    }, [GONAVI_ROW_KEY, currentSelectionRef, data, displayColumnNames, displayData, filterDataGridCellSelectionToVisibleRows, resetCellSelection, resolveDataGridCellSelectionAnchor, rowIndexMapRef, selectedCells, selectionStartRef, updateCellSelection]);

    const pendingChangeCount = addedRows.length + Object.keys(modifiedRows).length + deletedRowKeys.size;
    const hasChanges = pendingChangeCount > 0;
    const dataEditCommitMode = dataEditTransactionOptions?.commitMode === 'auto' ? 'auto' : 'manual';
    const dataEditAutoCommitDelayMs = DATA_EDIT_AUTO_COMMIT_DELAY_OPTIONS.some((item) => item.value === dataEditTransactionOptions?.autoCommitDelayMs)
        ? Number(dataEditTransactionOptions?.autoCommitDelayMs)
        : 5000;
    const [autoCommitRemainingSeconds, setAutoCommitRemainingSeconds] = useState<number | null>(null);
    const autoCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const autoCommitCountdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const autoCommitChangeTokenRef = useRef(0);
    const autoCommitFailedTokenRef = useRef(-1);
    const clearAutoCommitTimer = useCallback(() => {
        if (autoCommitTimerRef.current) {
            clearTimeout(autoCommitTimerRef.current);
            autoCommitTimerRef.current = null;
        }
        if (autoCommitCountdownRef.current) {
            clearInterval(autoCommitCountdownRef.current);
            autoCommitCountdownRef.current = null;
        }
        setAutoCommitRemainingSeconds(null);
    }, []);

    const visibleSelectedCells = useMemo(
        () => filterDataGridCellSelectionToVisibleRows({
            cellKeys: selectedCells,
            rows: displayData,
        }),
        [displayData, selectedCells],
    );
    const selectedCellCount = canUseCellSelectionAsFillTemplateTargets
        ? visibleSelectedCells.size
        : 0;
    const selectedCellRowCount = useMemo(
        () => collectDataGridCellSelectionRowKeys(visibleSelectedCells).length,
        [visibleSelectedCells],
    );
    // Cell selection represents rows independently from the table checkbox
    // selection. Use the same eligibility/source guard as other edit actions so
    // Page Find's focused cell does not appear as a data selection in the footer.
    const hasUserCellSelection = cellSelectionUserSourceDataRef.current === data;
    const selectedRowCount = hasUserCellSelection && visibleSelectedCells.size > 0
        ? selectedCellRowCount
        : selectedRowKeys.length;
    const fillTemplateTargetRowCount = useMemo(
        () => copiedCellPatch
            ? collectDataGridFillTemplateTargetRowKeys({
                selectedRowKeys,
                selectedCellKeys: canUseCellSelectionAsFillTemplateTargets ? selectedCells : [],
                sourceRowKey: copiedCellPatch.sourceRowKey,
                rowKeyToString: rowKeyStr,
            }).length
            : 0,
        [canUseCellSelectionAsFillTemplateTargets, copiedCellPatch, rowKeyStr, selectedCells, selectedRowKeys],
    );
    const selectedCellRowKeys = useMemo(
        () => cellEditMode
            && cellSelectionDeleteEligible
            && cellSelectionSourceDataRef.current === data
            ? collectDataGridCellSelectionRowKeys(selectedCells)
            : [],
        [cellEditMode, cellSelectionDeleteEligible, data, selectedCells],
    );
    const deleteTargetRowKeys = useMemo(
        () => selectedRowKeys.length > 0
            ? selectedRowKeys.map(key => rowKeyStr(key))
            : selectedCellRowKeys,
        [rowKeyStr, selectedCellRowKeys, selectedRowKeys],
    );
    const deleteTargetRowCount = deleteTargetRowKeys.length;
    const allSelectedAreDeleted = useMemo(() => {
        if (deleteTargetRowKeys.length === 0) return false;
        return deleteTargetRowKeys.every(key => deletedRowKeys.has(key));
    }, [deleteTargetRowKeys, deletedRowKeys]);

    const addedRowKeySet = useMemo(() => {
        const next = new Set<string>();
        addedRows.forEach((row) => {
            const key = row?.[GONAVI_ROW_KEY];
            if (key === undefined || key === null) return;
            next.add(rowKeyStr(key));
        });
        return next;
    }, [addedRows, rowKeyStr]);

    const modifiedRowKeySet = useMemo(() => new Set(Object.keys(modifiedRows)), [modifiedRows]);
    useEffect(() => {
        autoCommitChangeTokenRef.current += 1;
        autoCommitFailedTokenRef.current = -1;
    }, [addedRows, modifiedRows, deletedRowKeys]);

    const rowClassName = useCallback((record: Item) => {
        const k = record?.[GONAVI_ROW_KEY];
        if (k === undefined || k === null) return '';
        const keyStr = rowKeyStr(k);
        if (addedRowKeySet.has(keyStr)) return 'row-added';
        if (deletedRowKeys.has(keyStr)) return 'row-deleted';
        if (modifiedRowKeySet.has(keyStr)) return 'row-modified';
        return '';
    }, [addedRowKeySet, modifiedRowKeySet, deletedRowKeys, rowKeyStr]);

    const handleTableChange = useCallback((_pag: any, _filtersArg: any, sorter: any) => {
        if (isResizingRef.current) return; // Block sort if resizing
        const next = resolveGridSortInfoFromTableSorter({ sorter });
        setSortInfo(next);
        if (onSort) onSort(JSON.stringify(next), '');
    }, [onSort]);

    const applySortInfo = useCallback((next: Array<{ columnKey: string, order: string, enabled?: boolean }>) => {
        setSortInfo(next);
        if (onSort) onSort(JSON.stringify(next), '');
    }, [onSort]);

    const applyColumnSort = useCallback((columnName: string, order: 'ascend' | 'descend' | null) => {
        const normalizedName = String(columnName || '').trim();
        if (!normalizedName) return;
        const next = sortInfo.filter((item) => item.columnKey !== normalizedName);
        if (order) {
            next.push({ columnKey: normalizedName, order, enabled: true });
        }
        applySortInfo(next);
    }, [applySortInfo, sortInfo]);

    const {
        autoFitColumnWidth,
        handleResizeAutoFit,
        handleResizeStart,
        isResizingRef,
    } = useDataGridColumnResize({
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
    });

    const handleDragEnd = useCallback((event: DragEndEvent) => {
      // 防御性检查：若正在调整列宽，忽略拖拽排序事件
      if (isResizingRef.current) return;
      const { active, over } = event;
      if (active.id !== over?.id && over) {
        reorderVisibleColumns(String(active.id), String(over.id));
      }
    }, [reorderVisibleColumns]);

    const handleCellSave = useCallback((row: any) => {
        const rowKey = row?.[GONAVI_ROW_KEY];
        if (rowKey === undefined) return;
        const keyStr = rowKeyStr(rowKey);
        const isAdded = addedRows.some(r => r?.[GONAVI_ROW_KEY] === rowKey);
        if (isAdded) {
            const currentAddedRow = addedRows.find(r => r?.[GONAVI_ROW_KEY] === rowKey);
            const normalizedRow = normalizeMongoEditedRow(row, currentAddedRow);
            setAddedRows(prev => prev.map(r => r?.[GONAVI_ROW_KEY] === rowKey ? { ...r, ...normalizedRow } : r));
            return;
        }
        if (deletedRowKeys.has(keyStr)) return;
        // 查找原始行数据，对比是否真正有值变更
        const originalRow = baseData.find(r => r?.[GONAVI_ROW_KEY] === rowKey);
        if (originalRow) {
            const currentRow = modifiedRows[keyStr] ? { ...originalRow, ...modifiedRows[keyStr] } : originalRow;
            const normalizedRow = normalizeMongoEditedRow(row, currentRow);
            const changedFields: Record<string, any> = {};
            for (const col of Object.keys(normalizedRow)) {
                if (col === GONAVI_ROW_KEY) continue;
                if (!isWritableResultColumn(col, effectiveEditLocator)) continue;
                if (!isCellValueEqualForDiff(originalRow[col], normalizedRow[col])) {
                    changedFields[col] = normalizedRow[col];
                }
            }
            if (Object.keys(changedFields).length === 0) {
                // 没有实际变更，从 modifiedRows 中移除该行
                setModifiedRows(prev => {
                    if (!(keyStr in prev)) return prev;
                    const next = { ...prev };
                    delete next[keyStr];
                    return next;
                });
                // 同时清除该行的 modifiedColumns
                setModifiedColumns(prev => {
                    if (!(keyStr in prev)) return prev;
                    const next = { ...prev };
                    delete next[keyStr];
                    return next;
                });
                return;
            }
            // 更新 modifiedColumns：记录所有变更的列
            setModifiedColumns(prev => {
                const newCols = new Set(Object.keys(changedFields));
                // 如果和之前一样，避免不必要的 state 更新
                if (prev[keyStr] && prev[keyStr].size === newCols.size &&
                    [...newCols].every(c => prev[keyStr].has(c))) {
                    return prev;
                }
                return { ...prev, [keyStr]: newCols };
            });
            setModifiedRows(prev => ({ ...prev, [keyStr]: normalizedRow }));
        }
    }, [addedRows, baseData, rowKeyStr, deletedRowKeys, effectiveEditLocator, modifiedRows, normalizeMongoEditedRow]);
    const handleCellSaveRef = useRef(handleCellSave);
    handleCellSaveRef.current = handleCellSave;

    const handleCellSetNull = useCallback(() => {
      const record = cellContextMenu.record;
      const dataIndex = String(cellContextMenu.dataIndex || '').trim();
      const rowKey = record?.[GONAVI_ROW_KEY];
      if (!record || !dataIndex || rowKey === undefined || rowKey === null) return;

      // The original contextual action batches when the clicked cell belongs to
      // an active range, while retaining single-cell fallback outside that range.
      // The separately labelled action always batches the current selection.
      handleSetNullForSelectedCells({ rowKey, colName: dataIndex });
    }, [GONAVI_ROW_KEY, cellContextMenu.dataIndex, cellContextMenu.record, handleSetNullForSelectedCells]);

    const canUndoContextMenuCellChange = useMemo(() => {
      const record = cellContextMenu.record;
      const dataIndex = String(cellContextMenu.dataIndex || '').trim();
      const rowKey = record?.[GONAVI_ROW_KEY];
      if (!record || !dataIndex || rowKey === undefined || rowKey === null) return false;
      const keyStr = rowKeyStr(rowKey);
      if (addedRowKeySet.has(keyStr)) return false;
      return !!modifiedColumns[keyStr]?.has(dataIndex);
    }, [addedRowKeySet, cellContextMenu.dataIndex, cellContextMenu.record, modifiedColumns, rowKeyStr]);

    const canEditContextMenuCell = useMemo(() => {
      const record = cellContextMenu.record;
      const dataIndex = String(cellContextMenu.dataIndex ?? '');
      const rowKey = record?.[GONAVI_ROW_KEY];
      if (!canModifyData || !record || !dataIndex || rowKey === undefined || rowKey === null) return false;
      if (deletedRowKeys.has(rowKeyStr(rowKey))) return false;
      return isWritableResultColumn(dataIndex, effectiveEditLocator);
    }, [GONAVI_ROW_KEY, canModifyData, cellContextMenu.dataIndex, cellContextMenu.record, deletedRowKeys, effectiveEditLocator, rowKeyStr]);
    return {
        resetCellSelection, closeCellEditMode, handleBatchFillCells, handleSetNullForSelectedCells,
        handleCopySelectedColumnsFromRow, handlePasteCopiedColumnsToSelectedRows,
        handleBatchFillToSelected, selectEditableColumnCells, displayData, pendingChangeCount,
        hasChanges, dataEditCommitMode, dataEditAutoCommitDelayMs, autoCommitRemainingSeconds,
        setAutoCommitRemainingSeconds, autoCommitTimerRef, autoCommitCountdownRef,
        autoCommitChangeTokenRef, autoCommitFailedTokenRef, clearAutoCommitTimer, selectedCellCount,
        selectedCellRowCount, selectedRowCount, fillTemplateTargetRowCount, deleteTargetRowKeys,
        deleteTargetRowCount, allSelectedAreDeleted, addedRowKeySet, rowClassName,
        handleTableChange, applySortInfo, applyColumnSort, autoFitColumnWidth, handleResizeAutoFit,
        handleResizeStart, handleDragEnd, handleCellSave, handleCellSaveRef, handleCellSetNull,
        canUndoContextMenuCellChange, canEditContextMenuCell,
    };
};

export type DataGridCellEditingApi = ReturnType<typeof useDataGridCellEditing>;
