import React, { useState, useEffect, useRef, useContext, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Table, message, Input, Button, Dropdown, MenuProps, Form, Pagination, Select, Modal, Checkbox, Segmented } from 'antd';
import type { SortOrder } from 'antd/es/table/interface';
import { ReloadOutlined, ImportOutlined, ExportOutlined, DownOutlined, PlusOutlined, DeleteOutlined, SaveOutlined, UndoOutlined, FilterOutlined, CloseOutlined, ConsoleSqlOutlined, FileTextOutlined, CopyOutlined, ClearOutlined, EditOutlined, VerticalAlignBottomOutlined } from '@ant-design/icons';
import Editor from '@monaco-editor/react';
import { ImportData, ExportTable, ExportData, ExportQuery, ApplyChanges } from '../../wailsjs/go/app/App';
import ImportPreviewModal from './ImportPreviewModal';
import { useStore } from '../store';
import { v4 as uuidv4 } from 'uuid';
import 'react-resizable/css/styles.css';
import { buildWhereSQL, escapeLiteral, quoteIdentPart, quoteQualifiedIdent, type FilterCondition } from '../utils/sql';
import { isMacLikePlatform, normalizeOpacityForPlatform } from '../utils/appearance';

// --- Error Boundary ---
interface DataGridErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
}

class DataGridErrorBoundary extends React.Component<
    { children: React.ReactNode },
    DataGridErrorBoundaryState
> {
    constructor(props: { children: React.ReactNode }) {
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
                    <h4>渲染错误</h4>
                    <p>数据表格渲染时发生错误，可能是数据格式问题。</p>
                    <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                        {this.state.error?.message}
                    </pre>
                    <Button
                        size="small"
                        onClick={() => this.setState({ hasError: false, error: null })}
                    >
                        重试
                    </Button>
                </div>
            );
        }
        return this.props.children;
    }
}

// 内部行标识字段：避免与真实业务字段（如 `key` 列）冲突。
export const GONAVI_ROW_KEY = '__gonavi_row_key__';

// Cell key helpers for batch selection/fill.
// Use a control character separator to avoid collisions with rowKey/columnName contents (e.g. `new-123`).
const CELL_KEY_SEP = '\u0001';
const makeCellKey = (rowKey: string, colName: string) => `${rowKey}${CELL_KEY_SEP}${colName}`;
const splitCellKey = (cellKey: string): { rowKey: string; colName: string } | null => {
    const sepIndex = cellKey.indexOf(CELL_KEY_SEP);
    if (sepIndex === -1) return null;
    return {
        rowKey: cellKey.slice(0, sepIndex),
        colName: cellKey.slice(sepIndex + CELL_KEY_SEP.length),
    };
};

// Normalize common datetime strings to `YYYY-MM-DD HH:mm:ss` for display/editing.
// Handles RFC3339 and Go-style datetime text like `2024-05-13 08:32:47 +0800 CST`.
// Also keep invalid datetime values like `0000-00-00 00:00:00` unchanged.
const normalizeDateTimeString = (val: string) => {
    // 检查是否为无效日期时间（0000-00-00 或类似格式）
    if (/^0{4}-0{2}-0{2}/.test(val)) {
        return val; // 保持原样显示，不尝试转换
    }

    const match = val.match(
        /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:\s*(?:Z|[+-]\d{2}:?\d{2})(?:\s+[A-Za-z_\/+-]+)?)?$/
    );
    if (!match) return val;
    return `${match[1]} ${match[2]}`;
};

// --- Helper: Format Value ---
const formatCellValue = (val: any) => {
    try {
        if (val === null) return <span style={{ color: '#ccc' }}>NULL</span>;
        if (typeof val === 'object') {
            try {
                return JSON.stringify(val);
            } catch {
                return '[Object]';
            }
        }
        if (typeof val === 'string') {
            return normalizeDateTimeString(val);
        }
        return String(val);
    } catch (e) {
        console.error('formatCellValue error:', e);
        return '[Error]';
    }
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
    const leftNullish = left === null || left === undefined;
    const rightNullish = right === null || right === undefined;
    if (leftNullish || rightNullish) return leftNullish && rightNullish;
    return toFormText(left) === toFormText(right);
};

const INLINE_EDIT_MAX_CHARS = 2000;

const shouldOpenModalEditor = (val: any): boolean => {
    if (val === null || val === undefined) return false;
    if (typeof val === 'string') {
        if (val.length > INLINE_EDIT_MAX_CHARS || val.includes('\n')) return true;
        const trimmed = val.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) return true;
        return false;
    }
    if (typeof val === 'object') {
        return true;
    }
    return false;
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
const ResizableTitle = (props: any) => {
  const { onResizeStart, width, ...restProps } = props;

  const nextStyle = { ...(restProps.style || {}) } as React.CSSProperties;
  if (width) {
    nextStyle.width = width;
  }

  // 注意：virtual table 模式下，rc-table 会依赖 header cell 的 width 样式来渲染选择列。
  // 若这里丢失 width，可能导致左上角“全选”checkbox 不显示。
  if (!width || typeof onResizeStart !== 'function') {
    return <th {...restProps} style={nextStyle} />;
  }

  return (
    <th {...restProps} style={{ ...nextStyle, position: 'relative' }}>
      {restProps.children}
      <span
        className="react-resizable-handle"
        onMouseDown={(e) => {
            e.stopPropagation();
            // Pass the header element reference implicitly via event target
            onResizeStart(e);
        }}
        onClick={(e) => e.stopPropagation()}
        style={{
            position: 'absolute',
            right: 0, // Align to right edge
            bottom: 0,
            top: 0,
            width: 10,
            cursor: 'col-resize',
            zIndex: 10,
            touchAction: 'none'
        }}
      />
    </th>
  );
};

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
    handleCopyJson: (r: any) => void;
    handleCopyCsv: (r: any) => void;
    handleExportSelected: (format: string, r: any) => void;
    copyToClipboard: (t: string) => void;
    tableName?: string;
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
  [key: string]: any;
}

const EditableCell: React.FC<EditableCellProps> = React.memo(({
  title,
  editable,
  children,
  dataIndex,
  record,
  handleSave,
  focusCell,
  ...restProps
}) => {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<any>(null);
  const form = useContext(EditableContext);
  const cellContextMenuContext = useContext(CellContextMenuContext);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
    }
  }, [editing]);

  const toggleEdit = () => {
    setEditing(!editing);
    const raw = record[dataIndex];
    const initialValue = typeof raw === 'string' ? normalizeDateTimeString(raw) : raw;
    const fieldName = getCellFieldName(record, dataIndex);
    setCellFieldValue(form, fieldName, initialValue);
  };

  const save = async () => {
    try {
      if (!form) return;
      const fieldName = getCellFieldName(record, dataIndex);
      await form.validateFields([fieldName]);
      const nextValue = form.getFieldValue(fieldName);
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
    }
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!editable) return;
    e.preventDefault();
    e.stopPropagation(); // 阻止冒泡到行级菜单
    if (cellContextMenuContext) {
      cellContextMenuContext.showMenu(e, record, dataIndex, title);
    }
  };

  let childNode = children;

  if (editable) {
    childNode = editing ? (
      <Form.Item style={{ margin: 0 }} name={getCellFieldName(record, dataIndex)}>
        <Input
          ref={inputRef}
          onPressEnter={save}
          onBlur={save}
          onFocus={(e) => {
            // Enter 编辑态时直接全选，便于快速替换；同时避免双击在 input 内冒泡导致关闭编辑态。
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
      </Form.Item>
    ) : (
      <div
        className="editable-cell-value-wrap"
        style={{ paddingRight: 24, minHeight: 20, position: 'relative' }}
        onContextMenu={handleContextMenu}
      >
        {children}
      </div>
    );
  }

  const handleDoubleClick = () => {
      if (!editable) return;
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
      <td
          {...restProps}
          data-row-key={record ? String(record?.[GONAVI_ROW_KEY]) : undefined}
          data-col-name={dataIndex || undefined}
          onDoubleClick={editable ? handleDoubleClick : restProps?.onDoubleClick}
      >
          {childNode}
      </td>
  );
});

const ContextMenuRow = React.memo(({ children, record, ...props }: any) => {
    const context = useContext(DataContext);
    
    if (!record || !context) return <tr {...props}>{children}</tr>;

    const { selectedRowKeysRef, displayDataRef, handleCopyInsert, handleCopyJson, handleCopyCsv, handleExportSelected, copyToClipboard } = context;

    const getTargets = () => {
        const keys = selectedRowKeysRef.current;
        const recordKey = record?.[GONAVI_ROW_KEY];
        if (recordKey !== undefined && keys.includes(recordKey)) {
            return displayDataRef.current.filter(d => keys.includes(d?.[GONAVI_ROW_KEY]));
        }
        return [record];
    };

    const menuItems: MenuProps['items'] = [
        { 
            key: 'insert', 
            label: `复制为 INSERT`, 
            icon: <ConsoleSqlOutlined />, 
            onClick: () => handleCopyInsert(record) 
        },
        { key: 'json', label: '复制为 JSON', icon: <FileTextOutlined />, onClick: () => handleCopyJson(record) },
        { key: 'csv', label: '复制为 CSV', icon: <FileTextOutlined />, onClick: () => handleCopyCsv(record) },
        { key: 'copy', label: '复制为 Markdown', icon: <CopyOutlined />, onClick: () => { 
            const records = getTargets();
            const lines = records.map((r: any) => {
                const { [GONAVI_ROW_KEY]: _rowKey, ...vals } = r;
                return `| ${Object.values(vals).join(' | ')} |`;
            });
            copyToClipboard(lines.join('\n'));
        } },
        { type: 'divider' },
        {
            key: 'export-selected',
            label: '导出选中数据',
            icon: <ExportOutlined />,
            children: [
                { key: 'exp-csv', label: 'CSV', onClick: () => handleExportSelected('csv', record) },
                { key: 'exp-xlsx', label: 'Excel', onClick: () => handleExportSelected('xlsx', record) },
                { key: 'exp-json', label: 'JSON', onClick: () => handleExportSelected('json', record) },
                { key: 'exp-md', label: 'Markdown', onClick: () => handleExportSelected('md', record) },
            ]
        }
    ];

    return (
        <Dropdown menu={{ items: menuItems }} trigger={['contextMenu']}>
            <tr {...props}>{children}</tr>
        </Dropdown>
    );
});

interface DataGridProps {
    data: any[];
    columnNames: string[];
    loading: boolean;
    tableName?: string;
    dbName?: string;
    connectionId?: string;
    pkColumns?: string[];
    readOnly?: boolean;
    onReload?: () => void;
    onSort?: (field: string, order: string) => void;
    onPageChange?: (page: number, size: number) => void;
    pagination?: { current: number, pageSize: number, total: number, totalKnown?: boolean };
    // Filtering
    showFilter?: boolean;
    onToggleFilter?: () => void;
    onApplyFilter?: (conditions: GridFilterCondition[]) => void;
}

type GridFilterCondition = FilterCondition & {
    id: number;
    column: string;
    op: string;
    value: string;
    value2?: string;
};

type GridViewMode = 'table' | 'json' | 'text';

const DataGrid: React.FC<DataGridProps> = ({ 
    data, columnNames, loading, tableName, dbName, connectionId, pkColumns = [], readOnly = false,
    onReload, onSort, onPageChange, pagination, showFilter, onToggleFilter, onApplyFilter
}) => {
  const connections = useStore(state => state.connections);
  const addSqlLog = useStore(state => state.addSqlLog);
  const theme = useStore(state => state.theme);
  const appearance = useStore(state => state.appearance);
  const isMacLike = useMemo(() => isMacLikePlatform(), []);
  const darkMode = theme === 'dark';
  const opacity = normalizeOpacityForPlatform(appearance.opacity);
  const canModifyData = !readOnly && !!tableName;
  const selectionColumnWidth = 46;

  // Background Helper
  const getBg = (darkHex: string) => {
      if (!darkMode) return `rgba(255, 255, 255, ${opacity})`;
      const hex = darkHex.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  };
  const bgContent = getBg('#1d1d1d');
  const bgFilter = getBg('#262626');
  const bgContextMenu = getBg('#1f1f1f');
  
  // Row Colors with Opacity
  const getRowBg = (r: number, g: number, b: number) => `rgba(${r}, ${g}, ${b}, ${opacity})`;
  const rowAddedBg = darkMode ? getRowBg(22, 43, 22) : getRowBg(246, 255, 237);
  const rowModBg = darkMode ? getRowBg(22, 34, 56) : getRowBg(230, 247, 255);
  const rowAddedHover = darkMode ? getRowBg(31, 61, 31) : getRowBg(217, 247, 190);
  const rowModHover = darkMode ? getRowBg(29, 53, 94) : getRowBg(186, 231, 255);
  
  const [form] = Form.useForm();
  const [modal, contextHolder] = Modal.useModal();
  const gridId = useMemo(() => `grid-${uuidv4()}`, []);
  const [viewMode, setViewMode] = useState<GridViewMode>('table');
  const [textRecordIndex, setTextRecordIndex] = useState(0);
  const [cellEditorOpen, setCellEditorOpen] = useState(false);
  const [cellEditorValue, setCellEditorValue] = useState('');
  const [cellEditorIsJson, setCellEditorIsJson] = useState(false);
  const [cellEditorMeta, setCellEditorMeta] = useState<{ record: Item; dataIndex: string; title: string } | null>(null);
  const cellEditorApplyRef = useRef<((val: string) => void) | null>(null);
  const [jsonEditorOpen, setJsonEditorOpen] = useState(false);
  const [jsonEditorValue, setJsonEditorValue] = useState('');
  const [rowEditorOpen, setRowEditorOpen] = useState(false);
  const [rowEditorRowKey, setRowEditorRowKey] = useState<string>('');
  const rowEditorBaseRawRef = useRef<Record<string, any>>({});
  const rowEditorDisplayRef = useRef<Record<string, string>>({});
  const rowEditorNullColsRef = useRef<Set<string>>(new Set());
  const [rowEditorForm] = Form.useForm();

  // Cell Context Menu State
  const [cellContextMenu, setCellContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    record: Item | null;
    dataIndex: string;
    title: string;
  }>({
    visible: false,
    x: 0,
    y: 0,
    record: null,
    dataIndex: '',
    title: '',
  });
  const [cellSetValueInput, setCellSetValueInput] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const pendingScrollToBottomRef = useRef(false);

  // 批量编辑模式状态
  const [cellEditMode, setCellEditMode] = useState(false);
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const [batchEditModalOpen, setBatchEditModalOpen] = useState(false);
  const [batchEditValue, setBatchEditValue] = useState('');
  const [batchEditSetNull, setBatchEditSetNull] = useState(false);

  // 使用 ref 来优化拖拽性能，完全避免状态更新
  const cellSelectionRafRef = useRef<number | null>(null);
  const cellSelectionScrollRafRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);

  // 导入预览 Modal 状态
  const [importPreviewVisible, setImportPreviewVisible] = useState(false);
  const [importFilePath, setImportFilePath] = useState('');
  const currentSelectionRef = useRef<Set<string>>(new Set());
  const selectionStartRef = useRef<{ rowKey: string; colName: string; rowIndex: number; colIndex: number } | null>(null);
  const rowIndexMapRef = useRef<Map<string, number>>(new Map());

  const scrollTableBodyToBottom = useCallback(() => {
      const root = containerRef.current;
      if (!root) return;
      const body = root.querySelector('.ant-table-body') as HTMLElement | null;
      if (!body) return;
      body.scrollTop = body.scrollHeight;
  }, []);

  // Close cell context menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (cellContextMenu.visible) {
        setCellContextMenu(prev => ({ ...prev, visible: false }));
      }
      // Remove focus from any focused cell when clicking outside the table
      const target = e.target as HTMLElement;
      const tableContainer = containerRef.current;
      if (tableContainer && !tableContainer.contains(target)) {
        // Remove focus from any input elements in the table
        const focusedElement = document.activeElement as HTMLElement;
        if (focusedElement && focusedElement.tagName === 'INPUT' && tableContainer.contains(focusedElement)) {
          focusedElement.blur();
        }
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [cellContextMenu.visible]);

  const showCellContextMenu = useCallback((e: React.MouseEvent, record: Item, dataIndex: string, title: React.ReactNode) => {
    e.preventDefault();
    e.stopPropagation();
    const titleText = typeof title === 'string' ? title : (typeof title === 'number' ? String(title) : String(dataIndex));
    setCellContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      record,
      dataIndex,
      title: titleText,
    });
    setCellSetValueInput(toFormText(record[dataIndex]));
  }, []);

  // Helper to export specific data
  const exportData = async (rows: any[], format: string) => {
      const hide = message.loading(`正在导出 ${rows.length} 条数据...`, 0);
      const cleanRows = rows.map(({ [GONAVI_ROW_KEY]: _rowKey, ...rest }) => rest);
      // Pass tableName (or 'export') as default filename
      const res = await ExportData(cleanRows, columnNames, tableName || 'export', format);
      hide();
      if (res.success) { message.success("导出成功"); } else if (res.message !== "Cancelled") { message.error("导出失败: " + res.message); }
  };
  
  const [sortInfo, setSortInfo] = useState<{ columnKey: string, order: string } | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});

  const closeCellEditor = useCallback(() => {
      setCellEditorOpen(false);
      setCellEditorMeta(null);
      setCellEditorValue('');
      setCellEditorIsJson(false);
      cellEditorApplyRef.current = null;
  }, []);

  const openCellEditor = useCallback((record: Item, dataIndex: string, title: React.ReactNode, onApplyValue?: (val: string) => void) => {
      if (!record || !dataIndex) return;
      const raw = record?.[dataIndex];
      const text = toEditableText(raw);
      const isJson = looksLikeJsonText(text);
      const titleText = typeof title === 'string' ? title : (typeof title === 'number' ? String(title) : String(dataIndex));

      setCellEditorMeta({ record, dataIndex, title: titleText });
      setCellEditorValue(text);
      setCellEditorIsJson(isJson);
      setCellEditorOpen(true);
      cellEditorApplyRef.current = typeof onApplyValue === 'function' ? onApplyValue : null;
  }, []);

  // Dynamic Height
  const [tableHeight, setTableHeight] = useState(500);
  const [tableViewportWidth, setTableViewportWidth] = useState(0);
  const [tableBodyBottomPadding, setTableBodyBottomPadding] = useState(0);
  const recalculateTableMetrics = useCallback((targetElement?: HTMLElement | null) => {
      const target = targetElement || containerRef.current;
      if (!target) return;

      const height = target.getBoundingClientRect().height;
      const width = target.getBoundingClientRect().width;
      if (!Number.isFinite(height) || height < 50) return;
      if (Number.isFinite(width) && width > 0) {
          setTableViewportWidth(Math.floor(width));
      }

      const headerEl =
          (target.querySelector('.ant-table-header') as HTMLElement | null) ||
          (target.querySelector('.ant-table-thead') as HTMLElement | null);
      const rawHeaderHeight = headerEl ? headerEl.getBoundingClientRect().height : NaN;
      const headerHeight =
          Number.isFinite(rawHeaderHeight) && rawHeaderHeight >= 24 && rawHeaderHeight <= 120 ? rawHeaderHeight : 42;

      const bodyEl = target.querySelector('.ant-table-body') as HTMLElement | null;
      const stickyScrollEl = target.querySelector('.ant-table-sticky-scroll') as HTMLElement | null;
      const hasHorizontalOverflow = !!bodyEl && (bodyEl.scrollWidth - bodyEl.clientWidth > 1);
      const nativeHorizontalScrollbarHeight = bodyEl ? Math.max(0, Math.ceil(bodyEl.offsetHeight - bodyEl.clientHeight)) : 0;
      const stickyScrollHeight = stickyScrollEl ? Math.ceil(stickyScrollEl.getBoundingClientRect().height) : 0;
      // 动态为横向滚动条（含 sticky 条）预留空间，避免最后一行被遮住。
      const horizontalReserve = hasHorizontalOverflow
          ? Math.max(nativeHorizontalScrollbarHeight, stickyScrollHeight, 14)
          : Math.max(nativeHorizontalScrollbarHeight, 0);
      // sticky 横向滚动条会覆盖在表格底部，额外给 body 增加内边距，确保最后一行完整可见。
      const nextBodyBottomPadding = hasHorizontalOverflow
          ? Math.max(stickyScrollHeight, nativeHorizontalScrollbarHeight, 14) + 6
          : 0;
      setTableBodyBottomPadding(nextBodyBottomPadding);
      const extraBottom = 10 + horizontalReserve;
      const nextHeight = Math.max(100, Math.floor(height - headerHeight - extraBottom));
      setTableHeight(nextHeight);
  }, []);

  useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      let rafId: number | null = null;

      const resizeObserver = new ResizeObserver(entries => {
          if (rafId !== null) cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(() => {
              const target = (entries[0]?.target as HTMLElement | undefined) || containerRef.current;
              recalculateTableMetrics(target);
          });
      });

      resizeObserver.observe(el);
      rafId = requestAnimationFrame(() => recalculateTableMetrics(el));
      return () => {
          resizeObserver.disconnect();
          if (rafId !== null) cancelAnimationFrame(rafId);
      };
  }, [recalculateTableMetrics]);

  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [addedRows, setAddedRows] = useState<any[]>([]);
  const [modifiedRows, setModifiedRows] = useState<Record<string, any>>({});
  const [deletedRowKeys, setDeletedRowKeys] = useState<Set<string>>(new Set());

  // Filter State
  const [filterConditions, setFilterConditions] = useState<GridFilterCondition[]>([]);
  const [nextFilterId, setNextFilterId] = useState(1);

  const selectedRowKeysRef = useRef(selectedRowKeys);
  const displayDataRef = useRef<any[]>([]);

  useEffect(() => { selectedRowKeysRef.current = selectedRowKeys; }, [selectedRowKeys]);

  useEffect(() => {
      if (!pendingScrollToBottomRef.current) return;
      pendingScrollToBottomRef.current = false;
      // 等待 Table 渲染出新增行后再滚动到底部（virtual 模式也适用）
      requestAnimationFrame(() => {
          scrollTableBodyToBottom();
          requestAnimationFrame(() => scrollTableBodyToBottom());
      });
  }, [addedRows.length, scrollTableBodyToBottom]);

  // Reset local state when data source likely changes (e.g. tableName change)
  useEffect(() => {
      setAddedRows([]);
      setModifiedRows({});
      setDeletedRowKeys(new Set());
      setSelectedRowKeys([]);
      setRowEditorOpen(false);
      setRowEditorRowKey('');
      rowEditorBaseRawRef.current = {};
      rowEditorDisplayRef.current = {};
      rowEditorNullColsRef.current = new Set();
      rowEditorForm.resetFields();
      closeCellEditor();
      form.resetFields();
  }, [tableName, dbName, connectionId]); // Reset on context change

  const rowKeyStr = useCallback((k: React.Key) => String(k), []);

  const columnIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    columnNames.forEach((name, idx) => map.set(name, idx));
    return map;
  }, [columnNames]);

  // 直接操作 DOM 更新选中效果，避免 React 重渲染
  const updateCellSelection = useCallback((newSelection: Set<string>) => {
    const tableBody = containerRef.current?.querySelector('.ant-table-body');
    if (!tableBody) return;

    // 只同步可见单元格（兼容 virtual 渲染 + 极大选区）
    const visibleCells = tableBody.querySelectorAll('td[data-row-key][data-col-name]');
    visibleCells.forEach((cell) => {
      const el = cell as HTMLElement;
      const rowKey = el.getAttribute('data-row-key');
      const colName = el.getAttribute('data-col-name');
      if (!rowKey || !colName) return;
      const key = makeCellKey(rowKey, colName);
      if (newSelection.has(key)) {
        if (el.getAttribute('data-cell-selected') !== 'true') el.setAttribute('data-cell-selected', 'true');
      } else {
        if (el.hasAttribute('data-cell-selected')) el.removeAttribute('data-cell-selected');
      }
    });
  }, []);

  // 批量填充选中的单元格
  const handleBatchFillCells = useCallback(() => {
    const cellsToFill = currentSelectionRef.current;
    if (cellsToFill.size === 0) {
      message.info('请先选择要填充的单元格');
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

      const existing = modifiedRows[rowKey];
      const baseRow = baseRowMap.get(rowKey);
      let currentVal: any = undefined;

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
      message.info('选中的单元格无需更新');
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

    message.success(`已填充 ${updatedCount} 个单元格`);
    setBatchEditModalOpen(false);

    // 清除选中状态
    setSelectedCells(new Set());
    currentSelectionRef.current = new Set();
    selectionStartRef.current = null;
    isDraggingRef.current = false;
    updateCellSelection(new Set());
  }, [batchEditValue, batchEditSetNull, addedRows, modifiedRows, rowKeyStr, updateCellSelection]);

  // 事件委托：在容器级别处理批量编辑模式的鼠标事件
  useEffect(() => {
    if (!cellEditMode) return;

    const container = containerRef.current;
    if (!container) return;

    const getCellInfo = (target: HTMLElement): { rowKey: string; colName: string } | null => {
      const td = target.closest('td[data-row-key][data-col-name]') as HTMLElement;
      if (!td) return null;
      const rowKey = td.getAttribute('data-row-key');
      const colName = td.getAttribute('data-col-name');
      if (!rowKey || !colName) return null;
      return { rowKey, colName };
    };

    const onMouseDown = (e: MouseEvent) => {
      const cellInfo = getCellInfo(e.target as HTMLElement);
      if (!cellInfo) return;

      e.preventDefault();
      isDraggingRef.current = true;
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
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current || !selectionStartRef.current) return;

      const cellInfo = getCellInfo(e.target as HTMLElement);
      if (!cellInfo) return;

      // 使用 RAF 节流
      if (cellSelectionRafRef.current !== null) {
        cancelAnimationFrame(cellSelectionRafRef.current);
      }

      cellSelectionRafRef.current = requestAnimationFrame(() => {
        cellSelectionRafRef.current = null;
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
            newSelectedCells.add(makeCellKey(rKey, columnNames[j]));
          }
        }

        currentSelectionRef.current = newSelectedCells;
        updateCellSelection(newSelectedCells);
      });
    };

    const onMouseUp = () => {
      if (!isDraggingRef.current) return;
      isDraggingRef.current = false;

      if (cellSelectionRafRef.current !== null) {
        cancelAnimationFrame(cellSelectionRafRef.current);
        cellSelectionRafRef.current = null;
      }

      if (currentSelectionRef.current.size > 0) {
        setSelectedCells(new Set(currentSelectionRef.current));
      }
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

    container.addEventListener('mousedown', onMouseDown);
    container.addEventListener('mousemove', onMouseMove);
    container.addEventListener('scroll', onScroll, true);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      container.removeEventListener('mousedown', onMouseDown);
      container.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('mouseup', onMouseUp);
      if (cellSelectionRafRef.current !== null) {
        cancelAnimationFrame(cellSelectionRafRef.current);
        cellSelectionRafRef.current = null;
      }
      if (cellSelectionScrollRafRef.current !== null) {
        cancelAnimationFrame(cellSelectionScrollRafRef.current);
        cellSelectionScrollRafRef.current = null;
      }
      isDraggingRef.current = false;
    };
  }, [cellEditMode, columnNames, columnIndexMap, updateCellSelection]);

  // 批量填充到选中行
  const handleBatchFillToSelected = useCallback((sourceRecord: Item, dataIndex: string) => {
    const sourceValue = sourceRecord[dataIndex];
    const selKeys = selectedRowKeysRef.current;

    if (selKeys.length === 0) {
      message.info('请先选择要填充的行');
      return;
    }

    const sourceKey = sourceRecord?.[GONAVI_ROW_KEY];
    // 过滤掉源行本身
    const targetKeys = selKeys.filter(k => k !== sourceKey);

    if (targetKeys.length === 0) {
      message.info('没有其他选中的行可以填充');
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

    message.success(`已填充 ${updatedCount} 行`);
    setCellContextMenu(prev => ({ ...prev, visible: false }));
  }, [addedRows, rowKeyStr]);

  const displayData = useMemo(() => {
      return [...data, ...addedRows].filter(item => {
          const k = item?.[GONAVI_ROW_KEY];
          return k === undefined ? true : !deletedRowKeys.has(rowKeyStr(k));
      });
  }, [data, addedRows, deletedRowKeys]);

  useEffect(() => { displayDataRef.current = displayData; }, [displayData]);

  const hasChanges = addedRows.length > 0 || Object.keys(modifiedRows).length > 0 || deletedRowKeys.size > 0;

  const handleTableChange = (pag: any, filtersArg: any, sorter: any) => {
      if (isResizingRef.current) return; // Block sort if resizing
      if (sorter.field) {
          const order = sorter.order as string;
          setSortInfo({ columnKey: sorter.field as string, order });
          if (onSort) onSort(sorter.field, order);
      } else {
          setSortInfo(null);
          if (onSort) onSort('', '');
      }
  };

    // Native Drag State
    const draggingRef = useRef<{
        startX: number,
        startWidth: number,
        key: string,
        containerLeft: number
    } | null>(null);
    const ghostRef = useRef<HTMLDivElement>(null);
    const resizeRafRef = useRef<number | null>(null);
    const latestClientXRef = useRef<number | null>(null);
    const isResizingRef = useRef(false); // Lock for sorting

    const flushGhostPosition = useCallback(() => {
        resizeRafRef.current = null;
        if (!draggingRef.current || !ghostRef.current) return;
        if (latestClientXRef.current === null) return;
        const relativeLeft = latestClientXRef.current - draggingRef.current.containerLeft;
        ghostRef.current.style.transform = `translateX(${relativeLeft}px)`;
    }, []);
  
        // 1. Drag Start
  
        const handleResizeStart = useCallback((key: string) => (e: React.MouseEvent) => {
  
            e.preventDefault(); 
  
            e.stopPropagation(); 
  
            
  
            isResizingRef.current = true; // Engage lock
  
      
  
            const startX = e.clientX;
  
            const currentWidth = columnWidths[key] || 200; 
  
            const containerLeft = containerRef.current?.getBoundingClientRect().left ?? 0;
  
            draggingRef.current = { startX, startWidth: currentWidth, key, containerLeft };
            latestClientXRef.current = startX;
  
      
  
            // Show Ghost Line at initial position
  
            if (ghostRef.current && containerRef.current) {
                const relativeLeft = startX - containerLeft;
                ghostRef.current.style.transform = `translateX(${relativeLeft}px)`;
  
                ghostRef.current.style.display = 'block';
  
            }
  
      
  
            // Add global listeners
  
            document.addEventListener('mousemove', handleResizeMove);
  
            document.addEventListener('mouseup', handleResizeStop);
  
            document.body.style.cursor = 'col-resize'; 
  
            document.body.style.userSelect = 'none'; 
  
        }, [columnWidths]);

  // 2. Drag Move (Global)
  const handleResizeMove = useCallback((e: MouseEvent) => {
      if (!draggingRef.current) return;
      latestClientXRef.current = e.clientX;
      if (resizeRafRef.current !== null) return;
      resizeRafRef.current = requestAnimationFrame(flushGhostPosition);
  }, [flushGhostPosition]);

  // 3. Drag Stop (Global)
  const handleResizeStop = useCallback((e: MouseEvent) => {
      if (!draggingRef.current) return;

      const { startX, startWidth, key } = draggingRef.current;
      const deltaX = e.clientX - startX;
      const newWidth = Math.max(50, startWidth + deltaX);

      // Commit State
      setColumnWidths(prev => ({ ...prev, [key]: newWidth }));

      // Cleanup
      if (resizeRafRef.current !== null) {
          cancelAnimationFrame(resizeRafRef.current);
          resizeRafRef.current = null;
      }
      latestClientXRef.current = null;
      if (ghostRef.current) ghostRef.current.style.display = 'none';
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeStop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      draggingRef.current = null;
      
      // Release lock after a short delay to block subsequent click events (sorting)
      setTimeout(() => {
          isResizingRef.current = false;
      }, 100);
  }, []);

  const handleCellSave = useCallback((row: any) => {
      // Optimistic update for display
      // In parent-controlled data, we might need parent to update 'data', 
      // but here we manage 'modifiedRows' locally and overlay it.
      // Since 'displayData' is derived from 'data' + 'modifiedRows', we need to update the source if it's in 'data'.
      // But 'data' prop is immutable.
      // So we update 'modifiedRows'.
      
      // Check if it's an added row
      const rowKey = row?.[GONAVI_ROW_KEY];
      if (rowKey === undefined) return;
      const isAdded = addedRows.some(r => r?.[GONAVI_ROW_KEY] === rowKey);
      if (isAdded) {
          setAddedRows(prev => prev.map(r => r?.[GONAVI_ROW_KEY] === rowKey ? { ...r, ...row } : r));
      } else {
          setModifiedRows(prev => ({ ...prev, [rowKeyStr(rowKey)]: row }));
      }
  }, [addedRows]);

  const handleCellSetNull = useCallback(() => {
    if (!cellContextMenu.record) return;
    handleCellSave({ ...cellContextMenu.record, [cellContextMenu.dataIndex]: null });
    setCellContextMenu(prev => ({ ...prev, visible: false }));
  }, [cellContextMenu, handleCellSave]);

  const handleCellSetValue = useCallback(() => {
    if (!cellContextMenu.record) return;
    handleCellSave({ ...cellContextMenu.record, [cellContextMenu.dataIndex]: cellSetValueInput });
    setCellContextMenu(prev => ({ ...prev, visible: false }));
  }, [cellContextMenu, cellSetValueInput, handleCellSave]);

  const handleCellEditorSave = useCallback(() => {
      if (!cellEditorMeta) return;
      const apply = cellEditorApplyRef.current;
      if (apply) {
          apply(cellEditorValue);
          closeCellEditor();
          return;
      }
      const nextRow: any = { ...cellEditorMeta.record, [cellEditorMeta.dataIndex]: cellEditorValue };
      handleCellSave(nextRow);
      closeCellEditor();
  }, [cellEditorMeta, cellEditorValue, handleCellSave, closeCellEditor]);

  const handleFormatJsonInEditor = useCallback(() => {
      if (!cellEditorIsJson) return;
      try {
          const obj = JSON.parse(cellEditorValue);
          setCellEditorValue(JSON.stringify(obj, null, 2));
      } catch (e: any) {
          message.error("JSON 格式无效：" + (e?.message || String(e)));
      }
  }, [cellEditorIsJson, cellEditorValue]);

  // Merge Data for Display
  // 'displayData' already merges addedRows. 
  // We need to merge modifiedRows into it for rendering.
  const mergedDisplayData = useMemo(() => {
      return displayData.map(row => {
          const k = row?.[GONAVI_ROW_KEY];
          if (k !== undefined && modifiedRows[rowKeyStr(k)]) {
              return { ...row, ...modifiedRows[rowKeyStr(k)] };
          }
          return row;
      });
  }, [displayData, modifiedRows]);

  useEffect(() => {
      setTextRecordIndex(prev => {
          if (mergedDisplayData.length === 0) return 0;
          return Math.min(prev, mergedDisplayData.length - 1);
      });
  }, [mergedDisplayData.length]);

  const jsonViewText = useMemo(() => {
      const cleanRows = mergedDisplayData.map((row) => {
          const { [GONAVI_ROW_KEY]: _rowKey, ...rest } = row || {};
          return normalizeValueForJsonView(rest);
      });
      return JSON.stringify(cleanRows, null, 2);
  }, [mergedDisplayData]);

  const textViewRows = useMemo(() => {
      return mergedDisplayData.map((row) => {
          const { [GONAVI_ROW_KEY]: _rowKey, ...rest } = row || {};
          return rest;
      });
  }, [mergedDisplayData]);

  const currentTextRow = useMemo(() => {
      if (textViewRows.length === 0) return null;
      return textViewRows[textRecordIndex] || null;
  }, [textViewRows, textRecordIndex]);

  const formatTextViewValue = useCallback((val: any): string => {
      if (val === null) return 'NULL';
      if (val === undefined) return '';
      if (typeof val === 'string') return normalizeDateTimeString(val);
      if (typeof val === 'object') {
          try {
              return JSON.stringify(val, null, 2);
          } catch {
              return String(val);
          }
      }
      return String(val);
  }, []);

  const closeRowEditor = useCallback(() => {
      setRowEditorOpen(false);
      setRowEditorRowKey('');
      rowEditorBaseRawRef.current = {};
      rowEditorDisplayRef.current = {};
      rowEditorNullColsRef.current = new Set();
      rowEditorForm.resetFields();
  }, [rowEditorForm]);

  const openRowEditorByKey = useCallback((keyStr?: string) => {
      if (!canModifyData) return;
      if (!keyStr) {
          message.info('请先定位到要编辑的记录');
          return;
      }
      const displayRow = mergedDisplayData.find(r => rowKeyStr(r?.[GONAVI_ROW_KEY]) === keyStr);
      if (!displayRow) {
          message.error('未找到目标行，请刷新后重试');
          return;
      }

      const baseRow =
          data.find(r => rowKeyStr(r?.[GONAVI_ROW_KEY]) === keyStr) ||
          addedRows.find(r => rowKeyStr(r?.[GONAVI_ROW_KEY]) === keyStr) ||
          displayRow;

      const baseRawMap: Record<string, any> = {};
      const displayMap: Record<string, string> = {};
      const formMap: Record<string, any> = {};
      const nullCols = new Set<string>();

      columnNames.forEach((col) => {
          const baseVal = (baseRow as any)?.[col];
          const displayVal = (displayRow as any)?.[col];
          baseRawMap[col] = baseVal;
          displayMap[col] = toFormText(displayVal);
          formMap[col] = displayVal === null || displayVal === undefined ? undefined : toFormText(displayVal);
          if (baseVal === null || baseVal === undefined) nullCols.add(col);
      });

      rowEditorBaseRawRef.current = baseRawMap;
      rowEditorDisplayRef.current = displayMap;
      rowEditorNullColsRef.current = nullCols;

      rowEditorForm.setFieldsValue(formMap);
      setRowEditorRowKey(keyStr);
      setRowEditorOpen(true);
  }, [canModifyData, mergedDisplayData, data, addedRows, columnNames, rowEditorForm, rowKeyStr]);

  const openRowEditor = useCallback(() => {
      if (!canModifyData) return;
      if (selectedRowKeys.length > 1) {
          message.info('一次只能编辑一行，请仅选择一行');
          return;
      }
      const keyStr = selectedRowKeys.length === 1 ? rowKeyStr(selectedRowKeys[0]) : undefined;
      if (!keyStr) {
          message.info('请先选择一行（勾选复选框）');
          return;
      }
      openRowEditorByKey(keyStr);
  }, [canModifyData, selectedRowKeys, rowKeyStr, openRowEditorByKey]);

  const openCurrentViewRowEditor = useCallback(() => {
      if (!canModifyData) return;
      const currentRow = mergedDisplayData[textRecordIndex];
      const rowKey = currentRow?.[GONAVI_ROW_KEY];
      if (rowKey === undefined || rowKey === null) {
          message.info('当前记录不可编辑');
          return;
      }
      openRowEditorByKey(rowKeyStr(rowKey));
  }, [canModifyData, mergedDisplayData, textRecordIndex, rowKeyStr, openRowEditorByKey]);

  const openJsonEditor = useCallback(() => {
      if (!canModifyData) return;
      setJsonEditorValue(jsonViewText);
      setJsonEditorOpen(true);
  }, [canModifyData, jsonViewText]);

  const handleFormatJsonEditor = useCallback(() => {
      try {
          const parsed = JSON.parse(jsonEditorValue);
          setJsonEditorValue(JSON.stringify(parsed, null, 2));
      } catch (e: any) {
          message.error("JSON 格式无效：" + (e?.message || String(e)));
      }
  }, [jsonEditorValue]);

  const applyJsonEditor = useCallback(() => {
      if (!canModifyData) return;
      let parsed: any;
      try {
          parsed = JSON.parse(jsonEditorValue);
      } catch (e: any) {
          message.error("JSON 解析失败：" + (e?.message || String(e)));
          return;
      }

      if (!Array.isArray(parsed)) {
          message.error("JSON 视图必须是数组格式（每项对应一条记录）");
          return;
      }
      if (parsed.length !== mergedDisplayData.length) {
          message.error(`记录条数不一致：当前 ${mergedDisplayData.length} 条，JSON 中 ${parsed.length} 条。请勿在此模式增删记录。`);
          return;
      }

      const addedKeySet = new Set<string>();
      addedRows.forEach((r) => {
          const key = r?.[GONAVI_ROW_KEY];
          if (key === undefined) return;
          addedKeySet.add(rowKeyStr(key));
      });

      const originalMap = new Map<string, any>();
      data.forEach((r) => {
          const key = r?.[GONAVI_ROW_KEY];
          if (key === undefined) return;
          originalMap.set(rowKeyStr(key), r);
      });

      const addedPatchMap = new Map<string, Record<string, any>>();
      const updatePatchMap = new Map<string, Record<string, any>>();

      for (let idx = 0; idx < parsed.length; idx += 1) {
          const nextItem = parsed[idx];
          if (!isPlainObject(nextItem)) {
              message.error(`第 ${idx + 1} 条记录不是对象，无法应用`);
              return;
          }

          const currentRow = mergedDisplayData[idx];
          const rowKey = currentRow?.[GONAVI_ROW_KEY];
          if (rowKey === undefined || rowKey === null) {
              message.error(`第 ${idx + 1} 条记录缺少行标识，无法应用`);
              return;
          }
          const keyStr = rowKeyStr(rowKey);
          const normalizedNext: Record<string, any> = {};
          let hasAnyVisibleChange = false;
          columnNames.forEach((col) => {
              const currentVal = (currentRow as any)?.[col];
              const editedVal = Object.prototype.hasOwnProperty.call(nextItem, col) ? (nextItem as any)[col] : currentVal;
              if (!isJsonViewValueEqual(currentVal, editedVal)) hasAnyVisibleChange = true;
              normalizedNext[col] = coerceJsonEditorValueForStorage(currentVal, editedVal);
          });

          if (!hasAnyVisibleChange) {
              continue;
          }

          if (addedKeySet.has(keyStr)) {
              addedPatchMap.set(keyStr, normalizedNext);
              continue;
          }

          const originalRow = originalMap.get(keyStr);
          if (!originalRow) continue;
          const patch: Record<string, any> = {};
          columnNames.forEach((col) => {
              const prevVal = (originalRow as any)?.[col];
              const nextVal = normalizedNext[col];
              if (!isCellValueEqualForDiff(prevVal, nextVal)) patch[col] = nextVal;
          });
          updatePatchMap.set(keyStr, patch);
      }

      setAddedRows((prev) => prev.map((row) => {
          const key = row?.[GONAVI_ROW_KEY];
          if (key === undefined) return row;
          const patch = addedPatchMap.get(rowKeyStr(key));
          if (!patch) return row;
          return { ...row, ...patch };
      }));

      setModifiedRows((prev) => {
          const next = { ...prev };
          updatePatchMap.forEach((patch, keyStr) => {
              if (Object.keys(patch).length === 0) delete next[keyStr];
              else next[keyStr] = patch;
          });
          return next;
      });

      setJsonEditorOpen(false);
      message.success("JSON 修改已应用到当前结果集，可继续“提交事务”");
  }, [canModifyData, jsonEditorValue, mergedDisplayData, addedRows, rowKeyStr, data, columnNames]);

  const openRowEditorFieldEditor = useCallback((dataIndex: string) => {
      if (!dataIndex) return;
      const val = rowEditorForm.getFieldValue(dataIndex);
      openCellEditor(
          { [dataIndex]: val ?? '' },
          dataIndex,
          dataIndex,
          (nextVal) => rowEditorForm.setFieldsValue({ [dataIndex]: nextVal }),
      );
  }, [rowEditorForm, openCellEditor]);

  const applyRowEditor = useCallback(() => {
      const keyStr = rowEditorRowKey;
      if (!keyStr) return;
      const values = rowEditorForm.getFieldsValue(true) || {};

      const isAdded = addedRows.some(r => rowKeyStr(r?.[GONAVI_ROW_KEY]) === keyStr);
      if (isAdded) {
          setAddedRows(prev => prev.map(r => rowKeyStr(r?.[GONAVI_ROW_KEY]) === keyStr ? { ...r, ...values } : r));
          closeRowEditor();
          return;
      }

      const baseRawMap = rowEditorBaseRawRef.current || {};
      const patch: Record<string, any> = {};
      columnNames.forEach((col) => {
          const nextVal = values[col];
          const baseVal = baseRawMap[col];
          if (!isCellValueEqualForDiff(baseVal, nextVal)) patch[col] = nextVal;
      });

      setModifiedRows(prev => {
          const next = { ...prev };
          if (Object.keys(patch).length === 0) delete next[keyStr];
          else next[keyStr] = patch;
          return next;
      });

      closeRowEditor();
  }, [rowEditorRowKey, rowEditorForm, addedRows, columnNames, rowKeyStr, closeRowEditor]);

  const columns = useMemo(() => {
      return columnNames.map(key => ({
          title: key,
          dataIndex: key,
          key: key,
          // 不使用 ellipsis，避免 Ant Design 的 Tooltip 展开行为
          width: columnWidths[key] || 200,
          sorter: !!onSort,
          sortOrder: (sortInfo?.columnKey === key ? sortInfo.order : null) as SortOrder | undefined,
          editable: canModifyData, // Only editable if table name known and not readonly
          render: (text: any) => (
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {formatCellValue(text)}
              </div>
          ),
          onHeaderCell: (column: any) => ({
              width: column.width,
              onResizeStart: handleResizeStart(key), // Only need start
          }),
      }));
  }, [columnNames, columnWidths, sortInfo, handleResizeStart, canModifyData, onSort]);

  const mergedColumns = useMemo(() => columns.map(col => {
      if (!col.editable) return col;
      return {
          ...col,
          onCell: (record: Item) => ({
              record,
              editable: col.editable,
              dataIndex: col.dataIndex,
              title: col.title,
              handleSave: handleCellSave,
              focusCell: openCellEditor,
          }),
      };
  }), [columns, handleCellSave, openCellEditor]);

  const handleAddRow = () => {
      const newKey = `new-${Date.now()}`;
      const newRow: any = { [GONAVI_ROW_KEY]: newKey };
      columnNames.forEach(col => newRow[col] = ''); 
      pendingScrollToBottomRef.current = true;
      setAddedRows(prev => [...prev, newRow]);
  };

  const handleDeleteSelected = () => {
      setDeletedRowKeys(prev => {
          const newDeleted = new Set(prev);
          selectedRowKeys.forEach(key => newDeleted.add(rowKeyStr(key)));
          return newDeleted;
      });
      setSelectedRowKeys([]);
  };

  const handleCommit = async () => {
      if (!connectionId || !tableName) return;
      const conn = connections.find(c => c.id === connectionId);
      if (!conn) return;

      const inserts: any[] = [];
      const updates: any[] = [];
      const deletes: any[] = [];

      addedRows.forEach(row => { const { [GONAVI_ROW_KEY]: _rowKey, ...vals } = row; inserts.push(vals); });
      deletedRowKeys.forEach(keyStr => {
          // Find original data
          const originalRow = data.find(d => rowKeyStr(d?.[GONAVI_ROW_KEY]) === keyStr) || addedRows.find(d => rowKeyStr(d?.[GONAVI_ROW_KEY]) === keyStr);
          if (originalRow) {
              const pkData: any = {};
              if (pkColumns.length > 0) pkColumns.forEach(k => pkData[k] = originalRow[k]);
              else { const { [GONAVI_ROW_KEY]: _rowKey, ...rest } = originalRow; Object.assign(pkData, rest); }
              deletes.push(pkData);
          }
      });
      Object.entries(modifiedRows).forEach(([keyStr, newRow]) => {
          if (deletedRowKeys.has(keyStr)) return;
          const originalRow = data.find(d => rowKeyStr(d?.[GONAVI_ROW_KEY]) === keyStr);
          if (!originalRow) return; // Should not happen for modified rows unless deleted
          
          const pkData: any = {};
          if (pkColumns.length > 0) pkColumns.forEach(k => pkData[k] = originalRow[k]);
          else { const { [GONAVI_ROW_KEY]: _rowKey, ...rest } = originalRow; Object.assign(pkData, rest); }

          const hasRowKey = Object.prototype.hasOwnProperty.call(newRow as any, GONAVI_ROW_KEY);
          let values: any = {};

          if (!hasRowKey) {
              values = { ...(newRow as any) };
          } else {
              columnNames.forEach((col) => {
                  const nextVal = (newRow as any)?.[col];
                  const prevVal = (originalRow as any)?.[col];
                  if (!isCellValueEqualForDiff(prevVal, nextVal)) values[col] = nextVal;
              });
          }

          if (Object.keys(values).length === 0) return;
          updates.push({ keys: pkData, values });
      });

      if (inserts.length === 0 && updates.length === 0 && deletes.length === 0) {
          message.info("No changes to commit");
          return;
      }

      const config = { 
          ...conn.config, 
          port: Number(conn.config.port), 
          password: conn.config.password || "", 
          database: conn.config.database || "", 
          useSSH: conn.config.useSSH || false, 
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" } 
      };
      
      const startTime = Date.now();
      const res = await ApplyChanges(config as any, dbName || '', tableName, { inserts, updates, deletes } as any);
      const duration = Date.now() - startTime;
      
      // Construct a pseudo-SQL representation for the log
      let logSql = `/* Batch Apply on ${tableName} */\n`;
      if (inserts.length > 0) logSql += `INSERT ${inserts.length} rows;\n`;
      if (updates.length > 0) logSql += `UPDATE ${updates.length} rows;\n`;
      if (deletes.length > 0) logSql += `DELETE ${deletes.length} rows;\n`;
      
      if (res.success) {
          addSqlLog({
              id: Date.now().toString(),
              timestamp: Date.now(),
              sql: logSql.trim(),
              status: 'success',
              duration,
              message: res.message,
              dbName
          });
          message.success("事务提交成功");
          setAddedRows([]);
          setModifiedRows({});
          setDeletedRowKeys(new Set());
          if (onReload) onReload();
      } else {
          addSqlLog({
              id: Date.now().toString(),
              timestamp: Date.now(),
              sql: logSql.trim(),
              status: 'error',
              duration,
              message: res.message,
              dbName
          });
          message.error("提交失败: " + res.message);
      }
  };

  const copyToClipboard = useCallback((text: string) => {
      navigator.clipboard.writeText(text);
      message.success("Copied to clipboard");
  }, []);
  
  const getTargets = useCallback((clickedRecord: any) => {
      const selKeys = selectedRowKeysRef.current;
      const currentData = displayDataRef.current;
      const clickedKey = clickedRecord?.[GONAVI_ROW_KEY];
      if (clickedKey !== undefined && selKeys.includes(clickedKey)) {
          return currentData.filter(d => selKeys.includes(d?.[GONAVI_ROW_KEY]));
      }
      return [clickedRecord];
  }, []);

  const handleCopyInsert = useCallback((record: any) => {
      const records = getTargets(record);
      const sqls = records.map((r: any) => {
          const { [GONAVI_ROW_KEY]: _rowKey, ...vals } = r;
          const cols = Object.keys(vals);
          const values = Object.values(vals).map(v => v === null ? 'NULL' : `'${v}'`); 
          const targetTable = tableName || 'table';
          return `INSERT INTO \`${targetTable}\` (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${values.join(', ')});`;
      });
      copyToClipboard(sqls.join('\n'));
  }, [tableName, getTargets, copyToClipboard]);

  const handleCopyJson = useCallback((record: any) => {
      const records = getTargets(record);
      const cleanRecords = records.map((r: any) => {
          const { [GONAVI_ROW_KEY]: _rowKey, ...rest } = r;
          return rest;
      });
      copyToClipboard(JSON.stringify(cleanRecords, null, 2));
  }, [getTargets, copyToClipboard]);

  const handleCopyCsv = useCallback((record: any) => {
      const records = getTargets(record);
      const lines = records.map((r: any) => {
          const { [GONAVI_ROW_KEY]: _rowKey, ...vals } = r;
          const values = Object.values(vals).map(v => v === null ? 'NULL' : `"${v}"`);
          return values.join(',');
      });
      copyToClipboard(lines.join('\n'));
  }, [getTargets, copyToClipboard]);

  const buildConnConfig = useCallback(() => {
      if (!connectionId) return null;
      const conn = connections.find(c => c.id === connectionId);
      if (!conn) return null;
      return {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      };
  }, [connections, connectionId]);

  const exportByQuery = useCallback(async (sql: string, format: string, defaultName: string) => {
      const config = buildConnConfig();
      if (!config) return;
      const hide = message.loading(`正在导出...`, 0);
      const res = await ExportQuery(config as any, dbName || '', sql, defaultName || 'export', format);
      hide();
      if (res.success) {
          message.success("导出成功");
      } else if (res.message !== "Cancelled") {
          message.error("导出失败: " + res.message);
      }
  }, [buildConnConfig, dbName]);

  const buildPkWhereSql = useCallback((rows: any[], dbType: string) => {
      if (!tableName || pkColumns.length === 0) return '';
      const targets = (rows || []).filter(Boolean);
      if (targets.length === 0) return '';

      const clauses: string[] = [];
      for (const r of targets) {
          const andParts: string[] = [];
          for (const pk of pkColumns) {
              const col = quoteIdentPart(dbType, pk);
              const v = r?.[pk];
              if (v === null || v === undefined) return '';
              andParts.push(`${col} = '${escapeLiteral(String(v))}'`);
          }
          if (andParts.length === pkColumns.length) {
              clauses.push(`(${andParts.join(' AND ')})`);
          }
      }
      if (clauses.length === 0) return '';
      return clauses.join(' OR ');
  }, [pkColumns, tableName]);

  const buildCurrentPageSql = useCallback((dbType: string) => {
      if (!tableName || !pagination) return '';
      const whereSQL = buildWhereSQL(dbType, filterConditions);
      let sql = `SELECT * FROM ${quoteQualifiedIdent(dbType, tableName)} ${whereSQL}`;
      if (sortInfo && sortInfo.order) {
          sql += ` ORDER BY ${quoteIdentPart(dbType, sortInfo.columnKey)} ${sortInfo.order === 'ascend' ? 'ASC' : 'DESC'}`;
      }
      const offset = (pagination.current - 1) * pagination.pageSize;
      sql += ` LIMIT ${pagination.pageSize} OFFSET ${offset}`;
      return sql;
  }, [tableName, pagination, filterConditions, sortInfo]);

  // Context Menu Export
  const handleExportSelected = useCallback(async (format: string, record: any) => {
      const records = getTargets(record);
      if (!connectionId || !tableName) {
          await exportData(records, format);
          return;
      }

      // 有未提交修改时，优先按界面数据导出，避免与数据库不一致。
      if (hasChanges) {
          message.warning("当前存在未提交修改，导出将按界面数据生成；如需完整长字段建议先提交后再导出。");
          await exportData(records, format);
          return;
      }

      const config = buildConnConfig();
      if (!config) {
          await exportData(records, format);
          return;
      }

      const dbType = config.type || '';
      const pkWhere = buildPkWhereSql(records, dbType);
      if (!pkWhere) {
          await exportData(records, format);
          return;
      }

      const sql = `SELECT * FROM ${quoteQualifiedIdent(dbType, tableName)} WHERE ${pkWhere}`;
      await exportByQuery(sql, format, tableName || 'export');
  }, [getTargets, connectionId, tableName, hasChanges, exportData, buildConnConfig, buildPkWhereSql, exportByQuery]);

  // Export
  const handleExport = async (format: string) => {
      if (!connectionId || !tableName) return;
      
      // 1. Export Selected
      if (selectedRowKeys.length > 0) {
          const selectedRows = displayData.filter(d => selectedRowKeys.includes(d?.[GONAVI_ROW_KEY]));
          await handleExportSelected(format, selectedRows[0]);
          return;
      }

      // 2. Prompt for Current vs All
      // Using a custom modal content with buttons to handle 3 states
      let instance: any;
      const handleAll = async () => {
          instance.destroy();
          const config = buildConnConfig();
          if (!config) return;
          const hide = message.loading(`正在导出全部数据...`, 0);
          const res = await ExportTable(config as any, dbName || '', tableName, format);
          hide();
          if (res.success) { message.success("导出成功"); } else if (res.message !== "Cancelled") { message.error("导出失败: " + res.message); }
      };
      const handlePage = async () => {
          instance.destroy();
          if (hasChanges) {
              message.warning("当前存在未提交修改，导出将按界面数据生成；如需完整长字段建议先提交后再导出。");
              await exportData(displayData, format);
              return;
          }

          const config = buildConnConfig();
          if (!config) {
              await exportData(displayData, format);
              return;
          }

          const sql = buildCurrentPageSql(config.type || '');
          if (!sql) {
              await exportData(displayData, format);
              return;
          }

          await exportByQuery(sql, format, tableName || 'export');
      };

      instance = modal.info({
          title: '导出选项',
          content: (
              <div>
                  <p>您未选中任何行，请选择导出范围：</p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
                      <Button onClick={() => instance.destroy()}>取消</Button>
                      <Button onClick={handlePage}>导出当前页 ({displayData.length}条)</Button>
                      <Button type="primary" onClick={handleAll}>导出全部数据</Button>
                  </div>
              </div>
          ),
          icon: <ExportOutlined />,
          okButtonProps: { style: { display: 'none' } }, // Hide default OK
          maskClosable: true,
      });
  };

  const handleImport = async () => {
      if (!connectionId || !tableName) return;
      const config = buildConnConfig();
      if (!config) return;

      const res = await ImportData(config as any, dbName || '', tableName);
      if (res.success && res.data && res.data.filePath) {
          setImportFilePath(res.data.filePath);
          setImportPreviewVisible(true);
      } else if (res.message !== "Cancelled") {
          message.error("选择文件失败: " + res.message);
      }
  };

  const handleImportSuccess = () => {
      setImportPreviewVisible(false);
      setImportFilePath('');
      message.success('导入完成');
      if (onReload) onReload();
  };

  // Filters
  const filterOpOptions = useMemo(() => ([
      { value: '=', label: '=' },
      { value: '!=', label: '!=' },
      { value: '<', label: '<' },
      { value: '<=', label: '<=' },
      { value: '>', label: '>' },
      { value: '>=', label: '>=' },
      { value: 'CONTAINS', label: '包含' },
      { value: 'NOT_CONTAINS', label: '不包含' },
      { value: 'STARTS_WITH', label: '开始以' },
      { value: 'NOT_STARTS_WITH', label: '不是开始于' },
      { value: 'ENDS_WITH', label: '结束以' },
      { value: 'NOT_ENDS_WITH', label: '不是结束于' },
      { value: 'IS_NULL', label: '是 null' },
      { value: 'IS_NOT_NULL', label: '不是 null' },
      { value: 'IS_EMPTY', label: '是空的' },
      { value: 'IS_NOT_EMPTY', label: '不是空的' },
      { value: 'BETWEEN', label: '介于' },
      { value: 'NOT_BETWEEN', label: '不介于' },
      { value: 'IN', label: '在列表' },
      { value: 'NOT_IN', label: '不在列表' },
      { value: 'CUSTOM', label: '[自定义]' },
  ]), []);

  const isNoValueOp = useCallback((op: string) => (
      op === 'IS_NULL' || op === 'IS_NOT_NULL' || op === 'IS_EMPTY' || op === 'IS_NOT_EMPTY'
  ), []);
  const isBetweenOp = useCallback((op: string) => op === 'BETWEEN' || op === 'NOT_BETWEEN', []);
  const isListOp = useCallback((op: string) => op === 'IN' || op === 'NOT_IN', []);

  const addFilter = () => {
      setFilterConditions([...filterConditions, { id: nextFilterId, enabled: true, column: columnNames[0] || '', op: '=', value: '', value2: '' }]);
      setNextFilterId(nextFilterId + 1);
  };
  const updateFilter = (id: number, field: keyof GridFilterCondition, val: string | boolean) => {
      setFilterConditions(prev => prev.map(c => {
          if (c.id !== id) return c;
          const next: GridFilterCondition = { ...c, [field]: val } as GridFilterCondition;
          if (field === 'op') {
              const nextOp = String(val);
              if (isNoValueOp(nextOp)) {
                  next.value = '';
                  next.value2 = '';
              } else if (isBetweenOp(nextOp)) {
                  if (typeof next.value2 !== 'string') next.value2 = '';
              } else {
                  next.value2 = '';
              }
          }
          return next;
      }));
  };
  const removeFilter = (id: number) => {
      setFilterConditions(prev => prev.filter(c => c.id !== id));
  };
  const applyFilters = () => {
      if (onApplyFilter) onApplyFilter(filterConditions);
  };

  const exportMenu: MenuProps['items'] = [
      { key: 'csv', label: 'CSV', onClick: () => handleExport('csv') },
      { key: 'xlsx', label: 'Excel (XLSX)', onClick: () => handleExport('xlsx') },
      { key: 'json', label: 'JSON', onClick: () => handleExport('json') },
      { key: 'md', label: 'Markdown', onClick: () => handleExport('md') },
  ];

  const tableComponents = useMemo(() => ({
      body: { cell: EditableCell, row: ContextMenuRow },
      header: { cell: ResizableTitle }
  }), []); 

  const totalWidth = columns.reduce((sum, col) => sum + (Number(col.width) || 200), 0) + selectionColumnWidth;
  const enableVirtual = mergedDisplayData.length >= 200;
  const tableScrollX = useMemo(() => {
      const baseWidth = Math.max(totalWidth, 1000);
      if (!isMacLike || tableViewportWidth <= 0) return baseWidth;
      // macOS 在“自动隐藏滚动条”模式下容易误判为无横向滚动，预留 2px 触发稳定滚动轨道。
      return Math.max(baseWidth, tableViewportWidth + 2);
  }, [totalWidth, isMacLike, tableViewportWidth]);
  const tableStickyConfig = useMemo(() => ({
      getContainer: () => containerRef.current || document.body,
      offsetScroll: 0,
  }), []);

  useEffect(() => {
      if (viewMode !== 'table') return;
      const rafId = requestAnimationFrame(() => recalculateTableMetrics(containerRef.current));
      return () => cancelAnimationFrame(rafId);
  }, [viewMode, totalWidth, mergedDisplayData.length, recalculateTableMetrics]);

  return (
    <div className={`${gridId}${cellEditMode ? ' cell-edit-mode' : ''}`} ref={containerRef} style={{ flex: '1 1 auto', height: '100%', overflow: 'hidden', padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0, background: bgContent }}>
	       {/* Toolbar */}
	        <div style={{ padding: '8px', borderBottom: '1px solid #eee', display: 'flex', gap: 8, alignItems: 'center' }}>
	            {onReload && <Button icon={<ReloadOutlined />} disabled={loading} onClick={() => {
	                setAddedRows([]);
	                setModifiedRows({});
	               setDeletedRowKeys(new Set());
	               setSelectedRowKeys([]);
	               onReload();
	           }}>刷新</Button>}
	           {tableName && <Button icon={<ImportOutlined />} onClick={handleImport}>导入</Button>}
	           {tableName && <Dropdown menu={{ items: exportMenu }}><Button icon={<ExportOutlined />}>导出 <DownOutlined /></Button></Dropdown>}
	           
	           {canModifyData && (
	               <>
	                   <div style={{ width: 1, background: '#eee', height: 20, margin: '0 8px' }} />
	                   <Button icon={<PlusOutlined />} onClick={handleAddRow}>添加行</Button>
	                   <Button
                           icon={<EditOutlined />}
                           disabled={selectedRowKeys.length !== 1}
                           onClick={openRowEditor}
                       >
                           编辑行
                       </Button>
	                   <Button icon={<DeleteOutlined />} danger disabled={selectedRowKeys.length === 0} onClick={handleDeleteSelected}>删除选中</Button>
	                   {selectedRowKeys.length > 0 && <span style={{ fontSize: '12px', color: '#888' }}>已选 {selectedRowKeys.length}</span>}
	                   <div style={{ width: 1, background: '#eee', height: 20, margin: '0 8px' }} />
	                   <Button
                            icon={<EditOutlined />}
                            type={cellEditMode ? 'primary' : 'default'}
                            onClick={() => {
                                const next = !cellEditMode;
                                setCellEditMode(next);
                                setSelectedCells(new Set());
                                currentSelectionRef.current = new Set();
                                selectionStartRef.current = null;
                                isDraggingRef.current = false;
                                if (cellSelectionRafRef.current !== null) {
                                    cancelAnimationFrame(cellSelectionRafRef.current);
                                    cellSelectionRafRef.current = null;
                                }
                                if (cellSelectionScrollRafRef.current !== null) {
                                    cancelAnimationFrame(cellSelectionScrollRafRef.current);
                                    cellSelectionScrollRafRef.current = null;
                                }
                                updateCellSelection(new Set());
                                if (!next) setBatchEditModalOpen(false);
                                message.info(next ? '已进入单元格编辑模式，可拖拽选择多个单元格' : '已退出单元格编辑模式');
                            }}
                        >
                            单元格编辑器
                        </Button>
                       {cellEditMode && selectedCells.size > 0 && (
                           <>
                               <Button
                                   type="primary"
                                   onClick={() => {
                                       setBatchEditValue('');
                                       setBatchEditSetNull(false);
                                       setBatchEditModalOpen(true);
                                   }}
                               >
                                   批量填充 ({selectedCells.size})
                               </Button>
                           </>
                       )}
	                   <div style={{ width: 1, background: '#eee', height: 20, margin: '0 8px' }} />
	                   <Button icon={<SaveOutlined />} type="primary" disabled={!hasChanges} onClick={handleCommit}>提交事务 ({addedRows.length + Object.keys(modifiedRows).length + deletedRowKeys.size})</Button>
	                   {hasChanges && (<Button icon={<UndoOutlined />} onClick={() => {
	                        setAddedRows([]);
                        setModifiedRows({});
                        setDeletedRowKeys(new Set());
                   }}>回滚</Button>)}
               </>
           )}

           {onToggleFilter && (
               <>
                   <div style={{ width: 1, background: '#eee', height: 20, margin: '0 8px' }} />
                   <Button icon={<FilterOutlined />} type={showFilter ? 'primary' : 'default'} onClick={() => { 
                       onToggleFilter(); 
                       if (filterConditions.length === 0 && !showFilter) addFilter(); 
                   }}>筛选</Button>
               </>
           )}

           <div style={{ marginLeft: 'auto' }} />
           <Segmented
               size="small"
               value={viewMode}
               options={[
                   { label: '表格', value: 'table' },
                   { label: 'JSON', value: 'json' },
                   { label: '文本', value: 'text' }
               ]}
               onChange={(val) => {
                   const nextMode = String(val) as GridViewMode;
                   if (nextMode === 'json' && cellEditMode) {
                       setCellEditMode(false);
                       setSelectedCells(new Set());
                       currentSelectionRef.current = new Set();
                       selectionStartRef.current = null;
                       updateCellSelection(new Set());
                   }
                   if (nextMode === 'text') {
                       const selectedKey = selectedRowKeys[0];
                       if (selectedKey !== undefined) {
                           const idx = mergedDisplayData.findIndex((row) => rowKeyStr(row?.[GONAVI_ROW_KEY]) === rowKeyStr(selectedKey));
                           if (idx >= 0) {
                               setTextRecordIndex(idx);
                           }
                       }
                   }
                   setViewMode(nextMode);
               }}
           />
       </div>

       {/* Filter Panel */}
       {showFilter && (
           <div style={{ 
               padding: '8px', 
               margin: '4px 8px 0 8px', 
               borderRadius: '8px',
               background: bgFilter, 
           }}>
               {filterConditions.map(cond => (
                   <div key={cond.id} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-start', opacity: cond.enabled === false ? 0.58 : 1 }}>
                       <Checkbox
                           checked={cond.enabled !== false}
                           onChange={e => updateFilter(cond.id, 'enabled', e.target.checked)}
                           style={{ marginTop: 6 }}
                       >
                           启用
                       </Checkbox>
                       <Select
                           style={{ width: 180 }}
                           value={cond.column}
                           onChange={v => updateFilter(cond.id, 'column', v)}
                           options={columnNames.map(c => ({ value: c, label: c }))}
                           disabled={cond.op === 'CUSTOM'}
                       />
                       <Select
                           style={{ width: 140 }}
                           value={cond.op}
                           onChange={v => updateFilter(cond.id, 'op', v)}
                           options={filterOpOptions as any}
                       />

                       {cond.op === 'CUSTOM' ? (
                           <Input.TextArea
                               style={{ flex: 1 }}
                               autoSize={{ minRows: 1, maxRows: 4 }}
                               value={cond.value}
                               onChange={e => updateFilter(cond.id, 'value', e.target.value)}
                               placeholder="输入自定义 WHERE 表达式（不需要再写 WHERE），例如：status IN ('A','B')"
                           />
                       ) : isListOp(cond.op) ? (
                           <Input.TextArea
                               style={{ flex: 1 }}
                               autoSize={{ minRows: 1, maxRows: 4 }}
                               value={cond.value}
                               onChange={e => updateFilter(cond.id, 'value', e.target.value)}
                               placeholder="多个值用逗号或换行分隔"
                           />
                       ) : isBetweenOp(cond.op) ? (
                           <>
                               <Input
                                   style={{ width: 220 }}
                                   value={cond.value}
                                   onChange={e => updateFilter(cond.id, 'value', e.target.value)}
                                   placeholder="开始值"
                               />
                               <Input
                                   style={{ width: 220 }}
                                   value={cond.value2 || ''}
                                   onChange={e => updateFilter(cond.id, 'value2', e.target.value)}
                                   placeholder="结束值"
                               />
                           </>
                       ) : isNoValueOp(cond.op) ? (
                           <Input style={{ width: 220 }} value="" disabled placeholder="无需输入值" />
                       ) : (
                           <Input
                               style={{ width: 280 }}
                               value={cond.value}
                               onChange={e => updateFilter(cond.id, 'value', e.target.value)}
                           />
                       )}

                       <Button icon={<CloseOutlined />} onClick={() => removeFilter(cond.id)} type="text" danger />
                   </div>
               ))}
               <div style={{ display: 'flex', gap: 8 }}>
                   <Button type="dashed" onClick={addFilter} size="small" icon={<PlusOutlined />}>添加条件</Button>
                   <Button size="small" onClick={() => setFilterConditions(prev => prev.map(c => ({ ...c, enabled: true })))}>全启用</Button>
                   <Button size="small" onClick={() => setFilterConditions(prev => prev.map(c => ({ ...c, enabled: false })))}>全停用</Button>
                   <Button type="primary" onClick={applyFilters} size="small">应用</Button>
                   <Button size="small" icon={<ClearOutlined />} onClick={() => {
                       setFilterConditions([]);
                       if (onApplyFilter) onApplyFilter([]);
                   }}>清除</Button>
               </div>
           </div>
       )}

	       <div ref={containerRef} style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
	        {contextHolder}
            <Modal
                title="编辑行"
                open={rowEditorOpen}
                onCancel={closeRowEditor}
                width={980}
                destroyOnHidden
                maskClosable={false}
                footer={[
                    <Button key="cancel" onClick={closeRowEditor}>取消</Button>,
                    <Button key="ok" type="primary" onClick={applyRowEditor}>应用</Button>,
                ]}
            >
                <div style={{ marginBottom: 8, color: '#888', fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span>{tableName ? `${tableName}` : ''}</span>
                    <span>{rowEditorRowKey ? `rowKey: ${rowEditorRowKey}` : ''}</span>
                </div>
                <Form form={rowEditorForm} layout="vertical">
                    <div className="custom-scrollbar" style={{ maxHeight: '62vh', overflow: 'auto', paddingRight: 8 }}>
                        {columnNames.map((col) => {
                            const sample = rowEditorDisplayRef.current?.[col] ?? '';
                            const placeholder = rowEditorNullColsRef.current?.has(col) ? '(NULL)' : undefined;
                            const isJson = looksLikeJsonText(sample);
                            const useArea = isJson || sample.includes('\n') || sample.length >= 160;

                            return (
                                <Form.Item key={col} label={col} style={{ marginBottom: 12 }}>
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                                        <Form.Item name={col} noStyle>
                                            {useArea ? (
                                                <Input.TextArea
                                                    style={{ flex: 1 }}
                                                    autoSize={{ minRows: isJson ? 4 : 1, maxRows: 10 }}
                                                    placeholder={placeholder}
                                                />
                                            ) : (
                                                <Input style={{ flex: 1 }} placeholder={placeholder} />
                                            )}
                                        </Form.Item>
                                        <Button size="small" onClick={() => openRowEditorFieldEditor(col)} title="弹窗编辑">...</Button>
                                    </div>
                                </Form.Item>
                            );
                        })}
                    </div>
                </Form>
            </Modal>
	        <Modal
	            title={cellEditorMeta ? `编辑单元格：${cellEditorMeta.title}` : '编辑单元格'}
	            open={cellEditorOpen}
	            onCancel={closeCellEditor}
            width={960}
            maskClosable={false}
            footer={[
                <Button key="format" onClick={handleFormatJsonInEditor} disabled={!cellEditorIsJson}>
                    格式化 JSON
                </Button>,
                <Button key="cancel" onClick={closeCellEditor}>取消</Button>,
                <Button key="ok" type="primary" onClick={handleCellEditorSave}>保存</Button>,
            ]}
        >
            <div style={{ marginBottom: 8, color: '#888', fontSize: 12 }}>
                {cellEditorMeta ? `${tableName || ''}${tableName ? '.' : ''}${cellEditorMeta.dataIndex}` : ''}
            </div>
            <Editor
                height="56vh"
                language={cellEditorIsJson ? "json" : "plaintext"}
                theme={darkMode ? "transparent-dark" : "transparent-light"}
                value={cellEditorValue}
                onChange={(val) => setCellEditorValue(val || '')}
                options={{
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                    fontSize: 14,
                    tabSize: 2,
                    automaticLayout: true,
                }}
            />
        </Modal>

        {/* 批量编辑弹窗 */}
        <Modal
            title={`批量填充 (${selectedCells.size} 个单元格)`}
            open={batchEditModalOpen}
            onCancel={() => setBatchEditModalOpen(false)}
            onOk={handleBatchFillCells}
            width={500}
        >
            <div style={{ marginBottom: 16 }}>
                <Checkbox
                    checked={batchEditSetNull}
                    onChange={(e) => setBatchEditSetNull(e.target.checked)}
                >
                    设置为 NULL
                </Checkbox>
            </div>
            {!batchEditSetNull && (
                <Input.TextArea
                    value={batchEditValue}
                    onChange={(e) => setBatchEditValue(e.target.value)}
                    placeholder="输入要填充的值"
                    autoSize={{ minRows: 3, maxRows: 10 }}
                    autoFocus
                />
            )}
        </Modal>
        <Modal
            title="编辑 JSON 结果集"
            open={jsonEditorOpen}
            onCancel={() => setJsonEditorOpen(false)}
            width={980}
            maskClosable={false}
            footer={[
                <Button key="format" onClick={handleFormatJsonEditor}>格式化 JSON</Button>,
                <Button key="cancel" onClick={() => setJsonEditorOpen(false)}>取消</Button>,
                <Button key="ok" type="primary" onClick={applyJsonEditor}>应用修改</Button>,
            ]}
        >
            <div style={{ marginBottom: 8, color: '#888', fontSize: 12 }}>
                说明：此处按当前结果集顺序编辑，不支持在 JSON 模式增删记录（可在表格模式操作）。
            </div>
            <Editor
                height="56vh"
                language="json"
                theme={darkMode ? "transparent-dark" : "transparent-light"}
                value={jsonEditorValue}
                onChange={(val) => setJsonEditorValue(val || '')}
                options={{
                    readOnly: false,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    wordWrap: "off",
                    fontSize: 12,
                    tabSize: 2,
                    automaticLayout: true,
                }}
            />
        </Modal>

        {viewMode === 'table' ? (
            <Form component={false} form={form}>
                <DataContext.Provider value={{ selectedRowKeysRef, displayDataRef, handleCopyInsert, handleCopyJson, handleCopyCsv, handleExportSelected, copyToClipboard, tableName }}>
                    <CellContextMenuContext.Provider value={{ showMenu: showCellContextMenu, handleBatchFillToSelected }}>
                            <EditableContext.Provider value={form}>
                                <Table
                                    components={tableComponents}
                                    dataSource={mergedDisplayData}
                                    columns={mergedColumns}
                                    size="small"
                                    tableLayout="fixed"
                                    scroll={{ x: tableScrollX, y: tableHeight }}
                                    sticky={tableStickyConfig}
                                    virtual={enableVirtual}
                                    loading={loading}
                                        rowKey={GONAVI_ROW_KEY}
                                        pagination={false}
                                        onChange={handleTableChange}
                                        bordered
                                        rowSelection={{
                                            selectedRowKeys,
                                            onChange: setSelectedRowKeys,
                                            columnWidth: selectionColumnWidth,
                                        }}
                                        rowClassName={(record) => {
                                            const k = record?.[GONAVI_ROW_KEY];
                                            if (k !== undefined && addedRows.some(r => r?.[GONAVI_ROW_KEY] === k)) return 'row-added';
                                            if (k !== undefined && (modifiedRows[rowKeyStr(k)] || deletedRowKeys.has(rowKeyStr(k)))) return 'row-modified'; // deleted won't show
                                            return '';
                                        }}
                                        onRow={(record) => ({ record } as any)}
                                    />
                            </EditableContext.Provider>
                    </CellContextMenuContext.Provider>
                </DataContext.Provider>
            </Form>
        ) : viewMode === 'json' ? (
            <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '8px 10px', borderBottom: darkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: darkMode ? '#999' : '#666' }}>
                        {mergedDisplayData.length === 0 ? '当前结果集无数据' : `当前结果集 ${mergedDisplayData.length} 条记录`}
                    </span>
                    {canModifyData && (
                        <Button size="small" type="primary" onClick={openJsonEditor} disabled={mergedDisplayData.length === 0}>
                            编辑 JSON
                        </Button>
                    )}
                </div>
                <div style={{ flex: 1, minHeight: 0, padding: '8px 10px 10px 10px' }}>
                    <Editor
                        height="100%"
                        defaultLanguage="json"
                        language="json"
                        theme={darkMode ? "transparent-dark" : "transparent-light"}
                        value={jsonViewText}
                        options={{
                            readOnly: true,
                            minimap: { enabled: false },
                            scrollBeyondLastLine: false,
                            wordWrap: "off",
                            fontSize: 12,
                            tabSize: 2,
                            automaticLayout: true,
                        }}
                    />
                </div>
            </div>
        ) : (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '8px 12px', borderBottom: darkMode ? '1px solid rgba(255,255,255,0.08)' : '1px solid rgba(0,0,0,0.08)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Button size="small" onClick={() => setTextRecordIndex(i => Math.max(0, i - 1))} disabled={textViewRows.length === 0 || textRecordIndex <= 0}>
                        上一条
                    </Button>
                    <Button size="small" onClick={() => setTextRecordIndex(i => Math.min(textViewRows.length - 1, i + 1))} disabled={textViewRows.length === 0 || textRecordIndex >= textViewRows.length - 1}>
                        下一条
                    </Button>
                    <span style={{ fontSize: 12, color: darkMode ? '#999' : '#666' }}>
                        {textViewRows.length === 0 ? '当前结果集无数据' : `记录 ${textRecordIndex + 1} / ${textViewRows.length}`}
                    </span>
                    {canModifyData && (
                        <Button size="small" type="primary" onClick={openCurrentViewRowEditor} disabled={textViewRows.length === 0}>
                            编辑当前记录
                        </Button>
                    )}
                </div>
                <div className="custom-scrollbar" style={{ flex: 1, overflow: 'auto', padding: '8px 12px' }}>
                    {currentTextRow ? columnNames.map((col) => (
                        <div key={col} style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 10, padding: '6px 0', borderBottom: darkMode ? '1px solid rgba(255,255,255,0.06)' : '1px solid rgba(0,0,0,0.06)', alignItems: 'start' }}>
                            <div style={{ fontWeight: 600, color: darkMode ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.88)', wordBreak: 'break-all' }}>
                                {col} :
                            </div>
                            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: darkMode ? 'rgba(255,255,255,0.88)' : 'rgba(0,0,0,0.88)' }}>
                                {formatTextViewValue((currentTextRow as any)[col])}
                            </div>
                        </div>
                    )) : (
                        <div style={{ fontSize: 12, color: darkMode ? '#999' : '#666', paddingTop: 4 }}>
                            当前结果集无数据
                        </div>
                    )}
                </div>
            </div>
        )}

        {/* Cell Context Menu - 使用 Portal 渲染到 body，避免 backdropFilter 影响 fixed 定位 */}
        {viewMode === 'table' && cellContextMenu.visible && createPortal(
            <div
                style={{
                    position: 'fixed',
                    left: cellContextMenu.x,
                    top: cellContextMenu.y,
                    zIndex: 10000,
                    background: bgContextMenu,
                    border: darkMode ? '1px solid #303030' : '1px solid #d9d9d9',
                    borderRadius: 4,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                    minWidth: 160,
                    color: darkMode ? '#fff' : 'rgba(0, 0, 0, 0.88)'
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div
                    style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        transition: 'background 0.2s',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = darkMode ? '#303030' : '#f5f5f5'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    onClick={handleCellSetNull}
                >
                    设置为 NULL
                </div>
                <div
                    style={{
                        padding: '8px 12px',
                        cursor: selectedRowKeys.length > 0 ? 'pointer' : 'not-allowed',
                        transition: 'background 0.2s',
                        opacity: selectedRowKeys.length > 0 ? 1 : 0.5,
                    }}
                    onMouseEnter={(e) => {
                        if (selectedRowKeys.length > 0) e.currentTarget.style.background = darkMode ? '#303030' : '#f5f5f5';
                    }}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    onClick={() => {
                        if (selectedRowKeys.length > 0 && cellContextMenu.record) {
                            handleBatchFillToSelected(cellContextMenu.record, cellContextMenu.dataIndex);
                        }
                    }}
                >
                    <VerticalAlignBottomOutlined style={{ marginRight: 8 }} />
                    填充到选中行 ({selectedRowKeys.length})
                </div>
                <div style={{ height: 1, background: darkMode ? '#303030' : '#f0f0f0', margin: '4px 0' }} />
                <div
                    style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        transition: 'background 0.2s',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = darkMode ? '#303030' : '#f5f5f5'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    onClick={() => {
                        if (cellContextMenu.record) handleCopyInsert(cellContextMenu.record);
                        setCellContextMenu(prev => ({ ...prev, visible: false }));
                    }}
                >
                    复制为 INSERT
                </div>
                <div
                    style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        transition: 'background 0.2s',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = darkMode ? '#303030' : '#f5f5f5'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    onClick={() => {
                        if (cellContextMenu.record) handleCopyJson(cellContextMenu.record);
                        setCellContextMenu(prev => ({ ...prev, visible: false }));
                    }}
                >
                    复制为 JSON
                </div>
                <div
                    style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        transition: 'background 0.2s',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = darkMode ? '#303030' : '#f5f5f5'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    onClick={() => {
                        if (cellContextMenu.record) handleCopyCsv(cellContextMenu.record);
                        setCellContextMenu(prev => ({ ...prev, visible: false }));
                    }}
                >
                    复制为 CSV
                </div>
                <div
                    style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        transition: 'background 0.2s',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = darkMode ? '#303030' : '#f5f5f5'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    onClick={() => {
                        if (cellContextMenu.record) {
                            const records = getTargets(cellContextMenu.record);
                            const lines = records.map((r: any) => {
                                const { [GONAVI_ROW_KEY]: _rowKey, ...vals } = r;
                                return `| ${Object.values(vals).join(' | ')} |`;
                            });
                            copyToClipboard(lines.join('\n'));
                        }
                        setCellContextMenu(prev => ({ ...prev, visible: false }));
                    }}
                >
                    复制为 Markdown
                </div>
                <div style={{ height: 1, background: darkMode ? '#303030' : '#f0f0f0', margin: '4px 0' }} />
                <div
                    style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        transition: 'background 0.2s',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = darkMode ? '#303030' : '#f5f5f5'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    onClick={() => {
                        if (cellContextMenu.record) handleExportSelected('csv', cellContextMenu.record);
                        setCellContextMenu(prev => ({ ...prev, visible: false }));
                    }}
                >
                    导出为 CSV
                </div>
                <div
                    style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        transition: 'background 0.2s',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = darkMode ? '#303030' : '#f5f5f5'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    onClick={() => {
                        if (cellContextMenu.record) handleExportSelected('xlsx', cellContextMenu.record);
                        setCellContextMenu(prev => ({ ...prev, visible: false }));
                    }}
                >
                    导出为 Excel
                </div>
                <div
                    style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        transition: 'background 0.2s',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = darkMode ? '#303030' : '#f5f5f5'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    onClick={() => {
                        if (cellContextMenu.record) handleExportSelected('json', cellContextMenu.record);
                        setCellContextMenu(prev => ({ ...prev, visible: false }));
                    }}
                >
                    导出为 JSON
                </div>
            </div>,
            document.body
        )}
       </div>
       
       {pagination && (
           <div style={{ padding: '8px', borderTop: 'none', display: 'flex', justifyContent: 'flex-end' }}>
                   <Pagination 
                   current={pagination.current}
                   pageSize={pagination.pageSize}
                   total={pagination.total}
                   showTotal={(total, range) => {
                       const currentCount = Math.max(0, range[1] - range[0] + 1);
                       if (pagination.totalKnown === false) return `当前 ${currentCount} 条 / 正在统计总数...`;
                       return `当前 ${currentCount} 条 / 共 ${total} 条`;
                   }}
                   showSizeChanger
                   pageSizeOptions={['100', '200', '500', '1000']}
                   onChange={onPageChange}
                   size="small"
               />
           </div>
       )}

	        <style>{`
                .${gridId} .ant-table { background: transparent !important; }
                .${gridId} .ant-table-container { background: transparent !important; border: none !important; }
                .${gridId} .ant-table-tbody > tr > td { background: transparent !important; border-bottom: 1px solid ${darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'} !important; border-inline-end: 1px solid transparent !important; }
                .${gridId} .ant-table-thead > tr > th { background: transparent !important; border-bottom: 1px solid ${darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'} !important; border-inline-end: 1px solid transparent !important; }
                .${gridId} .ant-table-thead > tr > th::before { display: none !important; }
                .${gridId} .ant-table-tbody > tr:hover > td { background-color: ${darkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.02)'} !important; }
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected > td { background-color: ${darkMode ? 'rgba(24, 144, 255, 0.15)' : 'rgba(24, 144, 255, 0.08)'} !important; }
                .${gridId} .ant-table-tbody > tr.ant-table-row-selected:hover > td { background-color: ${darkMode ? 'rgba(24, 144, 255, 0.25)' : 'rgba(24, 144, 255, 0.12)'} !important; }
	            .${gridId} .row-added td { background-color: ${rowAddedBg} !important; color: ${darkMode ? '#e6fffb' : 'inherit'}; }
	            .${gridId} .row-modified td { background-color: ${rowModBg} !important; color: ${darkMode ? '#e6f7ff' : 'inherit'}; }
                .${gridId} .ant-table-tbody > tr.row-added:hover > td { background-color: ${rowAddedHover} !important; }
                .${gridId} .ant-table-tbody > tr.row-modified:hover > td { background-color: ${rowModHover} !important; }
                .${gridId}.cell-edit-mode .ant-table-tbody > tr > td[data-col-name] { user-select: none; -webkit-user-select: none; cursor: crosshair; }
                .${gridId}.cell-edit-mode .ant-table-tbody > tr > td[data-cell-selected="true"] {
                    box-shadow: inset 0 0 0 2px #1890ff;
                    background-image: linear-gradient(${darkMode ? 'rgba(24, 144, 255, 0.18)' : 'rgba(24, 144, 255, 0.08)'}, ${darkMode ? 'rgba(24, 144, 255, 0.18)' : 'rgba(24, 144, 255, 0.08)'});
                }
                .${gridId} .ant-table-content,
                .${gridId} .ant-table-body {
                    scrollbar-gutter: stable;
                }
                .${gridId} .ant-table-body {
                    padding-bottom: ${tableBodyBottomPadding}px;
                    box-sizing: border-box;
                    scroll-padding-bottom: ${tableBodyBottomPadding}px;
                }
                .${gridId} .ant-table-sticky-scroll {
                    height: 10px !important;
                    background: ${darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'};
                    z-index: 20 !important;
                }
                .${gridId} .ant-table-sticky-scroll-bar {
                    background: ${darkMode ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.28)'} !important;
                }
	        `}</style>
       
       {/* Ghost Resize Line for Columns */}
       <div
           ref={ghostRef}
           style={{
               position: 'absolute',
               top: 0,
               bottom: 0, // Fits container height
               left: 0,
               width: '2px',
               background: '#1890ff',
               zIndex: 9999,
               display: 'none',
               pointerEvents: 'none',
               willChange: 'transform'
           }}
       />

       {/* Import Preview Modal */}
       <ImportPreviewModal
           visible={importPreviewVisible}
           filePath={importFilePath}
           connectionId={connectionId || ''}
           dbName={dbName || ''}
           tableName={tableName || ''}
           onClose={() => {
               setImportPreviewVisible(false);
               setImportFilePath('');
           }}
           onSuccess={handleImportSuccess}
       />
    </div>
  );
};

// 使用 ErrorBoundary 包裹 DataGrid，防止数据渲染错误导致应用崩溃
const MemoizedDataGrid = React.memo(DataGrid);

const DataGridWithErrorBoundary: React.FC<DataGridProps> = (props) => (
    <DataGridErrorBoundary>
        <MemoizedDataGrid {...props} />
    </DataGridErrorBoundary>
);

export default DataGridWithErrorBoundary;
