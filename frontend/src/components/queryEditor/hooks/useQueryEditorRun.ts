import { message } from 'antd';
import { useEffect, useCallback } from 'react';
import type { QueryEditorRunScope } from '../queryEditorRunHelpers';
import { t as translate } from '../../../i18n';
import { resolveSqlDialect } from '../../../utils/sqlDialect';
import {
    resolveQueryEditorExecutionContext,
    resolveQueryEditorConnectionTimeout,
} from '../QueryEditorHelpers';
import { canUseQueryEditorDatabaseContext } from '../queryEditorLazyTablesCache';
import { CancelQuery } from '../../../../wailsjs/go/app/App';
import { getDataSourceCapabilities } from '../../../utils/dataSourceCapabilities';
import {
    findConnectionMutatingStatements,
    findPotentiallyMutatingConnectionStatements,
} from '../../../utils/connectionReadOnly';
import { confirmProductionRisk } from '../../../utils/productionRiskConfirm';
import type { ConnectionConfig } from '../../../types';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { runQueryEditorMongoStatements } from '../run/queryEditorMongoRun';
import { runQueryEditorSqlStatements } from '../run/queryEditorSqlRun';
import {
    shouldRetainQueryEditorRunAfterRpcFailure,
    isQueryEditorCancelledRpcError,
    shouldRetainQueryEditorRunAfterRpc,
    shouldFinishQueryEditorRunAfterCancelMiss,
} from '../queryEditorExecutionLifecycle';
import { isWebRPCAbortError } from '../../../utils/webRpc';
import { formatSqlExecutionError } from '../../../utils/sqlErrorSemantics';
import { QUERY_EDITOR_SQL_LOG_TAB_KEY } from '../../QueryEditorResultsPanel';
import type { QueryEditorConnectionContextApi } from './useQueryEditorConnectionContext';
import type { QueryEditorElasticsearchRunApi } from './useQueryEditorElasticsearchRun';
import type { QueryEditorCoreStateApi } from './useQueryEditorCoreState';
import type { QueryEditorDraftSyncApi } from './useQueryEditorDraftSync';
import type { QueryEditorResultSetModelApi } from './useQueryEditorResultSetModel';
import type { QueryEditorExecutionStatusApi } from './useQueryEditorExecutionStatus';
import type { QueryEditorQueryContextApi } from './useQueryEditorQueryContext';
import type { QueryEditorResultReloadApi } from './useQueryEditorResultReload';
import type { QueryEditorEditorSplitApi } from './useQueryEditorEditorSplit';
import type { QueryEditorProps } from '../../QueryEditor';

export interface UseQueryEditorRunInput {
    tab: QueryEditorProps['tab'];
    isActive: Exclude<QueryEditorProps['isActive'], undefined>;
    isElasticsearchMode: QueryEditorConnectionContextApi['isElasticsearchMode'];
    handleElasticsearchRun: QueryEditorElasticsearchRunApi['handleElasticsearchRun'];
    canSelectQuerySchema: QueryEditorConnectionContextApi['canSelectQuerySchema'];
    schemaLoading: QueryEditorCoreStateApi['schemaLoading'];
    getCurrentQuery: QueryEditorDraftSyncApi['getCurrentQuery'];
    getSelectedSQL: QueryEditorResultSetModelApi['getSelectedSQL'];
    getExecutableSQL: QueryEditorResultSetModelApi['getExecutableSQL'];
    clearUnpinnedResultSets: QueryEditorResultSetModelApi['clearUnpinnedResultSets'];
    currentConnection: QueryEditorConnectionContextApi['currentConnection'];
    currentDbRef: QueryEditorConnectionContextApi['currentDbRef'];
    currentSchemaRef: QueryEditorConnectionContextApi['currentSchemaRef'];
    visibleDbsRef: QueryEditorCoreStateApi['visibleDbsRef'];
    pendingSqlTransactionRef: QueryEditorExecutionStatusApi['pendingSqlTransactionRef'];
    activatePendingSqlTransaction: QueryEditorExecutionStatusApi['activatePendingSqlTransaction'];
    appendPendingSqlTransactionExecution: QueryEditorExecutionStatusApi['appendPendingSqlTransactionExecution'];
    queryContextLockRunSeqRef: QueryEditorCoreStateApi['queryContextLockRunSeqRef'];
    switchQueryContext: QueryEditorQueryContextApi['switchQueryContext'];
    currentConnectionIdRef: QueryEditorConnectionContextApi['currentConnectionIdRef'];
    schemaContextKeyRef: QueryEditorConnectionContextApi['schemaContextKeyRef'];
    latestSelectedSchemaRef: QueryEditorConnectionContextApi['latestSelectedSchemaRef'];
    setCurrentSchema: QueryEditorCoreStateApi['setCurrentSchema'];
    setSchemaList: QueryEditorCoreStateApi['setSchemaList'];
    updateQueryTabDraft: QueryEditorConnectionContextApi['updateQueryTabDraft'];
    runSeqRef: QueryEditorCoreStateApi['runSeqRef'];
    beginQueryEditorRunClock: QueryEditorCoreStateApi['beginQueryEditorRunClock'];
    lockQueryContextForRun: QueryEditorCoreStateApi['lockQueryContextForRun'];
    setLoading: QueryEditorCoreStateApi['setLoading'];
    setExecutionError: QueryEditorCoreStateApi['setExecutionError'];
    recordExecutionOrigin: QueryEditorCoreStateApi['recordExecutionOrigin'];
    updateResultPanelVisibility: QueryEditorExecutionStatusApi['updateResultPanelVisibility'];
    rpcLostWithoutResultRef: QueryEditorCoreStateApi['rpcLostWithoutResultRef'];
    cancelResultTotalCountRequests: QueryEditorResultReloadApi['cancelResultTotalCountRequests'];
    resultTotalCountRequestsRef: QueryEditorCoreStateApi['resultTotalCountRequestsRef'];
    currentQueryIdRef: QueryEditorCoreStateApi['currentQueryIdRef'];
    clearQueryId: QueryEditorEditorSplitApi['clearQueryId'];
    connections: QueryEditorConnectionContextApi['connections'];
    currentConnectionId: QueryEditorCoreStateApi['currentConnectionId'];
    buildSqlExecutionConnectionConfig: QueryEditorResultSetModelApi['buildSqlExecutionConnectionConfig'];
    splitSQLStatements: QueryEditorResultSetModelApi['splitSQLStatements'];
    resultSets: QueryEditorCoreStateApi['resultSets'];
    setResultSets: QueryEditorCoreStateApi['setResultSets'];
    lastExecutedEditorQueryRef: QueryEditorCoreStateApi['lastExecutedEditorQueryRef'];
    normalizeExecutableStatementList: QueryEditorResultSetModelApi['normalizeExecutableStatementList'];
    queryOptions: QueryEditorCoreStateApi['queryOptions'];
    setExecutionTimingActive: QueryEditorCoreStateApi['setExecutionTimingActive'];
    setQueryId: QueryEditorEditorSplitApi['setQueryId'];
    invokeRequestScopedApp: QueryEditorCoreStateApi['invokeRequestScopedApp'];
    addSqlLog: QueryEditorConnectionContextApi['addSqlLog'];
    finishQueryEditorSqlClock: QueryEditorCoreStateApi['finishQueryEditorSqlClock'];
    mergeResultSets: QueryEditorResultSetModelApi['mergeResultSets'];
    activateExecutedResult: QueryEditorResultSetModelApi['activateExecutedResult'];
    metadataGenerationRef: QueryEditorCoreStateApi['metadataGenerationRef'];
    isQueryEditorMetadataRequestCurrent: QueryEditorConnectionContextApi['isQueryEditorMetadataRequestCurrent'];
    tablesRef: QueryEditorCoreStateApi['tablesRef'];
    containsOraclePlsqlDefinition: QueryEditorResultSetModelApi['containsOraclePlsqlDefinition'];
    normalizeOracleSqlPlusSlashTerminators: QueryEditorResultSetModelApi['normalizeOracleSqlPlusSlashTerminators'];
    paramsDialogState: QueryEditorQueryContextApi['paramsDialogState'];
    setParamsDialogState: QueryEditorQueryContextApi['setParamsDialogState'];
    paramsState: QueryEditorQueryContextApi['paramsState'];
    lastParamsRunScopeRef: QueryEditorQueryContextApi['lastParamsRunScopeRef'];
    executeSqlEditorMultiQuery: QueryEditorResultSetModelApi['executeSqlEditorMultiQuery'];
    queryEditorUnmountedRef: QueryEditorCoreStateApi['queryEditorUnmountedRef'];
    sqlEditorCommitMode: QueryEditorExecutionStatusApi['sqlEditorCommitMode'];
    sqlEditorAutoCommitDelayMs: QueryEditorExecutionStatusApi['sqlEditorAutoCommitDelayMs'];
    hasConcreteQueryResultSetData: QueryEditorResultSetModelApi['hasConcreteQueryResultSetData'];
    isAffectedRowsResultSetData: QueryEditorResultSetModelApi['isAffectedRowsResultSetData'];
    executionLifecycleRef: QueryEditorExecutionStatusApi['executionLifecycleRef'];
    unlockQueryContextForRun: QueryEditorCoreStateApi['unlockQueryContextForRun'];
    handleRunRef: QueryEditorCoreStateApi['handleRunRef'];
    deferredContextRunSeqRef: QueryEditorCoreStateApi['deferredContextRunSeqRef'];
    queryEditorActiveRef: QueryEditorCoreStateApi['queryEditorActiveRef'];
    schemaLoadingRef: QueryEditorCoreStateApi['schemaLoadingRef'];
    pendingRunAfterSchemaLoadRef: QueryEditorCoreStateApi['pendingRunAfterSchemaLoadRef'];
    loading: QueryEditorCoreStateApi['loading'];
}

export const useQueryEditorRun = ({
    tab, isActive, isElasticsearchMode, handleElasticsearchRun, canSelectQuerySchema, schemaLoading,
    getCurrentQuery, getSelectedSQL, getExecutableSQL, clearUnpinnedResultSets, currentConnection,
    currentDbRef, currentSchemaRef, visibleDbsRef, pendingSqlTransactionRef,
    activatePendingSqlTransaction, appendPendingSqlTransactionExecution, queryContextLockRunSeqRef,
    switchQueryContext, currentConnectionIdRef, schemaContextKeyRef, latestSelectedSchemaRef,
    setCurrentSchema, setSchemaList, updateQueryTabDraft, runSeqRef, beginQueryEditorRunClock,
    lockQueryContextForRun, setLoading, setExecutionError, recordExecutionOrigin,
    updateResultPanelVisibility, rpcLostWithoutResultRef, cancelResultTotalCountRequests,
    resultTotalCountRequestsRef, currentQueryIdRef, clearQueryId, connections, currentConnectionId,
    buildSqlExecutionConnectionConfig, splitSQLStatements, resultSets, setResultSets,
    lastExecutedEditorQueryRef, normalizeExecutableStatementList, queryOptions,
    setExecutionTimingActive, setQueryId, invokeRequestScopedApp, addSqlLog,
    finishQueryEditorSqlClock, mergeResultSets, activateExecutedResult, metadataGenerationRef,
    isQueryEditorMetadataRequestCurrent, tablesRef, containsOraclePlsqlDefinition,
    normalizeOracleSqlPlusSlashTerminators, paramsDialogState, setParamsDialogState, paramsState,
    lastParamsRunScopeRef, executeSqlEditorMultiQuery, queryEditorUnmountedRef, sqlEditorCommitMode,
    sqlEditorAutoCommitDelayMs, hasConcreteQueryResultSetData, isAffectedRowsResultSetData,
    executionLifecycleRef, unlockQueryContextForRun, handleRunRef, deferredContextRunSeqRef,
    queryEditorActiveRef, schemaLoadingRef, pendingRunAfterSchemaLoadRef, loading,
}: UseQueryEditorRunInput) => {
    const handleRun = async (runScope: QueryEditorRunScope = 'default', runOptions?: { skipParamsGate?: boolean }) => {
      if (isElasticsearchMode) {
          await handleElasticsearchRun(runScope === 'all');
          return;
      }
      if (canSelectQuerySchema && schemaLoading) {
          message.info(translate('common.loading'));
          return;
      }
      const currentQuery = getCurrentQuery();
      if (!currentQuery.trim()) return;
      const executableSQL = runScope === 'all'
          ? currentQuery
          : runScope === 'selection'
              ? getSelectedSQL()
              : getExecutableSQL();
      if (!executableSQL.trim()) {
          message.info(translate('query_editor.message.no_executable_sql'));
          clearUnpinnedResultSets();
          return;
      }
      const executionDialect = resolveSqlDialect(
          String(currentConnection?.config?.type || ''),
          String(currentConnection?.config?.driver || ''),
          { oceanBaseProtocol: currentConnection?.config?.oceanBaseProtocol },
      );
      const sqlContext = resolveQueryEditorExecutionContext(
          executableSQL,
          executionDialect,
          currentDbRef.current,
          currentSchemaRef.current,
          visibleDbsRef.current,
      );
      if (sqlContext.dbName || sqlContext.schemaName) {
          if (sqlContext.schemaName && canSelectQuerySchema && pendingSqlTransactionRef.current) {
              message.warning(translate('query_editor.transaction.message.pending_managed_transaction'));
              return;
          }
          if (sqlContext.schemaName && canSelectQuerySchema && queryContextLockRunSeqRef.current !== 0) {
              message.info(translate('common.loading'));
              return;
          }
          if (sqlContext.dbName && !switchQueryContext(currentConnectionIdRef.current, sqlContext.dbName)) return;
          if (sqlContext.schemaName && canSelectQuerySchema) {
              const nextSchema = sqlContext.schemaName;
              schemaContextKeyRef.current = `${tab.id}\u0000${currentConnectionIdRef.current}\u0000${currentDbRef.current}`;
              currentSchemaRef.current = nextSchema;
              latestSelectedSchemaRef.current = nextSchema;
              setCurrentSchema(nextSchema);
              setSchemaList((current) => current.includes(nextSchema) ? current : [nextSchema, ...current]);
              updateQueryTabDraft(tab.id, { schemaName: nextSchema });
          }
      }
      const executionDbName = currentDbRef.current;
      const executionSchemaName = currentSchemaRef.current;
      if (!canUseQueryEditorDatabaseContext(currentConnection, executionDbName, executableSQL)) {
          message.error(translate('query_editor.message.select_database_first'));
          return;
      }

      const runSeq = ++runSeqRef.current;
      const runState: { queryId: string; sqlDurationMs?: number } = { queryId: '' };
      const isCurrentRun = () => runSeqRef.current === runSeq;
      beginQueryEditorRunClock(runSeq);
      lockQueryContextForRun(runSeq);
      setLoading(true);
      setExecutionError('');
      recordExecutionOrigin(currentQuery, executableSQL);
      updateResultPanelVisibility(true);
      rpcLostWithoutResultRef.current = false;
      const runStartTime = Date.now();

      try {
      await cancelResultTotalCountRequests(Object.keys(resultTotalCountRequestsRef.current));
      if (!isCurrentRun()) return;
      // 如果已有查询在运行，先取消它
      if (currentQueryIdRef.current) {
          const previousQueryID = currentQueryIdRef.current;
          try {
              await CancelQuery(previousQueryID);
          } catch (error) {
              // 忽略取消错误，可能查询已完成
          }
          if (!isCurrentRun()) return;
          if (currentQueryIdRef.current === previousQueryID) {
              clearQueryId();
          }
      }
      const conn = connections.find(c => c.id === currentConnectionId);
      if (!conn) {
          message.error(translate('query_editor.message.connection_not_found'));
          if (isCurrentRun()) setLoading(false);
          return;
      }
      const connCaps = getDataSourceCapabilities(conn.config);
      if (!connCaps.supportsQueryEditor) {
          message.error(translate(connCaps.query.messageKey || 'query_editor.message.unsupported_source'));
          if (isCurrentRun()) setLoading(false);
          return;
      }
      const restrictedStatements = findConnectionMutatingStatements(conn.config, executableSQL);
      if (restrictedStatements.length > 0) {
          message.warning(translate('query_editor.message.connection_readonly_blocked'));
          if (isCurrentRun()) setLoading(false);
          return;
      }

      // 写操作判定要复用同一结果：生产确认和"不可撤销"提示必须基于同一判断，
      // 各算一遍会在边界 SQL 上出现"确认了却没提示"或反之的漂移。
      const mutatingStatements = findPotentiallyMutatingConnectionStatements(conn.config, executableSQL);
      if (mutatingStatements.length > 0) {
          const approved = await confirmProductionRisk({
              connection: conn,
              action: translate('connection.production_risk.action.execute_sql'),
              target: executionDbName,
              translate,
          });
          if (!isCurrentRun()) return;
          if (!approved) {
              setLoading(false);
              return;
          }
      }

      const config: ConnectionConfig = {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" },
          timeout: resolveQueryEditorConnectionTimeout(conn.config),
      };
          const executionConfig = buildSqlExecutionConnectionConfig(config, executionSchemaName);
          const executionConnectionParams = canSelectQuerySchema
              ? String(executionConfig.connectionParams || '')
              : undefined;
          const rawSQL = executableSQL;
          const rpcConfig = buildRpcConnectionConfig(executionConfig) as any;
          const dbType = String(rpcConfig.type || 'mysql');
          const driver = String((config as any).driver || '');
          const normalizedDbType = String(resolveSqlDialect(dbType, driver, {
              oceanBaseProtocol: (config as any).oceanBaseProtocol,
          })).trim().toLowerCase();
          const normalizedRawSQL = String(rawSQL || '').replace(/；/g, ';');

          // MongoDB 仍走逐条执行的旧路径
          const isMongoDB = normalizedDbType === 'mongodb';

          if (isMongoDB) {
              await runQueryEditorMongoStatements({
                  normalizedRawSQL, splitSQLStatements, normalizedDbType, resultSets,
                  lastExecutedEditorQueryRef, currentQuery, normalizeExecutableStatementList,
                  clearUnpinnedResultSets, queryOptions, setExecutionTimingActive,
                  updateResultPanelVisibility, setExecutionError, isCurrentRun, runState, setQueryId,
                  config, invokeRequestScopedApp, executionDbName, currentQueryIdRef, clearQueryId,
                  addSqlLog, finishQueryEditorSqlClock, mergeResultSets, setResultSets,
                  activateExecutedResult, runSeq,
              });

          } else {
              await runQueryEditorSqlStatements({
                  splitSQLStatements, normalizedRawSQL, normalizedDbType, resultSets,
                  lastExecutedEditorQueryRef, currentQuery, normalizeExecutableStatementList,
                  clearUnpinnedResultSets, tab, config, pendingSqlTransactionRef, connCaps, conn,
                  metadataGenerationRef, currentConnectionId, isQueryEditorMetadataRequestCurrent,
                  tablesRef, isActive, executionDbName, isCurrentRun, executionConfig, queryOptions,
                  driver, containsOraclePlsqlDefinition, normalizeOracleSqlPlusSlashTerminators,
                  recordExecutionOrigin, executableSQL, runOptions, paramsDialogState, paramsState,
                  setLoading, lastParamsRunScopeRef, runScope, setParamsDialogState, runState,
                  setQueryId, setExecutionTimingActive, executeSqlEditorMultiQuery,
                  executionConnectionParams, finishQueryEditorSqlClock, queryEditorUnmountedRef,
                  addSqlLog, currentQueryIdRef, clearQueryId, updateResultPanelVisibility,
                  setExecutionError, mutatingStatements, activatePendingSqlTransaction,
                  sqlEditorCommitMode, sqlEditorAutoCommitDelayMs,
                  appendPendingSqlTransactionExecution, hasConcreteQueryResultSetData,
                  isAffectedRowsResultSetData, mergeResultSets, setResultSets, activateExecutedResult,
                  runSeq,
              });

          }
      } catch (e: any) {
          if (!isCurrentRun()) return;
          if (shouldRetainQueryEditorRunAfterRpcFailure(e, executionLifecycleRef.current)) {
              rpcLostWithoutResultRef.current = true;
              return;
          }
          if (isWebRPCAbortError(e) || isQueryEditorCancelledRpcError(e)) return;
          const formattedError = formatSqlExecutionError(e?.message || e, { translate });
          message.error(translate('query_editor.message.execution_failed_with_error', { error: formattedError }));
          addSqlLog({
              id: `log-${Date.now()}-error`,
              timestamp: Date.now(),
              sql: executableSQL || getExecutableSQL() || getCurrentQuery(),
              status: 'error',
              duration: runState.sqlDurationMs ?? Date.now() - runStartTime,
              message: e.message,
              dbName: executionDbName
          });
          updateResultPanelVisibility(true);
          setExecutionError(formattedError);
          clearUnpinnedResultSets(QUERY_EDITOR_SQL_LOG_TAB_KEY);
      } finally {
          unlockQueryContextForRun(runSeq);
          const retainRun = isCurrentRun() && shouldRetainQueryEditorRunAfterRpc(
              rpcLostWithoutResultRef.current,
              executionLifecycleRef.current,
          );
          if (isCurrentRun() && !retainRun) setLoading(false);
          if (runState.queryId && currentQueryIdRef.current === runState.queryId && !retainRun) {
              clearQueryId();
          }
      }
    };

    useEffect(() => {
        handleRunRef.current = handleRun;
        return () => {
            if (handleRunRef.current === handleRun) {
                handleRunRef.current = null;
            }
        };
    }, [handleRun]);

    const runAfterQueryContextReady = useCallback(() => {
        const requestSeq = deferredContextRunSeqRef.current + 1;
        deferredContextRunSeqRef.current = requestSeq;
        window.setTimeout(() => {
            if (
                requestSeq !== deferredContextRunSeqRef.current
                || !queryEditorActiveRef.current
            ) {
                return;
            }
            if (schemaLoadingRef.current) {
                pendingRunAfterSchemaLoadRef.current = true;
                return;
            }
            void handleRunRef.current?.();
        }, 500);
    }, []);

    useEffect(() => {
        if (isActive) return;
        deferredContextRunSeqRef.current += 1;
        pendingRunAfterSchemaLoadRef.current = false;
    }, [isActive]);

    useEffect(() => {
        if (schemaLoading || !pendingRunAfterSchemaLoadRef.current) return;
        pendingRunAfterSchemaLoadRef.current = false;
        deferredContextRunSeqRef.current += 1;
        if (queryEditorActiveRef.current) {
            void handleRunRef.current?.();
        }
    }, [schemaLoading]);

    useEffect(() => () => {
        deferredContextRunSeqRef.current += 1;
        pendingRunAfterSchemaLoadRef.current = false;
    }, []);

    const handleRunSelectedShortcut = async () => {
        await handleRun();
    };

    const handleCancel = async () => {
      const finishCancelledRun = () => {
        const lockedRunSeq = queryContextLockRunSeqRef.current;
        runSeqRef.current += 1;
        if (lockedRunSeq !== 0) {
          unlockQueryContextForRun(lockedRunSeq);
        }
        setLoading(false);
        setResultSets(prev => prev.map(result =>
          result.page?.loading
            ? { ...result, page: { ...result.page, loading: false } }
            : result
        ));
      };

      if (!currentQueryIdRef.current) {
        if (loading) {
          finishCancelledRun();
          message.success(translate('query_editor.message.cancel_success'));
          return;
        }
        message.warning(translate('query_editor.message.cancel_no_running'));
        return;
      }
      const queryIdToCancel = currentQueryIdRef.current;
      try {
        const res = await CancelQuery(queryIdToCancel);
        if (res.success) {
          message.success(translate('query_editor.message.cancel_success'));
          if (currentQueryIdRef.current === queryIdToCancel) {
            finishCancelledRun();
            clearQueryId();
          }
        } else if (
          currentQueryIdRef.current === queryIdToCancel
          && shouldFinishQueryEditorRunAfterCancelMiss(res, loading)
        ) {
          finishCancelledRun();
          clearQueryId();
        } else {
          message.warning(res.message);
        }
      } catch (error: any) {
        message.error(translate('query_editor.message.cancel_failed', { error: error.message }));
      }
    };
    return {
        handleRun, runAfterQueryContextReady, handleRunSelectedShortcut, handleCancel,
    };
};

export type QueryEditorRunApi = ReturnType<typeof useQueryEditorRun>;
