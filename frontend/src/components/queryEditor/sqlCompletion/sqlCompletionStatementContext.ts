import {
    isQueryEditorTableSourceCompletionContext,
    isQueryEditorTableAliasCompletionContext, buildQueryEditorTableSourceAlias,
} from '../QueryEditorHelpers';
import { readQueryEditorCompletionAnalysisText } from './queryEditorCompletionAnalysisWindow';
import { resolveBoundedSqlStatementContext } from '../queryEditorBoundedStatementContext';
import { useStore } from '../../../store';
import { appendTableAlias } from '../../../utils/sqlDialect';
import type { createSqlCompletionDialectContext } from './sqlCompletionDialectContext';

export interface ResolveSqlCompletionStatementContextInput {
    model: any;
    position: any;
    activeDialect: ReturnType<typeof createSqlCompletionDialectContext>['activeDialect'];
}

export const resolveSqlCompletionStatementContext = ({ model, position, activeDialect }: ResolveSqlCompletionStatementContextInput) => {
    const { text: fullText, cursorOffset } = readQueryEditorCompletionAnalysisText(model, position);
    // 有界语句上下文：只在光标附近「向上 200 行 / 向下 100 行、遇空行截断」的窗口内定位语句
    // 边界，避免每次触发补全都对整篇文档做词法扫描（大 SQL 下补全耗时随体积增长）。
    // 窗口仍覆盖同一语句的 FROM 部分，别名解析结果与全文扫描一致。
    const boundedContext = resolveBoundedSqlStatementContext(fullText, cursorOffset, activeDialect);

    const lineStartOffset = fullText.lastIndexOf('\n', Math.max(0, cursorOffset - 1)) + 1;
    const linePrefix = fullText.slice(lineStartOffset, cursorOffset);
    // 窗口内没定位到语句（例如光标停在空白/注释区）时退回当前行前缀，
    // 不能再取全文前缀——那正是本次要消除的「随文档增长」成本来源。
    const currentStatementPrefix = boundedContext.prefixText || linePrefix;
    const completionScopeText = currentStatementPrefix || linePrefix;
    const currentStatementText = boundedContext.statementText;
    const completionReferenceText = currentStatementText || completionScopeText;
    const isTableSourceCompletion = isQueryEditorTableSourceCompletionContext(completionScopeText, activeDialect);
    const isTableAliasCompletion = isQueryEditorTableAliasCompletionContext(completionScopeText, activeDialect);
    const appendTableSourceAlias = (insertText: string, tableName: string) => {
        const tableAliasSettings = useStore.getState().appearance;
        if (!isTableAliasCompletion || tableAliasSettings.autoAddTableAlias === false) return insertText;
        const alias = buildQueryEditorTableSourceAlias(
            tableName,
            completionReferenceText,
            activeDialect,
            tableAliasSettings.customTableAliasPrefixEnabled
                ? tableAliasSettings.customTableAliasPrefix
                : '',
        );
        return appendTableAlias(insertText, alias, activeDialect);
    };
    return {
        linePrefix, currentStatementPrefix, completionReferenceText, isTableSourceCompletion,
        appendTableSourceAlias,
    };
};
