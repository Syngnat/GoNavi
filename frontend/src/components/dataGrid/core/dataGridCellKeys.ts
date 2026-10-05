import React from 'react';
import { getCurrentLanguage } from '../../../i18n';
import { useOptionalI18n } from '../../../i18n/provider';

// 内部行标识字段：避免与真实业务字段（如 `key` 列）冲突。
export const GONAVI_ROW_KEY = '__gonavi_row_key__';
export const GONAVI_ROW_NUMBER_COLUMN_KEY = '__gonavi_row_number__';

// Cell key helpers for batch selection/fill.
// Use a control character separator to avoid collisions with rowKey/columnName contents (e.g. `new-123`).
export const CELL_KEY_SEP = '\u0001';
export const CELL_SELECTION_DRAG_THRESHOLD_PX = 4;
export const DATE_TIME_CACHE_LIMIT = 2000;
export const TABLE_CELL_PREVIEW_MAX_CHARS = 240;
// 行号列：仅展示序号的窄固定列（约 3~4 位）；多余视口宽度由数据列吸收
export const ROW_NUMBER_COLUMN_WIDTH = 36;
export const DATA_EDIT_AUTO_COMMIT_DELAY_OPTIONS = [
    { value: 3000, seconds: 3 },
    { value: 5000, seconds: 5 },
    { value: 10000, seconds: 10 },
    { value: 30000, seconds: 30 },
];
export const DATA_GRID_VIRTUAL_EDIT_RENDER_VERSION = Symbol('DATA_GRID_VIRTUAL_EDIT_RENDER_VERSION');
export const DEFAULT_GRID_MONO_FONT_FAMILY = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
export const normalizedDateTimeCache = new Map<string, string>();
export const objectCellPreviewCache = new WeakMap<object, string>();
export const useDataGridI18nLanguage = () => {
    const i18n = useOptionalI18n();
    return i18n?.language ?? getCurrentLanguage();
};
export const makeCellKey = (rowKey: string, colName: string) => `${rowKey}${CELL_KEY_SEP}${colName}`;
export const splitCellKey = (cellKey: string): { rowKey: string; colName: string } | null => {
    const sepIndex = cellKey.indexOf(CELL_KEY_SEP);
    if (sepIndex === -1) return null;
    return {
        rowKey: cellKey.slice(0, sepIndex),
        colName: cellKey.slice(sepIndex + CELL_KEY_SEP.length),
    };
};
export const buildDataGridCellSelectionRectangle = ({
    startRowIndex,
    startColIndex,
    endRowIndex,
    endColIndex,
    rows,
    columnNames,
    rowKeyField = GONAVI_ROW_KEY,
    canSelectColumn = () => true,
}: {
    startRowIndex: number;
    startColIndex: number;
    endRowIndex: number;
    endColIndex: number;
    rows: Array<Record<string, any>>;
    columnNames: string[];
    rowKeyField?: string;
    canSelectColumn?: (columnName: string) => boolean;
}): Set<string> => {
    const selectedCells = new Set<string>();
    const minRowIndex = Math.min(startRowIndex, endRowIndex);
    const maxRowIndex = Math.max(startRowIndex, endRowIndex);
    const minColIndex = Math.min(startColIndex, endColIndex);
    const maxColIndex = Math.max(startColIndex, endColIndex);

    for (let rowIndex = minRowIndex; rowIndex <= maxRowIndex; rowIndex++) {
        const rowKey = rows[rowIndex]?.[rowKeyField];
        if (rowKey === undefined || rowKey === null) continue;
        for (let colIndex = minColIndex; colIndex <= maxColIndex; colIndex++) {
            const columnName = columnNames[colIndex];
            if (!columnName || !canSelectColumn(columnName)) continue;
            selectedCells.add(makeCellKey(String(rowKey), columnName));
        }
    }
    return selectedCells;
};
export const collectDataGridCellSelectionRowKeys = (cellKeys: Iterable<string>): string[] => {
    const rowKeys = new Set<string>();
    for (const cellKey of cellKeys) {
        const parsed = splitCellKey(cellKey);
        if (!parsed || !parsed.rowKey) continue;
        rowKeys.add(parsed.rowKey);
    }
    return Array.from(rowKeys);
};
export const filterDataGridCellSelectionToVisibleRows = ({
    cellKeys,
    rows,
    rowKeyField = GONAVI_ROW_KEY,
}: {
    cellKeys: Iterable<string>;
    rows: Iterable<Record<string, any>>;
    rowKeyField?: string;
}): Set<string> => {
    const visibleRowKeys = new Set<string>();
    for (const row of rows) {
        const rowKey = row?.[rowKeyField];
        if (rowKey === undefined || rowKey === null) continue;
        visibleRowKeys.add(String(rowKey));
    }

    const visibleCells = new Set<string>();
    for (const cellKey of cellKeys) {
        const parsed = splitCellKey(cellKey);
        if (parsed && visibleRowKeys.has(parsed.rowKey)) {
            visibleCells.add(cellKey);
        }
    }
    return visibleCells;
};
type DataGridCellSelectionAnchor = {
    rowKey: string;
    colName: string;
    rowIndex: number;
    colIndex: number;
};
export const resolveDataGridCellSelectionAnchor = ({
    cellKeys,
    rows,
    columnNames,
    preferredAnchor,
}: {
    cellKeys: Iterable<string>;
    rows: Iterable<Record<string, any>>;
    columnNames: Iterable<string>;
    preferredAnchor?: { rowKey: string; colName: string } | null;
}): DataGridCellSelectionAnchor | null => {
    const selectedCells = new Set(cellKeys);
    if (selectedCells.size === 0) return null;

    const rowList = Array.from(rows);
    const columns = Array.from(columnNames, (columnName) => String(columnName));
    const columnIndexMap = new Map<string, number>();
    columns.forEach((columnName, index) => columnIndexMap.set(columnName, index));

    const rowIndexMap = new Map<string, number>();
    rowList.forEach((row, index) => {
        const rowKey = row?.[GONAVI_ROW_KEY];
        if (rowKey === undefined || rowKey === null) return;
        rowIndexMap.set(String(rowKey), index);
    });

    const resolveCandidate = (rowKey: string, colName: string): DataGridCellSelectionAnchor | null => {
        const rowIndex = rowIndexMap.get(rowKey);
        const colIndex = columnIndexMap.get(colName);
        if (rowIndex === undefined || colIndex === undefined) return null;
        if (!selectedCells.has(makeCellKey(rowKey, colName))) return null;
        return { rowKey, colName, rowIndex, colIndex };
    };

    if (preferredAnchor) {
        const preferred = resolveCandidate(String(preferredAnchor.rowKey), String(preferredAnchor.colName));
        if (preferred) return preferred;
    }

    for (const [rowIndex, row] of rowList.entries()) {
        const rowKey = row?.[GONAVI_ROW_KEY];
        if (rowKey === undefined || rowKey === null) continue;
        const rowKeyText = String(rowKey);
        for (const [colIndex, colName] of columns.entries()) {
            if (selectedCells.has(makeCellKey(rowKeyText, colName))) {
                return { rowKey: rowKeyText, colName, rowIndex, colIndex };
            }
        }
    }
    return null;
};
export const collectDataGridFillTemplateTargetRowKeys = ({
    selectedRowKeys,
    selectedCellKeys,
    sourceRowKey,
    rowKeyToString,
}: {
    selectedRowKeys: Iterable<React.Key>;
    selectedCellKeys: Iterable<string>;
    sourceRowKey?: string | null;
    rowKeyToString: (key: React.Key) => string;
}): string[] => {
    const targetRowKeys = new Set<string>();
    for (const rowKey of selectedRowKeys) {
        const normalized = rowKeyToString(rowKey);
        if (normalized) targetRowKeys.add(normalized);
    }
    for (const rowKey of collectDataGridCellSelectionRowKeys(selectedCellKeys)) {
        targetRowKeys.add(rowKey);
    }
    if (sourceRowKey !== undefined && sourceRowKey !== null) {
        targetRowKeys.delete(sourceRowKey);
    }
    return Array.from(targetRowKeys);
};
export const resolveContextMenuFieldName = (dataIndex: string, title?: string): string => {
    const name = String(dataIndex || title || '').trim();
    return name;
};
