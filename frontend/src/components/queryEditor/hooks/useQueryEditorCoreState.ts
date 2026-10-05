import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { message, Form, type InputRef } from 'antd';
import { useQueryEditorEverActive } from '../useQueryEditorEverActive';
import { useExternalSqlFileDrop } from '../useExternalSqlFileDrop';
import { useStore } from '../../../store';
import {
    getInitialEditorQuery,
    resolveNewQueryDefaultTemplate,
    getTabQueryValue,
    type CompletionTableMeta,
    type CompletionColumnMeta,
    type CompletionViewMeta,
    type CompletionSynonymMeta,
    type CompletionTriggerMeta,
    type CompletionRoutineMeta,
    type CompletionSequenceMeta,
    type CompletionPackageMeta,
} from '../QueryEditorHelpers';
import { isElasticsearchConnection } from '../../../utils/elasticsearchConsole';
import { buildQueryEditorMonacoOptions, type QueryEditorRunScope } from '../queryEditorRunHelpers';
import { takeQueryEditorResultSession } from '../../../utils/queryEditorResultSessionCache';
import {
    type QueryEditorResultSet,
    QUERY_EDITOR_SQL_LOG_TAB_KEY,
} from '../../QueryEditorResultsPanel';
import {
    applyQueryEditorResultHistoryBudget,
    QUERY_EDITOR_RESULT_HISTORY_MAX_RESULTS,
    QUERY_EDITOR_RESULT_HISTORY_MAX_ROWS,
    QUERY_EDITOR_RESULT_HISTORY_MAX_BYTES,
} from '../queryEditorResultHistory';
import { t as translate } from '../../../i18n';
import { useQueryEditorResultHistoryBudget } from '../useQueryEditorResultHistoryBudget';
import {
    useQueryExecutionElapsed,
    formatQueryExecutionElapsed,
    resolveQueryExecutionSpeedIcon,
    resolveReportedQueryDurationMs,
} from '../queryEditorExecutionTimer';
import { invokeAppWithSignal } from '../../../utils/webRpc';
import { CancelQuery } from '../../../../wailsjs/go/app/App';
import type {
    QueryEditorAiApplyMode,
    QueryEditorAiContext,
    QueryEditorAiEditorSnapshot,
} from '../QueryEditorAiAssist';
import type { ResultDiffSummary, ResultDiffColumnMeta } from '../../../utils/resultDiff/types';
import { useQueryEditorSqlErrorLocator } from '../useQueryEditorSqlErrorLocator';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorCoreStateInput {
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    tab: QueryEditorProps['tab'];
}

export const useQueryEditorCoreState = ({ isActive, tab }: UseQueryEditorCoreStateInput) => {
    const hasBeenActive = useQueryEditorEverActive(isActive);
    useExternalSqlFileDrop();
    const appearance = useStore(state => state.appearance);
    const queryOptions = useStore(state => state.queryOptions);
    const setQueryOptions = useStore(state => state.setQueryOptions);
    const wordWrapEnabled = queryOptions?.wordWrap === true;
    const [query, setQuery] = useState(() => {
        const initialConnection = useStore.getState().connections.find((connection) => connection.id === tab.connectionId);
        return getInitialEditorQuery(
            tab,
            isElasticsearchConnection(initialConnection?.config)
                ? ''
                : resolveNewQueryDefaultTemplate(appearance.newQuerySqlTemplate),
        );
    });
    const isExternalSQLFileTab = Boolean(String(tab.filePath || '').trim());
    const isObjectEditQueryTab = tab.type === 'query' && tab.queryMode === 'object-edit';
    const queryEditorMonacoOptions = useMemo(
        () => buildQueryEditorMonacoOptions(
            isObjectEditQueryTab,
            wordWrapEnabled,
        ),
        [isObjectEditQueryTab, wordWrapEnabled],
    );

    // Result Sets (session cache survives detach/attach remounts)
    const restoredResultSessionRef = useRef(takeQueryEditorResultSession(tab.id));
    // A restored session may predate the current history budget, so bound it on the
    // way in: the trimmed set is what the editor mounts with, not just what it saves.
    const restoredResultHistoryRef = useRef<{
        resultSets: QueryEditorResultSet[];
        evictedKeys: string[];
    } | null>(null);
    if (restoredResultHistoryRef.current === null) {
        const restoredActiveKey = restoredResultSessionRef.current?.activeResultKey || '';
        restoredResultHistoryRef.current = applyQueryEditorResultHistoryBudget(
            restoredResultSessionRef.current?.resultSets || [],
            restoredActiveKey ? [restoredActiveKey] : [],
        );
    }
    const [resultSets, setResultSets] = useState<QueryEditorResultSet[]>(
      () => restoredResultHistoryRef.current?.resultSets || [],
    );
    const [activeResultKey, setActiveResultKey] = useState<string>(
      () => {
          const restoredActiveKey = restoredResultSessionRef.current?.activeResultKey || '';
          const restoredResults = restoredResultHistoryRef.current?.resultSets || [];
          return restoredResults.some((result) => result.key === restoredActiveKey)
              ? restoredActiveKey
              : restoredResults[0]?.key || '';
      },
    );
    const [resultDataPreviewRequest, setResultDataPreviewRequest] = useState<{
        resultKey: string;
        requestId: string;
    } | null>(null);
    // ES 结果 table/raw 视图模式：提升到编辑器层，结果面板因隐藏/全屏重挂时不丢失。
    const [elasticsearchViewModes, setElasticsearchViewModes] = useState<Record<string, 'table' | 'raw'>>({});
    const handleElasticsearchViewModeChange = useCallback((key: string, mode: 'table' | 'raw') => {
        setElasticsearchViewModes((current) => ({ ...current, [key]: mode }));
    }, []);
    const resultSetsRef = useRef(resultSets);
    const activeResultKeyRef = useRef(activeResultKey);
    // 参数面板可用性快照：监听器闭包内不能读 paramsState（effect 不随分析刷新，
    // 陈旧闭包会让快捷键误关未查看的结果 tab），与 isResultPanelVisibleRef 同模式。
    const paramsPanelAvailableRef = useRef(false);
    const nativeRestoredResultRefs = useRef(new Map<
      string,
      { resultKey: string; result: QueryEditorResultSet }
    >());
    resultSetsRef.current = resultSets;
    activeResultKeyRef.current = activeResultKey;
    const notifyResultHistoryTrimmed = useCallback(() => {
        void message.info(translate('query_editor.results_panel.message.history_trimmed', {
            results: QUERY_EDITOR_RESULT_HISTORY_MAX_RESULTS,
            rows: QUERY_EDITOR_RESULT_HISTORY_MAX_ROWS,
            size: Math.round(QUERY_EDITOR_RESULT_HISTORY_MAX_BYTES / 1024 / 1024),
        }));
    }, []);
    useEffect(() => {
        if ((restoredResultHistoryRef.current?.evictedKeys.length || 0) === 0) return;
        notifyResultHistoryTrimmed();
    }, [notifyResultHistoryTrimmed]);
    useQueryEditorResultHistoryBudget({
        resultSets,
        protectedActiveKey: activeResultKey === QUERY_EDITOR_SQL_LOG_TAB_KEY ? '' : activeResultKey,
        resultSetsRef,
        setResultSets,
        onTrimmed: notifyResultHistoryTrimmed,
    });
    const [loading, setLoading] = useState(false);
    const [queryEditorMetadataReloadTick, setQueryEditorMetadataReloadTick] = useState(0);
    // 事件驱动的结构变更重载必须绕过 fetchKey 去重（服务端结构可能已变，前端无从感知）
    const queryEditorMetadataForceReloadRef = useRef(false);
    const [queryContextLockRunSeq, setQueryContextLockRunSeq] = useState(0);
    const queryContextLockRunSeqRef = useRef(0);
    const lockQueryContextForRun = useCallback((runSeq: number) => {
        queryContextLockRunSeqRef.current = runSeq;
        setQueryContextLockRunSeq(runSeq);
    }, []);
    const unlockQueryContextForRun = useCallback((runSeq: number) => {
        if (queryContextLockRunSeqRef.current !== runSeq) return;
        queryContextLockRunSeqRef.current = 0;
        setQueryContextLockRunSeq(0);
    }, []);
    const [executionRunToken, setExecutionRunToken] = useState(0);
    const [executionTimingActive, setExecutionTimingActive] = useState(false);
    const [completedExecutionElapsedMs, setCompletedExecutionElapsedMs] = useState<number | null>(null);
    const executionAwaitingDriverRef = useRef(false);
    const executionElapsedMs = useQueryExecutionElapsed(
        executionTimingActive && loading,
        executionRunToken,
        completedExecutionElapsedMs,
        executionAwaitingDriverRef,
    );
    const executionElapsedText = formatQueryExecutionElapsed(executionElapsedMs);
    const executionElapsedLabel = translate('query_editor.execution.elapsed', {
        duration: executionElapsedText,
    });
    const executionSpeedIcon = resolveQueryExecutionSpeedIcon(executionElapsedMs);
    const beginQueryEditorRunClock = useCallback((runSeq: number) => {
        setExecutionRunToken(runSeq);
        setExecutionTimingActive(false);
        setCompletedExecutionElapsedMs(null);
    }, []);
    const finishQueryEditorSqlClock = useCallback((
        result: { durationMs?: unknown } | null | undefined,
        startedAt: number,
    ) => {
        const durationMs = resolveReportedQueryDurationMs(result, Date.now() - startedAt);
        setExecutionTimingActive(false);
        setCompletedExecutionElapsedMs(durationMs);
        return durationMs;
    }, []);
    const [executionError, setExecutionError] = useState<string>('');
    // 渲染期同步最新执行错误，keydown 监听从 ref 读取，避免每次执行后重注册监听。
    const executionErrorRef = useRef('');
    executionErrorRef.current = executionError;
    const [currentQueryId, setCurrentQueryId] = useState<string>('');
    const [isSqlSnippetPickerOpen, setIsSqlSnippetPickerOpen] = useState(false);
    const [isDuckDBAttachPickerOpen, setIsDuckDBAttachPickerOpen] = useState(false);
    const [sqlSnippetPickerKeyword, setSqlSnippetPickerKeyword] = useState('');
    const runSeqRef = useRef(0);
    const currentQueryIdRef = useRef('');
    const rpcLostWithoutResultRef = useRef(false);
    const queryEditorUnmountedRef = useRef(false);
    const requestScopedRPCControllersRef = useRef(new Set<AbortController>());
    const invokeRequestScopedApp = useCallback(<T,>(
        method: string,
        args: unknown[],
        fallback: () => Promise<T>,
    ): Promise<T> => {
        const controller = new AbortController();
        requestScopedRPCControllersRef.current.add(controller);
        return invokeAppWithSignal(method, args, controller.signal, fallback)
            .finally(() => requestScopedRPCControllersRef.current.delete(controller));
    }, []);
    useEffect(() => () => {
        requestScopedRPCControllersRef.current.forEach((controller) => controller.abort());
        requestScopedRPCControllersRef.current.clear();
    }, []);
    useEffect(() => {
        queryEditorUnmountedRef.current = false;
        return () => {
            queryEditorUnmountedRef.current = true;
            // A managed DML run receives its query ID before the RPC can expose a
            // transaction ID. Cancel by that ID when the tab disappears so the
            // backend can stop the in-flight statement and roll it back.
            runSeqRef.current += 1;
            const queryId = currentQueryIdRef.current;
            currentQueryIdRef.current = '';
            if (queryId) {
                void Promise.resolve(CancelQuery(queryId)).catch(() => undefined);
            }
        };
    }, []);
    const resultTotalCountSeqRef = useRef(0);
    const resultTotalCountRequestsRef = useRef<Record<string, { sequence: number; queryId: string }>>({});
    const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
    const [saveModalMode, setSaveModalMode] = useState<'save' | 'saveAs' | 'rename'>('save');
    const [saveForm] = Form.useForm();
    const saveQueryNameInputRef = useRef<InputRef>(null);

    // Database Selection
    const [currentConnectionId, setCurrentConnectionId] = useState<string>(tab.connectionId);
    const [currentDb, setCurrentDb] = useState<string>(tab.dbName || '');
    const [currentSchema, setCurrentSchema] = useState<string>(String(tab.schemaName || '').trim());
    const [schemaList, setSchemaList] = useState<string[]>([]);
    const [schemaLoading, setSchemaLoadingState] = useState(false);
    const schemaLoadingRef = useRef(false);
    const setSchemaLoading = useCallback((nextLoading: boolean) => {
        schemaLoadingRef.current = nextLoading;
        setSchemaLoadingState(nextLoading);
    }, []);
    const resultTotalCountContextRef = useRef(
        `${tab.connectionId}\u0000${tab.dbName || ''}\u0000${tab.schemaName || ''}`,
    );
    const [dbList, setDbList] = useState<string[]>([]);
    const [isTextToSqlModalOpen, setIsTextToSqlModalOpen] = useState(false);
    const [textToSqlInstruction, setTextToSqlInstruction] = useState('');
    const [textToSqlApplyMode, setTextToSqlApplyMode] = useState<QueryEditorAiApplyMode>('insert');
    const [textToSqlGenerating, setTextToSqlGenerating] = useState(false);
    const [resultDiffWizardOpen, setResultDiffWizardOpen] = useState(false);
    const [resultDiffAnchorKey, setResultDiffAnchorKey] = useState<string>('');
    const [resultDiffSession, setResultDiffSession] = useState<{
      jobId: string;
      summary: ResultDiffSummary;
      leftLabel: string;
      rightLabel: string;
      columnMeta?: Record<string, ResultDiffColumnMeta>;
    } | null>(null);
    const [viewDataVerifyOpen, setViewDataVerifyOpen] = useState(false);

    // Resizing state
    const [editorHeight, setEditorHeight] = useState(300);
    const editorStageRef = useRef<HTMLDivElement | null>(null);
    const editorShellRef = useRef<HTMLDivElement | null>(null);
    const editorRef = useRef<any>(null);
    const monacoRef = useRef<any>(null);
    const handleRunRef = useRef<((scope?: QueryEditorRunScope) => Promise<void>) | null>(null);
    const pendingRunAfterSchemaLoadRef = useRef(false);
    const deferredContextRunSeqRef = useRef(0);
    const runQueryActionRef = useRef<any>(null);
    const sqlExecutionContextMenuActionDisposablesRef = useRef<any[]>([]);
    const selectCurrentStatementActionRef = useRef<any>(null);
    const macFindWithSelectionGuardActionRef = useRef<any>(null);
    const duplicateCurrentLineActionRef = useRef<any>(null);
    const toggleLineCommentActionRef = useRef<any>(null);
    const saveQueryActionRef = useRef<any>(null);
    const saveQueryAsActionRef = useRef<any>(null);
    const findInEditorActionRef = useRef<any>(null);
    const formatSqlActionRef = useRef<any>(null);
    const triggerSqlAiCompletionActionRef = useRef<any>(null);
    const triggerSqlAiCompletionKeydownDisposableRef = useRef<any>(null);
    const acceptSqlAiCompletionKeydownDisposableRef = useRef<any>(null);
    const insertSqlSnippetActionRef = useRef<any>(null);
    const transformCaseActionDisposablesRef = useRef<any[]>([]);
    const aiContextMenuActionDisposablesRef = useRef<any[]>([]);
    const toggleQueryResultsPanelActionRef = useRef<any>(null);
    const lastExternalQueryRef = useRef<string>(getTabQueryValue(tab));
    const lastLocalQueryRef = useRef<string>(query);
    const saveOperationQueueRef = useRef<Promise<unknown>>(Promise.resolve());
    const queryEditorMountedRef = useRef(true);
    const imeCompositionFallbackRef = useRef<{
        editor: any;
        valueBefore: string;
        selectionBefore: any;
        positionBefore: { lineNumber: number; column: number } | null;
        committedText: string;
    } | null>(null);
    const imeCompositionFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastEditorCursorPositionRef = useRef<any>(null);
    const lastHoverTargetPositionRef = useRef<{ lineNumber: number; column: number } | null>(null);
    const lastExecutedEditorQueryRef = useRef<string>('');
    const { recordExecutionOrigin, locateExecutionError, resolveExecutionErrorStatement } = useQueryEditorSqlErrorLocator(editorRef);
    const linkDecorationIdsRef = useRef<string[]>([]);
    const ctrlMetaPressedRef = useRef(false);
    const objectDecorationIdsRef = useRef<string[]>([]);
    const sqlFieldDropDecorationIdsRef = useRef<string[]>([]);
    const aiInlineGhostDecorationIdsRef = useRef<string[]>([]);
    const aiInlineGhostOverlayRef = useRef<HTMLSpanElement | null>(null);
    const aiInlineGhostVisibleContextKeyRef = useRef<any>(null);
    const aiInlineGhostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const aiInlineGhostRequestSeqRef = useRef(0);
    const triggerAiInlineCompletionRef = useRef<(() => void) | null>(null);
    const acceptAiInlineCompletionRef = useRef<(() => boolean) | null>(null);
    const acceptSqlAiCompletionBindingRef = useRef<{ combo: string; enabled: boolean }>({ combo: '', enabled: false });
    const queryEditorActiveRef = useRef(false);
    const aiContextMetadataWarmupRef = useRef<Record<string, Promise<boolean> | undefined>>({});
    const incompleteColumnMetadataDbsRef = useRef<Set<string>>(new Set());
    const aiContextCacheRef = useRef<{ deps: unknown[]; value: QueryEditorAiContext } | null>(null);
    const triggerSqlAiCompletionAltPressedRef = useRef(false);
    const triggerSqlAiCompletionAltGestureAtRef = useRef(0);
    const triggerSqlAiCompletionFallbackRef = useRef<{ observedAt: number } | null>(null);
    const triggerSqlAiCompletionFallbackApplyingRef = useRef(false);
    const aiInlineGhostRef = useRef<{
        insertText: string;
        editText: string;
        replacePrefixLength: number;
        modelUri: string;
        position: { lineNumber: number; column: number };
        snapshot: QueryEditorAiEditorSnapshot;
    } | null>(null);
    const aiInlineGhostAcceptingRef = useRef(false);
    const objectHoverActionRef = useRef<any>(null);
    const dragRef = useRef<{ startY: number, startHeight: number, currentHeight: number } | null>(null);
    const pendingEditorHeightRef = useRef(editorHeight);
    const resizeFrameRef = useRef<number | null>(null);
    const queryEditorRootRef = useRef<HTMLDivElement | null>(null);
    const editorPaneRef = useRef<HTMLDivElement | null>(null);
    const tablesRef = useRef<CompletionTableMeta[]>([]); // Store tables for autocomplete (cross-db)
    const metadataGenerationRef = useRef(0);
    const missingTableMetadataKeysRef = useRef<Set<string>>(new Set());
    const tableNavigationValidationInFlightRef = useRef<
        Record<string, Promise<boolean | null> | undefined>
    >({});
    const tableNavigationActionInFlightRef = useRef<Record<string, Promise<void> | undefined>>({});
    const queryTableLocateCycleRef = useRef<{ lineNumber: number; signature: string; index: number } | null>(null);
    const allColumnsRef = useRef<CompletionColumnMeta[]>([]); // Store all columns (cross-db)
    const viewsRef = useRef<CompletionViewMeta[]>([]);
    const materializedViewsRef = useRef<CompletionViewMeta[]>([]);
    const synonymsRef = useRef<CompletionSynonymMeta[]>([]);
    const triggersRef = useRef<CompletionTriggerMeta[]>([]);
    const routinesRef = useRef<CompletionRoutineMeta[]>([]);
    const sequencesRef = useRef<CompletionSequenceMeta[]>([]);
    const packagesRef = useRef<CompletionPackageMeta[]>([]);
    const visibleDbsRef = useRef<string[]>([]); // Store visible databases for cross-db intellisense
    const metadataFetchKeyRef = useRef<string>('');
    const metadataContextKeyRef = useRef<string>('');
    const metadataContextConnectionConfigRef = useRef<unknown>(undefined);
    /** SQL 中引用到的库集合变化时触发跨库元数据补拉（供超链接/补全） */
    const [sqlReferencedMetadataKey, setSqlReferencedMetadataKey] = useState('');
    const sqlReferencedMetadataTimerRef = useRef<number | null>(null);
    const lastSqlReferencedMetadataKeyRef = useRef('');
    const metadataRetryPendingRef = useRef(false);
    const objectDecorationIdleCallbackRef = useRef<number | null>(null);
    const objectDecorationFallbackTimerRef = useRef<number | null>(null);
    const objectDecorationRefreshSeqRef = useRef(0);
    const objectDecorationsDirtyRef = useRef(true);
    return {
        hasBeenActive, appearance, queryOptions, setQueryOptions, wordWrapEnabled, query, setQuery,
        isExternalSQLFileTab, isObjectEditQueryTab, queryEditorMonacoOptions,
        restoredResultSessionRef, resultSets, setResultSets, activeResultKey, setActiveResultKey,
        resultDataPreviewRequest, setResultDataPreviewRequest, elasticsearchViewModes,
        handleElasticsearchViewModeChange, resultSetsRef, activeResultKeyRef,
        paramsPanelAvailableRef, nativeRestoredResultRefs, loading, setLoading,
        queryEditorMetadataReloadTick, setQueryEditorMetadataReloadTick,
        queryEditorMetadataForceReloadRef, queryContextLockRunSeq, queryContextLockRunSeqRef,
        lockQueryContextForRun, unlockQueryContextForRun, executionTimingActive,
        setExecutionTimingActive, executionAwaitingDriverRef, executionElapsedText,
        executionElapsedLabel, executionSpeedIcon, beginQueryEditorRunClock,
        finishQueryEditorSqlClock, executionError, setExecutionError, executionErrorRef,
        currentQueryId, setCurrentQueryId, isSqlSnippetPickerOpen, setIsSqlSnippetPickerOpen,
        isDuckDBAttachPickerOpen, setIsDuckDBAttachPickerOpen, sqlSnippetPickerKeyword,
        setSqlSnippetPickerKeyword, runSeqRef, currentQueryIdRef, rpcLostWithoutResultRef,
        queryEditorUnmountedRef, invokeRequestScopedApp, resultTotalCountSeqRef,
        resultTotalCountRequestsRef, isSaveModalOpen, setIsSaveModalOpen, saveModalMode,
        setSaveModalMode, saveForm, saveQueryNameInputRef, currentConnectionId,
        setCurrentConnectionId, currentDb, setCurrentDb, currentSchema, setCurrentSchema,
        schemaList, setSchemaList, schemaLoading, schemaLoadingRef, setSchemaLoading,
        resultTotalCountContextRef, dbList, setDbList, isTextToSqlModalOpen,
        setIsTextToSqlModalOpen, textToSqlInstruction, setTextToSqlInstruction, textToSqlApplyMode,
        setTextToSqlApplyMode, textToSqlGenerating, setTextToSqlGenerating, resultDiffWizardOpen,
        setResultDiffWizardOpen, resultDiffAnchorKey, setResultDiffAnchorKey, resultDiffSession,
        setResultDiffSession, viewDataVerifyOpen, setViewDataVerifyOpen, editorHeight,
        setEditorHeight, editorStageRef, editorShellRef, editorRef, monacoRef, handleRunRef,
        pendingRunAfterSchemaLoadRef, deferredContextRunSeqRef, runQueryActionRef,
        sqlExecutionContextMenuActionDisposablesRef, selectCurrentStatementActionRef,
        macFindWithSelectionGuardActionRef, duplicateCurrentLineActionRef,
        toggleLineCommentActionRef, saveQueryActionRef, saveQueryAsActionRef, findInEditorActionRef,
        formatSqlActionRef, triggerSqlAiCompletionActionRef,
        triggerSqlAiCompletionKeydownDisposableRef, acceptSqlAiCompletionKeydownDisposableRef,
        insertSqlSnippetActionRef, transformCaseActionDisposablesRef,
        aiContextMenuActionDisposablesRef, toggleQueryResultsPanelActionRef, lastExternalQueryRef,
        lastLocalQueryRef, saveOperationQueueRef, queryEditorMountedRef, imeCompositionFallbackRef,
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
    };
};

export type QueryEditorCoreStateApi = ReturnType<typeof useQueryEditorCoreState>;
