import QueryEditorResultsPanel from '../QueryEditorResultsPanel';
import {
  QueryEditorParamsPanel,
  QueryEditorParamsBindDialog,
} from './params/QueryEditorParamsPanel';
import { collectMissingParamNames } from './params/queryEditorParamsModel';
import type { QueryEditorShortcutsAndSnippetsApi } from './hooks/useQueryEditorShortcutsAndSnippets';
import type { QueryEditorCoreStateApi } from './hooks/useQueryEditorCoreState';
import type { QueryEditorExecutionStatusApi } from './hooks/useQueryEditorExecutionStatus';
import type { QueryEditorConnectionContextApi } from './hooks/useQueryEditorConnectionContext';
import type { QueryEditorResultTabsApi } from './hooks/useQueryEditorResultTabs';
import type { QueryEditorResultReloadApi } from './hooks/useQueryEditorResultReload';
import type { QueryEditorResultPagingApi } from './hooks/useQueryEditorResultPaging';
import type { QueryEditorQueryContextApi } from './hooks/useQueryEditorQueryContext';
import type { QueryEditorRunApi } from './hooks/useQueryEditorRun';
import type { QueryEditorProps } from '../QueryEditor';

export interface QueryEditorResultsAreaProps {
  editorFullscreen: QueryEditorShortcutsAndSnippetsApi['editorFullscreen'];
  tab: QueryEditorProps['tab'];
  resultSets: QueryEditorCoreStateApi['resultSets'];
  activeResultKey: QueryEditorCoreStateApi['activeResultKey'];
  isActive: Exclude<QueryEditorProps['isActive'], undefined>;
  loading: QueryEditorCoreStateApi['loading'];
  executionLifecycle: QueryEditorExecutionStatusApi['executionLifecycle'];
  executionError: QueryEditorCoreStateApi['executionError'];
  sqlLogCount: QueryEditorConnectionContextApi['sqlLogCount'];
  darkMode: QueryEditorConnectionContextApi['darkMode'];
  currentDb: QueryEditorCoreStateApi['currentDb'];
  currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
  queryOptions: QueryEditorCoreStateApi['queryOptions'];
  resultDataPreviewRequest: QueryEditorCoreStateApi['resultDataPreviewRequest'];
  elasticsearchViewModes: QueryEditorCoreStateApi['elasticsearchViewModes'];
  handleElasticsearchViewModeChange: QueryEditorCoreStateApi['handleElasticsearchViewModeChange'];
  toggleQueryResultsPanelShortcutLabel: QueryEditorResultTabsApi['toggleQueryResultsPanelShortcutLabel'];
  setActiveResultKey: QueryEditorCoreStateApi['setActiveResultKey'];
  updateResultPanelVisibility: QueryEditorExecutionStatusApi['updateResultPanelVisibility'];
  handleCloseResult: QueryEditorResultTabsApi['handleCloseResult'];
  closeOtherResultTabs: QueryEditorResultTabsApi['closeOtherResultTabs'];
  closeResultTabsToLeft: QueryEditorResultTabsApi['closeResultTabsToLeft'];
  closeResultTabsToRight: QueryEditorResultTabsApi['closeResultTabsToRight'];
  closeAllResultTabs: QueryEditorResultTabsApi['closeAllResultTabs'];
  handleResultPinnedChange: QueryEditorResultTabsApi['handleResultPinnedChange'];
  openResultInWindow: QueryEditorResultTabsApi['openResultInWindow'];
  handleReloadResult: QueryEditorResultReloadApi['handleReloadResult'];
  handleResultPageChange: QueryEditorResultPagingApi['handleResultPageChange'];
  handleResultSort: QueryEditorResultPagingApi['handleResultSort'];
  handleRequestResultTotalCount: QueryEditorResultReloadApi['handleRequestResultTotalCount'];
  handleCancelResultTotalCount: QueryEditorResultReloadApi['handleCancelResultTotalCount'];
  handleDiagnoseExecutionError: QueryEditorResultTabsApi['handleDiagnoseExecutionError'];
  diagnoseExecutionErrorShortcutLabel: QueryEditorResultTabsApi['diagnoseExecutionErrorShortcutLabel'];
  locateExecutionError: QueryEditorCoreStateApi['locateExecutionError'];
  setResultDiffAnchorKey: QueryEditorCoreStateApi['setResultDiffAnchorKey'];
  setResultDiffWizardOpen: QueryEditorCoreStateApi['setResultDiffWizardOpen'];
  paramsState: QueryEditorQueryContextApi['paramsState'];
  paramsDialogState: QueryEditorQueryContextApi['paramsDialogState'];
  setParamsDialogState: QueryEditorQueryContextApi['setParamsDialogState'];
  handleRun: QueryEditorRunApi['handleRun'];
  lastParamsRunScopeRef: QueryEditorQueryContextApi['lastParamsRunScopeRef'];
}

export const QueryEditorResultsArea = ({
  editorFullscreen, tab, resultSets, activeResultKey, isActive, loading, executionLifecycle,
  executionError, sqlLogCount, darkMode, currentDb, currentConnectionId, queryOptions,
  resultDataPreviewRequest, elasticsearchViewModes, handleElasticsearchViewModeChange,
  toggleQueryResultsPanelShortcutLabel, setActiveResultKey, updateResultPanelVisibility,
  handleCloseResult, closeOtherResultTabs, closeResultTabsToLeft, closeResultTabsToRight,
  closeAllResultTabs, handleResultPinnedChange, openResultInWindow, handleReloadResult,
  handleResultPageChange, handleResultSort, handleRequestResultTotalCount,
  handleCancelResultTotalCount, handleDiagnoseExecutionError, diagnoseExecutionErrorShortcutLabel,
  locateExecutionError, setResultDiffAnchorKey, setResultDiffWizardOpen, paramsState,
  paramsDialogState, setParamsDialogState, handleRun, lastParamsRunScopeRef,
}: QueryEditorResultsAreaProps) => (
  <>
    {editorFullscreen.resultsAreaMounted && (
      <QueryEditorResultsPanel
        workbenchTabId={tab.id}
        resultSets={resultSets}
        activeResultKey={activeResultKey}
        isActive={isActive}
        loading={loading}
        executionLifecycle={executionLifecycle}
        executionError={executionError}
        sqlLogCount={sqlLogCount}
        darkMode={darkMode}
        currentDb={currentDb}
        currentConnectionId={currentConnectionId}
        maxRows={queryOptions?.maxRows ?? 5000}
        dataPreviewRequest={resultDataPreviewRequest}
        elasticsearchViewModes={elasticsearchViewModes}
        onElasticsearchViewModeChange={handleElasticsearchViewModeChange}
        toggleShortcutLabel={toggleQueryResultsPanelShortcutLabel}
        onActiveResultKeyChange={setActiveResultKey}
        onHide={() => updateResultPanelVisibility(false)}
        onCloseResult={handleCloseResult}
        onCloseOtherResultTabs={closeOtherResultTabs}
        onCloseResultTabsToLeft={closeResultTabsToLeft}
        onCloseResultTabsToRight={closeResultTabsToRight}
        onCloseAllResultTabs={closeAllResultTabs}
        onResultPinnedChange={handleResultPinnedChange}
        onOpenResultInWindow={openResultInWindow}
        onReloadResult={handleReloadResult}
        onResultPageChange={handleResultPageChange}
        onResultSort={handleResultSort}
        onRequestResultTotalCount={handleRequestResultTotalCount}
        onCancelResultTotalCount={handleCancelResultTotalCount}
        onDiagnoseExecutionError={handleDiagnoseExecutionError}
        diagnoseShortcutLabel={diagnoseExecutionErrorShortcutLabel}
        onLocateExecutionError={() => locateExecutionError(executionError)}
        onCompareResult={(resultKey) => {
          setResultDiffAnchorKey(resultKey);
          setResultDiffWizardOpen(true);
        }}
        paramsPanel={
          paramsState.hasParams || paramsState.analyzing || paramsState.analysis ? (
            <QueryEditorParamsPanel
              analysis={paramsState.analysis}
              analyzing={paramsState.analyzing}
              values={paramsState.values}
              onChange={paramsState.setValue}
            />
          ) : undefined
        }
      />
    )}

    <QueryEditorParamsBindDialog
      open={paramsDialogState.open}
      analysis={paramsDialogState.analysis}
      analyzing={paramsState.analyzing}
      values={paramsState.values}
      missingNames={
        paramsDialogState.analysis
          ? collectMissingParamNames(paramsDialogState.analysis.parameterNames, paramsState.values)
          : []
      }
      onChange={paramsState.setValue}
      onConfirm={() => {
        setParamsDialogState((current) => ({ ...current, open: false }));
        void handleRun(lastParamsRunScopeRef.current || 'default', { skipParamsGate: true });
      }}
      onCancel={() => setParamsDialogState((current) => ({ ...current, open: false }))}
    />
  </>
);
