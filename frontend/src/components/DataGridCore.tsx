import Modal from './common/ResizableDraggableModal';
// cspell:ignore anticon sqls uuidv uuidv4 hscroll
import React, { useState, useEffect, useRef, useContext, useMemo, useCallback, useDeferredValue } from 'react';
import { createPortal } from 'react-dom';
import { Table, message, Input, Button, Dropdown, MenuProps, Form, Pagination, Select, Checkbox, Segmented, Tooltip, Popover, DatePicker, TimePicker } from 'antd';
import dayjs from 'dayjs';
import type { SortOrder, ColumnType } from 'antd/es/table/interface';
import type { Reference as TableReference } from 'rc-table';
import { CloseOutlined, ConsoleSqlOutlined, CopyOutlined, EditOutlined, ExportOutlined, FileTextOutlined, LeftOutlined, RightOutlined, SearchOutlined, VerticalAlignBottomOutlined } from '@ant-design/icons';
import { 
    DndContext, 
    DragEndEvent, 
    PointerSensor, 
    useSensor, 
    useSensors, 
    closestCenter 
} from '@dnd-kit/core';
import { 
    SortableContext, 
    useSortable, 
    horizontalListSortingStrategy, 
    arrayMove 
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ImportData, ExportDataWithOptions, ExportQueryWithOptions, ApplyChanges, PreviewChanges, DBGetColumns, DBGetIndexes, DBGetForeignKeys, DBShowCreateTable } from '../../wailsjs/go/app/App';
import ImportPreviewModal from './ImportPreviewModal';
import { useStore } from '../store';
import { getCurrentLanguage, t } from '../i18n';
import { useOptionalI18n } from '../i18n/provider';
import type { ColumnDefinition, ForeignKeyDefinition, IndexDefinition } from '../types';
import { v4 as generateUuid } from 'uuid';
import 'react-resizable/css/styles.css';
import { buildOrderBySQL, buildPaginatedSelectSQL, buildWhereSQL, escapeLiteral, hasExplicitSort, quoteIdentPart, withSortBufferTuningSQL, type FilterCondition } from '../utils/sql';
import { isMacLikePlatform, normalizeOpacityForPlatform, resolveAppearanceValues } from '../utils/appearance';
import { getDataSourceCapabilities, resolveDataSourceType } from '../utils/dataSourceCapabilities';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { normalizeOceanBaseProtocol } from '../utils/oceanBaseProtocol';
import {
    getDensityParams,
    resolveDataTableColumnWidth,
    resolveDataTableVerticalBorderColor,
} from '../utils/dataGridDisplay';
import { resolvePaginationPageText, resolvePaginationSummaryText, resolvePaginationTotalForControl } from '../utils/dataGridPagination';
import { resolveGridSortInfoFromTableSorter } from '../utils/dataGridSort';
import {
    calculateExternalHorizontalScrollInnerWidth,
    calculateTableBodyBottomPadding,
    calculateVirtualTableScrollX,
    resolveDataGridColumnQuickFindScrollLeft,
    resolveDataGridHorizontalWheelDelta,
} from './dataGridLayout';
import {
    buildCopyDeleteSQL,
    buildCopyInsertSQL,
    buildCopyUpdateSQL,
    normalizeTemporalLiteralText,
    resolveUniqueKeyGroupsFromIndexes,
    type CopySqlError,
} from './dataGridCopyInsert';
import { calculateAutoFitColumnWidth } from './dataGridAutoWidth';
import { buildSelectedCellClipboardText } from './dataGridSelectionCopy';
import { buildCopiedRowsForPaste, buildPastedRowsFromCopiedRows } from './dataGridRowClipboard';
import {
    buildDataGridSelectBaseSql,
    pickDataGridOutputRows,
    resolveDataGridOutputColumnNames,
} from './dataGridOutput';
import {
    buildClipboardCsv,
    buildClipboardJson,
    buildClipboardMarkdown,
    pickRowsForClipboard,
} from './dataGridClipboardExport';
import { applyNoAutoCapAttributesWithin, noAutoCapInputProps } from '../utils/inputAutoCap';
import { DEFAULT_SHORTCUT_OPTIONS, getShortcutPlatform, resolveShortcutDisplay } from '../utils/shortcuts';
import { formatMongoValueForDisplay } from '../utils/mongodb';
import {
    TEMPORAL_FORMATS,
    formatFromDayjs,
    getTemporalPickerFormat,
    getTemporalPickerType,
    isTemporalColumnType,
    parseToDayjs,
    resolveTemporalEditorSaveValue,
    type TemporalConnectionLike,
    type TemporalPickerType,
} from './dataGridTemporal';
import {
    buildEffectiveFilterConditions,
    normalizeQuickWhereCondition,
    resolveWhereConditionSelectedValue,
    resolveWhereConditionSuggestions,
    shouldApplyQuickWhereOnEnter,
    validateQuickWhereCondition,
} from '../utils/dataGridWhereFilter';
import {
    attachDataGridFindRenderVersion,
    collectDataGridFindMatches,
    findDataGridTextRanges,
    hasDataGridFindRenderVersionChanged,
    normalizeDataGridFindQuery,
    resolveDataGridColumnQuickFindTarget,
    resolveDataGridFindNavigationIndex,
    summarizeDataGridFindMatches,
    type DataGridFindMatch,
    type DataGridFindNavigationDirection,
} from '../utils/dataGridFind';
import {
    filterHiddenLocatorColumns,
    isWritableResultColumn,
    resolveWritableColumnName,
    resolveRowLocatorValues,
    type EditRowLocator,
    type RowLocatorMessages,
} from '../utils/rowLocator';
import {
    getColumnDefinitionComment,
    getColumnDefinitionDefault,
    getColumnDefinitionExtra,
    getColumnDefinitionName,
    getColumnDefinitionNullable,
    getColumnDefinitionType,
    hasColumnDefinitionDefault,
} from '../utils/columnDefinition';
import {
    V2CellContextMenuView,
    V2ColumnHeaderContextMenuView,
    type V2CellContextMenuActionKey,
    type V2ColumnHeaderContextMenuActionKey,
} from './V2TableContextMenu';
import DataGridColumnTitle from './DataGridColumnTitle';
import DataGridColumnInfoPopoverContent from './DataGridColumnInfoPopoverContent';
import DataGridColumnQuickFind from './DataGridColumnQuickFind';
import DataGridPageFind from './DataGridPageFind';
import DataGridPaginationBar from './DataGridPaginationBar';
import DataGridResultViewSwitcher from './DataGridResultViewSwitcher';
import DataGridSecondaryActions from './DataGridSecondaryActions';
import DataGridToolbarFrame from './DataGridToolbarFrame';
import DataGridModals from './DataGridModals';
import DataGridLegacyCellContextMenu from './DataGridLegacyCellContextMenu';
import DataGridPreviewPanel from './DataGridPreviewPanel';
import {
    DEFAULT_DATA_EXPORT_FORMAT,
    DEFAULT_XLSX_ROWS_PER_SHEET,
    showDataExportDialog,
    type DataExportDialogValues,
    type DataExportFileOptions,
    type DataExportScopeOption,
} from './DataExportDialog';
import { DataGridJsonView, DataGridTextView } from './DataGridRecordViews';
import { DataGridV2DdlSideWorkspace, DataGridV2DdlView } from './DataGridV2DdlWorkspace';
import { DataGridV2ErView, DataGridV2FieldsView } from './DataGridV2MetadataViews';
import TableDesigner from './TableDesigner';
import { useExportProgressDialog } from './ExportProgressModal';
import { useDataGridFilters } from './useDataGridFilters';
import { useDataGridDdlView } from './useDataGridDdlView';
import { useDataGridModalEditors } from './useDataGridModalEditors';
import { useDataGridPreviewPanel } from './useDataGridPreviewPanel';
import { buildTableExportTab } from '../utils/tableExportTab';
import { buildDataGridCssText } from './dataGridStyles';

// --- Error Boundary ---
interface DataGridErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

interface DataGridErrorBoundaryProps {
    children: React.ReactNode;
    i18nLanguage?: string;
}

class DataGridErrorBoundary extends React.Component<
    DataGridErrorBoundaryProps,
    DataGridErrorBoundaryState
> {
    constructor(props: DataGridErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): DataGridErrorBoundaryState {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
        console.error('DataGrid render error:', error, errorInfo);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div style={{ padding: 16, color: '#ff4d4f' }}>
                    <h4>{t('data_grid.error_boundary.title', undefined, this.props.i18nLanguage)}</h4>
                    <p>{t('data_grid.error_boundary.description', undefined, this.props.i18nLanguage)}</p>
                    <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                        {this.state.error?.message}
                    </pre>
                    <Button
                        size="small"
                        onClick={() => this.setState({ hasError: false, error: null })}
                    >
                        {t('data_grid.error_boundary.retry', undefined, this.props.i18nLanguage)}
                    </Button>
                </div>
            );
        }
        return this.props.children;
    }
}

// 内部行标识字段：避免与真实业务字段（如 `key` 列）冲突。
export const GONAVI_ROW_KEY = '__gonavi_row_key__';
export const GONAVI_ROW_NUMBER_COLUMN_KEY = '__gonavi_row_number__';

// Cell key helpers for batch selection/fill.
// Use a control character separator to avoid collisions with rowKey/columnName contents (e.g. `new-123`).
const CELL_KEY_SEP = '\u0001';
const CELL_SELECTION_DRAG_THRESHOLD_PX = 4;
const DATE_TIME_CACHE_LIMIT = 2000;
const TABLE_CELL_PREVIEW_MAX_CHARS = 240;
// 行号列：仅展示序号的窄固定列（约 3~4 位）；多余视口宽度由数据列吸收
const ROW_NUMBER_COLUMN_WIDTH = 36;
const DATA_EDIT_AUTO_COMMIT_DELAY_OPTIONS = [
    { value: 3000, seconds: 3 },
    { value: 5000, seconds: 5 },
    { value: 10000, seconds: 10 },
    { value: 30000, seconds: 30 },
];
const DATA_GRID_DISPLAY_RENDER_VERSION = Symbol('DATA_GRID_DISPLAY_RENDER_VERSION');
const DATA_GRID_VIRTUAL_EDIT_RENDER_VERSION = Symbol('DATA_GRID_VIRTUAL_EDIT_RENDER_VERSION');
const DEFAULT_GRID_MONO_FONT_FAMILY = '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const normalizedDateTimeCache = new Map<string, string>();
const objectCellPreviewCache = new WeakMap<object, string>();
const useDataGridI18nLanguage = () => {
    const i18n = useOptionalI18n();
    return i18n?.language ?? getCurrentLanguage();
};
const makeCellKey = (rowKey: string, colName: string) => `${rowKey}${CELL_KEY_SEP}${colName}`;
const splitCellKey = (cellKey: string): { rowKey: string; colName: string } | null => {
    const sepIndex = cellKey.indexOf(CELL_KEY_SEP);
    if (sepIndex === -1) return null;
    return {
        rowKey: cellKey.slice(0, sepIndex),
        colName: cellKey.slice(sepIndex + CELL_KEY_SEP.length),
    };
};
const collectDataGridCellSelectionRowKeys = (cellKeys: Iterable<string>): string[] => {
    const rowKeys = new Set<string>();
    for (const cellKey of cellKeys) {
        const parsed = splitCellKey(cellKey);
        if (!parsed || !parsed.rowKey) continue;
        rowKeys.add(parsed.rowKey);
    }
    return Array.from(rowKeys);
};
export const resolveContextMenuFieldName = (dataIndex: string, title?: string): string => {
    const name = String(dataIndex || title || '').trim();
    return name;
};

const trimSimpleCache = (cache: Map<string, string>, limit: number) => {
    if (cache.size < limit) return;
    const firstKey = cache.keys().next().value;
    if (typeof firstKey === 'string') {
        cache.delete(firstKey);
    }
};

const looksLikeDateTimeText = (val: string): boolean => {
    if (!val) return false;
    const len = val.length;
    if (len < 19 || len > 48) return false;
    const charCode0 = val.charCodeAt(0);
    if (charCode0 < 48 || charCode0 > 57) return false;
    return (
        val[4] === '-' &&
        val[7] === '-' &&
        (val[10] === ' ' || val[10] === 'T') &&
        val[13] === ':' &&
        val[16] === ':'
    );
};

// Normalize common datetime strings to `YYYY-MM-DD HH:mm:ss[.fraction]` for display/editing.
// Handles RFC3339 and Go-style datetime text like `2024-05-13 08:32:47 +0800 CST`.
// Also keep invalid datetime values like `0000-00-00 00:00:00` unchanged.
const normalizeDateTimeString = (val: string) => {
    if (!looksLikeDateTimeText(val)) {
        return val;
    }

    const cached = normalizedDateTimeCache.get(val);
    if (cached !== undefined) {
        return cached;
    }

    // 检查是否为无效日期时间（0000-00-00 或类似格式）
    if (/^0{4}-0{2}-0{2}/.test(val)) {
        return val; // 保持原样显示，不尝试转换
    }

    const match = val.match(
        /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(?:\s*(?:Z|[+-]\d{2}:?\d{2})(?:\s+[A-Za-z_\/+-]+)?)?$/
    );
    const normalized = match ? `${match[1]} ${match[2]}${match[3] || ''}` : val;
    trimSimpleCache(normalizedDateTimeCache, DATE_TIME_CACHE_LIMIT);
    normalizedDateTimeCache.set(val, normalized);
    return normalized;
};

// --- Helper: Format Value ---
const normalizeBitHexDisplayText = (val: any, columnType?: string): string | null => {
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

type CellDisplayConnectionLike = TemporalConnectionLike;

const isDateOnlyColumnType = (columnType?: string): boolean => {
    const normalized = String(columnType || '').trim().toLowerCase();
    if (!normalized) return false;
    const base = normalized.split(/[ (]/)[0];
    return base === 'date' || base === 'newdate';
};

const isOceanBaseOracleDisplayConnection = (connectionConfig?: CellDisplayConnectionLike): boolean => {
    if (!connectionConfig) return false;
    const type = String(connectionConfig.type || '').trim().toLowerCase();
    const driver = String(connectionConfig.driver || '').trim().toLowerCase();
    return (type === 'oceanbase' || driver === 'oceanbase')
        && normalizeOceanBaseProtocol(connectionConfig.oceanBaseProtocol) === 'oracle';
};

const normalizeOceanBaseOracleDateDisplayText = (
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

const formatClipboardCellText = (val: any, columnType?: string, connectionConfig?: CellDisplayConnectionLike): string => {
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

const normalizeClipboardTsvCell = (text: string): string => text.replace(/\t/g, ' ').replace(/\r?\n/g, ' ');

const buildClipboardTsv = (
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

const renderHighlightedCellText = (text: string, query: string): React.ReactNode => {
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

const renderCellDisplayValue = (val: any, query: string, columnType?: string, connectionConfig?: CellDisplayConnectionLike): React.ReactNode => {
    const text = formatCellDisplayText(val, columnType, connectionConfig);
    const content = renderHighlightedCellText(text, query);
    if (val === null) return <span style={{ color: '#ccc' }}>{content}</span>;
    return content;
};

const formatCellValue = (val: any) => renderCellDisplayValue(val, '');

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

export const attachDataGridDisplayRenderVersion = <T extends Item>(
    rows: T[],
    renderVersion: string,
): T[] => {
    if (!renderVersion) return rows;

    return rows.map((row) => {
        if (!row || typeof row !== 'object') return row;
        const nextRow = { ...(row as object) } as T;
        Object.defineProperty(nextRow, DATA_GRID_DISPLAY_RENDER_VERSION, {
            value: renderVersion,
            enumerable: true,
        });
        return nextRow;
    });
};

export const hasDataGridDisplayRenderVersionChanged = (nextRecord: unknown, previousRecord: unknown): boolean => {
    const nextVersion = nextRecord && typeof nextRecord === 'object'
        ? (nextRecord as Record<symbol, unknown>)[DATA_GRID_DISPLAY_RENDER_VERSION]
        : undefined;
    const previousVersion = previousRecord && typeof previousRecord === 'object'
        ? (previousRecord as Record<symbol, unknown>)[DATA_GRID_DISPLAY_RENDER_VERSION]
        : undefined;
    return nextVersion !== previousVersion;
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

const toEditableText = (val: any): string => {
    if (val === null || val === undefined) return '';
    if (typeof val === 'string') return val;
    try {
        return JSON.stringify(val, null, 2);
    } catch {
        return String(val);
    }
};

const toFormText = (val: any): string => {
    if (val === null || val === undefined) return '';
    if (typeof val === 'string') return normalizeDateTimeString(val);
    return toEditableText(val);
};

// 用于变更比较：NULL 与 undefined 视为同类空值；与空字符串严格区分。
const isCellValueEqualForDiff = (left: any, right: any): boolean => {
    if (left === right) return true;
    const leftNullish = left === null || left === undefined;
    const rightNullish = right === null || right === undefined;
    if (leftNullish || rightNullish) return leftNullish && rightNullish;
    return toFormText(left) === toFormText(right);
};

// 渲染阶段轻量比较：避免对象值在 shouldCellUpdate 中反复深度序列化导致卡顿。
const isCellValueEqualForRender = (left: any, right: any): boolean => {
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

const INLINE_EDIT_MAX_CHARS = 2000;

const shouldOpenModalEditor = (val: any): boolean => {
    if (val === null || val === undefined) return false;
    if (typeof val === 'string') {
        if (val.length > INLINE_EDIT_MAX_CHARS || val.includes('\n')) return true;
        const trimmed = val.trimStart();
        return trimmed.startsWith('{') || trimmed.startsWith('[');
    }
    return typeof val === 'object';
};

const getCellFieldName = (record: Item, dataIndex: string) => {
    const rowKey = record?.[GONAVI_ROW_KEY];
    if (rowKey === undefined || rowKey === null) return dataIndex;
    return [String(rowKey), dataIndex];
};

const setCellFieldValue = (form: any, fieldName: string | (string | number)[], value: any) => {
    if (!form) return;
    if (Array.isArray(fieldName)) {
        const [rowKey, colKey] = fieldName;
        form.setFieldsValue({ [rowKey]: { [colKey]: value } });
        return;
    }
    form.setFieldsValue({ [fieldName]: value });
};

const looksLikeJsonText = (text: string): boolean => {
    const raw = (text || '').trim();
    if (!raw) return false;
    const first = raw[0];
    const last = raw[raw.length - 1];
    return (first === '{' && last === '}') || (first === '[' && last === ']');
};

const isPlainObject = (value: any): value is Record<string, any> => {
    return Object.prototype.toString.call(value) === '[object Object]';
};

const normalizeValueForJsonView = (value: any): any => {
    if (value === null || value === undefined) return value;

    if (typeof value === 'string') {
        const normalizedText = normalizeDateTimeString(value);
        if (!looksLikeJsonText(normalizedText)) return normalizedText;
        try {
            return normalizeValueForJsonView(JSON.parse(normalizedText));
        } catch {
            return normalizedText;
        }
    }

    if (Array.isArray(value)) {
        return value.map((item) => normalizeValueForJsonView(item));
    }

    if (isPlainObject(value)) {
        const next: Record<string, any> = {};
        Object.entries(value).forEach(([key, val]) => {
            next[key] = normalizeValueForJsonView(val);
        });
        return next;
    }

    return value;
};

const isJsonViewValueEqual = (left: any, right: any): boolean => {
    const leftNormalized = normalizeValueForJsonView(left);
    const rightNormalized = normalizeValueForJsonView(right);

    if (leftNormalized === rightNormalized) return true;
    if (leftNormalized === null || rightNormalized === null) return leftNormalized === rightNormalized;
    if (leftNormalized === undefined || rightNormalized === undefined) return leftNormalized === rightNormalized;

    if (typeof leftNormalized !== 'object' && typeof rightNormalized !== 'object') {
        return String(leftNormalized) === String(rightNormalized);
    }

    try {
        return JSON.stringify(leftNormalized) === JSON.stringify(rightNormalized);
    } catch {
        return false;
    }
};

const coerceJsonEditorValueForStorage = (currentValue: any, editedValue: any): any => {
    if (typeof currentValue === 'string') {
        const raw = currentValue.trim();
        const parsedCurrent = looksLikeJsonText(raw);
        if (parsedCurrent && (isPlainObject(editedValue) || Array.isArray(editedValue))) {
            return JSON.stringify(editedValue);
        }
    }
    return editedValue;
};

// --- Resizable Header (Native Implementation) ---
const ResizableTitle = React.forwardRef<HTMLTableCellElement, any>((props, ref) => {
  const { onResizeStart, onResizeAutoFit, width, ...restProps } = props;

  const nextStyle = { ...(restProps.style || {}) } as React.CSSProperties;
  if (width) {
    nextStyle.width = width;
  }

  // 注意：virtual table 模式下，rc-table 会依赖 header cell 的 width 样式来渲染选择列。
  // 若这里丢失 width，可能导致左上角“全选”checkbox 不显示。
  if (!width || typeof onResizeStart !== 'function') {
    return <th ref={ref} {...restProps} style={nextStyle} />;
  }

  // 缩放手柄 absolute 定位需要 relative 上下文；
  // 固定列表头的 sticky 由 CSS !important 覆盖，不会被这里的 relative 破坏。
  const thStyle: React.CSSProperties = {
      ...nextStyle,
      position: 'relative',
  };

  return (
    <th ref={ref} {...restProps} style={thStyle}>
      {restProps.children}
      <span
        className="react-resizable-handle"
        onMouseDown={(e) => {
            e.stopPropagation();
            // Pass the header element reference implicitly via event target
            onResizeStart(e);
        }}
        onDoubleClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (typeof onResizeAutoFit === 'function') {
                onResizeAutoFit(e);
            }
        }}
        onPointerDown={(e) => {
            // 阻止 pointerdown 冒泡到 @dnd-kit 的 PointerSensor，
            // 避免调整列宽时意外触发列拖拽排序
            e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
        title={t('data_grid.column.resize_tooltip')}
        style={{
            position: 'absolute',
            right: 0, // Align to right edge
            bottom: 0,
            top: 0,
            width: 10,
            cursor: 'col-resize',
            // 必须低于固定列表头 z-index(30)，否则横向滚动时会穿透到勾选/行号上方
            zIndex: 2,
            touchAction: 'none'
        }}
      />
    </th>
  );
});

// --- Sortable Header Cell ---
interface SortableHeaderCellProps extends React.HTMLAttributes<HTMLTableCellElement> {
    id?: string;
}

// --- Sortable Header Cell ---
interface SortableHeaderCellProps extends React.HTMLAttributes<HTMLTableCellElement> {
    id?: string;
}

// 静态 CSS 移到组件外，强制去除 th 内边距并确保指针穿透
const sortableHeaderStaticStyles = `
    .gonavi-sortable-header-cell {
        padding: 0 !important;
        overflow: hidden;
    }
    .gonavi-sortable-header-cell[data-cursor-grabbing="true"],
    .gonavi-sortable-header-cell[data-cursor-grabbing="true"] *,
    .gonavi-sortable-header-cell.is-dragging,
    .gonavi-sortable-header-cell.is-dragging * {
        cursor: grabbing !important;
    }
    .sortable-header-cell-drag-handle {
        display: flex;
        align-items: center;
        width: 100%;
        height: 100%;
        min-height: var(--gonavi-header-min-height, 40px);
        padding: 0 10px;
        user-select: none;
        cursor: inherit;
        overflow: hidden;
    }
`;

const SortableHeaderCell: React.FC<SortableHeaderCellProps> = React.memo((props) => {
    const { id, children, style: propStyle, className: propClassName, ...restProps } = props;
    const [isPressed, setIsPressed] = useState(false);
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: id || '' });

    // 未拖拽时不要写 transform/willChange，否则会破坏表头 sticky 固定列（全选 / 行号）
    const dndTransform = isDragging ? CSS.Transform.toString(transform) : undefined;
    const style: React.CSSProperties = {
        ...propStyle,
        ...(dndTransform ? { transform: dndTransform, willChange: 'transform' as const } : {}),
        transition,
        ...(isDragging ? {
            position: 'relative',
            zIndex: 9999,
            opacity: 0.6,
            backgroundColor: 'rgba(24, 144, 255, 0.15)',
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        } : {}),
        touchAction: 'none',
        cursor: (isDragging || isPressed) ? 'grabbing' : 'pointer',
    };

    useEffect(() => {
        const handleGlobalMouseUp = () => setIsPressed(false);
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
    }, []);

    // 选择列 / 无 id：保留 propStyle（含 sticky left），不要被 dnd 样式污染
    if (!id || id === 'GONAVI_SELECTION_COLUMN') {
        return (
            <ResizableTitle
                {...restProps}
                className={propClassName}
                style={propStyle}
            >
                {children}
            </ResizableTitle>
        );
    }

    return (
        <ResizableTitle
            ref={setNodeRef}
            style={style}
            className={`${propClassName || ''} ${isDragging ? 'is-dragging' : ''}`}
            data-cursor-grabbing={isDragging || isPressed}
            {...restProps}
            {...attributes}
            {...listeners}
            onPointerDown={(e: any) => {
                setIsPressed(true);
                if (listeners?.onPointerDown) listeners.onPointerDown(e);
            }}
        >
            <style>{sortableHeaderStaticStyles}</style>
            <div className="sortable-header-cell-drag-handle" title={t('data_grid.column.drag_tooltip')}>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', minWidth: 0, cursor: 'inherit' }}>
                    {children}
                </div>
            </div>
        </ResizableTitle>
    );
});

// --- Contexts ---
const EditableContext = React.createContext<any>(null);
const CellContextMenuContext = React.createContext<{
    showMenu: (e: React.MouseEvent, record: Item, dataIndex: string, title: React.ReactNode) => void;
    handleBatchFillToSelected: (record: Item, dataIndex: string) => void;
} | null>(null);
const DataContext = React.createContext<{
    selectedRowKeysRef: React.MutableRefObject<React.Key[]>;
    displayDataRef: React.MutableRefObject<any[]>;
    handleCopyInsert: (r: any) => void;
    handleCopyUpdate: (r: any) => void;
    handleCopyDelete: (r: any) => void;
    handleCopyJson: (r: any) => void;
    handleCopyCsv: (r: any) => void;
    handleExportSelected: (options: DataExportFileOptions, r: any) => Promise<void>;
    copyToClipboard: (t: string) => void;
    tableName?: string;
    enableRowContextMenu: boolean;
    supportsCopyInsert: boolean;
} | null>(null);

interface Item {
  [key: string]: any;
}

interface EditableCellProps {
  title: React.ReactNode;
  editable: boolean;
  children: React.ReactNode;
  dataIndex: string;
  record: Item;
  handleSave: (record: Item) => void;
  focusCell?: (record: Item, dataIndex: string, title: React.ReactNode) => void;
  columnType?: string;
  dbType?: string;
  connectionConfig?: CellDisplayConnectionLike;
  inputCellPadding?: React.CSSProperties;
  as?: any;
  modifiedColumns?: Record<string, Set<string>>;
  rowKeyStr?: (k: React.Key) => string;
  deletedRowKeys?: Set<string>;
  darkMode?: boolean;
  [key: string]: any;
}

// 模块级变量：绕过 React 渲染链条，在事件处理器中直接读取最新删除状态。
// EditableCell 内部通过 React.memo 包裹，且 Ant Design rc-table 有多层 memo 缓存，
// 仅靠 props 传递 deletedRowKeys 可能因缓存而不触发重渲染。
let globalDeletedRowKeys: Set<string> = new Set();
const setGlobalDeletedRowKeys = (next: Set<string>) => {
  globalDeletedRowKeys = next;
};

const resolveEditableCellRowKey = (
  record: Item | undefined,
  rowKeyStr?: (k: React.Key) => string,
): string | null => {
  const rowKey = record?.[GONAVI_ROW_KEY];
  if (rowKey === undefined || rowKey === null || typeof rowKeyStr !== 'function') {
      return null;
  }
  return rowKeyStr(rowKey);
};

const isEditableCellDeleted = (
  record: Item | undefined,
  deletedRowKeys?: Set<string>,
  rowKeyStr?: (k: React.Key) => string,
): boolean => {
  const rowKey = resolveEditableCellRowKey(record, rowKeyStr);
  return rowKey ? !!deletedRowKeys?.has(rowKey) : false;
};

const isEditableCellModified = (
  record: Item | undefined,
  dataIndex: string,
  modifiedColumns?: Record<string, Set<string>>,
  rowKeyStr?: (k: React.Key) => string,
): boolean => {
  const rowKey = resolveEditableCellRowKey(record, rowKeyStr);
  return rowKey ? !!modifiedColumns?.[rowKey]?.has(dataIndex) : false;
};

const areEditableCellPropsEqual = (prevProps: EditableCellProps, nextProps: EditableCellProps): boolean => {
  if (prevProps.editable !== nextProps.editable) return false;
  if (prevProps.dataIndex !== nextProps.dataIndex) return false;
  if (prevProps.title !== nextProps.title) return false;
  if (prevProps.columnType !== nextProps.columnType) return false;
  if (prevProps.dbType !== nextProps.dbType) return false;
  if ((prevProps.connectionConfig?.type ?? null) !== (nextProps.connectionConfig?.type ?? null)) return false;
  if ((prevProps.connectionConfig?.driver ?? null) !== (nextProps.connectionConfig?.driver ?? null)) return false;
  if ((prevProps.connectionConfig?.oceanBaseProtocol ?? null) !== (nextProps.connectionConfig?.oceanBaseProtocol ?? null)) return false;
  if (prevProps.darkMode !== nextProps.darkMode) return false;
  if (prevProps.as !== nextProps.as) return false;
  if (prevProps.handleSave !== nextProps.handleSave) return false;
  if (prevProps.focusCell !== nextProps.focusCell) return false;
  if ((prevProps.inputCellPadding?.padding ?? null) !== (nextProps.inputCellPadding?.padding ?? null)) return false;
  if (prevProps.style !== nextProps.style) return false;

  const prevRecord = prevProps.record;
  const nextRecord = nextProps.record;
  if (resolveEditableCellRowKey(prevRecord, prevProps.rowKeyStr) !== resolveEditableCellRowKey(nextRecord, nextProps.rowKeyStr)) {
      return false;
  }
  if (hasDataGridFindRenderVersionChanged(nextRecord, prevRecord)) {
      return false;
  }
  if (!isCellValueEqualForRender(prevRecord?.[prevProps.dataIndex], nextRecord?.[nextProps.dataIndex])) {
      return false;
  }
  if (isEditableCellDeleted(prevRecord, prevProps.deletedRowKeys, prevProps.rowKeyStr) !== isEditableCellDeleted(nextRecord, nextProps.deletedRowKeys, nextProps.rowKeyStr)) {
      return false;
  }
  if (isEditableCellModified(prevRecord, prevProps.dataIndex, prevProps.modifiedColumns, prevProps.rowKeyStr) !== isEditableCellModified(nextRecord, nextProps.dataIndex, nextProps.modifiedColumns, nextProps.rowKeyStr)) {
      return false;
  }

  return true;
};

const EditableCell: React.FC<EditableCellProps> = React.memo(({
  title,
  editable,
  children,
  dataIndex,
  record,
  handleSave,
  focusCell,
  columnType,
  dbType,
  connectionConfig,
  inputCellPadding,
  as: Component = 'td',
  modifiedColumns,
  rowKeyStr,
  deletedRowKeys,
  darkMode,
  ...restProps
}) => {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<any>(null);
  const cellRef = useRef<HTMLElement>(null);
  const pickerOpenRef = useRef(false);
  const scrollLockRef = useRef<{ el: HTMLElement; handler: (e: WheelEvent) => void } | null>(null);
  const form = useContext(EditableContext);
  const cellContextMenuContext = useContext(CellContextMenuContext);
  const i18nLanguage = useDataGridI18nLanguage();
  const dateTimePickerNowLabel = t('data_grid.datetime_picker.now', undefined, i18nLanguage);

  /** DatePicker 面板打开时锁定表格滚动，关闭时恢复 */
  const lockTableScroll = useCallback((lock: boolean) => {
      if (lock) {
          // 查找虚拟滚动容器或常规滚动容器
          const tableWrapper = cellRef.current?.closest?.('.ant-table-wrapper') as HTMLElement | null;
          if (tableWrapper) {
              const handler = (e: WheelEvent) => { e.preventDefault(); e.stopPropagation(); };
              tableWrapper.addEventListener('wheel', handler, { capture: true, passive: false });
              scrollLockRef.current = { el: tableWrapper, handler };
          }
      } else if (scrollLockRef.current) {
          const { el, handler } = scrollLockRef.current;
          el.removeEventListener('wheel', handler, { capture: true } as any);
          scrollLockRef.current = null;
      }
  }, []);

  useEffect(() => {
    if (editing) {
      // 每次进入编辑时强制设置表单值（覆盖 form store 中可能残留的旧值）
      const raw = record[dataIndex];
      const fieldName = getCellFieldName(record, dataIndex);
      if (isDateTimeField) {
        const dayjsVal = parseToDayjs(raw, pickerType);
        setCellFieldValue(form, fieldName, dayjsVal);
      } else {
        const initialValue = typeof raw === 'string' ? normalizeDateTimeString(raw) : raw;
        setCellFieldValue(form, fieldName, initialValue);
      }
      inputRef.current?.focus();
    }
  }, [editing]);

  const toggleEdit = () => {
    setEditing(!editing);
  };

  const save = async (pickerValue?: dayjs.Dayjs | null) => {
    try {
      if (!form || !editing) return;
      const fieldName = getCellFieldName(record, dataIndex);
      await form.validateFields([fieldName]);
      let nextValue = form.getFieldValue(fieldName);
      if (isDateTimeField) {
        nextValue = resolveTemporalEditorSaveValue(nextValue, pickerValue, pickerType);
      }
      toggleEdit();
      // 仅当值发生变化时才标记为修改，避免“双击-失焦”导致整行进入 modified 状态（蓝色高亮不清除）。
      if (!isCellValueEqualForDiff(record?.[dataIndex], nextValue)) {
        handleSave({ ...record, [dataIndex]: nextValue });
      }
      // 保存后移除焦点
      if (inputRef.current) {
        inputRef.current.blur();
      }
    } catch (errInfo) {
      console.log('Save failed:', errInfo);
      // 日期时间类型保存失败时兜底退出编辑，避免 DatePicker 卡在编辑态
      if (isDateTimeField && editing) setEditing(false);
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!cellContextMenuContext) return;
    e.preventDefault();
    e.stopPropagation(); // 阻止冒泡到行级菜单
    cellContextMenuContext.showMenu(e, record, dataIndex, title);
  };

  let childNode = children;

  const pickerType = getTemporalPickerType(columnType, dbType, connectionConfig);
  const isDateTimeField = !!pickerType && !(/^0{4}-0{2}-0{2}/.test(String(record?.[dataIndex] || '')));

  const isRowDeleted = deletedRowKeys && rowKeyStr && record?.[GONAVI_ROW_KEY] !== undefined
    ? deletedRowKeys.has(rowKeyStr(record[GONAVI_ROW_KEY]))
    : false;

  const isModified = !editing && modifiedColumns && rowKeyStr && record?.[GONAVI_ROW_KEY] !== undefined
    ? modifiedColumns[rowKeyStr(record[GONAVI_ROW_KEY])]?.has(dataIndex)
    : false;

  const modifiedStyle: React.CSSProperties | undefined = isModified
    ? { backgroundColor: darkMode ? 'rgba(255, 214, 102, 0.16)' : '#FFF3B0' }
    : undefined;

  if (editable) {
    childNode = editing ? (
      <Form.Item className="data-grid-inline-editor-form-item" style={INLINE_EDIT_FORM_ITEM_STYLE} name={getCellFieldName(record, dataIndex)}>
        {isDateTimeField ? (
          pickerType === 'time' ? (
            <TimePicker
              ref={inputRef}
              style={{ width: '100%' }}
              format={TEMPORAL_FORMATS[pickerType]}
              onChange={(value) => setTimeout(() => { void save(value); }, 0)}
              onOpenChange={lockTableScroll}
              onBlur={() => setTimeout(() => { void save(); }, 0)}
              needConfirm={false}
            />
          ) : pickerType === 'datetime' ? (
            <DatePicker
              ref={inputRef}
              style={{ width: '100%' }}
              showTime
              showNow={false}
              format={getTemporalPickerFormat(pickerType)}
              renderExtraFooter={() => (
                <a
                  style={{ padding: '0 2px' }}
                  onClick={() => {
                    // 自定义"此刻"：仅将当前时间填入表单字段，面板保持打开。
                    // 用户需点击"确定"才真正保存，替代内置 showNow 的自动提交行为。
                    const fieldName = getCellFieldName(record, dataIndex);
                    setCellFieldValue(form, fieldName, dayjs());
                  }}
                >{dateTimePickerNowLabel}</a>
              )}
              onOk={(value) => setTimeout(() => { void save((value as dayjs.Dayjs | null | undefined) ?? undefined); }, 0)}
              onOpenChange={(open) => {
                pickerOpenRef.current = open;
                lockTableScroll(open);
                // 面板关闭（点击外部）时退出编辑，不保存；仅"确定"按钮（onOk）触发保存
                if (!open) setTimeout(() => { if (editing) toggleEdit(); }, 0);
              }}
              onBlur={() => {
                // 兜底：面板未打开或已关闭时，点击外部通过 blur 退出编辑。
                // 延迟检查面板状态，避免点击自定义"此刻"按钮时误退出（此时面板仍打开）。
                setTimeout(() => { if (editing && !pickerOpenRef.current) setEditing(false); }, 150);
              }}
              needConfirm
            />
          ) : (
            <DatePicker
              ref={inputRef}
              style={{ width: '100%' }}
              format={TEMPORAL_FORMATS[pickerType]}
              picker={pickerType as any}
              onChange={(value) => setTimeout(() => { void save(value); }, 0)}
              onOpenChange={lockTableScroll}
              onBlur={() => setTimeout(() => { void save(); }, 0)}
              needConfirm={false}
            />
          )
        ) : (
          <Input
            {...noAutoCapInputProps}
            ref={inputRef}
            className="data-grid-inline-editor-input"
            style={{ width: '100%', ...inputCellPadding }}
            onPressEnter={() => { void save(); }}
            onBlur={() => { void save(); }}
            onFocus={(e) => {
              try {
                (e.target as HTMLInputElement)?.select?.();
              } catch {
                // ignore
              }
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              try {
                (e.target as HTMLInputElement)?.select?.();
              } catch {
                // ignore
              }
            }}
          />
        )}
      </Form.Item>
    ) : (
      <div
        className="editable-cell-value-wrap"
        style={modifiedStyle}
        onContextMenu={handleContextMenu}
      >
        {children}
      </div>
    );
  } else if (cellContextMenuContext) {
    // 非编辑模式（只读查询结果）也绑定右键菜单，支持复制为 INSERT/JSON/CSV 等操作
    childNode = (
      <div onContextMenu={handleContextMenu} style={modifiedStyle ? { ...READONLY_CELL_WRAP_STYLE, ...modifiedStyle } : READONLY_CELL_WRAP_STYLE}>
        {children}
      </div>
    );
  } else if (isModified) {
    childNode = (
      <div style={modifiedStyle}>
        {children}
      </div>
    );
  }

  const handleDoubleClick = () => {
      if (!editable) return;
      if (isRowDeleted) return;
      // 模块级检查：绕过 React 渲染链条，确保即使组件因 memo 缓存未重渲染也能拿到最新状态
      if (record?.[GONAVI_ROW_KEY] !== undefined
          && rowKeyStr
          && globalDeletedRowKeys.has(rowKeyStr(record[GONAVI_ROW_KEY]))) return;
      // 已在编辑态时再次双击不应退出编辑；双击应支持在 Input 内进行全选。
      if (editing) return;
      const raw = record?.[dataIndex];
      if (focusCell && shouldOpenModalEditor(raw)) {
          focusCell(record, dataIndex, title);
          return;
      }
      toggleEdit();
  };

  return (
      <Component
          ref={cellRef}
          {...restProps}
          data-row-key={record ? String(record?.[GONAVI_ROW_KEY]) : undefined}
          data-col-name={dataIndex || undefined}
          onDoubleClick={editable ? handleDoubleClick : restProps?.onDoubleClick}
      >
          {childNode}
      </Component>
  );
}, areEditableCellPropsEqual);

const ContextMenuRow = React.memo(({ children, record, ...props }: any) => {
    const context = useContext(DataContext);
    
    if (!record || !context) return <tr {...props}>{children}</tr>;

    const {
        selectedRowKeysRef,
        displayDataRef,
        handleCopyInsert,
        handleCopyUpdate,
        handleCopyDelete,
        handleCopyJson,
        handleCopyCsv,
        handleExportSelected,
        copyToClipboard,
        enableRowContextMenu,
        supportsCopyInsert,
    } = context;

    if (!enableRowContextMenu) {
        return <tr {...props}>{children}</tr>;
    }

    const getTargets = () => {
        const keys = selectedRowKeysRef.current;
        const recordKey = record?.[GONAVI_ROW_KEY];
        if (recordKey !== undefined && keys.includes(recordKey)) {
            return displayDataRef.current.filter(d => keys.includes(d?.[GONAVI_ROW_KEY]));
        }
        return [record];
    };

    const menuItems: MenuProps['items'] = [
        ...(supportsCopyInsert ? [{
            key: 'insert',
            label: t('data_grid.context_menu.copy_as_insert'),
            icon: <ConsoleSqlOutlined />,
            onClick: () => handleCopyInsert(record),
        }, {
            key: 'update',
            label: t('data_grid.context_menu.copy_as_update'),
            icon: <ConsoleSqlOutlined />,
            onClick: () => handleCopyUpdate(record),
        }, {
            key: 'delete',
            label: t('data_grid.context_menu.copy_as_delete'),
            icon: <ConsoleSqlOutlined />,
            onClick: () => handleCopyDelete(record),
        }] : []),
        { key: 'json', label: t('data_grid.context_menu.copy_as_json'), icon: <FileTextOutlined />, onClick: () => handleCopyJson(record) },
        { key: 'csv', label: t('data_grid.context_menu.copy_as_csv'), icon: <FileTextOutlined />, onClick: () => handleCopyCsv(record) },
        { key: 'copy', label: t('data_grid.context_menu.copy_as_markdown'), icon: <CopyOutlined />, onClick: () => {
            const records = getTargets();
            const orderedCols = displayDataRef.current.length > 0
                ? Object.keys(displayDataRef.current[0]).filter(c => c !== GONAVI_ROW_KEY)
                : [];
            const header = `| ${orderedCols.join(' | ')} |`;
            const separator = `| ${orderedCols.map(() => '---').join(' | ')} |`;
            const rows = records.map((r: any) => {
                const values = orderedCols.map(c => {
                    const v = r[c];
                    if (v === null || v === undefined) return 'NULL';
                    return String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
                });
                return `| ${values.join(' | ')} |`;
            });
            copyToClipboard([header, separator, ...rows].join('\n'));
        } },
        { type: 'divider' },
        {
            key: 'export-selected',
            label: t('data_grid.context_menu.export_selected'),
            icon: <ExportOutlined />,
            children: [
                { key: 'exp-csv', label: 'CSV', onClick: () => handleExportSelected({ format: 'csv' }, record).catch(console.error) },
                { key: 'exp-xlsx', label: 'Excel', onClick: () => handleExportSelected({ format: 'xlsx' }, record).catch(console.error) },
                { key: 'exp-json', label: 'JSON', onClick: () => handleExportSelected({ format: 'json' }, record).catch(console.error) },
                { key: 'exp-md', label: 'Markdown', onClick: () => handleExportSelected({ format: 'md' }, record).catch(console.error) },
                { key: 'exp-html', label: 'HTML', onClick: () => handleExportSelected({ format: 'html' }, record).catch(console.error) },
            ]
        }
    ];

    return (
        <Dropdown menu={{ items: menuItems }} trigger={['contextMenu']} getPopupContainer={() => document.body} autoAdjustOverflow>
            <tr {...props}>{children}</tr>
        </Dropdown>
    );
});

interface DataGridProps {
    data: any[];
    columnNames: string[];
    loading: boolean;
    tableName?: string;
    /** Optional display-state identity for query results without a physical table. */
    columnPinScope?: string;
    objectType?: 'table' | 'view' | 'materialized-view';
    exportScope?: 'table' | 'queryResult';
    resultSql?: string;
    resultExportAllSql?: string;
    dbName?: string;
    /** DDL 查询使用的数据库/命名空间；查询结果页不复用列元数据目标。 */
    ddlDbName?: string;
    /** DDL 查询使用的表名；查询结果页仅在该目标明确时显示 DDL 入口。 */
    ddlTableName?: string;
    connectionId?: string;
    pkColumns?: string[];
    editLocator?: EditRowLocator;
    readOnly?: boolean;
    showRowNumberColumn?: boolean;
    onReload?: () => void;
    onSort?: (field: string, order: string) => void;
    onPageChange?: (page: number, size: number) => void;
    onLastPage?: (pageSize: number) => void;
    pagination?: {
        current: number,
        pageSize: number,
        total: number,
        totalKnown?: boolean,
        totalApprox?: boolean,
        approximateTotal?: number,
        totalCountLoading?: boolean,
        totalCountCancelled?: boolean,
    };
    onRequestTotalCount?: () => void;
    onCancelTotalCount?: () => void;
    sortInfoExternal?: Array<{ columnKey: string, order: string, enabled?: boolean }>;
    // Filtering
    showFilter?: boolean;
    onToggleFilter?: () => void;
    exportSqlWithFilter?: string;
    onApplyFilter?: (conditions: GridFilterCondition[]) => void;
    appliedFilterConditions?: FilterCondition[];
    quickWhereCondition?: string;
    onApplyQuickWhereCondition?: (condition: string) => void;
    scrollSnapshot?: { top: number; left: number };
    onScrollSnapshotChange?: (snapshot: { top: number; left: number }) => void;
    toolbarExtraActions?: React.ReactNode;
    isActive?: boolean;
    enableSqlLogEvent?: boolean;
    initialViewMode?: GridViewMode;
    initialViewModeRequestId?: string;
    initialViewModeScope?: 'shared' | 'local';
    onDataViewActivate?: () => void;
    onDataChange?: (rows: any[]) => void;
}

type GridFilterCondition = FilterCondition & {
    id: number;
    column: string;
    op: string;
    value: string;
    value2?: string;
};

type GridViewMode = 'table' | 'json' | 'text' | 'fields' | 'ddl' | 'er' | 'sqlLog';
type DdlViewLayoutMode = 'bottom' | 'side';
type DataGridExportScope = 'selected' | 'page' | 'all' | 'filteredAll';
type VirtualEditingCellState = {
    sessionId: number;
    rowKey: string;
    dataIndex: string;
    title: React.ReactNode;
    columnType?: string;
};

type ColumnMeta = {
    type: string;
    comment: string;
    nullable: string;
    default: string;
    hasDefault: boolean;
    extra: string;
};

const buildColumnMetaMap = (columns: ColumnDefinition[]): Record<string, ColumnMeta> => {
    const nextMap: Record<string, ColumnMeta> = {};
    (columns || []).forEach((column: any) => {
        const name = getColumnDefinitionName(column);
        if (!name) return;
        nextMap[name] = {
            type: getColumnDefinitionType(column),
            comment: getColumnDefinitionComment(column),
            nullable: getColumnDefinitionNullable(column),
            default: getColumnDefinitionDefault(column),
            hasDefault: hasColumnDefinitionDefault(column),
            extra: getColumnDefinitionExtra(column),
        };
    });
    return nextMap;
};

const hasUsableColumnMeta = (metaMap: Record<string, ColumnMeta>): boolean => (
    Object.values(metaMap || {}).some((meta) => {
        const type = String(meta?.type || '').trim();
        const comment = String(meta?.comment || '').trim();
        return type.length > 0 || comment.length > 0;
    })
);

export const shouldOmitBlankDataGridInsertValue = (
    value: unknown,
    mode: 'insert' | 'update',
    meta?: Partial<ColumnMeta>,
): boolean => {
    if (mode !== 'insert' || typeof value !== 'string' || value.trim() !== '') {
        return false;
    }
    const extra = String(meta?.extra || '').trim().toLowerCase();
    return meta?.hasDefault === true
        || String(meta?.default || '').trim() !== ''
        || extra.includes('auto_increment')
        || extra.includes('identity');
};

type ForeignKeyTarget = {
    columnName: string;
    refTableName: string;
    refColumnName: string;
    constraintName: string;
};

type VirtualTableScrollReference = TableReference & {
    scrollTo: (config: { left?: number; top?: number; index?: number; key?: React.Key }) => void;
};

const EXACT_GRID_FILTER_OPERATOR = '=';
const CONTAINS_GRID_FILTER_OPERATOR = 'CONTAINS';
const FILTER_FIELD_SELECT_STYLE: React.CSSProperties = {
    width: 320,
    flex: '0 1 320px',
    minWidth: 260,
    maxWidth: 'min(460px, 100%)',
};
const FILTER_FIELD_POPUP_WIDTH = 520;
const FILTER_FIELD_OPTION_STYLE: React.CSSProperties = {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
};
const STRING_LIKE_GRID_FILTER_TYPES = new Set([
    'bpchar',
    'char',
    'character',
    'character varying',
    'citext',
    'clob',
    'fixedstring',
    'long nvarchar',
    'long varchar',
    'longtext',
    'mediumtext',
    'nchar',
    'nclob',
    'ntext',
    'nvarchar',
    'nvarchar2',
    'string',
    'text',
    'tinytext',
    'varchar',
    'varchar2',
]);

const normalizeGridFilterColumnType = (columnType: unknown): string => {
    let normalized = String(columnType ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    for (let i = 0; i < 4; i += 1) {
        const wrapped = normalized.match(/^(?:nullable|lowcardinality)\((.+)\)$/);
        if (!wrapped) break;
        normalized = wrapped[1].trim().replace(/\s+/g, ' ');
    }
    return normalized;
};

export const isStringLikeGridFilterColumnType = (columnType: unknown): boolean => {
    const normalized = normalizeGridFilterColumnType(columnType);
    if (!normalized) return false;
    const baseType = normalized.replace(/\(.*/, '').trim();
    return STRING_LIKE_GRID_FILTER_TYPES.has(baseType);
};

export const resolveDefaultGridFilterOperator = (columnType: unknown): string => (
    isStringLikeGridFilterColumnType(columnType) ? CONTAINS_GRID_FILTER_OPERATOR : EXACT_GRID_FILTER_OPERATOR
);

export const resolveNextGridFilterOperatorForColumnChange = ({
    currentOperator,
    previousColumnType,
    nextColumnType,
}: {
    currentOperator: unknown;
    previousColumnType: unknown;
    nextColumnType: unknown;
}): string => {
    const current = String(currentOperator || '').trim();
    if (!current) return resolveDefaultGridFilterOperator(nextColumnType);
    const previousDefault = resolveDefaultGridFilterOperator(previousColumnType);
    return current === previousDefault ? resolveDefaultGridFilterOperator(nextColumnType) : current;
};

export const buildGridFieldSelectOptions = (columnNames: string[]) => (
    (columnNames || []).map((columnName) => {
        const text = String(columnName || '');
        return {
            value: text,
            label: text,
            title: text,
        };
    })
);

const renderGridFieldSelectOption = (option: { label?: React.ReactNode; value?: unknown; title?: unknown }) => {
    const text = String(option?.title ?? option?.label ?? option?.value ?? '');
    return (
        <span title={text} style={FILTER_FIELD_OPTION_STYLE}>
            {text}
        </span>
    );
};

type NormalizeCommitCellValue = (columnName: string, value: any, mode: 'insert' | 'update') => any;

type DataGridCommitChangeSet = {
    inserts: any[];
    updates: any[];
    deletes: any[];
};

export const buildDataGridCommitChangeSet = ({
    addedRows,
    modifiedRows,
    deletedRowKeys,
    data,
    editLocator,
    visibleColumnNames,
    rowKeyToString,
    normalizeCommitCellValue,
    shouldCommitColumn,
    rowLocatorMessages,
}: {
    addedRows: any[];
    modifiedRows: Record<string, any>;
    deletedRowKeys: Set<string>;
    data: any[];
    editLocator?: EditRowLocator;
    visibleColumnNames: string[];
    rowKeyToString: (key: any) => string;
    normalizeCommitCellValue: NormalizeCommitCellValue;
    shouldCommitColumn: (columnName: string) => boolean;
    rowLocatorMessages?: RowLocatorMessages;
}): { ok: true; changes: DataGridCommitChangeSet } | { ok: false; error: string } => {
    if (!editLocator || editLocator.readOnly || editLocator.strategy === 'none') {
        return { ok: false, error: editLocator?.reason || rowLocatorMessages?.noSafeLocator?.() || 'No safe row locator is available for this result set.' };
    }

    const normalizeValues = (values: Record<string, any>, mode: 'insert' | 'update') => {
        const normalizedValues: Record<string, any> = {};
        Object.entries(values).forEach(([col, val]) => {
            if (!shouldCommitColumn(col)) return;
            const commitColumnName = resolveWritableColumnName(col, editLocator);
            if (!commitColumnName) return;
            const normalizedVal = normalizeCommitCellValue(col, val, mode);
            if (normalizedVal !== undefined) {
                normalizedValues[commitColumnName] = normalizedVal;
            }
        });
        return normalizedValues;
    };

    const originalRowsByKey = new Map<string, any>();
    data.forEach((row) => {
        const key = row?.[GONAVI_ROW_KEY];
        if (key === undefined || key === null) return;
        originalRowsByKey.set(rowKeyToString(key), row);
    });

    const inserts: any[] = [];
    const updates: any[] = [];
    const deletes: any[] = [];

    addedRows.forEach(row => {
        const key = row?.[GONAVI_ROW_KEY];
        if (key !== undefined && key !== null && deletedRowKeys.has(rowKeyToString(key))) return;
        inserts.push(normalizeValues(row, 'insert'));
    });

    for (const keyStr of deletedRowKeys) {
        const originalRow = originalRowsByKey.get(keyStr);
        if (!originalRow) continue;
        const locatorValues = resolveRowLocatorValues(editLocator, originalRow, rowLocatorMessages);
        if (!locatorValues.ok) return { ok: false, error: locatorValues.error };
        deletes.push(locatorValues.values);
    }

    for (const [keyStr, newRow] of Object.entries(modifiedRows)) {
        if (deletedRowKeys.has(keyStr)) continue;
        const originalRow = originalRowsByKey.get(keyStr);
        if (!originalRow) continue;

        const locatorValues = resolveRowLocatorValues(editLocator, originalRow, rowLocatorMessages);
        if (!locatorValues.ok) return { ok: false, error: locatorValues.error };

        const hasRowKey = Object.prototype.hasOwnProperty.call(newRow as any, GONAVI_ROW_KEY);
        let values: Record<string, any> = {};
        if (!hasRowKey) {
            values = { ...(newRow as any) };
        } else {
            visibleColumnNames.forEach((col) => {
                const nextVal = (newRow as any)?.[col];
                const prevVal = (originalRow as any)?.[col];
                if (!isCellValueEqualForDiff(prevVal, nextVal)) values[col] = nextVal;
            });
        }

        const normalizedValues = normalizeValues(values, 'update');
        if (Object.keys(normalizedValues).length === 0) continue;
        updates.push({ keys: locatorValues.values, values: normalizedValues });
    }

    return { ok: true, changes: { inserts, updates, deletes } };
};

// P2 性能优化：提取内联 style 对象为模块级常量，避免每次 render 创建新对象
const CELL_ELLIPSIS_STYLE: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, width: '100%' };
const VIRTUAL_CELL_TEXT_STYLE: React.CSSProperties = {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    width: '100%',
};
const READONLY_CELL_WRAP_STYLE: React.CSSProperties = { minHeight: 20, display: 'flex', alignItems: 'center', width: '100%', minWidth: 0 };
const INLINE_EDIT_FORM_ITEM_STYLE: React.CSSProperties = { margin: 0, width: '100%', minWidth: 0 };
const VIRTUAL_EDITING_CELL_STYLE: React.CSSProperties = {
    margin: 0,
    padding: 0,
    display: 'flex',
    flex: '1 1 auto',
    alignItems: 'center',
    width: '100%',
    minWidth: 0,
    minHeight: 'calc(28px * var(--gn-ui-scale, 1))',
    height: 'calc(28px * var(--gn-ui-scale, 1))',
    overflow: 'visible',
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
};


export {
    DataGridErrorBoundary,
    CELL_KEY_SEP,
    CELL_SELECTION_DRAG_THRESHOLD_PX,
    DATE_TIME_CACHE_LIMIT,
    TABLE_CELL_PREVIEW_MAX_CHARS,
    ROW_NUMBER_COLUMN_WIDTH,
    DATA_EDIT_AUTO_COMMIT_DELAY_OPTIONS,
    DATA_GRID_DISPLAY_RENDER_VERSION,
    DATA_GRID_VIRTUAL_EDIT_RENDER_VERSION,
    DEFAULT_GRID_MONO_FONT_FAMILY,
    normalizedDateTimeCache,
    objectCellPreviewCache,
    useDataGridI18nLanguage,
    makeCellKey,
    splitCellKey,
    collectDataGridCellSelectionRowKeys,
    trimSimpleCache,
    looksLikeDateTimeText,
    normalizeDateTimeString,
    normalizeBitHexDisplayText,
    isDateOnlyColumnType,
    isOceanBaseOracleDisplayConnection,
    normalizeOceanBaseOracleDateDisplayText,
    formatClipboardCellText,
    normalizeClipboardTsvCell,
    buildClipboardTsv,
    renderHighlightedCellText,
    renderCellDisplayValue,
    formatCellValue,
    toEditableText,
    toFormText,
    isCellValueEqualForDiff,
    isCellValueEqualForRender,
    INLINE_EDIT_MAX_CHARS,
    shouldOpenModalEditor,
    getCellFieldName,
    setCellFieldValue,
    looksLikeJsonText,
    isPlainObject,
    normalizeValueForJsonView,
    isJsonViewValueEqual,
    coerceJsonEditorValueForStorage,
    ResizableTitle,
    sortableHeaderStaticStyles,
    SortableHeaderCell,
    EditableContext,
    CellContextMenuContext,
    DataContext,
    setGlobalDeletedRowKeys,
    resolveEditableCellRowKey,
    isEditableCellDeleted,
    isEditableCellModified,
    areEditableCellPropsEqual,
    EditableCell,
    ContextMenuRow,
    buildColumnMetaMap,
    hasUsableColumnMeta,
    EXACT_GRID_FILTER_OPERATOR,
    CONTAINS_GRID_FILTER_OPERATOR,
    FILTER_FIELD_SELECT_STYLE,
    FILTER_FIELD_POPUP_WIDTH,
    FILTER_FIELD_OPTION_STYLE,
    STRING_LIKE_GRID_FILTER_TYPES,
    normalizeGridFilterColumnType,
    renderGridFieldSelectOption,
    CELL_ELLIPSIS_STYLE,
    VIRTUAL_CELL_TEXT_STYLE,
    READONLY_CELL_WRAP_STYLE,
    INLINE_EDIT_FORM_ITEM_STYLE,
    VIRTUAL_EDITING_CELL_STYLE,
};

export type {
    DataGridErrorBoundaryState,
    DataGridErrorBoundaryProps,
    CellDisplayConnectionLike,
    SortableHeaderCellProps,
    Item,
    EditableCellProps,
    DataGridProps,
    GridFilterCondition,
    GridViewMode,
    DdlViewLayoutMode,
    DataGridExportScope,
    VirtualEditingCellState,
    ColumnMeta,
    ForeignKeyTarget,
    VirtualTableScrollReference,
    NormalizeCommitCellValue,
    DataGridCommitChangeSet,
};
