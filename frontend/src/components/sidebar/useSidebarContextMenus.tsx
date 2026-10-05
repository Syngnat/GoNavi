import { useV2ExplorerFilterReset } from './useV2ExplorerFilterReset';
import { useSidebarV2ContextMenu } from './useSidebarV2ContextMenu';
import {
  isPostgresSchemaDialect,
  buildConnectionRootRedisCommandTabTitle,
  buildConnectionRootRedisMonitorTabTitle,
  buildConnectionRootQueryTabTitle,
} from './sidebarRootHelpers';
import { useRef, useCallback, useEffect, useMemo } from 'react';
import { type SidebarTreeConnectionStatus, renderSidebarV2TreeTitle } from './SidebarTreeTitle';
import {
  type SidebarTreeNode as TreeNode,
  resolveNacosNamespaceDiscoveryModeFromTreeNode,
  buildV2RailConnectionGroups,
} from '../sidebarV2Utils';
import {
  findSidebarNodePathByKey,
  type SidebarLocateTreeNodeLike,
  normalizeSidebarLocateConnectionRequest,
  collectSidebarLocateExpandKeys,
  SIDEBAR_LOCATE_CONNECTION_EVENT,
} from '../../utils/sidebarLocate';
import { useSidebarCommandSearchRunner } from './useSidebarCommandSearchRunner';
import { MenuProps } from 'antd';
import { buildSidebarNodeMenuItems } from './sidebarNodeMenu';
import { getMetadataDialect, shouldHideSchemaPrefix } from './sidebarMetadataLoaders';
import { useSidebarTitleRender } from './useSidebarTitleRender';
import type { SidebarObjectMenuActionsApi } from './useSidebarObjectMenuActions';
import type { SidebarSearchStateApi } from './useSidebarSearchState';
import type { SidebarStoreStateApi } from './useSidebarStoreState';
import type { SidebarJvmAndSavedQueriesApi } from './useSidebarJvmAndSavedQueries';
import type { SidebarTreeViewStateApi } from './useSidebarTreeViewState';
import type { SidebarVisibilityApi } from './useSidebarVisibility';
import type { SidebarTreeDataApi } from './useSidebarTreeData';
import type { SidebarTreeEventsApi } from './useSidebarTreeEvents';
import type { SidebarLocateApi } from './useSidebarLocate';
import type { SidebarTitlebarSyncApi } from './useSidebarTitlebarSync';
import type { SidebarConnectionRefreshApi } from './useSidebarConnectionRefresh';
import type { SidebarProps } from '../Sidebar';

export interface UseSidebarContextMenusInput {
  activeConnection: SidebarObjectMenuActionsApi['activeConnection'];
  v2ExplorerFilter: SidebarSearchStateApi['v2ExplorerFilter'];
  setV2ExplorerFilter: SidebarSearchStateApi['setV2ExplorerFilter'];
  connections: SidebarStoreStateApi['connections'];
  connectionTags: SidebarStoreStateApi['connectionTags'];
  activeShortcutPlatform: SidebarStoreStateApi['activeShortcutPlatform'];
  flattenConnectionNodes: SidebarObjectMenuActionsApi['flattenConnectionNodes'];
  v2TreeMetrics: SidebarObjectMenuActionsApi['v2TreeMetrics'];
  tableSortPreference: SidebarStoreStateApi['tableSortPreference'];
  pinnedSidebarTables: SidebarStoreStateApi['pinnedSidebarTables'];
  pinnedSidebarDatabases: SidebarStoreStateApi['pinnedSidebarDatabases'];
  getConnectionNodeForAction: SidebarObjectMenuActionsApi['getConnectionNodeForAction'];
  handleV2TableContextMenuAction: SidebarObjectMenuActionsApi['handleV2TableContextMenuAction'];
  handleV2TableGroupContextMenuAction: SidebarObjectMenuActionsApi['handleV2TableGroupContextMenuAction'];
  handleV2DatabaseContextMenuAction: SidebarObjectMenuActionsApi['handleV2DatabaseContextMenuAction'];
  handleV2ConnectionContextMenuAction: SidebarObjectMenuActionsApi['handleV2ConnectionContextMenuAction'];
  handleV2ConnectionGroupContextMenuAction: SidebarObjectMenuActionsApi['handleV2ConnectionGroupContextMenuAction'];
  buildRuntimeConfig: SidebarJvmAndSavedQueriesApi['buildRuntimeConfig'];
  extractObjectName: SidebarJvmAndSavedQueriesApi['extractObjectName'];
  loadTables: SidebarJvmAndSavedQueriesApi['loadTables'];
  getDatabaseNodeRef: SidebarJvmAndSavedQueriesApi['getDatabaseNodeRef'];
  handleExportSchemaSQL: SidebarTreeViewStateApi['handleExportSchemaSQL'];
  handleDeleteSchema: SidebarObjectMenuActionsApi['handleDeleteSchema'];
  openRenameSchemaModal: SidebarObjectMenuActionsApi['openRenameSchemaModal'];
  resolveMessagePublishTarget: SidebarObjectMenuActionsApi['resolveMessagePublishTarget'];
  openSchemaVisibilitySettings: SidebarVisibilityApi['openSchemaVisibilitySettings'];
  supportsConnectionVisibility: SidebarVisibilityApi['supportsConnectionVisibility'];
  addSqlLog: SidebarStoreStateApi['addSqlLog'];
  refreshV2TableContextMenuStatsRef: SidebarObjectMenuActionsApi['refreshV2TableContextMenuStatsRef'];
  sidebarTableMetadataFields: SidebarStoreStateApi['sidebarTableMetadataFields'];
  sidebarTreeDropPreview: SidebarTreeViewStateApi['sidebarTreeDropPreview'];
  treeDataRef: SidebarTreeViewStateApi['treeDataRef'];
  setSearchValue: SidebarSearchStateApi['setSearchValue'];
  mergeExpandedTreeKeys: SidebarTreeDataApi['mergeExpandedTreeKeys'];
  setSidebarSelectedKeys: SidebarSearchStateApi['setSidebarSelectedKeys'];
  selectedNodesRef: SidebarSearchStateApi['selectedNodesRef'];
  scrollSidebarTreeToKey: SidebarTreeDataApi['scrollSidebarTreeToKey'];
  activeContext: SidebarStoreStateApi['activeContext'];
  activeTab: SidebarStoreStateApi['activeTab'];
  addTab: SidebarStoreStateApi['addTab'];
  clearStaleHostStateOnSelection: SidebarTreeEventsApi['clearStaleHostStateOnSelection'];
  closeV2CommandSearch: SidebarSearchStateApi['closeV2CommandSearch'];
  commandSearchFlatItems: SidebarObjectMenuActionsApi['commandSearchFlatItems'];
  connectionIds: SidebarSearchStateApi['connectionIds'];
  queryCapableConnectionIds: SidebarSearchStateApi['queryCapableConnectionIds'];
  findTreeNodeByKeyRef: SidebarTreeViewStateApi['findTreeNodeByKeyRef'];
  locateObjectInSidebar: SidebarLocateApi['locateObjectInSidebar'];
  loadDatabases: SidebarJvmAndSavedQueriesApi['loadDatabases'];
  onDoubleClick: SidebarTreeEventsApi['onDoubleClick'];
  publishTitlebarSelectionForNode: SidebarTitlebarSyncApi['publishTitlebarSelectionForNode'];
  setActiveContext: SidebarStoreStateApi['setActiveContext'];
  setV2CommandActiveIndex: SidebarSearchStateApi['setV2CommandActiveIndex'];
  v2CommandActiveIndex: SidebarSearchStateApi['v2CommandActiveIndex'];
  expandConnectionFromRailRef: SidebarTreeViewStateApi['expandConnectionFromRailRef'];
  onEnsureSidebarExpanded: SidebarProps['onEnsureSidebarExpanded'];
  waitForSidebarLoadKey: SidebarLocateApi['waitForSidebarLoadKey'];
  onCreateConnectionInGroup: SidebarProps['onCreateConnectionInGroup'];
  onEditConnection: SidebarProps['onEditConnection'];
  openConnectionVisibilitySettings: SidebarVisibilityApi['openConnectionVisibilitySettings'];
  handleTableGroupSortAction: SidebarObjectMenuActionsApi['handleTableGroupSortAction'];
  disconnectConnectionNode: SidebarObjectMenuActionsApi['disconnectConnectionNode'];
  deleteConnectionNode: SidebarObjectMenuActionsApi['deleteConnectionNode'];
  openBatchTableWorkbench: SidebarTreeViewStateApi['openBatchTableWorkbench'];
  openBatchDatabaseWorkbench: SidebarTreeViewStateApi['openBatchDatabaseWorkbench'];
  openBatchConnectionWorkbench: SidebarTreeViewStateApi['openBatchConnectionWorkbench'];
  openCreateView: SidebarObjectMenuActionsApi['openCreateView'];
  openCreateStarRocksMaterializedView: SidebarObjectMenuActionsApi['openCreateStarRocksMaterializedView'];
  openCreateRoutine: SidebarObjectMenuActionsApi['openCreateRoutine'];
  openCreateStarRocksExternalCatalog: SidebarObjectMenuActionsApi['openCreateStarRocksExternalCatalog'];
  openEditView: SidebarObjectMenuActionsApi['openEditView'];
  handleDropView: SidebarObjectMenuActionsApi['handleDropView'];
  openViewDefinition: SidebarObjectMenuActionsApi['openViewDefinition'];
  openRoutineDefinition: SidebarObjectMenuActionsApi['openRoutineDefinition'];
  openEditRoutine: SidebarObjectMenuActionsApi['openEditRoutine'];
  handleDropRoutine: SidebarObjectMenuActionsApi['handleDropRoutine'];
  handleCompileOracleObject: SidebarObjectMenuActionsApi['handleCompileOracleObject'];
  openEventDefinition: SidebarObjectMenuActionsApi['openEventDefinition'];
  openEditEvent: SidebarObjectMenuActionsApi['openEditEvent'];
  openSequenceDefinition: SidebarObjectMenuActionsApi['openSequenceDefinition'];
  openPackageDefinition: SidebarObjectMenuActionsApi['openPackageDefinition'];
  openMessageQueueWorkbench: SidebarObjectMenuActionsApi['openMessageQueueWorkbench'];
  openMessagePublishModal: SidebarObjectMenuActionsApi['openMessagePublishModal'];
  openCreateStarRocksRollup: SidebarObjectMenuActionsApi['openCreateStarRocksRollup'];
  handleCopyTableName: SidebarObjectMenuActionsApi['handleCopyTableName'];
  handleCopyTable: SidebarObjectMenuActionsApi['handleCopyTable'];
  handleCopyStructure: SidebarObjectMenuActionsApi['handleCopyStructure'];
  handleExport: SidebarObjectMenuActionsApi['handleExport'];
  handleTableDataDangerAction: SidebarObjectMenuActionsApi['handleTableDataDangerAction'];
  handleDeleteTable: SidebarObjectMenuActionsApi['handleDeleteTable'];
  openExportDialog: SidebarObjectMenuActionsApi['openExportDialog'];
  isSavedQueryUnmatched: SidebarObjectMenuActionsApi['isSavedQueryUnmatched'];
  handleRebindSavedQuery: SidebarObjectMenuActionsApi['handleRebindSavedQuery'];
  openRenameSavedQueryModal: SidebarObjectMenuActionsApi['openRenameSavedQueryModal'];
  handleRevealSavedQueryInFolder: SidebarObjectMenuActionsApi['handleRevealSavedQueryInFolder'];
  isStructureOnlyDbType: SidebarTreeEventsApi['isStructureOnlyDbType'];
  openNewTableDesign: SidebarTreeEventsApi['openNewTableDesign'];
  createTagForm: SidebarTreeViewStateApi['createTagForm'];
  setRenameViewTarget: SidebarTreeViewStateApi['setRenameViewTarget'];
  setIsCreateTagModalOpen: SidebarTreeViewStateApi['setIsCreateTagModalOpen'];
  removeConnectionTag: SidebarStoreStateApi['removeConnectionTag'];
  setExpandedKeys: SidebarTreeViewStateApi['setExpandedKeys'];
  setLoadedKeys: SidebarSearchStateApi['setLoadedKeys'];
  loadingNodesRef: SidebarSearchStateApi['loadingNodesRef'];
  refreshConnectionResources: SidebarConnectionRefreshApi['refreshConnectionResources'];
  handleDuplicateConnection: SidebarTitlebarSyncApi['handleDuplicateConnection'];
  moveConnectionToTag: SidebarStoreStateApi['moveConnectionToTag'];
  setTargetConnection: SidebarTreeViewStateApi['setTargetConnection'];
  setIsCreateDbModalOpen: SidebarTreeViewStateApi['setIsCreateDbModalOpen'];
  handleRunSQLFile: SidebarTreeDataApi['handleRunSQLFile'];
  handleAddExternalSQLDirectory: SidebarTreeDataApi['handleAddExternalSQLDirectory'];
  openCreateExternalSQLFileModal: SidebarTreeDataApi['openCreateExternalSQLFileModal'];
  openCreateExternalSQLDirectoryModal: SidebarTreeDataApi['openCreateExternalSQLDirectoryModal'];
  openRenameExternalSQLDirectoryModal: SidebarTreeDataApi['openRenameExternalSQLDirectoryModal'];
  handleRefreshExternalSQLDirectory: SidebarTreeDataApi['handleRefreshExternalSQLDirectory'];
  handleDeleteExternalSQLDirectory: SidebarTreeDataApi['handleDeleteExternalSQLDirectory'];
  handleRemoveExternalSQLDirectory: SidebarTreeDataApi['handleRemoveExternalSQLDirectory'];
  openExternalSQLFile: SidebarTreeDataApi['openExternalSQLFile'];
  openExternalSQLBindingModal: SidebarTreeDataApi['openExternalSQLBindingModal'];
  openRenameExternalSQLFileModal: SidebarTreeDataApi['openRenameExternalSQLFileModal'];
  handleDeleteExternalSQLFile: SidebarTreeDataApi['handleDeleteExternalSQLFile'];
  renameViewForm: SidebarTreeViewStateApi['renameViewForm'];
  setIsRenameViewModalOpen: SidebarTreeViewStateApi['setIsRenameViewModalOpen'];
  openDesign: SidebarTreeEventsApi['openDesign'];
  setRenameTableTarget: SidebarTreeViewStateApi['setRenameTableTarget'];
  renameTableForm: SidebarTreeViewStateApi['renameTableForm'];
  setIsRenameTableModalOpen: SidebarTreeViewStateApi['setIsRenameTableModalOpen'];
  resolveSavedQueryDisplayName: SidebarJvmAndSavedQueriesApi['resolveSavedQueryDisplayName'];
  deleteQuery: SidebarStoreStateApi['deleteQuery'];
  savedQueryGroups: SidebarStoreStateApi['savedQueryGroups'];
  openSavedQueryGroupModal: SidebarJvmAndSavedQueriesApi['openSavedQueryGroupModal'];
  deleteSavedQueryGroup: SidebarStoreStateApi['deleteSavedQueryGroup'];
  moveSavedQueryToGroup: SidebarStoreStateApi['moveSavedQueryToGroup'];
  setTreeData: SidebarStoreStateApi['setTreeData'];
  connectionStates: SidebarTreeViewStateApi['connectionStates'];
  sidebarRootOrder: SidebarStoreStateApi['sidebarRootOrder'];
  rootSortMode: SidebarStoreStateApi['rootSortMode'];
  rootConnectionSortMode: SidebarStoreStateApi['rootConnectionSortMode'];
}

export const useSidebarContextMenus = ({
  activeConnection, v2ExplorerFilter, setV2ExplorerFilter, connections, connectionTags,
  activeShortcutPlatform, flattenConnectionNodes, v2TreeMetrics, tableSortPreference,
  pinnedSidebarTables, pinnedSidebarDatabases, getConnectionNodeForAction,
  handleV2TableContextMenuAction, handleV2TableGroupContextMenuAction,
  handleV2DatabaseContextMenuAction, handleV2ConnectionContextMenuAction,
  handleV2ConnectionGroupContextMenuAction, buildRuntimeConfig, extractObjectName, loadTables,
  getDatabaseNodeRef, handleExportSchemaSQL, handleDeleteSchema, openRenameSchemaModal,
  resolveMessagePublishTarget, openSchemaVisibilitySettings, supportsConnectionVisibility,
  addSqlLog, refreshV2TableContextMenuStatsRef, sidebarTableMetadataFields, sidebarTreeDropPreview,
  treeDataRef, setSearchValue, mergeExpandedTreeKeys, setSidebarSelectedKeys, selectedNodesRef,
  scrollSidebarTreeToKey, activeContext, activeTab, addTab, clearStaleHostStateOnSelection,
  closeV2CommandSearch, commandSearchFlatItems, connectionIds, queryCapableConnectionIds,
  findTreeNodeByKeyRef, locateObjectInSidebar, loadDatabases, onDoubleClick,
  publishTitlebarSelectionForNode, setActiveContext, setV2CommandActiveIndex, v2CommandActiveIndex,
  expandConnectionFromRailRef, onEnsureSidebarExpanded, waitForSidebarLoadKey,
  onCreateConnectionInGroup, onEditConnection, openConnectionVisibilitySettings,
  handleTableGroupSortAction, disconnectConnectionNode, deleteConnectionNode,
  openBatchTableWorkbench, openBatchDatabaseWorkbench, openBatchConnectionWorkbench, openCreateView,
  openCreateStarRocksMaterializedView, openCreateRoutine, openCreateStarRocksExternalCatalog,
  openEditView, handleDropView, openViewDefinition, openRoutineDefinition, openEditRoutine,
  handleDropRoutine, handleCompileOracleObject, openEventDefinition, openEditEvent,
  openSequenceDefinition, openPackageDefinition, openMessageQueueWorkbench, openMessagePublishModal,
  openCreateStarRocksRollup, handleCopyTableName, handleCopyTable, handleCopyStructure,
  handleExport, handleTableDataDangerAction, handleDeleteTable, openExportDialog,
  isSavedQueryUnmatched, handleRebindSavedQuery, openRenameSavedQueryModal,
  handleRevealSavedQueryInFolder, isStructureOnlyDbType, openNewTableDesign, createTagForm,
  setRenameViewTarget, setIsCreateTagModalOpen, removeConnectionTag, setExpandedKeys, setLoadedKeys,
  loadingNodesRef, refreshConnectionResources, handleDuplicateConnection, moveConnectionToTag,
  setTargetConnection, setIsCreateDbModalOpen, handleRunSQLFile, handleAddExternalSQLDirectory,
  openCreateExternalSQLFileModal, openCreateExternalSQLDirectoryModal,
  openRenameExternalSQLDirectoryModal, handleRefreshExternalSQLDirectory,
  handleDeleteExternalSQLDirectory, handleRemoveExternalSQLDirectory, openExternalSQLFile,
  openExternalSQLBindingModal, openRenameExternalSQLFileModal, handleDeleteExternalSQLFile,
  renameViewForm, setIsRenameViewModalOpen, openDesign, setRenameTableTarget, renameTableForm,
  setIsRenameTableModalOpen, resolveSavedQueryDisplayName, deleteQuery, savedQueryGroups,
  openSavedQueryGroupModal, deleteSavedQueryGroup, moveSavedQueryToGroup, setTreeData,
  connectionStates, sidebarRootOrder, rootSortMode, rootConnectionSortMode,
}: UseSidebarContextMenusInput) => {
  // Drops a filter belonging to another workbench family, so a stale one cannot
  // empty the tree. The slot derives the same family from the same connection, so
  // the two cannot disagree. See the hook for the reasoning.
  useV2ExplorerFilterReset(activeConnection, v2ExplorerFilter, setV2ExplorerFilter);

  const {
      contextMenu,
      setContextMenu,
      contextMenuPortalRef,
      openV2ConnectionContextMenu,
      getV2TreeMetaText,
      renderV2SidebarContextMenuContent,
      fetchV2TableContextMenuStats,
      refreshV2TableContextMenuStats,
  } = useSidebarV2ContextMenu({
      connections,
      connectionTags,
      activeShortcutPlatform,
      flattenConnectionNodes,
      v2TreeMetrics,
      tableSortPreference,
      pinnedSidebarTables,
      pinnedSidebarDatabases,
      getConnectionNodeForAction,
      buildRuntimeConfig,
      extractObjectName,
      isPostgresSchemaDialect,
      loadTables,
      getDatabaseNodeRef,
      handleExportSchemaSQL,
      handleDeleteSchema,
      openRenameSchemaModal,
      openSchemaVisibilitySettings,
      supportsConnectionVisibility,
      resolveMessagePublishTarget,
      addSqlLog,
      handleV2TableContextMenuAction,
      handleV2TableGroupContextMenuAction,
      handleV2DatabaseContextMenuAction,
      handleV2ConnectionContextMenuAction,
      handleV2ConnectionGroupContextMenuAction,
  });
  refreshV2TableContextMenuStatsRef.current = refreshV2TableContextMenuStats;
  const getV2TreeMetaTextRef = useRef(getV2TreeMetaText);
  getV2TreeMetaTextRef.current = getV2TreeMetaText;

  const renderV2TreeTitle = useCallback((node: any, hoverTitle: string, connectionStatus: SidebarTreeConnectionStatus) => renderSidebarV2TreeTitle({
      node,
      hoverTitle,
      connectionStatus,
      getV2TreeMetaText: getV2TreeMetaTextRef.current,
      sidebarTableMetadataFields,
      sidebarDropPlacement: sidebarTreeDropPreview?.nodeKey === String(node.key || '')
          ? sidebarTreeDropPreview.placement
          : null,
  }), [
      sidebarTreeDropPreview,
      sidebarTableMetadataFields,
  ]);

  const revealCommandSearchNode = useCallback((node: TreeNode) => {
      const targetKey = node.key;
      const path = findSidebarNodePathByKey(
          treeDataRef.current as SidebarLocateTreeNodeLike[],
          String(targetKey),
      );
      setSearchValue('');
      setV2ExplorerFilter('all');
      if (path) mergeExpandedTreeKeys(path.slice(0, -1));
      setSidebarSelectedKeys([targetKey]);
      selectedNodesRef.current = [node];
      scrollSidebarTreeToKey(targetKey, 'center');
  }, [mergeExpandedTreeKeys, scrollSidebarTreeToKey, setSidebarSelectedKeys]);

  const {
      selectConnectionFromRail,
      runCommandSearchItem,
      handleV2CommandSearchKeyDown,
  } = useSidebarCommandSearchRunner({
      activeContext,
      activeTab,
      addTab,
      clearStaleHostStateOnSelection,
      closeV2CommandSearch,
      commandSearchFlatItems,
      connectionIds,
      queryCapableConnectionIds,
      findTreeNodeByKeyRef,
      locateObjectInSidebar,
      loadDatabases,
      mergeExpandedTreeKeys,
      onDoubleClick,
      publishTitlebarSelectionForNode,
      revealCommandSearchNode,
      scrollSidebarTreeToKey,
      selectedNodesRef,
      setActiveContext,
      setSelectedKeys: setSidebarSelectedKeys,
      setV2CommandActiveIndex,
      treeDataRef,
      v2CommandActiveIndex,
  });
  expandConnectionFromRailRef.current = (connectionId: string) => {
      const conn = connections.find((item) => item.id === connectionId);
      if (conn) {
          void selectConnectionFromRail(conn);
      }
  };

  const locateConnectionInSidebar = useCallback(async (detail: unknown) => {
      const request = normalizeSidebarLocateConnectionRequest(detail);
      if (!request) return;

      const connection = connections.find((item) => item.id === request.connectionId);
      if (!connection) return;

      onEnsureSidebarExpanded?.();
      setSearchValue('');
      setV2ExplorerFilter('all');
      mergeExpandedTreeKeys(collectSidebarLocateExpandKeys(
          treeDataRef.current as SidebarLocateTreeNodeLike[],
          connection.id,
      ));
      await selectConnectionFromRail(connection);

      if (!request.dbName) {
          scrollSidebarTreeToKey(connection.id);
          return;
      }

      await waitForSidebarLoadKey(`dbs-${connection.id}`);
      const databaseNode = findTreeNodeByKeyRef.current(
          treeDataRef.current,
          `${connection.id}-${request.dbName}`,
      );
      if (!databaseNode) {
          scrollSidebarTreeToKey(connection.id);
          return;
      }

      const dbName = String(databaseNode.dataRef?.dbName || request.dbName).trim();
      setSidebarSelectedKeys([databaseNode.key]);
      selectedNodesRef.current = [databaseNode];
      setActiveContext({ connectionId: connection.id, dbName });
      publishTitlebarSelectionForNode(databaseNode);
      scrollSidebarTreeToKey(databaseNode.key);
  }, [
      connections,
      findTreeNodeByKeyRef,
      mergeExpandedTreeKeys,
      onEnsureSidebarExpanded,
      publishTitlebarSelectionForNode,
      scrollSidebarTreeToKey,
      selectConnectionFromRail,
      selectedNodesRef,
      setActiveContext,
      setSearchValue,
      setSidebarSelectedKeys,
      setV2ExplorerFilter,
      treeDataRef,
  ]);

  useEffect(() => {
      const handleLocateSidebarConnection = (event: Event) => {
          void locateConnectionInSidebar((event as CustomEvent).detail);
      };
      window.addEventListener(SIDEBAR_LOCATE_CONNECTION_EVENT, handleLocateSidebarConnection as EventListener);
      return () => {
          window.removeEventListener(SIDEBAR_LOCATE_CONNECTION_EVENT, handleLocateSidebarConnection as EventListener);
      };
  }, [locateConnectionInSidebar]);

  const getNodeMenuItems = (node: any): MenuProps['items'] => buildSidebarNodeMenuItems(node, {
    addTab,
    getMetadataDialect,
    shouldHideSchemaPrefix,
    openSchemaVisibilitySettings,
    openConnectionVisibilitySettings,
    supportsConnectionVisibility,
    handleV2DatabaseContextMenuAction,
    isPostgresSchemaDialect,
    handleExportSchemaSQL,
    openRenameSchemaModal,
    loadTables,
    getDatabaseNodeRef,
    handleDeleteSchema,
    tableSortPreference,
    isStructureOnlyDbType,
    openNewTableDesign,
    handleTableGroupSortAction,
    openCreateView,
    openCreateStarRocksMaterializedView,
    openCreateRoutine,
    createTagForm,
    setRenameViewTarget,
    setIsCreateTagModalOpen,
    removeConnectionTag,
    onCreateConnectionInGroup,
    setExpandedKeys,
    setLoadedKeys,
    loadingNodesRef,
    loadDatabases,
    refreshConnectionResources,
    buildConnectionRootRedisCommandTabTitle,
    buildConnectionRootRedisMonitorTabTitle,
    onEditConnection,
    handleDuplicateConnection,
    disconnectConnectionNode,
    deleteConnectionNode,
    connectionTags,
    moveConnectionToTag,
    setTargetConnection,
    setIsCreateDbModalOpen,
    buildConnectionRootQueryTabTitle,
    handleRunSQLFile,
    openCreateStarRocksExternalCatalog,
    openEditView,
    renameViewForm,
    setIsRenameViewModalOpen,
    handleDropView,
    onDoubleClick,
    openViewDefinition,
    openRoutineDefinition,
    openEditRoutine,
    handleDropRoutine,
    handleCompileOracleObject,
    openEventDefinition,
    openEditEvent,
    openSequenceDefinition,
    openPackageDefinition,
    resolveMessagePublishTarget,
    openMessageQueueWorkbench,
    openMessagePublishModal,
    openDesign,
    openCreateStarRocksRollup,
    handleCopyTableName,
    handleCopyTable,
    handleCopyStructure,
    handleExport,
    setRenameTableTarget,
    renameTableForm,
    setIsRenameTableModalOpen,
    handleTableDataDangerAction,
    handleDeleteTable,
    openExportDialog,
    openBatchTableWorkbench,
    openBatchDatabaseWorkbench,
    openBatchConnectionWorkbench,
    isSavedQueryUnmatched,
    connections,
    handleRebindSavedQuery,
    openRenameSavedQueryModal,
    handleRevealSavedQueryInFolder,
    resolveSavedQueryDisplayName,
    deleteQuery,
    savedQueryGroups,
    openSavedQueryGroupModal,
    deleteSavedQueryGroup,
    moveSavedQueryToGroup,
    treeDataRef,
    getNacosNamespaceDiscoveryMode: (connectionId: string) =>
      resolveNacosNamespaceDiscoveryModeFromTreeNode(
        findTreeNodeByKeyRef.current(treeDataRef.current, connectionId),
      ),
    setTreeData,
    handleAddExternalSQLDirectory,
    openCreateExternalSQLFileModal,
    openCreateExternalSQLDirectoryModal,
    openRenameExternalSQLDirectoryModal,
    handleRefreshExternalSQLDirectory,
    handleDeleteExternalSQLDirectory,
    handleRemoveExternalSQLDirectory,
    openExternalSQLFile,
    openExternalSQLBindingModal,
    openRenameExternalSQLFileModal,
    handleDeleteExternalSQLFile,
    extractObjectName,
  });

  const titleRender = useSidebarTitleRender({
      connectionStates,
      renderV2TreeTitle,
      handleAddExternalSQLDirectory,
  });
  const v2RailConnectionGroups = useMemo(
      () => buildV2RailConnectionGroups(connections, connectionTags, sidebarRootOrder, rootSortMode, rootConnectionSortMode),
      [connections, connectionTags, sidebarRootOrder, rootSortMode, rootConnectionSortMode],
  );
  return {
    contextMenu, setContextMenu, contextMenuPortalRef, openV2ConnectionContextMenu,
    renderV2SidebarContextMenuContent, runCommandSearchItem, handleV2CommandSearchKeyDown,
    getNodeMenuItems, titleRender, v2RailConnectionGroups,
  };
};

export type SidebarContextMenusApi = ReturnType<typeof useSidebarContextMenus>;
