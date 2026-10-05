import React from 'react';

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
import { type DataSyncWorkbenchGateway } from './gateway';
import {
  type DataSyncConnectionTreeItem,
  type DataSyncTaskDefinition,
  type DataSyncTaskStage,
  type DataSyncWorkbenchFamily,
} from './model';
import { type DataSyncWorkbenchLocale } from './text';
import './DataSyncWorkbench.css';
import { useDataSyncWorkbenchState } from './workbenchShell/hooks/useDataSyncWorkbenchState';
import {
  useDataSyncWorkbenchTaskPersistence,
} from './workbenchShell/hooks/useDataSyncWorkbenchTaskPersistence';
import {
  useDataSyncWorkbenchRunActions,
} from './workbenchShell/hooks/useDataSyncWorkbenchRunActions';
import {
  useDataSyncWorkbenchTaskLifecycle,
} from './workbenchShell/hooks/useDataSyncWorkbenchTaskLifecycle';
import {
  useDataSyncWorkbenchDiffActions,
} from './workbenchShell/hooks/useDataSyncWorkbenchDiffActions';
import { DataSyncWorkbenchHeader } from './workbenchShell/DataSyncWorkbenchHeader';
import { DataSyncWorkbenchActionBar } from './workbenchShell/DataSyncWorkbenchActionBar';
export {
  resolveDataSyncSidebarRefreshes,
  mergeDataSyncInitialTasks,
} from './workbenchShell/dataSyncWorkbenchShellModel';

// Compare-task conversion lives in its own module; re-exported here so the
// workbench keeps a single import surface for existing call sites.
export {
  createSchemaSyncTaskFromCompare,
  createSyncTaskFromCompare,
} from './dataSyncCompareTaskFactory';

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
  const {
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
  } = useDataSyncWorkbenchState({
    locale, initialTasks, workbenchFamily, gateway, focusTaskId, focusRequestId, focusStage,
  });

  const { patchSelectedTask, createTask, saveTask } = useDataSyncWorkbenchTaskPersistence({
    workbenchFamily, cdcAbortRef, gatewayRef, handoffTaskRef, initialTasksRef, deletedTaskIdsRef,
    setTasks, dirtyTaskIdsRef, setSelectedTaskId, requestRunPage, scheduleControlRef, applyRunPage,
    setCdcSources, setOperationError, bootstrapRevision, selectedTask, setCapability,
    capabilityAbortRef, activeView, runs, requestRunPageForPoll, runPageCursors, runPageIndex,
    runPageSize, selectedRunId, selectedRunActive, runEventsRequestEpochRef, setRunEvents,
    setCompareResult, runStatusesRef, tasks, tasksRef, markTaskDirty, setApprovalError,
    setApprovalChallenges, t, setActiveStage, setShowKindSelector, setActiveView, savingRef,
    preflightingRef, deletingTaskRef, setSaving, preflightAbortRef, clearTaskEvidence,
    setPreflights, setDirtyTaskIds, workbenchTabId,
  });

  const {
    runPreflight, deleteTask, startTask, runCompare, selectRun, scheduleControl, beginApproval,
    approveTask,
  } = useDataSyncWorkbenchRunActions({
    selectedTask, preflightingRef, savingRef, deletingTaskRef, setPreflighting, setOperationError,
    preflightAbortRef, gatewayRef, setPreflights, setApprovals, setApprovalChallenges,
    selectedTaskIdRef, setActiveStage, setOperationBusy, deletedTaskIdsRef, setTasks, tasks,
    tasksRef, clearTaskDirty, clearTaskEvidence, setSelectedTaskId, scheduleControlRef,
    reloadFirstRunPage, setActiveView, selectedRunRequestEpochRef, runEventsRequestEpochRef,
    setSelectedRunId, setRunEvents, setErrorRows, setCheckpoint, setCompareResult, preflighting,
    operationBusy, selectedPreflight, capability, dirtyTaskIds, selectedApproval, t,
    dirtyTaskIdsRef, saveTask, runs, setRuns, markTaskDirty, approvals, setCapability,
    beginningApproval, setBeginningApproval, setApprovalError, approving, setApproving,
    pendingPublicationTaskId, setPendingPublicationTaskId,
  });

  const {
    refreshRuns, updateRun, discardErrorRow, retryErrorRow, refreshCdc, locateIssue,
    transitionLifecycle, publishTask, changeRunPage, changeRunPageSize, requestDeleteSelectedTask,
    requestDeleteRunHistory, requestClearTerminalRunHistory, requestResetCheckpoint, actionEnabled,
    currentPreflightRequiresApproval,
  } = useDataSyncWorkbenchTaskLifecycle({
    setOperationBusy, setOperationError, requestRunPage, runPageCursors, runPageIndex, runPageSize,
    applyRunPage, gatewayRef, setRuns, reloadFirstRunPage, scheduleControl, setErrorRows, errorRows,
    setApprovals, operationBusy, setTasks, clearTaskEvidence, setCheckpoint, cdcAbortRef,
    setCdcSources, setActiveView, setShowKindSelector, setActiveStage, setFocusMappingRef,
    patchSelectedTask, selectedTask, savingRef, preflightingRef, deletingTaskRef, setPreflighting,
    setApprovalError, preflightAbortRef, tasksRef, t, selectedTaskIdRef, setPreflights,
    markTaskDirty, setApprovalChallenges, setPendingPublicationTaskId, saveTask, nextRunCursor,
    setRunPageSize, deleteTask, saving, preflighting, checkpoint, checkpointTask, selectedPreflight,
    capability, dirtyTaskIds, selectedApproval, preflightStale,
  });
  const {
    runActionTitle, saveApprovalReady, nextStage, previousStage, relevantBlockerStage,
    relevantBlocker, blockerInEarlierStage, preflightNeedsRefresh, compareStartEnabled, actionHint,
    actionHintTone, serviceUnavailableError, workbenchChrome, handleGenerateRepairSql,
    handleAskAiAboutDiffs, handleSyncDiffs,
  } = useDataSyncWorkbenchDiffActions({
    actionEnabled, t, selectedTask, dirtyTaskIds, selectedPreflight, preflightStale,
    currentPreflightRequiresApproval, capability, selectedApproval, activeStage, saving,
    preflighting, operationBusy, operationError, workbenchFamily, onOpenQueryTab, compareResult,
    onAskAi, onOpenSyncWorkbench, gatewayRef, setOperationError,
  });

  return (
    <div
      ref={workbenchRef}
      className="gn-data-sync-workbench"
      data-data-sync-workbench-shell="true"
      data-workbench-family={workbenchFamily || ''}
    >
      <DataSyncWorkbenchHeader
        t={t} workbenchChrome={workbenchChrome} viewKeys={viewKeys} activeView={activeView}
        setActiveView={setActiveView} setTaskRailOpen={setTaskRailOpen}
        scheduleControl={scheduleControl} taskRailToggleRef={taskRailToggleRef}
        taskListId={taskListId} taskRailOpen={taskRailOpen} compactTaskRail={compactTaskRail}
        setShowKindSelector={setShowKindSelector} onClose={onClose}
      />

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
                <DataSyncWorkbenchActionBar
                  actionHint={actionHint} actionHintTone={actionHintTone}
                  relevantBlocker={relevantBlocker} taskMenuRef={taskMenuRef}
                  taskMenuOpen={taskMenuOpen} setTaskMenuOpen={setTaskMenuOpen} t={t}
                  selectedTask={selectedTask} transitionLifecycle={transitionLifecycle}
                  operationBusy={operationBusy} saving={saving} preflighting={preflighting}
                  requestDeleteSelectedTask={requestDeleteSelectedTask} activeStage={activeStage}
                  preflightNeedsRefresh={preflightNeedsRefresh} runPreflight={runPreflight}
                  compareStartEnabled={compareStartEnabled} runCompare={runCompare}
                  actionEnabled={actionEnabled} runActionTitle={runActionTitle}
                  startTask={startTask} dirtyTaskIds={dirtyTaskIds}
                  saveApprovalReady={saveApprovalReady} publishTask={publishTask}
                  saveTask={saveTask} previousStage={previousStage}
                  setActiveStage={setActiveStage} blockerInEarlierStage={blockerInEarlierStage}
                  relevantBlockerStage={relevantBlockerStage} nextStage={nextStage}
                />
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
