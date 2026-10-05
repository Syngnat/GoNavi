export {
    findCompletionTablesByDatabase,
    createBoundedQueryEditorCompletionCandidateBatch,
    materializeBoundedQueryEditorCompletionBatches,
    buildBoundedQueryEditorCompletionSuggestions,
    selectUnqualifiedCompletionSynonyms,
} from './queryEditorCompletionCandidates';
export type {
    CompletionTableMeta,
    CompletionColumnMeta,
    CompletionViewMeta,
    CompletionSynonymMeta,
    CompletionTriggerMeta,
    CompletionRoutineMeta,
    CompletionSequenceMeta,
    CompletionPackageMeta,
    QueryEditorCompletionCandidateBatch,
} from './queryEditorCompletionCandidates';
export {
    QUERY_LOCATOR_ALIAS_PREFIX,
    buildQueryReadOnlyLocator,
    stripSidebarDropIdentifierQuotes,
    shouldPrefixSidebarDropDatabase,
    isQueryEditorPrimaryMouseButton,
    hasQueryEditorCtrlMetaModifier,
    readSidebarSqlDropText,
    stripQueryIdentifierQuotes,
    normalizeQueryResultMessageText,
    normalizeQueryResultMessages,
    MYSQL_SYSTEM_METADATA_SCHEMAS,
    POSTGRES_SYSTEM_METADATA_SCHEMAS,
    SQLITE_SYSTEM_METADATA_TABLES,
    isSystemMetadataQueryResult,
} from './queryEditorResultMessages';
export type { SimpleSelectInfo, QueryStatementPlan } from './queryEditorResultMessages';
export {
    splitTopLevelComma,
    SIMPLE_IDENTIFIER_PATH_RE,
    QUERY_ALIAS_RESERVED,
    getLastIdentifierPart,
    resolveSelectItemInfo,
    resolveSimpleSelectItemColumn,
    parseSimpleSelectInfo,
    appendQuerySelectExpressions,
    QUERY_LOCATOR_SOURCE_ALIAS,
    rewriteOracleSelectAllWithExpressions,
    rewriteOracleDuplicateSelectColumns,
    findWritableResultColumnForSource,
    resolveMetadataColumnName,
    buildQueryLocatorAlias,
    buildQueryLocatorColumnExpression,
    buildQueryRowIDExpression,
    buildDuckDBRowIDExpression,
    escapeMetadataSqlLiteral,
    quoteSqlServerDbIdentifier,
} from './queryEditorSelectRewrite';
export type { SelectItemInfo } from './queryEditorSelectRewrite';
export {
    normalizeMetadataDialect,
    buildCompletionTableCommentSQL,
    getCaseInsensitiveValue,
    normalizeCommentText,
    buildCompletionDocumentation,
    appendCommentToDetail,
    buildColumnCompletionDetail,
    buildColumnCompletionDocumentation,
    stripCompletionIdentifierQuotes,
    normalizeCompletionQualifiedName,
    getCompletionQualifiedNameLastPart,
    splitCompletionSchemaAndTable,
    getCompletionTableSchemaCounts,
    getFirstRowValue,
    getMySQLShowTablesName,
    normalizeMetadataQuerySpecs,
    buildQualifiedCompletionName,
    buildCompletionViewsMetadataQuerySpecs,
    buildCompletionSynonymsMetadataQuerySpecs,
    buildCompletionMaterializedViewsMetadataQuerySpecs,
    buildCompletionTriggersMetadataQuerySpecs,
    buildCompletionFunctionsMetadataQuerySpecs,
    buildCompletionSequencesMetadataQuerySpecs,
    buildCompletionPackagesMetadataQuerySpecs,
    queryCompletionMetadataRowsBySpecs,
} from './queryEditorCompletionMetadata';
export type { MetadataQuerySpec, MetadataQueryResult } from './queryEditorCompletionMetadata';
export {
    resolveQueryEditorConnectionTimeout,
    resolveQueryEditorMonacoLanguage,
    resolveQueryEditorFormatterLanguage,
    DEFAULT_QUERY_TEMPLATE,
    resolveNewQueryDefaultTemplate,
    getTabQueryValue,
    getInitialEditorQuery,
    resolveNextResultSetIndex,
    normalizeExecutedSqlKey,
    buildQueryEditorResultSetMergeKey,
    areSqlStatementListsEqual,
    normalizeEditorPosition,
    getNormalizedOffsetAtPosition,
    getNormalizedPositionAtOffset,
} from './queryEditorEditorState';
export type { QueryEditorMonacoLanguage } from './queryEditorEditorState';
export {
    QUERY_EDITOR_IDENTIFIER_CHAR_REGEX,
    QUERY_EDITOR_SQL_UNQUOTED_IDENTIFIER_PATTERN,
    QUERY_EDITOR_SQL_QUOTED_IDENTIFIER_PATTERN,
    QUERY_EDITOR_SQL_IDENTIFIER_PATTERN,
    QUERY_EDITOR_SQL_IDENTIFIER_PATH_PATTERN,
    QUERY_EDITOR_SQL_THREE_PART_COMPLETION_REGEX,
    QUERY_EDITOR_SQL_QUALIFIER_COMPLETION_REGEX,
    QUERY_EDITOR_SQL_TABLE_REFERENCE_REGEX,
    QUERY_EDITOR_SQL_ALIAS_REFERENCE_REGEX,
    QUERY_EDITOR_SQL_LEADING_IDENTIFIER_PATH_REGEX,
    QUERY_EDITOR_HOVER_DELAY_MS,
    QUERY_EDITOR_OBJECT_DECORATION_MAX_TEXT_LENGTH,
    QUERY_EDITOR_OBJECT_DECORATION_MAX_IDENTIFIERS,
    QUERY_EDITOR_OBJECT_DECORATION_MAX_LINES,
    QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH,
    QUERY_EDITOR_PERSISTED_DRAFT_MAX_TEXT_LENGTH,
    getQueryEditorModelValueLength,
    isQuotedQueryIdentifierPart,
    isQuotedQueryIdentifierPartForDialect,
    splitQueryIdentifierPathSegments,
    matchLeadingSelectTableReference,
    rewriteLeadingSelectTableReference,
    isOracleBaseTableReference,
    resolveOracleExactCaseTableReference,
    resolveOracleLikeDefaultSchemaName,
    resolveOracleLikeExecutionSchemaName,
    resolveOracleLikeLookupSchemaCandidates,
    getQueryEditorModelTextIfWithinLimit,
    getQueryEditorObjectResolveText,
    getQueryEditorDecorationModelTextIfLightweight,
} from './queryEditorIdentifierPaths';
export type {
    QueryEditorNavigationTarget,
    QueryEditorTableCtrlClickAction,
    QueryEditorHoverTarget,
    QueryIdentifierPathSegment,
} from './queryEditorIdentifierPaths';
export {
    maskQueryEditorSqlLiteralsAndComments,
    collectQueryEditorObjectDecorationCandidates,
    findIdentifierWindowAtOffset,
    getQueryEditorDocumentOffsetAtPosition,
    findQualifiedIdentifierWindowAtOffset,
    isQueryEditorTableSourceAtPosition,
} from './queryEditorSqlScan';
export {
    normalizeNavigationIdentifierParts,
    buildQueryEditorHoverMarkdown,
    buildQueryEditorIdentifierIdentityKey,
    buildQueryEditorReferenceIdentityKeys,
} from './queryEditorReferenceIdentity';
export type { QueryEditorTableReference } from './queryEditorReferenceIdentity';
export { collectQueryEditorTableReferences } from './queryEditorTableReferences';
export type { QueryEditorExecutionContext } from './queryEditorTableReferences';
export {
    resolveQueryEditorExecutionContext,
    isQueryEditorTableSourceCompletionContext,
    isQueryEditorTableAliasCompletionContext,
    buildQueryEditorAliasMap,
    buildQueryEditorTableSourceAlias,
    QUERY_EDITOR_COMMON_SCHEMA_NAME_SET,
    collectQueryEditorReferencedDatabaseNames,
} from './queryEditorExecutionContext';
export type { QueryEditorAliasMap } from './queryEditorExecutionContext';
export { resolveQueryEditorNavigationTarget } from './queryEditorNavigationTarget';
export { resolveQueryEditorHoverTarget } from './queryEditorHoverTarget';
export {
    resolveQueryEditorNavigationDecorations,
    resolveNextQueryEditorTableLocateIndex,
    dispatchQueryEditorSidebarLocate,
    resolveEventTargetNode,
    isDocumentLevelShortcutTarget,
    shouldHandleQueryEditorRunShortcutFallback,
    clearQueryEditorLinkDecorations,
    clearQueryEditorObjectDecorations,
} from './queryEditorNavigationDecorations';
export { resolveQueryLocatorPlan } from './queryEditorLocatorPlan';

export {
    QUERY_EDITOR_COMPLETION_SUGGESTION_LIMIT,
    rankQueryEditorCompletionCandidate,
    resolveQueryEditorCompletionFilterText,
} from './queryEditorCompletionMatch';
export type { QueryEditorCompletionMatchRank } from './queryEditorCompletionMatch';
