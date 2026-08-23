import React, { useCallback, useMemo } from 'react';

import { useStore } from '../store';
import type { TabData } from '../types';
import { useOptionalI18n } from '../i18n/provider';
import {
  createDataSyncTaskDraft,
  createWailsDataSyncWorkbenchGateway,
  DataSyncWorkbenchShell,
} from './data-sync';
import type { DataSyncEntryMode } from './dataSyncEntryMode';

const resolveEntryMode = (tab: TabData): DataSyncEntryMode => {
  if (tab.dataSyncEntryMode === 'schemaCompare' || tab.dataSyncEntryMode === 'dataCompare') {
    return tab.dataSyncEntryMode;
  }
  return 'sync';
};

const DataSyncWorkbench: React.FC<{ tab: TabData }> = ({ tab }) => {
  const closeTab = useStore((state) => state.closeTab);
  const i18n = useOptionalI18n();
  const entryMode = resolveEntryMode(tab);
  const handleClose = useCallback(() => {
    closeTab(tab.id);
  }, [closeTab, tab.id]);
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

  return (
    <div
      data-data-sync-workbench="true"
      style={{ width: '100%', height: '100%', minWidth: 0, minHeight: 0, overflow: 'hidden' }}
    >
      <DataSyncWorkbenchShell
        initialTasks={[initialTask]}
        gateway={gateway}
        locale={i18n?.language}
        onClose={handleClose}
      />
    </div>
  );
};

export default DataSyncWorkbench;
