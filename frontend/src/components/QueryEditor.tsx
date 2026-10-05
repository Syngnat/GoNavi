import React from 'react';
import type { TabData } from '../types';
export {
    collectQueryEditorObjectDecorationCandidates,
    resolveQueryEditorNavigationDecorations,
    resolveQueryEditorNavigationTarget,
} from './queryEditor/QueryEditorHelpers';
import { useQueryEditorCoreState } from './queryEditor/hooks/useQueryEditorCoreState';
import { useQueryEditorConnectionContext } from './queryEditor/hooks/useQueryEditorConnectionContext';
import { useQueryEditorShortcutsAndSnippets } from './queryEditor/hooks/useQueryEditorShortcutsAndSnippets';
import { useQueryEditorAiCompletionTriggers } from './queryEditor/hooks/useQueryEditorAiCompletionTriggers';
import { useQueryEditorExecutionStatus } from './queryEditor/hooks/useQueryEditorExecutionStatus';
import { useQueryEditorQueryContext } from './queryEditor/hooks/useQueryEditorQueryContext';
import { useQueryEditorDraftSync } from './queryEditor/hooks/useQueryEditorDraftSync';
import { useQueryEditorAiContext } from './queryEditor/hooks/useQueryEditorAiContext';
import { useQueryEditorObjectDecorations } from './queryEditor/hooks/useQueryEditorObjectDecorations';
import { useQueryEditorDropAndLineEdits } from './queryEditor/hooks/useQueryEditorDropAndLineEdits';
import { useQueryEditorAiAssistActions } from './queryEditor/hooks/useQueryEditorAiAssistActions';
import { useQueryEditorMetadataLoading } from './queryEditor/hooks/useQueryEditorMetadataLoading';
import { useQueryEditorEditorSplit } from './queryEditor/hooks/useQueryEditorEditorSplit';
import { useQueryEditorObjectEditTabs } from './queryEditor/hooks/useQueryEditorObjectEditTabs';
import { useQueryEditorMonacoMount } from './queryEditor/hooks/useQueryEditorMonacoMount';
import { useQueryEditorFormatting } from './queryEditor/hooks/useQueryEditorFormatting';
import { useQueryEditorResultSetModel } from './queryEditor/hooks/useQueryEditorResultSetModel';
import { useQueryEditorResultReload } from './queryEditor/hooks/useQueryEditorResultReload';
import { useQueryEditorResultPaging } from './queryEditor/hooks/useQueryEditorResultPaging';
import { useQueryEditorElasticsearchRun } from './queryEditor/hooks/useQueryEditorElasticsearchRun';
import { useQueryEditorRun } from './queryEditor/hooks/useQueryEditorRun';
import { useQueryEditorEditorActions } from './queryEditor/hooks/useQueryEditorEditorActions';
import { useQueryEditorActiveTabShortcuts } from './queryEditor/hooks/useQueryEditorActiveTabShortcuts';
import { useQueryEditorSaveActions } from './queryEditor/hooks/useQueryEditorSaveActions';
import { useQueryEditorToolbarMenus } from './queryEditor/hooks/useQueryEditorToolbarMenus';
import { useQueryEditorKeyboardShortcuts } from './queryEditor/hooks/useQueryEditorKeyboardShortcuts';
import { useQueryEditorResultTabs } from './queryEditor/hooks/useQueryEditorResultTabs';
import { useLateBoundCallback } from '../hooks/useLateBoundCallback';
import { QueryEditorEditorPane } from './queryEditor/QueryEditorEditorPane';
import { QueryEditorResultsArea } from './queryEditor/QueryEditorResultsArea';
import { QueryEditorResultDiffViews } from './queryEditor/QueryEditorResultDiffViews';
import { QueryEditorDialogs } from './queryEditor/QueryEditorDialogs';

export { shouldRefreshQueryEditorCompletionColumns } from './queryEditor/queryEditorCompletionColumns';
export { filterQueryEditorResultSetsForBulkClose } from './queryEditor/queryEditorResultSort';

export interface QueryEditorProps { tab: TabData; isActive?: boolean }

const QueryEditor: React.FC<QueryEditorProps> = ({ tab, isActive = true }) => {
  const {
      hasBeenActive, appearance, queryOptions, setQueryOptions, wordWrapEnabled, query, setQuery,
      isExternalSQLFileTab, isObjectEditQueryTab, queryEditorMonacoOptions,
      restoredResultSessionRef, resultSets, setResultSets, activeResultKey, setActiveResultKey,
      resultDataPreviewRequest, setResultDataPreviewRequest, elasticsearchViewModes,
      handleElasticsearchViewModeChange, resultSetsRef, activeResultKeyRef, paramsPanelAvailableRef,
      nativeRestoredResultRefs, loading, setLoading, queryEditorMetadataReloadTick,
      setQueryEditorMetadataReloadTick, queryEditorMetadataForceReloadRef, queryContextLockRunSeq,
      queryContextLockRunSeqRef, lockQueryContextForRun, unlockQueryContextForRun,
      executionTimingActive, setExecutionTimingActive, executionAwaitingDriverRef,
      executionElapsedText, executionElapsedLabel, executionSpeedIcon, beginQueryEditorRunClock,
      finishQueryEditorSqlClock, executionError, setExecutionError, executionErrorRef,
      currentQueryId, setCurrentQueryId, isSqlSnippetPickerOpen, setIsSqlSnippetPickerOpen,
      isDuckDBAttachPickerOpen, setIsDuckDBAttachPickerOpen, sqlSnippetPickerKeyword,
      setSqlSnippetPickerKeyword, runSeqRef, currentQueryIdRef, rpcLostWithoutResultRef,
      queryEditorUnmountedRef, invokeRequestScopedApp, resultTotalCountSeqRef,
      resultTotalCountRequestsRef, isSaveModalOpen, setIsSaveModalOpen, saveModalMode,
      setSaveModalMode, saveForm, saveQueryNameInputRef, currentConnectionId,
      setCurrentConnectionId, currentDb, setCurrentDb, currentSchema, setCurrentSchema, schemaList,
      setSchemaList, schemaLoading, schemaLoadingRef, setSchemaLoading, resultTotalCountContextRef,
      dbList, setDbList, isTextToSqlModalOpen, setIsTextToSqlModalOpen, textToSqlInstruction,
      setTextToSqlInstruction, textToSqlApplyMode, setTextToSqlApplyMode, textToSqlGenerating,
      setTextToSqlGenerating, resultDiffWizardOpen, setResultDiffWizardOpen, resultDiffAnchorKey,
      setResultDiffAnchorKey, resultDiffSession, setResultDiffSession, viewDataVerifyOpen,
      setViewDataVerifyOpen, editorHeight, setEditorHeight, editorStageRef, editorShellRef,
      editorRef, monacoRef, handleRunRef, pendingRunAfterSchemaLoadRef, deferredContextRunSeqRef,
      runQueryActionRef, sqlExecutionContextMenuActionDisposablesRef,
      selectCurrentStatementActionRef, macFindWithSelectionGuardActionRef,
      duplicateCurrentLineActionRef, toggleLineCommentActionRef, saveQueryActionRef,
      saveQueryAsActionRef, findInEditorActionRef, formatSqlActionRef,
      triggerSqlAiCompletionActionRef, triggerSqlAiCompletionKeydownDisposableRef,
      acceptSqlAiCompletionKeydownDisposableRef, insertSqlSnippetActionRef,
      transformCaseActionDisposablesRef, aiContextMenuActionDisposablesRef,
      toggleQueryResultsPanelActionRef, lastExternalQueryRef, lastLocalQueryRef,
      saveOperationQueueRef, queryEditorMountedRef, imeCompositionFallbackRef,
      imeCompositionFallbackTimerRef, lastEditorCursorPositionRef, lastHoverTargetPositionRef,
      lastExecutedEditorQueryRef, recordExecutionOrigin, locateExecutionError,
      resolveExecutionErrorStatement, linkDecorationIdsRef, ctrlMetaPressedRef,
      objectDecorationIdsRef, sqlFieldDropDecorationIdsRef, aiInlineGhostDecorationIdsRef,
      aiInlineGhostOverlayRef, aiInlineGhostVisibleContextKeyRef, aiInlineGhostTimerRef,
      aiInlineGhostRequestSeqRef, triggerAiInlineCompletionRef, acceptAiInlineCompletionRef,
      acceptSqlAiCompletionBindingRef, queryEditorActiveRef, aiContextMetadataWarmupRef,
      incompleteColumnMetadataDbsRef, aiContextCacheRef, triggerSqlAiCompletionAltPressedRef,
      triggerSqlAiCompletionAltGestureAtRef, triggerSqlAiCompletionFallbackRef,
      triggerSqlAiCompletionFallbackApplyingRef, aiInlineGhostRef, aiInlineGhostAcceptingRef,
      objectHoverActionRef, dragRef, pendingEditorHeightRef, resizeFrameRef, queryEditorRootRef,
      editorPaneRef, tablesRef, metadataGenerationRef, missingTableMetadataKeysRef,
      tableNavigationValidationInFlightRef, tableNavigationActionInFlightRef,
      queryTableLocateCycleRef, allColumnsRef, viewsRef, materializedViewsRef, synonymsRef,
      triggersRef, routinesRef, sequencesRef, packagesRef, visibleDbsRef, metadataFetchKeyRef,
      metadataContextKeyRef, metadataContextConnectionConfigRef, sqlReferencedMetadataKey,
      setSqlReferencedMetadataKey, sqlReferencedMetadataTimerRef, lastSqlReferencedMetadataKeyRef,
      metadataRetryPendingRef, objectDecorationIdleCallbackRef, objectDecorationFallbackTimerRef,
      objectDecorationRefreshSeqRef, objectDecorationsDirtyRef,
  } = useQueryEditorCoreState({ isActive, tab });

  const {
      connections, connectionTags, sidebarRootOrder, rootSortMode, rootConnectionSortMode,
      currentConnection, currentConnectionConfig, canSelectQuerySchema, queryCapableConnections,
      currentConnectionCapabilities, isElasticsearchMode, elasticsearchServerMajor,
      setElasticsearchServerMajor, queryEditorMonacoLanguage, addSqlLog, sqlLogCount, addTab,
      setActiveContext, updateQueryTabDraft, savedQueries, sqlSnippets, currentConnectionIdRef,
      currentDbRef, currentSchemaRef, latestSelectedSchemaRef, schemaLoadSeqRef,
      schemaContextKeyRef, tableNavigationContextRef, inlineSqlMemoryEntries, draftSnapshotTab,
      connectionsRef, isQueryEditorMetadataRequestCurrent, columnsCacheRef, saveQuery,
      languagePreference, darkMode, sqlFormatOptions, setSqlFormatOptions,
      queryEditorEditorHeightRatio, sqlEditorTransactionOptions, setSqlEditorTransactionOptions,
      isResultPanelVisible, setIsResultPanelVisible, isResultPanelVisibleRef,
  } = useQueryEditorConnectionContext({
      currentConnectionId, isObjectEditQueryTab, tab, currentDb, metadataGenerationRef, editorRef,
      monacoRef, isActive, currentSchema, queryEditorMountedRef, queryOptions,
      restoredResultSessionRef, resultSetsRef, activeResultKeyRef, resultSets, activeResultKey,
  });
  const getCurrentQueryLate = useLateBoundCallback<() => string>();
  const {
      shortcutOptions, activeShortcutPlatform, runQueryShortcutBinding,
      diagnoseQueryShortcutBinding, showSlowQueriesShortcutBinding,
      diagnoseExecutionErrorShortcutBinding, filteredSqlSnippets, sqlSnippetPickerEmptyLabel,
      openSqlAnalysisWorkbench, openQueryHistoryWorkbench, handleCloseSqlSnippetPicker,
      handleOpenSnippetSettingsFromPicker, registerInsertSqlSnippetContextMenuAction,
      disposeSqlExecutionContextMenuActions, registerSqlExecutionContextMenuActions,
      disposeTransformCaseContextMenuActions, registerTransformCaseContextMenuActions,
      handleDiagnoseExecutionErrorWithAI, selectCurrentStatementShortcutBinding,
      duplicateCurrentLineShortcutBinding, toggleLineCommentShortcutBinding,
      saveQueryShortcutBinding, saveQueryAsShortcutBinding, formatSqlShortcutBinding,
      triggerSqlAiCompletionShortcutBinding, toggleQueryResultsPanelShortcutBinding,
      editorFullscreen, findInEditorShortcutCombo, primaryShortcutModifierLabel,
  } = useQueryEditorShortcutsAndSnippets({
      sqlSnippets, sqlSnippetPickerKeyword, tab, currentConnectionId, currentConnectionCapabilities,
      currentDb, addTab, setIsSqlSnippetPickerOpen, setSqlSnippetPickerKeyword,
      insertSqlSnippetActionRef, isElasticsearchMode, sqlExecutionContextMenuActionDisposablesRef,
      languagePreference, transformCaseActionDisposablesRef,
      getCurrentQuery: getCurrentQueryLate.call, resolveExecutionErrorStatement,
      currentConnectionIdRef, currentDbRef, currentConnectionConfig, isActive, executionErrorRef,
      acceptSqlAiCompletionBindingRef, queryEditorActiveRef, editorRef, queryEditorRootRef,
      editorHeight, isResultPanelVisible,
  });
  const {
      isTriggerSqlAiCompletionShortcutEvent, isPossibleTriggerSqlAiCompletionFallbackEvent,
      registerTriggerSqlAiCompletionAction,
  } = useQueryEditorAiCompletionTriggers({
      triggerSqlAiCompletionShortcutBinding, triggerSqlAiCompletionAltPressedRef,
      triggerSqlAiCompletionActionRef, isElasticsearchMode, activeShortcutPlatform,
      triggerAiInlineCompletionRef, tab, restoredResultSessionRef, isResultPanelVisibleRef,
      setIsResultPanelVisible,
  });
  const {
      updateResultPanelVisibility, executionLifecycle, executionLifecycleRef, executionStatusText,
      toggleResultPanelVisibility, handleOpenEditorFind, handleShowSqlExecutionLog,
      sqlEditorCommitMode, sqlEditorAutoCommitDelayMs, activatePendingSqlTransaction,
      appendPendingSqlTransactionExecution, sqlEditorAutoCommitRemainingSeconds,
      pendingSqlTransaction, pendingSqlTransactionRef, handleFinishPendingSqlTransaction,
      autoFetchVisible,
  } = useQueryEditorExecutionStatus({
      tab, isResultPanelVisibleRef, setIsResultPanelVisible, updateQueryTabDraft,
      rpcLostWithoutResultRef, setLoading, setExecutionTimingActive, setExecutionError,
      setResultSets, currentQueryId, loading, isActive, executionAwaitingDriverRef,
      executionTimingActive, editorRef, isResultPanelVisible, activeResultKey, setActiveResultKey,
      sqlEditorTransactionOptions,
  });

  const {
      switchQueryContext, currentSavedQuery, paramsState, paramsDialogState, setParamsDialogState,
      lastParamsRunScopeRef,
  } = useQueryEditorQueryContext({
      isActive, metadataContextKeyRef, metadataContextConnectionConfigRef, metadataFetchKeyRef,
      metadataRetryPendingRef, aiContextMetadataWarmupRef, aiContextCacheRef,
      incompleteColumnMetadataDbsRef, missingTableMetadataKeysRef, tablesRef, allColumnsRef,
      viewsRef, materializedViewsRef, synonymsRef, triggersRef, routinesRef, sequencesRef,
      packagesRef, columnsCacheRef, currentSchemaRef, latestSelectedSchemaRef, schemaContextKeyRef,
      schemaLoadSeqRef, setCurrentSchema, setSchemaList, connections, isObjectEditQueryTab,
      setSchemaLoading, tab, currentConnectionIdRef, currentDbRef, queryContextLockRunSeqRef,
      pendingSqlTransactionRef, deferredContextRunSeqRef, pendingRunAfterSchemaLoadRef,
      setCurrentConnectionId, setCurrentDb, visibleDbsRef, editorRef, setActiveContext,
      updateQueryTabDraft, currentConnectionId, currentDb, currentConnectionConfig, savedQueries,
      currentConnection, query, paramsPanelAvailableRef, monacoRef, queryEditorMountedRef,
      aiInlineGhostTimerRef, aiInlineGhostRequestSeqRef,
  });

  const {
      runQueuedSaveOperation, syncQueryDraft, applyQueryState, handleInsertSqlSnippet,
      handleInsertDuckDBAttachStatement, getCurrentQuery,
  } = useQueryEditorDraftSync({
      saveOperationQueueRef, lastLocalQueryRef, draftSnapshotTab, currentConnectionIdRef,
      currentDbRef, isExternalSQLFileTab, setQuery, editorRef, monacoRef,
      handleCloseSqlSnippetPicker, tab, currentConnectionId, currentDb, currentSavedQuery, query,
      queryCapableConnections, switchQueryContext, pendingSqlTransaction, queryContextLockRunSeq,
      queryEditorMonacoLanguage, currentSchemaRef, currentSchema, queryContextLockRunSeqRef,
      pendingSqlTransactionRef, latestSelectedSchemaRef, setCurrentSchema, setSchemaList,
      updateQueryTabDraft,
  });
  getCurrentQueryLate.bind(getCurrentQuery);

  const {
      buildQueryEditorAiEditorSnapshot, buildQueryEditorAiContext,
      ensureQueryEditorAiContextMetadata, handleDatabaseChange,
  } = useQueryEditorAiContext({
      editorRef, getCurrentQuery, tab, currentConnectionIdRef, currentConnectionId, connectionsRef,
      currentDbRef, currentDb, tablesRef, allColumnsRef, visibleDbsRef, appearance,
      aiContextCacheRef, incompleteColumnMetadataDbsRef, metadataGenerationRef,
      aiContextMetadataWarmupRef, isQueryEditorMetadataRequestCurrent, isExternalSQLFileTab,
      draftSnapshotTab, isActive, connections, currentSchema, viewsRef, materializedViewsRef,
      synonymsRef, triggersRef, routinesRef, sequencesRef, packagesRef, columnsCacheRef,
      switchQueryContext,
  });

  const {
      refreshObjectDecorations, cancelPendingObjectDecorationRefresh,
      cancelPendingSqlReferencedMetadataRefresh, scheduleObjectDecorationRefresh,
      validateTableNavigationTarget, clearMissingTableNavigationMetadata, showObjectInfoAtPosition,
      registerShowObjectInfoAction,
  } = useQueryEditorObjectDecorations({
      editorRef, monacoRef, isObjectEditQueryTab, objectDecorationIdsRef, objectDecorationsDirtyRef,
      tablesRef, viewsRef, materializedViewsRef, triggersRef, routinesRef, sequencesRef,
      packagesRef, connectionsRef, currentConnectionIdRef, allColumnsRef, currentDbRef,
      visibleDbsRef, currentSchemaRef, objectDecorationRefreshSeqRef,
      objectDecorationIdleCallbackRef, objectDecorationFallbackTimerRef,
      sqlReferencedMetadataTimerRef, queryEditorMountedRef, queryEditorActiveRef, lastLocalQueryRef,
      isActive, tableNavigationValidationInFlightRef, tableNavigationContextRef,
      metadataGenerationRef, missingTableMetadataKeysRef, columnsCacheRef, aiContextCacheRef,
      objectHoverActionRef, lastHoverTargetPositionRef, currentDb, currentSchema,
  });

  const {
      resolveSqlFieldDropPosition, clearSqlFieldDropPreview, updateSqlFieldDropPreview,
      handleSidebarObjectDrop, handleSelectCurrentStatement, handleDuplicateCurrentLine,
      disposeToggleLineCommentAction, registerToggleLineCommentAction,
  } = useQueryEditorDropAndLineEdits({
      editorRef, monacoRef, lastEditorCursorPositionRef, sqlFieldDropDecorationIdsRef, isActive,
      currentConnectionIdRef, currentDbRef, connectionsRef, missingTableMetadataKeysRef,
      visibleDbsRef, tablesRef, refreshObjectDecorations, applyQueryState,
      toggleLineCommentActionRef, activeShortcutPlatform, toggleLineCommentShortcutBinding,
      languagePreference,
  });

  const {
      disposeQueryEditorAiContextMenuActions, registerQueryEditorAiContextMenuActions,
      refreshQueryEditorSlashCommandDefs, syncQueryToEditor, openTextToSqlModal,
      handleGenerateTextToSql,
  } = useQueryEditorAiAssistActions({
      aiContextMenuActionDisposablesRef, tab, isElasticsearchMode, currentConnectionIdRef,
      currentDbRef, queryEditorMonacoLanguage, connectionsRef, applyQueryState, editorRef,
      setTextToSqlApplyMode, setIsTextToSqlModalOpen, monacoRef, refreshObjectDecorations,
      lastEditorCursorPositionRef, textToSqlInstruction, setTextToSqlInstruction,
      setTextToSqlGenerating, buildQueryEditorAiContext, buildQueryEditorAiEditorSnapshot,
      elasticsearchServerMajor, textToSqlApplyMode,
  });

  useQueryEditorMetadataLoading({
      tab, lastExternalQueryRef, editorRef, lastLocalQueryRef, setQuery, syncQueryToEditor,
      hasBeenActive, autoFetchVisible, connections, currentConnectionId, visibleDbsRef,
      queryEditorActiveRef, setDbList, schemaLoadSeqRef, setSchemaLoading, canSelectQuerySchema,
      schemaContextKeyRef, currentSchemaRef, latestSelectedSchemaRef, setCurrentSchema,
      setSchemaList, currentConnection, currentDb, updateQueryTabDraft, currentConnectionIdRef,
      isObjectEditQueryTab, metadataGenerationRef, metadataFetchKeyRef, tablesRef, allColumnsRef,
      viewsRef, materializedViewsRef, synonymsRef, triggersRef, routinesRef, sequencesRef,
      packagesRef, columnsCacheRef, incompleteColumnMetadataDbsRef, missingTableMetadataKeysRef,
      queryEditorMetadataForceReloadRef, setQueryEditorMetadataReloadTick,
      isQueryEditorMetadataRequestCurrent, currentDbRef, getCurrentQuery, objectDecorationsDirtyRef,
      scheduleObjectDecorationRefresh, metadataRetryPendingRef, refreshObjectDecorations,
      lastSqlReferencedMetadataKeyRef, queryEditorMetadataReloadTick, sqlReferencedMetadataKey,
  });

  const { setQueryId, clearQueryId, handleMouseDown } = useQueryEditorEditorSplit({
      currentQueryIdRef, setCurrentQueryId, queryEditorRootRef, editorPaneRef, editorStageRef,
      editorShellRef, dragRef, queryEditorEditorHeightRatio, pendingEditorHeightRef,
      setEditorHeight, isActive, tab, editorFullscreen, isResultPanelVisible, editorRef,
      resizeFrameRef, editorHeight,
  });

  const {
      openRoutineObjectEditTab, openDefinitionObjectEditTab, openTriggerObjectEditTab,
  } = useQueryEditorObjectEditTabs({ tab, connectionsRef, addTab });

  const { handleEditorBeforeMount, handleEditorDidMount } = useQueryEditorMonacoMount({
      tab, isActive, editorRef, monacoRef, restoredResultSessionRef, lastEditorCursorPositionRef,
      queryEditorMonacoLanguage, isObjectEditQueryTab, wordWrapEnabled, isElasticsearchMode,
      aiInlineGhostVisibleContextKeyRef, aiInlineGhostTimerRef, aiInlineGhostDecorationIdsRef,
      aiInlineGhostRequestSeqRef, aiInlineGhostRef, aiInlineGhostOverlayRef, connectionsRef,
      currentConnectionIdRef, syncQueryDraft, aiInlineGhostAcceptingRef, buildQueryEditorAiContext,
      inlineSqlMemoryEntries, ensureQueryEditorAiContextMetadata, triggerAiInlineCompletionRef,
      acceptAiInlineCompletionRef, acceptSqlAiCompletionKeydownDisposableRef, queryEditorActiveRef,
      acceptSqlAiCompletionBindingRef, ctrlMetaPressedRef, linkDecorationIdsRef, currentDbRef,
      visibleDbsRef, tablesRef, viewsRef, materializedViewsRef, triggersRef, routinesRef,
      sequencesRef, packagesRef, primaryShortcutModifierLabel, currentSchemaRef,
      lastHoverTargetPositionRef, imeCompositionFallbackTimerRef, imeCompositionFallbackRef,
      resolveSqlFieldDropPosition, updateSqlFieldDropPreview, clearSqlFieldDropPreview,
      handleSidebarObjectDrop, darkMode, objectHoverActionRef, showObjectInfoAtPosition,
      triggerSqlAiCompletionFallbackApplyingRef, triggerSqlAiCompletionFallbackRef,
      triggerSqlAiCompletionAltGestureAtRef, objectDecorationsDirtyRef,
      cancelPendingObjectDecorationRefresh, cancelPendingSqlReferencedMetadataRefresh,
      refreshObjectDecorations, sqlReferencedMetadataTimerRef, lastSqlReferencedMetadataKeyRef,
      metadataRetryPendingRef, setQueryEditorMetadataReloadTick, scheduleObjectDecorationRefresh,
      setSqlReferencedMetadataKey, switchQueryContext, addTab, tableNavigationContextRef,
      tableNavigationActionInFlightRef, validateTableNavigationTarget, queryEditorMountedRef,
      missingTableMetadataKeysRef, clearMissingTableNavigationMetadata, openDefinitionObjectEditTab,
      openTriggerObjectEditTab, openRoutineObjectEditTab, objectDecorationIdsRef,
      triggerSqlAiCompletionActionRef, macFindWithSelectionGuardActionRef,
      triggerSqlAiCompletionKeydownDisposableRef, disposeQueryEditorAiContextMenuActions,
      disposeSqlExecutionContextMenuActions, disposeTransformCaseContextMenuActions,
      registerSqlExecutionContextMenuActions, registerQueryEditorAiContextMenuActions,
      registerInsertSqlSnippetContextMenuAction, registerTransformCaseContextMenuActions,
      registerToggleLineCommentAction, registerTriggerSqlAiCompletionAction,
      runQueryShortcutBinding, activeShortcutPlatform, runQueryActionRef,
      selectCurrentStatementShortcutBinding, selectCurrentStatementActionRef,
      handleSelectCurrentStatement, duplicateCurrentLineShortcutBinding,
      duplicateCurrentLineActionRef, handleDuplicateCurrentLine, saveQueryActionRef,
      saveQueryShortcutBinding, saveQueryAsActionRef, currentSavedQuery, saveQueryAsShortcutBinding,
      findInEditorShortcutCombo, findInEditorActionRef, formatSqlShortcutBinding,
      formatSqlActionRef, refreshQueryEditorSlashCommandDefs,
      toggleQueryResultsPanelShortcutBinding, toggleQueryResultsPanelActionRef,
      toggleResultPanelVisibility, currentDb, getCurrentQuery,
  });

  const { handleFormat, handleFormatRef, handleAIAction, formatSettingsMenu } = useQueryEditorFormatting({
      tab, isElasticsearchMode, editorRef, monacoRef, getCurrentQuery, updateQueryTabDraft,
      applyQueryState, syncQueryToEditor, currentConnectionIdRef, connectionsRef, sqlFormatOptions,
      refreshObjectDecorations, isActive, shortcutOptions, activeShortcutPlatform, connections,
      currentConnectionId, currentDb, openTextToSqlModal, setSqlFormatOptions,
  });

  const {
      splitSQLStatements, normalizeExecutableStatementList, containsOraclePlsqlDefinition,
      normalizeOracleSqlPlusSlashTerminators, getSelectedSQL, mergeResultSets,
      clearUnpinnedResultSets, isAffectedRowsResultSetData, hasConcreteQueryResultSetData,
      activateExecutedResult, getExecutableSQL, captureEditorCursorPosition,
      buildSqlExecutionConnectionConfig, executeSqlEditorMultiQuery,
  } = useQueryEditorResultSetModel({
      editorRef, resultSetsRef, activeResultKeyRef, setResultSets, setActiveResultKey, tab,
      setResultDataPreviewRequest, lastEditorCursorPositionRef, getCurrentQuery, resultSets,
      lastExecutedEditorQueryRef, connections, currentConnectionId, currentSchemaRef,
      canSelectQuerySchema, currentConnectionIdRef, currentDbRef, queryOptions,
      pendingSqlTransactionRef, invokeRequestScopedApp,
  });

  const {
      handleReloadResult, handleRequestResultTotalCount, cancelResultTotalCountRequests,
      handleCancelResultTotalCount,
  } = useQueryEditorResultReload({
      resultSets, setResultSets, currentConnectionId, connections, currentDb, runSeqRef,
      beginQueryEditorRunClock, setLoading, currentQueryIdRef, clearQueryId, setQueryId,
      setExecutionTimingActive, executeSqlEditorMultiQuery, splitSQLStatements,
      finishQueryEditorSqlClock, queryOptions, resultSetsRef, resultTotalCountRequestsRef,
      resultTotalCountSeqRef, addSqlLog, currentSchema, resultTotalCountContextRef,
  });

  const { handleResultPageChange, handleResultSort } = useQueryEditorResultPaging({
      resultSetsRef, currentConnectionId, connections, currentDb, runSeqRef,
      beginQueryEditorRunClock, setLoading, setResultSets, currentQueryIdRef, clearQueryId,
      setQueryId, setExecutionTimingActive, executeSqlEditorMultiQuery, splitSQLStatements,
      finishQueryEditorSqlClock,
  });

  const { handleElasticsearchRun } = useQueryEditorElasticsearchRun({
      isActive, getCurrentQuery, connections, currentConnectionId, currentDb, editorRef, runSeqRef,
      currentQueryIdRef, clearQueryId, setElasticsearchServerMajor, beginQueryEditorRunClock,
      setLoading, setExecutionError, setQueryId, setExecutionTimingActive,
      finishQueryEditorSqlClock, updateResultPanelVisibility, mergeResultSets, resultSetsRef,
      setResultSets, activateExecutedResult, currentConnectionIdRef, visibleDbsRef, setDbList,
      currentDbRef, handleDatabaseChange,
  });

  const {
      handleRun, runAfterQueryContextReady, handleRunSelectedShortcut, handleCancel,
  } = useQueryEditorRun({
      tab, isActive, isElasticsearchMode, handleElasticsearchRun, canSelectQuerySchema,
      schemaLoading, getCurrentQuery, getSelectedSQL, getExecutableSQL, clearUnpinnedResultSets,
      currentConnection, currentDbRef, currentSchemaRef, visibleDbsRef, pendingSqlTransactionRef,
      activatePendingSqlTransaction, appendPendingSqlTransactionExecution,
      queryContextLockRunSeqRef, switchQueryContext, currentConnectionIdRef, schemaContextKeyRef,
      latestSelectedSchemaRef, setCurrentSchema, setSchemaList, updateQueryTabDraft, runSeqRef,
      beginQueryEditorRunClock, lockQueryContextForRun, setLoading, setExecutionError,
      recordExecutionOrigin, updateResultPanelVisibility, rpcLostWithoutResultRef,
      cancelResultTotalCountRequests, resultTotalCountRequestsRef, currentQueryIdRef, clearQueryId,
      connections, currentConnectionId, buildSqlExecutionConnectionConfig, splitSQLStatements,
      resultSets, setResultSets, lastExecutedEditorQueryRef, normalizeExecutableStatementList,
      queryOptions, setExecutionTimingActive, setQueryId, invokeRequestScopedApp, addSqlLog,
      finishQueryEditorSqlClock, mergeResultSets, activateExecutedResult, metadataGenerationRef,
      isQueryEditorMetadataRequestCurrent, tablesRef, containsOraclePlsqlDefinition,
      normalizeOracleSqlPlusSlashTerminators, paramsDialogState, setParamsDialogState, paramsState,
      lastParamsRunScopeRef, executeSqlEditorMultiQuery, queryEditorUnmountedRef,
      sqlEditorCommitMode, sqlEditorAutoCommitDelayMs, hasConcreteQueryResultSetData,
      isAffectedRowsResultSetData, executionLifecycleRef, unlockQueryContextForRun, handleRunRef,
      deferredContextRunSeqRef, queryEditorActiveRef, schemaLoadingRef,
      pendingRunAfterSchemaLoadRef, loading,
  });

  useQueryEditorEditorActions({
      isActive, editorRef, editorPaneRef, queryEditorRootRef, runQueryShortcutBinding,
      handleRunSelectedShortcut, handleRun, objectHoverActionRef, monacoRef,
      registerShowObjectInfoAction, languagePreference, registerInsertSqlSnippetContextMenuAction,
      insertSqlSnippetActionRef, registerSqlExecutionContextMenuActions,
      disposeSqlExecutionContextMenuActions, registerTransformCaseContextMenuActions,
      disposeTransformCaseContextMenuActions, registerTriggerSqlAiCompletionAction,
      triggerSqlAiCompletionActionRef, triggerSqlAiCompletionKeydownDisposableRef,
      triggerSqlAiCompletionShortcutBinding, isElasticsearchMode,
      isTriggerSqlAiCompletionShortcutEvent, isPossibleTriggerSqlAiCompletionFallbackEvent,
      triggerSqlAiCompletionFallbackRef, triggerAiInlineCompletionRef, runQueryActionRef,
      activeShortcutPlatform, selectCurrentStatementActionRef, macFindWithSelectionGuardActionRef,
      selectCurrentStatementShortcutBinding, handleSelectCurrentStatement,
      duplicateCurrentLineActionRef, duplicateCurrentLineShortcutBinding,
      handleDuplicateCurrentLine,
  });

  useQueryEditorActiveTabShortcuts({
      registerToggleLineCommentAction, disposeToggleLineCommentAction, saveQueryActionRef,
      editorRef, monacoRef, activeShortcutPlatform, saveQueryShortcutBinding, languagePreference,
      tab, saveQueryAsActionRef, currentSavedQuery, saveQueryAsShortcutBinding,
      findInEditorActionRef, findInEditorShortcutCombo, formatSqlActionRef,
      formatSqlShortcutBinding, registerQueryEditorAiContextMenuActions,
      disposeQueryEditorAiContextMenuActions, refreshQueryEditorSlashCommandDefs,
      toggleQueryResultsPanelActionRef, toggleQueryResultsPanelShortcutBinding,
      toggleResultPanelVisibility, isActive, lastEditorCursorPositionRef, currentConnectionIdRef,
      currentDbRef, currentConnectionConfig, queryTableLocateCycleRef, visibleDbsRef, tablesRef,
      viewsRef, materializedViewsRef, triggersRef, routinesRef, sequencesRef, packagesRef,
      currentSchemaRef, handleRun, handleRunSelectedShortcut, handleOpenEditorFind,
      selectCurrentStatementShortcutBinding, queryEditorRootRef, handleSelectCurrentStatement,
      duplicateCurrentLineShortcutBinding, handleDuplicateCurrentLine, switchQueryContext,
      applyQueryState, getCurrentQuery, runAfterQueryContextReady,
  });

  const {
      persistQuery, handleQuickSave, handleRenameQuery, handleSaveQueryAs, handleExportSQLFile,
  } = useQueryEditorSaveActions({
      tab, getCurrentQuery, lastLocalQueryRef, savedQueries, currentConnectionId, currentDb,
      runQueuedSaveOperation, saveQuery, queryEditorMountedRef, currentConnectionIdRef,
      currentDbRef, addTab, setQuery, currentSavedQuery, setSaveModalMode, saveForm,
      setIsSaveModalOpen,
  });

  const { elasticsearchTemplateMenuItems, saveMoreMenuItems, analysisMenuItems } = useQueryEditorToolbarMenus({
      editorRef, monacoRef, getCurrentQuery, syncQueryToEditor, applyQueryState, currentDb,
      elasticsearchServerMajor, tab, currentConnectionConfig, setIsDuckDBAttachPickerOpen,
      currentSavedQuery, saveQueryAsShortcutBinding, activeShortcutPlatform, handleSaveQueryAs,
      handleRenameQuery, handleExportSQLFile, diagnoseQueryShortcutBinding,
      showSlowQueriesShortcutBinding, currentConnectionCapabilities, openQueryHistoryWorkbench,
      openSqlAnalysisWorkbench,
  });

  useQueryEditorKeyboardShortcuts({
      isActive, findInEditorShortcutCombo, editorRef, editorPaneRef, queryEditorRootRef,
      handleOpenEditorFind, saveQueryShortcutBinding, handleQuickSave, tab,
      saveQueryAsShortcutBinding, currentSavedQuery, handleSaveQueryAs, formatSqlShortcutBinding,
      handleFormatRef, triggerSqlAiCompletionAltGestureAtRef, triggerSqlAiCompletionAltPressedRef,
      triggerSqlAiCompletionFallbackRef, triggerSqlAiCompletionShortcutBinding,
      isTriggerSqlAiCompletionShortcutEvent, isPossibleTriggerSqlAiCompletionFallbackEvent,
      triggerAiInlineCompletionRef, toggleQueryResultsPanelShortcutBinding,
      toggleResultPanelVisibility, isResultPanelVisible, activeResultKey, handleShowSqlExecutionLog,
  });

  const {
      handleSave, handleCloseResult, handleResultPinnedChange, closeOtherResultTabs,
      closeResultTabsToLeft, closeResultTabsToRight, closeAllResultTabs, openResultInWindow,
      toggleQueryResultsPanelShortcutLabel, diagnoseExecutionErrorShortcutLabel,
      handleDiagnoseExecutionError, sqlEditorTransactionToolbar,
  } = useQueryEditorResultTabs({
      tab, saveForm, currentSavedQuery, saveModalMode, persistQuery, setIsSaveModalOpen,
      cancelResultTotalCountRequests, resultSetsRef, activeResultKeyRef, paramsPanelAvailableRef,
      setResultSets, setActiveResultKey, isActive, isResultPanelVisibleRef,
      updateResultPanelVisibility, resultTotalCountRequestsRef, resultSets, currentConnectionId,
      currentDb, nativeRestoredResultRefs, toggleQueryResultsPanelShortcutBinding,
      activeShortcutPlatform, diagnoseExecutionErrorShortcutBinding,
      handleDiagnoseExecutionErrorWithAI, executionError, darkMode, pendingSqlTransaction,
      sqlEditorAutoCommitRemainingSeconds, handleFinishPendingSqlTransaction,
  });
  return (
    <div ref={queryEditorRootRef} className="gn-v2-query-editor" style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <QueryEditorEditorPane
        editorPaneRef={editorPaneRef} editorFullscreen={editorFullscreen}
        isElasticsearchMode={isElasticsearchMode} activeShortcutPlatform={activeShortcutPlatform}
        currentConnectionId={currentConnectionId} currentDb={currentDb}
        queryCapableConnections={queryCapableConnections} connectionTags={connectionTags}
        sidebarRootOrder={sidebarRootOrder} rootSortMode={rootSortMode}
        rootConnectionSortMode={rootConnectionSortMode} dbList={dbList}
        queryContextLockRunSeq={queryContextLockRunSeq}
        pendingSqlTransaction={pendingSqlTransaction} canSelectQuerySchema={canSelectQuerySchema}
        currentSchema={currentSchema} schemaList={schemaList} schemaLoading={schemaLoading}
        loading={loading} queryContextLockRunSeqRef={queryContextLockRunSeqRef}
        pendingSqlTransactionRef={pendingSqlTransactionRef} currentSchemaRef={currentSchemaRef}
        latestSelectedSchemaRef={latestSelectedSchemaRef} setCurrentSchema={setCurrentSchema}
        setSchemaList={setSchemaList} updateQueryTabDraft={updateQueryTabDraft} tab={tab}
        queryOptions={queryOptions} sqlEditorCommitMode={sqlEditorCommitMode}
        sqlEditorAutoCommitDelayMs={sqlEditorAutoCommitDelayMs}
        sqlEditorTransactionToolbar={sqlEditorTransactionToolbar}
        runQueryShortcutBinding={runQueryShortcutBinding}
        saveQueryShortcutBinding={saveQueryShortcutBinding}
        formatSqlShortcutBinding={formatSqlShortcutBinding}
        triggerSqlAiCompletionShortcutBinding={triggerSqlAiCompletionShortcutBinding}
        toggleQueryResultsPanelShortcutBinding={toggleQueryResultsPanelShortcutBinding}
        isResultPanelVisible={isResultPanelVisible} wordWrapEnabled={wordWrapEnabled}
        saveMoreMenuItems={saveMoreMenuItems} analysisMenuItems={analysisMenuItems}
        formatSettingsMenu={formatSettingsMenu} sqlFormatOptions={sqlFormatOptions}
        elasticsearchTemplateMenuItems={elasticsearchTemplateMenuItems}
        switchQueryContext={switchQueryContext} handleDatabaseChange={handleDatabaseChange}
        setQueryOptions={setQueryOptions}
        setSqlEditorTransactionOptions={setSqlEditorTransactionOptions}
        captureEditorCursorPosition={captureEditorCursorPosition} handleRun={handleRun}
        handleElasticsearchRun={handleElasticsearchRun} handleCancel={handleCancel}
        handleQuickSave={handleQuickSave} handleOpenEditorFind={handleOpenEditorFind}
        handleFormat={handleFormat} triggerAiInlineCompletionRef={triggerAiInlineCompletionRef}
        toggleResultPanelVisibility={toggleResultPanelVisibility} handleAIAction={handleAIAction}
        isObjectEditQueryTab={isObjectEditQueryTab} query={query}
        setViewDataVerifyOpen={setViewDataVerifyOpen} editorStageRef={editorStageRef}
        editorShellRef={editorShellRef} queryEditorMonacoLanguage={queryEditorMonacoLanguage}
        darkMode={darkMode} syncQueryDraft={syncQueryDraft} paramsState={paramsState}
        handleEditorBeforeMount={handleEditorBeforeMount}
        handleEditorDidMount={handleEditorDidMount}
        queryEditorMonacoOptions={queryEditorMonacoOptions}
        executionElapsedLabel={executionElapsedLabel} executionSpeedIcon={executionSpeedIcon}
        executionElapsedText={executionElapsedText} executionStatusText={executionStatusText}
        handleMouseDown={handleMouseDown}
      />

      <QueryEditorResultsArea
        editorFullscreen={editorFullscreen} tab={tab} resultSets={resultSets}
        activeResultKey={activeResultKey} isActive={isActive} loading={loading}
        executionLifecycle={executionLifecycle} executionError={executionError}
        sqlLogCount={sqlLogCount} darkMode={darkMode} currentDb={currentDb}
        currentConnectionId={currentConnectionId} queryOptions={queryOptions}
        resultDataPreviewRequest={resultDataPreviewRequest}
        elasticsearchViewModes={elasticsearchViewModes}
        handleElasticsearchViewModeChange={handleElasticsearchViewModeChange}
        toggleQueryResultsPanelShortcutLabel={toggleQueryResultsPanelShortcutLabel}
        setActiveResultKey={setActiveResultKey}
        updateResultPanelVisibility={updateResultPanelVisibility}
        handleCloseResult={handleCloseResult} closeOtherResultTabs={closeOtherResultTabs}
        closeResultTabsToLeft={closeResultTabsToLeft}
        closeResultTabsToRight={closeResultTabsToRight} closeAllResultTabs={closeAllResultTabs}
        handleResultPinnedChange={handleResultPinnedChange}
        openResultInWindow={openResultInWindow} handleReloadResult={handleReloadResult}
        handleResultPageChange={handleResultPageChange} handleResultSort={handleResultSort}
        handleRequestResultTotalCount={handleRequestResultTotalCount}
        handleCancelResultTotalCount={handleCancelResultTotalCount}
        handleDiagnoseExecutionError={handleDiagnoseExecutionError}
        diagnoseExecutionErrorShortcutLabel={diagnoseExecutionErrorShortcutLabel}
        locateExecutionError={locateExecutionError}
        setResultDiffAnchorKey={setResultDiffAnchorKey}
        setResultDiffWizardOpen={setResultDiffWizardOpen} paramsState={paramsState}
        paramsDialogState={paramsDialogState} setParamsDialogState={setParamsDialogState}
        handleRun={handleRun} lastParamsRunScopeRef={lastParamsRunScopeRef}
      />

      <QueryEditorResultDiffViews
        resultDiffWizardOpen={resultDiffWizardOpen} resultSets={resultSets}
        currentConnectionId={currentConnectionId} currentDb={currentDb}
        resultDiffAnchorKey={resultDiffAnchorKey} connections={connections}
        setResultDiffWizardOpen={setResultDiffWizardOpen}
        setResultDiffSession={setResultDiffSession} resultDiffSession={resultDiffSession}
        darkMode={darkMode} viewDataVerifyOpen={viewDataVerifyOpen} query={query} tab={tab}
        setViewDataVerifyOpen={setViewDataVerifyOpen}
      />

      <QueryEditorDialogs
        isElasticsearchMode={isElasticsearchMode} isTextToSqlModalOpen={isTextToSqlModalOpen}
        textToSqlGenerating={textToSqlGenerating}
        setIsTextToSqlModalOpen={setIsTextToSqlModalOpen}
        handleGenerateTextToSql={handleGenerateTextToSql} darkMode={darkMode}
        textToSqlInstruction={textToSqlInstruction}
        setTextToSqlInstruction={setTextToSqlInstruction} textToSqlApplyMode={textToSqlApplyMode}
        setTextToSqlApplyMode={setTextToSqlApplyMode}
        isSqlSnippetPickerOpen={isSqlSnippetPickerOpen}
        sqlSnippetPickerKeyword={sqlSnippetPickerKeyword}
        setSqlSnippetPickerKeyword={setSqlSnippetPickerKeyword}
        filteredSqlSnippets={filteredSqlSnippets}
        sqlSnippetPickerEmptyLabel={sqlSnippetPickerEmptyLabel}
        handleInsertSqlSnippet={handleInsertSqlSnippet}
        handleOpenSnippetSettingsFromPicker={handleOpenSnippetSettingsFromPicker}
        handleCloseSqlSnippetPicker={handleCloseSqlSnippetPicker}
        isDuckDBAttachPickerOpen={isDuckDBAttachPickerOpen} connections={connections}
        currentConnectionConfig={currentConnectionConfig} currentDb={currentDb}
        setIsDuckDBAttachPickerOpen={setIsDuckDBAttachPickerOpen}
        handleInsertDuckDBAttachStatement={handleInsertDuckDBAttachStatement}
        saveModalMode={saveModalMode} isSaveModalOpen={isSaveModalOpen} handleSave={handleSave}
        setIsSaveModalOpen={setIsSaveModalOpen} saveQueryNameInputRef={saveQueryNameInputRef}
        saveForm={saveForm}
      />

    </div>
    );
};

export default React.memo(QueryEditor);
