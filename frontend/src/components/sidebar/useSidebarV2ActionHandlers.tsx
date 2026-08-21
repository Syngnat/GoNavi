import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { message } from 'antd';
import type { FormInstance } from 'antd/es/form';

import Modal from '../common/ResizableDraggableModal';
import { t } from '../../i18n';
import type { ConnectionTag, SavedConnection } from '../../types';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { resolveConnectionAccentColor, resolveConnectionIconType } from '../../utils/connectionVisual';
import {
  buildTableSelectQuery,
  isElasticsearchDbType,
  resolveTableSelectQuery,
} from '../../utils/objectQueryTemplates';
import { DBReleaseConnection } from '../../../wailsjs/go/app/App';
import { updateSidebarDatabasePinKeys } from '../../store';
import { getDbIcon } from '../DatabaseIcons';
import { getMetadataDialect } from './sidebarMetadataLoaders';
import {
  type V2DatabaseContextMenuActionKey,
  type V2ConnectionGroupContextMenuActionKey,
  type V2ConnectionContextMenuActionKey,
  type V2TableContextMenuActionKey,
  type V2TableGroupContextMenuActionKey,
} from '../V2TableContextMenu';
import {
  applySidebarDatabasePinning,
  buildV2SidebarDatabaseSectionedChildren,
  isSidebarDatabasePinned,
  isSidebarTablePinned,
  type SidebarConnectionState,
  type SidebarTreeNode as TreeNode,
  type V2RailConnectionGroup,
} from '../sidebarV2Utils';
import type { SidebarTreeLoadOptions } from './useSidebarTreeLoaders';

type UseSidebarV2ActionHandlersArgs = {
  connections: SavedConnection[];
  connectionTags: ConnectionTag[];
  pinnedSidebarTables: any[];
  pinnedSidebarDatabases: string[];
  loadingNodesRef: MutableRefObject<Set<string>>;
  treeDataRef: MutableRefObject<TreeNode[]>;
  refreshConnectionResources: (node: any) => Promise<void>;
  findTreeNodeByKeyRef: MutableRefObject<(nodes: TreeNode[], targetKey: React.Key) => TreeNode | null>;
  refreshV2TableContextMenuStatsRef: MutableRefObject<(node: any) => void>;
  setConnectionStates: Dispatch<SetStateAction<Record<string, SidebarConnectionState>>>;
  setExpandedKeys: Dispatch<SetStateAction<React.Key[]>>;
  setLoadedKeys: Dispatch<SetStateAction<React.Key[]>>;
  setTargetConnection: Dispatch<SetStateAction<any>>;
  setIsCreateDbModalOpen: Dispatch<SetStateAction<boolean>>;
  setRenameDbTarget: Dispatch<SetStateAction<any>>;
  setIsRenameDbModalOpen: Dispatch<SetStateAction<boolean>>;
  setRenameTableTarget: Dispatch<SetStateAction<any>>;
  setIsRenameTableModalOpen: Dispatch<SetStateAction<boolean>>;
  setRenameViewTarget: Dispatch<SetStateAction<any>>;
  setIsCreateTagModalOpen: Dispatch<SetStateAction<boolean>>;
  renameDbForm: FormInstance;
  renameTableForm: FormInstance;
  createTagForm: FormInstance;
  addTab: (tab: any) => void;
  closeTabsByDatabase: (connectionId: string, dbName: string) => void;
  closeTabsByConnection: (connectionId: string) => void;
  removeConnection: (connectionId: string) => void;
  removeConnectionTag: (tagId: string) => void;
  moveConnectionToTag: (connectionId: string, tagId: string | null) => void;
  setSidebarTablePinned: (connectionId: string, dbName: string, tableName: string, schemaName: string, pinned: boolean) => void;
  setSidebarDatabasePinned: (connectionId: string, dbName: string, pinned: boolean) => void;
  setTableSortPreference: (connectionId: string, dbName: string, sortBy: 'name' | 'frequency') => void;
  replaceTreeNodeChildren: (key: React.Key, children: TreeNode[] | undefined) => void;
  loadDatabases: (node: any, options?: SidebarTreeLoadOptions) => Promise<void>;
  loadTables: (node: any, options?: SidebarTreeLoadOptions) => Promise<void>;
  getDatabaseNodeRef: (connRef: any, dbName: string) => any;
  extractObjectName: (fullName: string) => string;
  openDesign: (node: any, initialTab: string, readOnly?: boolean) => void;
  openNewTableDesign: (node: any) => void;
  onDoubleClick: (event: any, node: any) => void;
  openMessagePublishModal: (node: any) => void;
  openTableDdlInDesigner: (node: any) => void;
  openTableInERView: (node: any) => void;
  handleCopyTableName: (node: any) => Promise<void>;
  handleCopyTable: (node: any) => void;
  handleCopyDatabaseName: (node: any) => Promise<void>;
  handleCopyStructure: (node: any) => Promise<void>;
  handleCopyTableAsInsert: (node: any) => Promise<void>;
  openCreateStarRocksRollup: (node: any) => void;
  handleExport: (node: any, options: { format: string; xlsxMaxRowsPerSheet?: number }) => Promise<void>;
  openExportDialog: (node: any) => Promise<void>;
  injectTablePromptToAI: (node: any, promptKind: 'explain' | 'query') => Promise<void>;
  handleTableDataDangerAction: (node: any, action: 'truncate' | 'clear') => Promise<void>;
  handleDeleteTable: (node: any) => void;
  openCreateSchemaModal: (node: any) => void;
  openCreateStarRocksMaterializedView: (node: any) => void;
  openCreateStarRocksExternalCatalog: (node: any) => void;
  handleExportDatabaseSQL: (node: any, includeData: boolean) => Promise<void>;
  openBatchTableWorkbench: (node?: any) => void;
  openBatchDatabaseWorkbench: (node?: any) => void;
  handleRunSQLFile: (node: any) => void;
  handleDeleteDatabase: (node: any) => void;
  onCreateConnectionInGroup?: (targetTagId: string) => void;
  onOpenConnectionHealthForGroup?: (tagId: string) => void;
  onEditConnection?: (conn: SavedConnection) => void;
  handleDuplicateConnection: (conn: SavedConnection) => Promise<void>;
  buildConnectionRootQueryTabTitle: () => string;
  buildConnectionRootRedisCommandTabTitle: (redisDbLabel?: string) => string;
  buildConnectionRootRedisMonitorTabTitle: (redisDbLabel?: string) => string;
};

export const useSidebarV2ActionHandlers = ({
  connections,
  connectionTags,
  pinnedSidebarTables,
  pinnedSidebarDatabases,
  loadingNodesRef,
  treeDataRef,
  refreshConnectionResources,
  findTreeNodeByKeyRef,
  refreshV2TableContextMenuStatsRef,
  setConnectionStates,
  setExpandedKeys,
  setLoadedKeys,
  setTargetConnection,
  setIsCreateDbModalOpen,
  setRenameDbTarget,
  setIsRenameDbModalOpen,
  setRenameTableTarget,
  setIsRenameTableModalOpen,
  setRenameViewTarget,
  setIsCreateTagModalOpen,
  renameDbForm,
  renameTableForm,
  createTagForm,
  addTab,
  closeTabsByDatabase,
  closeTabsByConnection,
  removeConnection,
  removeConnectionTag,
  moveConnectionToTag,
  setSidebarTablePinned,
  setSidebarDatabasePinned,
  setTableSortPreference,
  replaceTreeNodeChildren,
  loadDatabases,
  loadTables,
  getDatabaseNodeRef,
  extractObjectName,
  openDesign,
  openNewTableDesign,
  onDoubleClick,
  openMessagePublishModal,
  openTableDdlInDesigner,
  openTableInERView,
  handleCopyTableName,
  handleCopyTable,
  handleCopyDatabaseName,
  handleCopyStructure,
  handleCopyTableAsInsert,
  openCreateStarRocksRollup,
  handleExport,
  openExportDialog,
  injectTablePromptToAI,
  handleTableDataDangerAction,
  handleDeleteTable,
  openCreateSchemaModal,
  openCreateStarRocksMaterializedView,
  openCreateStarRocksExternalCatalog,
  handleExportDatabaseSQL,
  openBatchTableWorkbench,
  openBatchDatabaseWorkbench,
  handleRunSQLFile,
  handleDeleteDatabase,
  onCreateConnectionInGroup,
  onOpenConnectionHealthForGroup,
  onEditConnection,
  handleDuplicateConnection,
  buildConnectionRootQueryTabTitle,
  buildConnectionRootRedisCommandTabTitle,
  buildConnectionRootRedisMonitorTabTitle,
}: UseSidebarV2ActionHandlersArgs) => {
  const handleV2TableContextMenuAction = (node: any, action: V2TableContextMenuActionKey) => {
    switch (action) {
      case 'pin-table':
      case 'unpin-table': {
        toggleSidebarTablePinned(node, action === 'pin-table');
        return;
      }
      case 'open-data':
      case 'open-new-tab':
        onDoubleClick(null, node);
        return;
      case 'design-table':
        openDesign(node, 'columns', false);
        return;
      case 'new-query': {
        void (async () => {
          const tableName = String(node.dataRef?.tableName || '').trim();
          const dbType = getMetadataDialect(node.dataRef as SavedConnection);
          const queryTemplate = await resolveTableSelectQuery({
            dbType,
            tableName,
            dbName: String(node.dataRef?.dbName || ''),
            connectionConfig: node.dataRef?.config,
          });
          addTab({
            id: `query-${Date.now()}`,
            title: t('query.new'),
            type: 'query',
            connectionId: node.dataRef.id,
            dbName: node.dataRef.dbName,
            query: queryTemplate,
          });
        })();
        return;
      }
      case 'publish-message':
        openMessagePublishModal(node);
        return;
      case 'view-ddl':
        openTableDdlInDesigner(node);
        return;
      case 'view-er':
        openTableInERView(node);
        return;
      case 'copy-table-name':
        void handleCopyTableName(node);
        return;
      case 'copy-structure':
        void handleCopyStructure(node);
        return;
      case 'copy-table':
        handleCopyTable(node);
        return;
      case 'copy-insert':
        void handleCopyTableAsInsert(node);
        return;
      case 'rename-table':
        setRenameTableTarget(node);
        renameTableForm.setFieldsValue({ newName: extractObjectName(node.dataRef?.tableName || node.title) });
        setIsRenameTableModalOpen(true);
        return;
      case 'new-rollup':
        openCreateStarRocksRollup(node);
        return;
      case 'backup-table':
        void handleExport(node, { format: 'sql' });
        return;
      case 'refresh-stats':
        refreshV2TableContextMenuStatsRef.current(node);
        return;
      case 'export-data':
        void openExportDialog(node);
        return;
      case 'batch-tables':
        openBatchTableWorkbench(node);
        return;
      case 'ai-explain':
        void injectTablePromptToAI(node, 'explain');
        return;
      case 'ai-generate-query':
        void injectTablePromptToAI(node, 'query');
        return;
      case 'truncate-table':
        void handleTableDataDangerAction(node, 'truncate');
        return;
      case 'drop-table':
        handleDeleteTable(node);
        return;
      default:
        return;
    }
  };

  const toggleSidebarTablePinned = (node: any, pinned?: boolean) => {
    const conn = node?.dataRef || {};
    const tableName = String(conn.tableName || node?.title || '').trim();
    const dbName = String(conn.dbName || '').trim();
    if (!conn.id || !dbName || !tableName) return;
    const currentlyPinned = isSidebarTablePinned(
      pinnedSidebarTables,
      String(conn.id || ''),
      dbName,
      tableName,
      String(conn.schemaName || ''),
    );
    const shouldPin = pinned ?? !currentlyPinned;
    setSidebarTablePinned(conn.id, dbName, tableName, conn.schemaName || '', shouldPin);
    void loadTables(getDatabaseNodeRef(conn, dbName), { ensureFresh: true });
    message.success(shouldPin ? t('sidebar.message.table_pinned') : t('sidebar.message.table_unpinned'));
  };

  const toggleSidebarDatabasePinned = (node: any, pinned?: boolean) => {
    const conn = node?.dataRef || {};
    const connectionId = String(conn.id || '').trim();
    const dbName = String(conn.dbName || node?.title || '').trim();
    if (!connectionId || !dbName) return;
    const currentlyPinned = isSidebarDatabasePinned(
      pinnedSidebarDatabases,
      connectionId,
      dbName,
    );
    const shouldPin = pinned ?? !currentlyPinned;
    const nextPinnedSidebarDatabases = updateSidebarDatabasePinKeys(
      pinnedSidebarDatabases,
      connectionId,
      dbName,
      shouldPin,
    );
    setSidebarDatabasePinned(connectionId, dbName, shouldPin);

    const connectionNode = findTreeNodeByKeyRef.current(treeDataRef.current, connectionId);
    if (connectionNode?.children?.length) {
      replaceTreeNodeChildren(
        connectionId,
        buildV2SidebarDatabaseSectionedChildren(
          connectionId,
          applySidebarDatabasePinning(
            connectionNode.children,
            { connectionId, pinnedSidebarDatabases: nextPinnedSidebarDatabases },
          ),
        ),
      );
    } else {
      const latestConnection = connections.find((candidate) => candidate.id === connectionId);
      void loadDatabases({ key: connectionId, dataRef: latestConnection || conn });
    }
    message.success(shouldPin
      ? t('sidebar.message.database_pinned')
      : t('sidebar.message.database_unpinned'));
  };

  const handleTableGroupSortAction = (node: any, sortBy: 'name' | 'frequency') => {
    const groupData = node.dataRef;
    setTableSortPreference(groupData.id, groupData.dbName, sortBy);
    const dbNode = {
      key: `${groupData.id}-${groupData.dbName}`,
      dataRef: groupData,
    };
    loadTables(dbNode, { ensureFresh: true });
  };

  const handleTableGroupRefreshAction = (node: any) => {
    const groupData = node.dataRef;
    if (!groupData?.id || !groupData?.dbName) return;
    const dbNode = {
      key: `${groupData.id}-${groupData.dbName}`,
      dataRef: groupData,
    };
    void loadTables(dbNode);
  };

  const handleV2TableGroupContextMenuAction = (node: any, action: V2TableGroupContextMenuActionKey) => {
    switch (action) {
      case 'new-table':
        openNewTableDesign(node);
        return;
      case 'refresh':
        handleTableGroupRefreshAction(node);
        return;
      case 'sort-by-name':
        handleTableGroupSortAction(node, 'name');
        return;
      case 'sort-by-frequency':
        handleTableGroupSortAction(node, 'frequency');
        return;
      default:
        return;
    }
  };

  const closeDatabaseNode = (node: any) => {
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
    replaceTreeNodeChildren(node.key, undefined);
    if (dbConnId && dbName) {
      closeTabsByDatabase(dbConnId, dbName);
    }
    message.success(t('sidebar.message.database_closed'));
  };

  const openDatabaseQuery = (node: any) => {
    const dbName = String(node.dataRef?.dbName || node.title || '').trim();
    const dbType = getMetadataDialect(node.dataRef as SavedConnection);
    addTab({
      id: `query-${Date.now()}`,
      title: t('sidebar.tab.new_query_database', { database: node.title }),
      type: 'query',
      connectionId: node.dataRef.id,
      dbName,
      query: isElasticsearchDbType(dbType)
        ? buildTableSelectQuery(dbType, dbName)
        : '',
    });
  };

  const handleV2DatabaseContextMenuAction = (node: any, action: V2DatabaseContextMenuActionKey) => {
    switch (action) {
      case 'pin-database':
      case 'unpin-database':
        toggleSidebarDatabasePinned(node, action === 'pin-database');
        return;
      case 'copy-database-name':
        void handleCopyDatabaseName(node);
        return;
      case 'new-table':
        openNewTableDesign(node);
        return;
      case 'new-schema':
        openCreateSchemaModal(node);
        return;
      case 'new-materialized-view':
        openCreateStarRocksMaterializedView(node);
        return;
      case 'new-external-catalog':
        openCreateStarRocksExternalCatalog(node);
        return;
      case 'rename-db':
        setRenameDbTarget(node);
        renameDbForm.setFieldsValue({ newName: node.dataRef?.dbName || '' });
        setIsRenameDbModalOpen(true);
        return;
      case 'refresh':
        loadTables(node, { ensureFresh: true });
        return;
      case 'export-db-schema':
        void handleExportDatabaseSQL(node, false);
        return;
      case 'backup-db-sql':
        void handleExportDatabaseSQL(node, true);
        return;
      case 'batch-tables':
        openBatchTableWorkbench(node);
        return;
      case 'batch-databases':
        openBatchDatabaseWorkbench(node);
        return;
      case 'disconnect-db':
        closeDatabaseNode(node);
        return;
      case 'new-query':
        openDatabaseQuery(node);
        return;
      case 'run-sql':
        handleRunSQLFile(node);
        return;
      case 'drop-db':
        handleDeleteDatabase(node);
        return;
      default:
        return;
    }
  };

  const releaseConnectionResources = async (conn: SavedConnection | undefined) => {
    if (!conn?.config) return;
    const res = await DBReleaseConnection(buildRpcConnectionConfig(conn.config, { id: conn.id }) as any);
    if (res && res.success === false) {
      throw new Error(String(res.message || '').trim());
    }
  };

  const disconnectConnectionNode = async (node: any) => {
    const connKey = String(node?.key || node?.dataRef?.id || '');
    if (!connKey) return;
    const conn = (connections.find((item) => item.id === connKey) || node?.dataRef) as SavedConnection | undefined;
    Array.from(loadingNodesRef.current).forEach((loadingKey) => {
      if (loadingKey === `dbs-${connKey}` || loadingKey.startsWith(`tables-${connKey}-`)) {
        loadingNodesRef.current.delete(loadingKey);
      }
    });
    setConnectionStates(prev => {
      const next = { ...prev };
      Object.keys(next).forEach(k => {
        if (k === connKey || k.startsWith(`${connKey}-`)) {
          delete next[k];
        }
      });
      return next;
    });
    setExpandedKeys(prev => prev.filter(k => k !== connKey && !k.toString().startsWith(`${connKey}-`)));
    setLoadedKeys(prev => prev.filter(k => k !== connKey && !k.toString().startsWith(`${connKey}-`)));
    replaceTreeNodeChildren(connKey, undefined);
    closeTabsByConnection(connKey);
    try {
      await releaseConnectionResources(conn);
    } catch (error: any) {
      message.warning(String(error?.message || '').trim() || t('sidebar.message.connection_release_failed_from_sidebar'));
    }
    message.success(t('connection.sidebar.disconnect.success'));
  };

  const deleteConnectionNode = (node: any) => {
    Modal.confirm({
      title: t('connection.sidebar.delete.confirmTitle'),
      content: t('connection.sidebar.delete.confirmContent', { name: node.title }),
      onOk: async () => {
        const connId = String(node.key);
        const backendApp = (window as any).go?.app?.App;
        if (typeof backendApp?.DeleteConnection !== 'function') {
          message.error(t('connection.sidebar.delete.backendUnavailable'));
          throw new Error('DeleteConnection unavailable');
        }
        try {
          await backendApp.DeleteConnection(connId);
          closeTabsByConnection(connId);
          removeConnection(connId);
          message.success(t('connection.sidebar.delete.success'));
        } catch (error: any) {
          message.error(error?.message || t('connection.sidebar.delete.failureFallback'));
          throw error;
        }
      },
    });
  };

  const createConnectionTreeNode = (conn: SavedConnection): TreeNode => ({
    title: conn.name,
    key: conn.id,
    icon: getDbIcon(resolveConnectionIconType(conn), resolveConnectionAccentColor(conn), 22),
    type: 'connection',
    dataRef: conn,
    isLeaf: false,
  });

  const getConnectionNodeForAction = (conn: SavedConnection): TreeNode => {
    return findTreeNodeByKeyRef.current(treeDataRef.current, conn.id) || createConnectionTreeNode(conn);
  };

  const handleV2ConnectionContextMenuAction = (node: any, action: V2ConnectionContextMenuActionKey) => {
    const connId = String(node?.key || node?.dataRef?.id || '');
    if (!connId) return;
    switch (action) {
      case 'new-db':
        setTargetConnection(node);
        setIsCreateDbModalOpen(true);
        return;
      case 'refresh':
        void refreshConnectionResources(node);
        return;
      case 'new-query':
        addTab({
          id: `query-${Date.now()}`,
          title: buildConnectionRootQueryTabTitle(),
          type: 'query',
          connectionId: connId,
          dbName: undefined,
          query: '',
        });
        return;
      case 'open-sql-file':
        handleRunSQLFile(node);
        return;
      case 'new-command':
        addTab({
          id: `redis-cmd-${connId}-${Date.now()}`,
          title: buildConnectionRootRedisCommandTabTitle(),
          type: 'redis-command',
          connectionId: connId,
          redisDB: 0,
        });
        return;
      case 'open-monitor':
        addTab({
          id: `redis-monitor-${connId}-${Date.now()}`,
          title: buildConnectionRootRedisMonitorTabTitle(),
          type: 'redis-monitor',
          connectionId: connId,
          redisDB: 0,
        });
        return;
      case 'edit':
        if (onEditConnection) onEditConnection(node.dataRef);
        return;
      case 'copy-connection':
        void handleDuplicateConnection(node.dataRef as SavedConnection);
        return;
      case 'disconnect':
        void disconnectConnectionNode(node);
        return;
      case 'delete':
        deleteConnectionNode(node);
        return;
      case 'move-to-ungrouped':
        moveConnectionToTag(connId, null);
        return;
      default:
        if (action.startsWith('move-to-tag:')) {
          moveConnectionToTag(connId, action.slice('move-to-tag:'.length));
        }
    }
  };

  const handleV2ConnectionGroupContextMenuAction = (group: V2RailConnectionGroup, action: V2ConnectionGroupContextMenuActionKey) => {
    const tag = connectionTags.find((item) => item.id === group.id);
    if (!tag) return;
    if (action === 'new-connection') {
      onCreateConnectionInGroup?.(tag.id);
      return;
    }
    if (action === 'connection-health') {
      onOpenConnectionHealthForGroup?.(tag.id);
      return;
    }
    if (action === 'new-subgroup') {
      createTagForm.resetFields();
      createTagForm.setFieldsValue({
        parentTagId: tag.id,
        connectionIds: [],
      });
      setRenameViewTarget(null);
      setIsCreateTagModalOpen(true);
      return;
    }
    if (action === 'edit-group') {
      createTagForm.setFieldsValue({
        name: tag.name,
        parentTagId: tag.parentTagId,
        connectionIds: tag.connectionIds,
      });
      setRenameViewTarget({
        title: tag.name,
        key: `tag-${tag.id}`,
        type: 'tag',
        dataRef: tag,
      });
      setIsCreateTagModalOpen(true);
      return;
    }
    if (action === 'delete-group') {
      Modal.confirm({
        title: t('connection.sidebar.group.deleteConfirmTitle'),
        content: t('connection.sidebar.group.deleteConfirmContent', { name: tag.name }),
        onOk: () => {
          removeConnectionTag(tag.id);
        },
      });
    }
  };

  return {
    getConnectionNodeForAction,
    handleV2TableContextMenuAction,
    handleTableGroupSortAction,
    handleV2TableGroupContextMenuAction,
    handleV2DatabaseContextMenuAction,
    disconnectConnectionNode,
    deleteConnectionNode,
    handleV2ConnectionContextMenuAction,
    handleV2ConnectionGroupContextMenuAction,
  };
};
