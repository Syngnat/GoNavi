import { useSidebarObjectActions } from './useSidebarObjectActions';
import {
  isPostgresSchemaDialect,
  buildConnectionRootQueryTabTitle,
  buildConnectionRootRedisCommandTabTitle,
  buildConnectionRootRedisMonitorTabTitle,
  useSidebarLayoutEffect,
} from './sidebarRootHelpers';
import React, { useRef, useEffect, useCallback } from 'react';
import { useSidebarV2ActionHandlers } from './useSidebarV2ActionHandlers';
import { useSidebarSearchModel } from './useSidebarSearchModel';
import { useCommandSearchDestinations } from './useCommandSearchDestinations';
import {
  findSidebarNodePathByKey,
  type SidebarLocateTreeNodeLike,
} from '../../utils/sidebarLocate';
import { runSidebarTreeScrollRequest } from './sidebarTreeScrollRequest';
import { getDataSourceCapabilities } from '../../utils/dataSourceCapabilities';
import type { SidebarStoreStateApi } from './useSidebarStoreState';
import type { SidebarSearchStateApi } from './useSidebarSearchState';
import type { SidebarTreeViewStateApi } from './useSidebarTreeViewState';
import type { SidebarJvmAndSavedQueriesApi } from './useSidebarJvmAndSavedQueries';
import type { SidebarTreeEventsApi } from './useSidebarTreeEvents';
import type { SidebarVisibilityApi } from './useSidebarVisibility';
import type { SidebarConnectionRefreshApi } from './useSidebarConnectionRefresh';
import type { SidebarTreeDataApi } from './useSidebarTreeData';
import type { SidebarTitlebarSyncApi } from './useSidebarTitlebarSync';
import type { SidebarProps } from '../Sidebar';

export interface UseSidebarObjectMenuActionsInput {
  connections: SidebarStoreStateApi['connections'];
  connectionIds: SidebarSearchStateApi['connectionIds'];
  connectionIdSet: SidebarSearchStateApi['connectionIdSet'];
  tabs: SidebarStoreStateApi['tabs'];
  treeDataRef: SidebarTreeViewStateApi['treeDataRef'];
  setTreeData: SidebarStoreStateApi['setTreeData'];
  setExpandedKeys: SidebarTreeViewStateApi['setExpandedKeys'];
  setLoadedKeys: SidebarSearchStateApi['setLoadedKeys'];
  addTab: SidebarStoreStateApi['addTab'];
  updateQueryTabDraft: SidebarStoreStateApi['updateQueryTabDraft'];
  saveQuery: SidebarStoreStateApi['saveQuery'];
  addSqlLog: SidebarStoreStateApi['addSqlLog'];
  closeTabsByDatabase: SidebarStoreStateApi['closeTabsByDatabase'];
  createDbForm: SidebarTreeViewStateApi['createDbForm'];
  targetConnection: SidebarTreeViewStateApi['targetConnection'];
  isCreateDbModalOpen: SidebarTreeViewStateApi['isCreateDbModalOpen'];
  setIsCreateDbModalOpen: SidebarTreeViewStateApi['setIsCreateDbModalOpen'];
  createDbCharsets: SidebarTreeViewStateApi['createDbCharsets'];
  setCreateDbCharsets: SidebarTreeViewStateApi['setCreateDbCharsets'];
  createDbCollations: SidebarTreeViewStateApi['createDbCollations'];
  setCreateDbCollations: SidebarTreeViewStateApi['setCreateDbCollations'];
  loadingCreateDbOptions: SidebarTreeViewStateApi['loadingCreateDbOptions'];
  setLoadingCreateDbOptions: SidebarTreeViewStateApi['setLoadingCreateDbOptions'];
  createSchemaForm: SidebarTreeViewStateApi['createSchemaForm'];
  createSchemaTarget: SidebarTreeViewStateApi['createSchemaTarget'];
  setCreateSchemaTarget: SidebarTreeViewStateApi['setCreateSchemaTarget'];
  setIsCreateSchemaModalOpen: SidebarTreeViewStateApi['setIsCreateSchemaModalOpen'];
  renameSchemaForm: SidebarTreeViewStateApi['renameSchemaForm'];
  renameSchemaTarget: SidebarTreeViewStateApi['renameSchemaTarget'];
  setRenameSchemaTarget: SidebarTreeViewStateApi['setRenameSchemaTarget'];
  setIsRenameSchemaModalOpen: SidebarTreeViewStateApi['setIsRenameSchemaModalOpen'];
  renameDbForm: SidebarTreeViewStateApi['renameDbForm'];
  renameDbTarget: SidebarTreeViewStateApi['renameDbTarget'];
  setRenameDbTarget: SidebarTreeViewStateApi['setRenameDbTarget'];
  setIsRenameDbModalOpen: SidebarTreeViewStateApi['setIsRenameDbModalOpen'];
  renameTableForm: SidebarTreeViewStateApi['renameTableForm'];
  renameTableTarget: SidebarTreeViewStateApi['renameTableTarget'];
  setRenameTableTarget: SidebarTreeViewStateApi['setRenameTableTarget'];
  setIsRenameTableModalOpen: SidebarTreeViewStateApi['setIsRenameTableModalOpen'];
  renameViewForm: SidebarTreeViewStateApi['renameViewForm'];
  renameViewTarget: SidebarTreeViewStateApi['renameViewTarget'];
  setRenameViewTarget: SidebarTreeViewStateApi['setRenameViewTarget'];
  setIsRenameViewModalOpen: SidebarTreeViewStateApi['setIsRenameViewModalOpen'];
  renameSavedQueryForm: SidebarTreeViewStateApi['renameSavedQueryForm'];
  renameSavedQueryTarget: SidebarTreeViewStateApi['renameSavedQueryTarget'];
  setRenameSavedQueryTarget: SidebarTreeViewStateApi['setRenameSavedQueryTarget'];
  setIsRenameSavedQueryModalOpen: SidebarTreeViewStateApi['setIsRenameSavedQueryModalOpen'];
  setMessagePublishTarget: SidebarTreeViewStateApi['setMessagePublishTarget'];
  buildRuntimeConfig: SidebarJvmAndSavedQueriesApi['buildRuntimeConfig'];
  getConnectionNodeRef: SidebarJvmAndSavedQueriesApi['getConnectionNodeRef'];
  getDatabaseNodeRef: SidebarJvmAndSavedQueriesApi['getDatabaseNodeRef'];
  extractObjectName: SidebarJvmAndSavedQueriesApi['extractObjectName'];
  loadDatabases: SidebarJvmAndSavedQueriesApi['loadDatabases'];
  loadTables: SidebarJvmAndSavedQueriesApi['loadTables'];
  openDesign: SidebarTreeEventsApi['openDesign'];
  onDoubleClick: SidebarTreeEventsApi['onDoubleClick'];
  runExportWithProgress: SidebarStoreStateApi['runExportWithProgress'];
  setAIPanelVisible: SidebarStoreStateApi['setAIPanelVisible'];
  addAIContext: SidebarStoreStateApi['addAIContext'];
  migrateVisibilityForRenamedDatabase: SidebarVisibilityApi['migrateVisibilityForRenamedDatabase'];
  removeVisibilityForDeletedDatabase: SidebarVisibilityApi['removeVisibilityForDeletedDatabase'];
  migrateVisibilityForRenamedSchema: SidebarVisibilityApi['migrateVisibilityForRenamedSchema'];
  removeVisibilityForDeletedSchema: SidebarVisibilityApi['removeVisibilityForDeletedSchema'];
  migratePinnedDatabaseKey: SidebarVisibilityApi['migratePinnedDatabaseKey'];
  onCreateConnectionInGroup: SidebarProps['onCreateConnectionInGroup'];
  onEditConnection: SidebarProps['onEditConnection'];
  connectionTags: SidebarStoreStateApi['connectionTags'];
  pinnedSidebarTables: SidebarStoreStateApi['pinnedSidebarTables'];
  pinnedSidebarDatabases: SidebarStoreStateApi['pinnedSidebarDatabases'];
  loadingNodesRef: SidebarSearchStateApi['loadingNodesRef'];
  refreshConnectionResources: SidebarConnectionRefreshApi['refreshConnectionResources'];
  invalidateConnectionLoads: SidebarJvmAndSavedQueriesApi['invalidateConnectionLoads'];
  findTreeNodeByKeyRef: SidebarTreeViewStateApi['findTreeNodeByKeyRef'];
  setConnectionStates: SidebarTreeViewStateApi['setConnectionStates'];
  setTargetConnection: SidebarTreeViewStateApi['setTargetConnection'];
  setIsCreateTagModalOpen: SidebarTreeViewStateApi['setIsCreateTagModalOpen'];
  createTagForm: SidebarTreeViewStateApi['createTagForm'];
  closeTabsByConnection: SidebarStoreStateApi['closeTabsByConnection'];
  removeConnection: SidebarStoreStateApi['removeConnection'];
  removeConnectionTag: SidebarStoreStateApi['removeConnectionTag'];
  moveConnectionToTag: SidebarStoreStateApi['moveConnectionToTag'];
  setSidebarTablePinned: SidebarStoreStateApi['setSidebarTablePinned'];
  setSidebarDatabasePinned: SidebarStoreStateApi['setSidebarDatabasePinned'];
  setTableSortPreference: SidebarStoreStateApi['setTableSortPreference'];
  replaceTreeNodeChildren: SidebarTreeDataApi['replaceTreeNodeChildren'];
  openNewTableDesign: SidebarTreeEventsApi['openNewTableDesign'];
  handleExportDatabaseSQL: SidebarTreeViewStateApi['handleExportDatabaseSQL'];
  openBatchTableWorkbench: SidebarTreeViewStateApi['openBatchTableWorkbench'];
  openBatchDatabaseWorkbench: SidebarTreeViewStateApi['openBatchDatabaseWorkbench'];
  openBatchConnectionWorkbench: SidebarTreeViewStateApi['openBatchConnectionWorkbench'];
  handleRunSQLFile: SidebarTreeDataApi['handleRunSQLFile'];
  openConnectionVisibilitySettings: SidebarVisibilityApi['openConnectionVisibilitySettings'];
  handleDuplicateConnection: SidebarTitlebarSyncApi['handleDuplicateConnection'];
  onCreateConnection: SidebarProps['onCreateConnection'];
  onToggleAI: SidebarProps['onToggleAI'];
  onToggleLogPanel: SidebarProps['onToggleLogPanel'];
  searchScopes: SidebarSearchStateApi['searchScopes'];
  setSearchScopes: SidebarSearchStateApi['setSearchScopes'];
  setSearchValue: SidebarSearchStateApi['setSearchValue'];
  deferredSearchValue: SidebarSearchStateApi['deferredSearchValue'];
  deferredV2CommandSearchValue: SidebarSearchStateApi['deferredV2CommandSearchValue'];
  v2CommandSearchValue: SidebarSearchStateApi['v2CommandSearchValue'];
  setV2CommandActiveIndex: SidebarSearchStateApi['setV2CommandActiveIndex'];
  v2ExplorerFilter: SidebarSearchStateApi['v2ExplorerFilter'];
  visibleSidebarTreeData: SidebarSearchStateApi['visibleSidebarTreeData'];
  treeHeight: SidebarTreeViewStateApi['treeHeight'];
  isV2CommandSearchOpen: SidebarSearchStateApi['isV2CommandSearchOpen'];
  selectedKeys: SidebarSearchStateApi['selectedKeys'];
  selectedNodesRef: SidebarSearchStateApi['selectedNodesRef'];
  activeContext: SidebarStoreStateApi['activeContext'];
  activeTab: SidebarStoreStateApi['activeTab'];
  recentSqlLogs: SidebarSearchStateApi['recentSqlLogs'];
  shortcutOptions: SidebarStoreStateApi['shortcutOptions'];
  activeShortcutPlatform: SidebarStoreStateApi['activeShortcutPlatform'];
  overlayTheme: SidebarStoreStateApi['overlayTheme'];
  darkMode: SidebarStoreStateApi['darkMode'];
  isWebRuntime: Exclude<SidebarProps['isWebRuntime'], undefined>;
  onOpenSettingsNavigation: SidebarProps['onOpenSettingsNavigation'];
  markTreeScrollActivity: SidebarTreeViewStateApi['markTreeScrollActivity'];
  sidebarTreeScrollRequest: SidebarTreeViewStateApi['sidebarTreeScrollRequest'];
  setSidebarTreeScrollRequest: SidebarTreeViewStateApi['setSidebarTreeScrollRequest'];
  expandedKeys: SidebarSearchStateApi['expandedKeys'];
  treeContainerRef: SidebarTreeViewStateApi['treeContainerRef'];
  sidebarTreeScrollRequestIdRef: SidebarTreeViewStateApi['sidebarTreeScrollRequestIdRef'];
  treeRef: SidebarTreeViewStateApi['treeRef'];
}

export const useSidebarObjectMenuActions = ({
  connections, connectionIds, connectionIdSet, tabs, treeDataRef, setTreeData, setExpandedKeys,
  setLoadedKeys, addTab, updateQueryTabDraft, saveQuery, addSqlLog, closeTabsByDatabase,
  createDbForm, targetConnection, isCreateDbModalOpen, setIsCreateDbModalOpen, createDbCharsets,
  setCreateDbCharsets, createDbCollations, setCreateDbCollations, loadingCreateDbOptions,
  setLoadingCreateDbOptions, createSchemaForm, createSchemaTarget, setCreateSchemaTarget,
  setIsCreateSchemaModalOpen, renameSchemaForm, renameSchemaTarget, setRenameSchemaTarget,
  setIsRenameSchemaModalOpen, renameDbForm, renameDbTarget, setRenameDbTarget,
  setIsRenameDbModalOpen, renameTableForm, renameTableTarget, setRenameTableTarget,
  setIsRenameTableModalOpen, renameViewForm, renameViewTarget, setRenameViewTarget,
  setIsRenameViewModalOpen, renameSavedQueryForm, renameSavedQueryTarget, setRenameSavedQueryTarget,
  setIsRenameSavedQueryModalOpen, setMessagePublishTarget, buildRuntimeConfig, getConnectionNodeRef,
  getDatabaseNodeRef, extractObjectName, loadDatabases, loadTables, openDesign, onDoubleClick,
  runExportWithProgress, setAIPanelVisible, addAIContext, migrateVisibilityForRenamedDatabase,
  removeVisibilityForDeletedDatabase, migrateVisibilityForRenamedSchema,
  removeVisibilityForDeletedSchema, migratePinnedDatabaseKey, onCreateConnectionInGroup,
  onEditConnection, connectionTags, pinnedSidebarTables, pinnedSidebarDatabases, loadingNodesRef,
  refreshConnectionResources, invalidateConnectionLoads, findTreeNodeByKeyRef, setConnectionStates,
  setTargetConnection, setIsCreateTagModalOpen, createTagForm, closeTabsByConnection,
  removeConnection, removeConnectionTag, moveConnectionToTag, setSidebarTablePinned,
  setSidebarDatabasePinned, setTableSortPreference, replaceTreeNodeChildren, openNewTableDesign,
  handleExportDatabaseSQL, openBatchTableWorkbench, openBatchDatabaseWorkbench,
  openBatchConnectionWorkbench, handleRunSQLFile, openConnectionVisibilitySettings,
  handleDuplicateConnection, onCreateConnection, onToggleAI, onToggleLogPanel, searchScopes,
  setSearchScopes, setSearchValue, deferredSearchValue, deferredV2CommandSearchValue,
  v2CommandSearchValue, setV2CommandActiveIndex, v2ExplorerFilter, visibleSidebarTreeData,
  treeHeight, isV2CommandSearchOpen, selectedKeys, selectedNodesRef, activeContext, activeTab,
  recentSqlLogs, shortcutOptions, activeShortcutPlatform, overlayTheme, darkMode, isWebRuntime,
  onOpenSettingsNavigation, markTreeScrollActivity, sidebarTreeScrollRequest,
  setSidebarTreeScrollRequest, expandedKeys, treeContainerRef, sidebarTreeScrollRequestIdRef,
  treeRef,
}: UseSidebarObjectMenuActionsInput) => {
  const {
      handleCopyStructure,
      handleCopyTable,
      handleCopyTableName,
      handleCopyDatabaseName,
      handleExport,
      openExportDialog,
      handleCopyTableAsInsert,
      openTableDdlInDesigner,
      openTableInERView,
      injectTablePromptToAI,
      handleCreateDatabase,
      openCreateSchemaModal,
      handleCreateSchema,
      openRenameSchemaModal,
      handleRenameSchema,
      handleDeleteSchema,
      handleRenameDatabase,
      handleDeleteDatabase,
      handleRenameTable,
      handleDeleteTable,
      handleTableDataDangerAction,
      openViewDefinition,
      openEditView,
      openCreateView,
      openCreateStarRocksMaterializedView,
      openCreateStarRocksExternalCatalog,
      openCreateStarRocksRollup,
      handleDropView,
      handleRenameView,
      openRenameSavedQueryModal,
      handleRenameSavedQuery,
      handleRevealSavedQueryInFolder,
      isSavedQueryUnmatched,
      handleRebindSavedQuery,
      openRoutineDefinition,
      openEventDefinition,
      openEditEvent,
      openSequenceDefinition,
      openPackageDefinition,
      openEditRoutine,
      openCreateRoutine,
      handleDropRoutine,
      handleCompileOracleObject,
      resolveMessagePublishTarget,
      openMessageQueueWorkbench,
      openMessagePublishModal,
      handleMessagePublishSuccess,
  } = useSidebarObjectActions({
      connections,
      connectionIds,
      connectionIdSet,
      tabs,
      treeDataRef,
      setTreeData,
      setExpandedKeys,
      setLoadedKeys,
      addTab,
      updateQueryTabDraft,
      saveQuery,
      addSqlLog,
      closeTabsByDatabase,
      createDbForm,
      targetConnection,
      isCreateDbModalOpen,
      setIsCreateDbModalOpen,
      createDbCharsets,
      setCreateDbCharsets,
      createDbCollations,
      setCreateDbCollations,
      loadingCreateDbOptions,
      setLoadingCreateDbOptions,
      createSchemaForm,
      createSchemaTarget,
      setCreateSchemaTarget,
      setIsCreateSchemaModalOpen,
      renameSchemaForm,
      renameSchemaTarget,
      setRenameSchemaTarget,
      setIsRenameSchemaModalOpen,
      renameDbForm,
      renameDbTarget,
      setRenameDbTarget,
      setIsRenameDbModalOpen,
      renameTableForm,
      renameTableTarget,
      setRenameTableTarget,
      setIsRenameTableModalOpen,
      renameViewForm,
      renameViewTarget,
      setRenameViewTarget,
      setIsRenameViewModalOpen,
      renameSavedQueryForm,
      renameSavedQueryTarget,
      setRenameSavedQueryTarget,
      setIsRenameSavedQueryModalOpen,
      setMessagePublishTarget,
      buildRuntimeConfig,
      getConnectionNodeRef,
      getDatabaseNodeRef,
      extractObjectName,
      isPostgresSchemaDialect,
      loadDatabases,
      loadTables,
      openDesign,
      onDoubleClick,
      runExportWithProgress,
      setAIPanelVisible,
      addAIContext,
      migrateVisibilityForRenamedDatabase,
      removeVisibilityForDeletedDatabase,
      migrateVisibilityForRenamedSchema,
      removeVisibilityForDeletedSchema,
      migratePinnedDatabaseKey,
  });

  const refreshV2TableContextMenuStatsRef = useRef<(node: any) => void>(() => {});

  const {
      getConnectionNodeForAction,
      handleV2TableContextMenuAction,
      handleTableGroupSortAction,
      handleV2TableGroupContextMenuAction,
      handleV2DatabaseContextMenuAction,
      disconnectConnectionNode,
      deleteConnectionNode,
      handleV2ConnectionContextMenuAction,
      handleV2ConnectionGroupContextMenuAction,
  } = useSidebarV2ActionHandlers({
      connections,
      connectionTags,
      pinnedSidebarTables,
      pinnedSidebarDatabases,
      loadingNodesRef,
      treeDataRef,
      refreshConnectionResources,
      invalidateConnectionLoads,
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
      openMessageQueueWorkbench,
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
      openBatchConnectionWorkbench,
      handleRunSQLFile,
      handleDeleteDatabase,
      onCreateConnectionInGroup,
      onEditConnection,
      openConnectionVisibilitySettings,
      handleDuplicateConnection,
      buildConnectionRootQueryTabTitle,
      buildConnectionRootRedisCommandTabTitle,
      buildConnectionRootRedisMonitorTabTitle,
  });
  useEffect(() => {
      const handleDeleteConnection = (event: Event) => {
          const connectionId = String(
              (event as CustomEvent<{ connectionId?: string }>).detail?.connectionId || '',
          ).trim();
          const connection = connections.find((item) => item.id === connectionId);
          if (connection) deleteConnectionNode(getConnectionNodeForAction(connection));
      };
      window.addEventListener('gonavi:delete-connection', handleDeleteConnection);
      return () => window.removeEventListener('gonavi:delete-connection', handleDeleteConnection);
  }, [connections, deleteConnectionNode, getConnectionNodeForAction]);
  const {
      onSearch,
      searchScopeSummary,
      searchScopePopoverContent,
      displayTreeData,
      v2CommandSearchObjectMode,
      v2CommandSearchAiMode,
      filteredCommandSearchTreeItems,
      filteredCommandSearchActionItems,
      filteredCommandSearchRecentItems,
      commandSearchAiItem,
      flattenConnectionNodes,
      activeConnection,
      v2VisibleTreeData,
      effectiveTreeHeight,
      v2TreeMetrics,
  } = useSidebarSearchModel({
      searchScopes,
      setSearchScopes,
      setSearchValue,
      deferredSearchValue,
      deferredV2CommandSearchValue,
      v2CommandSearchValue,
      setV2CommandActiveIndex,
      v2ExplorerFilter,
      treeData: visibleSidebarTreeData,
      treeHeight,
      isV2CommandSearchOpen,
      connections,
      connectionIds,
      selectedKeys,
      selectedNodesRef,
      activeContext,
      activeTab,
      recentSqlLogs,
      shortcutOptions,
      activeShortcutPlatform,
      overlayTheme,
      darkMode,
      onCreateConnection,
      onToggleAI,
      onToggleLogPanel,
      setAIPanelVisible,
      extractObjectName,
  });
  const { destinationSections: commandSearchDestinations, flatItems: commandSearchFlatItems } = useCommandSearchDestinations({
      isOpen: isV2CommandSearchOpen,
      searchValue: deferredV2CommandSearchValue,
      isWebRuntime,
      onOpenSettingsNavigation,
      aiItems: commandSearchAiItem,
      treeItems: filteredCommandSearchTreeItems,
      actionItems: filteredCommandSearchActionItems,
      recentItems: filteredCommandSearchRecentItems,
  });
  // The tree never scrolls horizontally: long labels ellipsize and the user
  // widens the sidebar to read them. Wheel input only drives vertical scroll.
  const handleTreeWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
      if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
          markTreeScrollActivity();
      }
  }, [markTreeScrollActivity]);

  useSidebarLayoutEffect(() => {
      if (!sidebarTreeScrollRequest) return;

      const renderedTreeData = v2VisibleTreeData;
      const visiblePath = findSidebarNodePathByKey(
          renderedTreeData as SidebarLocateTreeNodeLike[],
          String(sidebarTreeScrollRequest.key),
      );
      if (!visiblePath) return;

      const expandedKeySet = new Set(expandedKeys.map((key) => String(key)));
      const visibleAncestorsExpanded = visiblePath
          .slice(0, -1)
          .every((key) => expandedKeySet.has(String(key)));
      if (!visibleAncestorsExpanded) return;

      const request = sidebarTreeScrollRequest;
      const findExactTreeRow = (): HTMLElement | null => {
          const nodeTitles = treeContainerRef.current
              ?.querySelectorAll<HTMLElement>('[data-sidebar-node-key]');
          const targetTitle = Array.from(nodeTitles || [])
              .find((element) => element.dataset.sidebarNodeKey === String(request.key));
          return (targetTitle?.closest('.ant-tree-treenode') as HTMLElement | null) ?? null;
      };
      return runSidebarTreeScrollRequest({
          request,
          isCurrent: () => sidebarTreeScrollRequestIdRef.current === request.id,
          scrollTreeToKey: (key, align) => treeRef.current?.scrollTo?.({ key, align }),
          findRow: findExactTreeRow,
          onSettled: (outcome) => {
              if (outcome === 'cancelled') return;
              setSidebarTreeScrollRequest((current) => current?.id === request.id ? null : current);
          },
      });
  }, [displayTreeData, expandedKeys, true, sidebarTreeScrollRequest, v2VisibleTreeData]);

  const hasRelationalObjectKindFilterConnection = connections.some(
      (connection) => getDataSourceCapabilities(connection.config).supportsRelationalObjectKindFilter,
  );
  return {
    handleCopyStructure, handleCopyTable, handleCopyTableName, handleExport, openExportDialog,
    handleCreateDatabase, handleCreateSchema, openRenameSchemaModal, handleRenameSchema,
    handleDeleteSchema, handleRenameDatabase, handleRenameTable, handleDeleteTable,
    handleTableDataDangerAction, openViewDefinition, openEditView, openCreateView,
    openCreateStarRocksMaterializedView, openCreateStarRocksExternalCatalog,
    openCreateStarRocksRollup, handleDropView, handleRenameView, openRenameSavedQueryModal,
    handleRenameSavedQuery, handleRevealSavedQueryInFolder, isSavedQueryUnmatched,
    handleRebindSavedQuery, openRoutineDefinition, openEventDefinition, openEditEvent,
    openSequenceDefinition, openPackageDefinition, openEditRoutine, openCreateRoutine,
    handleDropRoutine, handleCompileOracleObject, resolveMessagePublishTarget,
    openMessageQueueWorkbench, openMessagePublishModal, handleMessagePublishSuccess,
    refreshV2TableContextMenuStatsRef, getConnectionNodeForAction, handleV2TableContextMenuAction,
    handleTableGroupSortAction, handleV2TableGroupContextMenuAction,
    handleV2DatabaseContextMenuAction, disconnectConnectionNode, deleteConnectionNode,
    handleV2ConnectionContextMenuAction, handleV2ConnectionGroupContextMenuAction, onSearch,
    displayTreeData, v2CommandSearchObjectMode, v2CommandSearchAiMode,
    filteredCommandSearchTreeItems, filteredCommandSearchActionItems,
    filteredCommandSearchRecentItems, commandSearchAiItem, flattenConnectionNodes, activeConnection,
    v2VisibleTreeData, effectiveTreeHeight, v2TreeMetrics, commandSearchDestinations,
    commandSearchFlatItems, handleTreeWheel, hasRelationalObjectKindFilterConnection,
  };
};

export type SidebarObjectMenuActionsApi = ReturnType<typeof useSidebarObjectMenuActions>;
