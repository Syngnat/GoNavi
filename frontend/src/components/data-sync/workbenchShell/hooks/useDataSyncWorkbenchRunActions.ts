import { isWebRPCAbortError } from '../../../../utils/webRpc';
import {
  type DataSyncTaskDefinition,
  type DataSyncPreflightSnapshot,
  canStartDataSyncTask,
  validateDataSyncTask,
  reviseDataSyncTask,
  isDataSyncPreflightCurrent,
  type DataSyncRunRecord,
} from '../../model';
import { extractCompareResult } from '../dataSyncWorkbenchShellModel';
import { useDataSyncScheduleControl } from '../../useDataSyncScheduleControl';
import type { DataSyncWorkbenchStateApi } from './useDataSyncWorkbenchState';
import type { DataSyncWorkbenchTaskPersistenceApi } from './useDataSyncWorkbenchTaskPersistence';

export interface UseDataSyncWorkbenchRunActionsInput {
  selectedTask: DataSyncWorkbenchStateApi['selectedTask'];
  preflightingRef: DataSyncWorkbenchStateApi['preflightingRef'];
  savingRef: DataSyncWorkbenchStateApi['savingRef'];
  deletingTaskRef: DataSyncWorkbenchStateApi['deletingTaskRef'];
  setPreflighting: DataSyncWorkbenchStateApi['setPreflighting'];
  setOperationError: DataSyncWorkbenchStateApi['setOperationError'];
  preflightAbortRef: DataSyncWorkbenchStateApi['preflightAbortRef'];
  gatewayRef: DataSyncWorkbenchStateApi['gatewayRef'];
  setPreflights: DataSyncWorkbenchStateApi['setPreflights'];
  setApprovals: DataSyncWorkbenchStateApi['setApprovals'];
  setApprovalChallenges: DataSyncWorkbenchStateApi['setApprovalChallenges'];
  selectedTaskIdRef: DataSyncWorkbenchStateApi['selectedTaskIdRef'];
  setActiveStage: DataSyncWorkbenchStateApi['setActiveStage'];
  setOperationBusy: DataSyncWorkbenchStateApi['setOperationBusy'];
  deletedTaskIdsRef: DataSyncWorkbenchStateApi['deletedTaskIdsRef'];
  setTasks: DataSyncWorkbenchStateApi['setTasks'];
  tasks: DataSyncWorkbenchStateApi['tasks'];
  tasksRef: DataSyncWorkbenchStateApi['tasksRef'];
  clearTaskDirty: DataSyncWorkbenchStateApi['clearTaskDirty'];
  clearTaskEvidence: DataSyncWorkbenchStateApi['clearTaskEvidence'];
  setSelectedTaskId: DataSyncWorkbenchStateApi['setSelectedTaskId'];
  scheduleControlRef: DataSyncWorkbenchStateApi['scheduleControlRef'];
  reloadFirstRunPage: DataSyncWorkbenchStateApi['reloadFirstRunPage'];
  setActiveView: DataSyncWorkbenchStateApi['setActiveView'];
  selectedRunRequestEpochRef: DataSyncWorkbenchStateApi['selectedRunRequestEpochRef'];
  runEventsRequestEpochRef: DataSyncWorkbenchStateApi['runEventsRequestEpochRef'];
  setSelectedRunId: DataSyncWorkbenchStateApi['setSelectedRunId'];
  setRunEvents: DataSyncWorkbenchStateApi['setRunEvents'];
  setErrorRows: DataSyncWorkbenchStateApi['setErrorRows'];
  setCheckpoint: DataSyncWorkbenchStateApi['setCheckpoint'];
  setCompareResult: DataSyncWorkbenchStateApi['setCompareResult'];
  preflighting: DataSyncWorkbenchStateApi['preflighting'];
  operationBusy: DataSyncWorkbenchStateApi['operationBusy'];
  selectedPreflight: DataSyncWorkbenchStateApi['selectedPreflight'];
  capability: DataSyncWorkbenchStateApi['capability'];
  dirtyTaskIds: DataSyncWorkbenchStateApi['dirtyTaskIds'];
  selectedApproval: DataSyncWorkbenchStateApi['selectedApproval'];
  t: DataSyncWorkbenchStateApi['t'];
  dirtyTaskIdsRef: DataSyncWorkbenchStateApi['dirtyTaskIdsRef'];
  saveTask: DataSyncWorkbenchTaskPersistenceApi['saveTask'];
  runs: DataSyncWorkbenchStateApi['runs'];
  setRuns: DataSyncWorkbenchStateApi['setRuns'];
  markTaskDirty: DataSyncWorkbenchStateApi['markTaskDirty'];
  approvals: DataSyncWorkbenchStateApi['approvals'];
  setCapability: DataSyncWorkbenchStateApi['setCapability'];
  beginningApproval: DataSyncWorkbenchStateApi['beginningApproval'];
  setBeginningApproval: DataSyncWorkbenchStateApi['setBeginningApproval'];
  setApprovalError: DataSyncWorkbenchStateApi['setApprovalError'];
  approving: DataSyncWorkbenchStateApi['approving'];
  setApproving: DataSyncWorkbenchStateApi['setApproving'];
  pendingPublicationTaskId: DataSyncWorkbenchStateApi['pendingPublicationTaskId'];
  setPendingPublicationTaskId: DataSyncWorkbenchStateApi['setPendingPublicationTaskId'];
}

export const useDataSyncWorkbenchRunActions = ({
  selectedTask, preflightingRef, savingRef, deletingTaskRef, setPreflighting, setOperationError,
  preflightAbortRef, gatewayRef, setPreflights, setApprovals, setApprovalChallenges,
  selectedTaskIdRef, setActiveStage, setOperationBusy, deletedTaskIdsRef, setTasks, tasks, tasksRef,
  clearTaskDirty, clearTaskEvidence, setSelectedTaskId, scheduleControlRef, reloadFirstRunPage,
  setActiveView, selectedRunRequestEpochRef, runEventsRequestEpochRef, setSelectedRunId,
  setRunEvents, setErrorRows, setCheckpoint, setCompareResult, preflighting, operationBusy,
  selectedPreflight, capability, dirtyTaskIds, selectedApproval, t, dirtyTaskIdsRef, saveTask, runs,
  setRuns, markTaskDirty, approvals, setCapability, beginningApproval, setBeginningApproval,
  setApprovalError, approving, setApproving, pendingPublicationTaskId, setPendingPublicationTaskId,
}: UseDataSyncWorkbenchRunActionsInput) => {
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
      void scheduleControlRef.current?.refresh();
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
  scheduleControlRef.current = scheduleControl;

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
  return {
    runPreflight, deleteTask, startTask, runCompare, selectRun, scheduleControl, beginApproval,
    approveTask,
  };
};

export type DataSyncWorkbenchRunActionsApi = ReturnType<typeof useDataSyncWorkbenchRunActions>;
