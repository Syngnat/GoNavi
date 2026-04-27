import React, { useEffect, useState, useMemo, useRef } from 'react';
import { Tree, message, Dropdown, MenuProps, Input, Button, Modal, Form, Badge, Checkbox, Space, Select, Popover, Tooltip, Progress } from 'antd';
	import {
	  DatabaseOutlined,
	  TableOutlined,
	  EyeOutlined,
	  ConsoleSqlOutlined,
  HddOutlined,
  FolderOutlined,
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
  CodeOutlined,
  TagOutlined,
  CheckOutlined,
  FilterOutlined,
  DashboardOutlined,
  WarningOutlined
	} from '@ant-design/icons';
import { useStore } from '../store';
import { buildOverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
	import { SavedConnection, ExternalSQLTreeEntry, JVMCapability, JVMResourceSummary } from '../types';
import { getDbIcon } from './DatabaseIcons';
	import { DBGetDatabases, DBGetTables, DBQuery, DBShowCreateTable, ExportTable, OpenSQLFile, ExecuteSQLFile, CancelSQLFileExecution, CreateDatabase, RenameDatabase, DropDatabase, RenameTable, DropTable, DropView, DropFunction, RenameView, SelectSQLDirectory, ListSQLDirectory, ReadSQLFile, JVMProbeCapabilities } from '../../wailsjs/go/app/App';
import { getTableDataDangerActionMeta, supportsTableTruncateAction, type TableDataDangerActionKind } from './tableDataDangerActions';
  import { EventsOn } from '../../wailsjs/runtime/runtime';
  import { isMacLikePlatform, normalizeOpacityForPlatform, resolveAppearanceValues } from '../utils/appearance';
import { useAutoFetchVisibility } from '../utils/autoFetchVisibility';
import FindInDatabaseModal from './FindInDatabaseModal';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { noAutoCapInputProps } from '../utils/inputAutoCap';
import { normalizeSidebarViewName, resolveSidebarRuntimeDatabase } from '../utils/sidebarMetadata';
import { resolveConnectionHostTokens } from '../utils/tabDisplay';
import { resolveConnectionAccentColor, resolveConnectionIconType } from '../utils/connectionVisual';
import { buildJVMTabTitle } from '../utils/jvmRuntimePresentation';
import { buildJVMDiagnosticActionDescriptor, buildJVMMonitoringActionDescriptors } from '../utils/jvmSidebarActions';
import { buildTableSelectQuery } from '../utils/objectQueryTemplates';
import { buildExternalSQLDirectoryId, buildExternalSQLRootNode, buildExternalSQLTabId, type ExternalSQLTreeNode } from '../utils/externalSqlTree';
import JVMModeBadge from './jvm/JVMModeBadge';

const { Search } = Input;

interface TreeNode {
  title: string;
  key: string;
  isLeaf?: boolean;
  children?: TreeNode[];
  icon?: React.ReactNode;
  dataRef?: any;
  type?: 'connection' | 'database' | 'table' | 'view' | 'db-trigger' | 'routine' | 'object-group' | 'queries-folder' | 'saved-query' | 'external-sql-root' | 'external-sql-directory' | 'external-sql-folder' | 'external-sql-file' | 'folder-columns' | 'folder-indexes' | 'folder-fks' | 'folder-triggers' | 'redis-db' | 'tag' | 'jvm-mode' | 'jvm-resource' | 'jvm-diagnostic' | 'jvm-monitoring';
}

type BatchTableExportMode = 'schema' | 'backup' | 'dataOnly';
type BatchObjectType = 'table' | 'view';
type BatchObjectFilterType = 'all' | BatchObjectType;
type BatchSelectionScope = 'filtered' | 'all';
type SearchScope = 'smart' | 'object' | 'database' | 'host' | 'tag';

interface BatchObjectItem {
  title: string;
  key: string;
  objectName: string;
  objectType: BatchObjectType;
  dataRef: any;
}

const SEARCH_SCOPE_OPTIONS: Array<{ value: SearchScope; label: string }> = [
  { value: 'smart', label: '智能' },
  { value: 'object', label: '表对象' },
  { value: 'database', label: '库' },
  { value: 'host', label: 'Host' },
  { value: 'tag', label: '标签' },
];

const SEARCH_SCOPE_LABEL_MAP: Record<SearchScope, string> = SEARCH_SCOPE_OPTIONS.reduce((acc, option) => {
  acc[option.value] = option.label;
  return acc;
}, {} as Record<SearchScope, string>);


const SEARCH_SCOPE_ICON_MAP: Record<SearchScope, React.ReactNode> = {
  smart: <ThunderboltOutlined />,
  object: <TableOutlined />,
  database: <DatabaseOutlined />,
  host: <CloudOutlined />,
  tag: <TagOutlined />,
};

const normalizeMySQLViewDDLForEditing = (viewName: string, rawDefinition: unknown): string => {
  const text = String(rawDefinition || '').trim();
  if (!text) return '';

  const normalized = text.replace(/\r\n/g, '\n').trim().replace(/;+\s*$/, '');
  const createViewPrefixPattern = /^\s*create\s+(?:algorithm\s*=\s*\w+\s+)?(?:definer\s*=\s*(?:`[^`]+`|\S+)\s*@\s*(?:`[^`]+`|\S+)\s+)?(?:sql\s+security\s+(?:definer|invoker)\s+)?view\s+/i;
  if (createViewPrefixPattern.test(normalized)) {
    return `${normalized.replace(createViewPrefixPattern, 'CREATE OR REPLACE VIEW ')};`;
  }

  if (/^\s*(select|with)\b/i.test(normalized)) {
    return `CREATE OR REPLACE VIEW ${viewName} AS\n${normalized};`;
  }

  return `${normalized};`;
};

const Sidebar: React.FC<{ onEditConnection?: (conn: SavedConnection) => void }> = ({ onEditConnection }) => {
  const connections = useStore(state => state.connections);
  const savedQueries = useStore(state => state.savedQueries);
  const externalSQLDirectories = useStore(state => state.externalSQLDirectories);
  const deleteQuery = useStore(state => state.deleteQuery);
  const saveExternalSQLDirectory = useStore(state => state.saveExternalSQLDirectory);
  const deleteExternalSQLDirectory = useStore(state => state.deleteExternalSQLDirectory);
  const addConnection = useStore(state => state.addConnection);
  const addTab = useStore(state => state.addTab);
  const setActiveContext = useStore(state => state.setActiveContext);
  const removeConnection = useStore(state => state.removeConnection);
  const connectionTags = useStore(state => state.connectionTags);
  const addConnectionTag = useStore(state => state.addConnectionTag);
  const updateConnectionTag = useStore(state => state.updateConnectionTag);
  const removeConnectionTag = useStore(state => state.removeConnectionTag);
  const moveConnectionToTag = useStore(state => state.moveConnectionToTag);
  const reorderTags = useStore(state => state.reorderTags);
  const closeTabsByConnection = useStore(state => state.closeTabsByConnection);
  const closeTabsByDatabase = useStore(state => state.closeTabsByDatabase);
  const theme = useStore(state => state.theme);
  const appearance = useStore(state => state.appearance);
  const tableAccessCount = useStore(state => state.tableAccessCount);
  const tableSortPreference = useStore(state => state.tableSortPreference);
  const recordTableAccess = useStore(state => state.recordTableAccess);
  const setTableSortPreference = useStore(state => state.setTableSortPreference);
  const addSqlLog = useStore(state => state.addSqlLog);
  const darkMode = theme === 'dark';
  const resolvedAppearance = resolveAppearanceValues(appearance);
  const opacity = normalizeOpacityForPlatform(resolvedAppearance.opacity);
  const disableLocalBackdropFilter = isMacLikePlatform();
  const autoFetchVisible = useAutoFetchVisibility();
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
  const overlayTheme = useMemo(
      () => buildOverlayWorkbenchTheme(darkMode, { disableBackdropFilter: disableLocalBackdropFilter }),
      [darkMode, disableLocalBackdropFilter],
  );
  const modalPanelStyle = useMemo(() => ({
      background: overlayTheme.shellBg,
      border: overlayTheme.shellBorder,
      boxShadow: overlayTheme.shellShadow,
      backdropFilter: overlayTheme.shellBackdropFilter,
  }), [overlayTheme]);
  const modalSectionStyle = useMemo(() => ({
      padding: 14,
      borderRadius: 14,
      border: overlayTheme.sectionBorder,
      background: overlayTheme.sectionBg,
  }), [overlayTheme]);
  const modalScrollSectionStyle = useMemo(() => ({
      maxHeight: 400,
      overflow: 'auto' as const,
      border: overlayTheme.sectionBorder,
      borderRadius: 14,
      padding: 12,
      background: overlayTheme.sectionBg,
  }), [overlayTheme]);
  const modalHintTextStyle = useMemo(() => ({
      color: overlayTheme.mutedText,
      fontSize: 12,
      lineHeight: 1.6,
  }), [overlayTheme]);
  const renderSidebarModalTitle = (icon: React.ReactNode, title: string, description: string) => (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
          <div style={{ width: 34, height: 34, borderRadius: 12, display: 'grid', placeItems: 'center', background: overlayTheme.iconBg, color: overlayTheme.iconColor, flexShrink: 0 }}>
              {icon}
          </div>
          <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: overlayTheme.titleText }}>{title}</div>
              <div style={{ marginTop: 4, color: overlayTheme.mutedText, fontSize: 12, lineHeight: 1.6 }}>{description}</div>
          </div>
      </div>
  );
  const [searchValue, setSearchValue] = useState('');
  const [searchScopes, setSearchScopes] = useState<SearchScope[]>(['smart']);
  const [isSearchScopePopoverOpen, setIsSearchScopePopoverOpen] = useState(false);
  const searchInputRef = useRef<any>(null);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [autoExpandParent, setAutoExpandParent] = useState(true);
  const [loadedKeys, setLoadedKeys] = useState<React.Key[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const selectedNodesRef = useRef<any[]>([]);
  const loadingNodesRef = useRef<Set<string>>(new Set());
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(() => {
      const handleFocusSidebarSearch = () => {
          const inputEl = searchInputRef.current?.input as HTMLInputElement | undefined;
          if (!inputEl) {
              return;
          }
          inputEl.focus();
          inputEl.select();
      };
      window.addEventListener('gonavi:focus-sidebar-search', handleFocusSidebarSearch as EventListener);
      return () => {
          window.removeEventListener('gonavi:focus-sidebar-search', handleFocusSidebarSearch as EventListener);
      };
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

  // Connection Tag Modals
  const [isCreateTagModalOpen, setIsCreateTagModalOpen] = useState(false);
  const [createTagForm] = Form.useForm();

  // Batch Operations Modal
  const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);
  const [batchTables, setBatchTables] = useState<BatchObjectItem[]>([]);
  const [checkedTableKeys, setCheckedTableKeys] = useState<string[]>([]);
  const [batchDbContext, setBatchDbContext] = useState<any>(null);
  const [selectedConnection, setSelectedConnection] = useState<string>('');
  const [selectedDatabase, setSelectedDatabase] = useState<string>('');
  const [availableDatabases, setAvailableDatabases] = useState<any[]>([]);
  const [batchFilterKeyword, setBatchFilterKeyword] = useState<string>('');
  const [batchFilterType, setBatchFilterType] = useState<BatchObjectFilterType>('all');
  const [batchSelectionScope, setBatchSelectionScope] = useState<BatchSelectionScope>('filtered');
  const filteredBatchObjects = useMemo(() => {
      const keyword = batchFilterKeyword.trim().toLowerCase();
      return batchTables.filter((item) => {
          if (batchFilterType !== 'all' && item.objectType !== batchFilterType) {
              return false;
          }
          if (!keyword) {
              return true;
          }
          return item.title.toLowerCase().includes(keyword) || item.objectName.toLowerCase().includes(keyword);
      });
  }, [batchFilterKeyword, batchFilterType, batchTables]);
  const groupedBatchObjects = useMemo(() => {
      const tables = filteredBatchObjects.filter(item => item.objectType === 'table');
      const views = filteredBatchObjects.filter(item => item.objectType === 'view');
      return { tables, views };
  }, [filteredBatchObjects]);
  const allBatchObjectKeys = useMemo(() => batchTables.map(item => item.key), [batchTables]);
  const allBatchObjectKeysByType = useMemo(() => {
      if (batchFilterType === 'all') {
          return allBatchObjectKeys;
      }
      return batchTables
          .filter((item) => item.objectType === batchFilterType)
          .map((item) => item.key);
  }, [allBatchObjectKeys, batchFilterType, batchTables]);
  const filteredBatchObjectKeys = useMemo(() => filteredBatchObjects.map(item => item.key), [filteredBatchObjects]);
  const selectionScopeTargetKeys = useMemo(
      () => (batchSelectionScope === 'filtered' ? filteredBatchObjectKeys : allBatchObjectKeysByType),
      [allBatchObjectKeysByType, batchSelectionScope, filteredBatchObjectKeys]
  );
  const selectedBatchObjects = useMemo(
      () => batchTables.filter((item) => checkedTableKeys.includes(item.key)),
      [batchTables, checkedTableKeys]
  );
  const selectedBatchTableNames = useMemo(
      () => selectedBatchObjects.filter((item) => item.objectType === 'table').map((item) => item.objectName),
      [selectedBatchObjects]
  );
  const selectedBatchViewCount = useMemo(
      () => selectedBatchObjects.filter((item) => item.objectType === 'view').length,
      [selectedBatchObjects]
  );
  useEffect(() => {
      if (batchFilterType === 'all') {
          return;
      }
      const allowed = new Set(allBatchObjectKeysByType);
      setCheckedTableKeys((prev) => prev.filter((key) => allowed.has(key)));
  }, [allBatchObjectKeysByType, batchFilterType]);

  // Batch Database Operations Modal
  const [isBatchDbModalOpen, setIsBatchDbModalOpen] = useState(false);
  const [batchDatabases, setBatchDatabases] = useState<any[]>([]);
  const [checkedDbKeys, setCheckedDbKeys] = useState<string[]>([]);
  const [batchConnContext, setBatchConnContext] = useState<any>(null);
  const [selectedDbConnection, setSelectedDbConnection] = useState<string>('');

  // Find in Database Modal
  const [findInDbContext, setFindInDbContext] = useState<{ open: boolean; connectionId: string; dbName: string }>({ open: false, connectionId: '', dbName: '' });

  useEffect(() => {
      if (!autoFetchVisible) {
          return;
      }

      expandedKeys.forEach(key => {
          const node = findTreeNodeByKey(treeData, key);
          if (node && node.type === 'database') {
              loadTables(node);
          }
      });
  }, [autoFetchVisible, externalSQLDirectories, savedQueries]);

  useEffect(() => {
    setTreeData((prev) => {
      const prevMap = new Map<string, TreeNode>();

      // We need to recursively extract connections from old tag structures
      // so if a user expands a connection that was tagged, the state remains
      const recurseCollect = (nodes: TreeNode[]) => {
          nodes.forEach((node) => {
            if (node.type === 'tag') {
               if (node.children) recurseCollect(node.children);
            } else if (node.type === 'connection') {
               prevMap.set(String(node.key), node);
            }
          });
      };
      recurseCollect(prev);

      const buildConnectionNode = (conn: SavedConnection): TreeNode => {
        const existing = prevMap.get(conn.id);
        const iconType = resolveConnectionIconType(conn);
        const iconColor = resolveConnectionAccentColor(conn);
        return {
          title: conn.name,
          key: conn.id,
          icon: getDbIcon(iconType, iconColor, 22),
          type: 'connection',
          dataRef: conn,
          isLeaf: false,
          children: existing?.children,
        } as TreeNode;
      };

      const taggedConnIds = new Set<string>();
      const tagNodes: TreeNode[] = connectionTags.map((tag) => {
        tag.connectionIds.forEach(id => taggedConnIds.add(id));
        return {
          title: tag.name,
          key: `tag-${tag.id}`,
          icon: <FolderOutlined style={{ color: '#faad14' }} />,
          type: 'tag',
          dataRef: tag,
          isLeaf: false,
          children: tag.connectionIds
            .map(cid => connections.find(c => c.id === cid))
            .filter(Boolean)
            .map(conn => buildConnectionNode(conn!)),
        } as TreeNode;
      });

      const ungroupedNodes: TreeNode[] = connections
        .filter(c => !taggedConnIds.has(c.id))
        .map(conn => buildConnectionNode(conn));

      return [...tagNodes, ...ungroupedNodes];
    });
  }, [connections, connectionTags]);

  const handleDuplicateConnection = async (conn: SavedConnection) => {
    if (!conn?.id) return;

    const backendApp = (window as any).go?.app?.App;
    if (typeof backendApp?.DuplicateConnection !== 'function') {
      message.error('复制连接失败：后端接口不可用');
      return;
    }

    try {
      const duplicatedConnection = await backendApp.DuplicateConnection(conn.id);
      if (!duplicatedConnection) {
        throw new Error('复制连接失败：后端未返回结果');
      }
      addConnection(duplicatedConnection);
      message.success(`已复制连接: ${duplicatedConnection.name}`);
    } catch (error: any) {
      message.error(error?.message || '复制连接失败');
    }
  };
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

  const findTreeNodeByKey = (nodes: TreeNode[], targetKey: React.Key): TreeNode | null => {
    for (const node of nodes) {
      if (node.key === targetKey) {
        return node;
      }
      if (node.children) {
        const child = findTreeNodeByKey(node.children, targetKey);
        if (child) {
          return child;
        }
      }
    }
    return null;
  };

  const decorateExternalSQLTreeNode = (node: ExternalSQLTreeNode): TreeNode => {
    const icon = (() => {
      switch (node.type) {
        case 'external-sql-root':
          return <FolderOpenOutlined />;
        case 'external-sql-directory':
          return <HddOutlined />;
        case 'external-sql-folder':
          return <FolderOutlined />;
        default:
          return <FileTextOutlined />;
      }
    })();

    return {
      ...node,
      icon,
      children: node.children?.map((child) => decorateExternalSQLTreeNode(child)),
    };
  };

  const getNodeDatabaseContext = (node: any): { connectionId: string; dbName: string; dbNodeKey: string } | null => {
    if (!node) return null;
    if (node.type === 'database') {
      return {
        connectionId: String(node?.dataRef?.id || '').trim(),
        dbName: String(node?.dataRef?.dbName || '').trim(),
        dbNodeKey: String(node.key || '').trim(),
      };
    }

    if (
      node.type === 'external-sql-root'
      || node.type === 'external-sql-directory'
      || node.type === 'external-sql-folder'
      || node.type === 'external-sql-file'
    ) {
      return {
        connectionId: String(node?.dataRef?.connectionId || '').trim(),
        dbName: String(node?.dataRef?.dbName || '').trim(),
        dbNodeKey: String(node?.dataRef?.dbNodeKey || '').trim(),
      };
    }

    return null;
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

      const customDriver = String(conn?.config?.driver || '').trim().toLowerCase();
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
          const driver = String(conn?.config?.driver || '').trim().toLowerCase();
          if (driver === 'diros' || driver === 'doris') return 'mysql';
          return driver;
      }
      if (type === 'mariadb' || type === 'diros' || type === 'sphinx') return 'mysql';
      if (type === 'dameng') return 'dm';
      return type;
  };

  const escapeSQLLiteral = (raw: string): string => String(raw || '').replace(/'/g, "''");
  const quoteSqlServerIdentifier = (raw: string): string => `[${String(raw || '').replace(/]/g, ']]')}]`;

  type MetadataQuerySpec = {
      sql: string;
      inferredType?: 'FUNCTION' | 'PROCEDURE';
  };

  type MetadataQueryResult = {
      rows: Record<string, any>[];
      inferredType?: 'FUNCTION' | 'PROCEDURE';
  };

  const isSphinxConnection = (conn: SavedConnection | undefined): boolean => {
      const type = String(conn?.config?.type || '').trim().toLowerCase();
      if (type === 'sphinx') return true;
      if (type !== 'custom') return false;
      const driver = String(conn?.config?.driver || '').trim().toLowerCase();
      return driver === 'sphinx' || driver === 'sphinxql';
  };

  const normalizeMetadataQuerySpecs = (specs: MetadataQuerySpec[]): MetadataQuerySpec[] => {
      const seen = new Set<string>();
      const normalized: MetadataQuerySpec[] = [];
      specs.forEach((spec) => {
          const sql = String(spec.sql || '').trim();
          if (!sql) return;
          const key = `${spec.inferredType || ''}@@${sql}`;
          if (seen.has(key)) return;
          seen.add(key);
          normalized.push({ sql, inferredType: spec.inferredType });
      });
      return normalized;
  };

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

  const getCaseInsensitiveRawValue = (row: Record<string, any>, candidateKeys: string[]): any => {
      const keyMap = new Map<string, any>();
      Object.keys(row || {}).forEach((key) => keyMap.set(key.toLowerCase(), row[key]));
      for (const key of candidateKeys) {
          const value = keyMap.get(key.toLowerCase());
          if (value !== undefined && value !== null) {
              return value;
          }
      }
      return undefined;
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

  const getMySQLShowTablesName = (row: Record<string, any>): string => {
      for (const key of Object.keys(row || {})) {
          if (!key.toLowerCase().startsWith('tables_in_')) continue;
          const value = row[key];
          if (value === undefined || value === null) continue;
          const normalized = String(value).trim();
          if (normalized !== '') return normalized;
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

  const parseDuckDBParameterNames = (raw: any): string[] => {
      if (Array.isArray(raw)) {
          return raw
              .map((item) => String(item ?? '').trim())
              .filter((item) => item !== '' && item.toLowerCase() !== '<nil>');
      }

      const text = String(raw ?? '').trim();
      if (!text) return [];
      const normalized = text.startsWith('[') && text.endsWith(']')
          ? text.slice(1, -1)
          : text;
      return normalized
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== '' && part.toLowerCase() !== '<nil>');
  };

  const buildDuckDBMacroDDL = (
      schemaName: string,
      functionName: string,
      parametersRaw: any,
      macroDefinitionRaw: any
  ): string => {
      const schema = String(schemaName || '').trim();
      const name = String(functionName || '').trim();
      const macroDefinition = String(macroDefinitionRaw || '').trim();
      if (!name || !macroDefinition) return '';

      const parameters = parseDuckDBParameterNames(parametersRaw).join(', ');
      const qualifiedName = schema ? `${schema}.${name}` : name;
      const isTableMacro = !macroDefinition.startsWith('(');
      if (isTableMacro) {
          return `CREATE OR REPLACE MACRO ${qualifiedName}(${parameters}) AS TABLE ${macroDefinition};`;
      }
      return `CREATE OR REPLACE MACRO ${qualifiedName}(${parameters}) AS ${macroDefinition};`;
  };

  const buildViewsMetadataQuerySpecs = (dialect: string, dbName: string): MetadataQuerySpec[] => {
      const safeDbName = escapeSQLLiteral(dbName);
      switch (dialect) {
          case 'mysql': {
              const dbIdent = String(dbName || '').replace(/`/g, '``').trim();
              return normalizeMetadataQuerySpecs([
                  {
                      sql: safeDbName
                          ? `SELECT TABLE_NAME AS view_name, TABLE_SCHEMA AS schema_name FROM information_schema.views WHERE table_schema = '${safeDbName}' ORDER BY TABLE_NAME`
                          : '',
                  },
                  { sql: dbIdent ? `SHOW FULL TABLES FROM \`${dbIdent}\`` : '' },
                  { sql: `SHOW FULL TABLES` },
              ]);
          }
          case 'postgres':
          case 'kingbase':
          case 'highgo':
          case 'vastbase':
              return [{ sql: `SELECT schemaname AS schema_name, viewname AS view_name FROM pg_catalog.pg_views WHERE schemaname != 'information_schema' AND schemaname NOT LIKE 'pg_%' ORDER BY schemaname, viewname` }];
          case 'sqlserver': {
              const safeDb = quoteSqlServerIdentifier(dbName || 'master');
              return [{ sql: `SELECT s.name AS schema_name, v.name AS view_name FROM ${safeDb}.sys.views v JOIN ${safeDb}.sys.schemas s ON v.schema_id = s.schema_id ORDER BY s.name, v.name` }];
          }
          case 'oracle':
          case 'dm':
              return normalizeMetadataQuerySpecs([
                  { sql: `SELECT VIEW_NAME AS view_name FROM USER_VIEWS ORDER BY VIEW_NAME` },
                  { sql: `SELECT OWNER AS schema_name, VIEW_NAME AS view_name FROM ALL_VIEWS WHERE OWNER = USER ORDER BY VIEW_NAME` },
                  {
                      sql: safeDbName
                          ? `SELECT OWNER AS schema_name, VIEW_NAME AS view_name FROM ALL_VIEWS WHERE OWNER = '${safeDbName.toUpperCase()}' ORDER BY VIEW_NAME`
                          : '',
                  },
              ]);
          case 'sqlite':
              return [{ sql: `SELECT name AS view_name FROM sqlite_master WHERE type = 'view' ORDER BY name` }];
          case 'duckdb':
              return [{ sql: `SELECT table_schema AS schema_name, table_name AS view_name FROM information_schema.views WHERE table_schema NOT IN ('information_schema', 'pg_catalog') ORDER BY table_schema, table_name` }];
          default:
              return [];
      }
  };

  const buildTriggersMetadataQuerySpecs = (dialect: string, dbName: string): MetadataQuerySpec[] => {
      const safeDbName = escapeSQLLiteral(dbName);
      switch (dialect) {
          case 'mysql': {
              const dbIdent = String(dbName || '').replace(/`/g, '``').trim();
              return normalizeMetadataQuerySpecs([
                  {
                      sql: safeDbName
                          ? `SELECT TRIGGER_NAME AS trigger_name, EVENT_OBJECT_TABLE AS table_name, TRIGGER_SCHEMA AS schema_name FROM information_schema.triggers WHERE trigger_schema = '${safeDbName}' ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME`
                          : '',
                  },
                  { sql: dbIdent ? `SHOW TRIGGERS FROM \`${dbIdent}\`` : '' },
                  { sql: `SHOW TRIGGERS` },
              ]);
          }
          case 'postgres':
          case 'kingbase':
          case 'highgo':
          case 'vastbase':
              return [{ sql: `SELECT DISTINCT event_object_schema AS schema_name, event_object_table AS table_name, trigger_name FROM information_schema.triggers WHERE trigger_schema NOT IN ('pg_catalog', 'information_schema') AND trigger_schema NOT LIKE 'pg_%' ORDER BY event_object_schema, event_object_table, trigger_name` }];
          case 'sqlserver': {
              const safeDb = quoteSqlServerIdentifier(dbName || 'master');
              return [{ sql: `SELECT s.name AS schema_name, t.name AS table_name, tr.name AS trigger_name FROM ${safeDb}.sys.triggers tr JOIN ${safeDb}.sys.tables t ON tr.parent_id = t.object_id JOIN ${safeDb}.sys.schemas s ON t.schema_id = s.schema_id WHERE tr.parent_class = 1 ORDER BY s.name, t.name, tr.name` }];
          }
          case 'oracle':
          case 'dm':
              if (!safeDbName) {
                  return [{ sql: `SELECT TRIGGER_NAME AS trigger_name, TABLE_NAME AS table_name FROM USER_TRIGGERS ORDER BY TABLE_NAME, TRIGGER_NAME` }];
              }
              return [{ sql: `SELECT OWNER AS schema_name, TABLE_NAME AS table_name, TRIGGER_NAME AS trigger_name FROM ALL_TRIGGERS WHERE OWNER = '${safeDbName.toUpperCase()}' ORDER BY TABLE_NAME, TRIGGER_NAME` }];
          case 'sqlite':
              return [{ sql: `SELECT name AS trigger_name, tbl_name AS table_name FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, name` }];
          case 'duckdb':
              return [];
          default:
              return [];
      }
  };

  const buildFunctionsMetadataQuerySpecs = (dialect: string, dbName: string): MetadataQuerySpec[] => {
      const safeDbName = escapeSQLLiteral(dbName);
      switch (dialect) {
          case 'mysql':
              return normalizeMetadataQuerySpecs([
                  {
                      sql: safeDbName
                          ? `SELECT ROUTINE_NAME AS routine_name, ROUTINE_TYPE AS routine_type, ROUTINE_SCHEMA AS schema_name FROM information_schema.routines WHERE routine_schema = '${safeDbName}' ORDER BY ROUTINE_TYPE, ROUTINE_NAME`
                          : '',
                  },
                  {
                      sql: safeDbName
                          ? `SHOW FUNCTION STATUS WHERE Db = '${safeDbName}'`
                          : `SHOW FUNCTION STATUS`,
                      inferredType: 'FUNCTION',
                  },
                  {
                      sql: safeDbName
                          ? `SHOW PROCEDURE STATUS WHERE Db = '${safeDbName}'`
                          : `SHOW PROCEDURE STATUS`,
                      inferredType: 'PROCEDURE',
                  },
              ]);
          case 'postgres':
          case 'kingbase':
          case 'highgo':
          case 'vastbase':
              return normalizeMetadataQuerySpecs([
                  {
                      // PostgreSQL 11+ / 部分 PG-like：通过 prokind 区分 FUNCTION/PROCEDURE
                      sql: `SELECT n.nspname AS schema_name, p.proname AS routine_name, CASE WHEN p.prokind = 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS routine_type FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_%' ORDER BY n.nspname, routine_type, p.proname`,
                  },
                  {
                      // PostgreSQL 10 / 不支持 prokind 的兼容路径
                      sql: `SELECT r.routine_schema AS schema_name, r.routine_name AS routine_name, COALESCE(NULLIF(UPPER(r.routine_type), ''), 'FUNCTION') AS routine_type FROM information_schema.routines r WHERE r.routine_schema NOT IN ('pg_catalog', 'information_schema') AND r.routine_schema NOT LIKE 'pg_%' ORDER BY r.routine_schema, routine_type, r.routine_name`,
                  },
                  {
                      // 最后兜底：仅函数列表，确保 prokind/routines 视图异常时仍可展示
                      sql: `SELECT n.nspname AS schema_name, p.proname AS routine_name, 'FUNCTION' AS routine_type FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_%' ORDER BY n.nspname, p.proname`,
                  },
              ]);
          case 'sqlserver': {
              const safeDb = quoteSqlServerIdentifier(dbName || 'master');
              return [{ sql: `SELECT s.name AS schema_name, o.name AS routine_name, CASE o.type WHEN 'P' THEN 'PROCEDURE' WHEN 'FN' THEN 'FUNCTION' WHEN 'IF' THEN 'FUNCTION' WHEN 'TF' THEN 'FUNCTION' END AS routine_type FROM ${safeDb}.sys.objects o JOIN ${safeDb}.sys.schemas s ON o.schema_id = s.schema_id WHERE o.type IN ('P','FN','IF','TF') ORDER BY o.type, s.name, o.name` }];
          }
          case 'oracle':
          case 'dm':
              return normalizeMetadataQuerySpecs([
                  { sql: `SELECT OBJECT_NAME AS routine_name, OBJECT_TYPE AS routine_type FROM USER_OBJECTS WHERE OBJECT_TYPE IN ('FUNCTION','PROCEDURE') ORDER BY OBJECT_TYPE, OBJECT_NAME` },
                  { sql: `SELECT OWNER AS schema_name, OBJECT_NAME AS routine_name, OBJECT_TYPE AS routine_type FROM ALL_OBJECTS WHERE OWNER = USER AND OBJECT_TYPE IN ('FUNCTION','PROCEDURE') ORDER BY OBJECT_TYPE, OBJECT_NAME` },
                  {
                      sql: safeDbName
                          ? `SELECT OWNER AS schema_name, OBJECT_NAME AS routine_name, OBJECT_TYPE AS routine_type FROM ALL_OBJECTS WHERE OWNER = '${safeDbName.toUpperCase()}' AND OBJECT_TYPE IN ('FUNCTION','PROCEDURE') ORDER BY OBJECT_TYPE, OBJECT_NAME`
                          : '',
                  },
              ]);
          case 'duckdb':
              return [{
                  sql: `SELECT schema_name, function_name AS routine_name, 'FUNCTION' AS routine_type FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND COALESCE(macro_definition, '') <> '' ORDER BY schema_name, function_name`,
                  inferredType: 'FUNCTION',
              }];
          default:
              return [];
      }
  };

  const queryMetadataRowsBySpecs = async (
      conn: any,
      dbName: string,
      specs: MetadataQuerySpec[]
  ): Promise<{ results: MetadataQueryResult[]; hasSuccessfulQuery: boolean }> => {
      const normalizedSpecs = normalizeMetadataQuerySpecs(specs);
      if (normalizedSpecs.length === 0) {
          return { results: [], hasSuccessfulQuery: false };
      }
      const config = buildRuntimeConfig(conn, dbName);
      const results: MetadataQueryResult[] = [];
      let hasSuccessfulQuery = false;

      for (const spec of normalizedSpecs) {
          try {
              const result = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, spec.sql);
              if (!result.success || !Array.isArray(result.data)) {
                  continue;
              }
              hasSuccessfulQuery = true;
              results.push({
                  rows: result.data as Record<string, any>[],
                  inferredType: spec.inferredType,
              });
          } catch {
              // 忽略单条查询失败，继续尝试后续回退语句
          }
      }
      return { results, hasSuccessfulQuery };
  };

  const loadViews = async (conn: any, dbName: string): Promise<{ views: string[]; supported: boolean }> => {
      const savedConn = conn as SavedConnection;
      const dialect = getMetadataDialect(savedConn);
      const querySpecs = buildViewsMetadataQuerySpecs(dialect, dbName);
      const { results, hasSuccessfulQuery } = await queryMetadataRowsBySpecs(conn, dbName, querySpecs);
      const seen = new Set<string>();
      const views: string[] = [];

      results.forEach((queryResult) => {
          queryResult.rows.forEach((row) => {
              const tableType = getCaseInsensitiveValue(row, ['table_type', 'table type', 'type']);
              if (tableType && tableType.toUpperCase() !== 'VIEW') return;
              const schemaName = getCaseInsensitiveValue(row, ['schema_name', 'schemaname', 'owner', 'table_schema', 'db']);
              const viewName =
                  getCaseInsensitiveValue(row, ['view_name', 'viewname', 'table_name', 'name'])
                  || getMySQLShowTablesName(row)
                  || getFirstRowValue(row);
              const fullName = normalizeSidebarViewName(dialect, dbName, schemaName, viewName);
              if (!fullName || seen.has(fullName)) return;
              seen.add(fullName);
              views.push(fullName);
          });
      });
      return { views, supported: hasSuccessfulQuery };
  };

  const loadDatabaseTriggers = async (
      conn: any,
      dbName: string
  ): Promise<{ triggers: Array<{ displayName: string; triggerName: string; tableName: string }>; supported: boolean }> => {
      const dialect = getMetadataDialect(conn as SavedConnection);
      const querySpecs = buildTriggersMetadataQuerySpecs(dialect, dbName);
      const { results, hasSuccessfulQuery } = await queryMetadataRowsBySpecs(conn, dbName, querySpecs);
      const seen = new Set<string>();
      const triggers: Array<{ displayName: string; triggerName: string; tableName: string }> = [];

      results.forEach((queryResult) => {
          queryResult.rows.forEach((row) => {
              const rawTriggerName = getCaseInsensitiveValue(row, ['trigger_name', 'triggername', 'trigger', 'name']) || getFirstRowValue(row);
              if (!rawTriggerName) return;

              const rawSchemaName = getCaseInsensitiveValue(row, ['schema_name', 'schemaname', 'owner', 'event_object_schema', 'trigger_schema', 'db']);
              const rawTableName = getCaseInsensitiveValue(row, ['table_name', 'event_object_table', 'tbl_name', 'table']);

              const triggerParts = splitQualifiedName(rawTriggerName);
              const tableParts = splitQualifiedName(rawTableName);

              const resolvedSchema = (
                  rawSchemaName
                  || tableParts.schemaName
                  || triggerParts.schemaName
                  || dbName
              ).trim();
              const resolvedTriggerName = (triggerParts.objectName || rawTriggerName).trim();
              const resolvedTableName = (tableParts.objectName || rawTableName).trim();
              const fullTableName = buildQualifiedName(resolvedSchema, resolvedTableName);

              // MySQL 下 trigger 名在同 schema 内唯一，直接按 schema+trigger 去重可彻底规避多元数据查询导致的重复
              const uniqueKey = dialect === 'mysql'
                  ? `${resolvedSchema.toLowerCase()}@@${resolvedTriggerName.toLowerCase()}`
                  : `${resolvedSchema.toLowerCase()}@@${resolvedTriggerName.toLowerCase()}@@${resolvedTableName.toLowerCase()}`;
              if (seen.has(uniqueKey)) return;
              seen.add(uniqueKey);
              const displayName = fullTableName ? `${resolvedTriggerName} (${fullTableName})` : resolvedTriggerName;
              triggers.push({ displayName, triggerName: resolvedTriggerName, tableName: fullTableName || resolvedTableName });
          });
      });
      return { triggers, supported: hasSuccessfulQuery };
  };

  const loadFunctions = async (
      conn: any,
      dbName: string
  ): Promise<{ routines: Array<{ displayName: string; routineName: string; routineType: string }>; supported: boolean }> => {
      const dialect = getMetadataDialect(conn as SavedConnection);
      const querySpecs = buildFunctionsMetadataQuerySpecs(dialect, dbName);
      const { results, hasSuccessfulQuery } = await queryMetadataRowsBySpecs(conn, dbName, querySpecs);
      const seen = new Set<string>();
      const routines: Array<{ displayName: string; routineName: string; routineType: string }> = [];

      results.forEach((queryResult) => {
          queryResult.rows.forEach((row) => {
              const routineName = getCaseInsensitiveValue(row, ['routine_name', 'object_name', 'proname', 'name']);
              if (!routineName) return;
              const schemaName = getCaseInsensitiveValue(row, ['schema_name', 'nspname', 'owner', 'db', 'database']);
              const rawType = getCaseInsensitiveValue(row, ['routine_type', 'object_type', 'type']) || queryResult.inferredType || 'FUNCTION';
              const normalizedType = rawType.toUpperCase().includes('PROC') ? 'PROCEDURE' : 'FUNCTION';
              const fullName = buildQualifiedName(schemaName, routineName);
              const uniqueKey = `${fullName}@@${normalizedType}`;
              if (!fullName || seen.has(uniqueKey)) return;
              seen.add(uniqueKey);
              const typeLabel = normalizedType === 'PROCEDURE' ? 'P' : 'F';
              routines.push({ displayName: `${fullName} [${typeLabel}]`, routineName: fullName, routineType: normalizedType });
          });
      });
      return { routines, supported: hasSuccessfulQuery };
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

          if (conn.config.type === 'jvm') {
              try {
                  const res = await JVMProbeCapabilities(buildRuntimeConfig(conn) as any);
                  if (res.success) {
                      setConnectionStates(prev => ({ ...prev, [conn.id]: 'success' }));
                      const capabilities: JVMCapability[] = Array.isArray(res.data) ? res.data as JVMCapability[] : [];
                      const modeNodes: TreeNode[] = capabilities.map((capability) => ({
                          title: capability.displayLabel || capability.mode,
                          key: `${conn.id}-jvm-mode-${capability.mode}`,
                          icon: <HddOutlined />,
                          type: 'jvm-mode',
                          dataRef: {
                              ...conn,
                              providerMode: capability.mode,
                              canBrowse: capability.canBrowse,
                              canWrite: capability.canWrite,
                              reason: capability.reason,
                              displayLabel: capability.displayLabel,
                          },
                          isLeaf: capability.canBrowse !== true,
                      }));
                      const monitoringNodes: TreeNode[] = buildJVMMonitoringActionDescriptors(conn.id, capabilities).map((item) => ({
                          title: item.title,
                          key: item.key,
                          icon: <DashboardOutlined />,
                          type: 'jvm-monitoring',
                          dataRef: {
                              ...conn,
                              providerMode: item.providerMode,
                          },
                          isLeaf: true,
                      }));
                      const diagnosticNode = buildJVMDiagnosticTreeNodes(conn);
                      setTreeData(origin => updateTreeData(origin, node.key, [...monitoringNodes, ...modeNodes, ...diagnosticNode]));
                  } else {
                      const diagnosticNode = buildJVMDiagnosticTreeNodes(conn);
                      setConnectionStates(prev => ({ ...prev, [conn.id]: 'error' }));
                      if (diagnosticNode.length > 0) {
                          setTreeData(origin => updateTreeData(origin, node.key, diagnosticNode));
                          message.warning({ content: `JVM Provider 探测失败：${res.message || '未知错误'}；已保留诊断增强入口`, key: `conn-${conn.id}-jvm-caps` });
                      } else {
                          setLoadedKeys(prev => prev.filter(k => k !== node.key));
                          message.error({ content: res.message, key: `conn-${conn.id}-jvm-caps` });
                      }
                  }
              } catch (e: any) {
                  const diagnosticNode = buildJVMDiagnosticTreeNodes(conn);
                  setConnectionStates(prev => ({ ...prev, [conn.id]: 'error' }));
                  if (diagnosticNode.length > 0) {
                      setTreeData(origin => updateTreeData(origin, node.key, diagnosticNode));
                      message.warning({ content: `JVM Provider 探测异常：${e?.message || String(e)}；已保留诊断增强入口`, key: `conn-${conn.id}-jvm-caps` });
                  } else {
                      setLoadedKeys(prev => prev.filter(k => k !== node.key));
                      message.error({ content: '连接失败: ' + (e?.message || String(e)), key: `conn-${conn.id}-jvm-caps` });
                  }
              } finally {
                  loadingNodesRef.current.delete(loadKey);
              }
              return;
          }

          // Handle Redis connections differently
          if (conn.config.type === 'redis') {
              try {
                  const res = await (window as any).go.app.App.RedisGetDatabases(buildRpcConnectionConfig(config));
                  if (res.success) {
                      setConnectionStates(prev => ({ ...prev, [conn.id]: 'success' }));
                      const redisRows: any[] = Array.isArray(res.data) ? res.data : [];
                      let dbs = redisRows.map((db: any) => ({
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
	          const res = await DBGetDatabases(buildRpcConnectionConfig(config) as any);
	          if (res.success) {
	            setConnectionStates(prev => ({ ...prev, [conn.id]: 'success' }));
                const dbRows: any[] = Array.isArray(res.data) ? res.data : [];
	            let dbs = dbRows.map((row: any) => ({
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

            if (dbs.length > 0) {
                setTreeData(origin => updateTreeData(origin, node.key, dbs));
            } else {
                // 空列表：清理 loadedKeys 以允许重新加载，不设置 children = []
                setLoadedKeys(prev => prev.filter(k => k !== node.key));
                message.warning({ content: '未获取到可见数据库/schema，请检查账号权限或右键刷新', key: `conn-${conn.id}-dbs` });
            }
	          } else {
	            setConnectionStates(prev => ({ ...prev, [conn.id]: 'error' }));
	            setLoadedKeys(prev => prev.filter(k => k !== node.key));
	            message.error({ content: res.message, key: `conn-${conn.id}-dbs` });
	          }
	      } catch (e: any) {
	          setConnectionStates(prev => ({ ...prev, [conn.id]: 'error' }));
	          setLoadedKeys(prev => prev.filter(k => k !== node.key));
	          message.error({ content: '连接失败: ' + (e?.message || String(e)), key: `conn-${conn.id}-dbs` });
	      } finally {
	          loadingNodesRef.current.delete(loadKey);
	      }
  };

  const loadJVMResources = async (node: any) => {
      const conn = node.dataRef as SavedConnection & { providerMode?: string; resourcePath?: string };
      const providerMode = String(conn.providerMode || '').trim().toLowerCase();
      const parentPath = String(conn.resourcePath || '').trim();
      const loadKey = `jvm-resources-${conn.id}-${providerMode}-${parentPath}`;
      if (loadingNodesRef.current.has(loadKey)) return;
      loadingNodesRef.current.add(loadKey);

      try {
          const backendApp = (window as any).go?.app?.App;
          if (typeof backendApp?.JVMListResources !== 'function') {
              throw new Error('JVMListResources 后端方法不可用');
          }

          const res = await backendApp.JVMListResources(buildJVMRuntimeConfig(conn, providerMode), parentPath);
          if (res.success) {
              const resourceRows: JVMResourceSummary[] = Array.isArray(res.data) ? res.data as JVMResourceSummary[] : [];
              const resourceNodes: TreeNode[] = resourceRows.map((item) => ({
                  title: item.name || item.path || item.id,
                  key: `${conn.id}-jvm-resource-${providerMode}-${item.path}`,
                  icon: item.hasChildren ? <FolderOpenOutlined /> : <HddOutlined />,
                  type: 'jvm-resource',
                  dataRef: {
                      ...conn,
                      providerMode: item.providerMode || providerMode,
                      resourcePath: item.path,
                      resourceKind: item.kind,
                      canRead: item.canRead,
                      canWrite: item.canWrite,
                      hasChildren: item.hasChildren,
                      sensitive: item.sensitive,
                  },
                  isLeaf: item.hasChildren !== true,
              }));
              setTreeData(origin => updateTreeData(origin, node.key, resourceNodes));
          } else {
              setLoadedKeys(prev => prev.filter(k => k !== node.key));
              message.error({ content: res.message, key: `jvm-resource-${node.key}` });
          }
      } catch (e: any) {
          setLoadedKeys(prev => prev.filter(k => k !== node.key));
          message.error({ content: '加载 JVM 资源失败: ' + (e?.message || String(e)), key: `jvm-resource-${node.key}` });
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
      const dbExternalSQLDirectories = useStore.getState().externalSQLDirectories.filter(directory => directory.connectionId === conn.id && directory.dbName === dbName);
      
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
	          const res = await DBGetTables(buildRpcConnectionConfig(config) as any, conn.dbName);
	          if (res.success) {
	            setConnectionStates(prev => ({ ...prev, [key as string]: 'success' }));

                const tableRows: any[] = Array.isArray(res.data) ? res.data : [];
	            const tableEntries = tableRows.map((row: any) => {
	                const tableName = Object.values(row)[0] as string;
	                const parsed = splitQualifiedName(tableName);
	                return {
	                    tableName,
	                    schemaName: parsed.schemaName,
	                    displayName: getSidebarTableDisplayName(conn, tableName),
	                };
	            });

	            const [viewsResult, triggersResult, routinesResult] = await Promise.all([
	                loadViews(conn, conn.dbName),
	                loadDatabaseTriggers(conn, conn.dbName),
	                loadFunctions(conn, conn.dbName),
	            ]);
                const externalSQLDirectoryResults = await Promise.all(
                    dbExternalSQLDirectories.map(async (directory) => {
                        const directoryRes = await ListSQLDirectory(directory.path);
                        if (!directoryRes.success) {
                            message.warning({
                                key: `external-sql-${directory.id}`,
                                content: `SQL 目录读取失败: ${directory.name} (${directoryRes.message})`,
                            });
                            return { id: directory.id, entries: [] as ExternalSQLTreeEntry[] };
                        }
                        return {
                            id: directory.id,
                            entries: Array.isArray(directoryRes.data) ? directoryRes.data as ExternalSQLTreeEntry[] : [],
                        };
                    }),
                );
                const externalSQLTrees = externalSQLDirectoryResults.reduce<Record<string, ExternalSQLTreeEntry[]>>((accumulator, item) => {
                    accumulator[item.id] = item.entries;
                    return accumulator;
                }, {});
                const externalSQLRootNode = decorateExternalSQLTreeNode(buildExternalSQLRootNode({
                    dbNodeKey: String(key),
                    connectionId: String(conn.id),
                    dbName: String(conn.dbName),
                    directories: dbExternalSQLDirectories,
                    directoryTrees: externalSQLTrees,
                }));

            const viewRows: string[] = Array.isArray(viewsResult.views) ? viewsResult.views : [];
            const triggerRows: any[] = Array.isArray(triggersResult.triggers) ? triggersResult.triggers : [];
            const routineRows: any[] = Array.isArray(routinesResult.routines) ? routinesResult.routines : [];

            const viewEntries = viewRows.map((viewName: string) => {
                const parsed = splitQualifiedName(viewName);
                return {
                    viewName,
	                    schemaName: parsed.schemaName,
	                    displayName: getSidebarTableDisplayName(conn, viewName),
	                };
	            });

            const triggerEntries = (() => {
                const deduped: Array<{ displayName: string; triggerName: string; tableName: string; schemaName: string }> = [];
                const triggerSeen = new Set<string>();
                const metadataDialect = getMetadataDialect(conn as SavedConnection);

                triggerRows.forEach((trigger: any) => {
                    const triggerParsed = splitQualifiedName(trigger.triggerName);
                    const tableParsed = splitQualifiedName(trigger.tableName);
                    const schemaName = tableParsed.schemaName || triggerParsed.schemaName || String(conn.dbName || '').trim();
                    const triggerObjectName = (triggerParsed.objectName || trigger.triggerName).trim();
                    const tableObjectName = (tableParsed.objectName || trigger.tableName).trim();
                    const displayName = tableObjectName ? `${triggerObjectName} (${tableObjectName})` : triggerObjectName;
                    const dedupeKey = metadataDialect === 'mysql'
                        ? `${schemaName.toLowerCase()}@@${triggerObjectName.toLowerCase()}`
                        : `${schemaName.toLowerCase()}@@${triggerObjectName.toLowerCase()}@@${tableObjectName.toLowerCase()}`;

                    if (triggerSeen.has(dedupeKey)) return;
                    triggerSeen.add(dedupeKey);
                    deduped.push({
                        ...trigger,
                        schemaName,
                        triggerName: triggerObjectName,
                        tableName: buildQualifiedName(schemaName, tableObjectName) || tableObjectName,
                        displayName,
                    });
                });

                return deduped;
            })();

            const routineEntries = routineRows.map((routine: any) => {
                const parsed = splitQualifiedName(routine.routineName);
                const typeLabel = routine.routineType === 'PROCEDURE' ? 'P' : 'F';
                return {
	                    ...routine,
	                    schemaName: parsed.schemaName,
                    displayName: `${parsed.objectName || routine.routineName} [${typeLabel}]`,
                };
            });

            if (isSphinxConnection(conn as SavedConnection)) {
                const unsupportedObjects: string[] = [];
                if (!viewsResult.supported) unsupportedObjects.push('视图');
                if (!routinesResult.supported) unsupportedObjects.push('函数/存储过程');
                if (!triggersResult.supported) unsupportedObjects.push('触发器');
                if (unsupportedObjects.length > 0) {
                    message.info({
                        key: `sphinx-capability-${conn.id}-${conn.dbName}`,
                        content: `当前 Sphinx 实例未开放以下对象能力：${unsupportedObjects.join('、')}（已自动降级兼容）`,
                    });
                }
            }

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

	                const dialect = getMetadataDialect(conn as SavedConnection);
	                const isOracleLike = (dialect === 'oracle' || dialect === 'dm');

	                const schemaNodes: TreeNode[] = Array.from(schemaMap.values())
	                    .filter((bucket) => !(isOracleLike && !bucket.schemaName))
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

	                setTreeData(origin => updateTreeData(origin, key, [queriesNode, externalSQLRootNode, ...schemaNodes]));
	            } else {
	                const groupedNodes: TreeNode[] = [
	                    buildObjectGroup(key as string, 'tables', '表', <TableOutlined />, tableEntries.map(buildTableNode)),
	                    buildObjectGroup(key as string, 'views', '视图', <EyeOutlined />, viewEntries.map(buildViewNode)),
	                    buildObjectGroup(key as string, 'routines', '函数', <CodeOutlined />, routineEntries.map(buildRoutineNode)),
	                    buildObjectGroup(key as string, 'triggers', '触发器', <FunctionOutlined />, triggerEntries.map(buildTriggerNode)),
	                ];

	                setTreeData(origin => updateTreeData(origin, key, [queriesNode, externalSQLRootNode, ...groupedNodes]));
	            }
	          } else {
	            setConnectionStates(prev => ({ ...prev, [key as string]: 'error' }));
	            message.error({ content: res.message, key: `db-${key}-tables` });
          }
	      } catch (e: any) {
	          setConnectionStates(prev => ({ ...prev, [key as string]: 'error' }));
	          message.error({ content: '加载表失败: ' + (e?.message || String(e)), key: `db-${key}-tables` });
	      } finally {
	          loadingNodesRef.current.delete(loadKey);
	      }
  };

  const onLoadData = async ({ key, children, dataRef, type }: any) => {
    if (type === 'tag') return;
    if (children) return;

    if (type === 'connection') {
        await loadDatabases({ key, dataRef });
    } else if (type === 'jvm-mode' || type === 'jvm-resource') {
        await loadJVMResources({ key, dataRef });
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
          setActiveContext({ connectionId: dataRef.id, dbName: dataRef.dbName });
      } else if (type === 'table') {
          setActiveContext({ connectionId: dataRef.id, dbName: dataRef.dbName });
      } else if (type === 'jvm-mode' || type === 'jvm-resource' || type === 'jvm-diagnostic' || type === 'jvm-monitoring') {
          setActiveContext({ connectionId: dataRef.id, dbName: '' });
      } else if (type === 'view' || type === 'db-trigger' || type === 'routine') {
          setActiveContext({ connectionId: dataRef.id, dbName: dataRef.dbName });
      } else if (type === 'saved-query') {
          setActiveContext({ connectionId: dataRef.connectionId, dbName: dataRef.dbName });
      } else if (type === 'external-sql-root' || type === 'external-sql-directory' || type === 'external-sql-folder' || type === 'external-sql-file') {
          setActiveContext({ connectionId: dataRef.connectionId, dbName: dataRef.dbName });
      } else if (type === 'redis-db') {
          setActiveContext({ connectionId: dataRef.id, dbName: `db${dataRef.redisDB}` });
      }

      if (type === 'folder-columns') openDesign(info.node, 'columns', false);
      else if (type === 'folder-indexes') openDesign(info.node, 'indexes', false);
      else if (type === 'folder-fks') openDesign(info.node, 'foreignKeys', false);
      else if (type === 'folder-triggers') openDesign(info.node, 'triggers', false);
      else if (type === 'object-group' && dataRef?.groupKey === 'tables') {
          // 单击延迟打开表概览，双击时会取消此定时器
          if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
          const { id, dbName: gDbName, schemaName } = dataRef;
          clickTimerRef.current = setTimeout(() => {
              clickTimerRef.current = null;
              addTab({
                  id: `table-overview-${id}-${gDbName}${schemaName ? `-${schemaName}` : ''}`,
                  title: `表概览 - ${gDbName}${schemaName ? ` (${schemaName})` : ''}`,
                  type: 'table-overview' as any,
                  connectionId: id,
                  dbName: gDbName,
                  schemaName,
              } as any);
          }, 250);
      }
  };

  const onExpand = (newExpandedKeys: React.Key[]) => {
    setExpandedKeys(newExpandedKeys);
    setAutoExpandParent(false);
  };

  const onDoubleClick = (e: any, node: any) => {
      // 双击时取消单击延迟动作（如表概览打开），让双击只触发展开/折叠
      if (clickTimerRef.current) {
          clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
      }
      const { type, dataRef, key: nodeKey } = node;
      if (type === 'connection') setActiveContext({ connectionId: nodeKey, dbName: '' });
      else if (type === 'database') setActiveContext({ connectionId: dataRef.id, dbName: dataRef.dbName });
      else if (type === 'jvm-mode' || type === 'jvm-resource' || type === 'jvm-diagnostic' || type === 'jvm-monitoring') setActiveContext({ connectionId: dataRef.id, dbName: '' });
      else if (type === 'table' || type === 'view' || type === 'db-trigger' || type === 'routine') setActiveContext({ connectionId: dataRef.id, dbName: dataRef.dbName });
      else if (type === 'saved-query') setActiveContext({ connectionId: dataRef.connectionId, dbName: dataRef.dbName });
      else if (type === 'external-sql-root' || type === 'external-sql-directory' || type === 'external-sql-folder' || type === 'external-sql-file') setActiveContext({ connectionId: dataRef.connectionId, dbName: dataRef.dbName });
      else if (type === 'redis-db') setActiveContext({ connectionId: dataRef.id, dbName: `db${dataRef.redisDB}` });

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
              query: q.sql,
              savedQueryId: q.id,
          });
          return;
      } else if (node.type === 'external-sql-file') {
          void openExternalSQLFile(node);
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
      } else if (node.type === 'jvm-mode') {
          const { providerMode, id } = node.dataRef;
          const conn = (connections.find((item) => item.id === id) || node.dataRef) as SavedConnection;
          openJVMOverviewTab(conn, providerMode);
          return;
      } else if (node.type === 'jvm-resource') {
          const { providerMode, resourcePath, resourceKind, id } = node.dataRef;
          const conn = (connections.find((item) => item.id === id) || node.dataRef) as SavedConnection;
          openJVMResourceTab(conn, providerMode, resourcePath, resourceKind);
          return;
      } else if (node.type === 'jvm-monitoring') {
          const { providerMode, id } = node.dataRef;
          const conn = (connections.find((item) => item.id === id) || node.dataRef) as SavedConnection;
          openJVMMonitoringTab(conn, providerMode);
          return;
      } else if (node.type === 'jvm-diagnostic') {
          const conn = (connections.find((item) => item.id === node.dataRef.id) || node.dataRef) as SavedConnection;
          openJVMDiagnosticTab(conn);
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
	      const res = await DBShowCreateTable(buildRpcConnectionConfig(config) as any, dbName, tableName);
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
      const res = await ExportTable(buildRpcConnectionConfig(config) as any, dbName, tableName, format);
      hide();
      if (res.success) {
          message.success('导出成功');
      } else if (res.message !== '已取消') {
          message.error('导出失败: ' + res.message);
      }
  };

  const normalizeConnConfig = (raw: any) => (
      buildRpcConnectionConfig(raw)
  );

  const handleExportDatabaseSQL = async (node: any, includeData: boolean) => {
      const conn = node.dataRef;
      const dbName = conn.dbName || node.title;
      const hide = message.loading(includeData ? `正在备份数据库 ${dbName} (结构+数据)...` : `正在导出数据库 ${dbName} 表结构...`, 0);
      try {
          const res = await (window as any).go.app.App.ExportDatabaseSQL(normalizeConnConfig(conn.config), dbName, includeData);
          hide();
          if (res.success) {
              message.success('导出成功');
          } else if (res.message !== '已取消') {
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
          } else if (res.message !== '已取消') {
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
          } else if (node.type === 'table' || node.type === 'view') {
              connId = node.dataRef.id;
              dbName = node.dataRef.dbName;
          }
      }

      setSelectedConnection(connId);
      setSelectedDatabase(dbName);
      setBatchTables([]);
      setCheckedTableKeys([]);
      setAvailableDatabases([]);
      setBatchFilterKeyword('');
      setBatchFilterType('all');
      setBatchSelectionScope('filtered');

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

      const res = await DBGetDatabases(buildRpcConnectionConfig(config) as any);
      if (res.success) {
          const dbRows: any[] = Array.isArray(res.data) ? res.data : [];
          let dbs = dbRows.map((row: any) => {
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

      const [res, viewResult] = await Promise.all([
          DBGetTables(buildRpcConnectionConfig(config) as any, dbName),
          loadViews(conn, dbName).catch(() => ({ views: [], supported: false })),
      ]);

      if (!res.success) {
          message.error('获取表列表失败: ' + res.message);
          return;
      }

      const tableRows: any[] = Array.isArray(res.data) ? res.data : [];
      const viewRows: string[] = Array.isArray(viewResult.views) ? viewResult.views : [];
      const viewSet = new Set(viewRows.map((view: string) => view.toLowerCase()));

      const tableObjects: BatchObjectItem[] = tableRows
          .map((row: any) => Object.values(row)[0] as string)
          .filter((tableName: string) => !viewSet.has(tableName.toLowerCase()))
          .map((tableName: string) => ({
              title: getSidebarTableDisplayName(conn, tableName),
              key: `${conn.id}-${dbName}-table-${tableName}`,
              objectName: tableName,
              objectType: 'table' as const,
              dataRef: { ...conn, tableName, dbName, objectType: 'table' },
          }));

      const viewObjects: BatchObjectItem[] = viewRows.map((viewName: string) => ({
          title: getSidebarTableDisplayName(conn, viewName),
          key: `${conn.id}-${dbName}-view-${viewName}`,
          objectName: viewName,
          objectType: 'view' as const,
          dataRef: { ...conn, tableName: viewName, dbName, objectType: 'view' },
      }));

      tableObjects.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
      viewObjects.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));

      setBatchTables([...tableObjects, ...viewObjects]);
      setCheckedTableKeys([]);
  };

  const handleConnectionChange = async (connId: string) => {
      setSelectedConnection(connId);
      setSelectedDatabase('');
      setBatchTables([]);
      setCheckedTableKeys([]);
      setBatchFilterKeyword('');
      setBatchFilterType('all');
      setBatchSelectionScope('filtered');

      const conn = connections.find(c => c.id === connId);
      if (conn) {
          await loadDatabasesForBatch(conn);
      }
  };

  const handleDatabaseChange = async (dbName: string) => {
      setSelectedDatabase(dbName);
      setBatchFilterKeyword('');
      setBatchFilterType('all');
      setBatchSelectionScope('filtered');

      const conn = connections.find(c => c.id === selectedConnection);
      if (conn && dbName) {
          await loadTablesForBatch(conn, dbName);
      }
  };

  const handleBatchExport = async (mode: BatchTableExportMode) => {
      const selectedObjects = batchTables.filter(t => checkedTableKeys.includes(t.key));
      if (selectedObjects.length === 0) {
          message.warning('请至少选择一个对象');
          return;
      }

      setIsBatchModalOpen(false);

      const { conn, dbName } = batchDbContext;
      const objectNames = selectedObjects.map(t => t.objectName);
      const selectedViewCount = selectedObjects.filter(item => item.objectType === 'view').length;

      const loadingText = mode === 'backup'
          ? `正在备份选中对象 (${objectNames.length})...`
          : mode === 'dataOnly'
              ? `正在导出选中对象数据 (INSERT) (${objectNames.length})...`
              : `正在导出选中对象结构 (${objectNames.length})...`;
      const hide = message.loading(loadingText, 0);
      try {
          const app = (window as any).go.app.App;
          const res = mode === 'dataOnly'
              ? await app.ExportTablesDataSQL(normalizeConnConfig(conn.config), dbName, objectNames)
              : await app.ExportTablesSQL(normalizeConnConfig(conn.config), dbName, objectNames, mode === 'backup');
          hide();
          if (res.success) {
              if (mode !== 'schema' && selectedViewCount > 0) {
                  message.success(`导出成功（已自动跳过 ${selectedViewCount} 个视图的数据导出）`);
              } else {
                  message.success('导出成功');
              }
          } else if (res.message !== '已取消') {
              message.error('导出失败: ' + res.message);
          }
      } catch (e: any) {
          hide();
          message.error('导出失败: ' + (e?.message || String(e)));
      }
  };

  const handleBatchClear = async () => {
      if (selectedBatchObjects.length === 0) {
          message.warning('请至少选择一个对象');
          return;
      }
      if (selectedBatchTableNames.length === 0) {
          message.warning('批量清空仅支持表，请至少选择一个表');
          return;
      }

      const { conn, dbName } = batchDbContext;
      const objectNames = selectedBatchTableNames;
      const selectedViewWarning = selectedBatchViewCount > 0 ? `\r\n\r\n已自动忽略 ${selectedBatchViewCount} 个视图。` : '';

      const ok = await new Promise<boolean>((resolve) => {
          Modal.confirm({
              title: '确认清空选中表',
              content: `清空选中表会永久删除表中所有数据，操作不可逆，是否继续？\r\n\r\n连接: ${conn.name}\n数据库: ${dbName}${selectedViewWarning}`,
              okText: '继续',
              cancelText: '取消',
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
          });
      });
      if (!ok) return;

      setIsBatchModalOpen(false);
      const hide = message.loading(`正在清空选中表 (${objectNames.length})...`, 0);
      const startTime = Date.now();
      try {
          const app = (window as any).go.app.App;
          const res = await app.ClearTables(normalizeConnConfig(conn.config), dbName, objectNames);
          hide();
          const duration = Date.now() - startTime;
          if (res.success) {
              message.success(selectedBatchViewCount > 0 ? `清空成功（已忽略 ${selectedBatchViewCount} 个视图）` : '清空成功');
              // 构造 SQL 日志
              let logSql = `/* Clear Tables (${objectNames.length} tables) */\n`;
              if (res.data && res.data.executedSQLs && Array.isArray(res.data.executedSQLs)) {
                  logSql += res.data.executedSQLs.join(';\n') + ';';
              } else {
                  logSql += objectNames.map(name => name).join('; ');
              }
              addSqlLog({
                  id: Date.now().toString(),
                  timestamp: Date.now(),
                  sql: logSql,
                  status: 'success',
                  duration,
                  message: res.message,
                  dbName,
                  affectedRows: res.data?.count || 0
              });
          } else if (res.message !== '已取消') {
              message.error('清空失败: ' + res.message);
              // 记录失败的日志
              let logSql = `/* Clear Tables (${objectNames.length} tables) - FAILED */\n`;
              if (res.data && res.data.executedSQLs && Array.isArray(res.data.executedSQLs)) {
                  logSql += res.data.executedSQLs.join(';\n') + ';';
              } else {
                  logSql += objectNames.map(name => name).join('; ');
              }
              addSqlLog({
                  id: Date.now().toString(),
                  timestamp: Date.now(),
                  sql: logSql,
                  status: 'error',
                  duration,
                  message: res.message,
                  dbName
              });
          }
      } catch (e: any) {
          const duration = Date.now() - startTime;
          hide();
          const errMsg = e?.message || String(e);
          message.error('清空失败: ' + errMsg);
          // 记录异常的日志
          let logSql = `/* Clear Tables (${objectNames.length} tables) - ERROR */\n`;
          logSql += objectNames.map(name => name).join('; ');
          addSqlLog({
              id: Date.now().toString(),
              timestamp: Date.now(),
              sql: logSql,
              status: 'error',
              duration,
              message: errMsg,
              dbName
          });
      }
  };

  const handleBatchDelete = async () => {
      if (selectedBatchObjects.length === 0) {
          message.warning('请至少选择一个对象');
          return;
      }
      if (selectedBatchTableNames.length === 0) {
          message.warning('批量删除仅支持表，请至少选择一个表');
          return;
      }

      const { conn, dbName } = batchDbContext;
      const selectedViewWarning = selectedBatchViewCount > 0 ? `\r\n\r\n已自动忽略 ${selectedBatchViewCount} 个视图。` : '';
      const ok = await new Promise<boolean>((resolve) => {
          Modal.confirm({
              title: '确认删除选中表',
              content: `删除选中表会直接删除表结构和数据，操作不可恢复，是否继续？\r\n\r\n连接: ${conn.name}\n数据库: ${dbName}\n表数量: ${selectedBatchTableNames.length}${selectedViewWarning}`,
              okText: '删除',
              cancelText: '取消',
              okButtonProps: { danger: true },
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
          });
      });
      if (!ok) return;

      setIsBatchModalOpen(false);
      const hide = message.loading(`正在删除选中表 (${selectedBatchTableNames.length})...`, 0);
      const startTime = Date.now();
      try {
          const app = (window as any).go.app.App;
          const res = await app.DropTables(normalizeConnConfig(conn.config), dbName, selectedBatchTableNames);
          hide();
          const duration = Date.now() - startTime;
          const executedSQLs = Array.isArray(res.data?.executedSQLs) ? res.data.executedSQLs : [];
          const logSql = executedSQLs.length > 0
              ? executedSQLs.join(';\n') + ';'
              : selectedBatchTableNames.map((name) => `DROP TABLE ${name}`).join(';\n') + ';';

          if (res.success) {
              message.success(selectedBatchViewCount > 0 ? `删除成功（已忽略 ${selectedBatchViewCount} 个视图）` : '删除成功');
              addSqlLog({
                  id: Date.now().toString(),
                  timestamp: Date.now(),
                  sql: logSql,
                  status: 'success',
                  duration,
                  message: res.message,
                  dbName,
                  affectedRows: res.data?.count || selectedBatchTableNames.length,
              });
              await loadTables(getDatabaseNodeRef(conn, dbName));
              await loadTablesForBatch(conn, dbName);
              return;
          }

          addSqlLog({
              id: Date.now().toString(),
              timestamp: Date.now(),
              sql: logSql,
              status: 'error',
              duration,
              message: res.message,
              dbName,
          });
          message.error('删除失败: ' + res.message);
      } catch (e: any) {
          const duration = Date.now() - startTime;
          hide();
          const errMsg = e?.message || String(e);
          addSqlLog({
              id: Date.now().toString(),
              timestamp: Date.now(),
              sql: selectedBatchTableNames.map((name) => `DROP TABLE ${name}`).join(';\n') + ';',
              status: 'error',
              duration,
              message: errMsg,
              dbName,
          });
          message.error('删除失败: ' + errMsg);
      }
  };

  const handleCheckAll = (checked: boolean) => {
      if (batchSelectionScope === 'all') {
          setCheckedTableKeys(checked ? allBatchObjectKeys : []);
          return;
      }
      if (filteredBatchObjectKeys.length === 0) {
          return;
      }
      if (checked) {
          setCheckedTableKeys(prev => {
              const nextSet = new Set(prev);
              filteredBatchObjectKeys.forEach((key) => nextSet.add(key));
              return allBatchObjectKeys.filter((key) => nextSet.has(key));
          });
          return;
      }
      const filteredKeySet = new Set(filteredBatchObjectKeys);
      setCheckedTableKeys(prev => prev.filter((key) => !filteredKeySet.has(key)));
  };

  const handleInvertSelection = () => {
      if (batchSelectionScope === 'all') {
          setCheckedTableKeys(prev => allBatchObjectKeys.filter((key) => !prev.includes(key)));
          return;
      }
      if (filteredBatchObjectKeys.length === 0) {
          return;
      }
      setCheckedTableKeys(prev => {
          const nextSet = new Set(prev);
          filteredBatchObjectKeys.forEach((key) => {
              if (nextSet.has(key)) {
                  nextSet.delete(key);
              } else {
                  nextSet.add(key);
              }
          });
          return allBatchObjectKeys.filter((key) => nextSet.has(key));
      });
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

      const res = await DBGetDatabases(buildRpcConnectionConfig(config) as any);
      if (res.success) {
          const dbRows: any[] = Array.isArray(res.data) ? res.data : [];
          let dbs = dbRows.map((row: any) => {
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
              } else if (res.message !== '已取消') {
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
      const res = await OpenSQLFile();
      if (res.success) {
          const data = res.data;
          // 大文件：后端返回文件路径，走流式执行
          if (data && typeof data === 'object' && data.isLargeFile) {
              const connId = node.type === 'connection' ? node.key : node.dataRef?.id;
              const dbName = node.dataRef?.dbName || '';
              const conn = connections.find(c => c.id === connId);
              if (!conn) {
                  message.error('未找到对应的连接配置');
                  return;
              }
              startSQLFileExecution(conn.config, dbName, data.filePath, data.fileSizeMB);
              return;
          }
          // 小文件：加载到编辑器
          const sqlContent = data;
          const { dbName, id } = node.dataRef;
          addTab({
              id: `query-${Date.now()}`,
              title: `运行外部SQL文件`,
              type: 'query',
              connectionId: node.type === 'connection' ? node.key : node.dataRef.id,
              dbName: dbName,
              query: sqlContent
          });
      } else if (res.message !== '已取消') {
          message.error('读取文件失败: ' + res.message);
      }
  };

  const handleOpenSQLFileFromToolbar = async () => {
      const ctx = useStore.getState().activeContext;
      if (!ctx?.connectionId) {
          message.warning('请先选择一个连接或数据库');
          return;
      }
      const res = await OpenSQLFile();
      if (res.success) {
          const data = res.data;
          // 大文件：后端流式执行
          if (data && typeof data === 'object' && data.isLargeFile) {
              const conn = connections.find(c => c.id === ctx.connectionId);
              if (!conn) {
                  message.error('未找到对应的连接配置');
                  return;
              }
              startSQLFileExecution(conn.config, ctx.dbName || '', data.filePath, data.fileSizeMB);
              return;
          }
          // 小文件
          addTab({
              id: `query-${Date.now()}`,
              title: `运行外部SQL文件`,
              type: 'query',
              connectionId: ctx.connectionId,
              dbName: ctx.dbName || undefined,
              query: data
          });
      } else if (res.message !== '已取消') {
          message.error('读取文件失败: ' + res.message);
      }
  };

  // SQL 文件流式执行状态
  const [sqlFileExecState, setSqlFileExecState] = useState<{
      open: boolean;
      jobId: string;
      fileSizeMB: string;
      status: 'running' | 'done' | 'cancelled' | 'error';
      executed: number;
      failed: number;
      total: number;
      percent: number;
      currentSQL: string;
      resultMessage: string;
  }>({
      open: false, jobId: '', fileSizeMB: '', status: 'running',
      executed: 0, failed: 0, total: 0, percent: 0, currentSQL: '', resultMessage: ''
  });

  const startSQLFileExecution = (config: any, dbName: string, filePath: string, fileSizeMB: string) => {
      const jobId = `sqlfile-${Date.now()}`;
      setSqlFileExecState({
          open: true, jobId, fileSizeMB, status: 'running',
          executed: 0, failed: 0, total: 0, percent: 0, currentSQL: '', resultMessage: ''
      });

      // 监听进度事件
      const offProgress = EventsOn('sqlfile:progress', (event: any) => {
          if (!event || event.jobId !== jobId) return;
          setSqlFileExecState(prev => ({
              ...prev,
              status: event.status || prev.status,
              executed: typeof event.executed === 'number' ? event.executed : prev.executed,
              failed: typeof event.failed === 'number' ? event.failed : prev.failed,
              total: typeof event.total === 'number' ? event.total : prev.total,
              percent: typeof event.percent === 'number' ? Math.min(100, event.percent) : prev.percent,
              currentSQL: typeof event.currentSQL === 'string' ? event.currentSQL : prev.currentSQL,
          }));
      });

      // 异步执行
      ExecuteSQLFile(config, dbName, filePath, jobId).then(res => {
          offProgress();
          setSqlFileExecState(prev => ({
              ...prev,
              status: res.success ? 'done' : (prev.status === 'cancelled' ? 'cancelled' : 'error'),
              percent: 100,
              resultMessage: res.message || '',
          }));
      }).catch(err => {
          offProgress();
          setSqlFileExecState(prev => ({
              ...prev,
              status: 'error',
              resultMessage: String(err?.message || err),
          }));
      });
  };

  const refreshDatabaseNode = async (dbNodeKey: string) => {
      if (!dbNodeKey) {
          return;
      }
      const dbNode = findTreeNodeByKey(treeData, dbNodeKey);
      if (dbNode && dbNode.type === 'database') {
          await loadTables(dbNode);
      }
  };

  const openExternalSQLFile = async (fileNode: any) => {
      const connectionId = String(fileNode?.dataRef?.connectionId || '').trim();
      const dbName = String(fileNode?.dataRef?.dbName || '').trim();
      const filePath = String(fileNode?.dataRef?.path || '').trim();
      const fileName = String(fileNode?.dataRef?.name || fileNode?.title || 'SQL文件').trim() || 'SQL文件';
      if (!connectionId || !dbName || !filePath) {
          message.error('SQL 文件上下文不完整，无法打开');
          return;
      }

      const res = await ReadSQLFile(filePath);
      if (!res.success) {
          if (res.message !== '已取消') {
              message.error('读取 SQL 文件失败: ' + res.message);
          }
          return;
      }

      const data = res.data;
      if (data && typeof data === 'object' && data.isLargeFile) {
          const conn = connections.find((item) => item.id === connectionId);
          if (!conn) {
              message.error('未找到对应的连接配置');
              return;
          }
          startSQLFileExecution(conn.config, dbName, data.filePath, data.fileSizeMB);
          return;
      }

      addTab({
          id: buildExternalSQLTabId(connectionId, dbName, filePath),
          title: fileName,
          type: 'query',
          connectionId,
          dbName,
          query: String(data || ''),
      });
  };

  const handleAddExternalSQLDirectory = async (node: any) => {
      const context = getNodeDatabaseContext(node);
      if (!context?.connectionId || !context?.dbName || !context?.dbNodeKey) {
          message.warning('请在具体数据库下添加外部 SQL 目录');
          return;
      }

      const currentDirectory = externalSQLDirectories.find((item) =>
          item.connectionId === context.connectionId && item.dbName === context.dbName,
      )?.path || '';
      const selection = await SelectSQLDirectory(currentDirectory);
      if (!selection.success) {
          if (selection.message !== '已取消') {
              message.error('选择 SQL 目录失败: ' + selection.message);
          }
          return;
      }

      const payload = (selection.data && typeof selection.data === 'object') ? selection.data as Record<string, unknown> : {};
      const path = String(payload.path || '').trim();
      const name = String(payload.name || '').trim();
      if (!path) {
          message.error('未获取到有效的 SQL 目录路径');
          return;
      }

      const directoryId = buildExternalSQLDirectoryId(context.connectionId, context.dbName, path);
      saveExternalSQLDirectory({
          id: directoryId,
          name: name || path.split(/[\\/]/).filter(Boolean).pop() || 'SQL目录',
          path,
          connectionId: context.connectionId,
          dbName: context.dbName,
          createdAt: Date.now(),
      });

      setExpandedKeys((prev) => Array.from(new Set([...prev, context.dbNodeKey, `${context.dbNodeKey}-external-sql`])));
      setAutoExpandParent(false);
      await refreshDatabaseNode(context.dbNodeKey);
      message.success('外部 SQL 目录已添加');
  };

  const handleRemoveExternalSQLDirectory = async (node: any) => {
      const directoryId = String(node?.dataRef?.id || '').trim();
      const dbNodeKey = String(node?.dataRef?.dbNodeKey || '').trim();
      if (!directoryId) {
          message.error('未找到可移除的 SQL 目录');
          return;
      }
      deleteExternalSQLDirectory(directoryId);
      await refreshDatabaseNode(dbNodeKey);
      message.success('外部 SQL 目录已移除');
  };

  const handleRefreshExternalSQLDirectory = async (node: any) => {
      const dbNodeKey = String(node?.dataRef?.dbNodeKey || '').trim();
      if (!dbNodeKey) {
          message.warning('当前目录缺少数据库上下文，无法刷新');
          return;
      }
      await refreshDatabaseNode(dbNodeKey);
      message.success('外部 SQL 目录已刷新');
  };

  const handleCreateDatabase = async () => {
      try {
          const values = await createDbForm.validateFields();
          const conn = targetConnection.dataRef;
          const config = { 
              ...conn.config, 
              port: Number(conn.config.port),
              password: conn.config.password || "",
              database: (conn.config.type === 'oracle' || conn.config.type === 'dameng') ? (conn.config.database || "") : "",
              useSSH: conn.config.useSSH || false,
              ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
          };
          
          const res = await CreateDatabase(buildRpcConnectionConfig(config) as any, values.name);
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
      return buildRpcConnectionConfig(conn.config, {
          database: resolveSidebarRuntimeDatabase(
              conn?.config?.type,
              conn?.config?.driver,
              conn?.config?.database,
              overrideDatabase,
              clearDatabase,
          ),
      });
  };

  const buildJVMRuntimeConfig = (conn: SavedConnection & { dbName?: string }, providerMode: string) => {
      const sourceJVM = conn.config.jvm || {};
      return buildRpcConnectionConfig(conn.config, {
          database: '',
          jvm: {
              ...sourceJVM,
              preferredMode: providerMode as 'jmx' | 'endpoint' | 'agent',
              allowedModes: [providerMode as 'jmx' | 'endpoint' | 'agent'],
          },
      });
  };

  const openJVMOverviewTab = (conn: SavedConnection, providerMode: string) => {
      addTab({
          id: `jvm-overview-${conn.id}-${providerMode}`,
          title: buildJVMTabTitle(conn.name, 'overview', providerMode),
          type: 'jvm-overview',
          connectionId: conn.id,
          providerMode: providerMode as 'jmx' | 'endpoint' | 'agent',
      });
  };

  const openJVMMonitoringTab = (conn: SavedConnection, providerMode: string) => {
      addTab({
          id: `jvm-monitoring-${conn.id}-${providerMode}`,
          title: buildJVMTabTitle(conn.name, 'monitoring', providerMode),
          type: 'jvm-monitoring',
          connectionId: conn.id,
          providerMode: providerMode as 'jmx' | 'endpoint' | 'agent',
      });
  };

  const buildJVMDiagnosticTreeNodes = (conn: SavedConnection): TreeNode[] => {
      const descriptor = buildJVMDiagnosticActionDescriptor(conn.id, conn.config.jvm?.diagnostic);
      if (!descriptor) {
          return [];
      }
      return [{
          title: descriptor.title,
          key: descriptor.key,
          icon: <DashboardOutlined />,
          type: 'jvm-diagnostic',
          dataRef: {
              ...conn,
              diagnosticTransport: descriptor.transport,
          },
          isLeaf: true,
      }];
  };

  const openJVMResourceTab = (conn: SavedConnection, providerMode: string, resourcePath: string, resourceKind?: string) => {
      const trimmedResourcePath = String(resourcePath || '').trim();
      addTab({
          id: `jvm-resource-${conn.id}-${providerMode}-${encodeURIComponent(trimmedResourcePath)}`,
          title: trimmedResourcePath
              ? `${buildJVMTabTitle(conn.name, 'resource', providerMode)} · ${trimmedResourcePath}`
              : buildJVMTabTitle(conn.name, 'resource', providerMode),
          type: 'jvm-resource',
          connectionId: conn.id,
          providerMode: providerMode as 'jmx' | 'endpoint' | 'agent',
          resourcePath: trimmedResourcePath,
          resourceKind,
      });
  };

  const openJVMDiagnosticTab = (conn: SavedConnection) => {
      const transport = conn.config.jvm?.diagnostic?.transport || 'agent-bridge';
      addTab({
          id: `jvm-diagnostic-${conn.id}`,
          title: buildJVMTabTitle(conn.name, 'diagnostic', transport),
          type: 'jvm-diagnostic',
          connectionId: conn.id,
      });
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
          const res = await RenameDatabase(buildRpcConnectionConfig(config) as any, oldDbName, newDbName);
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
              const res = await DropDatabase(buildRpcConnectionConfig(config) as any, dbName);
              if (res.success) {
                  message.success("数据库删除成功");
                  closeTabsByDatabase(conn.id, dbName);
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
          const res = await RenameTable(buildRpcConnectionConfig(config) as any, conn.dbName, oldTableName, newTableName);
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
              const res = await DropTable(buildRpcConnectionConfig(config) as any, conn.dbName, tableName);
              if (res.success) {
                  message.success("表删除成功");
                  await loadTables(getDatabaseNodeRef(conn, conn.dbName));
              } else {
                  message.error("删除失败: " + res.message);
              }
          }
      });
  };

  const handleTableDataDangerAction = async (node: any, action: TableDataDangerActionKind) => {
      const conn = node.dataRef;
      const tableName = String(conn.tableName || '').trim();
      if (!tableName) return;

      const { label, progressLabel } = getTableDataDangerActionMeta(action);
      const confirmed = await new Promise<boolean>((resolve) => {
          Modal.confirm({
              title: `确认${label}`,
              content: `${label}会永久删除表 "${tableName}" 中的所有数据，操作不可逆，是否继续？`,
              okText: '继续',
              cancelText: '取消',
              okButtonProps: { danger: true },
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
          });
      });
      if (!confirmed) return;

      const config = buildRuntimeConfig(conn, conn.dbName);
      const app = (window as any).go.app.App;
      const methodName = action === 'truncate' ? 'TruncateTables' : 'ClearTables';
      const hide = message.loading(`正在${progressLabel} ${tableName}...`, 0);
      const startTime = Date.now();
      try {
          const res = await app[methodName](buildRpcConnectionConfig(config) as any, conn.dbName, [tableName]);
          hide();
          const duration = Date.now() - startTime;
          const executedSQLs = Array.isArray(res.data?.executedSQLs) ? res.data.executedSQLs : [];
          const logSql = executedSQLs.length > 0
              ? executedSQLs.join(';\n') + ';'
              : `/* ${label} ${tableName} */`;

          if (res.success) {
              message.success(`${progressLabel}成功`);
              addSqlLog({
                  id: Date.now().toString(),
                  timestamp: Date.now(),
                  sql: logSql,
                  status: 'success',
                  duration,
                  message: res.message,
                  dbName: conn.dbName,
                  affectedRows: res.data?.count || 0,
              });
              await loadTables(getDatabaseNodeRef(conn, conn.dbName));
              return;
          }

          addSqlLog({
              id: Date.now().toString(),
              timestamp: Date.now(),
              sql: logSql,
              status: 'error',
              duration,
              message: res.message,
              dbName: conn.dbName,
          });
          if (res.message !== '已取消') {
              message.error(`${progressLabel}失败: ${res.message}`);
          }
      } catch (e: any) {
          const duration = Date.now() - startTime;
          const errMsg = e?.message || String(e);
          hide();
          addSqlLog({
              id: Date.now().toString(),
              timestamp: Date.now(),
              sql: `/* ${label} ${tableName} - ERROR */`,
              status: 'error',
              duration,
              message: errMsg,
              dbName: conn.dbName,
          });
          message.error(`${progressLabel}失败: ${errMsg}`);
      }
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
              case 'duckdb': {
                  const parts = splitQualifiedName(viewName);
                  const viewSchema = escapeSQLLiteral(parts.schemaName || 'main');
                  const viewObject = escapeSQLLiteral(parts.objectName || viewName);
                  query = `SELECT view_definition FROM information_schema.views WHERE table_schema='${viewSchema}' AND table_name='${viewObject}' LIMIT 1`;
                  break;
              }
          }
          if (query) {
              const result = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, query);
              if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                  const row = result.data[0] as Record<string, any>;
                  const def = row.view_definition || row.VIEW_DEFINITION || Object.values(row).find(v => typeof v === 'string' && String(v).length > 10) || '';
                  if (def) {
                      if (dialect === 'mysql') {
                          template = `-- 编辑视图 ${viewName}\n${normalizeMySQLViewDDLForEditing(viewName, def)}`;
                      } else {
                          template = `-- 编辑视图 ${viewName}\nCREATE OR REPLACE VIEW ${viewName} AS\n${def}`;
                      }
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
          case 'duckdb':
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
              const res = await DropView(buildRpcConnectionConfig(config) as any, conn.dbName, viewName);
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
          const res = await RenameView(buildRpcConnectionConfig(config) as any, conn.dbName, oldViewName, newViewName);
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
          const parsedRoutine = splitQualifiedName(routineName);
          const name = parsedRoutine.objectName || routineName;
          const schema = parsedRoutine.schemaName;

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
              case 'duckdb': {
                  const schemaRef = schema || 'main';
                  query = `SELECT schema_name, function_name, parameters, macro_definition FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND schema_name = '${escapeSQLLiteral(schemaRef)}' AND function_name = '${escapeSQLLiteral(name)}' LIMIT 1`;
                  break;
              }
          }
          if (query) {
              const result = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, query);
              if (result.success && Array.isArray(result.data) && result.data.length > 0) {
                  if (dialect === 'oracle' || dialect === 'dm') {
                      const lines = result.data.map((row: any) => row.text || row.TEXT || Object.values(row)[0] || '').join('');
                      if (lines) template = `-- 编辑${typeLabel} ${routineName}\nCREATE OR REPLACE ${lines}`;
                  } else if (dialect === 'duckdb') {
                      const row = result.data[0] as Record<string, any>;
                      const ddl = buildDuckDBMacroDDL(
                          String(getCaseInsensitiveRawValue(row, ['schema_name']) || schema || '').trim(),
                          String(getCaseInsensitiveRawValue(row, ['function_name']) || name || '').trim(),
                          getCaseInsensitiveRawValue(row, ['parameters']),
                          getCaseInsensitiveRawValue(row, ['macro_definition'])
                      );
                      if (ddl) template = `-- 编辑${typeLabel} ${routineName}\n${ddl}`;
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
          case 'duckdb':
              template = isProc
                  ? `-- DuckDB 暂不支持存储过程\n-- 请使用 SQL Macro 作为函数能力\nCREATE MACRO func_name(param1) AS (param1 * 2);`
                  : `CREATE MACRO func_name(param1) AS (param1 * 2);`;
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
              const res = await DropFunction(buildRpcConnectionConfig(config) as any, conn.dbName, routineName, routineType);
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

  const toggleSearchScope = (scope: SearchScope) => {
      setSearchScopes((prev) => {
          if (scope === 'smart') {
              return ['smart'];
          }
          const withoutSmart = prev.filter((item) => item !== 'smart');
          if (withoutSmart.includes(scope)) {
              const next = withoutSmart.filter((item) => item !== scope);
              return next.length > 0 ? next : ['smart'];
          }
          return [...withoutSmart, scope];
      });
  };

  const setSearchScopeChecked = (scope: SearchScope, checked: boolean) => {
      if (scope === 'smart') {
          if (checked) {
              setSearchScopes(['smart']);
          } else if (searchScopes.length === 1 && searchScopes[0] === 'smart') {
              setSearchScopes(['smart']);
          } else {
              setSearchScopes((prev) => {
                  const next = prev.filter((item) => item !== 'smart');
                  return next.length > 0 ? next : ['smart'];
              });
          }
          return;
      }

      if (checked) {
          setSearchScopes((prev) => {
              const withoutSmart = prev.filter((item) => item !== 'smart');
              if (withoutSmart.includes(scope)) {
                  return withoutSmart;
              }
              return [...withoutSmart, scope];
          });
      } else {
          setSearchScopes((prev) => {
              const next = prev.filter((item) => item !== scope && item !== 'smart');
              return next.length > 0 ? next : ['smart'];
          });
      }
  };

  const searchScopeSummary = useMemo(() => {
      if (searchScopes.includes('smart')) {
          return '智能';
      }
      return searchScopes.map((scope) => SEARCH_SCOPE_LABEL_MAP[scope]).join(' + ');
  }, [searchScopes]);

  const searchScopePopoverContent = useMemo(() => {
      const smartSelected = searchScopes.includes('smart');
      const scopedOptions = SEARCH_SCOPE_OPTIONS.filter((option) => option.value !== 'smart');
      const borderColor = overlayTheme.sectionBorder.replace('1px solid ', '');
      const mutedTextColor = overlayTheme.mutedText;
      const titleColor = overlayTheme.titleText;
      const panelBg = overlayTheme.shellBg;
      const smartBg = smartSelected
          ? (darkMode ? 'linear-gradient(135deg, rgba(255,214,102,0.22) 0%, rgba(255,179,71,0.16) 100%)' : 'linear-gradient(135deg, rgba(255,214,102,0.26) 0%, rgba(255,244,204,0.92) 100%)')
          : (darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.72)');
      const smartBorder = smartSelected
          ? (darkMode ? 'rgba(255,214,102,0.42)' : 'rgba(245,176,65,0.34)')
          : borderColor;
      const getOptionCardStyle = (checked: boolean) => ({
          display: 'flex',
          alignItems: 'center' as const,
          justifyContent: 'space-between' as const,
          gap: 12,
          padding: '10px 12px',
          borderRadius: 12,
          border: `1px solid ${checked ? (darkMode ? 'rgba(118,169,250,0.44)' : 'rgba(24,144,255,0.32)') : borderColor}`,
          background: checked
              ? (darkMode ? 'rgba(64,124,255,0.18)' : 'rgba(24,144,255,0.08)')
              : (darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.76)'),
          transition: 'all 120ms ease',
      });
      return (
          <div style={{ minWidth: 280, display: 'flex', flexDirection: 'column', background: panelBg, padding: 14, gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                  <div>
                      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.4, color: mutedTextColor, textTransform: 'uppercase' }}>搜索范围</div>
                      <div style={{ marginTop: 4, fontSize: 13, lineHeight: 1.5, color: mutedTextColor }}>“智能”自动匹配最可能的命中项；手动模式支持按维度组合筛选。</div>
                  </div>
                  <div style={{ width: 32, height: 32, borderRadius: 10, display: 'grid', placeItems: 'center', background: darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(17,24,39,0.06)', color: darkMode ? '#ffd666' : '#1677ff', flexShrink: 0 }}>
                      <FilterOutlined />
                  </div>
              </div>

              <label style={{ display: 'block', cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, border: `1px solid ${smartBorder}`, background: smartBg, boxShadow: smartSelected ? (darkMode ? '0 10px 24px rgba(0,0,0,0.24)' : '0 10px 24px rgba(245,176,65,0.14)') : 'none' }}>
                      <Checkbox
                          checked={smartSelected}
                          onChange={(e) => setSearchScopeChecked('smart', e.target.checked)}
                      />
                      <div style={{ width: 30, height: 30, borderRadius: 10, display: 'grid', placeItems: 'center', background: darkMode ? 'rgba(255,214,102,0.16)' : 'rgba(255,214,102,0.3)', color: darkMode ? '#ffd666' : '#ad6800', flexShrink: 0 }}>
                          {SEARCH_SCOPE_ICON_MAP.smart}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 14, fontWeight: 700, color: titleColor }}>智能</span>
                              <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, color: darkMode ? '#ffe58f' : '#ad6800', background: darkMode ? 'rgba(255,214,102,0.16)' : 'rgba(255,214,102,0.35)' }}>推荐</span>
                          </div>
                          <div style={{ marginTop: 3, fontSize: 12, lineHeight: 1.5, color: mutedTextColor }}>适合日常检索，自动覆盖名称、库、Host 和标签等高频维度。</div>
                      </div>
                  </div>
              </label>

              <div style={{ height: 1, background: overlayTheme.divider, opacity: 0.9 }} />

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.3, color: mutedTextColor, textTransform: 'uppercase' }}>手动范围</div>
                  <div style={{ fontSize: 12, color: mutedTextColor }}>支持多选组合</div>
              </div>

              <div style={{ display: 'grid', gap: 8 }}>
                  {scopedOptions.map((option) => {
                      const checked = searchScopes.includes(option.value);
                      return (
                          <label key={option.value} style={{ display: 'block', cursor: 'pointer' }}>
                              <div style={getOptionCardStyle(checked)}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                                      <Checkbox
                                          checked={checked}
                                          onChange={(e) => setSearchScopeChecked(option.value, e.target.checked)}
                                      />
                                      <div style={{ width: 28, height: 28, borderRadius: 9, display: 'grid', placeItems: 'center', background: checked ? (darkMode ? 'rgba(118,169,250,0.2)' : 'rgba(24,144,255,0.12)') : (darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(17,24,39,0.06)'), color: checked ? (darkMode ? '#91caff' : '#1677ff') : mutedTextColor, flexShrink: 0 }}>
                                          {SEARCH_SCOPE_ICON_MAP[option.value]}
                                      </div>
                                      <span style={{ fontSize: 14, fontWeight: 600, color: titleColor, whiteSpace: 'nowrap' }}>{option.label}</span>
                                  </div>
                                  <div style={{ width: 18, display: 'flex', justifyContent: 'center', color: checked ? (darkMode ? '#91caff' : '#1677ff') : 'transparent', flexShrink: 0 }}>
                                      <CheckOutlined />
                                  </div>
                              </div>
                          </label>
                      );
                  })}
              </div>

              <div style={{ padding: '10px 12px', borderRadius: 12, background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(17,24,39,0.04)', color: mutedTextColor, fontSize: 12, lineHeight: 1.6 }}>
                  智能与其他项互斥。若你明确知道要搜的是对象、库、Host 或标签，建议切到手动范围以减少噪音结果。
              </div>
          </div>
      );
  }, [darkMode, overlayTheme, searchScopes]);

  const getConnectionHostSearchText = (node: TreeNode): string => {
      if (node.type !== 'connection') return '';
      const config = node.dataRef?.config || {};
      return resolveConnectionHostTokens(config).join(' ');
  };

  const getConnectionNameSearchText = (node: TreeNode): string => {
      if (node.type !== 'connection') return '';
      const name = node.dataRef?.name ?? node.title;
      return String(name || '').toLowerCase();
  };

  const isObjectNode = (node: TreeNode): boolean => {
      return node.type === 'table'
          || node.type === 'view'
          || node.type === 'db-trigger'
          || node.type === 'routine'
          || node.type === 'object-group';
  };

  const matchByScopes = (node: TreeNode, keyword: string, scopes: SearchScope[]): boolean => {
      const title = String(node.title || '').toLowerCase();
      if (scopes.includes('database') && node.type === 'database' && title.includes(keyword)) {
          return true;
      }
      if (scopes.includes('tag') && node.type === 'tag' && title.includes(keyword)) {
          return true;
      }
      if (scopes.includes('host') && node.type === 'connection' && getConnectionHostSearchText(node).includes(keyword)) {
          return true;
      }
      if (scopes.includes('object') && isObjectNode(node) && title.includes(keyword)) {
          return true;
      }
      return false;
  };

  const loop = (data: TreeNode[], keyword: string): TreeNode[] => {
      const isSmartMode = searchScopes.includes('smart');
      const result: TreeNode[] = [];
      data.forEach((item) => {
          const titleMatch = String(item.title || '').toLowerCase().includes(keyword);
          const smartMatch = item.type === 'connection'
              ? getConnectionNameSearchText(item).includes(keyword) || getConnectionHostSearchText(item).includes(keyword)
              : titleMatch;
          const scopedMatch = matchByScopes(item, keyword, searchScopes);
          const selfMatch = isSmartMode ? smartMatch : scopedMatch;
          const filteredChildren = item.children ? loop(item.children, keyword) : [];

          if (selfMatch) {
              const shouldKeepFullSubtree = isSmartMode
                  || item.type === 'connection'
                  || item.type === 'database'
                  || item.type === 'tag';
              if (item.children && shouldKeepFullSubtree) {
                  result.push(item);
              } else if (item.children && filteredChildren.length > 0) {
                  result.push({ ...item, children: filteredChildren });
              } else {
                  result.push(item);
              }
              return;
          }

          if (filteredChildren.length > 0) {
              result.push({ ...item, children: filteredChildren });
          }
      });
      return result;
  };

  const displayTreeData = useMemo(() => {
      const keyword = searchValue.trim().toLowerCase();
      if (!keyword) return treeData;
      return loop(treeData, keyword);
  }, [searchValue, searchScopes, treeData]);

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
        const dialect = getMetadataDialect(node.dataRef as SavedConnection);
        const routineMenu: MenuProps['items'] = [
            {
                key: 'create-function',
                label: '新建函数',
                icon: <PlusOutlined />,
                onClick: () => openCreateRoutine(node, 'FUNCTION')
            },
        ];
        if (dialect !== 'duckdb') {
            routineMenu.push({
                key: 'create-procedure',
                label: '新建存储过程',
                icon: <PlusOutlined />,
                onClick: () => openCreateRoutine(node, 'PROCEDURE')
            });
        }
        return routineMenu;
    }

    // Connection Tag Menu — must be BEFORE the connection check
    if (node.type === 'tag') {
        return [
            {
                key: 'edit-tag',
                label: '编辑标签',
                icon: <EditOutlined />,
                onClick: () => {
                    createTagForm.setFieldsValue({ name: node.title, connectionIds: node.dataRef.connectionIds });
                    setRenameViewTarget(node);
                    setIsCreateTagModalOpen(true);
                }
            },
            { type: 'divider' },
            {
                key: 'delete-tag',
                label: '删除标签',
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => {
                    Modal.confirm({
                        title: '确认删除',
                        content: `确定要删除标签 "${node.title}" 吗？这不会删除里面的连接。`,
                        onOk: () => {
                            removeConnectionTag(node.dataRef.id);
                        }
                    });
                }
            }
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
                    onClick: () => {
                        const connKey = String(node.key);
                        // 清除子节点的展开/已加载状态，确保刷新后重新展开时能触发 onLoadData
                        setExpandedKeys(prev => prev.filter(k => !k.toString().startsWith(`${connKey}-`)));
                        setLoadedKeys(prev => prev.filter(k => !k.toString().startsWith(`${connKey}-`)));
                        // 清除 loadingNodesRef 中残留的子节点加载标记
                        Array.from(loadingNodesRef.current).forEach(lk => {
                            if (lk.startsWith(`tables-${connKey}-`)) loadingNodesRef.current.delete(lk);
                        });
                        loadDatabases(node);
                    }
                },
                { type: 'divider' },
                {
                    key: 'new-command',
                    label: '新建命令窗口',
                    icon: <ConsoleSqlOutlined />,
                    onClick: () => {
                        addTab({
                            id: `redis-cmd-${node.key}-${Date.now()}`,
                            title: '命令 - db0',
                            type: 'redis-command',
                            connectionId: node.key,
                            redisDB: 0
                        });
                    }
                },
                {
                    key: 'open-monitor',
                    label: 'Redis 实例监控',
                    icon: <DashboardOutlined />,
                    onClick: () => {
                        addTab({
                            id: `redis-monitor-${node.key}-${Date.now()}`,
                            title: '监控 - db0',
                            type: 'redis-monitor',
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
                    key: 'copy-connection',
                    label: '复制连接',
                    icon: <CopyOutlined />,
                    onClick: () => handleDuplicateConnection(node.dataRef as SavedConnection)
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
                        closeTabsByConnection(String(node.key));
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
                            onOk: async () => {
                                const connId = String(node.key);
                                const backendApp = (window as any).go?.app?.App;
                                if (typeof backendApp?.DeleteConnection !== 'function') {
                                    message.error('删除连接失败：后端接口不可用');
                                    throw new Error('DeleteConnection unavailable');
                                }
                                try {
                                    await backendApp.DeleteConnection(connId);
                                    closeTabsByConnection(connId);
                                    removeConnection(connId);
                                    message.success('已删除连接');
                                } catch (error: any) {
                                    message.error(error?.message || '删除连接失败');
                                    throw error;
                                }
                            }
                        });
                    }
                }
            ];
        }

        // Tag submenu for connection
        const tagSubMenuItems: MenuProps['items'] = connectionTags.map(tag => ({
            key: `move-to-tag-${tag.id}`,
            label: tag.name,
            icon: <FolderOutlined />,
            onClick: () => moveConnectionToTag(node.key, tag.id)
        }));
        if (connectionTags.length > 0) {
            tagSubMenuItems.push({ type: 'divider' });
        }
        tagSubMenuItems.push({
            key: 'move-to-ungrouped',
            label: '移出标签',
            onClick: () => moveConnectionToTag(node.key, null)
        });

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
                onClick: () => {
                    const connKey = String(node.key);
                    // 清除子节点的展开/已加载状态，确保刷新后重新展开时能触发 onLoadData
                    setExpandedKeys(prev => prev.filter(k => !k.toString().startsWith(`${connKey}-`)));
                    setLoadedKeys(prev => prev.filter(k => !k.toString().startsWith(`${connKey}-`)));
                    // 清除 loadingNodesRef 中残留的子节点加载标记
                    Array.from(loadingNodesRef.current).forEach(lk => {
                        if (lk.startsWith(`tables-${connKey}-`)) loadingNodesRef.current.delete(lk);
                    });
                    loadDatabases(node);
                }
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
             {
                 key: 'open-sql-file',
                 label: '运行外部SQL文件',
                 icon: <FileAddOutlined />,
                 onClick: () => handleRunSQLFile(node)
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
                 key: 'copy-connection',
                 label: '复制连接',
                 icon: <CopyOutlined />,
                 onClick: () => handleDuplicateConnection(node.dataRef as SavedConnection)
             },
             {
                 key: 'move-to-tag',
                 label: '移至标签',
                 icon: <FolderOpenOutlined />,
                 children: tagSubMenuItems
             },
             {
                 key: 'disconnect',
                 label: '断开连接',
                 icon: <DisconnectOutlined />,
                 onClick: () => {
                     const connId = String(node.key || '');
                     // 强制清理该连接相关的 loading 标记，避免网络卡住后重连仍被短路。
                     Array.from(loadingNodesRef.current).forEach((loadingKey) => {
                         if (loadingKey === `dbs-${connId}` || loadingKey.startsWith(`tables-${connId}-`)) {
                             loadingNodesRef.current.delete(loadingKey);
                         }
                     });
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
                     closeTabsByConnection(String(node.key));
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
                         onOk: async () => {
                             const connId = String(node.key);
                             const backendApp = (window as any).go?.app?.App;
                             if (typeof backendApp?.DeleteConnection !== 'function') {
                                 message.error('删除连接失败：后端接口不可用');
                                 throw new Error('DeleteConnection unavailable');
                             }
                             try {
                                 await backendApp.DeleteConnection(connId);
                                 closeTabsByConnection(connId);
                                 removeConnection(connId);
                                 message.success('已删除连接');
                             } catch (error: any) {
                                 message.error(error?.message || '删除连接失败');
                                 throw error;
                             }
                         }
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
            },
            {
                key: 'open-monitor',
                label: 'Redis 实例监控',
                icon: <DashboardOutlined />,
                onClick: () => {
                    addTab({
                        id: `redis-monitor-${id}-db${redisDB}-${Date.now()}`,
                        title: `监控 - db${redisDB}`,
                        type: 'redis-monitor',
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
               key: 'danger-zone',
               label: '危险操作',
               icon: <WarningOutlined />,
               children: [
                   {
                       key: 'drop-db',
                       label: '删除数据库',
                       icon: <DeleteOutlined />,
                       danger: true,
                       onClick: () => handleDeleteDatabase(node)
                   }
               ]
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
                   const dbConnId = String(node.dataRef?.id || '');
                   const dbName = String(node.dataRef?.dbName || node.title || '').trim();
                   loadingNodesRef.current.delete(`tables-${dbConnId}-${dbName}`);
                   setConnectionStates(prev => {
                       const next = { ...prev };
                       delete next[node.key];
                       return next;
                   });
                   setExpandedKeys(prev => prev.filter(k => k !== node.key && !k.toString().startsWith(`${node.key}-`)));
                   setLoadedKeys(prev => prev.filter(k => k !== node.key && !k.toString().startsWith(`${node.key}-`)));
                   setTreeData(origin => updateTreeData(origin, node.key, undefined));
                   if (dbConnId && dbName) {
                       closeTabsByDatabase(dbConnId, dbName);
                   }
                   message.success("已关闭数据库");
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
                 label: '运行外部SQL文件',
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
                key: 'danger-zone',
                label: '危险操作',
                icon: <WarningOutlined />,
                children: [
                    {
                        key: 'drop-view',
                        label: '删除视图',
                        icon: <DeleteOutlined />,
                        danger: true,
                        onClick: () => handleDropView(node)
                    }
                ]
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
                key: 'danger-zone',
                label: '危险操作',
                icon: <WarningOutlined />,
                children: [
                    {
                        key: 'drop-routine',
                        label: `删除${typeLabel}`,
                        icon: <DeleteOutlined />,
                        danger: true,
                        onClick: () => handleDropRoutine(node)
                    }
                ]
            },
        ];
    } else if (node.type === 'table') {
        return [
            {
                key: 'new-query',
                label: '新建查询',
                icon: <ConsoleSqlOutlined />,
                onClick: () => {
                   const tableName = String(node.dataRef?.tableName || '').trim();
                   const queryTemplate = buildTableSelectQuery(getMetadataDialect(node.dataRef as SavedConnection), tableName);
                   addTab({
                       id: `query-${Date.now()}`,
                       title: `新建查询`,
                       type: 'query',
                       connectionId: node.dataRef.id,
                       dbName: node.dataRef.dbName,
                       query: queryTemplate
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
                key: 'danger-zone',
                label: '危险操作',
                icon: <WarningOutlined />,
                children: [
                    ...(supportsTableTruncateAction(node.dataRef?.config?.type, node.dataRef?.config?.driver) ? [{
                        key: 'truncate-table',
                        label: '截断表',
                        danger: true,
                        onClick: () => handleTableDataDangerAction(node, 'truncate')
                    }] : []),
                    {
                        key: 'clear-table',
                        label: '清空表',
                        danger: true,
                        onClick: () => handleTableDataDangerAction(node, 'clear')
                    },
                    {
                        key: 'drop-table',
                        label: '删除表',
                        icon: <DeleteOutlined />,
                        danger: true,
                        onClick: () => handleDeleteTable(node)
                    }
                ]
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
                    { key: 'export-html', label: '导出 HTML', onClick: () => handleExport(node, 'html') },
                ]
            }
        ];
    }

    // 已存查询节点的右键菜单
    if (node.type === 'saved-query') {
        const q = node.dataRef;
        return [
            {
                key: 'open-query',
                label: '打开查询',
                icon: <ConsoleSqlOutlined />,
                onClick: () => {
                    addTab({
                        id: q.id,
                        title: q.name,
                        type: 'query',
                        connectionId: q.connectionId,
                        dbName: q.dbName,
                        query: q.sql,
                        savedQueryId: q.id,
                    });
                }
            },
            { type: 'divider' },
            {
                key: 'delete-query',
                label: '删除查询',
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => {
                    Modal.confirm({
                        title: '确认删除',
                        content: `确定要删除已保存的查询 "${q.name}" 吗？此操作不可恢复。`,
                        okButtonProps: { danger: true },
                        onOk: () => {
                            deleteQuery(q.id);
                            // 从树中移除节点
                            setTreeData(origin => {
                                const removeNode = (list: TreeNode[]): TreeNode[] =>
                                    list
                                        .filter(n => n.key !== node.key)
                                        .map(n => n.children ? { ...n, children: removeNode(n.children) } : n);
                                return removeNode(origin);
                            });
                            message.success('查询已删除');
                        }
                    });
                }
            }
        ];
    }

    if (node.type === 'external-sql-root') {
        return [
            {
                key: 'add-external-sql-directory',
                label: '添加 SQL 目录',
                icon: <PlusOutlined />,
                onClick: () => {
                    void handleAddExternalSQLDirectory(node);
                }
            }
        ];
    }

    if (node.type === 'external-sql-directory') {
        return [
            {
                key: 'refresh-external-sql-directory',
                label: '刷新目录',
                icon: <ReloadOutlined />,
                onClick: () => {
                    void handleRefreshExternalSQLDirectory(node);
                }
            },
            { type: 'divider' },
            {
                key: 'remove-external-sql-directory',
                label: '移除目录',
                icon: <DeleteOutlined />,
                danger: true,
                onClick: () => {
                    void handleRemoveExternalSQLDirectory(node);
                }
            }
        ];
    }

    if (node.type === 'external-sql-file') {
        return [
            {
                key: 'open-external-sql-file',
                label: '打开 SQL 文件',
                icon: <ConsoleSqlOutlined />,
                onClick: () => {
                    void openExternalSQLFile(node);
                }
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
        <Badge status={status} style={{ marginLeft: 4, marginRight: 8 }} />
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
    } else if (node.type === 'external-sql-directory' || node.type === 'external-sql-folder' || node.type === 'external-sql-file') {
        hoverTitle = String(node?.dataRef?.path || displayTitle);
    }

    if (node.type === 'jvm-mode') {
        return (
            <span
                title={hoverTitle}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}
            >
                <JVMModeBadge
                    mode={String(node?.dataRef?.providerMode || displayTitle)}
                    label={displayTitle}
                    reason={String(node?.dataRef?.reason || '').trim() || undefined}
                />
            </span>
        );
    }

    if (node.type === 'external-sql-root') {
        return (
            <span
                title={hoverTitle}
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%' }}
            >
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {statusBadge}
                    {displayTitle}
                </span>
                <Button
                    size="small"
                    type="text"
                    icon={<PlusOutlined />}
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void handleAddExternalSQLDirectory(node);
                    }}
                    style={{ paddingInline: 4, height: 20 }}
                />
            </span>
        );
    }

    return <span title={hoverTitle}>{statusBadge}{displayTitle}</span>;
  };

  const handleDrop = (info: any) => {
      const dropKey = info.node.key;
      const dragKey = info.dragNode.key;
      const dropPos = info.node.pos.split('-');
      const dropPosition = info.dropPosition - Number(dropPos[dropPos.length - 1]);

      const dragNode = info.dragNode;
      const dropNode = info.node;

      // Tag to Tag reordering
      if (dragNode.type === 'tag') {
          // You can only drop tags onto the root level (before/after other tags or connections at root)
          if (dropNode.type === 'tag' || dropNode.type === 'connection') {
              // Get current order
              const currentTagOrder = connectionTags.map(t => t.id);
              const dragTagId = dragNode.dataRef.id;

              // Filter out the dragging tag
              const newOrder = currentTagOrder.filter(id => id !== dragTagId);

              let insertIndex = newOrder.length;
              if (dropNode.type === 'tag') {
                  const dropTagId = dropNode.dataRef.id;
                  const dropIndex = newOrder.indexOf(dropTagId);

                  if (dropPosition === -1) {
                      insertIndex = dropIndex;
                  } else {
                      insertIndex = dropIndex + 1;
                  }
              } else {
                  // Dropped onto a root connection, usually meaning moving to the end of tags
                  // Since tags are always displayed before ungrouped connections, just put it at the end
                  insertIndex = newOrder.length;
              }

              newOrder.splice(insertIndex, 0, dragTagId);
              reorderTags(newOrder);
          }
          return;
      }

      // Connection moving to tag (any drop position on a tag node counts as "into")
      if (dragNode.type === 'connection' && dropNode.type === 'tag') {
          moveConnectionToTag(dragNode.key, dropNode.dataRef.id);
          return;
      }

      // Connection moving to another connection inside a tag
      if (dragNode.type === 'connection' && dropNode.type === 'connection') {
          // Find if drop target is under a tag
          const targetTag = connectionTags.find(t => t.connectionIds.includes(dropNode.key));
          if (targetTag) {
              moveConnectionToTag(dragNode.key, targetTag.id);
              return;
          }

          // Drop target is NOT under a tag (ungrouped) -> move OUT of tag
          const sourceTag = connectionTags.find(t => t.connectionIds.includes(dragNode.key));
          if (sourceTag) {
              moveConnectionToTag(dragNode.key, null);
              return;
          }
      }
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
        <div style={{ padding: '8px 14px', borderBottom: `1px solid ${darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'}` }}>
            <Input
                {...noAutoCapInputProps}
                ref={searchInputRef}
                placeholder="搜索..."
                onChange={onSearch}
                size="small"
                prefix={<SearchOutlined style={{ color: darkMode ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)', marginRight: 4 }} />}
                style={{
                    borderRadius: 6,
                    border: 'none',
                    background: darkMode ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.03)',
                    boxShadow: 'none',
                    padding: '4px 8px',
                    color: darkMode ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)',
                }}
                suffix={
                    <Popover
                        content={searchScopePopoverContent}
                        trigger="click"
                        placement="bottomRight"
                        open={isSearchScopePopoverOpen}
                        onOpenChange={setIsSearchScopePopoverOpen}
                        styles={{ body: { padding: 0, borderRadius: 16, overflow: 'hidden' } }}
                    >
                        <Tooltip title={`搜索范围：${searchScopeSummary}`}>
                            <div
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 4,
                                    cursor: 'pointer',
                                    padding: '2px 6px',
                                    borderRadius: 4,
                                    background: isSearchScopePopoverOpen
                                        ? (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)')
                                        : 'transparent',
                                    transition: 'background 0.2s',
                                    color: searchScopes.includes('smart')
                                        ? (darkMode ? '#ffd666' : '#1677ff')
                                        : (darkMode ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)'),
                                }}
                                onMouseEnter={(e) => {
                                    if (!isSearchScopePopoverOpen) {
                                      e.currentTarget.style.background = darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)';
                                      e.currentTarget.style.color = darkMode ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.65)';
                                    }
                                }}
                                onMouseLeave={(e) => {
                                    if (!isSearchScopePopoverOpen) {
                                      e.currentTarget.style.background = 'transparent';
                                      e.currentTarget.style.color = searchScopes.includes('smart')
                                          ? (darkMode ? '#ffd666' : '#1677ff')
                                          : (darkMode ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)');
                                    }
                                }}
                            >
                                <FilterOutlined style={{ fontSize: 13 }} />
                                <span style={{ fontSize: 12, fontWeight: 500 }}>
                                    {searchScopes.includes('smart') ? '智' : searchScopes.length}
                                </span>
                            </div>
                        </Tooltip>
                    </Popover>
                }
            />
        </div>

        {/* Toolbar */}
        <div style={{ padding: '6px 16px', display: 'flex', gap: 8, justifyContent: 'space-between', borderTop: `1px solid ${darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'}`, borderBottom: `1px solid ${darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'}`, background: darkMode ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0.015)' }}>
            <Tooltip title="新建组">
                <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => { setRenameViewTarget(null); createTagForm.resetFields(); setIsCreateTagModalOpen(true); }} style={{ color: darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)' }} />
            </Tooltip>
            <Tooltip title="批量操作表">
                <Button size="small" type="text" icon={<TableOutlined />} onClick={() => openBatchOperationModal()} style={{ color: darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)' }} />
            </Tooltip>
            <Tooltip title="批量操作库">
                <Button size="small" type="text" icon={<DatabaseOutlined />} onClick={() => openBatchDatabaseModal()} style={{ color: darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)' }} />
            </Tooltip>
            <Tooltip title="运行外部SQL文件">
                <Button size="small" type="text" icon={<FileAddOutlined />} onClick={handleOpenSQLFileFromToolbar} style={{ color: darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.65)' }} />
            </Tooltip>
        </div>

        <div ref={treeContainerRef} className="sidebar-tree-scroll-shell" style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
            <div className="sidebar-tree-scroll-content">
                <Tree
                    showIcon
                    draggable={{
                        icon: false,
                        nodeDraggable: (node: any) => node.type === 'connection' || node.type === 'tag'
                    }}
                    onDrop={handleDrop}
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
            title={renderSidebarModalTitle(
                <FolderOpenOutlined />,
                renameViewTarget?.type === 'tag' ? "编辑标签" : "新建组",
                renameViewTarget?.type === 'tag' ? "调整分组名称和包含的连接。" : "为连接树创建一个更清晰的分组视图。"
            )}
            open={isCreateTagModalOpen}
            centered
            styles={{ content: modalPanelStyle, header: { background: 'transparent', borderBottom: 'none', paddingBottom: 10 }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none', paddingTop: 12 } }}
            onOk={() => {
                createTagForm.validateFields().then(values => {
                    if (renameViewTarget?.type === 'tag') {
                        // Rename
                        updateConnectionTag({
                            ...renameViewTarget.dataRef,
                            name: values.name,
                            connectionIds: values.connectionIds || []
                        });
                        // update cross-connections
                        const allOtherTagsIds = connectionTags.filter(t => t.id !== renameViewTarget.dataRef.id).flatMap(t => t.connectionIds);
                        (values.connectionIds || []).forEach((cid: string) => {
                           if (allOtherTagsIds.includes(cid)) {
                               moveConnectionToTag(cid, renameViewTarget.dataRef.id);
                           }
                        });
                    } else {
                        // Create
                        const tagId = Date.now().toString();
                        addConnectionTag({
                            id: tagId,
                            name: values.name,
                            connectionIds: values.connectionIds || []
                        });
                        (values.connectionIds || []).forEach((cid: string) => {
                            moveConnectionToTag(cid, tagId);
                        });
                    }
                    setIsCreateTagModalOpen(false);
                });
            }}
            onCancel={() => setIsCreateTagModalOpen(false)}
        >
            <Form form={createTagForm} layout="vertical">
                <div style={modalSectionStyle}>
                    <Form.Item name="name" label="标签名称" rules={[{ required: true, message: '请输入标签名称' }]}>
                        <Input placeholder="例如：线上环境 / 核心业务 / 临时调试" />
                    </Form.Item>
                    <Form.Item name="connectionIds" label="选择连接" style={{ marginBottom: 0 }}>
                        <Checkbox.Group style={{ width: '100%' }}>
                            <div style={modalScrollSectionStyle}>
                                <Space direction="vertical" style={{ width: '100%' }}>
                                    {connections.map(conn => (
                                        <Checkbox key={conn.id} value={conn.id}>
                                            {conn.name} {conn.config.host ? `(${conn.config.host})` : ''}
                                        </Checkbox>
                                    ))}
                                </Space>
                            </div>
                        </Checkbox.Group>
                    </Form.Item>
                </div>
            </Form>
        </Modal>

        <Modal
            title="新建数据库"
            open={isCreateDbModalOpen}
            onOk={handleCreateDatabase}
            onCancel={() => setIsCreateDbModalOpen(false)}
        >
            <Form form={createDbForm} layout="vertical">
                <Form.Item name="name" label="数据库名称" rules={[{ required: true, message: '请输入名称' }]}>
                    <Input {...noAutoCapInputProps} />
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
                    <Input {...noAutoCapInputProps} />
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
                    <Input {...noAutoCapInputProps} />
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
                    <Input {...noAutoCapInputProps} />
                </Form.Item>
            </Form>
        </Modal>

        <Modal
            title={renderSidebarModalTitle(<TableOutlined />, "批量操作表", "按对象批量导出结构、数据或完整备份。")}
            open={isBatchModalOpen}
            onCancel={() => setIsBatchModalOpen(false)}
            width={720}
            centered
            styles={{ content: modalPanelStyle, header: { background: 'transparent', borderBottom: 'none', paddingBottom: 10 }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none', paddingTop: 12 } }}
            footer={
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <Button key="cancel" onClick={() => setIsBatchModalOpen(false)}>
                        取消
                    </Button>
                    <Space size={8} wrap style={{ marginLeft: 'auto' }}>
                        <Button
                            key="drop-table"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={() => handleBatchDelete()}
                            disabled={selectedBatchTableNames.length === 0}
                        >
                            删除表
                        </Button>
                        <Button
                            key="clear"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={() => handleBatchClear()}
                            disabled={selectedBatchTableNames.length === 0}
                        >
                            清空数据
                        </Button>
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
            <div style={{ ...modalSectionStyle, marginBottom: 16 }}>
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
                <div style={modalHintTextStyle}>先选择连接与数据库，再决定导出范围和目标对象。</div>
            </div>

            {batchTables.length > 0 && (
                <div style={{ ...modalSectionStyle, marginBottom: 16 }}>
                    <Space wrap size={8} style={{ width: '100%' }}>
                        <Input
                            allowClear
                            value={batchFilterKeyword}
                            onChange={(e) => setBatchFilterKeyword(e.target.value)}
                            placeholder="筛选表/视图名称"
                            prefix={<SearchOutlined />}
                            style={{ width: 260 }}
                        />
                        <Select
                            value={batchFilterType}
                            onChange={(value) => setBatchFilterType(value as BatchObjectFilterType)}
                            style={{ width: 140 }}
                            options={[
                                { label: '全部对象', value: 'all' },
                                { label: '仅表', value: 'table' },
                                { label: '仅视图', value: 'view' },
                            ]}
                        />
                        <Select
                            value={batchSelectionScope}
                            onChange={(value) => setBatchSelectionScope(value as BatchSelectionScope)}
                            style={{ width: 220 }}
                            options={[
                                { label: '勾选作用于：当前筛选结果', value: 'filtered' },
                                { label: '勾选作用于：全部对象', value: 'all' },
                            ]}
                        />
                    </Space>
                    <div style={{ marginTop: 6, color: '#999', fontSize: 12 }}>
                        当前筛选命中 {filteredBatchObjects.length} / {batchTables.length} 个对象
                    </div>
                </div>
            )}

            {batchTables.length > 0 && (
                <>
                    <div style={{ ...modalSectionStyle, marginBottom: 16 }}>
                        <Space>
                            <Button
                                size="small"
                                onClick={() => handleCheckAll(true)}
                                disabled={selectionScopeTargetKeys.length === 0}
                            >
                                全选
                            </Button>
                            <Button
                                size="small"
                                onClick={() => handleCheckAll(false)}
                                disabled={selectionScopeTargetKeys.length === 0}
                            >
                                取消全选
                            </Button>
                            <Button
                                size="small"
                                onClick={handleInvertSelection}
                                disabled={selectionScopeTargetKeys.length === 0}
                            >
                                反选
                            </Button>
                            <span style={{ color: '#999' }}>
                                已选择 {checkedTableKeys.length} / {batchTables.length} 个对象
                            </span>
                        </Space>
                    </div>
                    <div style={modalScrollSectionStyle}>
                        <Checkbox.Group
                            value={checkedTableKeys}
                            onChange={(values) => setCheckedTableKeys(values as string[])}
                            style={{ width: '100%' }}
                        >
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                {groupedBatchObjects.tables.length > 0 && (
                                    <div>
                                        <div style={{ marginBottom: 6, color: darkMode ? '#bfbfbf' : '#595959', fontSize: 12 }}>
                                            表 ({groupedBatchObjects.tables.length})
                                        </div>
                                        <Space direction="vertical" style={{ width: '100%' }}>
                                            {groupedBatchObjects.tables.map(table => (
                                                <Checkbox key={table.key} value={table.key}>
                                                    <TableOutlined style={{ marginRight: 8 }} />
                                                    {table.title}
                                                </Checkbox>
                                            ))}
                                        </Space>
                                    </div>
                                )}
                                {groupedBatchObjects.views.length > 0 && (
                                    <div>
                                        <div style={{ marginBottom: 6, color: darkMode ? '#bfbfbf' : '#595959', fontSize: 12 }}>
                                            视图 ({groupedBatchObjects.views.length})
                                        </div>
                                        <Space direction="vertical" style={{ width: '100%' }}>
                                            {groupedBatchObjects.views.map(view => (
                                                <Checkbox key={view.key} value={view.key}>
                                                    <EyeOutlined style={{ marginRight: 8 }} />
                                                    {view.title}
                                                </Checkbox>
                                            ))}
                                        </Space>
                                    </div>
                                )}
                                {groupedBatchObjects.tables.length === 0 && groupedBatchObjects.views.length === 0 && (
                                    <div style={{ color: '#999', padding: '8px 0' }}>
                                        无匹配对象
                                    </div>
                                )}
                            </div>
                        </Checkbox.Group>
                    </div>
                </>
            )}
        </Modal>

        <Modal
            title={renderSidebarModalTitle(<DatabaseOutlined />, "批量操作库", "按数据库批量导出结构，或生成结构加数据的备份。")}
            open={isBatchDbModalOpen}
            onCancel={() => setIsBatchDbModalOpen(false)}
            width={640}
            centered
            styles={{ content: modalPanelStyle, header: { background: 'transparent', borderBottom: 'none', paddingBottom: 10 }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none', paddingTop: 12 } }}
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
            <div style={{ ...modalSectionStyle, marginBottom: 16 }}>
                <label style={{ display: 'block', marginBottom: 4, fontWeight: 600, color: darkMode ? '#f5f7ff' : '#162033' }}>选择连接：</label>
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
                <div style={{ ...modalHintTextStyle, marginTop: 10 }}>连接选定后会加载当前连接下可批量导出的数据库列表。</div>
            </div>

            {batchDatabases.length > 0 && (
                <>
                    <div style={{ ...modalSectionStyle, marginBottom: 16 }}>
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
                    <div style={modalScrollSectionStyle}>
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

        {/* SQL 文件流式执行进度 Modal */}
        <Modal
            title="运行外部SQL文件"
            open={sqlFileExecState.open}
            centered
            closable={sqlFileExecState.status !== 'running'}
            maskClosable={false}
            footer={sqlFileExecState.status === 'running' ? [
                <Button key="cancel" danger onClick={() => {
                    CancelSQLFileExecution(sqlFileExecState.jobId);
                    setSqlFileExecState(prev => ({ ...prev, status: 'cancelled' }));
                }}>
                    取消执行
                </Button>
            ] : [
                <Button key="close" type="primary" onClick={() => setSqlFileExecState(prev => ({ ...prev, open: false }))}>
                    关闭
                </Button>
            ]}
            onCancel={() => {
                if (sqlFileExecState.status !== 'running') {
                    setSqlFileExecState(prev => ({ ...prev, open: false }));
                }
            }}
            styles={{ content: modalPanelStyle, header: { background: 'transparent', borderBottom: 'none' }, body: { paddingTop: 8 }, footer: { background: 'transparent', borderTop: 'none' } }}
        >
            <div style={{ marginBottom: 16 }}>
                <Progress
                    percent={Math.round(sqlFileExecState.percent)}
                    status={sqlFileExecState.status === 'error' ? 'exception' : sqlFileExecState.status === 'done' ? 'success' : 'active'}
                    strokeColor={sqlFileExecState.status === 'cancelled' ? '#faad14' : undefined}
                />
            </div>
            <div style={{ fontSize: 13, lineHeight: '22px', marginBottom: 8 }}>
                <div>文件大小：<strong>{sqlFileExecState.fileSizeMB} MB</strong></div>
                <div>状态：<strong>{
                    sqlFileExecState.status === 'running' ? '执行中...' :
                    sqlFileExecState.status === 'done' ? '✅ 完成' :
                    sqlFileExecState.status === 'cancelled' ? '⚠️ 已取消' : '❌ 出错'
                }</strong></div>
                <div>已执行：<strong style={{ color: '#52c41a' }}>{sqlFileExecState.executed}</strong> 条 | 失败：<strong style={{ color: sqlFileExecState.failed > 0 ? '#ff4d4f' : undefined }}>{sqlFileExecState.failed}</strong> 条</div>
            </div>
            {sqlFileExecState.currentSQL && sqlFileExecState.status === 'running' && (
                <div style={{ fontSize: 12, color: 'rgba(128,128,128,0.8)', background: 'rgba(128,128,128,0.06)', borderRadius: 6, padding: '6px 10px', marginTop: 8, fontFamily: 'monospace', wordBreak: 'break-all', maxHeight: 60, overflow: 'hidden' }}>
                    {sqlFileExecState.currentSQL}
                </div>
            )}
            {sqlFileExecState.resultMessage && sqlFileExecState.status !== 'running' && (
                <div style={{ fontSize: 12, marginTop: 12, maxHeight: 200, overflow: 'auto', whiteSpace: 'pre-wrap', background: 'rgba(128,128,128,0.06)', borderRadius: 6, padding: '8px 12px' }}>
                    {sqlFileExecState.resultMessage}
                </div>
            )}
        </Modal>
        <FindInDatabaseModal
            open={findInDbContext.open}
            onClose={() => setFindInDbContext({ open: false, connectionId: '', dbName: '' })}
            connectionId={findInDbContext.connectionId}
            dbName={findInDbContext.dbName}
        />
    </div>
  );
};

export default Sidebar;
