import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Tree, message, Dropdown, MenuProps, Input, Button, Modal, Form, Badge, Checkbox, Space, Select } from 'antd';
	import {
	  DatabaseOutlined,
	  TableOutlined,
	  EyeOutlined,
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
  DisconnectOutlined,
  CloudOutlined,
  CheckSquareOutlined,
  CodeOutlined
	} from '@ant-design/icons';
	import { useStore } from '../store';
	import { SavedConnection } from '../types';
	import { DBGetDatabases, DBGetTables, DBQuery, DBShowCreateTable, ExportTable, OpenSQLFile, CreateDatabase, RenameDatabase, DropDatabase, RenameTable, DropTable, DropView, DropFunction, RenameView } from '../../wailsjs/go/app/App';
  import { normalizeOpacityForPlatform } from '../utils/appearance';

const { Search } = Input;

interface TreeNode {
  title: string;
  key: string;
  isLeaf?: boolean;
  children?: TreeNode[];
  icon?: React.ReactNode;
  dataRef?: any;
  type?: 'connection' | 'database' | 'table' | 'view' | 'db-trigger' | 'routine' | 'object-group' | 'queries-folder' | 'saved-query' | 'folder-columns' | 'folder-indexes' | 'folder-fks' | 'folder-triggers' | 'redis-db';
}

type BatchTableExportMode = 'schema' | 'backup' | 'dataOnly';

const Sidebar: React.FC<{ onEditConnection?: (conn: SavedConnection) => void }> = ({ onEditConnection }) => {
  const connections = useStore(state => state.connections);
  const savedQueries = useStore(state => state.savedQueries);
  const addTab = useStore(state => state.addTab);
  const setActiveContext = useStore(state => state.setActiveContext);
  const removeConnection = useStore(state => state.removeConnection);
  const theme = useStore(state => state.theme);
  const appearance = useStore(state => state.appearance);
  const tableAccessCount = useStore(state => state.tableAccessCount);
  const tableSortPreference = useStore(state => state.tableSortPreference);
  const recordTableAccess = useStore(state => state.recordTableAccess);
  const setTableSortPreference = useStore(state => state.setTableSortPreference);
  const darkMode = theme === 'dark';
  const opacity = normalizeOpacityForPlatform(appearance.opacity);
  const [treeData, setTreeData] = useState<TreeNode[]>([]);

  // Background Helper (Duplicate logic for now, ideally shared)
  const getBg = (darkHex: string) => {
      if (!darkMode) return `rgba(255, 255, 255, ${opacity})`;
      const hex = darkHex.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  };
  const bgMain = getBg('#141414');
  const [searchValue, setSearchValue] = useState('');
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [autoExpandParent, setAutoExpandParent] = useState(true);
  const [loadedKeys, setLoadedKeys] = useState<React.Key[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const selectedNodesRef = useRef<any[]>([]);
  const loadingNodesRef = useRef<Set<string>>(new Set());
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
  const [isRenameDbModalOpen, setIsRenameDbModalOpen] = useState(false);
  const [renameDbForm] = Form.useForm();
  const [renameDbTarget, setRenameDbTarget] = useState<any>(null);
  const [isRenameTableModalOpen, setIsRenameTableModalOpen] = useState(false);
  const [renameTableForm] = Form.useForm();
  const [renameTableTarget, setRenameTableTarget] = useState<any>(null);
  const [isRenameViewModalOpen, setIsRenameViewModalOpen] = useState(false);
  const [renameViewForm] = Form.useForm();
  const [renameViewTarget, setRenameViewTarget] = useState<any>(null);

  // Batch Operations Modal
  const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);
  const [batchTables, setBatchTables] = useState<any[]>([]);
  const [checkedTableKeys, setCheckedTableKeys] = useState<string[]>([]);
  const [batchDbContext, setBatchDbContext] = useState<any>(null);
  const [selectedConnection, setSelectedConnection] = useState<string>('');
  const [selectedDatabase, setSelectedDatabase] = useState<string>('');
  const [availableDatabases, setAvailableDatabases] = useState<any[]>([]);

  // Batch Database Operations Modal
  const [isBatchDbModalOpen, setIsBatchDbModalOpen] = useState(false);
  const [batchDatabases, setBatchDatabases] = useState<any[]>([]);
  const [checkedDbKeys, setCheckedDbKeys] = useState<string[]>([]);
  const [batchConnContext, setBatchConnContext] = useState<any>(null);
  const [selectedDbConnection, setSelectedDbConnection] = useState<string>('');

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
    setTreeData((prev) => {
      const prevMap = new Map<string, TreeNode>();
      prev.forEach((node) => {
        prevMap.set(String(node.key), node);
      });

      return connections.map((conn) => {
        const existing = prevMap.get(conn.id);
        return {
          title: conn.name,
          key: conn.id,
          icon: conn.config.type === 'redis' ? <CloudOutlined style={{ color: '#DC382D' }} /> : <HddOutlined />,
          type: 'connection',
          dataRef: conn,
          isLeaf: false,
          children: existing?.children,
        } as TreeNode;
      });
    });
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

  const SIDEBAR_SCHEMA_DB_TYPES = new Set([
      'postgres',
      'kingbase',
      'highgo',
      'vastbase',
      'sqlserver',
      'oracle',
      'dameng',
  ]);

  const SIDEBAR_SCHEMA_CUSTOM_DRIVERS = new Set([
      'postgres',
      'kingbase',
      'highgo',
      'vastbase',
      'sqlserver',
      'oracle',
      'dm',
  ]);

  const shouldHideSchemaPrefix = (conn: SavedConnection | undefined): boolean => {
      const dbType = String(conn?.config?.type || '').trim().toLowerCase();
      if (SIDEBAR_SCHEMA_DB_TYPES.has(dbType)) return true;
      if (dbType !== 'custom') return false;

      const customDriver = String((conn?.config as any)?.driver || '').trim().toLowerCase();
      return SIDEBAR_SCHEMA_CUSTOM_DRIVERS.has(customDriver);
  };

  const getSidebarTableDisplayName = (conn: SavedConnection | undefined, tableName: string): string => {
      const rawName = String(tableName || '').trim();
      if (!rawName) return rawName;
      if (!shouldHideSchemaPrefix(conn)) return rawName;
      const lastDotIndex = rawName.lastIndexOf('.');
      if (lastDotIndex <= 0 || lastDotIndex >= rawName.length - 1) return rawName;
      return rawName.substring(lastDotIndex + 1);
  };

  const getMetadataDialect = (conn: SavedConnection | undefined): string => {
      const type = String(conn?.config?.type || '').trim().toLowerCase();
      if (type === 'custom') {
          return String((conn?.config as any)?.driver || '').trim().toLowerCase();
      }
      if (type === 'mariadb') return 'mysql';
      if (type === 'dameng') return 'dm';
      return type;
  };

  const escapeSQLLiteral = (raw: string): string => String(raw || '').replace(/'/g, "''");
  const quoteSqlServerIdentifier = (raw: string): string => `[${String(raw || '').replace(/]/g, ']]')}]`;

  const getCaseInsensitiveValue = (row: Record<string, any>, candidateKeys: string[]): string => {
      const keyMap = new Map<string, any>();
      Object.keys(row || {}).forEach((key) => keyMap.set(key.toLowerCase(), row[key]));
      for (const key of candidateKeys) {
          const value = keyMap.get(key.toLowerCase());
          if (value !== undefined && value !== null) {
              const normalized = String(value).trim();
              if (normalized !== '') return normalized;
          }
      }
      return '';
  };

  const getFirstRowValue = (row: Record<string, any>): string => {
      for (const value of Object.values(row || {})) {
          if (value !== undefined && value !== null) {
              const normalized = String(value).trim();
              if (normalized !== '') return normalized;
          }
      }
      return '';
  };

  const buildQualifiedName = (schemaName: string, objectName: string): string => {
      const schema = String(schemaName || '').trim();
      const name = String(objectName || '').trim();
      if (!name) return '';
      if (!schema) return name;
      if (name.includes('.')) return name;
      return `${schema}.${name}`;
  };

  const splitQualifiedName = (qualifiedName: string): { schemaName: string; objectName: string } => {
      const raw = String(qualifiedName || '').trim();
      if (!raw) return { schemaName: '', objectName: '' };
      const idx = raw.lastIndexOf('.');
      if (idx <= 0 || idx >= raw.length - 1) {
          return { schemaName: '', objectName: raw };
      }
      return {
          schemaName: raw.substring(0, idx),
          objectName: raw.substring(idx + 1),
      };
  };

  const buildViewsMetadataQuery = (dialect: string, dbName: string): string => {
      const safeDbName = escapeSQLLiteral(dbName);
      switch (dialect) {
          case 'mysql':
              if (!safeDbName) return '';
              return `SELECT TABLE_NAME AS view_name FROM information_schema.views WHERE table_schema = '${safeDbName}' ORDER BY TABLE_NAME`;
          case 'postgres':
          case 'kingbase':
          case 'highgo':
          case 'vastbase':
              return `SELECT schemaname AS schema_name, viewname AS view_name FROM pg_catalog.pg_views WHERE schemaname != 'information_schema' AND schemaname NOT LIKE 'pg_%' ORDER BY schemaname, viewname`;
          case 'sqlserver': {
              const safeDb = quoteSqlServerIdentifier(dbName || 'master');
              return `SELECT s.name AS schema_name, v.name AS view_name FROM ${safeDb}.sys.views v JOIN ${safeDb}.sys.schemas s ON v.schema_id = s.schema_id ORDER BY s.name, v.name`;
          }
          case 'oracle':
          case 'dm': {
              if (!safeDbName) {
                  return `SELECT VIEW_NAME AS view_name FROM USER_VIEWS ORDER BY VIEW_NAME`;
              }
              return `SELECT OWNER AS schema_name, VIEW_NAME AS view_name FROM ALL_VIEWS WHERE OWNER = '${safeDbName.toUpperCase()}' ORDER BY VIEW_NAME`;
          }
          case 'sqlite':
              return `SELECT name AS view_name FROM sqlite_master WHERE type = 'view' ORDER BY name`;
          default:
              return '';
      }
  };

  const buildTriggersMetadataQuery = (dialect: string, dbName: string): string => {
      const safeDbName = escapeSQLLiteral(dbName);
      switch (dialect) {
          case 'mysql':
              if (!safeDbName) return '';
              return `SELECT TRIGGER_NAME AS trigger_name, EVENT_OBJECT_TABLE AS table_name, TRIGGER_SCHEMA AS schema_name FROM information_schema.triggers WHERE trigger_schema = '${safeDbName}' ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`;
          case 'postgres':
          case 'kingbase':
          case 'highgo':
          case 'vastbase':
              return `SELECT DISTINCT event_object_schema AS schema_name, event_object_table AS table_name, trigger_name FROM information_schema.triggers WHERE trigger_schema NOT IN ('pg_catalog', 'information_schema') AND trigger_schema NOT LIKE 'pg_%' ORDER BY event_object_schema, event_object_table, trigger_name`;
          case 'sqlserver': {
              const safeDb = quoteSqlServerIdentifier(dbName || 'master');
              return `SELECT s.name AS schema_name, t.name AS table_name, tr.name AS trigger_name FROM ${safeDb}.sys.triggers tr JOIN ${safeDb}.sys.tables t ON tr.parent_id = t.object_id JOIN ${safeDb}.sys.schemas s ON t.schema_id = s.schema_id WHERE tr.parent_class = 1 ORDER BY s.name, t.name, tr.name`;
          }
          case 'oracle':
          case 'dm': {
              if (!safeDbName) {
                  return `SELECT TRIGGER_NAME AS trigger_name, TABLE_NAME AS table_name FROM USER_TRIGGERS ORDER BY TABLE_NAME, TRIGGER_NAME`;
              }
              return `SELECT OWNER AS schema_name, TABLE_NAME AS table_name, TRIGGER_NAME AS trigger_name FROM ALL_TRIGGERS WHERE OWNER = '${safeDbName.toUpperCase()}' ORDER BY TABLE_NAME, TRIGGER_NAME`;
          }
          case 'sqlite':
              return `SELECT name AS trigger_name, tbl_name AS table_name FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, name`;
          default:
              return '';
      }
  };

  const queryMetadataRows = async (conn: any, dbName: string, query: string): Promise<Record<string, any>[]> => {
      if (!query) return [];
      try {
          const config = buildRuntimeConfig(conn, dbName);
          const result = await DBQuery(config as any, dbName, query);
          if (!result.success || !Array.isArray(result.data)) return [];
          return result.data as Record<string, any>[];
      } catch {
          return [];
      }
  };

  const loadViews = async (conn: any, dbName: string): Promise<string[]> => {
      const dialect = getMetadataDialect(conn as SavedConnection);
      const query = buildViewsMetadataQuery(dialect, dbName);
      const rows = await queryMetadataRows(conn, dbName, query);
      const seen = new Set<string>();
      const views: string[] = [];

      rows.forEach((row) => {
          const schemaName = getCaseInsensitiveValue(row, ['schema_name', 'schemaname', 'owner', 'table_schema']);
          const viewName = getCaseInsensitiveValue(row, ['view_name', 'viewname', 'table_name', 'name']) || getFirstRowValue(row);
          const fullName = buildQualifiedName(schemaName, viewName);
          if (!fullName || seen.has(fullName)) return;
          seen.add(fullName);
          views.push(fullName);
      });
      return views;
  };

  const loadDatabaseTriggers = async (conn: any, dbName: string): Promise<Array<{ displayName: string; triggerName: string; tableName: string }>> => {
      const dialect = getMetadataDialect(conn as SavedConnection);
      const query = buildTriggersMetadataQuery(dialect, dbName);
      const rows = await queryMetadataRows(conn, dbName, query);
      const seen = new Set<string>();
      const triggers: Array<{ displayName: string; triggerName: string; tableName: string }> = [];

      rows.forEach((row) => {
          const triggerName = getCaseInsensitiveValue(row, ['trigger_name', 'triggername', 'name']) || getFirstRowValue(row);
          if (!triggerName) return;
          const schemaName = getCaseInsensitiveValue(row, ['schema_name', 'schemaname', 'owner', 'event_object_schema', 'trigger_schema']);
          const tableName = getCaseInsensitiveValue(row, ['table_name', 'event_object_table', 'tbl_name']);
          const fullTableName = buildQualifiedName(schemaName, tableName);
          const uniqueKey = `${triggerName}@@${fullTableName}`;
          if (seen.has(uniqueKey)) return;
          seen.add(uniqueKey);
          const displayName = fullTableName ? `${triggerName} (${fullTableName})` : triggerName;
          triggers.push({ displayName, triggerName, tableName: fullTableName });
      });
      return triggers;
  };

  const buildFunctionsMetadataQuery = (dialect: string, dbName: string): string => {
      const safeDbName = escapeSQLLiteral(dbName);
      switch (dialect) {
          case 'mysql':
              if (!safeDbName) return '';
              return `SELECT ROUTINE_NAME AS routine_name, ROUTINE_TYPE AS routine_type FROM information_schema.routines WHERE routine_schema = '${safeDbName}' ORDER BY ROUTINE_TYPE, ROUTINE_NAME`;
          case 'postgres':
          case 'kingbase':
          case 'highgo':
          case 'vastbase':
              return `SELECT n.nspname AS schema_name, p.proname AS routine_name, CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS routine_type FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_%' ORDER BY n.nspname, routine_type, p.proname`;
          case 'sqlserver': {
              const safeDb = quoteSqlServerIdentifier(dbName || 'master');
              return `SELECT s.name AS schema_name, o.name AS routine_name, CASE o.type WHEN 'P' THEN 'PROCEDURE' WHEN 'FN' THEN 'FUNCTION' WHEN 'IF' THEN 'FUNCTION' WHEN 'TF' THEN 'FUNCTION' END AS routine_type FROM ${safeDb}.sys.objects o JOIN ${safeDb}.sys.schemas s ON o.schema_id = s.schema_id WHERE o.type IN ('P','FN','IF','TF') ORDER BY o.type, s.name, o.name`;
          }
          case 'oracle':
          case 'dm': {
              if (!safeDbName) {
                  return `SELECT OBJECT_NAME AS routine_name, OBJECT_TYPE AS routine_type FROM USER_OBJECTS WHERE OBJECT_TYPE IN ('FUNCTION','PROCEDURE') ORDER BY OBJECT_TYPE, OBJECT_NAME`;
              }
              return `SELECT OWNER AS schema_name, OBJECT_NAME AS routine_name, OBJECT_TYPE AS routine_type FROM ALL_OBJECTS WHERE OWNER = '${safeDbName.toUpperCase()}' AND OBJECT_TYPE IN ('FUNCTION','PROCEDURE') ORDER BY OBJECT_TYPE, OBJECT_NAME`;
          }
          default:
              return '';
      }
  };

  const loadFunctions = async (conn: any, dbName: string): Promise<Array<{ displayName: string; routineName: string; routineType: string }>> => {
      const dialect = getMetadataDialect(conn as SavedConnection);
      const query = buildFunctionsMetadataQuery(dialect, dbName);
      const rows = await queryMetadataRows(conn, dbName, query);
      const seen = new Set<string>();
      const routines: Array<{ displayName: string; routineName: string; routineType: string }> = [];

      rows.forEach((row) => {
          const routineName = getCaseInsensitiveValue(row, ['routine_name', 'object_name', 'proname', 'name']);
          if (!routineName) return;
          const schemaName = getCaseInsensitiveValue(row, ['schema_name', 'nspname', 'owner']);
          const routineType = getCaseInsensitiveValue(row, ['routine_type', 'object_type']) || 'FUNCTION';
          const fullName = buildQualifiedName(schemaName, routineName);
          if (!fullName || seen.has(fullName)) return;
          seen.add(fullName);
          const typeLabel = routineType.toUpperCase() === 'PROCEDURE' ? 'P' : 'F';
          routines.push({ displayName: `${fullName} [${typeLabel}]`, routineName: fullName, routineType: routineType.toUpperCase() });
      });
      return routines;
  };

	  const loadDatabases = async (node: any) => {
	      const conn = node.dataRef as SavedConnection;
	      const loadKey = `dbs-${conn.id}`;
	      if (loadingNodesRef.current.has(loadKey)) return;
	      loadingNodesRef.current.add(loadKey);
	      const config = {
	          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
	          useSSH: conn.config.useSSH || false,
	          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
	      };

          // Handle Redis connections differently
          if (conn.config.type === 'redis') {
              try {
                  const res = await (window as any).go.app.App.RedisGetDatabases(config);
                  if (res.success) {
                      setConnectionStates(prev => ({ ...prev, [conn.id]: 'success' }));
                      let dbs = (res.data as any[]).map((db: any) => ({
                          title: `db${db.index}${db.keys > 0 ? ` (${db.keys})` : ''}`,
                          key: `${conn.id}-db${db.index}`,
                          icon: <DatabaseOutlined style={{ color: '#DC382D' }} />,
                          type: 'redis-db' as const,
                          dataRef: { ...conn, redisDB: db.index },
                          isLeaf: true,
                          dbIndex: db.index,
                      }));
                      // Filter Redis databases if configured
                      if (conn.includeRedisDatabases && conn.includeRedisDatabases.length > 0) {
                          dbs = dbs.filter(db => conn.includeRedisDatabases!.includes(db.dbIndex));
                      }
                      setTreeData(origin => updateTreeData(origin, node.key, dbs));
                  } else {
                      setConnectionStates(prev => ({ ...prev, [conn.id]: 'error' }));
                      message.error({ content: res.message, key: `conn-${conn.id}-dbs` });
                  }
              } catch (e: any) {
                  setConnectionStates(prev => ({ ...prev, [conn.id]: 'error' }));
                  message.error({ content: '连接失败: ' + (e?.message || String(e)), key: `conn-${conn.id}-dbs` });
              } finally {
                  loadingNodesRef.current.delete(loadKey);
              }
              return;
          }

	      try {
	          const res = await DBGetDatabases(config as any);
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
            message.error({ content: res.message, key: `conn-${conn.id}-dbs` });
          }
	      } finally {
	          loadingNodesRef.current.delete(loadKey);
	      }
  };

	  const loadTables = async (node: any) => {
	      const conn = node.dataRef; // has dbName
	      const dbName = conn.dbName;
      const key = node.key;
      const loadKey = `tables-${conn.id}-${dbName}`;
      if (loadingNodesRef.current.has(loadKey)) return;
      loadingNodesRef.current.add(loadKey);
      
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
	      try {
	          const res = await DBGetTables(config as any, conn.dbName);
	          if (res.success) {
	            setConnectionStates(prev => ({ ...prev, [key as string]: 'success' }));

	            const tableEntries = (res.data as any[]).map((row: any) => {
	                const tableName = Object.values(row)[0] as string;
	                const parsed = splitQualifiedName(tableName);
	                return {
	                    tableName,
	                    schemaName: parsed.schemaName,
	                    displayName: getSidebarTableDisplayName(conn, tableName),
	                };
	            });

	            const [views, triggers, routines] = await Promise.all([
	                loadViews(conn, conn.dbName),
	                loadDatabaseTriggers(conn, conn.dbName),
	                loadFunctions(conn, conn.dbName),
	            ]);

	            const viewEntries = views.map((viewName) => {
	                const parsed = splitQualifiedName(viewName);
	                return {
	                    viewName,
	                    schemaName: parsed.schemaName,
	                    displayName: getSidebarTableDisplayName(conn, viewName),
	                };
	            });

	            const triggerEntries = triggers.map((trigger) => {
	                const triggerParsed = splitQualifiedName(trigger.triggerName);
	                const tableParsed = splitQualifiedName(trigger.tableName);
	                const schemaName = tableParsed.schemaName || triggerParsed.schemaName;
	                const triggerObjectName = triggerParsed.objectName || trigger.triggerName;
	                const tableObjectName = tableParsed.objectName || trigger.tableName;
	                const displayName = tableObjectName ? `${triggerObjectName} (${tableObjectName})` : triggerObjectName;
	                return {
	                    ...trigger,
	                    schemaName,
	                    displayName,
	                };
	            });

	            const routineEntries = routines.map((routine) => {
	                const parsed = splitQualifiedName(routine.routineName);
	                const typeLabel = routine.routineType === 'PROCEDURE' ? 'P' : 'F';
	                return {
	                    ...routine,
	                    schemaName: parsed.schemaName,
	                    displayName: `${parsed.objectName || routine.routineName} [${typeLabel}]`,
	                };
	            });

	            // 获取当前数据库的排序偏好
	            const sortPreferenceKey = `${conn.id}-${conn.dbName}`;
	            const sortBy = tableSortPreference[sortPreferenceKey] || 'name';

	            // 根据排序偏好排序表
	            if (sortBy === 'frequency') {
	                // 按使用频率排序（降序）
	                tableEntries.sort((a, b) => {
	                    const keyA = `${conn.id}-${conn.dbName}-${a.tableName}`;
	                    const keyB = `${conn.id}-${conn.dbName}-${b.tableName}`;
	                    const countA = tableAccessCount[keyA] || 0;
	                    const countB = tableAccessCount[keyB] || 0;
	                    if (countA !== countB) {
	                        return countB - countA;
	                    }
	                    return a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase());
	                });
	            } else {
	                tableEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));
	            }

	            // Sort views by name (case-insensitive)
	            viewEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

	            // Sort triggers by display name (case-insensitive)
	            triggerEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

	            // Sort routines by display name (case-insensitive)
	            routineEntries.sort((a, b) => a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()));

	            const buildTableNode = (entry: { tableName: string; schemaName: string; displayName: string }): TreeNode => ({
	                title: entry.displayName,
	                key: `${conn.id}-${conn.dbName}-${entry.tableName}`,
	                icon: <TableOutlined />,
	                type: 'table',
	                dataRef: { ...conn, tableName: entry.tableName, schemaName: entry.schemaName },
	                isLeaf: false,
	            });

	            const buildViewNode = (entry: { viewName: string; schemaName: string; displayName: string }): TreeNode => ({
	                title: entry.displayName,
	                key: `${conn.id}-${conn.dbName}-view-${entry.viewName}`,
	                icon: <EyeOutlined />,
	                type: 'view',
	                dataRef: { ...conn, viewName: entry.viewName, tableName: entry.viewName, schemaName: entry.schemaName },
	                isLeaf: true,
	            });

	            const buildTriggerNode = (entry: { triggerName: string; tableName: string; schemaName: string; displayName: string }): TreeNode => ({
	                title: entry.displayName,
	                key: `${conn.id}-${conn.dbName}-trigger-${entry.triggerName}-${entry.tableName}`,
	                icon: <FunctionOutlined />,
	                type: 'db-trigger',
	                dataRef: { ...conn, triggerName: entry.triggerName, triggerTableName: entry.tableName, schemaName: entry.schemaName },
	                isLeaf: true,
	            });

	            const buildRoutineNode = (entry: { routineName: string; routineType: string; schemaName: string; displayName: string }): TreeNode => ({
	                title: entry.displayName,
	                key: `${conn.id}-${conn.dbName}-routine-${entry.routineName}`,
	                icon: <CodeOutlined />,
	                type: 'routine',
	                dataRef: { ...conn, routineName: entry.routineName, routineType: entry.routineType, schemaName: entry.schemaName },
	                isLeaf: true,
	            });

	            const buildObjectGroup = (
	                parentKey: string,
	                groupKey: string,
	                groupTitle: string,
	                groupIcon: React.ReactNode,
	                children: TreeNode[],
	                extraData: Record<string, any> = {}
	            ): TreeNode => ({
	                title: `${groupTitle} (${children.length})`,
	                key: `${parentKey}-${groupKey}`,
	                icon: groupIcon,
	                type: 'object-group',
	                isLeaf: children.length === 0,
	                children: children.length > 0 ? children : undefined,
	                dataRef: { ...conn, dbName: conn.dbName, groupKey, ...extraData }
	            });

	            const shouldGroupBySchema = shouldHideSchemaPrefix(conn as SavedConnection);
	            if (shouldGroupBySchema) {
	                type SchemaBucket = {
	                    schemaName: string;
	                    tables: TreeNode[];
	                    views: TreeNode[];
	                    routines: TreeNode[];
	                    triggers: TreeNode[];
	                };

	                const schemaMap = new Map<string, SchemaBucket>();
	                const getSchemaBucket = (rawSchemaName: string): SchemaBucket => {
	                    const schemaName = String(rawSchemaName || '').trim();
	                    const schemaKey = schemaName || '__default__';
	                    let bucket = schemaMap.get(schemaKey);
	                    if (!bucket) {
	                        bucket = {
	                            schemaName,
	                            tables: [],
	                            views: [],
	                            routines: [],
	                            triggers: [],
	                        };
	                        schemaMap.set(schemaKey, bucket);
	                    }
	                    return bucket;
	                };

	                tableEntries.forEach((entry) => getSchemaBucket(entry.schemaName).tables.push(buildTableNode(entry)));
	                viewEntries.forEach((entry) => getSchemaBucket(entry.schemaName).views.push(buildViewNode(entry)));
	                routineEntries.forEach((entry) => getSchemaBucket(entry.schemaName).routines.push(buildRoutineNode(entry)));
	                triggerEntries.forEach((entry) => getSchemaBucket(entry.schemaName).triggers.push(buildTriggerNode(entry)));

	                const schemaNodes: TreeNode[] = Array.from(schemaMap.values())
	                    .sort((a, b) => {
	                        if (!a.schemaName && !b.schemaName) return 0;
	                        if (!a.schemaName) return -1;
	                        if (!b.schemaName) return 1;
	                        return a.schemaName.toLowerCase().localeCompare(b.schemaName.toLowerCase());
	                    })
	                    .map((bucket) => {
	                        const schemaNodeKey = `${key}-schema-${bucket.schemaName || 'default'}`;
	                        const schemaTitle = bucket.schemaName || '默认模式';
	                        const groupedNodes: TreeNode[] = [
	                            buildObjectGroup(schemaNodeKey, 'tables', '表', <TableOutlined />, bucket.tables, { schemaName: bucket.schemaName }),
	                            buildObjectGroup(schemaNodeKey, 'views', '视图', <EyeOutlined />, bucket.views, { schemaName: bucket.schemaName }),
	                            buildObjectGroup(schemaNodeKey, 'routines', '函数', <CodeOutlined />, bucket.routines, { schemaName: bucket.schemaName }),
	                            buildObjectGroup(schemaNodeKey, 'triggers', '触发器', <FunctionOutlined />, bucket.triggers, { schemaName: bucket.schemaName }),
	                        ];

	                        return {
	                            title: schemaTitle,
	                            key: schemaNodeKey,
	                            icon: <FolderOpenOutlined />,
	                            type: 'object-group' as const,
	                            isLeaf: groupedNodes.length === 0,
	                            children: groupedNodes,
	                            dataRef: { ...conn, dbName: conn.dbName, groupKey: 'schema', schemaName: bucket.schemaName }
	                        };
	                    });

	                setTreeData(origin => updateTreeData(origin, key, [queriesNode, ...schemaNodes]));
	            } else {
	                const groupedNodes: TreeNode[] = [
	                    buildObjectGroup(key as string, 'tables', '表', <TableOutlined />, tableEntries.map(buildTableNode)),
	                    buildObjectGroup(key as string, 'views', '视图', <EyeOutlined />, viewEntries.map(buildViewNode)),
	                    buildObjectGroup(key as string, 'routines', '函数', <CodeOutlined />, routineEntries.map(buildRoutineNode)),
	                    buildObjectGroup(key as string, 'triggers', '触发器', <FunctionOutlined />, triggerEntries.map(buildTriggerNode)),
	                ];

	                setTreeData(origin => updateTreeData(origin, key, [queriesNode, ...groupedNodes]));
	            }
	          } else {
	            setConnectionStates(prev => ({ ...prev, [key as string]: 'error' }));
	            message.error({ content: res.message, key: `db-${key}-tables` });
          }
	      } finally {
	          loadingNodesRef.current.delete(loadKey);
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
      setSelectedKeys(keys);
      selectedNodesRef.current = info.selectedNodes || [];

      if (keys.length === 0) {
          setActiveContext(null);
          return;
      }
      if (!info.selected) return;

      const { type, dataRef, key, title } = info.node;

      // Update active context
      if (type === 'connection') {
          setActiveContext({ connectionId: key, dbName: '' });
      } else if (type === 'database') {
          setActiveContext({ connectionId: dataRef.id, dbName: title });
      } else if (type === 'table') {
          setActiveContext({ connectionId: dataRef.id, dbName: dataRef.dbName });
      } else if (type === 'view' || type === 'db-trigger' || type === 'routine') {
          setActiveContext({ connectionId: dataRef.id, dbName: dataRef.dbName });
      } else if (type === 'saved-query') {
          setActiveContext({ connectionId: dataRef.connectionId, dbName: dataRef.dbName });
      } else if (type === 'redis-db') {
          setActiveContext({ connectionId: dataRef.id, dbName: `db${dataRef.redisDB}` });
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
      if (node.type === 'table') {
          const { tableName, dbName, id } = node.dataRef;
          // 记录表访问
          recordTableAccess(id, dbName, tableName);
          addTab({
              id: node.key,
              title: tableName,
              type: 'table',
              connectionId: id,
              dbName,
              tableName,
          });
          return;
      } else if (node.type === 'view') {
          const { viewName, dbName, id } = node.dataRef;
          addTab({
              id: node.key,
              title: viewName,
              type: 'table',
              connectionId: id,
              dbName,
              tableName: viewName,
          });
          return;
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
          return;
      } else if (node.type === 'redis-db') {
          const { id, redisDB } = node.dataRef;
          addTab({
              id: `redis-keys-${id}-db${redisDB}`,
              title: `db${redisDB}`,
              type: 'redis-keys',
              connectionId: id,
              redisDB: redisDB
          });
          return;
      } else if (node.type === 'db-trigger') {
          const { triggerName, dbName, id } = node.dataRef;
          addTab({
              id: `trigger-${node.key}`,
              title: `触发器: ${triggerName}`,
              type: 'trigger',
              connectionId: id,
              dbName,
              triggerName
          });
          return;
      } else if (node.type === 'routine') {
          const { routineName, routineType, dbName, id } = node.dataRef;
          const typeLabel = routineType === 'PROCEDURE' ? '存储过程' : '函数';
          addTab({
              id: `routine-def-${node.key}`,
              title: `${typeLabel}: ${routineName}`,
              type: 'routine-def',
              connectionId: id,
              dbName,
              routineName,
              routineType
          });
          return;
      }

      const key = node.key;
      const isExpanded = expandedKeys.includes(key);
      const newExpandedKeys = isExpanded
          ? expandedKeys.filter(k => k !== key)
          : [...expandedKeys, key];

      setExpandedKeys(newExpandedKeys);
      if (!isExpanded) setAutoExpandParent(false);
  };
  
	  const handleCopyStructure = async (node: any) => {
	      const { config, dbName, tableName } = node.dataRef;
	      const res = await DBShowCreateTable({ 
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

  const normalizeConnConfig = (raw: any) => ({
      ...raw,
      port: Number(raw.port),
      password: raw.password || "",
      database: raw.database || "",
      useSSH: raw.useSSH || false,
      ssh: raw.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
  });

  const handleExportDatabaseSQL = async (node: any, includeData: boolean) => {
      const conn = node.dataRef;
      const dbName = conn.dbName || node.title;
      const hide = message.loading(includeData ? `正在备份数据库 ${dbName} (结构+数据)...` : `正在导出数据库 ${dbName} 表结构...`, 0);
      try {
          const res = await (window as any).go.app.App.ExportDatabaseSQL(normalizeConnConfig(conn.config), dbName, includeData);
          hide();
          if (res.success) {
              message.success('导出成功');
          } else if (res.message !== 'Cancelled') {
              message.error('导出失败: ' + res.message);
          }
      } catch (e: any) {
          hide();
          message.error('导出失败: ' + (e?.message || String(e)));
      }
  };

  const handleExportTablesSQL = async (nodes: any[], includeData: boolean) => {
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0].dataRef;
      const dbName = first.dbName;
      const connId = first.id;
      const allSame = nodes.every(n => n?.dataRef?.id === connId && n?.dataRef?.dbName === dbName);
      if (!allSame) {
          message.error('请在同一连接、同一数据库下选择多张表进行导出');
          return;
      }

      const tableNames = nodes.map(n => n.dataRef.tableName).filter(Boolean);
      const hide = message.loading(includeData ? `正在备份选中表 (${tableNames.length})...` : `正在导出选中表结构 (${tableNames.length})...`, 0);
      try {
          const res = await (window as any).go.app.App.ExportTablesSQL(normalizeConnConfig(first.config), dbName, tableNames, includeData);
          hide();
          if (res.success) {
              message.success('导出成功');
          } else if (res.message !== 'Cancelled') {
              message.error('导出失败: ' + res.message);
          }
      } catch (e: any) {
          hide();
          message.error('导出失败: ' + (e?.message || String(e)));
      }
  };

  const openBatchOperationModal = async () => {
      // Check if current selected node is database or table
      let connId = '';
      let dbName = '';

      if (selectedNodesRef.current.length > 0) {
          const node = selectedNodesRef.current[0];
          if (node.type === 'database') {
              connId = node.dataRef.id;
              dbName = node.title;
          } else if (node.type === 'table') {
              connId = node.dataRef.id;
              dbName = node.dataRef.dbName;
          }
      }

      setSelectedConnection(connId);
      setSelectedDatabase(dbName);
      setBatchTables([]);
      setCheckedTableKeys([]);
      setAvailableDatabases([]);

      if (connId) {
          const conn = connections.find(c => c.id === connId);
          if (conn) {
              await loadDatabasesForBatch(conn);
              if (dbName) {
                  await loadTablesForBatch(conn, dbName);
              }
          }
      }

      setIsBatchModalOpen(true);
  };

  const loadDatabasesForBatch = async (conn: SavedConnection) => {
      const config = {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      };

      const res = await DBGetDatabases(config as any);
      if (res.success) {
          let dbs = (res.data as any[]).map((row: any) => {
              const dbName = row.Database || row.database;
              return {
                  title: dbName,
                  key: `${conn.id}-${dbName}`,
                  dbName: dbName
              };
          });

          if (conn.includeDatabases && conn.includeDatabases.length > 0) {
              dbs = dbs.filter(db => conn.includeDatabases!.includes(db.dbName));
          }

          setAvailableDatabases(dbs);
      } else {
          message.error('获取数据库列表失败: ' + res.message);
      }
  };

  const loadTablesForBatch = async (conn: SavedConnection, dbName: string) => {
      setBatchDbContext({ conn, dbName });

      const config = {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      };

      const res = await DBGetTables(config as any, dbName);
      if (res.success) {
          const tables = (res.data as any[]).map((row: any) => {
              const tableName = Object.values(row)[0] as string;
              return {
                  title: tableName,
                  key: `${conn.id}-${dbName}-${tableName}`,
                  tableName: tableName,
                  dataRef: { ...conn, tableName, dbName }
              };
          });

          setBatchTables(tables);
          setCheckedTableKeys([]);
      } else {
          message.error('获取表列表失败: ' + res.message);
      }
  };

  const handleConnectionChange = async (connId: string) => {
      setSelectedConnection(connId);
      setSelectedDatabase('');
      setBatchTables([]);
      setCheckedTableKeys([]);

      const conn = connections.find(c => c.id === connId);
      if (conn) {
          await loadDatabasesForBatch(conn);
      }
  };

  const handleDatabaseChange = async (dbName: string) => {
      setSelectedDatabase(dbName);

      const conn = connections.find(c => c.id === selectedConnection);
      if (conn && dbName) {
          await loadTablesForBatch(conn, dbName);
      }
  };

  const handleBatchExport = async (mode: BatchTableExportMode) => {
      const selectedTables = batchTables.filter(t => checkedTableKeys.includes(t.key));
      if (selectedTables.length === 0) {
          message.warning('请至少选择一张表');
          return;
      }

      setIsBatchModalOpen(false);

      const { conn, dbName } = batchDbContext;
      const tableNames = selectedTables.map(t => t.tableName);

      const loadingText = mode === 'backup'
          ? `正在备份选中表 (${tableNames.length})...`
          : mode === 'dataOnly'
              ? `正在导出选中表数据 (INSERT) (${tableNames.length})...`
              : `正在导出选中表结构 (${tableNames.length})...`;
      const hide = message.loading(loadingText, 0);
      try {
          const app = (window as any).go.app.App;
          const res = mode === 'dataOnly'
              ? await app.ExportTablesDataSQL(normalizeConnConfig(conn.config), dbName, tableNames)
              : await app.ExportTablesSQL(normalizeConnConfig(conn.config), dbName, tableNames, mode === 'backup');
          hide();
          if (res.success) {
              message.success('导出成功');
          } else if (res.message !== 'Cancelled') {
              message.error('导出失败: ' + res.message);
          }
      } catch (e: any) {
          hide();
          message.error('导出失败: ' + (e?.message || String(e)));
      }
  };

  const handleCheckAll = (checked: boolean) => {
      if (checked) {
          setCheckedTableKeys(batchTables.map(t => t.key));
      } else {
          setCheckedTableKeys([]);
      }
  };

  const handleInvertSelection = () => {
      const allKeys = batchTables.map(t => t.key);
      const newChecked = allKeys.filter(k => !checkedTableKeys.includes(k));
      setCheckedTableKeys(newChecked);
  };

  const openBatchDatabaseModal = async () => {
      // Check if current selected node is connection or database
      let connId = '';

      if (selectedNodesRef.current.length > 0) {
          const node = selectedNodesRef.current[0];
          if (node.type === 'connection' && node.dataRef?.config?.type !== 'redis') {
              connId = node.key as string;
          } else if (node.type === 'database') {
              connId = node.dataRef.id;
          } else if (node.type === 'table') {
              connId = node.dataRef.id;
          }
      }

      setSelectedDbConnection(connId);
      setBatchDatabases([]);
      setCheckedDbKeys([]);

      if (connId) {
          const conn = connections.find(c => c.id === connId);
          if (conn) {
              await loadDatabasesForDbBatch(conn);
          }
      }

      setIsBatchDbModalOpen(true);
  };

  const loadDatabasesForDbBatch = async (conn: SavedConnection) => {
      setBatchConnContext(conn);

      const config = {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      };

      const res = await DBGetDatabases(config as any);
      if (res.success) {
          let dbs = (res.data as any[]).map((row: any) => {
              const dbName = row.Database || row.database;
              return {
                  title: dbName,
                  key: `${conn.id}-${dbName}`,
                  dbName: dbName,
                  dataRef: { ...conn, dbName }
              };
          });

          if (conn.includeDatabases && conn.includeDatabases.length > 0) {
              dbs = dbs.filter(db => conn.includeDatabases!.includes(db.dbName));
          }

          setBatchDatabases(dbs);
          setCheckedDbKeys([]);
      } else {
          message.error('获取数据库列表失败: ' + res.message);
      }
  };

  const handleDbConnectionChange = async (connId: string) => {
      setSelectedDbConnection(connId);

      const conn = connections.find(c => c.id === connId);
      if (conn) {
          await loadDatabasesForDbBatch(conn);
      }
  };

  const handleBatchDbExport = async (includeData: boolean) => {
      const selectedDbs = batchDatabases.filter(db => checkedDbKeys.includes(db.key));
      if (selectedDbs.length === 0) {
          message.warning('请至少选择一个数据库');
          return;
      }

      setIsBatchDbModalOpen(false);

      for (const db of selectedDbs) {
          const hide = message.loading(includeData ? `正在备份数据库 ${db.dbName} (结构+数据)...` : `正在导出数据库 ${db.dbName} 表结构...`, 0);
          try {
              const res = await (window as any).go.app.App.ExportDatabaseSQL(normalizeConnConfig(batchConnContext.config), db.dbName, includeData);
              hide();
              if (res.success) {
                  message.success(`${db.dbName} 导出成功`);
              } else if (res.message !== 'Cancelled') {
                  message.error(`${db.dbName} 导出失败: ` + res.message);
                  break;
              } else {
                  break; // User cancelled
              }
          } catch (e: any) {
              hide();
              message.error(`${db.dbName} 导出失败: ` + (e?.message || String(e)));
              break;
          }
      }
  };

  const handleCheckAllDb = (checked: boolean) => {
      if (checked) {
          setCheckedDbKeys(batchDatabases.map(db => db.key));
      } else {
          setCheckedDbKeys([]);
      }
  };

  const handleInvertSelectionDb = () => {
      const allKeys = batchDatabases.map(db => db.key);
      const newChecked = allKeys.filter(k => !checkedDbKeys.includes(k));
      setCheckedDbKeys(newChecked);
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

  const buildRuntimeConfig = (conn: any, overrideDatabase?: string, clearDatabase: boolean = false) => {
      return {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: clearDatabase ? "" : ((overrideDatabase ?? conn.config.database) || ""),
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      };
  };

  const getConnectionNodeRef = (connRef: any) => {
      const latestConn = connections.find(c => c.id === connRef.id);
      return { key: connRef.id, dataRef: latestConn || connRef };
  };

  const getDatabaseNodeRef = (connRef: any, dbName: string) => {
      const latestConn = connections.find(c => c.id === connRef.id);
      return {
          key: `${connRef.id}-${dbName}`,
          dataRef: { ...(latestConn || connRef), dbName }
      };
  };

  const extractObjectName = (fullName: string) => {
      const raw = String(fullName || '').trim();
      const idx = raw.lastIndexOf('.');
      if (idx >= 0 && idx < raw.length - 1) {
          return raw.substring(idx + 1);
      }
      return raw;
  };

  const handleRenameDatabase = async () => {
      if (!renameDbTarget) return;
      try {
          const values = await renameDbForm.validateFields();
          const conn = renameDbTarget.dataRef;
          const oldDbName = String(conn.dbName || '').trim();
          const newDbName = String(values.newName || '').trim();
          if (!oldDbName || !newDbName) {
              message.error("数据库名称不能为空");
              return;
          }
          if (oldDbName === newDbName) {
              message.warning("新旧数据库名称相同，无需修改");
              return;
          }

          const config = buildRuntimeConfig(conn, conn.dbName);
          const res = await RenameDatabase(config as any, oldDbName, newDbName);
          if (res.success) {
              message.success("数据库重命名成功");
              setExpandedKeys(prev => prev.filter(k => !k.toString().startsWith(`${conn.id}-${oldDbName}`)));
              setLoadedKeys(prev => prev.filter(k => !k.toString().startsWith(`${conn.id}-${oldDbName}`)));
              await loadDatabases(getConnectionNodeRef(conn));
              setIsRenameDbModalOpen(false);
              setRenameDbTarget(null);
              renameDbForm.resetFields();
          } else {
              message.error("重命名失败: " + res.message);
          }
      } catch (e) {
          // Validate failed
      }
  };

  const handleDeleteDatabase = (node: any) => {
      const conn = node.dataRef;
      const dbName = String(conn.dbName || '').trim();
      if (!dbName) return;
      Modal.confirm({
          title: '确认删除数据库',
          content: `确定删除数据库 "${dbName}" 吗？该操作不可恢复。`,
          okButtonProps: { danger: true },
          onOk: async () => {
              const config = buildRuntimeConfig(conn, conn.dbName);
              const res = await DropDatabase(config as any, dbName);
              if (res.success) {
                  message.success("数据库删除成功");
                  setExpandedKeys(prev => prev.filter(k => !k.toString().startsWith(`${conn.id}-${dbName}`)));
                  setLoadedKeys(prev => prev.filter(k => !k.toString().startsWith(`${conn.id}-${dbName}`)));
                  await loadDatabases(getConnectionNodeRef(conn));
              } else {
                  message.error("删除失败: " + res.message);
              }
          }
      });
  };

  const handleRenameTable = async () => {
      if (!renameTableTarget) return;
      try {
          const values = await renameTableForm.validateFields();
          const conn = renameTableTarget.dataRef;
          const oldTableName = String(conn.tableName || '').trim();
          const newTableName = String(values.newName || '').trim();
          if (!oldTableName || !newTableName) {
              message.error("表名不能为空");
              return;
          }
          if (extractObjectName(oldTableName) === newTableName || oldTableName === newTableName) {
              message.warning("新旧表名相同，无需修改");
              return;
          }
          const config = buildRuntimeConfig(conn, conn.dbName);
          const res = await RenameTable(config as any, conn.dbName, oldTableName, newTableName);
          if (res.success) {
              message.success("表重命名成功");
              await loadTables(getDatabaseNodeRef(conn, conn.dbName));
              setIsRenameTableModalOpen(false);
              setRenameTableTarget(null);
              renameTableForm.resetFields();
          } else {
              message.error("重命名失败: " + res.message);
          }
      } catch (e) {
          // Validate failed
      }
  };

  const handleDeleteTable = (node: any) => {
      const conn = node.dataRef;
      const tableName = String(conn.tableName || '').trim();
      if (!tableName) return;
      Modal.confirm({
          title: '确认删除表',
          content: `确定删除表 "${tableName}" 吗？该操作不可恢复。`,
          okButtonProps: { danger: true },
          onOk: async () => {
              const config = buildRuntimeConfig(conn, conn.dbName);
              const res = await DropTable(config as any, conn.dbName, tableName);
              if (res.success) {
                  message.success("表删除成功");
                  await loadTables(getDatabaseNodeRef(conn, conn.dbName));
              } else {
                  message.error("删除失败: " + res.message);
              }
          }
      });
  };

  // --- 视图操作 ---
  const openViewDefinition = (node: any) => {
      const { viewName, dbName, id } = node.dataRef;
      addTab({
          id: `view-def-${id}-${dbName}-${viewName}`,
          title: `视图: ${viewName}`,
          type: 'view-def',
          connectionId: id,
          dbName,
          viewName,
      });
  };

  const openEditView = async (node: any) => {
      const conn = node.dataRef;
      const { viewName, dbName, id } = conn;
      // 获取视图定义后打开查询编辑器
      const dialect = getMetadataDialect(conn as SavedConnection);
      let template = `-- 编辑视图 ${viewName}\n-- 请修改后执行\nCREATE OR REPLACE VIEW ${viewName} AS\nSELECT * FROM your_table;`;

      try {
          const config = buildRuntimeConfig(conn, dbName);
          let query = '';
          switch (dialect) {
              case 'mysql':
                  query = `SHOW CREATE VIEW \`${viewName.replace(/`/g, '``')}\``;
                  break;
              case 'postgres': case 'kingbase': case 'highgo': case 'vastbase': {
                  const parts = viewName.split('.');
                  const schema = parts.length > 1 ? parts[0] : 'public';
                  const name = parts.length > 1 ? parts[1] : viewName;
                  query = `SELECT pg_get_viewdef('${escapeSQLLiteral(schema)}.${escapeSQLLiteral(name)}'::regclass, true) AS view_definition`;
                  break;
              }
              case 'sqlserver':
                  query = `SELECT OBJECT_DEFINITION(OBJECT_ID('${escapeSQLLiteral(viewName)}')) AS view_definition`;
                  break;
              case 'sqlite':
                  query = `SELECT sql AS view_definition FROM sqlite_master WHERE type='view' AND name='${escapeSQLLiteral(viewName)}'`;
                  break;
          }
          if (query) {
              const result = await DBQuery(config as any, dbName, query);
              if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                  const row = result.data[0] as Record<string, any>;
                  const def = row.view_definition || row.VIEW_DEFINITION || Object.values(row).find(v => typeof v === 'string' && String(v).length > 10) || '';
                  if (def) {
                      template = `-- 编辑视图 ${viewName}\nCREATE OR REPLACE VIEW ${viewName} AS\n${def}`;
                  }
              }
          }
      } catch { /* 降级使用模板 */ }

      addTab({
          id: `query-edit-view-${Date.now()}`,
          title: `编辑视图: ${viewName}`,
          type: 'query',
          connectionId: id,
          dbName,
          query: template
      });
  };

  const openCreateView = (node: any) => {
      const conn = node.dataRef;
      const { dbName, id } = conn;
      const dialect = getMetadataDialect(conn as SavedConnection);
      let template: string;
      switch (dialect) {
          case 'mysql':
              template = `CREATE VIEW \`view_name\` AS\nSELECT column1, column2\nFROM table_name\nWHERE condition;`;
              break;
          case 'postgres': case 'kingbase': case 'highgo': case 'vastbase':
              template = `CREATE OR REPLACE VIEW view_name AS\nSELECT column1, column2\nFROM table_name\nWHERE condition;`;
              break;
          case 'sqlserver':
              template = `CREATE VIEW dbo.view_name AS\nSELECT column1, column2\nFROM table_name\nWHERE condition;`;
              break;
          case 'oracle': case 'dm':
              template = `CREATE OR REPLACE VIEW view_name AS\nSELECT column1, column2\nFROM table_name\nWHERE condition;`;
              break;
          case 'sqlite':
              template = `CREATE VIEW view_name AS\nSELECT column1, column2\nFROM table_name\nWHERE condition;`;
              break;
          default:
              template = `CREATE VIEW view_name AS\nSELECT column1, column2\nFROM table_name\nWHERE condition;`;
      }
      addTab({
          id: `query-create-view-${Date.now()}`,
          title: `新建视图`,
          type: 'query',
          connectionId: id,
          dbName,
          query: template
      });
  };

  const handleDropView = (node: any) => {
      const conn = node.dataRef;
      const viewName = String(conn.viewName || '').trim();
      if (!viewName) return;
      Modal.confirm({
          title: '确认删除视图',
          content: `确定删除视图 "${viewName}" 吗？该操作不可恢复。`,
          okButtonProps: { danger: true },
          onOk: async () => {
              const config = buildRuntimeConfig(conn, conn.dbName);
              const res = await DropView(config as any, conn.dbName, viewName);
              if (res.success) {
                  message.success("视图删除成功");
                  await loadTables(getDatabaseNodeRef(conn, conn.dbName));
              } else {
                  message.error("删除失败: " + res.message);
              }
          }
      });
  };

  const handleRenameView = async () => {
      if (!renameViewTarget) return;
      try {
          const values = await renameViewForm.validateFields();
          const conn = renameViewTarget.dataRef;
          const oldViewName = String(conn.viewName || '').trim();
          const newViewName = String(values.newName || '').trim();
          if (!oldViewName || !newViewName) {
              message.error("视图名称不能为空");
              return;
          }
          if (extractObjectName(oldViewName) === newViewName || oldViewName === newViewName) {
              message.warning("新旧视图名相同，无需修改");
              return;
          }
          const config = buildRuntimeConfig(conn, conn.dbName);
          const res = await RenameView(config as any, conn.dbName, oldViewName, newViewName);
          if (res.success) {
              message.success("视图重命名成功");
              await loadTables(getDatabaseNodeRef(conn, conn.dbName));
              setIsRenameViewModalOpen(false);
              setRenameViewTarget(null);
              renameViewForm.resetFields();
          } else {
              message.error("重命名失败: " + res.message);
          }
      } catch (e) {
          // Validate failed
      }
  };

  // --- 函数/存储过程操作 ---
  const openRoutineDefinition = (node: any) => {
      const { routineName, routineType, dbName, id } = node.dataRef;
      const typeLabel = routineType === 'PROCEDURE' ? '存储过程' : '函数';
      addTab({
          id: `routine-def-${id}-${dbName}-${routineName}`,
          title: `${typeLabel}: ${routineName}`,
          type: 'routine-def',
          connectionId: id,
          dbName,
          routineName,
          routineType
      });
  };

  const openEditRoutine = async (node: any) => {
      const conn = node.dataRef;
      const { routineName, routineType, dbName, id } = conn;
      const dialect = getMetadataDialect(conn as SavedConnection);
      const typeLabel = routineType === 'PROCEDURE' ? '存储过程' : '函数';
      let template = `-- 编辑${typeLabel} ${routineName}`;

      try {
          const config = buildRuntimeConfig(conn, dbName);
          let query = '';
          const parts = routineName.split('.');
          const name = parts.length > 1 ? parts[1] : routineName;
          const schema = parts.length > 1 ? parts[0] : '';

          switch (dialect) {
              case 'mysql':
                  query = `SHOW CREATE ${routineType} \`${name.replace(/`/g, '``')}\``;
                  break;
              case 'postgres': case 'kingbase': case 'highgo': case 'vastbase': {
                  const schemaRef = schema || 'public';
                  query = `SELECT pg_get_functiondef(p.oid) AS routine_definition FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = '${escapeSQLLiteral(schemaRef)}' AND p.proname = '${escapeSQLLiteral(name)}' LIMIT 1`;
                  break;
              }
              case 'sqlserver':
                  query = `SELECT OBJECT_DEFINITION(OBJECT_ID('${escapeSQLLiteral(routineName)}')) AS routine_definition`;
                  break;
              case 'oracle': case 'dm': {
                  const owner = schema ? escapeSQLLiteral(schema).toUpperCase() : '';
                  if (owner) {
                      query = `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${owner}' AND NAME = '${escapeSQLLiteral(name).toUpperCase()}' AND TYPE = '${routineType}' ORDER BY LINE`;
                  } else {
                      query = `SELECT TEXT FROM USER_SOURCE WHERE NAME = '${escapeSQLLiteral(name).toUpperCase()}' AND TYPE = '${routineType}' ORDER BY LINE`;
                  }
                  break;
              }
          }
          if (query) {
              const result = await DBQuery(config as any, dbName, query);
              if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                  if (dialect === 'oracle' || dialect === 'dm') {
                      const lines = result.data.map((row: any) => row.text || row.TEXT || Object.values(row)[0] || '').join('');
                      if (lines) template = `-- 编辑${typeLabel} ${routineName}\nCREATE OR REPLACE ${lines}`;
                  } else {
                      const row = result.data[0] as Record<string, any>;
                      const def = row.routine_definition || row.ROUTINE_DEFINITION || Object.values(row).find(v => typeof v === 'string' && String(v).length > 10) || '';
                      if (def) template = `-- 编辑${typeLabel} ${routineName}\n${def}`;
                  }
              }
          }
      } catch { /* 降级使用模板 */ }

      addTab({
          id: `query-edit-routine-${Date.now()}`,
          title: `编辑${typeLabel}: ${routineName}`,
          type: 'query',
          connectionId: id,
          dbName,
          query: template
      });
  };

  const openCreateRoutine = (node: any, type: 'FUNCTION' | 'PROCEDURE') => {
      const conn = node.dataRef;
      const { dbName, id } = conn;
      const dialect = getMetadataDialect(conn as SavedConnection);
      const isProc = type === 'PROCEDURE';
      let template: string;

      switch (dialect) {
          case 'mysql':
              template = isProc
                  ? `DELIMITER $$\nCREATE PROCEDURE proc_name(IN param1 INT)\nBEGIN\n    SELECT * FROM table_name WHERE id = param1;\nEND$$\nDELIMITER ;`
                  : `DELIMITER $$\nCREATE FUNCTION func_name(param1 INT)\nRETURNS INT\nDETERMINISTIC\nBEGIN\n    RETURN param1 * 2;\nEND$$\nDELIMITER ;`;
              break;
          case 'postgres': case 'kingbase': case 'highgo': case 'vastbase':
              template = isProc
                  ? `CREATE OR REPLACE PROCEDURE proc_name(param1 integer)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n    -- procedure body\nEND;\n$$;`
                  : `CREATE OR REPLACE FUNCTION func_name(param1 integer)\nRETURNS integer\nLANGUAGE plpgsql\nAS $$\nBEGIN\n    RETURN param1 * 2;\nEND;\n$$;`;
              break;
          case 'sqlserver':
              template = isProc
                  ? `CREATE PROCEDURE dbo.proc_name\n    @param1 INT\nAS\nBEGIN\n    SELECT * FROM table_name WHERE id = @param1;\nEND;`
                  : `CREATE FUNCTION dbo.func_name(@param1 INT)\nRETURNS INT\nAS\nBEGIN\n    RETURN @param1 * 2;\nEND;`;
              break;
          case 'oracle': case 'dm':
              template = isProc
                  ? `CREATE OR REPLACE PROCEDURE proc_name(param1 IN NUMBER)\nIS\nBEGIN\n    -- procedure body\n    NULL;\nEND;`
                  : `CREATE OR REPLACE FUNCTION func_name(param1 IN NUMBER)\nRETURN NUMBER\nIS\nBEGIN\n    RETURN param1 * 2;\nEND;`;
              break;
          default:
              template = isProc
                  ? `CREATE PROCEDURE proc_name()\nBEGIN\n    -- procedure body\nEND;`
                  : `CREATE FUNCTION func_name()\nRETURNS INTEGER\nBEGIN\n    RETURN 0;\nEND;`;
      }

      addTab({
          id: `query-create-routine-${Date.now()}`,
          title: isProc ? '新建存储过程' : '新建函数',
          type: 'query',
          connectionId: id,
          dbName,
          query: template
      });
  };

  const handleDropRoutine = (node: any) => {
      const conn = node.dataRef;
      const routineName = String(conn.routineName || '').trim();
      const routineType = String(conn.routineType || 'FUNCTION').trim();
      if (!routineName) return;
      const typeLabel = routineType === 'PROCEDURE' ? '存储过程' : '函数';
      Modal.confirm({
          title: `确认删除${typeLabel}`,
          content: `确定删除${typeLabel} "${routineName}" 吗？该操作不可恢复。`,
          okButtonProps: { danger: true },
          onOk: async () => {
              const config = buildRuntimeConfig(conn, conn.dbName);
              const res = await DropFunction(config as any, conn.dbName, routineName, routineType);
              if (res.success) {
                  message.success(`${typeLabel}删除成功`);
                  await loadTables(getDatabaseNodeRef(conn, conn.dbName));
              } else {
                  message.error("删除失败: " + res.message);
              }
          }
      });
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
    const conn = node.dataRef as SavedConnection;
    const isRedis = conn?.config?.type === 'redis';

    // 表分组节点的右键菜单
    if (node.type === 'object-group' && node.dataRef?.groupKey === 'tables') {
        const groupData = node.dataRef; // { ...conn, dbName, groupKey }
        const sortPreferenceKey = `${groupData.id}-${groupData.dbName}`;
        const currentSort = tableSortPreference[sortPreferenceKey] || 'name';

        return [
            {
                key: 'sort-by-name',
                label: '按名称排序',
                icon: currentSort === 'name' ? <CheckSquareOutlined /> : null,
                onClick: () => {
                    setTableSortPreference(groupData.id, groupData.dbName, 'name');
                    const dbNode = {
                        key: `${groupData.id}-${groupData.dbName}`,
                        dataRef: groupData
                    };
                    loadTables(dbNode);
                }
            },
            {
                key: 'sort-by-frequency',
                label: '按使用频率排序',
                icon: currentSort === 'frequency' ? <CheckSquareOutlined /> : null,
                onClick: () => {
                    setTableSortPreference(groupData.id, groupData.dbName, 'frequency');
                    const dbNode = {
                        key: `${groupData.id}-${groupData.dbName}`,
                        dataRef: groupData
                    };
                    loadTables(dbNode);
                }
            }
        ];
    }

    // 视图分组节点的右键菜单
    if (node.type === 'object-group' && node.dataRef?.groupKey === 'views') {
        return [
            {
                key: 'create-view',
                label: '新建视图',
                icon: <PlusOutlined />,
                onClick: () => openCreateView(node)
            },
        ];
    }

    // 函数分组节点的右键菜单
    if (node.type === 'object-group' && node.dataRef?.groupKey === 'routines') {
        return [
            {
                key: 'create-function',
                label: '新建函数',
                icon: <PlusOutlined />,
                onClick: () => openCreateRoutine(node, 'FUNCTION')
            },
            {
                key: 'create-procedure',
                label: '新建存储过程',
                icon: <PlusOutlined />,
                onClick: () => openCreateRoutine(node, 'PROCEDURE')
            },
        ];
    }

    if (node.type === 'connection') {
        // Redis connection menu
        if (isRedis) {
            return [
                {
                    key: 'refresh',
                    label: '刷新',
                    icon: <ReloadOutlined />,
                    onClick: () => loadDatabases(node)
                },
                { type: 'divider' },
                {
                    key: 'new-command',
                    label: '新建命令窗口',
                    icon: <ConsoleSqlOutlined />,
                    onClick: () => {
                        addTab({
                            id: `redis-cmd-${node.key}-${Date.now()}`,
                            title: `命令 - ${node.title}`,
                            type: 'redis-command',
                            connectionId: node.key,
                            redisDB: 0
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
                        setConnectionStates(prev => {
                            const next = { ...prev };
                            Object.keys(next).forEach(k => {
                                if (k === node.key || k.startsWith(`${node.key}-`)) {
                                    delete next[k];
                                }
                            });
                            return next;
                        });
                        setExpandedKeys(prev => prev.filter(k => k !== node.key && !k.toString().startsWith(`${node.key}-`)));
                        setLoadedKeys(prev => prev.filter(k => k !== node.key && !k.toString().startsWith(`${node.key}-`)));
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
        }

        // Regular database connection menu
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
                       dbName: undefined,
                       query: ''
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
    } else if (node.type === 'redis-db') {
        // Redis database menu
        const { id, redisDB } = node.dataRef;
        return [
            {
                key: 'open-keys',
                label: '浏览 Key',
                icon: <KeyOutlined />,
                onClick: () => {
                    addTab({
                        id: `redis-keys-${id}-db${redisDB}`,
                        title: `db${redisDB}`,
                        type: 'redis-keys',
                        connectionId: id,
                        redisDB: redisDB
                    });
                }
            },
            {
                key: 'new-command',
                label: '新建命令窗口',
                icon: <ConsoleSqlOutlined />,
                onClick: () => {
                    addTab({
                        id: `redis-cmd-${id}-db${redisDB}-${Date.now()}`,
                        title: `命令 - db${redisDB}`,
                        type: 'redis-command',
                        connectionId: id,
                        redisDB: redisDB
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
               key: 'rename-db',
               label: '重命名数据库',
               icon: <EditOutlined />,
               onClick: () => {
                   setRenameDbTarget(node);
                   renameDbForm.setFieldsValue({ newName: node.dataRef?.dbName || '' });
                   setIsRenameDbModalOpen(true);
               }
           },
           {
               key: 'drop-db',
               label: '删除数据库',
               icon: <DeleteOutlined />,
               danger: true,
               onClick: () => handleDeleteDatabase(node)
           },
           {
               key: 'refresh',
               label: '刷新',
               icon: <ReloadOutlined />,
               onClick: () => loadTables(node)
           },
           {
               key: 'export-db-schema',
               label: '导出全部表结构 (SQL)',
               icon: <ExportOutlined />,
               onClick: () => handleExportDatabaseSQL(node, false)
           },
           {
               key: 'backup-db-sql',
               label: '备份全部表 (结构+数据 SQL)',
               icon: <SaveOutlined />,
               onClick: () => handleExportDatabaseSQL(node, true)
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
                       dbName: node.title,
                       query: ''
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
    } else if (node.type === 'view') {
        return [
            {
                key: 'open-view',
                label: '浏览视图数据',
                icon: <EyeOutlined />,
                onClick: () => onDoubleClick(null, node)
            },
            {
                key: 'view-definition',
                label: '查看视图定义',
                icon: <CodeOutlined />,
                onClick: () => openViewDefinition(node)
            },
            { type: 'divider' },
            {
                key: 'edit-view',
                label: '编辑视图',
                icon: <EditOutlined />,
                onClick: () => openEditView(node)
            },
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
                        dbName: node.dataRef.dbName,
                        query: ''
                    });
                }
            },
            { type: 'divider' },
            {
                key: 'rename-view',
                label: '重命名视图',
                icon: <EditOutlined />,
                onClick: () => {
                    setRenameViewTarget(node);
                    renameViewForm.setFieldsValue({ newName: extractObjectName(node.dataRef?.viewName || node.title) });
                    setIsRenameViewModalOpen(true);
                }
            },
            {
                key: 'drop-view',
                label: '删除视图',
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => handleDropView(node)
            },
        ];
    } else if (node.type === 'routine') {
        const routineType = node.dataRef?.routineType || 'FUNCTION';
        const typeLabel = routineType === 'PROCEDURE' ? '存储过程' : '函数';
        return [
            {
                key: 'view-routine-def',
                label: '查看定义',
                icon: <CodeOutlined />,
                onClick: () => openRoutineDefinition(node)
            },
            {
                key: 'edit-routine',
                label: '编辑定义',
                icon: <EditOutlined />,
                onClick: () => openEditRoutine(node)
            },
            { type: 'divider' },
            {
                key: 'drop-routine',
                label: `删除${typeLabel}`,
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => handleDropRoutine(node)
            },
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
                       dbName: node.dataRef.dbName,
                       query: ''
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
                key: 'rename-table',
                label: '重命名表',
                icon: <EditOutlined />,
                onClick: () => {
                    setRenameTableTarget(node);
                    renameTableForm.setFieldsValue({ newName: extractObjectName(node.dataRef?.tableName || node.title) });
                    setIsRenameTableModalOpen(true);
                }
            },
            {
                key: 'drop-table',
                label: '删除表',
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => handleDeleteTable(node)
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

    const displayTitle = String(node.title ?? '');
    let hoverTitle = displayTitle;
    if (node.type === 'table' || node.type === 'view') {
        const rawTableName = String(node?.dataRef?.tableName || node?.dataRef?.viewName || '').trim();
        const conn = node?.dataRef as SavedConnection | undefined;
        if (rawTableName && shouldHideSchemaPrefix(conn)) {
            const lastDotIndex = rawTableName.lastIndexOf('.');
            if (lastDotIndex > 0 && lastDotIndex < rawTableName.length - 1) {
                hoverTitle = rawTableName;
            }
        }
    }

    return <span title={hoverTitle}>{statusBadge}{displayTitle}</span>;
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

        {/* Toolbar for batch operations - always visible */}
        <div style={{ padding: '4px 8px', borderBottom: 'none', display: 'flex', gap: 4 }}>
            <Button
                size="small"
                icon={<CheckSquareOutlined />}
                onClick={() => openBatchOperationModal()}
                style={{ flex: 1 }}
            >
                批量操作表
            </Button>
            <Button
                size="small"
                icon={<CheckSquareOutlined />}
                onClick={() => openBatchDatabaseModal()}
                style={{ flex: 1 }}
            >
                批量操作库
            </Button>
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
                selectedKeys={selectedKeys}
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

        <Modal
            title={`重命名数据库${renameDbTarget?.dataRef?.dbName ? ` (${renameDbTarget.dataRef.dbName})` : ''}`}
            open={isRenameDbModalOpen}
            onOk={handleRenameDatabase}
            onCancel={() => {
                setIsRenameDbModalOpen(false);
                setRenameDbTarget(null);
                renameDbForm.resetFields();
            }}
        >
            <Form form={renameDbForm} layout="vertical">
                <Form.Item name="newName" label="新数据库名称" rules={[{ required: true, message: '请输入新数据库名称' }]}>
                    <Input />
                </Form.Item>
            </Form>
        </Modal>

        <Modal
            title={`重命名表${renameTableTarget?.dataRef?.tableName ? ` (${renameTableTarget.dataRef.tableName})` : ''}`}
            open={isRenameTableModalOpen}
            onOk={handleRenameTable}
            onCancel={() => {
                setIsRenameTableModalOpen(false);
                setRenameTableTarget(null);
                renameTableForm.resetFields();
            }}
        >
            <Form form={renameTableForm} layout="vertical">
                <Form.Item name="newName" label="新表名" rules={[{ required: true, message: '请输入新表名' }]}>
                    <Input />
                </Form.Item>
            </Form>
        </Modal>

        <Modal
            title={`重命名视图${renameViewTarget?.dataRef?.viewName ? ` (${renameViewTarget.dataRef.viewName})` : ''}`}
            open={isRenameViewModalOpen}
            onOk={handleRenameView}
            onCancel={() => {
                setIsRenameViewModalOpen(false);
                setRenameViewTarget(null);
                renameViewForm.resetFields();
            }}
        >
            <Form form={renameViewForm} layout="vertical">
                <Form.Item name="newName" label="新视图名" rules={[{ required: true, message: '请输入新视图名' }]}>
                    <Input />
                </Form.Item>
            </Form>
        </Modal>

        <Modal
            title="批量操作表"
            open={isBatchModalOpen}
            onCancel={() => setIsBatchModalOpen(false)}
            width={680}
            footer={
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Button key="cancel" onClick={() => setIsBatchModalOpen(false)}>
                        取消
                    </Button>
                    <Space size={8} wrap style={{ marginLeft: 'auto' }}>
                        <Button
                            key="export-schema"
                            icon={<ExportOutlined />}
                            onClick={() => handleBatchExport('schema')}
                            disabled={checkedTableKeys.length === 0}
                        >
                            导出结构
                        </Button>
                        <Button
                            key="export-data-only"
                            icon={<SaveOutlined />}
                            onClick={() => handleBatchExport('dataOnly')}
                            disabled={checkedTableKeys.length === 0}
                        >
                            仅数据(INSERT)
                        </Button>
                        <Button
                            key="backup"
                            type="primary"
                            icon={<SaveOutlined />}
                            onClick={() => handleBatchExport('backup')}
                            disabled={checkedTableKeys.length === 0}
                        >
                            备份(结构+数据)
                        </Button>
                    </Space>
                </div>
            }
        >
            <div style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 8 }}>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>选择连接：</label>
                    <Select
                        value={selectedConnection}
                        onChange={handleConnectionChange}
                        style={{ width: '100%' }}
                        placeholder="请选择连接"
                    >
                        {connections.filter(c => c.config.type !== 'redis').map(conn => (
                            <Select.Option key={conn.id} value={conn.id}>
                                {conn.name}
                            </Select.Option>
                        ))}
                    </Select>
                </div>
                <div style={{ marginBottom: 8 }}>
                    <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>选择数据库：</label>
                    <Select
                        value={selectedDatabase}
                        onChange={handleDatabaseChange}
                        style={{ width: '100%' }}
                        placeholder="请先选择连接"
                        disabled={!selectedConnection}
                    >
                        {availableDatabases.map(db => (
                            <Select.Option key={db.key} value={db.dbName}>
                                {db.title}
                            </Select.Option>
                        ))}
                    </Select>
                </div>
            </div>

            {batchTables.length > 0 && (
                <>
                    <div style={{ marginBottom: 16 }}>
                        <Space>
                            <Button
                                size="small"
                                onClick={() => handleCheckAll(true)}
                            >
                                全选
                            </Button>
                            <Button
                                size="small"
                                onClick={() => handleCheckAll(false)}
                            >
                                取消全选
                            </Button>
                            <Button
                                size="small"
                                onClick={handleInvertSelection}
                            >
                                反选
                            </Button>
                            <span style={{ color: '#999' }}>
                                已选择 {checkedTableKeys.length} / {batchTables.length} 张表
                            </span>
                        </Space>
                    </div>
                    <div style={{ maxHeight: 400, overflow: 'auto', border: darkMode ? '1px solid #303030' : '1px solid #f0f0f0', borderRadius: 4, padding: 8 }}>
                        <Checkbox.Group
                            value={checkedTableKeys}
                            onChange={(values) => setCheckedTableKeys(values as string[])}
                            style={{ width: '100%' }}
                        >
                            <Space direction="vertical" style={{ width: '100%' }}>
                                {batchTables.map(table => (
                                    <Checkbox key={table.key} value={table.key}>
                                        <TableOutlined style={{ marginRight: 8 }} />
                                        {table.title}
                                    </Checkbox>
                                ))}
                            </Space>
                        </Checkbox.Group>
                    </div>
                </>
            )}
        </Modal>

        <Modal
            title="批量操作库"
            open={isBatchDbModalOpen}
            onCancel={() => setIsBatchDbModalOpen(false)}
            width={600}
            footer={[
                <Button key="cancel" onClick={() => setIsBatchDbModalOpen(false)}>
                    取消
                </Button>,
                <Button
                    key="export-schema"
                    icon={<ExportOutlined />}
                    onClick={() => handleBatchDbExport(false)}
                    disabled={checkedDbKeys.length === 0}
                >
                    导出库结构 ({checkedDbKeys.length})
                </Button>,
                <Button
                    key="backup"
                    type="primary"
                    icon={<SaveOutlined />}
                    onClick={() => handleBatchDbExport(true)}
                    disabled={checkedDbKeys.length === 0}
                >
                    备份库 ({checkedDbKeys.length})
                </Button>
            ]}
        >
            <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>选择连接：</label>
                <Select
                    value={selectedDbConnection}
                    onChange={handleDbConnectionChange}
                    style={{ width: '100%' }}
                    placeholder="请选择连接"
                >
                    {connections.filter(c => c.config.type !== 'redis').map(conn => (
                        <Select.Option key={conn.id} value={conn.id}>
                            {conn.name}
                        </Select.Option>
                    ))}
                </Select>
            </div>

            {batchDatabases.length > 0 && (
                <>
                    <div style={{ marginBottom: 16 }}>
                        <Space>
                            <Button
                                size="small"
                                onClick={() => handleCheckAllDb(true)}
                            >
                                全选
                            </Button>
                            <Button
                                size="small"
                                onClick={() => handleCheckAllDb(false)}
                            >
                                取消全选
                            </Button>
                            <Button
                                size="small"
                                onClick={handleInvertSelectionDb}
                            >
                                反选
                            </Button>
                            <span style={{ color: '#999' }}>
                                已选择 {checkedDbKeys.length} / {batchDatabases.length} 个库
                            </span>
                        </Space>
                    </div>
                    <div style={{ maxHeight: 400, overflow: 'auto', border: darkMode ? '1px solid #303030' : '1px solid #f0f0f0', borderRadius: 4, padding: 8 }}>
                        <Checkbox.Group
                            value={checkedDbKeys}
                            onChange={(values) => setCheckedDbKeys(values as string[])}
                            style={{ width: '100%' }}
                        >
                            <Space direction="vertical" style={{ width: '100%' }}>
                                {batchDatabases.map(db => (
                                    <Checkbox key={db.key} value={db.key}>
                                        <DatabaseOutlined style={{ marginRight: 8 }} />
                                        {db.title}
                                    </Checkbox>
                                ))}
                            </Space>
                        </Checkbox.Group>
                    </div>
                </>
            )}
        </Modal>
    </div>
  );
};

export default Sidebar;
