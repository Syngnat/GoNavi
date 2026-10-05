import { normalizeQueryResultMessages, type QueryStatementPlan } from '../QueryEditorHelpers';
import type { QueryEditorResultSet } from '../../QueryEditorResultsPanel';
import { GONAVI_ROW_KEY } from '../../DataGrid';
import { createInitialQueryResultPagination } from '../../../utils/queryResultPagination';
import type { QueryParamBindingInput } from '../params/queryEditorParamsModel';
import type { QueryOptions } from '../../../store/storeStateTypes';

export interface CollectQueryEditorRunResultSetsInput {
    res: any;
    queryOptions: QueryOptions;
    normalizedDbType: string;
    sourceStatements: string[];
    hasConcreteQueryResultSetData: (result: any, messages: string[]) => boolean;
    executablePlans: QueryStatementPlan[];
    isAffectedRowsResultSetData: (result?: any) => boolean;
    anyLimitApplied: false;
    driver: string;
    currentConnectionId: string;
    executionDbName: string;
    executionConnectionParams: string | undefined;
    paramBindings: QueryParamBindingInput[] | undefined;
    forceReadOnlyResult: boolean;
}

export const collectQueryEditorRunResultSets = ({
    res, queryOptions, normalizedDbType, sourceStatements, hasConcreteQueryResultSetData,
    executablePlans, isAffectedRowsResultSetData, anyLimitApplied, driver, currentConnectionId,
    executionDbName, executionConnectionParams, paramBindings, forceReadOnlyResult,
}: CollectQueryEditorRunResultSetsInput) => {
    // res.data 是 ResultSetData[] 数组
    const resultSetDataArray = Array.isArray(res.data) ? (res.data as any[]) : [];
    const topLevelMessages = normalizeQueryResultMessages(res.messages);
    const nextResultSets: QueryEditorResultSet[] = [];
    const maxRows = Number(queryOptions?.maxRows) || 0;
    let anyTruncated = false;
    const statementResultCounts = new Map<number, number>();
    const resolveSourceStatementIndex = (rsData: any, idx: number): number => {
        const explicitStatementIndex = Number(rsData?.statementIndex || 0);
        if (explicitStatementIndex > 0) {
            return explicitStatementIndex;
        }
        if (normalizedDbType === 'sqlserver' && sourceStatements.length === 1) {
            return 1;
        }
        return idx + 1;
    };
    const sqlServerStatementsWithConcreteResults = new Set<number>();
    if (normalizedDbType === 'sqlserver') {
        resultSetDataArray.forEach((rsData, idx) => {
            const sourceStatementIndex = resolveSourceStatementIndex(rsData, idx);
            const resultMessages = normalizeQueryResultMessages(rsData?.messages);
            if (hasConcreteQueryResultSetData(rsData, resultMessages)) {
                sqlServerStatementsWithConcreteResults.add(sourceStatementIndex);
            }
        });
    }
    const shouldUseTopLevelSqlServerMessages = normalizedDbType === 'sqlserver'
        && topLevelMessages.length > 0
        && sqlServerStatementsWithConcreteResults.size === 0;

    for (let idx = 0; idx < resultSetDataArray.length; idx++) {
        const rsData = resultSetDataArray[idx];
        const sourceStatementIndex = resolveSourceStatementIndex(rsData, idx);
        const plan = executablePlans[Math.max(0, sourceStatementIndex - 1)];
        const originalSql = plan?.originalSql || '';
        const executedSql = plan?.executedSql || originalSql;
        const resultMessages = normalizeQueryResultMessages(rsData?.messages);

        // 检查是否为 affectedRows 类结果集
        const isAffectedResult = isAffectedRowsResultSetData(rsData);
        const shouldHideSqlServerAffectedResult = normalizedDbType === 'sqlserver'
            && isAffectedResult
            && (
                sqlServerStatementsWithConcreteResults.has(sourceStatementIndex)
                || shouldUseTopLevelSqlServerMessages
            );
        if (shouldHideSqlServerAffectedResult) {
            continue;
        }

        const statementResultIndex = (statementResultCounts.get(sourceStatementIndex) || 0) + 1;
        statementResultCounts.set(sourceStatementIndex, statementResultIndex);

        if (isAffectedResult) {
            const affected = Number(rsData.rows[0]?.affectedRows);
            const row = { affectedRows: Number.isFinite(affected) ? affected : 0 };
            (row as any)[GONAVI_ROW_KEY] = 0;
            nextResultSets.push({
                key: `result-${nextResultSets.length + 1}`,
                sql: executedSql,
                exportSql: originalSql,
                sourceStatementIndex,
                statementResultIndex,
                rows: [row],
                columns: ['affectedRows'],
                messages: resultMessages,
                pkColumns: [],
                readOnly: true
            });
        } else if ((!Array.isArray(rsData.rows) || rsData.rows.length === 0) && (!Array.isArray(rsData.columns) || rsData.columns.length === 0) && resultMessages.length > 0) {
            nextResultSets.push({
                key: `result-${nextResultSets.length + 1}`,
                sql: executedSql,
                exportSql: originalSql,
                sourceStatementIndex,
                statementResultIndex,
                rows: [],
                columns: [],
                messages: resultMessages,
                resultType: 'message',
                pkColumns: [],
                readOnly: true,
            });
        } else {
            let rows = Array.isArray(rsData.rows) ? rsData.rows : [];
            // The backend scanner reports its own truncation; the client-side
            // slice below only covers the injected-LIMIT fallback.
            let truncated = rsData?.truncated === true;
            // 仅当前端自动注入了 LIMIT 时才做兜底截断；用户手写 LIMIT 时尊重原始结果
            if (anyLimitApplied && Number.isFinite(maxRows) && maxRows > 0 && rows.length > maxRows) {
                truncated = true;
                anyTruncated = true;
                rows = rows.slice(0, maxRows);
            }
            const cols = (rsData.columns && rsData.columns.length > 0)
                ? rsData.columns
                : (rows.length > 0 ? Object.keys(rows[0]) : []);

            rows.forEach((row: any, i: number) => {
                if (row && typeof row === 'object') row[GONAVI_ROW_KEY] = i;
            });

            const tableRef = plan?.tableRef;
            const editLocator = plan?.editLocator;
            const page = createInitialQueryResultPagination({
                executedSql,
                exportSql: originalSql,
                dbType: normalizedDbType,
                driver,
                returnedRowCount: rows.length,
                fallbackPageSize: maxRows,
            });
            nextResultSets.push({
                key: `result-${nextResultSets.length + 1}`,
                sql: executedSql,
                exportSql: originalSql,
                sourceStatementIndex,
                statementResultIndex,
                rows,
                columns: cols,
                messages: resultMessages,
                tableName: tableRef?.tableName,
                // 跨库/跨 schema 查询时，列类型与注释必须从真实表所在库加载
                metadataDbName: tableRef?.metadataDbName,
                metadataTableName: tableRef?.metadataTableName,
                ddlDbName: tableRef?.ddlDbName,
                ddlTableName: tableRef?.ddlTableName,
                executionConnectionId: currentConnectionId,
                executionDbName: executionDbName,
                executionConnectionParams,
                executionBindings: paramBindings,
                pkColumns: plan?.pkColumns || [],
                columnMetaMap: plan?.columnMetaMap,
                uniqueKeyGroups: plan?.uniqueKeyGroups,
                editLocator,
                readOnly: forceReadOnlyResult || !editLocator || editLocator.readOnly,
                truncated,
                page,
            });
        }
    }
    return {
        resultSetDataArray, topLevelMessages, nextResultSets, statementResultCounts,
    };
};
