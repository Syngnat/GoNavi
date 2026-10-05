import { isDataSyncPreflightCurrent, dataSyncTaskStages, validateDataSyncTask } from '../../model';
import { dataSyncValidationIssueText } from '../../text';
import { resolveWorkbenchChrome, nextLocalTaskId } from '../dataSyncWorkbenchShellModel';
import {
  buildCompareRepairSQL,
  buildCompareAiPrompt,
  tableHasCompareDiff,
} from '../../compareRepairSql';
import { createSyncTaskFromCompare } from '../../dataSyncCompareTaskFactory';
import { setDataSyncHandoff } from '../../../../utils/dataSyncHandoff';
import type { DataSyncWorkbenchTaskLifecycleApi } from './useDataSyncWorkbenchTaskLifecycle';
import type { DataSyncWorkbenchStateApi } from './useDataSyncWorkbenchState';
import type { DataSyncWorkbenchShellProps } from '../../DataSyncWorkbenchShell';

export interface UseDataSyncWorkbenchDiffActionsInput {
  actionEnabled: DataSyncWorkbenchTaskLifecycleApi['actionEnabled'];
  t: DataSyncWorkbenchStateApi['t'];
  selectedTask: DataSyncWorkbenchStateApi['selectedTask'];
  dirtyTaskIds: DataSyncWorkbenchStateApi['dirtyTaskIds'];
  selectedPreflight: DataSyncWorkbenchStateApi['selectedPreflight'];
  preflightStale: DataSyncWorkbenchStateApi['preflightStale'];
  currentPreflightRequiresApproval: DataSyncWorkbenchTaskLifecycleApi['currentPreflightRequiresApproval'];
  capability: DataSyncWorkbenchStateApi['capability'];
  selectedApproval: DataSyncWorkbenchStateApi['selectedApproval'];
  activeStage: DataSyncWorkbenchStateApi['activeStage'];
  saving: DataSyncWorkbenchStateApi['saving'];
  preflighting: DataSyncWorkbenchStateApi['preflighting'];
  operationBusy: DataSyncWorkbenchStateApi['operationBusy'];
  operationError: DataSyncWorkbenchStateApi['operationError'];
  workbenchFamily: DataSyncWorkbenchShellProps['workbenchFamily'];
  onOpenQueryTab: DataSyncWorkbenchShellProps['onOpenQueryTab'];
  compareResult: DataSyncWorkbenchStateApi['compareResult'];
  onAskAi: DataSyncWorkbenchShellProps['onAskAi'];
  onOpenSyncWorkbench: DataSyncWorkbenchShellProps['onOpenSyncWorkbench'];
  gatewayRef: DataSyncWorkbenchStateApi['gatewayRef'];
  setOperationError: DataSyncWorkbenchStateApi['setOperationError'];
}

export const useDataSyncWorkbenchDiffActions = ({
  actionEnabled, t, selectedTask, dirtyTaskIds, selectedPreflight, preflightStale,
  currentPreflightRequiresApproval, capability, selectedApproval, activeStage, saving, preflighting,
  operationBusy, operationError, workbenchFamily, onOpenQueryTab, compareResult, onAskAi,
  onOpenSyncWorkbench, gatewayRef, setOperationError,
}: UseDataSyncWorkbenchDiffActionsInput) => {
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
  return {
    runActionTitle, saveApprovalReady, nextStage, previousStage, relevantBlockerStage,
    relevantBlocker, blockerInEarlierStage, preflightNeedsRefresh, compareStartEnabled, actionHint,
    actionHintTone, serviceUnavailableError, workbenchChrome, handleGenerateRepairSql,
    handleAskAiAboutDiffs, handleSyncDiffs,
  };
};

export type DataSyncWorkbenchDiffActionsApi = ReturnType<typeof useDataSyncWorkbenchDiffActions>;
