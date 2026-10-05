import { useCallback, useRef } from 'react';
import {
    type QueryEditorExecutionLifecycleState,
    buildQueryEditorLifecycleAffectedRowsResult,
    isQueryEditorAwaitingDriver,
    queryEditorExecutionTimerStatusI18nKey,
} from '../queryEditorExecutionLifecycle';
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
    loading: QueryEditorCoreStateApi['loading'];
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    executionAwaitingDriverRef: QueryEditorCoreStateApi['executionAwaitingDriverRef'];
    executionTimingActive: QueryEditorCoreStateApi['executionTimingActive'];
    editorRef: QueryEditorCoreStateApi['editorRef'];
    isResultPanelVisible: QueryEditorConnectionContextApi['isResultPanelVisible'];
    activeResultKey: QueryEditorCoreStateApi['activeResultKey'];
    setActiveResultKey: QueryEditorCoreStateApi['setActiveResultKey'];
    sqlEditorTransactionOptions: QueryEditorConnectionContextApi['sqlEditorTransactionOptions'];
}

export const useQueryEditorExecutionStatus = ({
    tab, isResultPanelVisibleRef, setIsResultPanelVisible, updateQueryTabDraft,
    rpcLostWithoutResultRef, setLoading, setExecutionTimingActive, setExecutionError, setResultSets,
    currentQueryId, loading, isActive, executionAwaitingDriverRef, executionTimingActive, editorRef,
    isResultPanelVisible, activeResultKey, setActiveResultKey, sqlEditorTransactionOptions,
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
        loading,
        onTerminal: handleExecutionLifecycleTerminal,
    });
    useQueryEditorTabExecutionBroadcast(tab.id, loading, executionLifecycle.status, isActive);
    const executionLifecycleRef = useRef(executionLifecycle);
    executionLifecycleRef.current = executionLifecycle;
    executionAwaitingDriverRef.current = isQueryEditorAwaitingDriver(executionLifecycle);
    const executionStatusKey = queryEditorExecutionTimerStatusI18nKey(executionTimingActive && loading, executionLifecycle);
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
        updateResultPanelVisibility(true);
        setActiveResultKey(QUERY_EDITOR_SQL_LOG_TAB_KEY);
    }, [activeResultKey, isActive, isResultPanelVisible, updateResultPanelVisibility]);
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
        toggleResultPanelVisibility, handleOpenEditorFind, handleShowSqlExecutionLog,
        sqlEditorCommitMode, sqlEditorAutoCommitDelayMs, activatePendingSqlTransaction,
        appendPendingSqlTransactionExecution, sqlEditorAutoCommitRemainingSeconds,
        pendingSqlTransaction, pendingSqlTransactionRef, handleFinishPendingSqlTransaction,
        autoFetchVisible,
    };
};

export type QueryEditorExecutionStatusApi = ReturnType<typeof useQueryEditorExecutionStatus>;
