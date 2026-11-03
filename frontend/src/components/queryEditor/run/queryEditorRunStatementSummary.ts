import { t as translate } from '../../../i18n';
import { isSqlEditorSchemaChangingStatement, resolveSqlEditorOperationKeyword } from '../../../utils/sqlEditorTransaction';
import type { QueryEditorResultSet } from '../../QueryEditorResultsPanel';

/**
 * 批量执行结果汇总口径。
 *
 * 背景：一次执行几百条 ALTER TABLE 时，每条语句都产出一个 affectedRows 结果集，
 * 结果区就变成几百个「结果 N」标签，历史预算瞬间被打满；而 DDL 在 MySQL 等数据库里
 * 恒返回 0 行，单条 DDL 固定显示「影响行数：0」，看起来像没执行成功。
 *
 * 口径：
 * - DDL / TRUNCATE 没有行数语义，一律不展示影响行数；
 * - 一次执行产出多条 affectedRows 结果时合并成一个「执行摘要」结果集（保留 SELECT 等真实结果集）；
 * - 单条 DML 保持原样，影响行数本身有信息量。
 */

/** 摘要结果集标记，渲染层据此显示摘要标题与条目。 */
export const QUERY_EDITOR_STATEMENT_SUMMARY_KIND = 'statements';

/** 摘要里最多逐条列出多少条语句；超出只给总数与结构变更说明，避免摘要本身变噪音。 */
const SUMMARY_LINE_LIMIT = 20;

const SUMMARY_LINE_MAX_LENGTH = 200;

export type QueryEditorStatementSummaryEntry = {
    statementIndex: number;
    statement: string;
    /** 仅 DML 记录；DDL / TRUNCATE 不记录，避免渲染成「影响行数：0」。 */
    affectedRows?: number;
    /** DDL / TRUNCATE：行数无意义，界面提示结构变更已直接生效。 */
    rowCountMeaningless: boolean;
};

export const isQueryEditorStatementSummary = (
    result: { summaryKind?: string } | null | undefined,
): boolean => result?.summaryKind === QUERY_EDITOR_STATEMENT_SUMMARY_KIND;

/** DDL / TRUNCATE 的受影响行数恒为 0，展示出来只会误导。 */
export const isQueryEditorRowCountMeaninglessStatement = (
    statement: string,
    dbType = '',
): boolean => (
    isSqlEditorSchemaChangingStatement(statement, dbType)
    || resolveSqlEditorOperationKeyword(statement, dbType) === 'truncate'
);

const summarizeStatementText = (statement: string, statementIndex: number): string => {
    const text = String(statement || '').replace(/\s+/g, ' ').trim();
    if (!text) {
        // 后端返回的结果集可能多于前端切分出的语句（存储过程展开、状态行等），按序号回退。
        return translate('query_editor.result.summary.statement_index', { index: statementIndex });
    }
    return text.length > SUMMARY_LINE_MAX_LENGTH
        ? `${text.slice(0, SUMMARY_LINE_MAX_LENGTH)}…`
        : text;
};

export type CollectQueryEditorStatementSummaryEntriesInput = {
    resultSets: QueryEditorResultSet[];
    statementAt: (statementIndex: number) => string;
    dbType: string;
};

/**
 * 收集本次执行产出的 affectedRows 结果，按语句去重后汇总。
 *
 * 去重键优先用语句文本（同一匿名块展开多个结果时不会重复列出），
 * 语句缺失时退化为结果序号，保证计数仍然准确。
 */
export const collectQueryEditorStatementSummaryEntries = ({
    resultSets, statementAt, dbType,
}: CollectQueryEditorStatementSummaryEntriesInput): QueryEditorStatementSummaryEntry[] => {
    const entries: QueryEditorStatementSummaryEntry[] = [];
    const entryIndexByKey = new Map<string, number>();
    resultSets.forEach((result, resultIndex) => {
        if (result.columns.length !== 1 || result.columns[0] !== 'affectedRows') {
            return;
        }
        const statementIndex = Number(result.sourceStatementIndex || resultIndex + 1);
        const statement = statementAt(statementIndex);
        const rowCountMeaningless = isQueryEditorRowCountMeaninglessStatement(statement, dbType);
        const affected = Number(result.rows[0]?.affectedRows ?? 0);
        const key = String(statement || '').trim()
            ? String(statement).replace(/\s+/g, ' ').trim().toLowerCase()
            : `#${statementIndex}`;
        const existingIndex = entryIndexByKey.get(key);
        if (existingIndex !== undefined) {
            const existing = entries[existingIndex];
            if (existing.affectedRows !== undefined && Number.isFinite(affected)) {
                existing.affectedRows += affected;
            }
            return;
        }
        entryIndexByKey.set(key, entries.length);
        entries.push({
            statementIndex,
            statement,
            ...(rowCountMeaningless || !Number.isFinite(affected) ? {} : { affectedRows: affected }),
            rowCountMeaningless,
        });
    });
    return entries;
};

/** 本次执行产出的 affectedRows 结果条数（去重前），决定是否值得汇总。 */
export const countQueryEditorAffectedRowResults = (resultSets: QueryEditorResultSet[]): number => (
    resultSets.filter((result) => (
        Array.isArray(result.columns) && result.columns.length === 1 && result.columns[0] === 'affectedRows'
    )).length
);

export const buildQueryEditorStatementSummaryLines = (
    entries: QueryEditorStatementSummaryEntry[],
    affectedResultCount: number,
): string[] => {
    const lines: string[] = [];
    if (affectedResultCount > 1) {
        lines.push(translate('query_editor.result.summary.statements_success', { count: affectedResultCount }));
    }
    if (entries.length <= SUMMARY_LINE_LIMIT) {
        entries.forEach((entry) => {
            const line = `✓ ${entry.statementIndex}. ${summarizeStatementText(entry.statement, entry.statementIndex)}`;
            lines.push(entry.affectedRows === undefined
                ? line
                : `${line}  ${translate('query_editor.result.affected_rows', { count: entry.affectedRows })}`);
        });
    } else {
        lines.push(translate('query_editor.result.summary.remaining', { count: entries.length - SUMMARY_LINE_LIMIT }));
    }
    if (entries.some((entry) => entry.rowCountMeaningless)) {
        lines.push(translate('query_editor.result.summary.schema_applied'));
    }
    return lines;
};

export type BuildQueryEditorStatementSummaryInput = {
    entries: QueryEditorStatementSummaryEntry[];
    affectedResultCount: number;
    key: string;
    exportSql: string;
    executionDbName: string;
};

export const buildQueryEditorStatementSummaryResultSet = ({
    entries, affectedResultCount, key, exportSql, executionDbName,
}: BuildQueryEditorStatementSummaryInput): QueryEditorResultSet => {
    const firstEntry = entries[0];
    return {
        key,
        sql: firstEntry?.statement || exportSql,
        exportSql,
        sourceStatementIndex: firstEntry?.statementIndex || 1,
        statementResultIndex: 1,
        rows: [],
        columns: [],
        messages: buildQueryEditorStatementSummaryLines(entries, affectedResultCount),
        resultType: 'message',
        summaryKind: QUERY_EDITOR_STATEMENT_SUMMARY_KIND,
        summaryStatementCount: affectedResultCount,
        executionDbName,
        pkColumns: [],
        readOnly: true,
    };
};

export type AggregateQueryEditorStatementResultsInput = {
    resultSets: QueryEditorResultSet[];
    entries: QueryEditorStatementSummaryEntry[];
    affectedResultCount: number;
    exportSql: string;
    executionDbName: string;
};

/**
 * 用一条摘要结果集替换本次执行产出的所有 affectedRows 结果集。
 *
 * 只处理受影响行数结果，SELECT 等真实结果集保持独立标签；单条 DML 不合并，
 * 「一条 UPDATE 影响 3 行」本身有信息量，压缩成摘要反而更难读。
 */
export const aggregateQueryEditorStatementResults = ({
    resultSets, entries, affectedResultCount, exportSql, executionDbName,
}: AggregateQueryEditorStatementResultsInput): QueryEditorResultSet[] => {
    if (affectedResultCount <= 1 || entries.length === 0) {
        return resultSets;
    }
    // SQL Server 存储过程会同时返回真实结果集与该语句的 affectedRows 状态行，
    // 这类状态行由 finalizeQueryEditorSqlServerResultSets 负责隐藏；先汇总会把它变成
    // 保留的 message 结果，反而多出一个标签，因此只要存在同语句的真实结果就不汇总。
    const concreteStatementIndexes = new Set<number>();
    resultSets.forEach((result) => {
        const isAffected = Array.isArray(result.columns) && result.columns.length === 1 && result.columns[0] === 'affectedRows';
        if (!isAffected) {
            concreteStatementIndexes.add(Number(result.sourceStatementIndex ?? 0));
        }
    });
    if (entries.some((entry) => concreteStatementIndexes.has(entry.statementIndex))) {
        return resultSets;
    }
    let summaryInserted = false;
    const next: QueryEditorResultSet[] = [];
    resultSets.forEach((result) => {
        if (result.columns.length === 1 && result.columns[0] === 'affectedRows') {
            if (summaryInserted) {
                return;
            }
            summaryInserted = true;
            next.push(buildQueryEditorStatementSummaryResultSet({
                entries,
                affectedResultCount,
                key: result.key,
                exportSql,
                executionDbName,
            }));
            return;
        }
        next.push(result);
    });
    return next;
};
