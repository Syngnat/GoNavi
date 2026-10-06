import {
  hasSidebarLazyChildren,
  clearSidebarHostConnectionState,
  isV2SidebarObjectNode,
  resolveSidebarTitlebarObjectName,
  resolveSidebarDoubleClickExpandedKeys,
  shouldLoadSidebarNodeOnExpand,
} from './sidebarHelpers';
import {
  type SidebarTreeNode as TreeNode,
  shouldSkipSidebarSelectWhileDragging,
  resolveSidebarNodeConnectionId,
  shouldClearSidebarNodeChildrenOnCollapse,
  collectSidebarSubtreeKeys,
  shouldSkipSidebarLoadOnExpandWhileDragging,
  resolveNacosServicesDoubleClickAction,
} from '../sidebarV2Utils';
import { t } from '../../i18n';
import { GnFieldsIcon, GnIndexIcon, GnLinkIcon } from '../icons/gnIcons';
import { renderSidebarObjectIcon } from './sidebarObjectIcons';
import { useSidebarTreeLoaders } from './useSidebarTreeLoaders';
import { resolveDataSourceType } from '../../utils/dataSourceCapabilities';
import { isConnectionStructureEditRestricted } from '../../utils/connectionReadOnly';
import { message } from 'antd';
import { tryOpenSidebarObjectNode } from './sidebarOpenObjectNode';
import { buildOptionalSchemaContext } from './sidebarRootHelpers';
import { useSidebarObjectActions } from './useSidebarObjectActions';
import React from 'react';
import * as sidebarTreeDrag from './sidebarTreeDragOrder';
import { SavedConnection } from '../../types';
import type { SidebarTreeDataApi } from './useSidebarTreeData';
import type { SidebarStoreStateApi } from './useSidebarStoreState';
import type { SidebarSearchStateApi } from './useSidebarSearchState';
import type { SidebarTreeViewStateApi } from './useSidebarTreeViewState';
import type { SidebarTitlebarSyncApi } from './useSidebarTitlebarSync';
import { isElasticsearchFamilyType } from '../../utils/elasticsearchFamily';
import { prefetchTableOpenMetadata } from '../../utils/tableOpenPrefetch';

export interface UseSidebarTreeEventsInput {
  loadDatabases: ReturnType<typeof useSidebarTreeLoaders>['loadDatabases'];
  loadJVMResources: ReturnType<typeof useSidebarTreeLoaders>['loadJVMResources'];
  loadTables: ReturnType<typeof useSidebarTreeLoaders>['loadTables'];
  loadNacosConfigGroups: ReturnType<typeof useSidebarTreeLoaders>['loadNacosConfigGroups'];
  loadNacosServiceGroups: ReturnType<typeof useSidebarTreeLoaders>['loadNacosServiceGroups'];
  refreshGlobalExternalSQLRootNode: SidebarTreeDataApi['refreshGlobalExternalSQLRootNode'];
  replaceTreeNodeChildren: SidebarTreeDataApi['replaceTreeNodeChildren'];
  connections: SidebarStoreStateApi['connections'];
  addTab: SidebarStoreStateApi['addTab'];
  openEventDefinition: ReturnType<typeof useSidebarObjectActions>['openEventDefinition'];
  openSequenceDefinition: ReturnType<typeof useSidebarObjectActions>['openSequenceDefinition'];
  openPackageDefinition: ReturnType<typeof useSidebarObjectActions>['openPackageDefinition'];
  openMessageQueueWorkbench: ReturnType<typeof useSidebarObjectActions>['openMessageQueueWorkbench'];
  selectedSidebarKeyRef: SidebarSearchStateApi['selectedSidebarKeyRef'];
  setConnectionStates: SidebarTreeViewStateApi['setConnectionStates'];
  resolveSidebarSelectionContext: SidebarTitlebarSyncApi['resolveSidebarSelectionContext'];
  publishTitlebarSnapshotUpdate: SidebarTitlebarSyncApi['publishTitlebarSnapshotUpdate'];
  treeDragSelectSuppressUntilRef: SidebarSearchStateApi['treeDragSelectSuppressUntilRef'];
  isTreeDragging: SidebarTreeViewStateApi['isTreeDragging'];
  setSidebarSelectedKeys: SidebarSearchStateApi['setSidebarSelectedKeys'];
  selectedNodesRef: SidebarSearchStateApi['selectedNodesRef'];
  publishTitlebarSelection: SidebarTitlebarSyncApi['publishTitlebarSelection'];
  connectionIds: SidebarSearchStateApi['connectionIds'];
  publishTitlebarSelectionForNode: SidebarTitlebarSyncApi['publishTitlebarSelectionForNode'];
  setActiveContext: SidebarStoreStateApi['setActiveContext'];
  clickTimerRef: SidebarSearchStateApi['clickTimerRef'];
  sidebarTreeDragNodeRef: SidebarTreeViewStateApi['sidebarTreeDragNodeRef'];
  setExpandedKeys: SidebarTreeViewStateApi['setExpandedKeys'];
  setAutoExpandParent: SidebarSearchStateApi['setAutoExpandParent'];
  clearTreeNodeChildrenByKeys: SidebarTreeDataApi['clearTreeNodeChildrenByKeys'];
  recordTableAccess: SidebarStoreStateApi['recordTableAccess'];
  tableDoubleClickAction: SidebarSearchStateApi['tableDoubleClickAction'];
  resolveSavedQueryDisplayName: (name: string | null | undefined) => string;
  openExternalSQLFile: SidebarTreeDataApi['openExternalSQLFile'];
  openJVMOverviewTab: (conn: SavedConnection, providerMode: string) => void;
  openJVMResourceTab: (conn: SavedConnection, providerMode: string, resourcePath: string, resourceKind?: string) => void;
  openJVMMonitoringTab: (conn: SavedConnection, providerMode: string) => void;
  openJVMDiagnosticTab: (conn: SavedConnection) => void;
  expandedKeys: SidebarSearchStateApi['expandedKeys'];
}

export const useSidebarTreeEvents = ({
  loadDatabases, loadJVMResources, loadTables, loadNacosConfigGroups, loadNacosServiceGroups,
  refreshGlobalExternalSQLRootNode, replaceTreeNodeChildren, connections, addTab,
  openEventDefinition, openSequenceDefinition, openPackageDefinition, openMessageQueueWorkbench,
  selectedSidebarKeyRef, setConnectionStates, resolveSidebarSelectionContext,
  publishTitlebarSnapshotUpdate, treeDragSelectSuppressUntilRef, isTreeDragging,
  setSidebarSelectedKeys, selectedNodesRef, publishTitlebarSelection, connectionIds,
  publishTitlebarSelectionForNode, setActiveContext, clickTimerRef, sidebarTreeDragNodeRef,
  setExpandedKeys, setAutoExpandParent, clearTreeNodeChildrenByKeys, recordTableAccess,
  tableDoubleClickAction, resolveSavedQueryDisplayName, openExternalSQLFile, openJVMOverviewTab,
  openJVMResourceTab, openJVMMonitoringTab, openJVMDiagnosticTab, expandedKeys,
}: UseSidebarTreeEventsInput) => {
  const onLoadData = async ({ key, children, dataRef, type }: any) => {
    if (type === 'tag' || type === 'all-saved-queries' || type === 'saved-query-group' || type === 'saved-query-manual-group' || type === 'unmatched-saved-queries') return;
    if (hasSidebarLazyChildren(children)) return;

    if (type === 'connection') {
        await loadDatabases({ key, dataRef });
    } else if (type === 'jvm-mode' || type === 'jvm-resource') {
        await loadJVMResources({ key, dataRef });
    } else if (type === 'database' || type === 'message-namespace') {
        await loadTables({ key, dataRef });
    } else if (type === 'nacos-config-entry') {
        await loadNacosConfigGroups({ key, dataRef });
    } else if (type === 'nacos-services-entry') {
        await loadNacosServiceGroups({ key, dataRef });
    } else if (type === 'external-sql-root') {
        await refreshGlobalExternalSQLRootNode(false);
    } else if (type === 'table') {
        // Expand table to show object categories
        const conn = dataRef;

        const folders: TreeNode[] = [
            {
                title: t('sidebar.table_folder.columns'),
                key: `${key}-columns`,
                icon: <GnFieldsIcon />,
                type: 'folder-columns',
                isLeaf: true,
                dataRef: conn
            },
            {
                title: t('sidebar.table_folder.indexes'),
                key: `${key}-indexes`,
                icon: <GnIndexIcon />,
                type: 'folder-indexes',
                isLeaf: true,
                dataRef: conn
            },
            {
                title: t('sidebar.table_folder.foreign_keys'),
                key: `${key}-fks`,
                icon: <GnLinkIcon />,
                type: 'folder-fks',
                isLeaf: true,
                dataRef: conn
            },
            {
                title: t('sidebar.table_folder.triggers'),
                key: `${key}-triggers`,
                icon: renderSidebarObjectIcon('trigger'),
                type: 'folder-triggers',
                isLeaf: true,
                dataRef: conn
            }
        ];

        replaceTreeNodeChildren(key, folders);
    }
  };

  const isStructureOnlyDbType = (connectionId: string): boolean => {
      const conn = connections.find(c => c.id === connectionId);
      if (!conn) return false;
      const dbType = resolveDataSourceType(conn.config);
      return isElasticsearchFamilyType(dbType) || dbType === 'mongodb' || dbType === 'redis' || dbType === 'iotdb';
  };

  const openDesign = (node: any, initialTab: string, readOnly: boolean = false) => {
      const { tableName, dbName, id, schemaName } = node.dataRef;
      const conn = connections.find(c => c.id === id);
      const forceReadOnly = readOnly
          || isStructureOnlyDbType(id)
          || isConnectionStructureEditRestricted(conn?.config);
      addTab({
          id: `design-${id}-${dbName}-${schemaName || 'default'}-${tableName}`,
          title: forceReadOnly
              ? t('sidebar.tab.table_structure', { table: tableName })
              : t('sidebar.tab.design_table', { table: tableName }),
          type: 'design',
          connectionId: id,
          dbName: dbName,
          tableName: tableName,
          schemaName,
          initialTab: initialTab,
          readOnly: forceReadOnly
      });
  };

  const openNewTableDesign = (node: any) => {
      const { dbName, id, schemaName } = node.dataRef;
      const conn = connections.find(c => c.id === id);
      if (isStructureOnlyDbType(id) || isConnectionStructureEditRestricted(conn?.config)) {
          message.warning(t('sidebar.message.visual_new_table_unsupported'));
          return;
      }
      addTab({
          id: `new-table-${id}-${dbName}-${Date.now()}`,
          title: t('sidebar.tab.new_table', { database: dbName }),
          type: 'design',
          connectionId: id,
          dbName: dbName,
          tableName: '', // Empty tableName signals creation mode
          schemaName,
          initialTab: 'columns',
          readOnly: false
      });
  };

  const openSidebarObjectNode = (node: any): boolean => tryOpenSidebarObjectNode(node, {
      addTab,
      openEventDefinition,
      openSequenceDefinition,
      openPackageDefinition,
      t,
      buildOptionalSchemaContext,
  });

  const openMessageObjectNode = (node: any): boolean => {
      if (node?.type !== 'message-object') return false;
      openMessageQueueWorkbench(node, 'open');
      return true;
  };

  const clearStaleHostStateOnSelection = (node: any): void => {
      if (node?.type !== 'connection') return;
      const connectionId = String(node.key || node.dataRef?.id || '').trim();
      if (!connectionId) return;

      // The rail and command-search paths call this before writing the tree
      // selection. Register the row first so a queued update from the prior
      // Host cannot repaint the title bar after this selection.
      selectedSidebarKeyRef.current = String(node.key || connectionId).trim();

      // Selecting a Host is a navigation action, not a connection-health
      // assertion. Clear only a previous success/error result. If an
      // explicit expansion/reconnect is already loading, keep that request
      // and its loading state so the title bar stays in lockstep with the
      // Host row instead of cancelling the in-flight probe.
      setConnectionStates((previous) => clearSidebarHostConnectionState(previous, connectionId));
      const selection = resolveSidebarSelectionContext(node);
      publishTitlebarSnapshotUpdate((snapshot) => ({
          ...snapshot,
          selection,
          connectionStates: clearSidebarHostConnectionState(
              snapshot.connectionStates,
              connectionId,
          ),
      }), selectedSidebarKeyRef.current);
  };

  const onSelect = (keys: React.Key[], info: any) => {
      if (info?.node?.type === 'v2-table-section' || info?.node?.type === 'v2-database-section') {
          return;
      }
      if (Date.now() < treeDragSelectSuppressUntilRef.current) {
          return;
      }
      if (isTreeDragging) {
          return;
      }
      setSidebarSelectedKeys(keys);
      selectedNodesRef.current = info.selectedNodes || [];

      if (keys.length === 0) {
          publishTitlebarSelection(null);
          return;
      }
      if (shouldSkipSidebarSelectWhileDragging(isTreeDragging, info)) return;

      const { type, dataRef, key, title } = info.node;
      const nodeConnectionId = resolveSidebarNodeConnectionId(info.node, connectionIds);
      if (type === 'connection') {
          clearStaleHostStateOnSelection(info.node);
      } else {
          publishTitlebarSelectionForNode(info.node);
      }

      // Update active context
      if (type === 'connection') {
          setActiveContext({ connectionId: key, dbName: '' });
      } else if (type === 'database' || type === 'message-namespace') {
          setActiveContext({ connectionId: nodeConnectionId || dataRef.id, dbName: dataRef.dbName });
      } else if (type === 'object-group' && dataRef?.groupKey === 'schema') {
          setActiveContext({
              connectionId: nodeConnectionId || dataRef.id,
              dbName: dataRef.dbName,
              ...buildOptionalSchemaContext(dataRef.schemaName),
          });
      } else if (isV2SidebarObjectNode(info.node)) {
          setActiveContext({
              connectionId: nodeConnectionId || dataRef.id,
              dbName: dataRef.dbName,
              tableName: resolveSidebarTitlebarObjectName(info.node),
              ...buildOptionalSchemaContext(dataRef.schemaName),
          });
      } else if (type === 'jvm-mode' || type === 'jvm-resource' || type === 'jvm-diagnostic' || type === 'jvm-monitoring') {
          setActiveContext({ connectionId: nodeConnectionId || dataRef.id, dbName: '' });
      } else if (type === 'saved-query') {
          setActiveContext({ connectionId: dataRef.connectionId, dbName: dataRef.dbName });
      } else if (type === 'redis-db') {
          setActiveContext({ connectionId: dataRef.id, dbName: `db${dataRef.redisDB}` });
      } else if (
          type === 'nacos-namespace'
          || type === 'nacos-config-entry'
          || type === 'nacos-config-group'
          || type === 'nacos-services-entry'
          || type === 'nacos-service-group'
      ) {
          setActiveContext({
              connectionId: dataRef.id,
              dbName: dataRef.nacosNamespaceName || dataRef.nacosNamespaceId || 'public',
          });
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
                  title: t('sidebar.tab.table_overview', {
                      database: gDbName,
                      schema: schemaName ? ` (${schemaName})` : '',
                  }),
                  type: 'table-overview' as any,
                  connectionId: id,
                  dbName: gDbName,
                  schemaName,
              } as any);
          }, 250);
      } else if (openSidebarObjectNode(info.node)) {
          return;
      }
  };

  const onExpand = (newExpandedKeys: React.Key[], info?: any) => {
    // rc-tree auto-expands any loaded node after a drag hover. During a V2 Host
    // move, group expansion is controlled by the explicit 500ms inside target;
    // ignore rc-tree's competing expansion so connection resource rows do not
    // unexpectedly open and move the target under the pointer.
    if (
        isTreeDragging
        && sidebarTreeDrag.isSidebarHostTreeNode(sidebarTreeDragNodeRef.current)
    ) {
        return;
    }
    if (!info?.expanded && shouldClearSidebarNodeChildrenOnCollapse(info?.node)) {
        const collapsedKey = String(info.node?.key || '').trim();
        const keysToClear = [
            collapsedKey,
            ...collectSidebarSubtreeKeys(info.node),
        ].filter(Boolean);
        const keysToClearSet = new Set(keysToClear);
        setExpandedKeys(newExpandedKeys.filter((key) => !keysToClearSet.has(String(key))));
        setAutoExpandParent(false);
        clearTreeNodeChildrenByKeys(keysToClear);
        return;
    }
    setExpandedKeys(newExpandedKeys);
    setAutoExpandParent(false);
    if (!shouldSkipSidebarLoadOnExpandWhileDragging(isTreeDragging, info)) {
        void onLoadData(info.node);
    }
  };

  const onDoubleClick = (e: any, node: any) => {
      // 双击时取消单击延迟动作（如表概览打开）。连接节点只展开不折叠，其它目录仍切换展开。
      if (clickTimerRef.current) {
          clearTimeout(clickTimerRef.current);
          clickTimerRef.current = null;
      }
      const { type, dataRef, key: nodeKey } = node;
      if (type === 'v2-table-section' || type === 'v2-database-section') {
          return;
      }
      const nodeConnectionId = resolveSidebarNodeConnectionId(node, connectionIds);
      // Context-menu actions call this handler directly, without rc-tree's
      // preceding select event. Keep the tree selection in sync so the
      // titlebar layout effect cannot restore the previously selected row
      // after opening the requested object.
      if (nodeKey !== undefined && nodeKey !== null && String(nodeKey).trim() !== '') {
          setSidebarSelectedKeys([nodeKey]);
          selectedNodesRef.current = [node];
      }
      if (type === 'connection') {
          clearStaleHostStateOnSelection(node);
      } else {
          publishTitlebarSelectionForNode(node);
      }
      if (type === 'connection') {
          setActiveContext({ connectionId: nodeKey, dbName: '' });
      } else if (type === 'database' || type === 'message-namespace') {
          setActiveContext({ connectionId: nodeConnectionId || dataRef.id, dbName: dataRef.dbName });
      } else if (type === 'object-group' && dataRef?.groupKey === 'schema') {
          setActiveContext({
              connectionId: nodeConnectionId || dataRef.id,
              dbName: dataRef.dbName,
              ...buildOptionalSchemaContext(dataRef.schemaName),
          });
      } else if (type === 'jvm-mode' || type === 'jvm-resource' || type === 'jvm-diagnostic' || type === 'jvm-monitoring') {
          setActiveContext({ connectionId: nodeConnectionId || dataRef.id, dbName: '' });
      } else if (isV2SidebarObjectNode(node)) {
          setActiveContext({
              connectionId: nodeConnectionId || dataRef.id,
              dbName: dataRef.dbName,
              tableName: resolveSidebarTitlebarObjectName(node),
              ...buildOptionalSchemaContext(dataRef.schemaName),
          });
      } else if (type === 'saved-query') {
          setActiveContext({ connectionId: dataRef.connectionId, dbName: dataRef.dbName });
      }
      else if (type === 'redis-db') {
          setActiveContext({ connectionId: dataRef.id, dbName: `db${dataRef.redisDB}` });
      }
      else if (
          type === 'nacos-namespace'
          || type === 'nacos-config-entry'
          || type === 'nacos-config-group'
          || type === 'nacos-services-entry'
          || type === 'nacos-service-group'
      ) {
          setActiveContext({
              connectionId: dataRef.id,
              dbName: dataRef.nacosNamespaceName || dataRef.nacosNamespaceId || 'public',
          });
      }

      const isMessageQueueConnection = node.type === 'connection'
          && ['mqtt', 'kafka', 'rocketmq', 'rabbitmq', 'pulsar'].includes(
              resolveDataSourceType(node.dataRef?.config),
          );
      if (isMessageQueueConnection || node.type === 'message-namespace') {
          openMessageQueueWorkbench(node, 'open');
          return;
      }
      if (openMessageObjectNode(node)) {
          return;
      } else if (openSidebarObjectNode(node)) {
          return;
      } else if (node.type === 'table') {
          const { tableName, dbName, id, schemaName } = node.dataRef;
          // 记录表访问
          recordTableAccess(id, dbName, tableName);
          // 页签挂载前就把它最先要用的元数据请求发出去。
          prefetchTableOpenMetadata({
              connection: connections.find((item) => item.id === id),
              connectionId: id, dbName, tableName,
              view: tableDoubleClickAction === 'open-design' ? 'fields' : 'data',
          });
          addTab({
              id: node.key,
              title: tableName,
              type: 'table',
              connectionId: id,
              dbName,
              tableName,
              ...buildOptionalSchemaContext(schemaName),
              initialViewMode: tableDoubleClickAction === 'open-design' ? 'fields' : undefined,
              initialViewModeRequestId: tableDoubleClickAction === 'open-design' ? String(Date.now()) : undefined,
              objectType: 'table',
          });
          return;
      } else if (node.type === 'saved-query') {
          const q = node.dataRef;
          addTab({
              id: q.id,
              title: resolveSavedQueryDisplayName(q.name),
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
      } else if (node.type === 'nacos-config-entry') {
          // Folder node: fall through to expand/collapse + lazy load groups.
      } else if (node.type === 'nacos-config-group') {
          const {
              id,
              nacosNamespaceId = '',
              nacosNamespaceName = '',
              nacosGroup = '',
              nacosAllConfigs = false,
          } = node.dataRef || {};
          const nsName = nacosNamespaceName || nacosNamespaceId || 'public';
          const nsKey = nacosNamespaceId || 'public';
          const isAll = !!nacosAllConfigs;
          const groupName = isAll ? '' : (String(nacosGroup || '').trim() || 'DEFAULT_GROUP');
          addTab({
              id: isAll
                  ? `nacos-config-${id}-ns-${nsKey}`
                  : `nacos-config-${id}-ns-${nsKey}-g-${encodeURIComponent(groupName)}`,
              title: isAll ? `${nsName} · ${t('nacos_viewer.label.all')}` : `${nsName} · ${groupName}`,
              type: 'nacos-config',
              connectionId: id,
              nacosNamespaceId: nacosNamespaceId || '',
              nacosNamespaceName: nsName,
              ...(isAll ? {} : { nacosGroup: groupName }),
          });
          return;
      } else if (node.type === 'nacos-services-entry' || node.type === 'nacos-service-group') {
          const action = resolveNacosServicesDoubleClickAction(node);
          if (action?.kind === 'open') {
              addTab(action.tab);
              return;
          }
          // Service explorer entry is a folder: fall through to expand/collapse + lazy load groups.
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
      const { expandedKeys: nextExpandedKeys, didExpand } = resolveSidebarDoubleClickExpandedKeys({
          nodeType: type,
          nodeKey: key,
          expandedKeys,
      });
      setExpandedKeys(nextExpandedKeys);
      // 连接节点双击只展开：工作台定位已经展开后，再双击同一 Host 保持库树打开。
      // 若已展开但子节点尚未加载，继续走懒加载，而不是把树收起来。
      if (didExpand || (type === 'connection' && shouldLoadSidebarNodeOnExpand(node))) {
          setAutoExpandParent(false);
          if (shouldLoadSidebarNodeOnExpand(node)) {
              void onLoadData(node);
          }
      }
  };
  return {
    onLoadData, isStructureOnlyDbType, openDesign, openNewTableDesign,
    clearStaleHostStateOnSelection, onSelect, onExpand, onDoubleClick,
  };
};

export type SidebarTreeEventsApi = ReturnType<typeof useSidebarTreeEvents>;
