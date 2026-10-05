import { isWebRPCAbortError } from '../../../../utils/webRpc';
import {
  type DataSyncTaskStage,
  type DataSyncTaskDefinition,
  reviseDataSyncTask,
  type DataSyncRunPageSize,
  canStartDataSyncTask,
} from '../../model';
import type { DataSyncConfirmation } from '../dataSyncWorkbenchShellModel';
import Modal from '../../../common/ResizableDraggableModal';
import type { DataSyncWorkbenchStateApi } from './useDataSyncWorkbenchState';
import type { DataSyncWorkbenchRunActionsApi } from './useDataSyncWorkbenchRunActions';
import type { DataSyncWorkbenchTaskPersistenceApi } from './useDataSyncWorkbenchTaskPersistence';

export interface UseDataSyncWorkbenchTaskLifecycleInput {
  setOperationBusy: DataSyncWorkbenchStateApi['setOperationBusy'];
  setOperationError: DataSyncWorkbenchStateApi['setOperationError'];
  requestRunPage: DataSyncWorkbenchStateApi['requestRunPage'];
  runPageCursors: DataSyncWorkbenchStateApi['runPageCursors'];
  runPageIndex: DataSyncWorkbenchStateApi['runPageIndex'];
  runPageSize: DataSyncWorkbenchStateApi['runPageSize'];
  applyRunPage: DataSyncWorkbenchStateApi['applyRunPage'];
  gatewayRef: DataSyncWorkbenchStateApi['gatewayRef'];
  setRuns: DataSyncWorkbenchStateApi['setRuns'];
  reloadFirstRunPage: DataSyncWorkbenchStateApi['reloadFirstRunPage'];
  scheduleControl: DataSyncWorkbenchRunActionsApi['scheduleControl'];
  setErrorRows: DataSyncWorkbenchStateApi['setErrorRows'];
  errorRows: DataSyncWorkbenchStateApi['errorRows'];
  setApprovals: DataSyncWorkbenchStateApi['setApprovals'];
  operationBusy: DataSyncWorkbenchStateApi['operationBusy'];
  setTasks: DataSyncWorkbenchStateApi['setTasks'];
  clearTaskEvidence: DataSyncWorkbenchStateApi['clearTaskEvidence'];
  setCheckpoint: DataSyncWorkbenchStateApi['setCheckpoint'];
  cdcAbortRef: DataSyncWorkbenchStateApi['cdcAbortRef'];
  setCdcSources: DataSyncWorkbenchStateApi['setCdcSources'];
  setActiveView: DataSyncWorkbenchStateApi['setActiveView'];
  setShowKindSelector: DataSyncWorkbenchStateApi['setShowKindSelector'];
  setActiveStage: DataSyncWorkbenchStateApi['setActiveStage'];
  setFocusMappingRef: DataSyncWorkbenchStateApi['setFocusMappingRef'];
  patchSelectedTask: DataSyncWorkbenchTaskPersistenceApi['patchSelectedTask'];
  selectedTask: DataSyncWorkbenchStateApi['selectedTask'];
  savingRef: DataSyncWorkbenchStateApi['savingRef'];
  preflightingRef: DataSyncWorkbenchStateApi['preflightingRef'];
  deletingTaskRef: DataSyncWorkbenchStateApi['deletingTaskRef'];
  setPreflighting: DataSyncWorkbenchStateApi['setPreflighting'];
  setApprovalError: DataSyncWorkbenchStateApi['setApprovalError'];
  preflightAbortRef: DataSyncWorkbenchStateApi['preflightAbortRef'];
  tasksRef: DataSyncWorkbenchStateApi['tasksRef'];
  t: DataSyncWorkbenchStateApi['t'];
  selectedTaskIdRef: DataSyncWorkbenchStateApi['selectedTaskIdRef'];
  setPreflights: DataSyncWorkbenchStateApi['setPreflights'];
  markTaskDirty: DataSyncWorkbenchStateApi['markTaskDirty'];
  setApprovalChallenges: DataSyncWorkbenchStateApi['setApprovalChallenges'];
  setPendingPublicationTaskId: DataSyncWorkbenchStateApi['setPendingPublicationTaskId'];
  saveTask: DataSyncWorkbenchTaskPersistenceApi['saveTask'];
  nextRunCursor: DataSyncWorkbenchStateApi['nextRunCursor'];
  setRunPageSize: DataSyncWorkbenchStateApi['setRunPageSize'];
  deleteTask: DataSyncWorkbenchRunActionsApi['deleteTask'];
  saving: DataSyncWorkbenchStateApi['saving'];
  preflighting: DataSyncWorkbenchStateApi['preflighting'];
  checkpoint: DataSyncWorkbenchStateApi['checkpoint'];
  checkpointTask: DataSyncWorkbenchStateApi['checkpointTask'];
  selectedPreflight: DataSyncWorkbenchStateApi['selectedPreflight'];
  capability: DataSyncWorkbenchStateApi['capability'];
  dirtyTaskIds: DataSyncWorkbenchStateApi['dirtyTaskIds'];
  selectedApproval: DataSyncWorkbenchStateApi['selectedApproval'];
  preflightStale: DataSyncWorkbenchStateApi['preflightStale'];
}

export const useDataSyncWorkbenchTaskLifecycle = ({
  setOperationBusy, setOperationError, requestRunPage, runPageCursors, runPageIndex, runPageSize,
  applyRunPage, gatewayRef, setRuns, reloadFirstRunPage, scheduleControl, setErrorRows, errorRows,
  setApprovals, operationBusy, setTasks, clearTaskEvidence, setCheckpoint, cdcAbortRef,
  setCdcSources, setActiveView, setShowKindSelector, setActiveStage, setFocusMappingRef,
  patchSelectedTask, selectedTask, savingRef, preflightingRef, deletingTaskRef, setPreflighting,
  setApprovalError, preflightAbortRef, tasksRef, t, selectedTaskIdRef, setPreflights, markTaskDirty,
  setApprovalChallenges, setPendingPublicationTaskId, saveTask, nextRunCursor, setRunPageSize,
  deleteTask, saving, preflighting, checkpoint, checkpointTask, selectedPreflight, capability,
  dirtyTaskIds, selectedApproval, preflightStale,
}: UseDataSyncWorkbenchTaskLifecycleInput) => {
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
  return {
    refreshRuns, updateRun, discardErrorRow, retryErrorRow, refreshCdc, locateIssue,
    transitionLifecycle, publishTask, changeRunPage, changeRunPageSize, requestDeleteSelectedTask,
    requestDeleteRunHistory, requestClearTerminalRunHistory, requestResetCheckpoint, actionEnabled,
    currentPreflightRequiresApproval,
  };
};

export type DataSyncWorkbenchTaskLifecycleApi = ReturnType<typeof useDataSyncWorkbenchTaskLifecycle>;
