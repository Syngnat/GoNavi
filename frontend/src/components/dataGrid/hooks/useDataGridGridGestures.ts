import React, { useEffect, useRef } from 'react';
import {
  buildAllDataCellKeys,
  isGridSelectAllEventTarget,
  isSelectAllKeyCombo,
} from '../batchActions/gridGesturesInteraction';
import { GONAVI_ROW_KEY, type Item } from '../../DataGridCore';

// 网格手势挂载层（Navicat 式交互对齐）：
// Ctrl/Cmd+A 只全选数据单元格 —— 复用单元格选区管线
// （currentSelectionRef / updateCellSelection / cellEditMode），
// 滚动时的可视化重放由既有的容器 scroll capture 处理器负责。
// 判定与计算都在 gridGesturesInteraction（纯逻辑，可单测），本文件只挂监听。

export interface UseDataGridGridGesturesInput {
  containerRef: React.RefObject<HTMLDivElement | null>;
  isActive: boolean;
  isTableSurfaceActive: boolean;
  displayDataRef: { current: Item[] };
  displayColumnNames: readonly string[];
  rowKeyStr: (key: React.Key) => string;
  makeCellKey: (rowKey: string, colName: string) => string;
  canModifyData: boolean;
  cellEditModeRef: { current: boolean };
  setCellEditMode: (value: boolean) => void;
  setSelectedCells: (cells: Set<string>) => void;
  currentSelectionRef: { current: Set<string> };
  selectionStartRef: { current: { rowKey: string; colName: string } | null };
  pendingCellSelectionStartRef: { current: unknown };
  updateCellSelection: (cells: Set<string>) => void;
  markCellSelectionDeleteEligible: (eligible: boolean) => void;
  markCellSelectionUserSelection: (user: boolean) => void;
}

export const useDataGridGridGestures = ({
  containerRef, isActive, isTableSurfaceActive, displayDataRef, displayColumnNames,
  rowKeyStr, makeCellKey, canModifyData, cellEditModeRef, setCellEditMode,
  setSelectedCells, currentSelectionRef, selectionStartRef, pendingCellSelectionStartRef,
  updateCellSelection, markCellSelectionDeleteEligible, markCellSelectionUserSelection,
}: UseDataGridGridGesturesInput) => {
  // 让常驻监听器读到最新列名，避免列集合变化时反复摘挂监听。
  const displayColumnNamesRef = useRef(displayColumnNames);
  useEffect(() => {
    displayColumnNamesRef.current = displayColumnNames;
  }, [displayColumnNames]);

  useEffect(() => {
    const container = containerRef.current;
    if (!isActive || !isTableSurfaceActive || !container) return;

    const applySelectAll = () => {
      const rows = displayDataRef.current ?? [];
      const columnNames = displayColumnNamesRef.current;
      if (rows.length === 0 || columnNames.length === 0) return;
      const { cellKeys, anchor } = buildAllDataCellKeys({
        rows, rowKeyField: GONAVI_ROW_KEY, rowKeyStr, columnNames, makeCellKey,
      });
      if (!anchor) return;
      currentSelectionRef.current = cellKeys;
      selectionStartRef.current = anchor;
      pendingCellSelectionStartRef.current = null;
      // 与 shift+click 批选同路径：可编辑网格进入批量模式，删除/填充工具可用。
      if (canModifyData && !cellEditModeRef.current) {
        cellEditModeRef.current = true;
        setCellEditMode(true);
      }
      setSelectedCells(new Set(cellKeys));
      markCellSelectionDeleteEligible(canModifyData);
      markCellSelectionUserSelection(true);
      updateCellSelection(cellKeys);
    };

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (!isSelectAllKeyCombo(event)) return;
      if (!isGridSelectAllEventTarget(event.target, container)) return;
      event.preventDefault();
      event.stopPropagation();
      applySelectAll();
    };

    window.addEventListener('keydown', handleWindowKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown, true);
    };
  }, [
    canModifyData, cellEditModeRef, containerRef, currentSelectionRef, displayColumnNames,
    displayDataRef, isActive, isTableSurfaceActive, makeCellKey, markCellSelectionDeleteEligible,
    markCellSelectionUserSelection, pendingCellSelectionStartRef, rowKeyStr, selectionStartRef,
    setCellEditMode, setSelectedCells, updateCellSelection,
  ]);
};

export default useDataGridGridGestures;
