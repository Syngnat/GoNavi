import { message } from 'antd';
import { v4 as uuidv4 } from 'uuid';
import {
    areSqlStatementListsEqual, resolveOracleLikeDefaultSchemaName, normalizeMetadataDialect,
    type CompletionTableMeta, matchLeadingSelectTableReference, splitQueryIdentifierPathSegments,
    resolveOracleLikeLookupSchemaCandidates, isOracleBaseTableReference,
    resolveOracleExactCaseTableReference, rewriteLeadingSelectTableReference,
    type QueryStatementPlan, resolveQueryLocatorPlan,
} from '../QueryEditorHelpers';
import { backfillQueryEditorStatementPlans } from './queryEditorSqlRunMetadata';
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
import {
    type QueryParamBindingInput, bindingsFromValues, collectMissingParamNames,
    type QueryParameterAnalysisInfo,
} from '../params/queryEditorParamsModel';
import { buildQueryEditorResultBudgetOptions, type QueryEditorResultBudgetOptions } from '../queryEditorResultBudget';
import { resolveReportedQueryDurationMs } from '../queryEditorExecutionTimer';
import {
    collectOracleCompileTargets, loadOracleCompileErrors, formatOracleCompileErrors,
} from '../../sidebar/oracleObjectCompilation';
import { findPotentiallyDataOrSchemaChangingConnectionStatements } from '../../../utils/connectionReadOnly';
import { dispatchSidebarSqlDataRefresh } from '../queryEditorSidebarRefresh';
import { handleQueryEditorRunFailure } from './queryEditorRunFailure';
import { collectQueryEditorRunResultSets } from './queryEditorRunResultSets';
import {
    finalizeQueryEditorSqlServerResultSets, resolveQueryEditorExecutionSuccessToast,
} from '../queryEditorSqlServerResultMessages';
import {
    aggregateQueryEditorStatementResults, collectQueryEditorStatementSummaryEntries,
    countQueryEditorAffectedRowResults, collectQueryEditorUnmanagedRollbackableStatements,
} from './queryEditorRunStatementSummary';
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
    executeSqlEditorMultiQuery: (config: Record<string, any>, dbName: string, sql: string, queryId: string, sourceStatements: string[], dbType?: string, connectionParamsOverride?: string, executionConnectionId?: string, paramBindings?: QueryParamBindingInput[], quotedPlaceholders?: boolean, resultBudgetOverride?: QueryEditorResultBudgetOptions) => Promise<connection.QueryResult>;
    executionConnectionParams: string | undefined;
    executionSchemaName?: string;
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
    updateResultPanelVisibility, setExecutionError, mutatingStatements, executionSchemaName,
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
                schemaName: executionSchemaName,
                deferColumnMetaBackfill: true,
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

    await backfillQueryEditorStatementPlans({
        statementPlans, executedSourceStatements, sourceStatements,
        dbType: normalizedDbType, currentDb: executionDbName, schemaName: executionSchemaName,
        config: executionConfig, isCurrentRun,
    });
    if (!isCurrentRun()) return;

    // 不再给 SELECT 注入 LIMIT：工具栏的「最大返回行数」已移除，用户跑
    // `SELECT *` 就该拿到全量结果。结果按页显示，翻页 SQL 自带 LIMIT。
    const executablePlans = statementPlans;
    const anyLimitApplied = false;
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
    const resultBudget = buildQueryEditorResultBudgetOptions();
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
                    paramsState.quotedPlaceholders,
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
                paramsState.quotedPlaceholders,
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
    const schemaChanged = schemaInvalidationStatements.some((statement) => (
        isSqlEditorSchemaChangingStatement(statement, normalizedDbType)
    ));
    if (schemaChanged) {
        invalidateQueryEditorHoverDdlCacheForConnection(conn.id);
    }
    // 托管事务的写入尚未对侧栏独立连接可见，提交成功后由事务控制器刷新。
    const committedStatements = hasSqlExecutionOutcomeUnknown(res)
        ? sourceStatements
        : sourceStatements.slice(0, confirmedStatementCount);
    const dataChanged = !res.transactionPending && (!useManagedTransaction || res.success)
        && findPotentiallyDataOrSchemaChangingConnectionStatements(config, committedStatements.join(';\n')).length > 0;
    if (schemaChanged || dataChanged) {
        dispatchSidebarSqlDataRefresh({
            connectionId: conn.id,
            dbName: executionDbName,
            schemaName: executionSchemaName,
        }, committedStatements, normalizedDbType, !res.transactionPending && !hasSqlExecutionOutcomeUnknown(res));
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
    //
    // 只对「可回滚却被跳过事务」的写语句告警：DDL / TRUNCATE 本身没有回滚语义
    // （MySQL 隐式提交），SET / USE 这类会话级命令也不修改业务数据；一次几百条
    // ALTER 或每次 SET SESSION 都弹一次告警只会变成噪音。
    const unmanagedRollbackableStatements = collectQueryEditorUnmanagedRollbackableStatements(
        mutatingStatements, normalizedDbType,
    );
    if (res.success && unmanagedRollbackableStatements.length > 0 && !res.transactionPending) {
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
                schemaName: executionSchemaName,
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
        executionConnectionParams, paramBindings, quotedPlaceholders: paramsState.quotedPlaceholders, forceReadOnlyResult,
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
    // 批量脚本（典型是几百条 ALTER TABLE）每条语句都会产出一个 affectedRows 结果，
    // 一个「结果 N」标签对应一条语句，既看不出整体结果又会撑爆历史预算；
    // DDL 的受影响行数在 MySQL 等库里恒为 0，单条 DDL 显示「影响行数：0」容易被误读成没执行。
    // 因此把本次执行的受影响行数结果汇总成一个「执行摘要」，SELECT 等真实结果集保持不变。
    const affectedResultCount = countQueryEditorAffectedRowResults(nextResultSets);
    const statementSummaryEntries = collectQueryEditorStatementSummaryEntries({
        resultSets: nextResultSets,
        statementAt: (statementIndex) => sourceStatements[statementIndex - 1] || '',
        dbType: normalizedDbType,
    });
    const aggregatedResultSets = aggregateQueryEditorStatementResults({
        resultSets: nextResultSets,
        entries: statementSummaryEntries,
        affectedResultCount,
        exportSql: sourceStatements.join(';\n'),
        executionDbName,
    });
    const visibleResultSets = finalizeQueryEditorSqlServerResultSets(normalizedDbType, aggregatedResultSets);

    if (visibleResultSets.length > 0 || queryOptions.showSqlExecutionLog !== false) {
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
