// 数据网格手势的纯逻辑层（Navicat 式交互对齐）：
// Ctrl/Cmd+A 只全选数据单元格（不碰输入框内的全选、不含行号/checkbox 列）。
//
// 本文件只做判定与计算（可单测），DOM 监听与 React 状态写入由
// useDataGridGridGestures 负责挂接。

import type { Key } from 'react';

export interface GridGestureCellAnchor {
  rowKey: string;
  colName: string;
}

export interface GridGestureRowLike {
  [key: string]: unknown;
}

/** 输入类控件内的 Cmd/Ctrl+A 必须保持原生行为（全选文本），不劫持。 */
const GRID_SELECT_ALL_INTERACTIVE_SELECTOR = 'input, textarea, [contenteditable="true"], .ant-picker, .ant-select, .ant-dropdown, .ant-modal';

export const isSelectAllKeyCombo = (event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean => (
  (event.key === 'a' || event.key === 'A')
  && (event.metaKey || event.ctrlKey)
);

/** 事件目标位于网格容器内、且不在输入类控件上时，才由网格接管全选。 */
export const isGridSelectAllEventTarget = (
  target: EventTarget | null,
  container: HTMLElement | null,
): boolean => {
  if (!container || !(target instanceof HTMLElement)) return false;
  if (!container.contains(target)) return false;
  return !target.closest(GRID_SELECT_ALL_INTERACTIVE_SELECTOR);
};

/**
 * 全选 = 显示数据行 × 数据列 的全部单元格 key。
 * 行号列 / checkbox 列不在 columnNames 里，天然不会被选中（「只选择数据」）。
 */
export const buildAllDataCellKeys = ({
  rows,
  rowKeyField,
  rowKeyStr,
  columnNames,
  makeCellKey,
}: {
  rows: GridGestureRowLike[];
  rowKeyField: string;
  rowKeyStr: (key: Key) => string;
  columnNames: readonly string[];
  makeCellKey: (rowKey: string, colName: string) => string;
}): { cellKeys: Set<string>; anchor: GridGestureCellAnchor | null } => {
  const cellKeys = new Set<string>();
  let anchor: GridGestureCellAnchor | null = null;
  for (const row of rows) {
    const rawKey = row?.[rowKeyField];
    if (rawKey === undefined || rawKey === null) continue;
    const rowKey = rowKeyStr(rawKey as Key);
    for (const colName of columnNames) {
      if (!anchor) anchor = { rowKey, colName };
      cellKeys.add(makeCellKey(rowKey, colName));
    }
  }
  return { cellKeys, anchor };
};
