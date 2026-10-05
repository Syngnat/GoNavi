import {
    type CompletionTableMeta,
    splitQueryIdentifierPathSegments,
    buildQueryEditorIdentifierIdentityKey,
    buildQueryEditorAliasMap,
    collectQueryEditorTableReferences,
    isQueryEditorTableAliasCompletionContext,
    buildQueryEditorTableSourceAlias,
} from './QueryEditorHelpers';
import { isPostgresSchemaDialect } from '../../utils/connectionDriverType';
import { appendTableAlias } from '../../utils/sqlDialect';
import { getCurrentStatementPrefix, findCaseInsensitiveOverlap } from './queryEditorAiInlineText';
import {
    INLINE_PREFIX_LIMIT,
    MAX_INLINE_SCHEMA_TABLES,
    type QueryEditorAiContext,
    type QueryEditorAiEditorSnapshot,
    type QueryEditorAiTableReference,
    type QueryEditorInlineCompletionIntentDetails,
} from './queryEditorAiAssistTypes';
import {
    collectCurrentDatabaseTables,
    normalizeInlineIdentifierPath,
    defineHiddenInlineReferenceProperty,
    sameIdentifier,
    buildInlineTableMetadataIdentityKeys,
    getInlineIdentifierLastPart,
    collectColumnsMatchingReference,
    stripInlineIdentifierQuotes,
    INLINE_TABLE_FRAGMENT_SAFE_RE,
    INLINE_COLUMN_FRAGMENT_SAFE_RE,
    resolveQueryEditorInlineCompletionIntentDetails,
} from './queryEditorAiInlineReferences';

export const applyQueryEditorCompletionFragmentCase = (
    candidate: string,
    fragment: string,
    preserveCandidateCase = false,
): string => {
    if (preserveCandidateCase) {
        return candidate;
    }
    const activeFragment = String(fragment || '').trim().split('.').pop() || '';
    const fragmentCharacters = activeFragment.replace(/[^A-Za-z]/g, '');
    const candidateParts = String(candidate || '').split('.');
    const candidateLastPart = candidateParts.pop() || '';
    const candidateCharacters = candidateLastPart.replace(/[^A-Za-z]/g, '');
    if (!fragmentCharacters || !candidateCharacters) {
        return candidate;
    }
    // Lowercase input may intentionally target an uppercase metadata name. Do not
    // uppercase a lowercase metadata name: case-sensitive MySQL deployments would fail.
    if (
        fragmentCharacters === fragmentCharacters.toLowerCase()
        && candidateCharacters === candidateCharacters.toUpperCase()
    ) {
        return [...candidateParts, candidateLastPart.toLowerCase()].join('.');
    }
    return candidate;
};

export const resolveInlineSqlInsertText = (generatedSql: string, prefix: string, sqlDialect = ''): string => {
    const generated = String(generatedSql || '').trimEnd();
    if (!generated.trim()) {
        return '';
    }

    const prefixText = String(prefix || '');
    const statementPrefix = getCurrentStatementPrefix(prefixText, sqlDialect);
    const candidates = [
        prefixText.slice(-INLINE_PREFIX_LIMIT),
        statementPrefix,
        statementPrefix.trimStart(),
    ].filter(Boolean);

    for (const candidate of candidates) {
        const overlap = findCaseInsensitiveOverlap(candidate, generated);
        if (overlap > 0) {
            return generated.slice(overlap);
        }
    }

    if (/\w$/.test(prefixText) && /^\w/.test(generated)) {
        return ` ${generated}`;
    }
    return generated;
};

export const filterInlineTableMatches = (
    tables: CompletionTableMeta[],
    currentDb: string,
    fragment: string,
    dialect: string,
): CompletionTableMeta[] => {
    const fragmentSegments = splitQueryIdentifierPathSegments(fragment, dialect);
    const normalizedFragment = buildQueryEditorIdentifierIdentityKey(fragmentSegments, dialect);
    const useQualifiedName = fragmentSegments.length > 1;
    const sourceTables = useQualifiedName ? tables : collectCurrentDatabaseTables(tables, currentDb, dialect);
    const matched = sourceTables.filter((table) => {
        if (!normalizedFragment) {
            return true;
        }
        const tableSegments = splitQueryIdentifierPathSegments(table.tableName || '', dialect);
        const dbSegment = splitQueryIdentifierPathSegments(table.dbName || '', dialect)[0];
        const candidateSegments = useQualifiedName
            ? [
                tableSegments,
                ...(dbSegment ? [[dbSegment, ...tableSegments]] : []),
            ]
            : tableSegments.length > 0
                ? [[tableSegments[tableSegments.length - 1]]]
                : [];
        return candidateSegments.some((segments) => (
            buildQueryEditorIdentifierIdentityKey(segments, dialect).startsWith(normalizedFragment)
        ));
    });
    return matched.slice(0, MAX_INLINE_SCHEMA_TABLES);
};

export const resolveInlineColumnOwnerReference = (
    context: QueryEditorAiContext,
    editorSnapshot: QueryEditorAiEditorSnapshot,
    qualifier: string,
): QueryEditorAiTableReference | null => {
    const normalizedQualifier = normalizeInlineIdentifierPath(qualifier);
    if (!normalizedQualifier) {
        return null;
    }

    const currentDb = String(context.currentDb || '').trim();
    const dialect = context.sqlDialect || context.sourceType || '';
    const statementPrefix = getCurrentStatementPrefix(editorSnapshot.prefix, dialect);
    const aliasMap = buildQueryEditorAliasMap(statementPrefix, currentDb, dialect);
    const qualifierSegments = splitQueryIdentifierPathSegments(qualifier, dialect);
    const qualifierKey = buildQueryEditorIdentifierIdentityKey(qualifierSegments, dialect);
    const aliasMatch = aliasMap[qualifierKey];
    if (aliasMatch) {
        const sourceReference = collectQueryEditorTableReferences(statementPrefix, dialect).find((reference) => {
            const sourceSegments = reference.segments || splitQueryIdentifierPathSegments(reference.tableIdent, dialect);
            const sourceAliasSegment = reference.aliasSegment;
            const sourceKey = sourceAliasSegment
                ? buildQueryEditorIdentifierIdentityKey([sourceAliasSegment], dialect)
                : sourceSegments.length > 0
                    ? buildQueryEditorIdentifierIdentityKey([sourceSegments[sourceSegments.length - 1]], dialect)
                    : '';
            return sourceKey === qualifierKey;
        });
        const sourceSegments = sourceReference?.segments
            || splitQueryIdentifierPathSegments(sourceReference?.tableIdent || aliasMatch.tableName, dialect);
        const sourceParts = sourceReference?.parts
            || sourceSegments.map((segment) => segment.value).filter(Boolean);
        const schemaScoped = isPostgresSchemaDialect(dialect);
        const dbName = schemaScoped && sourceParts.length === 2
            ? currentDb
            : aliasMatch.dbName;
        const tableName = schemaScoped && sourceParts.length === 2
            ? sourceParts.join('.')
            : aliasMatch.tableName;
        const reference = {
            dbName,
            tableName,
            alias: normalizedQualifier,
            raw: normalizedQualifier,
        } as QueryEditorAiTableReference;
        defineHiddenInlineReferenceProperty(reference, 'parts', sourceParts);
        if (sourceSegments.length > 0) {
            defineHiddenInlineReferenceProperty(reference, 'segments', sourceSegments);
        }
        const aliasSegment = qualifierSegments[qualifierSegments.length - 1];
        if (aliasSegment) {
            defineHiddenInlineReferenceProperty(reference, 'aliasSegment', aliasSegment);
        }
        return reference;
    }

    const directTable = (context.tables || []).find((table) => {
        if (!sameIdentifier(table.dbName, currentDb, dialect)) {
            return false;
        }
        return buildInlineTableMetadataIdentityKeys(table.dbName, table.tableName, dialect)
            .some((key) => key === qualifierKey);
    });
    if (!directTable) {
        return null;
    }
    const reference = {
        dbName: directTable.dbName,
        tableName: directTable.tableName,
        raw: normalizedQualifier,
    } as QueryEditorAiTableReference;
    defineHiddenInlineReferenceProperty(
        reference,
        'parts',
        qualifierSegments.map((segment) => segment.value).filter(Boolean),
    );
    defineHiddenInlineReferenceProperty(
        reference,
        'segments',
        qualifierSegments,
    );
    return reference;
};

const resolveUniqueCompletionCandidateInsertText = (
    candidates: string[],
    fragment: string,
    preserveCandidateCase = false,
): string => {
    const dedupedCandidates = Array.from(new Map(
        candidates
            .map((candidate) => String(candidate || '').trim())
            .filter(Boolean)
            .map((candidate) => [candidate.toLowerCase(), candidate] as const),
    ).values());
    if (dedupedCandidates.length === 0) {
        return '';
    }

    const normalizedFragment = String(fragment || '').trim();
    if (!normalizedFragment) {
        return dedupedCandidates.length === 1 ? dedupedCandidates[0] : '';
    }

    const exactMatch = dedupedCandidates.find((candidate) => candidate.toLowerCase() === normalizedFragment.toLowerCase());
    if (exactMatch) {
        return '';
    }

    const prefixMatches = dedupedCandidates.filter((candidate) => candidate.toLowerCase().startsWith(normalizedFragment.toLowerCase()));
    if (prefixMatches.length !== 1) {
        return '';
    }
    return applyQueryEditorCompletionFragmentCase(prefixMatches[0], normalizedFragment, preserveCandidateCase)
        .slice(normalizedFragment.length);
};

export const collectInlineTableCandidateLabels = (
    context: QueryEditorAiContext,
    fragment: string,
): string[] => {
    const currentDb = String(context.currentDb || '').trim();
    const useQualifiedName = normalizeInlineIdentifierPath(fragment).includes('.');
    const dialect = context.sqlDialect || context.sourceType || '';
    return filterInlineTableMatches(context.tables || [], currentDb, fragment, dialect)
        .map((table) => {
            const normalizedTableName = normalizeInlineIdentifierPath(table.tableName || '');
            if (!useQualifiedName) {
                return getInlineIdentifierLastPart(normalizedTableName);
            }
            const normalizedDbName = normalizeInlineIdentifierPath(table.dbName || '');
            const candidatePaths = [
                normalizedTableName,
                normalizedDbName && !normalizedTableName.toLowerCase().startsWith(`${normalizedDbName.toLowerCase()}.`)
                    ? `${normalizedDbName}.${normalizedTableName}`
                    : '',
            ].filter(Boolean);
            return candidatePaths.find((candidate) => candidate.toLowerCase().startsWith(normalizeInlineIdentifierPath(fragment).toLowerCase()))
                || candidatePaths[0]
                || '';
        })
        .filter(Boolean);
};

export const collectInlineColumnCandidateLabels = (
    context: QueryEditorAiContext,
    editorSnapshot: QueryEditorAiEditorSnapshot,
    qualifier: string,
): string[] => {
    const ownerRef = resolveInlineColumnOwnerReference(context, editorSnapshot, qualifier);
    if (!ownerRef) {
        return [];
    }

    return collectColumnsMatchingReference(
        context.columns || [],
        ownerRef,
        context.sqlDialect || context.sourceType || '',
    )
        .map((column) => stripInlineIdentifierQuotes(column.name || '').trim())
        .filter(Boolean);
};

const resolveValidatedInlineObjectCandidateInsertText = ({
    candidateLabels,
    fragment,
    insertText,
    prefix,
    sqlDialect,
    normalizer,
    safePattern,
    preserveCandidateCase = false,
}: {
    candidateLabels: string[];
    fragment: string;
    insertText: string;
    prefix: string;
    sqlDialect?: string;
    normalizer: (value: string) => string;
    safePattern: RegExp;
    preserveCandidateCase?: boolean;
}): string => {
    const trimmedInsertText = String(insertText || '').trim();
    if (!trimmedInsertText || !safePattern.test(trimmedInsertText)) {
        return '';
    }

    const normalizedDirectSuggestion = normalizer(trimmedInsertText).toLowerCase();
    const normalizedCombinedSuggestion = normalizer(`${fragment}${trimmedInsertText}`).toLowerCase();

    const dedupedCandidates = Array.from(new Map(
        candidateLabels
            .map((candidate) => String(candidate || '').trim())
            .filter(Boolean)
            .map((candidate) => [normalizer(candidate).toLowerCase(), candidate] as const),
    ).values());

    const matchedCandidate = dedupedCandidates.find((candidate) => {
        const normalizedCandidate = normalizer(candidate).toLowerCase();
        return normalizedCandidate === normalizedDirectSuggestion
            || normalizedCandidate === normalizedCombinedSuggestion;
    });
    if (!matchedCandidate) {
        return '';
    }

    return resolveInlineSqlInsertText(
        applyQueryEditorCompletionFragmentCase(matchedCandidate, fragment, preserveCandidateCase),
        prefix,
        sqlDialect,
    );
};

const shouldAllowInlineObjectAiFallback = (
    candidateLabels: string[],
    fragment: string,
    normalizer: (value: string) => string,
): boolean => {
    const dedupedCandidates = Array.from(new Map(
        candidateLabels
            .map((candidate) => String(candidate || '').trim())
            .filter(Boolean)
            .map((candidate) => [normalizer(candidate).toLowerCase(), candidate] as const),
    ).values());
    if (dedupedCandidates.length === 0) {
        return false;
    }

    const normalizedFragment = normalizer(fragment).toLowerCase();
    if (!normalizedFragment) {
        return true;
    }
    if (dedupedCandidates.some((candidate) => normalizer(candidate).toLowerCase() === normalizedFragment)) {
        return false;
    }

    const prefixMatches = dedupedCandidates.filter((candidate) => normalizer(candidate).toLowerCase().startsWith(normalizedFragment));
    return prefixMatches.length > 1;
};

const resolveDeterministicInlineTableInsertText = (
    context: QueryEditorAiContext,
    fragment: string,
): string => {
    const candidateLabels = collectInlineTableCandidateLabels(context, fragment);
    return resolveUniqueCompletionCandidateInsertText(
        candidateLabels,
        normalizeInlineIdentifierPath(fragment),
        isPostgresSchemaDialect(context.sourceType || ''),
    );
};

export const resolveDeterministicInlineTableAliasInsertText = (
    editorSnapshot: QueryEditorAiEditorSnapshot,
    dialect?: string,
    tableAliasPrefix?: string,
): string => {
    const statementPrefix = getCurrentStatementPrefix(editorSnapshot.prefix, dialect);
    if (!/\s$/.test(statementPrefix) || !isQueryEditorTableAliasCompletionContext(statementPrefix, dialect || '')) {
        return '';
    }
    const references = collectQueryEditorTableReferences(statementPrefix, dialect || '');
    const currentReference = references[references.length - 1];
    if (!currentReference || currentReference.alias) {
        return '';
    }
    const alias = buildQueryEditorTableSourceAlias(
        currentReference.tableIdent,
        statementPrefix,
        dialect || '',
        tableAliasPrefix,
    );
    return appendTableAlias('', alias, dialect || '');
};

export const isQueryEditorInlineTableAliasPending = (
    editorSnapshot: QueryEditorAiEditorSnapshot,
    dialect = '',
): boolean => {
    const statementPrefix = getCurrentStatementPrefix(editorSnapshot.prefix, dialect);
    if (!/\s$/.test(statementPrefix) || !isQueryEditorTableAliasCompletionContext(statementPrefix, dialect)) {
        return false;
    }
    const references = collectQueryEditorTableReferences(statementPrefix, dialect);
    const currentReference = references[references.length - 1];
    return Boolean(currentReference && !currentReference.alias);
};

const resolveDeterministicInlineColumnInsertText = (
    context: QueryEditorAiContext,
    editorSnapshot: QueryEditorAiEditorSnapshot,
    qualifier: string,
    fragment: string,
): string => {
    const candidateLabels = collectInlineColumnCandidateLabels(context, editorSnapshot, qualifier);
    return resolveUniqueCompletionCandidateInsertText(
        candidateLabels,
        stripInlineIdentifierQuotes(fragment || '').trim(),
        isPostgresSchemaDialect(context.sourceType || ''),
    );
};

export const resolveValidatedInlineTableAiInsertText = (
    context: QueryEditorAiContext,
    editorSnapshot: QueryEditorAiEditorSnapshot,
    fragment: string,
    insertText: string,
): string => resolveValidatedInlineObjectCandidateInsertText({
    candidateLabels: collectInlineTableCandidateLabels(context, fragment),
    fragment,
    insertText,
    prefix: editorSnapshot.prefix,
    sqlDialect: context.sqlDialect || context.sourceType || '',
    normalizer: normalizeInlineIdentifierPath,
    safePattern: INLINE_TABLE_FRAGMENT_SAFE_RE,
    preserveCandidateCase: isPostgresSchemaDialect(context.sourceType || ''),
});

export const resolveValidatedInlineColumnAiInsertText = (
    context: QueryEditorAiContext,
    editorSnapshot: QueryEditorAiEditorSnapshot,
    qualifier: string,
    fragment: string,
    insertText: string,
): string => resolveValidatedInlineObjectCandidateInsertText({
    candidateLabels: collectInlineColumnCandidateLabels(context, editorSnapshot, qualifier),
    fragment,
    insertText,
    prefix: editorSnapshot.prefix,
    sqlDialect: context.sqlDialect || context.sourceType || '',
    normalizer: stripInlineIdentifierQuotes,
    safePattern: INLINE_COLUMN_FRAGMENT_SAFE_RE,
    preserveCandidateCase: isPostgresSchemaDialect(context.sourceType || ''),
});

export const shouldAllowInlineTableAiFallback = (
    context: QueryEditorAiContext,
    fragment: string,
): boolean => shouldAllowInlineObjectAiFallback(
    collectInlineTableCandidateLabels(context, fragment),
    fragment,
    normalizeInlineIdentifierPath,
);

export const shouldAllowInlineColumnAiFallback = (
    context: QueryEditorAiContext,
    editorSnapshot: QueryEditorAiEditorSnapshot,
    qualifier: string,
    fragment: string,
): boolean => shouldAllowInlineObjectAiFallback(
    collectInlineColumnCandidateLabels(context, editorSnapshot, qualifier),
    fragment,
    stripInlineIdentifierQuotes,
);

export const resolveDeterministicInlineSchemaCompletion = (
    context: QueryEditorAiContext,
    editorSnapshot: QueryEditorAiEditorSnapshot,
    intentDetails?: QueryEditorInlineCompletionIntentDetails,
): { handled: boolean; insertText: string } => {
    const intent = intentDetails || resolveQueryEditorInlineCompletionIntentDetails(
        editorSnapshot,
        context.sqlDialect || context.sourceType || '',
    );
    if (intent.intent === 'table_name') {
        return {
            handled: true,
            insertText: resolveDeterministicInlineTableInsertText(context, intent.fragment),
        };
    }
    if (intent.intent === 'column_name') {
        return {
            handled: true,
            insertText: resolveDeterministicInlineColumnInsertText(
                context,
                editorSnapshot,
                intent.qualifier,
                intent.fragment,
            ),
        };
    }
    return {
        handled: false,
        insertText: '',
    };
};
