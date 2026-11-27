import { useCallback, useRef } from 'react';
import {
    type QueryEditorExecutionLifecycleState,
    buildQueryEditorLifecycleAffectedRowsResult,
    createIdleQueryEditorExecutionLifecycle,
    queryEditorExecutionTimerStatusI18nKey,
} from '../queryEditorExecutionLifecycle';
import {
    formatQueryExecutionElapsed,
    resolveQueryExecutionLifecycleTimerHint,
    resolveQueryExecutionSpeedIcon,
    shouldShowQueryExecutionElapsed,
    useQueryExecutionElapsed,
} from '../queryEditorExecutionTimer';
import {
    type QueryEditorResultSet,
    QUERY_EDITOR_SQL_LOG_TAB_KEY,
} from '../../QueryEditorResultsPanel';
import { t as translate } from '../../../i18n';
import { useQueryEditorExecutionLifecycle } from '../useQueryEditorExecutionLifecycle';
import { useQueryEditorTabExecutionBroadcast } from '../queryEditorTabExecutionState';
import { SQL_EDITOR_AUTO_COMMIT_DELAY_OPTIONS } from '../../QueryEditorTransactionSettings';
import { useSqlEditorTransactionController } from '../../useSqlEditorTransactionController';
import { useAutoFetchVisibility } from '../../../utils/autoFetchVisibility';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorProps } from '../../QueryEditor';
import type { SqlEditorCommitMode } from '../../QueryEditorTransactionSettings';

const IDLE_QUERY_EDITOR_EXECUTION_LIFECYCLE = createIdleQueryEditorExecutionLifecycle();

export interface UseQueryEditorExecutionStatusInput {
    tab: QueryEditorProps['tab'];
    isResultPanelVisibleRef: QueryEditorConnectionContextApi['isResultPanelVisibleRef'];
    setIsResultPanelVisible: QueryEditorConnectionContextApi['setIsResultPanelVisible'];
    updateQueryTabDraft: QueryEditorConnectionContextApi['updateQueryTabDraft'];
    rpcLostWithoutResultRef: QueryEditorCoreStateApi['rpcLostWithoutResultRef'];
    setLoading: QueryEditorCoreStateApi['setLoading'];
    setExecutionTimingActive: QueryEditorCoreStateApi['setExecutionTimingActive'];
    setExecutionError: QueryEditorCoreStateApi['setExecutionError'];
    setResultSets: QueryEditorCoreStateApi['setResultSets'];
    currentQueryId: QueryEditorCoreStateApi['currentQueryId'];
    currentQueryIdRef: QueryEditorCoreStateApi['currentQueryIdRef'];
    loading: QueryEditorCoreStateApi['loading'];
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    isElasticsearchMode: QueryEditorConnectionContextApi['isElasticsearchMode'];
    executionRunToken: QueryEditorCoreStateApi['executionRunToken'];
    executionTimingActive: QueryEditorCoreStateApi['executionTimingActive'];
    completedExecutionElapsedMs: QueryEditorCoreStateApi['completedExecutionElapsedMs'];
    editorRef: QueryEditorCoreStateApi['editorRef'];
    isResultPanelVisible: QueryEditorConnectionContextApi['isResultPanelVisible'];
    activeResultKey: QueryEditorCoreStateApi['activeResultKey'];
    setActiveResultKey: QueryEditorCoreStateApi['setActiveResultKey'];
    sqlEditorTransactionOptions: QueryEditorConnectionContextApi['sqlEditorTransactionOptions'];
    showSqlExecutionLog: boolean;
    setShowSqlExecutionLog: (enabled: boolean) => void;
}

export const useQueryEditorExecutionStatus = ({
    tab, isResultPanelVisibleRef, setIsResultPanelVisible, updateQueryTabDraft,
    rpcLostWithoutResultRef, setLoading, setExecutionTimingActive, setExecutionError, setResultSets,
    currentQueryId, currentQueryIdRef, loading, isActive, isElasticsearchMode,
    executionRunToken, executionTimingActive, completedExecutionElapsedMs, editorRef,
    isResultPanelVisible, activeResultKey, setActiveResultKey, sqlEditorTransactionOptions,
    showSqlExecutionLog, setShowSqlExecutionLog,
}: UseQueryEditorExecutionStatusInput) => {
    const updateResultPanelVisibility = useCallback((visible: boolean) => {
        isResultPanelVisibleRef.current = visible;
        setIsResultPanelVisible(visible);
        updateQueryTabDraft(tab.id, { resultPanelVisible: visible });
    }, [tab.id, updateQueryTabDraft]);
    const handleExecutionLifecycleTerminal = useCallback((state: QueryEditorExecutionLifecycleState) => {
        if (!rpcLostWithoutResultRef.current) {
            return;
        }
        rpcLostWithoutResultRef.current = false;
        setLoading(false);
        setExecutionTimingActive(false);
        const affectedResult = buildQueryEditorLifecycleAffectedRowsResult('', state);
        if (affectedResult) {
            setExecutionError('');
            updateResultPanelVisibility(true);
            setResultSets([affectedResult as QueryEditorResultSet]);
            return;
        }
        if (state.status === 'error' || state.outcomeUnknown || state.status === 'cancelled') {
            updateResultPanelVisibility(true);
            setExecutionError(state.message || translate(
                state.outcomeUnknown
                    ? 'query_editor.execution.outcome_unknown'
                    : 'query_editor.result.execution_failed',
            ));
        }
    }, [updateResultPanelVisibility]);
    const executionLifecycle = useQueryEditorExecutionLifecycle({
        queryId: currentQueryId,
        queryIdRef: currentQueryIdRef,
        loading,
        onTerminal: handleExecutionLifecycleTerminal,
    });
    useQueryEditorTabExecutionBroadcast(tab.id, loading, executionLifecycle.status, isActive);
    const executionLifecycleRef = useRef(executionLifecycle);
    executionLifecycleRef.current = executionLifecycle;
    // 新一轮执行尚未分配 queryId 或还残留上一轮终态时，先收口为空闲态，避免旧耗时或旧状态闪现。
    const effectiveExecutionLifecycle = loading && (
        !currentQueryId
        || (executionLifecycle.queryId !== '' && executionLifecycle.queryId !== currentQueryId)
    )
        ? IDLE_QUERY_EDITOR_EXECUTION_LIFECYCLE
        : executionLifecycle;
    const executionLifecycleTimerHint = resolveQueryExecutionLifecycleTimerHint(effectiveExecutionLifecycle);
    const executionElapsedMs = useQueryExecutionElapsed(
        executionTimingActive && loading,
        executionRunToken,
        completedExecutionElapsedMs,
        executionLifecycleTimerHint,
    );
    const executionElapsedText = formatQueryExecutionElapsed(executionElapsedMs);
    const showExecutionElapsed = shouldShowQueryExecutionElapsed({
        loading,
        timingActive: executionTimingActive,
        completedElapsedMs: completedExecutionElapsedMs,
        elapsedMs: executionElapsedMs,
        lifecycleHint: executionLifecycleTimerHint,
        awaitBackendEvents: !isElasticsearchMode,
    });
    const executionElapsedLabel = translate('query_editor.execution.elapsed', {
        duration: executionElapsedText,
    });
    const executionSpeedIcon = resolveQueryExecutionSpeedIcon(executionElapsedMs);
    const executionStatusKey = queryEditorExecutionTimerStatusI18nKey(
        executionTimingActive && loading,
        effectiveExecutionLifecycle,
        loading,
    );
    const executionStatusText = executionStatusKey ? translate(executionStatusKey) : '';
    const toggleResultPanelVisibility = useCallback(() => {
        const nextVisible = !isResultPanelVisibleRef.current;
        isResultPanelVisibleRef.current = nextVisible;
        setIsResultPanelVisible(nextVisible);
        updateQueryTabDraft(tab.id, { resultPanelVisible: nextVisible });
    }, [tab.id, updateQueryTabDraft]);
    const handleOpenEditorFind = useCallback(() => {
        const editor = editorRef.current;
        if (!editor) {
            return;
        }

        editor.focus?.();
        try {
            const findAction = editor.getAction?.('actions.find');
            if (findAction?.run) {
                void findAction.run();
                return;
            }
        } catch {
            // Fall back to Monaco's built-in command id if the action lookup fails.
        }

        editor.trigger?.('keyboard', 'actions.find', null);
    }, []);
    const handleShowSqlExecutionLog = useCallback((mode: 'open' | 'toggle' = 'toggle') => {
        if (!isActive) {
            return;
        }
        if (mode !== 'open' && isResultPanelVisible && activeResultKey === QUERY_EDITOR_SQL_LOG_TAB_KEY) {
            updateResultPanelVisibility(false);
            return;
        }
        // 日志标签关闭时，任何「显示日志」入口都先把标签重新打开。
        if (!showSqlExecutionLog) {
            setShowSqlExecutionLog(true);
        }
        updateResultPanelVisibility(true);
        setActiveResultKey(QUERY_EDITOR_SQL_LOG_TAB_KEY);
    }, [activeResultKey, isActive, isResultPanelVisible, setShowSqlExecutionLog, showSqlExecutionLog, updateResultPanelVisibility]);
    const sqlEditorCommitMode: SqlEditorCommitMode = sqlEditorTransactionOptions?.commitMode === 'auto' ? 'auto' : 'manual';
    const sqlEditorAutoCommitDelayMs = SQL_EDITOR_AUTO_COMMIT_DELAY_OPTIONS.some((item) => item.value === sqlEditorTransactionOptions?.autoCommitDelayMs)
        ? Number(sqlEditorTransactionOptions?.autoCommitDelayMs)
        : 0;
    const {
        activatePendingSqlTransaction,
        appendPendingSqlTransactionExecution,
        autoCommitRemainingSeconds: sqlEditorAutoCommitRemainingSeconds,
        finishPendingSqlTransaction,
        pendingSqlTransaction,
        pendingSqlTransactionRef,
    } = useSqlEditorTransactionController({
        tabId: tab.id,
        translate: (key, params) => translate(key, params),
    });
    const handleFinishPendingSqlTransaction = useCallback(async (action: 'commit' | 'rollback') => {
        await finishPendingSqlTransaction(action, 'manual');
        handleShowSqlExecutionLog('open');
    }, [finishPendingSqlTransaction, handleShowSqlExecutionLog]);
    const autoFetchVisible = useAutoFetchVisibility();
    return {
        updateResultPanelVisibility, executionLifecycle, executionLifecycleRef, executionStatusText,
        executionElapsedText, showExecutionElapsed, executionElapsedLabel, executionSpeedIcon,
        toggleResultPanelVisibility, handleOpenEditorFind, handleShowSqlExecutionLog,
        sqlEditorCommitMode, sqlEditorAutoCommitDelayMs, activatePendingSqlTransaction,
        appendPendingSqlTransactionExecution, sqlEditorAutoCommitRemainingSeconds,
        pendingSqlTransaction, pendingSqlTransactionRef, handleFinishPendingSqlTransaction,
        autoFetchVisible,
    };
};

export type QueryEditorExecutionStatusApi = ReturnType<typeof useQueryEditorExecutionStatus>;
