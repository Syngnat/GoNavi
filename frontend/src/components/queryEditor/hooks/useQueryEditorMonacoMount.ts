import type { BeforeMount, OnMount } from '../../MonacoEditor';
import { installQueryEditorViewStateMemory } from '../queryEditorResultSessionLifecycle';
import { installQueryEditorSuggestWidgetWidth } from '../queryEditorSuggestionLayout';
import { QUERY_EDITOR_SQL_SNIPPET_SUGGEST_DETAIL_MIN_HEIGHT } from '../queryEditorLazyTablesCache';
import { normalizeEditorPosition } from '../QueryEditorHelpers';
import { setSharedActiveEditorModelUri } from '../queryEditorCompletionState';
import {
    buildQueryEditorMonacoOptions,
    QUERY_EDITOR_AI_INLINE_CONTEXT_KEY,
} from '../queryEditorRunHelpers';
import { decorateV2MonacoContextMenu } from '../../common/V2ActionMenuPopup';
import { createQueryEditorAiInlineGhostState } from '../monaco/queryEditorAiInlineGhostState';
import { createQueryEditorAiInlineGhostActions } from '../monaco/queryEditorAiInlineGhostActions';
import { createQueryEditorNavigationHover } from '../monaco/queryEditorNavigationHover';
import { createQueryEditorImeAndDropHandlers } from '../monaco/queryEditorImeAndDropHandlers';
import { bindQueryEditorEditorEvents } from '../monaco/queryEditorEditorEventBindings';
import { bindQueryEditorMouseAndDispose } from '../monaco/queryEditorMouseAndDisposeBindings';
import { registerQueryEditorKeyBindings } from '../monaco/queryEditorKeyBindings';
import { registerQueryEditorSqlLanguageProviders } from '../monaco/queryEditorSqlLanguageProviders';
import { bindQueryEditorSlashCommands } from '../monaco/queryEditorSlashCommandBinding';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorDraftSyncApi } from './useQueryEditorDraftSync';
import type { QueryEditorAiContextApi } from './useQueryEditorAiContext';
import type { QueryEditorShortcutsAndSnippetsApi } from './useQueryEditorShortcutsAndSnippets';
import type { QueryEditorDropAndLineEditsApi } from './useQueryEditorDropAndLineEdits';
import type { QueryEditorObjectDecorationsApi } from './useQueryEditorObjectDecorations';
import type { QueryEditorQueryContextApi } from './useQueryEditorQueryContext';
import type { QueryEditorObjectEditTabsApi } from './useQueryEditorObjectEditTabs';
import type { QueryEditorAiAssistActionsApi } from './useQueryEditorAiAssistActions';
import type { QueryEditorAiCompletionTriggersApi } from './useQueryEditorAiCompletionTriggers';
import type { QueryEditorExecutionStatusApi } from './useQueryEditorExecutionStatus';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorMonacoMountInput {
    tab: QueryEditorProps['tab'];
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    editorRef: QueryEditorCoreStateApi['editorRef'];
    monacoRef: QueryEditorCoreStateApi['monacoRef'];
    restoredResultSessionRef: QueryEditorCoreStateApi['restoredResultSessionRef'];
    lastEditorCursorPositionRef: QueryEditorCoreStateApi['lastEditorCursorPositionRef'];
    queryEditorMonacoLanguage: QueryEditorConnectionContextApi['queryEditorMonacoLanguage'];
    isObjectEditQueryTab: QueryEditorCoreStateApi['isObjectEditQueryTab'];
    wordWrapEnabled: QueryEditorCoreStateApi['wordWrapEnabled'];
    isElasticsearchMode: QueryEditorConnectionContextApi['isElasticsearchMode'];
    aiInlineGhostVisibleContextKeyRef: QueryEditorCoreStateApi['aiInlineGhostVisibleContextKeyRef'];
    aiInlineGhostTimerRef: QueryEditorCoreStateApi['aiInlineGhostTimerRef'];
    aiInlineGhostDecorationIdsRef: QueryEditorCoreStateApi['aiInlineGhostDecorationIdsRef'];
    aiInlineGhostRequestSeqRef: QueryEditorCoreStateApi['aiInlineGhostRequestSeqRef'];
    aiInlineGhostRef: QueryEditorCoreStateApi['aiInlineGhostRef'];
    aiInlineGhostOverlayRef: QueryEditorCoreStateApi['aiInlineGhostOverlayRef'];
    connectionsRef: QueryEditorConnectionContextApi['connectionsRef'];
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    syncQueryDraft: QueryEditorDraftSyncApi['syncQueryDraft'];
    aiInlineGhostAcceptingRef: QueryEditorCoreStateApi['aiInlineGhostAcceptingRef'];
    buildQueryEditorAiContext: QueryEditorAiContextApi['buildQueryEditorAiContext'];
    inlineSqlMemoryEntries: QueryEditorConnectionContextApi['inlineSqlMemoryEntries'];
    ensureQueryEditorAiContextMetadata: QueryEditorAiContextApi['ensureQueryEditorAiContextMetadata'];
    triggerAiInlineCompletionRef: QueryEditorCoreStateApi['triggerAiInlineCompletionRef'];
    acceptAiInlineCompletionRef: QueryEditorCoreStateApi['acceptAiInlineCompletionRef'];
    acceptSqlAiCompletionKeydownDisposableRef: QueryEditorCoreStateApi['acceptSqlAiCompletionKeydownDisposableRef'];
    queryEditorActiveRef: QueryEditorCoreStateApi['queryEditorActiveRef'];
    acceptSqlAiCompletionBindingRef: QueryEditorCoreStateApi['acceptSqlAiCompletionBindingRef'];
    ctrlMetaPressedRef: QueryEditorCoreStateApi['ctrlMetaPressedRef'];
    linkDecorationIdsRef: QueryEditorCoreStateApi['linkDecorationIdsRef'];
    currentDbRef: QueryEditorConnectionContextApi['currentDbRef'];
    visibleDbsRef: QueryEditorCoreStateApi['visibleDbsRef'];
    tablesRef: QueryEditorCoreStateApi['tablesRef'];
    viewsRef: QueryEditorCoreStateApi['viewsRef'];
    materializedViewsRef: QueryEditorCoreStateApi['materializedViewsRef'];
    triggersRef: QueryEditorCoreStateApi['triggersRef'];
    routinesRef: QueryEditorCoreStateApi['routinesRef'];
    sequencesRef: QueryEditorCoreStateApi['sequencesRef'];
    packagesRef: QueryEditorCoreStateApi['packagesRef'];
    primaryShortcutModifierLabel: QueryEditorShortcutsAndSnippetsApi['primaryShortcutModifierLabel'];
    currentSchemaRef: QueryEditorConnectionContextApi['currentSchemaRef'];
    lastHoverTargetPositionRef: QueryEditorCoreStateApi['lastHoverTargetPositionRef'];
    imeCompositionFallbackTimerRef: QueryEditorCoreStateApi['imeCompositionFallbackTimerRef'];
    imeCompositionFallbackRef: QueryEditorCoreStateApi['imeCompositionFallbackRef'];
    resolveSqlFieldDropPosition: QueryEditorDropAndLineEditsApi['resolveSqlFieldDropPosition'];
    updateSqlFieldDropPreview: QueryEditorDropAndLineEditsApi['updateSqlFieldDropPreview'];
    clearSqlFieldDropPreview: QueryEditorDropAndLineEditsApi['clearSqlFieldDropPreview'];
    handleSidebarObjectDrop: QueryEditorDropAndLineEditsApi['handleSidebarObjectDrop'];
    darkMode: QueryEditorConnectionContextApi['darkMode'];
    objectHoverActionRef: QueryEditorCoreStateApi['objectHoverActionRef'];
    showObjectInfoAtPosition: QueryEditorObjectDecorationsApi['showObjectInfoAtPosition'];
    triggerSqlAiCompletionFallbackApplyingRef: QueryEditorCoreStateApi['triggerSqlAiCompletionFallbackApplyingRef'];
    triggerSqlAiCompletionFallbackRef: QueryEditorCoreStateApi['triggerSqlAiCompletionFallbackRef'];
    triggerSqlAiCompletionAltGestureAtRef: QueryEditorCoreStateApi['triggerSqlAiCompletionAltGestureAtRef'];
    objectDecorationsDirtyRef: QueryEditorCoreStateApi['objectDecorationsDirtyRef'];
    cancelPendingObjectDecorationRefresh: QueryEditorObjectDecorationsApi['cancelPendingObjectDecorationRefresh'];
    cancelPendingSqlReferencedMetadataRefresh: QueryEditorObjectDecorationsApi['cancelPendingSqlReferencedMetadataRefresh'];
    refreshObjectDecorations: QueryEditorObjectDecorationsApi['refreshObjectDecorations'];
    sqlReferencedMetadataTimerRef: QueryEditorCoreStateApi['sqlReferencedMetadataTimerRef'];
    lastSqlReferencedMetadataKeyRef: QueryEditorCoreStateApi['lastSqlReferencedMetadataKeyRef'];
    metadataRetryPendingRef: QueryEditorCoreStateApi['metadataRetryPendingRef'];
    setQueryEditorMetadataReloadTick: QueryEditorCoreStateApi['setQueryEditorMetadataReloadTick'];
    scheduleObjectDecorationRefresh: QueryEditorObjectDecorationsApi['scheduleObjectDecorationRefresh'];
    setSqlReferencedMetadataKey: QueryEditorCoreStateApi['setSqlReferencedMetadataKey'];
    switchQueryContext: QueryEditorQueryContextApi['switchQueryContext'];
    addTab: QueryEditorConnectionContextApi['addTab'];
    tableNavigationContextRef: QueryEditorConnectionContextApi['tableNavigationContextRef'];
    tableNavigationActionInFlightRef: QueryEditorCoreStateApi['tableNavigationActionInFlightRef'];
    validateTableNavigationTarget: QueryEditorObjectDecorationsApi['validateTableNavigationTarget'];
    queryEditorMountedRef: QueryEditorCoreStateApi['queryEditorMountedRef'];
    missingTableMetadataKeysRef: QueryEditorCoreStateApi['missingTableMetadataKeysRef'];
    clearMissingTableNavigationMetadata: QueryEditorObjectDecorationsApi['clearMissingTableNavigationMetadata'];
    openDefinitionObjectEditTab: QueryEditorObjectEditTabsApi['openDefinitionObjectEditTab'];
    openTriggerObjectEditTab: QueryEditorObjectEditTabsApi['openTriggerObjectEditTab'];
    openRoutineObjectEditTab: QueryEditorObjectEditTabsApi['openRoutineObjectEditTab'];
    objectDecorationIdsRef: QueryEditorCoreStateApi['objectDecorationIdsRef'];
    triggerSqlAiCompletionActionRef: QueryEditorCoreStateApi['triggerSqlAiCompletionActionRef'];
    macFindWithSelectionGuardActionRef: QueryEditorCoreStateApi['macFindWithSelectionGuardActionRef'];
    triggerSqlAiCompletionKeydownDisposableRef: QueryEditorCoreStateApi['triggerSqlAiCompletionKeydownDisposableRef'];
    disposeQueryEditorAiContextMenuActions: QueryEditorAiAssistActionsApi['disposeQueryEditorAiContextMenuActions'];
    disposeSqlExecutionContextMenuActions: QueryEditorShortcutsAndSnippetsApi['disposeSqlExecutionContextMenuActions'];
    disposeTransformCaseContextMenuActions: QueryEditorShortcutsAndSnippetsApi['disposeTransformCaseContextMenuActions'];
    registerSqlExecutionContextMenuActions: QueryEditorShortcutsAndSnippetsApi['registerSqlExecutionContextMenuActions'];
    registerQueryEditorAiContextMenuActions: QueryEditorAiAssistActionsApi['registerQueryEditorAiContextMenuActions'];
    registerInsertSqlSnippetContextMenuAction: QueryEditorShortcutsAndSnippetsApi['registerInsertSqlSnippetContextMenuAction'];
    registerTransformCaseContextMenuActions: QueryEditorShortcutsAndSnippetsApi['registerTransformCaseContextMenuActions'];
    registerToggleLineCommentAction: QueryEditorDropAndLineEditsApi['registerToggleLineCommentAction'];
    registerTriggerSqlAiCompletionAction: QueryEditorAiCompletionTriggersApi['registerTriggerSqlAiCompletionAction'];
    runQueryShortcutBinding: QueryEditorShortcutsAndSnippetsApi['runQueryShortcutBinding'];
    activeShortcutPlatform: QueryEditorShortcutsAndSnippetsApi['activeShortcutPlatform'];
    runQueryActionRef: QueryEditorCoreStateApi['runQueryActionRef'];
    selectCurrentStatementShortcutBinding: QueryEditorShortcutsAndSnippetsApi['selectCurrentStatementShortcutBinding'];
    selectCurrentStatementActionRef: QueryEditorCoreStateApi['selectCurrentStatementActionRef'];
    handleSelectCurrentStatement: QueryEditorDropAndLineEditsApi['handleSelectCurrentStatement'];
    duplicateCurrentLineShortcutBinding: QueryEditorShortcutsAndSnippetsApi['duplicateCurrentLineShortcutBinding'];
    duplicateCurrentLineActionRef: QueryEditorCoreStateApi['duplicateCurrentLineActionRef'];
    handleDuplicateCurrentLine: QueryEditorDropAndLineEditsApi['handleDuplicateCurrentLine'];
    saveQueryActionRef: QueryEditorCoreStateApi['saveQueryActionRef'];
    saveQueryShortcutBinding: QueryEditorShortcutsAndSnippetsApi['saveQueryShortcutBinding'];
    saveQueryAsActionRef: QueryEditorCoreStateApi['saveQueryAsActionRef'];
    currentSavedQuery: QueryEditorQueryContextApi['currentSavedQuery'];
    saveQueryAsShortcutBinding: QueryEditorShortcutsAndSnippetsApi['saveQueryAsShortcutBinding'];
    findInEditorShortcutCombo: QueryEditorShortcutsAndSnippetsApi['findInEditorShortcutCombo'];
    findInEditorActionRef: QueryEditorCoreStateApi['findInEditorActionRef'];
    formatSqlShortcutBinding: QueryEditorShortcutsAndSnippetsApi['formatSqlShortcutBinding'];
    formatSqlActionRef: QueryEditorCoreStateApi['formatSqlActionRef'];
    refreshQueryEditorSlashCommandDefs: QueryEditorAiAssistActionsApi['refreshQueryEditorSlashCommandDefs'];
    toggleQueryResultsPanelShortcutBinding: QueryEditorShortcutsAndSnippetsApi['toggleQueryResultsPanelShortcutBinding'];
    toggleQueryResultsPanelActionRef: QueryEditorCoreStateApi['toggleQueryResultsPanelActionRef'];
    toggleResultPanelVisibility: QueryEditorExecutionStatusApi['toggleResultPanelVisibility'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    getCurrentQuery: QueryEditorDraftSyncApi['getCurrentQuery'];
}

export const useQueryEditorMonacoMount = ({
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
    registerToggleLineCommentAction, registerTriggerSqlAiCompletionAction, runQueryShortcutBinding,
    activeShortcutPlatform, runQueryActionRef, selectCurrentStatementShortcutBinding,
    selectCurrentStatementActionRef, handleSelectCurrentStatement,
    duplicateCurrentLineShortcutBinding, duplicateCurrentLineActionRef, handleDuplicateCurrentLine,
    saveQueryActionRef, saveQueryShortcutBinding, saveQueryAsActionRef, currentSavedQuery,
    saveQueryAsShortcutBinding, findInEditorShortcutCombo, findInEditorActionRef,
    formatSqlShortcutBinding, formatSqlActionRef, refreshQueryEditorSlashCommandDefs,
    toggleQueryResultsPanelShortcutBinding, toggleQueryResultsPanelActionRef,
    toggleResultPanelVisibility, currentDb, getCurrentQuery,
}: UseQueryEditorMonacoMountInput) => {
    const handleEditorBeforeMount: BeforeMount = (monaco) => {
        const languageId = 'elasticsearch-console';
        const isRegistered = monaco.languages.getLanguages?.().some((language: any) => language.id === languageId);
        if (!isRegistered) {
            monaco.languages.register({ id: languageId });
            monaco.languages.setLanguageConfiguration(languageId, {
                comments: { lineComment: '#' },
                brackets: [['{', '}'], ['[', ']']],
                autoClosingPairs: [
                    { open: '{', close: '}' },
                    { open: '[', close: ']' },
                    { open: '"', close: '"' },
                ],
            });
            monaco.languages.setMonarchTokensProvider(languageId, {
                tokenizer: {
                    root: [
                        [/^\s*(GET|POST|PUT|DELETE|HEAD)(\s+)(\/\S*)\s*$/, ['keyword', 'white', 'string']],
                        [/^\s*(#|\/\/).*$/, 'comment'],
                        [/"(?:\\.|[^"\\])*"(?=\s*:)/, 'type.identifier'],
                        [/"(?:\\.|[^"\\])*"/, 'string'],
                        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
                        [/\b(?:true|false|null)\b/, 'keyword'],
                        [/[{}\[\]]/, '@brackets'],
                    ],
                },
            });
        }
    };

    // Setup Autocomplete and Editor
    const handleEditorDidMount: OnMount = (editor, monaco) => {
        editorRef.current = editor;
        monacoRef.current = monaco;
        installQueryEditorViewStateMemory(
            tab.id,
            editor,
            restoredResultSessionRef.current?.editorViewState,
        );
        // CompletionItemLabel is rendered by Monaco's DOM suggest widget. Keep
        // the original string label for non-DOM adapters used by older hosts.
        const useStructuredCompletionLabel = typeof editor?.getDomNode?.()?.querySelector === 'function';

        const suggestController = editor.getContribution?.('editor.contrib.suggestController') as {
            widget?: { value?: { _details?: { widget?: { layout?: (width: number, height: number) => void } } } };
        } | null;
        installQueryEditorSuggestWidgetWidth(editor);
        const suggestDetailsWidget = suggestController?.widget?.value?._details?.widget;
        if (suggestDetailsWidget?.layout) {
            const originalSuggestDetailsLayout = suggestDetailsWidget.layout.bind(suggestDetailsWidget);
            suggestDetailsWidget.layout = (width: number, height: number) => {
                originalSuggestDetailsLayout(width, Math.max(height, QUERY_EDITOR_SQL_SNIPPET_SUGGEST_DETAIL_MIN_HEIGHT));
            };
        }
        lastEditorCursorPositionRef.current = normalizeEditorPosition(editor.getPosition?.());
        if (isActive) {
            setSharedActiveEditorModelUri(String(editor.getModel?.()?.uri?.toString?.() || ''));
        }

        const mountedModel = editor.getModel?.();
        if (mountedModel && typeof monaco?.editor?.setModelLanguage === 'function') {
            monaco.editor.setModelLanguage(mountedModel, queryEditorMonacoLanguage);
        }
        const mountedEditorOptions = buildQueryEditorMonacoOptions(
            isObjectEditQueryTab,
            wordWrapEnabled,
        );
        editor.updateOptions?.(isElasticsearchMode ? {
            ...mountedEditorOptions,
            quickSuggestions: false,
            suggestOnTriggerCharacters: false,
            inlineSuggest: { enabled: false },
        } : mountedEditorOptions);

        if (typeof editor.onContextMenu === 'function') {
            editor.onContextMenu(() => {
                decorateV2MonacoContextMenu();
                window.setTimeout(decorateV2MonacoContextMenu, 0);
                window.setTimeout(decorateV2MonacoContextMenu, 48);
                window.setTimeout(decorateV2MonacoContextMenu, 120);
            });
        }

        aiInlineGhostVisibleContextKeyRef.current = editor.createContextKey?.(
            QUERY_EDITOR_AI_INLINE_CONTEXT_KEY,
            false,
        ) || null;

        const {
            getEditorText, clearAiInlineGhostDecorations, clearAiInlineGhost,
            triggerStructuredSqlSuggest, didModelContentAcceptCurrentAiInlineGhost,
            buildInlineGhostEditorSnapshot, buildInlineGhostEditorSnapshotFromInsertedTextRemoval,
            recoverStrayManualSqlCompletionMarker, isInlineGhostSnapshotCurrent,
        } = createQueryEditorAiInlineGhostState({
            editor, aiInlineGhostTimerRef, aiInlineGhostDecorationIdsRef, aiInlineGhostRequestSeqRef,
            aiInlineGhostRef, aiInlineGhostVisibleContextKeyRef, aiInlineGhostOverlayRef, editorRef,
            monaco, connectionsRef, currentConnectionIdRef, syncQueryDraft,
        });

        const { requestAiInlineGhost, scheduleAiInlineGhost, repositionAiInlineGhost } = createQueryEditorAiInlineGhostActions({
            clearAiInlineGhost, aiInlineGhostRef, clearAiInlineGhostDecorations, editor,
            aiInlineGhostOverlayRef, monaco, aiInlineGhostVisibleContextKeyRef,
            isInlineGhostSnapshotCurrent, aiInlineGhostAcceptingRef, syncQueryDraft, editorRef,
            aiInlineGhostTimerRef, buildInlineGhostEditorSnapshot,
            recoverStrayManualSqlCompletionMarker, connectionsRef, currentConnectionIdRef,
            buildQueryEditorAiContext, inlineSqlMemoryEntries, aiInlineGhostRequestSeqRef,
            ensureQueryEditorAiContextMetadata, triggerStructuredSqlSuggest,
            triggerAiInlineCompletionRef, acceptAiInlineCompletionRef,
            acceptSqlAiCompletionKeydownDisposableRef, queryEditorActiveRef,
            acceptSqlAiCompletionBindingRef,
        });

        const { applyNavigationHoverState, syncModifierState, handleWindowBlur } = createQueryEditorNavigationHover({
            ctrlMetaPressedRef, editor, linkDecorationIdsRef, connectionsRef, currentConnectionIdRef,
            currentDbRef, visibleDbsRef, tablesRef, viewsRef, materializedViewsRef, triggersRef,
            routinesRef, sequencesRef, packagesRef, primaryShortcutModifierLabel, currentSchemaRef,
            monaco, lastHoverTargetPositionRef, lastEditorCursorPositionRef,
        });
        const {
            editorDomNode, clearImeCompositionFallbackTimer, handleImeCompositionStart,
            handleImeBeforeInput, handleImeCompositionEnd, handleEditorDragOver,
            handleEditorDragLeave, handleSqlFieldDragEnd, handleEditorDrop,
        } = createQueryEditorImeAndDropHandlers({
            editor, imeCompositionFallbackTimerRef, imeCompositionFallbackRef,
            lastEditorCursorPositionRef, monaco, getEditorText, editorRef, syncQueryDraft,
            resolveSqlFieldDropPosition, updateSqlFieldDropPreview, clearSqlFieldDropPreview,
            handleSidebarObjectDrop,
        });

        bindQueryEditorEditorEvents({
            monaco, darkMode, objectHoverActionRef, editor, lastHoverTargetPositionRef,
            showObjectInfoAtPosition, lastEditorCursorPositionRef, aiInlineGhostRef,
            clearAiInlineGhost, tab, currentConnectionIdRef, currentDbRef, queryEditorMonacoLanguage,
            triggerSqlAiCompletionFallbackApplyingRef, triggerSqlAiCompletionFallbackRef,
            triggerSqlAiCompletionAltGestureAtRef,
            buildInlineGhostEditorSnapshotFromInsertedTextRemoval, connectionsRef, syncQueryDraft,
            getEditorText, triggerAiInlineCompletionRef, objectDecorationsDirtyRef,
            cancelPendingObjectDecorationRefresh, cancelPendingSqlReferencedMetadataRefresh,
            imeCompositionFallbackTimerRef, clearImeCompositionFallbackTimer,
            refreshObjectDecorations, sqlReferencedMetadataTimerRef, editorRef, visibleDbsRef,
            lastSqlReferencedMetadataKeyRef, metadataRetryPendingRef,
            setQueryEditorMetadataReloadTick, scheduleObjectDecorationRefresh,
            setSqlReferencedMetadataKey, aiInlineGhostAcceptingRef,
            didModelContentAcceptCurrentAiInlineGhost, requestAiInlineGhost, scheduleAiInlineGhost,
            repositionAiInlineGhost, syncModifierState, applyNavigationHoverState,
            linkDecorationIdsRef, handleWindowBlur, handleSqlFieldDragEnd, editorDomNode,
            handleImeBeforeInput, handleImeCompositionStart, handleImeCompositionEnd,
            handleEditorDragOver, handleEditorDragLeave, handleEditorDrop,
        });

        bindQueryEditorMouseAndDispose({
            editor, ctrlMetaPressedRef, connectionsRef, currentConnectionIdRef, currentDbRef,
            visibleDbsRef, tablesRef, viewsRef, materializedViewsRef, triggersRef, routinesRef,
            sequencesRef, packagesRef, currentSchemaRef, switchQueryContext, addTab, tab,
            tableNavigationContextRef, tableNavigationActionInFlightRef, editorRef,
            validateTableNavigationTarget, queryEditorMountedRef, queryEditorActiveRef,
            missingTableMetadataKeysRef, clearMissingTableNavigationMetadata,
            lastHoverTargetPositionRef, linkDecorationIdsRef, openDefinitionObjectEditTab,
            openTriggerObjectEditTab, openRoutineObjectEditTab,
            cancelPendingSqlReferencedMetadataRefresh, cancelPendingObjectDecorationRefresh,
            objectDecorationIdsRef, clearSqlFieldDropPreview, objectHoverActionRef,
            triggerSqlAiCompletionActionRef, macFindWithSelectionGuardActionRef,
            triggerSqlAiCompletionKeydownDisposableRef, triggerAiInlineCompletionRef,
            acceptAiInlineCompletionRef, acceptSqlAiCompletionKeydownDisposableRef,
            disposeQueryEditorAiContextMenuActions, disposeSqlExecutionContextMenuActions,
            disposeTransformCaseContextMenuActions, syncModifierState, handleWindowBlur,
            handleSqlFieldDragEnd, clearImeCompositionFallbackTimer, editorDomNode,
            handleImeBeforeInput, handleImeCompositionStart, handleImeCompositionEnd,
            handleEditorDragOver, handleEditorDragLeave, handleEditorDrop,
        });

        registerQueryEditorKeyBindings({
            refreshObjectDecorations, registerSqlExecutionContextMenuActions, editor,
            registerQueryEditorAiContextMenuActions, registerInsertSqlSnippetContextMenuAction,
            registerTransformCaseContextMenuActions, registerToggleLineCommentAction,
            registerTriggerSqlAiCompletionAction, monaco, runQueryShortcutBinding,
            activeShortcutPlatform, runQueryActionRef, selectCurrentStatementShortcutBinding,
            selectCurrentStatementActionRef, handleSelectCurrentStatement,
            macFindWithSelectionGuardActionRef, duplicateCurrentLineShortcutBinding,
            duplicateCurrentLineActionRef, handleDuplicateCurrentLine, saveQueryActionRef,
            saveQueryShortcutBinding, saveQueryAsActionRef, currentSavedQuery, tab,
            saveQueryAsShortcutBinding, findInEditorShortcutCombo, findInEditorActionRef,
            formatSqlShortcutBinding, formatSqlActionRef, refreshQueryEditorSlashCommandDefs,
            toggleQueryResultsPanelShortcutBinding, toggleQueryResultsPanelActionRef,
            toggleResultPanelVisibility,
        });

        registerQueryEditorSqlLanguageProviders({
            monaco, currentDbRef, currentDb, tab, currentConnectionIdRef,
            useStructuredCompletionLabel,
        });
        bindQueryEditorSlashCommands({
            editor, connectionsRef, currentConnectionIdRef, getCurrentQuery, currentDbRef,
        });
    };
    return { handleEditorBeforeMount, handleEditorDidMount };
};

export type QueryEditorMonacoMountApi = ReturnType<typeof useQueryEditorMonacoMount>;
