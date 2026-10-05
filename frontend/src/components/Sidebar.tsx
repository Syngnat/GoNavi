import SidebarConnectionRail from './sidebar/SidebarConnectionRail';
import TitleBarQuickActionsHost from './TitleBarQuickActionsHost';
import SidebarSearchPanel from './sidebar/SidebarSearchPanel';
import { loadSchemas } from './sidebar/sidebarMetadataLoaders';
import { SidebarEntityModals } from './sidebar/SidebarEntityModals';
import { SavedQueryGroupModal } from './sidebar/SavedQueryGroupModal';
import DatabaseSchemaVisibilityModal from './sidebar/DatabaseSchemaVisibilityModal';
import { useSidebarObjectActions } from './sidebar/useSidebarObjectActions';
import { useSidebarTreeLoaders } from './sidebar/useSidebarTreeLoaders';
export { formatSidebarDriverAgentUpdateWarning } from './sidebar/useSidebarTreeLoaders';
import {
  ExternalSQLBindingModal,
  ExternalSQLFileModal,
} from './sidebar/SidebarExternalSqlWorkflow';
export {
  buildSQLFileExecutionFooter,
  SQLFileExecutionProgressContent,
} from './sidebar/SidebarExternalSqlWorkflow';
export type {
  SQLFileExecutionProgressState,
  SQLFileExecutionStatus,
} from './sidebar/SidebarExternalSqlWorkflow';

// 重新导出，保持外部测试文件的 `from './Sidebar'` 兼容
export {
  V2_RAIL_UNGROUPED_CONNECTION_GROUP_ID,
  formatSidebarRowCount,
  hasSidebarLazyChildren,
  shouldLoadSidebarNodeOnExpand,
  getV2RailConnectionGroupBadgeText,
  isV2SidebarObjectNode,
  resolveV2ObjectGroupTitle,
  clearSidebarHostConnectionState,
  shouldDeferSidebarTitlebarSelection,
  resolveSidebarTableNameForCopy,
  resolveSidebarDatabaseNameForCopy,
  parseV2CommandSearchQuery,
} from './sidebar/sidebarHelpers';
import React from 'react';
import { createPortal } from 'react-dom';
import { APP_POPUP_Z_INDEX } from '../utils/overlayZIndex';
import { V2ExplorerSearchAction, V2ExplorerToolbarActions } from './sidebar/SidebarExplorerToolbar';
		import { SavedConnection } from '../types';
import FindInDatabaseModal from './FindInDatabaseModal';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { getDataSourceCapabilities } from '../utils/dataSourceCapabilities';
import { t } from '../i18n';
import MessagePublishModal from './MessagePublishModal';
import { SIDEBAR_CONTEXT_MENU_FALLBACK_HEIGHT, SIDEBAR_CONTEXT_MENU_FALLBACK_WIDTH } from './sidebarCoreUtils';
export { resolveSidebarContextMenuPosition } from './sidebarCoreUtils';
export type { ExternalSQLFileModalMode, SearchScope } from './sidebarCoreUtils';

import { applySidebarDatabasePinning, buildSidebarTableChildrenForUi, buildSidebarConnectionTagTree, buildV2RailConnectionGroups, buildV2SidebarDatabaseSectionedChildren, buildV2SidebarTableSectionedChildren, resolveSidebarTreeRowHeight, collectSidebarSubtreeKeys, filterV2CommandSearchTreeItems, filterV2ExplorerTreeByKind, isSidebarDatabasePinned, isSidebarTablePinned, isConnectionTagDescendant, normalizeSidebarTreeRelativeDropPosition, resolveSidebarConnectionIdFromKey, resolveSidebarConnectionRefreshKeys, resolveSidebarDropDomHit, resolveSidebarDropInsertBefore, resolveSidebarDropNodeFromDomEvent, resolveSidebarDropTargetMetricsFromDomEvent, resolveSidebarTreeDropPlacement, resolveSidebarDatabaseTreePruneKeys, resolveSidebarNodeConnectionId, resolveV2ActiveConnectionId, shouldClearSidebarNodeChildrenOnCollapse, shouldSkipSidebarLoadOnExpandWhileDragging, shouldSkipSidebarSelectWhileDragging, shouldCloseV2CommandSearchOnGlobalKey, shouldRunV2CommandSearchEnter, sortSidebarTableEntries, type SidebarTreeNode as TreeNode } from './sidebarV2Utils';

export {
  applySidebarDatabasePinning,
  buildSidebarTableChildrenForUi,
  buildSidebarConnectionTagTree,
  buildV2RailConnectionGroups,
  buildV2SidebarDatabaseSectionedChildren,
  buildV2SidebarTableSectionedChildren,
  resolveSidebarTreeRowHeight,
  collectSidebarSubtreeKeys,
  filterV2CommandSearchTreeItems,
  filterV2ExplorerTreeByKind,
  isSidebarDatabasePinned,
  isSidebarTablePinned,
  isConnectionTagDescendant,
  normalizeSidebarTreeRelativeDropPosition,
  resolveSidebarConnectionIdFromKey,
  resolveSidebarConnectionRefreshKeys,
  resolveSidebarDropDomHit,
  resolveSidebarDropInsertBefore,
  resolveSidebarDropNodeFromDomEvent,
  resolveSidebarDropTargetMetricsFromDomEvent,
  resolveSidebarTreeDropPlacement,
  resolveSidebarDatabaseTreePruneKeys,
  resolveSidebarNodeConnectionId,
  resolveV2ActiveConnectionId,
  shouldClearSidebarNodeChildrenOnCollapse,
  shouldSkipSidebarLoadOnExpandWhileDragging,
  shouldSkipSidebarSelectWhileDragging,
  shouldCloseV2CommandSearchOnGlobalKey,
  shouldRunV2CommandSearchEnter,
  sortSidebarTableEntries,
};
export {
  resolveSidebarHostGroupDropDestination,
  resolveSidebarTagDropInsertBefore,
} from './sidebarV2Utils';
export type { SidebarDropDomHit, SidebarTreeDropPlacement, V2CommandSearchItem, V2RailConnectionGroup } from './sidebarV2Utils';

// 懒加载节点的 key 映射与加载态判定统一放在 ./sidebar/sidebarSwitcherState，
// 这里只保留转出以维持既有引用（含 Sidebar.locate-toolbar.test.tsx）。
export {
  resolveSidebarSwitcherLoadKey,
  shouldKeepSidebarSwitcherCollapsedWhileLoading,
  type SidebarTreeSwitcherNodeLike,
} from './sidebar/sidebarSwitcherState';

import { useSidebarStoreState } from './sidebar/useSidebarStoreState';
import { useSidebarSearchState } from './sidebar/useSidebarSearchState';
import { useSidebarTreeViewState } from './sidebar/useSidebarTreeViewState';
import { useSidebarTitlebarSync } from './sidebar/useSidebarTitlebarSync';
import { useSidebarTreeData } from './sidebar/useSidebarTreeData';
import { useSidebarLocate } from './sidebar/useSidebarLocate';
import { useSidebarTreeEvents } from './sidebar/useSidebarTreeEvents';
import { useSidebarJvmAndSavedQueries } from './sidebar/useSidebarJvmAndSavedQueries';
import { useSidebarConnectionRefresh } from './sidebar/useSidebarConnectionRefresh';
import { useSidebarVisibility } from './sidebar/useSidebarVisibility';
import { useSidebarObjectMenuActions } from './sidebar/useSidebarObjectMenuActions';
import { useSidebarContextMenus } from './sidebar/useSidebarContextMenus';
import { useSidebarTreeDnd } from './sidebar/useSidebarTreeDnd';
import { useSidebarToolbarModel } from './sidebar/useSidebarToolbarModel';
import { useLateBoundCallback } from '../hooks/useLateBoundCallback';
import { SidebarObjectExplorer } from './sidebar/SidebarObjectExplorer';
import type { SidebarProps } from './sidebar/sidebarProps';
export type { SidebarProps } from './sidebar/sidebarProps';

export { resolveNacosServiceGroupsRefreshTarget } from './sidebar/sidebarRootHelpers';
export { buildAllSavedQueriesTreeNode } from './sidebar/sidebarSavedQueriesTreeNode';
export { V2ExplorerContextSummary } from './sidebar/V2ExplorerContextSummary';
export type { V2ExplorerContext } from './sidebar/V2ExplorerContextSummary';

export { V2ExplorerToolbarActions } from './sidebar/SidebarExplorerToolbar';
export type {
  V2ExplorerToolbarActionLabels,
  V2ExplorerToolbarToggleAction,
} from './sidebar/SidebarExplorerToolbar';

const Sidebar: React.FC<SidebarProps> = React.memo(({
  onCreateConnection,
  onCreateConnectionInGroup,
  onEditConnection,
  onOpenSettings,
  onOpenSettingsNavigation,
  activeSettingsCenterPaneKey,
  onCheckUpdate,
  hideTitlebarAboutAction = false,
  hideTitlebarDriverAction = false,
  isWebRuntime = false,
  onToggleAI,
  onToggleLogPanel,
  v2ExplorerContext,
  collapsedSidebarActionsTarget,
  onTitlebarSnapshotChange,
  onFocusCommandSearch,
  onCollapseSidebar,
  onExpandSidebar,
  onEnsureSidebarExpanded,
  collapseSidebarLabel,
  collapseSidebarButtonRef,
  expandSidebarLabel,
  expandSidebarButtonRef,
}) => {
  const {
    connections, savedQueries, savedQueryGroups, externalSQLDirectories, saveQuery, deleteQuery,
    saveSavedQueryGroup, deleteSavedQueryGroup, moveSavedQueryToGroup, reloadSavedQueryGroups,
    saveExternalSQLDirectory, deleteExternalSQLDirectory, updateRecentSQLFilePath,
    removeRecentSQLFilesByPath, moveRecentSQLFilesByDirectory, removeRecentSQLFilesByDirectory,
    addConnection, updateConnection, addTab, updateQueryTabDraft, tabs, activeTabId,
    setActiveContext, removeConnection, connectionTags, sidebarRootOrder, rootSortMode,
    rootConnectionSortMode, addConnectionTag, updateConnectionTag, removeConnectionTag,
    moveConnectionToTag, moveConnectionTag, closeTabsByConnection, closeTabsByDatabase, appearance,
    activeContext, tableAccessCount, tableSortPreference, pinnedSidebarTables,
    pinnedSidebarDatabases, recordTableAccess, setTableSortPreference, sidebarTreeOrders,
    updateSidebarTreeOrders, setSidebarTablePinned, setSidebarDatabasePinned, addSqlLog,
    hideSqlLogFromRecent, clearRecentSqlLogs, shortcutOptions, setAppearance, setAIPanelVisible,
    addAIContext, darkMode, sidebarTableMetadataFields, exportProgressModal, runExportWithProgress,
    autoFetchVisible, activeShortcutPlatform, treeData, setTreeData, sidebarTreeOrdersRef,
    tableSortPreferenceRef, activeTab, activeTabHasConnection, activeTabLocateAction,
    canLocateActiveTab, overlayTheme, modalPanelStyle, modalSectionStyle, modalScrollSectionStyle,
    renderSidebarModalTitle,
  } = useSidebarStoreState();
  const {
    usePersistentSidebarFilter, tableDoubleClickAction, sidebarSingleDatabaseExpansion, searchValue,
    setSearchValue, deferredSearchValue, searchScopes, setSearchScopes, v2ExplorerFilter,
    setV2ExplorerFilter, searchInputRef, commandSearchInputRef, isV2CommandSearchOpen,
    recentSqlLogs, v2CommandSearchValue, deferredV2CommandSearchValue, v2CommandActiveIndex,
    setV2CommandActiveIndex, expandedKeys, setExpandedKeysState, expandedKeysRef, autoExpandParent,
    setAutoExpandParent, loadedKeys, setLoadedKeys, selectedKeys, selectedSidebarKeyRef,
    setSidebarSelectedKeys, selectedNodesRef, loadingNodesRef, databaseTreeTouchedAtRef,
    pruneLoadedDatabaseTreesRef, refreshConnectionResourcesRef, loadNacosServiceGroupsRef,
    replaceTreeNodeChildrenRef, clickTimerRef, treeDragSelectSuppressUntilRef,
    connectionReloadSignaturesRef, invalidateConnectionLoadsRef, connectionIds,
    queryCapableConnectionIds, connectionIdSet, allSavedQueriesNode, visibleSidebarTreeData,
    sidebarObjectVisibilitySignature, snapshotTreeSelectionBeforeDrag,
    restoreTreeSelectionAfterDrag, openV2CommandSearch, closeV2CommandSearch,
    handleV2CommandSearchValueChange, resetV2SidebarFilter,
  } = useSidebarSearchState({
    appearance, connections, savedQueries, savedQueryGroups, sidebarTreeOrders, tableSortPreference,
    treeData, activeContext, setActiveContext, setAppearance,
  });

  const findTreeNodeByKeyLate = useLateBoundCallback<(nodes: TreeNode[], targetKey: React.Key) => TreeNode | null>();
  const loadTablesLate = useLateBoundCallback<ReturnType<typeof useSidebarTreeLoaders>['loadTables']>();
  const {
    treeHeight, treeContainerRef, treeRef, sidebarTreeScrollRequestIdRef, sidebarTreeScrollRequest,
    setSidebarTreeScrollRequest, treeDataRef, externalSQLDirectoryTreesRef, findTreeNodeByKeyRef,
    expandConnectionFromRailRef, setExpandedKeys, markTreeScrollActivity, connectionStates,
    setConnectionStates, isTreeDragging, setIsTreeDragging, sidebarTreeDragNodeType,
    setSidebarTreeDragNodeType, sidebarTreeDropPreview, setSidebarTreeDropPreview,
    sidebarTreeDragNodeRef, sidebarTreeDropPreviewRef, sidebarTreeDragPreviewElementRef,
    sidebarGroupHoverExpandTimerRef, isCreateDbModalOpen, setIsCreateDbModalOpen, createDbForm,
    targetConnection, setTargetConnection, createDbCharsets, setCreateDbCharsets,
    createDbCollations, setCreateDbCollations, loadingCreateDbOptions, setLoadingCreateDbOptions,
    isCreateSchemaModalOpen, setIsCreateSchemaModalOpen, createSchemaForm, createSchemaTarget,
    setCreateSchemaTarget, isRenameSchemaModalOpen, setIsRenameSchemaModalOpen, renameSchemaForm,
    renameSchemaTarget, setRenameSchemaTarget, connectionVisibilityTarget,
    setConnectionVisibilityTarget, isSavingConnectionVisibility, setIsSavingConnectionVisibility,
    isRenameDbModalOpen, setIsRenameDbModalOpen, renameDbForm, renameDbTarget, setRenameDbTarget,
    isRenameTableModalOpen, setIsRenameTableModalOpen, renameTableForm, renameTableTarget,
    setRenameTableTarget, messagePublishTarget, setMessagePublishTarget, isRenameViewModalOpen,
    setIsRenameViewModalOpen, renameViewForm, renameViewTarget, setRenameViewTarget,
    isRenameSavedQueryModalOpen, setIsRenameSavedQueryModalOpen, renameSavedQueryForm,
    renameSavedQueryTarget, setRenameSavedQueryTarget, isSavedQueryGroupModalOpen,
    setIsSavedQueryGroupModalOpen, savedQueryGroupTargetId, setSavedQueryGroupTargetId,
    savedQueryGroupInitialParentId, setSavedQueryGroupInitialParentId, isCreateTagModalOpen,
    setIsCreateTagModalOpen, createTagForm, handleExportDatabaseSQL, handleExportSchemaSQL,
    openBatchTableWorkbench, openBatchDatabaseWorkbench, openBatchConnectionWorkbench,
    findInDbContext, setFindInDbContext,
  } = useSidebarTreeViewState({
    setExpandedKeysState, sidebarSingleDatabaseExpansion, treeData, usePersistentSidebarFilter,
    openV2CommandSearch, searchInputRef, isV2CommandSearchOpen, commandSearchInputRef,
    closeV2CommandSearch, connections, selectedNodesRef, addTab, autoFetchVisible, expandedKeys,
    findTreeNodeByKey: findTreeNodeByKeyLate.call, loadTables: loadTablesLate.call, savedQueries,
  });

  const {
    handleDuplicateConnection, findTreeNodeByKey, resolveSidebarSelectionContext,
    publishTitlebarSnapshotUpdate, publishTitlebarSelection, publishTitlebarSelectionForNode,
  } = useSidebarTitlebarSync({
    connectionReloadSignaturesRef, connections, setLoadedKeys, setExpandedKeys, setConnectionStates,
    invalidateConnectionLoadsRef, loadingNodesRef, setTreeData, connectionTags, sidebarRootOrder,
    rootSortMode, rootConnectionSortMode, allSavedQueriesNode, addConnection, findTreeNodeByKeyRef,
    connectionIds, onTitlebarSnapshotChange, selectedSidebarKeyRef, selectedKeys, treeData,
    selectedNodesRef, connectionStates,
  });
  findTreeNodeByKeyLate.bind(findTreeNodeByKey);

  const {
    replaceTreeNodeChildren, clearTreeNodeChildrenByKeys, pruneLoadedDatabaseTrees,
    mergeExpandedTreeKeys, scrollSidebarTreeToKey, refreshGlobalExternalSQLRootNode,
    openDataImportWorkbench, handleRunSQLFile, handleOpenSQLFileFromToolbar, openExternalSQLFile,
    openExternalSQLBindingModal, openCreateExternalSQLFileModal, openRenameExternalSQLFileModal,
    openCreateExternalSQLDirectoryModal, openRenameExternalSQLDirectoryModal,
    handleDeleteExternalSQLFile, handleDeleteExternalSQLDirectory, handleAddExternalSQLDirectory,
    handleRemoveExternalSQLDirectory, handleRefreshExternalSQLDirectory, browserSQLFileInputProps,
    externalSQLFileModalProps, externalSQLBindingModalProps,
  } = useSidebarTreeData({
    sidebarTreeOrdersRef, tableSortPreferenceRef, treeDataRef, setTreeData, setLoadedKeys,
    connectionIds, invalidateConnectionLoadsRef, setConnectionStates, databaseTreeTouchedAtRef,
    activeContext, expandedKeys, selectedKeys, pruneLoadedDatabaseTreesRef, setExpandedKeys,
    setAutoExpandParent, sidebarTreeScrollRequestIdRef, setSidebarTreeScrollRequest,
    externalSQLDirectories, externalSQLDirectoryTreesRef, tabs, addTab, isWebRuntime, connections,
    activeTab, selectedNodesRef, saveExternalSQLDirectory, deleteExternalSQLDirectory,
    updateRecentSQLFilePath, removeRecentSQLFilesByPath, moveRecentSQLFilesByDirectory,
    removeRecentSQLFilesByDirectory,
  });

  const clearStaleHostStateOnSelectionLate = useLateBoundCallback<(node: any) => void>();
  const loadDatabasesLate = useLateBoundCallback<ReturnType<typeof useSidebarTreeLoaders>['loadDatabases']>();
  const {
    waitForSidebarLoadKey, locateObjectInSidebar, handleLocateActiveTabInSidebar,
  } = useSidebarLocate({
    loadingNodesRef, onEnsureSidebarExpanded, refreshGlobalExternalSQLRootNode, treeDataRef,
    findTreeNodeByKey, setSearchValue, setV2ExplorerFilter, mergeExpandedTreeKeys,
    setSidebarSelectedKeys, selectedNodesRef, activeContext, activeTab, setActiveContext,
    publishTitlebarSelection, resolveSidebarSelectionContext, scrollSidebarTreeToKey, connections,
    clearStaleHostStateOnSelection: clearStaleHostStateOnSelectionLate.call,
    loadDatabases: loadDatabasesLate.call, loadTables: loadTablesLate.call, activeTabLocateAction,
    findTreeNodeByKeyRef, refreshConnectionResourcesRef,
  });

  const loadJVMResourcesLate = useLateBoundCallback<ReturnType<typeof useSidebarTreeLoaders>['loadJVMResources']>();
  const loadNacosConfigGroupsLate = useLateBoundCallback<ReturnType<typeof useSidebarTreeLoaders>['loadNacosConfigGroups']>();
  const loadNacosServiceGroupsLate = useLateBoundCallback<ReturnType<typeof useSidebarTreeLoaders>['loadNacosServiceGroups']>();
  const openEventDefinitionLate = useLateBoundCallback<ReturnType<typeof useSidebarObjectActions>['openEventDefinition']>();
  const openSequenceDefinitionLate = useLateBoundCallback<ReturnType<typeof useSidebarObjectActions>['openSequenceDefinition']>();
  const openPackageDefinitionLate = useLateBoundCallback<ReturnType<typeof useSidebarObjectActions>['openPackageDefinition']>();
  const openMessageQueueWorkbenchLate = useLateBoundCallback<ReturnType<typeof useSidebarObjectActions>['openMessageQueueWorkbench']>();
  const resolveSavedQueryDisplayNameLate = useLateBoundCallback<(name: string | null | undefined) => string>();
  const openJVMOverviewTabLate = useLateBoundCallback<(conn: SavedConnection, providerMode: string) => void>();
  const openJVMResourceTabLate = useLateBoundCallback<(conn: SavedConnection, providerMode: string, resourcePath: string, resourceKind?: string) => void>();
  const openJVMMonitoringTabLate = useLateBoundCallback<(conn: SavedConnection, providerMode: string) => void>();
  const openJVMDiagnosticTabLate = useLateBoundCallback<(conn: SavedConnection) => void>();
  const {
    onLoadData, isStructureOnlyDbType, openDesign, openNewTableDesign,
    clearStaleHostStateOnSelection, onSelect, onExpand, onDoubleClick,
  } = useSidebarTreeEvents({
    loadDatabases: loadDatabasesLate.call, loadJVMResources: loadJVMResourcesLate.call,
    loadTables: loadTablesLate.call, loadNacosConfigGroups: loadNacosConfigGroupsLate.call,
    loadNacosServiceGroups: loadNacosServiceGroupsLate.call, refreshGlobalExternalSQLRootNode,
    replaceTreeNodeChildren, connections, addTab, openEventDefinition: openEventDefinitionLate.call,
    openSequenceDefinition: openSequenceDefinitionLate.call,
    openPackageDefinition: openPackageDefinitionLate.call,
    openMessageQueueWorkbench: openMessageQueueWorkbenchLate.call, selectedSidebarKeyRef,
    setConnectionStates, resolveSidebarSelectionContext, publishTitlebarSnapshotUpdate,
    treeDragSelectSuppressUntilRef, isTreeDragging, setSidebarSelectedKeys, selectedNodesRef,
    publishTitlebarSelection, connectionIds, publishTitlebarSelectionForNode, setActiveContext,
    clickTimerRef, sidebarTreeDragNodeRef, setExpandedKeys, setAutoExpandParent,
    clearTreeNodeChildrenByKeys, recordTableAccess, tableDoubleClickAction,
    resolveSavedQueryDisplayName: resolveSavedQueryDisplayNameLate.call, openExternalSQLFile,
    openJVMOverviewTab: openJVMOverviewTabLate.call,
    openJVMResourceTab: openJVMResourceTabLate.call,
    openJVMMonitoringTab: openJVMMonitoringTabLate.call,
    openJVMDiagnosticTab: openJVMDiagnosticTabLate.call, expandedKeys,
  });
  clearStaleHostStateOnSelectionLate.bind(clearStaleHostStateOnSelection);

  const {
    renderSidebarSwitcherIcon, buildRuntimeConfig, openJVMOverviewTab, openJVMMonitoringTab,
    openJVMResourceTab, openJVMDiagnosticTab, getConnectionNodeRef, getDatabaseNodeRef,
    extractObjectName, resolveSavedQueryDisplayName, openSavedQueryGroupModal,
    closeSavedQueryGroupModal, handleSaveSavedQueryGroup, savedQueryGroupTarget, loadDatabases,
    loadJVMResources, loadTables, loadNacosConfigGroups, loadNacosServiceGroups,
    invalidateConnectionLoads,
  } = useSidebarJvmAndSavedQueries({
    loadingNodesRef, addTab, connections, reloadSavedQueryGroups, setSavedQueryGroupTargetId,
    setSavedQueryGroupInitialParentId, setIsSavedQueryGroupModalOpen, saveSavedQueryGroup,
    savedQueryGroups, savedQueryGroupTargetId, savedQueries, tableSortPreference, tableAccessCount,
    pinnedSidebarTables, pinnedSidebarDatabases, setConnectionStates, setLoadedKeys,
    replaceTreeNodeChildren, databaseTreeTouchedAtRef, pruneLoadedDatabaseTrees,
    invalidateConnectionLoadsRef, loadNacosServiceGroupsRef, replaceTreeNodeChildrenRef,
  });
  loadTablesLate.bind(loadTables);
  loadDatabasesLate.bind(loadDatabases);
  loadJVMResourcesLate.bind(loadJVMResources);
  loadNacosConfigGroupsLate.bind(loadNacosConfigGroups);
  loadNacosServiceGroupsLate.bind(loadNacosServiceGroups);
  resolveSavedQueryDisplayNameLate.bind(resolveSavedQueryDisplayName);
  openJVMOverviewTabLate.bind(openJVMOverviewTab);
  openJVMResourceTabLate.bind(openJVMResourceTab);
  openJVMMonitoringTabLate.bind(openJVMMonitoringTab);
  openJVMDiagnosticTabLate.bind(openJVMDiagnosticTab);

  const { refreshConnectionResources } = useSidebarConnectionRefresh({
    treeDataRef, expandedKeysRef, invalidateConnectionLoads, loadDatabases, setLoadedKeys,
    loadingNodesRef, findTreeNodeByKeyRef, onLoadData, setExpandedKeys,
    refreshConnectionResourcesRef, replaceTreeNodeChildrenRef, loadNacosServiceGroupsRef,
  });

  const {
    supportsConnectionVisibility, openConnectionVisibilitySettings, openSchemaVisibilitySettings,
    handleSaveConnectionVisibility, migrateVisibilityForRenamedDatabase,
    removeVisibilityForDeletedDatabase, migrateVisibilityForRenamedSchema,
    removeVisibilityForDeletedSchema, migratePinnedDatabaseKey,
  } = useSidebarVisibility({
    connections, setConnectionVisibilityTarget, connectionVisibilityTarget,
    setIsSavingConnectionVisibility, connectionReloadSignaturesRef, updateConnection, setLoadedKeys,
    replaceTreeNodeChildren, loadDatabases, setExpandedKeys, findTreeNodeByKeyRef, treeDataRef,
    pinnedSidebarDatabases, setSidebarDatabasePinned,
  });

  const {
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
  } = useSidebarObjectMenuActions({
    connections, connectionIds, connectionIdSet, tabs, treeDataRef, setTreeData, setExpandedKeys,
    setLoadedKeys, addTab, updateQueryTabDraft, saveQuery, addSqlLog, closeTabsByDatabase,
    createDbForm, targetConnection, isCreateDbModalOpen, setIsCreateDbModalOpen, createDbCharsets,
    setCreateDbCharsets, createDbCollations, setCreateDbCollations, loadingCreateDbOptions,
    setLoadingCreateDbOptions, createSchemaForm, createSchemaTarget, setCreateSchemaTarget,
    setIsCreateSchemaModalOpen, renameSchemaForm, renameSchemaTarget, setRenameSchemaTarget,
    setIsRenameSchemaModalOpen, renameDbForm, renameDbTarget, setRenameDbTarget,
    setIsRenameDbModalOpen, renameTableForm, renameTableTarget, setRenameTableTarget,
    setIsRenameTableModalOpen, renameViewForm, renameViewTarget, setRenameViewTarget,
    setIsRenameViewModalOpen, renameSavedQueryForm, renameSavedQueryTarget,
    setRenameSavedQueryTarget, setIsRenameSavedQueryModalOpen, setMessagePublishTarget,
    buildRuntimeConfig, getConnectionNodeRef, getDatabaseNodeRef, extractObjectName, loadDatabases,
    loadTables, openDesign, onDoubleClick, runExportWithProgress, setAIPanelVisible, addAIContext,
    migrateVisibilityForRenamedDatabase, removeVisibilityForDeletedDatabase,
    migrateVisibilityForRenamedSchema, removeVisibilityForDeletedSchema, migratePinnedDatabaseKey,
    onCreateConnectionInGroup, onEditConnection, connectionTags, pinnedSidebarTables,
    pinnedSidebarDatabases, loadingNodesRef, refreshConnectionResources, invalidateConnectionLoads,
    findTreeNodeByKeyRef, setConnectionStates, setTargetConnection, setIsCreateTagModalOpen,
    createTagForm, closeTabsByConnection, removeConnection, removeConnectionTag,
    moveConnectionToTag, setSidebarTablePinned, setSidebarDatabasePinned, setTableSortPreference,
    replaceTreeNodeChildren, openNewTableDesign, handleExportDatabaseSQL, openBatchTableWorkbench,
    openBatchDatabaseWorkbench, openBatchConnectionWorkbench, handleRunSQLFile,
    openConnectionVisibilitySettings, handleDuplicateConnection, onCreateConnection, onToggleAI,
    onToggleLogPanel, searchScopes, setSearchScopes, setSearchValue, deferredSearchValue,
    deferredV2CommandSearchValue, v2CommandSearchValue, setV2CommandActiveIndex, v2ExplorerFilter,
    visibleSidebarTreeData, treeHeight, isV2CommandSearchOpen, selectedKeys, selectedNodesRef,
    activeContext, activeTab, recentSqlLogs, shortcutOptions, activeShortcutPlatform, overlayTheme,
    darkMode, isWebRuntime, onOpenSettingsNavigation, markTreeScrollActivity,
    sidebarTreeScrollRequest, setSidebarTreeScrollRequest, expandedKeys, treeContainerRef,
    sidebarTreeScrollRequestIdRef, treeRef,
  });
  openEventDefinitionLate.bind(openEventDefinition);
  openSequenceDefinitionLate.bind(openSequenceDefinition);
  openPackageDefinitionLate.bind(openPackageDefinition);
  openMessageQueueWorkbenchLate.bind(openMessageQueueWorkbench);
  const {
    contextMenu, setContextMenu, contextMenuPortalRef, openV2ConnectionContextMenu,
    renderV2SidebarContextMenuContent, runCommandSearchItem, handleV2CommandSearchKeyDown,
    getNodeMenuItems, titleRender, v2RailConnectionGroups,
  } = useSidebarContextMenus({
    activeConnection, v2ExplorerFilter, setV2ExplorerFilter, connections, connectionTags,
    activeShortcutPlatform, flattenConnectionNodes, v2TreeMetrics, tableSortPreference,
    pinnedSidebarTables, pinnedSidebarDatabases, getConnectionNodeForAction,
    handleV2TableContextMenuAction, handleV2TableGroupContextMenuAction,
    handleV2DatabaseContextMenuAction, handleV2ConnectionContextMenuAction,
    handleV2ConnectionGroupContextMenuAction, buildRuntimeConfig, extractObjectName, loadTables,
    getDatabaseNodeRef, handleExportSchemaSQL, handleDeleteSchema, openRenameSchemaModal,
    resolveMessagePublishTarget, openSchemaVisibilitySettings, supportsConnectionVisibility,
    addSqlLog, refreshV2TableContextMenuStatsRef, sidebarTableMetadataFields,
    sidebarTreeDropPreview, treeDataRef, setSearchValue, mergeExpandedTreeKeys,
    setSidebarSelectedKeys, selectedNodesRef, scrollSidebarTreeToKey, activeContext, activeTab,
    addTab, clearStaleHostStateOnSelection, closeV2CommandSearch, commandSearchFlatItems,
    connectionIds, queryCapableConnectionIds, findTreeNodeByKeyRef, locateObjectInSidebar,
    loadDatabases, onDoubleClick, publishTitlebarSelectionForNode, setActiveContext,
    setV2CommandActiveIndex, v2CommandActiveIndex, expandConnectionFromRailRef,
    onEnsureSidebarExpanded, waitForSidebarLoadKey, onCreateConnectionInGroup, onEditConnection,
    openConnectionVisibilitySettings, handleTableGroupSortAction, disconnectConnectionNode,
    deleteConnectionNode, openBatchTableWorkbench, openBatchDatabaseWorkbench,
    openBatchConnectionWorkbench, openCreateView, openCreateStarRocksMaterializedView,
    openCreateRoutine, openCreateStarRocksExternalCatalog, openEditView, handleDropView,
    openViewDefinition, openRoutineDefinition, openEditRoutine, handleDropRoutine,
    handleCompileOracleObject, openEventDefinition, openEditEvent, openSequenceDefinition,
    openPackageDefinition, openMessageQueueWorkbench, openMessagePublishModal,
    openCreateStarRocksRollup, handleCopyTableName, handleCopyTable, handleCopyStructure,
    handleExport, handleTableDataDangerAction, handleDeleteTable, openExportDialog,
    isSavedQueryUnmatched, handleRebindSavedQuery, openRenameSavedQueryModal,
    handleRevealSavedQueryInFolder, isStructureOnlyDbType, openNewTableDesign, createTagForm,
    setRenameViewTarget, setIsCreateTagModalOpen, removeConnectionTag, setExpandedKeys,
    setLoadedKeys, loadingNodesRef, refreshConnectionResources, handleDuplicateConnection,
    moveConnectionToTag, setTargetConnection, setIsCreateDbModalOpen, handleRunSQLFile,
    handleAddExternalSQLDirectory, openCreateExternalSQLFileModal,
    openCreateExternalSQLDirectoryModal, openRenameExternalSQLDirectoryModal,
    handleRefreshExternalSQLDirectory, handleDeleteExternalSQLDirectory,
    handleRemoveExternalSQLDirectory, openExternalSQLFile, openExternalSQLBindingModal,
    openRenameExternalSQLFileModal, handleDeleteExternalSQLFile, renameViewForm,
    setIsRenameViewModalOpen, openDesign, setRenameTableTarget, renameTableForm,
    setIsRenameTableModalOpen, resolveSavedQueryDisplayName, deleteQuery, savedQueryGroups,
    openSavedQueryGroupModal, deleteSavedQueryGroup, moveSavedQueryToGroup, setTreeData,
    connectionStates, sidebarRootOrder, rootSortMode, rootConnectionSortMode,
  });
  const {
    updateSidebarTreeDropPreview, clearSidebarTreeDragVisuals, handleSidebarTreeDragOverCapture,
    handleSidebarTreeDropCapture, allowSidebarTreeDrop, handleDrop, onRightClick,
    handleV2TreeContextMenu,
  } = useSidebarTreeDnd({
    sidebarGroupHoverExpandTimerRef, sidebarTreeDropPreviewRef, setSidebarTreeDropPreview,
    expandedKeysRef, setExpandedKeys, setAutoExpandParent, sidebarTreeDragNodeRef,
    setSidebarTreeDragNodeType, sidebarTreeDragPreviewElementRef, setIsTreeDragging, treeDataRef,
    connectionTags, moveConnectionTag, moveConnectionToTag, sidebarTreeOrdersRef,
    tableSortPreferenceRef, setTreeData, updateSidebarTreeOrders, setTableSortPreference,
    restoreTreeSelectionAfterDrag, findTreeNodeByKeyRef, v2RailConnectionGroups, setContextMenu,
    openV2ConnectionContextMenu, getNodeMenuItems,
  });

  const {
    v2RailObjectActionsLabel, v2RailSystemActionsLabel, v2CommandSearchLabel,
    scrollV2ExplorerToTopExpanded, sidebarActionsInRail, v2ExplorerToolbarActionProps,
    v2TitlebarQuickActions, v2TitlebarVisibleTrailingActions, v2CommandSearchPanelProps,
    v2ConnectionRailProps,
  } = useSidebarToolbarModel({
    treeRef, onEnsureSidebarExpanded, appearance, canLocateActiveTab, activeConnection,
    handleLocateActiveTabInSidebar, openV2ConnectionContextMenu, selectedNodesRef, tabs,
    activeTabId, activeContext, openDataImportWorkbench, activeTab, activeTabHasConnection, addTab,
    onOpenSettingsNavigation, openBatchConnectionWorkbench, openBatchTableWorkbench,
    openBatchDatabaseWorkbench, activeSettingsCenterPaneKey, onCheckUpdate, hideTitlebarAboutAction,
    hideTitlebarDriverAction, connections, connectionIds, isV2CommandSearchOpen,
    v2CommandSearchValue, v2CommandActiveIndex, setV2CommandActiveIndex, v2CommandSearchAiMode,
    v2CommandSearchObjectMode, filteredCommandSearchTreeItems, commandSearchAiItem,
    filteredCommandSearchActionItems, filteredCommandSearchRecentItems, commandSearchFlatItems,
    commandSearchDestinations, commandSearchInputRef, handleV2CommandSearchValueChange,
    handleV2CommandSearchKeyDown, runCommandSearchItem, closeV2CommandSearch, hideSqlLogFromRecent,
    clearRecentSqlLogs, collapsedSidebarActionsTarget, onExpandSidebar, expandSidebarLabel,
    expandSidebarButtonRef, onCollapseSidebar, collapseSidebarLabel, collapseSidebarButtonRef,
    setRenameViewTarget, createTagForm, setIsCreateTagModalOpen, handleOpenSQLFileFromToolbar,
    usePersistentSidebarFilter, openV2CommandSearch,
  });

  return (
    <div
        className="gn-v2-sidebar-redesign"
        data-sidebar-actions-rail={sidebarActionsInRail ? 'true' : undefined}
        style={{ display: 'flex', height: '100%', minHeight: 0 }}
    >
        {exportProgressModal}
        <SidebarConnectionRail {...v2ConnectionRailProps} />
        <SidebarObjectExplorer
          v2RailSystemActionsLabel={v2RailSystemActionsLabel}
          v2ExplorerContext={v2ExplorerContext}
          collapsedSidebarActionsTarget={collapsedSidebarActionsTarget}
          sidebarActionsInRail={sidebarActionsInRail}
          usePersistentSidebarFilter={usePersistentSidebarFilter}
          v2CommandSearchLabel={v2CommandSearchLabel} openV2CommandSearch={openV2CommandSearch}
          onFocusCommandSearch={onFocusCommandSearch}
          v2ExplorerToolbarActionProps={v2ExplorerToolbarActionProps}
          onCollapseSidebar={onCollapseSidebar} collapseSidebarLabel={collapseSidebarLabel}
          collapseSidebarButtonRef={collapseSidebarButtonRef} darkMode={darkMode}
          searchInputRef={searchInputRef} searchValue={searchValue} onSearch={onSearch}
          resetV2SidebarFilter={resetV2SidebarFilter} activeConnection={activeConnection}
          displayTreeData={displayTreeData}
          hasRelationalObjectKindFilterConnection={hasRelationalObjectKindFilterConnection}
          v2ExplorerFilter={v2ExplorerFilter} setV2ExplorerFilter={setV2ExplorerFilter}
          treeContainerRef={treeContainerRef} sidebarTreeDragNodeType={sidebarTreeDragNodeType}
          sidebarTreeDropPreview={sidebarTreeDropPreview} handleTreeWheel={handleTreeWheel}
          markTreeScrollActivity={markTreeScrollActivity}
          handleSidebarTreeDragOverCapture={handleSidebarTreeDragOverCapture}
          handleSidebarTreeDropCapture={handleSidebarTreeDropCapture}
          updateSidebarTreeDropPreview={updateSidebarTreeDropPreview}
          sidebarObjectVisibilitySignature={sidebarObjectVisibilitySignature} treeRef={treeRef}
          allowSidebarTreeDrop={allowSidebarTreeDrop}
          snapshotTreeSelectionBeforeDrag={snapshotTreeSelectionBeforeDrag}
          treeDragSelectSuppressUntilRef={treeDragSelectSuppressUntilRef}
          sidebarTreeDragNodeRef={sidebarTreeDragNodeRef}
          setSidebarTreeDragNodeType={setSidebarTreeDragNodeType}
          sidebarTreeDragPreviewElementRef={sidebarTreeDragPreviewElementRef}
          setIsTreeDragging={setIsTreeDragging}
          restoreTreeSelectionAfterDrag={restoreTreeSelectionAfterDrag}
          clearSidebarTreeDragVisuals={clearSidebarTreeDragVisuals} handleDrop={handleDrop}
          onLoadData={onLoadData} v2VisibleTreeData={v2VisibleTreeData}
          onDoubleClick={onDoubleClick} onSelect={onSelect} titleRender={titleRender}
          renderSidebarSwitcherIcon={renderSidebarSwitcherIcon} expandedKeys={expandedKeys}
          onExpand={onExpand} loadedKeys={loadedKeys} setLoadedKeys={setLoadedKeys}
          autoExpandParent={autoExpandParent} selectedKeys={selectedKeys}
          effectiveTreeHeight={effectiveTreeHeight}
          handleV2TreeContextMenu={handleV2TreeContextMenu} onRightClick={onRightClick}
        />
        <SidebarSearchPanel {...v2CommandSearchPanelProps} />

        {collapsedSidebarActionsTarget && createPortal(
          <>
            {!usePersistentSidebarFilter && (
              <V2ExplorerSearchAction label={v2CommandSearchLabel} onClick={() => openV2CommandSearch()} />
            )}
            <V2ExplorerToolbarActions
              {...v2ExplorerToolbarActionProps}
              onScrollToTop={scrollV2ExplorerToTopExpanded}
            />
          </>,
          collapsedSidebarActionsTarget,
        )}

        <TitleBarQuickActionsHost
          label={v2RailObjectActionsLabel}
          actions={v2TitlebarQuickActions}
          trailingActions={v2TitlebarVisibleTrailingActions}
        />

        {contextMenu?.kind && typeof document !== 'undefined' && createPortal(
            <div
                ref={contextMenuPortalRef}
                className={`gn-v2-sidebar-context-menu-portal ${contextMenu.rootClassName || ''}`}
                data-gonavi-close-shortcut-guard="true"
                data-gonavi-close-shortcut-blocks-background="true"
                style={{
                    position: 'fixed',
                    left: contextMenu.x,
                    top: contextMenu.y,
                    zIndex: APP_POPUP_Z_INDEX,
                    width: contextMenu.overlayStyle?.width ?? SIDEBAR_CONTEXT_MENU_FALLBACK_WIDTH,
                    maxWidth: contextMenu.overlayStyle?.maxWidth ?? 'calc(100vw - 24px)',
                    ['--gn-v2-context-menu-max-height' as any]: `${contextMenu.maxHeight ?? SIDEBAR_CONTEXT_MENU_FALLBACK_HEIGHT}px`,
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.preventDefault()}
            >
                {renderV2SidebarContextMenuContent(contextMenu)}
            </div>,
            document.body,
        )}

        <SidebarEntityModals
            connections={connections}
            connectionTags={connectionTags}
            modalPanelStyle={modalPanelStyle}
            modalSectionStyle={modalSectionStyle}
            modalScrollSectionStyle={modalScrollSectionStyle}
            renderSidebarModalTitle={renderSidebarModalTitle}
            isCreateTagModalOpen={isCreateTagModalOpen}
            setIsCreateTagModalOpen={setIsCreateTagModalOpen}
            createTagForm={createTagForm}
            renameViewTarget={renameViewTarget}
            updateConnectionTag={updateConnectionTag}
            addConnectionTag={addConnectionTag}
            isCreateDbModalOpen={isCreateDbModalOpen}
            setIsCreateDbModalOpen={setIsCreateDbModalOpen}
            createDbForm={createDbForm}
            handleCreateDatabase={handleCreateDatabase}
            createDbTarget={targetConnection}
            createDbCharsets={createDbCharsets}
            createDbCollations={createDbCollations}
            loadingCreateDbOptions={loadingCreateDbOptions}
            isCreateSchemaModalOpen={isCreateSchemaModalOpen}
            setIsCreateSchemaModalOpen={setIsCreateSchemaModalOpen}
            createSchemaForm={createSchemaForm}
            createSchemaTarget={createSchemaTarget}
            setCreateSchemaTarget={setCreateSchemaTarget}
            handleCreateSchema={handleCreateSchema}
            isRenameSchemaModalOpen={isRenameSchemaModalOpen}
            setIsRenameSchemaModalOpen={setIsRenameSchemaModalOpen}
            renameSchemaForm={renameSchemaForm}
            renameSchemaTarget={renameSchemaTarget}
            setRenameSchemaTarget={setRenameSchemaTarget}
            handleRenameSchema={handleRenameSchema}
            isRenameDbModalOpen={isRenameDbModalOpen}
            setIsRenameDbModalOpen={setIsRenameDbModalOpen}
            renameDbForm={renameDbForm}
            renameDbTarget={renameDbTarget}
            setRenameDbTarget={setRenameDbTarget}
            handleRenameDatabase={handleRenameDatabase}
            isRenameTableModalOpen={isRenameTableModalOpen}
            setIsRenameTableModalOpen={setIsRenameTableModalOpen}
            renameTableForm={renameTableForm}
            renameTableTarget={renameTableTarget}
            setRenameTableTarget={setRenameTableTarget}
            handleRenameTable={handleRenameTable}
            isRenameViewModalOpen={isRenameViewModalOpen}
            setIsRenameViewModalOpen={setIsRenameViewModalOpen}
            renameViewForm={renameViewForm}
            setRenameViewTarget={setRenameViewTarget}
            handleRenameView={handleRenameView}
            isRenameSavedQueryModalOpen={isRenameSavedQueryModalOpen}
            setIsRenameSavedQueryModalOpen={setIsRenameSavedQueryModalOpen}
            renameSavedQueryForm={renameSavedQueryForm}
            renameSavedQueryTarget={renameSavedQueryTarget}
            setRenameSavedQueryTarget={setRenameSavedQueryTarget}
            handleRenameSavedQuery={handleRenameSavedQuery}
        />

        <SavedQueryGroupModal
            open={isSavedQueryGroupModalOpen}
            groups={savedQueryGroups}
            savedQueries={savedQueries}
            target={savedQueryGroupTarget}
            initialParentGroupId={savedQueryGroupInitialParentId}
            modalPanelStyle={modalPanelStyle}
            modalSectionStyle={modalSectionStyle}
            modalScrollSectionStyle={modalScrollSectionStyle}
            renderModalTitle={renderSidebarModalTitle}
            onClose={closeSavedQueryGroupModal}
            onSave={handleSaveSavedQueryGroup}
        />

        {connectionVisibilityTarget && (() => {
            const target = connectionVisibilityTarget.connection;
            const capabilities = getDataSourceCapabilities(target.config);
            const isRedis = target.config.type === 'redis';
            const source = isRedis ? {
                includeDatabases: target.includeRedisDatabases?.map((database) => `db${database}`),
                schemaVisibilityByDatabase: undefined,
            } : target;
            const primaryKind = capabilities.navigation.primaryKind;
            const primaryLabel = t(`sidebar.database_schema_visibility.primary.${primaryKind}`);
            return (
                <DatabaseSchemaVisibilityModal
                    open
                    connectionName={target.name}
                    source={source}
                    initialDatabase={isRedis
                        ? undefined
                        : connectionVisibilityTarget.initialDatabase}
                    primaryLabel={primaryLabel}
                    supportsSchemas={!isRedis && capabilities.supportsSecondarySchemaVisibility}
                    databaseCaseSensitive={capabilities.schemaIdentifierCaseSensitive}
                    schemaCaseSensitive={capabilities.schemaIdentifierCaseSensitive}
                    saving={isSavingConnectionVisibility}
                    loadDatabases={async () => {
                        const backendApp = (window as any).go?.app?.App;
                        const result = isRedis
                            ? await backendApp.RedisGetDatabases(buildRpcConnectionConfig(target.config))
                            : await backendApp.DBGetDatabases(buildRpcConnectionConfig(target.config));
                        if (!result?.success) {
                            throw new Error(result?.message || t('sidebar.database_schema_visibility.message.load_failed_fallback'));
                        }
                        const rows = Array.isArray(result.data) ? result.data : [];
                        return isRedis
                            ? rows
                                .map((row: any) => Number(row?.index ?? row?.Index))
                                .filter((database: number) => Number.isInteger(database) && database >= 0)
                                .map((database: number) => `db${database}`)
                            : rows
                                .map((row: any) => String(row?.Database ?? row?.database ?? '').trim())
                                .filter(Boolean);
                    }}
                    loadSchemas={async (database) => loadSchemas(target, database)}
                    onCancel={() => setConnectionVisibilityTarget(null)}
                    onSave={handleSaveConnectionVisibility}
                />
            );
        })()}

        {isWebRuntime ? (
          <input
            {...browserSQLFileInputProps}
            data-sidebar-browser-sql-file-input="true"
          />
        ) : null}
        <ExternalSQLFileModal {...externalSQLFileModalProps} />
        <ExternalSQLBindingModal {...externalSQLBindingModalProps} />

        <FindInDatabaseModal
            open={findInDbContext.open}
            onClose={() => setFindInDbContext({ open: false, connectionId: '', dbName: '' })}
            connectionId={findInDbContext.connectionId}
            dbName={findInDbContext.dbName}
        />
        <MessagePublishModal
            open={Boolean(messagePublishTarget)}
            connection={messagePublishTarget?.connection || null}
            executionDbName={messagePublishTarget?.executionDbName || ''}
            defaultDestination={messagePublishTarget?.destination || ''}
            defaultExchange={messagePublishTarget?.exchange || ''}
            onCancel={() => setMessagePublishTarget(null)}
            onSuccess={handleMessagePublishSuccess}
        />
    </div>
  );
});

export default Sidebar;
