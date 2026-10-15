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
  /** 空白选择列模式（Navicat 风格默认）：点击行首切换整行选中。 */
  selectionColumnBlank: boolean;
  /** 行选中状态（selectedRowKeys）引用与写入，空白选择列点击选行用。 */
  rowSelectionKeysRef: { current: Iterable<unknown> };
  setRowSelectionKeys: (keys: string[]) => void;
}

export const useDataGridGridGestures = ({
  containerRef, isActive, isTableSurfaceActive, selectionColumnBlank, displayDataRef, displayColumnNames,
  rowKeyStr, makeCellKey, canModifyData, cellEditModeRef, setCellEditMode,
  setSelectedCells, currentSelectionRef, selectionStartRef, pendingCellSelectionStartRef,
  updateCellSelection, markCellSelectionDeleteEligible, markCellSelectionUserSelection,
  rowSelectionKeysRef, setRowSelectionKeys,
}: UseDataGridGridGesturesInput) => {
  // 让常驻监听器读到最新列名，避免列集合变化时反复摘挂监听。
  const displayColumnNamesRef = useRef(displayColumnNames);
  useEffect(() => {
    displayColumnNamesRef.current = displayColumnNames;
  }, [displayColumnNames]);
  const selectionColumnBlankRef = useRef(selectionColumnBlank);
  useEffect(() => {
    selectionColumnBlankRef.current = selectionColumnBlank;
  }, [selectionColumnBlank]);

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

    // 空白选择列（Navicat 风格默认）：按下锚定整行选中态，不松手拖动即按
    // 区间渐进涂选/取消（paint 语义），松开提交。纯 DOM 事件 + 受控状态，
    // 无复选框（renderCell 已置空），不存在与 antd 勾选态的竞争。
    let dragAnchorRowKey: string | null = null;
    // 拖选收尾的 click 可能落在容器外（此时标记未被消费），
    // 用「容器内下一次普通按下」兜底复位，避免误吞后续点击。
    const rowDragJustEndedRef = { current: false };
    let dragPaintState = false;
    let dragOrderedRowKeys: readonly string[] = [];
    let dragLastRowKey: string | null = null;
    let dragRafId: number | null = null;

    const applyPaint = (currentRowKey: string) => {
      if (!dragAnchorRowKey) return;
      const anchorIndex = dragOrderedRowKeys.indexOf(dragAnchorRowKey);
      const currentIndex = dragOrderedRowKeys.indexOf(currentRowKey);
      if (anchorIndex === -1 || currentIndex === -1) return;
      const [startIndex, endIndex] = anchorIndex <= currentIndex
        ? [anchorIndex, currentIndex]
        : [currentIndex, anchorIndex];
      const selected = new Set<string>();
      for (const key of rowSelectionKeysRef.current) selected.add(String(key));
      for (let i = startIndex; i <= endIndex; i += 1) {
        const key = dragOrderedRowKeys[i];
        if (dragPaintState) selected.add(key);
        else selected.delete(key);
      }
      // 输出保持行的显示顺序，勾选态与视觉行序一致。
      setRowSelectionKeys(dragOrderedRowKeys.filter((key) => selected.has(key)));
    };

    const endRowDrag = () => {
      if (dragRafId !== null) {
        cancelAnimationFrame(dragRafId);
        dragRafId = null;
      }
      dragAnchorRowKey = null;
      dragLastRowKey = null;
      document.body.classList.remove('gn-datagrid-row-select-dragging');
    };

    const resolveSelectionRowKey = (target: EventTarget | null): string | null => {
      if (!(target instanceof HTMLElement)) return null;
      // 虚拟网格（BodyGrid）下行与单元格都是 div：选择列带
      // .ant-table-selection-column，行键挂在 .ant-table-row 上。
      const cell = target.closest('.ant-table-selection-column');
      if (!(cell instanceof HTMLElement) || !container.contains(cell)) return null;
      const rowEl = cell.closest('.ant-table-row');
      if (!(rowEl instanceof HTMLElement)) return null; // 表头等非行元素不参与
      return rowEl.getAttribute('data-row-key');
    };

    const handleContainerMouseDownCapture = (event: MouseEvent) => {
      if (!rowDragJustEndedRef.current) return;
      if (resolveSelectionRowKey(event.target)) return;
      rowDragJustEndedRef.current = false;
    };

    const handleSelectionColumnMouseDown = (event: MouseEvent) => {
      if (!selectionColumnBlankRef.current || event.button !== 0) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      const rowKey = resolveSelectionRowKey(event.target);
      if (!rowKey) return;
      const rows = displayDataRef.current ?? [];
      const orderedRowKeys: string[] = [];
      for (const row of rows) {
        const rawKey = row?.[GONAVI_ROW_KEY];
        if (rawKey === undefined || rawKey === null) continue;
        orderedRowKeys.push(rowKeyStr(rawKey));
      }
      if (!orderedRowKeys.includes(rowKey)) return;
      // capture 阶段接管：阻断单元格选区与文本拖选。
      event.stopPropagation();
      event.preventDefault();
      dragAnchorRowKey = rowKey;
      dragOrderedRowKeys = orderedRowKeys;
      dragLastRowKey = rowKey;
      dragPaintState = !Array.from(rowSelectionKeysRef.current)
        .some((key) => String(key) === rowKey);
      // 松手后的收尾 click 由此标记吞掉（见 handleContainerClickCapture）。
      rowDragJustEndedRef.current = true;
      document.body.classList.add('gn-datagrid-row-select-dragging');
      applyPaint(rowKey);
    };

    const handleDocumentMouseMove = (event: MouseEvent) => {
      if (!dragAnchorRowKey) return;
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const rowEl = target instanceof HTMLElement ? target.closest('.ant-table-row[data-row-key]') : null;
      const rowKey = rowEl instanceof HTMLElement ? rowEl.getAttribute('data-row-key') : null;
      if (!rowKey || rowKey === dragLastRowKey) return;
      if (!dragOrderedRowKeys.includes(rowKey)) return;
      dragLastRowKey = rowKey;
      if (dragRafId !== null) cancelAnimationFrame(dragRafId);
      dragRafId = requestAnimationFrame(() => {
        dragRafId = null;
        applyPaint(rowKey);
      });
    };

    const handleDocumentMouseUp = () => {
      if (dragAnchorRowKey) endRowDrag();
    };

    // 点击捕获：a) 吞掉拖选收尾的 click（避免覆盖刚涂选的行）；
    // b) 点击行首选择列与行号列之外的任何区域时清空行选中（Navicat 习惯：
    //    点别处 = 取消已选行）。行号列有自己的整行切换逻辑，保持不动。
    const handleContainerClickCapture = (event: MouseEvent) => {
      if (rowDragJustEndedRef.current) {
        rowDragJustEndedRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      let hasSelection = false;
      for (const key of rowSelectionKeysRef.current) {
        if (String(key).length > 0) { hasSelection = true; break; }
      }
      if (!hasSelection) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target || !container.contains(target)) return;
      if (target.closest('.data-grid-row-number-cell')) return;
      if (target.closest('.ant-table-selection-column')) return;
      setRowSelectionKeys([]);
    };

    container.addEventListener('mousedown', handleContainerMouseDownCapture, true);
    container.addEventListener('mousedown', handleSelectionColumnMouseDown, true);
    container.addEventListener('click', handleContainerClickCapture, true);
    document.addEventListener('mousemove', handleDocumentMouseMove);
    document.addEventListener('mouseup', handleDocumentMouseUp);
    window.addEventListener('keydown', handleWindowKeyDown, true);
    return () => {
      container.removeEventListener('mousedown', handleContainerMouseDownCapture, true);
      container.removeEventListener('mousedown', handleSelectionColumnMouseDown, true);
      container.removeEventListener('click', handleContainerClickCapture, true);
      document.removeEventListener('mousemove', handleDocumentMouseMove);
      document.removeEventListener('mouseup', handleDocumentMouseUp);
      endRowDrag();
      window.removeEventListener('keydown', handleWindowKeyDown, true);
    };
  }, [
    canModifyData, cellEditModeRef, containerRef, currentSelectionRef, displayColumnNames,
    displayDataRef, isActive, isTableSurfaceActive, makeCellKey, markCellSelectionDeleteEligible,
    markCellSelectionUserSelection, pendingCellSelectionStartRef, rowKeyStr, rowSelectionKeysRef,
    selectionColumnBlank, selectionStartRef, setCellEditMode, setSelectedCells, setRowSelectionKeys,
    updateCellSelection, displayDataRef, GONAVI_ROW_KEY,
  ]);
};

export default useDataGridGridGestures;
