import { message } from 'antd';
import { v4 as uuidv4 } from 'uuid';
import {
    areSqlStatementListsEqual, resolveOracleLikeDefaultSchemaName, normalizeMetadataDialect,
    type CompletionTableMeta, matchLeadingSelectTableReference, splitQueryIdentifierPathSegments,
    resolveOracleLikeLookupSchemaCandidates, isOracleBaseTableReference,
    resolveOracleExactCaseTableReference, rewriteLeadingSelectTableReference,
    type QueryStatementPlan, resolveQueryLocatorPlan,
} from '../QueryEditorHelpers';
import { t as translate } from '../../../i18n';
import {
    isQueryEditorTriggerDropStatement, hasSqlExecutionOutcomeUnknown, type QueryEditorRunScope,
} from '../queryEditorRunHelpers';
import { isTableDesignerTriggerCreateStatement as isQueryEditorTriggerCreateStatement } from '../../tableDesignerExecutionSql';
import {
    shouldUseSqlEditorManagedTransactionForType, isSqlEditorSchemaChangingStatement,
} from '../../../utils/sqlEditorTransaction';
import { isOracleLikeDialect } from '../../../utils/sqlDialect';
import {
    type QueryEditorMetadataRequestSnapshot, invalidateQueryEditorHoverDdlCacheForConnection,
} from '../queryEditorHoverDdl';
import {
    DBGetTables, GenerateQueryID, DBQueryMultiTransactionalWithParams,
    DBQueryMultiTransactionalWithOptions, DBRollbackTransactionWithTrigger, DBQuery,
} from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { extractTableNameFromMetadataRow } from '../../../utils/tableMetadataRows';
import { buildCompletionTableMetadataIdentityKey } from '../queryEditorCompletionTables';
import { setSharedTablesData } from '../queryEditorCompletionState';
import { applyQueryAutoLimit } from '../../../utils/queryAutoLimit';
import {
    type QueryParamBindingInput, bindingsFromValues, collectMissingParamNames,
    type QueryParameterAnalysisInfo,
} from '../params/queryEditorParamsModel';
import { buildQueryEditorResultBudgetOptions } from '../queryEditorResultBudget';
import { resolveReportedQueryDurationMs } from '../queryEditorExecutionTimer';
import {
    collectOracleCompileTargets, loadOracleCompileErrors, formatOracleCompileErrors,
} from '../../sidebar/oracleObjectCompilation';
import { dispatchSidebarDatabaseRefresh } from '../../../utils/sidebarDatabaseRefresh';
import { handleQueryEditorRunFailure } from './queryEditorRunFailure';
import { collectQueryEditorRunResultSets } from './queryEditorRunResultSets';
import {
    finalizeQueryEditorSqlServerResultSets, resolveQueryEditorExecutionSuccessToast,
} from '../queryEditorSqlServerResultMessages';
import type { QueryEditorResultSet } from '../../QueryEditorResultsPanel';
import type { TabData, ConnectionConfig } from '../../../types';
import type { useSqlEditorTransactionController } from '../../useSqlEditorTransactionController';
import type { DataSourceCapabilities } from '../../../utils/dataSourceCapabilities';
import type { SavedConnection } from '../../../typeDefs/connectionTypes';
import type { QueryOptions, SqlLog } from '../../../store/storeStateTypes';
import type { useQueryEditorSqlErrorLocator } from '../useQueryEditorSqlErrorLocator';
import type { QueryEditorParamsState } from '../params/useQueryEditorParams';
import type { connection } from '../../../../wailsjs/go/models';

export interface RunQueryEditorSqlStatementsInput {
    splitSQLStatements: (sql: string, dbType?: string) => string[];
    normalizedRawSQL: string;
    normalizedDbType: string;
    resultSets: QueryEditorResultSet[];
    lastExecutedEditorQueryRef: React.MutableRefObject<string>;
    currentQuery: string;
    normalizeExecutableStatementList: (statements: string[], dbType?: string) => string[];
    clearUnpinnedResultSets: (fallbackActiveKey?: string) => QueryEditorResultSet[];
    tab: TabData;
    config: ConnectionConfig;
    pendingSqlTransactionRef: ReturnType<typeof useSqlEditorTransactionController>['pendingSqlTransactionRef'];
    connCaps: DataSourceCapabilities;
    conn: SavedConnection;
    metadataGenerationRef: React.MutableRefObject<number>;
    currentConnectionId: string;
    isQueryEditorMetadataRequestCurrent: (snapshot: QueryEditorMetadataRequestSnapshot) => boolean;
    tablesRef: React.MutableRefObject<CompletionTableMeta[]>;
    isActive: boolean;
    executionDbName: string;
    isCurrentRun: () => boolean;
    executionConfig: Record<string, any>;
    queryOptions: QueryOptions;
    driver: string;
    containsOraclePlsqlDefinition: (statements: string[]) => boolean;
    normalizeOracleSqlPlusSlashTerminators: (sql: string) => string;
    recordExecutionOrigin: ReturnType<typeof useQueryEditorSqlErrorLocator>['recordExecutionOrigin'];
    executableSQL: string;
    runOptions: { skipParamsGate?: boolean; } | undefined;
    paramsDialogState: { open: boolean; analysis: QueryParameterAnalysisInfo | null; };
    paramsState: QueryEditorParamsState;
    setLoading: React.Dispatch<React.SetStateAction<boolean>>;
    lastParamsRunScopeRef: React.MutableRefObject<QueryEditorRunScope>;
    runScope: QueryEditorRunScope;
    setParamsDialogState: React.Dispatch<React.SetStateAction<{ open: boolean; analysis: QueryParameterAnalysisInfo | null; }>>;
    runState: { queryId: string; sqlDurationMs?: number; };
    setQueryId: (id: string) => void;
    setExecutionTimingActive: React.Dispatch<React.SetStateAction<boolean>>;
    executeSqlEditorMultiQuery: (config: Record<string, any>, dbName: string, sql: string, queryId: string, sourceStatements: string[], dbType?: string, connectionParamsOverride?: string, executionConnectionId?: string, paramBindings?: QueryParamBindingInput[]) => Promise<connection.QueryResult>;
    executionConnectionParams: string | undefined;
    finishQueryEditorSqlClock: (result: { durationMs?: unknown; } | null | undefined, startedAt: number) => number;
    queryEditorUnmountedRef: React.MutableRefObject<boolean>;
    addSqlLog: (log: SqlLog) => void;
    currentQueryIdRef: React.MutableRefObject<string>;
    clearQueryId: () => void;
    updateResultPanelVisibility: (visible: boolean) => void;
    setExecutionError: React.Dispatch<React.SetStateAction<string>>;
    mutatingStatements: string[];
    activatePendingSqlTransaction: ReturnType<typeof useSqlEditorTransactionController>['activatePendingSqlTransaction'];
    sqlEditorCommitMode: "manual" | "auto";
    sqlEditorAutoCommitDelayMs: number;
    appendPendingSqlTransactionExecution: ReturnType<typeof useSqlEditorTransactionController>['appendPendingSqlTransactionExecution'];
    hasConcreteQueryResultSetData: (result: any, messages: string[]) => boolean;
    isAffectedRowsResultSetData: (result?: any) => boolean;
    mergeResultSets: (previous: QueryEditorResultSet[], next: QueryEditorResultSet[], replaceAll: boolean) => QueryEditorResultSet[];
    setResultSets: React.Dispatch<React.SetStateAction<QueryEditorResultSet[]>>;
    activateExecutedResult: (merged: QueryEditorResultSet[], executed: QueryEditorResultSet[], requestSeq: number) => void;
    runSeq: number;
}

export const runQueryEditorSqlStatements = async ({
    splitSQLStatements, normalizedRawSQL, normalizedDbType, resultSets, lastExecutedEditorQueryRef,
    currentQuery, normalizeExecutableStatementList, clearUnpinnedResultSets, tab, config,
    pendingSqlTransactionRef, connCaps, conn, metadataGenerationRef, currentConnectionId,
    isQueryEditorMetadataRequestCurrent, tablesRef, isActive, executionDbName, isCurrentRun,
    executionConfig, queryOptions, driver, containsOraclePlsqlDefinition,
    normalizeOracleSqlPlusSlashTerminators, recordExecutionOrigin, executableSQL, runOptions,
    paramsDialogState, paramsState, setLoading, lastParamsRunScopeRef, runScope,
    setParamsDialogState, runState, setQueryId, setExecutionTimingActive,
    executeSqlEditorMultiQuery, executionConnectionParams, finishQueryEditorSqlClock,
    queryEditorUnmountedRef, addSqlLog, currentQueryIdRef, clearQueryId,
    updateResultPanelVisibility, setExecutionError, mutatingStatements,
    activatePendingSqlTransaction, sqlEditorCommitMode, sqlEditorAutoCommitDelayMs,
    appendPendingSqlTransactionExecution, hasConcreteQueryResultSetData,
    isAffectedRowsResultSetData, mergeResultSets, setResultSets, activateExecutedResult, runSeq,
}: RunQueryEditorSqlStatementsInput) => {
    // 非 MongoDB：使用 DBQueryMulti 一次性执行多条 SQL，后端返回多结果集
    const sourceStatements = splitSQLStatements(normalizedRawSQL, normalizedDbType);
    const didExecuteAppendedSql = resultSets.length > 0
        && lastExecutedEditorQueryRef.current
        && currentQuery.startsWith(lastExecutedEditorQueryRef.current)
        && normalizedRawSQL.trim() === currentQuery.slice(lastExecutedEditorQueryRef.current.length).replace(/；/g, ';').trim();
    const didExecuteWholeEditor = areSqlStatementListsEqual(
        normalizeExecutableStatementList(
            splitSQLStatements(currentQuery.replace(/；/g, ';'), normalizedDbType),
            normalizedDbType,
        ),
        sourceStatements,
    );
    if (sourceStatements.length === 0) {
        message.info(translate('query_editor.message.no_executable_sql'));
        clearUnpinnedResultSets();
        return;
    }
    const triggerDropStatementIndex = sourceStatements.findIndex(isQueryEditorTriggerDropStatement);
    const isTriggerObjectEdit = tab.queryMode === 'object-edit'
        && Boolean(tab.triggerName || tab.triggerRollbackSql);
    if (
        isTriggerObjectEdit
        && triggerDropStatementIndex >= 0
        && !sourceStatements.some(isQueryEditorTriggerCreateStatement)
    ) {
        message.error(translate('trigger_viewer.edit_sql.empty_definition'));
        return;
    }
    const useManagedTransaction = shouldUseSqlEditorManagedTransactionForType(normalizedDbType, sourceStatements, config);
    if (useManagedTransaction && pendingSqlTransactionRef.current) {
        message.warning(translate('query_editor.transaction.message.pending_managed_transaction'));
        return;
    }
    const managedTransactionStatementCount = sourceStatements
        .filter((statement) => shouldUseSqlEditorManagedTransactionForType(normalizedDbType, [statement], config))
        .length || sourceStatements.length;

    const forceReadOnlyResult = connCaps.forceReadOnlyQueryResult;
    const defaultOracleSchema = isOracleLikeDialect(normalizedDbType)
        ? resolveOracleLikeDefaultSchemaName(config)
        : '';
    const metadataDialect = normalizeMetadataDialect(conn);
    const oracleTableCache = new Map<string, CompletionTableMeta[]>();
    const getOracleTablesForDb = async (dbName: string): Promise<CompletionTableMeta[]> => {
        const normalizedDbName = String(dbName || '').trim();
        if (!normalizedDbName) return [];
        const cacheKey = normalizedDbName.toLowerCase();
        const cached = oracleTableCache.get(cacheKey);
        if (cached) return cached;

        try {
            const metadataSnapshot: QueryEditorMetadataRequestSnapshot = {
                generation: metadataGenerationRef.current,
                connectionId: currentConnectionId,
                connectionConfig: conn.config,
            };
            const resTables = await DBGetTables(buildRpcConnectionConfig(config) as any, normalizedDbName);
            if (!resTables?.success || !Array.isArray(resTables.data)) {
                oracleTableCache.set(cacheKey, []);
                return [];
            }
            const fetchedTables = resTables.data
                .map((row: any) => {
                    const tableName = extractTableNameFromMetadataRow(row);
                    if (!tableName) return null;
                    return {
                        dbName: normalizedDbName,
                        tableName,
                    } as CompletionTableMeta;
                })
                .filter(Boolean) as CompletionTableMeta[];
            if (
                fetchedTables.length > 0
                && isQueryEditorMetadataRequestCurrent(metadataSnapshot)
            ) {
                const knownKeys = new Set(tablesRef.current.map((table) => buildCompletionTableMetadataIdentityKey(
                    metadataDialect,
                    table.dbName,
                    table.tableName,
                )));
                const missing = fetchedTables.filter((table) => !knownKeys.has(
                    buildCompletionTableMetadataIdentityKey(
                        metadataDialect,
                        table.dbName,
                        table.tableName,
                    ),
                ));
                if (missing.length > 0) {
                    tablesRef.current = [...tablesRef.current, ...missing];
                    if (isActive) {
                        setSharedTablesData(tablesRef.current);
                    }
                }
            }
            oracleTableCache.set(cacheKey, fetchedTables);
            return fetchedTables;
        } catch {
            oracleTableCache.set(cacheKey, []);
            return [];
        }
    };
    const executedSourceStatements: string[] = [];
    const allowOracleRowIDByStatement: boolean[] = [];
    for (const statement of sourceStatements) {
        let executableStatement = statement;
        let allowOracleRowID = false;
        if (isOracleLikeDialect(normalizedDbType)) {
            const leadingTable = matchLeadingSelectTableReference(statement);
            if (leadingTable) {
                const leadingSegments = splitQueryIdentifierPathSegments(leadingTable.tableText);
                const oracleLookupDbCandidates = leadingSegments.length >= 2
                    ? [String(leadingSegments[0]?.value || '').trim()].filter(Boolean)
                    : resolveOracleLikeLookupSchemaCandidates(config, executionDbName);
                let exactQualifiedTable: string | undefined;
                for (const oracleLookupDbName of oracleLookupDbCandidates) {
                    const oracleTables = oracleLookupDbName ? await getOracleTablesForDb(oracleLookupDbName) : [];
                    if (!isCurrentRun()) return;
                    if (
                        isOracleBaseTableReference(statement, oracleLookupDbName, oracleTables)
                    ) {
                        allowOracleRowID = true;
                    }
                    exactQualifiedTable = resolveOracleExactCaseTableReference(statement, oracleLookupDbName, oracleTables, {
                        qualifyUnqualified: Boolean(
                            leadingSegments.length === 1
                            && oracleLookupDbName
                            && oracleLookupDbName.toLowerCase() !== String(defaultOracleSchema || '').trim().toLowerCase(),
                        ),
                    });
                    if (exactQualifiedTable) {
                        break;
                    }
                }
                if (exactQualifiedTable) {
                    executableStatement = rewriteLeadingSelectTableReference(statement, exactQualifiedTable) || statement;
                }
            }
        }
        executedSourceStatements.push(executableStatement);
        allowOracleRowIDByStatement.push(allowOracleRowID);
    }
    const statementPlans: QueryStatementPlan[] = [];
    for (let index = 0; index < sourceStatements.length; index += 1) {
        const statementForPlan = executedSourceStatements[index] || sourceStatements[index];
        try {
            const statementPlan = await resolveQueryLocatorPlan({
                statement: statementForPlan,
                originalStatement: sourceStatements[index],
                dbType: normalizedDbType,
                currentDb: executionDbName,
                config: executionConfig,
                forceReadOnly: forceReadOnlyResult,
                allowOracleRowID: allowOracleRowIDByStatement[index],
            });
            if (!isCurrentRun()) return;
            statementPlans.push(statementPlan);
        } catch (planError) {
            if (!isCurrentRun()) return;
            // 行定位计划失败绝不能阻断查询执行，兜底裸计划保证结果页始终呈现。
            console.warn('resolveQueryLocatorPlan failed; falling back to a bare statement plan', planError);
            statementPlans.push({
                originalSql: sourceStatements[index],
                executedSql: statementForPlan,
                pkColumns: [],
            });
        }
    }

    // 自动给 SELECT 语句注入行数限制（防止大结果集卡死）
    const maxRowsForLimit = Number(queryOptions?.maxRows) || 0;
    let anyLimitApplied = false;
    const executablePlans = statementPlans.map((plan) => {
        if (!Number.isFinite(maxRowsForLimit) || maxRowsForLimit <= 0) return plan;
        const result = applyQueryAutoLimit(plan.executedSql, normalizedDbType, maxRowsForLimit, driver);
        if (result.applied) anyLimitApplied = true;
        return { ...plan, executedSql: result.sql };
    });
    const executableStatements = executablePlans.map((plan) => plan.executedSql);
    const shouldPreserveOraclePlsqlBatch = isOracleLikeDialect(normalizedDbType) && containsOraclePlsqlDefinition(sourceStatements);
    const fullSQL = shouldPreserveOraclePlsqlBatch
        ? normalizeOracleSqlPlusSlashTerminators(normalizedRawSQL)
        : executableStatements.join(';\n');
    recordExecutionOrigin(currentQuery, executableSQL, fullSQL, executablePlans);

    // 运行时绑定参数门控：以刚要执行的 SQL 做权威分析。
    // skipParamsGate 表示用户已在绑定对话框确认——按对话框分析结果
    // 与会话值构建绑定（对话框在缺值时禁用确认按钮），不再重复分析。
    let paramBindings: QueryParamBindingInput[] | undefined;
    if (runOptions?.skipParamsGate) {
        const confirmed = paramsDialogState.analysis;
        if (confirmed && confirmed.parameterNames.length > 0) {
            paramBindings = bindingsFromValues(confirmed.parameterNames, paramsState.values);
        }
    } else {
        const freshAnalysis = await paramsState.analyzeNow(fullSQL, executionDbName);
        if (freshAnalysis && freshAnalysis.parameterNames.length > 0) {
            if (!freshAnalysis.supported) {
                message.error(translate(freshAnalysis.messageKey || 'query_editor.params.unsupported_driver'));
                if (isCurrentRun()) setLoading(false);
                return;
            }
            const missing = collectMissingParamNames(freshAnalysis.parameterNames, paramsState.values);
            if (missing.length > 0) {
                lastParamsRunScopeRef.current = runScope;
                setParamsDialogState({ open: true, analysis: freshAnalysis });
                message.warning(translate('query_editor.params.missing_hint', { names: missing.join(', ') }));
                if (isCurrentRun()) setLoading(false);
                return;
            }
            paramBindings = bindingsFromValues(freshAnalysis.parameterNames, paramsState.values);
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

    let res: any = undefined;
    const startTime = Date.now();
    const resultBudget = buildQueryEditorResultBudgetOptions(queryOptions?.maxRows);
    setExecutionTimingActive(true);
    try {
        res = useManagedTransaction
            ? (paramBindings
                ? await DBQueryMultiTransactionalWithParams(
                    buildRpcConnectionConfig(executionConfig) as any,
                    executionDbName,
                    fullSQL,
                    queryId,
                    paramBindings,
                )
                : await DBQueryMultiTransactionalWithOptions(
                    buildRpcConnectionConfig(executionConfig) as any,
                    executionDbName,
                    fullSQL,
                    queryId,
                    resultBudget,
                ))
            : await executeSqlEditorMultiQuery(
                config,
                executionDbName,
                fullSQL,
                queryId,
                executableStatements,
                normalizedDbType,
                executionConnectionParams,
                currentConnectionId,
                paramBindings,
            );
    } catch (error: any) {
        // A rejected Wails call has the same ambiguity as a returned
        // outcomeUnknown response for DDL: the server may have
        // committed before the transport failed. Feed a normalized
        // failure through the existing refresh/no-compensation path.
        const schemaChangingRun = sourceStatements.some((statement) => (
            isSqlEditorSchemaChangingStatement(statement, normalizedDbType)
        ));
        if (!schemaChangingRun) {
            throw error;
        }
        res = {
            success: false,
            message: error?.message || String(error || translate('common.unknown')),
            data: [],
            outcomeUnknown: true,
        };
    } finally {
        if (isCurrentRun()) {
            runState.sqlDurationMs = finishQueryEditorSqlClock(res, startTime);
        }
    }
    if (!res || typeof res.success !== 'boolean') {
        if (!sourceStatements.some((statement) => (
            isSqlEditorSchemaChangingStatement(statement, normalizedDbType)
        ))) {
            throw new Error(String(res?.message || translate('common.unknown')));
        }
        res = {
            ...(res && typeof res === 'object' ? res : {}),
            success: false,
            message: String(res?.message || translate('common.unknown')),
            data: Array.isArray(res?.data) ? res.data : [],
            outcomeUnknown: true,
        };
    }
    if (queryEditorUnmountedRef.current) {
        // The tab may have closed after the backend created the
        // transaction but before this RPC response reached React.
        // It was never registered in the transaction controller, so
        // roll it back directly instead of leaving an orphaned lock.
        if (res?.transactionPending && res?.transactionId) {
            void Promise.resolve(DBRollbackTransactionWithTrigger(String(res.transactionId), 'tab_close'))
                .catch(() => undefined);
        }
        return;
    }
    if (!isCurrentRun()) return;
    const duration = runState.sqlDurationMs ?? resolveReportedQueryDurationMs(res, Date.now() - startTime);
    let oracleCompileFailureMessage = '';
    if (res?.success && isOracleLikeDialect(normalizedDbType)) {
        const compileTargets = collectOracleCompileTargets(sourceStatements);
        if (compileTargets.length > 0) {
            try {
                const compileErrors = await loadOracleCompileErrors(compileTargets, {
                    query: async (sql) => DBQuery(
                        buildRpcConnectionConfig(executionConfig) as any,
                        executionDbName,
                        sql,
                    ),
                });
                if (!isCurrentRun()) return;
                if (compileErrors.length > 0) {
                    oracleCompileFailureMessage = formatOracleCompileErrors(compileErrors);
                    res = {
                        ...(res && typeof res === 'object' ? res : {}),
                        success: false,
                        message: oracleCompileFailureMessage,
                        executedCount: sourceStatements.length,
                    };
                }
            } catch {
                if (!isCurrentRun()) return;
            }
        }
    }

    addSqlLog({
        id: `log-${Date.now()}-query-multi`,
        timestamp: Date.now(),
        sql: sourceStatements.join(';\n'),
        status: res.success ? 'success' : 'error',
        duration,
        message: res.success ? '' : res.message,
        dbName: executionDbName
    });

    const confirmedStatementCount = res.success
        ? sourceStatements.length
        : Math.max(0, Math.min(sourceStatements.length, Number(res.executedCount) || 0));
    const schemaInvalidationStatements = hasSqlExecutionOutcomeUnknown(res)
        ? sourceStatements
        : sourceStatements.slice(0, res.success
            ? confirmedStatementCount
            : Math.min(sourceStatements.length, confirmedStatementCount + 1));
    if (schemaInvalidationStatements.some((statement) => (
        isSqlEditorSchemaChangingStatement(statement, normalizedDbType)
    ))) {
        invalidateQueryEditorHoverDdlCacheForConnection(conn.id);
        dispatchSidebarDatabaseRefresh({
            connectionId: conn.id,
            dbName: executionDbName,
        });
    }

    if (!res.success) {
        await handleQueryEditorRunFailure({
            oracleCompileFailureMessage, res, tab, normalizedDbType, sourceStatements,
            executionConfig, executionDbName, isCurrentRun, conn, clearUnpinnedResultSets,
            currentQueryIdRef, queryId, clearQueryId, updateResultPanelVisibility,
            setExecutionError,
        });
        return;
    }

    // 有写操作、后端却没返回 transactionPending，说明本次是以 autocommit 落地的
    // （DDL / TRUNCATE / CALL / 存储过程 / 非事务数据源，见后端 shouldUseManagedSQLTransaction）。
    // 前端自己的 useManagedTransaction 判定比后端宽松，直接采信它会把 DDL 误报成"已托管"，
    // 所以这里以后端的实际响应为准。必须显式告知，不能静默假装已保护（§3.2 验收 3）。
    if (res.success && mutatingStatements.length > 0 && !res.transactionPending) {
        message.warning(translate('query_editor.transaction.message.executed_without_transaction'), 6);
    }

    if (res.transactionPending && res.transactionId) {
        const transactionId = String(res.transactionId);
        if (useManagedTransaction) {
            activatePendingSqlTransaction({
                id: transactionId,
                commitMode: sqlEditorCommitMode,
                autoCommitDelayMs: sqlEditorAutoCommitDelayMs,
                createdAt: Date.now(),
                statementCount: managedTransactionStatementCount,
                dbType: normalizedDbType,
                dbName: executionDbName,
                statements: sourceStatements,
                executionDurationMs: duration,
                connectionId: currentConnectionId,
            });
        } else {
            appendPendingSqlTransactionExecution({
                transactionId,
                statements: sourceStatements,
                durationMs: duration,
            });
        }
    }

    const {
        resultSetDataArray, topLevelMessages, nextResultSets, statementResultCounts,
    } = collectQueryEditorRunResultSets({
        res, queryOptions, normalizedDbType, sourceStatements,
        hasConcreteQueryResultSetData, executablePlans, isAffectedRowsResultSetData,
        anyLimitApplied, driver, currentConnectionId, executionDbName,
        executionConnectionParams, paramBindings, forceReadOnlyResult,
    });

    if (topLevelMessages.length > 0 && !nextResultSets.some((result) => Array.isArray(result.messages) && result.messages.length > 0)) {
        nextResultSets.push({
            key: `result-${nextResultSets.length + 1}`,
            sql: fullSQL,
            exportSql: sourceStatements.join(';\n'),
            sourceStatementIndex: 1,
            statementResultIndex: (statementResultCounts.get(1) || 0) + 1,
            rows: [],
            columns: [],
            messages: topLevelMessages,
            resultType: 'message',
            pkColumns: [],
            readOnly: true,
        });
    }
    const visibleResultSets = finalizeQueryEditorSqlServerResultSets(normalizedDbType, nextResultSets);

    if (visibleResultSets.length > 0) {
        updateResultPanelVisibility(true);
    }
    const shouldReplaceAllResults = didExecuteWholeEditor;
    const mergedResultSets = mergeResultSets(resultSets, visibleResultSets, shouldReplaceAllResults);
    setResultSets(mergedResultSets);
    activateExecutedResult(mergedResultSets, visibleResultSets, runSeq);
    if (didExecuteAppendedSql || didExecuteWholeEditor) {
        lastExecutedEditorQueryRef.current = currentQuery;
    }

    executablePlans.forEach((plan) => {
        if (plan.warning) message.warning(plan.warning);
    });

    // 后端附带的提示信息（如本次改走逐条执行的多语句回退提示）
    if (res.message) {
        message.info(res.message);
    }
    const successToast = resolveQueryEditorExecutionSuccessToast(resultSetDataArray.length, visibleResultSets);
    if (successToast) {
        message.success(translate(successToast.key, successToast.params));
    }
};
