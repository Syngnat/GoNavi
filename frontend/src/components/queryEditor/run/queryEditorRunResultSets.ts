import { normalizeQueryResultMessages, type QueryStatementPlan } from '../QueryEditorHelpers';
import type { QueryEditorResultSet } from '../../QueryEditorResultsPanel';
import { GONAVI_ROW_KEY } from '../../DataGrid';
import { createInitialQueryResultPagination } from '../../../utils/queryResultPagination';
import { QUERY_EDITOR_DEFAULT_PAGE_SIZE } from '../queryEditorResultBudget';
import { isSqlEditorNonDataStatement } from '../../../utils/sqlEditorTransaction';
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
    quotedPlaceholders: boolean;
    forceReadOnlyResult: boolean;
}

export const collectQueryEditorRunResultSets = ({
    res, queryOptions, normalizedDbType, sourceStatements, hasConcreteQueryResultSetData,
    executablePlans, isAffectedRowsResultSetData, anyLimitApplied, driver, currentConnectionId,
    executionDbName, executionConnectionParams, paramBindings, quotedPlaceholders, forceReadOnlyResult,
}: CollectQueryEditorRunResultSetsInput) => {
    // res.data 是 ResultSetData[] 数组
    const resultSetDataArray = Array.isArray(res.data) ? (res.data as any[]) : [];
    const topLevelMessages = normalizeQueryResultMessages(res.messages);
    const nextResultSets: QueryEditorResultSet[] = [];
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
        // SET / USE / 事务控制等非数据语句只会产出“影响行数 0”的空结果页签，
        // 既没有信息量，又会让页签数和成功提示里的“生成 N 个结果集”对不上。
        const shouldHideNonDataAffectedResult = isAffectedResult
            && isSqlEditorNonDataStatement(originalSql, normalizedDbType);
        if (shouldHideSqlServerAffectedResult || shouldHideNonDataAffectedResult) {
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
            const rows = Array.isArray(rsData.rows) ? rsData.rows : [];
            // 前端已不再注入 LIMIT，截断只可能来自后端扫描层（字段预览预算）。
            const truncated = rsData?.truncated === true;
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
                fallbackPageSize: QUERY_EDITOR_DEFAULT_PAGE_SIZE,
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
                executionQuotedPlaceholders: quotedPlaceholders,
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
