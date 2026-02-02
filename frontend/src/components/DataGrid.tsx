import React, { useState, useEffect, useRef, useContext, useMemo, useCallback } from 'react';
import { Table, message, Input, Button, Dropdown, MenuProps, Form, Pagination, Select, Modal } from 'antd';
import type { SortOrder } from 'antd/es/table/interface';
import { ReloadOutlined, ImportOutlined, ExportOutlined, DownOutlined, PlusOutlined, DeleteOutlined, SaveOutlined, UndoOutlined, FilterOutlined, CloseOutlined, ConsoleSqlOutlined, FileTextOutlined, CopyOutlined, ClearOutlined } from '@ant-design/icons';
import { Resizable } from 'react-resizable';
import { ImportData, ExportTable, ExportData, ApplyChanges } from '../../wailsjs/go/app/App';
import { useStore } from '../store';
import { v4 as uuidv4 } from 'uuid';
import 'react-resizable/css/styles.css';

// --- Helper: Format Value ---
const formatCellValue = (val: any) => {
    if (val === null) return <span style={{ color: '#ccc' }}>NULL</span>;
    if (typeof val === 'object') return JSON.stringify(val);
    if (typeof val === 'string') {
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(val)) {
            return val.replace('T', ' ').replace(/\+.*$/, '').replace(/Z$/, '');
        }
    }
    return String(val);
};

// --- Resizable Header (Native Implementation) ---
const ResizableTitle = (props: any) => {
  const { onResizeStart, width, ...restProps } = props;

  if (!width) {
    return <th {...restProps} />;
  }

  return (
    <th {...restProps} style={{ ...restProps.style, position: 'relative' }}>
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
  key: string;
  [key: string]: any;
}

interface EditableCellProps {
  title: React.ReactNode;
  editable: boolean;
  children: React.ReactNode;
  dataIndex: string;
  record: Item;
  handleSave: (record: Item) => void;
  [key: string]: any;
}

const EditableCell: React.FC<EditableCellProps> = React.memo(({
  title,
  editable,
  children,
  dataIndex,
  record,
  handleSave,
  ...restProps
}) => {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<any>(null);
  const form = useContext(EditableContext);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
    }
  }, [editing]);

  const toggleEdit = () => {
    setEditing(!editing);
    form.setFieldsValue({ [dataIndex]: record[dataIndex] });
  };

  const save = async () => {
    try {
      if (!form) return;
      const values = await form.validateFields();
      toggleEdit();
      handleSave({ ...record, ...values });
    } catch (errInfo) {
      console.log('Save failed:', errInfo);
    }
  };

  let childNode = children;

  if (editable) {
    childNode = editing ? (
      <Form.Item style={{ margin: 0 }} name={dataIndex}>
        <Input ref={inputRef} onPressEnter={save} onBlur={save} />
      </Form.Item>
    ) : (
      <div className="editable-cell-value-wrap" style={{ paddingRight: 24, minHeight: 20 }}>
        {children}
      </div>
    );
  }

  return <td {...restProps} onDoubleClick={editable ? toggleEdit : undefined}>{childNode}</td>;
});

const ContextMenuRow = React.memo(({ children, ...props }: any) => {
    const record = props.record; 
    const context = useContext(DataContext);
    
    if (!record || !context) return <tr {...props}>{children}</tr>;

    const { selectedRowKeysRef, displayDataRef, handleCopyInsert, handleCopyJson, handleCopyCsv, handleExportSelected, copyToClipboard } = context;

    const getTargets = () => {
        const keys = selectedRowKeysRef.current;
        if (keys.includes(record.key)) {
            return displayDataRef.current.filter(d => keys.includes(d.key));
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
                const { key, ...vals } = r;
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
    pagination?: { current: number, pageSize: number, total: number };
    // Filtering
    showFilter?: boolean;
    onToggleFilter?: () => void;
    onApplyFilter?: (conditions: any[]) => void;
}

const DataGrid: React.FC<DataGridProps> = ({ 
    data, columnNames, loading, tableName, dbName, connectionId, pkColumns = [], readOnly = false,
    onReload, onSort, onPageChange, pagination, showFilter, onToggleFilter, onApplyFilter
}) => {
  const { connections } = useStore();
  const addSqlLog = useStore(state => state.addSqlLog);
  const [form] = Form.useForm();
  const [modal, contextHolder] = Modal.useModal();
  const gridId = useMemo(() => `grid-${uuidv4()}`, []);
  
  // Helper to export specific data
  const exportData = async (rows: any[], format: string) => {
      const hide = message.loading(`正在导出 ${rows.length} 条数据...`, 0);
      const cleanRows = rows.map(({ key, ...rest }) => rest);
      // Pass tableName (or 'export') as default filename
      const res = await ExportData(cleanRows, columnNames, tableName || 'export', format);
      hide();
      if (res.success) { message.success("导出成功"); } else if (res.message !== "Cancelled") { message.error("导出失败: " + res.message); }
  };
  
  const [sortInfo, setSortInfo] = useState<{ columnKey: string, order: string } | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  
  // Dynamic Height
  const [tableHeight, setTableHeight] = useState(500);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
      if (!containerRef.current) return;
      
      let rafId: number;
      const resizeObserver = new ResizeObserver(entries => {
          rafId = requestAnimationFrame(() => {
              for (let entry of entries) {
                  // Use boundingClientRect for more accurate render size (including padding if any)
                  const height = entry.contentRect.height;
                  if (height < 50) return; 
                  // Subtract header (~42px) and a buffer
                  const h = Math.max(100, height - 42); 
                  setTableHeight(h); 
              }
          });
      });
      
      resizeObserver.observe(containerRef.current);
      return () => {
          resizeObserver.disconnect();
          cancelAnimationFrame(rafId);
      };
  }, []);

  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [addedRows, setAddedRows] = useState<any[]>([]);
  const [modifiedRows, setModifiedRows] = useState<Record<string, any>>({});
  const [deletedRowKeys, setDeletedRowKeys] = useState<Set<React.Key>>(new Set());

  // Filter State
  const [filterConditions, setFilterConditions] = useState<{ id: number, column: string, op: string, value: string }[]>([]);
  const [nextFilterId, setNextFilterId] = useState(1);

  const selectedRowKeysRef = useRef(selectedRowKeys);
  const displayDataRef = useRef<any[]>([]);

  useEffect(() => { selectedRowKeysRef.current = selectedRowKeys; }, [selectedRowKeys]);

  // Reset local state when data source likely changes (e.g. tableName change)
  useEffect(() => {
      setAddedRows([]);
      setModifiedRows({});
      setDeletedRowKeys(new Set());
      setSelectedRowKeys([]);
  }, [tableName, dbName, connectionId]); // Reset on context change

  const displayData = useMemo(() => {
      return [...data, ...addedRows].filter(item => !deletedRowKeys.has(item.key));
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
        key: string
    } | null>(null);
    const ghostRef = useRef<HTMLDivElement>(null);
    const isResizingRef = useRef(false); // Lock for sorting
  
        // 1. Drag Start
  
        const handleResizeStart = useCallback((key: string) => (e: React.MouseEvent) => {
  
            e.preventDefault(); 
  
            e.stopPropagation(); 
  
            
  
            isResizingRef.current = true; // Engage lock
  
      
  
            const startX = e.clientX;
  
            const currentWidth = columnWidths[key] || 200; 
  
            
  
            draggingRef.current = { startX, startWidth: currentWidth, key };
  
      
  
            // Show Ghost Line at initial position
  
            if (ghostRef.current && containerRef.current) {
  
                const containerRect = containerRef.current.getBoundingClientRect();
  
                const relativeLeft = startX - containerRect.left;
  
                ghostRef.current.style.left = `${relativeLeft}px`;
  
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
      if (!draggingRef.current || !ghostRef.current || !containerRef.current) return;

      // Update Ghost Line Position directly
      const containerRect = containerRef.current.getBoundingClientRect();
      const relativeLeft = e.clientX - containerRect.left;
      ghostRef.current.style.left = `${relativeLeft}px`;
  }, []);

  // 3. Drag Stop (Global)
  const handleResizeStop = useCallback((e: MouseEvent) => {
      if (!draggingRef.current) return;

      const { startX, startWidth, key } = draggingRef.current;
      const deltaX = e.clientX - startX;
      const newWidth = Math.max(50, startWidth + deltaX);

      // Commit State
      setColumnWidths(prev => ({ ...prev, [key]: newWidth }));

      // Cleanup
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
      const isAdded = addedRows.some(r => r.key === row.key);
      if (isAdded) {
          setAddedRows(prev => prev.map(r => r.key === row.key ? { ...r, ...row } : r));
      } else {
          setModifiedRows(prev => ({ ...prev, [row.key]: row }));
      }
  }, [addedRows]);

  // Merge Data for Display
  // 'displayData' already merges addedRows. 
  // We need to merge modifiedRows into it for rendering.
  const mergedDisplayData = useMemo(() => {
      return displayData.map(row => {
          if (modifiedRows[row.key]) {
              return { ...row, ...modifiedRows[row.key] };
          }
          return row;
      });
  }, [displayData, modifiedRows]);

  const columns = useMemo(() => {
      return columnNames.map(key => ({
          title: key,
          dataIndex: key,
          key: key,
          ellipsis: true,
          width: columnWidths[key] || 200, 
          sorter: !!onSort, 
          sortOrder: (sortInfo?.columnKey === key ? sortInfo.order : null) as SortOrder | undefined,
          editable: !readOnly && !!tableName, // Only editable if table name known
          render: (text: any) => formatCellValue(text),
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
          }),
      };
  }), [columns, handleCellSave]);

  const handleAddRow = () => {
      const newKey = `new-${Date.now()}`;
      const newRow: any = { key: newKey };
      columnNames.forEach(col => newRow[col] = ''); 
      setAddedRows(prev => [...prev, newRow]);
  };

  const handleDeleteSelected = () => {
      setDeletedRowKeys(prev => {
          const newDeleted = new Set(prev);
          selectedRowKeys.forEach(key => newDeleted.add(key));
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

      addedRows.forEach(row => { const { key, ...vals } = row; inserts.push(vals); });
      deletedRowKeys.forEach(key => {
          // Find original data
          const originalRow = data.find(d => d.key === key) || addedRows.find(d => d.key === key);
          if (originalRow) {
              const pkData: any = {};
              if (pkColumns.length > 0) pkColumns.forEach(k => pkData[k] = originalRow[k]);
              else { const { key: _, ...rest } = originalRow; Object.assign(pkData, rest); }
              deletes.push(pkData);
          }
      });
      Object.entries(modifiedRows).forEach(([key, newRow]) => {
          if (deletedRowKeys.has(key)) return;
          const originalRow = data.find(d => d.key === key);
          if (!originalRow) return; // Should not happen for modified rows unless deleted
          
          const pkData: any = {};
          if (pkColumns.length > 0) pkColumns.forEach(k => pkData[k] = originalRow[k]);
          else { const { key: _, ...rest } = originalRow; Object.assign(pkData, rest); }
          
          const { key: _, ...vals } = newRow;
          updates.push({ keys: pkData, values: vals });
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
          message.success("Changes committed successfully!");
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
          message.error("Commit failed: " + res.message);
      }
  };

  const copyToClipboard = useCallback((text: string) => {
      navigator.clipboard.writeText(text);
      message.success("Copied to clipboard");
  }, []);
  
  const getTargets = useCallback((clickedRecord: any) => {
      const selKeys = selectedRowKeysRef.current;
      const currentData = displayDataRef.current;
      if (selKeys.includes(clickedRecord.key)) {
          return currentData.filter(d => selKeys.includes(d.key));
      }
      return [clickedRecord];
  }, []);

  const handleCopyInsert = useCallback((record: any) => {
      const records = getTargets(record);
      const sqls = records.map((r: any) => {
          const { key, ...vals } = r;
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
          const { key, ...rest } = r;
          return rest;
      });
      copyToClipboard(JSON.stringify(cleanRecords, null, 2));
  }, [getTargets, copyToClipboard]);

  const handleCopyCsv = useCallback((record: any) => {
      const records = getTargets(record);
      const lines = records.map((r: any) => {
          const { key, ...vals } = r;
          const values = Object.values(vals).map(v => v === null ? 'NULL' : `"${v}"`);
          return values.join(',');
      });
      copyToClipboard(lines.join('\n'));
  }, [getTargets, copyToClipboard]);

  // Context Menu Export
  const handleExportSelected = useCallback(async (format: string, record: any) => {
      const records = getTargets(record);
      await exportData(records, format);
  }, [getTargets]);

  // Export
  const handleExport = async (format: string) => {
      if (!connectionId || !tableName) return;
      
      // 1. Export Selected
      if (selectedRowKeys.length > 0) {
          const selectedRows = displayData.filter(d => selectedRowKeys.includes(d.key));
          await exportData(selectedRows, format);
          return;
      }

      // 2. Prompt for Current vs All
      // Using a custom modal content with buttons to handle 3 states
      let instance: any;
      const handleAll = async () => {
          instance.destroy();
          const conn = connections.find(c => c.id === connectionId);
          if (!conn) return;
          const config = { ...conn.config, port: Number(conn.config.port), password: conn.config.password || "", database: conn.config.database || "", useSSH: conn.config.useSSH || false, ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" } };
          const hide = message.loading(`正在导出全部数据...`, 0);
          const res = await ExportTable(config as any, dbName || '', tableName, format);
          hide();
          if (res.success) { message.success("导出成功"); } else if (res.message !== "Cancelled") { message.error("导出失败: " + res.message); }
      };
      const handlePage = async () => {
          instance.destroy();
          await exportData(displayData, format);
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
      const conn = connections.find(c => c.id === connectionId);
      if (!conn) return;
      const config = { ...conn.config, port: Number(conn.config.port), password: conn.config.password || "", database: conn.config.database || "", useSSH: conn.config.useSSH || false, ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" } };
      
      const res = await ImportData(config as any, dbName || '', tableName);
      if (res.success) { message.success(res.message); if (onReload) onReload(); } else if (res.message !== "Cancelled") { message.error("Import Failed: " + res.message); }
  };

  // Filters
  const addFilter = () => {
      setFilterConditions([...filterConditions, { id: nextFilterId, column: columnNames[0] || '', op: '=', value: '' }]);
      setNextFilterId(nextFilterId + 1);
  };
  const updateFilter = (id: number, field: string, val: string) => {
      setFilterConditions(prev => prev.map(c => c.id === id ? { ...c, [field]: val } : c));
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

  const totalWidth = columns.reduce((sum, col) => sum + (col.width as number || 200), 0);

  return (
    <div className={gridId} style={{ height: '100%', overflow: 'hidden', padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
       {/* Toolbar */}
       <div style={{ padding: '8px', borderBottom: '1px solid #eee', display: 'flex', gap: 8, alignItems: 'center' }}>
           {onReload && <Button icon={<ReloadOutlined />} onClick={() => {
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
                   <div key={cond.id} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                       <Select style={{ width: 150 }} value={cond.column} onChange={v => updateFilter(cond.id, 'column', v)} options={columnNames.map(c => ({ value: c, label: c }))} />
                       <Select style={{ width: 100 }} value={cond.op} onChange={v => updateFilter(cond.id, 'op', v)} options={[{ value: '=', label: '=' }, { value: 'LIKE', label: '包含' }]} />
                       <Input style={{ width: 200 }} value={cond.value} onChange={e => updateFilter(cond.id, 'value', e.target.value)} />
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
        <Form component={false} form={form}>
            <DataContext.Provider value={{ selectedRowKeysRef, displayDataRef, handleCopyInsert, handleCopyJson, handleCopyCsv, handleExportSelected, copyToClipboard, tableName }}>
                <EditableContext.Provider value={form}>
                    <Table 
                        components={tableComponents}
                        dataSource={mergedDisplayData} 
                        columns={mergedColumns} 
                        size="small" 
                        scroll={{ x: Math.max(totalWidth, 1000), y: tableHeight }}
                        loading={loading}
                        pagination={false} 
                        onChange={handleTableChange}
                        bordered
                        rowSelection={{
                            selectedRowKeys,
                            onChange: setSelectedRowKeys,
                        }}
                        rowClassName={(record) => {
                            if (addedRows.some(r => r.key === record.key)) return 'row-added';
                            if (modifiedRows[record.key] || deletedRowKeys.has(record.key)) return 'row-modified'; // deleted won't show
                            return '';
                        }}
                        onRow={(record) => ({ record } as any)}
                    />
                </EditableContext.Provider>
            </DataContext.Provider>
        </Form>
       </div>
       
       {pagination && (
           <div style={{ padding: '8px', borderTop: '1px solid #eee', display: 'flex', justifyContent: 'flex-end', background: '#fff' }}>
               <Pagination 
                   current={pagination.current}
                   pageSize={pagination.pageSize}
                   total={pagination.total}
                   showTotal={(total, range) => `当前 ${range[1] - range[0] + 1} 条 / 共 ${total} 条`}
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
           .${gridId} .ant-table-body {
               height: ${tableHeight}px !important;
               max-height: ${tableHeight}px !important;
           }
       `}</style>
       
       {/* Ghost Resize Line for Columns */}
       <div 
           ref={ghostRef}
           style={{
               position: 'absolute',
               top: 0,
               bottom: 0, // Fits container height
               width: '2px',
               background: '#1890ff',
               zIndex: 9999,
               display: 'none',
               pointerEvents: 'none'
           }}
       />
    </div>
  );
};

export default React.memo(DataGrid);
