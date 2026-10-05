import React, { useCallback } from 'react';
import {
    findSqlStatementRanges,
    stripLeadingSqlTrivia,
    resolveExecutableSql,
} from '../../../utils/sqlStatementSelection';
import {
    maskQueryEditorSqlLiteralsAndComments,
    buildQueryEditorResultSetMergeKey,
    resolveNextResultSetIndex,
    normalizeEditorPosition,
    getNormalizedOffsetAtPosition,
} from '../QueryEditorHelpers';
import type { QueryEditorResultSet } from '../../QueryEditorResultsPanel';
import { resolveSqlDialect } from '../../../utils/sqlDialect';
import {
    supportsQueryEditorSchemaSelection,
    applyQueryEditorSchemaSearchPath,
} from '../queryEditorSchemaContext';
import type { QueryParamBindingInput } from '../params/queryEditorParamsModel';
import { buildQueryEditorResultBudgetOptions } from '../queryEditorResultBudget';
import { canReusePendingSqlEditorTransactionForType } from '../../../utils/sqlEditorTransaction';
import type { ConnectionConfig } from '../../../types';
import {
    DBQueryMultiWithParamsInTransaction,
    DBQueryMultiInTransactionWithOptions,
    DBQueryMultiWithParams,
    DBQueryMultiWithOptions,
} from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { invokeBudgetedDBQueryMulti, expandCompactQueryResult } from '../queryResultTransport';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorDraftSyncApi } from './useQueryEditorDraftSync';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorExecutionStatusApi } from './useQueryEditorExecutionStatus';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorResultSetModelInput {
    editorRef: QueryEditorCoreStateApi['editorRef'];
    resultSetsRef: QueryEditorCoreStateApi['resultSetsRef'];
    activeResultKeyRef: QueryEditorCoreStateApi['activeResultKeyRef'];
    setResultSets: QueryEditorCoreStateApi['setResultSets'];
    setActiveResultKey: QueryEditorCoreStateApi['setActiveResultKey'];
    tab: QueryEditorProps['tab'];
    setResultDataPreviewRequest: QueryEditorCoreStateApi['setResultDataPreviewRequest'];
    lastEditorCursorPositionRef: QueryEditorCoreStateApi['lastEditorCursorPositionRef'];
    getCurrentQuery: QueryEditorDraftSyncApi['getCurrentQuery'];
    resultSets: QueryEditorCoreStateApi['resultSets'];
    lastExecutedEditorQueryRef: QueryEditorCoreStateApi['lastExecutedEditorQueryRef'];
    connections: QueryEditorConnectionContextApi['connections'];
    currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
    currentSchemaRef: QueryEditorConnectionContextApi['currentSchemaRef'];
    canSelectQuerySchema: QueryEditorConnectionContextApi['canSelectQuerySchema'];
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    currentDbRef: QueryEditorConnectionContextApi['currentDbRef'];
    queryOptions: QueryEditorCoreStateApi['queryOptions'];
    pendingSqlTransactionRef: QueryEditorExecutionStatusApi['pendingSqlTransactionRef'];
    invokeRequestScopedApp: QueryEditorCoreStateApi['invokeRequestScopedApp'];
}

export const useQueryEditorResultSetModel = ({
    editorRef, resultSetsRef, activeResultKeyRef, setResultSets, setActiveResultKey, tab,
    setResultDataPreviewRequest, lastEditorCursorPositionRef, getCurrentQuery, resultSets,
    lastExecutedEditorQueryRef, connections, currentConnectionId, currentSchemaRef,
    canSelectQuerySchema, currentConnectionIdRef, currentDbRef, queryOptions,
    pendingSqlTransactionRef, invokeRequestScopedApp,
}: UseQueryEditorResultSetModelInput) => {
    const splitSQLStatements = (sql: string, dbType = ''): string[] => {
      return findSqlStatementRanges(sql, dbType).map((range) => range.text);
    };

    const normalizeExecutableStatementList = (statements: string[], dbType = ''): string[] => (
        statements.map((statement) => stripLeadingSqlTrivia(statement, dbType))
    );

    const containsOraclePlsqlDefinition = (statements: string[]): boolean => (
        statements.some((statement) => /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER)\b/i.test(
            maskQueryEditorSqlLiteralsAndComments(statement),
        ))
    );

    const normalizeOracleSqlPlusSlashTerminators = (sql: string): string => (
        String(sql || '').replace(/(^|\n)([ \t]*\/[ \t]*);+([ \t]*(?:--[^\n]*)?)(?=\n|$)/g, '$1$2$3')
    );

    const getSelectedSQL = (): string => {
        const editor = editorRef.current;
        if (!editor) return '';
        const model = editor.getModel?.();
        const selection = editor.getSelection?.();
        if (!model || !selection) return '';

        const selected = model.getValueInRange?.(selection) || '';
        if (typeof selected !== 'string') return '';
        if (!selected.trim()) return '';
        return selected;
    };

    const buildResultSetMergeKey = (result: QueryEditorResultSet): string => (
        buildQueryEditorResultSetMergeKey(result)
    );

    const mergeResultSets = (previous: QueryEditorResultSet[], next: QueryEditorResultSet[], replaceAll: boolean): QueryEditorResultSet[] => {
        const merged = replaceAll ? previous.filter((result) => result.pinned) : [...previous];
        next.forEach((result) => {
            const incomingKey = buildResultSetMergeKey(result);
            const existingIndex = merged.findIndex(
                (item) => !item.pinned && buildResultSetMergeKey(item) === incomingKey,
            );
            if (existingIndex >= 0) {
                merged[existingIndex] = { ...result, key: merged[existingIndex].key, pinned: false };
                return;
            }
            merged.push({ ...result, key: `result-${resolveNextResultSetIndex(merged)}`, pinned: false });
        });
        return merged;
    };

    const clearUnpinnedResultSets = (fallbackActiveKey = ''): QueryEditorResultSet[] => {
        const nextResultSets = resultSetsRef.current.filter((result) => result.pinned);
        const nextActiveKey = nextResultSets.some((result) => result.key === activeResultKeyRef.current)
            ? activeResultKeyRef.current
            : nextResultSets[0]?.key || fallbackActiveKey;
        resultSetsRef.current = nextResultSets;
        activeResultKeyRef.current = nextActiveKey;
        setResultSets(nextResultSets);
        setActiveResultKey(nextActiveKey);
        return nextResultSets;
    };

    const isDisplayableResultSet = (result?: QueryEditorResultSet | null): boolean => {
        if (!result) {
            return false;
        }
        if (Array.isArray(result.messages) && result.messages.length > 0) {
            return true;
        }
        if (Array.isArray(result.columns) && result.columns.length > 0) {
            return true;
        }
        if (Array.isArray(result.rows) && result.rows.length > 0) {
            return true;
        }
        return false;
    };

    const isAffectedRowsResultSet = (result?: QueryEditorResultSet | null): boolean =>
        Boolean(
            result &&
            Array.isArray(result.columns) &&
            result.columns.length === 1 &&
            result.columns[0] === 'affectedRows',
        );

    const isAffectedRowsResultSetData = (result?: any): boolean =>
        Boolean(
            result &&
            Array.isArray(result.rows) &&
            result.rows.length === 1 &&
            Array.isArray(result.columns) &&
            result.columns.length === 1 &&
            result.columns[0] === 'affectedRows',
        );

    const hasConcreteQueryResultSetData = (result: any, messages: string[]): boolean => {
        if (!result || isAffectedRowsResultSetData(result)) return false;
        if (messages.length > 0) return true;
        if (Array.isArray(result.columns) && result.columns.length > 0) return true;
        if (Array.isArray(result.rows) && result.rows.length > 0) return true;
        return false;
    };

    const isMessageLikeResultSet = (result?: QueryEditorResultSet | null): boolean =>
        Boolean(
            result &&
            Array.isArray(result.messages) &&
            result.messages.length > 0 &&
            result.resultType !== 'grid',
        );

    const isConcreteGridResultSet = (result?: QueryEditorResultSet | null): boolean =>
        Boolean(
            result &&
            result.resultType !== 'message' &&
            !isAffectedRowsResultSet(result) &&
            (
                (Array.isArray(result.columns) && result.columns.length > 0) ||
                (Array.isArray(result.rows) && result.rows.length > 0)
            ),
        );

    const isQueryDataGridResultSet = (result?: QueryEditorResultSet | null): boolean =>
        Boolean(
            result &&
            result.resultType !== 'message' &&
            !isAffectedRowsResultSet(result),
        );

    const resolveActiveResultKeyAfterMerge = (merged: QueryEditorResultSet[], executed: QueryEditorResultSet[]): string => {
        const firstExecutedResult = executed.find((result) => isConcreteGridResultSet(result))
            || executed.find((result) => isMessageLikeResultSet(result))
            || executed.find((result) => isDisplayableResultSet(result) && !isAffectedRowsResultSet(result))
            || executed.find((result) => isDisplayableResultSet(result))
            || executed[0];
        if (!firstExecutedResult) {
            return '';
        }
        const executedSqlKey = buildResultSetMergeKey(firstExecutedResult);
        return merged.find(
            (item) => !item.pinned && buildResultSetMergeKey(item) === executedSqlKey,
        )?.key
            || firstExecutedResult.key
            || merged[0]?.key
            || '';
    };

    const activateExecutedResult = (merged: QueryEditorResultSet[], executed: QueryEditorResultSet[], requestSeq: number) => {
        const nextActiveResultKey = resolveActiveResultKeyAfterMerge(merged, executed);
        const nextActiveResult = merged.find((result) => result.key === nextActiveResultKey);
        setActiveResultKey(nextActiveResultKey);
        setResultDataPreviewRequest(isQueryDataGridResultSet(nextActiveResult)
            ? {
                resultKey: nextActiveResultKey,
                requestId: `${tab.id}:${requestSeq}`,
            }
            : null);
    };

    const resolveExecutableSQLAtEditorPosition = (model: any, sqlText: string, position: any, dbType = ''): string => {
        const normalizedPosition = normalizeEditorPosition(position);
        if (!normalizedPosition) return '';
        const cursorOffset = getNormalizedOffsetAtPosition(sqlText, normalizedPosition);
        const resolved = resolveExecutableSql(sqlText, cursorOffset, '', dbType);
        return resolved?.sql || '';
    };

    const getExecutableSQLAtCurrentCursor = (model: any, sqlText: string, dbType = ''): string => {
        const editor = editorRef.current;
        const liveSelection = normalizeEditorPosition(editor?.getSelection?.());
        if (liveSelection) {
            return resolveExecutableSQLAtEditorPosition(model, sqlText, liveSelection, dbType);
        }

        const livePosition = normalizeEditorPosition(editor?.getPosition?.());
        const cachedPosition = normalizeEditorPosition(lastEditorCursorPositionRef.current);
        const candidates: Array<{ lineNumber: number; column: number }> = [];
        if (cachedPosition) candidates.push(cachedPosition);
        if (livePosition) candidates.push(livePosition);
        const seen = new Set<string>();

        for (const position of candidates) {
            const key = `${position.lineNumber}:${position.column}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const sql = resolveExecutableSQLAtEditorPosition(model, sqlText, position, dbType);
            if (sql.trim()) return sql;
        }

        const fallbackPosition = cachedPosition || livePosition;
        return resolveExecutableSQLAtEditorPosition(model, sqlText, fallbackPosition, dbType);
    };

    const getExecutableSQL = (): string => {
        const editor = editorRef.current;
        const model = editor?.getModel?.();
        const currentQuery = getCurrentQuery();
        const selectedSQL = getSelectedSQL();
        const selected = selectedSQL.trim();
        if (!selected && resultSets.length > 0 && lastExecutedEditorQueryRef.current && currentQuery.startsWith(lastExecutedEditorQueryRef.current)) {
            const appendedSQL = currentQuery.slice(lastExecutedEditorQueryRef.current.length);
            if (appendedSQL.trim()) {
                return appendedSQL;
            }
        }
        if (!model || !editor) {
            return selectedSQL || currentQuery;
        }

        if (selected) {
            return selectedSQL;
        }
        const activeConnection = connections.find((connection) => connection.id === currentConnectionId);
        const activeDialect = resolveSqlDialect(
            String(activeConnection?.config?.type || ''),
            String(activeConnection?.config?.driver || ''),
            { oceanBaseProtocol: activeConnection?.config?.oceanBaseProtocol },
        );
        return getExecutableSQLAtCurrentCursor(model, String(model.getValue?.() ?? currentQuery), activeDialect);
    };

    const captureEditorCursorPosition = (event?: React.MouseEvent<HTMLElement>) => {
        event?.preventDefault();
        const editor = editorRef.current;
        const position = normalizeEditorPosition(editor?.getSelection?.()) || normalizeEditorPosition(editor?.getPosition?.());
        if (position) {
            lastEditorCursorPositionRef.current = position;
        }
    };

    const buildSqlExecutionConnectionConfig = useCallback((
        config: Record<string, any>,
        schemaName = currentSchemaRef.current,
    ) => {
        const configDialect = resolveSqlDialect(
            String(config.type || ''),
            String(config.driver || ''),
            { oceanBaseProtocol: config.oceanBaseProtocol },
        );
        if (!canSelectQuerySchema || !supportsQueryEditorSchemaSelection(configDialect)) {
            return config;
        }
        return applyQueryEditorSchemaSearchPath(config, schemaName);
    }, [canSelectQuerySchema]);

    const executeSqlEditorMultiQuery = useCallback((
        config: Record<string, any>,
        dbName: string,
        sql: string,
        queryId: string,
        sourceStatements: string[],
        dbType = String(config.type || ''),
        connectionParamsOverride?: string,
        executionConnectionId = currentConnectionIdRef.current,
        paramBindings?: QueryParamBindingInput[],
    ) => {
        const executionConfig = connectionParamsOverride === undefined
            ? buildSqlExecutionConnectionConfig(config)
            : { ...config, connectionParams: connectionParamsOverride };
        const currentContextConfig = buildSqlExecutionConnectionConfig(config);
        const matchesCurrentExecutionContext = String(executionConnectionId || '').trim()
                === String(currentConnectionIdRef.current || '').trim()
            && String(dbName || '').trim() === String(currentDbRef.current || '').trim()
            && (
                connectionParamsOverride === undefined
                || String(executionConfig.connectionParams || '')
                    === String(currentContextConfig.connectionParams || '')
            );
        const resultBudget = buildQueryEditorResultBudgetOptions(queryOptions?.maxRows);
        const pendingTransaction = pendingSqlTransactionRef.current;
        if (
            pendingTransaction
            && matchesCurrentExecutionContext
            && canReusePendingSqlEditorTransactionForType(dbType, sourceStatements, config as ConnectionConfig)
        ) {
            if (paramBindings && paramBindings.length > 0) {
                return DBQueryMultiWithParamsInTransaction(pendingTransaction.id, sql, queryId, paramBindings);
            }
            return DBQueryMultiInTransactionWithOptions(pendingTransaction.id, sql, queryId, resultBudget);
        }
        const rpcConfig = buildRpcConnectionConfig(executionConfig) as any;
        if (paramBindings && paramBindings.length > 0) {
            return invokeRequestScopedApp(
                'DBQueryMultiWithParams',
                [rpcConfig, dbName, sql, queryId, paramBindings],
                () => DBQueryMultiWithParams(rpcConfig, dbName, sql, queryId, paramBindings),
            );
        }
        return invokeBudgetedDBQueryMulti(
            [rpcConfig, dbName, sql, queryId, resultBudget],
            () => DBQueryMultiWithOptions(rpcConfig, dbName, sql, queryId, resultBudget),
            invokeRequestScopedApp,
        )
            .then(expandCompactQueryResult);
    }, [buildSqlExecutionConnectionConfig, invokeRequestScopedApp, queryOptions?.maxRows]);
    return {
        splitSQLStatements, normalizeExecutableStatementList, containsOraclePlsqlDefinition,
        normalizeOracleSqlPlusSlashTerminators, getSelectedSQL, mergeResultSets,
        clearUnpinnedResultSets, isAffectedRowsResultSetData, hasConcreteQueryResultSetData,
        activateExecutedResult, getExecutableSQL, captureEditorCursorPosition,
        buildSqlExecutionConnectionConfig, executeSqlEditorMultiQuery,
    };
};

export type QueryEditorResultSetModelApi = ReturnType<typeof useQueryEditorResultSetModel>;
