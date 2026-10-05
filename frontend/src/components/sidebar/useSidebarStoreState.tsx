import { useStore } from '../../store';
import { useWorkbenchTabs } from '../../hooks/useWorkbenchTabs';
import {
  resolveAppearanceValues,
  normalizeOpacityForPlatform,
  isMacLikePlatform,
} from '../../utils/appearance';
import React, { useMemo, useState, useRef } from 'react';
import { resolveSidebarTableMetadataFields } from '../../utils/sidebarTableMetadata';
import { useExportProgressDialog } from '../ExportProgressModal';
import { useAutoFetchVisibility } from '../../utils/autoFetchVisibility';
import { getShortcutPlatform } from '../../utils/shortcuts';
import type { SidebarTreeNode as TreeNode } from '../sidebarV2Utils';
import {
  resolveSidebarActiveTabLocateAction,
  canLocateSidebarActiveTab,
} from './sidebarLocateActiveTab';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

export const useSidebarStoreState = () => {
  const connections = useStore(state => state.connections);
  const savedQueries = useStore(state => state.savedQueries);
  const savedQueryGroups = useStore(state => state.savedQueryGroups);
  const externalSQLDirectories = useStore(state => state.externalSQLDirectories);
  const saveQuery = useStore(state => state.saveQuery);
  const deleteQuery = useStore(state => state.deleteQuery);
  const saveSavedQueryGroup = useStore(state => state.saveSavedQueryGroup);
  const deleteSavedQueryGroup = useStore(state => state.deleteSavedQueryGroup);
  const moveSavedQueryToGroup = useStore(state => state.moveSavedQueryToGroup);
  const reloadSavedQueryGroups = useStore(state => state.reloadSavedQueryGroups);
  const saveExternalSQLDirectory = useStore(state => state.saveExternalSQLDirectory);
  const deleteExternalSQLDirectory = useStore(state => state.deleteExternalSQLDirectory);
  const updateRecentSQLFilePath = useStore(state => state.updateRecentSQLFilePath);
  const removeRecentSQLFilesByPath = useStore(state => state.removeRecentSQLFilesByPath);
  const moveRecentSQLFilesByDirectory = useStore(state => state.moveRecentSQLFilesByDirectory);
  const removeRecentSQLFilesByDirectory = useStore(state => state.removeRecentSQLFilesByDirectory);
  const addConnection = useStore(state => state.addConnection);
  const updateConnection = useStore(state => state.updateConnection);
  const addTab = useStore(state => state.addTab);
  const updateQueryTabDraft = useStore(state => state.updateQueryTabDraft);
  const tabs = useWorkbenchTabs();
  const activeTabId = useStore(state => state.activeTabId);
  const setActiveContext = useStore(state => state.setActiveContext);
  const removeConnection = useStore(state => state.removeConnection);
  const connectionTags = useStore(state => state.connectionTags);
  const sidebarRootOrder = useStore(state => state.sidebarRootOrder);
  const rootSortMode = useStore(state => state.rootSortMode);
  const rootConnectionSortMode = useStore(state => state.rootConnectionSortMode);
  const addConnectionTag = useStore(state => state.addConnectionTag);
  const updateConnectionTag = useStore(state => state.updateConnectionTag);
  const removeConnectionTag = useStore(state => state.removeConnectionTag);
  const moveConnectionToTag = useStore(state => state.moveConnectionToTag);
  const moveConnectionTag = useStore(state => state.moveConnectionTag);
  const closeTabsByConnection = useStore(state => state.closeTabsByConnection);
  const closeTabsByDatabase = useStore(state => state.closeTabsByDatabase);
  const theme = useStore(state => state.theme);
  const appearance = useStore(state => state.appearance);
  const activeContext = useStore(state => state.activeContext);
  const tableAccessCount = useStore(state => state.tableAccessCount);
  const tableSortPreference = useStore(state => state.tableSortPreference);
  const pinnedSidebarTables = useStore(state => state.pinnedSidebarTables);
  const pinnedSidebarDatabases = useStore(state => state.pinnedSidebarDatabases);
  const recordTableAccess = useStore(state => state.recordTableAccess);
  const setTableSortPreference = useStore(state => state.setTableSortPreference);
  const sidebarTreeOrders = useStore(state => state.sidebarTreeOrders);
  const updateSidebarTreeOrders = useStore(state => state.updateSidebarTreeOrders);
  const setSidebarTablePinned = useStore(state => state.setSidebarTablePinned);
  const setSidebarDatabasePinned = useStore(state => state.setSidebarDatabasePinned);
  const queryOptions = useStore(state => state.queryOptions);
  const setQueryOptions = useStore(state => state.setQueryOptions);
  const addSqlLog = useStore(state => state.addSqlLog);
  const hideSqlLogFromRecent = useStore(state => state.hideSqlLogFromRecent);
  const clearRecentSqlLogs = useStore(state => state.clearRecentSqlLogs);
  const shortcutOptions = useStore(state => state.shortcutOptions);
  const languagePreference = useStore(state => state.languagePreference);
  const setAppearance = useStore(state => state.setAppearance);
  const setAIPanelVisible = useStore(state => state.setAIPanelVisible);
  const addAIContext = useStore(state => state.addAIContext);
  void languagePreference;
  const darkMode = theme === 'dark';
  const resolvedAppearance = resolveAppearanceValues(appearance);
  const opacity = normalizeOpacityForPlatform(resolvedAppearance.opacity);
  const sidebarTableMetadataFields = useMemo(
      () => resolveSidebarTableMetadataFields(
          queryOptions?.sidebarTableMetadataFields,
          queryOptions?.showSidebarTableComment === true,
          queryOptions?.sidebarTableMetadataFieldOrder,
      ),
      [queryOptions?.showSidebarTableComment, queryOptions?.sidebarTableMetadataFieldOrder, queryOptions?.sidebarTableMetadataFields],
  );
  const { exportProgressModal, runExportWithProgress } = useExportProgressDialog();
  const disableLocalBackdropFilter = isMacLikePlatform();
  const autoFetchVisible = useAutoFetchVisibility();
  const activeShortcutPlatform = getShortcutPlatform(isMacLikePlatform());

  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const sidebarTreeOrdersRef = useRef(sidebarTreeOrders);
  const tableSortPreferenceRef = useRef(tableSortPreference);
  sidebarTreeOrdersRef.current = sidebarTreeOrders;
  tableSortPreferenceRef.current = tableSortPreference;
  const activeTab = useMemo(() => tabs.find(tab => tab.id === activeTabId) || null, [tabs, activeTabId]);
  const activeTabHasConnection = useMemo(
    () => Boolean(
      activeTab?.connectionId
      && connections.some((connection) => connection.id === activeTab.connectionId),
    ),
    [activeTab?.connectionId, connections],
  );
  const activeTabLocateAction = useMemo(() => resolveSidebarActiveTabLocateAction({
    tab: activeTab,
    hasConnection: activeTabHasConnection,
  }), [activeTab, activeTabHasConnection]);
  const canLocateActiveTab = canLocateSidebarActiveTab(activeTabLocateAction);

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
      () => buildOverlayWorkbenchTheme(darkMode, {
          disableBackdropFilter: disableLocalBackdropFilter,
      }),
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
  return {
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
  };
};

export type SidebarStoreStateApi = ReturnType<typeof useSidebarStoreState>;
