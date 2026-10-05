import {
    buildQueryEditorAliasMap, buildBoundedQueryEditorCompletionSuggestions,
    rankQueryEditorCompletionCandidate, buildColumnCompletionDetail,
    buildColumnCompletionDocumentation, resolveQueryEditorCompletionFilterText,
    findCompletionTablesByDatabase, createBoundedQueryEditorCompletionCandidateBatch,
    type CompletionTableMeta, appendCommentToDetail, buildCompletionDocumentation,
    type CompletionViewMeta, materializeBoundedQueryEditorCompletionBatches,
    QUERY_EDITOR_SQL_THREE_PART_COMPLETION_REGEX,
} from '../QueryEditorHelpers';
import {
    isSqlCompletionRequestCancelled, createEmptySqlCompletionResult, createSqlCompletionResult,
} from '../queryEditorLazyTablesCache';
import type { createSqlCompletionDialectContext } from './sqlCompletionDialectContext';
import type { createSqlCompletionMetadataLookups } from './sqlCompletionMetadataLookups';
import {
    sharedVisibleDbs, sharedTablesData, sharedViewsData, sharedMaterializedViewsData,
    sharedSynonymsData, sharedRoutinesData,
} from '../queryEditorCompletionState';
import { buildMetadataIdentityKey } from '../../../utils/metadataIdentity';
import { t as translate } from '../../../i18n';
import type { createSqlCompletionSuggestionBuilders } from './sqlCompletionSuggestionBuilders';
import type { resolveSqlCompletionStatementContext } from './sqlCompletionStatementContext';

export interface ResolveThreePartSqlCompletionInput {
    linePrefix: ReturnType<typeof resolveSqlCompletionStatementContext>['linePrefix'];
    stripQuotes: ReturnType<typeof createSqlCompletionDialectContext>['stripQuotes'];
    getCompletionColumnsByTable: ReturnType<typeof createSqlCompletionMetadataLookups>['getCompletionColumnsByTable'];
    token: { isCancellationRequested?: boolean; } | undefined;
    monaco: any;
    quoteCompletionPart: ReturnType<typeof createSqlCompletionDialectContext>['quoteCompletionPart'];
    applyCompletionFragmentCase: ReturnType<typeof createSqlCompletionDialectContext>['applyCompletionFragmentCase'];
    range: ReturnType<typeof createSqlCompletionDialectContext>['range'];
}

export const resolveThreePartSqlCompletion = async ({
    linePrefix, stripQuotes, getCompletionColumnsByTable, token, monaco, quoteCompletionPart,
    applyCompletionFragmentCase, range,
}: ResolveThreePartSqlCompletionInput) => {
    // 0) 三段式 db.table.column 格式：当输入 db.table. 时提示列
    const threePartMatch = linePrefix.match(QUERY_EDITOR_SQL_THREE_PART_COMPLETION_REGEX);
    if (threePartMatch) {
        const dbPart = stripQuotes(threePartMatch[1]);
        const tablePart = stripQuotes(threePartMatch[2]);
        const rawColPrefix = String(threePartMatch[3] || '');
        const colPrefix = rawColPrefix.toLowerCase();

        const cols = await getCompletionColumnsByTable(dbPart, tablePart, dbPart);
        if (isSqlCompletionRequestCancelled(token)) {
            return createEmptySqlCompletionResult();
        }

        const suggestions = buildBoundedQueryEditorCompletionSuggestions({
            candidates: cols,
            prefix: colPrefix,
            getMatchRank: (column, prefix) => rankQueryEditorCompletionCandidate(prefix, [column.name]),
            getSelectionKey: (column, _prefix, matchRank) => `0${matchRank}${column.name}`,
            buildSuggestion: (column) => ({
                label: column.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: quoteCompletionPart(applyCompletionFragmentCase(column.name, rawColPrefix)),
                detail: buildColumnCompletionDetail(column),
                documentation: buildColumnCompletionDocumentation(column),
                filterText: resolveQueryEditorCompletionFilterText(colPrefix, [column.name]) || column.name,
                range,
                sortText: `0${rankQueryEditorCompletionCandidate(colPrefix, [column.name]) ?? 9}${column.name}`,
            }),
        });
        return createSqlCompletionResult(suggestions);
    }
};

export interface ResolveDatabaseQualifierSqlCompletionInput {
    activeDialect: ReturnType<typeof createSqlCompletionDialectContext>['activeDialect'];
    qualifierIdentityKey: string;
    qualifier: string;
    getLazyTablesByDB: ReturnType<typeof createSqlCompletionMetadataLookups>['getLazyTablesByDB'];
    token: { isCancellationRequested?: boolean; } | undefined;
    prefix: string;
    buildDbQualifiedTableSuggestionMeta: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildDbQualifiedTableSuggestionMeta'];
    buildTableSuggestion: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildTableSuggestion'];
    monaco: any;
    appendTableSourceAlias: (insertText: string, tableName: string) => string;
    quoteCompletionPath: ReturnType<typeof createSqlCompletionDialectContext>['quoteCompletionPath'];
    applyCompletionFragmentCase: ReturnType<typeof createSqlCompletionDialectContext>['applyCompletionFragmentCase'];
    rawPrefix: string;
    range: ReturnType<typeof createSqlCompletionDialectContext>['range'];
    buildViewSuggestionMeta: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildViewSuggestionMeta'];
    getViewTypeLabel: ReturnType<typeof createSqlCompletionSuggestionBuilders>['getViewTypeLabel'];
    buildSynonymSuggestion: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildSynonymSuggestion'];
    buildRoutineSuggestionMeta: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildRoutineSuggestionMeta'];
    getRoutineTypeLabel: ReturnType<typeof createSqlCompletionSuggestionBuilders>['getRoutineTypeLabel'];
}

export const resolveDatabaseQualifierSqlCompletion = async ({
    activeDialect, qualifierIdentityKey, qualifier, getLazyTablesByDB, token, prefix,
    buildDbQualifiedTableSuggestionMeta, buildTableSuggestion, monaco, appendTableSourceAlias,
    quoteCompletionPath, applyCompletionFragmentCase, rawPrefix, range, buildViewSuggestionMeta,
    getViewTypeLabel, buildSynonymSuggestion, buildRoutineSuggestionMeta, getRoutineTypeLabel,
}: ResolveDatabaseQualifierSqlCompletionInput) => {
    // 首先检查 qualifier 是否是数据库名（跨库表提示）
    const visibleDbs = sharedVisibleDbs;
    if (visibleDbs.some((db) => buildMetadataIdentityKey(activeDialect, db) === qualifierIdentityKey)) {
        // qualifier 是数据库名，提示该库的表
        let tables = findCompletionTablesByDatabase(
            sharedTablesData,
            qualifier,
            activeDialect,
        );
        if (tables.length === 0) {
            tables = await getLazyTablesByDB(qualifier);
            if (isSqlCompletionRequestCancelled(token)) {
                return createEmptySqlCompletionResult();
            }
        }
        const tableBatch = createBoundedQueryEditorCompletionCandidateBatch<CompletionTableMeta, any>({
            candidates: tables,
            prefix,
            getMatchRank: (table, normalizedPrefix) => {
                if (buildMetadataIdentityKey(activeDialect, table.dbName || '') !== qualifierIdentityKey) return null;
                const meta = buildDbQualifiedTableSuggestionMeta(table.dbName || qualifier, table.tableName || '');
                return rankQueryEditorCompletionCandidate(normalizedPrefix, [meta.displayName, table.tableName]);
            },
            getSelectionKey: (table, _prefix, matchRank) => {
                const meta = buildDbQualifiedTableSuggestionMeta(table.dbName || qualifier, table.tableName || '');
                return `0${matchRank}${meta.displayName}`;
            },
            buildSuggestion: (table) => {
                const meta = buildDbQualifiedTableSuggestionMeta(table.dbName || qualifier, table.tableName || '');
                return {
                    ...buildTableSuggestion(
                        meta.displayName,
                        `${translate('query_editor.object_info.table')} (${table.dbName})`,
                        table.comment,
                        prefix,
                        [meta.displayName, table.tableName],
                    ),
                    kind: monaco.languages.CompletionItemKind.Class,
                    insertText: appendTableSourceAlias(
                        quoteCompletionPath(applyCompletionFragmentCase(meta.insertName, rawPrefix)),
                        meta.insertName,
                    ),
                    detail: appendCommentToDetail(`${translate('query_editor.object_info.table')} (${table.dbName})`, table.comment),
                    documentation: buildCompletionDocumentation(table.comment),
                    range,
                    sortText: `0${rankQueryEditorCompletionCandidate(prefix, [meta.displayName, table.tableName]) ?? 9}${meta.displayName}`,
                };
            },
        });
        const buildQualifiedViewBatch = (views: CompletionViewMeta[], materialized: boolean) => (
            createBoundedQueryEditorCompletionCandidateBatch({
                candidates: views,
                prefix,
                getMatchRank: (view, normalizedPrefix) => {
                    if (buildMetadataIdentityKey(activeDialect, view.dbName || '') !== qualifierIdentityKey) return null;
                    const meta = buildViewSuggestionMeta(view);
                    return rankQueryEditorCompletionCandidate(
                        normalizedPrefix,
                        [meta.displayName, meta.objectName, view.viewName],
                        false,
                    );
                },
                getSelectionKey: (view, _prefix, matchRank) => `05${matchRank}${buildViewSuggestionMeta(view).displayName}`,
                buildSuggestion: (view) => {
                    const meta = buildViewSuggestionMeta(view);
                    return {
                        label: meta.displayName,
                        kind: monaco.languages.CompletionItemKind.Class,
                        insertText: quoteCompletionPath(meta.displayName),
                        detail: `${getViewTypeLabel(materialized)} (${view.dbName})`,
                        filterText: resolveQueryEditorCompletionFilterText(prefix, [meta.displayName, meta.objectName, view.viewName])
                            || meta.displayName,
                        range,
                        sortText: `05${rankQueryEditorCompletionCandidate(prefix, [meta.displayName, meta.objectName, view.viewName]) ?? 9}${meta.displayName}`,
                    };
                },
            })
        );
        const viewBatch = buildQualifiedViewBatch(sharedViewsData, false);
        const materializedViewBatch = buildQualifiedViewBatch(sharedMaterializedViewsData, true);
        const synonymBatch = createBoundedQueryEditorCompletionCandidateBatch({
            candidates: sharedSynonymsData,
            prefix,
            getMatchRank: (synonym, normalizedPrefix) => (
                buildMetadataIdentityKey(activeDialect, synonym.ownerName || '') === qualifierIdentityKey
                    ? rankQueryEditorCompletionCandidate(normalizedPrefix, [synonym.synonymName])
                    : null
            ),
            getSelectionKey: (synonym) => '06' + synonym.synonymName,
            buildSuggestion: (synonym) => buildSynonymSuggestion(synonym, '06' + synonym.synonymName),
        });
        const routineBatch = createBoundedQueryEditorCompletionCandidateBatch({
            candidates: sharedRoutinesData,
            prefix,
            getMatchRank: (routine, normalizedPrefix) => {
                if (buildMetadataIdentityKey(activeDialect, routine.dbName || '') !== qualifierIdentityKey) return null;
                const meta = buildRoutineSuggestionMeta(routine);
                return rankQueryEditorCompletionCandidate(
                    normalizedPrefix,
                    [meta.displayName, meta.objectName, routine.routineName],
                );
            },
            getSelectionKey: (routine) => '1' + buildRoutineSuggestionMeta(routine).displayName,
            buildSuggestion: (routine) => {
                const meta = buildRoutineSuggestionMeta(routine);
                return {
                    label: meta.displayName,
                    kind: monaco.languages.CompletionItemKind.Function,
                    insertText: meta.insertText,
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                    detail: `${getRoutineTypeLabel(routine.routineType)} (${routine.dbName})`,
                    range,
                    sortText: '1' + meta.displayName,
                };
            },
        });
        return createSqlCompletionResult(
            materializeBoundedQueryEditorCompletionBatches([
                tableBatch,
                viewBatch,
                materializedViewBatch,
                synonymBatch,
                routineBatch,
            ]),
            true,
        );
    }
};

export interface ResolveSchemaQualifierSqlCompletionInput {
    activeDialect: ReturnType<typeof createSqlCompletionDialectContext>['activeDialect'];
    qualifierIdentityKey: string;
    prefix: string;
    splitSchemaAndTable: ReturnType<typeof createSqlCompletionDialectContext>['splitSchemaAndTable'];
    buildTableSuggestion: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildTableSuggestion'];
    monaco: any;
    appendTableSourceAlias: (insertText: string, tableName: string) => string;
    quoteCompletionPart: ReturnType<typeof createSqlCompletionDialectContext>['quoteCompletionPart'];
    applyCompletionFragmentCase: ReturnType<typeof createSqlCompletionDialectContext>['applyCompletionFragmentCase'];
    rawPrefix: string;
    range: ReturnType<typeof createSqlCompletionDialectContext>['range'];
    buildViewSuggestionMeta: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildViewSuggestionMeta'];
    getViewTypeLabel: ReturnType<typeof createSqlCompletionSuggestionBuilders>['getViewTypeLabel'];
    getViewSuggestionScope: ReturnType<typeof createSqlCompletionSuggestionBuilders>['getViewSuggestionScope'];
    buildSynonymSuggestion: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildSynonymSuggestion'];
    buildRoutineSuggestionMeta: ReturnType<typeof createSqlCompletionSuggestionBuilders>['buildRoutineSuggestionMeta'];
    getRoutineTypeLabel: ReturnType<typeof createSqlCompletionSuggestionBuilders>['getRoutineTypeLabel'];
}

export const resolveSchemaQualifierSqlCompletion = ({
    activeDialect, qualifierIdentityKey, prefix, splitSchemaAndTable, buildTableSuggestion, monaco,
    appendTableSourceAlias, quoteCompletionPart, applyCompletionFragmentCase, rawPrefix, range,
    buildViewSuggestionMeta, getViewTypeLabel, getViewSuggestionScope, buildSynonymSuggestion,
    buildRoutineSuggestionMeta, getRoutineTypeLabel,
}: ResolveSchemaQualifierSqlCompletionInput) => {
    // qualifier 是 schema（如 dbo/public）时，仅补全表名，避免输入 dbo. 后再补成 dbo.dbo.table
    let hasKnownSchemaQualifier = false;
    const matchesSchemaQualifier = (schemaName: string): boolean => (
        buildMetadataIdentityKey(activeDialect, schemaName || '') === qualifierIdentityKey
    );
    const schemaTableBatch = createBoundedQueryEditorCompletionCandidateBatch<CompletionTableMeta, any>({
        candidates: sharedTablesData,
        prefix,
        getMatchRank: (table, normalizedPrefix) => {
            const parsed = splitSchemaAndTable(table.tableName || '', table.dbName);
            if (!matchesSchemaQualifier(parsed.schema)) return null;
            hasKnownSchemaQualifier = true;
            if (!parsed.table) return null;
            return rankQueryEditorCompletionCandidate(normalizedPrefix, [parsed.table]);
        },
        getSelectionKey: (table, _prefix, matchRank) => `0${matchRank}${splitSchemaAndTable(table.tableName || '', table.dbName).table}`,
        buildSuggestion: (table) => {
            const parsed = splitSchemaAndTable(table.tableName || '', table.dbName);
            return {
                ...buildTableSuggestion(
                    parsed.table,
                    `${translate('query_editor.object_info.table')} (${table.dbName}${parsed.schema ? '.' + parsed.schema : ''})`,
                    table.comment,
                    prefix,
                    [parsed.table, table.tableName],
                ),
                kind: monaco.languages.CompletionItemKind.Class,
                insertText: appendTableSourceAlias(
                    quoteCompletionPart(applyCompletionFragmentCase(parsed.table, rawPrefix)),
                    parsed.table,
                ),
                detail: appendCommentToDetail(`${translate('query_editor.object_info.table')} (${table.dbName}${parsed.schema ? '.' + parsed.schema : ''})`, table.comment),
                documentation: buildCompletionDocumentation(table.comment),
                range,
                sortText: `0${rankQueryEditorCompletionCandidate(prefix, [parsed.table, table.tableName]) ?? 9}${parsed.table}`,
            };
        },
    });
        const buildSchemaViewBatch = (views: CompletionViewMeta[], materialized: boolean) => (
            createBoundedQueryEditorCompletionCandidateBatch({
                candidates: views,
                prefix,
                getMatchRank: (view, normalizedPrefix) => {
                    const meta = buildViewSuggestionMeta(view);
                    if (!matchesSchemaQualifier(meta.schemaName)) return null;
                    hasKnownSchemaQualifier = true;
                    if (!meta.objectName) return null;
                    return rankQueryEditorCompletionCandidate(normalizedPrefix, [meta.objectName]);
            },
            getSelectionKey: (view, _prefix, matchRank) => `05${matchRank}${buildViewSuggestionMeta(view).objectName}`,
            buildSuggestion: (view) => {
                const meta = buildViewSuggestionMeta(view);
                return {
                    label: meta.objectName,
                    kind: monaco.languages.CompletionItemKind.Class,
                    insertText: quoteCompletionPart(meta.objectName),
                    detail: `${getViewTypeLabel(materialized)} (${getViewSuggestionScope(view, meta)})`,
                    filterText: resolveQueryEditorCompletionFilterText(prefix, [meta.objectName, view.viewName])
                        || meta.objectName,
                    range,
                    sortText: `05${rankQueryEditorCompletionCandidate(prefix, [meta.objectName]) ?? 9}${meta.objectName}`,
                };
            },
        })
    );
    const schemaViewBatch = buildSchemaViewBatch(sharedViewsData, false);
    const schemaMaterializedViewBatch = buildSchemaViewBatch(sharedMaterializedViewsData, true);
    const schemaSynonymBatch = createBoundedQueryEditorCompletionCandidateBatch({
        candidates: sharedSynonymsData,
        prefix,
        getMatchRank: (synonym, normalizedPrefix) => {
            if (!matchesSchemaQualifier(synonym.ownerName || '')) return null;
            hasKnownSchemaQualifier = true;
            return rankQueryEditorCompletionCandidate(normalizedPrefix, [synonym.synonymName]);
        },
        getSelectionKey: (synonym) => '06' + synonym.synonymName,
        buildSuggestion: (synonym) => buildSynonymSuggestion(synonym, '06' + synonym.synonymName),
    });
    const schemaRoutineBatch = createBoundedQueryEditorCompletionCandidateBatch({
        candidates: sharedRoutinesData,
        prefix,
        getMatchRank: (routine, normalizedPrefix) => {
            const meta = buildRoutineSuggestionMeta(routine);
            if (!matchesSchemaQualifier(meta.schemaName)) return null;
            hasKnownSchemaQualifier = true;
            return rankQueryEditorCompletionCandidate(normalizedPrefix, [meta.objectName]);
        },
        getSelectionKey: (routine) => '1' + buildRoutineSuggestionMeta(routine).objectName,
        buildSuggestion: (routine) => {
            const meta = buildRoutineSuggestionMeta(routine);
            return {
                label: meta.objectName,
                kind: monaco.languages.CompletionItemKind.Function,
                insertText: `${quoteCompletionPart(meta.objectName)}($0)`,
                insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                detail: `${getRoutineTypeLabel(routine.routineType)} (${routine.dbName}${meta.schemaName ? '.' + meta.schemaName : ''})`,
                range,
                sortText: '1' + meta.objectName,
            };
        },
    });
    const schemaSuggestions = materializeBoundedQueryEditorCompletionBatches([
        schemaTableBatch,
        schemaViewBatch,
        schemaMaterializedViewBatch,
        schemaSynonymBatch,
        schemaRoutineBatch,
    ]);
    if (hasKnownSchemaQualifier) {
        return createSqlCompletionResult(schemaSuggestions, true);
    }
};

export interface ResolveTableQualifierSqlCompletionInput {
    completionReferenceText: string;
    getActiveCompletionDbName: ReturnType<typeof createSqlCompletionDialectContext>['getActiveCompletionDbName'];
    activeDialect: ReturnType<typeof createSqlCompletionDialectContext>['activeDialect'];
    qualifierIdentityKey: string;
    getCompletionColumnsForAlias: ReturnType<typeof createSqlCompletionMetadataLookups>['getCompletionColumnsForAlias'];
    token: { isCancellationRequested?: boolean; } | undefined;
    prefix: string;
    monaco: any;
    quoteCompletionPart: ReturnType<typeof createSqlCompletionDialectContext>['quoteCompletionPart'];
    applyCompletionFragmentCase: ReturnType<typeof createSqlCompletionDialectContext>['applyCompletionFragmentCase'];
    rawPrefix: string;
    range: ReturnType<typeof createSqlCompletionDialectContext>['range'];
}

export const resolveTableQualifierSqlCompletion = async ({
    completionReferenceText, getActiveCompletionDbName, activeDialect, qualifierIdentityKey,
    getCompletionColumnsForAlias, token, prefix, monaco, quoteCompletionPart,
    applyCompletionFragmentCase, rawPrefix, range,
}: ResolveTableQualifierSqlCompletionInput) => {
    // 否则检查是否是表别名或表名，提示列
    const aliasMap = buildQueryEditorAliasMap(completionReferenceText, getActiveCompletionDbName(), activeDialect);

    const tableInfo = aliasMap[qualifierIdentityKey];
    if (tableInfo) {
        const cols = await getCompletionColumnsForAlias(
            tableInfo,
            getActiveCompletionDbName(),
        );
        if (isSqlCompletionRequestCancelled(token)) {
            return createEmptySqlCompletionResult();
        }

        const suggestions = buildBoundedQueryEditorCompletionSuggestions({
            candidates: cols,
            prefix,
            getMatchRank: (column, normalizedPrefix) => rankQueryEditorCompletionCandidate(normalizedPrefix, [column.name]),
            getSelectionKey: (column, _prefix, matchRank) => `0${matchRank}${column.name}`,
            buildSuggestion: (column) => ({
                label: column.name,
                kind: monaco.languages.CompletionItemKind.Field,
                insertText: quoteCompletionPart(applyCompletionFragmentCase(column.name, rawPrefix)),
                detail: buildColumnCompletionDetail(column),
                documentation: buildColumnCompletionDocumentation(column),
                filterText: resolveQueryEditorCompletionFilterText(prefix, [column.name]) || column.name,
                range,
                sortText: `0${rankQueryEditorCompletionCandidate(prefix, [column.name]) ?? 9}${column.name}`,
            }),
        });
        return createSqlCompletionResult(suggestions);
    }
};
