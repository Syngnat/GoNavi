import { t } from '../../i18n';
import React, { useCallback } from 'react';
import { useSidebarWorkbenchLaunchers } from './useSidebarWorkbenchLaunchers';
import type { TitleBarQuickAction } from '../TitleBarQuickActions';
import { TitlebarGraphIcon, TitlebarSqlToolIcon } from '../titlebar/gonaviTitlebarIcons';
import {
  CloudOutlined,
  TableOutlined,
  DatabaseOutlined,
  ImportOutlined,
  UploadOutlined,
  SwitcherOutlined,
  HistoryOutlined,
  AuditOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { buildTitlebarTrailingActions } from './titlebarTrailingActions';
import { useSidebarCommandSearchCopy } from './useSidebarCommandSearchCopy';
import type { SidebarSearchPanelProps } from './SidebarSearchPanel';
import type { V2CommandSearchItem } from '../sidebarV2Utils';
import { V2RailExplorerActions } from './SidebarExplorerToolbar';
import type { SidebarTreeViewStateApi } from './useSidebarTreeViewState';
import type { SidebarStoreStateApi } from './useSidebarStoreState';
import type { SidebarObjectMenuActionsApi } from './useSidebarObjectMenuActions';
import type { SidebarLocateApi } from './useSidebarLocate';
import type { SidebarContextMenusApi } from './useSidebarContextMenus';
import type { SidebarSearchStateApi } from './useSidebarSearchState';
import type { SidebarTreeDataApi } from './useSidebarTreeData';
import type { SidebarProps } from '../Sidebar';

export interface UseSidebarToolbarModelInput {
  treeRef: SidebarTreeViewStateApi['treeRef'];
  onEnsureSidebarExpanded: SidebarProps['onEnsureSidebarExpanded'];
  appearance: SidebarStoreStateApi['appearance'];
  canLocateActiveTab: SidebarStoreStateApi['canLocateActiveTab'];
  activeConnection: SidebarObjectMenuActionsApi['activeConnection'];
  handleLocateActiveTabInSidebar: SidebarLocateApi['handleLocateActiveTabInSidebar'];
  openV2ConnectionContextMenu: SidebarContextMenusApi['openV2ConnectionContextMenu'];
  selectedNodesRef: SidebarSearchStateApi['selectedNodesRef'];
  tabs: SidebarStoreStateApi['tabs'];
  activeTabId: SidebarStoreStateApi['activeTabId'];
  activeContext: SidebarStoreStateApi['activeContext'];
  openDataImportWorkbench: SidebarTreeDataApi['openDataImportWorkbench'];
  activeTab: SidebarStoreStateApi['activeTab'];
  activeTabHasConnection: SidebarStoreStateApi['activeTabHasConnection'];
  addTab: SidebarStoreStateApi['addTab'];
  onOpenSettingsNavigation: SidebarProps['onOpenSettingsNavigation'];
  openBatchConnectionWorkbench: SidebarTreeViewStateApi['openBatchConnectionWorkbench'];
  openBatchTableWorkbench: SidebarTreeViewStateApi['openBatchTableWorkbench'];
  openBatchDatabaseWorkbench: SidebarTreeViewStateApi['openBatchDatabaseWorkbench'];
  activeSettingsCenterPaneKey: SidebarProps['activeSettingsCenterPaneKey'];
  onCheckUpdate: SidebarProps['onCheckUpdate'];
  hideTitlebarAboutAction: Exclude<SidebarProps['hideTitlebarAboutAction'], undefined>;
  hideTitlebarDriverAction: Exclude<SidebarProps['hideTitlebarDriverAction'], undefined>;
  connections: SidebarStoreStateApi['connections'];
  connectionIds: SidebarSearchStateApi['connectionIds'];
  isV2CommandSearchOpen: SidebarSearchStateApi['isV2CommandSearchOpen'];
  v2CommandSearchValue: SidebarSearchStateApi['v2CommandSearchValue'];
  v2CommandActiveIndex: SidebarSearchStateApi['v2CommandActiveIndex'];
  setV2CommandActiveIndex: SidebarSearchStateApi['setV2CommandActiveIndex'];
  v2CommandSearchAiMode: SidebarObjectMenuActionsApi['v2CommandSearchAiMode'];
  v2CommandSearchObjectMode: SidebarObjectMenuActionsApi['v2CommandSearchObjectMode'];
  filteredCommandSearchTreeItems: SidebarObjectMenuActionsApi['filteredCommandSearchTreeItems'];
  commandSearchAiItem: SidebarObjectMenuActionsApi['commandSearchAiItem'];
  filteredCommandSearchActionItems: SidebarObjectMenuActionsApi['filteredCommandSearchActionItems'];
  filteredCommandSearchRecentItems: SidebarObjectMenuActionsApi['filteredCommandSearchRecentItems'];
  commandSearchFlatItems: SidebarObjectMenuActionsApi['commandSearchFlatItems'];
  commandSearchDestinations: SidebarObjectMenuActionsApi['commandSearchDestinations'];
  commandSearchInputRef: SidebarSearchStateApi['commandSearchInputRef'];
  handleV2CommandSearchValueChange: SidebarSearchStateApi['handleV2CommandSearchValueChange'];
  handleV2CommandSearchKeyDown: SidebarContextMenusApi['handleV2CommandSearchKeyDown'];
  runCommandSearchItem: SidebarContextMenusApi['runCommandSearchItem'];
  closeV2CommandSearch: SidebarSearchStateApi['closeV2CommandSearch'];
  hideSqlLogFromRecent: SidebarStoreStateApi['hideSqlLogFromRecent'];
  clearRecentSqlLogs: SidebarStoreStateApi['clearRecentSqlLogs'];
  collapsedSidebarActionsTarget: SidebarProps['collapsedSidebarActionsTarget'];
  onExpandSidebar: SidebarProps['onExpandSidebar'];
  expandSidebarLabel: SidebarProps['expandSidebarLabel'];
  expandSidebarButtonRef: SidebarProps['expandSidebarButtonRef'];
  onCollapseSidebar: SidebarProps['onCollapseSidebar'];
  collapseSidebarLabel: SidebarProps['collapseSidebarLabel'];
  collapseSidebarButtonRef: SidebarProps['collapseSidebarButtonRef'];
  setRenameViewTarget: SidebarTreeViewStateApi['setRenameViewTarget'];
  createTagForm: SidebarTreeViewStateApi['createTagForm'];
  setIsCreateTagModalOpen: SidebarTreeViewStateApi['setIsCreateTagModalOpen'];
  handleOpenSQLFileFromToolbar: SidebarTreeDataApi['handleOpenSQLFileFromToolbar'];
  usePersistentSidebarFilter: SidebarSearchStateApi['usePersistentSidebarFilter'];
  openV2CommandSearch: SidebarSearchStateApi['openV2CommandSearch'];
}

export const useSidebarToolbarModel = ({
  treeRef, onEnsureSidebarExpanded, appearance, canLocateActiveTab, activeConnection,
  handleLocateActiveTabInSidebar, openV2ConnectionContextMenu, selectedNodesRef, tabs, activeTabId,
  activeContext, openDataImportWorkbench, activeTab, activeTabHasConnection, addTab,
  onOpenSettingsNavigation, openBatchConnectionWorkbench, openBatchTableWorkbench,
  openBatchDatabaseWorkbench, activeSettingsCenterPaneKey, onCheckUpdate, hideTitlebarAboutAction,
  hideTitlebarDriverAction, connections, connectionIds, isV2CommandSearchOpen, v2CommandSearchValue,
  v2CommandActiveIndex, setV2CommandActiveIndex, v2CommandSearchAiMode, v2CommandSearchObjectMode,
  filteredCommandSearchTreeItems, commandSearchAiItem, filteredCommandSearchActionItems,
  filteredCommandSearchRecentItems, commandSearchFlatItems, commandSearchDestinations,
  commandSearchInputRef, handleV2CommandSearchValueChange, handleV2CommandSearchKeyDown,
  runCommandSearchItem, closeV2CommandSearch, hideSqlLogFromRecent, clearRecentSqlLogs,
  collapsedSidebarActionsTarget, onExpandSidebar, expandSidebarLabel, expandSidebarButtonRef,
  onCollapseSidebar, collapseSidebarLabel, collapseSidebarButtonRef, setRenameViewTarget,
  createTagForm, setIsCreateTagModalOpen, handleOpenSQLFileFromToolbar, usePersistentSidebarFilter,
  openV2CommandSearch,
}: UseSidebarToolbarModelInput) => {
  const v2RailObjectActionsLabel = t('sidebar.rail.object_actions');
  const v2RailSystemActionsLabel = t('sidebar.rail.system_actions');
  const v2NewGroupLabel = t('sidebar.action.new_group');
  const v2DataWorkflowLabel = t('app.tools.group.workflow.title');
  const v2BatchTablesLabel = t('sidebar.action.batch_tables');
  const v2BatchDatabasesLabel = t('sidebar.action.batch_databases');
  const v2BatchConnectionsLabel = t('sidebar.action.batch_connections');
  const v2DataImportLabel = t('sidebar.action.data_import');
  const v2SqlToolsLabel = t('sidebar.action.sql_tools');
  const v2SlowQueryLabel = t('sql_analysis.slow_query.rail.aria_label');
  const v2SqlAuditLabel = t('sql_audit.rail.aria_label');
  const v2OpenExternalSqlFileLabel = t('sidebar.sql_file_exec.title');
  const v2LocateCurrentTableLabel = t('sidebar.action.locate_current_table');
  const v2LocateCurrentTableUnavailableLabel = t('sidebar.message.locate_current_table_unavailable');
  const v2ConnectionActionsLabel = t('sidebar.active_connection.actions');
  const v2ScrollToTopLabel = t('sidebar.action.scroll_to_top');
  const v2CommandSearchLabel = t('sidebar.command_search.label');
  const v2CommandSearchPlaceholder = t('sidebar.command_search.placeholder');

  const scrollV2ExplorerToTop = () => {
    treeRef.current?.scrollTo?.({ index: 0, align: 'top' });
  };
  // Docked / rail actions stay reachable while the explorer is collapsed, so reveal it before scrolling.
  const scrollV2ExplorerToTopExpanded = () => {
    onEnsureSidebarExpanded?.();
    scrollV2ExplorerToTop();
  };
  const sidebarActionsInRail = appearance.sidebarActionsPlacement === 'rail';

  const v2ExplorerToolbarActionProps = {
    labels: {
      objectActions: v2RailObjectActionsLabel,
      locateCurrentTable: v2LocateCurrentTableLabel,
      locateCurrentTableUnavailable: v2LocateCurrentTableUnavailableLabel,
      scrollToTop: v2ScrollToTopLabel,
      connectionActions: v2ConnectionActionsLabel,
    },
    canLocateActiveTab,
    hasActiveConnection: Boolean(activeConnection),
    onLocateCurrentTable: handleLocateActiveTabInSidebar,
    onScrollToTop: scrollV2ExplorerToTop,
    onOpenConnectionActions: (event: React.MouseEvent<HTMLElement>) => {
      if (activeConnection) {
        openV2ConnectionContextMenu(event, activeConnection);
      }
    },
  };

  const handleOpenDataImportWorkbench = useCallback(() => {
    const node = selectedNodesRef.current[0];
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    const nodeConnectionId = String(
      node?.dataRef?.id || (node?.type === 'connection' ? node?.key : '') || '',
    ).trim();
    const connectionId = nodeConnectionId || String(activeContext?.connectionId || '').trim();
    const dbName = String(
      node?.type === 'database'
        ? (node?.dataRef?.dbName || node?.title || '')
        : node?.dataRef?.dbName || activeContext?.dbName || '',
    ).trim();
    const tableName = String(
      node?.type === 'table'
        ? (node?.dataRef?.tableName || node?.title || '')
        : !node && activeTab?.type === 'table'
          ? activeTab.tableName || ''
          : '',
    ).trim();
    const mode = node?.type === 'database' ? 'database' : 'table';

    openDataImportWorkbench({ connectionId, dbName, tableName, mode });
  }, [activeContext?.connectionId, activeContext?.dbName, activeTabId, openDataImportWorkbench, tabs]);

  const {
    openSlowQueryWorkbench,
    openSqlAuditWorkbench,
    openDMLSnapshotWorkbench,
    sessionWorkbenchAction,
    userManagementAction,
  } = useSidebarWorkbenchLaunchers({
    activeTab, activeTabHasConnection, activeConnection, addTab,
  });

  const v2TitlebarQuickActions: TitleBarQuickAction[] = [
    {
      key: 'data-workflow',
      label: v2DataWorkflowLabel,
      icon: <TitlebarGraphIcon size="100%" />,
      menu: [
        {
          key: 'batch-connections',
          label: v2BatchConnectionsLabel,
          icon: <CloudOutlined aria-hidden="true" />,
          onClick: openBatchConnectionWorkbench,
        },
        {
          key: 'batch-tables',
          label: v2BatchTablesLabel,
          icon: <TableOutlined aria-hidden="true" />,
          onClick: openBatchTableWorkbench,
        },
        {
          key: 'batch-databases',
          label: v2BatchDatabasesLabel,
          icon: <DatabaseOutlined aria-hidden="true" />,
          onClick: openBatchDatabaseWorkbench,
        },
        {
          key: 'data-import',
          label: v2DataImportLabel,
          icon: <ImportOutlined aria-hidden="true" />,
          onClick: handleOpenDataImportWorkbench,
        },
        {
          key: 'sync',
          label: t('app.tools.entry.sync.title'),
          icon: <UploadOutlined rotate={90} aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'workflow', action: 'sync' }),
        },
        {
          key: 'compare',
          label: t('app.tools.entry.compare.title'),
          icon: <SwitcherOutlined aria-hidden="true" />,
          onClick: () => onOpenSettingsNavigation?.({ group: 'workflow', action: 'compare' }),
        },
      ],
    },
    {
      key: 'sql-tools',
      label: v2SqlToolsLabel,
      dividerBefore: true, // 「数据工作流」与「SQL 工具」之间的分组竖线
      icon: <TitlebarSqlToolIcon size="100%" />,
      menu: [
        {
          key: 'slow-query',
          label: v2SlowQueryLabel,
          icon: <HistoryOutlined aria-hidden="true" />,
          onClick: openSlowQueryWorkbench,
          disabled: !activeTabHasConnection,
        },
        {
          key: 'sql-audit',
          label: v2SqlAuditLabel,
          icon: <AuditOutlined aria-hidden="true" />,
          onClick: openSqlAuditWorkbench,
        },
        {
          key: 'dml-snapshot',
          label: t('dml_snapshot.workbench.title'),
          icon: <SafetyCertificateOutlined aria-hidden="true" />,
          onClick: openDMLSnapshotWorkbench,
        },
      ],
    },
    sessionWorkbenchAction,
    userManagementAction,
  ];
  // 尾部操作：非 macOS 渲染到标题栏「设置 │ … │ 主题」胶囊中间，macOS 留在工具条 AI 之后。
  const v2TitlebarVisibleTrailingActions = buildTitlebarTrailingActions({
    t,
    activeSettingsCenterPaneKey,
    onOpenSettingsNavigation,
    onCheckUpdate,
    hideAbout: hideTitlebarAboutAction,
    hideDrivers: hideTitlebarDriverAction,
  });

  const { getCommandSearchCopyOptions, handleCopyCommandSearchItem } = useSidebarCommandSearchCopy({ connections, connectionIds });

  const v2CommandSearchPanelProps: SidebarSearchPanelProps<V2CommandSearchItem> = {
    isOpen: isV2CommandSearchOpen,
    searchValue: v2CommandSearchValue,
    activeIndex: v2CommandActiveIndex,
    label: v2CommandSearchLabel,
    placeholder: v2CommandSearchPlaceholder,
    aiMode: v2CommandSearchAiMode,
    objectMode: v2CommandSearchObjectMode,
    flatItems: commandSearchFlatItems,
    sections: {
      goTo: filteredCommandSearchTreeItems,
      ai: commandSearchAiItem,
      tabs: commandSearchDestinations.tabs,
      savedQueries: commandSearchDestinations.savedQueries,
      settings: commandSearchDestinations.settings,
      actions: filteredCommandSearchActionItems,
      recent: filteredCommandSearchRecentItems,
    },
    inputRef: commandSearchInputRef,
    handlers: {
      onSearchValueChange: handleV2CommandSearchValueChange,
      onKeyDown: handleV2CommandSearchKeyDown,
      onClose: closeV2CommandSearch,
      onItemSelect: (item: V2CommandSearchItem) => runCommandSearchItem(item),
      onItemHover: (key: string) => setV2CommandActiveIndex(commandSearchFlatItems.findIndex((entry) => entry.key === key)),
      onRemoveRecentItem: (item: V2CommandSearchItem) => {
        if (item.kind === 'recent') hideSqlLogFromRecent(item.logId);
      },
      onClearRecentItems: clearRecentSqlLogs,
      getCopyOptions: getCommandSearchCopyOptions,
      onCopyCommandSearchItem: handleCopyCommandSearchItem,
    },
  };

  // V2 Connection Rail 子组件 props（从原 renderV2ConnectionRail 抽出，保留所有原行为）
  const v2ConnectionRailProps = {
    labels: {
      railSystemActions: v2RailSystemActionsLabel,
      railObjectActions: v2RailObjectActionsLabel,
      newGroup: v2NewGroupLabel,
      batchTables: v2BatchTablesLabel,
      batchDatabases: v2BatchDatabasesLabel,
      dataImport: v2DataImportLabel,
      openExternalSqlFile: v2OpenExternalSqlFileLabel,
      locateCurrentTable: v2LocateCurrentTableLabel,
      locateCurrentTableUnavailable: v2LocateCurrentTableUnavailableLabel,
    },
    handlers: {
      openCreateTagModal: () => { setRenameViewTarget(null); createTagForm.resetFields(); setIsCreateTagModalOpen(true); },
      openBatchTableExport: openBatchTableWorkbench,
      openBatchDatabaseExport: openBatchDatabaseWorkbench,
      openDataImport: handleOpenDataImportWorkbench,
      openExternalSqlFile: handleOpenSQLFileFromToolbar,
      locateActiveTab: handleLocateActiveTabInSidebar,
    },
    canLocateActiveTab,
    showObjectActions: false,
    showLocateAction: false,
    // The session workbench is exposed as a titlebar action so it remains
    // reachable while the expanded explorer hides the fixed rail.
    showWorkbenchActions: false,
    sidebarExpandAction: !collapsedSidebarActionsTarget && !sidebarActionsInRail && onExpandSidebar && expandSidebarLabel ? {
      label: expandSidebarLabel,
      onClick: onExpandSidebar,
      buttonRef: expandSidebarButtonRef,
    } : undefined,
    explorerActions: sidebarActionsInRail ? (
      <V2RailExplorerActions
        label={v2RailSystemActionsLabel}
        searchAction={usePersistentSidebarFilter ? undefined : { label: v2CommandSearchLabel, onClick: () => openV2CommandSearch() }}
        toolbar={{ ...v2ExplorerToolbarActionProps, onScrollToTop: scrollV2ExplorerToTopExpanded }}
        collapseAction={onCollapseSidebar && collapseSidebarLabel
          ? { label: collapseSidebarLabel, onClick: onCollapseSidebar, buttonRef: collapseSidebarButtonRef }
          : undefined}
        expandAction={onExpandSidebar && expandSidebarLabel
          ? { label: expandSidebarLabel, onClick: onExpandSidebar, buttonRef: expandSidebarButtonRef }
          : undefined}
      />
    ) : undefined,
  };
  return {
    v2RailObjectActionsLabel, v2RailSystemActionsLabel, v2CommandSearchLabel,
    scrollV2ExplorerToTopExpanded, sidebarActionsInRail, v2ExplorerToolbarActionProps,
    v2TitlebarQuickActions, v2TitlebarVisibleTrailingActions, v2CommandSearchPanelProps,
    v2ConnectionRailProps,
  };
};

export type SidebarToolbarModelApi = ReturnType<typeof useSidebarToolbarModel>;
