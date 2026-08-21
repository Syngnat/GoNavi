import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DataSyncCdcView,
  DataSyncRunHistory,
  DataSyncScheduleView,
} from './DataSyncOperationalViews';
import { DataSyncPreflightPanel } from './DataSyncPreflightPanel';
import { DataSyncRouteBar } from './DataSyncRouteBar';
import { DataSyncTaskEditor } from './DataSyncTaskEditor';
import {
  DataSyncTaskKindSelector,
  DataSyncTaskList,
} from './DataSyncTaskList';
import {
  createStaticDataSyncWorkbenchGateway,
  type DataSyncWorkbenchGateway,
} from './gateway';
import {
  aggregateDataSyncScheduleSummaries,
  canStartDataSyncTask,
  createDataSyncTaskDraft,
  isDataSyncPreflightCurrent,
  reviseDataSyncTask,
  type DataSyncCdcSourceStatus,
  type DataSyncCheckpointSummary,
  type DataSyncApprovalChallenge,
  type DataSyncApprovalGrant,
  type DataSyncErrorRow,
  type DataSyncPreflightSnapshot,
  type DataSyncRouteCapability,
  type DataSyncRunRecord,
  type DataSyncScheduleSummary,
  type DataSyncTaskDefinition,
  type DataSyncTaskKind,
  type DataSyncTaskStage,
} from './model';
import {
  createDataSyncWorkbenchTranslate,
  type DataSyncWorkbenchLocale,
} from './text';
import {
  dispatchSidebarDatabaseRefresh,
  type SidebarDatabaseRefreshRequest,
} from '../../utils/sidebarDatabaseRefresh';
import './DataSyncWorkbench.css';

type WorkbenchView = 'tasks' | 'runs' | 'schedules' | 'cdc';

type DataSyncOperationalState = {
  tasks: DataSyncTaskDefinition[];
  runs: DataSyncRunRecord[];
  scheduleRuns: DataSyncRunRecord[];
  schedules: DataSyncScheduleSummary[];
  cdcSources: DataSyncCdcSourceStatus[];
};

const EMPTY_CAPABILITY: DataSyncRouteCapability = {
  level: 'unknown',
  canExecute: false,
  supportsAutoCreate: false,
  supportsMutations: false,
  supportsCdc: false,
};

const viewKeys: WorkbenchView[] = ['tasks', 'runs', 'schedules', 'cdc'];
const SIDEBAR_REFRESH_RUN_STATUSES = new Set<DataSyncRunRecord['status']>([
  'succeeded',
  'partial',
  'failed',
  'paused',
  'canceled',
  'cancelled',
  'interrupted',
]);

let localTaskSequence = 0;

const nextLocalTaskId = (): string => {
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

export type DataSyncWorkbenchShellProps = {
  initialTasks?: DataSyncTaskDefinition[];
  gateway?: DataSyncWorkbenchGateway;
  locale?: DataSyncWorkbenchLocale | string;
  onClose?: () => void;
};

export const DataSyncWorkbenchShell: React.FC<DataSyncWorkbenchShellProps> = ({
  initialTasks = [],
  gateway,
  locale,
  onClose,
}) => {
  const t = useMemo(() => createDataSyncWorkbenchTranslate(locale), [locale]);
  const initialTasksRef = useRef<DataSyncTaskDefinition[]>();
  if (!initialTasksRef.current) {
    initialTasksRef.current =
      initialTasks.length > 0
        ? initialTasks
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

  const [activeView, setActiveView] = useState<WorkbenchView>('tasks');
  const [tasks, setTasks] = useState<DataSyncTaskDefinition[]>(initialTasksRef.current);
  const [selectedTaskId, setSelectedTaskId] = useState(
    initialTasksRef.current[0]?.id || '',
  );
  const [activeStage, setActiveStage] = useState<DataSyncTaskStage>('endpoints');
  const [search, setSearch] = useState('');
  const [showKindSelector, setShowKindSelector] = useState(false);
  const [dirtyTaskIds, setDirtyTaskIds] = useState<Set<string>>(
    () =>
      new Set(
        initialTasksRef.current!
          .filter((task) => task.id.startsWith('data-sync-local-'))
          .map((task) => task.id),
      ),
  );
  const [saving, setSaving] = useState(false);
  const [preflighting, setPreflighting] = useState(false);
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
  const [operationError, setOperationError] = useState('');
  const [operationBusy, setOperationBusy] = useState('');
  const [capability, setCapability] = useState<DataSyncRouteCapability>(
    EMPTY_CAPABILITY,
  );
  const [runs, setRuns] = useState<DataSyncRunRecord[]>([]);
  const [schedules, setSchedules] = useState<DataSyncScheduleSummary[]>([]);
  const [cdcSources, setCdcSources] = useState<DataSyncCdcSourceStatus[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [errorRows, setErrorRows] = useState<DataSyncErrorRow[]>([]);
  const [checkpoint, setCheckpoint] = useState<DataSyncCheckpointSummary | null>(null);
  const runStatusesRef = useRef<Map<string, DataSyncRunRecord['status']>>(new Map());
  const scheduleActionBusyRef = useRef(false);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || null;
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
    const query = search.trim().toLowerCase();
    if (!query) return tasks;
    return tasks.filter((task) =>
      [task.name, task.kind, task.source.connectionName, task.target.connectionName]
        .join(' ')
        .toLowerCase()
        .includes(query),
    );
  }, [search, tasks]);

  const scheduleImpactScope = (task: DataSyncTaskDefinition): string => {
    const endpoint = (
      value: DataSyncTaskDefinition['source'],
      fallback: string,
    ) => {
      const connection = value.connectionName || value.connectionId || fallback;
      const location = [value.database, value.schema].filter(Boolean).join(' / ');
      return location ? `${connection} / ${location}` : connection;
    };
    return [
      `${t('route.source')}: ${endpoint(task.source, t('route.pending_source'))}`,
      `${t('route.target')}: ${endpoint(task.target, t('route.pending_target'))}`,
    ].join('\n');
  };

  const loadOperationalState = useCallback(
    async (): Promise<DataSyncOperationalState> => {
      // Wails derives schedules and CDC sources from its cached task projection,
      // so refresh tasks first and use that same snapshot for every view.
      const loadedTasks = await gatewayRef.current!.listTasks();
      const scheduledTasks = loadedTasks.filter(
        (task) => task.trigger.mode !== 'manual',
      );
      const [loadedRuns, loadedSchedules, loadedSources, loadedScheduleRuns] = await Promise.all([
        gatewayRef.current!.listRuns(),
        gatewayRef.current!.listSchedules(),
        gatewayRef.current!.listCdcSources(),
        Promise.all(
          scheduledTasks.map((task) => gatewayRef.current!.listRuns(task.id)),
        ),
      ]);
      return {
        tasks: loadedTasks,
        runs: loadedRuns,
        scheduleRuns: loadedScheduleRuns.flat(),
        schedules: loadedSchedules,
        cdcSources: loadedSources,
      };
    },
    [],
  );

  const applyOperationalState = useCallback(
    (snapshot: DataSyncOperationalState, includeTasks = false) => {
      if (includeTasks && snapshot.tasks.length > 0) {
        setTasks(snapshot.tasks);
        setSelectedTaskId((current) =>
          snapshot.tasks.some((task) => task.id === current)
            ? current
            : snapshot.tasks[0]?.id || '',
        );
      }
      setRuns(snapshot.runs);
      setSchedules(
        aggregateDataSyncScheduleSummaries(
          snapshot.tasks,
          snapshot.scheduleRuns,
          snapshot.schedules,
        ),
      );
      setCdcSources(snapshot.cdcSources);
    },
    [],
  );

  const refreshScheduleState = useCallback(async () => {
    const snapshot = await loadOperationalState();
    applyOperationalState(snapshot);
    return snapshot.tasks;
  }, [applyOperationalState, loadOperationalState]);

  useEffect(() => {
    let active = true;
    void loadOperationalState()
      .then((snapshot) => {
        if (active) {
          applyOperationalState(snapshot, true);
        }
      })
      .catch((error) => {
        if (active) {
          setOperationError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      active = false;
    };
  }, [applyOperationalState, loadOperationalState]);

  useEffect(() => {
    if (!selectedTask) {
      setCapability(EMPTY_CAPABILITY);
      return undefined;
    }
    let active = true;
    setCapability(EMPTY_CAPABILITY);
    void gatewayRef.current!
      .resolveCapability(selectedTask)
      .then((resolved) => {
        if (active) setCapability(resolved);
      })
      .catch((error) => {
        if (!active) return;
        setCapability(EMPTY_CAPABILITY);
        setOperationError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [selectedTask?.id, selectedTask?.source, selectedTask?.target]);

  useEffect(() => {
    if (activeView !== 'runs') return undefined;
    const hasActiveRun = runs.some((run) =>
      ['queued', 'running', 'cancelling', 'preflighting', 'snapshotting', 'catching_up', 'streaming']
        .includes(run.status),
    );
    if (!hasActiveRun) return undefined;
    const timer = globalThis.setInterval(() => {
      void gatewayRef.current!
        .listRuns()
        .then(setRuns)
        .catch((error) =>
          setOperationError(error instanceof Error ? error.message : String(error)),
        );
    }, 3_000);
    return () => globalThis.clearInterval(timer);
  }, [activeView, runs]);

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
    patch: Partial<
      Omit<
        DataSyncTaskDefinition,
        'id' | 'schemaVersion' | 'revision' | 'createdAt'
      >
    >,
  ) => {
    const taskId = selectedTask?.id;
    if (!taskId) return;
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId ? reviseDataSyncTask(task, patch) : task,
      ),
    );
    setDirtyTaskIds((current) => new Set(current).add(taskId));
    setApprovalError('');
    setApprovalChallenges((current) => {
      if (!current[taskId]) return current;
      const next = { ...current };
      delete next[taskId];
      return next;
    });
  };

  const createTask = (kind: DataSyncTaskKind) => {
    const task = createDataSyncTaskDraft({
      id: nextLocalTaskId(),
      kind,
      name: t(`task_kind.${kind}`),
    });
    setTasks((current) => [...current, task]);
    setSelectedTaskId(task.id);
    setDirtyTaskIds((current) => new Set(current).add(task.id));
    setActiveStage('endpoints');
    setShowKindSelector(false);
    setActiveView('tasks');
  };

  const saveTask = async () => {
    if (!selectedTask || saving) return;
    const submittedTaskId = selectedTask.id;
    setSaving(true);
    setOperationError('');
    try {
      const saved = await gatewayRef.current!.saveTask(selectedTask);
      setTasks((current) => {
        const next = current.flatMap((task) => {
          if (task.id === submittedTaskId) return [saved];
          if (task.id === saved.id) return [];
          return [task];
        });
        return next.some((task) => task.id === saved.id) ? next : [...next, saved];
      });
      if (saved.id !== submittedTaskId) {
        setSelectedTaskId((current) =>
          current === submittedTaskId ? saved.id : current,
        );
        setPreflights((current) => {
          const previous = current[submittedTaskId];
          if (!previous) return current;
          const next = { ...current };
          delete next[submittedTaskId];
          next[saved.id] = {
            ...previous,
            taskId: saved.id,
            // A server-assigned identity can change the authoritative definition hash.
            // Keep the keyed evidence for display, but force a fresh preflight.
            taskRevision:
              previous.taskRevision === saved.revision
                ? previous.taskRevision - 1
                : previous.taskRevision,
          };
          return next;
        });
      }
      setDirtyTaskIds((current) => {
        const next = new Set(current);
        next.delete(submittedTaskId);
        next.delete(saved.id);
        return next;
      });
      setApprovals((current) => {
        const next = { ...current };
        delete next[submittedTaskId];
        delete next[saved.id];
        return next;
      });
      setApprovalChallenges((current) => {
        const next = { ...current };
        delete next[submittedTaskId];
        delete next[saved.id];
        return next;
      });
      if (saved.trigger.mode !== 'manual') {
        await refreshScheduleState();
      }
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const runPreflight = async () => {
    if (!selectedTask || preflighting) return;
    setPreflighting(true);
    setOperationError('');
    try {
      const snapshot = await gatewayRef.current!.preflightTask(selectedTask);
      setPreflights((current) => ({ ...current, [selectedTask.id]: snapshot }));
      setApprovals((current) => {
        const approval = current[selectedTask.id];
        if (
          !approval ||
          (approval.definitionHash === snapshot.definitionHash &&
            approval.taskRevision === snapshot.taskRevision)
        ) return current;
        const next = { ...current };
        delete next[selectedTask.id];
        return next;
      });
      setApprovalChallenges((current) => {
        const challenge = current[selectedTask.id];
        if (
          !challenge ||
          (challenge.definitionHash === snapshot.definitionHash &&
            challenge.taskRevision === snapshot.taskRevision)
        ) {
          return current;
        }
        const next = { ...current };
        delete next[selectedTask.id];
        return next;
      });
      setActiveStage('preflight');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreflighting(false);
    }
  };

  const startTask = async () => {
    if (
      !selectedTask ||
      !selectedPreflight ||
      !capability.canExecute ||
      dirtyTaskIds.has(selectedTask.id) ||
      !canStartDataSyncTask(selectedTask, selectedPreflight, selectedApproval)
    ) {
      return;
    }
    setOperationBusy('start');
    setOperationError('');
    try {
      const run = await gatewayRef.current!.startTask(
        selectedTask,
        selectedPreflight,
      );
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setActiveView('runs');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setApprovals((current) => {
        const next = { ...current };
        delete next[selectedTask.id];
        return next;
      });
      setOperationBusy('');
    }
  };

  const selectRun = async (runId: string, taskIdHint = '') => {
    setSelectedRunId(runId);
    setOperationError('');
    try {
      let run = runs.find((item) => item.id === runId);
      if (!run && taskIdHint) {
        const taskRuns = await gatewayRef.current!.listRuns(taskIdHint);
        run = taskRuns.find((item) => item.id === runId);
        if (run) {
          setRuns((current) => [run!, ...current.filter((item) => item.id !== runId)]);
        }
      }
      const [rows, loadedCheckpoint] = await Promise.all([
        gatewayRef.current!.listErrorRows(runId),
        run ? gatewayRef.current!.getCheckpoint(run.taskId) : Promise.resolve(null),
      ]);
      setErrorRows(rows);
      setCheckpoint(loadedCheckpoint);
    } catch (error) {
      setErrorRows([]);
      setCheckpoint(null);
      setOperationError(error instanceof Error ? error.message : String(error));
    }
  };

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
    setApproving(true);
    setApprovalError('');
    try {
      const grant = await gatewayRef.current!.approveTask(
        selectedTask,
        selectedPreflight,
      );
      setApprovals((current) => ({ ...current, [selectedTask.id]: grant }));
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
      // The global endpoint is capped. Keep the selected schedule run visible
      // by using its task-scoped history when the capped result omits it.
      let taskIdHint = selectedRunId
        ? runs.find((run) => run.id === selectedRunId)?.taskId ||
          schedules.find((schedule) => schedule.latestRun?.id === selectedRunId)
            ?.taskId ||
          ''
        : '';
      const refreshedRuns = await gatewayRef.current!.listRuns();
      const selectedFromGlobal = refreshedRuns.find((run) => run.id === selectedRunId);
      if (selectedFromGlobal) taskIdHint = selectedFromGlobal.taskId;
      let nextRuns = refreshedRuns;
      if (selectedRunId && !selectedFromGlobal && taskIdHint) {
        const taskRuns = await gatewayRef.current!.listRuns(taskIdHint);
        const selectedFromTask = taskRuns.find((run) => run.id === selectedRunId);
        if (selectedFromTask) {
          nextRuns = [
            selectedFromTask,
            ...refreshedRuns.filter((run) => run.id !== selectedFromTask.id),
          ];
        }
      }
      setRuns(nextRuns);
      if (selectedRunId) await selectRun(selectedRunId, taskIdHint);
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
        const run =
          action === 'resume'
            ? await gatewayRef.current!.resumeRun(runId)
            : await gatewayRef.current!.retryRun(runId);
        setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      }
      await refreshScheduleState();
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

  const resetCheckpoint = async () => {
    if (!checkpoint || !checkpointTask || checkpointTask.lifecycle !== 'paused') {
      return;
    }
    if (!globalThis.confirm(t('checkpoint.reset_warning'))) return;
    setOperationBusy('reset-checkpoint');
    setOperationError('');
    try {
      const saved = await gatewayRef.current!.resetCheckpoint(
        checkpoint.taskId,
        checkpointTask.revision,
      );
      setTasks((current) =>
        current.map((task) => (task.id === saved.id ? saved : task)),
      );
      setPreflights((current) => {
        if (!current[saved.id]) return current;
        const next = { ...current };
        delete next[saved.id];
        return next;
      });
      setApprovals((current) => {
        if (!current[saved.id]) return current;
        const next = { ...current };
        delete next[saved.id];
        return next;
      });
      setApprovalChallenges((current) => {
        if (!current[saved.id]) return current;
        const next = { ...current };
        delete next[saved.id];
        return next;
      });
      setCheckpoint(null);
      setCdcSources(await gatewayRef.current!.listCdcSources());
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationBusy('');
    }
  };

  const refreshSchedules = async () => {
    setOperationBusy('refresh-schedules');
    setOperationError('');
    try {
      await refreshScheduleState();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationBusy('');
    }
  };

  const replaceTaskState = (saved: DataSyncTaskDefinition) => {
    setTasks((current) =>
      current.map((task) => (task.id === saved.id ? saved : task)),
    );
    setDirtyTaskIds((current) => {
      const next = new Set(current);
      next.delete(saved.id);
      return next;
    });
    setPreflights((current) => {
      if (!current[saved.id]) return current;
      const next = { ...current };
      delete next[saved.id];
      return next;
    });
    setApprovals((current) => {
      if (!current[saved.id]) return current;
      const next = { ...current };
      delete next[saved.id];
      return next;
    });
    setApprovalChallenges((current) => {
      if (!current[saved.id]) return current;
      const next = { ...current };
      delete next[saved.id];
      return next;
    });
  };

  const showScheduleTaskPreflight = (
    task: DataSyncTaskDefinition,
    preflight: DataSyncPreflightSnapshot,
    resolvedCapability: DataSyncRouteCapability,
  ) => {
    setTasks((current) =>
      current.map((item) => (item.id === task.id ? task : item)),
    );
    setSelectedTaskId(task.id);
    setPreflights((current) => ({ ...current, [task.id]: preflight }));
    setApprovals((current) => {
      const approval = current[task.id];
      if (
        !approval ||
        (approval.definitionHash === preflight.definitionHash &&
          approval.taskRevision === preflight.taskRevision)
      ) {
        return current;
      }
      const next = { ...current };
      delete next[task.id];
      return next;
    });
    setApprovalChallenges((current) => {
      const challenge = current[task.id];
      if (
        !challenge ||
        (challenge.definitionHash === preflight.definitionHash &&
          challenge.taskRevision === preflight.taskRevision)
      ) {
        return current;
      }
      const next = { ...current };
      delete next[task.id];
      return next;
    });
    setCapability(resolvedCapability);
    setActiveView('tasks');
    setActiveStage('preflight');
  };

  const toggleSchedule = async (schedule: DataSyncScheduleSummary) => {
    if (scheduleActionBusyRef.current) return;
    scheduleActionBusyRef.current = true;
    const enabling = !schedule.enabled;
    const action = enabling ? 'enable' : 'disable';
    const confirmKey = enabling
      ? 'schedules.confirm_enable'
      : 'schedules.confirm_disable';
    setOperationBusy(`${action}:${schedule.taskId}`);
    setOperationError('');
    try {
      const latestTasks = await gatewayRef.current!.listTasks();
      const current = latestTasks.find((task) => task.id === schedule.taskId);
      if (!current) throw new Error(t('schedules.task_missing'));
      if (dirtyTaskIds.has(current.id)) {
        throw new Error(t('schedules.unsaved_edits', { task: current.name }));
      }
      if (!globalThis.confirm(t(confirmKey, {
        task: current.name,
        scope: scheduleImpactScope(current),
      }))) {
        return;
      }
      // Store.PutJob accepts the persisted revision and advances it itself.
      const next: DataSyncTaskDefinition = {
        ...current,
        lifecycle: enabling ? 'enabled' : 'paused',
      };
      if (enabling) {
        const [preflight, resolvedCapability] = await Promise.all([
          gatewayRef.current!.preflightTask(next),
          gatewayRef.current!.resolveCapability(next),
        ]);
        if (
          preflight.status === 'blocked' ||
          preflight.approvalRequired ||
          !resolvedCapability.canExecute
        ) {
          showScheduleTaskPreflight(next, preflight, resolvedCapability);
          setTasks((state) =>
            state.map((task) => (task.id === next.id ? next : task)),
          );
          setDirtyTaskIds((state) => new Set(state).add(next.id));
          setOperationError(
            t('schedules.preflight_required', { task: next.name }),
          );
          return;
        }
      }
      const saved = await gatewayRef.current!.saveTask(next);
      replaceTaskState(saved);
      await refreshScheduleState();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      scheduleActionBusyRef.current = false;
      setOperationBusy('');
    }
  };

  const runScheduleNow = async (schedule: DataSyncScheduleSummary) => {
    if (scheduleActionBusyRef.current) return;
    scheduleActionBusyRef.current = true;
    setOperationBusy(`run-now:${schedule.taskId}`);
    setOperationError('');
    try {
      const latestTasks = await gatewayRef.current!.listTasks();
      const task = latestTasks.find((item) => item.id === schedule.taskId);
      if (!task) throw new Error(t('schedules.task_missing'));
      if (dirtyTaskIds.has(task.id)) {
        throw new Error(t('schedules.unsaved_edits', { task: task.name }));
      }
      if (!globalThis.confirm(t('schedules.confirm_run_now', {
        task: task.name,
        scope: scheduleImpactScope(task),
      }))) {
        return;
      }
      const [preflight, resolvedCapability] = await Promise.all([
        gatewayRef.current!.preflightTask(task),
        gatewayRef.current!.resolveCapability(task),
      ]);
      showScheduleTaskPreflight(task, preflight, resolvedCapability);
      if (
        !resolvedCapability.canExecute ||
        !canStartDataSyncTask(task, preflight, approvals[task.id] || null)
      ) {
        setOperationError(t('schedules.preflight_required', { task: task.name }));
        return;
      }
      const run = await gatewayRef.current!.startTask(
        task,
        preflight,
      );
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      await refreshScheduleState();
      setSelectedRunId(run.id);
      setActiveView('runs');
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      scheduleActionBusyRef.current = false;
      setOperationBusy('');
    }
  };

  const viewScheduleRun = (runId: string) => {
    const taskId = schedules.find((schedule) => schedule.latestRun?.id === runId)?.taskId || '';
    setSelectedRunId(runId);
    setActiveView('runs');
    void selectRun(runId, taskId);
  };

  const refreshCdc = async () => {
    setOperationBusy('refresh-cdc');
    try {
      setCdcSources(await gatewayRef.current!.listCdcSources());
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error));
    } finally {
      setOperationBusy('');
    }
  };

  const locateIssue = (stage: DataSyncTaskStage) => {
    setActiveView('tasks');
    setShowKindSelector(false);
    setActiveStage(stage);
  };

  const transitionLifecycle = (
    lifecycle: DataSyncTaskDefinition['lifecycle'],
  ) => {
    patchSelectedTask({ lifecycle });
    setActiveStage('preflight');
  };

  const actionEnabled = Boolean(
    selectedTask &&
      selectedPreflight &&
      capability.canExecute &&
      !dirtyTaskIds.has(selectedTask.id) &&
      canStartDataSyncTask(selectedTask, selectedPreflight, selectedApproval),
  );
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
                selectedApproval.taskRevision === selectedPreflight.taskRevision &&
                Date.parse(selectedApproval.expiresAt) > Date.now(),
            )))),
  );

  return (
    <div
      className="gn-data-sync-workbench"
      data-data-sync-workbench-shell="true"
    >
      <header className="gn-data-sync-workbench__header">
        <div className="gn-data-sync-workbench__identity">
          <strong>{t('workbench.title')}</strong>
          <span>{t('workbench.subtitle')}</span>
        </div>
        <nav className="gn-data-sync-global-nav" aria-label={t('workbench.title')}>
          {viewKeys.map((view) => (
            <button
              key={view}
              type="button"
              data-active={activeView === view ? 'true' : 'false'}
              onClick={() => setActiveView(view)}
            >
              {t(`nav.${view}`)}
            </button>
          ))}
        </nav>
        <div className="gn-data-sync-workbench__header-actions">
          <button
            type="button"
            className="gn-data-sync-button"
            onClick={() => {
              setActiveView('tasks');
              setShowKindSelector(true);
            }}
          >
            {t('workbench.new_task')}
          </button>
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
          <span>{operationError}</span>
          <button
            type="button"
            className="gn-data-sync-link-button"
            onClick={() => setOperationError('')}
          >
            {t('common.dismiss')}
          </button>
        </div>
      ) : null}

      {activeView === 'tasks' ? (
        <div className="gn-data-sync-workspace-grid">
          <DataSyncTaskList
            tasks={filteredTasks}
            selectedTaskId={selectedTaskId}
            search={search}
            t={t}
            onSearchChange={setSearch}
            onSelectTask={(taskId) => {
              setSelectedTaskId(taskId);
              setShowKindSelector(false);
            }}
            onNewTask={() => setShowKindSelector(true)}
          />
          <main className="gn-data-sync-editor-column">
            {showKindSelector || !selectedTask ? (
              <DataSyncTaskKindSelector t={t} onSelect={createTask} />
            ) : (
              <>
                <DataSyncRouteBar
                  source={selectedTask.source}
                  target={selectedTask.target}
                  capability={capability}
                  active={selectedTask.kind === 'cdc' && selectedTask.lifecycle === 'enabled'}
                  t={t}
                />
                <DataSyncTaskEditor
                  task={selectedTask}
                  gateway={gatewayRef.current!}
                  capability={capability}
                  activeStage={activeStage}
                  preflight={selectedPreflight}
                  preflightStale={preflightStale}
                  t={t}
                  onStageChange={setActiveStage}
                  onPatch={patchSelectedTask}
                />
                <footer className="gn-data-sync-action-bar">
                  <span
                    className="gn-data-sync-save-state"
                    data-dirty={dirtyTaskIds.has(selectedTask.id) ? 'true' : 'false'}
                  >
                    {dirtyTaskIds.has(selectedTask.id)
                      ? t('workbench.unsaved')
                      : t('workbench.saved')}
                  </span>
                  <span className="gn-data-sync-action-bar__spacer" />
                  {selectedTask.lifecycle === 'draft' ? (
                    <button
                      type="button"
                      className="gn-data-sync-button"
                      onClick={() => transitionLifecycle('ready')}
                    >
                      {t('lifecycle.publish_ready')}
                    </button>
                  ) : null}
                  {selectedTask.lifecycle === 'ready' &&
                  selectedTask.trigger.mode !== 'manual' ? (
                    <button
                      type="button"
                      className="gn-data-sync-button"
                      onClick={() => transitionLifecycle('enabled')}
                    >
                      {t('lifecycle.enable_schedule')}
                    </button>
                  ) : null}
                  {selectedTask.lifecycle === 'enabled' ? (
                    <button
                      type="button"
                      className="gn-data-sync-button"
                      onClick={() => transitionLifecycle('paused')}
                    >
                      {t('lifecycle.pause')}
                    </button>
                  ) : null}
                  {selectedTask.lifecycle === 'paused' ? (
                    <button
                      type="button"
                      className="gn-data-sync-button"
                      onClick={() => transitionLifecycle('enabled')}
                    >
                      {t('lifecycle.resume_schedule')}
                    </button>
                  ) : null}
                  {selectedTask.lifecycle !== 'archived' ? (
                    <button
                      type="button"
                      className="gn-data-sync-link-button gn-data-sync-link-button--danger"
                      onClick={() => transitionLifecycle('archived')}
                    >
                      {t('lifecycle.archive')}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="gn-data-sync-button"
                    disabled={
                      saving ||
                      !dirtyTaskIds.has(selectedTask.id) ||
                      !saveApprovalReady
                    }
                    onClick={() => void saveTask()}
                  >
                    {saving ? t('workbench.saving') : t('workbench.save')}
                  </button>
                  <button
                    type="button"
                    className="gn-data-sync-button"
                    disabled={preflighting}
                    onClick={() => void runPreflight()}
                  >
                    {preflighting
                      ? t('workbench.preflighting')
                      : t('workbench.run_preflight')}
                  </button>
                  <button
                    type="button"
                    className="gn-data-sync-button gn-data-sync-button--primary"
                    disabled={!actionEnabled || operationBusy === 'start'}
                    title={actionEnabled ? t('workbench.start') : t('workbench.blocked_action')}
                    onClick={() => void startTask()}
                  >
                    {t('workbench.start')}
                  </button>
                </footer>
              </>
            )}
          </main>
          {selectedTask && !showKindSelector ? (
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
            />
          ) : (
            <aside className="gn-data-sync-preflight gn-data-sync-preflight--blank" />
          )}
        </div>
      ) : null}

      {activeView === 'runs' ? (
        <DataSyncRunHistory
          runs={runs}
          selectedRunId={selectedRunId}
          errorRows={errorRows}
          t={t}
          onSelectRun={(runId) => void selectRun(runId)}
          checkpoint={checkpoint}
          busyAction={operationBusy}
          onRefresh={() => void refreshRuns()}
          onCancel={(runId) => void updateRun('cancel', runId)}
          onResume={(runId) => void updateRun('resume', runId)}
          onRetry={(runId) => void updateRun('retry', runId)}
          onDiscardErrorRow={(errorRowId) => void discardErrorRow(errorRowId)}
          errorRowRetryAvailable={gatewayRef.current!.capabilities.errorRowRetry}
          onRetryErrorRow={(errorRowId) => void retryErrorRow(errorRowId)}
          checkpointResetEnabled={checkpointTask?.lifecycle === 'paused'}
          onResetCheckpoint={() => void resetCheckpoint()}
        />
      ) : null}
      {activeView === 'schedules' ? (
        <DataSyncScheduleView
          schedules={schedules}
          t={t}
          refreshing={operationBusy === 'refresh-schedules'}
          onRefresh={() => void refreshSchedules()}
          busyAction={operationBusy}
          onToggle={(schedule) => void toggleSchedule(schedule)}
          onRunNow={(schedule) => void runScheduleNow(schedule)}
          onViewRun={viewScheduleRun}
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
