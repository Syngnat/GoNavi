import React, { useCallback, useEffect, useMemo } from 'react';
import type { DragStartEvent, DragMoveEvent, DragEndEvent } from '@dnd-kit/core';
import type { TabsProps, MenuProps } from 'antd';
import {
  EditOutlined,
  SettingOutlined,
  ExportOutlined,
  CloseCircleOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import {
  buildTabDisplayModel,
  getConnectionGroupName,
  resolveConnectionHostSummary,
} from '../../../utils/tabDisplay';
import { t } from '../../../i18n';
import {
  type NativeDetachTerminalPointer,
  resolveNativeDetachDragRelease,
  shouldDetachAtScreenPoint,
  shouldDetachTabByDrag,
  resolveNativeDetachPreferredBounds,
  shouldDetachAfterNativePointerCancel,
} from '../../../utils/detachedWindow';
import { installTabDetachDragGuards, DraggableTabNode } from '../tabDragGuards';
import { buildDetachDragPreviewState } from '../../DetachDragPreview';
import { QueryEditorRunningTabsDock } from '../../queryEditor/QueryEditorRunningTabsDock';
import { resolveConnectionEnvironmentPresentation } from '../../../utils/connectionEnvironment';
import {
  resolveQueryTabRenameMenuState,
  isMainWindowBoundWorkbenchTab,
  buildRecentConnectionShortcuts,
  RECENT_WORKBENCH_ITEM_LIMIT,
  buildRecentSQLFileShortcuts,
  buildPinnedTableShortcuts,
  buildLinkedExternalSQLDirectoryShortcuts,
  type RecentConnectionShortcut,
  dispatchRecentConnectionShortcut,
  type PinnedTableShortcut,
} from '../tabManagerShortcuts';
import { QUERY_TAB_RENAME_REQUEST_EVENT } from '../../../utils/queryTabTitle';
import { openTabDisplaySettings } from '../TabHoverInfo';
import {
  getCloseOtherTabIds,
  closeConfirmedWorkbenchTabs,
  getCloseTabsToLeftIds,
  getCloseTabsToRightIds,
} from '../tabManagerCloseHelpers';
import { SortableTabLabel } from '../SortableTabLabel';
import WorkbenchTabContent from '../../WorkbenchTabContent';
import { getDataSourceCapabilities } from '../../../utils/dataSourceCapabilities';
import { buildWorkbenchQueryTabId } from '../tabManagerIds';
import type { TabManagerStateApi } from './useTabManagerState';
import type { TabManagerProps } from '../../TabManager';

export interface UseTabManagerItemsInput {
  detachDragSessionRef: TabManagerStateApi['detachDragSessionRef'];
  setDetachDragPreview: TabManagerStateApi['setDetachDragPreview'];
  dispatchDndPointerCancel: TabManagerStateApi['dispatchDndPointerCancel'];
  setDraggingTabId: TabManagerStateApi['setDraggingTabId'];
  dockedTabs: TabManagerStateApi['dockedTabs'];
  connections: TabManagerStateApi['connections'];
  appearance: TabManagerStateApi['appearance'];
  connectionGroupNameById: TabManagerStateApi['connectionGroupNameById'];
  suppressClickUntilRef: TabManagerStateApi['suppressClickUntilRef'];
  detachTabToWindow: TabManagerStateApi['detachTabToWindow'];
  moveTab: TabManagerStateApi['moveTab'];
  tabs: TabManagerStateApi['tabs'];
  activeTabId: TabManagerStateApi['activeTabId'];
  addTab: TabManagerStateApi['addTab'];
  setActiveTab: TabManagerStateApi['setActiveTab'];
  closeTabsWithSQLFilePrompt: TabManagerStateApi['closeTabsWithSQLFilePrompt'];
  closeTab: TabManagerStateApi['closeTab'];
  shouldDestroyHiddenTab: TabManagerStateApi['shouldDestroyHiddenTab'];
  languagePreference: TabManagerStateApi['languagePreference'];
  recentConnectionTargets: TabManagerStateApi['recentConnectionTargets'];
  savedQueries: TabManagerStateApi['savedQueries'];
  externalSQLDirectories: TabManagerStateApi['externalSQLDirectories'];
  recentSQLFiles: TabManagerStateApi['recentSQLFiles'];
  pinnedSidebarTables: TabManagerStateApi['pinnedSidebarTables'];
  setAIPanelVisible: TabManagerStateApi['setAIPanelVisible'];
  onFocusSidebarSearch: TabManagerProps['onFocusSidebarSearch'];
}

export const useTabManagerItems = ({
  detachDragSessionRef, setDetachDragPreview, dispatchDndPointerCancel, setDraggingTabId,
  dockedTabs, connections, appearance, connectionGroupNameById, suppressClickUntilRef,
  detachTabToWindow, moveTab, tabs, activeTabId, addTab, setActiveTab, closeTabsWithSQLFilePrompt,
  closeTab, shouldDestroyHiddenTab, languagePreference, recentConnectionTargets, savedQueries,
  externalSQLDirectories, recentSQLFiles, pinnedSidebarTables, setAIPanelVisible,
  onFocusSidebarSearch,
}: UseTabManagerItemsInput) => {
  const clearDetachDragSession = useCallback(() => {
    const session = detachDragSessionRef.current;
    session?.removeDragGuards?.();
    if (session?.captureTarget && session.pointerId !== null) {
      try {
        if (session.captureTarget.hasPointerCapture?.(session.pointerId)) {
          session.captureTarget.releasePointerCapture(session.pointerId);
        }
      } catch {
        // Pointer capture may already have been released by the native WebView.
      }
    }
    detachDragSessionRef.current = null;
    setDetachDragPreview(null);
    document.documentElement.classList.remove('gn-workbench-tab-detaching');
  }, []);

  useEffect(() => () => {
    const hadActiveSession = detachDragSessionRef.current !== null;
    clearDetachDragSession();
    if (hadActiveSession) {
      dispatchDndPointerCancel();
    }
  }, [clearDetachDragSession, dispatchDndPointerCancel]);

  const handleDragStart = (event: DragStartEvent) => {
    clearDetachDragSession();
    const sourceId = String(event.active.id || '').trim();
    setDraggingTabId(sourceId || null);
    const tab = dockedTabs.find((item) => item.id === sourceId);
    const connection = connections.find((conn) => conn.id === tab?.connectionId);
    const displayModel = tab
      ? buildTabDisplayModel(tab, connection, appearance.tabDisplay, t, getConnectionGroupName(connectionGroupNameById, tab.connectionId))
      : null;
    const title = displayModel?.fullTitle || tab?.title || t('tab_manager.detached.title_fallback');
    const pointerEvent = event.activatorEvent as PointerEvent | MouseEvent | undefined;
    const startX = typeof pointerEvent?.clientX === 'number' ? pointerEvent.clientX : 0;
    const startY = typeof pointerEvent?.clientY === 'number' ? pointerEvent.clientY : 0;
    const startScreenX = typeof pointerEvent?.screenX === 'number'
      ? pointerEvent.screenX
      : window.screenX + startX;
    const startScreenY = typeof pointerEvent?.screenY === 'number'
      ? pointerEvent.screenY
      : window.screenY + startY;
    const pointerId = typeof (pointerEvent as PointerEvent | undefined)?.pointerId === 'number'
      ? (pointerEvent as PointerEvent).pointerId
      : null;
    const activatorTarget = pointerEvent?.target;
    const captureTarget = typeof Element !== 'undefined' && activatorTarget instanceof Element
      ? activatorTarget.closest<HTMLElement>('.tab-dnd-node')
      : null;
    const session = sourceId
      ? {
          tabId: sourceId,
          title,
          startX,
          startY,
          startScreenX,
          startScreenY,
          pointerId,
          captureTarget,
          terminalPointer: null as NativeDetachTerminalPointer | null,
          removeDragGuards: null as (() => void) | null,
        }
      : null;
    detachDragSessionRef.current = session;
    if (session) {
      session.removeDragGuards = installTabDetachDragGuards({
        windowTarget: window,
        captureTarget: session.captureTarget,
        rootClassList: document.documentElement.classList,
        pointerId: session.pointerId,
        isCurrent: () => detachDragSessionRef.current === session,
        onTerminalPointer: (terminalPointer) => {
          session.terminalPointer = terminalPointer;
        },
        onInterrupted: () => {
          setDraggingTabId(null);
          clearDetachDragSession();
        },
        cancelDndDrag: dispatchDndPointerCancel,
      });
    }
  };

  const handleDragMove = (event: DragMoveEvent) => {
    const session = detachDragSessionRef.current;
    if (!session) return;
    const deltaX = Number(event.delta?.x || 0);
    const deltaY = Number(event.delta?.y || 0);
    setDetachDragPreview(buildDetachDragPreviewState({
      title: session.title,
      clientX: session.startX + deltaX,
      clientY: session.startY + deltaY,
      deltaY,
    }));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const sourceId = String(event.active.id || '').trim();
    const targetId = String(event.over?.id || '').trim();
    const deltaX = Number(event.delta?.x || 0);
    const deltaY = Number(event.delta?.y || 0);
    const session = detachDragSessionRef.current;
    const release = resolveNativeDetachDragRelease({
      startClientX: session?.startX ?? 0,
      startClientY: session?.startY ?? 0,
      startScreenX: session?.startScreenX ?? window.screenX,
      startScreenY: session?.startScreenY ?? window.screenY,
      fallbackDeltaX: deltaX,
      fallbackDeltaY: deltaY,
      terminalPointer: session?.terminalPointer,
    });
    setDraggingTabId(null);
    clearDetachDragSession();
    if (!sourceId) {
      return;
    }
    const releasedOutsideHost = shouldDetachAtScreenPoint(release.screenX, release.screenY, {
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth || window.innerWidth,
      height: window.outerHeight || window.innerHeight,
    });
    if (shouldDetachTabByDrag(release.deltaY, targetId || null) || releasedOutsideHost) {
      suppressClickUntilRef.current = Date.now() + 120;
      const preferred = resolveNativeDetachPreferredBounds(release.screenX, release.screenY);
      detachTabToWindow(sourceId, preferred);
      return;
    }
    if (!targetId || sourceId === targetId) {
      return;
    }
    suppressClickUntilRef.current = Date.now() + 120;
    moveTab(sourceId, targetId);
  };

  const handleDragCancel = () => {
    const session = detachDragSessionRef.current;
    const release = resolveNativeDetachDragRelease({
      startClientX: session?.startX ?? 0,
      startClientY: session?.startY ?? 0,
      startScreenX: session?.startScreenX ?? window.screenX,
      startScreenY: session?.startScreenY ?? window.screenY,
      fallbackDeltaX: 0,
      fallbackDeltaY: 0,
      terminalPointer: session?.terminalPointer,
    });
    const shouldDetach = Boolean(session) && shouldDetachAfterNativePointerCancel(release, {
      x: window.screenX,
      y: window.screenY,
      width: window.outerWidth || window.innerWidth,
      height: window.outerHeight || window.innerHeight,
    });
    setDraggingTabId(null);
    clearDetachDragSession();
    if (shouldDetach && session) {
      suppressClickUntilRef.current = Date.now() + 120;
      detachTabToWindow(
        session.tabId,
        resolveNativeDetachPreferredBounds(release.screenX, release.screenY),
      );
    }
  };

  React.useEffect(() => {
    const handleGlobalInsertSql = (e: any) => {
      const { sql, runImmediately, connectionId: eventConnId, dbName: eventDbName } = e.detail;
      if (!sql) return;

      const activeTab = tabs.find(t => t.id === activeTabId);

      // 🔧 runImmediately（点击"执行"）始终新建独立 tab，避免追加到已有 tab 导致 SQL 重复
      if (runImmediately) {
        const newTabId = 'tab-' + Date.now();
        const resolvedConnId = eventConnId || activeTab?.connectionId || (connections.length > 0 ? connections[0].id : '');
        const resolvedDbName = eventConnId ? (eventDbName || '') : (activeTab?.dbName || '');
        addTab({
            id: newTabId,
            type: 'query',
            title: t('query.new'),
            query: sql,
            connectionId: resolvedConnId,
            dbName: resolvedDbName
        });
        setActiveTab(newTabId);
        setTimeout(() => {
            window.dispatchEvent(new CustomEvent('gonavi:insert-sql-to-tab', {
                detail: { tabId: newTabId, sql, runImmediately: true, connectionId: resolvedConnId, dbName: resolvedDbName }
            }));
        }, 300);
        return;
      }

      // 插入模式：追加到已有 tab 或新建 tab
      if (activeTab && activeTab.type === 'query') {
        window.dispatchEvent(new CustomEvent('gonavi:insert-sql-to-tab', {
          detail: { ...e.detail, tabId: activeTab.id, runImmediately: false }
        }));
      } else {
        const newTabId = 'tab-' + Date.now();
        const resolvedConnId = eventConnId || activeTab?.connectionId || (connections.length > 0 ? connections[0].id : '');
        const resolvedDbName = eventConnId ? (eventDbName || '') : (activeTab?.dbName || '');
        addTab({
            id: newTabId,
            type: 'query',
            title: t('query.new'),
            query: sql,
            connectionId: resolvedConnId,
            dbName: resolvedDbName
        });
        setActiveTab(newTabId);
      }
    };
    window.addEventListener('gonavi:insert-sql', handleGlobalInsertSql);
    return () => window.removeEventListener('gonavi:insert-sql', handleGlobalInsertSql);
  }, [tabs, activeTabId, addTab, setActiveTab, connections]);

  const tabIds = useMemo(() => dockedTabs.map((tab) => tab.id), [dockedTabs]);
  const hasDoubleLineTabLabel = useMemo(() => (
    dockedTabs.some((tab) => {
      const connection = connections.find((conn) => conn.id === tab.connectionId);
      const displayModel = buildTabDisplayModel(tab, connection, appearance.tabDisplay, t, getConnectionGroupName(connectionGroupNameById, tab.connectionId));
      return displayModel.layout === 'double' && Boolean(displayModel.secondaryText);
    })
  ), [appearance.tabDisplay, connections, connectionGroupNameById, dockedTabs]);

  const renderTabBar: TabsProps['renderTabBar'] = (tabBarProps, DefaultTabBar) => (
    <DefaultTabBar {...tabBarProps} extra={<QueryEditorRunningTabsDock />}>
      {(node) => <DraggableTabNode key={node.key} node={node} />}
    </DefaultTabBar>
  );

  const items = useMemo(() => dockedTabs.map((tab, index) => {
    const connection = connections.find((conn) => conn.id === tab.connectionId);
    const displayModel = buildTabDisplayModel(tab, connection, appearance.tabDisplay, t, getConnectionGroupName(connectionGroupNameById, tab.connectionId));
    const environment = connection
      ? resolveConnectionEnvironmentPresentation(connection, t)
      : undefined;
    const displayTitle = displayModel.fullTitle;
    const hostSummary = resolveConnectionHostSummary(connection?.config);
    const renameQueryMenuState = resolveQueryTabRenameMenuState(tab);

    const menuItems: MenuProps['items'] = [
      ...(renameQueryMenuState.visible ? [{
        key: 'rename-query',
        icon: <EditOutlined />,
        label: t('query_editor.action.rename_query'),
        disabled: renameQueryMenuState.disabled,
        onClick: () => {
          setActiveTab(tab.id);
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent(QUERY_TAB_RENAME_REQUEST_EVENT, {
              detail: { tabId: tab.id },
            }));
          }, 0);
        },
      }] : []),
      {
        key: 'tab-display-settings',
        icon: <SettingOutlined />,
        label: t('tab_manager.menu.tab_display_settings'),
        onClick: openTabDisplaySettings,
      },
      {
        key: 'open-in-window',
        icon: <ExportOutlined />,
        label: t('tab_manager.menu.open_in_window'),
        disabled: isMainWindowBoundWorkbenchTab(tab),
        onClick: () => detachTabToWindow(tab.id),
      },
      { type: 'divider' },
      {
        key: 'close-other',
        icon: <CloseCircleOutlined />,
        label: t('tab_manager.menu.close_other'),
        disabled: tabs.length <= 1,
        onClick: () => {
          const targetIds = getCloseOtherTabIds(tabs, tab.id);
          closeTabsWithSQLFilePrompt(targetIds, () => closeConfirmedWorkbenchTabs(targetIds, closeTab));
        },
      },
      {
        key: 'close-left',
        icon: <ArrowLeftOutlined />,
        label: t('tab_manager.menu.close_left'),
        disabled: index === 0,
        onClick: () => {
          const targetIds = getCloseTabsToLeftIds(dockedTabs, tab.id);
          closeTabsWithSQLFilePrompt(targetIds, () => closeConfirmedWorkbenchTabs(targetIds, closeTab));
        },
      },
      {
        key: 'close-right',
        icon: <ArrowRightOutlined />,
        label: t('tab_manager.menu.close_right'),
        disabled: index === dockedTabs.length - 1,
        onClick: () => {
          const targetIds = getCloseTabsToRightIds(dockedTabs, tab.id);
          closeTabsWithSQLFilePrompt(targetIds, () => closeConfirmedWorkbenchTabs(targetIds, closeTab));
        },
      },
      {
        key: 'close-all',
        icon: <CloseOutlined />,
        label: t('tab_manager.menu.close_all'),
        disabled: tabs.length === 0,
        onClick: () => {
          const targetIds = tabs.map((item) => item.id);
          closeTabsWithSQLFilePrompt(targetIds, () => closeConfirmedWorkbenchTabs(targetIds, closeTab));
        },
      },
    ];

    return {
      label: (
        <SortableTabLabel
          tab={tab}
          displayModel={displayModel}
          displayTitle={displayTitle}
          menuItems={menuItems}
          connectionLabel={connection?.name}
          hostSummary={hostSummary}
          environmentColor={environment?.color}
          environmentLabel={environment?.label}
          environmentType={environment?.type}
          onClose={() => closeTabsWithSQLFilePrompt([tab.id], () => closeTab(tab.id))}
        />
      ),
      key: tab.id,
      closable: false,
      destroyOnHidden: shouldDestroyHiddenTab(tab),
      children: <WorkbenchTabContent tab={tab} />,
    };
  }), [dockedTabs, tabs, connections, connectionGroupNameById, appearance.tabDisplay, closeTab, closeTabsWithSQLFilePrompt, detachTabToWindow, true, languagePreference, shouldDestroyHiddenTab]);

  const queryCapableConnections = useMemo(
    () => connections.filter((connection) => getDataSourceCapabilities(connection.config).supportsQueryEditor),
    [connections],
  );
  const connectionById = useMemo(
    () => new Map(queryCapableConnections.map((connection) => [connection.id, connection])),
    [queryCapableConnections],
  );
  const recentConnectionShortcuts = useMemo(
    () => buildRecentConnectionShortcuts(connections, recentConnectionTargets),
    [connections, recentConnectionTargets],
  );
  const recentSavedQueries = useMemo(
    () => [...savedQueries]
      .filter((query) => connectionById.has(query.connectionId))
      .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
      .slice(0, RECENT_WORKBENCH_ITEM_LIMIT),
    [connectionById, savedQueries],
  );
  const recentSQLFileShortcuts = useMemo(
    () => buildRecentSQLFileShortcuts(queryCapableConnections, externalSQLDirectories, recentSQLFiles),
    [externalSQLDirectories, queryCapableConnections, recentSQLFiles],
  );
  const pinnedTableShortcuts = useMemo(
    () => buildPinnedTableShortcuts(queryCapableConnections, pinnedSidebarTables),
    [pinnedSidebarTables, queryCapableConnections],
  );
  const linkedExternalSQLDirectoryShortcuts = useMemo(
    () => buildLinkedExternalSQLDirectoryShortcuts(queryCapableConnections, externalSQLDirectories),
    [externalSQLDirectories, queryCapableConnections],
  );

  const handleOpenConnectionModal = () => {
    const target = document.querySelector<HTMLButtonElement>('[data-gonavi-create-connection-action="true"]');
    target?.click();
  };

  const handleOpenAI = () => {
    setAIPanelVisible(true);
  };

  const handleFocusObjectSearch = () => {
    if (onFocusSidebarSearch) {
      onFocusSidebarSearch();
      return;
    }
    window.dispatchEvent(new CustomEvent('gonavi:focus-sidebar-search'));
  };

  const handleAddExternalSQLDirectory = () => {
    window.dispatchEvent(new CustomEvent('gonavi:add-external-sql-directory'));
  };

  const handleOpenRecentConnection = useCallback((shortcut: RecentConnectionShortcut) => {
    dispatchRecentConnectionShortcut(shortcut);
  }, []);

  const handleCreateQueryForConnection = useCallback((shortcut: Pick<RecentConnectionShortcut, 'connection' | 'dbName'>) => {
    addTab({
      id: buildWorkbenchQueryTabId(),
      title: t('query.new'),
      type: 'query',
      connectionId: shortcut.connection.id,
      dbName: shortcut.dbName,
      query: '',
    });
  }, [addTab]);

  const handleOpenPinnedTable = useCallback((shortcut: PinnedTableShortcut) => {
    const displayName = shortcut.schemaName
      ? `${shortcut.schemaName}.${shortcut.tableName}`
      : shortcut.tableName;
    addTab({
      id: `pinned-table:${[shortcut.connection.id, shortcut.dbName, shortcut.schemaName || '', shortcut.tableName]
        .map(encodeURIComponent)
        .join(':')}`,
      title: displayName,
      type: 'table',
      connectionId: shortcut.connection.id,
      dbName: shortcut.dbName,
      tableName: shortcut.tableName,
      ...(shortcut.schemaName ? { schemaName: shortcut.schemaName } : {}),
      objectType: 'table',
    });
  }, [addTab]);
  return {
    handleDragStart, handleDragMove, handleDragEnd, handleDragCancel, tabIds, hasDoubleLineTabLabel,
    renderTabBar, items, connectionById, recentConnectionShortcuts, recentSavedQueries,
    recentSQLFileShortcuts, pinnedTableShortcuts, linkedExternalSQLDirectoryShortcuts,
    handleOpenConnectionModal, handleOpenAI, handleFocusObjectSearch, handleAddExternalSQLDirectory,
    handleOpenRecentConnection, handleCreateQueryForConnection, handleOpenPinnedTable,
  };
};

export type TabManagerItemsApi = ReturnType<typeof useTabManagerItems>;
