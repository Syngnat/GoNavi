import React from 'react';
import { Tabs } from 'antd';
import { DndContext, closestCenter } from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { t } from '../i18n';
import DetachDragPreview from './DetachDragPreview';
import {
  TAB_WORKBENCH_CLASS_NAME, TAB_ENVIRONMENT_ACCENT_CSS_HEIGHT,
} from './tabManager/tabManagerShortcuts';
import { useTabManagerState } from './tabManager/hooks/useTabManagerState';
import { useTabManagerItems } from './tabManager/hooks/useTabManagerItems';
import { useTabManagerEmptyWorkbench } from './tabManager/hooks/useTabManagerEmptyWorkbench';

export {
  isBackgroundTaskWorkbenchTab,
  isMainWindowBoundWorkbenchTab,
  resolveQueryTabRenameMenuState,
  isRunningDataImportWorkbenchTab,
  TAB_WORKBENCH_CLASS_NAME,
  TAB_ENVIRONMENT_ACCENT_CSS_HEIGHT,
  buildTabWorkbenchStyle,
  V2_WORKBENCH_TAB_MIN_WIDTH,
  V2_WORKBENCH_TAB_MAX_WIDTH,
  resolveV2WorkbenchTabWidth,
  dispatchRecentConnectionShortcut,
  buildRecentConnectionShortcuts,
  RecentConnectionShortcutItem,
  buildPinnedTableShortcuts,
  buildRecentSQLFileShortcuts,
} from './tabManager/tabManagerShortcuts';
export type {
  RecentConnectionShortcut,
  PinnedTableShortcut,
} from './tabManager/tabManagerShortcuts';
export {
  closeConfirmedWorkbenchTabs,
  stopTabHoverDragPropagation,
} from './tabManager/tabManagerCloseHelpers';
export { resolveTabHoverOpen, isMiddleMouseButton } from './tabManager/SortableTabLabel';
export {
  openTabDisplaySettings,
  shouldShowV2ConnectionLabel,
  resolveTabHoverTitle,
  TabHoverInfo,
} from './tabManager/TabHoverInfo';
export {
  shouldActivateTabDragPointer,
  handleTabDragPointerDown,
  installTabDetachDragGuards,
} from './tabManager/tabDragGuards';

export type TabManagerProps = {
  onFocusSidebarSearch?: () => void;
};

const TabManager: React.FC<TabManagerProps> = React.memo<TabManagerProps>(({ onFocusSidebarSearch }) => {
  const {
    tabs, connections, savedQueries, externalSQLDirectories, recentConnectionTargets,
    recentSQLFiles, pinnedSidebarTables, theme, appearance, languagePreference, activeTabId,
    shouldDestroyHiddenTab, setActiveTab, addTab, closeTab, moveTab, setAIPanelVisible, dockedTabs,
    connectionGroupNameById, tabsNavBorderColor, tabWorkbenchRef, setDraggingTabId,
    detachDragPreview, setDetachDragPreview, openingRecentSQLFileKey, setOpeningRecentSQLFileKey,
    detachDragSessionRef, suppressClickUntilRef, sensors, hasTabs, hasDockedTabs, tabWorkbenchStyle,
    detachTabToWindow, dockedActiveTabId, onChange, closeTabsWithSQLFilePrompt, onEdit,
    dispatchDndPointerCancel,
  } = useTabManagerState();

  const {
    handleDragStart, handleDragMove, handleDragEnd, handleDragCancel, tabIds, hasDoubleLineTabLabel,
    renderTabBar, items, connectionById, recentConnectionShortcuts, recentSavedQueries,
    recentSQLFileShortcuts, pinnedTableShortcuts, linkedExternalSQLDirectoryShortcuts,
    handleOpenConnectionModal, handleOpenAI, handleFocusObjectSearch, handleAddExternalSQLDirectory,
    handleOpenRecentConnection, handleCreateQueryForConnection, handleOpenPinnedTable,
  } = useTabManagerItems({
    detachDragSessionRef, setDetachDragPreview, dispatchDndPointerCancel, setDraggingTabId,
    dockedTabs, connections, appearance, connectionGroupNameById, suppressClickUntilRef,
    detachTabToWindow, moveTab, tabs, activeTabId, addTab, setActiveTab, closeTabsWithSQLFilePrompt,
    closeTab, shouldDestroyHiddenTab, languagePreference, recentConnectionTargets, savedQueries,
    externalSQLDirectories, recentSQLFiles, pinnedSidebarTables, setAIPanelVisible,
    onFocusSidebarSearch,
  });

  const { EmptyWorkbench } = useTabManagerEmptyWorkbench({
    connectionById, addTab, externalSQLDirectories, setOpeningRecentSQLFileKey, connections,
    handleOpenConnectionModal, handleFocusObjectSearch, handleOpenAI, recentConnectionShortcuts,
    handleOpenRecentConnection, recentSavedQueries, recentSQLFileShortcuts, openingRecentSQLFileKey,
    pinnedTableShortcuts, handleOpenPinnedTable, linkedExternalSQLDirectoryShortcuts,
    handleCreateQueryForConnection, handleAddExternalSQLDirectory,
  });

  return (
    <div
      ref={tabWorkbenchRef}
      className={`${TAB_WORKBENCH_CLASS_NAME} gn-v2-tab-workbench`}
      style={tabWorkbenchStyle}
    >
        <style>{`
            .${TAB_WORKBENCH_CLASS_NAME} {
              height: 100%;
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
              display: flex;
              flex-direction: column;
              overflow: hidden;
            }
            .main-tabs {
              height: 100%;
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
              display: flex;
              flex-direction: column;
              overflow: hidden;
            }
            .main-tabs .ant-tabs-nav {
              flex: 0 0 auto;
              margin: 0;
            }
            .main-tabs .ant-tabs-content-holder {
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
              overflow: hidden;
              display: flex;
              flex-direction: column;
            }
            .main-tabs .ant-tabs-content {
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
              display: flex;
              flex-direction: column;
            }
            .main-tabs .ant-tabs-tabpane {
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
              display: flex;
              flex-direction: column;
              overflow: hidden;
            }
            .main-tabs .ant-tabs-tabpane > div {
              flex: 1 1 auto;
              min-height: 0;
              min-width: 0;
            }
            .main-tabs .ant-tabs-tabpane-hidden {
              display: none !important;
            }
            .main-tabs .ant-tabs-nav::before {
                border-bottom: 1px solid ${tabsNavBorderColor} !important;
            }
            .main-tabs .ant-tabs-tab {
              transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1), background-color 120ms ease;
            }
            .main-tabs .tab-dnd-label {
              position: relative;
              user-select: none;
              -webkit-user-select: none;
              display: inline-flex;
              align-items: center;
              gap: 7px;
              max-width: 100%;
            }
            .main-tabs .gn-tab-environment-accent {
              position: absolute;
              z-index: 1;
              right: 8px;
              bottom: 0;
              left: 8px;
              height: ${TAB_ENVIRONMENT_ACCENT_CSS_HEIGHT};
              box-sizing: border-box;
              border-radius: 4px 4px 0 0;
              background: var(--gn-tab-environment-color);
              pointer-events: none;
              transition: opacity 140ms ease;
            }
            .main-tabs .ant-tabs-tab:not(:hover):not(.ant-tabs-tab-active) .gn-tab-environment-accent {
              opacity: 0.86;
            }
            .main-tabs .tab-title-text {
              min-width: 0;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            }
            .main-tabs .tab-dnd-node.is-dragging,
            .main-tabs .tab-dnd-node.is-dragging .tab-dnd-label {
              cursor: grabbing !important;
            }
            body[data-theme='dark'] .main-tabs .ant-tabs-tab-btn:focus-visible {
              outline: none !important;
              border-radius: 6px;
              box-shadow: 0 0 0 2px rgba(255, 214, 102, 0.72);
              background: rgba(255, 214, 102, 0.16);
            }
            body[data-theme='light'] .main-tabs .ant-tabs-tab-btn:focus-visible {
              outline: none !important;
              border-radius: 6px;
              box-shadow: 0 0 0 2px rgba(9, 109, 217, 0.32);
              background: rgba(9, 109, 217, 0.08);
            }
            body[data-theme='light'] .main-tabs .ant-tabs-tab.ant-tabs-tab-active {
              background: rgba(24, 144, 255, 0.10) !important;
              border-color: rgba(24, 144, 255, 0.28) !important;
            }
body[data-theme='dark'] .main-tabs .ant-tabs-tab.ant-tabs-tab-active {
              background: rgba(255, 214, 102, 0.12) !important;
              border-color: rgba(255, 214, 102, 0.4) !important;
            }
            body[data-ui-version='v2'] .main-tabs .ant-tabs-tab.ant-tabs-tab-active {
              background: var(--gn-bg-panel) !important;
              border-color: var(--gn-br-2) !important;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-tooltip .ant-tooltip-inner {
              min-width: 260px;
              padding: 0;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-tooltip {
              pointer-events: auto;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-card {
              --gn-v2-tab-hover-grid-columns: 56px minmax(0, 1fr);
              display: flex;
              flex-direction: column;
              gap: 8px;
              padding: 10px;
              color: var(--gn-fg-2);
              cursor: text;
              user-select: text;
              -webkit-user-select: text;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-card * {
              user-select: text;
              -webkit-user-select: text;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-head {
              display: grid;
              grid-template-columns: var(--gn-v2-tab-hover-grid-columns);
              align-items: start;
              gap: 8px;
              min-width: 0;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-head > span {
              justify-self: start;
              padding: 2px 6px;
              border-radius: 5px;
              background: var(--gn-bg-active);
              color: var(--gn-accent-2);
              font-family: var(--gn-font-mono);
              font-size: 10px;
              font-weight: 700;
              line-height: 14px;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-head > strong {
              min-width: 0;
              overflow-wrap: anywhere;
              color: var(--gn-fg-1);
              font-size: var(--gn-font-size-sm, 12px);
              font-weight: 700;
              line-height: 18px;
              white-space: normal;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-rows {
              display: grid;
              gap: 5px;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-row {
              display: grid;
              grid-template-columns: var(--gn-v2-tab-hover-grid-columns);
              align-items: start;
              gap: 8px;
              font-size: var(--gn-font-size-sm, 12px);
              line-height: 18px;
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-row > span {
              color: var(--gn-fg-5);
            }
            body[data-ui-version='v2'] .gn-v2-tab-hover-row > strong {
              min-width: 0;
              overflow-wrap: anywhere;
              color: var(--gn-fg-2);
              font-weight: 600;
            }
            html.gn-workbench-tab-detaching,
            html.gn-workbench-tab-detaching body,
            html.gn-workbench-tab-detaching * {
              user-select: none !important;
              -webkit-user-select: none !important;
            }
        `}</style>
        {!hasTabs ? (
          EmptyWorkbench
        ) : !hasDockedTabs ? (
          // All tabs are floating: keep empty docked area; floating host still shows content.
          <div className="gn-detached-only-workbench" style={{ flex: 1, minHeight: 0 }} />
        ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
            <Tabs
                className={`main-tabs gn-v2-main-tabs${hasDoubleLineTabLabel ? ' gn-v2-main-tabs-double' : ''}`}
                type="editable-card"
                onChange={(newActiveKey) => {
                  if (Date.now() < suppressClickUntilRef.current) return;
                  onChange(newActiveKey);
                }}
                activeKey={dockedActiveTabId || undefined}
                onEdit={onEdit}
                items={items}
                hideAdd
                renderTabBar={renderTabBar}
            />
          </SortableContext>
        </DndContext>
        )}
        <DetachDragPreview
          preview={detachDragPreview}
          darkMode={theme === 'dark'}
          readyHint={t('tab_manager.menu.open_in_window')}
        />
    </div>
  );
});

export default TabManager;
