import React, { useEffect, useState, useContext, useMemo, useRef } from 'react';
import { Table, Tabs, Button, message, Input, Checkbox, Modal, AutoComplete, Tooltip, Select, Empty, Space } from 'antd';
import { ReloadOutlined, SaveOutlined, PlusOutlined, DeleteOutlined, MenuOutlined, FileTextOutlined, EyeOutlined, EditOutlined, ExclamationCircleOutlined } from '@ant-design/icons';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragOverlay } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Resizable } from 'react-resizable';
import Editor, { loader } from '@monaco-editor/react';
import { TabData, ColumnDefinition, IndexDefinition, ForeignKeyDefinition, TriggerDefinition } from '../types';
import { useStore } from '../store';
import { DBGetColumns, DBGetIndexes, DBQuery, DBGetForeignKeys, DBGetTriggers, DBShowCreateTable } from '../../wailsjs/go/app/App';

// Need styles for react-resizable
import 'react-resizable/css/styles.css';

interface EditableColumn extends ColumnDefinition {
    _key: string;
    isNew?: boolean;
    isAutoIncrement?: boolean; // Virtual field for UI
}

const COMMON_TYPES = [
    { value: 'int' },
    { value: 'varchar(255)' },
    { value: 'text' },
    { value: 'datetime' },
    { value: 'tinyint(1)' },
    { value: 'decimal(10,2)' },
    { value: 'bigint' },
    { value: 'json' },
];

const COMMON_DEFAULTS = [
    { value: 'CURRENT_TIMESTAMP' },
    { value: 'NULL' },
    { value: '0' },
    { value: "''" },
];

const CHARSETS = [
    { label: 'utf8mb4 (Recommended)', value: 'utf8mb4' },
    { label: 'utf8', value: 'utf8' },
    { label: 'latin1', value: 'latin1' },
    { label: 'ascii', value: 'ascii' },
];

const COLLATIONS = {
    'utf8mb4': [
        { label: 'utf8mb4_unicode_ci (Default)', value: 'utf8mb4_unicode_ci' },
        { label: 'utf8mb4_general_ci', value: 'utf8mb4_general_ci' },
        { label: 'utf8mb4_bin', value: 'utf8mb4_bin' },
        { label: 'utf8mb4_0900_ai_ci', value: 'utf8mb4_0900_ai_ci' },
    ],
    'utf8': [
        { label: 'utf8_unicode_ci', value: 'utf8_unicode_ci' },
        { label: 'utf8_general_ci', value: 'utf8_general_ci' },
        { label: 'utf8_bin', value: 'utf8_bin' },
    ]
};

// --- Resizable Header Component ---
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
          onMouseDown={(e) => {
            e.stopPropagation();
            e.preventDefault(); // Prevent text selection and focus hijacking
          }}
          style={{
              position: 'absolute',
              right: -5,
              bottom: 0,
              top: 0,
              width: 10,
              cursor: 'col-resize',
              zIndex: 10
          }}
        />
      }
      onResize={onResize}
      draggableOpts={{ enableUserSelectHack: true }}
    >
      <th {...restProps} style={{ ...restProps.style, position: 'relative' }} />
    </Resizable>
  );
};

// --- Sortable Row Component ---
interface RowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  'data-row-key': string;
}

const SortableRow = ({ children, ...props }: RowProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: props['data-row-key'],
  });

  const style: React.CSSProperties = {
    ...props.style,
    transform: CSS.Transform.toString(transform),
    transition,
    cursor: 'move',
    ...(isDragging ? { position: 'relative', zIndex: 9999 } : {}),
  };

  return (
    <tr {...props} ref={setNodeRef} style={style} {...attributes}>
      {React.Children.map(children, child => {
        if ((child as React.ReactElement).key === 'sort') {
          return React.cloneElement(child as React.ReactElement, {
            children: (
                <MenuOutlined
                    style={{ cursor: 'grab', color: '#999' }}
                    {...listeners}
                />
            ),
          });
        }
        return child;
      })}
    </tr>
  );
};

const TableDesigner: React.FC<{ tab: TabData }> = ({ tab }) => {
  const isNewTable = !tab.tableName;
  
  const [columns, setColumns] = useState<EditableColumn[]>([]);
  const [originalColumns, setOriginalColumns] = useState<EditableColumn[]>([]);
  const [indexes, setIndexes] = useState<IndexDefinition[]>([]);
  const [fks, setFks] = useState<ForeignKeyDefinition[]>([]);
  const [triggers, setTriggers] = useState<TriggerDefinition[]>([]);
  const [ddl, setDdl] = useState<string>('');
  
  // New Table State
  const [newTableName, setNewTableName] = useState('');
  const [charset, setCharset] = useState('utf8mb4');
  const [collation, setCollation] = useState('utf8mb4_unicode_ci');
  
  const [loading, setLoading] = useState(false);
  const [previewSql, setPreviewSql] = useState<string>('');
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [activeKey, setActiveKey] = useState(tab.initialTab || "columns");
  const [selectedTrigger, setSelectedTrigger] = useState<TriggerDefinition | null>(null);
  const [isTriggerModalOpen, setIsTriggerModalOpen] = useState(false);
  const [isTriggerEditModalOpen, setIsTriggerEditModalOpen] = useState(false);
  const [triggerEditMode, setTriggerEditMode] = useState<'create' | 'edit'>('create');
  const [triggerEditSql, setTriggerEditSql] = useState<string>('');
  const [triggerExecuting, setTriggerExecuting] = useState(false);
  
  const connections = useStore(state => state.connections);
  const theme = useStore(state => state.theme);
  const darkMode = theme === 'dark';
  const readOnly = !!tab.readOnly;

  const [tableHeight, setTableHeight] = useState(500);
  const containerRef = useRef<HTMLDivElement>(null);

  // 初始化透明 Monaco Editor 主题
  useEffect(() => {
    loader.init().then(monaco => {
      monaco.editor.defineTheme('transparent-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': '#00000000',
          'editor.lineHighlightBackground': '#ffffff10',
          'editorGutter.background': '#00000000',
        }
      });
      monaco.editor.defineTheme('transparent-light', {
        base: 'vs',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': '#00000000',
          'editor.lineHighlightBackground': '#00000010',
          'editorGutter.background': '#00000000',
        }
      });
    });
  }, []);

  useEffect(() => {
      if (!containerRef.current) return;
      const resizeObserver = new ResizeObserver(entries => {
          for (let entry of entries) {
              const h = Math.max(200, entry.contentRect.height - 40);
              setTableHeight(h);
          }
      });
      resizeObserver.observe(containerRef.current);
      return () => resizeObserver.disconnect();
  }, [activeKey]); // Re-attach when tab switches

  // --- Resizable Columns State ---
  const [tableColumns, setTableColumns] = useState<any[]>([]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
      if (tab.initialTab) {
          setActiveKey(tab.initialTab);
      }
  }, [tab.initialTab]);

  // Initial Columns Definition
  useEffect(() => {
      const initialCols = [
          ...(readOnly ? [] : [{
              key: 'sort',
              width: 40,
              render: () => <MenuOutlined style={{ cursor: 'grab', color: '#999' }} />,
          }]),
          { 
              title: '名', 
              dataIndex: 'name', 
              key: 'name', 
              width: 180,
              render: (text: string, record: EditableColumn) => readOnly ? text : (
                  <Input value={text} onChange={e => handleColumnChange(record._key, 'name', e.target.value)} variant="borderless" />
              )
          },
          { 
              title: '类型', 
              dataIndex: 'type', 
              key: 'type', 
              width: 150,
              render: (text: string, record: EditableColumn) => readOnly ? text : (
                  <AutoComplete options={COMMON_TYPES} value={text} onChange={val => handleColumnChange(record._key, 'type', val)} style={{ width: '100%' }} variant="borderless" />
              )
          },
          { 
              title: '主键', 
              dataIndex: 'key', 
              key: 'key', 
              width: 60,
              align: 'center',
              render: (text: string, record: EditableColumn) => (
                  <Checkbox checked={text === 'PRI'} disabled={readOnly} onChange={e => handleColumnChange(record._key, 'key', e.target.checked ? 'PRI' : '')} />
              )
          },
          {
              title: '自增',
              dataIndex: 'isAutoIncrement',
              key: 'isAutoIncrement',
              width: 60,
              align: 'center',
              render: (val: boolean, record: EditableColumn) => (
                  <Checkbox checked={val} disabled={readOnly} onChange={e => handleColumnChange(record._key, 'isAutoIncrement', e.target.checked)} />
              )
          },
          { 
              title: '不是 Null', 
              dataIndex: 'nullable', 
              key: 'nullable', 
              width: 80,
              align: 'center',
              render: (text: string, record: EditableColumn) => (
                  <Checkbox checked={text === 'NO'} disabled={readOnly || record.key === 'PRI'} onChange={e => handleColumnChange(record._key, 'nullable', e.target.checked ? 'NO' : 'YES')} />
              )
          },
          { 
              title: '默认', 
              dataIndex: 'default', 
              key: 'default', 
              width: 180, // Increased default width
              render: (text: string, record: EditableColumn) => readOnly ? text : (
                  <AutoComplete options={COMMON_DEFAULTS} value={text} onChange={val => handleColumnChange(record._key, 'default', val)} style={{ width: '100%' }} variant="borderless" placeholder="NULL" />
              )
          },
          { 
              title: '注释', 
              dataIndex: 'comment', 
              key: 'comment',
              width: 200,
              render: (text: string, record: EditableColumn) => readOnly ? text : (
                  <Input value={text} onChange={e => handleColumnChange(record._key, 'comment', e.target.value)} variant="borderless" />
              )
          },
          ...(readOnly ? [] : [{
              title: '操作',
              key: 'action',
              width: 60,
              render: (_: any, record: EditableColumn) => (
                  <Button type="text" danger icon={<DeleteOutlined />} onClick={() => handleDeleteColumn(record._key)} />
              )
          }])
      ];
      setTableColumns(initialCols);
  }, [readOnly]); // Re-create if readOnly changes

  const rafRef = React.useRef<number | null>(null);

  // Resize Handler
  const handleResize = (index: number) => (_: React.SyntheticEvent, { size }: { size: { width: number } }) => {
      if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
      }
      rafRef.current = requestAnimationFrame(() => {
        setTableColumns((columns) => {
            const nextColumns = [...columns];
            nextColumns[index] = {
                ...nextColumns[index],
                width: size.width,
            };
            return nextColumns;
        });
        rafRef.current = null;
      });
  };

  const fetchData = async () => {
    if (isNewTable) return; // Don't fetch for new table

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

    const promises: Promise<any>[] = [
        DBGetColumns(config as any, tab.dbName || '', tab.tableName || ''),
        DBGetIndexes(config as any, tab.dbName || '', tab.tableName || ''),
        DBGetForeignKeys(config as any, tab.dbName || '', tab.tableName || ''),
        DBGetTriggers(config as any, tab.dbName || '', tab.tableName || '')
    ];

    if (readOnly) {
        promises.push(DBShowCreateTable(config as any, tab.dbName || '', tab.tableName || ''));
    }

    const results = await Promise.all(promises);
    const colsRes = results[0];
    const idxRes = results[1];
    const fkRes = results[2];
    const trigRes = results[3];
    const ddlRes = readOnly ? results[4] : null;

    if (colsRes.success) {
        const colsWithKey = (colsRes.data as ColumnDefinition[]).map((c, index) => ({
            ...c,
            _key: `col-${index}-${Date.now()}`,
            isAutoIncrement: c.extra && c.extra.toLowerCase().includes('auto_increment')
        }));
        setColumns(JSON.parse(JSON.stringify(colsWithKey)));
        setOriginalColumns(JSON.parse(JSON.stringify(colsWithKey)));
    } else {
        message.error("Failed to load columns: " + colsRes.message);
    }

    if (idxRes.success) setIndexes(idxRes.data);
    if (fkRes.success) setFks(fkRes.data);
    if (trigRes.success) setTriggers(trigRes.data);
    if (ddlRes && ddlRes.success) setDdl(ddlRes.data);
    
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, [tab]);

  // --- Trigger Handlers ---

  const getDbType = (): string => {
    const conn = connections.find(c => c.id === tab.connectionId);
    const type = String(conn?.config?.type || '').toLowerCase();
    if (type === 'mariadb') return 'mysql';
    if (type === 'dameng') return 'dm';
    return type;
  };

  const generateTriggerTemplate = (): string => {
    const dbType = getDbType();
    const tblName = tab.tableName || 'table_name';

    switch (dbType) {
      case 'mysql':
        return `CREATE TRIGGER trigger_name
BEFORE INSERT ON \`${tblName}\`
FOR EACH ROW
BEGIN
    -- 触发器逻辑
END;`;
      case 'postgres':
      case 'kingbase':
      case 'highgo':
      case 'vastbase':
        return `CREATE OR REPLACE FUNCTION trigger_function_name()
RETURNS TRIGGER AS $$
BEGIN
    -- 触发器逻辑
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_name
BEFORE INSERT ON "${tblName}"
FOR EACH ROW
EXECUTE FUNCTION trigger_function_name();`;
      case 'sqlserver':
        return `CREATE TRIGGER trigger_name
ON [${tblName}]
AFTER INSERT
AS
BEGIN
    SET NOCOUNT ON;
    -- 触发器逻辑
END;`;
      case 'oracle':
      case 'dm':
        return `CREATE OR REPLACE TRIGGER trigger_name
BEFORE INSERT ON "${tblName}"
FOR EACH ROW
BEGIN
    -- 触发器逻辑
    NULL;
END;`;
      case 'sqlite':
        return `CREATE TRIGGER trigger_name
AFTER INSERT ON "${tblName}"
BEGIN
    -- 触发器逻辑
END;`;
      default:
        return `-- 请输入 CREATE TRIGGER 语句`;
    }
  };

  const buildDropTriggerSql = (triggerName: string): string => {
    const dbType = getDbType();
    const tblName = tab.tableName || '';

    switch (dbType) {
      case 'mysql':
        return `DROP TRIGGER IF EXISTS \`${triggerName}\``;
      case 'postgres':
      case 'kingbase':
      case 'highgo':
      case 'vastbase':
        return `DROP TRIGGER IF EXISTS "${triggerName}" ON "${tblName}"`;
      case 'sqlserver':
        return `DROP TRIGGER IF EXISTS [${triggerName}]`;
      case 'oracle':
      case 'dm':
        return `DROP TRIGGER "${triggerName}"`;
      case 'sqlite':
        return `DROP TRIGGER IF EXISTS "${triggerName}"`;
      default:
        return `DROP TRIGGER ${triggerName}`;
    }
  };

  const handleCreateTrigger = () => {
    setTriggerEditMode('create');
    setTriggerEditSql(generateTriggerTemplate());
    setIsTriggerEditModalOpen(true);
  };

  const handleEditTrigger = () => {
    if (!selectedTrigger) return;
    setTriggerEditMode('edit');
    // 构建完整的 CREATE TRIGGER 语句
    const dbType = getDbType();
    const tblName = tab.tableName || '';
    let createSql = '';

    if (dbType === 'mysql') {
      createSql = `CREATE TRIGGER \`${selectedTrigger.name}\`
${selectedTrigger.timing} ${selectedTrigger.event} ON \`${tblName}\`
FOR EACH ROW
${selectedTrigger.statement}`;
    } else {
      createSql = selectedTrigger.statement || '-- 无法获取完整的触发器定义';
    }

    setTriggerEditSql(createSql);
    setIsTriggerEditModalOpen(true);
  };

  const handleDeleteTrigger = () => {
    if (!selectedTrigger) return;

    Modal.confirm({
      title: '确认删除触发器',
      icon: <ExclamationCircleOutlined />,
      content: `确定要删除触发器 "${selectedTrigger.name}" 吗？此操作不可撤销。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        const conn = connections.find(c => c.id === tab.connectionId);
        if (!conn) {
          message.error('未找到连接');
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

        const dropSql = buildDropTriggerSql(selectedTrigger.name);

        try {
          const res = await DBQuery(config as any, tab.dbName || '', dropSql);
          if (res.success) {
            message.success('触发器删除成功');
            setSelectedTrigger(null);
            fetchData(); // 刷新列表
          } else {
            message.error('删除失败: ' + res.message);
          }
        } catch (e: any) {
          message.error('删除失败: ' + (e?.message || String(e)));
        }
      }
    });
  };

  const handleExecuteTriggerSql = async () => {
    const conn = connections.find(c => c.id === tab.connectionId);
    if (!conn) {
      message.error('未找到连接');
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

    setTriggerExecuting(true);

    try {
      // 如果是编辑模式，先删除旧触发器
      if (triggerEditMode === 'edit' && selectedTrigger) {
        const dropSql = buildDropTriggerSql(selectedTrigger.name);
        const dropRes = await DBQuery(config as any, tab.dbName || '', dropSql);
        if (!dropRes.success) {
          message.error('删除旧触发器失败: ' + dropRes.message);
          setTriggerExecuting(false);
          return;
        }
      }

      // 执行创建语句
      const res = await DBQuery(config as any, tab.dbName || '', triggerEditSql);
      if (res.success) {
        message.success(triggerEditMode === 'create' ? '触发器创建成功' : '触发器修改成功');
        setIsTriggerEditModalOpen(false);
        setSelectedTrigger(null);
        fetchData(); // 刷新列表
      } else {
        message.error('执行失败: ' + res.message);
      }
    } catch (e: any) {
      message.error('执行失败: ' + (e?.message || String(e)));
    } finally {
      setTriggerExecuting(false);
    }
  };

  // --- Handlers ---

  const handleColumnChange = (key: string, field: keyof EditableColumn, value: any) => {
      setColumns(prev => prev.map(col => {
          if (col._key === key) {
              const newCol = { ...col, [field]: value };
              if (field === 'key' && value === 'PRI') newCol.nullable = 'NO';
              if (field === 'isAutoIncrement' && value === true) {
                  newCol.key = 'PRI';
                  newCol.nullable = 'NO';
                  newCol.type = 'int'; // Suggest INT
              }
              return newCol;
          }
          return col;
      }));
  };

  const handleAddColumn = () => {
      const newCol: EditableColumn = {
          name: isNewTable ? 'new_column' : `new_col_${columns.length + 1}`,
          type: 'varchar(255)',
          nullable: 'YES',
          key: '',
          extra: '',
          comment: '',
          default: '',
          _key: `new-${Date.now()}`,
          isNew: true,
          isAutoIncrement: false
      };
      setColumns([...columns, newCol]);
  };

  const handleDeleteColumn = (key: string) => {
      setColumns(prev => prev.filter(c => c._key !== key));
  };

  const onDragEnd = ({ active, over }: any) => {
    if (active.id !== over?.id) {
      setColumns((previous) => {
        const activeIndex = previous.findIndex((i) => i._key === active.id);
        const overIndex = previous.findIndex((i) => i._key === over?.id);
        return arrayMove(previous, activeIndex, overIndex);
      });
    }
  };

  const generateDDL = () => {
      if (isNewTable && !newTableName.trim()) {
          message.error("请输入表名");
          return;
      }
      if (columns.length === 0) {
          message.error("请至少添加一个字段");
          return;
      }

      const tableName = `\`${isNewTable ? newTableName : tab.tableName}\``;
      
      if (isNewTable) {
          // CREATE TABLE
          const colDefs = columns.map(curr => {
              let extra = curr.extra || "";
              if (curr.isAutoIncrement) {
                  extra += " AUTO_INCREMENT";
              }
              return `\`${curr.name}\` ${curr.type} ${curr.nullable === 'NO' ? 'NOT NULL' : 'NULL'} ${curr.default ? `DEFAULT '${curr.default}'` : ''} ${extra} COMMENT '${curr.comment}'`;
          });
          
          const pks = columns.filter(c => c.key === 'PRI').map(c => `\`${c.name}\``);
          if (pks.length > 0) {
              colDefs.push(`PRIMARY KEY (${pks.join(', ')})`);
          }
          
          // Append Charset and Collation
          const sql = `CREATE TABLE ${tableName} (\n  ${colDefs.join(",\n  ")}\n) ENGINE=InnoDB DEFAULT CHARSET=${charset} COLLATE=${collation};`;
          setPreviewSql(sql);
          setIsPreviewOpen(true);
      } else {
          // ALTER TABLE (Existing logic)
          const alters: string[] = [];
          
          originalColumns.forEach(orig => {
              if (!columns.find(c => c._key === orig._key)) {
                  alters.push(`DROP COLUMN \`${orig.name}\``);
              }
          });

          columns.forEach((curr, index) => {
              const orig = originalColumns.find(c => c._key === curr._key);
              const prevCol = index > 0 ? columns[index - 1] : null;
              const positionSql = prevCol ? `AFTER \`${prevCol.name}\`` : 'FIRST';
              
              let extra = curr.extra || "";
              if (curr.isAutoIncrement) {
                  if (!extra.toLowerCase().includes('auto_increment')) extra += " AUTO_INCREMENT";
              } else {
                  extra = extra.replace(/auto_increment/gi, "").trim();
              }

              const colDef = `\`${curr.name}\` ${curr.type} ${curr.nullable === 'NO' ? 'NOT NULL' : 'NULL'} ${curr.default ? `DEFAULT '${curr.default}'` : ''} ${extra} COMMENT '${curr.comment}'`;

              if (!orig) {
                  alters.push(`ADD COLUMN ${colDef} ${positionSql}`);
              } else {
                  const origIndex = originalColumns.findIndex(c => c._key === curr._key);
                  const origPrevCol = origIndex > 0 ? originalColumns[origIndex - 1] : null;
                  
                  let positionChanged = false;
                  if (index === 0 && origIndex !== 0) positionChanged = true;
                  if (index > 0 && (!origPrevCol || origPrevCol._key !== prevCol?._key)) positionChanged = true;

                  const isNameChanged = orig.name !== curr.name;
                  const isTypeChanged = orig.type !== curr.type;
                  const isNullableChanged = orig.nullable !== curr.nullable;
                  const isDefaultChanged = orig.default !== curr.default;
                  const isCommentChanged = orig.comment !== curr.comment;
                  const isAIChanged = orig.isAutoIncrement !== curr.isAutoIncrement;

                  if (isNameChanged || isTypeChanged || isNullableChanged || isDefaultChanged || isCommentChanged || positionChanged || isAIChanged) {
                      if (isNameChanged) {
                          alters.push(`CHANGE COLUMN \`${orig.name}\` ${colDef} ${positionSql}`);
                      } else {
                          alters.push(`MODIFY COLUMN ${colDef} ${positionSql}`);
                      }
                  }
              }
          });

          const origPKKeys = originalColumns.filter(c => c.key === 'PRI').map(c => c._key);
          const newPKKeys = columns.filter(c => c.key === 'PRI').map(c => c._key);
          const keysChanged = origPKKeys.length !== newPKKeys.length || !origPKKeys.every(k => newPKKeys.includes(k));

          if (keysChanged) {
              if (origPKKeys.length > 0) alters.push(`DROP PRIMARY KEY`);
              if (newPKKeys.length > 0) {
                  const pkNames = columns.filter(c => c.key === 'PRI').map(c => `\`${c.name}\``).join(', ');
                  alters.push(`ADD PRIMARY KEY (${pkNames})`);
              }
          }

          if (alters.length === 0) {
              message.info("没有检测到变更");
              return;
          }

          const sql = `ALTER TABLE ${tableName}\n` + alters.join(",\n");
          setPreviewSql(sql);
          setIsPreviewOpen(true);
      }
  };

	  const handleExecuteSave = async () => {
	      const conn = connections.find(c => c.id === tab.connectionId);
	      if (!conn) return;
	      const config = { ...conn.config, port: Number(conn.config.port), password: conn.config.password || "", database: conn.config.database || "", useSSH: conn.config.useSSH || false, ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" } };
	      const res = await DBQuery(config as any, tab.dbName || '', previewSql);
	      if (res.success) {
	          message.success(isNewTable ? "表创建成功！" : "表结构修改成功！");
	          setIsPreviewOpen(false);
	          if (!isNewTable) {
              fetchData();
          } else {
              // TODO: Close tab or reload sidebar?
              // Ideally, refresh sidebar node.
          }
      } else {
          message.error("执行失败: " + res.message);
      }
  };

  // Merge columns with resize handler
  const resizableColumns = tableColumns.map((col, index) => ({
    ...col,
    onHeaderCell: (column: any) => ({
      width: column.width,
      onResize: handleResize(index),
    }),
  }));

  const columnsTabContent = (
      <div ref={containerRef} className="table-designer-wrapper" style={{ height: '100%', overflow: 'hidden', position: 'relative' }}>
        <style>{`
           .table-designer-wrapper .ant-table-body {
               max-height: ${tableHeight}px !important;
           }
        `}</style>
        {readOnly ? (
        <Table 
            dataSource={columns} 
            columns={resizableColumns} 
            rowKey="_key" 
            size="small" 
            pagination={false} 
            loading={loading}
            scroll={{ y: tableHeight }}
            bordered
            components={{
              header: {
                cell: ResizableTitle,
              },
            }}
        />
  ) : (
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={columns.map(c => c._key)} strategy={verticalListSortingStrategy}>
            <Table 
                dataSource={columns} 
                columns={resizableColumns} 
                rowKey="_key" 
                size="small" 
                pagination={false} 
                loading={loading}
                scroll={{ y: tableHeight }}
                bordered
                components={{
                    body: { row: SortableRow },
                    header: { cell: ResizableTitle }
                }}
            />
        </SortableContext>
      </DndContext>
  )}
  </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ padding: '8px', borderBottom: '1px solid #eee', display: 'flex', gap: '8px', alignItems: 'center' }}>
            {isNewTable && (
                <>
                    <Input 
                        placeholder="请输入表名" 
                        value={newTableName} 
                        onChange={e => setNewTableName(e.target.value)} 
                        style={{ width: 150 }} 
                    />
                    <Select 
                        value={charset} 
                        onChange={v => {
                            setCharset(v);
                            // Set default collation
                            const cols = (COLLATIONS as any)[v];
                            if (cols && cols.length > 0) setCollation(cols[0].value);
                        }} 
                        options={CHARSETS} 
                        style={{ width: 120 }} 
                    />
                    <Select 
                        value={collation} 
                        onChange={setCollation} 
                        options={(COLLATIONS as any)[charset] || []} 
                        style={{ width: 150 }} 
                    />
                </>
            )}
            {!readOnly && <Button icon={<SaveOutlined />} type="primary" onClick={generateDDL}>保存</Button>}
            {!isNewTable && <Button icon={<ReloadOutlined />} onClick={fetchData}>刷新</Button>}
            {!readOnly && <Button icon={<PlusOutlined />} onClick={handleAddColumn}>添加字段</Button>}
            <div style={{ flex: 1 }} />
        </div>
        <Tabs 
            activeKey={activeKey}
            onChange={setActiveKey}
            style={{ flex: 1, padding: '0 10px' }}
            items={[
                {
                    key: 'columns',
                    label: '字段',
                    children: columnsTabContent
                },
                ...(!isNewTable ? [
                    {
                        key: 'indexes',
                        label: '索引',
                        children: (
                            <Table 
                                dataSource={indexes} 
                                columns={[
                                    { title: '名', dataIndex: 'name', key: 'name' },
                                    { title: '字段', dataIndex: 'columnName', key: 'columnName' },
                                    { title: '索引类型', dataIndex: 'indexType', key: 'indexType' },
                                    { title: '唯一', dataIndex: 'nonUnique', key: 'nonUnique', render: (v: number) => v === 0 ? 'Unique' : 'Normal' },
                                ]}
                                rowKey={(r) => r.name + r.columnName} 
                                size="small" 
                                pagination={false} 
                                loading={loading}
                            />
                        )
                    },
                    {
                        key: 'foreignKeys',
                        label: '外键',
                        children: (
                            <Table 
                                dataSource={fks} 
                                columns={[
                                    { title: '名', dataIndex: 'name', key: 'name' },
                                    { title: '字段', dataIndex: 'columnName', key: 'columnName' },
                                    { title: '参考表', dataIndex: 'refTableName', key: 'refTableName' },
                                    { title: '参考字段', dataIndex: 'refColumnName', key: 'refColumnName' },
                                ]}
                                rowKey="name" 
                                size="small" 
                                pagination={false} 
                                loading={loading}
                            />
                        )
                    },
                    {
                        key: 'triggers',
                        label: '触发器',
                        children: (
                            <div>
                                <div style={{ marginBottom: 8, display: 'flex', gap: 8 }}>
                                    <Button
                                        size="small"
                                        icon={<EyeOutlined />}
                                        disabled={!selectedTrigger}
                                        onClick={() => setIsTriggerModalOpen(true)}
                                    >
                                        查看语句
                                    </Button>
                                    <Button size="small" icon={<PlusOutlined />} onClick={handleCreateTrigger}>新增</Button>
                                    <Button size="small" icon={<EditOutlined />} disabled={!selectedTrigger} onClick={handleEditTrigger}>修改</Button>
                                    <Button size="small" icon={<DeleteOutlined />} danger disabled={!selectedTrigger} onClick={handleDeleteTrigger}>删除</Button>
                                    <span style={{ marginLeft: 'auto', color: '#888', fontSize: 12, alignSelf: 'center' }}>
                                        {selectedTrigger ? `已选择: ${selectedTrigger.name}` : '请点击选择触发器'}
                                    </span>
                                </div>
                                <Table
                                    dataSource={triggers}
                                    columns={[
                                        { title: '名称', dataIndex: 'name', key: 'name' },
                                        { title: '时机', dataIndex: 'timing', key: 'timing', width: 100 },
                                        { title: '事件', dataIndex: 'event', key: 'event', width: 100 },
                                    ]}
                                    rowKey="name"
                                    size="small"
                                    pagination={false}
                                    loading={loading}
                                    locale={{ emptyText: <Empty description="该表暂无触发器" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                                    rowSelection={{
                                        type: 'radio',
                                        selectedRowKeys: selectedTrigger ? [selectedTrigger.name] : [],
                                        onChange: (_, selectedRows) => setSelectedTrigger(selectedRows[0] || null),
                                        onSelect: (record, selected) => {
                                            // 点击单选按钮时，如果已选中则取消
                                            if (selectedTrigger?.name === record.name) {
                                                setSelectedTrigger(null);
                                            } else {
                                                setSelectedTrigger(record);
                                            }
                                        },
                                    }}
                                    onRow={(record) => ({
                                        onClick: () => {
                                            // 点击已选中的行时取消选择
                                            if (selectedTrigger?.name === record.name) {
                                                setSelectedTrigger(null);
                                            } else {
                                                setSelectedTrigger(record);
                                            }
                                        },
                                        style: { cursor: 'pointer' }
                                    })}
                                />
                            </div>
                        )
                    }
                ] : []),
                ...(readOnly ? [{
                    key: 'ddl',
                    label: 'DDL',
                    icon: <FileTextOutlined />,
                    children: (
                        <div style={{ height: 'calc(100vh - 200px)', border: darkMode ? '1px solid #303030' : '1px solid #d9d9d9', borderRadius: 4 }}>
                            <Editor
                                height="100%"
                                language="sql"
                                theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                                value={ddl}
                                options={{
                                    readOnly: true,
                                    minimap: { enabled: false },
                                    fontSize: 14,
                                    lineNumbers: 'on',
                                    scrollBeyondLastLine: false,
                                    wordWrap: 'on',
                                    automaticLayout: true,
                                }}
                            />
                        </div>
                    )
                }] : [])
            ]}
        />

        <Modal
            title="确认 SQL 变更"
            open={isPreviewOpen}
            onOk={handleExecuteSave}
            onCancel={() => setIsPreviewOpen(false)}
            width={700}
            okText="执行"
            cancelText="取消"
        >
            <div style={{ maxHeight: '400px', overflow: 'auto' }}>
                <pre style={{ background: '#f5f5f5', padding: '10px', borderRadius: '4px', border: '1px solid #eee', whiteSpace: 'pre-wrap' }}>
                    {previewSql}
                </pre>
            </div>
            <p style={{ marginTop: 10, color: '#faad14' }}>请仔细检查 SQL，执行后不可撤销。</p>
        </Modal>

        <Modal
            title={selectedTrigger ? `触发器: ${selectedTrigger.name}` : '触发器详情'}
            open={isTriggerModalOpen}
            onCancel={() => setIsTriggerModalOpen(false)}
            footer={null}
            width={700}
        >
            {selectedTrigger && (
                <div>
                    <div style={{ marginBottom: 12, display: 'flex', gap: 24 }}>
                        <span><strong>时机:</strong> {selectedTrigger.timing}</span>
                        <span><strong>事件:</strong> {selectedTrigger.event}</span>
                    </div>
                    <div style={{ border: darkMode ? '1px solid #303030' : '1px solid #d9d9d9', borderRadius: 4 }}>
                        <Editor
                            height="350px"
                            language="sql"
                            theme={darkMode ? 'transparent-dark' : 'transparent-light'}
                            value={selectedTrigger.statement}
                            options={{
                                readOnly: true,
                                minimap: { enabled: false },
                                fontSize: 14,
                                lineNumbers: 'on',
                                scrollBeyondLastLine: false,
                                wordWrap: 'on',
                                automaticLayout: true,
                            }}
                        />
                    </div>
                </div>
            )}
        </Modal>

        <Modal
            title={triggerEditMode === 'create' ? '新增触发器' : '修改触发器'}
            open={isTriggerEditModalOpen}
            onCancel={() => setIsTriggerEditModalOpen(false)}
            width={800}
            okText={triggerEditMode === 'create' ? '创建' : '保存'}
            cancelText="取消"
            confirmLoading={triggerExecuting}
            onOk={handleExecuteTriggerSql}
        >
            <div style={{ marginBottom: 8, color: '#888', fontSize: 12 }}>
                {triggerEditMode === 'edit' && selectedTrigger && (
                    <span>修改触发器时会先删除原触发器，再创建新触发器。</span>
                )}
            </div>
            <div style={{ border: darkMode ? '1px solid #303030' : '1px solid #d9d9d9', borderRadius: 4 }}>
                <Editor
                    height="350px"
                    language="sql"
                    theme={darkMode ? 'vs-dark' : 'light'}
                    value={triggerEditSql}
                    onChange={(val) => setTriggerEditSql(val || '')}
                    options={{
                        minimap: { enabled: false },
                        fontSize: 14,
                        lineNumbers: 'on',
                        scrollBeyondLastLine: false,
                        wordWrap: 'on',
                        automaticLayout: true,
                    }}
                />
            </div>
            <p style={{ marginTop: 10, color: '#faad14' }}>请仔细检查 SQL 语句，执行后不可撤销。</p>
        </Modal>
    </div>
  );
};

export default TableDesigner;
