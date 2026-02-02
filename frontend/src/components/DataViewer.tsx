import React, { useEffect, useState, useRef, useContext, useMemo, useCallback } from 'react';
import { Table, message, Spin, Input, Button, Space, Select, Tag, Dropdown, MenuProps, Form, Popconfirm, Pagination } from 'antd';
import type { SortOrder } from 'antd/es/table/interface';
import { SearchOutlined, FilterOutlined, CloseOutlined, ReloadOutlined, ImportOutlined, ExportOutlined, DownOutlined, PlusOutlined, DeleteOutlined, SaveOutlined, UndoOutlined, CheckOutlined, ConsoleSqlOutlined, FileTextOutlined, CopyOutlined } from '@ant-design/icons';
import { Resizable } from 'react-resizable';
import { TabData, ColumnDefinition } from '../types';
import { useStore } from '../store';
import { MySQLQuery, ImportData, ExportTable, ApplyChanges, DBGetColumns } from '../../wailsjs/go/main/App';
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

// --- Resizable Header ---
const ResizableTitle = (props: any) => {
  const { onResize, width, ...restProps } = props;

  if (!width) {
    return <th {...restProps} />;
  }

  return (
    <Resizable
      width={width}
      height={0}
      handle={
        <span
          className="react-resizable-handle"
          onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
          }}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
              position: 'absolute',
              right: -5,
              bottom: 0,
              top: 0,
              width: 10,
              cursor: 'col-resize',
              zIndex: 100,
              touchAction: 'none'
          }}
        />
      }
      onResize={onResize}
      draggableOpts={{ enableUserSelectHack: false }}
    >
      <th 
        {...restProps} 
        style={{ 
            ...restProps.style, 
            position: 'relative',
            userSelect: 'none'
        }} 
      />
    </Resizable>
  );
};

// --- Contexts ---
const EditableContext = React.createContext<any>(null);

// Use Ref for selection to prevent Context updates on every selection change
const DataContext = React.createContext<{
    selectedRowKeysRef: React.MutableRefObject<React.Key[]>;
    displayDataRef: React.MutableRefObject<any[]>;
    handleCopyInsert: (r: any) => void;
    handleCopyJson: (r: any) => void;
    handleCopyCsv: (r: any) => void;
    copyToClipboard: (t: string) => void;
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

// Optimization: Memoize EditableCell
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
      <Form.Item
        style={{ margin: 0 }}
        name={dataIndex}
      >
        <Input ref={inputRef} onPressEnter={save} onBlur={save} />
      </Form.Item>
    ) : (
      <div className="editable-cell-value-wrap" style={{ paddingRight: 24, minHeight: 20 }} onClick={toggleEdit}>
        {children}
      </div>
    );
  }

  return <td {...restProps}>{childNode}</td>;
});

// --- Context Menu Row Wrapper (External & Memoized) ---
const ContextMenuRow = React.memo(({ children, ...props }: any) => {
    const record = props.record; 
    const context = useContext(DataContext);
    
    if (!record || !context) {
        return <tr {...props}>{children}</tr>;
    }

    const { selectedRowKeysRef, displayDataRef, handleCopyInsert, handleCopyJson, handleCopyCsv, copyToClipboard } = context;

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
    ];

    return (
        <Dropdown menu={{ items: menuItems }} trigger={['contextMenu']}>
            <tr {...props}>{children}</tr>
        </Dropdown>
    );
});

const DataViewer: React.FC<{ tab: TabData }> = ({ tab }) => {
  const [data, setData] = useState<any[]>([]);
  const [columnNames, setColumnNames] = useState<string[]>([]);
  const [pkColumns, setPkColumns] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const connections = useStore(state => state.connections);

  const [pagination, setPagination] = useState({
      current: 1,
      pageSize: 100,
      total: 0
  });

  const [form] = Form.useForm();
  const [sortInfo, setSortInfo] = useState<{ columnKey: string, order: string } | null>(null);
  
  const [showFilter, setShowFilter] = useState(false);
  const [filterConditions, setFilterConditions] = useState<{ id: number, column: string, op: string, value: string }[]>([]);
  const [nextFilterId, setNextFilterId] = useState(1);

  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});

  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [addedRows, setAddedRows] = useState<any[]>([]);
  const [modifiedRows, setModifiedRows] = useState<Record<string, any>>({});
  const [deletedRowKeys, setDeletedRowKeys] = useState<Set<React.Key>>(new Set());

  // Refs
  const selectedRowKeysRef = useRef(selectedRowKeys);
  const displayDataRef = useRef<any[]>([]);

  useEffect(() => {
      selectedRowKeysRef.current = selectedRowKeys;
  }, [selectedRowKeys]);

  const displayData = useMemo(() => {
      return [...data, ...addedRows].filter(item => !deletedRowKeys.has(item.key));
  }, [data, addedRows, deletedRowKeys]);

  useEffect(() => {
      displayDataRef.current = displayData;
  }, [displayData]);

  const hasChanges = addedRows.length > 0 || Object.keys(modifiedRows).length > 0 || deletedRowKeys.size > 0;

  const fetchData = async (page = pagination.current, size = pagination.pageSize) => {
    setLoading(true);
    const conn = connections.find(c => c.id === tab.connectionId);
    if (!conn) {
        message.error("Connection not found");
        setLoading(false);
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

    const dbName = tab.dbName || '';
    const tableName = tab.tableName || '';

    const whereParts: string[] = [];
    filterConditions.forEach(cond => {
        if (cond.column && cond.value) {
            if (cond.op === 'LIKE') {
                whereParts.push(`\`${cond.column}\` LIKE '%${cond.value}%'`);
            } else {
                whereParts.push(`\`${cond.column}\` ${cond.op} '${cond.value}'`);
            }
        }
    });
    const whereSQL = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : "";

    const countSql = `SELECT COUNT(*) as total FROM \`${tableName}\` ${whereSQL}`;
    
    let sql = `SELECT * FROM \`${tableName}\` ${whereSQL}`;
    if (sortInfo && sortInfo.order) {
        sql += ` ORDER BY \`${sortInfo.columnKey}\` ${sortInfo.order === 'ascend' ? 'ASC' : 'DESC'}`;
    }
    const offset = (page - 1) * size;
    sql += ` LIMIT ${size} OFFSET ${offset}`;

    try {
        const pCount = MySQLQuery(config as any, dbName, countSql);
        const pData = MySQLQuery(config as any, dbName, sql);
        
        let pCols = null;
        if (pkColumns.length === 0) {
             pCols = DBGetColumns(config as any, dbName, tableName);
        }

        const [resCount, resData] = await Promise.all([pCount, pData]);
        
        if (pCols) {
            const resCols = await pCols;
            if (resCols.success) {
                const pks = (resCols.data as ColumnDefinition[]).filter(c => c.key === 'PRI').map(c => c.name);
                setPkColumns(pks);
            }
        }

        let totalRecords = 0;
        if (resCount.success && Array.isArray(resCount.data) && resCount.data.length > 0) {
            totalRecords = Number(resCount.data[0]['total']);
        }

        if (resData.success) {
            let resultData = resData.data as any[];
            if (!Array.isArray(resultData)) resultData = [];

            let fieldNames = resData.fields || [];
            if (fieldNames.length === 0 && resultData.length > 0) {
                fieldNames = Object.keys(resultData[0]);
            }
            setColumnNames(fieldNames);
            
            setData(resultData.map((row: any, i: number) => ({ ...row, key: `row-${i}` }))); 
            
            setPagination(prev => ({ ...prev, current: page, pageSize: size, total: totalRecords }));
            
            setAddedRows([]);
            setModifiedRows({});
            setDeletedRowKeys(new Set());
            setSelectedRowKeys([]);
        } else {
            message.error(resData.message);
        }
    } catch (e: any) {
        message.error("Error fetching data: " + e.message);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchData(1, pagination.pageSize); 
  }, [tab, sortInfo]); 
  
  const handlePaginationChange = (page: number, pageSize: number) => {
      fetchData(page, pageSize);
  };

  const handleTableChange = (pag: any, filtersArg: any, sorter: any) => {
      if (sorter.field) {
          setSortInfo({ columnKey: sorter.field as string, order: sorter.order as string });
      } else {
          setSortInfo(null);
      }
  };

  const handleResize = useCallback((key: string) => (_: React.SyntheticEvent, { size }: { size: { width: number } }) => {
      window.requestAnimationFrame(() => {
          setColumnWidths(prev => ({ ...prev, [key]: size.width }));
      });
  }, []);

  const columns = useMemo(() => {
      return columnNames.map(key => ({
          title: key,
          dataIndex: key,
          key: key,
          ellipsis: true,
          width: columnWidths[key] || 200, 
          sorter: true, 
          sortOrder: (sortInfo?.columnKey === key ? sortInfo.order : null) as SortOrder | undefined,
          editable: true, 
          render: (text: any) => formatCellValue(text),
          onHeaderCell: (column: any) => ({
              width: column.width,
              onResize: handleResize(key),
          }),
      }));
  }, [columnNames, columnWidths, sortInfo, handleResize]);

  // Calculate total width
  const totalWidth = columns.reduce((sum, col) => sum + (col.width as number || 200), 0);

  const handleCellSave = useCallback((row: any) => {
      setData(prevData => {
          const newData = [...prevData];
          const index = newData.findIndex(item => item.key === row.key);
          if (index > -1) {
              const item = newData[index];
              newData.splice(index, 1, { ...item, ...row });
              setModifiedRows(prev => ({ ...prev, [row.key]: row }));
              return newData;
          }
          return prevData;
      });
  }, []);

  // Compute merged columns for editable
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
          selectedRowKeys.forEach(key => {
             newDeleted.add(key);
          });
          return newDeleted;
      });
      setSelectedRowKeys([]);
  };

  const handleCommit = async () => {
      const conn = connections.find(c => c.id === tab.connectionId);
      if (!conn) return;

      const inserts: any[] = [];
      const updates: any[] = [];
      const deletes: any[] = [];

      addedRows.forEach(row => { const { key, ...vals } = row; inserts.push(vals); });
      deletedRowKeys.forEach(key => {
          const originalRow = data.find(d => d.key === key);
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
          if (!originalRow) return;
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

      const config = { ...conn.config, port: Number(conn.config.port), password: conn.config.password || "", database: conn.config.database || "", useSSH: conn.config.useSSH || false, ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" } };
      const res = await ApplyChanges(config as any, tab.dbName || '', tab.tableName || '', { inserts, updates, deletes } as any);
      if (res.success) {
          message.success("Changes committed successfully!");
          fetchData();
      } else {
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
          return `INSERT INTO \`${tab.tableName}\` (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${values.join(', ')});`;
      });
      copyToClipboard(sqls.join('\n'));
  }, [tab.tableName, getTargets, copyToClipboard]);

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

  // ... (Filter Handlers)
  const addFilter = () => {
      setFilterConditions([...filterConditions, { id: nextFilterId, column: columnNames[0] || '', op: '=', value: '' }]);
      setNextFilterId(nextFilterId + 1);
      setShowFilter(true);
  };
  const updateFilter = (id: number, field: string, val: string) => {
      setFilterConditions(prev => prev.map(c => c.id === id ? { ...c, [field]: val } : c));
  };
  const removeFilter = (id: number) => {
      setFilterConditions(prev => prev.filter(c => c.id !== id));
  };
  const applyFilters = () => fetchData(1, pagination.pageSize);
  
  const handleImport = async () => { 
      const conn = connections.find(c => c.id === tab.connectionId);
      if (!conn) return;
      const config = { ...conn.config, port: Number(conn.config.port), password: conn.config.password || "", database: conn.config.database || "", useSSH: conn.config.useSSH || false, ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" } };
      const res = await ImportData(config as any, tab.dbName || '', tab.tableName || '');
      if (res.success) { message.success(res.message); fetchData(); } else if (res.message !== "Cancelled") { message.error("Import Failed: " + res.message); }
  };
  
  const handleExport = async (format: string) => {
      const conn = connections.find(c => c.id === tab.connectionId);
      if (!conn) return;
      const config = { ...conn.config, port: Number(conn.config.port), password: conn.config.password || "", database: conn.config.database || "", useSSH: conn.config.useSSH || false, ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" } };
      const hide = message.loading(`Exporting as ${format.toUpperCase()}...`, 0);
      const res = await ExportTable(config as any, tab.dbName || '', tab.tableName || '', format);
      hide();
      if (res.success) { message.success("Export Successful"); } else if (res.message !== "Cancelled") { message.error("Export Failed: " + res.message); }
  };

  const exportMenu: MenuProps['items'] = [
      { key: 'csv', label: 'CSV', onClick: () => handleExport('csv') },
      { key: 'xlsx', label: 'Excel (XLSX)', onClick: () => handleExport('xlsx') },
      { key: 'json', label: 'JSON', onClick: () => handleExport('json') },
      { key: 'md', label: 'Markdown', onClick: () => handleExport('md') },
  ];

  const contextValue = useMemo(() => ({
      selectedRowKeysRef,
      displayDataRef,
      handleCopyInsert,
      handleCopyJson,
      handleCopyCsv,
      copyToClipboard
  }), [handleCopyInsert, handleCopyJson, handleCopyCsv, copyToClipboard]);

  const tableComponents = useMemo(() => ({
      body: { cell: EditableCell, row: ContextMenuRow },
      header: { cell: ResizableTitle }
  }), []); 

  return (
    <div style={{ height: '100%', overflow: 'hidden', padding: 0, display: 'flex', flexDirection: 'column' }}>
       {/* Toolbar */}
       <div style={{ padding: '8px', borderBottom: '1px solid #eee', display: 'flex', gap: 8, alignItems: 'center' }}>
           <Button icon={<ReloadOutlined />} onClick={() => fetchData()}>刷新</Button>
           <Button icon={<ImportOutlined />} onClick={handleImport}>导入</Button>
           <Dropdown menu={{ items: exportMenu }}><Button icon={<ExportOutlined />}>导出 <DownOutlined /></Button></Dropdown>
           <div style={{ width: 1, background: '#eee', height: 20, margin: '0 8px' }} />
           <Button icon={<PlusOutlined />} onClick={handleAddRow}>添加行</Button>
           <Button icon={<DeleteOutlined />} danger disabled={selectedRowKeys.length === 0} onClick={handleDeleteSelected}>删除选中</Button>
           <div style={{ width: 1, background: '#eee', height: 20, margin: '0 8px' }} />
           <Button icon={<SaveOutlined />} type="primary" disabled={!hasChanges} onClick={handleCommit}>提交事务 ({addedRows.length + Object.keys(modifiedRows).length + deletedRowKeys.size})</Button>
           {hasChanges && (<Button icon={<UndoOutlined />} onClick={() => fetchData()}>回滚</Button>)}
           <div style={{ width: 1, background: '#eee', height: 20, margin: '0 8px' }} />
           <Button icon={<FilterOutlined />} type={showFilter ? 'primary' : 'default'} onClick={() => { setShowFilter(!showFilter); if (filterConditions.length === 0 && !showFilter) addFilter(); }}>筛选</Button>
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
                   <Button type="dashed" onClick={addFilter} size="small" icon={<FilterOutlined />}>Add Condition</Button>
                   <Button type="primary" onClick={applyFilters} size="small">Apply</Button>
               </div>
           </div>
       )}

       <div style={{ flex: 1, overflow: 'hidden' }}>
        <Form component={false} form={form}>
            <DataContext.Provider value={contextValue}>
                <EditableContext.Provider value={form}>
                    <Table 
                        components={tableComponents}
                        dataSource={displayData} 
                        columns={mergedColumns} 
                        size="small" 
                        scroll={{ x: Math.max(totalWidth, 1000), y: 'calc(100vh - 200px - 40px)' }}
                        loading={loading}
                        pagination={false} 
                        onChange={handleTableChange}
                        bordered
                        rowSelection={{
                            selectedRowKeys,
                            onChange: setSelectedRowKeys,
                        }}
                        rowClassName={(record) => {
                            if (addedRows.includes(record)) return 'row-added';
                            if (modifiedRows[record.key]) return 'row-modified';
                            return '';
                        }}
                        onRow={(record) => ({ record } as any)}
                    />
                </EditableContext.Provider>
            </DataContext.Provider>
        </Form>
       </div>
       
       {/* Pagination Bar */}
       <div style={{ padding: '8px', borderTop: '1px solid #eee', display: 'flex', justifyContent: 'flex-end', background: '#fff' }}>
           <Pagination 
               current={pagination.current}
               pageSize={pagination.pageSize}
               total={pagination.total}
               showTotal={(total, range) => `当前 ${range[1] - range[0] + 1} 条 / 共 ${total} 条`}
               showSizeChanger
               pageSizeOptions={['100', '200', '500', '1000']}
               onChange={handlePaginationChange}
               size="small"
           />
       </div>

       <style>{`
           .row-added td { background-color: #f6ffed !important; }
           .row-modified td { background-color: #e6f7ff !important; }
       `}</style>
    </div>
  );
};

export default DataViewer;