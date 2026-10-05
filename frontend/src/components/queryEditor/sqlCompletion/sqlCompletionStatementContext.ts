import { normalizeQueryEditorCompletionAnalysisText } from '../queryEditorInlineMemory';
import {
    getNormalizedOffsetAtPosition, isQueryEditorTableSourceCompletionContext,
    isQueryEditorTableAliasCompletionContext, buildQueryEditorTableSourceAlias,
} from '../QueryEditorHelpers';
import { resolveCurrentSqlStatementRange } from '../../../utils/sqlStatementSelection';
import { useStore } from '../../../store';
import { appendTableAlias } from '../../../utils/sqlDialect';
import type { createSqlCompletionDialectContext } from './sqlCompletionDialectContext';

export interface ResolveSqlCompletionStatementContextInput {
    model: any;
    position: any;
    activeDialect: ReturnType<typeof createSqlCompletionDialectContext>['activeDialect'];
}

export const resolveSqlCompletionStatementContext = ({ model, position, activeDialect }: ResolveSqlCompletionStatementContextInput) => {
    const fullText = normalizeQueryEditorCompletionAnalysisText(model.getValue());
    const cursorOffset = getNormalizedOffsetAtPosition(fullText, {
        lineNumber: Number(position?.lineNumber || 1),
        column: Number(position?.column || 1),
    });
    const currentStatementRange = resolveCurrentSqlStatementRange(fullText, cursorOffset, activeDialect);

    const lineStartOffset = fullText.lastIndexOf('\n', Math.max(0, cursorOffset - 1)) + 1;
    const linePrefix = fullText.slice(lineStartOffset, cursorOffset);
    const currentStatementPrefix = currentStatementRange
        ? fullText.slice(currentStatementRange.start, cursorOffset)
        : fullText.slice(0, cursorOffset);
    const completionScopeText = currentStatementPrefix || linePrefix;
    const currentStatementText = currentStatementRange?.text || '';
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
