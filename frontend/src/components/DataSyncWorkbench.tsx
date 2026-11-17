import React, { useCallback, useMemo } from 'react';

import { useStore } from '../store';
import type { TabData } from '../types';
import { useOptionalI18n } from '../i18n/provider';
import {
  createWailsDataSyncWorkbenchGateway,
  DataSyncWorkbenchShell,
  type DataSyncConnectionTreeItem,
  type DataSyncWorkbenchFamily,
} from './data-sync';
import { buildDataSyncWorkbenchInitialTasks } from './data-sync/dataSyncWorkbenchInitialTasks';
import { normalizeDataSyncEntryMode } from './dataSyncEntryMode';
import { buildDataSyncWorkbenchTab } from '../utils/dataSyncTab';
import {
  buildSidebarConnectionTagTree,
  type SidebarConnectionTagTreeItem,
} from './sidebarV2Utils';
import { requestCloseWorkbenchTabs } from '../utils/workbenchTabCloseProtection';

const resolveWorkbenchFamily = (tab: TabData): DataSyncWorkbenchFamily =>
  normalizeDataSyncEntryMode(tab.dataSyncEntryMode);

const DataSyncWorkbench: React.FC<{ tab: TabData; embedded?: boolean }> = ({
  tab,
  embedded = false,
}) => {
  const connections = useStore((state) => state.connections);
  const connectionTags = useStore((state) => state.connectionTags);
  const sidebarRootOrder = useStore((state) => state.sidebarRootOrder);
  const rootSortMode = useStore((state) => state.rootSortMode);
  const rootConnectionSortMode = useStore((state) => state.rootConnectionSortMode);
  const i18n = useOptionalI18n();
  const workbenchFamily = resolveWorkbenchFamily(tab);
  const addTab = useStore((state) => state.addTab);
  const setAIPanelVisible = useStore((state) => state.setAIPanelVisible);
  const handleClose = useCallback(() => {
    requestCloseWorkbenchTabs([tab.id]);
  }, [tab.id]);
  const handleOpenQueryTab = useCallback(
    (queryTab: {
      title: string;
      connectionId: string;
      dbName?: string;
      schemaName?: string;
      query: string;
    }) => {
      addTab({
        id: `query-compare-repair-${Date.now()}`,
        title: queryTab.title,
        type: 'query',
        connectionId: queryTab.connectionId,
        dbName: queryTab.dbName,
        schemaName: queryTab.schemaName,
        query: queryTab.query,
      });
    },
    [addTab],
  );
  const handleAskAi = useCallback(
    (prompt: string) => {
      const wasClosed = !useStore.getState().aiPanelVisible;
      if (wasClosed) setAIPanelVisible(true);
      globalThis.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('gonavi:ai:inject-prompt', { detail: { prompt } }),
        );
      }, wasClosed ? 350 : 0);
    },
    [setAIPanelVisible],
  );
  const handleOpenSyncWorkbench = useCallback(
    (handoff?: { taskId: string; stage?: 'endpoints' | 'mappings' | 'delivery' | 'trigger' | 'preflight' }) => {
      addTab({
        ...buildDataSyncWorkbenchTab({ entryMode: 'sync' }),
        dataSyncFocusTaskId: handoff?.taskId,
        dataSyncFocusStage: handoff?.stage || 'mappings',
        dataSyncFocusRequestId: `${Date.now()}`,
      });
    },
    [addTab],
  );
  const initialTasks = useMemo(() => buildDataSyncWorkbenchInitialTasks({
    tabId: tab.id, tabTitle: tab.title, connectionId: tab.connectionId, workbenchFamily,
    pastePrefill: tab.dataSyncPastePrefill, focusTaskId: tab.dataSyncFocusTaskId, connections,
  }), [
    connections, tab.connectionId, tab.dataSyncFocusTaskId, tab.dataSyncPastePrefill,
    tab.id, tab.title, workbenchFamily,
  ]);
  const gateway = useMemo(() => createWailsDataSyncWorkbenchGateway(), []);
  const connectionTree = useMemo<DataSyncConnectionTreeItem[]>(() => {
    const projectItem = (
      item: SidebarConnectionTagTreeItem,
    ): DataSyncConnectionTreeItem =>
      item.kind === 'connection'
        ? { kind: 'connection', connectionId: item.id }
        : {
            kind: 'group',
            id: item.id,
            name: item.tag.name,
            children: item.children.map(projectItem),
          };

    return buildSidebarConnectionTagTree(
      connections,
      connectionTags,
      sidebarRootOrder,
      rootSortMode,
      rootConnectionSortMode,
    ).map(projectItem);
  }, [connections, connectionTags, rootConnectionSortMode, rootSortMode, sidebarRootOrder]);

  return (
    <div
      data-data-sync-workbench="true"
      style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden' }}
    >
      <DataSyncWorkbenchShell
        initialTasks={initialTasks}
        gateway={gateway}
        connectionTree={connectionTree}
        locale={i18n?.language}
        onClose={embedded ? undefined : handleClose}
        workbenchTabId={tab.id}
        workbenchFamily={workbenchFamily}
        onOpenQueryTab={handleOpenQueryTab}
        onAskAi={handleAskAi}
        onOpenSyncWorkbench={handleOpenSyncWorkbench}
        focusTaskId={tab.dataSyncFocusTaskId}
        focusStage={tab.dataSyncFocusStage}
        focusRequestId={tab.dataSyncFocusRequestId}
      />
    </div>
  );
};

export default DataSyncWorkbench;
