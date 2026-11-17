import type { SavedConnection } from '../../types';
import type { DataSyncPastePrefill } from '../dataSyncEntryMode';
import {
  createDataSyncTableMapping,
  createDataSyncTaskDraft,
  type DataSyncTaskDefinition,
  type DataSyncWorkbenchFamily,
} from './model';

type BuildDataSyncWorkbenchInitialTasksInput = {
  tabId: string;
  tabTitle: string;
  connectionId: string;
  workbenchFamily: DataSyncWorkbenchFamily;
  pastePrefill?: DataSyncPastePrefill;
  focusTaskId?: string;
  connections: SavedConnection[];
};

export const buildDataSyncWorkbenchInitialTasks = ({
  tabId,
  tabTitle,
  connectionId,
  workbenchFamily,
  pastePrefill,
  focusTaskId,
  connections,
}: BuildDataSyncWorkbenchInitialTasksInput): DataSyncTaskDefinition[] => {
  if (workbenchFamily === 'compare') {
    return [];
  }
  if (!pastePrefill) {
    return [
      createDataSyncTaskDraft({
        id: `data-sync-local-${tabId}`,
        kind: 'reconcile',
        name: tabTitle,
        sourceConnectionId: connectionId,
      }),
    ];
  }

  const taskId = String(focusTaskId || `data-sync-paste-${tabId}`);
  const draft = createDataSyncTaskDraft({
    id: taskId,
    kind: 'migration',
    name: tabTitle,
    content: 'both',
    sourceConnectionId: pastePrefill.source.connectionId,
  });
  const endpoint = (prefill: typeof pastePrefill.source) => {
    const conn = connections.find(
      (candidate) => String(candidate.id) === String(prefill.connectionId),
    );
    return {
      connectionId: prefill.connectionId,
      connectionName: String(conn?.name || ''),
      type: String(conn?.config?.type || ''),
      database: String(prefill.database || ''),
      schema: String(prefill.schema || ''),
    };
  };
  draft.source = endpoint(pastePrefill.source);
  draft.target = endpoint(pastePrefill.target);
  if (pastePrefill.source.table) {
    const mapping = createDataSyncTableMapping(
      `${taskId}:mapping:1`,
      pastePrefill.source.table,
      pastePrefill.source.table,
    );
    mapping.targetMode = 'create_or_reuse';
    mapping.targetModeExplicit = true;
    draft.mappings = [mapping];
  }
  return [draft];
};
