import React, { useCallback, useMemo } from 'react';

import { useStore } from '../store';
import type { TabData } from '../types';
import { useOptionalI18n } from '../i18n/provider';
import {
  createDataSyncTaskDraft,
  createWailsDataSyncWorkbenchGateway,
  DataSyncWorkbenchShell,
  type DataSyncConnectionTreeItem,
} from './data-sync';
import type { DataSyncEntryMode } from './dataSyncEntryMode';
import {
  buildSidebarConnectionTagTree,
  type SidebarConnectionTagTreeItem,
} from './sidebarV2Utils';
import { requestCloseWorkbenchTabs } from '../utils/workbenchTabCloseProtection';

const resolveEntryMode = (tab: TabData): DataSyncEntryMode => {
  if (tab.dataSyncEntryMode === 'schemaCompare' || tab.dataSyncEntryMode === 'dataCompare') {
    return tab.dataSyncEntryMode;
  }
  return 'sync';
};

const DataSyncWorkbench: React.FC<{ tab: TabData }> = ({ tab }) => {
  const connections = useStore((state) => state.connections);
  const connectionTags = useStore((state) => state.connectionTags);
  const sidebarRootOrder = useStore((state) => state.sidebarRootOrder);
  const rootSortMode = useStore((state) => state.rootSortMode);
  const rootConnectionSortMode = useStore((state) => state.rootConnectionSortMode);
  const i18n = useOptionalI18n();
  const entryMode = resolveEntryMode(tab);
  const handleClose = useCallback(() => {
    requestCloseWorkbenchTabs([tab.id]);
  }, [tab.id]);
  const initialTask = useMemo(
    () =>
      createDataSyncTaskDraft({
        id: `data-sync-local-${tab.id}`,
        kind: entryMode === 'sync' ? 'reconcile' : 'compare',
        compareMode:
          entryMode === 'schemaCompare'
            ? 'schema'
            : entryMode === 'dataCompare'
              ? 'data'
              : undefined,
        name: tab.title,
        sourceConnectionId: tab.connectionId,
      }),
    [entryMode, tab.connectionId, tab.id, tab.title],
  );
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
        initialTasks={[initialTask]}
        gateway={gateway}
        connectionTree={connectionTree}
        locale={i18n?.language}
        onClose={handleClose}
        workbenchTabId={tab.id}
      />
    </div>
  );
};

export default DataSyncWorkbench;
