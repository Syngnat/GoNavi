import type {
  DataSyncTaskDefinition,
  DataSyncRouteCapability,
  DataSyncWorkbenchFamily,
  DataSyncRunRecord,
  DataSyncRunEvent,
  DataSyncCompareResult,
} from '../model';
import type { DataSyncWorkbenchTextKey } from '../text';
import { decodeCompareResult } from '../wailsDto';
import type { SidebarDatabaseRefreshRequest } from '../../../utils/sidebarDatabaseRefresh';

export type WorkbenchView = 'tasks' | 'runs' | 'schedules' | 'cdc';

export type DataSyncConfirmation =
  | {
      kind: 'delete-task';
      task: DataSyncTaskDefinition;
      title: string;
      description: string;
      confirmText: string;
    }
  | {
      kind: 'delete-run';
      runId: string;
      title: string;
      description: string;
      confirmText: string;
    }
  | {
      kind: 'clear-terminal-runs';
      title: string;
      description: string;
      confirmText: string;
    }
  | {
      kind: 'reset-checkpoint';
      taskId: string;
      revision: number;
      title: string;
      description: string;
      confirmText: string;
    };

export const EMPTY_CAPABILITY: DataSyncRouteCapability = {
  level: 'unknown',
  canExecute: false,
  supportsAutoCreate: false,
  supportsMutations: false,
  supportsCdc: false,
};

const DATA_SYNC_WORKBENCH_VIEWS: readonly WorkbenchView[] = [
  'tasks',
  'runs',
  'schedules',
  'cdc',
];
const DATA_SYNC_COMPARE_WORKBENCH_VIEWS: readonly WorkbenchView[] = ['tasks', 'runs'];

export const workbenchViewKeys = (
  family?: DataSyncWorkbenchFamily,
): readonly WorkbenchView[] =>
  family === 'compare' ? DATA_SYNC_COMPARE_WORKBENCH_VIEWS : DATA_SYNC_WORKBENCH_VIEWS;
export const RUN_POLL_INTERVAL_MS = 3_000;
export const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
export const ACTIVE_RUN_STATUSES = new Set<DataSyncRunRecord['status']>([
  'queued',
  'running',
  'cancelling',
  'preflighting',
  'snapshotting',
  'catching_up',
  'streaming',
]);
const SIDEBAR_REFRESH_RUN_STATUSES = new Set<DataSyncRunRecord['status']>([
  'succeeded',
  'partial',
  'failed',
  'paused',
  'canceled',
  'cancelled',
  'interrupted',
]);

/**
 * The compare executor emits one Analyze payload per table mapping, each a
 * SyncAnalyzeResult JSON (`{success,message,tables:[...]}`) carrying a single
 * table — executeOneMapping runs once per mapping. Merge every payload in
 * chronological order so a multi-mapping compare lists all of its tables
 * instead of only the last one, keeping the newest entry per table when a run
 * was resumed and a mapping re-analyzed.
 */
export const extractCompareResult = (
  events: DataSyncRunEvent[],
): DataSyncCompareResult | null => {
  const byTable = new Map<string, DataSyncCompareResult['tables'][number]>();
  let latest: DataSyncCompareResult | null = null;
  for (const event of events) {
    const payload = event.payload;
    if (
      !payload ||
      typeof payload !== 'object' ||
      !Array.isArray((payload as { tables?: unknown }).tables)
    ) {
      continue;
    }
    try {
      const decoded = decodeCompareResult(payload, 'compareResult');
      latest = decoded;
      decoded.tables.forEach((table) => byTable.set(table.table, table));
    } catch {
      // Ignore malformed payloads and keep scanning the remaining events.
    }
  }
  if (!latest) return null;
  return { ...latest, tables: Array.from(byTable.values()) };
};

let localTaskSequence = 0;

export const nextLocalTaskId = (): string => {
  localTaskSequence += 1;
  return `data-sync-local-${Date.now()}-${localTaskSequence}`;
};

export const resolveDataSyncSidebarRefreshes = ({
  previousStatuses,
  runs,
  tasks,
}: {
  previousStatuses: ReadonlyMap<string, DataSyncRunRecord['status']>;
  runs: DataSyncRunRecord[];
  tasks: DataSyncTaskDefinition[];
}): Array<{ runId: string; request: SidebarDatabaseRefreshRequest }> => {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  return runs.flatMap((run) => {
    const previousStatus = previousStatuses.get(run.id);
    if (
      previousStatus === undefined
      || SIDEBAR_REFRESH_RUN_STATUSES.has(previousStatus)
      || !SIDEBAR_REFRESH_RUN_STATUSES.has(run.status)
      || !(Number(run.rowsWritten) > 0)
    ) {
      return [];
    }
    const target = tasksById.get(run.taskId)?.target;
    const connectionId = String(target?.connectionId || '').trim();
    const dbName = String(target?.database || '').trim();
    if (!connectionId || !dbName) return [];
    return [{
      runId: run.id,
      request: {
        connectionId,
        dbName,
        schemaName: String(target?.schema || '').trim() || undefined,
        reason: 'data-sync',
      },
    }];
  });
};

export const resolveWorkbenchChrome = (
  family: DataSyncWorkbenchFamily | undefined,
  task: DataSyncTaskDefinition | null,
): {
  title: DataSyncWorkbenchTextKey;
  titleShort: DataSyncWorkbenchTextKey;
  subtitle: DataSyncWorkbenchTextKey;
} => {
  const compareMode = task?.kind === 'compare' ? task.compareMode : undefined;
  if (family === 'compare' || (!family && task?.kind === 'compare')) {
    return {
      title:
        family === 'compare'
          ? 'workbench.title_compare'
          : compareMode === 'schema'
            ? 'workbench.title_schema_compare'
            : 'workbench.title_data_compare',
      titleShort:
        family === 'compare'
          ? 'workbench.title_compare_short'
          : compareMode === 'schema'
            ? 'workbench.title_schema_compare'
            : 'workbench.title_data_compare',
      subtitle:
        compareMode === 'schema'
          ? 'workbench.subtitle_schema_compare'
          : compareMode === 'data'
            ? 'workbench.subtitle_data_compare'
            : 'workbench.subtitle_compare',
    };
  }
  return {
    title: 'workbench.title',
    titleShort: 'workbench.title_short',
    subtitle: 'workbench.subtitle',
  };
};

/**
 * Keep tasks supplied by an entry point until persistence has a matching copy.
 * A persisted task wins for the same id so a stale in-memory draft cannot
 * overwrite the saved definition.
 */
export const mergeDataSyncInitialTasks = (
  initialTasks: DataSyncTaskDefinition[],
  loadedTasks: DataSyncTaskDefinition[],
  deletedTaskIds: ReadonlySet<string> = new Set(),
): DataSyncTaskDefinition[] => {
  const loadedIds = new Set(loadedTasks.map((task) => task.id));
  const missingInitialTasks = initialTasks.filter(
    (task) => !loadedIds.has(task.id) && !deletedTaskIds.has(task.id),
  );
  return [...missingInitialTasks, ...loadedTasks];
};
