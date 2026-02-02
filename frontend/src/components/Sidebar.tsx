import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Tree, message, Dropdown, MenuProps, Input, Button, Modal, Form, Badge } from 'antd';
import { 
  DatabaseOutlined, 
  TableOutlined, 
  ConsoleSqlOutlined, 
  HddOutlined, 
  FolderOpenOutlined, 
  FileTextOutlined,
  CopyOutlined,
  ExportOutlined,
  SaveOutlined,
  EditOutlined,
  DownOutlined,
  SearchOutlined,
  KeyOutlined,
  ThunderboltOutlined,
  UnorderedListOutlined,
  FunctionOutlined,
  LinkOutlined,
  FileAddOutlined,
  PlusOutlined,
  ReloadOutlined,
  DeleteOutlined,
  DisconnectOutlined
} from '@ant-design/icons';
import { useStore } from '../store';
import { SavedConnection } from '../types';
import { MySQLGetDatabases, MySQLGetTables, MySQLShowCreateTable, ExportTable, OpenSQLFile, CreateDatabase } from '../../wailsjs/go/app/App';

const { Search } = Input;

interface TreeNode {
  title: string;
  key: string;
  isLeaf?: boolean;
  children?: TreeNode[];
  icon?: React.ReactNode;
  dataRef?: any;
  type?: 'connection' | 'database' | 'table' | 'queries-folder' | 'saved-query' | 'folder-columns' | 'folder-indexes' | 'folder-fks' | 'folder-triggers';
}

const Sidebar: React.FC<{ onEditConnection?: (conn: SavedConnection) => void }> = ({ onEditConnection }) => {
  const { connections, savedQueries, addTab, setActiveContext, removeConnection } = useStore();
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [searchValue, setSearchValue] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [autoExpandParent, setAutoExpandParent] = useState(true);
  const [loadedKeys, setLoadedKeys] = useState<React.Key[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, items: MenuProps['items'] } | null>(null);
  
  // Virtual Scroll State
  const [treeHeight, setTreeHeight] = useState(500);
  const treeContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
      if (!treeContainerRef.current) return;
      const resizeObserver = new ResizeObserver(entries => {
          for (let entry of entries) {
              setTreeHeight(entry.contentRect.height);
          }
      });
      resizeObserver.observe(treeContainerRef.current);
      return () => resizeObserver.disconnect();
  }, []);
  
  // Connection Status State: key -> 'success' | 'error'
  const [connectionStates, setConnectionStates] = useState<Record<string, 'success' | 'error'>>({});

  // Create Database Modal
  const [isCreateDbModalOpen, setIsCreateDbModalOpen] = useState(false);
  const [createDbForm] = Form.useForm();
  const [targetConnection, setTargetConnection] = useState<any>(null);

  useEffect(() => {
      // Refresh queries for expanded databases
      const findNode = (nodes: TreeNode[], k: React.Key): TreeNode | null => {
          for (const node of nodes) {
              if (node.key === k) return node;
              if (node.children) {
                  const res = findNode(node.children, k);
                  if (res) return res;
              }
          }
          return null;
      };

      expandedKeys.forEach(key => {
          const node = findNode(treeData, key);
          if (node && node.type === 'database') {
              loadTables(node);
          }
      });
  }, [savedQueries]);

  useEffect(() => {
    setTreeData(connections.map(conn => ({
      title: conn.name,
      key: conn.id,
      icon: <HddOutlined />,
      type: 'connection',
      dataRef: conn,
      isLeaf: false,
    })));
  }, [connections]);

  const updateTreeData = (list: TreeNode[], key: React.Key, children: TreeNode[] | undefined): TreeNode[] => {
    return list.map(node => {
      if (node.key === key) {
        return { ...node, children };
      }
      if (node.children) {
        return { ...node, children: updateTreeData(node.children, key, children) };
      }
      return node;
    });
  };

  const loadDatabases = async (node: any) => {
      const conn = node.dataRef as SavedConnection;
      const config = { 
          ...conn.config, 
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      };
      const res = await MySQLGetDatabases(config as any);
      if (res.success) {
        setConnectionStates(prev => ({ ...prev, [conn.id]: 'success' }));
        let dbs = (res.data as any[]).map((row: any) => ({
          title: row.Database || row.database,
          key: `${conn.id}-${row.Database || row.database}`,
          icon: <DatabaseOutlined />,
          type: 'database' as const,
          dataRef: { ...conn, dbName: row.Database || row.database },
          isLeaf: false,
        }));

        // Filter databases if configured
        if (conn.includeDatabases && conn.includeDatabases.length > 0) {
            dbs = dbs.filter(db => conn.includeDatabases!.includes(db.title));
        }

        setTreeData(origin => updateTreeData(origin, node.key, dbs));
      } else {
        setConnectionStates(prev => ({ ...prev, [conn.id]: 'error' }));
        message.error(res.message);
      }
  };

  const loadTables = async (node: any) => {
      const conn = node.dataRef; // has dbName
      const dbName = conn.dbName;
      const key = node.key;
      
      const dbQueries = savedQueries.filter(q => q.connectionId === conn.id && q.dbName === dbName);
      
      const queriesNode: TreeNode = {
          title: '已存查询',
          key: `${key}-queries`,
          icon: <FolderOpenOutlined />,
          type: 'queries-folder',
          isLeaf: dbQueries.length === 0,
          children: dbQueries.map(q => ({
              title: q.name,
              key: q.id,
              icon: <FileTextOutlined />,
              type: 'saved-query',
              dataRef: q,
              isLeaf: true
          }))
      };

      const config = { 
          ...conn.config, 
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      };
      const res = await MySQLGetTables(config as any, conn.dbName);
      if (res.success) {
        setConnectionStates(prev => ({ ...prev, [key as string]: 'success' }));
        const tables = (res.data as any[]).map((row: any) => {
            const tableName = Object.values(row)[0] as string;
            return {
              title: tableName,
              key: `${conn.id}-${conn.dbName}-${tableName}`,
              icon: <TableOutlined />,
              type: 'table' as const,
              dataRef: { ...conn, tableName },
              isLeaf: false, 
            };
        });
        
        setTreeData(origin => updateTreeData(origin, key, [queriesNode, ...tables]));
      } else {
        setConnectionStates(prev => ({ ...prev, [key as string]: 'error' }));
        message.error(res.message);
      }
  };

  const onLoadData = async ({ key, children, dataRef, type }: any) => {
    if (children) return;

    if (type === 'connection') {
        await loadDatabases({ key, dataRef });
    } else if (type === 'database') {
        await loadTables({ key, dataRef });
    } else if (type === 'table') {
        // Expand table to show object categories
        const { tableName, dbName, id } = dataRef;
        const conn = dataRef; 

        const folders: TreeNode[] = [
            {
                title: '列',
                key: `${key}-columns`,
                icon: <UnorderedListOutlined />,
                type: 'folder-columns',
                isLeaf: true,
                dataRef: conn
            },
            {
                title: '索引',
                key: `${key}-indexes`,
                icon: <KeyOutlined style={{ transform: 'rotate(45deg)' }} />,
                type: 'folder-indexes',
                isLeaf: true,
                dataRef: conn
            },
            {
                title: '外键',
                key: `${key}-fks`,
                icon: <LinkOutlined />,
                type: 'folder-fks',
                isLeaf: true,
                dataRef: conn
            },
            {
                title: '触发器',
                key: `${key}-triggers`,
                icon: <ThunderboltOutlined />,
                type: 'folder-triggers',
                isLeaf: true,
                dataRef: conn
            }
        ];
        
        setTreeData(origin => updateTreeData(origin, key, folders));
    }
  };

  const openDesign = (node: any, initialTab: string, readOnly: boolean = false) => {
      const { tableName, dbName, id } = node.dataRef;
      addTab({
          id: `design-${id}-${dbName}-${tableName}`,
          title: `${readOnly ? '表结构' : '设计表'} (${tableName})`,
          type: 'design',
          connectionId: id,
          dbName: dbName,
          tableName: tableName,
          initialTab: initialTab,
          readOnly: readOnly
      });
  };

  const openNewTableDesign = (node: any) => {
      const { dbName, id } = node.dataRef;
      addTab({
          id: `new-table-${id}-${dbName}-${Date.now()}`,
          title: `新建表 - ${dbName}`,
          type: 'design',
          connectionId: id,
          dbName: dbName,
          tableName: '', // Empty tableName signals creation mode
          initialTab: 'columns',
          readOnly: false
      });
  };

  const onSelect = (keys: React.Key[], info: any) => {
      if (!info.node.selected) {
          setActiveContext(null);
          return;
      }
      
      const { type, dataRef, key, title } = info.node;
      
      // Update active context
      if (type === 'connection') {
          setActiveContext({ connectionId: key, dbName: '' });
      } else if (type === 'database') {
          setActiveContext({ connectionId: dataRef.id, dbName: title });
      } else if (type === 'table') {
          setActiveContext({ connectionId: dataRef.id, dbName: dataRef.dbName });
      } else if (type === 'saved-query') {
          setActiveContext({ connectionId: dataRef.connectionId, dbName: dataRef.dbName });
      }

      if (type === 'folder-columns') openDesign(info.node, 'columns', true);
      else if (type === 'folder-indexes') openDesign(info.node, 'indexes', true);
      else if (type === 'folder-fks') openDesign(info.node, 'foreignKeys', true);
      else if (type === 'folder-triggers') openDesign(info.node, 'triggers', true);
  };

  const onExpand = (newExpandedKeys: React.Key[]) => {
    setExpandedKeys(newExpandedKeys);
    setAutoExpandParent(false);
  };

  const onDoubleClick = (e: any, node: any) => {
      const key = node.key;
      const isExpanded = expandedKeys.includes(key);
      const newExpandedKeys = isExpanded 
          ? expandedKeys.filter(k => k !== key) 
          : [...expandedKeys, key];
      
      setExpandedKeys(newExpandedKeys);
      if (!isExpanded) setAutoExpandParent(false);

      if (node.type === 'table') {
          const { tableName, dbName, id } = node.dataRef;
          addTab({
              id: node.key,
              title: tableName,
              type: 'table',
              connectionId: id,
              dbName,
              tableName,
          });
      } else if (node.type === 'saved-query') {
          const q = node.dataRef;
          addTab({
              id: q.id,
              title: q.name,
              type: 'query',
              connectionId: q.connectionId,
              dbName: q.dbName,
              query: q.sql
          });
      }
  };
  
  const handleCopyStructure = async (node: any) => {
      const { config, dbName, tableName } = node.dataRef;
      const res = await MySQLShowCreateTable({ 
          ...config, 
          port: Number(config.port),
          password: config.password || "",
          database: config.database || "",
          useSSH: config.useSSH || false,
          ssh: config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      } as any, dbName, tableName);
      if (res.success) {
          navigator.clipboard.writeText(res.data as string);
          message.success('表结构已复制到剪贴板');
      } else {
          message.error(res.message);
      }
  };

  const handleExport = async (node: any, format: string) => {
      const { config, dbName, tableName } = node.dataRef;
      const hide = message.loading(`正在导出 ${tableName} 为 ${format.toUpperCase()}...`, 0);
      const res = await ExportTable({ 
          ...config, 
          port: Number(config.port),
          password: config.password || "",
          database: config.database || "",
          useSSH: config.useSSH || false,
          ssh: config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      } as any, dbName, tableName, format);
      hide();
      if (res.success) {
          message.success('导出成功');
      } else if (res.message !== 'Cancelled') {
          message.error('导出失败: ' + res.message);
      }
  };

  const handleRunSQLFile = async (node: any) => {
      const res = await (window as any).go.app.App.OpenSQLFile();
      if (res.success) {
          const sqlContent = res.data;
          const { dbName, id } = node.dataRef;
          addTab({
              id: `query-${Date.now()}`,
              title: `Import SQL`,
              type: 'query',
              connectionId: node.type === 'connection' ? node.key : node.dataRef.id,
              dbName: dbName,
              query: sqlContent
          });
      } else if (res.message !== "Cancelled") {
          message.error("读取文件失败: " + res.message);
      }
  };

  const handleCreateDatabase = async () => {
      try {
          const values = await createDbForm.validateFields();
          const conn = targetConnection.dataRef;
          const config = { 
              ...conn.config, 
              port: Number(conn.config.port),
              password: conn.config.password || "",
              database: "", // No db selected
              useSSH: conn.config.useSSH || false,
              ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
          };
          
          const res = await CreateDatabase(config as any, values.name);
          if (res.success) {
              message.success("数据库创建成功");
              setIsCreateDbModalOpen(false);
              createDbForm.resetFields();
              // Refresh node
              loadDatabases(targetConnection);
          } else {
              message.error("创建失败: " + res.message);
          }
      } catch (e) {
          // Validate failed
      }
  };

  const onSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { value } = e.target;
    setSearchValue(value);
  };

  const loop = (data: TreeNode[]): TreeNode[] => {
      const result: TreeNode[] = [];
      data.forEach(item => {
          const match = item.title.toLowerCase().indexOf(searchValue.toLowerCase()) > -1;
          if (item.children) {
              const filteredChildren = loop(item.children);
              if (filteredChildren.length > 0 || match) {
                  result.push({ ...item, children: filteredChildren });
              }
          } else {
              if (match) {
                  result.push(item);
              }
          }
      });
      return result;
  };

  const displayTreeData = useMemo(() => {
      if (!searchValue) return treeData;
      return loop(treeData);
  }, [searchValue, treeData]);

  const getNodeMenuItems = (node: any): MenuProps['items'] => {
    if (node.type === 'connection') {
        return [
            {
                key: 'new-db',
                label: '新建数据库',
                icon: <DatabaseOutlined />,
                onClick: () => {
                    setTargetConnection(node);
                    setIsCreateDbModalOpen(true);
                }
            },
            {
                key: 'refresh',
                label: '刷新',
                icon: <ReloadOutlined />,
                onClick: () => loadDatabases(node)
            },
            { type: 'divider' },
            { 
               key: 'new-query', 
               label: '新建查询', 
               icon: <ConsoleSqlOutlined />,
               onClick: () => {
                   addTab({
                       id: `query-${Date.now()}`,
                       title: `新建查询`,
                       type: 'query',
                       connectionId: node.key,
                       dbName: undefined
                   });
               }
             },
             { type: 'divider' },
             {
                 key: 'edit',
                 label: '编辑连接',
                 icon: <EditOutlined />,
                 onClick: () => {
                     if (onEditConnection) onEditConnection(node.dataRef);
                 }
             },
             {
                 key: 'disconnect',
                 label: '断开连接',
                 icon: <DisconnectOutlined />,
                 onClick: () => {
                     // Reset status recursively
                     setConnectionStates(prev => {
                         const next = { ...prev };
                         Object.keys(next).forEach(k => {
                             if (k === node.key || k.startsWith(`${node.key}-`)) {
                                 delete next[k];
                             }
                         });
                         return next;
                     });
                     // Collapse node and children
                     setExpandedKeys(prev => prev.filter(k => k !== node.key && !k.toString().startsWith(`${node.key}-`)));
                     // Reset loaded state recursively
                     setLoadedKeys(prev => prev.filter(k => k !== node.key && !k.toString().startsWith(`${node.key}-`)));
                     // Clear children (undefined to trigger reload)
                     setTreeData(origin => updateTreeData(origin, node.key, undefined));
                     message.success("已断开连接");
                 }
             },
             {
                 key: 'delete',
                 label: '删除连接',
                 icon: <DeleteOutlined />,
                 danger: true,
                 onClick: () => {
                     Modal.confirm({
                         title: '确认删除',
                         content: `确定要删除连接 "${node.title}" 吗？`,
                         onOk: () => removeConnection(node.key)
                     });
                 }
             }
        ];
    } else if (node.type === 'database') {
       return [
           {
               key: 'new-table',
               label: '新建表',
               icon: <TableOutlined />,
               onClick: () => openNewTableDesign(node)
           },
           {
               key: 'refresh',
               label: '刷新',
               icon: <ReloadOutlined />,
               onClick: () => loadTables(node)
           },
           { type: 'divider' },
           {
               key: 'disconnect-db',
               label: '关闭数据库',
               icon: <DisconnectOutlined />,
               onClick: () => {
                   setConnectionStates(prev => {
                       const next = { ...prev };
                       delete next[node.key];
                       return next;
                   });
                   setExpandedKeys(prev => prev.filter(k => k !== node.key && !k.toString().startsWith(`${node.key}-`)));
                   setLoadedKeys(prev => prev.filter(k => k !== node.key && !k.toString().startsWith(`${node.key}-`)));
                   setTreeData(origin => updateTreeData(origin, node.key, undefined));
               }
           },
           { 
               key: 'new-query', 
               label: '新建查询', 
               icon: <ConsoleSqlOutlined />,
               onClick: () => {
                   addTab({
                       id: `query-${Date.now()}`,
                       title: `新建查询 (${node.title})`,
                       type: 'query',
                       connectionId: node.dataRef.id,
                       dbName: node.title
                   });
               }
             },
             {
                 key: 'run-sql',
                 label: '运行 SQL 文件...',
                 icon: <FileAddOutlined />,
                 onClick: () => handleRunSQLFile(node)
             }
       ];
    } else if (node.type === 'table') {
        return [
            {
                key: 'new-query',
                label: '新建查询',
                icon: <ConsoleSqlOutlined />,
                onClick: () => {
                   addTab({
                       id: `query-${Date.now()}`,
                       title: `新建查询`,
                       type: 'query',
                       connectionId: node.dataRef.id,
                       dbName: node.dataRef.dbName
                   });
                }
            },
            { type: 'divider' },
            {
                key: 'design-table',
                label: '设计表',
                icon: <EditOutlined />,
                onClick: () => openDesign(node, 'columns', false)
            },
            {
                key: 'copy-structure',
                label: '复制表结构',
                icon: <CopyOutlined />,
                onClick: () => handleCopyStructure(node)
            },
            {
                key: 'backup-table',
                label: '备份表 (SQL)',
                icon: <SaveOutlined />,
                onClick: () => handleExport(node, 'sql')
            },
            {
                type: 'divider'
            },
            {
                key: 'export',
                label: '导出表数据',
                icon: <ExportOutlined />,
                children: [
                    { key: 'export-csv', label: '导出 CSV', onClick: () => handleExport(node, 'csv') },
                    { key: 'export-xlsx', label: '导出 Excel (XLSX)', onClick: () => handleExport(node, 'xlsx') },
                    { key: 'export-json', label: '导出 JSON', onClick: () => handleExport(node, 'json') },
                    { key: 'export-md', label: '导出 Markdown', onClick: () => handleExport(node, 'md') },
                ]
            }
        ];
    }
    return [];
  };

  const titleRender = (node: any) => {
    let status: 'success' | 'error' | 'default' = 'default';
    if (node.type === 'connection' || node.type === 'database') {
        if (connectionStates[node.key] === 'success') status = 'success';
        else if (connectionStates[node.key] === 'error') status = 'error';
    }
    
    const statusBadge = node.type === 'connection' || node.type === 'database' ? (
        <Badge status={status} style={{ marginRight: 8 }} />
    ) : null;

    return <span title={node.title}>{statusBadge}{node.title}</span>;
  };

  const onRightClick = ({ event, node }: any) => {
      const items = getNodeMenuItems(node);
      if (items && items.length > 0) {
          setContextMenu({
              x: event.clientX,
              y: event.clientY,
              items
          });
      }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={{ padding: '4px 8px' }}>
            <Search placeholder="搜索..." onChange={onSearch} size="small" />
        </div>
        <div ref={treeContainerRef} style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
            <Tree
                showIcon
                loadData={onLoadData}
                treeData={displayTreeData}
                onDoubleClick={onDoubleClick}
                onSelect={onSelect}
                titleRender={titleRender}
                expandedKeys={expandedKeys}
                onExpand={onExpand}
                loadedKeys={loadedKeys}
                onLoad={setLoadedKeys}
                autoExpandParent={autoExpandParent}
                blockNode
                height={treeHeight}
                onRightClick={onRightClick}
            />
        </div>

        {contextMenu && (
            <Dropdown
                menu={{ items: contextMenu.items }}
                open={true}
                onOpenChange={(open) => { if (!open) setContextMenu(null); }}
                trigger={['contextMenu']}
            >
                <div style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, width: 1, height: 1 }} />
            </Dropdown>
        )}

        <Modal
            title="新建数据库"
            open={isCreateDbModalOpen}
            onOk={handleCreateDatabase}
            onCancel={() => setIsCreateDbModalOpen(false)}
        >
            <Form form={createDbForm} layout="vertical">
                <Form.Item name="name" label="数据库名称" rules={[{ required: true, message: '请输入名称' }]}>
                    <Input />
                </Form.Item>
                {/* Charset option could be added here */}
            </Form>
        </Modal>
    </div>
  );
};

export default Sidebar;
