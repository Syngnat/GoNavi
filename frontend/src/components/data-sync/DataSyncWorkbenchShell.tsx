import React, { useEffect, useMemo, useRef, useState } from 'react';
import { isWebRPCAbortError } from '../../utils/webRpc';

import {
  DataSyncCdcView,
  DataSyncRunHistory,
} from './DataSyncOperationalViews';
import { DataSyncPreflightPanel } from './DataSyncPreflightPanel';
import { DataSyncScheduleTable } from './DataSyncScheduleTable';
import { DataSyncTaskEditor } from './DataSyncEditorRouter';
import {
  DataSyncTaskKindSelector,
  DataSyncTaskList,
} from './DataSyncTaskList';
import {
  createStaticDataSyncWorkbenchGateway,
  type DataSyncWorkbenchGateway,
} from './gateway';
import {
  canStartDataSyncTask,
  createDataSyncTaskDraft,
  dataSyncTaskBelongsToFamily,
  dataSyncTaskStages,
  isDataSyncPreflightCurrent,
  reviseDataSyncTask,
  validateDataSyncTask,
  type DataSyncCdcSourceStatus,
  type DataSyncCheckpointSummary,
  type DataSyncConnectionTreeItem,
  type DataSyncApprovalChallenge,
  type DataSyncApprovalGrant,
  type DataSyncErrorRow,
  type DataSyncPreflightSnapshot,
  type DataSyncRouteCapability,
  type DataSyncRunRecord,
  type DataSyncRunCursor,
  type DataSyncRunPage,
  type DataSyncRunPageSize,
  type DataSyncRunEvent,
  type DataSyncCompareResult,
  type DataSyncCompareMode,
  type DataSyncTaskDefinition,
  type DataSyncTaskKind,
  type DataSyncTaskStage,
  type DataSyncWorkbenchFamily,
} from './model';
import { useDataSyncScheduleControl } from './useDataSyncScheduleControl';
import { createSyncTaskFromCompare } from './dataSyncCompareTaskFactory';
import {
  createDataSyncWorkbenchTranslate,
  dataSyncStageTextKey,
  dataSyncTaskKindTextKey,
  dataSyncValidationIssueText,
  type DataSyncWorkbenchLocale,
  type DataSyncWorkbenchTextKey,
} from './text';
import {
  buildCompareAiPrompt,
  buildCompareRepairSQL,
  tableHasCompareDiff,
} from './compareRepairSql';
import { decodeCompareResult } from './wailsDto';
import {
  dispatchSidebarDatabaseRefresh,
  type SidebarDatabaseRefreshRequest,
} from '../../utils/sidebarDatabaseRefresh';
import { setDataSyncHandoff, takeDataSyncHandoff } from '../../utils/dataSyncHandoff';
import { registerWorkbenchTabCloseGuard } from '../../utils/workbenchTabCloseProtection';
import Modal from '../common/ResizableDraggableModal';
import './DataSyncWorkbench.css';

type WorkbenchView = 'tasks' | 'runs' | 'schedules' | 'cdc';

type DataSyncConfirmation =
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

const EMPTY_CAPABILITY: DataSyncRouteCapability = {
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

const workbenchViewKeys = (
  family?: DataSyncWorkbenchFamily,
): readonly WorkbenchView[] =>
  family === 'compare' ? DATA_SYNC_COMPARE_WORKBENCH_VIEWS : DATA_SYNC_WORKBENCH_VIEWS;
const RUN_POLL_INTERVAL_MS = 3_000;
const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
const ACTIVE_RUN_STATUSES = new Set<DataSyncRunRecord['status']>([
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
const extractCompareResult = (
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

const nextLocalTaskId = (): string => {
  localTaskSequence += 1;
  return `data-sync-local-${Date.now()}-${localTaskSequence}`;
};

// Compare-task conversion lives in its own module; re-exported here so the
// workbench keeps a single import surface for existing call sites.
export {
  createSchemaSyncTaskFromCompare,
  createSyncTaskFromCompare,
} from './dataSyncCompareTaskFactory';

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

export type DataSyncWorkbenchShellProps = {
  initialTasks?: DataSyncTaskDefinition[];
  gateway?: DataSyncWorkbenchGateway;
  connectionTree?: DataSyncConnectionTreeItem[];
  locale?: DataSyncWorkbenchLocale | string;
  onClose?: () => void;
  workbenchTabId?: string;
  workbenchFamily?: DataSyncWorkbenchFamily;
  onOpenQueryTab?: (tab: {
    title: string;
    connectionId: string;
    dbName?: string;
    schemaName?: string;
    query: string;
  }) => void;
  onAskAi?: (prompt: string) => void;
  onOpenSyncWorkbench?: (handoff?: {
    taskId: string;
    stage?: DataSyncTaskStage;
  }) => void;
  focusTaskId?: string;
  focusStage?: DataSyncTaskStage;
  focusRequestId?: string;
};

const resolveWorkbenchChrome = (
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

export const DataSyncWorkbenchShell: React.FC<DataSyncWorkbenchShellProps> = ({
  initialTasks = [],
  gateway,
  connectionTree = [],
  locale,
  onClose,
  workbenchTabId,
  workbenchFamily,
  onOpenQueryTab,
  onAskAi,
  onOpenSyncWorkbench,
  focusTaskId,
  focusStage,
  focusRequestId,
}) => {
  const t = useMemo(() => createDataSyncWorkbenchTranslate(locale), [locale]);
  const taskListId = React.useId();
  const initialTasksRef = useRef<DataSyncTaskDefinition[]>();
  if (!initialTasksRef.current) {
    initialTasksRef.current =
      initialTasks.length > 0
        ? initialTasks
        : workbenchFamily === 'compare'
          ? []
          : [
              createDataSyncTaskDraft({
                id: 'data-sync-local-draft',
                kind: 'reconcile',
                name: t('task_kind.reconcile'),
              }),
            ];
  }
  const gatewayRef = useRef<DataSyncWorkbenchGateway>();
  if (!gatewayRef.current) {
    gatewayRef.current =
      gateway ||
      createStaticDataSyncWorkbenchGateway({ tasks: initialTasksRef.current });
  }

  const viewKeys = workbenchViewKeys(workbenchFamily);
  const [activeView, setActiveView] = useState<WorkbenchView>('tasks');
  const [tasks, setTasks] = useState<DataSyncTaskDefinition[]>(initialTasksRef.current);
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const [selectedTaskId, setSelectedTaskId] = useState(
    initialTasksRef.current[0]?.id || '',
  );
  const selectedTaskIdRef = useRef(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;
  const [activeStage, setActiveStage] = useState<DataSyncTaskStage>('endpoints');
  // 预检问题「定位」时携带的映射引用；由编辑器解析成具体行并回报清空。
  const [focusMappingRef, setFocusMappingRef] = useState('');
  const [search, setSearch] = useState('');
  const [showKindSelector, setShowKindSelector] = useState(false);
  const [taskRailOpen, setTaskRailOpen] = useState(false);
  const [compactTaskRail, setCompactTaskRail] = useState(false);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const workbenchRef = useRef<HTMLDivElement | null>(null);
  const taskRailToggleRef = useRef<HTMLButtonElement | null>(null);
  const taskListRef = useRef<HTMLElement | null>(null);
  const editorColumnRef = useRef<HTMLElement | null>(null);
  const taskMenuRef = useRef<HTMLDetailsElement | null>(null);
  // Entry points provide the initial clean baseline. Explicit edits and tasks
  // created inside this workbench call markTaskDirty below.
  const [dirtyTaskIds, setDirtyTaskIds] = useState<Set<string>>(() => new Set());
  const dirtyTaskIdsRef = useRef(dirtyTaskIds);
  const deletedTaskIdsRef = useRef(new Set<string>());
  const handoffTaskRef = useRef<DataSyncTaskDefinition | null>(null);
  const markTaskDirty = (taskId: string) => {
    const next = new Set(dirtyTaskIdsRef.current).add(taskId);
    dirtyTaskIdsRef.current = next;
    setDirtyTaskIds(next);
  };
  const clearTaskDirty = (taskId: string) => {
    if (!dirtyTaskIdsRef.current.has(taskId)) return;
    const next = new Set(dirtyTaskIdsRef.current);
    next.delete(taskId);
    dirtyTaskIdsRef.current = next;
    setDirtyTaskIds(next);
  };
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [preflighting, setPreflighting] = useState(false);
  const preflightingRef = useRef(false);
  const preflightAbortRef = useRef<AbortController | null>(null);
  const capabilityAbortRef = useRef<AbortController | null>(null);
  const cdcAbortRef = useRef<AbortController | null>(null);
  const deletingTaskRef = useRef(false);
  const [preflights, setPreflights] = useState<
    Record<string, DataSyncPreflightSnapshot | undefined>
  >({});
  const [approvals, setApprovals] = useState<
    Record<string, DataSyncApprovalGrant | undefined>
  >({});
  const [approvalChallenges, setApprovalChallenges] = useState<
    Record<string, DataSyncApprovalChallenge | undefined>
  >({});
  const [beginningApproval, setBeginningApproval] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  const [pendingPublicationTaskId, setPendingPublicationTaskId] = useState('');
  const [operationError, setOperationError] = useState('');
  const [bootstrapRevision, setBootstrapRevision] = useState(0);
  const [operationBusy, setOperationBusy] = useState('');
  const [capability, setCapability] = useState<DataSyncRouteCapability>(
    EMPTY_CAPABILITY,
  );
  const [runs, setRuns] = useState<DataSyncRunRecord[]>([]);
  const [runPageIndex, setRunPageIndex] = useState(0);
  const [runPageSize, setRunPageSize] = useState<DataSyncRunPageSize>(10);
  const [runPageCursors, setRunPageCursors] = useState<
    Array<DataSyncRunCursor | null>
  >([null]);
  const [nextRunCursor, setNextRunCursor] = useState<DataSyncRunCursor | null>(null);
  const [runTotal, setRunTotal] = useState(0);
  const runPageRequestEpochRef = useRef(0);
  const runPagePollEpochRef = useRef(0);
  const runPageNavigationInFlightRef = useRef(0);
  const selectedRunRequestEpochRef = useRef(0);
  const runEventsRequestEpochRef = useRef(0);
  const [cdcSources, setCdcSources] = useState<DataSyncCdcSourceStatus[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [runEvents, setRunEvents] = useState<DataSyncRunEvent[]>([]);
  const [errorRows, setErrorRows] = useState<DataSyncErrorRow[]>([]);
  const [checkpoint, setCheckpoint] = useState<DataSyncCheckpointSummary | null>(null);
  const [compareResult, setCompareResult] = useState<DataSyncCompareResult | null>(
    null,
  );
  const runStatusesRef = useRef<Map<string, DataSyncRunRecord['status']>>(new Map());

  // One-shot run evidence (preflight snapshot, approval grant, and challenge)
  // is keyed by task and dropped together whenever the persisted task changes
  // or a start consumes it.
  const clearTaskEvidence = (taskId: string) => {
    setPreflights((current) => {
      if (!current[taskId]) return current;
      const next = { ...current };
      delete next[taskId];
      return next;
    });
    setApprovals((current) => {
      if (!current[taskId]) return current;
      const next = { ...current };
      delete next[taskId];
      return next;
    });
    setApprovalChallenges((current) => {
      if (!current[taskId]) return current;
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  };

  useEffect(() => () => {
    preflightAbortRef.current?.abort();
    capabilityAbortRef.current?.abort();
    cdcAbortRef.current?.abort();
  }, []);

  const applyRunPage = (
    page: DataSyncRunPage,
    pageIndex: number,
    cursors: Array<DataSyncRunCursor | null>,
  ) => {
    const selectedRunStillVisible = Boolean(
      selectedRunId && page.runs.some((run) => run.id === selectedRunId),
    );
    if (!selectedRunStillVisible) {
      // A page change that removes the selected run invalidates any detail
      // request for the old page. A refresh that keeps it visible must leave
      // its already-loaded event timeline/error rows/checkpoint/compare result
      // untouched.
      selectedRunRequestEpochRef.current += 1;
      runEventsRequestEpochRef.current += 1;
      setRunEvents([]);
      setErrorRows([]);
      setCheckpoint(null);
      setCompareResult(null);
    }
    setRuns(page.runs);
    setRunPageIndex(pageIndex);
    setRunPageCursors(cursors);
    setNextRunCursor(page.nextCursor);
    setRunTotal(page.total);
    setSelectedRunId((current) =>
      page.runs.some((run) => run.id === current) ? current : '',
    );
  };

  // 用户发起的翻页请求。此处递增 runPageRequestEpochRef 会作废更早的用户请求，
  // 但背景轮询用的是独立的 runPagePollEpochRef，二者互不干扰。
  const requestRunPage = async (
    cursor: DataSyncRunCursor | null,
    pageSize: DataSyncRunPageSize,
  ): Promise<DataSyncRunPage | null> => {
    const requestEpoch = ++runPageRequestEpochRef.current;
    // 同时作废在途的轮询响应：否则一个早于本次翻页发出、晚于本次翻页返回的
    // 轮询结果，会带着旧的页码与游标把视图覆盖回上一页。
    runPagePollEpochRef.current += 1;
    runPageNavigationInFlightRef.current += 1;
    try {
      const page = await gatewayRef.current!.listRunsPage(cursor, pageSize);
      return requestEpoch === runPageRequestEpochRef.current ? page : null;
    } finally {
      runPageNavigationInFlightRef.current -= 1;
    }
  };

  // 背景轮询专用。它只让更早的轮询响应失效，绝不能作废用户正在进行的翻页：
  // 两者若共用同一个 epoch 计数器，轮询 tick 恰好落在翻页请求飞行途中时，
  // 翻页响应会被判为过期而丢弃，页面停在原地 —— 表现为「上一页点了没反应」。
  // 翻页进行中也跳过本轮轮询，避免用旧页的数据覆盖刚翻到的页。
  const requestRunPageForPoll = async (
    cursor: DataSyncRunCursor | null,
    pageSize: DataSyncRunPageSize,
  ): Promise<DataSyncRunPage | null> => {
    if (runPageNavigationInFlightRef.current > 0) return null;
    const pollEpoch = ++runPagePollEpochRef.current;
    const page = await gatewayRef.current!.listRunsPage(cursor, pageSize);
    return pollEpoch === runPagePollEpochRef.current ? page : null;
  };

  const reloadFirstRunPage = async () => {
    const page = await requestRunPage(null, runPageSize);
    if (page) applyRunPage(page, 0, [null]);
    return page;
  };

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || null;
  useEffect(() => {
    if (!selectedTask) return;
    const stages = dataSyncTaskStages(selectedTask.kind);
    if (!stages.includes(activeStage)) {
      setActiveStage(stages.includes('mappings') ? 'mappings' : stages[0]);
    }
  }, [activeStage, selectedTask]);
  const selectedRun = runs.find((run) => run.id === selectedRunId) || null;
  const selectedRunActive = Boolean(
    selectedRun && ACTIVE_RUN_STATUSES.has(selectedRun.status),
  );
  const selectedRunTask = selectedRun
    ? tasks.find((task) => task.id === selectedRun.taskId) || null
    : null;
  const selectedRunCompareMode =
    selectedRun?.compareMode ?? selectedRunTask?.compareMode;
  const checkpointTask = checkpoint
    ? tasks.find((task) => task.id === checkpoint.taskId) || null
    : null;
  const selectedPreflight = selectedTask
    ? preflights[selectedTask.id] || null
    : null;
  const selectedApproval = selectedTask ? approvals[selectedTask.id] || null : null;
  const selectedApprovalChallenge = selectedTask
    ? approvalChallenges[selectedTask.id] || null
    : null;
  const preflightStale = Boolean(
    selectedTask &&
      selectedPreflight &&
      !isDataSyncPreflightCurrent(selectedTask, selectedPreflight),
  );
  const filteredTasks = useMemo(() => {
    const visibleTasks = workbenchFamily
      ? tasks.filter(
          (task) =>
            dataSyncTaskBelongsToFamily(task, workbenchFamily) ||
            task.id === selectedTaskId,
        )
      : tasks;
    const query = search.trim().toLowerCase();
    if (!query) return visibleTasks;
    return visibleTasks.filter((task) =>
      [task.name, task.kind, task.source.connectionName, task.target.connectionName]
        .join(' ')
        .toLowerCase()
        .includes(query),
    );
  }, [search, selectedTaskId, tasks, workbenchFamily]);

  const closeTaskRailAndRestoreFocus = () => {
    setTaskRailOpen(false);
    const restoreFocus = () => taskRailToggleRef.current?.focus();
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(restoreFocus);
    } else {
      restoreFocus();
    }
  };

  useEffect(() => {
    const workbench = workbenchRef.current;
    if (!workbench || typeof globalThis.ResizeObserver !== 'function') {
      return undefined;
    }
    const updateLayout = (width: number) => {
      const compact = width <= 860;
      setCompactTaskRail(compact);
      if (!compact) setTaskRailOpen(false);
    };
    updateLayout(workbench.getBoundingClientRect().width);
    const observer = new globalThis.ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) updateLayout(entry.contentRect.width);
    });
    observer.observe(workbench);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!compactTaskRail || !taskRailOpen || typeof document === 'undefined') {
      return undefined;
    }
    const taskList = taskListRef.current;
    const editor = editorColumnRef.current;
    const editorWasInert = editor?.hasAttribute('inert') ?? false;
    editor?.setAttribute('inert', '');

    const focusFirstControl = () => {
      taskList
        ?.querySelector<HTMLInputElement>('.gn-data-sync-search input')
        ?.focus();
    };
    const frame =
      typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame(focusFirstControl)
        : undefined;
    if (frame === undefined) focusFirstControl();

    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeTaskRailAndRestoreFocus();
        return;
      }
      if (event.key !== 'Tab' || !taskList) return;
      const focusable = Array.from(
        taskList.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !taskList.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !taskList.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keepFocusInside);
    return () => {
      if (frame !== undefined && typeof globalThis.cancelAnimationFrame === 'function') {
        globalThis.cancelAnimationFrame(frame);
      }
      document.removeEventListener('keydown', keepFocusInside);
      if (!editorWasInert) editor?.removeAttribute('inert');
    };
  }, [compactTaskRail, taskRailOpen]);

  useEffect(() => {
    setTaskMenuOpen(false);
  }, [activeView, selectedTaskId]);

  useEffect(() => {
    if (!viewKeys.includes(activeView)) {
      setActiveView('tasks');
    }
  }, [activeView, viewKeys]);

  useEffect(() => {
    if (!taskMenuOpen || typeof document === 'undefined') return undefined;
    const closeTaskMenu = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (
        event instanceof MouseEvent &&
        taskMenuRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      if (event instanceof KeyboardEvent) {
        event.preventDefault();
        taskMenuRef.current?.querySelector<HTMLElement>('summary')?.focus();
      }
      setTaskMenuOpen(false);
    };
    document.addEventListener('mousedown', closeTaskMenu);
    document.addEventListener('keydown', closeTaskMenu);
    return () => {
      document.removeEventListener('mousedown', closeTaskMenu);
      document.removeEventListener('keydown', closeTaskMenu);
    };
  }, [taskMenuOpen]);

  useEffect(() => {
    if (!focusTaskId && !focusRequestId) return;
    const handoff = takeDataSyncHandoff();
    const handed = handoff?.task;
    if (handed) {
      handoffTaskRef.current = handed;
      setTasks((current) => {
        const others = current.filter((task) => task.id !== handed.id);
        return [handed, ...others];
      });
    }
    const targetId = handed?.id || focusTaskId;
    if (!targetId) return;
    const targetKind =
      handed?.kind ||
      tasksRef.current.find((task) => task.id === targetId)?.kind ||
      'migration';
    const stages = dataSyncTaskStages(targetKind);
    const requestedStage = focusStage || handoff?.stage || 'mappings';
    setSelectedTaskId(targetId);
    setActiveStage(stages.includes(requestedStage) ? requestedStage : 'mappings');
    setShowKindSelector(false);
    setActiveView('tasks');
  }, [focusTaskId, focusStage, focusRequestId]);

  useEffect(() => {
    let active = true;
    const taskController = new AbortController();
    const cdcController = new AbortController();
    cdcAbortRef.current?.abort();
    cdcAbortRef.current = cdcController;
    void gatewayRef.current!
      .listTasks({ signal: taskController.signal })
      .then((loadedTasks) => {
        if (!active) return;
        const familyLoaded = workbenchFamily
          ? loadedTasks.filter((task) =>
              dataSyncTaskBelongsToFamily(task, workbenchFamily),
            )
          : loadedTasks;
        if (familyLoaded.length > 0 || handoffTaskRef.current) {
          const seededInitial = handoffTaskRef.current
            ? [handoffTaskRef.current, ...initialTasksRef.current!]
            : initialTasksRef.current!;
          const mergedTasks = mergeDataSyncInitialTasks(
            seededInitial,
            familyLoaded,
            deletedTaskIdsRef.current,
          );
          setTasks((current) => {
            const currentById = new Map(current.map((task) => [task.id, task]));
            return mergedTasks.map((task) =>
              dirtyTaskIdsRef.current.has(task.id)
                ? currentById.get(task.id) || task
                : task,
            );
          });
          setSelectedTaskId((current) =>
            mergedTasks.some((task) => task.id === current)
              ? current
              : mergedTasks[0]?.id || '',
          );
        }
        const runPageRequest = requestRunPage(null, 10);
        if (workbenchFamily !== 'compare') {
          // Schedule rows aggregate from this fresh task snapshot; the
          // schedule projection and per-task run history load inside the
          // schedule control. Only the compare workbench lacks a schedules
          // view, so any other family (including the default 'sync') must seed
          // it here — nothing else populates the list on first mount.
          void scheduleControl.ingestSnapshot(loadedTasks);
        }
        const pendingRequests:
          | readonly [Promise<DataSyncRunPage | null>]
          | readonly [
              Promise<DataSyncRunPage | null>,
              Promise<DataSyncCdcSourceStatus[]>,
            ] =
          workbenchFamily === 'compare'
            ? [runPageRequest]
            : [
                runPageRequest,
                gatewayRef.current!.listCdcSources({ signal: cdcController.signal }),
              ];
        return Promise.allSettled(pendingRequests);
      })
      .then((results) => {
        if (!active || !results) return;
        const [runPage, sources] = results;
        if (runPage.status === 'fulfilled' && runPage.value) {
          applyRunPage(runPage.value, 0, [null]);
        }
        if (sources?.status === 'fulfilled') {
          setCdcSources(sources.value);
        }
        const settledResults: ReadonlyArray<PromiseSettledResult<unknown>> = results;
        const rejected = settledResults.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (rejected && !isWebRPCAbortError(rejected.reason)) {
          setOperationError(
            rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason),
          );
        }
      })
      .catch((error) => {
        if (active && !isWebRPCAbortError(error)) {
          setOperationError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      active = false;
      taskController.abort();
      cdcController.abort();
      if (cdcAbortRef.current === cdcController) cdcAbortRef.current = null;
    };
  }, [bootstrapRevision]);

  useEffect(() => {
    if (!selectedTask) {
      setCapability(EMPTY_CAPABILITY);
      return undefined;
    }
    let active = true;
    const controller = new AbortController();
    capabilityAbortRef.current?.abort();
    capabilityAbortRef.current = controller;
    setCapability(EMPTY_CAPABILITY);
    void gatewayRef.current!
      .resolveCapability(selectedTask, { signal: controller.signal })
      .then((resolved) => {
        if (active) setCapability(resolved);
      })
      .catch((error) => {
        if (!active || isWebRPCAbortError(error)) return;
        setCapability(EMPTY_CAPABILITY);
        setOperationError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
      controller.abort();
      if (capabilityAbortRef.current === controller) capabilityAbortRef.current = null;
    };
  }, [
    selectedTask?.id,
    selectedTask?.kind,
    selectedTask?.source,
    selectedTask?.target,
    selectedTask?.incremental,
  ]);

  useEffect(() => {
    if (activeView !== 'runs') return undefined;
    const hasActiveRun = runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status));
    if (!hasActiveRun) return undefined;
    const timer = globalThis.setInterval(() => {
      void requestRunPageForPoll(runPageCursors[runPageIndex], runPageSize)
        .then((page) => {
          if (page) applyRunPage(page, runPageIndex, runPageCursors);
        })
        .catch((error) =>
          setOperationError(error instanceof Error ? error.message : String(error)),
        );
    }, RUN_POLL_INTERVAL_MS);
    return () => globalThis.clearInterval(timer);
  }, [activeView, runPageCursors, runPageIndex, runPageSize, runs, selectedRunId]);

  useEffect(() => {
    if (activeView !== 'runs' || !selectedRunId || !selectedRunActive) {
      return undefined;
    }
    let active = true;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const poll = async () => {
      const requestEpoch = ++runEventsRequestEpochRef.current;
      try {
        const loadedEvents = await gatewayRef.current!.listRunEvents(selectedRunId);
        if (!active || requestEpoch !== runEventsRequestEpochRef.current) return;
        setRunEvents(loadedEvents);
        setCompareResult(extractCompareResult(loadedEvents));
      } catch (error) {
        if (active && requestEpoch === runEventsRequestEpochRef.current) {
          setOperationError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (active) {
          timer = globalThis.setTimeout(poll, RUN_POLL_INTERVAL_MS);
        }
      }
    };
    timer = globalThis.setTimeout(poll, RUN_POLL_INTERVAL_MS);
    return () => {
      active = false;
      runEventsRequestEpochRef.current += 1;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [activeView, selectedRunId, selectedRunActive]);

  useEffect(() => {
    const previousStatuses = runStatusesRef.current;
    const refreshes = resolveDataSyncSidebarRefreshes({
      previousStatuses,
      runs,
      tasks,
    });
    refreshes.forEach(({ request }) => {
      dispatchSidebarDatabaseRefresh(request);
    });
    runStatusesRef.current = new Map(runs.map((run) => [run.id, run.status]));
  }, [runs, tasks]);

  const patchSelectedTask = (
    patch:
      | Partial<
          Omit<
            DataSyncTaskDefinition,
            'id' | 'schemaVersion' | 'revision' | 'editEpoch' | 'createdAt'
          >
        >
      | ((currentTask: DataSyncTaskDefinition) => Partial<
          Omit<
            DataSyncTaskDefinition,
            'id' | 'schemaVersion' | 'revision' | 'editEpoch' | 'createdAt'
          >
        >),
  ) => {
    const taskId = selectedTask?.id;
    if (!taskId) return;
    setTasks((current) => {
      const next = current.map((task) =>
        task.id === taskId
          ? reviseDataSyncTask(
              task,
              typeof patch === 'function' ? patch(task) : patch,
            )
          : task,
      );
      tasksRef.current = next;
      return next;
    });
    markTaskDirty(taskId);
    setApprovalError('');
    setApprovalChallenges((current) => {
      if (!current[taskId]) return current;
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  };

  const createTask = (kind: DataSyncTaskKind, compareMode?: DataSyncCompareMode) => {
    const task = createDataSyncTaskDraft({
      id: nextLocalTaskId(),
      kind,
      compareMode,
      name: t(dataSyncTaskKindTextKey({ kind, compareMode })),
    });
    deletedTaskIdsRef.current.delete(task.id);
    setTasks((current) => [...current, task]);
    setSelectedTaskId(task.id);
    markTaskDirty(task.id);
    setActiveStage('endpoints');
    setShowKindSelector(false);
    setActiveView('tasks');
  };

  const saveTask = async (
    taskToSave = selectedTask,
    expectedCurrentEditEpoch = taskToSave?.editEpoch,
    allowDuringPreflight = false,
  ) => {
    if (
      !taskToSave ||
      savingRef.current ||
      (preflightingRef.current && !allowDuringPreflight) ||
      deletingTaskRef.current
    ) {
      return null;
    }
    const submittedTaskId = taskToSave.id;
    savingRef.current = true;
    setSaving(true);
    setOperationError('');
    try {
      const saved = await gatewayRef.current!.saveTask(taskToSave);
      let refreshedPreflight: DataSyncPreflightSnapshot | null = null;
      let refreshError: unknown = null;
      if (saved.lifecycle === 'ready' || saved.lifecycle === 'enabled') {
        preflightAbortRef.current?.abort();
        const controller = new AbortController();
        preflightAbortRef.current = controller;
        try {
          // PutJob advances the persisted revision. Revalidate that exact
          // revision before exposing the run action; the old snapshot is no
          // longer sufficient evidence, even when the visible fields did not
          // change.
          refreshedPreflight = await gatewayRef.current!.preflightTask(saved, {
            signal: controller.signal,
          });
        } catch (error) {
          if (!isWebRPCAbortError(error)) refreshError = error;
        } finally {
          if (preflightAbortRef.current === controller) {
            preflightAbortRef.current = null;
          }
        }
      }
      const tombstoned =
        deletedTaskIdsRef.current.has(submittedTaskId) ||
        deletedTaskIdsRef.current.has(saved.id);
      if (tombstoned) return null;
      const latestTask = tasksRef.current.find(
        (task) => task.id === submittedTaskId || task.id === saved.id,
      );
      const editedDuringSave = Boolean(
        latestTask && latestTask.editEpoch !== expectedCurrentEditEpoch,
      );
      const resolvedTask =
        editedDuringSave && latestTask
          ? {
              ...latestTask,
              id: saved.id,
              schemaVersion: saved.schemaVersion,
              revision: saved.revision,
              createdAt: saved.createdAt,
            }
          : saved;
      setTasks((current) => {
        const next = current.flatMap((task) => {
          if (task.id === submittedTaskId) return [resolvedTask];
          if (task.id === saved.id) return [];
          return [task];
        });
        const resolved = next.some((task) => task.id === saved.id)
          ? next
          : [...next, resolvedTask];
        tasksRef.current = resolved;
        return resolved;
      });
      clearTaskEvidence(submittedTaskId);
      if (saved.id !== submittedTaskId) clearTaskEvidence(saved.id);
      setPreflights((current) => {
        const next = { ...current };
        delete next[submittedTaskId];
        delete next[saved.id];
        if (refreshedPreflight && !editedDuringSave) {
          next[saved.id] = refreshedPreflight;
        } else if (saved.id !== submittedTaskId) {
          const previous = current[submittedTaskId];
          if (previous) {
            next[saved.id] = {
              ...previous,
              taskId: saved.id,
              // A server-assigned identity can change the authoritative
              // definition hash. Keep the evidence visible, but stale.
              taskRevision:
                previous.taskRevision === saved.revision
                  ? previous.taskRevision - 1
                  : previous.taskRevision,
            };
          }
        }
        return next;
      });
      if (saved.id !== submittedTaskId) {
        setSelectedTaskId((current) =>
          current === submittedTaskId ? saved.id : current,
        );
      }
      setDirtyTaskIds((current) => {
        const next = new Set(current);
        next.delete(submittedTaskId);
        next.delete(saved.id);
        if (editedDuringSave) next.add(saved.id);
        dirtyTaskIdsRef.current = next;
        return next;
      });
      if (refreshError && !editedDuringSave) {
        setOperationError(
          `任务已保存，但保存后的预检失败：${
            refreshError instanceof Error ? refreshError.message : String(refreshError)
          }`,
        );
      }
      if (saved.trigger.mode !== 'manual') {
        // Persisted schedule rows derive from the saved task; re-aggregate so
        // the schedule list shows the authoritative lifecycle immediately.
        void scheduleControl.refresh();
      }
      return resolvedTask;
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!workbenchTabId) return undefined;
    return registerWorkbenchTabCloseGuard(workbenchTabId, {
      isDirty: () => dirtyTaskIdsRef.current.size > 0,
      save: async () => {
        const dirtyTaskIds = Array.from(dirtyTaskIdsRef.current);
        for (const taskId of dirtyTaskIds) {
          const task = tasks.find((item) => item.id === taskId);
          if (!task || !(await saveTask(task))) return false;
        }
        return dirtyTaskIdsRef.current.size === 0;
      },
      // Closing unmounts this workbench. The pending in-memory definitions
      // are intentionally discarded only after the user chose that action.
      discard: () => undefined,
    });
  }, [saveTask, tasks, workbenchTabId]);

  const runPreflight = async () => {
    if (
      !selectedTask ||
      preflightingRef.current ||
      savingRef.current ||
      deletingTaskRef.current
    ) {
      return;
    }
    preflightingRef.current = true;
    setPreflighting(true);
    setOperationError('');
    preflightAbortRef.current?.abort();
    const controller = new AbortController();
    preflightAbortRef.current = controller;
    try {
      const snapshot = await gatewayRef.current!.preflightTask(selectedTask, {
        signal: controller.signal,
      });
      setPreflights((current) => ({ ...current, [selectedTask.id]: snapshot }));
      setApprovals((current) => {
        const approval = current[selectedTask.id];
        if (!approval || approval.definitionHash === snapshot.definitionHash) return current;
        const next = { ...current };
        delete next[selectedTask.id];
        return next;
      });
      setApprovalChallenges((current) => {
        const challenge = current[selectedTask.id];
        if (!challenge || challenge.definitionHash === snapshot.definitionHash) {
          return current;
        }
        const next = { ...current };
        delete next[selectedTask.id];
        return next;
      });
      if (
        selectedTaskIdRef.current === selectedTask.id &&
        selectedTask.kind !== 'compare'
      ) {
        setActiveStage('preflight');
      }
    } catch (error) {
      if (isWebRPCAbortError(error)) return;
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      if (preflightAbortRef.current === controller) preflightAbortRef.current = null;
      preflightingRef.current = false;
      setPreflighting(false);
    }
  };

  const deleteTask = async (task: DataSyncTaskDefinition) => {
    if (
      deletingTaskRef.current ||
      savingRef.current ||
      preflightingRef.current
    ) {
      return;
    }
    deletingTaskRef.current = true;
    setOperationBusy('delete');
    setOperationError('');
    try {
      await gatewayRef.current!.deleteTask(task.id);
      deletedTaskIdsRef.current.add(task.id);
      setTasks((current) => {
        const next = current.filter((item) => item.id !== task.id);
        tasksRef.current = next;
        return next;
      });
      clearTaskDirty(task.id);
      clearTaskEvidence(task.id);
      setSelectedTaskId((current) => {
        if (current !== task.id) return current;
        const remaining = tasks.filter((item) => item.id !== task.id);
        return remaining[0]?.id || '';
      });
      // Deleted tasks must not linger as stale schedule rows.
      void scheduleControl.refresh();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      deletingTaskRef.current = false;
      setOperationBusy('');
    }
  };

  const launchStartedTask = async (
    taskToStart: DataSyncTaskDefinition,
    preflight: DataSyncPreflightSnapshot,
  ) => {
    const startedTaskId = taskToStart.id;
    const startedEditEpoch = taskToStart.editEpoch;
    setOperationBusy('start');
    setOperationError('');
    try {
      await gatewayRef.current!.startTask(taskToStart, preflight);
      // The backend may consume a production approval and persist a new job
      // revision before creating the run. Invalidate the one-shot evidence
      // immediately, then refresh the authoritative task before the run page
      // so a history-load failure cannot leave the editor on the old revision.
      clearTaskEvidence(startedTaskId);
      const refreshedTask = (await gatewayRef.current!.listTasks()).find(
        (task) => task.id === startedTaskId,
      );
      if (refreshedTask) {
        setTasks((current) => {
          const next = current.map((task) => {
            if (task.id !== refreshedTask.id) return task;
            if (task.editEpoch === startedEditEpoch) return refreshedTask;
            return {
              ...task,
              schemaVersion: refreshedTask.schemaVersion,
              revision: refreshedTask.revision,
              createdAt: refreshedTask.createdAt,
            };
          });
          tasksRef.current = next;
          return next;
        });
        clearTaskEvidence(refreshedTask.id);
      }
      const page = await reloadFirstRunPage();
      setActiveView('runs');
      const firstRunId = page?.runs[0]?.id;
      if (firstRunId) {
        const requestEpoch = ++selectedRunRequestEpochRef.current;
        const eventRequestEpoch = ++runEventsRequestEpochRef.current;
        setSelectedRunId(firstRunId);
        setRunEvents([]);
        setErrorRows([]);
        setCheckpoint(null);
        setCompareResult(null);
        void Promise.all([
          gatewayRef.current!.listErrorRows(firstRunId),
          gatewayRef.current!.getCheckpoint(startedTaskId),
          gatewayRef.current!.listRunEvents(firstRunId),
        ]).then(([rows, loadedCheckpoint, events]) => {
          if (requestEpoch !== selectedRunRequestEpochRef.current) return;
          if (eventRequestEpoch === runEventsRequestEpochRef.current) {
            setRunEvents(events);
            setCompareResult(extractCompareResult(events));
          }
          setErrorRows(rows);
          setCheckpoint(loadedCheckpoint);
        }).catch((error) => {
          if (requestEpoch === selectedRunRequestEpochRef.current) {
            setOperationError(error instanceof Error ? error.message : String(error));
          }
        });
      }
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setApprovals((current) => {
        const next = { ...current };
        delete next[startedTaskId];
        return next;
      });
      setOperationBusy('');
    }
  };

  const startTask = async () => {
    if (
      preflighting ||
      operationBusy === 'start' ||
      !selectedTask ||
      !selectedPreflight ||
      !capability.canExecute ||
      dirtyTaskIds.has(selectedTask.id) ||
      !canStartDataSyncTask(selectedTask, selectedPreflight, selectedApproval)
    ) {
      return;
    }
    await launchStartedTask(selectedTask, selectedPreflight);
  };

  const runCompare = async () => {
    if (
      !selectedTask ||
      selectedTask.kind !== 'compare' ||
      preflightingRef.current ||
      savingRef.current ||
      deletingTaskRef.current ||
      operationBusy === 'start'
    ) {
      return;
    }
    const blockers = validateDataSyncTask(selectedTask).filter(
      (issue) => issue.severity === 'blocker',
    );
    if (blockers.length > 0) return;

    const sourceTask = selectedTask;
    const candidate =
      sourceTask.lifecycle === 'draft'
        ? reviseDataSyncTask(sourceTask, { lifecycle: 'ready' })
        : sourceTask;
    preflightingRef.current = true;
    setPreflighting(true);
    setOperationError('');
    preflightAbortRef.current?.abort();
    const controller = new AbortController();
    preflightAbortRef.current = controller;
    try {
      const snapshot = await gatewayRef.current!.preflightTask(candidate, {
        signal: controller.signal,
      });
      const latestTask = tasksRef.current.find((task) => task.id === sourceTask.id);
      if (!latestTask || latestTask.editEpoch !== sourceTask.editEpoch) {
        setOperationError(t('workbench.definition_changed_retry'));
        return;
      }
      setPreflights((current) => ({ ...current, [sourceTask.id]: snapshot }));
      if (snapshot.status === 'blocked') {
        return;
      }
      let taskToStart = sourceTask;
      if (
        sourceTask.lifecycle === 'draft' ||
        dirtyTaskIdsRef.current.has(sourceTask.id)
      ) {
        const saved = await saveTask(candidate, sourceTask.editEpoch, true);
        if (!saved) return;
        taskToStart = saved;
      }
      const startPreflight =
        taskToStart.id === sourceTask.id &&
        isDataSyncPreflightCurrent(taskToStart, snapshot)
          ? snapshot
          : await gatewayRef.current!.preflightTask(taskToStart, {
              signal: controller.signal,
            });
      if (startPreflight.status === 'blocked') {
        setPreflights((current) => ({
          ...current,
          [taskToStart.id]: startPreflight,
        }));
        return;
      }
      if (
        !canStartDataSyncTask(taskToStart, startPreflight, selectedApproval)
      ) {
        setPreflights((current) => ({
          ...current,
          [taskToStart.id]: startPreflight,
        }));
        return;
      }
      await launchStartedTask(taskToStart, startPreflight);
    } catch (error) {
      if (isWebRPCAbortError(error)) return;
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      if (preflightAbortRef.current === controller) preflightAbortRef.current = null;
      preflightingRef.current = false;
      setPreflighting(false);
    }
  };

  const selectRun = async (runId: string, runHint?: DataSyncRunRecord) => {
    const requestEpoch = ++selectedRunRequestEpochRef.current;
    const eventRequestEpoch = ++runEventsRequestEpochRef.current;
    setSelectedRunId(runId);
    setRunEvents([]);
    setErrorRows([]);
    setCheckpoint(null);
    setCompareResult(null);
    const run = runs.find((item) => item.id === runId) || runHint;
    setOperationError('');
    try {
      const [rows, loadedCheckpoint, events] = await Promise.all([
        gatewayRef.current!.listErrorRows(runId),
        run ? gatewayRef.current!.getCheckpoint(run.taskId) : Promise.resolve(null),
        gatewayRef.current!.listRunEvents(runId),
      ]);
      if (requestEpoch !== selectedRunRequestEpochRef.current) return;
      if (eventRequestEpoch === runEventsRequestEpochRef.current) {
        setRunEvents(events);
      }
      setErrorRows(rows);
      setCheckpoint(loadedCheckpoint);
      setCompareResult(extractCompareResult(events));
    } catch (error) {
      if (requestEpoch !== selectedRunRequestEpochRef.current) return;
      if (eventRequestEpoch === runEventsRequestEpochRef.current) {
        setRunEvents([]);
      }
      setErrorRows([]);
      setCheckpoint(null);
      setCompareResult(null);
      setOperationError(error instanceof Error ? error.message : String(error));
    }
  };

  const openTaskPreflightStage = (taskId: string) => {
    setSelectedTaskId(taskId);
    setActiveView('tasks');
    setActiveStage('preflight');
  };

  const openRunFromSchedule = async (runId: string, taskId: string) => {
    setActiveView('runs');
    const page = await reloadFirstRunPage().catch(() => null);
    let runHint = page?.runs.find((run) => run.id === runId);
    if (!runHint) {
      // The run sits beyond the first page of the global history; pin it from
      // the task's own history so the detail view has the record.
      const taskRuns = await gatewayRef.current!.listRuns(taskId).catch(
        () => [] as DataSyncRunRecord[],
      );
      const run = taskRuns.find((item) => item.id === runId);
      if (run) {
        runHint = run;
        setRuns((current) =>
          current.some((item) => item.id === runId) ? current : [run, ...current],
        );
      }
    }
    await selectRun(runId, runHint || undefined);
  };

  const scheduleControl = useDataSyncScheduleControl({
    getGateway: () => gatewayRef.current!,
    t,
    getTasks: () => tasksRef.current,
    setTasks: (updater) =>
      setTasks((current) => {
        const next = updater(current);
        tasksRef.current = next;
        return next;
      }),
    isTaskDirty: (taskId) => dirtyTaskIdsRef.current.has(taskId),
    markTaskDirty,
    clearTaskDirty,
    clearTaskEvidence,
    setTaskPreflight: (taskId, snapshot) =>
      setPreflights((current) => ({ ...current, [taskId]: snapshot })),
    getApproval: (taskId) => approvals[taskId] || null,
    setCapability,
    openTaskPreflightStage,
    openRunFromSchedule,
    setOperationError,
    setOperationBusy,
  });

  const beginApproval = async () => {
    if (!selectedTask || !selectedPreflight || beginningApproval) return;
    setBeginningApproval(true);
    setApprovalError('');
    try {
      const challenge = await gatewayRef.current!.beginApproval(
        selectedTask,
        selectedPreflight,
      );
      setApprovalChallenges((current) => ({
        ...current,
        [selectedTask.id]: challenge,
      }));
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : String(error));
    } finally {
      setBeginningApproval(false);
    }
  };

  const approveTask = async () => {
    if (!selectedTask || !selectedPreflight || approving) return;
    const publicationPending = pendingPublicationTaskId === selectedTask.id;
    setApproving(true);
    setApprovalError('');
    try {
      const grant = await gatewayRef.current!.approveTask(
        selectedTask,
        selectedPreflight,
      );
      setApprovals((current) => ({ ...current, [selectedTask.id]: grant }));
      if (publicationPending) {
        const saved = await saveTask(selectedTask);
        if (!saved) {
          // A one-time approval token may have been consumed by an uncertain
          // save attempt. Return to draft so a retry must preflight and approve
          // the exact definition again instead of reusing stale authority.
          setTasks((current) =>
            current.map((task) =>
              task.id === selectedTask.id
                ? reviseDataSyncTask(task, { lifecycle: 'draft' })
                : task,
            ),
          );
          markTaskDirty(selectedTask.id);
        }
        setPendingPublicationTaskId('');
      }
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : String(error));
    } finally {
      setApprovalChallenges((current) => {
        const next = { ...current };
        delete next[selectedTask.id];
        return next;
      });
      setApproving(false);
    }
  };

  const refreshRuns = async () => {
    setOperationBusy('refresh-runs');
    setOperationError('');
    try {
      const page = await requestRunPage(
        runPageCursors[runPageIndex],
        runPageSize,
      );
      if (page) applyRunPage(page, runPageIndex, runPageCursors);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationBusy('');
    }
  };

  const updateRun = async (
    action: 'cancel' | 'resume' | 'retry',
    runId: string,
  ) => {
    setOperationBusy(`${action}:${runId}`);
    setOperationError('');
    try {
      if (action === 'cancel') {
        await gatewayRef.current!.cancelRun(runId);
        setRuns((current) =>
          current.map((run) =>
            run.id === runId ? { ...run, status: 'cancelling' } : run,
          ),
        );
      } else {
        if (action === 'resume') {
          await gatewayRef.current!.resumeRun(runId);
        } else {
          await gatewayRef.current!.retryRun(runId);
        }
        await reloadFirstRunPage();
        // A queued retry/resume becomes the schedule row's latest run.
        void scheduleControl.refresh();
      }
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationBusy('');
    }
  };

  const discardErrorRow = async (errorRowId: string) => {
    setOperationBusy(`discard:${errorRowId}`);
    setOperationError('');
    try {
      await gatewayRef.current!.discardErrorRow(errorRowId);
      setErrorRows((current) =>
        current.map((row) =>
          row.id === errorRowId ? { ...row, status: 'discarded' } : row,
        ),
      );
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationBusy('');
    }
  };

  const retryErrorRow = async (errorRowId: string) => {
    if (!gatewayRef.current!.capabilities.errorRowRetry) return;
    const errorRow = errorRows.find((row) => row.id === errorRowId);
    if (!errorRow || !errorRow.retryable || errorRow.status !== 'pending') return;
    setOperationBusy(`retry-row:${errorRowId}`);
    setOperationError('');
    try {
      const retried = await gatewayRef.current!.retryErrorRow(errorRowId);
      setErrorRows((current) =>
        current.map((row) => (row.id === retried.id ? retried : row)),
      );
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      // A retry may consume a one-time production approval token. Clear the
      // visible grant even on an uncertain response so it cannot appear reusable.
      setApprovals((current) => {
        if (!current[errorRow.taskId]) return current;
        const next = { ...current };
        delete next[errorRow.taskId];
        return next;
      });
      setOperationBusy('');
    }
  };

  const resetCheckpointForTask = async (taskId: string, revision: number) => {
    if (operationBusy === 'reset-checkpoint') return;
    setOperationBusy('reset-checkpoint');
    setOperationError('');
    try {
      const saved = await gatewayRef.current!.resetCheckpoint(
        taskId,
        revision,
      );
      setTasks((current) =>
        current.map((task) => (task.id === saved.id ? saved : task)),
      );
      clearTaskEvidence(saved.id);
      setCheckpoint(null);
      cdcAbortRef.current?.abort();
      const controller = new AbortController();
      cdcAbortRef.current = controller;
      try {
        setCdcSources(await gatewayRef.current!.listCdcSources({
          signal: controller.signal,
        }));
      } finally {
        if (cdcAbortRef.current === controller) cdcAbortRef.current = null;
      }
    } catch (error) {
      if (isWebRPCAbortError(error)) return;
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationBusy('');
    }
  };

  const refreshCdc = async () => {
    setOperationBusy('refresh-cdc');
    cdcAbortRef.current?.abort();
    const controller = new AbortController();
    cdcAbortRef.current = controller;
    try {
      setCdcSources(await gatewayRef.current!.listCdcSources({
        signal: controller.signal,
      }));
    } catch (error) {
      if (isWebRPCAbortError(error)) return;
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      if (cdcAbortRef.current === controller) cdcAbortRef.current = null;
      setOperationBusy('');
    }
  };

  const locateIssue = (stage: DataSyncTaskStage, mappingRef?: string) => {
    setActiveView('tasks');
    setShowKindSelector(false);
    setActiveStage(stage);
    // 映射引用交给编辑器解析：本地校验给行 id，后端给稳定键，只有编辑器
    // 同时掌握两套标识与任务级 schema。
    setFocusMappingRef((mappingRef || '').trim());
  };

  const transitionLifecycle = (
    lifecycle: DataSyncTaskDefinition['lifecycle'],
  ) => {
    patchSelectedTask({ lifecycle });
    setActiveStage('preflight');
  };

  const publishTask = async () => {
    if (
      !selectedTask ||
      savingRef.current ||
      preflightingRef.current ||
      deletingTaskRef.current
    ) {
      return;
    }
    const candidate = reviseDataSyncTask(selectedTask, { lifecycle: 'ready' });
    preflightingRef.current = true;
    setPreflighting(true);
    setOperationError('');
    setApprovalError('');
    preflightAbortRef.current?.abort();
    const controller = new AbortController();
    preflightAbortRef.current = controller;
    try {
      const snapshot = await gatewayRef.current!.preflightTask(candidate, {
        signal: controller.signal,
      });
      const latestTask = tasksRef.current.find((task) => task.id === selectedTask.id);
      if (!latestTask || latestTask.editEpoch !== selectedTask.editEpoch) {
        setOperationError(t('workbench.definition_changed_retry'));
        return;
      }
      if (
        selectedTaskIdRef.current === selectedTask.id &&
        selectedTask.kind !== 'compare'
      ) {
        setActiveStage('preflight');
      }
      if (snapshot.status === 'blocked') {
        // Keep the editor on the persisted draft. A blocked publication must
        // never leave an unsaved ready state that the user cannot recover from.
        setPreflights((current) => ({
          ...current,
          [selectedTask.id]: {
            ...snapshot,
            taskRevision: selectedTask.revision,
            taskEditEpoch: selectedTask.editEpoch,
          },
        }));
        return;
      }
      if (snapshot.approvalRequired) {
        // The approval token is tied to this exact candidate definition. Keep
        // it selected until approval completes, then save it atomically.
        setTasks((current) => {
          const next = current.map((task) =>
            task.id === candidate.id ? candidate : task,
          );
          tasksRef.current = next;
          return next;
        });
        markTaskDirty(candidate.id);
        setPreflights((current) => ({ ...current, [candidate.id]: snapshot }));
        setApprovals((current) => {
          const next = { ...current };
          delete next[candidate.id];
          return next;
        });
        setApprovalChallenges((current) => {
          const next = { ...current };
          delete next[candidate.id];
          return next;
        });
        setPendingPublicationTaskId(candidate.id);
        return;
      }
      await saveTask(candidate, selectedTask.editEpoch, true);
    } catch (error) {
      if (isWebRPCAbortError(error)) return;
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      if (preflightAbortRef.current === controller) preflightAbortRef.current = null;
      preflightingRef.current = false;
      setPreflighting(false);
    }
  };

  const changeRunPage = async (direction: 'previous' | 'next') => {
    if (direction === 'previous' && runPageIndex === 0) return;
    if (direction === 'next' && !nextRunCursor) return;
    const cursor =
      direction === 'previous'
        ? runPageCursors[runPageIndex - 1]
        : nextRunCursor;
    const nextIndex = direction === 'previous' ? runPageIndex - 1 : runPageIndex + 1;
    const cursors =
      direction === 'previous'
        ? runPageCursors.slice(0, nextIndex + 1)
        : [...runPageCursors.slice(0, runPageIndex + 1), cursor];
    setOperationBusy('page-runs');
    setOperationError('');
    try {
      const page = await requestRunPage(cursor, runPageSize);
      if (page) applyRunPage(page, nextIndex, cursors);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationBusy('');
    }
  };

  const changeRunPageSize = async (pageSize: DataSyncRunPageSize) => {
    if (pageSize === runPageSize) return;
    setOperationBusy('page-runs');
    setOperationError('');
    setRunPageSize(pageSize);
    try {
      const page = await requestRunPage(null, pageSize);
      if (page) applyRunPage(page, 0, [null]);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationBusy('');
    }
  };

  const deleteRunHistory = async (runId: string) => {
    if (operationBusy === `delete-run:${runId}`) return;
    setOperationBusy(`delete-run:${runId}`);
    setOperationError('');
    try {
      await gatewayRef.current!.deleteRun(runId);
      let page = await requestRunPage(
        runPageCursors[runPageIndex],
        runPageSize,
      );
      if (!page) return;
      let pageIndex = runPageIndex;
      let cursors = runPageCursors;
      if (page.runs.length === 0 && pageIndex > 0) {
        pageIndex -= 1;
        cursors = runPageCursors.slice(0, pageIndex + 1);
        page = await requestRunPage(cursors[pageIndex], runPageSize);
        if (!page) return;
      }
      applyRunPage(page, pageIndex, cursors);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationBusy('');
    }
  };

  const clearTerminalRunHistory = async () => {
    if (operationBusy === 'clear-runs') return;
    setOperationBusy('clear-runs');
    setOperationError('');
    try {
      await gatewayRef.current!.clearTerminalRuns();
      const page = await requestRunPage(null, runPageSize);
      if (page) applyRunPage(page, 0, [null]);
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationBusy('');
    }
  };

  const executeConfirmation = async (confirmation: DataSyncConfirmation) => {
    switch (confirmation.kind) {
      case 'delete-task':
        await deleteTask(confirmation.task);
        break;
      case 'delete-run':
        await deleteRunHistory(confirmation.runId);
        break;
      case 'clear-terminal-runs':
        await clearTerminalRunHistory();
        break;
      case 'reset-checkpoint':
        await resetCheckpointForTask(
          confirmation.taskId,
          confirmation.revision,
        );
        break;
    }
  };

  const openConfirmation = (confirmation: DataSyncConfirmation) => {
    Modal.confirm({
      title: confirmation.title,
      content: confirmation.description,
      okText: confirmation.confirmText,
      cancelText: t('common.cancel'),
      centered: true,
      closable: true,
      maskClosable: true,
      okButtonProps: { danger: true, type: 'primary' },
      onOk: () => executeConfirmation(confirmation),
    });
  };

  const requestDeleteSelectedTask = () => {
    if (!selectedTask || operationBusy === 'delete' || saving || preflighting) return;
    openConfirmation({
      kind: 'delete-task',
      task: selectedTask,
      title: t('workbench.delete_confirm_title'),
      description: t('workbench.delete_confirm'),
      confirmText: t('workbench.delete'),
    });
  };

  const requestDeleteRunHistory = (runId: string) => {
    if (operationBusy === `delete-run:${runId}`) return;
    openConfirmation({
      kind: 'delete-run',
      runId,
      title: t('runs.delete_confirm_title'),
      description: t('runs.delete_confirm'),
      confirmText: t('runs.delete'),
    });
  };

  const requestClearTerminalRunHistory = () => {
    if (operationBusy === 'clear-runs') return;
    openConfirmation({
      kind: 'clear-terminal-runs',
      title: t('runs.clear_terminal_confirm_title'),
      description: t('runs.clear_terminal_confirm'),
      confirmText: t('runs.clear_terminal'),
    });
  };

  const requestResetCheckpoint = () => {
    if (!checkpoint || !checkpointTask || checkpointTask.lifecycle !== 'paused') {
      return;
    }
    openConfirmation({
      kind: 'reset-checkpoint',
      taskId: checkpoint.taskId,
      revision: checkpointTask.revision,
      title: t('checkpoint.reset_confirm_title'),
      description: t('checkpoint.reset_warning'),
      confirmText: t('checkpoint.reset'),
    });
  };

  const actionEnabled = Boolean(
    selectedTask &&
      selectedPreflight &&
      capability.canExecute &&
      !dirtyTaskIds.has(selectedTask.id) &&
      canStartDataSyncTask(selectedTask, selectedPreflight, selectedApproval),
  );
  const selectedApprovalCurrent = Boolean(
    selectedPreflight &&
      selectedApproval &&
      selectedApproval.definitionHash === selectedPreflight.definitionHash &&
      Date.parse(selectedApproval.expiresAt) > Date.now(),
  );
  const currentPreflightRequiresApproval = Boolean(
    selectedPreflight &&
      !preflightStale &&
      selectedPreflight.approvalRequired !== false &&
      !selectedPreflight.approvalSatisfied &&
      !selectedApprovalCurrent,
  );
  const runActionTitle = actionEnabled
    ? t('workbench.start')
    : !selectedTask
      ? t('workbench.preflight_before_run')
      : selectedTask.lifecycle !== 'ready' && selectedTask.lifecycle !== 'enabled'
        ? t('workbench.lifecycle_before_run')
        : dirtyTaskIds.has(selectedTask.id)
          ? !selectedPreflight || preflightStale
            ? t('workbench.preflight_then_save_before_run')
            : selectedPreflight.status === 'blocked'
              ? t('workbench.blocked_action')
              : currentPreflightRequiresApproval
              ? t('workbench.approval_before_run')
              : t('workbench.save_before_run')
          : !selectedPreflight || preflightStale
            ? t('workbench.preflight_before_run')
            : selectedPreflight.status === 'blocked'
              ? t('workbench.blocked_action')
              : !capability.canExecute
                ? t('workbench.capability_before_run')
                : currentPreflightRequiresApproval
                  ? t('workbench.approval_before_run')
                  : t('workbench.preflight_before_run');
  const saveApprovalReady = Boolean(
    selectedTask &&
      (selectedTask.lifecycle === 'draft' ||
        selectedTask.lifecycle === 'paused' ||
        selectedTask.lifecycle === 'archived' ||
        (selectedPreflight &&
          isDataSyncPreflightCurrent(selectedTask, selectedPreflight) &&
          selectedPreflight.status !== 'blocked' &&
          (selectedPreflight.approvalRequired === false ||
            Boolean(
              selectedApproval &&
                selectedApproval.definitionHash === selectedPreflight.definitionHash &&
                Date.parse(selectedApproval.expiresAt) > Date.now(),
            )))),
  );
  const taskStages = dataSyncTaskStages(selectedTask?.kind ?? 'reconcile');
  const activeStageIndex = taskStages.indexOf(activeStage);
  const nextStage = taskStages[activeStageIndex + 1];
  const previousStage = taskStages[activeStageIndex - 1];
  const selectedTaskIssues =
    selectedPreflight && !preflightStale
      ? selectedPreflight.issues
      : selectedTask
        ? validateDataSyncTask(selectedTask)
        : [];
  const relevantBlockerStage = taskStages
    .slice(0, activeStageIndex + 1)
    .find((stage) =>
      selectedTaskIssues.some(
        (issue) => issue.stage === stage && issue.severity === 'blocker',
      ),
    );
  const relevantBlocker = selectedTaskIssues.find(
    (issue) =>
      issue.stage === relevantBlockerStage && issue.severity === 'blocker',
  );
  const blockerInEarlierStage = Boolean(
    relevantBlockerStage && relevantBlockerStage !== activeStage,
  );
  const preflightNeedsRefresh = Boolean(
    activeStage === 'preflight' &&
      (!selectedPreflight || preflightStale || selectedPreflight.status === 'blocked'),
  );
  const compareStartEnabled = Boolean(
    selectedTask?.kind === 'compare' &&
      !relevantBlocker &&
      !saving &&
      !preflighting &&
      operationBusy !== 'start',
  );
  const actionHint = relevantBlocker
    ? dataSyncValidationIssueText(relevantBlocker, t)
    : preflightNeedsRefresh
      ? preflightStale
        ? t('preflight.stale')
        : t('preflight.not_run')
      : activeStage === 'preflight' && !actionEnabled
        ? runActionTitle
        : '';
  const actionHintTone = relevantBlocker
    ? relevantBlocker.code === 'mapping_required'
      ? 'warning'
      : 'danger'
    : 'neutral';
  const serviceUnavailableError = /window\.go\.app\.App\.[A-Za-z0-9_]+ is not a function/.test(
    operationError,
  );
  const workbenchChrome = resolveWorkbenchChrome(workbenchFamily, selectedTask);
  const handleGenerateRepairSql = () => {
    if (!selectedTask || !compareResult || !onOpenQueryTab) return;
    onOpenQueryTab({
      title: t('compare.repair_sql_tab'),
      connectionId: selectedTask.target.connectionId,
      dbName: selectedTask.target.database,
      schemaName: selectedTask.target.schema,
      query: buildCompareRepairSQL(compareResult, {
        dialect: selectedTask.target.type,
        schema: selectedTask.target.schema,
      }),
    });
  };
  const handleAskAiAboutDiffs = () => {
    if (!selectedTask || !compareResult || !onAskAi) return;
    onAskAi(
      buildCompareAiPrompt(compareResult, {
        dialect: selectedTask.target.type,
        sourceName:
          selectedTask.source.connectionName || selectedTask.source.connectionId,
        targetName:
          selectedTask.target.connectionName || selectedTask.target.connectionId,
      }),
    );
  };
  const handleSyncDiffs = async () => {
    if (!selectedTask || selectedTask.kind !== 'compare') return;
    const tables = (compareResult?.tables || [])
      .filter((summary) =>
        tableHasCompareDiff(
          summary,
          compareResult?.content || selectedTask.compareMode,
        ),
      )
      .map((summary) => summary.table);
    const task = createSyncTaskFromCompare({
      compareTask: selectedTask,
      id: nextLocalTaskId(),
      name: t('compare.sync_task_name', {
        name: selectedTask.name || t('task_kind.compare'),
      }),
      tables,
    });
    if (!task) return;
    try {
      const saved = await gatewayRef.current!.saveTask(task);
      const requestId = `handoff-${Date.now()}`;
      setDataSyncHandoff({
        task: saved,
        stage: 'mappings',
        requestId,
      });
      onOpenSyncWorkbench?.({ taskId: saved.id, stage: 'mappings' });
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div
      ref={workbenchRef}
      className="gn-data-sync-workbench"
      data-data-sync-workbench-shell="true"
      data-workbench-family={workbenchFamily || ''}
    >
      <header className="gn-data-sync-workbench__header">
        <div className="gn-data-sync-workbench__identity">
          <strong>
            <span className="gn-data-sync-workbench__title-full">
              {t(workbenchChrome.title)}
            </span>
            <span className="gn-data-sync-workbench__title-short">
              {t(workbenchChrome.titleShort)}
            </span>
          </strong>
          <span className="gn-data-sync-workbench__subtitle">
            {t(workbenchChrome.subtitle)}
          </span>
        </div>
        <nav className="gn-data-sync-global-nav" aria-label={t('workbench.view_navigation')}>
          {viewKeys.map((view) => (
            <button
              key={view}
              type="button"
              data-active={activeView === view ? 'true' : 'false'}
              aria-current={activeView === view ? 'page' : undefined}
              onClick={() => {
                setActiveView(view);
                setTaskRailOpen(false);
                // Schedule rows live in the schedule control, not in this
                // component's state: entering the view must pull a fresh
                // snapshot so the list can never render a stale or empty set.
                if (view === 'schedules') void scheduleControl.refresh();
              }}
            >
              {t(`nav.${view}`)}
            </button>
          ))}
        </nav>
        <div className="gn-data-sync-workbench__header-actions">
          {activeView === 'tasks' ? (
            <button
              ref={taskRailToggleRef}
              type="button"
              className="gn-data-sync-button gn-data-sync-header-action gn-data-sync-task-rail-toggle"
              aria-controls={taskListId}
              aria-expanded={taskRailOpen}
              aria-label={t('workbench.task_list_toggle')}
              title={t('workbench.task_list_toggle')}
              onClick={() => setTaskRailOpen((open) => !open)}
            >
              <span
                className="gn-data-sync-header-action__icon"
                aria-hidden="true"
              >
                ☷
              </span>
              <span className="gn-data-sync-header-action__label">
                {t('workbench.task_list_toggle')}
              </span>
            </button>
          ) : null}
          {activeView !== 'tasks' || compactTaskRail ? (
            <button
              type="button"
              className="gn-data-sync-button gn-data-sync-header-action"
              aria-label={t('workbench.new_task')}
              title={t('workbench.new_task')}
              onClick={() => {
                setActiveView('tasks');
                setShowKindSelector(true);
                setTaskRailOpen(false);
              }}
            >
              <span
                className="gn-data-sync-header-action__icon"
                aria-hidden="true"
              >
                ＋
              </span>
              <span className="gn-data-sync-header-action__label">
                {t('workbench.new_task')}
              </span>
            </button>
          ) : null}
          {onClose ? (
            <button
              type="button"
              className="gn-data-sync-icon-button"
              aria-label={t('workbench.close')}
              title={t('workbench.close')}
              onClick={onClose}
            >
              ×
            </button>
          ) : null}
        </div>
      </header>

      {operationError ? (
        <div className="gn-data-sync-workbench-error" role="alert">
          <div className="gn-data-sync-workbench-error__body">
            <span className="gn-data-sync-workbench-error__message">
              <span title={operationError}>
              {serviceUnavailableError
                ? t('workbench.service_unavailable')
                : operationError}
              </span>
            </span>
            {serviceUnavailableError ? (
              <details className="gn-data-sync-workbench-error__details">
                <summary>{t('common.details')}</summary>
                <code>{operationError}</code>
              </details>
            ) : null}
          </div>
          <div className="gn-data-sync-workbench-error__actions">
            {serviceUnavailableError ? (
              <button
                type="button"
                className="gn-data-sync-link-button"
                onClick={() => {
                  setOperationError('');
                  setBootstrapRevision((revision) => revision + 1);
                }}
              >
                {t('common.retry')}
              </button>
            ) : null}
            <button
              type="button"
              className="gn-data-sync-link-button"
              onClick={() => setOperationError('')}
            >
              {t('common.dismiss')}
            </button>
          </div>
        </div>
      ) : null}

      {activeView === 'tasks' ? (
        <div
          className="gn-data-sync-workspace-grid"
          data-task-rail-open={taskRailOpen ? 'true' : 'false'}
          onMouseDown={(event) => {
            if (taskRailOpen && event.target === event.currentTarget) {
              closeTaskRailAndRestoreFocus();
            }
          }}
        >
          <DataSyncTaskList
            id={taskListId}
            containerRef={taskListRef}
            tasks={filteredTasks}
            selectedTaskId={selectedTaskId}
            search={search}
            t={t}
            onSearchChange={setSearch}
            onSelectTask={(taskId) => {
              setSelectedTaskId(taskId);
              setShowKindSelector(false);
              closeTaskRailAndRestoreFocus();
            }}
            onNewTask={() => {
              setShowKindSelector(true);
              closeTaskRailAndRestoreFocus();
            }}
            // 面板头部以删除当前任务取代原先的「收起」：宽屏下任务栏本就
            // 常驻，「收起」点了没有任何视觉变化，看起来像按钮坏了。
            onDeleteTask={
              selectedTask && !showKindSelector
                ? requestDeleteSelectedTask
                : undefined
            }
            deleteDisabled={
              operationBusy === 'delete' || saving || preflighting
            }
            deleting={operationBusy === 'delete'}
          />
          <main ref={editorColumnRef} className="gn-data-sync-editor-column">
            {showKindSelector || !selectedTask ? (
              <DataSyncTaskKindSelector
                t={t}
                family={workbenchFamily}
                onSelect={createTask}
              />
            ) : (
              <>
                <DataSyncTaskEditor
                  task={selectedTask}
                  gateway={gatewayRef.current!}
                  connectionTree={connectionTree}
                  capability={capability}
                  activeStage={activeStage}
                  preflight={selectedPreflight}
                  preflightStale={preflightStale}
                  focusMappingRef={focusMappingRef}
                  onMappingLocated={() => setFocusMappingRef('')}
                  preflightContent={(
                    <DataSyncPreflightPanel
                      snapshot={selectedPreflight}
                      currentRevision={selectedTask.revision}
                      stale={preflightStale}
                      running={preflighting}
                      t={t}
                      onLocateIssue={locateIssue}
                      approval={selectedApproval}
                      approvalChallenge={selectedApprovalChallenge}
                      beginningApproval={beginningApproval}
                      approving={approving}
                      approvalError={approvalError}
                      onBeginApproval={() => void beginApproval()}
                      onApprove={() => void approveTask()}
                      embedded
                    />
                  )}
                  t={t}
                  onStageChange={setActiveStage}
                  onPatch={patchSelectedTask}
                />
                <footer className="gn-data-sync-action-bar">
                  {actionHint ? (
                    <div
                      className="gn-data-sync-action-context"
                      data-has-hint="true"
                      data-tone={actionHintTone}
                    >
                      <span
                        className="gn-data-sync-action-hint"
                        role="status"
                        title={actionHint}
                        data-tone={actionHintTone}
                        data-issue-code={relevantBlocker?.code}
                      >
                        {actionHint}
                      </span>
                    </div>
                  ) : null}
                  <span className="gn-data-sync-action-bar__spacer" />
                  <details
                    ref={taskMenuRef}
                    className="gn-data-sync-task-menu"
                    open={taskMenuOpen}
                    onToggle={(event) => setTaskMenuOpen(event.currentTarget.open)}
                  >
                    <summary className="gn-data-sync-button">
                      {t('workbench.task_actions')}
                    </summary>
                    <div className="gn-data-sync-task-menu__panel" role="group">
                      {selectedTask.lifecycle === 'ready' &&
                      selectedTask.trigger.mode !== 'manual' ? (
                        <button
                          type="button"
                          onClick={() => {
                            setTaskMenuOpen(false);
                            transitionLifecycle('enabled');
                          }}
                        >
                          {t('lifecycle.enable_schedule')}
                        </button>
                      ) : null}
                      {selectedTask.lifecycle === 'enabled' ? (
                        <button
                          type="button"
                          onClick={() => {
                            setTaskMenuOpen(false);
                            transitionLifecycle('paused');
                          }}
                        >
                          {t('lifecycle.pause')}
                        </button>
                      ) : null}
                      {selectedTask.lifecycle === 'paused' ? (
                        <button
                          type="button"
                          onClick={() => {
                            setTaskMenuOpen(false);
                            transitionLifecycle('enabled');
                          }}
                        >
                          {t('lifecycle.resume_schedule')}
                        </button>
                      ) : null}
                      {selectedTask.lifecycle === 'archived' ? (
                        <button
                          type="button"
                          onClick={() => {
                            setTaskMenuOpen(false);
                            transitionLifecycle('draft');
                          }}
                        >
                          {t('lifecycle.restore')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="gn-data-sync-task-menu__danger"
                          onClick={() => {
                            setTaskMenuOpen(false);
                            transitionLifecycle('archived');
                          }}
                        >
                          {t('lifecycle.archive')}
                        </button>
                      )}
                      {selectedTask.lifecycle !== 'archived' ? (
                        <button
                          type="button"
                          className="gn-data-sync-task-menu__danger"
                          disabled={operationBusy === 'delete' || saving || preflighting}
                          onClick={() => {
                            setTaskMenuOpen(false);
                            requestDeleteSelectedTask();
                          }}
                        >
                          {operationBusy === 'delete'
                            ? t('workbench.deleting')
                            : t('workbench.delete')}
                        </button>
                      ) : null}
                      {selectedTask.kind !== 'compare' &&
                      (activeStage !== 'preflight' || !preflightNeedsRefresh) ? (
                        <button
                          type="button"
                          disabled={preflighting || saving}
                          onClick={() => {
                            setTaskMenuOpen(false);
                            void runPreflight();
                          }}
                        >
                          {preflighting
                            ? t('workbench.preflighting')
                            : t('workbench.run_preflight')}
                        </button>
                      ) : null}
                      {selectedTask.kind === 'compare' ? (
                        <button
                          type="button"
                          disabled={!compareStartEnabled}
                          onClick={() => {
                            setTaskMenuOpen(false);
                            void runCompare();
                          }}
                        >
                          {t('workbench.start_compare')}
                        </button>
                      ) : activeStage !== 'preflight' ? (
                        <button
                          type="button"
                          disabled={preflighting || !actionEnabled || operationBusy === 'start'}
                          title={runActionTitle}
                          onClick={() => {
                            setTaskMenuOpen(false);
                            void startTask();
                          }}
                        >
                          {t('workbench.start')}
                        </button>
                      ) : null}
                    </div>
                  </details>
                  <button
                    type="button"
                    className="gn-data-sync-button"
                    data-dirty={dirtyTaskIds.has(selectedTask.id) ? 'true' : 'false'}
                    title={
                      dirtyTaskIds.has(selectedTask.id)
                        ? t('workbench.unsaved')
                        : t('workbench.saved')
                    }
                    disabled={
                      saving ||
                      preflighting ||
                      (!dirtyTaskIds.has(selectedTask.id) &&
                        selectedTask.lifecycle !== 'draft') ||
                      !saveApprovalReady
                    }
                    onClick={() => {
                      if (selectedTask.lifecycle === 'draft') {
                        void publishTask();
                        return;
                      }
                      void saveTask();
                    }}
                  >
                    {saving ? t('workbench.saving') : t('workbench.save')}
                  </button>
                  {previousStage ? (
                    <button
                      type="button"
                      className="gn-data-sync-button"
                      onClick={() => setActiveStage(previousStage)}
                    >
                      {t('workbench.previous_step')}
                    </button>
                  ) : null}
                  {blockerInEarlierStage && relevantBlockerStage ? (
                    <button
                      type="button"
                      className="gn-data-sync-button gn-data-sync-button--primary"
                      title={actionHint}
                      onClick={() => setActiveStage(relevantBlockerStage)}
                    >
                      {t('workbench.return_to_stage', {
                        stage: t(
                          dataSyncStageTextKey(
                            relevantBlockerStage,
                            selectedTask.kind,
                            selectedTask.compareMode,
                          ),
                        ),
                      })}
                    </button>
                  ) : nextStage ? (
                      <button
                        type="button"
                        className="gn-data-sync-button gn-data-sync-button--primary"
                        disabled={Boolean(relevantBlocker)}
                        title={relevantBlocker ? actionHint : undefined}
                        onClick={() => setActiveStage(nextStage)}
                      >
                        {t('workbench.next_step', {
                          stage: t(
                            dataSyncStageTextKey(
                              nextStage,
                              selectedTask.kind,
                              selectedTask.compareMode,
                            ),
                          ),
                        })}
                      </button>
                  ) : selectedTask.kind === 'compare' ? (
                    <button
                      type="button"
                      className="gn-data-sync-button gn-data-sync-button--primary"
                      disabled={!compareStartEnabled}
                      title={relevantBlocker ? actionHint : undefined}
                      onClick={() => void runCompare()}
                    >
                      {preflighting || operationBusy === 'start'
                        ? t('workbench.preflighting')
                        : t('workbench.start_compare')}
                    </button>
                  ) : preflightNeedsRefresh ? (
                    <button
                      type="button"
                      className="gn-data-sync-button gn-data-sync-button--primary"
                      disabled={preflighting || saving}
                      onClick={() => void runPreflight()}
                    >
                      {preflighting
                        ? t('workbench.preflighting')
                        : t('workbench.run_preflight')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="gn-data-sync-button gn-data-sync-button--primary"
                      disabled={preflighting || !actionEnabled || operationBusy === 'start'}
                      title={runActionTitle}
                      onClick={() => void startTask()}
                    >
                      {t('workbench.start')}
                    </button>
                  )}
                </footer>
              </>
            )}
          </main>
        </div>
      ) : null}

      {activeView === 'runs' ? (
        <DataSyncRunHistory
          runs={runs}
          runPage={runPageIndex + 1}
          runPageSize={runPageSize}
          runTotal={runTotal}
          hasPreviousRunPage={runPageIndex > 0}
          hasNextRunPage={nextRunCursor !== null}
          selectedRunId={selectedRunId}
          selectedRunMessage={runs.find(
            (run) =>
              run.id === selectedRunId &&
              ['failed', 'partial', 'interrupted'].includes(run.status),
          )?.message}
          runEvents={runEvents}
          errorRows={errorRows}
          compareResult={compareResult}
          compareMode={selectedRunCompareMode}
          family={workbenchFamily}
          t={t}
          onSelectRun={(runId) => void selectRun(runId)}
          checkpoint={checkpoint}
          busyAction={operationBusy}
          onRefresh={() => void refreshRuns()}
          onPreviousRunPage={() => void changeRunPage('previous')}
          onNextRunPage={() => void changeRunPage('next')}
          onRunPageSizeChange={(pageSize) => void changeRunPageSize(pageSize)}
          onDeleteRun={requestDeleteRunHistory}
          onClearTerminalRuns={requestClearTerminalRunHistory}
          onCancel={(runId) => void updateRun('cancel', runId)}
          onResume={(runId) => void updateRun('resume', runId)}
          onRetry={(runId) => void updateRun('retry', runId)}
          onDiscardErrorRow={(errorRowId) => void discardErrorRow(errorRowId)}
          errorRowRetryAvailable={gatewayRef.current!.capabilities.errorRowRetry}
          onRetryErrorRow={(errorRowId) => void retryErrorRow(errorRowId)}
          checkpointResetEnabled={checkpointTask?.lifecycle === 'paused'}
          onResetCheckpoint={requestResetCheckpoint}
          onGenerateRepairSql={
            workbenchFamily === 'compare' && onOpenQueryTab
              ? handleGenerateRepairSql
              : undefined
          }
          onAskAiAboutDiffs={
            workbenchFamily === 'compare' && onAskAi
              ? handleAskAiAboutDiffs
              : undefined
          }
          onSyncDiffs={
            workbenchFamily === 'compare' ? () => void handleSyncDiffs() : undefined
          }
        />
      ) : null}
      {activeView === 'schedules' ? (
        <DataSyncScheduleTable
          schedules={scheduleControl.schedules}
          t={t}
          refreshing={operationBusy === 'refresh-schedules'}
          busyAction={operationBusy}
          onRefresh={() => void scheduleControl.refresh()}
          onToggle={scheduleControl.toggleSchedule}
          onRunNow={scheduleControl.runScheduleNow}
          onViewRun={(runId) => void scheduleControl.viewScheduleRun(runId)}
        />
      ) : null}
      {activeView === 'cdc' ? (
        <DataSyncCdcView
          sources={cdcSources}
          t={t}
          refreshing={operationBusy === 'refresh-cdc'}
          onRefresh={() => void refreshCdc()}
        />
      ) : null}
    </div>
  );
};
