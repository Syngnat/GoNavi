import { useCallback, useMemo } from 'react';
import { type SidebarTreeSwitcherNodeLike, isSidebarSwitcherLoading } from './sidebarSwitcherState';
import { LoadingOutlined, CaretDownFilled, DashboardOutlined } from '@ant-design/icons';
import { buildRpcConnectionConfig } from '../../utils/connectionRpcConfig';
import { resolveSidebarRuntimeDatabase } from '../../utils/sidebarMetadata';
import { SavedConnection, SavedQueryGroup } from '../../types';
import { buildJVMTabTitle } from '../../utils/jvmRuntimePresentation';
import type { SidebarTreeNode as TreeNode } from '../sidebarV2Utils';
import { buildJVMDiagnosticActionDescriptor } from '../../utils/jvmSidebarActions';
import { t } from '../../i18n';
import { splitQualifiedName } from './sidebarMetadataLoaders';
import { message } from 'antd';
import { useSidebarTreeLoaders } from './useSidebarTreeLoaders';
import type { SidebarSearchStateApi } from './useSidebarSearchState';
import type { SidebarStoreStateApi } from './useSidebarStoreState';
import type { SidebarTreeViewStateApi } from './useSidebarTreeViewState';
import type { SidebarTreeDataApi } from './useSidebarTreeData';

export interface UseSidebarJvmAndSavedQueriesInput {
  loadingNodesRef: SidebarSearchStateApi['loadingNodesRef'];
  addTab: SidebarStoreStateApi['addTab'];
  connections: SidebarStoreStateApi['connections'];
  reloadSavedQueryGroups: SidebarStoreStateApi['reloadSavedQueryGroups'];
  setSavedQueryGroupTargetId: SidebarTreeViewStateApi['setSavedQueryGroupTargetId'];
  setSavedQueryGroupInitialParentId: SidebarTreeViewStateApi['setSavedQueryGroupInitialParentId'];
  setIsSavedQueryGroupModalOpen: SidebarTreeViewStateApi['setIsSavedQueryGroupModalOpen'];
  saveSavedQueryGroup: SidebarStoreStateApi['saveSavedQueryGroup'];
  savedQueryGroups: SidebarStoreStateApi['savedQueryGroups'];
  savedQueryGroupTargetId: SidebarTreeViewStateApi['savedQueryGroupTargetId'];
  savedQueries: SidebarStoreStateApi['savedQueries'];
  tableSortPreference: SidebarStoreStateApi['tableSortPreference'];
  tableAccessCount: SidebarStoreStateApi['tableAccessCount'];
  pinnedSidebarTables: SidebarStoreStateApi['pinnedSidebarTables'];
  pinnedSidebarDatabases: SidebarStoreStateApi['pinnedSidebarDatabases'];
  setConnectionStates: SidebarTreeViewStateApi['setConnectionStates'];
  setLoadedKeys: SidebarSearchStateApi['setLoadedKeys'];
  replaceTreeNodeChildren: SidebarTreeDataApi['replaceTreeNodeChildren'];
  databaseTreeTouchedAtRef: SidebarSearchStateApi['databaseTreeTouchedAtRef'];
  pruneLoadedDatabaseTrees: SidebarTreeDataApi['pruneLoadedDatabaseTrees'];
  invalidateConnectionLoadsRef: SidebarSearchStateApi['invalidateConnectionLoadsRef'];
  loadNacosServiceGroupsRef: SidebarSearchStateApi['loadNacosServiceGroupsRef'];
  replaceTreeNodeChildrenRef: SidebarSearchStateApi['replaceTreeNodeChildrenRef'];
}

export const useSidebarJvmAndSavedQueries = ({
  loadingNodesRef, addTab, connections, reloadSavedQueryGroups, setSavedQueryGroupTargetId,
  setSavedQueryGroupInitialParentId, setIsSavedQueryGroupModalOpen, saveSavedQueryGroup,
  savedQueryGroups, savedQueryGroupTargetId, savedQueries, tableSortPreference, tableAccessCount,
  pinnedSidebarTables, pinnedSidebarDatabases, setConnectionStates, setLoadedKeys,
  replaceTreeNodeChildren, databaseTreeTouchedAtRef, pruneLoadedDatabaseTrees,
  invalidateConnectionLoadsRef, loadNacosServiceGroupsRef, replaceTreeNodeChildrenRef,
}: UseSidebarJvmAndSavedQueriesInput) => {
  const renderSidebarSwitcherIcon = useCallback((node: SidebarTreeSwitcherNodeLike) => {
      if (node.isLeaf) {
          return null;
      }
      // 懒加载期间给出转圈反馈；Nacos 命名空间下双击「配置管理」「服务管理」
      // 走手动 onLoadData，rc-tree 的 node.loading 不会置位，只能靠 loadingNodesRef。
      if (isSidebarSwitcherLoading(node, loadingNodesRef.current)) {
          return <LoadingOutlined className="gn-v2-tree-switcher-loading" spin />;
      }
      return <CaretDownFilled />;
  }, []);

  const buildRuntimeConfig = (conn: any, overrideDatabase?: string, clearDatabase: boolean = false) => {
      return buildRpcConnectionConfig(conn.config, {
          database: resolveSidebarRuntimeDatabase(
              conn?.config?.type,
              conn?.config?.driver,
              conn?.config?.database,
              overrideDatabase,
              clearDatabase,
              conn?.config?.oceanBaseProtocol,
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
      const descriptor = buildJVMDiagnosticActionDescriptor(conn.id, conn.config.jvm?.diagnostic, t);
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
          title: dbName,
          key: `${connRef.id}-${dbName}`,
          dataRef: { ...(latestConn || connRef), dbName }
      };
  };

  const extractObjectName = (fullName: string) => {
      return splitQualifiedName(String(fullName || '').trim()).objectName || String(fullName || '').trim();
  };

  const resolveSavedQueryDisplayName = (name: string | null | undefined): string => {
      const rawName = String(name || '').trim();
      return rawName || t('query_editor.save_modal.unnamed');
  };

  const openSavedQueryGroupModal = useCallback(async (
      target?: SavedQueryGroup | null,
      initialParentGroupId?: string | null,
  ) => {
      try {
          const groups = await reloadSavedQueryGroups();
          const targetId = String(target?.id || '').trim();
          if (targetId && !groups.some((group) => group.id === targetId)) {
              message.warning(t('sidebar.message.saved_query_group_not_found'));
              return;
          }
          const parentId = String(initialParentGroupId || '').trim();
          setSavedQueryGroupTargetId(targetId || null);
          setSavedQueryGroupInitialParentId(
              parentId && groups.some((group) => group.id === parentId) ? parentId : null,
          );
          setIsSavedQueryGroupModalOpen(true);
      } catch (error) {
          message.error(t('sidebar.message.saved_query_group_load_failed', {
              error: error instanceof Error ? error.message : String(error),
          }));
      }
  }, [reloadSavedQueryGroups]);

  const closeSavedQueryGroupModal = useCallback(() => {
      setIsSavedQueryGroupModalOpen(false);
      setSavedQueryGroupTargetId(null);
      setSavedQueryGroupInitialParentId(null);
  }, []);

  const handleSaveSavedQueryGroup = useCallback(async (group: SavedQueryGroup) => {
      const isEditing = Boolean(group.id);
      await saveSavedQueryGroup(group);
      message.success(t(
          isEditing
              ? 'sidebar.message.saved_query_group_updated'
              : 'sidebar.message.saved_query_group_created',
      ));
  }, [saveSavedQueryGroup]);

  const savedQueryGroupTarget = useMemo(
      () => savedQueryGroups.find((group) => group.id === savedQueryGroupTargetId) || null,
      [savedQueryGroupTargetId, savedQueryGroups],
  );

  const {
      loadDatabases,
      loadJVMResources,
      loadTables,
      loadNacosConfigGroups,
      loadNacosServiceGroups,
      invalidateConnectionLoads,
  } = useSidebarTreeLoaders({
      savedQueries,
      tableSortPreference,
      tableAccessCount,
      pinnedSidebarTables,
      pinnedSidebarDatabases,
      loadingNodesRef,
      setConnectionStates,
      setLoadedKeys,
      replaceTreeNodeChildren,
      buildRuntimeConfig,
      buildJVMRuntimeConfig,
      buildJVMDiagnosticTreeNodes,
      resolveSavedQueryDisplayName,
      onDatabaseTreeLoaded: (databaseKey: string) => {
          databaseTreeTouchedAtRef.current[databaseKey] = Date.now();
          pruneLoadedDatabaseTrees();
      },
  });
  invalidateConnectionLoadsRef.current = invalidateConnectionLoads;
  loadNacosServiceGroupsRef.current = loadNacosServiceGroups;
  replaceTreeNodeChildrenRef.current = replaceTreeNodeChildren;
  return {
    renderSidebarSwitcherIcon, buildRuntimeConfig, openJVMOverviewTab, openJVMMonitoringTab,
    openJVMResourceTab, openJVMDiagnosticTab, getConnectionNodeRef, getDatabaseNodeRef,
    extractObjectName, resolveSavedQueryDisplayName, openSavedQueryGroupModal,
    closeSavedQueryGroupModal, handleSaveSavedQueryGroup, savedQueryGroupTarget, loadDatabases,
    loadJVMResources, loadTables, loadNacosConfigGroups, loadNacosServiceGroups,
    invalidateConnectionLoads,
  };
};

export type SidebarJvmAndSavedQueriesApi = ReturnType<typeof useSidebarJvmAndSavedQueries>;
