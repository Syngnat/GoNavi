import React from 'react';
import { normalizeOceanBaseProtocol } from '../../../utils/oceanBaseProtocol';
import { formatMongoValueForDisplay } from '../../../utils/mongodb';
import type { TemporalConnectionLike } from '../../dataGridTemporal';
import { findDataGridTextRanges } from '../../../utils/dataGridFind';
import {
    TABLE_CELL_PREVIEW_MAX_CHARS,
    objectCellPreviewCache,
    GONAVI_ROW_KEY,
    DATA_GRID_VIRTUAL_EDIT_RENDER_VERSION,
    CELL_KEY_SEP,
} from './dataGridCellKeys';
import { isPlainObject, normalizeDateTimeString } from './dataGridCellValues';
import type { Item, VirtualEditingCellState } from './dataGridTypes';

// --- Helper: Format Value ---
export const normalizeBitHexDisplayText = (val: any, columnType?: string): string | null => {
    const typeText = String(columnType || '').trim().toLowerCase();
    if (!/^varbit(?:\s*\(\s*\d+\s*\))?$/.test(typeText)
        && !/^bit(?:\s+varying)?(?:\s*\(\s*\d+\s*\))?$/.test(typeText)) {
        return null;
    }
    if (typeof val !== 'string') return null;
    const raw = val.trim();
    if (!/^0x[0-9a-f]+$/i.test(raw)) return null;
    try {
        return BigInt(raw).toString(10);
    } catch {
        return null;
    }
};

export type CellDisplayConnectionLike = TemporalConnectionLike;

export const isDateOnlyColumnType = (columnType?: string): boolean => {
    const normalized = String(columnType || '').trim().toLowerCase();
    if (!normalized) return false;
    const base = normalized.split(/[ (]/)[0];
    return base === 'date' || base === 'newdate';
};

export const isOceanBaseOracleDisplayConnection = (connectionConfig?: CellDisplayConnectionLike): boolean => {
    if (!connectionConfig) return false;
    const type = String(connectionConfig.type || '').trim().toLowerCase();
    const driver = String(connectionConfig.driver || '').trim().toLowerCase();
    return (type === 'oceanbase' || driver === 'oceanbase')
        && normalizeOceanBaseProtocol(connectionConfig.oceanBaseProtocol) === 'oracle';
};

export const normalizeOceanBaseOracleDateDisplayText = (
    val: string,
    columnType?: string,
    connectionConfig?: CellDisplayConnectionLike,
): string | null => {
    if (!isDateOnlyColumnType(columnType) || !isOceanBaseOracleDisplayConnection(connectionConfig)) {
        return null;
    }
    const trimmed = String(val || '').trim();
    if (!trimmed) return trimmed;
    const match = trimmed.match(
        /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(?:\s*(?:Z|[+-]\d{2}:?\d{2})(?:\s+[A-Za-z_\/+-]+)?)?)?$/
    );
    if (!match) return null;
    const [, datePart, timePart, fractionPart] = match;
    if (!timePart) return datePart;
    if (timePart === '00:00:00' && (!fractionPart || /^\.0+$/.test(fractionPart))) {
        return datePart;
    }
    return null;
};

export const formatCellDisplayText = (val: any, columnType?: string, connectionConfig?: CellDisplayConnectionLike): string => {
    try {
        if (val === null) return 'NULL';
        const bitText = normalizeBitHexDisplayText(val, columnType);
        if (bitText !== null) return bitText;
        if (String(connectionConfig?.type || '').trim().toLowerCase() === 'mongodb') {
            const mongoText = formatMongoValueForDisplay(val);
            return mongoText.length > TABLE_CELL_PREVIEW_MAX_CHARS ? `${mongoText.slice(0, TABLE_CELL_PREVIEW_MAX_CHARS)}…` : mongoText;
        }
        if (typeof val === 'object') {
            if (!Array.isArray(val) && !isPlainObject(val)) {
                return String(val);
            }
            const cached = objectCellPreviewCache.get(val);
            if (cached !== undefined) {
                return cached;
            }
            const topLevelSize = Array.isArray(val) ? val.length : Object.keys(val || {}).length;
            if (topLevelSize > 80) {
                const summary = Array.isArray(val) ? `[Array(${topLevelSize})]` : `{Object(${topLevelSize})}`;
                objectCellPreviewCache.set(val, summary);
                return summary;
            }
            try {
                const nextText = JSON.stringify(val);
                const previewText = nextText.length > TABLE_CELL_PREVIEW_MAX_CHARS ? `${nextText.slice(0, TABLE_CELL_PREVIEW_MAX_CHARS)}…` : nextText;
                objectCellPreviewCache.set(val, previewText);
                return previewText;
            } catch {
                return '[Object]';
            }
        }
        if (typeof val === 'string') {
            const oceanBaseDateOnly = normalizeOceanBaseOracleDateDisplayText(val, columnType, connectionConfig);
            if (oceanBaseDateOnly !== null) {
                return oceanBaseDateOnly.length > TABLE_CELL_PREVIEW_MAX_CHARS ? `${oceanBaseDateOnly.slice(0, TABLE_CELL_PREVIEW_MAX_CHARS)}…` : oceanBaseDateOnly;
            }
            const normalized = normalizeDateTimeString(val);
            return normalized.length > TABLE_CELL_PREVIEW_MAX_CHARS ? `${normalized.slice(0, TABLE_CELL_PREVIEW_MAX_CHARS)}…` : normalized;
        }
        return String(val);
    } catch (e) {
        console.error('formatCellValue error:', e);
        return '[Error]';
    }
};

export const formatClipboardCellText = (val: any, columnType?: string, connectionConfig?: CellDisplayConnectionLike): string => {
    try {
        if (val === null || val === undefined) return 'NULL';
        const bitText = normalizeBitHexDisplayText(val, columnType);
        if (bitText !== null) return bitText;
        if (String(connectionConfig?.type || '').trim().toLowerCase() === 'mongodb') {
            return formatMongoValueForDisplay(val);
        }
        if (typeof val === 'string') {
            const oceanBaseDateOnly = normalizeOceanBaseOracleDateDisplayText(val, columnType, connectionConfig);
            if (oceanBaseDateOnly !== null) return oceanBaseDateOnly;
            return normalizeDateTimeString(val);
        }
        if (typeof val === 'object') {
            try {
                return JSON.stringify(val);
            } catch {
                return String(val);
            }
        }
        return String(val);
    } catch (e) {
        console.error('formatClipboardCellText error:', e);
        return '[Error]';
    }
};

export const normalizeClipboardTsvCell = (text: string): string => text.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');

export const buildClipboardTsv = (
    rows: Array<Record<string, any>>,
    columnNames: string[],
    getColumnType?: (columnName: string) => string | undefined,
    connectionConfig?: CellDisplayConnectionLike,
): string => {
    if (!Array.isArray(rows) || rows.length === 0 || !Array.isArray(columnNames) || columnNames.length === 0) {
        return '';
    }
    const header = columnNames.map(normalizeClipboardTsvCell).join('\t');
    const lines = rows.map((row) => (
        columnNames
            .map((columnName) => normalizeClipboardTsvCell(formatClipboardCellText(row?.[columnName], getColumnType?.(columnName), connectionConfig)))
            .join('\t')
    ));
    return [header, ...lines].join('\n');
};

export const renderHighlightedCellText = (text: string, query: string): React.ReactNode => {
    const ranges = findDataGridTextRanges(text, query);
    if (ranges.length === 0) return text;

    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    ranges.forEach((range, index) => {
        if (range.start > cursor) {
            nodes.push(text.slice(cursor, range.start));
        }
        nodes.push(
            <mark key={`${range.start}-${range.end}-${index}`} className="data-grid-find-highlight">
                {text.slice(range.start, range.end)}
            </mark>,
        );
        cursor = range.end;
    });
    if (cursor < text.length) {
        nodes.push(text.slice(cursor));
    }
    return <>{nodes}</>;
};

export const renderCellDisplayValue = (val: any, query: string, columnType?: string, connectionConfig?: CellDisplayConnectionLike): React.ReactNode => {
    const text = formatCellDisplayText(val, columnType, connectionConfig);
    const content = renderHighlightedCellText(text, query);
    if (val === null) return <span style={{ color: '#ccc' }}>{content}</span>;
    return content;
};

export const formatCellValue = (val: any) => renderCellDisplayValue(val, '');

export const attachDataGridVirtualEditRenderVersion = <T extends Item>(
    rows: T[],
    editingCell: VirtualEditingCellState | null,
): T[] => {
    if (!editingCell) return rows;

    return rows.map((row) => {
        const rowKey = row?.[GONAVI_ROW_KEY];
        if (rowKey === undefined || rowKey === null || String(rowKey) !== editingCell.rowKey) {
            return row;
        }
        const nextRow = { ...(row as object) } as T;
        Object.defineProperty(nextRow, DATA_GRID_VIRTUAL_EDIT_RENDER_VERSION, {
            value: `${editingCell.rowKey}${CELL_KEY_SEP}${editingCell.dataIndex}${CELL_KEY_SEP}${editingCell.sessionId}`,
            enumerable: true,
        });
        return nextRow;
    });
};

export const hasDataGridVirtualEditRenderVersionChanged = (nextRecord: unknown, previousRecord: unknown): boolean => {
    const nextVersion = nextRecord && typeof nextRecord === 'object'
        ? (nextRecord as Record<symbol, unknown>)[DATA_GRID_VIRTUAL_EDIT_RENDER_VERSION]
        : undefined;
    const previousVersion = previousRecord && typeof previousRecord === 'object'
        ? (previousRecord as Record<symbol, unknown>)[DATA_GRID_VIRTUAL_EDIT_RENDER_VERSION]
        : undefined;
    return nextVersion !== previousVersion;
};

export const toEditableText = (val: any): string => {
    if (val === null || val === undefined) return '';
    if (typeof val === 'string') return val;
    try {
        return JSON.stringify(val, null, 2);
    } catch {
        return String(val);
    }
};

export const toFormText = (val: any): string => {
    if (val === null || val === undefined) return '';
    if (typeof val === 'string') return normalizeDateTimeString(val);
    return toEditableText(val);
};

// 用于变更比较：NULL 与 undefined 视为同类空值；与空字符串严格区分。
export const isCellValueEqualForDiff = (left: any, right: any): boolean => {
    if (left === right) return true;
    const leftNullish = left === null || left === undefined;
    const rightNullish = right === null || right === undefined;
    if (leftNullish || rightNullish) return leftNullish && rightNullish;
    return toFormText(left) === toFormText(right);
};

// 渲染阶段轻量比较：避免对象值在 shouldCellUpdate 中反复深度序列化导致卡顿。
export const isCellValueEqualForRender = (left: any, right: any): boolean => {
    if (left === right) return true;
    const leftNullish = left === null || left === undefined;
    const rightNullish = right === null || right === undefined;
    if (leftNullish || rightNullish) return leftNullish && rightNullish;

    const leftType = typeof left;
    const rightType = typeof right;
    if (leftType === 'object' || rightType === 'object') {
        // 对象仅按引用比较；真正的值差异在提交保存时再做严格比对。
        return false;
    }

    if (leftType === 'string' || rightType === 'string') {
        return normalizeDateTimeString(String(left)) === normalizeDateTimeString(String(right));
    }
    return left === right;
};
