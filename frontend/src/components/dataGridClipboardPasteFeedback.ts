import type { DataGridClipboardValue } from './dataGridClipboardPaste';

// 外部剪贴板粘贴（Ctrl+V）在这些情况下不会写入任何单元格。过去它们都是静默返回，
// 用户看不到任何反馈，也无从判断是哪一步失败，因此每一种都对应一条提示与一行调试日志。
export type DataGridPasteSkipReason =
  | 'read-only'
  | 'no-anchor'
  | 'clipboard-empty'
  | 'anchor-missing';

export const DATA_GRID_PASTE_SKIP_MESSAGE_KEYS: Record<DataGridPasteSkipReason, string> = {
  'read-only': 'data_grid.message.paste_blocked_read_only',
  'no-anchor': 'data_grid.message.paste_no_anchor',
  'clipboard-empty': 'data_grid.message.paste_clipboard_empty',
  'anchor-missing': 'data_grid.message.paste_anchor_missing',
};

export const DATA_GRID_PASTE_OVERFLOW_MESSAGE_KEY = 'data_grid.message.paste_overflow_ignored';

const DATA_GRID_PASTE_LOG_PREFIX = '[GoNavi][DataGrid][paste]';

/**
 * 解析剪贴板之前的判定：窗口级 paste 监听会收到应用内所有非输入框的粘贴，
 * 只有用户已经表现出“想往表格里粘”的意图（选过单元格，或开着单元格选择模式）
 * 才值得提示，其余情况保持沉默。
 */
export const resolveDataGridPasteGateReason = ({
  canModifyData,
  hasAnchor,
  cellEditMode,
}: {
  canModifyData: boolean;
  hasAnchor: boolean;
  cellEditMode: boolean;
}): DataGridPasteSkipReason | 'ignore' | null => {
  if (!hasAnchor && !cellEditMode) return 'ignore';
  if (!canModifyData) return 'read-only';
  if (!hasAnchor) return 'no-anchor';
  return null;
};

/** 解析剪贴板之后的判定：矩阵为空，或粘贴起点在当前数据里已找不到。 */
export const resolveDataGridPasteMatrixReason = ({
  matrix,
  anchorResolved,
}: {
  matrix: DataGridClipboardValue[][];
  anchorResolved: boolean;
}): DataGridPasteSkipReason | null => {
  if (!matrix.some((row) => row.length > 0)) return 'clipboard-empty';
  if (!anchorResolved) return 'anchor-missing';
  return null;
};

/**
 * 统计粘贴矩阵超出表格右侧/下方边界、因此没有对应单元格的行数与列数。
 * 单值填充选区时不涉及边界，调用方应直接跳过。
 */
export const countDataGridPasteOverflow = ({
  matrix,
  startRowIndex,
  startColumnIndex,
  rowCount,
  columnCount,
}: {
  matrix: DataGridClipboardValue[][];
  startRowIndex: number;
  startColumnIndex: number;
  rowCount: number;
  columnCount: number;
}): { rows: number; columns: number } => {
  const widestRow = matrix.reduce((width, row) => Math.max(width, row.length), 0);
  return {
    rows: Math.max(0, matrix.length - Math.max(0, rowCount - startRowIndex)),
    columns: Math.max(0, widestRow - Math.max(0, columnCount - startColumnIndex)),
  };
};

const describeElement = (element: Element | null | undefined): string => {
  if (!element) return 'none';
  const tag = String(element.tagName || '').toLowerCase();
  const className = typeof element.className === 'string' ? element.className.trim().split(/\s+/)[0] : '';
  return className ? `${tag}.${className}` : tag;
};

/**
 * 粘贴被忽略时写一行调试日志，只记录原因与剪贴板格式名，不记录剪贴板内容。
 * 用 console.debug：默认隐藏，需要在开发者工具里打开 Verbose 才可见。
 */
export const traceDataGridPaste = (
  event: string,
  detail: {
    clipboardTypes?: readonly string[] | DOMStringList | null;
    activeElement?: Element | null;
    [key: string]: unknown;
  } = {},
): void => {
  const { clipboardTypes, activeElement, ...rest } = detail;
  console.debug(DATA_GRID_PASTE_LOG_PREFIX, event, {
    clipboardTypes: Array.from(clipboardTypes || []),
    activeElement: describeElement(activeElement),
    ...rest,
  });
};
