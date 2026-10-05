import React, { useMemo, useRef, useState, useEffect } from 'react';
import { createDataSyncWorkbenchTranslate } from '../../text';
import {
  type DataSyncTaskDefinition,
  createDataSyncTaskDraft,
  type DataSyncTaskStage,
  type DataSyncPreflightSnapshot,
  type DataSyncApprovalGrant,
  type DataSyncApprovalChallenge,
  type DataSyncRouteCapability,
  type DataSyncRunRecord,
  type DataSyncRunPageSize,
  type DataSyncRunCursor,
  type DataSyncCdcSourceStatus,
  type DataSyncRunEvent,
  type DataSyncErrorRow,
  type DataSyncCheckpointSummary,
  type DataSyncCompareResult,
  type DataSyncRunPage,
  dataSyncTaskStages,
  isDataSyncPreflightCurrent,
  dataSyncTaskBelongsToFamily,
} from '../../model';
import { type DataSyncWorkbenchGateway, createStaticDataSyncWorkbenchGateway } from '../../gateway';
import {
  workbenchViewKeys,
  type WorkbenchView,
  EMPTY_CAPABILITY,
  ACTIVE_RUN_STATUSES,
  FOCUSABLE_SELECTOR,
} from '../dataSyncWorkbenchShellModel';
import { takeDataSyncHandoff } from '../../../../utils/dataSyncHandoff';
import { useDataSyncScheduleControl } from '../../useDataSyncScheduleControl';
import type { DataSyncWorkbenchShellProps } from '../../DataSyncWorkbenchShell';

export interface UseDataSyncWorkbenchStateInput {
  locale: DataSyncWorkbenchShellProps['locale'];
  initialTasks: Exclude<DataSyncWorkbenchShellProps['initialTasks'], undefined>;
  workbenchFamily: DataSyncWorkbenchShellProps['workbenchFamily'];
  gateway: DataSyncWorkbenchShellProps['gateway'];
  focusTaskId: DataSyncWorkbenchShellProps['focusTaskId'];
  focusRequestId: DataSyncWorkbenchShellProps['focusRequestId'];
  focusStage: DataSyncWorkbenchShellProps['focusStage'];
}

export const useDataSyncWorkbenchState = ({
  locale, initialTasks, workbenchFamily, gateway, focusTaskId, focusRequestId, focusStage,
}: UseDataSyncWorkbenchStateInput) => {
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

  // 调度控制依赖后文的运行/预检处理器；更早声明的回调经此引用读取当前实例
  const scheduleControlRef = useRef<ReturnType<typeof useDataSyncScheduleControl> | null>(null);
  return {
    t, taskListId, initialTasksRef, gatewayRef, viewKeys, activeView, setActiveView, tasks,
    setTasks, tasksRef, selectedTaskId, setSelectedTaskId, selectedTaskIdRef, activeStage,
    setActiveStage, focusMappingRef, setFocusMappingRef, search, setSearch, showKindSelector,
    setShowKindSelector, taskRailOpen, setTaskRailOpen, compactTaskRail, taskMenuOpen,
    setTaskMenuOpen, workbenchRef, taskRailToggleRef, taskListRef, editorColumnRef, taskMenuRef,
    dirtyTaskIds, setDirtyTaskIds, dirtyTaskIdsRef, deletedTaskIdsRef, handoffTaskRef,
    markTaskDirty, clearTaskDirty, saving, setSaving, savingRef, preflighting, setPreflighting,
    preflightingRef, preflightAbortRef, capabilityAbortRef, cdcAbortRef, deletingTaskRef,
    setPreflights, approvals, setApprovals, setApprovalChallenges, beginningApproval,
    setBeginningApproval, approving, setApproving, approvalError, setApprovalError,
    pendingPublicationTaskId, setPendingPublicationTaskId, operationError, setOperationError,
    bootstrapRevision, setBootstrapRevision, operationBusy, setOperationBusy, capability,
    setCapability, runs, setRuns, runPageIndex, runPageSize, setRunPageSize, runPageCursors,
    nextRunCursor, runTotal, selectedRunRequestEpochRef, runEventsRequestEpochRef, cdcSources,
    setCdcSources, selectedRunId, setSelectedRunId, runEvents, setRunEvents, errorRows,
    setErrorRows, checkpoint, setCheckpoint, compareResult, setCompareResult, runStatusesRef,
    clearTaskEvidence, applyRunPage, requestRunPage, requestRunPageForPoll, reloadFirstRunPage,
    selectedTask, selectedRunActive, selectedRunCompareMode, checkpointTask, selectedPreflight,
    selectedApproval, selectedApprovalChallenge, preflightStale, filteredTasks,
    closeTaskRailAndRestoreFocus, scheduleControlRef,
  };
};

export type DataSyncWorkbenchStateApi = ReturnType<typeof useDataSyncWorkbenchState>;
