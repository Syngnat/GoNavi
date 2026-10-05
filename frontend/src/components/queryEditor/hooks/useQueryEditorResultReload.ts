import { message } from 'antd';
import { v4 as uuidv4 } from 'uuid';
import { useEffect } from 'react';
import { canUseQueryEditorDatabaseContext } from '../queryEditorLazyTablesCache';
import { resolveSqlDialect } from '../../../utils/sqlDialect';
import { CancelQuery, GenerateQueryID } from '../../../../wailsjs/go/app/App';
import { t as translate } from '../../../i18n';
import { formatSqlExecutionError } from '../../../utils/sqlErrorSemantics';
import {
    normalizeQueryResultMessages,
    resolveQueryEditorConnectionTimeout,
} from '../QueryEditorHelpers';
import { GONAVI_ROW_KEY } from '../../DataGrid';
import { isWebRPCAbortError } from '../../../utils/webRpc';
import {
    buildQueryResultCountSql,
    parseQueryResultTotalCount,
} from '../../../utils/queryResultPagination';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorEditorSplitApi } from './useQueryEditorEditorSplit';
import type { QueryEditorResultSetModelApi } from './useQueryEditorResultSetModel';

export interface UseQueryEditorResultReloadInput {
    resultSets: QueryEditorCoreStateApi['resultSets'];
    setResultSets: QueryEditorCoreStateApi['setResultSets'];
    currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
    connections: QueryEditorConnectionContextApi['connections'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    runSeqRef: QueryEditorCoreStateApi['runSeqRef'];
    beginQueryEditorRunClock: QueryEditorCoreStateApi['beginQueryEditorRunClock'];
    setLoading: QueryEditorCoreStateApi['setLoading'];
    currentQueryIdRef: QueryEditorCoreStateApi['currentQueryIdRef'];
    clearQueryId: QueryEditorEditorSplitApi['clearQueryId'];
    setQueryId: QueryEditorEditorSplitApi['setQueryId'];
    setExecutionTimingActive: QueryEditorCoreStateApi['setExecutionTimingActive'];
    executeSqlEditorMultiQuery: QueryEditorResultSetModelApi['executeSqlEditorMultiQuery'];
    splitSQLStatements: QueryEditorResultSetModelApi['splitSQLStatements'];
    finishQueryEditorSqlClock: QueryEditorCoreStateApi['finishQueryEditorSqlClock'];
    queryOptions: QueryEditorCoreStateApi['queryOptions'];
    resultSetsRef: QueryEditorCoreStateApi['resultSetsRef'];
    resultTotalCountRequestsRef: QueryEditorCoreStateApi['resultTotalCountRequestsRef'];
    resultTotalCountSeqRef: QueryEditorCoreStateApi['resultTotalCountSeqRef'];
    addSqlLog: QueryEditorConnectionContextApi['addSqlLog'];
    currentSchema: QueryEditorCoreStateApi['currentSchema'];
    resultTotalCountContextRef: QueryEditorCoreStateApi['resultTotalCountContextRef'];
}

export const useQueryEditorResultReload = ({
    resultSets, setResultSets, currentConnectionId, connections, currentDb, runSeqRef,
    beginQueryEditorRunClock, setLoading, currentQueryIdRef, clearQueryId, setQueryId,
    setExecutionTimingActive, executeSqlEditorMultiQuery, splitSQLStatements,
    finishQueryEditorSqlClock, queryOptions, resultSetsRef, resultTotalCountRequestsRef,
    resultTotalCountSeqRef, addSqlLog, currentSchema, resultTotalCountContextRef,
}: UseQueryEditorResultReloadInput) => {
    // 精准重查询单个结果集（提交事务 / 刷新按钮使用），不会重跑整个编辑器 SQL
    const handleReloadResult = async (
        resultKey: string,
        sql: string,
        executionContext?: {
            executionConnectionId?: string;
            executionDbName?: string;
            executionConnectionParams?: string;
            statementResultIndex?: number;
        },
    ) => {
        // Result keys are positional (`result-N`) and get reused across runs, so a
        // live lookup can resolve to a *different* result than the grid the user
        // clicked. Prefer the caller's own execution context, which is the result
        // actually being displayed.
        const currentResult = resultSets.find((item) => item.key === resultKey);
        const executionConnectionId = executionContext?.executionConnectionId
            || currentResult?.executionConnectionId
            || currentConnectionId;
        const conn = connections.find(c => c.id === executionConnectionId);
        if (!conn) return;
        const executionDbName = executionContext?.executionDbName
            ?? currentResult?.executionDbName
            ?? currentDb;
        if (!sql?.trim() || !canUseQueryEditorDatabaseContext(conn, executionDbName, sql)) return;
        const statementResultIndex = Math.max(
            1,
            Number(executionContext?.statementResultIndex ?? currentResult?.statementResultIndex ?? 1),
        );

        const config = {
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || "",
            database: conn.config.database || "",
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
        };
        const normalizedDbType = String(resolveSqlDialect(
            String(config.type || ''),
            String((config as any).driver || ''),
            { oceanBaseProtocol: String((config as any).oceanBaseProtocol || '') },
        )).trim().toLowerCase();

        const runSeq = ++runSeqRef.current;
        const isCurrentRun = () => runSeqRef.current === runSeq;
        let runQueryId = '';
        beginQueryEditorRunClock(runSeq);
        setLoading(true);

        try {
            if (currentQueryIdRef.current) {
                const previousQueryId = currentQueryIdRef.current;
                try {
                    await CancelQuery(previousQueryId);
                } catch {
                    // The previous query may already have completed.
                }
                if (!isCurrentRun()) return;
                if (currentQueryIdRef.current === previousQueryId) {
                    clearQueryId();
                }
            }
            // 保持与首次执行一致的后端路径，必要时复用挂起事务
            let queryId: string;
            try {
                queryId = await GenerateQueryID();
            } catch {
                queryId = 'reload-' + Date.now();
            }
            if (!isCurrentRun()) return;
            runQueryId = queryId;
            setQueryId(queryId);
            setExecutionTimingActive(true);
            const sqlStartedAt = Date.now();
            let res: any = undefined;
            try {
                res = await executeSqlEditorMultiQuery(
                    config,
                    executionDbName,
                    sql,
                    queryId,
                    splitSQLStatements(sql, normalizedDbType),
                    normalizedDbType,
                    executionContext?.executionConnectionParams ?? currentResult?.executionConnectionParams,
                    executionConnectionId,
                    currentResult?.executionBindings,
                );
            } finally {
                if (isCurrentRun()) {
                    finishQueryEditorSqlClock(res, sqlStartedAt);
                }
            }
            if (!isCurrentRun()) return;
            if (currentQueryIdRef.current === queryId) {
                clearQueryId();
                runQueryId = '';
            }
            if (!res?.success) {
                message.error(translate('query_editor.message.refresh_failed', {
                    error: formatSqlExecutionError(res?.message || translate('common.unknown'), { translate }),
                }));
                return;
            }

            const resultSetDataArray = Array.isArray(res.data) ? (res.data as any[]) : [];
            const rsData = resultSetDataArray[Math.max(0, statementResultIndex - 1)];
            if (!rsData) return;
            const isAffectedResult = Array.isArray(rsData.rows) && rsData.rows.length === 1
                && rsData.columns && rsData.columns.length === 1
                && rsData.columns[0] === 'affectedRows';
            if (isAffectedResult) return; // 不应该出现，但保险起见

            let rows = Array.isArray(rsData.rows) ? rsData.rows : [];
            const maxRows = Number(queryOptions?.maxRows) || 0;
            let truncated = false;
            if (Number.isFinite(maxRows) && maxRows > 0 && rows.length > maxRows) {
                truncated = true;
                rows = rows.slice(0, maxRows);
            }
            const cols = (rsData.columns && rsData.columns.length > 0)
                ? rsData.columns
                : (rows.length > 0 ? Object.keys(rows[0]) : []);
            const refreshedMessages = normalizeQueryResultMessages(rsData?.messages);
            rows.forEach((row: any, i: number) => {
                if (row && typeof row === 'object') row[GONAVI_ROW_KEY] = i;
            });

            // 只更新匹配的结果集的 rows 和 columns，保留 tableName/pkColumns/readOnly 等元数据
            setResultSets(prev => prev.map(rs =>
                rs.key === resultKey
                    ? {
                        ...rs,
                        rows,
                        columns: cols,
                        messages: refreshedMessages,
                        resultType: ((!Array.isArray(rsData.rows) || rsData.rows.length === 0) && (!Array.isArray(rsData.columns) || rsData.columns.length === 0) && refreshedMessages.length > 0)
                            ? 'message'
                            : 'grid',
                        truncated,
                    }
                    : rs
            ));
        } catch (err: any) {
            if (!isCurrentRun()) return;
            if (isWebRPCAbortError(err)) return;
            message.error(translate('query_editor.message.refresh_failed', {
                error: formatSqlExecutionError(err?.message || err || translate('common.unknown'), { translate }),
            }));
        } finally {
            if (isCurrentRun()) setLoading(false);
            if (runQueryId && currentQueryIdRef.current === runQueryId) {
                clearQueryId();
            }
        }
    };

    const handleRequestResultTotalCount = async (resultKey: string) => {
        const target = resultSetsRef.current.find((item) => item.key === resultKey);
        const executionConnectionId = target?.executionConnectionId || currentConnectionId;
        const conn = connections.find(c => c.id === executionConnectionId);
        if (!conn) return;
        const executionDbName = target?.executionDbName ?? currentDb;
        if (!target?.page?.baseSql || !canUseQueryEditorDatabaseContext(conn, executionDbName, target.page.baseSql) || resultTotalCountRequestsRef.current[resultKey]) return;
        const config = {
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || '',
            database: conn.config.database || '',
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
            timeout: resolveQueryEditorConnectionTimeout(conn.config),
        };
        const normalizedDbType = String(resolveSqlDialect(
            String(config.type || 'mysql'),
            String((config as any).driver || ''),
            { oceanBaseProtocol: String((config as any).oceanBaseProtocol || '') },
        )).toLowerCase();
        const countSql = buildQueryResultCountSql(target.page.baseSql, normalizedDbType);
        if (!countSql) return;
        const sequence = ++resultTotalCountSeqRef.current;
        resultTotalCountRequestsRef.current[resultKey] = { sequence, queryId: '' };
        setResultSets(prev => prev.map(rs =>
            rs.key === resultKey && rs.page
                ? { ...rs, page: { ...rs.page, totalCountLoading: true, totalCountCancelled: false } }
                : rs
        ));
        const countStartedAt = Date.now();
        const isCurrentRequest = () => {
            if (resultTotalCountRequestsRef.current[resultKey]?.sequence !== sequence) return false;
            const currentResult = resultSetsRef.current.find((item) => item.key === resultKey);
            return currentResult?.page?.baseSql === target.page?.baseSql;
        };
        const finishLoading = (cancelled = false) => {
            if (!isCurrentRequest()) return;
            delete resultTotalCountRequestsRef.current[resultKey];
            setResultSets(prev => prev.map(rs =>
                rs.key === resultKey && rs.page
                    ? { ...rs, page: { ...rs.page, totalCountLoading: false, totalCountCancelled: cancelled } }
                    : rs
            ));
        };

        try {
            let queryId: string;
            try {
                queryId = await GenerateQueryID();
            } catch {
                queryId = `query-total-${uuidv4()}`;
            }
            if (!isCurrentRequest()) return;
            resultTotalCountRequestsRef.current[resultKey] = { sequence, queryId };
            const res = await executeSqlEditorMultiQuery(
                config,
                executionDbName,
                countSql,
                queryId,
                [countSql],
                normalizedDbType,
                target.executionConnectionParams,
                executionConnectionId,
                target.executionBindings,
            );
            const duration = Date.now() - countStartedAt;
            addSqlLog({
                id: `log-${Date.now()}-query-total-count`,
                timestamp: Date.now(),
                sql: countSql,
                status: res?.success ? 'success' : 'error',
                duration,
                message: res?.success ? '' : String(res?.message || translate('data_viewer.message.total_count_failed')),
                dbName: executionDbName,
            });
            if (!isCurrentRequest()) return;
            if (!res?.success) {
                finishLoading();
                message.error(String(res?.message || translate('data_viewer.message.total_count_failed')));
                return;
            }
            const resultSetData = Array.isArray(res.data) ? res.data[0] : null;
            const countRow = Array.isArray(resultSetData?.rows) ? resultSetData.rows[0] : null;
            const total = parseQueryResultTotalCount(countRow);
            if (total === null) {
                finishLoading();
                message.error(translate('data_viewer.message.total_count_parse_failed'));
                return;
            }

            delete resultTotalCountRequestsRef.current[resultKey];
            setResultSets(prev => prev.map(rs =>
                rs.key === resultKey && rs.page
                    ? {
                        ...rs,
                        page: {
                            ...rs.page,
                            total,
                            totalKnown: true,
                            totalCountLoading: false,
                            totalCountCancelled: false,
                        },
                    }
                    : rs
            ));
        } catch (error: any) {
            if (!isCurrentRequest()) return;
            addSqlLog({
                id: `log-${Date.now()}-query-total-count-error`,
                timestamp: Date.now(),
                sql: countSql,
                status: 'error',
                duration: Date.now() - countStartedAt,
                message: String(error?.message || error || translate('common.unknown')),
                dbName: executionDbName,
            });
            finishLoading();
            message.error(translate('data_viewer.message.total_count_failed_detail', {
                detail: String(error?.message || error || translate('common.unknown')),
            }));
        }
    };

    const cancelResultTotalCountRequests = async (resultKeys: string[]) => {
        const uniqueKeys = Array.from(new Set(resultKeys));
        const pendingRequests = uniqueKeys
            .map((key) => ({ key, request: resultTotalCountRequestsRef.current[key] }))
            .filter((item) => Boolean(item.request));
        if (pendingRequests.length === 0) return;
        pendingRequests.forEach(({ key }) => {
            delete resultTotalCountRequestsRef.current[key];
        });
        const pendingKeySet = new Set(pendingRequests.map(({ key }) => key));
        setResultSets(prev => prev.map(rs =>
            pendingKeySet.has(rs.key) && rs.page
                ? { ...rs, page: { ...rs.page, totalCountLoading: false, totalCountCancelled: true } }
                : rs
        ));
        await Promise.all(pendingRequests.map(async ({ request }) => {
            if (!request?.queryId) return;
            try {
                await CancelQuery(request.queryId);
            } catch {
                // The query may have completed between the local cancellation and the backend call.
            }
        }));
    };

    useEffect(() => {
        const nextContext = `${currentConnectionId}\u0000${currentDb}\u0000${currentSchema}`;
        if (resultTotalCountContextRef.current === nextContext) return;
        resultTotalCountContextRef.current = nextContext;
        void cancelResultTotalCountRequests(Object.keys(resultTotalCountRequestsRef.current));
    }, [currentConnectionId, currentDb, currentSchema]);

    useEffect(() => () => {
        const requests = Object.values(resultTotalCountRequestsRef.current);
        resultTotalCountRequestsRef.current = {};
        requests.forEach((request) => {
            if (!request.queryId) return;
            void CancelQuery(request.queryId).catch(() => undefined);
        });
    }, []);

    const handleCancelResultTotalCount = async (resultKey: string) => {
        await cancelResultTotalCountRequests([resultKey]);
    };
    return {
        handleReloadResult, handleRequestResultTotalCount, cancelResultTotalCountRequests,
        handleCancelResultTotalCount,
    };
};

export type QueryEditorResultReloadApi = ReturnType<typeof useQueryEditorResultReload>;
