import { v4 as uuidv4 } from 'uuid';
import { message } from 'antd';
import React, { useEffect } from 'react';
import { t as translate } from '../../../i18n';
import {
    resolveEffectiveActiveResultKey,
    QUERY_EDITOR_SQL_LOG_TAB_KEY,
    type QueryEditorResultSet,
} from '../../QueryEditorResultsPanel';
import {
    type CloseActiveResultShortcutRequest,
    CLOSE_ACTIVE_RESULT_TAB_EVENT,
} from '../../../utils/closeTabShortcut';
import { filterQueryEditorResultSetsForBulkClose } from '../queryEditorResultSort';
import { openNativeQueryResultWindow } from '../../../utils/nativeDetachedWindowHost';
import { NATIVE_DETACHED_QUERY_RESULT_REDETACH_EVENT } from '../../../utils/nativeDetachedWindowClient';
import { getShortcutDisplayLabel } from '../../../utils/shortcuts';
import QueryEditorTransactionToolbar from '../../QueryEditorTransactionToolbar';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorQueryContextApi } from './useQueryEditorQueryContext';
import type { QueryEditorSaveActionsApi } from './useQueryEditorSaveActions';
import type { QueryEditorResultReloadApi } from './useQueryEditorResultReload';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorExecutionStatusApi } from './useQueryEditorExecutionStatus';
import type { QueryEditorShortcutsAndSnippetsApi } from './useQueryEditorShortcutsAndSnippets';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorResultTabsInput {
    tab: QueryEditorProps['tab'];
    saveForm: QueryEditorCoreStateApi['saveForm'];
    currentSavedQuery: QueryEditorQueryContextApi['currentSavedQuery'];
    saveModalMode: QueryEditorCoreStateApi['saveModalMode'];
    persistQuery: QueryEditorSaveActionsApi['persistQuery'];
    setIsSaveModalOpen: QueryEditorCoreStateApi['setIsSaveModalOpen'];
    cancelResultTotalCountRequests: QueryEditorResultReloadApi['cancelResultTotalCountRequests'];
    resultSetsRef: QueryEditorCoreStateApi['resultSetsRef'];
    activeResultKeyRef: QueryEditorCoreStateApi['activeResultKeyRef'];
    paramsPanelAvailableRef: QueryEditorCoreStateApi['paramsPanelAvailableRef'];
    setResultSets: QueryEditorCoreStateApi['setResultSets'];
    setActiveResultKey: QueryEditorCoreStateApi['setActiveResultKey'];
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    isResultPanelVisibleRef: QueryEditorConnectionContextApi['isResultPanelVisibleRef'];
    updateResultPanelVisibility: QueryEditorExecutionStatusApi['updateResultPanelVisibility'];
    resultTotalCountRequestsRef: QueryEditorCoreStateApi['resultTotalCountRequestsRef'];
    resultSets: QueryEditorCoreStateApi['resultSets'];
    currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    nativeRestoredResultRefs: QueryEditorCoreStateApi['nativeRestoredResultRefs'];
    toggleQueryResultsPanelShortcutBinding: QueryEditorShortcutsAndSnippetsApi['toggleQueryResultsPanelShortcutBinding'];
    activeShortcutPlatform: QueryEditorShortcutsAndSnippetsApi['activeShortcutPlatform'];
    diagnoseExecutionErrorShortcutBinding: QueryEditorShortcutsAndSnippetsApi['diagnoseExecutionErrorShortcutBinding'];
    handleDiagnoseExecutionErrorWithAI: QueryEditorShortcutsAndSnippetsApi['handleDiagnoseExecutionErrorWithAI'];
    executionError: QueryEditorCoreStateApi['executionError'];
    darkMode: QueryEditorConnectionContextApi['darkMode'];
    pendingSqlTransaction: QueryEditorExecutionStatusApi['pendingSqlTransaction'];
    sqlEditorAutoCommitRemainingSeconds: QueryEditorExecutionStatusApi['sqlEditorAutoCommitRemainingSeconds'];
    handleFinishPendingSqlTransaction: QueryEditorExecutionStatusApi['handleFinishPendingSqlTransaction'];
}

export const useQueryEditorResultTabs = ({
    tab, saveForm, currentSavedQuery, saveModalMode, persistQuery, setIsSaveModalOpen,
    cancelResultTotalCountRequests, resultSetsRef, activeResultKeyRef, paramsPanelAvailableRef,
    setResultSets, setActiveResultKey, isActive, isResultPanelVisibleRef,
    updateResultPanelVisibility, resultTotalCountRequestsRef, resultSets, currentConnectionId,
    currentDb, nativeRestoredResultRefs, toggleQueryResultsPanelShortcutBinding,
    activeShortcutPlatform, diagnoseExecutionErrorShortcutBinding,
    handleDiagnoseExecutionErrorWithAI, executionError, darkMode, pendingSqlTransaction,
    sqlEditorAutoCommitRemainingSeconds, handleFinishPendingSqlTransaction,
}: UseQueryEditorResultTabsInput) => {
    const handleSave = async () => {
        try {
            const values = await saveForm.validateFields();
            const existed = currentSavedQuery || null;
            const fallbackSavedId = String(tab.savedQueryId || '').trim();
            const isSaveAs = saveModalMode === 'saveAs';
            const nextSavedId = isSaveAs
                ? `saved-${uuidv4()}`
                : existed?.id || fallbackSavedId || `saved-${Date.now()}`;
            const applied = await persistQuery({
                id: nextSavedId,
                name: String(values.name || '').trim() || translate('query_editor.save_modal.unnamed'),
                createdAt: isSaveAs ? Date.now() : existed?.createdAt,
                openCopyInNewTab: isSaveAs,
            });
            if (!applied) {
                return;
            }
            message.success(translate(
                saveModalMode === 'rename'
                    ? 'query_editor.message.renamed'
                    : isSaveAs
                        ? 'query_editor.message.saved_as'
                        : 'query_editor.message.saved'
            ));
            setIsSaveModalOpen(false);
        } catch (e) {
            if (e instanceof Error) {
                message.error(translate('query_editor.message.save_query_failed', {
                    error: e.message,
                }));
            }
        }
    };

    const handleCloseResult = (key: string) => {
        void cancelResultTotalCountRequests([key]);
        const currentResultSets = resultSetsRef.current;
        const idx = currentResultSets.findIndex(result => result.key === key);
        if (idx < 0) return;

        const currentActiveKey = resolveEffectiveActiveResultKey(
            currentResultSets,
            activeResultKeyRef.current,
            true,
            paramsPanelAvailableRef.current,
        );
        const nextResultSets = currentResultSets.filter(result => result.key !== key);
        const nextActiveKey = currentActiveKey && currentActiveKey !== key
            ? currentActiveKey
            : nextResultSets[idx]?.key
                || nextResultSets[idx - 1]?.key
                || nextResultSets[0]?.key
                || (QUERY_EDITOR_SQL_LOG_TAB_KEY);

        resultSetsRef.current = nextResultSets;
        activeResultKeyRef.current = nextActiveKey;
        setResultSets(nextResultSets);
        setActiveResultKey(nextActiveKey);
    };

    useEffect(() => {
        if (!isActive) return;

        const handleCloseActiveResultTab = (event: Event) => {
            const request = (event as CustomEvent<CloseActiveResultShortcutRequest>).detail;
            if (!request || request.handled || request.targetTabId !== tab.id) return;
            request.handled = true;
            request.outcome = 'ignored';
            if (!isResultPanelVisibleRef.current) return;

            const effectiveActiveKey = resolveEffectiveActiveResultKey(
                resultSetsRef.current,
                activeResultKeyRef.current,
                true,
                paramsPanelAvailableRef.current,
            );
            if (!effectiveActiveKey) return;

            if (effectiveActiveKey === QUERY_EDITOR_SQL_LOG_TAB_KEY) {
                updateResultPanelVisibility(false);
                request.outcome = 'hidden';
                return;
            }
            if (!resultSetsRef.current.some(result => result.key === effectiveActiveKey)) return;

            handleCloseResult(effectiveActiveKey);
            request.outcome = 'closed';
        };

        window.addEventListener(CLOSE_ACTIVE_RESULT_TAB_EVENT, handleCloseActiveResultTab);
        return () => {
            window.removeEventListener(CLOSE_ACTIVE_RESULT_TAB_EVENT, handleCloseActiveResultTab);
        };
    }, [isActive, true, tab.id, updateResultPanelVisibility]);

    const handleResultPinnedChange = (key: string, pinned: boolean) => {
        const nextResultSets = resultSetsRef.current.map((result) => (
            result.key === key ? { ...result, pinned } : result
        ));
        resultSetsRef.current = nextResultSets;
        setResultSets(nextResultSets);
    };

    const replaceResultSetsAfterMenuClose = (next: QueryEditorResultSet[], preferredKey?: string) => {
        const nextKeys = new Set(next.map((result) => result.key));
        const removedCountKeys = Object.keys(resultTotalCountRequestsRef.current)
            .filter((key) => !nextKeys.has(key));
        void cancelResultTotalCountRequests(removedCountKeys);
        resultSetsRef.current = next;
        setResultSets(next);
        setActiveResultKey(prevActive => {
            const nextActiveKey = preferredKey && next.some(result => result.key === preferredKey)
                ? preferredKey
                : prevActive && next.some(result => result.key === prevActive)
                    ? prevActive
                    : next[0]?.key || '';
            activeResultKeyRef.current = nextActiveKey;
            return nextActiveKey;
        });
    };

    const closeOtherResultTabs = (key: string) => {
        replaceResultSetsAfterMenuClose(
            filterQueryEditorResultSetsForBulkClose(resultSets, key, 'other'),
            key,
        );
    };

    const closeResultTabsToLeft = (key: string) => {
        const next = filterQueryEditorResultSetsForBulkClose(resultSets, key, 'left');
        if (next === resultSets) return;
        replaceResultSetsAfterMenuClose(next, key);
    };

    const closeResultTabsToRight = (key: string) => {
        const next = filterQueryEditorResultSetsForBulkClose(resultSets, key, 'right');
        if (next === resultSets) return;
        replaceResultSetsAfterMenuClose(next, key);
    };

    const closeAllResultTabs = () => {
        replaceResultSetsAfterMenuClose(filterQueryEditorResultSetsForBulkClose(resultSets, '', 'all'));
    };

    const openResultInWindow = (
        key: string,
        preferred?: { x?: number; y?: number; width?: number; height?: number },
    ) => {
        const target = resultSets.find((result) => result.key === key);
        if (!target) return;
        const index = resultSets.findIndex((result) => result.key === key);
        const title = target.resultType === 'message'
            ? translate('query_editor.results_panel.tab.message', { index: index + 1 })
            : translate('query_editor.results_panel.detached.title', { index: index + 1 });
        const windowId = `query-result:${tab.id}:${target.key}`;
        const detachedWindow = {
            id: windowId,
            sourceQueryTabId: tab.id,
            connectionId: target.executionConnectionId || currentConnectionId || tab.connectionId || '',
            // 独立窗也要带上结果表元数据所属库，否则列类型/注释会丢
            dbName: target.metadataDbName ?? target.executionDbName ?? currentDb ?? tab.dbName ?? '',
            title,
            ...(preferred?.x !== undefined ? { x: preferred.x } : {}),
            ...(preferred?.y !== undefined ? { y: preferred.y } : {}),
            ...(preferred?.width !== undefined ? { width: preferred.width } : {}),
            ...(preferred?.height !== undefined ? { height: preferred.height } : {}),
            result: {
                key: target.key,
                sql: target.sql,
                exportSql: target.exportSql,
                sourceStatementIndex: target.sourceStatementIndex,
                statementResultIndex: target.statementResultIndex,
                rows: target.rows,
                columns: target.columns,
                messages: target.messages,
                resultType: target.resultType,
                requestLabel: target.requestLabel,
                httpStatus: target.httpStatus,
                rawResponse: target.rawResponse,
                partialFailure: target.partialFailure,
                outcomeUnknown: target.outcomeUnknown,
                tableName: target.metadataTableName || target.tableName,
                metadataDbName: target.metadataDbName,
                metadataTableName: target.metadataTableName,
                ddlDbName: target.ddlDbName,
                ddlTableName: target.ddlTableName,
                executionConnectionId: target.executionConnectionId,
                executionDbName: target.executionDbName,
                executionConnectionParams: target.executionConnectionParams,
                pkColumns: target.pkColumns || [],
                editLocator: target.editLocator as any,
                readOnly: target.readOnly !== false,
                showRowNumberColumn: target.showRowNumberColumn,
                truncated: target.truncated,
                pinned: target.pinned,
            },
        };
        void openNativeQueryResultWindow(detachedWindow)
            .then((opened) => {
                if (opened) handleCloseResult(key);
            })
            .catch((error) => {
                message.error(error instanceof Error ? error.message : String(error));
            });
    };

    React.useEffect(() => {
        const handleRestoreQueryResult = (event: Event) => {
            const detail = (event as CustomEvent).detail || {};
            const sourceQueryTabId = String(detail.sourceQueryTabId || '').trim();
            if (sourceQueryTabId !== tab.id) return;
            const restored = detail.result;
            if (!restored || typeof restored !== 'object') return;
            const restoredKey = String(restored.key || '').trim();
            if (!restoredKey) return;
            const windowId = String(detail.windowId || '').trim();
            const expectedWindowId = `query-result:${sourceQueryTabId}:${restoredKey}`;
            if (!resultSetsRef.current.some((item) => item.key === restoredKey)) {
                const restoredResult = {
                    key: restoredKey,
                    sql: String(restored.sql || ''),
                    exportSql: restored.exportSql,
                    sourceStatementIndex: restored.sourceStatementIndex,
                    statementResultIndex: restored.statementResultIndex,
                    rows: Array.isArray(restored.rows) ? restored.rows : [],
                    columns: Array.isArray(restored.columns) ? restored.columns : [],
                    messages: Array.isArray(restored.messages) ? restored.messages : undefined,
                    resultType: restored.resultType === 'message'
                        ? 'message'
                        : restored.resultType === 'elasticsearch'
                            ? 'elasticsearch'
                            : 'grid',
                    requestLabel: restored.requestLabel,
                    httpStatus: restored.httpStatus,
                    rawResponse: restored.rawResponse,
                    partialFailure: restored.partialFailure === true,
                    outcomeUnknown: restored.outcomeUnknown === true,
                    tableName: restored.tableName,
                    metadataDbName: restored.metadataDbName,
                    metadataTableName: restored.metadataTableName,
                    ddlDbName: restored.ddlDbName,
                    ddlTableName: restored.ddlTableName,
                    executionConnectionId: restored.executionConnectionId,
                    executionDbName: restored.executionDbName,
                    executionConnectionParams: restored.executionConnectionParams,
                    pkColumns: Array.isArray(restored.pkColumns) ? restored.pkColumns : [],
                    editLocator: restored.editLocator,
                    readOnly: restored.readOnly !== false,
                    showRowNumberColumn: restored.showRowNumberColumn,
                    truncated: restored.truncated,
                    pinned: restored.pinned === true,
                } as QueryEditorResultSet;
                const nextResultSets = [
                    ...resultSetsRef.current,
                    restoredResult,
                ];
                resultSetsRef.current = nextResultSets;
                setResultSets(nextResultSets);
                if (windowId === expectedWindowId) {
                    nativeRestoredResultRefs.current.set(windowId, {
                        resultKey: restoredKey,
                        result: restoredResult,
                    });
                }
            } else if (windowId) {
                nativeRestoredResultRefs.current.delete(windowId);
            }
            activeResultKeyRef.current = restoredKey;
            setActiveResultKey(restoredKey);
            updateResultPanelVisibility(true);
        };
        const handleRedetachQueryResult = (event: Event) => {
            const detail = (event as CustomEvent).detail || {};
            const sourceQueryTabId = String(detail.sourceQueryTabId || '').trim();
            if (sourceQueryTabId !== tab.id) return;
            const resultKey = String(detail.resultKey || '').trim();
            const windowId = String(detail.windowId || '').trim();
            if (!resultKey || windowId !== `query-result:${sourceQueryTabId}:${resultKey}`) return;
            const restoredResult = nativeRestoredResultRefs.current.get(windowId);
            nativeRestoredResultRefs.current.delete(windowId);
            if (
                !restoredResult
                || restoredResult.resultKey !== resultKey
                || resultSetsRef.current.find((item) => item.key === resultKey) !== restoredResult.result
            ) return;
            handleCloseResult(resultKey);
        };
        window.addEventListener('gonavi:restore-query-result', handleRestoreQueryResult as EventListener);
        window.addEventListener(
            NATIVE_DETACHED_QUERY_RESULT_REDETACH_EVENT,
            handleRedetachQueryResult as EventListener,
        );
        return () => {
            window.removeEventListener('gonavi:restore-query-result', handleRestoreQueryResult as EventListener);
            window.removeEventListener(
                NATIVE_DETACHED_QUERY_RESULT_REDETACH_EVENT,
                handleRedetachQueryResult as EventListener,
            );
        };
    }, [tab.id, updateResultPanelVisibility]);

    const toggleQueryResultsPanelShortcutLabel =
        toggleQueryResultsPanelShortcutBinding.enabled && toggleQueryResultsPanelShortcutBinding.combo
            ? getShortcutDisplayLabel(toggleQueryResultsPanelShortcutBinding.combo, activeShortcutPlatform)
            : '';
    const diagnoseExecutionErrorShortcutLabel =
        diagnoseExecutionErrorShortcutBinding.enabled && diagnoseExecutionErrorShortcutBinding.combo
            ? getShortcutDisplayLabel(diagnoseExecutionErrorShortcutBinding.combo, activeShortcutPlatform)
            : '';

    const handleDiagnoseExecutionError = () => {
        handleDiagnoseExecutionErrorWithAI(executionError);
    };

    const sqlEditorTransactionToolbar = (
        <QueryEditorTransactionToolbar
            darkMode={darkMode}
            transaction={pendingSqlTransaction}
            autoCommitRemainingSeconds={sqlEditorAutoCommitRemainingSeconds}
            onFinish={(action) => void handleFinishPendingSqlTransaction(action)}
        />
    );
    return {
        handleSave, handleCloseResult, handleResultPinnedChange, closeOtherResultTabs,
        closeResultTabsToLeft, closeResultTabsToRight, closeAllResultTabs, openResultInWindow,
        toggleQueryResultsPanelShortcutLabel, diagnoseExecutionErrorShortcutLabel,
        handleDiagnoseExecutionError, sqlEditorTransactionToolbar,
    };
};

export type QueryEditorResultTabsApi = ReturnType<typeof useQueryEditorResultTabs>;
