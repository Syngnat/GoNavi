import { message } from 'antd';
import type { GridSortInfoItem } from '../../../utils/dataGridSort';
import { canUseQueryEditorDatabaseContext } from '../queryEditorLazyTablesCache';
import { resolveSqlDialect } from '../../../utils/sqlDialect';
import {
    buildQueryResultPageSql,
    resolveQueryResultPaginationTotal,
} from '../../../utils/queryResultPagination';
import { CancelQuery, GenerateQueryID } from '../../../../wailsjs/go/app/App';
import { t as translate } from '../../../i18n';
import { formatSqlExecutionError } from '../../../utils/sqlErrorSemantics';
import { GONAVI_ROW_KEY } from '../../DataGrid';
import { normalizeQueryResultMessages } from '../QueryEditorHelpers';
import { isWebRPCAbortError } from '../../../utils/webRpc';
import { parseQueryResultSortInfo, sortCompleteQueryResultRows } from '../queryEditorResultSort';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorEditorSplitApi } from './useQueryEditorEditorSplit';
import type { QueryEditorResultSetModelApi } from './useQueryEditorResultSetModel';

export interface UseQueryEditorResultPagingInput {
    resultSetsRef: QueryEditorCoreStateApi['resultSetsRef'];
    currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
    connections: QueryEditorConnectionContextApi['connections'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    runSeqRef: QueryEditorCoreStateApi['runSeqRef'];
    beginQueryEditorRunClock: QueryEditorCoreStateApi['beginQueryEditorRunClock'];
    setLoading: QueryEditorCoreStateApi['setLoading'];
    setResultSets: QueryEditorCoreStateApi['setResultSets'];
    currentQueryIdRef: QueryEditorCoreStateApi['currentQueryIdRef'];
    clearQueryId: QueryEditorEditorSplitApi['clearQueryId'];
    setQueryId: QueryEditorEditorSplitApi['setQueryId'];
    setExecutionTimingActive: QueryEditorCoreStateApi['setExecutionTimingActive'];
    executeSqlEditorMultiQuery: QueryEditorResultSetModelApi['executeSqlEditorMultiQuery'];
    splitSQLStatements: QueryEditorResultSetModelApi['splitSQLStatements'];
    finishQueryEditorSqlClock: QueryEditorCoreStateApi['finishQueryEditorSqlClock'];
}

export const useQueryEditorResultPaging = ({
    resultSetsRef, currentConnectionId, connections, currentDb, runSeqRef, beginQueryEditorRunClock,
    setLoading, setResultSets, currentQueryIdRef, clearQueryId, setQueryId,
    setExecutionTimingActive, executeSqlEditorMultiQuery, splitSQLStatements,
    finishQueryEditorSqlClock,
}: UseQueryEditorResultPagingInput) => {
    const handleResultPageChange = async (
        resultKey: string,
        page: number,
        pageSize: number,
        sortInfoOverride?: GridSortInfoItem[],
    ) => {
        const target = resultSetsRef.current.find((item) => item.key === resultKey);
        const executionConnectionId = target?.executionConnectionId || currentConnectionId;
        const conn = connections.find(c => c.id === executionConnectionId);
        if (!conn) return;
        const executionDbName = target?.executionDbName ?? currentDb;
        if (!target?.page?.baseSql || !canUseQueryEditorDatabaseContext(conn, executionDbName, target.page.baseSql)) return;
        const safePageSize = pageSize === 0
            ? 0
            : Math.max(1, Math.floor(Number(pageSize) || target.page.pageSize || 1));
        const safePage = safePageSize === 0 ? 1 : Math.max(1, Math.floor(Number(page) || 1));
        const config = {
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || "",
            database: conn.config.database || "",
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
        };
        const dbType = String(config.type || 'mysql');
        const driver = String((config as any).driver || '');
        const normalizedDbType = String(resolveSqlDialect(dbType, driver, {
            oceanBaseProtocol: String((config as any).oceanBaseProtocol || ''),
        })).toLowerCase();
        const pageSql = buildQueryResultPageSql({
            baseSql: target.page.baseSql,
            dbType: normalizedDbType,
            driver,
            oceanBaseProtocol: String((config as any).oceanBaseProtocol || ''),
            page: safePage,
            pageSize: safePageSize,
            lookahead: true,
            sortInfo: sortInfoOverride || target.sortInfo || [],
        });

        const runSeq = ++runSeqRef.current;
        const isCurrentRun = () => runSeqRef.current === runSeq;
        let runQueryId = '';
        beginQueryEditorRunClock(runSeq);
        setLoading(true);

        try {
            setResultSets(prev => prev.map(rs =>
                rs.key === resultKey && rs.page
                    ? { ...rs, page: { ...rs.page, loading: true } }
                    : rs
            ));
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
            let queryId: string;
            try {
                queryId = await GenerateQueryID();
            } catch {
                queryId = 'query-page-' + Date.now();
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
                    pageSql,
                    queryId,
                    splitSQLStatements(pageSql, normalizedDbType),
                    normalizedDbType,
                    target.executionConnectionParams,
                    executionConnectionId,
                    target.executionBindings,
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
                message.error(translate('query_editor.message.page_query_failed', {
                    error: formatSqlExecutionError(res?.message || translate('common.unknown'), { translate }),
                }));
                return;
            }

            const resultSetDataArray = Array.isArray(res.data) ? (res.data as any[]) : [];
            const rsData = resultSetDataArray[0];
            if (!rsData) {
                message.warning(translate('query_editor.message.page_query_empty'));
                return;
            }
            const rawRows = Array.isArray(rsData.rows) ? rsData.rows : [];
            const hasNext = safePageSize > 0 && rawRows.length > safePageSize;
            const rows = safePageSize > 0 ? rawRows.slice(0, safePageSize) : rawRows;
            const rowKeyOffset = safePageSize > 0 ? (safePage - 1) * safePageSize : 0;
            rows.forEach((row: any, i: number) => {
                if (row && typeof row === 'object') row[GONAVI_ROW_KEY] = rowKeyOffset + i;
            });
            const cols = (rsData.columns && rsData.columns.length > 0)
                ? rsData.columns
                : (rows.length > 0 ? Object.keys(rows[0]) : target.columns);
            const pageMessages = normalizeQueryResultMessages(rsData?.messages);
            const totalState = resolveQueryResultPaginationTotal({
                current: safePage,
                pageSize: safePageSize,
                rowCount: rows.length,
                hasNext,
            });
            setResultSets(prev => prev.map(rs => {
                if (rs.key !== resultKey || !rs.page) return rs;
                const hasExactTotal = rs.page.totalKnown === true
                    && Number.isFinite(Number(rs.page.total))
                    && Number(rs.page.total) >= 0;
                return {
                    ...rs,
                    rows,
                    columns: cols,
                    messages: pageMessages,
                    resultType: 'grid',
                    truncated: false,
                    page: {
                        ...rs.page,
                        current: safePage,
                        pageSize: safePageSize,
                        ...(hasExactTotal
                            ? { total: rs.page.total, totalKnown: true }
                            : totalState),
                        loading: false,
                    },
                };
            }));
        } catch (err: any) {
            if (!isCurrentRun()) return;
            if (isWebRPCAbortError(err)) return;
            message.error(translate('query_editor.message.page_query_failed', {
                error: formatSqlExecutionError(err?.message || err || translate('common.unknown'), { translate }),
            }));
        } finally {
            if (isCurrentRun()) {
                setLoading(false);
                setResultSets(prev => prev.map(rs =>
                    rs.key === resultKey && rs.page?.loading
                        ? { ...rs, page: { ...rs.page, loading: false } }
                        : rs
                ));
            }
            if (runQueryId && currentQueryIdRef.current === runQueryId) {
                clearQueryId();
            }
        }
    };

    const handleResultSort = async (resultKey: string, field: string, order: string) => {
        const nextSortInfo = parseQueryResultSortInfo(field, order);
        const target = resultSetsRef.current.find((item) => item.key === resultKey);
        if (!target) return;

        if (target.page) {
            setResultSets(prev => prev.map(rs => (
                rs.key === resultKey ? { ...rs, sortInfo: nextSortInfo } : rs
            )));
            await handleResultPageChange(resultKey, 1, target.page.pageSize, nextSortInfo);
            return;
        }

        setResultSets(prev => prev.map(rs => (
            rs.key === resultKey
                ? {
                    ...rs,
                    rows: sortCompleteQueryResultRows(rs.rows, nextSortInfo),
                    sortInfo: nextSortInfo,
                }
                : rs
        )));
    };
    return { handleResultPageChange, handleResultSort };
};

export type QueryEditorResultPagingApi = ReturnType<typeof useQueryEditorResultPaging>;
