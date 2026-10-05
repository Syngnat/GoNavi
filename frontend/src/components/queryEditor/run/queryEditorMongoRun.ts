import { message } from 'antd';
import { v4 as uuidv4 } from 'uuid';
import { areSqlStatementListsEqual, normalizeQueryResultMessages } from '../QueryEditorHelpers';
import { t as translate } from '../../../i18n';
import {
    type QueryEditorResultSet, QUERY_EDITOR_SQL_LOG_TAB_KEY,
} from '../../QueryEditorResultsPanel';
import { convertMongoShellToJsonCommand, applyMongoQueryAutoLimit } from '../../../utils/mongodb';
import { formatSqlExecutionError } from '../../../utils/sqlErrorSemantics';
import { GenerateQueryID, DBQueryWithCancel } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { resolveReportedQueryDurationMs } from '../queryEditorExecutionTimer';
import { GONAVI_ROW_KEY } from '../../DataGrid';
import type { ConnectionConfig } from '../../../types';
import type { QueryOptions, SqlLog } from '../../../store/storeStateTypes';

export interface RunQueryEditorMongoStatementsInput {
    normalizedRawSQL: string;
    splitSQLStatements: (sql: string, dbType?: string) => string[];
    normalizedDbType: "mongodb";
    resultSets: QueryEditorResultSet[];
    lastExecutedEditorQueryRef: React.MutableRefObject<string>;
    currentQuery: string;
    normalizeExecutableStatementList: (statements: string[], dbType?: string) => string[];
    clearUnpinnedResultSets: (fallbackActiveKey?: string) => QueryEditorResultSet[];
    queryOptions: QueryOptions;
    setExecutionTimingActive: React.Dispatch<React.SetStateAction<boolean>>;
    updateResultPanelVisibility: (visible: boolean) => void;
    setExecutionError: React.Dispatch<React.SetStateAction<string>>;
    isCurrentRun: () => boolean;
    runState: { queryId: string; sqlDurationMs?: number; };
    setQueryId: (id: string) => void;
    config: ConnectionConfig;
    invokeRequestScopedApp: <T>(method: string, args: unknown[], fallback: () => Promise<T>) => Promise<T>;
    executionDbName: string;
    currentQueryIdRef: React.MutableRefObject<string>;
    clearQueryId: () => void;
    addSqlLog: (log: SqlLog) => void;
    finishQueryEditorSqlClock: (result: { durationMs?: unknown; } | null | undefined, startedAt: number) => number;
    mergeResultSets: (previous: QueryEditorResultSet[], next: QueryEditorResultSet[], replaceAll: boolean) => QueryEditorResultSet[];
    setResultSets: React.Dispatch<React.SetStateAction<QueryEditorResultSet[]>>;
    activateExecutedResult: (merged: QueryEditorResultSet[], executed: QueryEditorResultSet[], requestSeq: number) => void;
    runSeq: number;
}

export const runQueryEditorMongoStatements = async ({
    normalizedRawSQL, splitSQLStatements, normalizedDbType, resultSets, lastExecutedEditorQueryRef,
    currentQuery, normalizeExecutableStatementList, clearUnpinnedResultSets, queryOptions,
    setExecutionTimingActive, updateResultPanelVisibility, setExecutionError, isCurrentRun,
    runState, setQueryId, config, invokeRequestScopedApp, executionDbName, currentQueryIdRef,
    clearQueryId, addSqlLog, finishQueryEditorSqlClock, mergeResultSets, setResultSets,
    activateExecutedResult, runSeq,
}: RunQueryEditorMongoStatementsInput) => {
    // MongoDB: 保持逐条执行
    const splitInput = normalizedRawSQL
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/^\s*#.*$/gm, '');
    const statements = splitSQLStatements(splitInput, normalizedDbType);
    const didExecuteAppendedSql = resultSets.length > 0
        && lastExecutedEditorQueryRef.current
        && currentQuery.startsWith(lastExecutedEditorQueryRef.current)
        && normalizedRawSQL.trim() === currentQuery.slice(lastExecutedEditorQueryRef.current.length).replace(/；/g, ';').trim();
    const didExecuteWholeEditor = areSqlStatementListsEqual(
        normalizeExecutableStatementList(
            splitSQLStatements(currentQuery.replace(/；/g, ';'), normalizedDbType),
            normalizedDbType,
        ),
        statements,
    );
    if (statements.length === 0) {
        message.info(translate('query_editor.message.no_executable_sql'));
        clearUnpinnedResultSets();
        return;
    }

    const nextResultSets: QueryEditorResultSet[] = [];
    const maxRows = Number(queryOptions?.maxRows) || 0;
    const wantsLimitProbe = Number.isFinite(maxRows) && maxRows > 0;
    let anyTruncated = false;
    let mongoTotalDuration = 0;
    setExecutionTimingActive(true);
    try {
        for (let idx = 0; idx < statements.length; idx++) {
        const rawStatement = statements[idx];
        let executedSql = rawStatement;
        const shellConvert = convertMongoShellToJsonCommand(executedSql);
        if (shellConvert.recognized) {
            if (shellConvert.error) {
                const prefix = statements.length > 1
                    ? translate('query_editor.message.statement_failed_prefix', { index: idx + 1 })
                    : '';
                updateResultPanelVisibility(true);
                setExecutionError(formatSqlExecutionError(shellConvert.error, { prefix, translate }));
                clearUnpinnedResultSets();
                return;
            }
            if (shellConvert.command) {
                executedSql = shellConvert.command;
            }
        }
        if (wantsLimitProbe) {
            const limitResult = applyMongoQueryAutoLimit(executedSql, maxRows);
            if (limitResult.applied) {
                executedSql = limitResult.command;
            }
        }
        let queryId: string;
        try {
            queryId = await GenerateQueryID();
        } catch (error) {
            console.warn('GenerateQueryID failed, using local UUID fallback:', error);
            queryId = 'query-' + uuidv4();
        }
        if (!isCurrentRun()) return;
        runState.queryId = queryId;
        setQueryId(queryId);

        const startTime = Date.now();
        const mongoRPCConfig = buildRpcConnectionConfig(config) as any;
        const res = await invokeRequestScopedApp(
            'DBQueryWithCancel',
            [mongoRPCConfig, executionDbName, executedSql, queryId],
            () => DBQueryWithCancel(mongoRPCConfig, executionDbName, executedSql, queryId),
        );
        if (!isCurrentRun()) return;
        if (currentQueryIdRef.current === queryId) {
            clearQueryId();
            runState.queryId = '';
        }
        const legacyResultMessages = normalizeQueryResultMessages(res?.messages);
        const duration = resolveReportedQueryDurationMs(res, Date.now() - startTime);
        mongoTotalDuration += duration;
        addSqlLog({
            id: `log-${Date.now()}-query-${idx + 1}`,
            timestamp: Date.now(),
            sql: executedSql,
            status: res.success ? 'success' : 'error',
            duration,
            message: res.success ? '' : res.message,
            affectedRows: (res.success && !Array.isArray(res.data)) ? (res.data as any).affectedRows : (Array.isArray(res.data) ? res.data.length : undefined),
            dbName: executionDbName
        });
        if (!res.success) {
            const prefix = statements.length > 1
                ? translate('query_editor.message.statement_failed_prefix', { index: idx + 1 })
                : '';
            updateResultPanelVisibility(true);
            setExecutionError(formatSqlExecutionError(res.message, { prefix, translate }));
            clearUnpinnedResultSets(QUERY_EDITOR_SQL_LOG_TAB_KEY);
            return;
        }
        if (Array.isArray(res.data)) {
            let rows = (res.data as any[]) || [];
            let truncated = false;
            if (wantsLimitProbe && Number.isFinite(maxRows) && maxRows > 0 && rows.length > maxRows) {
                truncated = true;
                anyTruncated = true;
                rows = rows.slice(0, maxRows);
            }
            const cols = (res.fields && res.fields.length > 0)
                ? (res.fields as string[])
                : (rows.length > 0 ? Object.keys(rows[0]) : []);
            rows.forEach((row: any, i: number) => {
                if (row && typeof row === 'object') row[GONAVI_ROW_KEY] = i;
            });
            nextResultSets.push({
                key: `result-${idx + 1}`,
                sql: rawStatement,
                exportSql: rawStatement,
                sourceStatementIndex: idx + 1,
                statementResultIndex: 1,
                rows,
                columns: cols,
                messages: legacyResultMessages,
                pkColumns: [],
                readOnly: true,
                truncated
            });
        } else if (legacyResultMessages.length > 0) {
            nextResultSets.push({
                key: `result-${idx + 1}`,
                sql: rawStatement,
                exportSql: rawStatement,
                sourceStatementIndex: idx + 1,
                statementResultIndex: 1,
                rows: [],
                columns: [],
                messages: legacyResultMessages,
                resultType: 'message',
                pkColumns: [],
                readOnly: true,
            });
        } else {
            const affected = Number((res.data as any)?.affectedRows);
            if (Number.isFinite(affected)) {
                const row = { affectedRows: affected };
                (row as any)[GONAVI_ROW_KEY] = 0;
                nextResultSets.push({
                    key: `result-${idx + 1}`,
                    sql: rawStatement,
                    exportSql: rawStatement,
                    sourceStatementIndex: idx + 1,
                    statementResultIndex: 1,
                    rows: [row],
                    columns: ['affectedRows'],
                    messages: legacyResultMessages,
                    pkColumns: [],
                    readOnly: true
                });
            }
        }
    }
    } finally {
        if (isCurrentRun()) {
            runState.sqlDurationMs = mongoTotalDuration;
            finishQueryEditorSqlClock({ durationMs: mongoTotalDuration }, 0);
        }
    }
    if (nextResultSets.length > 0) {
        updateResultPanelVisibility(true);
    }
    const shouldReplaceAllResults = didExecuteWholeEditor;
    const mergedResultSets = mergeResultSets(resultSets, nextResultSets, shouldReplaceAllResults);
    setResultSets(mergedResultSets);
    activateExecutedResult(mergedResultSets, nextResultSets, runSeq);
    if (didExecuteAppendedSql || didExecuteWholeEditor) {
        lastExecutedEditorQueryRef.current = currentQuery;
    }
    if (statements.length > 1) {
        message.success(translate('query_editor.message.execution_multi_success', {
            statements: statements.length,
            results: nextResultSets.length,
        }));
    } else if (nextResultSets.length === 0) {
        message.success(translate('query_editor.message.execution_success'));
    }
};
