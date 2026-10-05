import { useEffect } from 'react';
import {
  dataSyncTaskBelongsToFamily,
  type DataSyncRunPage,
  type DataSyncCdcSourceStatus,
  type DataSyncTaskDefinition,
  reviseDataSyncTask,
  type DataSyncTaskKind,
  type DataSyncCompareMode,
  createDataSyncTaskDraft,
  type DataSyncPreflightSnapshot,
} from '../../model';
import {
  mergeDataSyncInitialTasks,
  EMPTY_CAPABILITY,
  ACTIVE_RUN_STATUSES,
  RUN_POLL_INTERVAL_MS,
  extractCompareResult,
  resolveDataSyncSidebarRefreshes,
  nextLocalTaskId,
} from '../dataSyncWorkbenchShellModel';
import { isWebRPCAbortError } from '../../../../utils/webRpc';
import { dispatchSidebarDatabaseRefresh } from '../../../../utils/sidebarDatabaseRefresh';
import { dataSyncTaskKindTextKey } from '../../text';
import { registerWorkbenchTabCloseGuard } from '../../../../utils/workbenchTabCloseProtection';
import type { DataSyncWorkbenchStateApi } from './useDataSyncWorkbenchState';
import type { DataSyncWorkbenchShellProps } from '../../DataSyncWorkbenchShell';

export interface UseDataSyncWorkbenchTaskPersistenceInput {
  workbenchFamily: DataSyncWorkbenchShellProps['workbenchFamily'];
  cdcAbortRef: DataSyncWorkbenchStateApi['cdcAbortRef'];
  gatewayRef: DataSyncWorkbenchStateApi['gatewayRef'];
  handoffTaskRef: DataSyncWorkbenchStateApi['handoffTaskRef'];
  initialTasksRef: DataSyncWorkbenchStateApi['initialTasksRef'];
  deletedTaskIdsRef: DataSyncWorkbenchStateApi['deletedTaskIdsRef'];
  setTasks: DataSyncWorkbenchStateApi['setTasks'];
  dirtyTaskIdsRef: DataSyncWorkbenchStateApi['dirtyTaskIdsRef'];
  setSelectedTaskId: DataSyncWorkbenchStateApi['setSelectedTaskId'];
  requestRunPage: DataSyncWorkbenchStateApi['requestRunPage'];
  scheduleControlRef: DataSyncWorkbenchStateApi['scheduleControlRef'];
  applyRunPage: DataSyncWorkbenchStateApi['applyRunPage'];
  setCdcSources: DataSyncWorkbenchStateApi['setCdcSources'];
  setOperationError: DataSyncWorkbenchStateApi['setOperationError'];
  bootstrapRevision: DataSyncWorkbenchStateApi['bootstrapRevision'];
  selectedTask: DataSyncWorkbenchStateApi['selectedTask'];
  setCapability: DataSyncWorkbenchStateApi['setCapability'];
  capabilityAbortRef: DataSyncWorkbenchStateApi['capabilityAbortRef'];
  activeView: DataSyncWorkbenchStateApi['activeView'];
  runs: DataSyncWorkbenchStateApi['runs'];
  requestRunPageForPoll: DataSyncWorkbenchStateApi['requestRunPageForPoll'];
  runPageCursors: DataSyncWorkbenchStateApi['runPageCursors'];
  runPageIndex: DataSyncWorkbenchStateApi['runPageIndex'];
  runPageSize: DataSyncWorkbenchStateApi['runPageSize'];
  selectedRunId: DataSyncWorkbenchStateApi['selectedRunId'];
  selectedRunActive: DataSyncWorkbenchStateApi['selectedRunActive'];
  runEventsRequestEpochRef: DataSyncWorkbenchStateApi['runEventsRequestEpochRef'];
  setRunEvents: DataSyncWorkbenchStateApi['setRunEvents'];
  setCompareResult: DataSyncWorkbenchStateApi['setCompareResult'];
  runStatusesRef: DataSyncWorkbenchStateApi['runStatusesRef'];
  tasks: DataSyncWorkbenchStateApi['tasks'];
  tasksRef: DataSyncWorkbenchStateApi['tasksRef'];
  markTaskDirty: DataSyncWorkbenchStateApi['markTaskDirty'];
  setApprovalError: DataSyncWorkbenchStateApi['setApprovalError'];
  setApprovalChallenges: DataSyncWorkbenchStateApi['setApprovalChallenges'];
  t: DataSyncWorkbenchStateApi['t'];
  setActiveStage: DataSyncWorkbenchStateApi['setActiveStage'];
  setShowKindSelector: DataSyncWorkbenchStateApi['setShowKindSelector'];
  setActiveView: DataSyncWorkbenchStateApi['setActiveView'];
  savingRef: DataSyncWorkbenchStateApi['savingRef'];
  preflightingRef: DataSyncWorkbenchStateApi['preflightingRef'];
  deletingTaskRef: DataSyncWorkbenchStateApi['deletingTaskRef'];
  setSaving: DataSyncWorkbenchStateApi['setSaving'];
  preflightAbortRef: DataSyncWorkbenchStateApi['preflightAbortRef'];
  clearTaskEvidence: DataSyncWorkbenchStateApi['clearTaskEvidence'];
  setPreflights: DataSyncWorkbenchStateApi['setPreflights'];
  setDirtyTaskIds: DataSyncWorkbenchStateApi['setDirtyTaskIds'];
  workbenchTabId: DataSyncWorkbenchShellProps['workbenchTabId'];
}

export const useDataSyncWorkbenchTaskPersistence = ({
  workbenchFamily, cdcAbortRef, gatewayRef, handoffTaskRef, initialTasksRef, deletedTaskIdsRef,
  setTasks, dirtyTaskIdsRef, setSelectedTaskId, requestRunPage, scheduleControlRef, applyRunPage,
  setCdcSources, setOperationError, bootstrapRevision, selectedTask, setCapability,
  capabilityAbortRef, activeView, runs, requestRunPageForPoll, runPageCursors, runPageIndex,
  runPageSize, selectedRunId, selectedRunActive, runEventsRequestEpochRef, setRunEvents,
  setCompareResult, runStatusesRef, tasks, tasksRef, markTaskDirty, setApprovalError,
  setApprovalChallenges, t, setActiveStage, setShowKindSelector, setActiveView, savingRef,
  preflightingRef, deletingTaskRef, setSaving, preflightAbortRef, clearTaskEvidence, setPreflights,
  setDirtyTaskIds, workbenchTabId,
}: UseDataSyncWorkbenchTaskPersistenceInput) => {
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
          void scheduleControlRef.current?.ingestSnapshot(loadedTasks);
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
        void scheduleControlRef.current?.refresh();
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
  return { patchSelectedTask, createTask, saveTask };
};

export type DataSyncWorkbenchTaskPersistenceApi = ReturnType<typeof useDataSyncWorkbenchTaskPersistence>;
