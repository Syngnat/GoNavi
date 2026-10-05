import { useRef, useEffect } from 'react';
import {
  waitForSidebarLocateLoadKey,
  runSidebarLocateDatabaseObject,
} from './sidebarLocateDatabaseObject';
import {
  normalizeSidebarLocateObjectRequest,
  resolveSidebarLocateTarget,
  findSidebarNodePathForLocate,
  type SidebarLocateTreeNodeLike,
} from '../../utils/sidebarLocate';
import { message } from 'antd';
import { t } from '../../i18n';
import { shouldHideSchemaPrefix } from './sidebarMetadataLoaders';
import { resolveSidebarTitlebarObjectName } from './sidebarHelpers';
import { buildOptionalSchemaContext } from './sidebarRootHelpers';
import { useSidebarTreeLoaders } from './useSidebarTreeLoaders';
import {
  describeSidebarLocateFailure,
  dispatchSidebarActiveQueryTableLocate,
} from './sidebarLocateActiveTab';
import {
  normalizeSidebarDatabaseRefreshRequest,
  SIDEBAR_DATABASE_REFRESH_EVENT,
} from '../../utils/sidebarDatabaseRefresh';
import type { SidebarSearchStateApi } from './useSidebarSearchState';
import type { SidebarTreeDataApi } from './useSidebarTreeData';
import type { SidebarTreeViewStateApi } from './useSidebarTreeViewState';
import type { SidebarTitlebarSyncApi } from './useSidebarTitlebarSync';
import type { SidebarStoreStateApi } from './useSidebarStoreState';
import type { SidebarProps } from '../Sidebar';

export interface UseSidebarLocateInput {
  loadingNodesRef: SidebarSearchStateApi['loadingNodesRef'];
  onEnsureSidebarExpanded: SidebarProps['onEnsureSidebarExpanded'];
  refreshGlobalExternalSQLRootNode: SidebarTreeDataApi['refreshGlobalExternalSQLRootNode'];
  treeDataRef: SidebarTreeViewStateApi['treeDataRef'];
  findTreeNodeByKey: SidebarTitlebarSyncApi['findTreeNodeByKey'];
  setSearchValue: SidebarSearchStateApi['setSearchValue'];
  setV2ExplorerFilter: SidebarSearchStateApi['setV2ExplorerFilter'];
  mergeExpandedTreeKeys: SidebarTreeDataApi['mergeExpandedTreeKeys'];
  setSidebarSelectedKeys: SidebarSearchStateApi['setSidebarSelectedKeys'];
  selectedNodesRef: SidebarSearchStateApi['selectedNodesRef'];
  activeContext: SidebarStoreStateApi['activeContext'];
  activeTab: SidebarStoreStateApi['activeTab'];
  setActiveContext: SidebarStoreStateApi['setActiveContext'];
  publishTitlebarSelection: SidebarTitlebarSyncApi['publishTitlebarSelection'];
  resolveSidebarSelectionContext: SidebarTitlebarSyncApi['resolveSidebarSelectionContext'];
  scrollSidebarTreeToKey: SidebarTreeDataApi['scrollSidebarTreeToKey'];
  connections: SidebarStoreStateApi['connections'];
  clearStaleHostStateOnSelection: (node: any) => void;
  loadDatabases: ReturnType<typeof useSidebarTreeLoaders>['loadDatabases'];
  loadTables: ReturnType<typeof useSidebarTreeLoaders>['loadTables'];
  activeTabLocateAction: SidebarStoreStateApi['activeTabLocateAction'];
  findTreeNodeByKeyRef: SidebarTreeViewStateApi['findTreeNodeByKeyRef'];
  refreshConnectionResourcesRef: SidebarSearchStateApi['refreshConnectionResourcesRef'];
}

export const useSidebarLocate = ({
  loadingNodesRef, onEnsureSidebarExpanded, refreshGlobalExternalSQLRootNode, treeDataRef,
  findTreeNodeByKey, setSearchValue, setV2ExplorerFilter, mergeExpandedTreeKeys,
  setSidebarSelectedKeys, selectedNodesRef, activeContext, activeTab, setActiveContext,
  publishTitlebarSelection, resolveSidebarSelectionContext, scrollSidebarTreeToKey, connections,
  clearStaleHostStateOnSelection, loadDatabases, loadTables, activeTabLocateAction,
  findTreeNodeByKeyRef, refreshConnectionResourcesRef,
}: UseSidebarLocateInput) => {
  const locateObjectInSidebarRef = useRef<(detail: unknown) => Promise<void>>(async () => {});

  const waitForSidebarLoadKey = async (loadKey: string): Promise<boolean> => (
      waitForSidebarLocateLoadKey(loadKey, (key) => loadingNodesRef.current.has(key))
  );

  const locateObjectInSidebar = async (detail: unknown) => {
      const request = normalizeSidebarLocateObjectRequest(detail);
      if (!request) {
          message.warning(t('sidebar.message.locate_current_table_unavailable'));
          return;
      }

      onEnsureSidebarExpanded?.();

      if (request.objectGroup === 'externalSqlFiles') {
          await refreshGlobalExternalSQLRootNode(false);
          const target = resolveSidebarLocateTarget(request, { groupBySchema: false });
          const path = findSidebarNodePathForLocate(treeDataRef.current as SidebarLocateTreeNodeLike[], target);
          if (!path) {
              message.warning(t('sidebar.message.locate_external_sql_file_not_found', { path: request.filePath }));
              return;
          }
          const targetKey = path[path.length - 1];
          const targetNode = findTreeNodeByKey(treeDataRef.current, targetKey);
          setSearchValue('');
          setV2ExplorerFilter('all');
          mergeExpandedTreeKeys(path.slice(0, -1));
          setSidebarSelectedKeys([targetKey]);
          selectedNodesRef.current = targetNode ? [targetNode] : [];
          const connectionId = String(request.connectionId || activeContext?.connectionId || activeTab?.connectionId || '').trim();
          const dbName = String(request.dbName || activeContext?.dbName || activeTab?.dbName || '').trim();
          if (connectionId) {
              setActiveContext({ connectionId, dbName });
              publishTitlebarSelection(
                  resolveSidebarSelectionContext(targetNode)
                  || {
                      connectionId,
                      dbName,
                      sidebarStateKey: connectionId,
                  },
                  targetKey,
              );
          }
          scrollSidebarTreeToKey(targetKey, 'center');
          return;
      }

      if (request.objectGroup === 'savedQueries') {
          const target = resolveSidebarLocateTarget(request, { groupBySchema: false });
          const path = findSidebarNodePathForLocate(treeDataRef.current as SidebarLocateTreeNodeLike[], target);
          if (!path) {
              message.warning(t('sidebar.message.locate_saved_query_not_found', {
                  name: request.savedQueryName || request.savedQueryId,
              }));
              return;
          }
          const targetKey = path[path.length - 1];
          const targetNode = findTreeNodeByKey(treeDataRef.current, targetKey);
          setSearchValue('');
          setV2ExplorerFilter('all');
          mergeExpandedTreeKeys(path.slice(0, -1));
          setSidebarSelectedKeys([targetKey]);
          selectedNodesRef.current = targetNode ? [targetNode] : [];
          const connectionId = String(request.connectionId || activeContext?.connectionId || activeTab?.connectionId || '').trim();
          const dbName = String(request.dbName || activeContext?.dbName || activeTab?.dbName || '').trim();
          if (connectionId) {
              setActiveContext({ connectionId, dbName });
              publishTitlebarSelection(
                  resolveSidebarSelectionContext(targetNode)
                  || {
                      connectionId,
                      dbName,
                      sidebarStateKey: connectionId,
                  },
                  targetKey,
              );
          }
          scrollSidebarTreeToKey(targetKey, 'center');
          return;
      }

      const conn = connections.find(item => item.id === request.connectionId);
      if (!conn) {
          message.warning(t('sidebar.message.locate_connection_not_found_for_object'));
          return;
      }

      const target = resolveSidebarLocateTarget(request, {
          groupBySchema: shouldHideSchemaPrefix(conn),
      });
      const objectLabel = request.objectGroup === 'materializedViews'
          ? t('sidebar.locate.object.materialized_view')
          : request.objectGroup === 'views'
              ? t('sidebar.locate.object.view')
              : request.objectGroup === 'triggers'
                  ? t('sidebar.locate.object.trigger')
                  : request.objectGroup === 'routines'
                      ? t('sidebar.locate.object.routine')
                      : t('sidebar.locate.object.table');

      setSearchValue('');
      setV2ExplorerFilter('all');
      const outcome = await runSidebarLocateDatabaseObject({
          request,
          target,
          objectLabel,
          getTree: () => treeDataRef.current as SidebarLocateTreeNodeLike[],
          findNode: (key) => findTreeNodeByKey(treeDataRef.current, key),
          mergeExpandedTreeKeys,
          revealNode: (key, node, stage) => {
              setSidebarSelectedKeys([key]);
              selectedNodesRef.current = node ? [node] : [];
              if (stage === 'connection') {
                  clearStaleHostStateOnSelection(node);
              }
              setActiveContext({
                  connectionId: request.connectionId,
                  dbName: request.dbName,
                  ...(stage === 'object'
                      ? {
                          tableName: resolveSidebarTitlebarObjectName(node) || request.tableName,
                          ...buildOptionalSchemaContext(node?.dataRef?.schemaName || request.schemaName),
                      }
                      : {}),
              });
              publishTitlebarSelection(
                  resolveSidebarSelectionContext(node)
                  || {
                      connectionId: request.connectionId,
                      dbName: request.dbName,
                      ...(stage === 'object' ? { tableName: request.tableName } : {}),
                      sidebarStateKey: request.connectionId,
                  },
                  key,
              );
              scrollSidebarTreeToKey(key, stage === 'object' ? 'center' : 'nearest');
          },
          loadDatabases,
          loadTables,
          isLoadPending: (loadKey) => loadingNodesRef.current.has(loadKey),
      });
      if (outcome.status === 'failed') {
          const notify = outcome.message.level === 'info' ? message.info : message.warning;
          notify(t(outcome.message.key, outcome.message.params));
      }
  };

  const handleLocateActiveTabInSidebar = () => {
      if (activeTabLocateAction.kind === 'object') {
          void locateObjectInSidebar(activeTabLocateAction.request).catch((error: unknown) => {
              console.error('GoNavi sidebar locate failed', error);
              message.error(t('sidebar.message.locate_failed', { detail: describeSidebarLocateFailure(error) }));
          });
          return;
      }
      if (activeTabLocateAction.kind === 'query-line-table') {
          dispatchSidebarActiveQueryTableLocate(activeTabLocateAction);
          return;
      }
      message.warning(t('sidebar.message.locate_current_table_unavailable'));
  };

  useEffect(() => {
      locateObjectInSidebarRef.current = locateObjectInSidebar;
  });

  useEffect(() => {
      const handleLocateSidebarObject = (event: Event) => {
          void locateObjectInSidebarRef.current((event as CustomEvent).detail);
      };
      window.addEventListener('gonavi:locate-sidebar-object', handleLocateSidebarObject as EventListener);
      return () => {
          window.removeEventListener('gonavi:locate-sidebar-object', handleLocateSidebarObject as EventListener);
      };
  }, []);

  useEffect(() => {
      const handleSidebarTablePinChanged = (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          const connectionId = String(detail.connectionId || '').trim();
          const dbName = String(detail.dbName || '').trim();
          if (!connectionId || !dbName) return;
          const dbNode = findTreeNodeByKeyRef.current(treeDataRef.current, `${connectionId}-${dbName}`);
          if (dbNode) {
              void loadTables(dbNode, { ensureFresh: true });
          }
      };
      window.addEventListener('gonavi:sidebar-table-pin-changed', handleSidebarTablePinChanged as EventListener);
      return () => {
          window.removeEventListener('gonavi:sidebar-table-pin-changed', handleSidebarTablePinChanged as EventListener);
      };
  }, []);

  useEffect(() => {
      const handleSidebarTableCreated = (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          const connectionId = String(detail.connectionId || '').trim();
          const dbName = String(detail.dbName || '').trim();
          if (!connectionId || !dbName) return;
          const dbNode = findTreeNodeByKeyRef.current(treeDataRef.current, `${connectionId}-${dbName}`);
          if (dbNode) {
              void loadTables(dbNode, { ensureFresh: true });
          }
      };
      window.addEventListener('gonavi:sidebar-table-created', handleSidebarTableCreated as EventListener);
      return () => {
          window.removeEventListener('gonavi:sidebar-table-created', handleSidebarTableCreated as EventListener);
      };
  }, []);

  useEffect(() => {
      const handleSidebarDatabaseRefresh = (event: Event) => {
          const request = normalizeSidebarDatabaseRefreshRequest((event as CustomEvent).detail);
          if (!request) return;
          if (!request.dbName) {
              const connectionNode = findTreeNodeByKeyRef.current(
                  treeDataRef.current,
                  request.connectionId,
              );
              if (connectionNode) {
                  void refreshConnectionResourcesRef.current(connectionNode);
              }
              return;
          }
          const dbNode = findTreeNodeByKeyRef.current(
              treeDataRef.current,
              `${request.connectionId}-${request.dbName}`,
          );
          if (dbNode) {
              void loadTables(dbNode, { ensureFresh: true });
          }
      };
      window.addEventListener(SIDEBAR_DATABASE_REFRESH_EVENT, handleSidebarDatabaseRefresh as EventListener);
      return () => {
          window.removeEventListener(SIDEBAR_DATABASE_REFRESH_EVENT, handleSidebarDatabaseRefresh as EventListener);
      };
  }, []);
  return {
    waitForSidebarLoadKey, locateObjectInSidebar, handleLocateActiveTabInSidebar,
  };
};

export type SidebarLocateApi = ReturnType<typeof useSidebarLocate>;
