import { useCallback, useEffect } from 'react';
import {
    persistQueryTabDraftSnapshot,
    clearQueryTabDraft,
    getQueryTabDraft,
} from '../../../utils/sqlFileTabDrafts';
import { QUERY_EDITOR_PERSISTED_DRAFT_MAX_TEXT_LENGTH } from '../QueryEditorHelpers';
import type { SqlSnippet } from '../../../types';
import { materializeSqlSnippetText } from '../queryEditorCompletionTables';
import { shouldKeepRestoredQueryUnbound } from '../../../utils/sqlAuditTab';
import { publishQueryEditorSelection } from '../queryEditorAiSelection';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorShortcutsAndSnippetsApi } from './useQueryEditorShortcutsAndSnippets';
import type { QueryEditorQueryContextApi } from './useQueryEditorQueryContext';
import type { QueryEditorExecutionStatusApi } from './useQueryEditorExecutionStatus';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorDraftSyncInput {
    saveOperationQueueRef: QueryEditorCoreStateApi['saveOperationQueueRef'];
    lastLocalQueryRef: QueryEditorCoreStateApi['lastLocalQueryRef'];
    draftSnapshotTab: QueryEditorConnectionContextApi['draftSnapshotTab'];
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    currentDbRef: QueryEditorConnectionContextApi['currentDbRef'];
    isExternalSQLFileTab: QueryEditorCoreStateApi['isExternalSQLFileTab'];
    setQuery: QueryEditorCoreStateApi['setQuery'];
    editorRef: QueryEditorCoreStateApi['editorRef'];
    monacoRef: QueryEditorCoreStateApi['monacoRef'];
    handleCloseSqlSnippetPicker: QueryEditorShortcutsAndSnippetsApi['handleCloseSqlSnippetPicker'];
    tab: QueryEditorProps['tab'];
    currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    currentSavedQuery: QueryEditorQueryContextApi['currentSavedQuery'];
    query: QueryEditorCoreStateApi['query'];
    queryCapableConnections: QueryEditorConnectionContextApi['queryCapableConnections'];
    switchQueryContext: QueryEditorQueryContextApi['switchQueryContext'];
    pendingSqlTransaction: QueryEditorExecutionStatusApi['pendingSqlTransaction'];
    queryContextLockRunSeq: QueryEditorCoreStateApi['queryContextLockRunSeq'];
    queryEditorMonacoLanguage: QueryEditorConnectionContextApi['queryEditorMonacoLanguage'];
    currentSchemaRef: QueryEditorConnectionContextApi['currentSchemaRef'];
    currentSchema: QueryEditorCoreStateApi['currentSchema'];
    queryContextLockRunSeqRef: QueryEditorCoreStateApi['queryContextLockRunSeqRef'];
    pendingSqlTransactionRef: QueryEditorExecutionStatusApi['pendingSqlTransactionRef'];
    latestSelectedSchemaRef: QueryEditorConnectionContextApi['latestSelectedSchemaRef'];
    setCurrentSchema: QueryEditorCoreStateApi['setCurrentSchema'];
    setSchemaList: QueryEditorCoreStateApi['setSchemaList'];
    updateQueryTabDraft: QueryEditorConnectionContextApi['updateQueryTabDraft'];
}

export const useQueryEditorDraftSync = ({
    saveOperationQueueRef, lastLocalQueryRef, draftSnapshotTab, currentConnectionIdRef,
    currentDbRef, isExternalSQLFileTab, setQuery, editorRef, monacoRef, handleCloseSqlSnippetPicker,
    tab, currentConnectionId, currentDb, currentSavedQuery, query, queryCapableConnections,
    switchQueryContext, pendingSqlTransaction, queryContextLockRunSeq, queryEditorMonacoLanguage,
    currentSchemaRef, currentSchema, queryContextLockRunSeqRef, pendingSqlTransactionRef,
    latestSelectedSchemaRef, setCurrentSchema, setSchemaList, updateQueryTabDraft,
}: UseQueryEditorDraftSyncInput) => {
    const runQueuedSaveOperation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
        const queued = saveOperationQueueRef.current.then(operation, operation);
        saveOperationQueueRef.current = queued.then(
            () => undefined,
            () => undefined,
        );
        return queued;
    }, []);

    const syncQueryDraft = useCallback((nextQuery: string) => {
        const next = String(nextQuery ?? '');
        lastLocalQueryRef.current = next;
        persistQueryTabDraftSnapshot(draftSnapshotTab, next, {
            connectionId: currentConnectionIdRef.current,
            dbName: currentDbRef.current,
        });
    }, [draftSnapshotTab]);

    const applyQueryState = useCallback((nextQuery: string) => {
        const next = String(nextQuery ?? '');
        syncQueryDraft(next);
        if (!isExternalSQLFileTab || next.length <= QUERY_EDITOR_PERSISTED_DRAFT_MAX_TEXT_LENGTH) {
            setQuery(next);
        }
    }, [isExternalSQLFileTab, syncQueryDraft]);

    const handleInsertSqlSnippet = useCallback((snippet: SqlSnippet) => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor) {
            return;
        }

        const snippetController = editor.getContribution?.('snippetController2');
        if (snippetController && typeof snippetController.insert === 'function') {
            editor.focus?.();
            snippetController.insert(snippet.body);
            const nextValue = editor.getValue?.();
            if (typeof nextValue === 'string') {
                applyQueryState(nextValue);
            }
            handleCloseSqlSnippetPicker();
            editor.focus?.();
            return;
        }

        const model = editor.getModel?.();
        if (!model || !monaco?.Range) {
            return;
        }

        const selection = editor.getSelection?.();
        const position = editor.getPosition?.()
            || { lineNumber: model.getLineCount?.() || 1, column: model.getLineMaxColumn?.(model.getLineCount?.() || 1) || 1 };
        const hasSelection = selection
            && (
                selection.startLineNumber !== selection.endLineNumber
                || selection.startColumn !== selection.endColumn
            );
        const range = hasSelection
            ? selection
            : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
        const startOffset = model.getOffsetAt?.({
            lineNumber: range.startLineNumber,
            column: range.startColumn,
        });
        const plainText = materializeSqlSnippetText(snippet.body);

        editor.pushUndoStop?.();
        editor.executeEdits?.('gonavi-insert-sql-snippet', [{
            range,
            text: plainText,
            forceMoveMarkers: true,
        }]);
        editor.pushUndoStop?.();

        if (Number.isFinite(Number(startOffset)) && typeof model.getPositionAt === 'function') {
            const nextPosition = model.getPositionAt(Number(startOffset) + plainText.length);
            editor.setPosition?.(nextPosition);
            editor.setSelection?.(new monaco.Range(
                nextPosition.lineNumber,
                nextPosition.column,
                nextPosition.lineNumber,
                nextPosition.column,
            ));
        }

        const nextValue = editor.getValue?.();
        if (typeof nextValue === 'string') {
            applyQueryState(nextValue);
        }
        handleCloseSqlSnippetPicker();
        editor.focus?.();
    }, [applyQueryState, handleCloseSqlSnippetPicker]);
    const handleInsertDuckDBAttachStatement = useCallback((statement: string) => {
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (!editor || !monaco?.Range || !statement) {
            return;
        }
        const model = editor.getModel?.();
        const position = editor.getPosition?.()
            || { lineNumber: model?.getLineCount?.() || 1, column: model?.getLineMaxColumn?.(model?.getLineCount?.() || 1) || 1 };
        const range = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
        editor.executeEdits?.('gonavi-duckdb-attach', [{ range, text: statement, forceMoveMarkers: true }]);
        const nextValue = editor.getValue?.();
        if (typeof nextValue === 'string') {
            applyQueryState(nextValue);
        }
        editor.focus?.();
    }, [applyQueryState]);

    useEffect(() => {
        const latestQuery = lastLocalQueryRef.current;
        const latestConnectionId = currentConnectionIdRef.current || currentConnectionId;
        const latestDbName = currentDbRef.current ?? currentDb;
        const matchesSavedQuery = currentSavedQuery
            && latestQuery === String(currentSavedQuery.sql ?? '')
            && String(latestConnectionId || '').trim() === String(currentSavedQuery.connectionId || '').trim()
            && String(latestDbName || '').trim() === String(currentSavedQuery.dbName || '').trim();
        if (matchesSavedQuery) {
            clearQueryTabDraft(tab.id);
            return;
        }
        persistQueryTabDraftSnapshot(draftSnapshotTab, latestQuery, {
            connectionId: latestConnectionId,
            dbName: latestDbName,
        });
    }, [currentConnectionId, currentDb, currentSavedQuery, draftSnapshotTab, query, tab.id]);

    useEffect(() => {
        currentConnectionIdRef.current = currentConnectionId;
    }, [currentConnectionId]);

    useEffect(() => {
        if (shouldKeepRestoredQueryUnbound(tab, currentConnectionId)) {
            return;
        }
        if (!queryCapableConnections.some(c => c.id === currentConnectionId)) {
            const fallback = queryCapableConnections[0]?.id || '';
            if (fallback && fallback !== currentConnectionId) {
                void switchQueryContext(fallback, '', { silentPending: true });
            }
        }
    }, [currentConnectionId, pendingSqlTransaction?.id, queryCapableConnections, queryContextLockRunSeq, switchQueryContext, tab.preserveUnboundConnection]);

    useEffect(() => {
        currentDbRef.current = currentDb;
    }, [currentDb]);

    useEffect(() => {
        const editor = editorRef.current;
        if (!editor) {
            return;
        }
        publishQueryEditorSelection({
            editor,
            tabId: tab.id,
            tabTitle: tab.title,
            connectionId: currentConnectionId || tab.connectionId,
            dbName: currentDb || tab.dbName,
            language: queryEditorMonacoLanguage,
        });
    }, [currentConnectionId, currentDb, queryEditorMonacoLanguage, tab.connectionId, tab.dbName, tab.id, tab.title]);

    useEffect(() => {
        currentSchemaRef.current = currentSchema;
    }, [currentSchema]);

    useEffect(() => {
        const nextConnectionId = String(tab.connectionId || '').trim();
        const nextDb = String(tab.dbName || '').trim();
        const nextSchema = String(tab.schemaName || '').trim();
        const contextChanged = nextConnectionId !== currentConnectionIdRef.current
            || nextDb !== currentDbRef.current;
        const schemaChanged = nextSchema !== currentSchemaRef.current;
        if (
            (queryContextLockRunSeqRef.current !== 0 || pendingSqlTransactionRef.current)
            && (contextChanged || schemaChanged)
        ) {
            return;
        }
        if (contextChanged && !switchQueryContext(nextConnectionId, nextDb, {
            persist: false,
            silentPending: true,
        })) {
            return;
        }
        if (nextSchema !== currentSchemaRef.current) {
            currentSchemaRef.current = nextSchema;
            if (!contextChanged) {
                latestSelectedSchemaRef.current = nextSchema;
            }
            setCurrentSchema(nextSchema);
            setSchemaList((current) => nextSchema && !current.includes(nextSchema)
                ? [nextSchema, ...current]
                : nextSchema ? current : []);
        }
    }, [
        pendingSqlTransaction?.id,
        pendingSqlTransactionRef,
        queryContextLockRunSeq,
        switchQueryContext,
        tab.connectionId,
        tab.dbName,
        tab.id,
        tab.schemaName,
    ]);

    useEffect(() => {
        if (isExternalSQLFileTab) return;
        const currentDraft = getQueryTabDraft(tab.id, query);
        const shouldPersistQuery = currentDraft.length <= QUERY_EDITOR_PERSISTED_DRAFT_MAX_TEXT_LENGTH;
        updateQueryTabDraft(tab.id, {
            ...(shouldPersistQuery ? { query: currentDraft } : {}),
            connectionId: currentConnectionId,
            dbName: currentDb,
        });
    }, [currentConnectionId, currentDb, isExternalSQLFileTab, query, tab.id, updateQueryTabDraft]);

    useEffect(() => {
        if (!isExternalSQLFileTab) return;
        updateQueryTabDraft(tab.id, {
            connectionId: currentConnectionId,
            dbName: currentDb,
        });
    }, [currentConnectionId, currentDb, isExternalSQLFileTab, tab.id, updateQueryTabDraft]);

    const getCurrentQuery = useCallback((): string => {
        const val = editorRef.current?.getValue?.();
        if (typeof val === 'string') return val;
        return query || '';
    }, [query]);
    return {
        runQueuedSaveOperation, syncQueryDraft, applyQueryState, handleInsertSqlSnippet,
        handleInsertDuckDBAttachStatement, getCurrentQuery,
    };
};

export type QueryEditorDraftSyncApi = ReturnType<typeof useQueryEditorDraftSync>;
