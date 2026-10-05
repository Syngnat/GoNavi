import { message } from 'antd';
import { t as translate } from '../../../i18n';
import {
    formatSqlExecutionError, hasLocalizedSqlTimeoutKeyword,
} from '../../../utils/sqlErrorSemantics';
import { normalizeTableDesignerTriggerRestoreSql } from '../../../utils/tableDesignerTriggerSql';
import {
    hasSqlExecutionOutcomeUnknown, isQueryEditorTriggerDropStatement,
} from '../queryEditorRunHelpers';
import { isTableDesignerTriggerCreateStatement as isQueryEditorTriggerCreateStatement } from '../../tableDesignerExecutionSql';
import { DBQueryAudited } from '../../../../wailsjs/go/app/App';
import { buildRpcConnectionConfig } from '../../../utils/connectionRpcConfig';
import { invalidateQueryEditorHoverDdlCacheForConnection } from '../queryEditorHoverDdl';
import { dispatchSidebarDatabaseRefresh } from '../../../utils/sidebarDatabaseRefresh';
import {
    QUERY_EDITOR_SQL_LOG_TAB_KEY, type QueryEditorResultSet,
} from '../../QueryEditorResultsPanel';
import type { TabData } from '../../../types';
import type { SavedConnection } from '../../../typeDefs/connectionTypes';

export interface HandleQueryEditorRunFailureInput {
    oracleCompileFailureMessage: string;
    res: any;
    tab: TabData;
    normalizedDbType: string;
    sourceStatements: string[];
    executionConfig: Record<string, any>;
    executionDbName: string;
    isCurrentRun: () => boolean;
    conn: SavedConnection;
    clearUnpinnedResultSets: (fallbackActiveKey?: string) => QueryEditorResultSet[];
    currentQueryIdRef: React.MutableRefObject<string>;
    queryId: string;
    clearQueryId: () => void;
    updateResultPanelVisibility: (visible: boolean) => void;
    setExecutionError: React.Dispatch<React.SetStateAction<string>>;
}

export const handleQueryEditorRunFailure = async ({
    oracleCompileFailureMessage, res, tab, normalizedDbType, sourceStatements, executionConfig,
    executionDbName, isCurrentRun, conn, clearUnpinnedResultSets, currentQueryIdRef, queryId,
    clearQueryId, updateResultPanelVisibility, setExecutionError,
}: HandleQueryEditorRunFailureInput) => {
    const executionErrorText = oracleCompileFailureMessage
        ? translate('query_editor.message.object_compile_failed', {
            error: oracleCompileFailureMessage,
        })
        : formatSqlExecutionError(res.message, { translate });
    let triggerRestoreMessage = '';
    const triggerRollbackSql = normalizeTableDesignerTriggerRestoreSql(
        String(tab.triggerRollbackSql || '').trim(),
        normalizedDbType,
    );
    const triggerExecutionOutcomeUnknown = hasSqlExecutionOutcomeUnknown(res);
    const failedStatementIndex = Number(res.failedIndex) || 0;
    const failedStatementZeroIndex = failedStatementIndex - 1;
    const triggerDropStatementIndex = sourceStatements.findIndex(isQueryEditorTriggerDropStatement);
    const triggerCreateStatementIndex = triggerDropStatementIndex >= 0
        ? sourceStatements.findIndex((statement, index) => (
            index > triggerDropStatementIndex && isQueryEditorTriggerCreateStatement(statement)
        ))
        : -1;
    const confirmedStatementCountForCompensation = Number(res.executedCount) || 0;
    // Compensation is safe only when the DROP is confirmed and the
    // replacement CREATE has not completed. A trigger edit can
    // contain setup statements (for example a PostgreSQL function)
    // between DROP and CREATE, so a failure before the CREATE must
    // also restore the original trigger. An unknown result may mean
    // the replacement already exists; recreating the old definition
    // would silently overwrite it.
    const triggerCreateWasConfirmed = triggerCreateStatementIndex >= 0
        && confirmedStatementCountForCompensation > triggerCreateStatementIndex;
    const triggerReplacementNeedsRestore = triggerCreateStatementIndex >= 0
        && failedStatementZeroIndex <= triggerCreateStatementIndex
        && !triggerCreateWasConfirmed;
    const triggerDropWasDispatched = !triggerExecutionOutcomeUnknown
        && failedStatementIndex > 1
        && confirmedStatementCountForCompensation > triggerDropStatementIndex
        && triggerReplacementNeedsRestore
        && Boolean(triggerRollbackSql)
        && triggerDropStatementIndex >= 0;
    if (triggerExecutionOutcomeUnknown && triggerRollbackSql) {
        triggerRestoreMessage = translate('table_designer.message.trigger_outcome_unknown', {
            detail: executionErrorText,
        });
    }
    if (triggerDropWasDispatched) {
        try {
            const restoreResult = await DBQueryAudited(
                buildRpcConnectionConfig(executionConfig) as any,
                executionDbName,
                triggerRollbackSql,
                'table_designer',
            );
            if (!isCurrentRun()) return;
            triggerRestoreMessage = restoreResult?.success
                ? translate('table_designer.message.trigger_restored_after_failure', {
                    detail: executionErrorText,
                })
                : translate('table_designer.message.trigger_restore_failed', {
                    detail: executionErrorText,
                    restoreDetail: restoreResult?.message || translate('common.unknown'),
                });
        } catch (restoreError: any) {
            if (!isCurrentRun()) return;
            triggerRestoreMessage = translate('table_designer.message.trigger_restore_failed', {
                detail: executionErrorText,
                restoreDetail: restoreError?.message || String(restoreError || translate('common.unknown')),
            });
        }
    }
    if (triggerDropWasDispatched && isCurrentRun()) {
        // The first refresh can race the compensating CREATE. Re-emit it
        // after restoration so consumers cannot cache the temporary gap.
        invalidateQueryEditorHoverDdlCacheForConnection(conn.id);
        dispatchSidebarDatabaseRefresh({
            connectionId: conn.id,
            dbName: executionDbName,
        });
    }
    const errorMsg = String(res.message || '').toLowerCase();
    const isCancelledError = errorMsg.includes('context canceled') ||
                             errorMsg.includes('查询已取消') ||
                             errorMsg.includes('canceled') ||
                             errorMsg.includes('cancelled') ||
                             errorMsg.includes('statement canceled') ||
                             errorMsg.includes('sql: statement canceled');
    const isTimeoutError = errorMsg.includes('context deadline exceeded') ||
                           errorMsg.includes('timeout') ||
                           hasLocalizedSqlTimeoutKeyword(errorMsg) ||
                           errorMsg.includes('deadline exceeded');

    if (isCancelledError && !isTimeoutError) {
        clearUnpinnedResultSets();
        if (currentQueryIdRef.current === queryId) {
            clearQueryId();
        }
        return;
    }

    updateResultPanelVisibility(true);
    setExecutionError(triggerRestoreMessage
        || executionErrorText);
    if (oracleCompileFailureMessage) {
        message.error(executionErrorText);
    }
    clearUnpinnedResultSets(QUERY_EDITOR_SQL_LOG_TAB_KEY);
    return;
};
