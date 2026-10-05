import { dataSyncStageTextKey } from '../text';
import type { DataSyncWorkbenchDiffActionsApi } from './hooks/useDataSyncWorkbenchDiffActions';
import type { DataSyncWorkbenchStateApi } from './hooks/useDataSyncWorkbenchState';
import type { DataSyncWorkbenchTaskLifecycleApi } from './hooks/useDataSyncWorkbenchTaskLifecycle';
import type { DataSyncWorkbenchRunActionsApi } from './hooks/useDataSyncWorkbenchRunActions';
import type {
  DataSyncWorkbenchTaskPersistenceApi,
} from './hooks/useDataSyncWorkbenchTaskPersistence';

export interface DataSyncWorkbenchActionBarProps {
  actionHint: DataSyncWorkbenchDiffActionsApi['actionHint'];
  actionHintTone: DataSyncWorkbenchDiffActionsApi['actionHintTone'];
  relevantBlocker: DataSyncWorkbenchDiffActionsApi['relevantBlocker'];
  taskMenuRef: DataSyncWorkbenchStateApi['taskMenuRef'];
  taskMenuOpen: DataSyncWorkbenchStateApi['taskMenuOpen'];
  setTaskMenuOpen: DataSyncWorkbenchStateApi['setTaskMenuOpen'];
  t: DataSyncWorkbenchStateApi['t'];
  selectedTask: NonNullable<DataSyncWorkbenchStateApi['selectedTask']>;
  transitionLifecycle: DataSyncWorkbenchTaskLifecycleApi['transitionLifecycle'];
  operationBusy: DataSyncWorkbenchStateApi['operationBusy'];
  saving: DataSyncWorkbenchStateApi['saving'];
  preflighting: DataSyncWorkbenchStateApi['preflighting'];
  requestDeleteSelectedTask: DataSyncWorkbenchTaskLifecycleApi['requestDeleteSelectedTask'];
  activeStage: DataSyncWorkbenchStateApi['activeStage'];
  preflightNeedsRefresh: DataSyncWorkbenchDiffActionsApi['preflightNeedsRefresh'];
  runPreflight: DataSyncWorkbenchRunActionsApi['runPreflight'];
  compareStartEnabled: DataSyncWorkbenchDiffActionsApi['compareStartEnabled'];
  runCompare: DataSyncWorkbenchRunActionsApi['runCompare'];
  actionEnabled: DataSyncWorkbenchTaskLifecycleApi['actionEnabled'];
  runActionTitle: DataSyncWorkbenchDiffActionsApi['runActionTitle'];
  startTask: DataSyncWorkbenchRunActionsApi['startTask'];
  dirtyTaskIds: DataSyncWorkbenchStateApi['dirtyTaskIds'];
  saveApprovalReady: DataSyncWorkbenchDiffActionsApi['saveApprovalReady'];
  publishTask: DataSyncWorkbenchTaskLifecycleApi['publishTask'];
  saveTask: DataSyncWorkbenchTaskPersistenceApi['saveTask'];
  previousStage: DataSyncWorkbenchDiffActionsApi['previousStage'];
  setActiveStage: DataSyncWorkbenchStateApi['setActiveStage'];
  blockerInEarlierStage: DataSyncWorkbenchDiffActionsApi['blockerInEarlierStage'];
  relevantBlockerStage: DataSyncWorkbenchDiffActionsApi['relevantBlockerStage'];
  nextStage: DataSyncWorkbenchDiffActionsApi['nextStage'];
}

export const DataSyncWorkbenchActionBar = ({
  actionHint, actionHintTone, relevantBlocker, taskMenuRef, taskMenuOpen, setTaskMenuOpen, t,
  selectedTask, transitionLifecycle, operationBusy, saving, preflighting, requestDeleteSelectedTask,
  activeStage, preflightNeedsRefresh, runPreflight, compareStartEnabled, runCompare, actionEnabled,
  runActionTitle, startTask, dirtyTaskIds, saveApprovalReady, publishTask, saveTask, previousStage,
  setActiveStage, blockerInEarlierStage, relevantBlockerStage, nextStage,
}: DataSyncWorkbenchActionBarProps) => (
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
);
