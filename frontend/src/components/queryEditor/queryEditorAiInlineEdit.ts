import {
    splitQueryIdentifierPathSegments,
    buildQueryEditorIdentifierIdentityKey,
} from './QueryEditorHelpers';
import { isPostgresSchemaDialect } from '../../utils/connectionDriverType';
import type { QueryEditorAiContext, QueryEditorAiEditorSnapshot } from './queryEditorAiAssistTypes';
import {
    resolveQueryEditorInlineCompletionIntentDetails,
    normalizeInlineIdentifierPath,
    stripInlineIdentifierQuotes,
    INLINE_CTE_NAME_RE,
    collectInlineTableReferences,
    tableMatchesInlineReference,
} from './queryEditorAiInlineReferences';
import {
    collectInlineTableCandidateLabels,
    collectInlineColumnCandidateLabels,
    applyQueryEditorCompletionFragmentCase,
} from './queryEditorAiInlineCandidates';
import { getCurrentStatementPrefix } from './queryEditorAiInlineText';

export interface QueryEditorInlineCompletionEdit {
    previewText: string;
    editText: string;
    replacePrefixLength: number;
}

export const resolveQueryEditorInlineCompletionEdit = ({
    aiContext,
    editorSnapshot,
    insertText,
}: {
    aiContext: QueryEditorAiContext;
    editorSnapshot: QueryEditorAiEditorSnapshot;
    insertText: string;
}): QueryEditorInlineCompletionEdit => {
    const fallback: QueryEditorInlineCompletionEdit = {
        previewText: insertText,
        editText: insertText,
        replacePrefixLength: 0,
    };
    const intent = resolveQueryEditorInlineCompletionIntentDetails(
        editorSnapshot,
        aiContext.sqlDialect || aiContext.sourceType || '',
    );
    if ((intent.intent !== 'table_name' && intent.intent !== 'column_name') || !intent.fragment) {
        return fallback;
    }

    const candidateLabels = intent.intent === 'table_name'
        ? collectInlineTableCandidateLabels(aiContext, intent.fragment)
        : collectInlineColumnCandidateLabels(aiContext, editorSnapshot, intent.qualifier);
    const normalizer = intent.intent === 'table_name'
        ? normalizeInlineIdentifierPath
        : stripInlineIdentifierQuotes;
    const token = String(insertText || '').match(/^[A-Za-z0-9_$]+/)?.[0] || '';
    if (!token) {
        return fallback;
    }
    const normalizedDirectSuggestion = normalizer(token).toLowerCase();
    const normalizedCombinedSuggestion = normalizer(`${intent.fragment}${token}`).toLowerCase();
    const matchedCandidate = Array.from(new Map(
        candidateLabels
            .map((candidate) => String(candidate || '').trim())
            .filter(Boolean)
            .map((candidate) => [normalizer(candidate).toLowerCase(), candidate] as const),
    ).values()).find((candidate) => {
        const normalizedCandidate = normalizer(candidate).toLowerCase();
        return normalizedCandidate === normalizedDirectSuggestion
            || normalizedCandidate === normalizedCombinedSuggestion;
    });
    if (!matchedCandidate) {
        return fallback;
    }

    const canonicalIdentifier = applyQueryEditorCompletionFragmentCase(
        matchedCandidate,
        intent.fragment,
        isPostgresSchemaDialect(aiContext.sourceType || ''),
    );
    const remainder = String(insertText).slice(token.length);
    const editText = `${canonicalIdentifier}${remainder}`;
    return {
        previewText: editText.slice(intent.fragment.length),
        editText,
        replacePrefixLength: intent.fragment.length,
    };
};

const buildKeywordSuffixInsertText = (statementPrefix: string, suffix: string): string => (
    /\s$/.test(statementPrefix) ? suffix : ` ${suffix}`
);

export const resolveDeterministicInlineSyntaxCompletion = (
    editorSnapshot: QueryEditorAiEditorSnapshot,
    sqlDialect = '',
): { handled: boolean; insertText: string } => {
    const statementPrefix = getCurrentStatementPrefix(editorSnapshot.prefix, sqlDialect);
    const trimmedStatement = statementPrefix.trim();

    if (!trimmedStatement) {
        return {
            handled: false,
            insertText: '',
        };
    }

    if (/^SELECT(?:\s+DISTINCT)?$/i.test(trimmedStatement)) {
        return {
            handled: true,
            insertText: buildKeywordSuffixInsertText(statementPrefix, '* FROM '),
        };
    }

    if (/^SELECT\s+\*$/i.test(trimmedStatement)) {
        return {
            handled: true,
            insertText: buildKeywordSuffixInsertText(statementPrefix, 'FROM '),
        };
    }

    if (/^DELETE$/i.test(trimmedStatement)) {
        return {
            handled: true,
            insertText: buildKeywordSuffixInsertText(statementPrefix, 'FROM '),
        };
    }

    if (/^INSERT$/i.test(trimmedStatement)) {
        return {
            handled: true,
            insertText: buildKeywordSuffixInsertText(statementPrefix, 'INTO '),
        };
    }

    if (/^MERGE$/i.test(trimmedStatement)) {
        return {
            handled: true,
            insertText: buildKeywordSuffixInsertText(statementPrefix, 'INTO '),
        };
    }

    if (/^REPLACE$/i.test(trimmedStatement)) {
        return {
            handled: true,
            insertText: buildKeywordSuffixInsertText(statementPrefix, 'INTO '),
        };
    }

    if (/^ALTER$/i.test(trimmedStatement)) {
        return {
            handled: true,
            insertText: buildKeywordSuffixInsertText(statementPrefix, 'TABLE '),
        };
    }

    if (/^CREATE$/i.test(trimmedStatement)) {
        return {
            handled: true,
            insertText: buildKeywordSuffixInsertText(statementPrefix, 'TABLE '),
        };
    }

    if (/^DROP$/i.test(trimmedStatement)) {
        return {
            handled: true,
            insertText: buildKeywordSuffixInsertText(statementPrefix, 'TABLE '),
        };
    }

    if (/^TRUNCATE$/i.test(trimmedStatement)) {
        return {
            handled: true,
            insertText: buildKeywordSuffixInsertText(statementPrefix, 'TABLE '),
        };
    }

    return {
        handled: false,
        insertText: '',
    };
};

const collectInlineCteNames = (sql: string, dialect: string): Set<string> => {
    const names = new Set<string>();
    INLINE_CTE_NAME_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_CTE_NAME_RE.exec(String(sql || ''))) !== null) {
        const segments = splitQueryIdentifierPathSegments(match[1] || '', dialect);
        const key = buildQueryEditorIdentifierIdentityKey(segments, dialect);
        if (key) {
            names.add(key);
        }
    }
    return names;
};

export const isInlineCompletionScopedToKnownContext = (
    insertText: string,
    prefix: string,
    context: QueryEditorAiContext,
): boolean => {
    const dialect = context.sqlDialect || context.sourceType || '';
    const insertedTableRefs = collectInlineTableReferences(
        insertText,
        context.currentDb || '',
        context.visibleDbs || [],
        dialect,
    );
    if (!insertedTableRefs.length) {
        return true;
    }

    const knownTables = context.tables || [];
    const knownRefs = context.inlineReferencedTables || [];
    const cteNames = collectInlineCteNames(prefix, dialect);

    return insertedTableRefs.every((ref) => {
        const refSegments = ref.segments && ref.segments.length > 0
            ? ref.segments
            : splitQueryIdentifierPathSegments(ref.tableName, dialect);
        const refLastPart = refSegments.length > 0
            ? buildQueryEditorIdentifierIdentityKey([refSegments[refSegments.length - 1]], dialect)
            : '';
        if (refLastPart && cteNames.has(refLastPart)) {
            return true;
        }
        return knownTables.some((table) => tableMatchesInlineReference(table, ref, dialect))
            || knownRefs.some((knownRef) => tableMatchesInlineReference(
                { dbName: knownRef.dbName, tableName: knownRef.tableName },
                ref,
                dialect,
            ));
    });
};
