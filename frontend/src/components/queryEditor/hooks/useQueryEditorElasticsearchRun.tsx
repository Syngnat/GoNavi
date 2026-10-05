import { message } from 'antd';
import { v4 as uuidv4 } from 'uuid';
import { t as translate } from '../../../i18n';
import {
    normalizeEditorPosition,
    resolveQueryEditorConnectionTimeout,
} from '../QueryEditorHelpers';
import {
    resolveElasticsearchConsoleExecution,
    isElasticsearchConsoleRunCurrent,
    buildElasticsearchInspectionDisplayLabel,
} from '../../../utils/elasticsearchConsole';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import {
    CancelQuery,
    InspectElasticsearchConsole,
    GenerateQueryID,
    ExecuteElasticsearchConsole,
    DBGetDatabases,
} from '../../../../wailsjs/go/app/App';
import { showCountdownDangerConfirm } from '../../common/countdownDangerConfirm';
import type { QueryEditorResultSet } from '../../QueryEditorResultsPanel';
import {
    buildElasticsearchOutcomeMetadata,
    hasElasticsearchUncertainOutcome,
} from '../queryEditorRunHelpers';
import { dispatchSidebarDatabaseListRefresh } from '../../../utils/sidebarDatabaseRefresh';
import { filterVisibleDatabaseNames } from '../../../utils/databaseVisibility';
import { setSharedVisibleDbs } from '../queryEditorCompletionState';
import type { QueryEditorDraftSyncApi } from './useQueryEditorDraftSync';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorEditorSplitApi } from './useQueryEditorEditorSplit';
import type { QueryEditorExecutionStatusApi } from './useQueryEditorExecutionStatus';
import type { QueryEditorResultSetModelApi } from './useQueryEditorResultSetModel';
import type { QueryEditorAiContextApi } from './useQueryEditorAiContext';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorElasticsearchRunInput {
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    getCurrentQuery: QueryEditorDraftSyncApi['getCurrentQuery'];
    connections: QueryEditorConnectionContextApi['connections'];
    currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
    currentDb: QueryEditorCoreStateApi['currentDb'];
    editorRef: QueryEditorCoreStateApi['editorRef'];
    runSeqRef: QueryEditorCoreStateApi['runSeqRef'];
    currentQueryIdRef: QueryEditorCoreStateApi['currentQueryIdRef'];
    clearQueryId: QueryEditorEditorSplitApi['clearQueryId'];
    setElasticsearchServerMajor: QueryEditorConnectionContextApi['setElasticsearchServerMajor'];
    beginQueryEditorRunClock: QueryEditorCoreStateApi['beginQueryEditorRunClock'];
    setLoading: QueryEditorCoreStateApi['setLoading'];
    setExecutionError: QueryEditorCoreStateApi['setExecutionError'];
    setQueryId: QueryEditorEditorSplitApi['setQueryId'];
    setExecutionTimingActive: QueryEditorCoreStateApi['setExecutionTimingActive'];
    finishQueryEditorSqlClock: QueryEditorCoreStateApi['finishQueryEditorSqlClock'];
    updateResultPanelVisibility: QueryEditorExecutionStatusApi['updateResultPanelVisibility'];
    mergeResultSets: QueryEditorResultSetModelApi['mergeResultSets'];
    resultSetsRef: QueryEditorCoreStateApi['resultSetsRef'];
    setResultSets: QueryEditorCoreStateApi['setResultSets'];
    activateExecutedResult: QueryEditorResultSetModelApi['activateExecutedResult'];
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    visibleDbsRef: QueryEditorCoreStateApi['visibleDbsRef'];
    setDbList: QueryEditorCoreStateApi['setDbList'];
    currentDbRef: QueryEditorConnectionContextApi['currentDbRef'];
    handleDatabaseChange: QueryEditorAiContextApi['handleDatabaseChange'];
}

export const useQueryEditorElasticsearchRun = ({
    isActive, getCurrentQuery, connections, currentConnectionId, currentDb, editorRef, runSeqRef,
    currentQueryIdRef, clearQueryId, setElasticsearchServerMajor, beginQueryEditorRunClock,
    setLoading, setExecutionError, setQueryId, setExecutionTimingActive, finishQueryEditorSqlClock,
    updateResultPanelVisibility, mergeResultSets, resultSetsRef, setResultSets,
    activateExecutedResult, currentConnectionIdRef, visibleDbsRef, setDbList, currentDbRef,
    handleDatabaseChange,
}: UseQueryEditorElasticsearchRunInput) => {
    const handleElasticsearchRun = async (runAll = false) => {
        const fullSource = getCurrentQuery();
        if (!fullSource.trim()) return;
        const conn = connections.find((connection) => connection.id === currentConnectionId);
        if (!conn) {
            void message.error(translate('query_editor.message.connection_not_found'));
            return;
        }

        const firstExecutableLine = fullSource
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .find((line) => {
                const trimmed = line.trim();
                return trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//');
            })
            ?.trim() || '';
        if (!currentDb && (firstExecutableLine.startsWith('{') || firstExecutableLine.startsWith('['))) {
            void message.error(translate('query_editor.elasticsearch.no_index_for_json'));
            return;
        }

        const editor = editorRef.current;
        const model = editor?.getModel?.();
        const selection = editor?.getSelection?.();
        const position = normalizeEditorPosition(editor?.getPosition?.());
        const cursorOffset = model && position && typeof model.getOffsetAt === 'function'
            ? Number(model.getOffsetAt(position))
            : fullSource.length;
        const hasSelection = !!selection && !(typeof selection.isEmpty === 'function'
            ? selection.isEmpty()
            : selection.startLineNumber === selection.endLineNumber && selection.startColumn === selection.endColumn);
        const selectionRange = hasSelection && model && typeof model.getOffsetAt === 'function'
            ? {
                start: Number(model.getOffsetAt({
                    lineNumber: selection.startLineNumber,
                    column: selection.startColumn,
                })),
                end: Number(model.getOffsetAt({
                    lineNumber: selection.endLineNumber,
                    column: selection.endColumn,
                })),
            }
            : null;
        const resolution = runAll
            ? { ok: true as const, source: 'all' as const, text: fullSource }
            : resolveElasticsearchConsoleExecution(fullSource, cursorOffset, selectionRange);
        if (!resolution.ok) {
            void message.error(translate(resolution.error === 'selection_must_include_complete_requests'
                ? 'query_editor.elasticsearch.selection_incomplete'
                : 'query_editor.message.no_executable_sql'));
            return;
        }

        const sourceToExecute = resolution.text;
        const config = buildRpcConnectionConfig({
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || '',
            database: conn.config.database || '',
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
            timeout: resolveQueryEditorConnectionTimeout(conn.config),
        }) as any;

        const runSeq = ++runSeqRef.current;

        if (currentQueryIdRef.current) {
            const previousQueryID = currentQueryIdRef.current;
            try {
                await CancelQuery(previousQueryID);
            } catch {
                // A previous request may already have completed.
            }
            if (currentQueryIdRef.current === previousQueryID) {
                clearQueryId();
            }
            if (!isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) return;
        }

        let inspection: any;
        try {
            inspection = await InspectElasticsearchConsole(config, currentDb || '', sourceToExecute);
        } catch (error: any) {
            if (!isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) return;
            void message.error(`${translate('query_editor.elasticsearch.inspect_failed')}: ${error?.message || String(error || '')}`);
            return;
        }
        if (!isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) return;
        if (!inspection?.success || inspection?.blocked) {
            void message.error(`${translate('query_editor.elasticsearch.inspect_failed')}: ${inspection?.message || inspection?.blockReason || translate('common.unknown')}`);
            return;
        }
        if (Number(inspection.serverMajor) > 0) {
            setElasticsearchServerMajor(Number(inspection.serverMajor));
        }

        let confirmationToken = '';
        if (inspection.requiresConfirmation) {
            confirmationToken = String(inspection.confirmationToken || '');
            const confirmed = await new Promise<boolean>((resolve) => {
                let settled = false;
                const settle = (value: boolean) => {
                    if (settled) return;
                    settled = true;
                    resolve(value);
                };
                showCountdownDangerConfirm({
                    title: translate('query_editor.elasticsearch.confirm_title'),
                    confirmText: translate('common.confirm'),
                    content: (
                        <div>
                            <div>{translate('query_editor.elasticsearch.confirm_description')}</div>
                            <ul style={{ margin: '10px 0 0', paddingLeft: 20 }}>
                                {(Array.isArray(inspection.requests) ? inspection.requests : []).map((request: any) => (
                                    <li key={`${request.index}-${request.method}-${request.path}`}>
                                        {buildElasticsearchInspectionDisplayLabel(request)}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ),
                    onOk: () => settle(true),
                    onCancel: () => settle(false),
                    afterClose: () => settle(false),
                });
            });
            if (!confirmed || !isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) return;
        }

        if (getCurrentQuery() !== fullSource) {
            void message.error(translate('query_editor.elasticsearch.inspect_failed'));
            return;
        }

        beginQueryEditorRunClock(runSeq);
        setLoading(true);
        setExecutionError('');
        let queryID = '';
        try {
            try {
                queryID = await GenerateQueryID();
            } catch {
                queryID = `query-${uuidv4()}`;
            }
            if (!isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) return;
            setQueryId(queryID);
            setExecutionTimingActive(true);
            const sqlStartedAt = Date.now();
            let execution: any = undefined;
            try {
                execution = await ExecuteElasticsearchConsole(
                    config,
                    currentDb || '',
                    sourceToExecute,
                    queryID,
                    String(inspection.fingerprint || ''),
                    confirmationToken,
                );
            } finally {
                if (isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) {
                    finishQueryEditorSqlClock(execution, sqlStartedAt);
                }
            }
            if (!isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) {
                return;
            }

            const responseResults = Array.isArray(execution?.results) ? execution.results : [];
            const nextResultSets: QueryEditorResultSet[] = responseResults.map((response: any, index: number) => {
                const rows = Array.isArray(response.rows) ? response.rows : [];
                const columns = Array.isArray(response.columns) ? response.columns.map(String) : [];
                const affectedRows = Number(response.affectedRows);
                const displayRows = rows.length === 0 && Number.isFinite(affectedRows) && affectedRows !== 0
                    ? [{ affectedRows }]
                    : rows;
                const displayColumns = columns.length === 0 && displayRows.length > 0 && 'affectedRows' in displayRows[0]
                    ? ['affectedRows']
                    : columns;
                const requestLabel = String(response.requestLabel || `${response.method || 'REQUEST'} ${response.path || ''}`).trim();
                if (Number(response.serverMajor) > 0) {
                    setElasticsearchServerMajor(Number(response.serverMajor));
                }
                return {
                    key: `es-result-${runSeq}-${Number(response.index ?? index)}`,
                    sql: requestLabel,
                    sourceStatementIndex: Number(response.index ?? index),
                    statementResultIndex: 0,
                    rows: displayRows,
                    columns: displayColumns,
                    messages: response.message ? [String(response.message)] : [],
                    resultType: 'elasticsearch',
                    requestLabel,
                    httpStatus: Number(response.httpStatus) || undefined,
                    rawResponse: String(response.rawResponse || ''),
                    partialFailure: response.partialFailure === true || response.outcome === 'partial',
                    ...buildElasticsearchOutcomeMetadata(response),
                    pkColumns: [],
                    readOnly: true,
                };
            });
            if (nextResultSets.length > 0) {
                updateResultPanelVisibility(true);
                const merged = mergeResultSets(resultSetsRef.current, nextResultSets, runAll);
                setResultSets(merged);
                activateExecutedResult(merged, nextResultSets, runSeq);
            }
            if (!execution?.success) {
                const errorMessage = String(execution?.message || translate('query_editor.elasticsearch.execute_failed'));
                setExecutionError(hasElasticsearchUncertainOutcome(execution)
                    ? `${errorMessage} (${translate('query_editor.elasticsearch.outcome_unknown')})`
                    : errorMessage);
                updateResultPanelVisibility(true);
                return;
            }
            void message.success(translate('query_editor.elasticsearch.execution_success'));
            if (inspection.containsWrite) {
                dispatchSidebarDatabaseListRefresh({
                    connectionId: conn.id,
                    reason: 'elasticsearch-write',
                });
                void DBGetDatabases(config)
                    .then((databaseResult: any) => {
                        if (
                            String(currentConnectionIdRef.current || '').trim() !== conn.id
                            || !databaseResult?.success
                            || !Array.isArray(databaseResult.data)
                        ) {
                            return;
                        }
                        const returnedDatabaseNames = databaseResult.data
                            .map((row: any) => row.Database || row.database)
                            .filter((name: unknown): name is string => (
                                typeof name === 'string' && name.length > 0
                            ));
                        const databaseNames = filterVisibleDatabaseNames(conn, returnedDatabaseNames);
                        visibleDbsRef.current = databaseNames;
                        if (isActive) {
                            setSharedVisibleDbs(databaseNames);
                        }
                        setDbList(databaseNames);
                        const selectedIndex = String(currentDbRef.current || '').trim();
                        if (selectedIndex && !returnedDatabaseNames.includes(selectedIndex)) {
                            handleDatabaseChange('');
                        }
                    })
                    .catch(() => {
                        // The write already succeeded; the next sidebar/editor refresh can retry metadata.
                    });
            }
        } catch (error: any) {
            if (!isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) return;
            setExecutionError(`${translate('query_editor.elasticsearch.execute_failed')}: ${error?.message || String(error || '')}`);
            updateResultPanelVisibility(true);
        } finally {
            if (runSeqRef.current === runSeq) {
                setLoading(false);
            }
            if (currentQueryIdRef.current === queryID) {
                clearQueryId();
            }
        }
    };
    return { handleElasticsearchRun };
};

export type QueryEditorElasticsearchRunApi = ReturnType<typeof useQueryEditorElasticsearchRun>;
