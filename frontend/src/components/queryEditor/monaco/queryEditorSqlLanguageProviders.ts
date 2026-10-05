import {
    setSqlCompletionRegistered, _g, setSqlCompletionDisposables, sqlCompletionRegistered,
    SQL_COMPLETION_PROVIDER_VERSION, SQL_COMPLETION_PROVIDER_MODULE_TOKEN, sqlCompletionDisposables,
    QUERY_EDITOR_MONACO_LANGUAGE_IDS, sharedConnections, sharedCurrentConnectionId, sharedCurrentDb,
    sharedVisibleDbs, sharedTablesData, sharedAllColumnsData, sharedViewsData,
    sharedMaterializedViewsData, sharedTriggersData, sharedRoutinesData, sharedSequencesData,
    sharedPackagesData, sharedCurrentSchema, sharedQueryEditorMetadataGeneration,
    sharedQueryEditorMetadataContextKey,
} from '../queryEditorCompletionState';
import {
    isSharedQueryEditorModelCurrent, isSqlCompletionRequestCancelled,
    isConnectionScopedQueryEditorMetadata, createEmptySqlCompletionResult,
    createSqlCompletionResult,
} from '../queryEditorLazyTablesCache';
import {
    normalizeEditorPosition, normalizeMetadataDialect, resolveQueryEditorHoverTarget,
    isQueryEditorTableSourceAtPosition, buildQueryEditorHoverMarkdown,
    QUERY_EDITOR_SQL_QUALIFIER_COMPLETION_REGEX, splitQueryIdentifierPathSegments,
    buildQueryEditorIdentifierIdentityKey, findCompletionTablesByDatabase, normalizeCommentText,
    type CompletionColumnMeta, buildQueryEditorAliasMap,
} from '../QueryEditorHelpers';
import {
    buildQueryEditorObjectResolveContext, type QueryEditorMetadataRequestSnapshot,
    loadQueryEditorHoverDdl, isSharedQueryEditorHoverDdlRequestCurrent,
    buildQueryEditorHoverDdlMarkdown,
} from '../queryEditorHoverDdl';
import { buildQueryEditorQualifiedObjectName } from '../queryEditorObjectEditSql';
import { createSqlCompletionDialectContext } from '../sqlCompletion/sqlCompletionDialectContext';
import { createSqlCompletionSuggestionBuilders } from '../sqlCompletion/sqlCompletionSuggestionBuilders';
import { createSqlCompletionMetadataLookups } from '../sqlCompletion/sqlCompletionMetadataLookups';
import { resolveSqlCompletionStatementContext } from '../sqlCompletion/sqlCompletionStatementContext';
import {
    resolveThreePartSqlCompletion, resolveDatabaseQualifierSqlCompletion,
    resolveSchemaQualifierSqlCompletion, resolveTableQualifierSqlCompletion,
} from '../sqlCompletion/sqlCompletionQualifierSuggestions';
import { createSqlCompletionRankingContext } from '../sqlCompletion/sqlCompletionRankingContext';
import { shouldIncludeQueryEditorSchemaObject } from '../queryEditorSchemaContext';
import { buildQueryEditorMetadataIdentityKeys } from '../queryEditorCompletionColumns';
import { buildSqlCompletionGlobalSuggestions } from '../sqlCompletion/sqlCompletionGlobalSuggestions';
import { useStore } from '../../../store';
import type { OnMount } from '../../MonacoEditor';
import type { TabData } from '../../../types';

export interface RegisterQueryEditorSqlLanguageProvidersInput {
    monaco: Parameters<OnMount>[1];
    currentDbRef: React.MutableRefObject<string>;
    currentDb: string;
    tab: TabData;
    currentConnectionIdRef: React.MutableRefObject<string>;
    useStructuredCompletionLabel: boolean;
}

export const registerQueryEditorSqlLanguageProviders = ({
    monaco, currentDbRef, currentDb, tab, currentConnectionIdRef, useStructuredCompletionLabel,
}: RegisterQueryEditorSqlLanguageProvidersInput) => {
    // HMR 重载或测试重置时，以全局状态为准，避免本地闭包状态和 provider 列表不同步。
    setSqlCompletionRegistered(Boolean(_g.__gonaviSqlCompletionState.registered));
    setSqlCompletionDisposables(_g.__gonaviSqlCompletionState.disposables);
    const shouldRegisterSqlCompletion = !sqlCompletionRegistered
        || _g.__gonaviSqlCompletionState.version !== SQL_COMPLETION_PROVIDER_VERSION
        || _g.__gonaviSqlCompletionState.moduleToken !== SQL_COMPLETION_PROVIDER_MODULE_TOKEN;

    // HMR 重载时释放旧注册避免补全项重复
    if (shouldRegisterSqlCompletion) {
        setSqlCompletionRegistered(true);
        _g.__gonaviSqlCompletionState.registered = true;
        _g.__gonaviSqlCompletionState.version = SQL_COMPLETION_PROVIDER_VERSION;
        _g.__gonaviSqlCompletionState.moduleToken = SQL_COMPLETION_PROVIDER_MODULE_TOKEN;
        sqlCompletionDisposables.forEach((d: any) => d?.dispose?.());
        sqlCompletionDisposables.length = 0;
        const registerQueryEditorHoverProvider = (provider: any) => {
            QUERY_EDITOR_MONACO_LANGUAGE_IDS.forEach((languageId) => {
                sqlCompletionDisposables.push(monaco.languages.registerHoverProvider(languageId, provider));
            });
        };
        const registerQueryEditorCompletionProvider = (provider: any) => {
            QUERY_EDITOR_MONACO_LANGUAGE_IDS.forEach((languageId) => {
                sqlCompletionDisposables.push(monaco.languages.registerCompletionItemProvider(languageId, provider));
            });
        };
        const queryEditorMetadataHoverProvider = {
        __gonaviHoverProviderKind: 'metadata',
        provideHover: (model: any, position: any) => {
            if (!isSharedQueryEditorModelCurrent(model)) {
                return null;
            }
            const normalizedPosition = normalizeEditorPosition(position);
            if (!normalizedPosition) {
                return null;
            }
            const lineContent = String(model?.getLineContent?.(normalizedPosition.lineNumber) || '');
            const resolveContext = buildQueryEditorObjectResolveContext(model, normalizedPosition, lineContent);
            const metadataDialect = normalizeMetadataDialect(
                sharedConnections.find((item) => item.id === sharedCurrentConnectionId),
            );
            const hoverTarget = resolveQueryEditorHoverTarget(
                resolveContext.text,
                lineContent,
                normalizedPosition.column,
                sharedCurrentDb,
                sharedVisibleDbs,
                sharedTablesData,
                sharedAllColumnsData,
                sharedViewsData,
                sharedMaterializedViewsData,
                sharedTriggersData,
                sharedRoutinesData,
                sharedSequencesData,
                sharedPackagesData,
                isQueryEditorTableSourceAtPosition(
                    resolveContext.text,
                    resolveContext.lineNumber,
                    normalizedPosition.column,
                    metadataDialect,
                ),
                resolveContext.documentContext,
                sharedCurrentSchema,
                undefined,
                true,
                metadataDialect,
            );
            if (!hoverTarget) {
                return null;
            }
            return {
                range: new monaco.Range(
                    normalizedPosition.lineNumber,
                    hoverTarget.range.startColumn,
                    normalizedPosition.lineNumber,
                    hoverTarget.range.endColumn,
                ),
                contents: [{ value: buildQueryEditorHoverMarkdown(hoverTarget) }],
            };
        },
        };
        const queryEditorDdlHoverProvider = {
        __gonaviHoverProviderKind: 'ddl',
        provideHover: async (model: any, position: any, token?: { isCancellationRequested?: boolean }) => {
            if (!isSharedQueryEditorModelCurrent(model)) {
                return null;
            }
            if (isSqlCompletionRequestCancelled(token)) {
                return null;
            }
            const normalizedPosition = normalizeEditorPosition(position);
            if (!normalizedPosition) {
                return null;
            }
            const lineContent = String(model?.getLineContent?.(normalizedPosition.lineNumber) || '');
            const resolveContext = buildQueryEditorObjectResolveContext(model, normalizedPosition, lineContent);
            const metadataDialect = normalizeMetadataDialect(
                sharedConnections.find((item) => item.id === sharedCurrentConnectionId),
            );
            const hoverTarget = resolveQueryEditorHoverTarget(
                resolveContext.text,
                lineContent,
                normalizedPosition.column,
                sharedCurrentDb,
                sharedVisibleDbs,
                sharedTablesData,
                sharedAllColumnsData,
                sharedViewsData,
                sharedMaterializedViewsData,
                sharedTriggersData,
                sharedRoutinesData,
                sharedSequencesData,
                sharedPackagesData,
                isQueryEditorTableSourceAtPosition(
                    resolveContext.text,
                    resolveContext.lineNumber,
                    normalizedPosition.column,
                    metadataDialect,
                ),
                resolveContext.documentContext,
                sharedCurrentSchema,
                undefined,
                true,
                metadataDialect,
            );
            if (hoverTarget?.kind !== 'table') {
                return null;
            }

            const connectionId = String(sharedCurrentConnectionId || '').trim();
            const dbName = String(hoverTarget.dbName || '').trim();
            const tableName = buildQueryEditorQualifiedObjectName(
                String(hoverTarget.lookupTableName || hoverTarget.tableName || '').trim(),
                hoverTarget.lookupTableName ? undefined : hoverTarget.schemaName,
            );
            const connection = sharedConnections.find((item) => item.id === connectionId);
            // SQLite can legitimately have an empty database name; the
            // backend still resolves the table from the connection itself.
            if (
                !connectionId
                || !connection?.config
                || !tableName
                || (!dbName && !isConnectionScopedQueryEditorMetadata(connection))
            ) {
                return null;
            }

            const snapshot: QueryEditorMetadataRequestSnapshot = {
                generation: sharedQueryEditorMetadataGeneration,
                connectionId,
                connectionConfig: connection.config,
            };
            const contextKey = sharedQueryEditorMetadataContextKey;
            const ddl = await loadQueryEditorHoverDdl(snapshot, dbName, tableName);
            if (
                isSqlCompletionRequestCancelled(token)
                || !ddl
                || !isSharedQueryEditorHoverDdlRequestCurrent(snapshot, contextKey)
            ) {
                return null;
            }

            return {
                range: new monaco.Range(
                    normalizedPosition.lineNumber,
                    hoverTarget.range.startColumn,
                    normalizedPosition.lineNumber,
                    hoverTarget.range.endColumn,
                ),
                contents: [{ value: buildQueryEditorHoverDdlMarkdown(ddl) }],
            };
        },
    };
    // Monaco prioritizes later same-score registrations, then renders the
    // collected parts by their provider ordinal. Register DDL first so the
    // later metadata provider receives the earlier ordinal and is rendered
    // above the optional DDL block.
    registerQueryEditorHoverProvider(queryEditorDdlHoverProvider);
    registerQueryEditorHoverProvider(queryEditorMetadataHoverProvider);
        registerQueryEditorCompletionProvider({
        triggerCharacters: ['.'],
        provideCompletionItems: async (model: any, position: any, _context?: any, token?: { isCancellationRequested?: boolean }) => {
            if (!isSharedQueryEditorModelCurrent(model)) {
                return createEmptySqlCompletionResult();
            }
            if (isSqlCompletionRequestCancelled(token)) {
                return createEmptySqlCompletionResult();
            }
            const {
                word, range, activeDialect, oracleLoginOwner, quoteCompletionPart,
                quoteCompletionPath, applyCompletionFragmentCase, getActiveCompletionDbName,
                getActiveCompletionSchemaName, activeConnectionHasScopedMetadata, dialectKeywords,
                dialectFunctions, stripQuotes, splitSchemaAndTable,
            } = createSqlCompletionDialectContext({ model, position, currentDbRef, currentDb, tab, currentConnectionIdRef });
            const {
                buildDbQualifiedTableSuggestionMeta, buildTableSuggestion, getRoutineTypeLabel,
                buildRoutineSuggestionMeta, getViewTypeLabel, buildViewSuggestionMeta,
                getViewSuggestionScope, buildSynonymSuggestion, buildConnConfig,
            } = createSqlCompletionSuggestionBuilders({
                splitSchemaAndTable, quoteCompletionPart, quoteCompletionPath,
                useStructuredCompletionLabel, getActiveCompletionDbName, monaco, range,
            });

        const {
            getLazyTablesByDB, getCompletionColumnsByTable, getCompletionColumnsForAlias,
        } = createSqlCompletionMetadataLookups({
            buildConnConfig, activeDialect, splitSchemaAndTable, oracleLoginOwner,
            activeConnectionHasScopedMetadata, token,
        });

            const {
                linePrefix, currentStatementPrefix, completionReferenceText,
                isTableSourceCompletion, appendTableSourceAlias,
            } = resolveSqlCompletionStatementContext({ model, position, activeDialect });

            const resolveThreePartSqlCompletionResult = await resolveThreePartSqlCompletion({
                linePrefix, stripQuotes, getCompletionColumnsByTable, token, monaco,
                quoteCompletionPart, applyCompletionFragmentCase, range,
            });
            if (resolveThreePartSqlCompletionResult !== undefined) return resolveThreePartSqlCompletionResult;

            // 1) 两段式 qualifier.xxx 格式
            const qualifierMatch = linePrefix.match(QUERY_EDITOR_SQL_QUALIFIER_COMPLETION_REGEX);
            if (qualifierMatch) {
                const qualifierSegments = splitQueryIdentifierPathSegments(qualifierMatch[1] || '', activeDialect);
                const qualifier = stripQuotes(qualifierMatch[1]);
                const rawPrefix = String(qualifierMatch[2] || '');
                const prefix = rawPrefix.toLowerCase();
                const qualifierIdentityKey = buildQueryEditorIdentifierIdentityKey(qualifierSegments, activeDialect);

                const resolveDatabaseQualifierSqlCompletionResult = await resolveDatabaseQualifierSqlCompletion({
                    activeDialect, qualifierIdentityKey, qualifier, getLazyTablesByDB, token,
                    prefix, buildDbQualifiedTableSuggestionMeta, buildTableSuggestion, monaco,
                    appendTableSourceAlias, quoteCompletionPath, applyCompletionFragmentCase,
                    rawPrefix, range, buildViewSuggestionMeta, getViewTypeLabel,
                    buildSynonymSuggestion, buildRoutineSuggestionMeta, getRoutineTypeLabel,
                });
                if (resolveDatabaseQualifierSqlCompletionResult !== undefined) return resolveDatabaseQualifierSqlCompletionResult;

                const resolveSchemaQualifierSqlCompletionResult = resolveSchemaQualifierSqlCompletion({
                    activeDialect, qualifierIdentityKey, prefix, splitSchemaAndTable,
                    buildTableSuggestion, monaco, appendTableSourceAlias, quoteCompletionPart,
                    applyCompletionFragmentCase, rawPrefix, range, buildViewSuggestionMeta,
                    getViewTypeLabel, getViewSuggestionScope, buildSynonymSuggestion,
                    buildRoutineSuggestionMeta, getRoutineTypeLabel,
                });
                if (resolveSchemaQualifierSqlCompletionResult !== undefined) return resolveSchemaQualifierSqlCompletionResult;

                const resolveTableQualifierSqlCompletionResult = await resolveTableQualifierSqlCompletion({
                    completionReferenceText, getActiveCompletionDbName, activeDialect,
                    qualifierIdentityKey, getCompletionColumnsForAlias, token, prefix, monaco,
                    quoteCompletionPart, applyCompletionFragmentCase, rawPrefix, range,
                });
                if (resolveTableQualifierSqlCompletionResult !== undefined) return resolveTableQualifierSqlCompletionResult;
            }

            const {
                foundTables, currentDatabase, hasCompletionDatabaseScope,
                isCurrentCompletionDatabase, rawWordPrefix, wordPrefix, getPrefixMatchRank,
                expectsTableName, expectsRoutineName, sortGroups,
            } = createSqlCompletionRankingContext({
                completionReferenceText, activeDialect, getActiveCompletionDbName,
                activeConnectionHasScopedMetadata, word, isTableSourceCompletion, linePrefix,
                dialectKeywords, currentStatementPrefix,
            });
            let completionTables = sharedTablesData;
            const currentSharedTables = expectsTableName && hasCompletionDatabaseScope
                ? findCompletionTablesByDatabase(
                    sharedTablesData,
                    currentDatabase,
                    activeDialect,
                )
                : [];
            if (
                expectsTableName
                && hasCompletionDatabaseScope
                && currentSharedTables.length === 0
            ) {
                const lazyTables = await getLazyTablesByDB(currentDatabase);
                if (isSqlCompletionRequestCancelled(token)) {
                    return createEmptySqlCompletionResult();
                }
                if (lazyTables.length > 0) {
                    completionTables = lazyTables;
                }
            }
            if (
                expectsTableName
                && hasCompletionDatabaseScope
                && currentSharedTables.length > 0
                && currentSharedTables.some((table) => !normalizeCommentText(table.comment))
            ) {
                const enrichedTables = await getLazyTablesByDB(currentDatabase);
                if (isSqlCompletionRequestCancelled(token)) {
                    return createEmptySqlCompletionResult();
                }
                if (enrichedTables.length > 0) {
                    completionTables = sharedTablesData;
                }
            }
            if (expectsTableName && hasCompletionDatabaseScope) {
                completionTables = findCompletionTablesByDatabase(
                    completionTables,
                    currentDatabase,
                    activeDialect,
                );
            }
            const currentCompletionSchema = getActiveCompletionSchemaName();
            if (expectsTableName && currentCompletionSchema) {
                completionTables = completionTables.filter((table) => {
                    const parsed = splitSchemaAndTable(table.tableName || '', table.dbName);
                    return shouldIncludeQueryEditorSchemaObject(currentCompletionSchema, parsed.schema);
                });
            }

            const referencedColumns: CompletionColumnMeta[] = [];
            if (!expectsTableName) {
                const aliasMapForReferencedTables = buildQueryEditorAliasMap(completionReferenceText, currentDatabase, activeDialect);
                const seenReferencedTables = new Set<string>();
                for (const tableInfo of Object.values(aliasMapForReferencedTables)) {
                    const key = buildQueryEditorMetadataIdentityKeys(
                        activeDialect,
                        tableInfo.dbName || '',
                        tableInfo.tableName || '',
                    )[0] || '';
                    if (
                        (!tableInfo.dbName && !activeConnectionHasScopedMetadata)
                        || !tableInfo.tableName
                        || seenReferencedTables.has(key)
                    ) continue;
                    seenReferencedTables.add(key);
                    const resolvedColumns = await getCompletionColumnsForAlias(tableInfo, currentDatabase);
                    if (isSqlCompletionRequestCancelled(token)) {
                        return createEmptySqlCompletionResult();
                    }
                    referencedColumns.push(...resolvedColumns);
                }
            }
            const { suggestions } = buildSqlCompletionGlobalSuggestions({
                expectsTableName, foundTables, activeDialect, referencedColumns, wordPrefix,
                isCurrentCompletionDatabase, sortGroups, monaco, quoteCompletionPart,
                applyCompletionFragmentCase, rawWordPrefix, range, currentDatabase,
                completionTables, splitSchemaAndTable, buildDbQualifiedTableSuggestionMeta,
                buildTableSuggestion, appendTableSourceAlias, quoteCompletionPath,
                getPrefixMatchRank, buildViewSuggestionMeta, getViewTypeLabel,
                getViewSuggestionScope, oracleLoginOwner, buildSynonymSuggestion,
                buildRoutineSuggestionMeta, expectsRoutineName, getRoutineTypeLabel,
                dialectKeywords, dialectFunctions,
            });
            return createSqlCompletionResult(suggestions, expectsTableName || expectsRoutineName);
        }
    });
    registerQueryEditorCompletionProvider({
        triggerCharacters: ['/'],
        provideCompletionItems: (model: any, position: any) => {
            const lineContent = model.getLineContent(position.lineNumber);
            const textBefore = lineContent.substring(0, position.column - 1).trimStart();
            if (!textBefore.startsWith('/')) {
                return { suggestions: [] };
            }

            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: position.column - textBefore.length,
                endColumn: position.column,
            };

            return {
                suggestions: ((window as any).__gonaviSlashCmdDefs || []).map((c: any, i: number) => ({
                    label: `${c.cmd}  ${c.label}`,
                    kind: monaco.languages.CompletionItemKind.Event,
                    detail: c.desc,
                    insertText: `__AI_${c.cmd.slice(1).toUpperCase()}__`,
                    range,
                    sortText: String(i).padStart(2, '0'),
                })),
            };
        },
    });

    // SQL snippet completion provider
    registerQueryEditorCompletionProvider({
        provideCompletionItems: (model: any, position: any) => {
            const word = model.getWordUntilPosition(position);
            const prefix = word.word.toLowerCase();
            if (!prefix) return createEmptySqlCompletionResult();

            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            };

            const allSnippets = useStore.getState().sqlSnippets || [];
            const matched = allSnippets.filter(s =>
                s.prefix.toLowerCase().startsWith(prefix) ||
                s.name.toLowerCase().includes(prefix)
            );

            return {
                suggestions: matched.map(s => ({
                    label: s.prefix,
                    kind: monaco.languages.CompletionItemKind.Snippet,
                    insertText: s.body,
                    insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                    detail: s.name,
                    documentation: s.syntaxHelp || s.description || s.body,
                    range,
                    sortText: '04' + s.prefix,
                })),
            };
        },
    });

    }
};
