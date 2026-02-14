import React, { useEffect, useState, useContext, useMemo, useRef, useCallback } from 'react';
import { Table, Tabs, Button, message, Input, Checkbox, Modal, AutoComplete, Tooltip, Select, Empty, Space, Tag } from 'antd';
import { ReloadOutlined, SaveOutlined, PlusOutlined, DeleteOutlined, MenuOutlined, FileTextOutlined, EyeOutlined, EditOutlined, ExclamationCircleOutlined, CopyOutlined } from '@ant-design/icons';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragOverlay } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import Editor, { loader } from '@monaco-editor/react';
import { TabData, ColumnDefinition, IndexDefinition, ForeignKeyDefinition, TriggerDefinition } from '../types';
import { useStore } from '../store';
import { DBGetColumns, DBGetIndexes, DBQuery, DBGetForeignKeys, DBGetTriggers, DBShowCreateTable } from '../../wailsjs/go/app/App';

interface EditableColumn extends ColumnDefinition {
    _key: string;
    isNew?: boolean;
    isAutoIncrement?: boolean; // Virtual field for UI
}

interface IndexDisplayRow {
    key: string;
    name: string;
    indexType: string;
    nonUnique: number;
    columnNames: string[];
}

interface ForeignKeyDisplayRow {
    key: string;
    name: string;
    constraintName: string;
    refTableName: string;
    columnNames: string[];
    refColumnNames: string[];
}

type IndexKind = 'NORMAL' | 'UNIQUE' | 'PRIMARY' | 'FULLTEXT' | 'SPATIAL';

interface IndexFormState {
    name: string;
    columnNames: string[];
    kind: IndexKind;
    indexType: string;
}

interface ForeignKeyFormState {
    constraintName: string;
    columnNames: string[];
    refTableName: string;
    refColumnNames: string[];
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

const MYSQL_INDEX_TYPE_OPTIONS = [
    { label: '默认', value: 'DEFAULT' },
    { label: 'BTREE', value: 'BTREE' },
    { label: 'HASH', value: 'HASH' },
    { label: 'FULLTEXT', value: 'FULLTEXT' },
    { label: 'SPATIAL', value: 'SPATIAL' },
    { label: 'RTREE', value: 'RTREE' },
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

// --- Resizable Header Component (Native, same interaction as DataGrid) ---
const ResizableTitle = (props: any) => {
  const { onResizeStart, width, ...restProps } = props;
  const nextStyle = { ...(restProps.style || {}) } as React.CSSProperties;

  if (width) {
    nextStyle.width = width;
  }

  if (!width) {
    return <th {...restProps} style={nextStyle} />;
  }

  return (
    <th {...restProps} style={{ ...nextStyle, position: 'relative' }}>
      {restProps.children}
      <span
        className="react-resizable-handle"
        onMouseDown={(e) => {
          e.stopPropagation();
          if (typeof onResizeStart === 'function') {
            onResizeStart(e);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute',
          right: 0,
          bottom: 0,
          top: 0,
          width: 10,
          cursor: 'col-resize',
          zIndex: 10,
          touchAction: 'none',
        }}
      />
    </th>
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
  const [selectedColumnRowKeys, setSelectedColumnRowKeys] = useState<string[]>([]);
  const [isCopyColumnsModalOpen, setIsCopyColumnsModalOpen] = useState(false);
  const [copyTableName, setCopyTableName] = useState('');
  const [copyCharset, setCopyCharset] = useState('utf8mb4');
  const [copyCollation, setCopyCollation] = useState('utf8mb4_unicode_ci');
  const [copyExecuting, setCopyExecuting] = useState(false);
  const [tableComment, setTableComment] = useState('');
  const [tableCommentDraft, setTableCommentDraft] = useState('');
  const [isTableCommentModalOpen, setIsTableCommentModalOpen] = useState(false);
  const [tableCommentSaving, setTableCommentSaving] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<IndexDisplayRow | null>(null);
  const [isIndexModalOpen, setIsIndexModalOpen] = useState(false);
  const [indexModalMode, setIndexModalMode] = useState<'create' | 'edit'>('create');
  const [indexSaving, setIndexSaving] = useState(false);
  const [indexForm, setIndexForm] = useState<IndexFormState>({
      name: '',
      columnNames: [],
      kind: 'NORMAL',
      indexType: 'DEFAULT',
  });
  const [selectedForeignKey, setSelectedForeignKey] = useState<ForeignKeyDisplayRow | null>(null);
  const [isForeignKeyModalOpen, setIsForeignKeyModalOpen] = useState(false);
  const [foreignKeyModalMode, setForeignKeyModalMode] = useState<'create' | 'edit'>('create');
  const [foreignKeySaving, setForeignKeySaving] = useState(false);
  const [foreignKeyForm, setForeignKeyForm] = useState<ForeignKeyFormState>({
      constraintName: '',
      columnNames: [],
      refTableName: '',
      refColumnNames: [],
  });
  const [selectedTrigger, setSelectedTrigger] = useState<TriggerDefinition | null>(null);
  const [isTriggerModalOpen, setIsTriggerModalOpen] = useState(false);
  const [isTriggerEditModalOpen, setIsTriggerEditModalOpen] = useState(false);
  const [triggerEditMode, setTriggerEditMode] = useState<'create' | 'edit'>('create');
  const [triggerEditSql, setTriggerEditSql] = useState<string>('');
  const [triggerExecuting, setTriggerExecuting] = useState(false);
  const [isCommentModalOpen, setIsCommentModalOpen] = useState(false);
  const [commentEditorColumnKey, setCommentEditorColumnKey] = useState('');
  const [commentEditorColumnName, setCommentEditorColumnName] = useState('');
  const [commentEditorValue, setCommentEditorValue] = useState('');
  
  const connections = useStore(state => state.connections);
  const theme = useStore(state => state.theme);
  const darkMode = theme === 'dark';
  const readOnly = !!tab.readOnly;

  const [tableHeight, setTableHeight] = useState(500);
  const containerRef = useRef<HTMLDivElement>(null);

  const openCommentEditor = useCallback((record: EditableColumn) => {
      if (!record?._key) return;
      setCommentEditorColumnKey(record._key);
      setCommentEditorColumnName(record.name || '');
      setCommentEditorValue(record.comment || '');
      setIsCommentModalOpen(true);
  }, []);

  const closeCommentEditor = useCallback(() => {
      setIsCommentModalOpen(false);
      setCommentEditorColumnKey('');
      setCommentEditorColumnName('');
      setCommentEditorValue('');
  }, []);

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
  const resizeDragRef = useRef<{ startX: number; startWidth: number; index: number; containerLeft: number } | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const latestResizeXRef = useRef<number | null>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const resizeListenerRef = useRef<{ move: ((e: MouseEvent) => void) | null; up: ((e: MouseEvent) => void) | null }>({
    move: null,
    up: null,
  });

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

  useEffect(() => {
      setSelectedColumnRowKeys(prev => prev.filter(key => columns.some(c => c._key === key)));
  }, [columns]);

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
              render: (text: string, record: EditableColumn) => readOnly ? (
                  <Tooltip title={text || ''}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text || ''}</div>
                  </Tooltip>
              ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Input
                          value={text}
                          onChange={e => handleColumnChange(record._key, 'comment', e.target.value)}
                          onDoubleClick={() => openCommentEditor(record)}
                          variant="borderless"
                      />
                      <Tooltip title="弹框编辑注释">
                          <Button
                              type="text"
                              size="small"
                              icon={<EditOutlined />}
                              onClick={() => openCommentEditor(record)}
                          />
                      </Tooltip>
                  </div>
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

  const flushResizeGhost = useCallback(() => {
    resizeRafRef.current = null;
    if (!resizeDragRef.current || !ghostRef.current) return;
    if (latestResizeXRef.current === null) return;
    const relativeLeft = latestResizeXRef.current - resizeDragRef.current.containerLeft;
    ghostRef.current.style.transform = `translateX(${relativeLeft}px)`;
  }, []);

  const detachResizeListeners = useCallback(() => {
    if (resizeListenerRef.current.move) {
      document.removeEventListener('mousemove', resizeListenerRef.current.move);
      resizeListenerRef.current.move = null;
    }
    if (resizeListenerRef.current.up) {
      document.removeEventListener('mouseup', resizeListenerRef.current.up);
      resizeListenerRef.current.up = null;
    }
  }, []);

  const cleanupResizeState = useCallback(() => {
    if (resizeRafRef.current !== null) {
      cancelAnimationFrame(resizeRafRef.current);
      resizeRafRef.current = null;
    }
    latestResizeXRef.current = null;
    resizeDragRef.current = null;
    if (ghostRef.current) {
      ghostRef.current.style.display = 'none';
    }
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const handleResizeStart = useCallback((index: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const currentWidth = Number(tableColumns[index]?.width || 200);
    const containerLeft = containerRef.current?.getBoundingClientRect().left ?? 0;
    resizeDragRef.current = { startX, startWidth: currentWidth, index, containerLeft };
    latestResizeXRef.current = startX;

    if (ghostRef.current && containerRef.current) {
      const relativeLeft = startX - containerLeft;
      ghostRef.current.style.transform = `translateX(${relativeLeft}px)`;
      ghostRef.current.style.display = 'block';
    }

    detachResizeListeners();

    const onMove = (event: MouseEvent) => {
      if (!resizeDragRef.current) return;
      latestResizeXRef.current = event.clientX;
      if (resizeRafRef.current !== null) return;
      resizeRafRef.current = requestAnimationFrame(flushResizeGhost);
    };

    const onUp = (event: MouseEvent) => {
      if (resizeDragRef.current) {
        const { startX: dragStartX, startWidth, index: dragIndex } = resizeDragRef.current;
        const deltaX = event.clientX - dragStartX;
        const newWidth = Math.max(50, startWidth + deltaX);
        setTableColumns((prevColumns) => {
          if (!prevColumns[dragIndex]) return prevColumns;
          const nextColumns = [...prevColumns];
          nextColumns[dragIndex] = {
            ...nextColumns[dragIndex],
            width: newWidth,
          };
          return nextColumns;
        });
      }

      detachResizeListeners();
      cleanupResizeState();
    };

    resizeListenerRef.current = { move: onMove, up: onUp };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [cleanupResizeState, detachResizeListeners, flushResizeGhost, tableColumns]);

  useEffect(() => {
    return () => {
      detachResizeListeners();
      cleanupResizeState();
    };
  }, [cleanupResizeState, detachResizeListeners]);

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

    if (!isNewTable) {
        promises.push(DBShowCreateTable(config as any, tab.dbName || '', tab.tableName || ''));
    }

    const results = await Promise.all(promises);
    const colsRes = results[0];
    const idxRes = results[1];
    const fkRes = results[2];
    const trigRes = results[3];
    const ddlRes = !isNewTable ? results[4] : null;

    if (colsRes.success) {
        const colsWithKey = (colsRes.data as ColumnDefinition[]).map((c, index) => ({
            ...c,
            _key: `col-${index}-${Date.now()}`,
            isAutoIncrement: c.extra && c.extra.toLowerCase().includes('auto_increment')
        }));
        setColumns(JSON.parse(JSON.stringify(colsWithKey)));
        setOriginalColumns(JSON.parse(JSON.stringify(colsWithKey)));
        setSelectedColumnRowKeys([]);
    } else {
        message.error("Failed to load columns: " + colsRes.message);
    }

    if (idxRes.success) {
        setIndexes(Array.isArray(idxRes.data) ? idxRes.data : []);
    } else {
        setIndexes([]);
    }
    if (fkRes.success) {
        setFks(Array.isArray(fkRes.data) ? fkRes.data : []);
    } else {
        setFks([]);
    }
    if (trigRes.success) {
        setTriggers(Array.isArray(trigRes.data) ? trigRes.data : []);
    } else {
        setTriggers([]);
    }
    if (ddlRes && ddlRes.success) {
        const ddlText = String(ddlRes.data || '');
        setDdl(ddlText);
        const commentMatch = ddlText.replace(/\r?\n/g, ' ').match(/COMMENT\s*=\s*'((?:\\'|''|[^'])*)'/i);
        const parsedTableComment = commentMatch ? commentMatch[1].replace(/\\'/g, "'").replace(/''/g, "'") : '';
        setTableComment(parsedTableComment);
        if (!isTableCommentModalOpen) {
            setTableCommentDraft(parsedTableComment);
        }
    }
    
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
  }, [tab]);

  // --- Trigger Handlers ---

  const getDbType = (): string => {
    const conn = connections.find(c => c.id === tab.connectionId);
    const type = String(conn?.config?.type || '').toLowerCase();
    if (type === 'mariadb' || type === 'diros' || type === 'sphinx') return 'mysql';
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

  const selectedColumns = useMemo(() => {
      if (selectedColumnRowKeys.length === 0) return [];
      const selectedSet = new Set(selectedColumnRowKeys);
      return columns.filter(col => selectedSet.has(col._key));
  }, [columns, selectedColumnRowKeys]);

  const groupedIndexes = useMemo<IndexDisplayRow[]>(() => {
      type IndexFieldItem = {
          name: string;
          seq: number;
          order: number;
      };
      type IndexBucket = {
          key: string;
          name: string;
          indexType: string;
          nonUnique: number;
          order: number;
          fields: IndexFieldItem[];
      };

      const buckets = new Map<string, IndexBucket>();

      const safeIndexes = Array.isArray(indexes) ? indexes : [];
      safeIndexes.forEach((idx, order) => {
          const rawName = String(idx.name || '').trim();
          const key = rawName || `__unnamed_${order}`;
          const indexType = String(idx.indexType || '').trim() || '-';
          const displayName = rawName || '(未命名索引)';

          if (!buckets.has(key)) {
              buckets.set(key, {
                  key,
                  name: displayName,
                  indexType,
                  nonUnique: idx.nonUnique === 0 ? 0 : 1,
                  order,
                  fields: [],
              });
          }

          const bucket = buckets.get(key);
          if (!bucket) return;

          if (bucket.indexType === '-' && indexType !== '-') {
              bucket.indexType = indexType;
          }
          if (idx.nonUnique === 0) {
              bucket.nonUnique = 0;
          }

          const columnName = String(idx.columnName || '').trim();
          if (!columnName) return;

          const rawSeq = Number(idx.seqInIndex);
          const seq = Number.isFinite(rawSeq) ? rawSeq : 0;
          bucket.fields.push({
              name: columnName,
              seq,
              order,
          });
      });

      return Array.from(buckets.values())
          .sort((a, b) => a.order - b.order)
          .map((bucket) => {
              const sortedFieldNames = bucket.fields
                  .slice()
                  .sort((a, b) => {
                      const aSeq = a.seq > 0 ? a.seq : Number.MAX_SAFE_INTEGER;
                      const bSeq = b.seq > 0 ? b.seq : Number.MAX_SAFE_INTEGER;
                      if (aSeq !== bSeq) return aSeq - bSeq;
                      return a.order - b.order;
                  })
                  .map(field => field.name);

              const uniqueFieldNames = Array.from(new Set(sortedFieldNames));

              return {
                  key: bucket.key,
                  name: bucket.name,
                  indexType: bucket.indexType,
                  nonUnique: bucket.nonUnique,
                  columnNames: uniqueFieldNames,
              };
          });
  }, [indexes]);

  const groupedIndexFieldCount = useMemo(
      () => groupedIndexes.reduce((total, row) => total + row.columnNames.length, 0),
      [groupedIndexes]
  );

  const groupedForeignKeys = useMemo<ForeignKeyDisplayRow[]>(() => {
      type FieldItem = { name: string; order: number };
      type FkBucket = {
          key: string;
          constraintName: string;
          refTableName: string;
          order: number;
          columns: FieldItem[];
          refColumns: FieldItem[];
      };

      const buckets = new Map<string, FkBucket>();

      const safeFks = Array.isArray(fks) ? fks : [];
      safeFks.forEach((fk, order) => {
          const rawConstraint = String(fk.constraintName || fk.name || '').trim();
          const key = rawConstraint || `__unnamed_fk_${order}`;
          const constraintName = rawConstraint || '(未命名外键)';
          const refTableName = String(fk.refTableName || '').trim() || '-';

          if (!buckets.has(key)) {
              buckets.set(key, {
                  key,
                  constraintName,
                  refTableName,
                  order,
                  columns: [],
                  refColumns: [],
              });
          }

          const bucket = buckets.get(key);
          if (!bucket) return;

          if (bucket.refTableName === '-' && refTableName !== '-') {
              bucket.refTableName = refTableName;
          }

          const colName = String(fk.columnName || '').trim();
          const refColName = String(fk.refColumnName || '').trim();
          if (colName) bucket.columns.push({ name: colName, order });
          if (refColName) bucket.refColumns.push({ name: refColName, order });
      });

      return Array.from(buckets.values())
          .sort((a, b) => a.order - b.order)
          .map((bucket) => {
              const columnNames = bucket.columns
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map(item => item.name);
              const refColumnNames = bucket.refColumns
                  .slice()
                  .sort((a, b) => a.order - b.order)
                  .map(item => item.name);

              return {
                  key: bucket.key,
                  name: bucket.constraintName,
                  constraintName: bucket.constraintName,
                  refTableName: bucket.refTableName,
                  columnNames: Array.from(new Set(columnNames)),
                  refColumnNames: Array.from(new Set(refColumnNames)),
              };
          });
  }, [fks]);

  const localColumnOptions = useMemo(
      () => columns.map(col => ({ label: col.name, value: col.name })),
      [columns]
  );

  useEffect(() => {
      if (!selectedIndex) return;
      if (!groupedIndexes.some(idx => idx.key === selectedIndex.key)) {
          setSelectedIndex(null);
      }
  }, [groupedIndexes, selectedIndex]);

  useEffect(() => {
      if (!selectedForeignKey) return;
      if (!groupedForeignKeys.some(fk => fk.key === selectedForeignKey.key)) {
          setSelectedForeignKey(null);
      }
  }, [groupedForeignKeys, selectedForeignKey]);

  const escapeBacktickIdentifier = (name: string) => String(name || '').replace(/`/g, '``');
  const escapeSqlString = (value: string) => String(value || '').replace(/'/g, "''");

  const quoteMysqlIdentifierPath = (path: string): string => {
      const trimmed = String(path || '').trim();
      if (!trimmed) return '';
      // If user already provided backticks, respect as-is.
      if (trimmed.includes('`')) return trimmed;
      return trimmed
          .split('.')
          .map(seg => `\`${escapeBacktickIdentifier(seg)}\``)
          .join('.');
  };

  const getMysqlTableRef = (): string => {
      const tbl = String(tab.tableName || '').trim();
      const schema = String(tab.dbName || '').trim();
      if (!schema) return `\`${escapeBacktickIdentifier(tbl)}\``;
      return `\`${escapeBacktickIdentifier(schema)}\`.\`${escapeBacktickIdentifier(tbl)}\``;
  };

  const buildCreateTableSql = (targetTableName: string, targetColumns: EditableColumn[], targetCharset: string, targetCollation: string) => {
      const tableName = `\`${escapeBacktickIdentifier(targetTableName)}\``;
      const colDefs = targetColumns.map(curr => {
          let extra = curr.extra || "";
          if (curr.isAutoIncrement && !extra.toLowerCase().includes('auto_increment')) {
              extra += " AUTO_INCREMENT";
          }
          return `\`${escapeBacktickIdentifier(curr.name)}\` ${curr.type} ${curr.nullable === 'NO' ? 'NOT NULL' : 'NULL'} ${curr.default ? `DEFAULT '${escapeSqlString(String(curr.default))}'` : ''} ${extra} COMMENT '${escapeSqlString(curr.comment || '')}'`;
      });
      const pks = targetColumns.filter(c => c.key === 'PRI').map(c => `\`${escapeBacktickIdentifier(c.name)}\``);
      if (pks.length > 0) {
          colDefs.push(`PRIMARY KEY (${pks.join(', ')})`);
      }
      return `CREATE TABLE ${tableName} (\n  ${colDefs.join(",\n  ")}\n) ENGINE=InnoDB DEFAULT CHARSET=${targetCharset} COLLATE=${targetCollation};`;
  };

  const openCopySelectedColumnsModal = () => {
      if (selectedColumns.length === 0) {
          message.warning('请先勾选要复制的字段');
          return;
      }
      const sourceName = (tab.tableName || 'new_table').trim();
      setCopyTableName(`${sourceName}_copy`);
      setCopyCharset(charset);
      const charsetCollations = (COLLATIONS as any)[charset] || [];
      setCopyCollation(
          charsetCollations.some((item: any) => item.value === collation)
              ? collation
              : (charsetCollations[0]?.value || 'utf8mb4_unicode_ci')
      );
      setIsCopyColumnsModalOpen(true);
  };

  const handleExecuteCopySelectedColumns = async () => {
      if (!copyTableName.trim()) {
          message.error('请输入目标表名');
          return;
      }
      if (selectedColumns.length === 0) {
          message.error('未选择可复制字段');
          return;
      }
      const conn = connections.find(c => c.id === tab.connectionId);
      if (!conn) {
          message.error('Connection not found');
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
      const sql = buildCreateTableSql(copyTableName.trim(), selectedColumns, copyCharset, copyCollation);
      setCopyExecuting(true);
      try {
          const res = await DBQuery(config as any, tab.dbName || '', sql);
          if (res.success) {
              message.success(`已将 ${selectedColumns.length} 个字段复制到新表 ${copyTableName.trim()}`);
              setIsCopyColumnsModalOpen(false);
          } else {
              message.error("执行失败: " + res.message);
          }
      } finally {
          setCopyExecuting(false);
      }
  };

  const supportsMysqlSchemaOps = () => getDbType() === 'mysql';

  const executeSchemaSql = async (sql: string, successMessage: string): Promise<boolean> => {
      const conn = connections.find(c => c.id === tab.connectionId);
      if (!conn) {
          message.error('未找到连接');
          return false;
      }
      const config = {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      };
      try {
          const res = await DBQuery(config as any, tab.dbName || '', sql);
          if (res.success) {
              message.success(successMessage);
              await fetchData();
              return true;
          }
          message.error('执行失败: ' + res.message);
          return false;
      } catch (e: any) {
          message.error('执行失败: ' + (e?.message || String(e)));
          return false;
      }
  };

  const openTableCommentModal = () => {
      setTableCommentDraft(tableComment || '');
      setIsTableCommentModalOpen(true);
  };

  const handleSaveTableComment = async () => {
      if (!supportsMysqlSchemaOps()) {
          message.warning('当前数据库暂不支持在此修改表备注');
          return;
      }
      if (!tab.tableName) return;
      const sql = `ALTER TABLE ${getMysqlTableRef()} COMMENT = '${escapeSqlString(tableCommentDraft)}';`;
      setTableCommentSaving(true);
      const ok = await executeSchemaSql(sql, '表备注更新成功');
      setTableCommentSaving(false);
      if (ok) {
          setTableComment(tableCommentDraft);
          setIsTableCommentModalOpen(false);
      }
  };

  const openCreateIndexModal = () => {
      setIndexModalMode('create');
      setIndexForm({
          name: '',
          columnNames: [],
          kind: 'NORMAL',
          indexType: 'DEFAULT',
      });
      setIsIndexModalOpen(true);
  };

  const openEditIndexModal = () => {
      if (!selectedIndex) {
          message.warning('请先选择一个索引');
          return;
      }
      setIndexModalMode('edit');
      const selectedName = String(selectedIndex.name || '').trim();
      const selectedNameUpper = selectedName.toUpperCase();
      const selectedTypeUpper = String(selectedIndex.indexType || '').trim().toUpperCase();
      let kind: IndexKind = 'NORMAL';
      if (selectedNameUpper === 'PRIMARY') {
          kind = 'PRIMARY';
      } else if (selectedTypeUpper === 'FULLTEXT') {
          kind = 'FULLTEXT';
      } else if (selectedTypeUpper === 'SPATIAL') {
          kind = 'SPATIAL';
      } else if (selectedIndex.nonUnique === 0) {
          kind = 'UNIQUE';
      }

      setIndexForm({
          name: kind === 'PRIMARY' ? 'PRIMARY' : selectedName,
          columnNames: [...selectedIndex.columnNames],
          kind,
          indexType: kind === 'NORMAL' || kind === 'UNIQUE'
              ? (selectedTypeUpper || 'DEFAULT')
              : 'DEFAULT',
      });
      setIsIndexModalOpen(true);
  };

  const buildIndexAddClause = (form: IndexFormState): string | null => {
      const kind: IndexKind = form.kind || 'NORMAL';
      const indexName = String(form.name || '').trim();
      const colSql = form.columnNames.map(col => `\`${escapeBacktickIdentifier(col)}\``).join(', ');

      if (kind === 'PRIMARY') {
          return `ADD PRIMARY KEY (${colSql})`;
      }

      if (!indexName) {
          message.error('请输入索引名');
          return null;
      }

      if (kind === 'FULLTEXT') {
          return `ADD FULLTEXT INDEX \`${escapeBacktickIdentifier(indexName)}\` (${colSql})`;
      }
      if (kind === 'SPATIAL') {
          return `ADD SPATIAL INDEX \`${escapeBacktickIdentifier(indexName)}\` (${colSql})`;
      }

      const normalizedType = String(form.indexType || '').trim().toUpperCase() || 'DEFAULT';
      if (normalizedType === 'FULLTEXT' || normalizedType === 'SPATIAL') {
          message.error(`请将“索引类别”切换为 ${normalizedType} 索引`);
          return null;
      }

      const usingSql = normalizedType !== 'DEFAULT' ? ` USING ${normalizedType}` : '';
      const prefix = kind === 'UNIQUE' ? 'ADD UNIQUE INDEX' : 'ADD INDEX';
      return `${prefix} \`${escapeBacktickIdentifier(indexName)}\`${usingSql} (${colSql})`;
  };

  const buildIndexDropClause = (indexName: string) => {
      if (String(indexName || '').trim().toUpperCase() === 'PRIMARY') {
          return 'DROP PRIMARY KEY';
      }
      return `DROP INDEX \`${escapeBacktickIdentifier(indexName)}\``;
  };

  const handleSubmitIndex = async () => {
      if (!supportsMysqlSchemaOps()) {
          message.warning('当前数据库暂不支持在此维护索引');
          return;
      }
      if (!tab.tableName) return;
      const nextName = indexForm.kind === 'PRIMARY' ? 'PRIMARY' : String(indexForm.name || '').trim();
      if (indexForm.kind !== 'PRIMARY' && !nextName) {
          message.error('请输入索引名');
          return;
      }
      if (indexForm.columnNames.length === 0) {
          message.error('请至少选择一个字段');
          return;
      }

      const upperName = nextName.toUpperCase();
      const duplicate = groupedIndexes.some(idx => {
          if (indexModalMode === 'edit' && selectedIndex && idx.key === selectedIndex.key) return false;
          return idx.name.toUpperCase() === upperName;
      });
      if (duplicate) {
          message.error(`索引名已存在：${nextName}`);
          return;
      }

      setIndexSaving(true);
      const addClause = buildIndexAddClause({ ...indexForm, name: nextName });
      if (!addClause) {
          setIndexSaving(false);
          return;
      }
      let sql = `ALTER TABLE ${getMysqlTableRef()}\n${addClause};`;

      if (indexModalMode === 'edit' && selectedIndex) {
          const dropClause = buildIndexDropClause(selectedIndex.name);
          sql = `ALTER TABLE ${getMysqlTableRef()}\n${dropClause},\n${addClause};`;
      }

      const ok = await executeSchemaSql(sql, indexModalMode === 'create' ? '索引新增成功' : '索引修改成功');
      setIndexSaving(false);
      if (ok) {
          setIsIndexModalOpen(false);
      }
  };

  const handleDeleteIndex = () => {
      if (!selectedIndex) {
          message.warning('请先选择一个索引');
          return;
      }
      if (!supportsMysqlSchemaOps()) {
          message.warning('当前数据库暂不支持在此维护索引');
          return;
      }
      Modal.confirm({
          title: '确认删除索引',
          icon: <ExclamationCircleOutlined />,
          content: `确定删除索引 "${selectedIndex.name}" 吗？`,
          okText: '删除',
          okType: 'danger',
          cancelText: '取消',
          onOk: async () => {
              const dropClause = buildIndexDropClause(selectedIndex.name);
              const sql = `ALTER TABLE ${getMysqlTableRef()}\n${dropClause};`;
              await executeSchemaSql(sql, '索引删除成功');
          }
      });
  };

  const openCreateForeignKeyModal = () => {
      setForeignKeyModalMode('create');
      setForeignKeyForm({
          constraintName: '',
          columnNames: [],
          refTableName: '',
          refColumnNames: [],
      });
      setIsForeignKeyModalOpen(true);
  };

  const openEditForeignKeyModal = () => {
      if (!selectedForeignKey) {
          message.warning('请先选择一个外键');
          return;
      }
      setForeignKeyModalMode('edit');
      setForeignKeyForm({
          constraintName: selectedForeignKey.constraintName,
          columnNames: [...selectedForeignKey.columnNames],
          refTableName: selectedForeignKey.refTableName === '-' ? '' : selectedForeignKey.refTableName,
          refColumnNames: [...selectedForeignKey.refColumnNames],
      });
      setIsForeignKeyModalOpen(true);
  };

  const buildForeignKeyAddClause = (form: ForeignKeyFormState) => {
      const localColsSql = form.columnNames.map(col => `\`${escapeBacktickIdentifier(col)}\``).join(', ');
      const refColsSql = form.refColumnNames.map(col => `\`${escapeBacktickIdentifier(col)}\``).join(', ');
      const refTableSql = quoteMysqlIdentifierPath(form.refTableName);
      return `ADD CONSTRAINT \`${escapeBacktickIdentifier(form.constraintName)}\` FOREIGN KEY (${localColsSql}) REFERENCES ${refTableSql} (${refColsSql})`;
  };

  const buildForeignKeyDropClause = (constraintName: string) =>
      `DROP FOREIGN KEY \`${escapeBacktickIdentifier(constraintName)}\``;

  const handleSubmitForeignKey = async () => {
      if (!supportsMysqlSchemaOps()) {
          message.warning('当前数据库暂不支持在此维护外键');
          return;
      }
      if (!tab.tableName) return;
      const nextConstraint = String(foreignKeyForm.constraintName || '').trim();
      const refTable = String(foreignKeyForm.refTableName || '').trim();
      const refCols = foreignKeyForm.refColumnNames.map(v => String(v || '').trim()).filter(Boolean);
      const localCols = foreignKeyForm.columnNames.map(v => String(v || '').trim()).filter(Boolean);

      if (!nextConstraint) {
          message.error('请输入外键约束名');
          return;
      }
      if (localCols.length === 0) {
          message.error('请至少选择一个本表字段');
          return;
      }
      if (!refTable) {
          message.error('请输入参考表');
          return;
      }
      if (refCols.length === 0) {
          message.error('请至少填写一个参考字段');
          return;
      }
      if (localCols.length !== refCols.length) {
          message.error('本表字段数量与参考字段数量必须一致');
          return;
      }

      const duplicate = groupedForeignKeys.some(item => {
          if (foreignKeyModalMode === 'edit' && selectedForeignKey && item.key === selectedForeignKey.key) return false;
          return item.constraintName.toUpperCase() === nextConstraint.toUpperCase();
      });
      if (duplicate) {
          message.error(`外键约束名已存在：${nextConstraint}`);
          return;
      }

      setForeignKeySaving(true);
      const addClause = buildForeignKeyAddClause({
          ...foreignKeyForm,
          constraintName: nextConstraint,
          columnNames: localCols,
          refTableName: refTable,
          refColumnNames: refCols,
      });
      let sql = `ALTER TABLE ${getMysqlTableRef()}\n${addClause};`;
      if (foreignKeyModalMode === 'edit' && selectedForeignKey) {
          const dropClause = buildForeignKeyDropClause(selectedForeignKey.constraintName);
          sql = `ALTER TABLE ${getMysqlTableRef()}\n${dropClause},\n${addClause};`;
      }

      const ok = await executeSchemaSql(sql, foreignKeyModalMode === 'create' ? '外键新增成功' : '外键修改成功');
      setForeignKeySaving(false);
      if (ok) {
          setIsForeignKeyModalOpen(false);
      }
  };

  const handleDeleteForeignKey = () => {
      if (!selectedForeignKey) {
          message.warning('请先选择一个外键');
          return;
      }
      if (!supportsMysqlSchemaOps()) {
          message.warning('当前数据库暂不支持在此维护外键');
          return;
      }
      Modal.confirm({
          title: '确认删除外键',
          icon: <ExclamationCircleOutlined />,
          content: `确定删除外键约束 "${selectedForeignKey.constraintName}" 吗？`,
          okText: '删除',
          okType: 'danger',
          cancelText: '取消',
          onOk: async () => {
              const sql = `ALTER TABLE ${getMysqlTableRef()}\n${buildForeignKeyDropClause(selectedForeignKey.constraintName)};`;
              await executeSchemaSql(sql, '外键删除成功');
          }
      });
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
          const sql = buildCreateTableSql(isNewTable ? newTableName : tab.tableName || '', columns, charset, collation);
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
      onResizeStart: handleResizeStart(index),
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
                rowSelection={{
                    selectedRowKeys: selectedColumnRowKeys,
                    onChange: (nextSelectedRowKeys) => setSelectedColumnRowKeys(nextSelectedRowKeys as string[]),
                }}
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
        <div
          ref={ghostRef}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: '2px',
            background: '#1890ff',
            zIndex: 9999,
            display: 'none',
            pointerEvents: 'none',
            willChange: 'transform',
          }}
        />
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
            {!isNewTable && !readOnly && supportsMysqlSchemaOps() && (
                <Button icon={<EditOutlined />} onClick={openTableCommentModal}>表备注</Button>
            )}
            {!readOnly && <Button icon={<PlusOutlined />} onClick={handleAddColumn}>添加字段</Button>}
            {!readOnly && (
                <Button
                    icon={<CopyOutlined />}
                    onClick={openCopySelectedColumnsModal}
                    disabled={selectedColumns.length === 0}
                >
                    复制选中到新表
                </Button>
            )}
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
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {!readOnly && (
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <Button size="small" icon={<PlusOutlined />} onClick={openCreateIndexModal}>新增</Button>
                                        <Button size="small" icon={<EditOutlined />} disabled={!selectedIndex} onClick={openEditIndexModal}>修改</Button>
                                        <Button size="small" icon={<DeleteOutlined />} danger disabled={!selectedIndex} onClick={handleDeleteIndex}>删除</Button>
                                        {!supportsMysqlSchemaOps() && (
                                            <span style={{ marginLeft: 'auto', color: '#faad14', fontSize: 12, alignSelf: 'center' }}>
                                                当前数据库暂不支持索引编辑，仅支持查看
                                            </span>
                                        )}
                                        {supportsMysqlSchemaOps() && selectedIndex && (
                                            <span style={{ marginLeft: 'auto', color: '#888', fontSize: 12, alignSelf: 'center' }}>
                                                已选择：{selectedIndex.name}
                                            </span>
                                        )}
                                    </div>
                                )}
                                <div style={{ color: '#888', fontSize: 12 }}>
                                    索引数：{groupedIndexes.length}，索引字段：{groupedIndexFieldCount}
                                </div>
                                <Table
                                    dataSource={groupedIndexes}
                                    columns={[
                                        {
                                            title: '索引名',
                                            dataIndex: 'name',
                                            key: 'name',
                                            width: 240,
                                            render: (text: string) => (
                                                <Tooltip title={text}>
                                                    <span style={{ display: 'inline-block', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                        {text}
                                                    </span>
                                                </Tooltip>
                                            ),
                                        },
                                        {
                                            title: '字段',
                                            dataIndex: 'columnNames',
                                            key: 'columnNames',
                                            render: (columnNames: string[]) => {
                                                if (!columnNames || columnNames.length === 0) {
                                                    return '-';
                                                }
                                                return (
                                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                                        {columnNames.map((columnName, idx) => (
                                                            <Tag key={`${columnName}-${idx}`}>
                                                                {columnName}
                                                            </Tag>
                                                        ))}
                                                    </div>
                                                );
                                            }
                                        },
                                        {
                                            title: '索引类型',
                                            dataIndex: 'indexType',
                                            key: 'indexType',
                                            width: 140,
                                            render: (text: string) => text || '-',
                                        },
                                        {
                                            title: '唯一性',
                                            dataIndex: 'nonUnique',
                                            key: 'nonUnique',
                                            width: 110,
                                            render: (v: number) => (
                                                <Tag color={v === 0 ? 'gold' : 'default'}>
                                                    {v === 0 ? '唯一' : '普通'}
                                                </Tag>
                                            ),
                                        },
                                    ]}
                                    rowKey="key"
                                    size="small"
                                    pagination={false}
                                    loading={loading}
                                    scroll={{ x: 960, y: tableHeight }}
                                    rowSelection={{
                                        type: 'radio',
                                        selectedRowKeys: selectedIndex ? [selectedIndex.key] : [],
                                        onChange: (_, selectedRows) => setSelectedIndex((selectedRows[0] as IndexDisplayRow) || null),
                                    }}
                                    onRow={(record) => ({
                                        onClick: () => {
                                            if (selectedIndex?.key === record.key) {
                                                setSelectedIndex(null);
                                            } else {
                                                setSelectedIndex(record);
                                            }
                                        },
                                        style: { cursor: 'pointer' }
                                    })}
                                />
                            </div>
                        )
                    },
                    {
                        key: 'foreignKeys',
                        label: '外键',
                        children: (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {!readOnly && (
                                    <div style={{ display: 'flex', gap: 8 }}>
                                        <Button size="small" icon={<PlusOutlined />} onClick={openCreateForeignKeyModal}>新增</Button>
                                        <Button size="small" icon={<EditOutlined />} disabled={!selectedForeignKey} onClick={openEditForeignKeyModal}>修改</Button>
                                        <Button size="small" icon={<DeleteOutlined />} danger disabled={!selectedForeignKey} onClick={handleDeleteForeignKey}>删除</Button>
                                        {!supportsMysqlSchemaOps() && (
                                            <span style={{ marginLeft: 'auto', color: '#faad14', fontSize: 12, alignSelf: 'center' }}>
                                                当前数据库暂不支持外键编辑，仅支持查看
                                            </span>
                                        )}
                                        {supportsMysqlSchemaOps() && selectedForeignKey && (
                                            <span style={{ marginLeft: 'auto', color: '#888', fontSize: 12, alignSelf: 'center' }}>
                                                已选择：{selectedForeignKey.constraintName}
                                            </span>
                                        )}
                                    </div>
                                )}
                                <Table 
                                    dataSource={groupedForeignKeys} 
                                    columns={[
                                        { title: '约束名', dataIndex: 'constraintName', key: 'constraintName', width: 220 },
                                        {
                                            title: '字段',
                                            dataIndex: 'columnNames',
                                            key: 'columnNames',
                                            render: (vals: string[]) => vals?.length ? vals.join(', ') : '-',
                                        },
                                        { title: '参考表', dataIndex: 'refTableName', key: 'refTableName', width: 220 },
                                        {
                                            title: '参考字段',
                                            dataIndex: 'refColumnNames',
                                            key: 'refColumnNames',
                                            render: (vals: string[]) => vals?.length ? vals.join(', ') : '-',
                                        },
                                    ]}
                                    rowKey="key" 
                                    size="small" 
                                    pagination={false} 
                                    loading={loading}
                                    scroll={{ x: 980, y: tableHeight }}
                                    rowSelection={{
                                        type: 'radio',
                                        selectedRowKeys: selectedForeignKey ? [selectedForeignKey.key] : [],
                                        onChange: (_, selectedRows) => setSelectedForeignKey((selectedRows[0] as ForeignKeyDisplayRow) || null),
                                    }}
                                    onRow={(record) => ({
                                        onClick: () => {
                                            if (selectedForeignKey?.key === record.key) {
                                                setSelectedForeignKey(null);
                                            } else {
                                                setSelectedForeignKey(record);
                                            }
                                        },
                                        style: { cursor: 'pointer' }
                                    })}
                                />
                            </div>
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
                ...(!isNewTable ? [{
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
                                    scrollBeyondLastLine: true,
                                    wordWrap: 'on',
                                    automaticLayout: true,
                                    padding: { top: 8, bottom: 24 },
                                }}
                            />
                        </div>
                    )
                }] : [])
            ]}
        />

        <Modal
            title={`字段注释${commentEditorColumnName ? ` - ${commentEditorColumnName}` : ''}`}
            open={isCommentModalOpen}
            onCancel={closeCommentEditor}
            onOk={() => {
                if (commentEditorColumnKey) {
                    handleColumnChange(commentEditorColumnKey, 'comment', commentEditorValue);
                }
                closeCommentEditor();
            }}
            okText="应用"
            cancelText="取消"
            width={640}
            destroyOnClose
        >
            <Input.TextArea
                value={commentEditorValue}
                onChange={(e) => setCommentEditorValue(e.target.value)}
                autoSize={{ minRows: 8, maxRows: 18 }}
                placeholder="请输入字段注释"
                maxLength={2000}
            />
        </Modal>

        <Modal
            title="复制选中字段到新表"
            open={isCopyColumnsModalOpen}
            onCancel={() => setIsCopyColumnsModalOpen(false)}
            onOk={handleExecuteCopySelectedColumns}
            okText="创建新表"
            cancelText="取消"
            confirmLoading={copyExecuting}
            width={560}
        >
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <div style={{ color: '#666' }}>
                    已选择字段：{selectedColumns.length}
                </div>
                <Input
                    placeholder="请输入目标表名"
                    value={copyTableName}
                    onChange={e => setCopyTableName(e.target.value)}
                    maxLength={128}
                />
                <Space wrap>
                    <Select
                        value={copyCharset}
                        onChange={v => {
                            setCopyCharset(v);
                            const cols = (COLLATIONS as any)[v];
                            if (cols && cols.length > 0) setCopyCollation(cols[0].value);
                        }}
                        options={CHARSETS}
                        style={{ width: 160 }}
                    />
                    <Select
                        value={copyCollation}
                        onChange={setCopyCollation}
                        options={(COLLATIONS as any)[copyCharset] || []}
                        style={{ width: 220 }}
                    />
                </Space>
            </Space>
        </Modal>

        <Modal
            title="修改表备注"
            open={isTableCommentModalOpen}
            onCancel={() => setIsTableCommentModalOpen(false)}
            onOk={handleSaveTableComment}
            okText="保存"
            cancelText="取消"
            confirmLoading={tableCommentSaving}
            width={640}
        >
            <Input.TextArea
                value={tableCommentDraft}
                onChange={(e) => setTableCommentDraft(e.target.value)}
                autoSize={{ minRows: 5, maxRows: 12 }}
                placeholder="请输入表备注"
                maxLength={2048}
            />
            <div style={{ marginTop: 8, color: '#888', fontSize: 12 }}>
                当前备注：{tableComment || '(空)'}
            </div>
        </Modal>

        <Modal
            title={indexModalMode === 'create' ? '新增索引' : '修改索引'}
            open={isIndexModalOpen}
            onCancel={() => setIsIndexModalOpen(false)}
            onOk={handleSubmitIndex}
            okText={indexModalMode === 'create' ? '创建' : '保存'}
            cancelText="取消"
            confirmLoading={indexSaving}
            width={620}
        >
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Input
                    placeholder={indexForm.kind === 'PRIMARY' ? '主键索引固定名称：PRIMARY' : '索引名（例如 idx_user_name）'}
                    value={indexForm.name}
                    onChange={(e) => setIndexForm(prev => ({ ...prev, name: e.target.value }))}
                    maxLength={128}
                    disabled={indexForm.kind === 'PRIMARY'}
                />
                <Select
                    mode="multiple"
                    allowClear
                    placeholder="请选择索引字段（按选择顺序生效）"
                    value={indexForm.columnNames}
                    onChange={(vals) => setIndexForm(prev => ({ ...prev, columnNames: vals }))}
                    options={localColumnOptions}
                    style={{ width: '100%' }}
                />
                <Space wrap>
                    <Select
                        value={indexForm.kind}
                        options={[
                            { label: '普通索引（非聚合）', value: 'NORMAL' },
                            { label: '唯一索引', value: 'UNIQUE' },
                            { label: '主键索引（聚合）', value: 'PRIMARY' },
                            { label: '全文索引', value: 'FULLTEXT' },
                            { label: '空间索引', value: 'SPATIAL' },
                        ]}
                        onChange={(val: IndexKind) =>
                            setIndexForm(prev => ({
                                ...prev,
                                kind: val,
                                name: val === 'PRIMARY' ? 'PRIMARY' : (prev.name === 'PRIMARY' ? '' : prev.name),
                                indexType: val === 'NORMAL' || val === 'UNIQUE' ? (prev.indexType || 'DEFAULT') : 'DEFAULT',
                            }))
                        }
                        style={{ width: 220 }}
                    />
                    <Select
                        value={indexForm.indexType}
                        onChange={(val) => setIndexForm(prev => ({ ...prev, indexType: val }))}
                        options={MYSQL_INDEX_TYPE_OPTIONS}
                        style={{ width: 160 }}
                        disabled={indexForm.kind === 'PRIMARY' || indexForm.kind === 'FULLTEXT' || indexForm.kind === 'SPATIAL'}
                    />
                </Space>
                <div style={{ color: '#888', fontSize: 12 }}>
                    修改索引会执行“先删除旧索引，再创建新索引”。
                </div>
            </Space>
        </Modal>

        <Modal
            title={foreignKeyModalMode === 'create' ? '新增外键' : '修改外键'}
            open={isForeignKeyModalOpen}
            onCancel={() => setIsForeignKeyModalOpen(false)}
            onOk={handleSubmitForeignKey}
            okText={foreignKeyModalMode === 'create' ? '创建' : '保存'}
            cancelText="取消"
            confirmLoading={foreignKeySaving}
            width={700}
        >
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
                <Input
                    placeholder="外键约束名（例如 fk_order_user）"
                    value={foreignKeyForm.constraintName}
                    onChange={(e) => setForeignKeyForm(prev => ({ ...prev, constraintName: e.target.value }))}
                    maxLength={128}
                />
                <Select
                    mode="multiple"
                    allowClear
                    placeholder="请选择本表字段（顺序需与参考字段一致）"
                    value={foreignKeyForm.columnNames}
                    onChange={(vals) => setForeignKeyForm(prev => ({ ...prev, columnNames: vals }))}
                    options={localColumnOptions}
                    style={{ width: '100%' }}
                />
                <Input
                    placeholder="参考表（支持 db.table）"
                    value={foreignKeyForm.refTableName}
                    onChange={(e) => setForeignKeyForm(prev => ({ ...prev, refTableName: e.target.value }))}
                    maxLength={256}
                />
                <Select
                    mode="tags"
                    tokenSeparators={[',', ' ']}
                    placeholder="请输入参考字段（支持多个）"
                    value={foreignKeyForm.refColumnNames}
                    onChange={(vals) => setForeignKeyForm(prev => ({ ...prev, refColumnNames: vals }))}
                    style={{ width: '100%' }}
                />
                <div style={{ color: '#888', fontSize: 12 }}>
                    修改外键会执行“先删除旧外键，再创建新外键”。
                </div>
            </Space>
        </Modal>

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
