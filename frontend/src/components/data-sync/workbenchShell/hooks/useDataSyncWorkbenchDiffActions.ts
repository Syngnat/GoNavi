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
import type { DataSyncEndpointRef } from '../../model';
import { useCompareHtmlExport } from '../../useCompareHtmlExport';
import type { CompareHtmlExportOutcome } from '../../dataSyncRunHistoryTypes';
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

// 连接名 + 库（+ schema）拼成报告头里的端点标识。
const endpointLabel = (endpoint: DataSyncEndpointRef): string => {
  const connection = endpoint.connectionName || endpoint.connectionId;
  const database = [endpoint.database, endpoint.schema].filter(Boolean).join('.');
  return database ? `${connection} · ${database}` : connection;
};

export const useDataSyncWorkbenchDiffActions = ({
  actionEnabled, t, selectedTask, dirtyTaskIds, selectedPreflight, preflightStale,
  currentPreflightRequiresApproval, capability, selectedApproval, activeStage, saving, preflighting,
  operationBusy, operationError, workbenchFamily, onOpenQueryTab, compareResult, onAskAi,
  onOpenSyncWorkbench, gatewayRef, setOperationError,
}: UseDataSyncWorkbenchDiffActionsInput) => {
  const { exportHtml } = useCompareHtmlExport(t);
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
  const handleExportCompareHtml = async (): Promise<CompareHtmlExportOutcome> => {
    if (!selectedTask || !compareResult) return { kind: 'cancelled' };
    // 报告里的两端标识优先用连接名，退化为 ID 时不至于出现空白表头。
    const outcome = await exportHtml({
      result: compareResult,
      compareMode: compareResult.content || selectedTask.compareMode,
      meta: {
        taskName: selectedTask.name || t('task_kind.compare'),
        // 只写连接名分不清比的是哪个库：同一条连接上可能有多个库。
        sourceLabel: endpointLabel(selectedTask.source),
        targetLabel: endpointLabel(selectedTask.target),
      },
      save: async (fileName, content) => {
        const saved = await gatewayRef.current!.exportTextFile(fileName, content, 'html');
        // 导出后直接打开：用户按下按钮的意图就是看报告，不该再让他自己
        // 去文件管理器里找。打开失败不影响导出结果本身。
        if (saved) {
          void gatewayRef.current?.openExportedFile(saved).catch(() => undefined);
        }
        return saved;
      },
    });
    if (outcome.kind === 'failed') setOperationError(outcome.error);
    return outcome;
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
    handleAskAiAboutDiffs, handleSyncDiffs, handleExportCompareHtml,
  };
};

export type DataSyncWorkbenchDiffActionsApi = ReturnType<typeof useDataSyncWorkbenchDiffActions>;
