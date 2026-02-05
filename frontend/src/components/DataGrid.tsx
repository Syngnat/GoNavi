import React, { useState, useEffect, useRef, useContext, useMemo, useCallback } from 'react';
import { Table, message, Input, Button, Dropdown, MenuProps, Form, Pagination, Select, Modal } from 'antd';
import type { SortOrder } from 'antd/es/table/interface';
import { ReloadOutlined, ImportOutlined, ExportOutlined, DownOutlined, PlusOutlined, DeleteOutlined, SaveOutlined, UndoOutlined, FilterOutlined, CloseOutlined, ConsoleSqlOutlined, FileTextOutlined, CopyOutlined, ClearOutlined, EditOutlined } from '@ant-design/icons';
import Editor from '@monaco-editor/react';
import { ImportData, ExportTable, ExportData, ExportQuery, ApplyChanges } from '../../wailsjs/go/app/App';
import { useStore } from '../store';
import { v4 as uuidv4 } from 'uuid';
import 'react-resizable/css/styles.css';
import { buildWhereSQL, escapeLiteral, quoteIdentPart, quoteQualifiedIdent } from '../utils/sql';

// 内部行标识字段：避免与真实业务字段（如 `key` 列）冲突。
export const GONAVI_ROW_KEY = '__gonavi_row_key__';

// Normalize RFC3339-like datetime strings to `YYYY-MM-DD HH:mm:ss` for display/editing.
const normalizeDateTimeString = (val: string) => {
    const match = val.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
    if (!match) return val;
    return `${match[1]} ${match[2]}`;
};

// --- Helper: Format Value ---
const formatCellValue = (val: any) => {
    if (val === null) return <span style={{ color: '#ccc' }}>NULL</span>;
    if (typeof val === 'object') return JSON.stringify(val);
    if (typeof val === 'string') {
        return normalizeDateTimeString(val);
    }
    return String(val);
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

const INLINE_EDIT_MAX_CHARS = 2000;

const shouldOpenModalEditor = (val: any): boolean => {
    if (val === null || val === undefined) return false;
    if (typeof val === 'string') {
        return val.length > INLINE_EDIT_MAX_CHARS || val.includes('\n');
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
  const cellRef = useRef<HTMLTableCellElement>(null);
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
      const prevText = toFormText(record?.[dataIndex]);
      const nextText = toFormText(nextValue);
      toggleEdit();
      // 仅当值发生变化时才标记为修改，避免“双击-失焦”导致整行进入 modified 状态（蓝色高亮不清除）。
      if (nextText !== prevText) {
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
        style={{ paddingRight: 24, minHeight: 20 }}
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
          ref={cellRef}
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
    onApplyFilter?: (conditions: any[]) => void;
}

const DataGrid: React.FC<DataGridProps> = ({ 
    data, columnNames, loading, tableName, dbName, connectionId, pkColumns = [], readOnly = false,
    onReload, onSort, onPageChange, pagination, showFilter, onToggleFilter, onApplyFilter
}) => {
  const connections = useStore(state => state.connections);
  const addSqlLog = useStore(state => state.addSqlLog);
  const darkMode = useStore(state => state.darkMode);
  const selectionColumnWidth = 46;
  const [form] = Form.useForm();
  const [modal, contextHolder] = Modal.useModal();
  const gridId = useMemo(() => `grid-${uuidv4()}`, []);
  const [cellEditorOpen, setCellEditorOpen] = useState(false);
  const [cellEditorValue, setCellEditorValue] = useState('');
  const [cellEditorIsJson, setCellEditorIsJson] = useState(false);
  const [cellEditorMeta, setCellEditorMeta] = useState<{ record: Item; dataIndex: string; title: string } | null>(null);
  const cellEditorApplyRef = useRef<((val: string) => void) | null>(null);
  const [rowEditorOpen, setRowEditorOpen] = useState(false);
  const [rowEditorRowKey, setRowEditorRowKey] = useState<string>('');
  const rowEditorBaseRef = useRef<Record<string, string>>({});
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

  useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      let rafId: number | null = null;

      const resizeObserver = new ResizeObserver(entries => {
          if (rafId !== null) cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(() => {
              const target = (entries[0]?.target as HTMLElement | undefined) || containerRef.current;
              if (!target) return;

              const height = target.getBoundingClientRect().height;
              if (!Number.isFinite(height) || height < 50) return;

              const headerEl =
                  (target.querySelector('.ant-table-header') as HTMLElement | null) ||
                  (target.querySelector('.ant-table-thead') as HTMLElement | null);
              const rawHeaderHeight = headerEl ? headerEl.getBoundingClientRect().height : NaN;
              const headerHeight =
                  Number.isFinite(rawHeaderHeight) && rawHeaderHeight >= 24 && rawHeaderHeight <= 120 ? rawHeaderHeight : 42;

              // 留一点余量，避免底部（边框/滚动条）遮挡最后一行
              const extraBottom = 16;
              const nextHeight = Math.max(100, Math.floor(height - headerHeight - extraBottom));
              setTableHeight(nextHeight);
          });
      });

      resizeObserver.observe(el);
      return () => {
          resizeObserver.disconnect();
          if (rafId !== null) cancelAnimationFrame(rafId);
      };
  }, []);

  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [addedRows, setAddedRows] = useState<any[]>([]);
  const [modifiedRows, setModifiedRows] = useState<Record<string, any>>({});
  const [deletedRowKeys, setDeletedRowKeys] = useState<Set<string>>(new Set());

  // Filter State
  const [filterConditions, setFilterConditions] = useState<{ id: number, column: string, op: string, value: string, value2?: string }[]>([]);
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
      rowEditorBaseRef.current = {};
      rowEditorDisplayRef.current = {};
      rowEditorNullColsRef.current = new Set();
      rowEditorForm.resetFields();
      closeCellEditor();
      form.resetFields();
  }, [tableName, dbName, connectionId]); // Reset on context change

  const rowKeyStr = useCallback((k: React.Key) => String(k), []);

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

  const closeRowEditor = useCallback(() => {
      setRowEditorOpen(false);
      setRowEditorRowKey('');
      rowEditorBaseRef.current = {};
      rowEditorDisplayRef.current = {};
      rowEditorNullColsRef.current = new Set();
      rowEditorForm.resetFields();
  }, [rowEditorForm]);

  const openRowEditor = useCallback(() => {
      if (readOnly || !tableName) return;
      if (selectedRowKeys.length > 1) {
          message.info('一次只能编辑一行，请仅选择一行');
          return;
      }

      const keyStr =
          selectedRowKeys.length === 1 ? rowKeyStr(selectedRowKeys[0]) : undefined;
      if (!keyStr) {
          message.info('请先选择一行（勾选复选框）');
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

      const baseMap: Record<string, string> = {};
      const displayMap: Record<string, string> = {};
      const nullCols = new Set<string>();

      columnNames.forEach((col) => {
          const baseVal = (baseRow as any)?.[col];
          const displayVal = (displayRow as any)?.[col];
          baseMap[col] = toFormText(baseVal);
          displayMap[col] = toFormText(displayVal);
          if (baseVal === null || baseVal === undefined) nullCols.add(col);
      });

      rowEditorBaseRef.current = baseMap;
      rowEditorDisplayRef.current = displayMap;
      rowEditorNullColsRef.current = nullCols;

      rowEditorForm.setFieldsValue(displayMap);
      setRowEditorRowKey(keyStr);
      setRowEditorOpen(true);
  }, [readOnly, tableName, selectedRowKeys, mergedDisplayData, data, addedRows, columnNames, rowEditorForm, rowKeyStr]);

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

      const baseMap = rowEditorBaseRef.current || {};
      const patch: Record<string, any> = {};
      columnNames.forEach((col) => {
          const nextVal = values[col];
          const nextStr = toFormText(nextVal);
          const baseStr = baseMap[col] ?? '';
          if (nextStr !== baseStr) patch[col] = nextStr;
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
          editable: !readOnly && !!tableName, // Only editable if table name known
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
  }, [columnNames, columnWidths, sortInfo, handleResizeStart, readOnly, tableName, onSort]);

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
                  const nextStr = toFormText(nextVal);
                  const prevStr = toFormText(prevVal);
                  if (nextStr !== prevStr) values[col] = nextVal;
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
      if (res.success) { message.success(res.message); if (onReload) onReload(); } else if (res.message !== "Cancelled") { message.error("Import Failed: " + res.message); }
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
      setFilterConditions([...filterConditions, { id: nextFilterId, column: columnNames[0] || '', op: '=', value: '', value2: '' }]);
      setNextFilterId(nextFilterId + 1);
  };
  const updateFilter = (id: number, field: string, val: string) => {
      setFilterConditions(prev => prev.map(c => {
          if (c.id !== id) return c;
          const next: any = { ...c, [field]: val };
          if (field === 'op') {
              if (isNoValueOp(val)) {
                  next.value = '';
                  next.value2 = '';
              } else if (isBetweenOp(val)) {
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

  return (
    <div className={gridId} style={{ flex: '1 1 auto', height: '100%', overflow: 'hidden', padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
	           
	           {!readOnly && tableName && (
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
       </div>

       {/* Filter Panel */}
       {showFilter && (
           <div style={{ padding: '8px', background: '#f5f5f5', borderBottom: '1px solid #eee' }}>
               {filterConditions.map(cond => (
                   <div key={cond.id} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'flex-start' }}>
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
                    <div style={{ maxHeight: '62vh', overflow: 'auto', paddingRight: 8 }}>
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
            destroyOnHidden
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
            {cellEditorOpen && (
                <Editor
                    height="56vh"
                    language={cellEditorIsJson ? "json" : "plaintext"}
                    theme={darkMode ? "vs-dark" : "light"}
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
            )}
        </Modal>
        <Form component={false} form={form}>
            <DataContext.Provider value={{ selectedRowKeysRef, displayDataRef, handleCopyInsert, handleCopyJson, handleCopyCsv, handleExportSelected, copyToClipboard, tableName }}>
                <CellContextMenuContext.Provider value={{ showMenu: showCellContextMenu }}>
                    <EditableContext.Provider value={form}>
                        <Table
                            components={tableComponents}
                            dataSource={mergedDisplayData}
                            columns={mergedColumns}
                            size="small"
                            tableLayout="fixed"
                            scroll={{ x: Math.max(totalWidth, 1000), y: tableHeight }}
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

        {/* Cell Context Menu */}
        {cellContextMenu.visible && (
            <div
                style={{
                    position: 'fixed',
                    left: cellContextMenu.x,
                    top: cellContextMenu.y,
                    zIndex: 10000,
                    background: '#fff',
                    border: '1px solid #d9d9d9',
                    borderRadius: 4,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                    minWidth: 120,
                }}
                onClick={(e) => e.stopPropagation()}
            >
                <div
                    style={{
                        padding: '8px 12px',
                        cursor: 'pointer',
                        transition: 'background 0.2s',
                    }}
                    onMouseEnter={(e) => e.currentTarget.style.background = '#f5f5f5'}
                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    onClick={handleCellSetNull}
                >
                    设置为 NULL
                </div>
            </div>
        )}
       </div>
       
       {pagination && (
           <div style={{ padding: '8px', borderTop: '1px solid #eee', display: 'flex', justifyContent: 'flex-end', background: '#fff' }}>
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
	            .${gridId} .row-added td { background-color: #f6ffed !important; }
	            .${gridId} .row-modified td { background-color: #e6f7ff !important; }
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
    </div>
  );
};

export default React.memo(DataGrid);
