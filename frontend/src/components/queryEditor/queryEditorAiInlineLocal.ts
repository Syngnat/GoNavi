import { isPostgresSchemaDialect } from '../../utils/connectionDriverType';
import { resolveTableAliasSyntax } from '../../utils/sqlDialect';
import {
    applyQueryEditorCompletionFragmentCase,
    resolveInlineSqlInsertText,
    isQueryEditorInlineTableAliasPending,
    resolveDeterministicInlineTableAliasInsertText,
    resolveDeterministicInlineSchemaCompletion,
    shouldAllowInlineTableAiFallback,
    shouldAllowInlineColumnAiFallback,
} from './queryEditorAiInlineCandidates';
import type {
    QueryEditorAiEditorSnapshot,
    QueryEditorInlineMemoryEntry,
    QueryEditorAiContext,
} from './queryEditorAiAssistTypes';
import {
    shouldAllowQueryEditorInlineMemoryCompletion,
    normalizeInlineMemoryMatchText,
    normalizeInlineMemoryCandidateSql,
    shouldRequestQueryEditorInlineCompletion,
} from './queryEditorAiRuntime';
import { getCurrentStatementPrefix, limitInlineInsertText } from './queryEditorAiInlineText';
import { resolveQueryEditorInlineCompletionIntentDetails } from './queryEditorAiInlineReferences';
import { resolveDeterministicInlineSyntaxCompletion } from './queryEditorAiInlineEdit';

const applyInlineMemoryObjectCase = (
    insertText: string,
    fragment: string,
    preserveCandidateCase = false,
): string => {
    const identifierSuffix = String(insertText || '').match(/^[A-Za-z0-9_$]+/)?.[0] || '';
    if (!identifierSuffix) {
        return insertText;
    }
    return `${applyQueryEditorCompletionFragmentCase(identifierSuffix, fragment, preserveCandidateCase)}${insertText.slice(identifierSuffix.length)}`;
};

export const resolveQueryEditorInlineMemoryInsertText = ({
    editorSnapshot,
    memoryEntries,
    sourceType,
    sqlDialect,
}: {
    editorSnapshot: QueryEditorAiEditorSnapshot;
    memoryEntries: QueryEditorInlineMemoryEntry[];
    sourceType?: string;
    sqlDialect?: string;
}): string => {
    const dialect = sqlDialect || sourceType || '';
    if (!shouldAllowQueryEditorInlineMemoryCompletion(editorSnapshot, dialect)) {
        return '';
    }

    const statementPrefix = getCurrentStatementPrefix(editorSnapshot.prefix, dialect);
    const normalizedStatementPrefix = normalizeInlineMemoryMatchText(statementPrefix);
    for (const entry of memoryEntries || []) {
        const candidateSql = normalizeInlineMemoryCandidateSql(entry?.sql || '');
        if (!candidateSql) {
            continue;
        }
        if (normalizedStatementPrefix && !normalizeInlineMemoryMatchText(candidateSql).startsWith(normalizedStatementPrefix)) {
            continue;
        }
        const insertText = resolveInlineSqlInsertText(candidateSql, editorSnapshot.prefix, dialect);
        const intent = resolveQueryEditorInlineCompletionIntentDetails(editorSnapshot, dialect);
        return limitInlineInsertText(
            intent.intent === 'table_name' || intent.intent === 'column_name'
                ? applyInlineMemoryObjectCase(insertText, intent.fragment, isPostgresSchemaDialect(sourceType || ''))
                : insertText,
        );
    }
    return '';
};

export const resolveQueryEditorInlineLocalCompletion = ({
    aiContext,
    editorSnapshot,
    deferEmptySchemaCompletion = false,
    autoAddTableAlias = true,
}: {
    aiContext: QueryEditorAiContext;
    editorSnapshot: QueryEditorAiEditorSnapshot;
    deferEmptySchemaCompletion?: boolean;
    autoAddTableAlias?: boolean;
}): { handled: boolean; insertText: string } => {
    const dialect = aiContext.sqlDialect || aiContext.sourceType || '';
    if (!shouldRequestQueryEditorInlineCompletion(editorSnapshot, dialect)) {
        return {
            handled: true,
            insertText: '',
        };
    }

    const isTableAliasContext = isQueryEditorInlineTableAliasPending(editorSnapshot, dialect);
    const tableAliasInsertText = autoAddTableAlias
        ? resolveDeterministicInlineTableAliasInsertText(editorSnapshot, dialect, aiContext.tableAliasPrefix)
        : '';
    if (tableAliasInsertText) {
        return {
            handled: true,
            insertText: tableAliasInsertText,
        };
    }
    if (isTableAliasContext && (
        !autoAddTableAlias
        || resolveTableAliasSyntax(dialect) === 'none'
    )) {
        return {
            handled: true,
            insertText: '',
        };
    }

    const inlineIntent = resolveQueryEditorInlineCompletionIntentDetails(editorSnapshot, dialect);
    const deterministicCompletion = resolveDeterministicInlineSchemaCompletion(
        aiContext,
        editorSnapshot,
        inlineIntent,
    );
    if (deterministicCompletion.handled && deterministicCompletion.insertText) {
        return deterministicCompletion;
    }
    if (deterministicCompletion.handled) {
        if (deferEmptySchemaCompletion) {
            return {
                handled: false,
                insertText: '',
            };
        }
        if (
            (inlineIntent.intent === 'table_name'
                && !shouldAllowInlineTableAiFallback(aiContext, inlineIntent.fragment))
            || (inlineIntent.intent === 'column_name'
                && !shouldAllowInlineColumnAiFallback(
                    aiContext,
                    editorSnapshot,
                    inlineIntent.qualifier,
                    inlineIntent.fragment,
                ))
        ) {
            return deterministicCompletion;
        }
    }

    return resolveDeterministicInlineSyntaxCompletion(editorSnapshot, dialect);
};
