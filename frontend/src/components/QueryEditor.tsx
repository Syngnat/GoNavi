import Modal from './common/ResizableDraggableModal';
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import Editor, { type BeforeMount, type OnMount } from './MonacoEditor';
import { message, Input, Form, MenuProps, Button, Segmented, type InputRef } from 'antd';
import {
    CodeOutlined,
    ClockCircleOutlined,
    EditOutlined,
    ExportOutlined,
    FileTextOutlined,
    HistoryOutlined,
    KeyOutlined,
    SaveOutlined,
    SearchOutlined,
    UndoOutlined,
} from '@ant-design/icons';
import { format } from 'sql-formatter';
import { v4 as uuidv4 } from 'uuid';
import { TabData, ColumnDefinition, type ConnectionConfig, type SavedQuery, type SqlSnippet } from '../types';
import { type SqlLog, useStore } from '../store';
import { DBQuery, DBQueryWithCancel, DBQueryMulti, DBQueryMultiInTransaction, DBQueryMultiTransactional, DBGetTables, DBTableExists, DBGetAllColumns, DBGetDatabases, DBGetColumns, DBGetTriggers, DBShowCreateTable, CancelQuery, GenerateQueryID, WriteSQLFile, ExportSQLFile, InspectElasticsearchConsole, ExecuteElasticsearchConsole } from '../../wailsjs/go/app/App';
import { GONAVI_ROW_KEY } from './DataGrid';
import { EventsOn, LogError, LogInfo } from '../../wailsjs/runtime';
import {
    findConnectionMutatingStatements,
    findPotentiallyMutatingConnectionStatements,
} from '../utils/connectionReadOnly';
import { confirmProductionRisk } from '../utils/productionRiskConfirm';
import {
    buildElasticsearchConsoleTemplates,
    buildElasticsearchInspectionDisplayLabel,
    formatElasticsearchConsoleSource,
    isElasticsearchConsoleRunCurrent,
    isElasticsearchConnection,
    resolveElasticsearchConsoleExecution,
} from '../utils/elasticsearchConsole';
import { getDataSourceCapabilities } from '../utils/dataSourceCapabilities';
import type { GridSortInfoItem } from '../utils/dataGridSort';
import { applyMongoQueryAutoLimit, convertMongoShellToJsonCommand } from "../utils/mongodb";
import { getShortcutDisplayLabel, getShortcutPlatform, getShortcutPrimaryModifierDisplayLabel, isEditableElement, isImeComposingKeyEvent, isShortcutMatch, comboToMonacoKeyBinding, normalizeShortcutCombo, resolveShortcutBinding } from "../utils/shortcuts";
import { useAutoFetchVisibility } from '../utils/autoFetchVisibility';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import { filterVisibleDatabaseNames } from '../utils/databaseVisibility';
import { isPostgresSchemaDialect } from '../utils/connectionDriverType';
import { resolveOceanBaseProtocolFromConfig } from '../utils/oceanBaseProtocol';
import { isOracleLikeDialect, resolveSqlDialect, resolveSqlFunctions, resolveSqlKeywords } from '../utils/sqlDialect';
import { applyQueryAutoLimit } from '../utils/queryAutoLimit';
import {
    buildQueryResultCountSql,
    buildQueryResultPageSql,
    createInitialQueryResultPagination,
    parseQueryResultTotalCount,
    resolveQueryResultPaginationTotal,
} from '../utils/queryResultPagination';
import { extractQueryResultTableRef, type QueryResultTableRef } from '../utils/queryResultTable';
import { quoteIdentPart, quoteQualifiedIdent } from '../utils/sql';
import { extractTableNameFromMetadataRow } from '../utils/tableMetadataRows';
import { getTableMetadataIssueDetail, isTableMetadataIncomplete } from '../utils/tableMetadataResult';
import { formatSqlExecutionError, hasLocalizedSqlTimeoutKeyword } from '../utils/sqlErrorSemantics';
import { canReusePendingSqlEditorTransactionForType, shouldUseSqlEditorManagedTransactionForType } from '../utils/sqlEditorTransaction';
import { findSqlStatementRanges, resolveCurrentSqlStatementRange, resolveExecutableSql } from '../utils/sqlStatementSelection';
import { isMacLikePlatform } from '../utils/appearance';
import { splitSidebarQualifiedName } from '../utils/sidebarLocate';
import { buildMySQLCompatibleViewMetadataSqls, isSidebarViewTableType, normalizeSidebarViewName } from '../utils/sidebarMetadata';
import { SIDEBAR_SQL_EDITOR_DRAG_MIME, decodeSidebarSqlEditorDragPayload, hasSidebarSqlEditorDragPayload } from '../utils/sidebarSqlDrag';
import {
  buildSqlFieldDropEdit,
  hasSqlFieldDragPayload,
  resolveSqlFieldDropAnchorRange,
  resolveSqlFieldDropCursorOffset,
} from '../utils/sqlFieldDrop';
import {
    CLOSE_ACTIVE_RESULT_TAB_EVENT,
    type CloseActiveResultShortcutRequest,
} from '../utils/closeTabShortcut';
import { resolveUniqueKeyGroupsFromIndexes } from './dataGridCopyInsert';
import { t as translate } from '../i18n';
import { buildSqlAnalysisWorkbenchTab } from '../utils/sqlAnalysisTab';
import { buildQueryHistoryWorkbenchTab, shouldKeepRestoredQueryUnbound } from '../utils/sqlAuditTab';
import { isLocalizedUntitledQueryTitle, QUERY_TAB_RENAME_REQUEST_EVENT } from '../utils/queryTabTitle';
import { buildSqlServerObjectDefinitionQueries } from '../utils/sqlServerObjectDefinition';
import { formatDdlForDisplay } from '../utils/ddlFormat';
import {
    clampQueryEditorEditorHeight,
    resolveQueryEditorEditorHeightFromRatio,
    resolveQueryEditorEditorHeightRatio,
    sanitizeQueryEditorEditorHeightRatio,
} from '../utils/queryEditorSplitLayout';
import {
    DUCKDB_ROWID_LOCATOR_COLUMN,
    ORACLE_ROWID_LOCATOR_COLUMN,
    type EditRowLocator,
} from '../utils/rowLocator';
import {
    clearQueryTabDraft,
    flushQueryTabDraftSnapshots,
    getQueryTabDraft,
    hasQueryTabDraft,
    persistQueryTabDraftSnapshot,
} from '../utils/sqlFileTabDrafts';
import {
    clearQueryEditorResultSession,
    saveQueryEditorResultSession,
    takeQueryEditorResultSession,
} from '../utils/queryEditorResultSessionCache';
import { buildEditableTriggerSql } from '../utils/triggerEditSql';
import { findTriggerDefinitionStatement } from '../utils/triggerDefinition';
import { openNativeQueryResultWindow } from '../utils/nativeDetachedWindowHost';
import {
    isNativeDetachedWindow,
    NATIVE_DETACHED_QUERY_RESULT_REDETACH_EVENT,
} from '../utils/nativeDetachedWindowClient';
import {
    getColumnDefinitionComment,
    getColumnDefinitionKey,
    getColumnDefinitionName,
    getColumnDefinitionType,
} from '../utils/columnDefinition';
import QueryEditorResultsPanel, {
    QUERY_EDITOR_SQL_LOG_TAB_KEY,
    resolveEffectiveActiveResultKey,
    type QueryEditorResultSet,
} from './QueryEditorResultsPanel';
import { showCountdownDangerConfirm } from './common/countdownDangerConfirm';
import ResultDiffWizard from './resultDiff/ResultDiffWizard';
import ResultDiffPanel from './resultDiff/ResultDiffPanel';
import ViewDataVerifyWizard from './resultDiff/ViewDataVerifyWizard';
import type {
  ResultDiffColumnMeta,
  ResultDiffComparableResult,
  ResultDiffSummary,
} from '../utils/resultDiff/types';
import {
  isViewEditSql,
  resolveViewNameForVerify,
} from '../utils/resultDiff/viewDataVerify';
import { SQL_EDITOR_AUTO_COMMIT_DELAY_OPTIONS } from './QueryEditorTransactionSettings';
import QueryEditorTransactionToolbar from './QueryEditorTransactionToolbar';
import { decorateV2MonacoContextMenu } from './common/V2ActionMenuPopup';
import QueryEditorToolbar, {
    formatQueryExecutionElapsed,
    resolveQueryExecutionSpeedIcon,
    useQueryExecutionElapsed,
} from './QueryEditorToolbar';
import { loadSchemas } from './sidebar/sidebarMetadataLoaders';
import {
    applyQueryEditorSchemaSearchPath,
    extractQueryEditorCurrentSchema,
    QUERY_EDITOR_CURRENT_SCHEMA_SQL,
    resolveLoadedQueryEditorSchema,
    shouldIncludeQueryEditorSchemaObject,
    supportsQueryEditorSchemaSelection,
} from './queryEditor/queryEditorSchemaContext';
import { useSqlEditorTransactionController } from './useSqlEditorTransactionController';
import {
    type CompletionColumnMeta,
    type CompletionPackageMeta,
    type CompletionRoutineMeta,
    type CompletionSequenceMeta,
    type CompletionSynonymMeta,
    type CompletionTableMeta,
    type CompletionTriggerMeta,
    type CompletionViewMeta,
    type QueryEditorNavigationTarget,
    type QueryStatementPlan,
    QUERY_EDITOR_HOVER_DELAY_MS,
    QUERY_EDITOR_COMPLETION_SUGGESTION_LIMIT,
    QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH,
    QUERY_EDITOR_OBJECT_DECORATION_MAX_TEXT_LENGTH,
    QUERY_EDITOR_PERSISTED_DRAFT_MAX_TEXT_LENGTH,
    QUERY_EDITOR_SQL_QUALIFIER_COMPLETION_REGEX,
    QUERY_EDITOR_SQL_THREE_PART_COMPLETION_REGEX,
    appendCommentToDetail,
    areSqlStatementListsEqual,
    buildBoundedQueryEditorCompletionSuggestions,
    createBoundedQueryEditorCompletionCandidateBatch,
    buildCompletionDocumentation,
    buildColumnCompletionDetail,
    buildColumnCompletionDocumentation,
    buildCompletionFunctionsMetadataQuerySpecs,
    buildCompletionMaterializedViewsMetadataQuerySpecs,
    buildCompletionPackagesMetadataQuerySpecs,
    buildCompletionSequencesMetadataQuerySpecs,
    buildCompletionSynonymsMetadataQuerySpecs,
    buildCompletionTableCommentSQL,
    buildCompletionTriggersMetadataQuerySpecs,
    buildCompletionViewsMetadataQuerySpecs,
    buildQueryEditorAliasMap,
    buildQueryEditorHoverMarkdown,
    buildQueryEditorResultSetMergeKey,
    buildQualifiedCompletionName,
    clearQueryEditorLinkDecorations,
    clearQueryEditorObjectDecorations,
    collectQueryEditorObjectDecorationCandidates,
    collectQueryEditorReferencedDatabaseNames,
    collectQueryEditorTableReferences,
    findCompletionTablesByDatabase,
    getCaseInsensitiveValue,
    getCompletionTableSchemaCounts,
    getFirstRowValue,
    getNormalizedPositionAtOffset,
    hasQueryEditorCtrlMetaModifier,
    getInitialEditorQuery,
    getMySQLShowTablesName,
    getNormalizedOffsetAtPosition,
    getQueryEditorDecorationModelTextIfLightweight,
    getQueryEditorObjectResolveText,
    getTabQueryValue,
    isOracleBaseTableReference,
    isQueryEditorTableSourceCompletionContext,
    isDocumentLevelShortcutTarget,
    isQueryEditorPrimaryMouseButton,
    normalizeCommentText,
    normalizeQueryResultMessages,
    normalizeCompletionQualifiedName,
    normalizeEditorPosition,
    normalizeMetadataDialect,
    queryCompletionMetadataRowsBySpecs,
    readSidebarSqlDropText,
    matchLeadingSelectTableReference,
    maskQueryEditorSqlLiteralsAndComments,
    materializeBoundedQueryEditorCompletionBatches,
    resolveNewQueryDefaultTemplate,
    resolveEventTargetNode,
    resolveNextResultSetIndex,
    resolveOracleExactCaseTableReference,
    resolveOracleLikeDefaultSchemaName,
    resolveOracleLikeExecutionSchemaName,
    resolveOracleLikeLookupSchemaCandidates,
    resolveQueryEditorFormatterLanguage,
    resolveQueryEditorCompletionFilterText,
    resolveQueryEditorConnectionTimeout,
    resolveQueryEditorMonacoLanguage,
    resolveQueryEditorHoverTarget,
    resolveQueryEditorNavigationDecorations,
    resolveQueryEditorNavigationTarget,
    rankQueryEditorCompletionCandidate,
    resolveQueryLocatorPlan,
    rewriteLeadingSelectTableReference,
    selectUnqualifiedCompletionSynonyms,
    splitCompletionSchemaAndTable,
    splitQueryIdentifierPathSegments,
    stripCompletionIdentifierQuotes,
    shouldHandleQueryEditorRunShortcutFallback,
} from './queryEditor/QueryEditorHelpers';
import {
    applyQueryEditorCompletionFragmentCase,
    buildQueryEditorAiInlineSuggestOptions,
    getQueryEditorAiService,
    requestQueryEditorInlineCompletion,
    requestQueryEditorTextToElasticsearch,
    requestQueryEditorTextToSql,
    resolveInlineSqlGhostPreviewText,
    resolveQueryEditorInlineMemoryInsertText,
    resolveQueryEditorInlineCompletionIntentDetails,
    resolveQueryEditorInlineCompletionEdit,
    resolveQueryEditorInlineLocalCompletion,
    resolveQueryEditorInlineRuntimeReadiness,
    shouldTriggerQueryEditorInlineObjectSuggestFallback,
    shouldRequestQueryEditorInlineCompletion,
    type QueryEditorAiApplyMode,
    type QueryEditorAiContext,
    type QueryEditorAiEditorSnapshot,
    type QueryEditorInlineCompletionEdit,
} from './queryEditor/QueryEditorAiAssist';
export {
    collectQueryEditorObjectDecorationCandidates,
    resolveQueryEditorNavigationDecorations,
    resolveQueryEditorNavigationTarget,
} from './queryEditor/QueryEditorHelpers';

const buildQueryEditorMonacoActionLabel = (key: string): string =>
    `GoNavi: ${translate(key)}`;

const QUERY_EDITOR_NATIVE_SELECT_CURRENT_LINE_EVENT = 'gonavi:native-select-current-line';
const QUERY_EDITOR_MAC_FIND_WITH_SELECTION_COMBO = 'Meta+E';
const QUERY_EDITOR_MAC_FIND_WITH_SELECTION_GUARD_ACTION_ID = 'gonavi.suppressMacFindWithSelection';
const QUERY_EDITOR_AI_INLINE_DEBOUNCE_MS = 220;
const QUERY_EDITOR_AI_INLINE_CONTEXT_KEY = 'gonaviAiInlineSuggestionVisible';
const QUERY_EDITOR_IME_FALLBACK_DELAY_MS = 80;
const QUERY_EDITOR_FORMAT_PARAM_TYPES = {
    custom: [
        { regex: String.raw`#\{[^{}]+\}` },
        { regex: String.raw`\$\{[^{}]+\}` },
    ],
};
const QUERY_EDITOR_FORMAT_ERROR_LOG_MAX_LENGTH = 500;
const EMPTY_QUERY_EDITOR_SQL_LOGS: SqlLog[] = [];

const hasElasticsearchUncertainOutcome = (response: any): boolean => (
    response?.outcomeUnknown === true
);

const buildElasticsearchOutcomeMetadata = (response: any): { outcomeUnknown: boolean } => ({
    outcomeUnknown: hasElasticsearchUncertainOutcome(response),
});

const isOceanBaseOracleConnection = (config: any): boolean => {
    const type = String(config?.type || '').trim().toLowerCase();
    const driver = String(config?.driver || '').trim().toLowerCase();
    if (type !== 'oceanbase' && driver !== 'oceanbase') return false;
    try {
        return resolveOceanBaseProtocolFromConfig(config || {}) === 'oracle';
    } catch {
        return false;
    }
};

const supportsPositionalSqlFormatParams = (config: any): boolean => (
    isOceanBaseOracleConnection(config)
    || resolveSqlDialect(
        String(config?.type || ''),
        String(config?.driver || ''),
        { oceanBaseProtocol: config?.oceanBaseProtocol },
    ) === 'dameng'
);

const queryEditorFormatNow = (): number => (
    typeof globalThis.performance?.now === 'function'
        ? globalThis.performance.now()
        : Date.now()
);

const formatQueryEditorFormatDuration = (startedAt: number): string => (
    String(Math.round(Math.max(0, queryEditorFormatNow() - startedAt) * 10) / 10)
);

const normalizeQueryEditorFormatLogField = (value: unknown, fallback: string): string => {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '_')
        .slice(0, 64);
    return normalized || fallback;
};

const formatQueryEditorFormatError = (error: unknown): string => {
    const messageText = error instanceof Error ? error.message : String(error || 'unknown');
    return messageText
        .replace(/\s+/g, ' ')
        .replace(/Unexpected "(?:[^"\\]|\\.)*"/gi, 'Unexpected <token>')
        .trim()
        .slice(0, QUERY_EDITOR_FORMAT_ERROR_LOG_MAX_LENGTH) || 'unknown';
};

const writeQueryEditorFormatLog = (level: 'info' | 'error', messageText: string): void => {
    try {
        if (level === 'error') {
            LogError(messageText);
            return;
        }
        LogInfo(messageText);
    } catch {
        // Logging must never change whether formatting succeeds or fails.
    }
};

const normalizeQueryEditorInlineMemorySqlKey = (sql: string): string => (
    String(sql || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
);

const matchesQueryEditorInlineMemoryDb = (currentDb: string, candidateDb?: string): boolean => {
    const normalizedCurrentDb = String(currentDb || '').trim().toLowerCase();
    const normalizedCandidateDb = String(candidateDb || '').trim().toLowerCase();
    if (!normalizedCurrentDb || !normalizedCandidateDb) {
        return true;
    }
    return normalizedCurrentDb === normalizedCandidateDb;
};

const buildQueryEditorInlineMemoryEntries = ({
    currentConnectionId,
    currentDb,
    savedQueries,
    sqlLogs,
}: {
    currentConnectionId: string;
    currentDb: string;
    savedQueries: SavedQuery[];
    sqlLogs: SqlLog[];
}): Array<{ sql: string }> => {
    const ranked = new Map<string, { sql: string; score: number; latestAt: number }>();
    const addCandidate = (sql: string, score: number, latestAt: number) => {
        const text = String(sql || '').trim();
        if (!text) {
            return;
        }
        const key = normalizeQueryEditorInlineMemorySqlKey(text);
        if (!key) {
            return;
        }
        const existing = ranked.get(key);
        if (!existing) {
            ranked.set(key, { sql: text, score, latestAt });
            return;
        }
        existing.score += score;
        if (latestAt >= existing.latestAt) {
            existing.latestAt = latestAt;
            existing.sql = text;
        }
    };

    savedQueries.forEach((query) => {
        if (currentConnectionId && String(query.connectionId || '').trim() !== currentConnectionId) {
            return;
        }
        if (!matchesQueryEditorInlineMemoryDb(currentDb, query.dbName)) {
            return;
        }
        addCandidate(query.sql, 600, Number(query.createdAt || 0));
    });

    sqlLogs.forEach((log) => {
        if (log.status !== 'success' || log.category === 'transaction') {
            return;
        }
        if (!matchesQueryEditorInlineMemoryDb(currentDb, log.dbName)) {
            return;
        }
        addCandidate(log.sql, 80, Number(log.timestamp || 0));
    });

    return [...ranked.values()]
        .sort((left, right) => (
            right.score - left.score
            || right.latestAt - left.latestAt
            || left.sql.length - right.sql.length
        ))
        .slice(0, 16)
        .map((entry) => ({ sql: entry.sql }));
};

const buildQueryEditorMonacoOptions = (
    isObjectEditQueryTab: boolean,
    wordWrapEnabled = false,
    preserveLegacyObjectEditTypography = false,
) => ({
    minimap: { enabled: false },
    automaticLayout: true,
    fixedOverflowWidgets: true,
    wordWrap: wordWrapEnabled ? ('on' as const) : ('off' as const),
    // Keep the find widget as an overlay; Monaco's default top spacer creates a blank band.
    find: {
        addExtraSpaceOnTop: false,
    },
    hover: {
        enabled: true,
        delay: QUERY_EDITOR_HOVER_DELAY_MS,
        above: false,
    },
    scrollBeyondLastLine: false,
    quickSuggestions: { other: true, comments: false, strings: false },
    suggestOnTriggerCharacters: true,
    suggestLineHeight: QUERY_EDITOR_TABLE_SUGGESTION_ROW_HEIGHT,
    inlineSuggest: buildQueryEditorAiInlineSuggestOptions(),
    ...(isObjectEditQueryTab
        ? {
            ...(preserveLegacyObjectEditTypography
                ? { fontSize: 14, lineHeight: 24 }
                : {}),
            lineNumbersMinChars: 4,
            stickyScroll: { enabled: false },
        }
        : {}),
});

const QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER = '{SQL}';

const escapeQueryEditorObjectEditSqlLiteral = (value: unknown): string => (
    String(value || '').replace(/'/g, "''")
);

const CLIPBOARD_WRITE_TIMEOUT_MS = 2000;

const copyQueryEditorTextToClipboard = async (text: string): Promise<boolean> => {
    const tryAsyncClipboardWrite = async (): Promise<boolean> => {
        if (typeof navigator?.clipboard?.writeText !== 'function') {
            return false;
        }

        try {
            const written = await Promise.race([
                navigator.clipboard.writeText(text).then(() => true as const),
                new Promise<false>((resolve) => setTimeout(() => resolve(false), CLIPBOARD_WRITE_TIMEOUT_MS)),
            ]);
            return written;
        } catch {
            return false;
        }
    };

    if (typeof document?.createElement === 'function' && typeof document?.execCommand === 'function') {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'true');
        textarea.setAttribute('aria-hidden', 'true');
        Object.assign(textarea.style, {
            position: 'fixed',
            top: '0',
            left: '-9999px',
            opacity: '0',
            pointerEvents: 'none',
        });

        try {
            document.body?.appendChild?.(textarea);
            textarea.focus?.();
            textarea.select?.();
            textarea.setSelectionRange?.(0, text.length);
            if (document.execCommand('copy')) {
                return true;
            }
        } catch {
            // Fall through to async clipboard APIs when execCommand is unavailable.
        } finally {
            textarea.remove?.();
        }
    }

    if (await tryAsyncClipboardWrite()) {
        return true;
    }
    return false;
};

const getQueryEditorObjectEditRawValue = (row: Record<string, any>, candidateKeys: string[]): any => {
    const keyMap = new Map<string, any>();
    Object.keys(row || {}).forEach((key) => keyMap.set(key.toLowerCase(), row[key]));
    for (const key of candidateKeys) {
        if (keyMap.has(key.toLowerCase())) {
            const value = keyMap.get(key.toLowerCase());
            if (value !== undefined && value !== null) return value;
        }
    }
    return undefined;
};

const normalizeQueryEditorRoutineDefinitionForEdit = (
    definition: string,
    routineName: string,
    routineType: string,
): string => {
    const text = String(definition || '').trim();
    if (!text) return '';
    if (/^\s*create\b/i.test(text)) return text;
    if (/^\s*(function|procedure)\b/i.test(text)) {
        return `CREATE OR REPLACE ${text}`;
    }
    const normalizedType = String(routineType || 'FUNCTION').trim().toUpperCase().includes('PROC')
        ? 'PROCEDURE'
        : 'FUNCTION';
    return `CREATE OR REPLACE ${normalizedType} ${routineName}\n${text}`;
};

const buildQueryEditorRoutineEditFallbackSql = (
    routineName: string,
    routineType: string,
): string => {
    const normalizedType = String(routineType || 'FUNCTION').trim().toUpperCase().includes('PROC')
        ? 'PROCEDURE'
        : 'FUNCTION';
    if (normalizedType === 'PROCEDURE') {
        return `CREATE OR REPLACE PROCEDURE ${routineName}()\nBEGIN\n    -- TODO: edit procedure body\nEND;`;
    }
    return `CREATE OR REPLACE FUNCTION ${routineName}()\nRETURNS INTEGER\nBEGIN\n    -- TODO: edit function body\n    RETURN 0;\nEND;`;
};

const normalizeQueryEditorMySQLViewDDL = (rawDefinition: unknown): string => {
    const text = String(rawDefinition || '').trim();
    if (!text) return '';

    const normalized = text.replace(/\r\n/g, '\n').trim().replace(/;+\s*$/, '');
    const createViewPrefixPattern = /^\s*create\s+(?:algorithm\s*=\s*\w+\s+)?(?:definer\s*=\s*(?:`[^`]+`|\S+)\s*@\s*(?:`[^`]+`|\S+)\s+)?(?:sql\s+security\s+(?:definer|invoker)\s+)?view\s+/i;
    if (createViewPrefixPattern.test(normalized)) {
        return `${normalized.replace(createViewPrefixPattern, 'CREATE OR REPLACE VIEW ')};`;
    }

    if (/^\s*(select|with)\b/i.test(normalized)) {
        return normalized;
    }

    return `${normalized};`;
};

const normalizeQueryEditorSqlPlusSlashTerminator = (sql: string): string => (
    String(sql || '').trim().replace(/(^|\n)([ \t]*\/[ \t]*);+([ \t]*(?:--[^\n]*)?)\s*$/i, '$1$2$3')
);

const hasQueryEditorSqlPlusSlashTerminator = (sql: string): boolean => (
    /(?:^|\n)[ \t]*\/[ \t]*(?:--[^\n]*)?\s*$/i.test(String(sql || '').trim())
);

const ensureQueryEditorObjectEditSqlTerminator = (sql: string): string => {
    const normalized = normalizeQueryEditorSqlPlusSlashTerminator(sql);
    if (!normalized) return '';
    if (hasQueryEditorSqlPlusSlashTerminator(normalized)) return normalized;
    return /;\s*$/.test(normalized) ? normalized : `${normalized};`;
};

const isQueryEditorCommentOnlyDefinition = (definition: string): boolean => {
    const normalized = String(definition || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return false;
    const lines = normalized
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    return lines.length > 0 && lines.every((line) => line.startsWith('--'));
};

const withQueryEditorCreateOrReplacePackageHeaders = (definition: string): string => {
    const normalized = String(definition || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return '';
    return normalized
        .split(/(?=^\s*PACKAGE(?:\s+BODY)?\b)/gim)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => (/^\s*CREATE\b/i.test(part) ? part : `CREATE OR REPLACE ${part}`))
        .join('\n/\n');
};

const buildQueryEditorQualifiedObjectName = (objectName: string, schemaName?: string): string => {
    const normalizedObjectName = String(objectName || '').trim();
    const normalizedSchemaName = String(schemaName || '').trim();
    if (!normalizedObjectName || !normalizedSchemaName || normalizedObjectName.includes('.')) {
        return normalizedObjectName;
    }
    return `${normalizedSchemaName}.${normalizedObjectName}`;
};

const buildQueryEditorEditableDefinitionSql = (
    objectType: 'view-def' | 'sequence-def' | 'package-def',
    definition: string,
    objectName: string,
    objectLabel: string,
): string => {
    const normalizedDefinition = String(definition || '').trim();
    const header = [
        `-- ${translate('definition_viewer.edit.comment_title', { object: objectLabel, name: objectName })}`,
        `-- ${translate('definition_viewer.edit.comment_compatibility')}`,
    ].join('\n') + '\n';
    if (!normalizedDefinition) {
        return `${header}-- ${translate('definition_viewer.edit.comment_empty_definition', { name: objectName })}\n`;
    }

    if (isQueryEditorCommentOnlyDefinition(normalizedDefinition)) {
        return `${header}${ensureQueryEditorObjectEditSqlTerminator(normalizedDefinition)}`;
    }

    if (objectType === 'view-def' && !/^\s*create\b/i.test(normalizedDefinition)) {
        if (/^\s*view\b/i.test(normalizedDefinition)) {
            return `${header}${ensureQueryEditorObjectEditSqlTerminator(normalizedDefinition.replace(/^\s*view\b/i, 'CREATE OR REPLACE VIEW'))}`;
        }
        return `${header}CREATE OR REPLACE VIEW ${objectName} AS\n${ensureQueryEditorObjectEditSqlTerminator(normalizedDefinition)}`;
    }

    if (objectType === 'sequence-def' && !/^\s*create\b/i.test(normalizedDefinition)) {
        return `${header}${ensureQueryEditorObjectEditSqlTerminator(`CREATE SEQUENCE ${objectName}\n${normalizedDefinition}`)}`;
    }

    if (
        objectType === 'package-def'
        && !/^\s*create\b/i.test(normalizedDefinition)
        && /^\s*package\b/i.test(normalizedDefinition)
    ) {
        return `${header}${withQueryEditorCreateOrReplacePackageHeaders(normalizedDefinition)}`;
    }

    return `${header}${ensureQueryEditorObjectEditSqlTerminator(normalizedDefinition)}`;
};

const buildQueryEditorObjectDefinitionConnectionConfig = (conn: any): Record<string, any> => ({
    ...conn.config,
    port: Number(conn.config?.port),
    password: conn.config?.password || '',
    database: conn.config?.database || '',
    useSSH: conn.config?.useSSH || false,
    ssh: conn.config?.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
});

const runQueryEditorObjectDefinitionCandidates = async (
    config: Record<string, any>,
    dbName: string,
    queries: string[],
    collectAll = false,
): Promise<any[]> => {
    const collectedRows: any[] = [];
    for (const query of queries) {
        const sql = String(query || '').trim();
        if (!sql || sql.startsWith('--')) continue;
        try {
            const result = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, sql);
            if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
                continue;
            }
            if (!collectAll) {
                return result.data;
            }
            collectedRows.push(...result.data);
        } catch {
            // 元数据定义读取失败时保留编辑模板。
        }
    }
    return collectedRows;
};

const buildQueryEditorViewDefinitionQueries = (
    dialect: string,
    viewName: string,
    dbName: string,
    schemaName?: string,
    viewKind?: 'view' | 'materialized',
): string[] => {
    const parsed = splitSidebarQualifiedName(viewName);
    const objectName = parsed.objectName || viewName;
    const schema = String(schemaName || parsed.schemaName || '').trim();
    const safeName = escapeQueryEditorObjectEditSqlLiteral(objectName);
    const safeDbName = escapeQueryEditorObjectEditSqlLiteral(dbName);

    switch (dialect) {
        case 'mysql':
        case 'starrocks': {
            const viewRef = schema
                ? `\`${schema.replace(/`/g, '``')}\`.\`${objectName.replace(/`/g, '``')}\``
                : `\`${objectName.replace(/`/g, '``')}\``;
            if (dialect === 'starrocks' && viewKind === 'materialized') {
                return [
                    `SHOW CREATE MATERIALIZED VIEW ${viewRef}`,
                    `SHOW CREATE TABLE ${viewRef}`,
                ];
            }
            return [
                `SHOW CREATE VIEW ${viewRef}`,
                safeDbName
                    ? `SELECT VIEW_DEFINITION AS view_definition FROM information_schema.views WHERE table_schema = '${safeDbName}' AND table_name = '${safeName}' LIMIT 1`
                    : '',
                `SHOW CREATE TABLE ${viewRef}`,
            ].filter(Boolean);
        }
        case 'postgres':
        case 'kingbase':
        case 'highgo':
        case 'vastbase':
        case 'opengauss':
        case 'gaussdb': {
            const schemaRef = schema || 'public';
            return [`SELECT pg_get_viewdef('${escapeQueryEditorObjectEditSqlLiteral(schemaRef)}.${safeName}'::regclass, true) AS view_definition`];
        }
        case 'sqlserver':
            return buildSqlServerObjectDefinitionQueries('view', viewName, dbName, 'view_definition');
        case 'oracle': {
            const owner = schema ? escapeQueryEditorObjectEditSqlLiteral(schema).toUpperCase() : (safeDbName ? safeDbName.toUpperCase() : '');
            if (owner) {
                return [`SELECT TEXT AS view_definition FROM ALL_VIEWS WHERE OWNER = '${owner}' AND VIEW_NAME = '${safeName.toUpperCase()}'`];
            }
            return [`SELECT TEXT AS view_definition FROM USER_VIEWS WHERE VIEW_NAME = '${safeName.toUpperCase()}'`];
        }
        case 'sqlite':
            return [`SELECT sql AS view_definition FROM sqlite_master WHERE type='view' AND name='${safeName}'`];
        case 'duckdb': {
            const schemaRef = schema || 'main';
            return [`SELECT view_definition FROM information_schema.views WHERE table_schema = '${escapeQueryEditorObjectEditSqlLiteral(schemaRef)}' AND table_name = '${safeName}' LIMIT 1`];
        }
        default:
            return [];
    }
};

const extractQueryEditorViewDefinition = (dialect: string, data: any[]): string => {
    if (!Array.isArray(data) || data.length === 0) return '';
    const row = data[0] as Record<string, any>;
    if (dialect === 'mysql' || dialect === 'starrocks') {
        const direct = getQueryEditorObjectEditRawValue(row, ['view_definition', 'VIEW_DEFINITION']);
        if (direct !== undefined && direct !== null && String(direct).trim()) {
            return normalizeQueryEditorMySQLViewDDL(direct);
        }
        const sqlKey = Object.keys(row).find((key) => {
            const lowerKey = key.toLowerCase();
            return lowerKey.includes('create view') || lowerKey === 'create view' || lowerKey.includes('create table');
        });
        if (sqlKey) {
            return normalizeQueryEditorMySQLViewDDL(row[sqlKey]);
        }
        const createValue = Object.values(row).find((value) => {
            const text = String(value || '').toUpperCase();
            return text.includes('CREATE') && (text.includes('VIEW') || text.includes('TABLE'));
        });
        return createValue ? normalizeQueryEditorMySQLViewDDL(createValue) : '';
    }
    if (dialect === 'sqlserver') {
        const direct = getQueryEditorObjectEditRawValue(row, ['view_definition', 'definition']);
        if (direct !== undefined && direct !== null && String(direct).trim()) {
            return String(direct);
        }
        return data
            .map((item) => getQueryEditorObjectEditRawValue(item, ['Text', 'text']))
            .filter((value) => value !== undefined && value !== null)
            .map((value) => String(value))
            .join('');
    }
    const direct = getQueryEditorObjectEditRawValue(row, ['view_definition', 'definition', 'sql', 'text', 'TEXT', 'SQL']);
    return direct !== undefined && direct !== null ? String(direct) : String(Object.values(row)[0] || '');
};

const buildQueryEditorSequenceDefinitionQueries = (
    dialect: string,
    sequenceName: string,
    dbName: string,
    schemaName?: string,
): string[] => {
    const parsed = splitSidebarQualifiedName(sequenceName);
    const objectName = parsed.objectName || sequenceName;
    const schema = String(schemaName || parsed.schemaName || '').trim();
    const safeName = escapeQueryEditorObjectEditSqlLiteral(objectName);
    const safeDbName = escapeQueryEditorObjectEditSqlLiteral(dbName);
    const owner = schema ? escapeQueryEditorObjectEditSqlLiteral(schema).toUpperCase() : (safeDbName ? safeDbName.toUpperCase() : '');

    switch (dialect) {
        case 'oracle':
            if (owner) {
                return [`SELECT SEQUENCE_OWNER, SEQUENCE_NAME, MIN_VALUE, MAX_VALUE, INCREMENT_BY, CYCLE_FLAG, ORDER_FLAG, CACHE_SIZE, LAST_NUMBER FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = '${owner}' AND SEQUENCE_NAME = '${safeName.toUpperCase()}'`];
            }
            return [`SELECT SEQUENCE_NAME, MIN_VALUE, MAX_VALUE, INCREMENT_BY, CYCLE_FLAG, ORDER_FLAG, CACHE_SIZE, LAST_NUMBER FROM USER_SEQUENCES WHERE SEQUENCE_NAME = '${safeName.toUpperCase()}'`];
        case 'postgres':
        case 'kingbase':
        case 'highgo':
        case 'vastbase':
        case 'opengauss':
        case 'gaussdb': {
            const schemaRef = schema || 'public';
            return [`SELECT sequence_schema, sequence_name, data_type, start_value, minimum_value, maximum_value, increment FROM information_schema.sequences WHERE sequence_schema = '${escapeQueryEditorObjectEditSqlLiteral(schemaRef)}' AND sequence_name = '${safeName}' LIMIT 1`];
        }
        default:
            return [];
    }
};

const buildQueryEditorSequenceDefinitionFromRow = (
    row: Record<string, any>,
    fallbackSequenceName: string,
    fallbackSchemaName?: string,
): string => {
    const sequenceName = String(getQueryEditorObjectEditRawValue(row, ['sequence_name']) || splitSidebarQualifiedName(fallbackSequenceName).objectName || fallbackSequenceName).trim();
    const owner = String(getQueryEditorObjectEditRawValue(row, ['sequence_owner', 'owner', 'sequence_schema']) || fallbackSchemaName || splitSidebarQualifiedName(fallbackSequenceName).schemaName || '').trim();
    const name = buildQueryEditorQualifiedObjectName(sequenceName, owner);
    if (!name) return '';

    const clauses: string[] = [];
    const increment = getQueryEditorObjectEditRawValue(row, ['increment_by', 'increment']);
    const minValue = getQueryEditorObjectEditRawValue(row, ['min_value', 'minimum_value']);
    const maxValue = getQueryEditorObjectEditRawValue(row, ['max_value', 'maximum_value']);
    const cacheSize = Number(getQueryEditorObjectEditRawValue(row, ['cache_size']));
    const cycleFlag = String(getQueryEditorObjectEditRawValue(row, ['cycle_flag']) || '').trim().toUpperCase();
    const orderFlag = String(getQueryEditorObjectEditRawValue(row, ['order_flag']) || '').trim().toUpperCase();

    if (increment !== undefined && increment !== null && String(increment).trim() !== '') {
        clauses.push(`INCREMENT BY ${increment}`);
    }
    if (minValue !== undefined && minValue !== null && String(minValue).trim() !== '') {
        clauses.push(`MINVALUE ${minValue}`);
    }
    if (maxValue !== undefined && maxValue !== null && String(maxValue).trim() !== '') {
        clauses.push(`MAXVALUE ${maxValue}`);
    }
    if (Number.isFinite(cacheSize)) {
        clauses.push(cacheSize > 0 ? `CACHE ${cacheSize}` : 'NOCACHE');
    }
    if (cycleFlag) clauses.push(cycleFlag === 'Y' ? 'CYCLE' : 'NOCYCLE');
    if (orderFlag) clauses.push(orderFlag === 'Y' ? 'ORDER' : 'NOORDER');

    return [`CREATE SEQUENCE ${name}`, ...clauses.map((clause) => `  ${clause}`)].join('\n');
};

const extractQueryEditorSequenceDefinition = (
    data: any[],
    sequenceName: string,
    schemaName?: string,
): string => {
    if (!Array.isArray(data) || data.length === 0) return '';
    return buildQueryEditorSequenceDefinitionFromRow(data[0] as Record<string, any>, sequenceName, schemaName);
};

const buildQueryEditorPackageDefinitionQueries = (
    dialect: string,
    packageName: string,
    dbName: string,
    schemaName?: string,
): string[] => {
    const parsed = splitSidebarQualifiedName(packageName);
    const objectName = parsed.objectName || packageName;
    const schema = String(schemaName || parsed.schemaName || '').trim();
    const safeName = escapeQueryEditorObjectEditSqlLiteral(objectName);
    const safeDbName = escapeQueryEditorObjectEditSqlLiteral(dbName);

    if (dialect !== 'oracle') {
        return [];
    }

    const owner = schema ? escapeQueryEditorObjectEditSqlLiteral(schema).toUpperCase() : (safeDbName ? safeDbName.toUpperCase() : '');
    if (owner) {
        return [
            `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${owner}' AND NAME = '${safeName.toUpperCase()}' AND TYPE = 'PACKAGE' ORDER BY LINE`,
            `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${owner}' AND NAME = '${safeName.toUpperCase()}' AND TYPE = 'PACKAGE BODY' ORDER BY LINE`,
        ];
    }
    return [
        `SELECT TEXT FROM USER_SOURCE WHERE NAME = '${safeName.toUpperCase()}' AND TYPE = 'PACKAGE' ORDER BY LINE`,
        `SELECT TEXT FROM USER_SOURCE WHERE NAME = '${safeName.toUpperCase()}' AND TYPE = 'PACKAGE BODY' ORDER BY LINE`,
    ];
};

const extractQueryEditorPackageDefinition = (data: any[]): string => {
    if (!Array.isArray(data) || data.length === 0) return '';
    return data
        .map((row: any) => getQueryEditorObjectEditRawValue(row, ['text', 'TEXT']) ?? Object.values(row || {})[0] ?? '')
        .map((value) => String(value))
        .join('');
};

const buildQueryEditorTriggerDefinitionQueries = (
    dialect: string,
    triggerName: string,
    dbName: string,
    schemaName?: string,
): string[] => {
    const parsed = splitSidebarQualifiedName(triggerName);
    const objectName = parsed.objectName || triggerName;
    const schema = String(schemaName || parsed.schemaName || '').trim();
    const safeName = escapeQueryEditorObjectEditSqlLiteral(objectName);
    const safeDbName = escapeQueryEditorObjectEditSqlLiteral(dbName);

    switch (dialect) {
        case 'mysql':
        case 'starrocks': {
            const triggerRef = schema
                ? `\`${schema.replace(/`/g, '``')}\`.\`${objectName.replace(/`/g, '``')}\``
                : `\`${objectName.replace(/`/g, '``')}\``;
            return [
                `SHOW CREATE TRIGGER ${triggerRef}`,
                safeDbName
                    ? `SELECT TRIGGER_NAME, TRIGGER_SCHEMA, EVENT_OBJECT_SCHEMA, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_ORIENTATION, ACTION_STATEMENT FROM information_schema.triggers WHERE trigger_schema = '${safeDbName}' AND trigger_name = '${safeName}' LIMIT 1`
                    : '',
            ].filter(Boolean);
        }
        case 'postgres':
        case 'kingbase':
        case 'highgo':
        case 'vastbase':
        case 'opengauss':
        case 'gaussdb':
            return [`SELECT pg_get_triggerdef(t.oid, true) AS trigger_definition
FROM pg_trigger t
JOIN pg_class c ON t.tgrelid = c.oid
WHERE t.tgname = '${safeName}'
  AND NOT t.tgisinternal
LIMIT 1`];
        case 'sqlserver':
            return buildSqlServerObjectDefinitionQueries('trigger', triggerName, dbName, 'trigger_definition');
        case 'oracle':
            return [];
        case 'sqlite':
            return [`SELECT sql AS trigger_definition FROM sqlite_master WHERE type = 'trigger' AND name = '${safeName}'`];
        default:
            return [];
    }
};

const extractQueryEditorTriggerDefinition = (dialect: string, data: any[]): string => {
    if (!Array.isArray(data) || data.length === 0) return '';
    const row = data[0] as Record<string, any>;
    const direct = getQueryEditorObjectEditRawValue(row, ['trigger_definition', 'definition', 'sql', 'SQL']);
    if (direct !== undefined && direct !== null && String(direct).trim()) {
        return String(direct);
    }
    if (dialect === 'mysql' || dialect === 'starrocks') {
        const statementKey = Object.keys(row).find((key) => {
            const lowerKey = key.toLowerCase();
            return lowerKey.includes('statement') || lowerKey.includes('create trigger');
        });
        if (statementKey) return String(row[statementKey] || '');
        const createValue = Object.values(row).find((value) => String(value || '').toUpperCase().includes('CREATE TRIGGER'));
        return createValue ? String(createValue) : String(getQueryEditorObjectEditRawValue(row, ['ACTION_STATEMENT', 'action_statement']) || '');
    }
    return String(getQueryEditorObjectEditRawValue(row, ['TRIGGER_BODY', 'trigger_body', 'TEXT', 'text']) || Object.values(row)[0] || '');
};

const buildQueryEditorAiContextPrompt = (connection: any, database: string): string => {
    if (!connection) {
        return '';
    }

    const sourceLabel = String(connection.config?.type || '').trim() || translate('query_editor.ai_prompt.default_source');
    const databaseLabel = String(database || '').trim() || translate('query_editor.ai_prompt.default_database');

    return translate('query_editor.ai_prompt.context', {
        type: sourceLabel,
        name: `"${connection.name}"`,
        database: `"${databaseLabel}"`,
    });
};

const resolveQueryEditorAiConnectionHost = (connection: any): string => {
    const config = connection?.config || {};
    if (Array.isArray(config.hosts)) {
        const hosts = config.hosts
            .map((item: any) => String(typeof item === 'string' ? item : item?.host || item?.hostname || item?.address || '').trim())
            .filter(Boolean);
        if (hosts.length > 0) {
            return hosts.join(', ');
        }
    }
    return String(config.host || config.hostname || config.server || config.address || '').trim();
};

// HMR 重载时释放旧注册避免补全和 hover 内容重复
const _g = globalThis as any;
const SQL_COMPLETION_PROVIDER_VERSION = '20260817-schema-context-v3';
const QUERY_EDITOR_MONACO_LANGUAGE_IDS = ['sql', 'mysql'] as const;
if (!_g.__gonaviSqlCompletionState) {
    _g.__gonaviSqlCompletionState = { registered: false, version: '', disposables: [] as any[] };
}
if (!Array.isArray(_g.__gonaviSqlCompletionState.disposables)) {
    _g.__gonaviSqlCompletionState.disposables = [];
}
let sqlCompletionRegistered = _g.__gonaviSqlCompletionState.registered;
let sqlCompletionDisposables = _g.__gonaviSqlCompletionState.disposables;

// 模块级共享变量：completion provider 从这些变量读取当前活跃 Tab 的状态。
// 每个 QueryEditor 实例在成为活跃 Tab 时更新这些变量，确保 provider 始终使用正确的上下文。
let sharedCurrentDb = '';
let sharedCurrentConnectionId = '';
let sharedCurrentSchema = '';
let sharedConnections: any[] = [];
let sharedTablesData: CompletionTableMeta[] = [];
let sharedAllColumnsData: CompletionColumnMeta[] = [];
let sharedQueryEditorMetadataGeneration = 0;
let sharedQueryEditorMetadataContextKey = '';
let sharedQueryEditorMetadataConnectionConfig: unknown = null;

const QUERY_EDITOR_TABLE_SUGGESTION_ROW_HEIGHT = 36;

export const shouldRefreshQueryEditorCompletionColumns = (
    intent: string,
    hasColumnsForDatabase: boolean,
    hasIncompleteColumnMetadata: boolean,
): boolean => (
    intent === 'column_name' && (hasIncompleteColumnMetadata || !hasColumnsForDatabase)
);

const normalizeQueryEditorTableSuggestionText = (value: unknown): string => (
    String(value ?? '').replace(/\r\n|\r|\n/g, '').trim()
);

const buildQueryEditorTableSuggestionLabel = (
    label: unknown,
    description?: unknown,
    useStructuredLabel = true,
): any => {
    const normalizedLabel = normalizeQueryEditorTableSuggestionText(label);
    const normalizedDescription = normalizeQueryEditorTableSuggestionText(description);
    if (!useStructuredLabel) {
        return normalizedLabel;
    }
    return {
        label: normalizedLabel,
        description: normalizedDescription,
    };
};

// AI 补全的元数据预热可能把整库列（数十万条）灌入 sharedAllColumnsData，普通补全逐列全量
// 扫描会阻塞主线程；按 (库, 表名末段) 建索引，并以数组身份为键缓存，数组重新赋值时自动失效。
const sharedColumnsIndexCache = new WeakMap<CompletionColumnMeta[], Map<string, CompletionColumnMeta[]>>();
const dedupeCompletionColumnsByName = (columns: CompletionColumnMeta[]): CompletionColumnMeta[] => {
    const seen = new Set<string>();
    return columns.filter((column) => {
        const key = String(column.name || '').trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};
const findSharedPreloadedColumns = (dbName: string, tableName: string): CompletionColumnMeta[] => {
    const columns = sharedAllColumnsData;
    let index = sharedColumnsIndexCache.get(columns);
    if (!index) {
        index = new Map<string, CompletionColumnMeta[]>();
        columns.forEach((column) => {
            const dbLower = String(column.dbName || '').toLowerCase();
            const tableLower = String(column.tableName || '').toLowerCase();
            const lastPartLower = String(splitCompletionSchemaAndTable(column.tableName || '', column.dbName).table || '').toLowerCase();
            const keys = lastPartLower && lastPartLower !== tableLower
                ? [`${dbLower}\u0000${tableLower}`, `${dbLower}\u0000${lastPartLower}`]
                : [`${dbLower}\u0000${tableLower}`];
            keys.forEach((key) => {
                const list = index!.get(key);
                if (list) {
                    list.push(column);
                } else {
                    index!.set(key, [column]);
                }
            });
        });
        sharedColumnsIndexCache.set(columns, index);
    }
    const key = `${String(dbName || '').toLowerCase()}\u0000${String(tableName || '').toLowerCase()}`;
    return dedupeCompletionColumnsByName(index.get(key) || []);
};

// 普通建议的“相关列”按 SQL 中引用的表标识符（db.table / table / 纯表名）匹配，
// 同样避免对全量列做逐条正则扫描；索引以列数组身份为键缓存。
const sharedColumnsByIdentCache = new WeakMap<CompletionColumnMeta[], Map<string, CompletionColumnMeta[]>>();
const collectSharedColumnsForTableIdents = (
    columns: CompletionColumnMeta[],
    idents: ReadonlySet<string>,
): CompletionColumnMeta[] => {
    let index = sharedColumnsByIdentCache.get(columns);
    if (!index) {
        index = new Map<string, CompletionColumnMeta[]>();
        columns.forEach((column) => {
            const tableLower = String(column.tableName || '').toLowerCase();
            const fullLower = `${String(column.dbName || '').toLowerCase()}.${tableLower}`;
            const pureLower = String(splitCompletionSchemaAndTable(column.tableName || '', column.dbName).table || '').toLowerCase();
            new Set([fullLower, tableLower, pureLower]).forEach((key) => {
                if (!key) {
                    return;
                }
                const list = index!.get(key);
                if (list) {
                    list.push(column);
                } else {
                    index!.set(key, [column]);
                }
            });
        });
        sharedColumnsByIdentCache.set(columns, index);
    }
    const seen = new Set<CompletionColumnMeta>();
    const result: CompletionColumnMeta[] = [];
    idents.forEach((ident) => {
        (index!.get(ident) || []).forEach((column) => {
            if (seen.has(column)) {
                return;
            }
            seen.add(column);
            result.push(column);
        });
    });
    return result;
};
let sharedVisibleDbs: string[] = [];
let sharedViewsData: CompletionViewMeta[] = [];
let sharedMaterializedViewsData: CompletionViewMeta[] = [];
let sharedSynonymsData: CompletionSynonymMeta[] = [];
let sharedTriggersData: CompletionTriggerMeta[] = [];
let sharedRoutinesData: CompletionRoutineMeta[] = [];
let sharedSequencesData: CompletionSequenceMeta[] = [];
let sharedPackagesData: CompletionPackageMeta[] = [];
let sharedColumnsCacheData: Record<string, any[]> = {};
let sharedActiveEditorModelUri = '';
const sharedLazyTablesCache: Record<string, CompletionTableMeta[] | undefined> = {};
const sharedLazyTablesInFlight: Record<string, Promise<CompletionTableMeta[]> | undefined> = {};
const createSqlCompletionResult = (suggestions: any[], retriggerOnContinue = false) => ({
    suggestions,
    // Monaco otherwise keeps filtering a cached list locally. Re-run strict
    // object-name contexts as the prefix grows, and re-run any full 200-item
    // window so omitted candidates can enter the next result.
    incomplete: suggestions.length > 0
        && (retriggerOnContinue || suggestions.length >= QUERY_EDITOR_COMPLETION_SUGGESTION_LIMIT),
});
const createEmptySqlCompletionResult = () => createSqlCompletionResult([]);
const isSqlCompletionRequestCancelled = (token?: { isCancellationRequested?: boolean } | null) =>
    Boolean(token?.isCancellationRequested);
const clearRecord = (record: Record<string, unknown>) => {
    Object.keys(record).forEach((key) => {
        delete record[key];
    });
};
const QUERY_EDITOR_SQL_SNIPPET_SUGGEST_DETAIL_MIN_HEIGHT = 260;
const QUERY_EDITOR_TABLE_NAVIGATION_VALIDATION_TIMEOUT_MS = 5_000;

type QueryEditorMetadataRequestSnapshot = {
    generation: number;
    connectionId: string;
    connectionConfig: unknown;
};

const buildQueryEditorTableMetadataKey = (connectionId: string, dbName: string): string => (
    `${String(connectionId || '').trim()}\u0000${String(dbName || '').trim()}`
);

const buildQueryEditorTableTargetKey = (
    connectionId: string,
    dbName: string,
    tableName: string,
): string => (
    `${buildQueryEditorTableMetadataKey(connectionId, dbName)}\u0000${normalizeCompletionQualifiedName(tableName)}`
);

const isSharedQueryEditorMetadataRequestCurrent = (
    snapshot: QueryEditorMetadataRequestSnapshot,
    contextKey: string,
): boolean => (
    snapshot.generation === sharedQueryEditorMetadataGeneration
    && contextKey === sharedQueryEditorMetadataContextKey
    && snapshot.connectionId === sharedCurrentConnectionId
    && sharedConnections.find((connection) => connection.id === snapshot.connectionId)?.config === snapshot.connectionConfig
);

const isExactQueryEditorTableName = (left: string, right: string): boolean => {
    const normalizedLeft = normalizeCompletionQualifiedName(left);
    const normalizedRight = normalizeCompletionQualifiedName(right);
    return Boolean(normalizedLeft && normalizedLeft === normalizedRight);
};

const getCompletionTableNameFromRow = (row: any): string => (
    normalizeCommentText(extractTableNameFromMetadataRow(row))
);

const getCompletionTableCommentFromRow = (row: any): string => (
    normalizeCommentText(getCaseInsensitiveValue(row, [
        'table_comment',
        'TABLE_COMMENT',
        'comment',
        'comments',
        'Comment',
        'COMMENTS',
        'description',
        'Description',
    ]))
);

const getCompletionTableComment = (
    tableComments: Map<string, string>,
    tableName: string,
    rowComment = '',
): string => {
    const parsed = splitCompletionSchemaAndTable(String(tableName || ''));
    return tableComments.get(String(tableName || '').toLowerCase())
        || (parsed.table ? tableComments.get(parsed.table.toLowerCase()) : '')
        || normalizeCommentText(rowComment);
};

const buildCompletionTableMeta = (
    dbName: string,
    row: any,
    tableComments: Map<string, string>,
): CompletionTableMeta | null => {
    const tableName = getCompletionTableNameFromRow(row);
    if (!tableName) return null;
    return {
        dbName,
        tableName,
        comment: getCompletionTableComment(tableComments, tableName, getCompletionTableCommentFromRow(row)) || undefined,
    };
};

const fetchCompletionTableCommentMap = async (
    config: any,
    dbName: string,
    metadataDialect: string,
): Promise<Map<string, string>> => {
    const tableComments = new Map<string, string>();
    const tableCommentSQL = buildCompletionTableCommentSQL(metadataDialect, dbName);
    if (!tableCommentSQL) return tableComments;

    try {
        const resTableComments = await DBQuery(buildRpcConnectionConfig(config) as any, dbName, tableCommentSQL);
        if (resTableComments.success && Array.isArray(resTableComments.data)) {
            resTableComments.data.forEach((row: any) => {
                const tableName = normalizeCommentText(getCaseInsensitiveValue(row, ['table_name', 'TABLE_NAME', 'name', 'Name']));
                if (!tableName) return;
                tableComments.set(tableName.toLowerCase(), getCompletionTableCommentFromRow(row));
            });
        }
    } catch {
        // 表备注只是补全增强，失败时保留原有表名补全。
    }
    return tableComments;
};

const buildSqlSnippetVariableMap = (now: Date): Record<string, string> => {
    const pad = (value: number) => String(value).padStart(2, '0');
    return {
        CURRENT_YEAR: String(now.getFullYear()),
        CURRENT_MONTH: pad(now.getMonth() + 1),
        CURRENT_DATE: pad(now.getDate()),
        CURRENT_HOUR: pad(now.getHours()),
        CURRENT_MINUTE: pad(now.getMinutes()),
        CURRENT_SECOND: pad(now.getSeconds()),
        CURRENT_SECONDS_UNIX: String(Math.floor(now.getTime() / 1000)),
        UUID: uuidv4(),
        RANDOM: String(Math.floor(100000 + Math.random() * 900000)),
    };
};

const materializeSqlSnippetText = (body: string): string => {
    const tabstopValues = new Map<string, string>();
    const variableMap = buildSqlSnippetVariableMap(new Date());
    return String(body || '')
        .replace(/\$\{(\d+)\|([^}]+)\|\}/g, (_match, index: string, rawChoices: string) => {
            const choice = String(rawChoices || '')
                .split(',')
                .map((item) => item.trim())
                .find(Boolean) || '';
            if (index !== '0') {
                tabstopValues.set(index, choice);
            }
            return choice;
        })
        .replace(/\$\{([A-Z_]+)\}/g, (match, variableName: string) => (
            Object.prototype.hasOwnProperty.call(variableMap, variableName)
                ? variableMap[variableName]
                : match
        ))
        .replace(/\$\{(\d+):([^}]+)\}/g, (_match, index: string, placeholder: string) => {
            const value = String(placeholder || '');
            if (index !== '0') {
                tabstopValues.set(index, value);
            }
            return value;
        })
        .replace(/\$(\d+)/g, (_match, index: string) => (
            index === '0' ? '' : (tabstopValues.get(index) ?? '')
        ));
};

const resetSharedQueryEditorMetadata = () => {
    sharedQueryEditorMetadataGeneration += 1;
    sharedQueryEditorMetadataContextKey = '';
    sharedQueryEditorMetadataConnectionConfig = null;
    sharedCurrentDb = '';
    sharedCurrentSchema = '';
    sharedTablesData = [];
    sharedAllColumnsData = [];
    sharedVisibleDbs = [];
    sharedViewsData = [];
    sharedMaterializedViewsData = [];
    sharedSynonymsData = [];
    sharedTriggersData = [];
    sharedRoutinesData = [];
    sharedSequencesData = [];
    sharedPackagesData = [];
    sharedColumnsCacheData = {};
    sharedActiveEditorModelUri = '';
    clearRecord(sharedLazyTablesCache);
    clearRecord(sharedLazyTablesInFlight);
};

const parseQueryResultSortInfo = (field: string, order: string): GridSortInfoItem[] => {
  let candidates: unknown[] = [];
  try {
    const parsed = JSON.parse(field);
    if (Array.isArray(parsed)) candidates = parsed;
  } catch {
    // Compatibility with the legacy single-column callback shape.
  }
  if (candidates.length === 0) {
    candidates = [{ columnKey: field, order, enabled: true }];
  }

  const normalized: GridSortInfoItem[] = [];
  const seen = new Set<string>();
  candidates.forEach((candidate) => {
    if (!candidate || typeof candidate !== 'object') return;
    const item = candidate as Record<string, unknown>;
    const columnKey = String(item.columnKey || '').trim();
    const normalizedOrder = item.order === 'ascend' || item.order === 'descend'
      ? item.order
      : '';
    const dedupeKey = columnKey.toLowerCase();
    if (!columnKey || !normalizedOrder || seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    normalized.push({
      columnKey,
      order: normalizedOrder,
      enabled: item.enabled !== false,
    });
  });
  return normalized;
};

const compareQueryResultValues = (left: unknown, right: unknown): number => {
  if (Object.is(left, right)) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    return left < right ? -1 : 1;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    if (Number.isNaN(left)) return Number.isNaN(right) ? 0 : -1;
    if (Number.isNaN(right)) return 1;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right);
  }
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
};

const compareQueryResultOriginalOrder = (
  left: Record<string, unknown>,
  right: Record<string, unknown>,
  leftIndex: number,
  rightIndex: number,
): number => {
  const leftKey = left?.[GONAVI_ROW_KEY];
  const rightKey = right?.[GONAVI_ROW_KEY];
  const leftNumber = Number(leftKey);
  const rightNumber = Number(rightKey);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  const keyOrder = String(leftKey ?? '').localeCompare(String(rightKey ?? ''), undefined, { numeric: true });
  return keyOrder || leftIndex - rightIndex;
};

const sortCompleteQueryResultRows = (
  rows: any[],
  sortInfo: GridSortInfoItem[],
): any[] => {
  const activeSortInfo = sortInfo.filter((item) => item.enabled !== false);
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      for (const item of activeSortInfo) {
        const valueOrder = compareQueryResultValues(
          left.row?.[item.columnKey],
          right.row?.[item.columnKey],
        );
        if (valueOrder !== 0) {
          return item.order === 'descend' ? -valueOrder : valueOrder;
        }
      }
      return compareQueryResultOriginalOrder(left.row, right.row, left.index, right.index);
    })
    .map(({ row }) => row);
};

type QueryEditorBulkCloseMode = 'other' | 'left' | 'right' | 'all';

export const filterQueryEditorResultSetsForBulkClose = (
    resultSets: QueryEditorResultSet[],
    key: string,
    mode: QueryEditorBulkCloseMode,
): QueryEditorResultSet[] => {
    const targetIndex = resultSets.findIndex((result) => result.key === key);
    if (mode !== 'all' && targetIndex < 0) return resultSets;
    return resultSets.filter((result, index) => {
        if (result.pinned) return true;
        if (mode === 'all') return false;
        if (mode === 'other') return result.key === key;
        if (mode === 'left') return index >= targetIndex;
        return index <= targetIndex;
    });
};

const QueryEditor: React.FC<{ tab: TabData; isActive?: boolean }> = ({ tab, isActive = true }) => {
  const appearance = useStore(state => state.appearance);
  const queryOptions = useStore(state => state.queryOptions);
  const setQueryOptions = useStore(state => state.setQueryOptions);
  const wordWrapEnabled = queryOptions?.wordWrap === true;
  const [query, setQuery] = useState(() => {
      const initialConnection = useStore.getState().connections.find((connection) => connection.id === tab.connectionId);
      return getInitialEditorQuery(
          tab,
          isElasticsearchConnection(initialConnection?.config)
              ? ''
              : resolveNewQueryDefaultTemplate(appearance.newQuerySqlTemplate),
      );
  });
  const isExternalSQLFileTab = Boolean(String(tab.filePath || '').trim());
  const isObjectEditQueryTab = tab.type === 'query' && tab.queryMode === 'object-edit';
  const queryEditorMonacoOptions = useMemo(
      () => buildQueryEditorMonacoOptions(
          isObjectEditQueryTab,
          wordWrapEnabled,
          appearance.uiVersion !== 'v2',
      ),
      [appearance.uiVersion, isObjectEditQueryTab, wordWrapEnabled],
  );
  
  type ResultSet = QueryEditorResultSet;

  // Result Sets (session cache survives detach/attach remounts)
  const restoredResultSessionRef = useRef(takeQueryEditorResultSession(tab.id));
  const [resultSets, setResultSets] = useState<ResultSet[]>(
    () => restoredResultSessionRef.current?.resultSets || [],
  );
  const [activeResultKey, setActiveResultKey] = useState<string>(
    () => restoredResultSessionRef.current?.activeResultKey || '',
  );
  const [resultDataPreviewRequest, setResultDataPreviewRequest] = useState<{
      resultKey: string;
      requestId: string;
  } | null>(null);
  const resultSetsRef = useRef(resultSets);
  const activeResultKeyRef = useRef(activeResultKey);
  const nativeRestoredResultRefs = useRef(new Map<
    string,
    { resultKey: string; result: ResultSet }
  >());
  resultSetsRef.current = resultSets;
  activeResultKeyRef.current = activeResultKey;
  const [loading, setLoading] = useState(false);
  const [queryContextLockRunSeq, setQueryContextLockRunSeq] = useState(0);
  const queryContextLockRunSeqRef = useRef(0);
  const lockQueryContextForRun = useCallback((runSeq: number) => {
      queryContextLockRunSeqRef.current = runSeq;
      setQueryContextLockRunSeq(runSeq);
  }, []);
  const unlockQueryContextForRun = useCallback((runSeq: number) => {
      if (queryContextLockRunSeqRef.current !== runSeq) return;
      queryContextLockRunSeqRef.current = 0;
      setQueryContextLockRunSeq(0);
  }, []);
  const [executionRunToken, setExecutionRunToken] = useState(0);
  const executionElapsedMs = useQueryExecutionElapsed(loading, executionRunToken);
  const executionElapsedText = formatQueryExecutionElapsed(executionElapsedMs);
  const executionElapsedLabel = translate('query_editor.execution.elapsed', {
      duration: executionElapsedText,
  });
  const executionSpeedIcon = resolveQueryExecutionSpeedIcon(executionElapsedMs);
  const [executionError, setExecutionError] = useState<string>('');
  const [, setCurrentQueryId] = useState<string>('');
  const [isSqlSnippetPickerOpen, setIsSqlSnippetPickerOpen] = useState(false);
  const [sqlSnippetPickerKeyword, setSqlSnippetPickerKeyword] = useState('');
  const runSeqRef = useRef(0);
  const currentQueryIdRef = useRef('');
  const resultTotalCountSeqRef = useRef(0);
  const resultTotalCountRequestsRef = useRef<Record<string, { sequence: number; queryId: string }>>({});
  const [isSaveModalOpen, setIsSaveModalOpen] = useState(false);
  const [saveModalMode, setSaveModalMode] = useState<'save' | 'saveAs' | 'rename'>('save');
  const [saveForm] = Form.useForm();
  const saveQueryNameInputRef = useRef<InputRef>(null);

  // Database Selection
  const [currentConnectionId, setCurrentConnectionId] = useState<string>(tab.connectionId);
  const [currentDb, setCurrentDb] = useState<string>(tab.dbName || '');
  const [currentSchema, setCurrentSchema] = useState<string>(String(tab.schemaName || '').trim());
  const [schemaList, setSchemaList] = useState<string[]>([]);
  const [schemaLoading, setSchemaLoadingState] = useState(false);
  const schemaLoadingRef = useRef(false);
  const setSchemaLoading = useCallback((nextLoading: boolean) => {
      schemaLoadingRef.current = nextLoading;
      setSchemaLoadingState(nextLoading);
  }, []);
  const resultTotalCountContextRef = useRef(
      `${tab.connectionId}\u0000${tab.dbName || ''}\u0000${tab.schemaName || ''}`,
  );
  const [dbList, setDbList] = useState<string[]>([]);
  const [isTextToSqlModalOpen, setIsTextToSqlModalOpen] = useState(false);
  const [textToSqlInstruction, setTextToSqlInstruction] = useState('');
  const [textToSqlApplyMode, setTextToSqlApplyMode] = useState<QueryEditorAiApplyMode>('insert');
  const [textToSqlGenerating, setTextToSqlGenerating] = useState(false);
  const [resultDiffWizardOpen, setResultDiffWizardOpen] = useState(false);
  const [resultDiffAnchorKey, setResultDiffAnchorKey] = useState<string>('');
  const [resultDiffSession, setResultDiffSession] = useState<{
    jobId: string;
    summary: ResultDiffSummary;
    leftLabel: string;
    rightLabel: string;
    columnMeta?: Record<string, ResultDiffColumnMeta>;
  } | null>(null);
  const [viewDataVerifyOpen, setViewDataVerifyOpen] = useState(false);

  // Resizing state
  const [editorHeight, setEditorHeight] = useState(300);
  const editorStageRef = useRef<HTMLDivElement | null>(null);
  const editorShellRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const handleRunRef = useRef<(() => Promise<void>) | null>(null);
  const pendingRunAfterSchemaLoadRef = useRef(false);
  const deferredContextRunSeqRef = useRef(0);
  const runQueryActionRef = useRef<any>(null);
  const selectCurrentStatementActionRef = useRef<any>(null);
  const macFindWithSelectionGuardActionRef = useRef<any>(null);
  const duplicateCurrentLineActionRef = useRef<any>(null);
  const saveQueryActionRef = useRef<any>(null);
  const saveQueryAsActionRef = useRef<any>(null);
  const findInEditorActionRef = useRef<any>(null);
  const formatSqlActionRef = useRef<any>(null);
  const triggerSqlAiCompletionActionRef = useRef<any>(null);
  const triggerSqlAiCompletionKeydownDisposableRef = useRef<any>(null);
  const acceptSqlAiCompletionKeydownDisposableRef = useRef<any>(null);
  const insertSqlSnippetActionRef = useRef<any>(null);
  const transformCaseActionDisposablesRef = useRef<any[]>([]);
  const aiContextMenuActionDisposablesRef = useRef<any[]>([]);
  const toggleQueryResultsPanelActionRef = useRef<any>(null);
  const lastExternalQueryRef = useRef<string>(getTabQueryValue(tab));
  const lastLocalQueryRef = useRef<string>(query);
  const saveOperationQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const queryEditorMountedRef = useRef(true);
  const imeCompositionFallbackRef = useRef<{
      editor: any;
      valueBefore: string;
      selectionBefore: any;
      positionBefore: { lineNumber: number; column: number } | null;
      committedText: string;
  } | null>(null);
  const imeCompositionFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEditorCursorPositionRef = useRef<any>(null);
  const lastHoverTargetPositionRef = useRef<{ lineNumber: number; column: number } | null>(null);
  const lastExecutedEditorQueryRef = useRef<string>('');
  const linkDecorationIdsRef = useRef<string[]>([]);
  const ctrlMetaPressedRef = useRef(false);
  const objectDecorationIdsRef = useRef<string[]>([]);
  const sqlFieldDropDecorationIdsRef = useRef<string[]>([]);
  const aiInlineGhostDecorationIdsRef = useRef<string[]>([]);
  const aiInlineGhostOverlayRef = useRef<HTMLSpanElement | null>(null);
  const aiInlineGhostVisibleContextKeyRef = useRef<any>(null);
  const aiInlineGhostTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiInlineGhostRequestSeqRef = useRef(0);
  const triggerAiInlineCompletionRef = useRef<(() => void) | null>(null);
  const acceptAiInlineCompletionRef = useRef<(() => boolean) | null>(null);
  const acceptSqlAiCompletionBindingRef = useRef<{ combo: string; enabled: boolean }>({ combo: '', enabled: false });
  const queryEditorActiveRef = useRef(false);
  const aiContextMetadataWarmupRef = useRef<Record<string, Promise<boolean> | undefined>>({});
  const incompleteColumnMetadataDbsRef = useRef<Set<string>>(new Set());
  const aiContextCacheRef = useRef<{ deps: unknown[]; value: QueryEditorAiContext } | null>(null);
  const triggerSqlAiCompletionAltPressedRef = useRef(false);
  const triggerSqlAiCompletionAltGestureAtRef = useRef(0);
  const triggerSqlAiCompletionFallbackRef = useRef<{ observedAt: number } | null>(null);
  const triggerSqlAiCompletionFallbackApplyingRef = useRef(false);
  const aiInlineGhostRef = useRef<{
      insertText: string;
      editText: string;
      replacePrefixLength: number;
      modelUri: string;
      position: { lineNumber: number; column: number };
      snapshot: QueryEditorAiEditorSnapshot;
  } | null>(null);
  const aiInlineGhostAcceptingRef = useRef(false);
  const objectHoverActionRef = useRef<any>(null);
  const dragRef = useRef<{ startY: number, startHeight: number, currentHeight: number } | null>(null);
  const pendingEditorHeightRef = useRef(editorHeight);
  const resizeFrameRef = useRef<number | null>(null);
  const queryEditorRootRef = useRef<HTMLDivElement | null>(null);
  const editorPaneRef = useRef<HTMLDivElement | null>(null);
  const tablesRef = useRef<CompletionTableMeta[]>([]); // Store tables for autocomplete (cross-db)
  const metadataGenerationRef = useRef(0);
  const missingTableMetadataKeysRef = useRef<Set<string>>(new Set());
  const tableNavigationValidationInFlightRef = useRef<
      Record<string, Promise<boolean | null> | undefined>
  >({});
  const tableNavigationActionInFlightRef = useRef<Record<string, Promise<void> | undefined>>({});
  const allColumnsRef = useRef<CompletionColumnMeta[]>([]); // Store all columns (cross-db)
  const viewsRef = useRef<CompletionViewMeta[]>([]);
  const materializedViewsRef = useRef<CompletionViewMeta[]>([]);
  const synonymsRef = useRef<CompletionSynonymMeta[]>([]);
  const triggersRef = useRef<CompletionTriggerMeta[]>([]);
  const routinesRef = useRef<CompletionRoutineMeta[]>([]);
  const sequencesRef = useRef<CompletionSequenceMeta[]>([]);
  const packagesRef = useRef<CompletionPackageMeta[]>([]);
  const visibleDbsRef = useRef<string[]>([]); // Store visible databases for cross-db intellisense
  const metadataFetchKeyRef = useRef<string>('');
  const metadataContextKeyRef = useRef<string>('');
  const metadataContextConnectionConfigRef = useRef<unknown>(undefined);
  /** SQL 中引用到的库集合变化时触发跨库元数据补拉（供超链接/补全） */
  const [sqlReferencedMetadataKey, setSqlReferencedMetadataKey] = useState('');
  const sqlReferencedMetadataTimerRef = useRef<number | null>(null);
  const lastSqlReferencedMetadataKeyRef = useRef('');

  const connections = useStore(state => state.connections);
  const currentConnection = connections.find(
      (connection) => connection.id === currentConnectionId,
  );
  const currentConnectionConfig = currentConnection?.config ?? null;
  const canSelectQuerySchema = !isObjectEditQueryTab && supportsQueryEditorSchemaSelection(
      String(currentConnectionConfig?.type || ''),
  );
  const metadataRenderContextRef = useRef<{ key: string; connectionConfig: unknown }>({
      key: '',
      connectionConfig: null,
  });
  const metadataRenderContextKey = `${isActive ? 'active' : 'inactive'}\u0000${tab.id}\u0000${currentConnectionId}\u0000${currentDb}`;
  if (
      metadataRenderContextRef.current.key !== metadataRenderContextKey
      || metadataRenderContextRef.current.connectionConfig !== currentConnectionConfig
  ) {
      metadataGenerationRef.current += 1;
      metadataRenderContextRef.current = {
          key: metadataRenderContextKey,
          connectionConfig: currentConnectionConfig,
      };
  }
  const queryCapableConnections = useMemo(
      () => connections.filter(c => getDataSourceCapabilities(c.config).supportsQueryEditor),
      [connections]
  );
  const currentConnectionCapabilities = useMemo(
      () => getDataSourceCapabilities(
          connections.find(connection => connection.id === currentConnectionId)?.config,
      ),
      [connections, currentConnectionId],
  );
  const isElasticsearchMode = useMemo(
      () => isElasticsearchConnection(
          connections.find(connection => connection.id === currentConnectionId)?.config,
      ),
      [connections, currentConnectionId],
  );
  const [elasticsearchServerMajor, setElasticsearchServerMajor] = useState(0);
  useEffect(() => {
      setElasticsearchServerMajor(0);
  }, [currentConnectionId]);
  useEffect(() => {
      if (!isElasticsearchMode) return;
      const conn = connections.find((connection) => connection.id === currentConnectionId);
      if (!conn) return;
      let cancelled = false;
      const config = buildRpcConnectionConfig({
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || '',
          database: conn.config.database || '',
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
      }) as any;
      void InspectElasticsearchConsole(config, '', 'GET /')
          .then((inspection: any) => {
              const major = Number(inspection?.serverMajor || 0);
              if (!cancelled && major > 0) {
                  setElasticsearchServerMajor(major);
              }
          })
          .catch(() => {
              // Execution preflight will surface connection and policy errors.
          });
      return () => {
          cancelled = true;
      };
  }, [connections, currentConnectionId, isElasticsearchMode]);
  const queryEditorMonacoLanguage = useMemo(
      () => resolveQueryEditorMonacoLanguage(
          connections.find(connection => connection.id === currentConnectionId),
      ),
      [connections, currentConnectionId],
  );
  useEffect(() => {
      const model = editorRef.current?.getModel?.();
      if (model && monacoRef.current?.editor?.setModelLanguage) {
          monacoRef.current.editor.setModelLanguage(model, queryEditorMonacoLanguage);
      }
  }, [queryEditorMonacoLanguage]);

  const addSqlLog = useStore(state => state.addSqlLog);
  const sqlLogs = useStore(state => (isActive ? state.sqlLogs : EMPTY_QUERY_EDITOR_SQL_LOGS));
  const sqlLogCount = sqlLogs.length;
  const addTab = useStore(state => state.addTab);
  const setActiveContext = useStore(state => state.setActiveContext);
  const updateQueryTabDraft = useStore(state => state.updateQueryTabDraft);
  const activeTabId = useStore(state => state.activeTabId);
  const savedQueries = useStore(state => state.savedQueries);
  const sqlSnippets = useStore(state => state.sqlSnippets);
  const currentConnectionIdRef = useRef(currentConnectionId);
  const currentDbRef = useRef(currentDb);
  const currentSchemaRef = useRef(currentSchema);
  const latestSelectedSchemaRef = useRef('');
  const schemaLoadSeqRef = useRef(0);
  const schemaContextKeyRef = useRef('');
  const tableNavigationContextRef = useRef<{ key: string; connectionConfig: unknown; version: number }>({
      key: '',
      connectionConfig: null,
      version: 0,
  });
  const tableNavigationContextKey = `${isActive ? 'active' : 'inactive'}\u0000${tab.id}\u0000${currentConnectionId}\u0000${currentDb}`;
  if (
      tableNavigationContextRef.current.key !== tableNavigationContextKey
      || tableNavigationContextRef.current.connectionConfig !== currentConnectionConfig
  ) {
      tableNavigationContextRef.current = {
          key: tableNavigationContextKey,
          connectionConfig: currentConnectionConfig,
          version: tableNavigationContextRef.current.version + 1,
      };
  }
  const inlineSqlMemoryEntries = useMemo(() => buildQueryEditorInlineMemoryEntries({
      currentConnectionId,
      currentDb,
      savedQueries,
      sqlLogs,
  }), [currentConnectionId, currentDb, savedQueries, sqlLogs]);
  const draftSnapshotTab = useMemo(() => ({
      id: tab.id,
      title: tab.title,
      connectionId: tab.connectionId,
      dbName: tab.dbName,
      filePath: tab.filePath,
      savedQueryId: tab.savedQueryId,
      readOnly: tab.readOnly,
  }), [tab.connectionId, tab.dbName, tab.filePath, tab.id, tab.readOnly, tab.savedQueryId, tab.title]);
  const connectionsRef = useRef(connections);
  const isQueryEditorMetadataRequestCurrent = useCallback((
      snapshot: QueryEditorMetadataRequestSnapshot,
  ): boolean => (
      queryEditorMountedRef.current
      && queryEditorActiveRef.current
      && metadataGenerationRef.current === snapshot.generation
      && String(currentConnectionIdRef.current || '').trim() === snapshot.connectionId
      && connectionsRef.current.find((connection) => connection.id === snapshot.connectionId)?.config === snapshot.connectionConfig
  ), []);
  const columnsCacheRef = useRef<Record<string, ColumnDefinition[]>>({});
  const saveQuery = useStore(state => state.saveQuery);
  const theme = useStore(state => state.theme);
  const languagePreference = useStore((state) => state.languagePreference);
  void languagePreference;
  const darkMode = theme === 'dark';
  const isV2Ui = appearance.uiVersion === 'v2';
  const sqlFormatOptions = useStore(state => state.sqlFormatOptions);
  const setSqlFormatOptions = useStore(state => state.setSqlFormatOptions);
  const queryEditorEditorHeightRatio = sanitizeQueryEditorEditorHeightRatio(
      queryOptions?.queryEditorEditorHeightRatio,
  );
  const sqlEditorTransactionOptions = useStore(state => state.sqlEditorTransactionOptions);
  const setSqlEditorTransactionOptions = useStore(state => state.setSqlEditorTransactionOptions);
  const [isResultPanelVisible, setIsResultPanelVisible] = useState(
      () => restoredResultSessionRef.current?.isResultPanelVisible
          ?? (tab.resultPanelVisible === true)
  );
  const isResultPanelVisibleRef = useRef(isResultPanelVisible);
  isResultPanelVisibleRef.current = isResultPanelVisible;
  const publishesDetachedResultSession = useMemo(() => isNativeDetachedWindow(), []);

  useEffect(() => {
      const captureSession = (event: Event) => {
          const requestedTabId = String((event as CustomEvent).detail?.tabId || '').trim();
          if (requestedTabId !== tab.id) return;
          saveQueryEditorResultSession(tab.id, {
              resultSets: resultSetsRef.current,
              activeResultKey: activeResultKeyRef.current,
              isResultPanelVisible: isResultPanelVisibleRef.current,
          });
      };
      window.addEventListener('gonavi:capture-query-result-session', captureSession);
      return () => {
          window.removeEventListener('gonavi:capture-query-result-session', captureSession);
      };
  }, [tab.id]);

  useEffect(() => {
      // Keep result panel state across detach/attach remounts of the same tab.
      return () => {
          saveQueryEditorResultSession(tab.id, {
              resultSets: resultSetsRef.current,
              activeResultKey: activeResultKeyRef.current,
              isResultPanelVisible: isResultPanelVisibleRef.current,
          });
      };
  }, [tab.id]);

  useEffect(() => {
      if (!publishesDetachedResultSession) return;
      saveQueryEditorResultSession(tab.id, {
          resultSets,
          activeResultKey,
          isResultPanelVisible,
      });
  }, [activeResultKey, isResultPanelVisible, publishesDetachedResultSession, resultSets, tab.id]);
  const shortcutOptions = useStore(state => state.shortcutOptions);
  const activeShortcutPlatform = getShortcutPlatform(isMacLikePlatform());
  const runQueryShortcutBinding = useMemo(
      () => resolveShortcutBinding(shortcutOptions, 'runQuery', activeShortcutPlatform),
      [activeShortcutPlatform, shortcutOptions],
  );
  // SQL 诊断 / 慢 SQL 历史的快捷键绑定（从 store 读取，用户可在快捷键管理面板自定义）
  const diagnoseQueryShortcutBinding = useMemo(
      () => resolveShortcutBinding(shortcutOptions, 'diagnoseQuery', activeShortcutPlatform),
      [activeShortcutPlatform, shortcutOptions],
  );
  const showSlowQueriesShortcutBinding = useMemo(
      () => resolveShortcutBinding(shortcutOptions, 'showSlowQueries', activeShortcutPlatform),
      [activeShortcutPlatform, shortcutOptions],
  );
  const sortedSqlSnippets = useMemo(
      () => [...sqlSnippets].sort((left, right) => (
          left.prefix.localeCompare(right.prefix) || left.name.localeCompare(right.name)
      )),
      [sqlSnippets],
  );
  const filteredSqlSnippets = useMemo(() => {
      const keyword = String(sqlSnippetPickerKeyword || '').trim().toLowerCase();
      if (!keyword) {
          return sortedSqlSnippets;
      }
      return sortedSqlSnippets.filter((snippet) => (
          [
              snippet.prefix,
              snippet.name,
              snippet.description,
              snippet.syntaxHelp,
              snippet.body,
          ].some((field) => String(field || '').toLowerCase().includes(keyword))
      ));
  }, [sortedSqlSnippets, sqlSnippetPickerKeyword]);
  const sqlSnippetPickerEmptyLabel = useMemo(
      () => (
          String(sqlSnippetPickerKeyword || '').trim()
              ? translate('query_editor.snippet_picker.empty_filtered')
              : translate('query_editor.snippet_picker.empty')
      ),
      [sqlSnippetPickerKeyword],
  );

  const openSqlAnalysisWorkbench = useCallback(
      (view: 'diagnose' | 'slow-query', nextSql?: string) => {
          const connectionId = String(currentConnectionId || '').trim();
          if (!connectionId) {
              message.warning(translate('query_editor.message.connection_not_found'));
              return;
          }
          if (view === 'diagnose' && !currentConnectionCapabilities.supportsExplainDiagnosis) {
              message.warning(translate('sql_analysis.slow_query.unsupported_diagnosis' as any));
              return;
          }
          const dbName = String(currentDb || tab.dbName || '').trim();
          addTab(buildSqlAnalysisWorkbenchTab({
              connectionId,
              dbName: dbName || undefined,
              query: typeof nextSql === 'string' && nextSql.trim() ? nextSql : undefined,
              view,
          }));
      },
      [addTab, currentConnectionCapabilities.supportsExplainDiagnosis, currentConnectionId, currentDb, tab.dbName],
  );

  const openQueryHistoryWorkbench = useCallback(() => {
      addTab(buildQueryHistoryWorkbenchTab({
          connectionId: String(currentConnectionId || '').trim(),
          dbName: String(currentDb || tab.dbName || '').trim(),
      }));
  }, [addTab, currentConnectionId, currentDb, tab.dbName]);

  const handleCloseSqlSnippetPicker = useCallback(() => {
      setIsSqlSnippetPickerOpen(false);
      setSqlSnippetPickerKeyword('');
  }, []);

  const handleOpenSqlSnippetPicker = useCallback(() => {
      setSqlSnippetPickerKeyword('');
      setIsSqlSnippetPickerOpen(true);
  }, []);

  const handleOpenSnippetSettingsFromPicker = useCallback(() => {
      handleCloseSqlSnippetPicker();
      window.dispatchEvent(new CustomEvent('gonavi:open-snippet-settings'));
  }, [handleCloseSqlSnippetPicker]);

  const registerInsertSqlSnippetContextMenuAction = useCallback((editor: any) => {
      if (insertSqlSnippetActionRef.current) {
          insertSqlSnippetActionRef.current.dispose();
          insertSqlSnippetActionRef.current = null;
      }
      if (!editor || isElasticsearchMode) {
          return;
      }

      insertSqlSnippetActionRef.current = editor.addAction({
          id: 'gonavi.insertSqlSnippet',
          label: translate('query_editor.action.insert_sql_snippet'),
          contextMenuGroupId: '8_snippet',
          contextMenuOrder: 1,
          run: handleOpenSqlSnippetPicker,
      });
  }, [handleOpenSqlSnippetPicker, isElasticsearchMode]);

  const disposeTransformCaseContextMenuActions = useCallback(() => {
      transformCaseActionDisposablesRef.current.forEach((disposable) => disposable?.dispose?.());
      transformCaseActionDisposablesRef.current = [];
  }, []);

  const registerTransformCaseContextMenuActions = useCallback((editor: any) => {
      disposeTransformCaseContextMenuActions();
      transformCaseActionDisposablesRef.current = [
          {
              id: 'gonavi.queryEditor.transformToUppercase',
              label: translate('query_editor.completion.action.uppercase'),
              actionId: 'editor.action.transformToUppercase',
              contextMenuOrder: 1,
          },
          {
              id: 'gonavi.queryEditor.transformToLowercase',
              label: translate('query_editor.completion.action.lowercase'),
              actionId: 'editor.action.transformToLowercase',
              contextMenuOrder: 2,
          },
      ].map((action) => editor.addAction({
          id: action.id,
          label: action.label,
          precondition: '!editorReadonly',
          contextMenuGroupId: '1_modification',
          contextMenuOrder: action.contextMenuOrder,
          run: (ed: any) => ed.getAction?.(action.actionId)?.run?.(),
      }));
  }, [disposeTransformCaseContextMenuActions]);

  // SQL 诊断 / 慢 SQL 历史的快捷键监听（必须在 binding 声明之后）
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: KeyboardEvent) => {
      if (diagnoseQueryShortcutBinding?.enabled && isShortcutMatch(e, diagnoseQueryShortcutBinding.combo)) {
        e.preventDefault();
        openSqlAnalysisWorkbench('diagnose', getCurrentQuery());
        return;
      }
      if (showSlowQueriesShortcutBinding?.enabled && isShortcutMatch(e, showSlowQueriesShortcutBinding.combo)) {
        e.preventDefault();
        openSqlAnalysisWorkbench('slow-query');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [diagnoseQueryShortcutBinding, isActive, openSqlAnalysisWorkbench, showSlowQueriesShortcutBinding]);
  const selectCurrentStatementShortcutBinding = useMemo(
      () => resolveShortcutBinding(shortcutOptions, 'selectCurrentStatement', activeShortcutPlatform),
      [activeShortcutPlatform, shortcutOptions],
  );
  const duplicateCurrentLineShortcutBinding = useMemo(
      () => resolveShortcutBinding(shortcutOptions, 'duplicateCurrentLine', activeShortcutPlatform),
      [activeShortcutPlatform, shortcutOptions],
  );
  const saveQueryShortcutBinding = useMemo(
      () => resolveShortcutBinding(shortcutOptions, 'saveQuery', activeShortcutPlatform),
      [activeShortcutPlatform, shortcutOptions],
  );
  const saveQueryAsShortcutBinding = useMemo(
      () => resolveShortcutBinding(shortcutOptions, 'saveQueryAs', activeShortcutPlatform),
      [activeShortcutPlatform, shortcutOptions],
  );
  const formatSqlShortcutBinding = useMemo(
      () => resolveShortcutBinding(shortcutOptions, 'formatSql', activeShortcutPlatform),
      [activeShortcutPlatform, shortcutOptions],
  );
  const triggerSqlAiCompletionShortcutBinding = useMemo(
      () => resolveShortcutBinding(shortcutOptions, 'triggerSqlAiCompletion', activeShortcutPlatform),
      [activeShortcutPlatform, shortcutOptions],
  );
  const acceptSqlAiCompletionShortcutBinding = useMemo(
      () => resolveShortcutBinding(shortcutOptions, 'acceptSqlAiCompletion', activeShortcutPlatform),
      [activeShortcutPlatform, shortcutOptions],
  );
  // 渲染期同步最新绑定/激活态,keydown 监听从 ref 读取,editor 重建或改绑均无需重注册。
  acceptSqlAiCompletionBindingRef.current = acceptSqlAiCompletionShortcutBinding;
  queryEditorActiveRef.current = isActive;
  const toggleQueryResultsPanelShortcutBinding = useMemo(
      () => resolveShortcutBinding(shortcutOptions, 'toggleQueryResultsPanel', activeShortcutPlatform),
      [activeShortcutPlatform, shortcutOptions],
  );
  const findInEditorShortcutCombo = useMemo(
      () => activeShortcutPlatform === 'mac' ? 'Meta+F' : 'Ctrl+F',
      [activeShortcutPlatform],
  );
  const primaryShortcutModifierLabel = useMemo(
      () => getShortcutPrimaryModifierDisplayLabel(activeShortcutPlatform),
      [activeShortcutPlatform],
  );
  const isTriggerSqlAiCompletionShortcutEvent = useCallback((event: any): boolean => {
      const binding = triggerSqlAiCompletionShortcutBinding;
      if (!binding?.enabled || !binding.combo) {
          return false;
      }
      if (isShortcutMatch(event, binding.combo)) {
          return true;
      }
      if (normalizeShortcutCombo(binding.combo) !== 'Alt+\\') {
          return false;
      }

      const key = String(
          event?.key
          || event?.nativeEvent?.key
          || event?.browserEvent?.key
          || '',
      ).trim();
      const code = String(
          event?.code
          || event?.nativeEvent?.code
          || event?.browserEvent?.code
          || '',
      ).trim();
      const keyCode = Number(
          event?.keyCode
          ?? event?.which
          ?? event?.nativeEvent?.keyCode
          ?? event?.nativeEvent?.which
          ?? event?.browserEvent?.keyCode
          ?? event?.browserEvent?.which
          ?? 0,
      );
      const isBackslashKey = key === '\\'
          || code === 'Backslash'
          || code === 'IntlBackslash'
          || keyCode === 220
          || keyCode === 226;
      return isBackslashKey && triggerSqlAiCompletionAltPressedRef.current;
  }, [triggerSqlAiCompletionShortcutBinding]);
  const isPossibleTriggerSqlAiCompletionFallbackEvent = useCallback((event: any): boolean => {
      const binding = triggerSqlAiCompletionShortcutBinding;
      if (!binding?.enabled || normalizeShortcutCombo(binding.combo) !== 'Alt+\\') {
          return false;
      }

      const key = String(
          event?.key
          || event?.nativeEvent?.key
          || event?.browserEvent?.key
          || '',
      ).trim();
      const code = String(
          event?.code
          || event?.nativeEvent?.code
          || event?.browserEvent?.code
          || '',
      ).trim();
      const keyCode = Number(
          event?.keyCode
          ?? event?.which
          ?? event?.nativeEvent?.keyCode
          ?? event?.nativeEvent?.which
          ?? event?.browserEvent?.keyCode
          ?? event?.browserEvent?.which
          ?? 0,
      );
      const isLikelyBackslashKey = key === '\\'
          || key === 'Process'
          || code === 'Backslash'
          || code === 'IntlBackslash'
          || keyCode === 220
          || keyCode === 226;
      const hasAltIntent = Boolean(
          event?.altKey
          || event?.nativeEvent?.altKey
          || event?.browserEvent?.altKey
          || triggerSqlAiCompletionAltPressedRef.current
      );
      return isLikelyBackslashKey && hasAltIntent;
  }, [triggerSqlAiCompletionShortcutBinding]);
  const registerTriggerSqlAiCompletionAction = useCallback((editor: any, monaco: any) => {
      if (triggerSqlAiCompletionActionRef.current) {
          triggerSqlAiCompletionActionRef.current.dispose();
          triggerSqlAiCompletionActionRef.current = null;
      }
      if (!editor || !monaco || isElasticsearchMode) {
          return;
      }

      const binding = triggerSqlAiCompletionShortcutBinding;
      const keyBinding = binding?.enabled && binding.combo
          ? comboToMonacoKeyBinding(binding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform)
          : null;
      triggerSqlAiCompletionActionRef.current = editor.addAction({
          id: 'gonavi.triggerSqlAiCompletion',
          label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.triggerSqlAiCompletion.label'),
          keybindings: keyBinding ? [keyBinding.keyMod | keyBinding.keyCode] : [],
          contextMenuGroupId: '7_ai',
          contextMenuOrder: 0,
          run: () => {
              triggerAiInlineCompletionRef.current?.();
          },
      });
  }, [activeShortcutPlatform, isElasticsearchMode, triggerSqlAiCompletionShortcutBinding]);
  useEffect(() => {
      // Prefer remount session cache (detach/attach); otherwise follow tab draft flag.
      if (restoredResultSessionRef.current && restoredResultSessionRef.current.isResultPanelVisible !== undefined) {
          const restoredVisible = restoredResultSessionRef.current.isResultPanelVisible === true;
          isResultPanelVisibleRef.current = restoredVisible;
          setIsResultPanelVisible(restoredVisible);
          return;
      }
      const restoredVisible = tab.resultPanelVisible === true;
      isResultPanelVisibleRef.current = restoredVisible;
      setIsResultPanelVisible(restoredVisible);
  }, [tab.id, tab.resultPanelVisible]);
  const updateResultPanelVisibility = useCallback((visible: boolean) => {
      isResultPanelVisibleRef.current = visible;
      setIsResultPanelVisible(visible);
      updateQueryTabDraft(tab.id, { resultPanelVisible: visible });
  }, [tab.id, updateQueryTabDraft]);
  const toggleResultPanelVisibility = useCallback(() => {
      const nextVisible = !isResultPanelVisibleRef.current;
      isResultPanelVisibleRef.current = nextVisible;
      setIsResultPanelVisible(nextVisible);
      updateQueryTabDraft(tab.id, { resultPanelVisible: nextVisible });
  }, [tab.id, updateQueryTabDraft]);
  const handleOpenEditorFind = useCallback(() => {
      const editor = editorRef.current;
      if (!editor) {
          return;
      }

      editor.focus?.();
      try {
          const findAction = editor.getAction?.('actions.find');
          if (findAction?.run) {
              void findAction.run();
              return;
          }
      } catch {
          // Fall back to Monaco's built-in command id if the action lookup fails.
      }

      editor.trigger?.('keyboard', 'actions.find', null);
  }, []);
  const handleShowSqlExecutionLog = useCallback((mode: 'open' | 'toggle' = 'toggle') => {
      if (!isActive) {
          return;
      }
      if (mode !== 'open' && isResultPanelVisible && activeResultKey === QUERY_EDITOR_SQL_LOG_TAB_KEY) {
          updateResultPanelVisibility(false);
          return;
      }
      updateResultPanelVisibility(true);
      setActiveResultKey(QUERY_EDITOR_SQL_LOG_TAB_KEY);
  }, [activeResultKey, isActive, isResultPanelVisible, updateResultPanelVisibility]);
  const sqlEditorCommitMode = sqlEditorTransactionOptions?.commitMode === 'auto' ? 'auto' : 'manual';
  const sqlEditorAutoCommitDelayMs = SQL_EDITOR_AUTO_COMMIT_DELAY_OPTIONS.some((item) => item.value === sqlEditorTransactionOptions?.autoCommitDelayMs)
      ? Number(sqlEditorTransactionOptions?.autoCommitDelayMs)
      : 0;
  const {
      activatePendingSqlTransaction,
      appendPendingSqlTransactionExecution,
      autoCommitRemainingSeconds: sqlEditorAutoCommitRemainingSeconds,
      finishPendingSqlTransaction,
      pendingSqlTransaction,
      pendingSqlTransactionRef,
  } = useSqlEditorTransactionController({
      tabId: tab.id,
      translate: (key, params) => translate(key, params),
  });
  const handleFinishPendingSqlTransaction = useCallback(async (action: 'commit' | 'rollback') => {
      await finishPendingSqlTransaction(action, 'manual');
      handleShowSqlExecutionLog('open');
  }, [finishPendingSqlTransaction, handleShowSqlExecutionLog]);
  const autoFetchVisible = useAutoFetchVisibility();

  const resetMetadataForContext = useCallback((
      connectionId: string,
      dbName: string,
      connectionConfig: unknown,
  ) => {
      const nextContextKey = [
          String(connectionId || '').trim(),
          String(dbName || '').trim().toLowerCase(),
      ].join('\u0000');
      if (
          metadataContextKeyRef.current === nextContextKey
          && metadataContextConnectionConfigRef.current === connectionConfig
      ) {
          return false;
      }
      metadataContextKeyRef.current = nextContextKey;
      metadataContextConnectionConfigRef.current = connectionConfig;
      metadataFetchKeyRef.current = '';
      aiContextMetadataWarmupRef.current = {};
      aiContextCacheRef.current = null;
      incompleteColumnMetadataDbsRef.current.clear();
      missingTableMetadataKeysRef.current.clear();
      tablesRef.current = [];
      allColumnsRef.current = [];
      viewsRef.current = [];
      materializedViewsRef.current = [];
      synonymsRef.current = [];
      triggersRef.current = [];
      routinesRef.current = [];
      sequencesRef.current = [];
      packagesRef.current = [];
      columnsCacheRef.current = {};
      if (isActive) {
          resetSharedQueryEditorMetadata();
      }
      return true;
  }, [isActive]);

  const resetQuerySchemaContext = useCallback((
      nextConnectionId: string,
      nextDbName: string,
  ) => {
      currentSchemaRef.current = '';
      latestSelectedSchemaRef.current = '';
      schemaContextKeyRef.current = '';
      schemaLoadSeqRef.current += 1;
      setCurrentSchema('');
      setSchemaList([]);

      const targetConnection = connections.find((item) => item.id === nextConnectionId);
      const shouldLoadSchema = !isObjectEditQueryTab
          && Boolean(String(nextDbName || '').trim())
          && supportsQueryEditorSchemaSelection(String(targetConnection?.config?.type || ''));
      setSchemaLoading(shouldLoadSchema);
  }, [connections, isObjectEditQueryTab, setSchemaLoading]);

  const switchQueryContext = useCallback((
      nextConnectionId: string,
      nextDbName: string,
      options: { persist?: boolean; silentPending?: boolean } = {},
  ): boolean => {
      const normalizedConnectionId = String(nextConnectionId || '').trim();
      const normalizedDbName = String(nextDbName || '').trim();
      const contextChanged = normalizedConnectionId !== String(currentConnectionIdRef.current || '').trim()
          || normalizedDbName !== String(currentDbRef.current || '').trim();
      if (!contextChanged) return true;
      if (queryContextLockRunSeqRef.current !== 0) {
          if (!options.silentPending) {
              void message.info(translate('common.loading'));
          }
          return false;
      }
      if (pendingSqlTransactionRef.current) {
          if (!options.silentPending) {
              void message.warning(translate('query_editor.transaction.message.pending_managed_transaction'));
          }
          return false;
      }

      deferredContextRunSeqRef.current += 1;
      pendingRunAfterSchemaLoadRef.current = false;
      currentConnectionIdRef.current = normalizedConnectionId;
      currentDbRef.current = normalizedDbName;
      setCurrentConnectionId(normalizedConnectionId);
      setCurrentDb(normalizedDbName);
      resetQuerySchemaContext(normalizedConnectionId, normalizedDbName);

      const targetConnectionConfig = connections.find(
          (connection) => connection.id === normalizedConnectionId,
      )?.config ?? null;
      if (isActive) {
          const metadataContextChanged = resetMetadataForContext(
              normalizedConnectionId,
              normalizedDbName,
              targetConnectionConfig,
          );
          const nextSharedMetadataContextKey = `${tab.id}\u0000${normalizedConnectionId}\u0000${normalizedDbName}`;
          if (
              !metadataContextChanged
              && (
                  sharedQueryEditorMetadataContextKey !== nextSharedMetadataContextKey
                  || sharedQueryEditorMetadataConnectionConfig !== targetConnectionConfig
              )
          ) {
              resetSharedQueryEditorMetadata();
          }
          sharedQueryEditorMetadataContextKey = nextSharedMetadataContextKey;
          sharedQueryEditorMetadataConnectionConfig = targetConnectionConfig;
          sharedCurrentDb = normalizedDbName;
          sharedCurrentConnectionId = normalizedConnectionId;
          sharedCurrentSchema = '';
          sharedConnections = connections;
          sharedVisibleDbs = visibleDbsRef.current;
          sharedActiveEditorModelUri = String(editorRef.current?.getModel?.()?.uri?.toString?.() || '');
      }
      if (isActive && normalizedConnectionId) {
          setActiveContext({ connectionId: normalizedConnectionId, dbName: normalizedDbName });
      }
      if (options.persist !== false) {
          updateQueryTabDraft(tab.id, {
              connectionId: normalizedConnectionId,
              dbName: normalizedDbName,
              schemaName: '',
          });
      }
      return true;
  }, [
      connections,
      isActive,
      pendingSqlTransactionRef,
      resetMetadataForContext,
      resetQuerySchemaContext,
      setActiveContext,
      tab.id,
      updateQueryTabDraft,
  ]);

  useEffect(() => {
      resetMetadataForContext(currentConnectionId, currentDb, currentConnectionConfig);
  }, [currentConnectionConfig, currentConnectionId, currentDb, resetMetadataForContext]);

  const currentSavedQuery = useMemo(() => {
      const savedId = String(tab.savedQueryId || '').trim();
      if (savedId) {
          return savedQueries.find((item) => item.id === savedId) || null;
      }
      const tabId = String(tab.id || '').trim();
      if (!tabId) {
          return null;
      }
      return savedQueries.find((item) => item.id === tabId) || null;
  }, [savedQueries, tab.id, tab.savedQueryId]);

  useEffect(() => {
      queryEditorMountedRef.current = true;
      return () => {
          queryEditorMountedRef.current = false;
      };
  }, []);

  const runQueuedSaveOperation = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
      const queued = saveOperationQueueRef.current.then(operation, operation);
      saveOperationQueueRef.current = queued.then(
          () => undefined,
          () => undefined,
      );
      return queued;
  }, []);

  const syncQueryDraft = useCallback((nextQuery: string) => {
      const next = String(nextQuery ?? '');
      lastLocalQueryRef.current = next;
      persistQueryTabDraftSnapshot(draftSnapshotTab, next, {
          connectionId: currentConnectionIdRef.current,
          dbName: currentDbRef.current,
      });
  }, [draftSnapshotTab]);

  const applyQueryState = useCallback((nextQuery: string) => {
      const next = String(nextQuery ?? '');
      syncQueryDraft(next);
      if (!isExternalSQLFileTab || next.length <= QUERY_EDITOR_PERSISTED_DRAFT_MAX_TEXT_LENGTH) {
          setQuery(next);
      }
  }, [isExternalSQLFileTab, syncQueryDraft]);

  const handleInsertSqlSnippet = useCallback((snippet: SqlSnippet) => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor) {
          return;
      }

      const snippetController = editor.getContribution?.('snippetController2');
      if (snippetController && typeof snippetController.insert === 'function') {
          editor.focus?.();
          snippetController.insert(snippet.body);
          const nextValue = editor.getValue?.();
          if (typeof nextValue === 'string') {
              applyQueryState(nextValue);
          }
          handleCloseSqlSnippetPicker();
          editor.focus?.();
          return;
      }

      const model = editor.getModel?.();
      if (!model || !monaco?.Range) {
          return;
      }

      const selection = editor.getSelection?.();
      const position = editor.getPosition?.()
          || { lineNumber: model.getLineCount?.() || 1, column: model.getLineMaxColumn?.(model.getLineCount?.() || 1) || 1 };
      const hasSelection = selection
          && (
              selection.startLineNumber !== selection.endLineNumber
              || selection.startColumn !== selection.endColumn
          );
      const range = hasSelection
          ? selection
          : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
      const startOffset = model.getOffsetAt?.({
          lineNumber: range.startLineNumber,
          column: range.startColumn,
      });
      const plainText = materializeSqlSnippetText(snippet.body);

      editor.pushUndoStop?.();
      editor.executeEdits?.('gonavi-insert-sql-snippet', [{
          range,
          text: plainText,
          forceMoveMarkers: true,
      }]);
      editor.pushUndoStop?.();

      if (Number.isFinite(Number(startOffset)) && typeof model.getPositionAt === 'function') {
          const nextPosition = model.getPositionAt(Number(startOffset) + plainText.length);
          editor.setPosition?.(nextPosition);
          editor.setSelection?.(new monaco.Range(
              nextPosition.lineNumber,
              nextPosition.column,
              nextPosition.lineNumber,
              nextPosition.column,
          ));
      }

      const nextValue = editor.getValue?.();
      if (typeof nextValue === 'string') {
          applyQueryState(nextValue);
      }
      handleCloseSqlSnippetPicker();
      editor.focus?.();
  }, [applyQueryState, handleCloseSqlSnippetPicker]);

  useEffect(() => {
      const latestQuery = lastLocalQueryRef.current;
      const latestConnectionId = currentConnectionIdRef.current || currentConnectionId;
      const latestDbName = currentDbRef.current || currentDb;
      const matchesSavedQuery = currentSavedQuery
          && latestQuery === String(currentSavedQuery.sql ?? '')
          && String(latestConnectionId || '').trim() === String(currentSavedQuery.connectionId || '').trim()
          && String(latestDbName || '').trim() === String(currentSavedQuery.dbName || '').trim();
      if (matchesSavedQuery) {
          clearQueryTabDraft(tab.id);
          return;
      }
      persistQueryTabDraftSnapshot(draftSnapshotTab, latestQuery, {
          connectionId: latestConnectionId,
          dbName: latestDbName,
      });
  }, [currentConnectionId, currentDb, currentSavedQuery, draftSnapshotTab, query, tab.id]);

  useEffect(() => {
      currentConnectionIdRef.current = currentConnectionId;
  }, [currentConnectionId]);

  useEffect(() => {
      if (shouldKeepRestoredQueryUnbound(tab, currentConnectionId)) {
          return;
      }
      if (!queryCapableConnections.some(c => c.id === currentConnectionId)) {
          const fallback = queryCapableConnections[0]?.id || '';
          if (fallback && fallback !== currentConnectionId) {
              void switchQueryContext(fallback, '', { silentPending: true });
          }
      }
  }, [currentConnectionId, pendingSqlTransaction?.id, queryCapableConnections, queryContextLockRunSeq, switchQueryContext, tab.preserveUnboundConnection]);

  useEffect(() => {
      currentDbRef.current = currentDb;
  }, [currentDb]);

  useEffect(() => {
      currentSchemaRef.current = currentSchema;
  }, [currentSchema]);

  useEffect(() => {
      const nextConnectionId = String(tab.connectionId || '').trim();
      const nextDb = String(tab.dbName || '').trim();
      const nextSchema = String(tab.schemaName || '').trim();
      const contextChanged = nextConnectionId !== currentConnectionIdRef.current
          || nextDb !== currentDbRef.current;
      const schemaChanged = nextSchema !== currentSchemaRef.current;
      if (
          (queryContextLockRunSeqRef.current !== 0 || pendingSqlTransactionRef.current)
          && (contextChanged || schemaChanged)
      ) {
          return;
      }
      if (contextChanged && !switchQueryContext(nextConnectionId, nextDb, {
          persist: false,
          silentPending: true,
      })) {
          return;
      }
      if (nextSchema !== currentSchemaRef.current) {
          currentSchemaRef.current = nextSchema;
          if (!contextChanged) {
              latestSelectedSchemaRef.current = nextSchema;
          }
          setCurrentSchema(nextSchema);
          setSchemaList((current) => nextSchema && !current.includes(nextSchema)
              ? [nextSchema, ...current]
              : nextSchema ? current : []);
      }
  }, [
      pendingSqlTransaction?.id,
      pendingSqlTransactionRef,
      queryContextLockRunSeq,
      switchQueryContext,
      tab.connectionId,
      tab.dbName,
      tab.id,
      tab.schemaName,
  ]);

  useEffect(() => {
      if (isExternalSQLFileTab) return;
      const currentDraft = getQueryTabDraft(tab.id, query);
      const shouldPersistQuery = currentDraft.length <= QUERY_EDITOR_PERSISTED_DRAFT_MAX_TEXT_LENGTH;
      updateQueryTabDraft(tab.id, {
          ...(shouldPersistQuery ? { query: currentDraft } : {}),
          connectionId: currentConnectionId,
          dbName: currentDb,
      });
  }, [currentConnectionId, currentDb, isExternalSQLFileTab, query, tab.id, updateQueryTabDraft]);

  useEffect(() => {
      if (!isExternalSQLFileTab) return;
      updateQueryTabDraft(tab.id, {
          connectionId: currentConnectionId,
          dbName: currentDb,
      });
  }, [currentConnectionId, currentDb, isExternalSQLFileTab, tab.id, updateQueryTabDraft]);

  const getCurrentQuery = useCallback(() => {
      const val = editorRef.current?.getValue?.();
      if (typeof val === 'string') return val;
      return query || '';
  }, [query]);

  const buildQueryEditorAiEditorSnapshot = useCallback((): QueryEditorAiEditorSnapshot => {
      const editor = editorRef.current;
      const model = editor?.getModel?.();
      const position = normalizeEditorPosition(editor?.getPosition?.());
      const value = String(model?.getValue?.() ?? getCurrentQuery() ?? '');
      if (!model || !position || typeof model.getOffsetAt !== 'function') {
          return {
              prefix: value,
              suffix: '',
              currentLineBeforeCursor: value.split(/\r?\n/).pop() || '',
              currentLineAfterCursor: '',
          };
      }

      const offset = Number(model.getOffsetAt(position));
      const safeOffset = Number.isFinite(offset)
          ? Math.max(0, Math.min(offset, value.length))
          : value.length;
      const lineContent = String(model.getLineContent?.(position.lineNumber) || '');
      const lineColumnIndex = Math.max(0, Math.min(position.column - 1, lineContent.length));
      return {
          prefix: value.slice(0, safeOffset),
          suffix: value.slice(safeOffset),
          currentLineBeforeCursor: lineContent.slice(0, lineColumnIndex),
          currentLineAfterCursor: lineContent.slice(lineColumnIndex),
      };
  }, [getCurrentQuery]);

  const buildQueryEditorAiContext = useCallback((): QueryEditorAiContext => {
      const resolvedConnectionId = String(
          currentConnectionIdRef.current
          || currentConnectionId
          || tab.connectionId
          || '',
      ).trim();
      const conn = connectionsRef.current.find(c => c.id === resolvedConnectionId);
      const currentDbName = String(
          currentDbRef.current
          || currentDb
          || tab.dbName
          || '',
      ).trim();
      const lazyTablesEntry = sharedLazyTablesCache[`${resolvedConnectionId}|${currentDbName}`];

      // 大库下全量合并可达数十万条且每次补全请求都会调用；依赖引用未变时复用上次结果，
      // 同时保持 tables/columns 数组身份稳定，让下游按数组身份缓存的索引也能跨请求复用。
      const cacheDeps: unknown[] = [
          resolvedConnectionId,
          conn,
          currentDbName,
          lazyTablesEntry,
          sharedTablesData,
          tablesRef.current,
          sharedAllColumnsData,
          allColumnsRef.current,
          visibleDbsRef.current,
      ];
      const cached = aiContextCacheRef.current;
      if (cached && cached.deps.every((dep, index) => dep === cacheDeps[index])) {
          return cached.value;
      }

      const lazyTables = lazyTablesEntry || [];
      const mergedTablesByKey = new Map<string, CompletionTableMeta>();
      [...sharedTablesData, ...tablesRef.current, ...lazyTables].forEach((table) => {
          const tableKey = `${String(table?.dbName || '').trim().toLowerCase()}\u0000${String(table?.tableName || '').trim().toLowerCase()}`;
          if (!tableKey.trim()) {
              return;
          }
          mergedTablesByKey.set(tableKey, table);
      });
      const mergedColumnsByKey = new Map<string, CompletionColumnMeta>();
      [...sharedAllColumnsData, ...allColumnsRef.current].forEach((column) => {
          const columnKey = `${String(column?.dbName || '').trim().toLowerCase()}\u0000${String(column?.tableName || '').trim().toLowerCase()}\u0000${String(column?.name || '').trim().toLowerCase()}`;
          if (!columnKey.trim()) {
              return;
          }
          mergedColumnsByKey.set(columnKey, column);
      });
      const value: QueryEditorAiContext = {
          connectionName: conn?.name,
          host: resolveQueryEditorAiConnectionHost(conn),
          port: conn?.config?.port,
          sourceType: conn?.config?.type,
          currentDb: currentDbName,
          visibleDbs: visibleDbsRef.current,
          tables: [...mergedTablesByKey.values()],
          columns: [...mergedColumnsByKey.values()],
      };
      aiContextCacheRef.current = { deps: cacheDeps, value };
      return value;
  }, [currentConnectionId, currentDb, tab.connectionId, tab.dbName]);

  const ensureQueryEditorAiContextMetadata = useCallback(async (
      editorSnapshot: QueryEditorAiEditorSnapshot,
  ): Promise<void> => {
      const connectionId = String(
          currentConnectionIdRef.current
          || currentConnectionId
          || tab.connectionId
          || '',
      ).trim();
      const dbName = String(
          currentDbRef.current
          || currentDb
          || tab.dbName
          || '',
      ).trim();
      if (!connectionId || !dbName) {
          return;
      }

      const intent = resolveQueryEditorInlineCompletionIntentDetails(editorSnapshot);
      const normalizedDbName = dbName.toLowerCase();
      const needsTables = intent.intent === 'table_name'
          || !tablesRef.current.some((table) => String(table.dbName || '').trim().toLowerCase() === normalizedDbName);
      const hasColumnsForDatabase = allColumnsRef.current.some(
          (column) => String(column.dbName || '').trim().toLowerCase() === normalizedDbName,
      );
      const needsColumns = shouldRefreshQueryEditorCompletionColumns(
          intent.intent,
          hasColumnsForDatabase,
          incompleteColumnMetadataDbsRef.current.has(normalizedDbName),
      );
      if (!needsTables && !needsColumns) {
          return;
      }

      const metadataGeneration = metadataGenerationRef.current;
      const warmupKey = `${connectionId}\u0000${normalizedDbName}\u0000${needsTables ? 'tables' : ''}\u0000${needsColumns ? 'columns' : ''}\u0000${metadataGeneration}`;
      const existingWarmup = aiContextMetadataWarmupRef.current[warmupKey];
      if (existingWarmup) {
          await existingWarmup;
          return;
      }

      const warmupPromise = (async (): Promise<boolean> => {
          const conn = connectionsRef.current.find((item) => item.id === connectionId);
          if (!conn) {
              return false;
          }
          const metadataSnapshot: QueryEditorMetadataRequestSnapshot = {
              generation: metadataGeneration,
              connectionId,
              connectionConfig: conn.config,
          };
          const isCurrentMetadataRequest = () => (
              isQueryEditorMetadataRequestCurrent(metadataSnapshot)
          );
          let warmupSucceeded = true;

          const config = {
              ...conn.config,
              port: Number(conn.config.port),
              password: conn.config.password || '',
              database: conn.config.database || '',
              useSSH: conn.config.useSSH || false,
              ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
          };

          if (needsTables) {
              try {
                  if (!isCurrentMetadataRequest()) {
                      return false;
                  }
                  const metadataDialect = normalizeMetadataDialect(conn);
                  const [tableComments, resTables] = await Promise.all([
                      fetchCompletionTableCommentMap(config, dbName, metadataDialect).catch(() => new Map<string, string>()),
                      DBGetTables(buildRpcConnectionConfig(config) as any, dbName),
                  ]);
                  if (!isCurrentMetadataRequest()) {
                      return false;
                  }
                  if (!resTables?.success) {
                      warmupSucceeded = false;
                  }
                  if (resTables?.success && Array.isArray(resTables.data)) {
                      const fetchedTables = resTables.data
                          .map((row: any) => buildCompletionTableMeta(dbName, row, tableComments))
                          .filter((table): table is CompletionTableMeta => !!table);
                      if (fetchedTables.length > 0) {
                          const nextTableByKey = new Map(
                              tablesRef.current.map((table) => [
                                  `${String(table.dbName || '').trim().toLowerCase()}\u0000${String(table.tableName || '').trim().toLowerCase()}`,
                                  table,
                              ]),
                          );
                          fetchedTables.forEach((table) => {
                              nextTableByKey.set(
                                  `${String(table.dbName || '').trim().toLowerCase()}\u0000${String(table.tableName || '').trim().toLowerCase()}`,
                                  table,
                              );
                          });
                          tablesRef.current = [...nextTableByKey.values()];
                          sharedTablesData = tablesRef.current;
                          sharedLazyTablesCache[`${connectionId}|${dbName}`] = fetchedTables;
                      }
                  }
              } catch (error) {
                  warmupSucceeded = false;
                  console.warn('GoNavi AI inline table metadata warmup failed', error);
              }
          }

          if (needsColumns) {
              try {
                  if (!isCurrentMetadataRequest()) {
                      return false;
                  }
                  const resCols = await DBGetAllColumns(buildRpcConnectionConfig(config) as any, dbName);
                  if (!isCurrentMetadataRequest()) {
                      return false;
                  }
                  if (!resCols?.success) {
                      warmupSucceeded = false;
                  }
                  if (resCols?.success && Array.isArray(resCols.data)) {
                      const incomplete = isTableMetadataIncomplete(resCols);
                      if (incomplete) {
                          message.warning(getTableMetadataIssueDetail(resCols));
                          incompleteColumnMetadataDbsRef.current.add(normalizedDbName);
                          warmupSucceeded = false;
                      } else {
                          incompleteColumnMetadataDbsRef.current.delete(normalizedDbName);
                      }
                      const fetchedColumns = resCols.data.map((col: any) => ({
                          dbName,
                          tableName: col.tableName,
                          name: col.name,
                          type: col.type,
                          comment: normalizeCommentText(col.comment ?? col.Comment ?? col.COLUMN_COMMENT ?? col.column_comment ?? ''),
                      }));
                      if (fetchedColumns.length > 0) {
                          const nextColumnByKey = new Map(
                              allColumnsRef.current.map((column) => [
                                  `${String(column.dbName || '').trim().toLowerCase()}\u0000${String(column.tableName || '').trim().toLowerCase()}\u0000${String(column.name || '').trim().toLowerCase()}`,
                                  column,
                              ]),
                          );
                          fetchedColumns.forEach((column) => {
                              nextColumnByKey.set(
                                  `${String(column.dbName || '').trim().toLowerCase()}\u0000${String(column.tableName || '').trim().toLowerCase()}\u0000${String(column.name || '').trim().toLowerCase()}`,
                                  column,
                              );
                          });
                          allColumnsRef.current = [...nextColumnByKey.values()];
                          sharedAllColumnsData = allColumnsRef.current;
                      }
                  }
              } catch (error) {
                  warmupSucceeded = false;
                  console.warn('GoNavi AI inline column metadata warmup failed', error);
              }
          }
          return warmupSucceeded;
      })();

      // 成功的 warmup 结果整个会话内复用，避免每次内联补全都真实查库；失败时删除缓存以便重试。
      aiContextMetadataWarmupRef.current[warmupKey] = warmupPromise;
      let warmupSucceeded = false;
      try {
          warmupSucceeded = await warmupPromise;
      } finally {
          if (!warmupSucceeded) {
              delete aiContextMetadataWarmupRef.current[warmupKey];
          }
      }
  }, [currentConnectionId, currentDb, isQueryEditorMetadataRequestCurrent, tab.connectionId, tab.dbName]);

  useEffect(() => {
      if (!isExternalSQLFileTab) return;
      persistQueryTabDraftSnapshot(draftSnapshotTab, getCurrentQuery(), {
          connectionId: currentConnectionIdRef.current,
          dbName: currentDbRef.current,
      });
      return () => {
          const tabStillExists = useStore.getState().tabs.some((item) => item.id === draftSnapshotTab.id);
          if (tabStillExists) {
              persistQueryTabDraftSnapshot(draftSnapshotTab, getCurrentQuery(), {
                  connectionId: currentConnectionIdRef.current,
                  dbName: currentDbRef.current,
              });
          } else {
              clearQueryTabDraft(draftSnapshotTab.id);
          }
      };
  }, [draftSnapshotTab, getCurrentQuery, isExternalSQLFileTab]);

  // 当此 Tab 成为活跃 Tab 时，将本实例的状态同步到模块级共享变量
  // 确保 completion provider 始终使用当前活跃 Tab 的上下文
  useEffect(() => {
      if (!isActive) return;
      const activeConnectionConfig = connections.find(
          (connection) => connection.id === currentConnectionId,
      )?.config ?? null;
      const nextSharedMetadataContextKey = `${tab.id}\u0000${currentConnectionId}\u0000${currentDb}`;
      if (
          sharedQueryEditorMetadataContextKey !== nextSharedMetadataContextKey
          || sharedQueryEditorMetadataConnectionConfig !== activeConnectionConfig
      ) {
          sharedQueryEditorMetadataGeneration += 1;
          sharedQueryEditorMetadataContextKey = nextSharedMetadataContextKey;
          sharedQueryEditorMetadataConnectionConfig = activeConnectionConfig;
      }
      sharedCurrentDb = currentDb;
      sharedCurrentConnectionId = currentConnectionId;
      sharedCurrentSchema = currentSchema;
      sharedConnections = connections;
      sharedTablesData = tablesRef.current;
      sharedAllColumnsData = allColumnsRef.current;
      sharedVisibleDbs = visibleDbsRef.current;
      sharedViewsData = viewsRef.current;
      sharedMaterializedViewsData = materializedViewsRef.current;
      sharedSynonymsData = synonymsRef.current;
      sharedTriggersData = triggersRef.current;
      sharedRoutinesData = routinesRef.current;
      sharedSequencesData = sequencesRef.current;
      sharedPackagesData = packagesRef.current;
      sharedColumnsCacheData = columnsCacheRef.current;
      sharedActiveEditorModelUri = String(editorRef.current?.getModel?.()?.uri?.toString?.() || '');
  }, [isActive, currentDb, currentConnectionId, currentSchema, connections, tab.id]);

  useEffect(() => {
      connectionsRef.current = connections;
  }, [connections]);

  const handleDatabaseChange = useCallback((dbName: string) => {
      void switchQueryContext(currentConnectionIdRef.current, dbName);
  }, [switchQueryContext]);

  const refreshObjectDecorations = useCallback((maxTextLength = QUERY_EDITOR_OBJECT_DECORATION_MAX_TEXT_LENGTH) => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      const model = editor?.getModel?.();
      if (!editor || !monaco || !model) {
          return;
      }

      if (isObjectEditQueryTab) {
          objectDecorationIdsRef.current = editor.deltaDecorations(objectDecorationIdsRef.current, []);
          return;
      }

      const text = getQueryEditorDecorationModelTextIfLightweight(model, maxTextLength);
      if (text === null) {
          objectDecorationIdsRef.current = editor.deltaDecorations(objectDecorationIdsRef.current, []);
          return;
      }

      const decorations: any[] = [];
      const seen = new Set<string>();
      const candidates = collectQueryEditorObjectDecorationCandidates(text);
      const objectMetadataCount = tablesRef.current.length
          + viewsRef.current.length
          + materializedViewsRef.current.length
          + triggersRef.current.length
          + routinesRef.current.length
          + sequencesRef.current.length
          + packagesRef.current.length;
      if (objectMetadataCount > 5_000) {
          objectDecorationIdsRef.current = editor.deltaDecorations(objectDecorationIdsRef.current, []);
          return;
      }
      const decorationColumns = allColumnsRef.current.length <= 2_000
          ? allColumnsRef.current
          : [];

      for (const candidate of candidates) {
          const hoverTarget = resolveQueryEditorHoverTarget(
              text,
              candidate.lineContent,
              candidate.positionColumn,
              currentDbRef.current,
              visibleDbsRef.current,
              tablesRef.current,
              decorationColumns,
              viewsRef.current,
              materializedViewsRef.current,
              triggersRef.current,
              routinesRef.current,
              sequencesRef.current,
              packagesRef.current,
          );
          if (!hoverTarget) continue;

          const inlineClassName = hoverTarget.kind === 'column'
              ? 'gonavi-query-editor-column-token'
              : hoverTarget.kind === 'database'
                  ? 'gonavi-query-editor-db-token'
                  : 'gonavi-query-editor-object-token';
          const key = `${candidate.lineNumber}:${hoverTarget.range.startColumn}:${hoverTarget.range.endColumn}:${inlineClassName}`;
          if (seen.has(key)) continue;
          seen.add(key);
          decorations.push({
              range: new monaco.Range(
                  candidate.lineNumber,
                  hoverTarget.range.startColumn,
                  candidate.lineNumber,
                  hoverTarget.range.endColumn,
              ),
              options: { inlineClassName },
          });
      }

      objectDecorationIdsRef.current = editor.deltaDecorations(objectDecorationIdsRef.current, decorations);
  }, [isObjectEditQueryTab]);

  const validateTableNavigationTarget = useCallback(async (
      connectionId: string,
      dbName: string,
      targetTableName: string,
      contextVersion: number,
  ): Promise<boolean | null> => {
      const metadataKey = buildQueryEditorTableMetadataKey(connectionId, dbName);
      const normalizedTargetTableName = normalizeCompletionQualifiedName(targetTableName);
      if (!metadataKey || !normalizedTargetTableName) {
          return null;
      }

      const validationKey = `${metadataKey}\u0000${normalizedTargetTableName}\u0000${contextVersion}`;
      const pendingValidation = tableNavigationValidationInFlightRef.current[validationKey];
      if (pendingValidation) {
          return pendingValidation;
      }

      const conn = connectionsRef.current.find((item) => item.id === connectionId);
      if (!conn) {
          return null;
      }
      const connectionConfig = conn.config;
      const config = {
          ...connectionConfig,
          port: Number(connectionConfig.port),
          password: connectionConfig.password || '',
          database: connectionConfig.database || '',
          useSSH: connectionConfig.useSSH || false,
          ssh: connectionConfig.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
      };

      const validationPromise = (async (): Promise<boolean | null> => {
          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          try {
              const result = await Promise.race([
                  DBTableExists(
                      buildRpcConnectionConfig(config) as any,
                      dbName,
                      targetTableName,
                  ),
                  new Promise<null>((resolve) => {
                      timeoutId = globalThis.setTimeout(
                          () => resolve(null),
                          QUERY_EDITOR_TABLE_NAVIGATION_VALIDATION_TIMEOUT_MS,
                      );
                  }),
              ]);
              if (
                  !queryEditorMountedRef.current
                  || !queryEditorActiveRef.current
                  || String(currentConnectionIdRef.current || '').trim() !== connectionId
                  || connectionsRef.current.find((item) => item.id === connectionId)?.config !== connectionConfig
                  || tableNavigationContextRef.current.version !== contextVersion
              ) {
                  return null;
              }
              if (!result) {
                  return null;
              }
              const exists = (result?.data as { exists?: unknown } | null | undefined)?.exists;
              return result?.success && typeof exists === 'boolean' ? exists : null;
          } catch (error) {
              console.warn('GoNavi table navigation validation failed', error);
              return null;
          } finally {
              if (timeoutId !== undefined) {
                  globalThis.clearTimeout(timeoutId);
              }
              delete tableNavigationValidationInFlightRef.current[validationKey];
          }
      })();

      tableNavigationValidationInFlightRef.current[validationKey] = validationPromise;
      return validationPromise;
  }, []);

  const clearMissingTableNavigationMetadata = useCallback((
      connectionId: string,
      dbName: string,
      targetTableName: string,
  ) => {
      metadataGenerationRef.current += 1;
      sharedQueryEditorMetadataGeneration += 1;
      missingTableMetadataKeysRef.current.add(
          buildQueryEditorTableTargetKey(connectionId, dbName, targetTableName),
      );
      const normalizedDbName = String(dbName || '').trim();
      const isTargetTableName = (value: string): boolean => (
          isExactQueryEditorTableName(value, targetTableName)
      );
      tablesRef.current = tablesRef.current.filter((table) => (
          String(table.dbName || '').trim() !== normalizedDbName
          || !isTargetTableName(String(table.tableName || ''))
      ));
      allColumnsRef.current = allColumnsRef.current.filter((column) => (
          String(column.dbName || '').trim() !== normalizedDbName
          || !isTargetTableName(String(column.tableName || ''))
      ));
      Object.keys(columnsCacheRef.current).forEach((cacheKey) => {
          const [cachedConnectionId = '', cachedDbName = '', ...cachedTableParts] = cacheKey.split('|');
          if (
              cachedConnectionId === connectionId
              && cachedDbName === normalizedDbName
              && isTargetTableName(cachedTableParts.join('|'))
          ) {
              delete columnsCacheRef.current[cacheKey];
          }
      });
      const sharedTablesCacheKey = `${connectionId}|${dbName}`;
      sharedLazyTablesCache[sharedTablesCacheKey] = (sharedLazyTablesCache[sharedTablesCacheKey] || []).filter(
          (table) => !isTargetTableName(String(table.tableName || '')),
      );
      aiContextCacheRef.current = null;
      sharedTablesData = tablesRef.current;
      sharedAllColumnsData = allColumnsRef.current;
      sharedColumnsCacheData = columnsCacheRef.current;
      refreshObjectDecorations(QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH);
  }, [refreshObjectDecorations]);

  const showObjectInfoAtPosition = useCallback((position?: { lineNumber: number; column: number } | null) => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      const model = editor?.getModel?.();
      const normalizedPosition = normalizeEditorPosition(position || editor?.getPosition?.());
      if (!editor || !model || !normalizedPosition) {
          return false;
      }
      const lineContent = String(model.getLineContent?.(normalizedPosition.lineNumber) || '');
      const resolveText = getQueryEditorObjectResolveText(model, lineContent);
      const hoverTarget = resolveQueryEditorHoverTarget(
          resolveText,
          lineContent,
          normalizedPosition.column,
          currentDbRef.current,
          visibleDbsRef.current,
          tablesRef.current,
          allColumnsRef.current,
          viewsRef.current,
          materializedViewsRef.current,
          triggersRef.current,
          routinesRef.current,
          sequencesRef.current,
          packagesRef.current,
      );
      if (!hoverTarget) {
          return false;
      }
      editor.focus?.();
      const hoverRange = monaco
          ? new monaco.Range(
              normalizedPosition.lineNumber,
              hoverTarget.range.startColumn,
              normalizedPosition.lineNumber,
              hoverTarget.range.endColumn,
          )
          : {
              startLineNumber: normalizedPosition.lineNumber,
              startColumn: hoverTarget.range.startColumn,
              endLineNumber: normalizedPosition.lineNumber,
              endColumn: hoverTarget.range.endColumn,
          };
      const contentHoverController = editor.getContribution?.('editor.contrib.contentHover');
      if (contentHoverController?.showContentHover) {
          contentHoverController.showContentHover(hoverRange, 1, 2, false);
          return true;
      }
      editor.setPosition?.({
          lineNumber: normalizedPosition.lineNumber,
          column: hoverTarget.range.startColumn,
      });
      editor.trigger?.('gonavi-hover', 'editor.action.showHover', null);
      return true;
  }, []);

  const registerShowObjectInfoAction = useCallback(() => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) {
          return;
      }

      objectHoverActionRef.current?.dispose?.();
      const showObjectInfoKeybinding = monaco.KeyMod?.CtrlCmd && monaco.KeyCode?.KeyQ
          ? [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyQ]
          : undefined;
      objectHoverActionRef.current = editor.addAction({
          id: 'gonavi.queryEditor.showObjectInfo',
          label: buildQueryEditorMonacoActionLabel('query_editor.action.show_object_info'),
          keybindings: showObjectInfoKeybinding,
          run: () => {
              const preferredPosition = lastHoverTargetPositionRef.current || editor.getPosition?.();
              const shown = showObjectInfoAtPosition(preferredPosition);
              if (!shown) {
                  void message.info({
                      key: 'gonavi-query-editor-object-info-miss',
                      content: translate('query_editor.message.object_info_target_not_found'),
                  });
              }
          },
      });
  }, [showObjectInfoAtPosition]);

  useEffect(() => {
      refreshObjectDecorations(QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH);
  }, [currentDb, refreshObjectDecorations]);

  const insertTextIntoEditorAtPosition = useCallback((text: string, position?: { lineNumber: number; column: number } | null) => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      const targetPosition = normalizeEditorPosition(position || editor?.getPosition?.() || lastEditorCursorPositionRef.current);
      if (!editor || !monaco?.Range || !targetPosition || !text) {
          return false;
      }
      editor.focus?.();
      editor.setPosition?.(targetPosition);
      editor.executeEdits?.('gonavi-sidebar-drop', [{
          range: new monaco.Range(
              targetPosition.lineNumber,
              targetPosition.column,
              targetPosition.lineNumber,
              targetPosition.column,
          ),
          text,
          forceMoveMarkers: true,
      }]);
      editor.pushUndoStop?.();
      return true;
  }, []);

  const resolveSqlFieldDropPosition = useCallback((editor: any, event: DragEvent) => {
      const model = editor?.getModel?.();
      if (!editor || !model) return null;

      const monacoTarget = editor.getTargetAtClientPoint?.(event.clientX, event.clientY);
      // CONTENT_EMPTY 会把文字下方的鼠标位置钳制到行尾，必须保留横坐标重新投影。
      let position = Number(monacoTarget?.type) === 6
          ? normalizeEditorPosition(monacoTarget?.position)
          : null;
      if (!position) {
          const editorDomNode = editor.getDomNode?.() as HTMLElement | null;
          const bounds = editorDomNode?.getBoundingClientRect?.();
          const visibleRanges = editor.getVisibleRanges?.() || [];
          if (bounds && visibleRanges.length > 0) {
              const localX = event.clientX - bounds.left;
              const localY = event.clientY - bounds.top;
              const visibleLines: number[] = [];
              visibleRanges.forEach((range: any) => {
                  const startLine = Math.max(1, Number(range?.startLineNumber || 1));
                  const endLine = Math.max(startLine, Number(range?.endLineNumber || startLine));
                  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
                      if (!visibleLines.includes(lineNumber)) visibleLines.push(lineNumber);
                  }
              });
              const nonEmptyLines = visibleLines.filter((lineNumber) => (
                  String(model.getLineContent?.(lineNumber) || '').trim().length > 0
              ));
              const candidateLines = nonEmptyLines.length > 0 ? nonEmptyLines : visibleLines;
              let nearestLine = Number(candidateLines[0] || 1);
              let nearestLineDistance = Number.POSITIVE_INFINITY;
              candidateLines.forEach((lineNumber) => {
                  const visible = editor.getScrolledVisiblePosition?.({ lineNumber, column: 1 });
                  if (!visible) return;
                  const distance = Math.abs(localY - (visible.top + visible.height / 2));
                  if (distance < nearestLineDistance) {
                      nearestLine = lineNumber;
                      nearestLineDistance = distance;
                  }
              });

              const maxColumn = Math.max(1, Number(model.getLineMaxColumn?.(nearestLine) || 1));
              let low = 1;
              let high = maxColumn;
              while (low < high) {
                  const middle = Math.floor((low + high) / 2);
                  const visible = editor.getScrolledVisiblePosition?.({ lineNumber: nearestLine, column: middle });
                  if (!visible || visible.left < localX) low = middle + 1;
                  else high = middle;
              }
              const candidateColumns = [Math.max(1, low - 1), low, Math.min(maxColumn, low + 1)];
              const nearestColumn = candidateColumns.reduce((best, column) => {
                  const bestVisible = editor.getScrolledVisiblePosition?.({ lineNumber: nearestLine, column: best });
                  const candidateVisible = editor.getScrolledVisiblePosition?.({ lineNumber: nearestLine, column });
                  if (!candidateVisible) return best;
                  if (!bestVisible) return column;
                  return Math.abs(candidateVisible.left - localX) < Math.abs(bestVisible.left - localX)
                      ? column
                      : best;
              }, candidateColumns[0]);
              position = normalizeEditorPosition({ lineNumber: nearestLine, column: nearestColumn });
          }
      }
      position = position
          || normalizeEditorPosition(editor.getPosition?.())
          || normalizeEditorPosition(lastEditorCursorPositionRef.current);
      if (!position) return null;

      const rawOffset = Number(model.getOffsetAt?.(position));
      if (!Number.isFinite(rawOffset) || typeof model.getPositionAt !== 'function') return position;
      return normalizeEditorPosition(model.getPositionAt(
          resolveSqlFieldDropCursorOffset(String(model.getValue?.() || ''), rawOffset),
      )) || position;
  }, []);

  const clearSqlFieldDropPreview = useCallback((editor: any) => {
      if (!editor?.deltaDecorations) {
          sqlFieldDropDecorationIdsRef.current = [];
          return;
      }
      sqlFieldDropDecorationIdsRef.current = editor.deltaDecorations(
          sqlFieldDropDecorationIdsRef.current,
          [],
      );
  }, []);

  const updateSqlFieldDropPreview = useCallback((editor: any, position: any) => {
      const model = editor?.getModel?.();
      const monaco = monacoRef.current;
      const offset = Number(model?.getOffsetAt?.(position));
      const anchor = model && Number.isFinite(offset)
          ? resolveSqlFieldDropAnchorRange(String(model.getValue?.() || ''), offset)
          : null;
      if (!anchor || !monaco?.Range || typeof model?.getPositionAt !== 'function') {
          clearSqlFieldDropPreview(editor);
          return;
      }
      const start = model.getPositionAt(anchor.startOffset);
      const end = model.getPositionAt(anchor.endOffset);
      sqlFieldDropDecorationIdsRef.current = editor.deltaDecorations(
          sqlFieldDropDecorationIdsRef.current,
          [{
              range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
              options: { inlineClassName: 'gonavi-query-editor-field-drop-anchor' },
          }],
      );
  }, [clearSqlFieldDropPreview]);

  const mergeSidebarDropObjectMetadata = useCallback((payload: ReturnType<typeof decodeSidebarSqlEditorDragPayload>) => {
      if (!payload?.text || !payload.dbName) {
          return;
      }
      const nodeType = String(payload.nodeType || '').trim().toLowerCase();
      if (nodeType && nodeType !== 'table') {
          return;
      }
      const dbName = String(payload.dbName || '').trim();
      const tableName = normalizeCompletionQualifiedName(payload.text);
      if (!dbName || !tableName) {
          return;
      }
      const payloadConnectionId = String(
          payload.connectionId || currentConnectionIdRef.current || '',
      ).trim();
      if (missingTableMetadataKeysRef.current.has(
          buildQueryEditorTableTargetKey(payloadConnectionId, dbName, tableName),
      )) {
          return;
      }
      const visibleKey = dbName.toLowerCase();
      if (!visibleDbsRef.current.some((db) => String(db || '').toLowerCase() === visibleKey)) {
          visibleDbsRef.current = [...visibleDbsRef.current, dbName];
      }
      const tableKey = `${visibleKey}\u0000${tableName.toLowerCase()}`;
      if (!tablesRef.current.some((table) => `${String(table.dbName || '').toLowerCase()}\u0000${String(table.tableName || '').toLowerCase()}` === tableKey)) {
          tablesRef.current = [...tablesRef.current, { dbName, tableName }];
      }
      if (isActive) {
          sharedVisibleDbs = visibleDbsRef.current;
          sharedTablesData = tablesRef.current;
      }
  }, [isActive]);

  const handleSidebarObjectDrop = useCallback((event: DragEvent) => {
      if (!hasSidebarSqlEditorDragPayload(event.dataTransfer)) {
          return;
      }
      event.preventDefault();
      event.stopPropagation();
      const payload = decodeSidebarSqlEditorDragPayload(String(event.dataTransfer?.getData(SIDEBAR_SQL_EDITOR_DRAG_MIME) || ''));
      const dragText = readSidebarSqlDropText(event, currentConnectionIdRef.current, currentDbRef.current);
      if (!dragText) {
          return;
      }
      const editor = editorRef.current;
      clearSqlFieldDropPreview(editor);
      const payloadNodeType = String(payload?.nodeType || '').trim().toLowerCase();
      const targetPosition = payloadNodeType === 'column'
          ? resolveSqlFieldDropPosition(editor, event)
          : normalizeEditorPosition(editor?.getTargetAtClientPoint?.(event.clientX, event.clientY)?.position)
              || normalizeEditorPosition(editor?.getPosition?.())
              || normalizeEditorPosition(lastEditorCursorPositionRef.current);
      let inserted = false;
      if (payloadNodeType === 'column' && editor && targetPosition) {
          const model = editor.getModel?.();
          const monaco = monacoRef.current;
          const offset = Number(model?.getOffsetAt?.(targetPosition));
          const edit = model && monaco?.Range && typeof model.getPositionAt === 'function' && Number.isFinite(offset)
              ? buildSqlFieldDropEdit({ sql: String(model?.getValue?.() || ''), offset, fieldName: dragText })
              : null;
          if (edit) {
              const start = model.getPositionAt(edit.startOffset);
              const end = model.getPositionAt(edit.endOffset);
              editor.focus?.();
              editor.setPosition?.(targetPosition);
              editor.executeEdits?.('gonavi-result-field-drop', [{
                  range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
                  text: edit.text,
                  forceMoveMarkers: true,
              }]);
              editor.pushUndoStop?.();
              inserted = true;
          }
      } else {
          inserted = insertTextIntoEditorAtPosition(dragText, targetPosition);
      }
      if (inserted) {
          mergeSidebarDropObjectMetadata(payload);
          refreshObjectDecorations(QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH);
      }
  }, [clearSqlFieldDropPreview, insertTextIntoEditorAtPosition, mergeSidebarDropObjectMetadata, refreshObjectDecorations, resolveSqlFieldDropPosition]);

  const handleSelectCurrentStatement = async () => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      const model = editor?.getModel?.();
      if (!editor || !monaco?.Range || !model) {
          return;
      }

      const normalizedPosition = normalizeEditorPosition(editor.getPosition?.())
          || normalizeEditorPosition(lastEditorCursorPositionRef.current);
      if (!normalizedPosition) {
          return;
      }
      lastEditorCursorPositionRef.current = normalizedPosition;
      const lineNumber = normalizedPosition.lineNumber;
      const lineText = String(model.getLineContent?.(lineNumber) || '');
      if (!lineText.trim()) {
          void message.info(translate('query_editor.message.current_line_no_copyable_content'));
          return;
      }

      const maxColumn = Number(model.getLineMaxColumn?.(lineNumber) || 1);
      const selection = new monaco.Range(lineNumber, 1, lineNumber, maxColumn);
      editor.setPosition?.(normalizedPosition);
      editor.setSelection(selection);
      editor.revealRangeInCenterIfOutsideViewport?.(selection);

      const copied = await copyQueryEditorTextToClipboard(lineText);
      editor.setSelection(selection);
      editor.focus?.();
      if (copied) {
          void message.success(translate('data_grid.message.copied_to_clipboard'));
          return;
      }

      void message.error(translate('connection_modal.message.copy_failed'));
  };

  const handleDuplicateCurrentLine = () => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      const model = editor?.getModel?.();
      const normalizedPosition = normalizeEditorPosition(editor?.getPosition?.());
      if (!editor || !monaco?.Range || !model || !normalizedPosition) {
          return;
      }

      const lineNumber = normalizedPosition.lineNumber;
      const lineText = String(model.getLineContent?.(lineNumber) || '');
      const maxColumn = Number(model.getLineMaxColumn?.(lineNumber) || (lineText.length + 1));
      const modelValue = String(model.getValue?.() || '');
      const lineBreak = typeof model.getEOL?.() === 'string'
          ? model.getEOL()
          : (modelValue.includes('\r\n') ? '\r\n' : '\n');
      const insertRange = new monaco.Range(lineNumber, maxColumn, lineNumber, maxColumn);
      const nextColumn = Math.min(normalizedPosition.column, lineText.length + 1);

      editor.executeEdits?.('gonavi-duplicate-current-line', [{
          range: insertRange,
          text: `${lineBreak}${lineText}`,
          forceMoveMarkers: true,
      }]);
      editor.pushUndoStop?.();

      const nextPosition = { lineNumber: lineNumber + 1, column: nextColumn };
      const cursorSelection = new monaco.Range(
          nextPosition.lineNumber,
          nextPosition.column,
          nextPosition.lineNumber,
          nextPosition.column,
      );
      editor.setSelections?.([cursorSelection]);
      editor.setSelection?.(cursorSelection);
      editor.setPosition?.(nextPosition);
      editor.revealLineInCenterIfOutsideViewport?.(nextPosition.lineNumber);
      editor.focus?.();

      const nextValue = editor.getValue?.();
      if (typeof nextValue === 'string') {
          applyQueryState(nextValue);
      }
  };

  const buildQueryEditorAiContextMenuActions = useCallback(() => ([
      {
          id: 'ai.generateSQL',
          label: `AI ${translate('query_editor.action.ai_generate_sql_menu')}`,
          prompt: translate('query_editor.ai_prompt.generate'),
      },
      {
          id: 'ai.explainSQL',
          label: `AI ${translate('query_editor.action.ai_explain_sql_menu')}`,
          useSelection: true,
          prompt: translate('query_editor.ai_prompt.explain', { sql: QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER }),
      },
      {
          id: 'ai.optimizeSQL',
          label: `AI ${translate('query_editor.action.ai_optimize_sql_menu')}`,
          useSelection: true,
          prompt: translate('query_editor.ai_prompt.optimize', { sql: QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER }),
      },
  ]), []);

  const disposeQueryEditorAiContextMenuActions = useCallback(() => {
      aiContextMenuActionDisposablesRef.current.forEach((disposable) => disposable?.dispose?.());
      aiContextMenuActionDisposablesRef.current = [];
  }, []);

  const registerQueryEditorAiContextMenuActions = useCallback((editor: any) => {
      disposeQueryEditorAiContextMenuActions();
      if (isElasticsearchMode) {
          return;
      }
      aiContextMenuActionDisposablesRef.current = buildQueryEditorAiContextMenuActions().map((action) => (
          editor.addAction({
              id: action.id,
              label: action.label,
              contextMenuGroupId: '9_ai',
              contextMenuOrder: 1,
              run: (ed: any) => {
                  const selection = ed.getModel()?.getValueInRange(ed.getSelection());
                  const conn = connectionsRef.current.find(c => c.id === currentConnectionIdRef.current);
                  const ctxText = buildQueryEditorAiContextPrompt(conn, currentDbRef.current);
                  let prompt = ctxText + action.prompt;
                  if (action.useSelection && selection) {
                      prompt = prompt.replace(QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER, selection);
                  }
                  const store = useStore.getState();
                  if (!store.aiPanelVisible) {
                      store.setAIPanelVisible(true);
                  }
                  window.dispatchEvent(new CustomEvent('gonavi:ai:inject-prompt', { detail: { prompt } }));
              },
          })
      ));
  }, [buildQueryEditorAiContextMenuActions, disposeQueryEditorAiContextMenuActions, isElasticsearchMode]);

  const buildQueryEditorSlashCommandDefs = useCallback(() => ([
      {
          cmd: '/query',
          label: `🔍 ${translate('query_editor.slash_command.query.label')}`,
          desc: translate('query_editor.slash_command.query.description'),
          prompt: translate('query_editor.slash_command.query.prompt'),
      },
      {
          cmd: '/sql',
          label: `📝 ${translate('query_editor.slash_command.sql.label')}`,
          desc: translate('query_editor.slash_command.sql.description'),
          prompt: translate('query_editor.slash_command.sql.prompt'),
      },
      {
          cmd: '/explain',
          label: `💡 ${translate('query_editor.slash_command.explain.label')}`,
          desc: translate('query_editor.slash_command.explain.description'),
          prompt: translate('query_editor.slash_command.explain.prompt', { sql: QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER }),
          useSelection: true,
      },
      {
          cmd: '/optimize',
          label: `⚡ ${translate('query_editor.slash_command.optimize.label')}`,
          desc: translate('query_editor.slash_command.optimize.description'),
          prompt: translate('query_editor.slash_command.optimize.prompt', { sql: QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER }),
          useSelection: true,
      },
      {
          cmd: '/schema',
          label: `🏗️ ${translate('query_editor.slash_command.schema.label')}`,
          desc: translate('query_editor.slash_command.schema.description'),
          prompt: translate('query_editor.slash_command.schema.prompt'),
      },
      {
          cmd: '/index',
          label: `📊 ${translate('query_editor.slash_command.index.label')}`,
          desc: translate('query_editor.slash_command.index.description'),
          prompt: translate('query_editor.slash_command.index.prompt'),
      },
      {
          cmd: '/diff',
          label: `🔄 ${translate('query_editor.slash_command.diff.label')}`,
          desc: translate('query_editor.slash_command.diff.description'),
          prompt: translate('query_editor.slash_command.diff.prompt'),
      },
      {
          cmd: '/mock',
          label: `🎲 ${translate('query_editor.slash_command.mock.label')}`,
          desc: translate('query_editor.slash_command.mock.description'),
          prompt: translate('query_editor.slash_command.mock.prompt'),
      },
  ]), []);

  const refreshQueryEditorSlashCommandDefs = useCallback(() => {
      (window as any).__gonaviSlashCmdDefs = buildQueryEditorSlashCommandDefs();
  }, [buildQueryEditorSlashCommandDefs]);

  const syncQueryToEditor = (sql: string) => {
      const next = sql || '';
      applyQueryState(next);
      const editor = editorRef.current;
      if (editor && editor.getValue?.() !== next) {
          editor.setValue(next);
      }
  };

  const openTextToSqlModal = useCallback(() => {
      const editor = editorRef.current;
      const selection = editor?.getSelection?.();
      const selectedText = selection ? String(editor?.getModel?.()?.getValueInRange?.(selection) || '') : '';
      setTextToSqlApplyMode(selectedText.trim() ? 'replaceSelection' : 'insert');
      setIsTextToSqlModalOpen(true);
  }, []);

  const applyTextToSqlResult = useCallback((sql: string, applyMode: QueryEditorAiApplyMode) => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      const model = editor?.getModel?.();
      const nextSql = String(sql || '').trim();
      if (!nextSql) {
          return false;
      }
      if (!editor || !monaco?.Range || !model) {
          syncQueryToEditor(nextSql);
          refreshObjectDecorations();
          return true;
      }

      const selection = editor.getSelection?.();
      const hasSelection = !!selection && !(typeof selection.isEmpty === 'function'
          ? selection.isEmpty()
          : selection.startLineNumber === selection.endLineNumber && selection.startColumn === selection.endColumn);
      const lineCount = Number(model.getLineCount?.() || 1);
      const range = applyMode === 'replaceAll'
          ? (
              model.getFullModelRange?.()
              || new monaco.Range(1, 1, lineCount, Number(model.getLineMaxColumn?.(lineCount) || 1))
          )
          : applyMode === 'replaceSelection' && hasSelection
              ? selection
              : (() => {
                  const position = normalizeEditorPosition(editor.getPosition?.())
                      || normalizeEditorPosition(lastEditorCursorPositionRef.current)
                      || { lineNumber: lineCount, column: Number(model.getLineMaxColumn?.(lineCount) || 1) };
                  return new monaco.Range(
                      position.lineNumber,
                      position.column,
                      position.lineNumber,
                      position.column,
                  );
              })();

      editor.focus?.();
      editor.pushUndoStop?.();
      editor.executeEdits?.('gonavi-text-to-sql', [{
          range,
          text: nextSql,
          forceMoveMarkers: true,
      }]);
      editor.pushUndoStop?.();
      const nextValue = String(editor.getValue?.() || nextSql);
      applyQueryState(nextValue);
      refreshObjectDecorations();
      return true;
  }, [applyQueryState, refreshObjectDecorations]);

  const showTextToSqlReadinessWarning = useCallback((reason?: string) => {
      const key = reason === 'service_unavailable'
          ? 'query_editor.message.ai_service_unavailable'
          : reason === 'model_missing'
              ? 'query_editor.message.ai_model_missing'
              : 'query_editor.message.ai_provider_missing';
      void message.warning(translate(key));
  }, []);

  const handleGenerateTextToSql = useCallback(async () => {
      const instruction = textToSqlInstruction.trim();
      if (!instruction) {
          void message.warning(translate('query_editor.message.text_to_sql_empty_instruction'));
          return;
      }

      setTextToSqlGenerating(true);
      try {
          const aiContext = buildQueryEditorAiContext();
          const editorSnapshot = buildQueryEditorAiEditorSnapshot();
          const response = isElasticsearchMode
              ? await requestQueryEditorTextToElasticsearch({
                  service: getQueryEditorAiService(),
                  aiContext: {
                      ...aiContext,
                      elasticsearchVersion: elasticsearchServerMajor > 0
                          ? String(elasticsearchServerMajor)
                          : '',
                      elasticsearchMapping: JSON.stringify({
                          fields: (aiContext.columns || []).map((column) => ({
                              index: column.dbName,
                              field: column.name,
                              type: column.type,
                          })),
                      }, null, 2),
                  },
                  editorSnapshot,
                  instruction,
              })
              : await requestQueryEditorTextToSql({
                  service: getQueryEditorAiService(),
                  aiContext,
                  editorSnapshot,
                  instruction,
              });
          const generatedSource = 'source' in response ? response.source : response.sql;
          const { readiness } = response;
          if (!readiness.ready) {
              showTextToSqlReadinessWarning(readiness.reason);
              return;
          }
          if (!generatedSource.trim()) {
              void message.warning(translate('query_editor.message.text_to_sql_empty_result'));
              return;
          }
          if (applyTextToSqlResult(generatedSource, textToSqlApplyMode)) {
              setIsTextToSqlModalOpen(false);
              setTextToSqlInstruction('');
              void message.success(translate('query_editor.message.text_to_sql_success'));
          }
      } catch (error: any) {
          void message.error(translate(isElasticsearchMode
              ? 'query_editor.elasticsearch.ai_failed'
              : 'query_editor.message.text_to_sql_failed', {
              error: error?.message || String(error || ''),
          }));
      } finally {
          setTextToSqlGenerating(false);
      }
  }, [
      applyTextToSqlResult,
      buildQueryEditorAiContext,
      buildQueryEditorAiEditorSnapshot,
      elasticsearchServerMajor,
      isElasticsearchMode,
      showTextToSqlReadinessWarning,
      textToSqlApplyMode,
      textToSqlInstruction,
  ]);

  // If opening a saved query, load its SQL
  useEffect(() => {
      const incoming = getTabQueryValue(tab);
      if (incoming === lastExternalQueryRef.current) {
          return;
      }
      lastExternalQueryRef.current = incoming;
      const editorHasFocus = editorRef.current?.hasTextFocus?.() === true;
      if (editorHasFocus && incoming === lastLocalQueryRef.current) {
          setQuery(incoming);
          return;
      }
      syncQueryToEditor(incoming);
  }, [tab.id, tab.query]);

  // Fetch Database List
  useEffect(() => {
      if (!isActive || !autoFetchVisible) {
          return;
      }

      let cancelled = false;
      const fetchDbs = async () => {
          const conn = connections.find(c => c.id === currentConnectionId);
          if (!conn) return;

          const config = {
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || "",
            database: conn.config.database || "",
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
          };

          const res = await DBGetDatabases(buildRpcConnectionConfig(config) as any);
          if (cancelled) return;
          if (res.success && Array.isArray(res.data)) {
              let dbs = res.data.map((row: any) => row.Database || row.database);

              dbs = filterVisibleDatabaseNames(conn, dbs);

              // 存储可见数据库列表用于跨库智能提示
              visibleDbsRef.current = dbs;
              if (isActive) {
                  sharedVisibleDbs = dbs;
              }

              setDbList(dbs);
          } else {
              visibleDbsRef.current = [];
              if (isActive) {
                  sharedVisibleDbs = [];
              }
              setDbList([]);
          }
      };
      void fetchDbs();
      return () => {
          cancelled = true;
      };
  }, [autoFetchVisible, currentConnectionId, connections, isActive]);

  // PostgreSQL keeps database and schema as separate execution contexts. Load the
  // available schemas without mutating the saved connection configuration.
  useEffect(() => {
      if (!isActive || !autoFetchVisible) {
          schemaLoadSeqRef.current += 1;
          setSchemaLoading(false);
          return;
      }
      if (!canSelectQuerySchema) {
          schemaLoadSeqRef.current += 1;
          schemaContextKeyRef.current = '';
          currentSchemaRef.current = '';
          latestSelectedSchemaRef.current = '';
          setCurrentSchema('');
          setSchemaList([]);
          setSchemaLoading(false);
          return;
      }

      const conn = currentConnection;
      const dbName = String(currentDb || '').trim();
      if (!conn || !dbName) {
          schemaLoadSeqRef.current += 1;
          setSchemaList([]);
          setSchemaLoading(false);
          return;
      }

      const contextKey = `${tab.id}\u0000${currentConnectionId}\u0000${dbName}`;
      if (schemaContextKeyRef.current !== contextKey) {
          schemaContextKeyRef.current = contextKey;
          latestSelectedSchemaRef.current = '';
          const rememberedSchema = String(currentSchemaRef.current || '').trim();
          setSchemaList(rememberedSchema ? [rememberedSchema] : []);
      }

      const requestSeq = schemaLoadSeqRef.current + 1;
      schemaLoadSeqRef.current = requestSeq;
      let cancelled = false;
      setSchemaLoading(true);

      const config = {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || '',
          database: conn.config.database || '',
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
      };
      const loadCurrentSchema = DBQuery(
          buildRpcConnectionConfig(config) as any,
          dbName,
          QUERY_EDITOR_CURRENT_SCHEMA_SQL,
      ).then((result) => (
          result.success ? extractQueryEditorCurrentSchema(result.data) : ''
      )).catch(() => '');

      void Promise.all([loadSchemas(conn, dbName), loadCurrentSchema])
          .then(([result, databaseDefaultSchema]) => {
              if (cancelled) return;
              const resolved = resolveLoadedQueryEditorSchema({
                  requestSeq,
                  currentRequestSeq: schemaLoadSeqRef.current,
                  latestSelectedSchema: latestSelectedSchemaRef.current,
                  rememberedSchema: String(tab.schemaName || ''),
                  currentSchema: databaseDefaultSchema,
                  schemaNames: Array.isArray(result.schemas) ? result.schemas : [],
              });
              if (!resolved) return;
              currentSchemaRef.current = resolved.selectedSchema;
              setCurrentSchema(resolved.selectedSchema);
              setSchemaList(resolved.schemaNames);
              if (resolved.selectedSchema) {
                  updateQueryTabDraft(tab.id, { schemaName: resolved.selectedSchema });
              }
          })
          .catch(() => {
              if (cancelled || requestSeq !== schemaLoadSeqRef.current) return;
              const fallbackSchema = String(currentSchemaRef.current || tab.schemaName || '').trim();
              setSchemaList(fallbackSchema ? [fallbackSchema] : []);
          })
          .finally(() => {
              if (!cancelled && requestSeq === schemaLoadSeqRef.current) {
                  setSchemaLoading(false);
              }
          });

      return () => {
          cancelled = true;
      };
  }, [
      autoFetchVisible,
      canSelectQuerySchema,
      currentConnection,
      currentConnectionId,
      currentDb,
      isActive,
      setSchemaLoading,
      tab.id,
      updateQueryTabDraft,
  ]);

  // Fetch Metadata for Autocomplete (Cross-database)
  useEffect(() => {
      if (!isActive || !autoFetchVisible || isObjectEditQueryTab) {
          return;
      }

      let cancelled = false;
      const metadataGeneration = metadataGenerationRef.current;
      // 仅在本次 effect 成功完成后写入；中途 cancel 不得留下 key，否则同 key 永远不再拉取 → 超链接全灭
      let activeFetchKey = '';
      const fetchMetadata = async () => {
          const conn = connections.find(c => c.id === currentConnectionId);
          if (!conn) return;
          const metadataSnapshot: QueryEditorMetadataRequestSnapshot = {
              generation: metadataGeneration,
              connectionId: currentConnectionId,
              connectionConfig: conn.config,
          };
          const isCurrentMetadataRequest = () => (
              !cancelled && isQueryEditorMetadataRequestCurrent(metadataSnapshot)
          );

          const visibleDbs = filterVisibleDatabaseNames(conn, visibleDbsRef.current);
          visibleDbsRef.current = visibleDbs;
          if (isActive) {
              sharedVisibleDbs = visibleDbs;
          }
          setDbList((current) => (
              current.length === visibleDbs.length
              && current.every((database, index) => database === visibleDbs[index])
                  ? current
                  : visibleDbs
          ));

          const config = {
            ...conn.config,
            port: Number(conn.config.port),
            password: conn.config.password || "",
            database: conn.config.database || "",
            useSSH: conn.config.useSSH || false,
            ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
          };

          const metadataDbName = String(currentDbRef.current || currentDb || '').trim();
          if (!metadataDbName) return;
          if (isActive) {
              sharedCurrentDb = metadataDbName;
          }
          const metadataDbNames = collectQueryEditorReferencedDatabaseNames(
              getCurrentQuery(),
              metadataDbName,
              visibleDbs,
          );
          const metadataFetchKey = [
              currentConnectionId,
              ...metadataDbNames.map((dbName) => String(dbName || '').toLowerCase()).sort(),
          ].join('\u0000');
          const hasCurrentDbTables = tablesRef.current.some(
              (table) => String(table.dbName || '').trim().toLowerCase() === metadataDbName.toLowerCase(),
          );
          if (metadataFetchKeyRef.current === metadataFetchKey && hasCurrentDbTables) {
              // 已成功拉过同一批库且当前库表仍在：只刷新装饰
              refreshObjectDecorations();
              return;
          }
          // key 相同但表为空（中途 cancel / 异常）：允许重拉
          activeFetchKey = metadataFetchKey;

          const allTables: CompletionTableMeta[] = [];
          const allColumns: CompletionColumnMeta[] = [];
          const allViews: CompletionViewMeta[] = [];
          const allMaterializedViews: CompletionViewMeta[] = [];
          const allSynonyms: CompletionSynonymMeta[] = [];
          const allTriggers: CompletionTriggerMeta[] = [];
          const allRoutines: CompletionRoutineMeta[] = [];
          const allSequences: CompletionSequenceMeta[] = [];
          const allPackages: CompletionPackageMeta[] = [];
          const metadataDialect = normalizeMetadataDialect(conn);
          const syncMetadataSnapshot = () => {
              if (!isCurrentMetadataRequest()) {
                  return false;
              }
              tablesRef.current = [...allTables];
              allColumnsRef.current = [...allColumns];
              viewsRef.current = [...allViews];
              materializedViewsRef.current = [...allMaterializedViews];
              synonymsRef.current = [...allSynonyms];
              triggersRef.current = [...allTriggers];
              routinesRef.current = [...allRoutines];
              sequencesRef.current = [...allSequences];
              packagesRef.current = [...allPackages];
              if (isActive) {
                  sharedCurrentDb = metadataDbName;
                  sharedTablesData = tablesRef.current;
                  sharedAllColumnsData = allColumnsRef.current;
                  sharedViewsData = viewsRef.current;
                  sharedMaterializedViewsData = materializedViewsRef.current;
                  sharedSynonymsData = synonymsRef.current;
                  sharedTriggersData = triggersRef.current;
                  sharedRoutinesData = routinesRef.current;
                  sharedSequencesData = sequencesRef.current;
                  sharedPackagesData = packagesRef.current;
              }
              return true;
          };

          const synonymResults = await queryCompletionMetadataRowsBySpecs(
              config,
              metadataDbName,
              buildCompletionSynonymsMetadataQuerySpecs(metadataDialect),
          );
          if (cancelled) return;
          const seenSynonyms = new Set<string>();
          synonymResults.forEach((queryResult) => {
              queryResult.rows.forEach((row) => {
                  const rawSynonymName = String(getCaseInsensitiveValue(row, ['synonym_name', 'synonymname', 'name']) || '').trim()
                      || getFirstRowValue(row);
                  const synonymParts = splitSidebarQualifiedName(rawSynonymName);
                  const synonymName = String(synonymParts.objectName || rawSynonymName).trim();
                  if (!synonymName) return;

                  const ownerName = String(getCaseInsensitiveValue(row, ['synonym_owner', 'owner', 'schema_name']) || synonymParts.schemaName || '').trim();
                  const rawTargetName = String(getCaseInsensitiveValue(row, ['target_name', 'table_name', 'table']) || '').trim();
                  const targetParts = splitSidebarQualifiedName(rawTargetName);
                  const targetName = String(targetParts.objectName || rawTargetName).trim();
                  if (!targetName) return;

                  const targetSchemaName = String(getCaseInsensitiveValue(row, ['target_schema_name', 'table_owner', 'target_owner']) || targetParts.schemaName || '').trim();
                  const uniqueKey = [ownerName.toLowerCase(), synonymName.toLowerCase()].join('\u0000');
                  if (seenSynonyms.has(uniqueKey)) return;
                  seenSynonyms.add(uniqueKey);
                  allSynonyms.push({
                      ownerName,
                      synonymName,
                      targetSchemaName: targetSchemaName || undefined,
                      targetName,
                  });
              });
          });

          for (const dbName of metadataDbNames) {
              if (cancelled) return;
              const tableComments = await fetchCompletionTableCommentMap(config, dbName, metadataDialect);
              if (cancelled) return;

              // 获取表
              const resTables = await DBGetTables(buildRpcConnectionConfig(config) as any, dbName);
              if (cancelled) return;
              if (resTables.success && Array.isArray(resTables.data)) {
                  resTables.data.forEach((row: any) => {
                      const tableMeta = buildCompletionTableMeta(dbName, row, tableComments);
                      if (tableMeta) {
                          allTables.push(tableMeta);
                      }
                  });
              }
              if (!syncMetadataSnapshot()) return;

              // 获取列 (所有数据库类型都支持 DBGetAllColumns)
              const resCols = await DBGetAllColumns(buildRpcConnectionConfig(config) as any, dbName);
              if (cancelled) return;
              if (resCols.success && Array.isArray(resCols.data)) {
                  const normalizedMetadataDbName = String(dbName || '').trim().toLowerCase();
                  if (isTableMetadataIncomplete(resCols)) {
                      message.warning(getTableMetadataIssueDetail(resCols));
                      incompleteColumnMetadataDbsRef.current.add(normalizedMetadataDbName);
                  } else {
                      incompleteColumnMetadataDbsRef.current.delete(normalizedMetadataDbName);
                  }
                  resCols.data.forEach((col: any) => {
                      allColumns.push({
                          dbName,
                          tableName: col.tableName,
                          name: col.name,
                          type: col.type,
                          comment: normalizeCommentText(col.comment ?? col.Comment ?? col.COLUMN_COMMENT ?? col.column_comment ?? '')
                      });
                  });
              }
              if (!syncMetadataSnapshot()) return;

              const viewResults = await queryCompletionMetadataRowsBySpecs(
                  config,
                  dbName,
                  buildCompletionViewsMetadataQuerySpecs(metadataDialect, dbName),
              );
              if (cancelled) return;
              const seenViews = new Set<string>();
              viewResults.forEach((queryResult) => {
                  queryResult.rows.forEach((row) => {
                      const tableType = getCaseInsensitiveValue(row, ['table_type', 'table type', 'type']);
                      if (!isSidebarViewTableType(tableType)) return;
                      const schemaName = String(getCaseInsensitiveValue(row, ['schema_name', 'schemaname', 'owner', 'table_schema', 'db']) || '').trim();
                      const rawViewName = String(getCaseInsensitiveValue(row, ['view_name', 'viewname', 'table_name', 'name']) || '').trim()
                          || getMySQLShowTablesName(row)
                          || getFirstRowValue(row);
                      const normalizedViewName = normalizeSidebarViewName(metadataDialect, dbName, schemaName, rawViewName);
                      if (!normalizedViewName) return;
                      const uniqueKey = `${dbName.toLowerCase()}@@${normalizedViewName.toLowerCase()}`;
                      if (seenViews.has(uniqueKey)) return;
                      seenViews.add(uniqueKey);
                      const parsed = splitSidebarQualifiedName(normalizedViewName);
                      allViews.push({
                          dbName,
                          viewName: normalizedViewName,
                          schemaName: schemaName || parsed.schemaName || undefined,
                      });
                  });
              });
              if (!syncMetadataSnapshot()) return;

              const materializedViewResults = await queryCompletionMetadataRowsBySpecs(
                  config,
                  dbName,
                  buildCompletionMaterializedViewsMetadataQuerySpecs(metadataDialect, dbName),
              );
              if (cancelled) return;
              const seenMaterializedViews = new Set<string>();
              materializedViewResults.forEach((queryResult) => {
                  queryResult.rows.forEach((row) => {
                      const schemaName = String(getCaseInsensitiveValue(row, ['schema_name', 'table_schema', 'db', 'database']) || '').trim();
                      const rawViewName = String(getCaseInsensitiveValue(row, ['object_name', 'view_name', 'table_name', 'name', 'materialized_view_name', 'mv_name']) || '').trim() || getFirstRowValue(row);
                      const normalizedViewName = normalizeSidebarViewName(metadataDialect, dbName, schemaName, rawViewName);
                      if (!normalizedViewName) return;
                      const uniqueKey = `${dbName.toLowerCase()}@@${normalizedViewName.toLowerCase()}`;
                      if (seenMaterializedViews.has(uniqueKey)) return;
                      seenMaterializedViews.add(uniqueKey);
                      const parsed = splitSidebarQualifiedName(normalizedViewName);
                      allMaterializedViews.push({
                          dbName,
                          viewName: normalizedViewName,
                          schemaName: schemaName || parsed.schemaName || undefined,
                      });
                  });
              });
              if (!syncMetadataSnapshot()) return;

              const triggerResults = await queryCompletionMetadataRowsBySpecs(
                  config,
                  dbName,
                  buildCompletionTriggersMetadataQuerySpecs(metadataDialect, dbName),
              );
              if (cancelled) return;
              const seenTriggers = new Set<string>();
              triggerResults.forEach((queryResult) => {
                  queryResult.rows.forEach((row) => {
                      const rawTriggerName = String(getCaseInsensitiveValue(row, ['trigger_name', 'triggername', 'trigger', 'name']) || '').trim() || getFirstRowValue(row);
                      if (!rawTriggerName) return;
                      const rawSchemaName = String(getCaseInsensitiveValue(row, ['schema_name', 'schemaname', 'owner', 'event_object_schema', 'trigger_schema', 'db']) || '').trim();
                      const rawTableName = String(getCaseInsensitiveValue(row, ['table_name', 'event_object_table', 'tbl_name', 'table']) || '').trim();
                      const triggerParts = splitSidebarQualifiedName(rawTriggerName);
                      const tableParts = splitSidebarQualifiedName(rawTableName);
                      const resolvedSchemaName = String(rawSchemaName || tableParts.schemaName || triggerParts.schemaName || '').trim();
                      const resolvedTriggerName = String(triggerParts.objectName || rawTriggerName).trim();
                      const resolvedTableName = buildQualifiedCompletionName(resolvedSchemaName, tableParts.objectName || rawTableName);
                      const uniqueKey = (metadataDialect === 'mysql' || metadataDialect === 'starrocks')
                          ? `${dbName.toLowerCase()}@@${resolvedSchemaName.toLowerCase()}@@${resolvedTriggerName.toLowerCase()}`
                          : `${dbName.toLowerCase()}@@${resolvedSchemaName.toLowerCase()}@@${resolvedTriggerName.toLowerCase()}@@${resolvedTableName.toLowerCase()}`;
                      if (seenTriggers.has(uniqueKey)) return;
                      seenTriggers.add(uniqueKey);
                      allTriggers.push({
                          dbName,
                          triggerName: buildQualifiedCompletionName(resolvedSchemaName, resolvedTriggerName) || resolvedTriggerName,
                          tableName: resolvedTableName || rawTableName,
                          schemaName: resolvedSchemaName || undefined,
                      });
                  });
              });
              if (!syncMetadataSnapshot()) return;

              const routineResults = await queryCompletionMetadataRowsBySpecs(
                  config,
                  dbName,
                  buildCompletionFunctionsMetadataQuerySpecs(metadataDialect, dbName),
              );
              if (cancelled) return;
              const seenRoutines = new Set<string>();
              routineResults.forEach((queryResult) => {
                  queryResult.rows.forEach((row) => {
                      const rawRoutineName = String(getCaseInsensitiveValue(row, ['routine_name', 'object_name', 'proname', 'name']) || '').trim();
                      if (!rawRoutineName) return;
                      const schemaName = String(getCaseInsensitiveValue(row, ['schema_name', 'nspname', 'owner', 'db', 'database']) || '').trim();
                      const rawType = String(getCaseInsensitiveValue(row, ['routine_type', 'object_type', 'type']) || queryResult.inferredType || 'FUNCTION').trim();
                      const normalizedType = rawType.toUpperCase().includes('PROC') ? 'PROCEDURE' : 'FUNCTION';
                      const qualifiedRoutineName = buildQualifiedCompletionName(schemaName, rawRoutineName);
                      if (!qualifiedRoutineName) return;
                      const uniqueKey = `${dbName.toLowerCase()}@@${qualifiedRoutineName.toLowerCase()}@@${normalizedType}`;
                      if (seenRoutines.has(uniqueKey)) return;
                      seenRoutines.add(uniqueKey);
                      allRoutines.push({
                          dbName,
                          routineName: qualifiedRoutineName,
                          routineType: normalizedType,
                          schemaName: schemaName || splitSidebarQualifiedName(qualifiedRoutineName).schemaName || undefined,
                      });
                  });
              });
              if (!syncMetadataSnapshot()) return;

              const sequenceResults = await queryCompletionMetadataRowsBySpecs(
                  config,
                  dbName,
                  buildCompletionSequencesMetadataQuerySpecs(metadataDialect, dbName),
              );
              if (cancelled) return;
              const seenSequences = new Set<string>();
              sequenceResults.forEach((queryResult) => {
                  queryResult.rows.forEach((row) => {
                      const rawSequenceName = String(getCaseInsensitiveValue(row, ['sequence_name', 'name']) || '').trim() || getFirstRowValue(row);
                      if (!rawSequenceName) return;
                      const schemaName = String(getCaseInsensitiveValue(row, ['schema_name', 'sequence_owner', 'owner', 'db', 'database']) || '').trim();
                      const sequenceParts = splitSidebarQualifiedName(rawSequenceName);
                      const resolvedSchemaName = String(schemaName || sequenceParts.schemaName || '').trim();
                      const resolvedSequenceName = String(sequenceParts.objectName || rawSequenceName).trim();
                      const qualifiedSequenceName = buildQualifiedCompletionName(resolvedSchemaName, resolvedSequenceName);
                      if (!qualifiedSequenceName) return;
                      const uniqueKey = `${dbName.toLowerCase()}@@${qualifiedSequenceName.toLowerCase()}`;
                      if (seenSequences.has(uniqueKey)) return;
                      seenSequences.add(uniqueKey);
                      allSequences.push({
                          dbName,
                          sequenceName: qualifiedSequenceName,
                          schemaName: resolvedSchemaName || splitSidebarQualifiedName(qualifiedSequenceName).schemaName || undefined,
                      });
                  });
              });
              if (!syncMetadataSnapshot()) return;

              const packageResults = await queryCompletionMetadataRowsBySpecs(
                  config,
                  dbName,
                  buildCompletionPackagesMetadataQuerySpecs(metadataDialect, dbName),
              );
              if (cancelled) return;
              const seenPackages = new Set<string>();
              packageResults.forEach((queryResult) => {
                  queryResult.rows.forEach((row) => {
                      const rawPackageName = String(getCaseInsensitiveValue(row, ['package_name', 'object_name', 'name']) || '').trim() || getFirstRowValue(row);
                      if (!rawPackageName) return;
                      const schemaName = String(getCaseInsensitiveValue(row, ['schema_name', 'owner', 'db', 'database']) || '').trim();
                      const packageParts = splitSidebarQualifiedName(rawPackageName);
                      const resolvedSchemaName = String(schemaName || packageParts.schemaName || '').trim();
                      const resolvedPackageName = String(packageParts.objectName || rawPackageName).trim();
                      const qualifiedPackageName = buildQualifiedCompletionName(resolvedSchemaName, resolvedPackageName);
                      if (!qualifiedPackageName) return;
                      const uniqueKey = `${dbName.toLowerCase()}@@${qualifiedPackageName.toLowerCase()}`;
                      if (seenPackages.has(uniqueKey)) return;
                      seenPackages.add(uniqueKey);
                      allPackages.push({
                          dbName,
                          packageName: qualifiedPackageName,
                          schemaName: resolvedSchemaName || splitSidebarQualifiedName(qualifiedPackageName).schemaName || undefined,
                      });
                  });
              });
              if (!syncMetadataSnapshot()) return;
          }

          if (!syncMetadataSnapshot()) return;
          // 成功完成后才固化 key，避免 cancel 后同 key 被误判为「已完成」
          metadataFetchKeyRef.current = activeFetchKey;
          lastSqlReferencedMetadataKeyRef.current = activeFetchKey;
          refreshObjectDecorations();
      };
      void fetchMetadata();
      return () => {
          cancelled = true;
      };
  }, [
      autoFetchVisible,
      currentConnectionId,
      currentDb,
      connections,
      isActive,
      isQueryEditorMetadataRequestCurrent,
      isObjectEditQueryTab,
      refreshObjectDecorations,
      sqlReferencedMetadataKey,
  ]);

  // Query ID management helpers
  const setQueryId = (id: string) => {
      currentQueryIdRef.current = id;
      setCurrentQueryId(id);
  };

  const clearQueryId = () => {
      currentQueryIdRef.current = '';
      setCurrentQueryId('');
  };

  const resolveEditorSplitAvailableHeight = useCallback(() => {
      const rootRect = queryEditorRootRef.current?.getBoundingClientRect?.();
      const paneRect = editorPaneRef.current?.getBoundingClientRect?.();
      const editorContainerRect = (editorStageRef.current || editorShellRef.current)?.getBoundingClientRect?.();
      const rootHeight = Number(rootRect?.height || 0);
      const paneHeight = Number(paneRect?.height || 0);
      const editorContainerHeight = Number(editorContainerRect?.height || 0);
      if (!Number.isFinite(rootHeight) || rootHeight <= 0) {
          return 0;
      }
      const nonEditorPaneHeight = paneHeight > 0 && editorContainerHeight > 0
          ? Math.max(0, paneHeight - editorContainerHeight)
          : 0;
      const availableHeight = rootHeight - nonEditorPaneHeight;
      return Number.isFinite(availableHeight) && availableHeight > 0 ? availableHeight : 0;
  }, []);

  const clampEditorHeight = useCallback((height: number) => {
      const availableHeight = resolveEditorSplitAvailableHeight();
      if (availableHeight > 0) {
          return clampQueryEditorEditorHeight(height, availableHeight);
      }
      const viewportHeight = Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
      const maxHeight = Math.max(100, viewportHeight - 200);
      return Math.max(100, Math.min(maxHeight, height));
  }, [resolveEditorSplitAvailableHeight]);

  const applyEditorHeightRatio = useCallback(() => {
      const availableHeight = resolveEditorSplitAvailableHeight();
      if (availableHeight <= 0 || dragRef.current) return;
      const nextHeight = resolveQueryEditorEditorHeightFromRatio(
          queryEditorEditorHeightRatio,
          availableHeight,
      );
      pendingEditorHeightRef.current = nextHeight;
      setEditorHeight(previousHeight => previousHeight === nextHeight ? previousHeight : nextHeight);
  }, [queryEditorEditorHeightRatio, resolveEditorSplitAvailableHeight]);

  useEffect(() => {
      if (!isResultPanelVisible || !isActive) return;
      let frame: number | null = null;
      const requestFrame = typeof window.requestAnimationFrame === 'function'
          ? window.requestAnimationFrame.bind(window)
          : (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 16);
      const cancelFrame = typeof window.cancelAnimationFrame === 'function'
          ? window.cancelAnimationFrame.bind(window)
          : window.clearTimeout.bind(window);
      const scheduleApply = () => {
          if (frame !== null) return;
          frame = requestFrame(() => {
              frame = null;
              applyEditorHeightRatio();
          });
      };

      scheduleApply();
      const ResizeObserverCtor = typeof ResizeObserver === 'function' ? ResizeObserver : null;
      const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(scheduleApply) : null;
      if (resizeObserver) {
          if (queryEditorRootRef.current) resizeObserver.observe(queryEditorRootRef.current);
          if (editorPaneRef.current) resizeObserver.observe(editorPaneRef.current);
      }
      window.addEventListener('resize', scheduleApply);
      return () => {
          if (frame !== null) {
              cancelFrame(frame);
              frame = null;
          }
          resizeObserver?.disconnect();
          window.removeEventListener('resize', scheduleApply);
      };
  }, [applyEditorHeightRatio, isActive, isResultPanelVisible, tab.id]);

  const applyEditorHeightToDom = useCallback(() => {
      const nextHeight = pendingEditorHeightRef.current;
      const editorContainer = editorStageRef.current || editorShellRef.current;
      if (editorContainer) {
          editorContainer.style.height = `${nextHeight}px`;
      }
      editorRef.current?.layout?.();
  }, []);

  const cancelEditorResizeFrame = useCallback(() => {
      if (resizeFrameRef.current === null) return;
      if (typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(resizeFrameRef.current);
      } else {
          window.clearTimeout(resizeFrameRef.current);
      }
      resizeFrameRef.current = null;
  }, []);

  const scheduleEditorHeightDomUpdate = useCallback((height: number) => {
      pendingEditorHeightRef.current = height;
      if (resizeFrameRef.current !== null) return;

      const requestFrame = typeof window.requestAnimationFrame === 'function'
          ? window.requestAnimationFrame.bind(window)
          : (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 16);

      resizeFrameRef.current = requestFrame(() => {
          resizeFrameRef.current = null;
          applyEditorHeightToDom();
      });
  }, [applyEditorHeightToDom]);

  // Handle Resizing
  const handleMouseMove = useCallback((e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = e.clientY - dragRef.current.startY;
      const newHeight = clampEditorHeight(dragRef.current.startHeight + delta);
      dragRef.current.currentHeight = newHeight;
      scheduleEditorHeightDomUpdate(newHeight);
  }, [clampEditorHeight, scheduleEditorHeightDomUpdate]);

  const handleMouseUp = useCallback(() => {
      const finalHeight = dragRef.current?.currentHeight;
      dragRef.current = null;
      cancelEditorResizeFrame();
      if (typeof finalHeight === 'number') {
          pendingEditorHeightRef.current = finalHeight;
          applyEditorHeightToDom();
          setEditorHeight(finalHeight);
          const availableHeight = resolveEditorSplitAvailableHeight();
          if (availableHeight > 0) {
              setQueryOptions({
                  queryEditorEditorHeightRatio: resolveQueryEditorEditorHeightRatio(
                      finalHeight,
                      availableHeight,
                  ),
              });
          }
      }
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
  }, [applyEditorHeightToDom, cancelEditorResizeFrame, handleMouseMove, resolveEditorSplitAvailableHeight, setQueryOptions]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      const currentEditorHeight = Number((editorStageRef.current || editorShellRef.current)?.getBoundingClientRect?.().height || editorHeight);
      const startHeight = Number.isFinite(currentEditorHeight) && currentEditorHeight > 0 ? currentEditorHeight : editorHeight;
      dragRef.current = { startY: e.clientY, startHeight, currentHeight: startHeight };
      pendingEditorHeightRef.current = startHeight;
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
  }, [editorHeight, handleMouseMove, handleMouseUp]);

  useEffect(() => {
      return () => {
          dragRef.current = null;
          cancelEditorResizeFrame();
          document.removeEventListener('mousemove', handleMouseMove);
          document.removeEventListener('mouseup', handleMouseUp);
      };
  }, [cancelEditorResizeFrame, handleMouseMove, handleMouseUp]);

  const openRoutineObjectEditTab = useCallback(async (
      navigationTarget: Extract<QueryEditorNavigationTarget, { type: 'routine' }>,
      connectionId: string,
      targetDbName: string,
  ) => {
      const targetRoutineName = String(navigationTarget.routineName || '').trim();
      if (!targetRoutineName) return;

      const normalizedRoutineType = String(navigationTarget.routineType || 'FUNCTION').trim().toUpperCase().includes('PROC')
          ? 'PROCEDURE'
          : 'FUNCTION';
      const routineTypeLabel = normalizedRoutineType === 'PROCEDURE'
          ? translate('sidebar.object.procedure')
          : translate('sidebar.object.function');
      const sqlTemplateHeader = `-- ${translate('sidebar.sql_template.edit_routine', {
          type: routineTypeLabel,
          name: targetRoutineName,
      })}`;
      let editSql = `${sqlTemplateHeader}\n-- ${translate('sidebar.sql_template.modify_then_execute')}\n${buildQueryEditorRoutineEditFallbackSql(targetRoutineName, normalizedRoutineType)}`;

      const conn = connectionsRef.current.find((item) => item.id === connectionId);
      if (conn) {
          const dialect = normalizeMetadataDialect(conn);
          const parsedRoutine = splitSidebarQualifiedName(targetRoutineName);
          const routineObjectName = parsedRoutine.objectName || targetRoutineName;
          const routineSchemaName = String(navigationTarget.schemaName || parsedRoutine.schemaName || '').trim();
          const safeName = escapeQueryEditorObjectEditSqlLiteral(routineObjectName);
          const safeSchema = escapeQueryEditorObjectEditSqlLiteral(routineSchemaName);
          const safeDbName = escapeQueryEditorObjectEditSqlLiteral(targetDbName);
          const config = {
              ...conn.config,
              port: Number(conn.config?.port),
              password: conn.config?.password || '',
              database: conn.config?.database || '',
              useSSH: conn.config?.useSSH || false,
              ssh: conn.config?.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
          };
          const queries = (() => {
              switch (dialect) {
                  case 'mysql':
                  case 'starrocks':
                      return [
                          `SHOW CREATE ${normalizedRoutineType} \`${routineObjectName.replace(/`/g, '``')}\``,
                          safeDbName
                              ? `SELECT ROUTINE_DEFINITION AS routine_definition FROM information_schema.routines WHERE routine_schema = '${safeDbName}' AND routine_name = '${safeName}' AND UPPER(routine_type) = '${normalizedRoutineType}' LIMIT 1`
                              : '',
                      ].filter(Boolean);
                  case 'postgres':
                  case 'kingbase':
                  case 'highgo':
                  case 'vastbase':
                  case 'opengauss':
                  case 'gaussdb': {
                      const schemaRef = safeSchema || 'public';
                      return [`SELECT pg_get_functiondef(p.oid) AS routine_definition FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid WHERE n.nspname = '${schemaRef}' AND p.proname = '${safeName}' LIMIT 1`];
                  }
                  case 'sqlserver':
                      return buildSqlServerObjectDefinitionQueries('routine', targetRoutineName, targetDbName, 'routine_definition');
                  case 'oracle':
                  case 'dm':
                  case 'dameng': {
                      const owner = safeSchema || safeDbName;
                      return [
                          owner
                              ? `SELECT TEXT FROM ALL_SOURCE WHERE OWNER = '${owner.toUpperCase()}' AND NAME = '${safeName.toUpperCase()}' AND TYPE = '${normalizedRoutineType}' ORDER BY LINE`
                              : `SELECT TEXT FROM USER_SOURCE WHERE NAME = '${safeName.toUpperCase()}' AND TYPE = '${normalizedRoutineType}' ORDER BY LINE`,
                      ];
                  }
                  case 'duckdb': {
                      const schemaRef = safeSchema || 'main';
                      return [
                          `SELECT schema_name, function_name, parameters, macro_definition FROM duckdb_functions() WHERE internal = false AND lower(function_type) = 'macro' AND schema_name = '${schemaRef}' AND function_name = '${safeName}' LIMIT 1`,
                      ];
                  }
                  default:
                      return [];
              }
          })();

          for (const queryText of queries) {
              try {
                  const result = await DBQuery(buildRpcConnectionConfig(config) as any, targetDbName, queryText);
                  if (!result.success || !Array.isArray(result.data) || result.data.length === 0) {
                      continue;
                  }
                  let definition = '';
                  if (dialect === 'oracle' || dialect === 'dm' || dialect === 'dameng') {
                      definition = result.data.map((row: any) => row.text || row.TEXT || Object.values(row)[0] || '').join('');
                  } else if (dialect === 'duckdb') {
                      const row = result.data[0] as Record<string, any>;
                      const schemaName = String(getQueryEditorObjectEditRawValue(row, ['schema_name']) || routineSchemaName || '').trim();
                      const functionName = String(getQueryEditorObjectEditRawValue(row, ['function_name', 'routine_name', 'name']) || routineObjectName || '').trim();
                      const parametersRaw = getQueryEditorObjectEditRawValue(row, ['parameters']);
                      const macroDefinition = String(getQueryEditorObjectEditRawValue(row, ['macro_definition']) || '').trim();
                      const parameters = Array.isArray(parametersRaw)
                          ? parametersRaw.map((item) => String(item ?? '').trim()).filter(Boolean).join(', ')
                          : String(parametersRaw ?? '').replace(/^\[|\]$/g, '').trim();
                      const qualifiedName = schemaName ? `${schemaName}.${functionName}` : functionName;
                      if (qualifiedName && macroDefinition) {
                          definition = macroDefinition.startsWith('(')
                              ? `CREATE OR REPLACE MACRO ${qualifiedName}(${parameters}) AS ${macroDefinition};`
                              : `CREATE OR REPLACE MACRO ${qualifiedName}(${parameters}) AS TABLE ${macroDefinition};`;
                      }
                  } else if (dialect === 'sqlserver') {
                      definition = result.data
                          .map((row: any) => getQueryEditorObjectEditRawValue(row, ['routine_definition', 'definition', 'text', 'Text']) ?? '')
                          .map((value) => String(value))
                          .join('');
                  } else {
                      const row = result.data[0] as Record<string, any>;
                      const direct = getQueryEditorObjectEditRawValue(row, ['routine_definition', 'definition']);
                      if (direct !== undefined && direct !== null && String(direct).trim()) {
                          definition = String(direct);
                      } else {
                          const createKey = Object.keys(row).find((key) => /create\s+(function|procedure)/i.test(key));
                          definition = createKey ? String(row[createKey] || '') : '';
                      }
                  }

                  const normalizedDefinition = normalizeQueryEditorRoutineDefinitionForEdit(
                      definition,
                      targetRoutineName,
                      normalizedRoutineType,
                  );
                  if (normalizedDefinition) {
                      editSql = `${sqlTemplateHeader}\n${normalizedDefinition}`;
                      break;
                  }
              } catch {
                  // 查询最新定义失败时保留可编辑模板。
              }
          }
      }

      addTab({
          id: `query-edit-routine-${connectionId}-${targetDbName}-${targetRoutineName}-${Date.now()}`,
          title: translate('sidebar.tab.edit_routine', {
              type: routineTypeLabel,
              name: targetRoutineName,
          }),
          type: 'query',
          connectionId,
          dbName: targetDbName,
          query: editSql,
          queryMode: 'object-edit',
          returnToTabId: activeTabId || undefined,
      });
  }, [activeTabId, addTab]);

  const openDefinitionObjectEditTab = useCallback(async (
      navigationTarget: Extract<QueryEditorNavigationTarget, { type: 'view' | 'materialized-view' | 'sequence' | 'package' }>,
      connectionId: string,
      targetDbName: string,
  ) => {
      const targetSchemaName = String(navigationTarget.schemaName || '').trim();
      const conn = connectionsRef.current.find((item) => item.id === connectionId);
      const dialect = conn ? normalizeMetadataDialect(conn) : '';
      let targetObjectName = '';
      let objectEditName = '';
      let objectLabel = '';
      let definitionTabType: 'view-def' | 'sequence-def' | 'package-def' = 'view-def';
      let definitionQueries: string[] = [];
      let collectAllDefinitionRows = false;
      let latestDefinition = '';

      if (navigationTarget.type === 'view' || navigationTarget.type === 'materialized-view') {
          targetObjectName = String(navigationTarget.viewName || '').trim();
          if (!targetObjectName) return;
          definitionTabType = 'view-def';
          objectEditName = buildQueryEditorQualifiedObjectName(targetObjectName, targetSchemaName);
          objectLabel = navigationTarget.type === 'materialized-view'
              ? translate('definition_viewer.object.materialized_view')
              : translate('definition_viewer.object.view');
          definitionQueries = conn
              ? buildQueryEditorViewDefinitionQueries(
                  dialect,
                  targetObjectName,
                  targetDbName,
                  targetSchemaName,
                  navigationTarget.type === 'materialized-view' ? 'materialized' : 'view',
              )
              : [];
      } else if (navigationTarget.type === 'sequence') {
          targetObjectName = String(navigationTarget.sequenceName || '').trim();
          if (!targetObjectName) return;
          definitionTabType = 'sequence-def';
          objectEditName = buildQueryEditorQualifiedObjectName(targetObjectName, targetSchemaName);
          objectLabel = translate('definition_viewer.object.sequence');
          definitionQueries = conn
              ? buildQueryEditorSequenceDefinitionQueries(dialect, targetObjectName, targetDbName, targetSchemaName)
              : [];
      } else {
          targetObjectName = String(navigationTarget.packageName || '').trim();
          if (!targetObjectName) return;
          definitionTabType = 'package-def';
          objectEditName = buildQueryEditorQualifiedObjectName(targetObjectName, targetSchemaName);
          objectLabel = translate('definition_viewer.object.package');
          collectAllDefinitionRows = true;
          definitionQueries = conn
              ? buildQueryEditorPackageDefinitionQueries(dialect, targetObjectName, targetDbName, targetSchemaName)
              : [];
      }

      if (conn && definitionTabType === 'view-def' && dialect === 'oracle') {
          const result = await DBShowCreateTable(
              buildRpcConnectionConfig(buildQueryEditorObjectDefinitionConnectionConfig(conn)) as any,
              targetDbName,
              objectEditName,
          );
          if (result?.success && String(result.data || '').trim()) {
              latestDefinition = formatDdlForDisplay(String(result.data), dialect);
          }
      } else if (conn && definitionQueries.length > 0) {
          const rows = await runQueryEditorObjectDefinitionCandidates(
              buildQueryEditorObjectDefinitionConnectionConfig(conn),
              targetDbName,
              definitionQueries,
              collectAllDefinitionRows,
          );
          if (definitionTabType === 'view-def') {
              latestDefinition = extractQueryEditorViewDefinition(dialect, rows);
          } else if (definitionTabType === 'sequence-def') {
              latestDefinition = extractQueryEditorSequenceDefinition(rows, targetObjectName, targetSchemaName);
          } else {
              latestDefinition = extractQueryEditorPackageDefinition(rows);
          }
      }

      addTab({
          id: `query-edit-object-${connectionId}-${targetDbName}-${objectEditName}-${Date.now()}`,
          title: translate('definition_viewer.edit.tab_title', {
              object: objectLabel,
              name: objectEditName,
          }),
          type: 'query',
          connectionId,
          dbName: targetDbName,
          query: buildQueryEditorEditableDefinitionSql(
              definitionTabType,
              latestDefinition,
              objectEditName,
              objectLabel,
          ),
          queryMode: 'object-edit',
          returnToTabId: activeTabId || undefined,
      });
  }, [activeTabId, addTab]);

  const openTriggerObjectEditTab = useCallback(async (
      navigationTarget: Extract<QueryEditorNavigationTarget, { type: 'trigger' }>,
      connectionId: string,
      targetDbName: string,
  ) => {
      const targetTriggerName = String(navigationTarget.triggerName || '').trim();
      if (!targetTriggerName) return;

      const conn = connectionsRef.current.find((item) => item.id === connectionId);
      let latestDefinition = '';
      if (conn) {
          const dialect = normalizeMetadataDialect(conn);
          const connectionConfig = buildQueryEditorObjectDefinitionConnectionConfig(conn);
          const triggerTableName = String(navigationTarget.tableName || '').trim();
          if (dialect === 'oracle') {
              if (triggerTableName) {
                  try {
                      const result = await DBGetTriggers(connectionConfig as any, targetDbName, triggerTableName);
                      if (result.success) {
                          latestDefinition = findTriggerDefinitionStatement(result.data, targetTriggerName);
                      }
                  } catch {
                      latestDefinition = '';
                  }
              }
          } else {
              const rows = await runQueryEditorObjectDefinitionCandidates(
                  connectionConfig,
                  targetDbName,
                  buildQueryEditorTriggerDefinitionQueries(
                      dialect,
                      targetTriggerName,
                      targetDbName,
                      navigationTarget.schemaName,
                  ),
              );
              latestDefinition = extractQueryEditorTriggerDefinition(dialect, rows);
          }
      }

      addTab({
          id: `query-edit-trigger-${connectionId}-${targetDbName}-${targetTriggerName}-${Date.now()}`,
          title: translate('trigger_viewer.tab.edit_trigger_title', { name: targetTriggerName }),
          type: 'query',
          connectionId,
          dbName: targetDbName,
          query: buildEditableTriggerSql(targetTriggerName, latestDefinition, { translate }),
          queryMode: 'object-edit',
          returnToTabId: activeTabId || undefined,
      });
  }, [activeTabId, addTab]);

  const handleEditorBeforeMount: BeforeMount = (monaco) => {
      const languageId = 'elasticsearch-console';
      const isRegistered = monaco.languages.getLanguages?.().some((language: any) => language.id === languageId);
      if (!isRegistered) {
          monaco.languages.register({ id: languageId });
          monaco.languages.setLanguageConfiguration(languageId, {
              comments: { lineComment: '#' },
              brackets: [['{', '}'], ['[', ']']],
              autoClosingPairs: [
                  { open: '{', close: '}' },
                  { open: '[', close: ']' },
                  { open: '"', close: '"' },
              ],
          });
          monaco.languages.setMonarchTokensProvider(languageId, {
              tokenizer: {
                  root: [
                      [/^\s*(GET|POST|PUT|DELETE|HEAD)(\s+)(\/\S*)\s*$/, ['keyword', 'white', 'string']],
                      [/^\s*(#|\/\/).*$/, 'comment'],
                      [/"(?:\\.|[^"\\])*"(?=\s*:)/, 'type.identifier'],
                      [/"(?:\\.|[^"\\])*"/, 'string'],
                      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
                      [/\b(?:true|false|null)\b/, 'keyword'],
                      [/[{}\[\]]/, '@brackets'],
                  ],
              },
          });
      }
  };

  // Setup Autocomplete and Editor
  const handleEditorDidMount: OnMount = (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;
      // CompletionItemLabel is rendered by Monaco's DOM suggest widget. Keep
      // the original string label for non-DOM adapters used by older hosts.
      const useStructuredCompletionLabel = typeof editor?.getDomNode?.()?.querySelector === 'function';

      const suggestController = editor.getContribution?.('editor.contrib.suggestController') as {
          widget?: { value?: { _details?: { widget?: { layout?: (width: number, height: number) => void } } } };
      } | null;
      const suggestDetailsWidget = suggestController?.widget?.value?._details?.widget;
      if (suggestDetailsWidget?.layout) {
          const originalSuggestDetailsLayout = suggestDetailsWidget.layout.bind(suggestDetailsWidget);
          suggestDetailsWidget.layout = (width: number, height: number) => {
              originalSuggestDetailsLayout(width, Math.max(height, QUERY_EDITOR_SQL_SNIPPET_SUGGEST_DETAIL_MIN_HEIGHT));
          };
      }
      lastEditorCursorPositionRef.current = normalizeEditorPosition(editor.getPosition?.());
      if (isActive) {
          sharedActiveEditorModelUri = String(editor.getModel?.()?.uri?.toString?.() || '');
      }

      const mountedModel = editor.getModel?.();
      if (mountedModel && typeof monaco?.editor?.setModelLanguage === 'function') {
          monaco.editor.setModelLanguage(mountedModel, queryEditorMonacoLanguage);
      }
      const mountedEditorOptions = buildQueryEditorMonacoOptions(
          isObjectEditQueryTab,
          wordWrapEnabled,
          !isV2Ui,
      );
      editor.updateOptions?.(isElasticsearchMode ? {
          ...mountedEditorOptions,
          quickSuggestions: false,
          suggestOnTriggerCharacters: false,
          inlineSuggest: { enabled: false },
      } : mountedEditorOptions);

      if (isV2Ui && typeof editor.onContextMenu === 'function') {
          editor.onContextMenu(() => {
              decorateV2MonacoContextMenu();
              window.setTimeout(decorateV2MonacoContextMenu, 0);
              window.setTimeout(decorateV2MonacoContextMenu, 48);
              window.setTimeout(decorateV2MonacoContextMenu, 120);
          });
      }

      aiInlineGhostVisibleContextKeyRef.current = editor.createContextKey?.(
          QUERY_EDITOR_AI_INLINE_CONTEXT_KEY,
          false,
      ) || null;

      const clearAiInlineGhostTimer = () => {
          if (aiInlineGhostTimerRef.current !== null) {
              clearTimeout(aiInlineGhostTimerRef.current);
              aiInlineGhostTimerRef.current = null;
          }
      };

      const clearAiInlineGhostDecorations = () => {
          if (aiInlineGhostDecorationIdsRef.current.length === 0) {
              return;
          }
          const nextDecorationIds = editor.deltaDecorations?.(
              aiInlineGhostDecorationIdsRef.current,
              [],
          );
          aiInlineGhostDecorationIdsRef.current = Array.isArray(nextDecorationIds) ? nextDecorationIds : [];
      };

      const clearAiInlineGhost = (cancelRequest = true) => {
          clearAiInlineGhostTimer();
          if (cancelRequest) {
              aiInlineGhostRequestSeqRef.current += 1;
          }
          aiInlineGhostRef.current = null;
          aiInlineGhostVisibleContextKeyRef.current?.set?.(false);
          if (aiInlineGhostOverlayRef.current) {
              aiInlineGhostOverlayRef.current.remove();
              aiInlineGhostOverlayRef.current = null;
          }
          clearAiInlineGhostDecorations();
      };

      const triggerStructuredSqlSuggest = (source: string, defer = false) => {
          const run = () => {
              if (editorRef.current !== editor) {
                  return;
              }
              editor.trigger?.(source, 'editor.action.triggerSuggest', undefined);
          };
          if (defer) {
              window.setTimeout(run, 0);
              return;
          }
          run();
      };

      const didModelContentAcceptCurrentAiInlineGhost = (event: any): boolean => {
          const ghost = aiInlineGhostRef.current;
          if (!ghost?.insertText) {
              return false;
          }
          const changes = Array.isArray(event?.changes) ? event.changes : [];
          return changes.some((change: any) => {
              const changedText = String(change?.text ?? '');
              return changedText === ghost.insertText || changedText === ghost.editText;
          });
      };

      const buildInlineGhostEditorSnapshot = (model: any, position: { lineNumber: number; column: number }): QueryEditorAiEditorSnapshot => {
          const lineContent = String(model.getLineContent?.(position.lineNumber) || '');
          const lineColumnIndex = Math.max(0, Math.min(Number(position.column || 1) - 1, lineContent.length));
          const lineCount = Number(model.getLineCount?.() || position.lineNumber || 1);
          return {
              prefix: String(model.getValueInRange?.(new monaco.Range(1, 1, position.lineNumber, position.column)) || ''),
              suffix: String(model.getValueInRange?.(new monaco.Range(
                  position.lineNumber,
                  position.column,
                  lineCount,
                  Number(model.getLineMaxColumn?.(lineCount) || position.column),
              )) || ''),
              currentLineBeforeCursor: lineContent.slice(0, lineColumnIndex),
              currentLineAfterCursor: lineContent.slice(lineColumnIndex),
          };
      };

      const buildInlineGhostEditorSnapshotFromInsertedTextRemoval = (
          modelText: string,
          rangeOffset: number,
          removedTextLength: number,
      ): QueryEditorAiEditorSnapshot | null => {
          if (!Number.isFinite(rangeOffset)) {
              return null;
          }
          const safeStart = Math.max(0, Math.min(Math.trunc(rangeOffset), modelText.length));
          const safeEnd = Math.max(safeStart, Math.min(safeStart + Math.max(0, removedTextLength), modelText.length));
          const textBeforeInsertion = `${modelText.slice(0, safeStart)}${modelText.slice(safeEnd)}`;
          const prefix = textBeforeInsertion.slice(0, safeStart);
          const suffix = textBeforeInsertion.slice(safeStart);
          const lineStart = Math.max(0, prefix.lastIndexOf('\n') + 1);
          const nextLineBreak = textBeforeInsertion.indexOf('\n', safeStart);
          const lineEnd = nextLineBreak === -1 ? textBeforeInsertion.length : nextLineBreak;
          return {
              prefix,
              suffix,
              currentLineBeforeCursor: prefix.slice(lineStart).replace(/\r/g, ''),
              currentLineAfterCursor: textBeforeInsertion.slice(safeStart, lineEnd).replace(/\r/g, ''),
          };
      };

      const recoverStrayManualSqlCompletionMarker = (
          model: any,
          position: { lineNumber: number; column: number },
          snapshot: QueryEditorAiEditorSnapshot,
      ): {
          position: { lineNumber: number; column: number };
          snapshot: QueryEditorAiEditorSnapshot;
          recovered: boolean;
      } => {
          const prefix = String(snapshot.prefix || '');
          const lineBeforeCursor = String(snapshot.currentLineBeforeCursor || '');
          if (!prefix.endsWith('\\') || !lineBeforeCursor.endsWith('\\')) {
              return { position, snapshot, recovered: false };
          }

          const sanitizedSnapshot: QueryEditorAiEditorSnapshot = {
              prefix: prefix.slice(0, -1),
              suffix: String(snapshot.suffix || ''),
              currentLineBeforeCursor: lineBeforeCursor.slice(0, -1),
              currentLineAfterCursor: String(snapshot.currentLineAfterCursor || ''),
          };
          const intent = resolveQueryEditorInlineCompletionIntentDetails(sanitizedSnapshot);
          if (intent.intent !== 'table_name' && intent.intent !== 'column_name') {
              return { position, snapshot, recovered: false };
          }

          const startColumn = Math.max(1, position.column - 1);
          const startPosition = { lineNumber: position.lineNumber, column: startColumn };
          editor.executeEdits?.('gonavi-manual-sql-ai-strip-marker', [{
              range: new monaco.Range(
                  position.lineNumber,
                  startColumn,
                  position.lineNumber,
                  position.column,
              ),
              text: '',
              forceMoveMarkers: true,
          }]);
          editor.setPosition?.(startPosition);
          syncQueryDraft(getEditorText());

          return {
              position: startPosition,
              snapshot: buildInlineGhostEditorSnapshot(model, startPosition),
              recovered: true,
          };
      };

      const isInlineGhostSnapshotCurrent = (
          model: any,
          position: { lineNumber: number; column: number },
          snapshot: QueryEditorAiEditorSnapshot,
      ): boolean => {
          const currentSnapshot = buildInlineGhostEditorSnapshot(model, position);
          return currentSnapshot.prefix === snapshot.prefix
              && currentSnapshot.suffix === snapshot.suffix
              && currentSnapshot.currentLineBeforeCursor === snapshot.currentLineBeforeCursor
              && currentSnapshot.currentLineAfterCursor === snapshot.currentLineAfterCursor;
      };

      const renderAiInlineGhost = (
          model: any,
          position: { lineNumber: number; column: number },
          insertText: string,
          snapshot: QueryEditorAiEditorSnapshot,
          edit?: QueryEditorInlineCompletionEdit,
      ) => {
          const resolvedEdit = edit || {
              previewText: insertText,
              editText: insertText,
              replacePrefixLength: 0,
          };
          const previewText = resolveInlineSqlGhostPreviewText(resolvedEdit.previewText);
          if (!previewText) {
              clearAiInlineGhost(false);
              return;
          }

          const modelUri = String(model?.uri?.toString?.() || '');
          aiInlineGhostRef.current = {
              insertText: resolvedEdit.previewText,
              editText: resolvedEdit.editText,
              replacePrefixLength: resolvedEdit.replacePrefixLength,
              modelUri,
              position,
              snapshot,
          };
          clearAiInlineGhostDecorations();
          const visiblePosition = editor.getScrolledVisiblePosition?.(position);
          const editorDomNode = editor.getDomNode?.();
          if (!visiblePosition || !editorDomNode) {
              clearAiInlineGhost(false);
              return;
          }

          const overlay = aiInlineGhostOverlayRef.current || document.createElement('span');
          if (!aiInlineGhostOverlayRef.current) {
              overlay.className = 'gonavi-query-editor-ai-inline-ghost-overlay';
              editorDomNode.appendChild(overlay);
              aiInlineGhostOverlayRef.current = overlay;
          }

          const fontInfoOption = monaco.editor?.EditorOption?.fontInfo;
          const fontInfo = fontInfoOption !== undefined ? editor.getOption?.(fontInfoOption) : null;
          overlay.textContent = previewText;
          overlay.style.left = `${Math.max(0, visiblePosition.left)}px`;
          overlay.style.top = `${Math.max(0, visiblePosition.top)}px`;
          overlay.style.height = `${Math.max(1, visiblePosition.height || fontInfo?.lineHeight || 20)}px`;
          overlay.style.lineHeight = `${Math.max(1, visiblePosition.height || fontInfo?.lineHeight || 20)}px`;
          if (fontInfo) {
              overlay.style.fontFamily = String(fontInfo.fontFamily || '');
              overlay.style.fontSize = `${Number(fontInfo.fontSize || 14)}px`;
              overlay.style.fontWeight = String(fontInfo.fontWeight || 'normal');
          }
          aiInlineGhostVisibleContextKeyRef.current?.set?.(true);
      };

      const acceptAiInlineGhost = (): boolean => {
          const ghost = aiInlineGhostRef.current;
          const model = editor.getModel?.();
          const position = normalizeEditorPosition(editor.getPosition?.());
          if (!ghost || !model || !position) {
              return false;
          }
          const modelUri = String(model?.uri?.toString?.() || '');
          if (
              ghost.modelUri !== modelUri
              || ghost.position.lineNumber !== position.lineNumber
              || ghost.position.column !== position.column
              || !isInlineGhostSnapshotCurrent(model, position, ghost.snapshot)
          ) {
              clearAiInlineGhost();
              return false;
          }

          aiInlineGhostAcceptingRef.current = true;
          try {
              editor.pushUndoStop?.();
              const replacePrefixLength = Math.max(
                  0,
                  Math.min(ghost.replacePrefixLength, Math.max(0, position.column - 1)),
              );
              const editStartPosition = {
                  lineNumber: position.lineNumber,
                  column: position.column - replacePrefixLength,
              };
              const startOffset = typeof model.getOffsetAt === 'function'
                  ? Number(model.getOffsetAt(editStartPosition))
                  : Number.NaN;
              editor.executeEdits?.('gonavi-ai-inline-sql-completion', [{
                  range: new monaco.Range(
                      editStartPosition.lineNumber,
                      editStartPosition.column,
                      position.lineNumber,
                      position.column,
                  ),
                  text: ghost.editText,
                  forceMoveMarkers: true,
              }]);
              editor.pushUndoStop?.();
              syncQueryDraft(String(editor.getValue?.() ?? model.getValue?.() ?? ''));
              if (Number.isFinite(startOffset) && typeof model.getPositionAt === 'function') {
                  const nextPosition = normalizeEditorPosition(model.getPositionAt(startOffset + ghost.editText.length));
                  if (nextPosition) {
                      editor.setPosition?.(nextPosition);
                  }
              }
          } finally {
              aiInlineGhostAcceptingRef.current = false;
              clearAiInlineGhost();
          }
          requestAiInlineGhost(0);
          return true;
      };

      const requestAiInlineGhost = (delayMs: number, focusEditor = false, manualTrigger = false) => {
          clearAiInlineGhost();
          if (aiInlineGhostAcceptingRef.current || editorRef.current !== editor) {
              return;
          }
          if (focusEditor) {
              editor.focus?.();
          }

          const model = editor.getModel?.();
          let position = normalizeEditorPosition(editor.getPosition?.());
          if (!model || !position) {
              return;
          }
          if (String(model.getLanguageId?.() || '') === 'elasticsearch-console') {
              return;
          }

          const modelUri = String(model?.uri?.toString?.() || '');
          if (modelUri && sharedActiveEditorModelUri && modelUri !== sharedActiveEditorModelUri) {
              return;
          }

          let editorSnapshot = buildInlineGhostEditorSnapshot(model, position);
          if (manualTrigger) {
              const normalizedState = recoverStrayManualSqlCompletionMarker(model, position, editorSnapshot);
              position = normalizedState.position;
              editorSnapshot = normalizedState.snapshot;
          }
          const intent = resolveQueryEditorInlineCompletionIntentDetails(editorSnapshot);
          const shouldUseInlineMemory = manualTrigger || intent.intent !== 'general_sql';
          let memoryInsertText = '';
          if (shouldUseInlineMemory) {
              const initialAiContext = buildQueryEditorAiContext();
              memoryInsertText = resolveQueryEditorInlineMemoryInsertText({
                  editorSnapshot,
                  memoryEntries: inlineSqlMemoryEntries,
                  sourceType: initialAiContext.sourceType,
              });
              // Empty fragments do not need metadata-based case correction and retain
              // the previous immediate memory-completion behavior.
              if (memoryInsertText.trim() && !intent.fragment) {
                  const memoryEdit = resolveQueryEditorInlineCompletionEdit({
                      aiContext: initialAiContext,
                      editorSnapshot,
                      insertText: memoryInsertText,
                  });
                  renderAiInlineGhost(model, position, memoryEdit.previewText, editorSnapshot, memoryEdit);
                  return;
              }
          }
          const requestId = ++aiInlineGhostRequestSeqRef.current;
          const runRequest = () => {
              if (aiInlineGhostTimerRef.current !== null) {
                  aiInlineGhostTimerRef.current = null;
              }
          void (async () => {
                  if (
                      requestId !== aiInlineGhostRequestSeqRef.current
                      || editorRef.current !== editor
                  ) {
                      return;
                  }
                  try {
                      if (shouldUseInlineMemory) {
                          if (!memoryInsertText.trim()) {
                              const initialAiContext = buildQueryEditorAiContext();
                              memoryInsertText = resolveQueryEditorInlineMemoryInsertText({
                                  editorSnapshot,
                                  memoryEntries: inlineSqlMemoryEntries,
                                  sourceType: initialAiContext.sourceType,
                              });
                          }
                          if (memoryInsertText.trim()) {
                              if (
                                  (intent.intent === 'table_name' || intent.intent === 'column_name')
                                  && intent.fragment
                              ) {
                                  await ensureQueryEditorAiContextMetadata(editorSnapshot);
                                  if (
                                      requestId !== aiInlineGhostRequestSeqRef.current
                                      || editorRef.current !== editor
                                  ) {
                                      return;
                                  }
                              }
                              const aiContext = buildQueryEditorAiContext();
                              const memoryEdit = resolveQueryEditorInlineCompletionEdit({
                                  aiContext,
                                  editorSnapshot,
                                  insertText: memoryInsertText,
                              });
                              renderAiInlineGhost(model, position, memoryEdit.previewText, editorSnapshot, memoryEdit);
                              return;
                          }
                      }
                      if (!shouldRequestQueryEditorInlineCompletion(editorSnapshot)) {
                          return;
                      }
                      const aiContext = buildQueryEditorAiContext();
                      const localCompletion = resolveQueryEditorInlineLocalCompletion({
                          aiContext,
                          editorSnapshot,
                          deferEmptySchemaCompletion: true,
                      });
                      if (localCompletion.handled) {
                          if (localCompletion.insertText.trim()) {
                              const localEdit = resolveQueryEditorInlineCompletionEdit({
                                  aiContext,
                                  editorSnapshot,
                                  insertText: localCompletion.insertText,
                              });
                              renderAiInlineGhost(model, position, localEdit.previewText, editorSnapshot, localEdit);
                          }
                          return;
                      }
                      const aiService = getQueryEditorAiService();
                      const readiness = await resolveQueryEditorInlineRuntimeReadiness(aiService);
                      if (
                          !readiness.ready
                          || requestId !== aiInlineGhostRequestSeqRef.current
                          || editorRef.current !== editor
                      ) {
                          return;
                      }
                      await ensureQueryEditorAiContextMetadata(editorSnapshot);
                      if (
                          requestId !== aiInlineGhostRequestSeqRef.current
                          || editorRef.current !== editor
                      ) {
                          return;
                      }
                      const insertText = await requestQueryEditorInlineCompletion({
                          service: aiService,
                          aiContext: buildQueryEditorAiContext(),
                          editorSnapshot,
                      });
                      const currentPosition = normalizeEditorPosition(editor.getPosition?.());
                      if (
                          requestId !== aiInlineGhostRequestSeqRef.current
                          || !currentPosition
                          || currentPosition.lineNumber !== position.lineNumber
                          || currentPosition.column !== position.column
                          || !isInlineGhostSnapshotCurrent(model, currentPosition, editorSnapshot)
                          ) {
                          return;
                      }
                      if (!insertText.trim()) {
                          // Keep the manual AI action on the AI path; silently downgrading to plain suggest is misleading.
                          if (!manualTrigger && (intent.intent === 'table_name' || intent.intent === 'column_name')) {
                              const shouldTriggerStructuredSuggest = shouldTriggerQueryEditorInlineObjectSuggestFallback({
                                  aiContext: buildQueryEditorAiContext(),
                                  editorSnapshot,
                              });
                              if (shouldTriggerStructuredSuggest) {
                                  triggerStructuredSqlSuggest('gonavi-ai-inline-auto', true);
                              }
                          }
                          return;
                      }
                      const inlineEdit = resolveQueryEditorInlineCompletionEdit({
                          aiContext: buildQueryEditorAiContext(),
                          editorSnapshot,
                          insertText,
                      });
                      renderAiInlineGhost(model, position, inlineEdit.previewText, editorSnapshot, inlineEdit);
                  } catch (error) {
                      console.warn('GoNavi AI inline SQL ghost failed', error);
                  }
              })();
          };

          if (delayMs > 0) {
              aiInlineGhostTimerRef.current = setTimeout(runRequest, delayMs);
              return;
          }
          runRequest();
      };

      const scheduleAiInlineGhost = () => {
          requestAiInlineGhost(QUERY_EDITOR_AI_INLINE_DEBOUNCE_MS);
      };

      triggerAiInlineCompletionRef.current = () => {
          requestAiInlineGhost(0, true, true);
      };
      acceptAiInlineCompletionRef.current = () => acceptAiInlineGhost();
      acceptSqlAiCompletionKeydownDisposableRef.current?.dispose?.();
      acceptSqlAiCompletionKeydownDisposableRef.current = editor.onKeyDown((event: any) => {
          if (!queryEditorActiveRef.current) {
              return;
          }
          const binding = acceptSqlAiCompletionBindingRef.current;
          if (!binding?.enabled || !binding?.combo) {
              return;
          }
          const browserEvent = event?.browserEvent || event?.event || event;
          if (!browserEvent) {
              return;
          }
          if (!isShortcutMatch(browserEvent, binding.combo)) {
              return;
          }
          // 接受成功才拦截按键;幽灵不存在或已过期时返回 false,键走默认行为。
          if (acceptAiInlineCompletionRef.current?.() === true) {
              event?.preventDefault?.();
              event?.stopPropagation?.();
              browserEvent.preventDefault?.();
              browserEvent.stopPropagation?.();
          }
      });

      if (monaco?.KeyCode?.RightArrow) {
          editor.addCommand?.(
              monaco.KeyCode.RightArrow,
              () => {
                  void editor.getAction?.('editor.action.inlineSuggest.commit')?.run?.();
              },
              'inlineSuggestionVisible',
          );
      }

      const repositionAiInlineGhost = () => {
          const ghost = aiInlineGhostRef.current;
          const model = editor.getModel?.();
          if (!ghost || !model) {
              return;
          }
          const modelUri = String(model?.uri?.toString?.() || '');
          if (ghost.modelUri !== modelUri) {
              clearAiInlineGhost();
              return;
          }
          renderAiInlineGhost(model, ghost.position, ghost.insertText, ghost.snapshot, {
              previewText: ghost.insertText,
              editText: ghost.editText,
              replacePrefixLength: ghost.replacePrefixLength,
          });
      };

      const applyNavigationHoverStateAtPosition = (targetPosition: { lineNumber: number; column: number } | null) => {
          if (!ctrlMetaPressedRef.current) {
              clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
              editor.updateOptions?.({ mouseStyle: 'text' });
              setQueryEditorMouseCursor(editor, '');
              return;
          }
          if (!targetPosition) {
              clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
              editor.updateOptions?.({ mouseStyle: 'text' });
              setQueryEditorMouseCursor(editor, '');
              return;
          }
          const model = editor.getModel?.();
          const lineContent = String(model?.getLineContent?.(targetPosition.lineNumber) || '');
          const decorations = resolveQueryEditorNavigationDecorations(
              lineContent,
              targetPosition.column,
              currentDbRef.current,
              visibleDbsRef.current,
              tablesRef.current,
              viewsRef.current,
              materializedViewsRef.current,
              triggersRef.current,
              routinesRef.current,
              sequencesRef.current,
              packagesRef.current,
              primaryShortcutModifierLabel,
          );
          if (decorations.length === 0) {
              clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
              editor.updateOptions?.({ mouseStyle: 'text' });
              setQueryEditorMouseCursor(editor, '');
              return;
          }
          linkDecorationIdsRef.current = editor.deltaDecorations(
              linkDecorationIdsRef.current,
              decorations.map((item) => ({
                  range: new monaco.Range(
                      targetPosition.lineNumber,
                      item.startColumn,
                      targetPosition.lineNumber,
                      item.endColumn,
                  ),
                  options: {
                      inlineClassName: 'gonavi-query-editor-link-hint',
                  },
              })),
          );
          setQueryEditorMouseCursor(editor, 'pointer');
      };

      const applyNavigationHoverState = (event: any) => {
          const targetPosition = normalizeEditorPosition(event?.target?.position);
          lastHoverTargetPositionRef.current = targetPosition;
          if (!ctrlMetaPressedRef.current) {
              return;
          }
          applyNavigationHoverStateAtPosition(targetPosition);
      };

      const syncModifierState = (keyboardEvent?: KeyboardEvent | MouseEvent | null) => {
          const wasPressed = ctrlMetaPressedRef.current;
          const isKeyboardLikeEvent = keyboardEvent
              && typeof keyboardEvent === 'object'
              && ('key' in keyboardEvent || 'code' in keyboardEvent || 'repeat' in keyboardEvent);
          if (isKeyboardLikeEvent && isImeComposingKeyEvent(keyboardEvent as KeyboardEvent)) {
              return;
          }
          const keyboardEventType = isKeyboardLikeEvent ? String((keyboardEvent as KeyboardEvent).type || '').toLowerCase() : '';
          const keyboardKey = isKeyboardLikeEvent ? String((keyboardEvent as KeyboardEvent).key || '').trim().toLowerCase() : '';
          const keyboardCode = isKeyboardLikeEvent ? String((keyboardEvent as KeyboardEvent).code || '').trim().toLowerCase() : '';
          const isModifierKeyDown = isKeyboardLikeEvent
              && keyboardEventType !== 'keyup'
              && (
                  keyboardKey === 'control'
                  || keyboardKey === 'ctrl'
                  || keyboardKey === 'meta'
                  || keyboardKey === 'os'
                  || keyboardKey === 'command'
                  || keyboardCode.startsWith('control')
                  || keyboardCode.startsWith('meta')
                  || keyboardCode.startsWith('os')
              );
          const eventHasModifierFlag = hasQueryEditorCtrlMetaModifier(keyboardEvent);
          const nextPressed = isKeyboardLikeEvent
              ? !!(eventHasModifierFlag || isModifierKeyDown)
              : !!(eventHasModifierFlag || wasPressed);
          ctrlMetaPressedRef.current = nextPressed;
          if (!nextPressed && !wasPressed) {
              return;
          }
          if (!nextPressed) {
              clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
              editor.updateOptions?.({ mouseStyle: 'text' });
              setQueryEditorMouseCursor(editor, '');
              return;
          }
          if (!wasPressed || isKeyboardLikeEvent) {
              const keyboardFallbackPosition = isKeyboardLikeEvent
                  ? normalizeEditorPosition(editor.getPosition?.()) || lastEditorCursorPositionRef.current
                  : null;
              applyNavigationHoverStateAtPosition(lastHoverTargetPositionRef.current || keyboardFallbackPosition);
          }
      };
      const handleWindowBlur = () => {
          ctrlMetaPressedRef.current = false;
          clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
          editor.updateOptions?.({ mouseStyle: 'text' });
          setQueryEditorMouseCursor(editor, '');
      };
      const editorDomNode = editor.getDomNode?.();
      const clearImeCompositionFallbackTimer = () => {
          if (imeCompositionFallbackTimerRef.current !== null) {
              clearTimeout(imeCompositionFallbackTimerRef.current);
              imeCompositionFallbackTimerRef.current = null;
          }
      };
      const getEditorText = () => String(
          editor.getValue?.()
          ?? editor.getModel?.()?.getValue?.()
          ?? '',
      );
      const buildImeFallbackRange = (snapshot: NonNullable<typeof imeCompositionFallbackRef.current>) => {
          const selection = snapshot.selectionBefore;
          const startFromSelection = typeof selection?.getStartPosition === 'function'
              ? normalizeEditorPosition(selection.getStartPosition())
              : null;
          const endFromSelection = typeof selection?.getEndPosition === 'function'
              ? normalizeEditorPosition(selection.getEndPosition())
              : null;
          const startPosition = startFromSelection || normalizeEditorPosition({
              lineNumber: selection?.startLineNumber ?? selection?.selectionStartLineNumber,
              column: selection?.startColumn ?? selection?.selectionStartColumn,
          }) || snapshot.positionBefore || lastEditorCursorPositionRef.current || { lineNumber: 1, column: 1 };
          const endPosition = endFromSelection || normalizeEditorPosition({
              lineNumber: selection?.endLineNumber ?? selection?.positionLineNumber,
              column: selection?.endColumn ?? selection?.positionColumn,
          }) || startPosition;
          return new monaco.Range(
              startPosition.lineNumber,
              startPosition.column,
              endPosition.lineNumber,
              endPosition.column,
          );
      };
      const handleImeCompositionStart = () => {
          clearImeCompositionFallbackTimer();
          imeCompositionFallbackRef.current = {
              editor,
              valueBefore: getEditorText(),
              selectionBefore: editor.getSelection?.() || null,
              positionBefore: normalizeEditorPosition(editor.getPosition?.()) || lastEditorCursorPositionRef.current || null,
              committedText: '',
          };
      };
      const handleImeBeforeInput = (rawEvent: Event) => {
          const snapshot = imeCompositionFallbackRef.current;
          if (!snapshot || snapshot.editor !== editor) {
              return;
          }
          const inputEvent = rawEvent as InputEvent;
          const nextText = String(inputEvent.data ?? '');
          if (nextText && (inputEvent.isComposing || String(inputEvent.inputType || '').includes('Composition'))) {
              snapshot.committedText = nextText;
          }
      };
      const handleImeCompositionEnd = (rawEvent: Event) => {
          const snapshot = imeCompositionFallbackRef.current;
          imeCompositionFallbackRef.current = null;
          const committedText = String((rawEvent as CompositionEvent).data ?? '') || snapshot?.committedText || '';
          if (!committedText || !snapshot || snapshot.editor !== editor) {
              return;
          }

          const fallbackRange = buildImeFallbackRange(snapshot);
          clearImeCompositionFallbackTimer();
          imeCompositionFallbackTimerRef.current = setTimeout(() => {
              imeCompositionFallbackTimerRef.current = null;
              if (editorRef.current !== editor) {
                  return;
              }
              const currentValue = getEditorText();
              if (currentValue !== snapshot.valueBefore) {
                  syncQueryDraft(currentValue);
                  return;
              }

              editor.executeEdits?.('gonavi-ime-composition-fallback', [{
                  range: fallbackRange,
                  text: committedText,
                  forceMoveMarkers: true,
              }]);
              const nextValue = getEditorText();
              syncQueryDraft(nextValue);

              const model = editor.getModel?.();
              const startOffset = Number(model?.getOffsetAt?.({
                  lineNumber: fallbackRange.startLineNumber,
                  column: fallbackRange.startColumn,
              }));
              const nextPosition = Number.isFinite(startOffset)
                  ? normalizeEditorPosition(model?.getPositionAt?.(startOffset + committedText.length))
                  : null;
              if (nextPosition) {
                  editor.setPosition?.(nextPosition);
              }
          }, QUERY_EDITOR_IME_FALLBACK_DELAY_MS);
      };
      const handleEditorDragOver = (rawEvent: Event) => {
          const event = rawEvent as DragEvent;
          if (!hasSidebarSqlEditorDragPayload(event.dataTransfer)) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer) {
              event.dataTransfer.dropEffect = 'copy';
          }
          if (hasSqlFieldDragPayload(event.dataTransfer)) {
              const dropPosition = resolveSqlFieldDropPosition(editor, event);
              if (dropPosition) {
                  editor.setPosition?.(dropPosition);
                  lastEditorCursorPositionRef.current = dropPosition;
                  updateSqlFieldDropPreview(editor, dropPosition);
                  editor.render?.(false);
              } else {
                  clearSqlFieldDropPreview(editor);
              }
          }
      };
      const handleEditorDragLeave = (rawEvent: Event) => {
          const relatedTarget = (rawEvent as DragEvent).relatedTarget as Node | null;
          if (relatedTarget && editorDomNode?.contains?.(relatedTarget)) return;
          clearSqlFieldDropPreview(editor);
      };
      const handleSqlFieldDragEnd = () => {
          clearSqlFieldDropPreview(editor);
      };
      const handleEditorDrop = (rawEvent: Event) => {
          handleSidebarObjectDrop(rawEvent as DragEvent);
      };

      // 应用透明主题（主题由 MonacoEditor 包装组件按需注册）
      monaco.editor.setTheme(darkMode ? 'transparent-dark' : 'transparent-light');

      objectHoverActionRef.current?.dispose?.();
      const showObjectInfoKeybinding = monaco.KeyMod?.CtrlCmd && monaco.KeyCode?.KeyQ
          ? [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyQ]
          : undefined;
      objectHoverActionRef.current = editor.addAction({
          id: 'gonavi.queryEditor.showObjectInfo',
          label: buildQueryEditorMonacoActionLabel('query_editor.action.show_object_info'),
          keybindings: showObjectInfoKeybinding,
          run: () => {
              const preferredPosition = lastHoverTargetPositionRef.current || editor.getPosition?.();
              const shown = showObjectInfoAtPosition(preferredPosition);
              if (!shown) {
                  void message.info({
                      key: 'gonavi-query-editor-object-info-miss',
                      content: translate('query_editor.message.object_info_target_not_found'),
                  });
              }
          },
      });

      editor.onDidChangeCursorPosition?.((event: any) => {
          const position = normalizeEditorPosition(event?.position);
          if (position) {
              lastEditorCursorPositionRef.current = position;
          }
          const ghost = aiInlineGhostRef.current;
          if (
              ghost
              && (!position
                  || ghost.position.lineNumber !== position.lineNumber
                  || ghost.position.column !== position.column)
          ) {
              clearAiInlineGhost();
          }
      });

      const recoverTriggerSqlAiCompletionFallback = (event: any): boolean => {
          if (triggerSqlAiCompletionFallbackApplyingRef.current) {
              return true;
          }

          const pending = triggerSqlAiCompletionFallbackRef.current;
          const altGestureAge = Date.now() - Number(triggerSqlAiCompletionAltGestureAtRef.current || 0);
          const hasRecentAltGesture = altGestureAge >= 0 && altGestureAge <= 1200;
          const changes = Array.isArray(event?.changes) ? event.changes : [];
          const backslashChange = changes.find((change: any) => String(change?.text ?? '') === '\\');
          if (!backslashChange) {
              if (pending && (Date.now() - pending.observedAt) > 1200) {
                  triggerSqlAiCompletionFallbackRef.current = null;
              }
              return false;
          }

          const model = editor.getModel?.();
          if (!model || typeof model.getOffsetAt !== 'function' || typeof model.getValue !== 'function') {
              return false;
          }

          let markerOffset = Number.NaN;
          let startPosition = normalizeEditorPosition(backslashChange?.range
              ? {
                  lineNumber: Number(backslashChange.range.startLineNumber || 1),
                  column: Number(backslashChange.range.startColumn || 1),
              }
              : null);
          let endPosition = normalizeEditorPosition(backslashChange?.range
              ? {
                  lineNumber: Number(backslashChange.range.endLineNumber || 1),
                  column: Number(backslashChange.range.endColumn || 1),
              }
              : null);

          const rangeOffset = Number(backslashChange?.rangeOffset);
          if (Number.isFinite(rangeOffset)) {
              markerOffset = rangeOffset;
          } else if (startPosition) {
              markerOffset = Number(model.getOffsetAt(startPosition));
          } else {
              const currentPosition = normalizeEditorPosition(editor.getPosition?.());
              const currentOffset = currentPosition ? Number(model.getOffsetAt(currentPosition)) : Number.NaN;
              if (Number.isFinite(currentOffset) && currentOffset > 0) {
                  markerOffset = currentOffset - 1;
              }
          }

          if (!Number.isFinite(markerOffset) || markerOffset < 0) {
              return false;
          }
          const currentModelText = String(model?.getValue?.() ?? '');
          if (currentModelText.slice(markerOffset, markerOffset + 1) !== '\\') {
              return false;
          }
          startPosition = normalizeEditorPosition(model?.getPositionAt?.(markerOffset));
          endPosition = normalizeEditorPosition(model?.getPositionAt?.(markerOffset + 1));
          const fallbackSnapshot = buildInlineGhostEditorSnapshotFromInsertedTextRemoval(
              currentModelText,
              markerOffset,
              1,
          );
          const fallbackIntent = fallbackSnapshot
              ? resolveQueryEditorInlineCompletionIntentDetails(fallbackSnapshot)
              : null;
          const hasStructuredSqlCompletionContext = fallbackIntent?.intent === 'table_name'
              || fallbackIntent?.intent === 'column_name';
          if (!pending && !hasRecentAltGesture && !hasStructuredSqlCompletionContext) {
              return false;
          }
          if (pending && (Date.now() - pending.observedAt) > 1200) {
              triggerSqlAiCompletionFallbackRef.current = null;
              if (!hasRecentAltGesture && !hasStructuredSqlCompletionContext) {
                  return false;
              }
          }

          if (!startPosition || !endPosition) {
              return false;
          }

          triggerSqlAiCompletionFallbackRef.current = null;
          triggerSqlAiCompletionFallbackApplyingRef.current = true;
          try {
              editor.executeEdits?.('gonavi-trigger-sql-ai-completion-fallback', [{
                  range: new monaco.Range(
                      startPosition.lineNumber,
                      startPosition.column,
                      endPosition.lineNumber,
                      endPosition.column,
                  ),
                  text: '',
                  forceMoveMarkers: true,
              }]);
              editor.setPosition?.(startPosition);
              syncQueryDraft(getEditorText());
          } finally {
              triggerSqlAiCompletionFallbackApplyingRef.current = false;
          }
          triggerAiInlineCompletionRef.current?.();
          return true;
      };

      editor.onDidChangeModelContent?.((event: any) => {
          if (recoverTriggerSqlAiCompletionFallback(event)) {
              return;
          }
          if (imeCompositionFallbackTimerRef.current !== null) {
              clearImeCompositionFallbackTimer();
              syncQueryDraft(getEditorText());
          }
          const hasSlashCommandMarker = Array.isArray(event?.changes)
              && event.changes.some((change: any) => /__AI_\w+__/.test(String(change?.text || '')));
          if (hasSlashCommandMarker) {
              refreshObjectDecorations(QUERY_EDITOR_LIVE_DECORATION_MAX_TEXT_LENGTH);
          }
          // SQL 文本变更后，按引用库集合防抖触发跨库元数据拉取（db.table / schema.table / db.schema.table）
          if (sqlReferencedMetadataTimerRef.current !== null) {
              window.clearTimeout(sqlReferencedMetadataTimerRef.current);
          }
          sqlReferencedMetadataTimerRef.current = window.setTimeout(() => {
              sqlReferencedMetadataTimerRef.current = null;
              if (editorRef.current !== editor) {
                  return;
              }
              const modelText = String(editor.getModel?.()?.getValue?.() || '');
              const referencedDbs = collectQueryEditorReferencedDatabaseNames(
                  modelText,
                  currentDbRef.current || '',
                  visibleDbsRef.current,
              );
              const nextKey = [
                  String(currentConnectionIdRef.current || '').trim(),
                  ...referencedDbs.map((dbName) => String(dbName || '').toLowerCase()).sort(),
              ].join('\u0000');
              if (nextKey === lastSqlReferencedMetadataKeyRef.current) {
                  return;
              }
              lastSqlReferencedMetadataKeyRef.current = nextKey;
              setSqlReferencedMetadataKey(nextKey);
          }, 450);
          const acceptedCurrentAiGhost = !aiInlineGhostAcceptingRef.current
              && didModelContentAcceptCurrentAiInlineGhost(event);
          if (acceptedCurrentAiGhost) {
              clearAiInlineGhost(false);
              window.setTimeout(() => {
                  if (editorRef.current !== editor) {
                      return;
                  }
                  requestAiInlineGhost(0);
              }, 0);
              return;
          }
          if (!aiInlineGhostAcceptingRef.current) {
              scheduleAiInlineGhost();
          }
      });

      // 滚动/布局事件可达每帧多次，rAF 合并避免高频 DOM 重排。
      let repositionAiInlineGhostRafId: number | null = null;
      const scheduleRepositionAiInlineGhost = () => {
          if (!aiInlineGhostRef.current || repositionAiInlineGhostRafId !== null) {
              return;
          }
          repositionAiInlineGhostRafId = window.requestAnimationFrame(() => {
              repositionAiInlineGhostRafId = null;
              if (editorRef.current !== editor) {
                  return;
              }
              repositionAiInlineGhost();
          });
      };

      editor.onDidScrollChange?.(() => {
          scheduleRepositionAiInlineGhost();
      });
      editor.onDidLayoutChange?.(() => {
          scheduleRepositionAiInlineGhost();
      });

      editor.onMouseMove?.((event: any) => {
          syncModifierState(event?.event || null);
          applyNavigationHoverState(event);
      });
      editor.onMouseLeave?.(() => {
          lastHoverTargetPositionRef.current = null;
          clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
          editor.updateOptions?.({ mouseStyle: 'text' });
          setQueryEditorMouseCursor(editor, '');
      });

      window.addEventListener('keydown', syncModifierState);
      window.addEventListener('keyup', syncModifierState);
      window.addEventListener('blur', handleWindowBlur);
      window.addEventListener('dragend', handleSqlFieldDragEnd);
      window.addEventListener('drop', handleSqlFieldDragEnd);
      editorDomNode?.addEventListener('beforeinput', handleImeBeforeInput, true);
      editorDomNode?.addEventListener('compositionstart', handleImeCompositionStart, true);
      editorDomNode?.addEventListener('compositionend', handleImeCompositionEnd, true);
      editorDomNode?.addEventListener('dragover', handleEditorDragOver, true);
      editorDomNode?.addEventListener('dragleave', handleEditorDragLeave, true);
      editorDomNode?.addEventListener('drop', handleEditorDrop, true);

      editor.onMouseDown?.((event: any) => {
          const browserEvent = event?.event;
          const targetPosition = normalizeEditorPosition(event?.target?.position);
          if (!browserEvent || !targetPosition) {
              return;
          }
          if (!isQueryEditorPrimaryMouseButton(browserEvent)) {
              return;
          }
          if (!hasQueryEditorCtrlMetaModifier(browserEvent) && !ctrlMetaPressedRef.current) {
              return;
          }

          const model = editor.getModel?.();
          const lineContent = String(model?.getLineContent?.(targetPosition.lineNumber) || '');
          const navigationTarget = resolveQueryEditorNavigationTarget(
              lineContent,
              targetPosition.column,
              currentDbRef.current,
              visibleDbsRef.current,
              tablesRef.current,
              viewsRef.current,
              materializedViewsRef.current,
              triggersRef.current,
              routinesRef.current,
              sequencesRef.current,
              packagesRef.current,
          );
          if (!navigationTarget) {
              return;
          }

          browserEvent.preventDefault?.();
          browserEvent.stopPropagation?.();

          const connectionId = String(currentConnectionIdRef.current || '').trim();
          if (!connectionId) {
              return;
          }

          if (navigationTarget.type === 'database') {
              const nextDbName = String(navigationTarget.dbName || '').trim();
              if (!nextDbName) {
                  return;
              }
              if (!switchQueryContext(connectionId, nextDbName)) {
                  return;
              }
              return;
          }

          const targetDbName = String(navigationTarget.dbName || '').trim();
          if (!targetDbName) {
              return;
          }

          if (navigationTarget.type === 'table') {
              const targetTableName = String(navigationTarget.tableName || '').trim();
              if (!targetTableName) return;
              const openTableTab = () => {
                  addTab({
                      id: `${connectionId}-${targetDbName}-table-${targetTableName}`,
                      title: targetTableName,
                      type: 'table',
                      connectionId,
                      dbName: targetDbName,
                      tableName: targetTableName,
                      initialViewMode: 'fields',
                      initialViewModeRequestId: String(Date.now()),
                      objectType: 'table',
                      returnToTabId: activeTabId || undefined,
                  });
              };
              const navigationContextVersion = tableNavigationContextRef.current.version;
              const navigationActionKey = [
                  connectionId,
                  targetDbName,
                  normalizeCompletionQualifiedName(targetTableName),
                  navigationContextVersion,
              ].join('\u0000');
              if (tableNavigationActionInFlightRef.current[navigationActionKey]) {
                  return;
              }
              const isCurrentNavigationEditor = () => {
                  if (editorRef.current !== editor) {
                      return false;
                  }
                  try {
                      return Boolean(editor.getModel?.());
                  } catch {
                      return false;
                  }
              };
              const navigationAction = (async () => {
                  const targetExists = await validateTableNavigationTarget(
                      connectionId,
                      targetDbName,
                      targetTableName,
                      navigationContextVersion,
                  );
                  if (
                      !queryEditorMountedRef.current
                      || !queryEditorActiveRef.current
                      || String(currentConnectionIdRef.current || '').trim() !== connectionId
                      || tableNavigationContextRef.current.version !== navigationContextVersion
                      || !isCurrentNavigationEditor()
                  ) {
                      return;
                  }
                  if (targetExists === null) {
                      openTableTab();
                      return;
                  }
                  if (targetExists) {
                      missingTableMetadataKeysRef.current.delete(
                          buildQueryEditorTableTargetKey(connectionId, targetDbName, targetTableName),
                      );
                      openTableTab();
                      return;
                  }

                  clearMissingTableNavigationMetadata(connectionId, targetDbName, targetTableName);
                  lastHoverTargetPositionRef.current = null;
                  clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
                  editor.updateOptions?.({ mouseStyle: 'text' });
                  setQueryEditorMouseCursor(editor, '');
                  void message.warning(translate('query_editor.message.table_navigation_target_missing', {
                      table: targetTableName,
                  }));
              })();
              tableNavigationActionInFlightRef.current[navigationActionKey] = navigationAction;
              void navigationAction
                  .catch((error) => {
                      console.warn('GoNavi table navigation handling failed', error);
                  })
                  .finally(() => {
                      if (tableNavigationActionInFlightRef.current[navigationActionKey] === navigationAction) {
                          delete tableNavigationActionInFlightRef.current[navigationActionKey];
                      }
                  });
              return;
          }

          if (navigationTarget.type === 'view' || navigationTarget.type === 'materialized-view') {
              void openDefinitionObjectEditTab(navigationTarget, connectionId, targetDbName);
              return;
          }

          if (navigationTarget.type === 'trigger') {
              void openTriggerObjectEditTab(navigationTarget, connectionId, targetDbName);
              return;
          }

          if (navigationTarget.type === 'sequence') {
              void openDefinitionObjectEditTab(navigationTarget, connectionId, targetDbName);
              return;
          }

          if (navigationTarget.type === 'package') {
              void openDefinitionObjectEditTab(navigationTarget, connectionId, targetDbName);
              return;
          }

          void openRoutineObjectEditTab(navigationTarget, connectionId, targetDbName);
      });

      editor.onDidDispose?.(() => {
          clearQueryEditorLinkDecorations(editor, linkDecorationIdsRef);
          clearQueryEditorObjectDecorations(editor, objectDecorationIdsRef);
          clearSqlFieldDropPreview(editor);
          setQueryEditorMouseCursor(editor, '');
          objectHoverActionRef.current?.dispose?.();
          objectHoverActionRef.current = null;
          triggerSqlAiCompletionActionRef.current?.dispose?.();
          triggerSqlAiCompletionActionRef.current = null;
          macFindWithSelectionGuardActionRef.current?.dispose?.();
          macFindWithSelectionGuardActionRef.current = null;
          triggerSqlAiCompletionKeydownDisposableRef.current?.dispose?.();
          triggerSqlAiCompletionKeydownDisposableRef.current = null;
          triggerAiInlineCompletionRef.current = null;
          acceptAiInlineCompletionRef.current = null;
          acceptSqlAiCompletionKeydownDisposableRef.current?.dispose?.();
          acceptSqlAiCompletionKeydownDisposableRef.current = null;
          const disposedModelUri = String(editor.getModel?.()?.uri?.toString?.() || '');
          if (disposedModelUri && sharedActiveEditorModelUri === disposedModelUri) {
              sharedActiveEditorModelUri = '';
          }
          disposeQueryEditorAiContextMenuActions();
          disposeTransformCaseContextMenuActions();
          window.removeEventListener('keydown', syncModifierState);
          window.removeEventListener('keyup', syncModifierState);
          window.removeEventListener('blur', handleWindowBlur);
          window.removeEventListener('dragend', handleSqlFieldDragEnd);
          window.removeEventListener('drop', handleSqlFieldDragEnd);
          clearImeCompositionFallbackTimer();
          editorDomNode?.removeEventListener('beforeinput', handleImeBeforeInput, true);
          editorDomNode?.removeEventListener('compositionstart', handleImeCompositionStart, true);
          editorDomNode?.removeEventListener('compositionend', handleImeCompositionEnd, true);
          editorDomNode?.removeEventListener('dragover', handleEditorDragOver, true);
          editorDomNode?.removeEventListener('dragleave', handleEditorDragLeave, true);
          editorDomNode?.removeEventListener('drop', handleEditorDrop, true);
      });

      refreshObjectDecorations();

      // 注册 AI 右键菜单操作
      registerQueryEditorAiContextMenuActions(editor);
      registerInsertSqlSnippetContextMenuAction(editor);
      registerTransformCaseContextMenuActions(editor);
      registerTriggerSqlAiCompletionAction(editor, monaco);

      // Register runQuery shortcut inside Monaco so it overrides Monaco's default keybinding
      const runBinding = runQueryShortcutBinding;
      if (runBinding?.enabled && runBinding.combo) {
          const keyBinding = comboToMonacoKeyBinding(
              runBinding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
          );
          if (keyBinding) {
              runQueryActionRef.current = editor.addAction({
                  id: 'gonavi.runQuery',
                  label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.runQuery.label'),
                  keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                  keybindingContext: 'editorTextFocus',
                  run: () => {
                      window.dispatchEvent(new CustomEvent('gonavi:run-active-query', {
                          detail: { requireSelection: true },
                      }));
                  },
              });
          }
      }

      const selectStatementBinding = selectCurrentStatementShortcutBinding;
      if (selectStatementBinding?.enabled && selectStatementBinding.combo) {
          const keyBinding = comboToMonacoKeyBinding(
              selectStatementBinding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
          );
          if (keyBinding) {
              selectCurrentStatementActionRef.current = editor.addAction({
                  id: 'gonavi.selectCurrentStatement',
                  label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.selectCurrentStatement.label'),
                  keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                  run: handleSelectCurrentStatement,
              });
          }
      }

      const macFindWithSelectionGuardKeyBinding = activeShortcutPlatform === 'mac'
          ? comboToMonacoKeyBinding(
              QUERY_EDITOR_MAC_FIND_WITH_SELECTION_COMBO, monaco.KeyMod, monaco.KeyCode,
              activeShortcutPlatform,
          )
          : null;
      if (macFindWithSelectionGuardKeyBinding) {
          macFindWithSelectionGuardActionRef.current = editor.addAction({
              id: QUERY_EDITOR_MAC_FIND_WITH_SELECTION_GUARD_ACTION_ID,
              label: 'GoNavi: Suppress macOS Cmd+E Find with Selection',
              keybindings: [
                  macFindWithSelectionGuardKeyBinding.keyMod
                  | macFindWithSelectionGuardKeyBinding.keyCode,
              ],
              run: () => {
                  if (
                      selectStatementBinding?.enabled
                      && normalizeShortcutCombo(selectStatementBinding.combo) === QUERY_EDITOR_MAC_FIND_WITH_SELECTION_COMBO
                  ) {
                      void handleSelectCurrentStatement();
                  }
              },
          });
      }

      const duplicateLineBinding = duplicateCurrentLineShortcutBinding;
      if (duplicateLineBinding?.enabled && duplicateLineBinding.combo) {
          const keyBinding = comboToMonacoKeyBinding(
              duplicateLineBinding.combo, monaco.KeyMod, monaco.KeyCode,
              activeShortcutPlatform,
          );
          if (keyBinding) {
              duplicateCurrentLineActionRef.current = editor.addAction({
                  id: 'gonavi.duplicateCurrentLine',
                  label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.duplicateCurrentLine.label'),
                  keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                  run: handleDuplicateCurrentLine,
              });
          }
      }

      const saveBinding = saveQueryShortcutBinding;
      if (saveBinding?.enabled && saveBinding.combo) {
          const keyBinding = comboToMonacoKeyBinding(
              saveBinding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
          );
          if (keyBinding) {
              saveQueryActionRef.current = editor.addAction({
                  id: 'gonavi.saveQuery',
                  label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.saveQuery.label'),
                  keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                  run: () => {
                      window.dispatchEvent(new CustomEvent('gonavi:save-active-query'));
                  },
              });
          }
      }

      const saveAsBinding = saveQueryAsShortcutBinding;
      if (currentSavedQuery && !tab.filePath && saveAsBinding?.enabled && saveAsBinding.combo) {
          const keyBinding = comboToMonacoKeyBinding(
              saveAsBinding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
          );
          if (keyBinding) {
              saveQueryAsActionRef.current = editor.addAction({
                  id: 'gonavi.saveQueryAs',
                  label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.saveQueryAs.label'),
                  keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                  run: () => {
                      window.dispatchEvent(new CustomEvent('gonavi:save-active-query-as'));
                  },
              });
          }
      }

      const findInEditorKeyBinding = comboToMonacoKeyBinding(
          findInEditorShortcutCombo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
      );
      if (findInEditorKeyBinding) {
          findInEditorActionRef.current = editor.addAction({
              id: 'gonavi.findInEditor',
              label: buildQueryEditorMonacoActionLabel('query_editor.action.find_in_editor'),
              keybindings: [findInEditorKeyBinding.keyMod | findInEditorKeyBinding.keyCode],
              run: () => {
                  window.dispatchEvent(new CustomEvent('gonavi:find-active-query'));
              },
          });
      }

      const formatBinding = formatSqlShortcutBinding;
      if (formatBinding?.enabled && formatBinding.combo) {
          const keyBinding = comboToMonacoKeyBinding(
              formatBinding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
          );
          if (keyBinding) {
              formatSqlActionRef.current = editor.addAction({
                  id: 'gonavi.formatSql',
                  label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.formatSql.label'),
                  keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                  run: () => {
                      window.dispatchEvent(new CustomEvent('gonavi:format-active-query'));
                  },
              });
          }
      }

      // 注册 / 斜杠命令 AI 快捷补全
      refreshQueryEditorSlashCommandDefs();
      const toggleResultsBinding = toggleQueryResultsPanelShortcutBinding;
      if (toggleResultsBinding?.enabled && toggleResultsBinding.combo) {
          const keyBinding = comboToMonacoKeyBinding(
              toggleResultsBinding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
          );
          if (keyBinding) {
              toggleQueryResultsPanelActionRef.current = editor.addAction({
                  id: 'gonavi.toggleQueryResultsPanel',
                  label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.toggleQueryResultsPanel.label'),
                  keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                  run: toggleResultPanelVisibility,
              });
          }
      }

      // HMR 重载或测试重置时，以全局状态为准，避免本地闭包状态和 provider 列表不同步。
      sqlCompletionRegistered = Boolean(_g.__gonaviSqlCompletionState.registered);
      sqlCompletionDisposables = _g.__gonaviSqlCompletionState.disposables;
      const shouldRegisterSqlCompletion = !sqlCompletionRegistered
          || _g.__gonaviSqlCompletionState.version !== SQL_COMPLETION_PROVIDER_VERSION;

      // HMR 重载时释放旧注册避免补全项重复
      if (shouldRegisterSqlCompletion) {
      sqlCompletionRegistered = true;
      _g.__gonaviSqlCompletionState.registered = true;
      _g.__gonaviSqlCompletionState.version = SQL_COMPLETION_PROVIDER_VERSION;
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
      registerQueryEditorHoverProvider({
          provideHover: (model: any, position: any) => {
              const normalizedPosition = normalizeEditorPosition(position);
              if (!normalizedPosition) {
                  return null;
              }
              const lineContent = String(model?.getLineContent?.(normalizedPosition.lineNumber) || '');
              const resolveText = getQueryEditorObjectResolveText(model, lineContent);
              const hoverTarget = resolveQueryEditorHoverTarget(
                  resolveText,
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
      });
      registerQueryEditorCompletionProvider({
          triggerCharacters: ['.'],
          provideCompletionItems: async (model: any, position: any, _context?: any, token?: { isCancellationRequested?: boolean }) => {
              if (isSqlCompletionRequestCancelled(token)) {
                  return createEmptySqlCompletionResult();
              }
              const word = model.getWordUntilPosition(position);
              const range = {
                  startLineNumber: position.lineNumber,
                  endLineNumber: position.lineNumber,
                  startColumn: word.startColumn,
                  endColumn: word.endColumn,
              };
              const activeConnection = sharedConnections.find(c => c.id === sharedCurrentConnectionId);
              const activeDialect = resolveSqlDialect(
                  String(activeConnection?.config?.type || ''),
                  String(activeConnection?.config?.driver || ''),
                  { oceanBaseProtocol: activeConnection?.config?.oceanBaseProtocol },
              );
              const oracleLoginOwner = isOracleLikeDialect(activeDialect)
                  ? resolveOracleLikeDefaultSchemaName(activeConnection?.config)
                  : '';
              const shouldQuoteCompletionIdentifiers = isPostgresSchemaDialect(activeDialect);
              const quoteCompletionPart = (ident: string) => {
                  const raw = String(ident || '').trim();
                  if (!raw) return raw;
                  return shouldQuoteCompletionIdentifiers ? quoteIdentPart(activeDialect, raw) : raw;
              };
              const quoteCompletionPath = (ident: string) => {
                  const raw = String(ident || '').trim();
                  if (!raw) return raw;
                  return shouldQuoteCompletionIdentifiers ? quoteQualifiedIdent(activeDialect, raw) : raw;
              };
              const applyCompletionFragmentCase = (ident: string, fragment: string) => (
                  shouldQuoteCompletionIdentifiers
                      ? ident
                      : applyQueryEditorCompletionFragmentCase(ident, fragment)
              );
              const getActiveCompletionDbName = () => String(sharedCurrentDb || currentDbRef.current || currentDb || tab.dbName || '').trim();
              const getActiveCompletionSchemaName = () => (
                  isPostgresSchemaDialect(activeDialect)
                      ? String(sharedCurrentSchema || '').trim()
                      : ''
              );
              const dialectKeywords = resolveSqlKeywords(activeDialect);
              const dialectFunctions = resolveSqlFunctions(activeDialect);

              const stripQuotes = stripCompletionIdentifierQuotes;
              const normalizeQualifiedName = normalizeCompletionQualifiedName;
              const splitSchemaAndTable = splitCompletionSchemaAndTable;
              const buildDbQualifiedTableSuggestionMeta = (dbName: string, tableName: string) => {
                  const rawDbName = String(dbName || '').trim();
                  const rawTableName = String(tableName || '').trim();
                  const parsed = splitSchemaAndTable(rawTableName, rawDbName);
                  const schemaMatchesDb = !!parsed.schema
                      && !!parsed.table
                      && parsed.schema.toLowerCase() === rawDbName.toLowerCase();
                  const displayName = schemaMatchesDb ? parsed.table : rawTableName;
                  const insertName = schemaMatchesDb ? parsed.table : rawTableName;
                  const insertText = schemaMatchesDb
                      ? quoteCompletionPart(insertName)
                      : quoteCompletionPath(insertName);
                  const dbQualifiedLabel = rawDbName
                      ? `${rawDbName}.${displayName || rawTableName}`
                      : (displayName || rawTableName);
                  return {
                      displayName: displayName || rawTableName,
                      insertName,
                      insertText,
                      dbQualifiedLabel,
                  };
              };
              const buildTableSuggestion = (
                  label: string,
                  detailPrefix: string,
                  comment?: string,
                  filterPrefix = '',
                  filterCandidates: readonly string[] = [label],
              ) => ({
                  label: buildQueryEditorTableSuggestionLabel(
                      label,
                      appendCommentToDetail(detailPrefix, comment),
                      useStructuredCompletionLabel,
                  ),
                  filterText: resolveQueryEditorCompletionFilterText(filterPrefix, filterCandidates)
                      || normalizeQueryEditorTableSuggestionText(label),
              });
              const normalizeRoutineType = (routineType: string) => (
                  String(routineType || '').trim().toUpperCase().includes('PROC') ? 'PROCEDURE' : 'FUNCTION'
              );
              const getRoutineTypeLabel = (routineType: string) => (
                  normalizeRoutineType(routineType) === 'PROCEDURE'
                      ? translate('sidebar.object.procedure')
                      : translate('sidebar.object.function')
              );
              const buildRoutineSuggestionMeta = (routine: CompletionRoutineMeta) => {
                  const rawDbName = String(routine.dbName || '').trim();
                  const rawRoutineName = String(routine.routineName || '').trim();
                  const parsed = splitSchemaAndTable(rawRoutineName, rawDbName);
                  const schemaName = String(routine.schemaName || parsed.schema || '').trim();
                  const objectName = String(parsed.table || rawRoutineName).trim();
                  const schemaMatchesDb = !!schemaName
                      && !!rawDbName
                      && schemaName.toLowerCase() === rawDbName.toLowerCase();
                  const isCurrentDb = rawDbName.toLowerCase() === getActiveCompletionDbName().toLowerCase();
                  const displayName = isCurrentDb && schemaMatchesDb
                      ? objectName
                      : (parsed.schema ? rawRoutineName : objectName);
                  const dbQualifiedLabel = rawDbName && !isCurrentDb
                      ? `${rawDbName}.${displayName}`
                      : displayName;
                  const insertName = rawDbName && !isCurrentDb
                      ? dbQualifiedLabel
                      : displayName;
                  return {
                      displayName,
                      dbQualifiedLabel,
                      insertText: `${quoteCompletionPath(insertName)}($0)`,
                      objectName,
                      schemaName,
                      routineType: normalizeRoutineType(routine.routineType),
                  };
              };
              const getViewTypeLabel = (materialized: boolean) => (
                  materialized
                      ? translate('query_editor.object_info.materialized_view')
                      : translate('sidebar.object.view')
              );
              const buildViewSuggestionMeta = (view: CompletionViewMeta) => {
                  const rawDbName = String(view.dbName || '').trim();
                  const rawViewName = String(view.viewName || '').trim();
                  const parsed = splitSchemaAndTable(rawViewName, rawDbName);
                  const schemaName = String(view.schemaName || parsed.schema || '').trim();
                  const objectName = String(parsed.table || rawViewName).trim();
                  const schemaMatchesDb = !!schemaName
                      && !!rawDbName
                      && schemaName.toLowerCase() === rawDbName.toLowerCase();
                  const isCurrentDb = rawDbName.toLowerCase() === getActiveCompletionDbName().toLowerCase();
                  const schemaQualifiedName = schemaName && !schemaMatchesDb
                      ? `${schemaName}.${objectName}`
                      : objectName;
                  const displayName = isCurrentDb && schemaMatchesDb
                      ? objectName
                      : schemaQualifiedName;
                  const dbQualifiedLabel = rawDbName && !isCurrentDb
                      ? `${rawDbName}.${displayName}`
                      : displayName;
                  const insertName = rawDbName && !isCurrentDb
                      ? dbQualifiedLabel
                      : displayName;
                  return {
                      displayName,
                      dbQualifiedLabel,
                      insertText: quoteCompletionPath(insertName),
                      objectName,
                      schemaName,
                  };
              };
              const getViewSuggestionScope = (view: CompletionViewMeta, meta: ReturnType<typeof buildViewSuggestionMeta>) => {
                  const dbName = String(view.dbName || '').trim();
                  const schemaName = String(meta.schemaName || '').trim();
                  if (!schemaName || schemaName.toLowerCase() === dbName.toLowerCase()) {
                      return dbName;
                  }
                  return dbName ? `${dbName}.${schemaName}` : schemaName;
              };
              const getSynonymTargetName = (synonym: CompletionSynonymMeta) => {
                  const targetSchemaName = String(synonym.targetSchemaName || '').trim();
                  const targetName = String(synonym.targetName || '').trim();
                  return targetSchemaName && targetName ? `${targetSchemaName}.${targetName}` : targetName;
              };
              const buildSynonymSuggestion = (synonym: CompletionSynonymMeta, sortText: string) => {
                  const synonymName = String(synonym.synonymName || '').trim();
                  const targetName = getSynonymTargetName(synonym);
                  return {
                      label: synonymName,
                      kind: monaco.languages.CompletionItemKind.Class,
                      insertText: quoteCompletionPath(synonymName),
                      detail: targetName
                          ? `${translate('query_editor.object_info.synonym')} (${targetName})`
                          : translate('query_editor.object_info.synonym'),
                      range,
                      sortText,
                  };
              };
              const buildConnConfig = () => {
                  const connId = sharedCurrentConnectionId;
                  const conn = sharedConnections.find(c => c.id === connId);
                  if (!conn) return null;
                  return {
                      ...conn.config,
                      port: Number(conn.config.port),
                      password: conn.config.password || "",
                      database: conn.config.database || "",
                      useSSH: conn.config.useSSH || false,
                      ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
                  };
              };

              const getLazyTablesByDB = async (dbName: string) => {
                  const connId = sharedCurrentConnectionId;
                  if (!connId || !dbName) return [] as CompletionTableMeta[];
                  const cacheKey = `${connId}|${dbName}`;
                  if (sharedLazyTablesCache[cacheKey]) {
                      return sharedLazyTablesCache[cacheKey];
                  }
                  const conn = sharedConnections.find(c => c.id === connId);
                  if (!conn) return [] as CompletionTableMeta[];
                  const metadataSnapshot: QueryEditorMetadataRequestSnapshot = {
                      generation: sharedQueryEditorMetadataGeneration,
                      connectionId: connId,
                      connectionConfig: conn.config,
                  };
                  const metadataContextKey = sharedQueryEditorMetadataContextKey;
                  const inFlightKey = `${cacheKey}|${metadataSnapshot.generation}`;
                  if (sharedLazyTablesInFlight[inFlightKey]) {
                      return sharedLazyTablesInFlight[inFlightKey];
                  }

                  const config = buildConnConfig();
                  if (!config) return [] as CompletionTableMeta[];

                  const request = Promise.all([
                      fetchCompletionTableCommentMap(config, dbName, normalizeMetadataDialect(conn)),
                      DBGetTables(buildRpcConnectionConfig(config) as any, dbName),
                  ])
                      .then(([tableComments, res]) => {
                          if (!isSharedQueryEditorMetadataRequestCurrent(metadataSnapshot, metadataContextKey)) {
                              return [];
                          }
                          const tables = res?.success && Array.isArray(res.data)
                              ? res.data
                                  .map((row: any) => buildCompletionTableMeta(dbName, row, tableComments))
                                  .filter((table): table is CompletionTableMeta => !!table)
                              : [];
                          sharedLazyTablesCache[cacheKey] = tables;
                          if (tables.length > 0) {
                              const lazyTableByKey = new Map(tables.map((table) => [
                                  `${table.dbName.toLowerCase()}.${table.tableName.toLowerCase()}`,
                                  table,
                              ]));
                              const existingKeys = new Set<string>();
                              let changed = false;
                              const nextSharedTables = sharedTablesData.map((table) => {
                                  const tableKey = `${table.dbName.toLowerCase()}.${table.tableName.toLowerCase()}`;
                                  existingKeys.add(tableKey);
                                  const lazyTable = lazyTableByKey.get(tableKey);
                                  if (lazyTable?.comment && lazyTable.comment !== table.comment) {
                                      changed = true;
                                      return { ...table, comment: lazyTable.comment };
                                  }
                                  return table;
                              });
                              const missingTables = tables.filter((table) => !existingKeys.has(`${table.dbName.toLowerCase()}.${table.tableName.toLowerCase()}`));
                              if (missingTables.length > 0) {
                                  changed = true;
                                  nextSharedTables.push(...missingTables);
                              }
                              if (changed) {
                                  sharedTablesData = nextSharedTables;
                              }
                          }
                          return tables;
                      })
                      .catch(() => [])
                      .finally(() => {
                          if (sharedLazyTablesInFlight[inFlightKey] === request) {
                              delete sharedLazyTablesInFlight[inFlightKey];
                          }
                      });
                  sharedLazyTablesInFlight[inFlightKey] = request;
                  return request;
              };

              const toCompletionColumns = (
                  columns: ColumnDefinition[],
                  dbName: string,
                  tableName: string,
              ): CompletionColumnMeta[] => dedupeCompletionColumnsByName(columns
                  .map((column) => ({
                      dbName,
                      tableName,
                      name: getColumnDefinitionName(column),
                      type: getColumnDefinitionType(column),
                      comment: getColumnDefinitionComment(column),
                  }))
                  .filter((column) => !!column.name));

              const findPreloadedColumns = (dbName: string, tableName: string) =>
                  findSharedPreloadedColumns(dbName, tableName);

              const mergeSharedCompletionColumns = (columns: CompletionColumnMeta[]) => {
                  if (columns.length === 0) return;
                  const existingKeys = new Set(sharedAllColumnsData.map((column) => [
                      String(column.dbName || '').toLowerCase(),
                      String(column.tableName || '').toLowerCase(),
                      String(column.name || '').toLowerCase(),
                  ].join('\u0000')));
                  const missing = columns.filter((column) => {
                      const key = [
                          String(column.dbName || '').toLowerCase(),
                          String(column.tableName || '').toLowerCase(),
                          String(column.name || '').toLowerCase(),
                      ].join('\u0000');
                      if (existingKeys.has(key)) return false;
                      existingKeys.add(key);
                      return true;
                  });
                  if (missing.length > 0) {
                      sharedAllColumnsData = [...sharedAllColumnsData, ...missing];
                  }
              };

              const findCompletionSynonym = (
                  tableIdent: string,
                  explicitOwnerName = '',
              ): CompletionSynonymMeta | undefined => {
                  const parsed = splitSchemaAndTable(tableIdent);
                  const synonymName = String(parsed.table || tableIdent).trim().toLowerCase();
                  if (!synonymName) return undefined;
                  const matches = sharedSynonymsData.filter((synonym) => (
                      String(synonym.synonymName || '').trim().toLowerCase() === synonymName
                  ));
                  if (matches.length === 0) return undefined;

                  const explicitOwner = String(explicitOwnerName || parsed.schema || '').trim().toLowerCase();
                  if (explicitOwner) {
                      return matches.find((synonym) => String(synonym.ownerName || '').trim().toLowerCase() === explicitOwner);
                  }

                  const loginOwner = oracleLoginOwner.trim().toLowerCase();
                  return matches.find((synonym) => String(synonym.ownerName || '').trim().toLowerCase() === loginOwner)
                      || matches.find((synonym) => String(synonym.ownerName || '').trim().toLowerCase() === 'public');
              };

              const getCompletionColumnsByTable = async (
                  dbName: string,
                  tableIdent: string,
                  explicitOwnerName = '',
              ) => {
                  const connId = sharedCurrentConnectionId;
                  const targetDb = String(dbName || '').trim();
                  const targetTable = String(tableIdent || '').trim();
                  if (!connId || !targetDb || !targetTable) return [] as CompletionColumnMeta[];

                  const synonym = findCompletionSynonym(targetTable, explicitOwnerName);
                  const lookupDbName = String(synonym?.ownerName || targetDb).trim();
                  const lookupTableName = String(synonym?.synonymName || targetTable).trim();
                  const preloaded = synonym ? [] : findPreloadedColumns(targetDb, targetTable);
                  if (preloaded.length > 0) {
                      return preloaded;
                  }

                  const key = `${connId}|${lookupDbName}|${lookupTableName}`;
                  const cached = sharedColumnsCacheData[key] as ColumnDefinition[] | undefined;
                  if (cached) {
                      const cachedColumns = toCompletionColumns(cached, targetDb, targetTable);
                      mergeSharedCompletionColumns(cachedColumns);
                      return cachedColumns;
                  }

                  const config = buildConnConfig();
                  if (!config) return [] as CompletionColumnMeta[];
                  const conn = sharedConnections.find(c => c.id === connId);
                  if (!conn) return [] as CompletionColumnMeta[];
                  const metadataSnapshot: QueryEditorMetadataRequestSnapshot = {
                      generation: sharedQueryEditorMetadataGeneration,
                      connectionId: connId,
                      connectionConfig: conn.config,
                  };
                  const metadataContextKey = sharedQueryEditorMetadataContextKey;

                  const res = await DBGetColumns(buildRpcConnectionConfig(config) as any, lookupDbName, lookupTableName);
                  if (!isSharedQueryEditorMetadataRequestCurrent(metadataSnapshot, metadataContextKey)) {
                      return [] as CompletionColumnMeta[];
                  }
                  if (res?.success && Array.isArray(res.data)) {
                      const cols = res.data as ColumnDefinition[];
                      sharedColumnsCacheData[key] = cols;
                      const completionColumns = toCompletionColumns(cols, targetDb, targetTable);
                      mergeSharedCompletionColumns(completionColumns);
                      return completionColumns;
                  }
                  return [] as CompletionColumnMeta[];
              };

              const fullText = model.getValue();
              const cursorOffset = getNormalizedOffsetAtPosition(fullText, {
                  lineNumber: Number(position?.lineNumber || 1),
                  column: Number(position?.column || 1),
              });
              const currentStatementRange = resolveCurrentSqlStatementRange(fullText, cursorOffset, activeDialect);

              // 获取当前行光标前的内容
              const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
              const currentStatementPrefix = currentStatementRange
                  ? fullText.slice(currentStatementRange.start, cursorOffset)
                  : fullText.slice(0, cursorOffset);
              const completionScopeText = currentStatementPrefix || linePrefix;
              const currentStatementText = currentStatementRange?.text || '';
              const completionReferenceText = currentStatementText || completionScopeText;

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

              // 1) 两段式 qualifier.xxx 格式
              const qualifierMatch = linePrefix.match(QUERY_EDITOR_SQL_QUALIFIER_COMPLETION_REGEX);
              if (qualifierMatch) {
                  const qualifier = stripQuotes(qualifierMatch[1]);
                  const rawPrefix = String(qualifierMatch[2] || '');
                  const prefix = rawPrefix.toLowerCase();
                  const qualifierLower = qualifier.toLowerCase();

                  // 首先检查 qualifier 是否是数据库名（跨库表提示）
                  const visibleDbs = sharedVisibleDbs;
                  if (visibleDbs.some(db => db.toLowerCase() === qualifierLower)) {
                      // qualifier 是数据库名，提示该库的表
                      let tables = findCompletionTablesByDatabase(sharedTablesData, qualifier);
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
                              if (String(table.dbName || '').toLowerCase() !== qualifierLower) return null;
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
                                  insertText: quoteCompletionPath(applyCompletionFragmentCase(meta.insertName, rawPrefix)),
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
                                  if (String(view.dbName || '').toLowerCase() !== qualifierLower) return null;
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
                              String(synonym.ownerName || '').trim().toLowerCase() === qualifierLower
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
                              if (String(routine.dbName || '').toLowerCase() !== qualifierLower) return null;
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

                  // qualifier 是 schema（如 dbo/public）时，仅补全表名，避免输入 dbo. 后再补成 dbo.dbo.table
                  let hasKnownSchemaQualifier = false;
                  const schemaTableBatch = createBoundedQueryEditorCompletionCandidateBatch<CompletionTableMeta, any>({
                      candidates: sharedTablesData,
                      prefix,
                      getMatchRank: (table, normalizedPrefix) => {
                          const parsed = splitSchemaAndTable(table.tableName || '', table.dbName);
                          if (parsed.schema.toLowerCase() !== qualifierLower) return null;
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
                              insertText: quoteCompletionPart(applyCompletionFragmentCase(parsed.table, rawPrefix)),
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
                              if (meta.schemaName.toLowerCase() !== qualifierLower) return null;
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
                          if (String(synonym.ownerName || '').trim().toLowerCase() !== qualifierLower) return null;
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
                          if (meta.schemaName.toLowerCase() !== qualifierLower) return null;
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

                  // 否则检查是否是表别名或表名，提示列
                  const aliasMap = buildQueryEditorAliasMap(completionReferenceText, sharedCurrentDb || '');

                  const tableInfo = aliasMap[qualifier.toLowerCase()];
                  if (tableInfo) {
                      const cols = await getCompletionColumnsByTable(
                          tableInfo.dbName,
                          tableInfo.tableName,
                          tableInfo.explicitOwnerName,
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
              }

              // 2) global/table/column completion
              const foundTables = new Set<string>();
              for (const reference of collectQueryEditorTableReferences(completionReferenceText)) {
                  const t = normalizeQualifiedName(reference.tableIdent);
                  if (!t) continue;
                  // 存储完整标识 db.table 或 table
                  foundTables.add(t.toLowerCase());
              }

              const currentDatabase = getActiveCompletionDbName();
              const isCurrentCompletionDatabase = (dbName: string) =>
                  String(dbName || '').toLowerCase() === currentDatabase.toLowerCase();
              const rawWordPrefix = String(word.word || '');
              const wordPrefix = rawWordPrefix.toLowerCase();
              const getPrefixMatchRank = (...candidates: string[]) => {
                  if (!wordPrefix) return '0';
                  const matchRank = rankQueryEditorCompletionCandidate(wordPrefix, candidates);
                  return matchRank === null ? '9' : String(matchRank);
              };
              const expectsTableName = isQueryEditorTableSourceCompletionContext(completionScopeText)
                  || /\b(?:TABLE|DESCRIBE|DESC|EXPLAIN)\s+[`"]?[\w.]*$/i.test(linePrefix);
              const expectsRoutineName = /\bCALL\s+[`"]?[\w.]*$/i.test(linePrefix);
              const matchesKeywordPrefix = wordPrefix.length > 0
                  && dialectKeywords.some((keyword) => keyword.toLowerCase().startsWith(wordPrefix));
              const statementPrefixBeforeWord = currentStatementPrefix.slice(
                  0,
                  Math.max(0, currentStatementPrefix.length - String(word.word || '').length),
              );
              const isNewStatementKeywordContext = !expectsTableName
                  && !expectsRoutineName
                  && matchesKeywordPrefix
                  && !statementPrefixBeforeWord.trim();
              const shouldBoostKeywords = !expectsTableName
                  && !expectsRoutineName
                  && matchesKeywordPrefix;
              const sortGroups = isNewStatementKeywordContext
                  ? { keyword: '00', func: '10', routineCurrent: '11', routineOther: '12', tableCurrent: '20', tableOther: '21', columnCurrent: '30', columnOther: '31', db: '40' }
                  : shouldBoostKeywords
                  ? { keyword: '00', func: '05', routineCurrent: '06', routineOther: '07', columnCurrent: '10', columnOther: '11', tableCurrent: '20', tableOther: '21', db: '30' }
                  : expectsRoutineName
                      ? { keyword: '30', func: '40', routineCurrent: '00', routineOther: '01', columnCurrent: '20', columnOther: '21', tableCurrent: '10', tableOther: '11', db: '35' }
                  : expectsTableName
                      ? { keyword: '20', func: '25', routineCurrent: '26', routineOther: '27', columnCurrent: '10', columnOther: '11', tableCurrent: '00', tableOther: '01', db: '30' }
                      : { keyword: '30', func: '25', routineCurrent: '26', routineOther: '27', columnCurrent: '00', columnOther: '01', tableCurrent: '10', tableOther: '11', db: '20' };
              let completionTables = sharedTablesData;
              const currentSharedTables = expectsTableName && currentDatabase
                  ? findCompletionTablesByDatabase(sharedTablesData, currentDatabase)
                  : [];
              if (
                  expectsTableName
                  && currentDatabase
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
                  && currentDatabase
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
              if (expectsTableName && currentDatabase) {
                  completionTables = findCompletionTablesByDatabase(completionTables, currentDatabase);
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
                  const aliasMapForReferencedTables = buildQueryEditorAliasMap(completionReferenceText, currentDatabase);
                  const seenReferencedTables = new Set<string>();
                  for (const tableInfo of Object.values(aliasMapForReferencedTables)) {
                      const key = `${String(tableInfo.dbName || '').toLowerCase()}.${String(tableInfo.tableName || '').toLowerCase()}`;
                      if (!tableInfo.dbName || !tableInfo.tableName || seenReferencedTables.has(key)) continue;
                      seenReferencedTables.add(key);
                      const preloaded = findPreloadedColumns(tableInfo.dbName, tableInfo.tableName);
                      if (preloaded.length > 0) continue;
                      const cols = await getCompletionColumnsByTable(
                          tableInfo.dbName,
                          tableInfo.tableName,
                          tableInfo.explicitOwnerName,
                      );
                      if (isSqlCompletionRequestCancelled(token)) {
                          return createEmptySqlCompletionResult();
                      }
                      referencedColumns.push(...cols);
                  }
              }
              // 相关列提示：匹配 SQL 中引用的表（FROM/JOIN 等）
              // 权重最高，输入 WHERE 条件时优先显示
              // 先用索引把候选收敛到被引用表的列，避免整库列全量扫描。
              const preloadedRelevantColumns = expectsTableName || foundTables.size === 0
                  ? []
                  : collectSharedColumnsForTableIdents(sharedAllColumnsData, foundTables);
              const relevantColumnCandidates = preloadedRelevantColumns.length === 0
                  ? referencedColumns
                  : referencedColumns.length === 0
                      ? preloadedRelevantColumns
                      : [...preloadedRelevantColumns, ...referencedColumns];
              const relevantColumnBatch = createBoundedQueryEditorCompletionCandidateBatch({
                  candidates: relevantColumnCandidates,
                  prefix: wordPrefix,
                  getMatchRank: (column, normalizedPrefix) => {
                      const fullIdent = `${column.dbName}.${column.tableName}`.toLowerCase();
                      const shortIdent = (column.tableName || '').toLowerCase();
                      const parsed = splitSchemaAndTable(column.tableName || '', column.dbName);
                      const pureIdent = (parsed.table || '').toLowerCase();
                      if (!foundTables.has(fullIdent) && !foundTables.has(shortIdent) && (!pureIdent || !foundTables.has(pureIdent))) {
                          return null;
                      }
                      return rankQueryEditorCompletionCandidate(normalizedPrefix, [column.name]);
                  },
                  getSelectionKey: (column, _prefix, matchRank) => (
                      (isCurrentCompletionDatabase(column.dbName || '')
                          ? sortGroups.columnCurrent
                          : sortGroups.columnOther)
                      + matchRank
                      + column.name
                  ),
                  buildSuggestion: (column) => {
                      const isCurrentDb = isCurrentCompletionDatabase(column.dbName || '');
                      return {
                          label: column.name,
                          kind: monaco.languages.CompletionItemKind.Field,
                          insertText: quoteCompletionPart(applyCompletionFragmentCase(column.name, rawWordPrefix)),
                          detail: buildColumnCompletionDetail(column),
                          documentation: buildColumnCompletionDocumentation(column),
                          filterText: resolveQueryEditorCompletionFilterText(wordPrefix, [column.name]) || column.name,
                          range,
                          sortText: `${isCurrentDb ? sortGroups.columnCurrent : sortGroups.columnOther}${rankQueryEditorCompletionCandidate(wordPrefix, [column.name]) ?? 9}${column.name}`,
                      };
                  },
              });

              // 表提示：当前库智能处理 schema.table 格式
              // 1. 构建纯表名到 schema 列表的映射，检测同名表
              const currentDatabaseTables = currentDatabase
                  ? findCompletionTablesByDatabase(completionTables, currentDatabase)
                  : [];
              const tableNameToSchemaCount = getCompletionTableSchemaCounts(currentDatabaseTables);

              const tableBatch = createBoundedQueryEditorCompletionCandidateBatch<CompletionTableMeta, any>({
                  candidates: completionTables,
                  prefix: wordPrefix,
                  getMatchRank: (table, normalizedPrefix) => {
                      const isCurrentDb = isCurrentCompletionDatabase(table.dbName || '');
                      const parsed = splitSchemaAndTable(table.tableName || '', table.dbName);
                      const pureTable = parsed.table || table.tableName || '';
                      if (!isCurrentDb) {
                          const meta = buildDbQualifiedTableSuggestionMeta(table.dbName || '', table.tableName || '');
                          return rankQueryEditorCompletionCandidate(
                              normalizedPrefix,
                              [meta.dbQualifiedLabel, table.tableName, pureTable],
                          );
                      }
                      return rankQueryEditorCompletionCandidate(normalizedPrefix, [table.tableName, pureTable]);
                  },
                  getSelectionKey: (table, _prefix, matchRank) => {
                      const isCurrentDb = isCurrentCompletionDatabase(table.dbName || '');
                      const parsed = splitSchemaAndTable(table.tableName || '', table.dbName);
                      const pureTable = parsed.table || table.tableName || '';
                      if (!isCurrentDb) {
                          const meta = buildDbQualifiedTableSuggestionMeta(table.dbName || '', table.tableName || '');
                          const label = meta.dbQualifiedLabel;
                          return sortGroups.tableOther + matchRank + label;
                      }
                      return sortGroups.tableCurrent + matchRank + pureTable;
                  },
                  buildSuggestion: (table) => {
                      const isCurrentDb = isCurrentCompletionDatabase(table.dbName || '');
                      const parsed = splitSchemaAndTable(table.tableName || '', table.dbName);
                      const pureTable = parsed.table || table.tableName || '';
                      if (!isCurrentDb) {
                          const meta = buildDbQualifiedTableSuggestionMeta(table.dbName || '', table.tableName || '');
                          const label = meta.dbQualifiedLabel;
                          return {
                              ...buildTableSuggestion(
                                  label,
                                  `${translate('query_editor.object_info.table')} (${table.dbName})`,
                                  table.comment,
                                  wordPrefix,
                                  [label, table.tableName || '', pureTable],
                              ),
                              kind: monaco.languages.CompletionItemKind.Class,
                              insertText: quoteCompletionPath(applyCompletionFragmentCase(label, rawWordPrefix)),
                              detail: appendCommentToDetail(`${translate('query_editor.object_info.table')} (${table.dbName})`, table.comment),
                              documentation: buildCompletionDocumentation(table.comment),
                              range,
                              sortText: sortGroups.tableOther + getPrefixMatchRank(label, table.tableName || '', pureTable) + label,
                          };
                      }
                      const hasDuplicate = (tableNameToSchemaCount.get(pureTable.toLowerCase()) || 0) > 1;
                      const label = hasDuplicate ? table.tableName : pureTable;
                      const schemaInfo = parsed.schema ? ` (${parsed.schema})` : '';
                      return {
                          ...buildTableSuggestion(
                              label,
                              `${translate('query_editor.object_info.table')}${schemaInfo}`,
                              table.comment,
                              wordPrefix,
                              [label, table.tableName || '', pureTable],
                          ),
                          kind: monaco.languages.CompletionItemKind.Class,
                          insertText: quoteCompletionPath(applyCompletionFragmentCase(
                              hasDuplicate ? table.tableName : pureTable,
                              rawWordPrefix,
                          )),
                          detail: appendCommentToDetail(`${translate('query_editor.object_info.table')}${schemaInfo}`, table.comment),
                          documentation: buildCompletionDocumentation(table.comment),
                          range,
                          sortText: sortGroups.tableCurrent + getPrefixMatchRank(table.tableName || '', pureTable) + pureTable,
                      };
                  },
              });

              const buildGlobalViewBatch = (views: CompletionViewMeta[], materialized: boolean) => (
                  createBoundedQueryEditorCompletionCandidateBatch({
                      candidates: views,
                      prefix: wordPrefix,
                      getMatchRank: (view, normalizedPrefix) => {
                          if (expectsTableName && currentDatabase && !isCurrentCompletionDatabase(view.dbName || '')) return null;
                          const meta = buildViewSuggestionMeta(view);
                          return rankQueryEditorCompletionCandidate(
                              normalizedPrefix,
                              [meta.dbQualifiedLabel, meta.displayName, meta.objectName, view.viewName],
                          );
                      },
                      getSelectionKey: (view, _prefix, matchRank) => {
                          const meta = buildViewSuggestionMeta(view);
                          const isCurrentDb = isCurrentCompletionDatabase(view.dbName || '');
                          const label = isCurrentDb ? meta.displayName : meta.dbQualifiedLabel;
                          return (isCurrentDb ? sortGroups.tableCurrent : sortGroups.tableOther)
                              + '1'
                              + matchRank
                              + label;
                      },
                      buildSuggestion: (view) => {
                          const meta = buildViewSuggestionMeta(view);
                          const isCurrentDb = isCurrentCompletionDatabase(view.dbName || '');
                          const label = isCurrentDb ? meta.displayName : meta.dbQualifiedLabel;
                          return {
                              label,
                              kind: monaco.languages.CompletionItemKind.Class,
                              insertText: meta.insertText,
                              detail: `${getViewTypeLabel(materialized)} (${getViewSuggestionScope(view, meta)})`,
                              filterText: resolveQueryEditorCompletionFilterText(wordPrefix, [meta.dbQualifiedLabel, meta.displayName, meta.objectName, view.viewName])
                                  || label,
                              range,
                              sortText: (isCurrentDb ? sortGroups.tableCurrent : sortGroups.tableOther)
                                  + '1'
                                  + getPrefixMatchRank(label, meta.displayName, meta.objectName, view.viewName || '')
                                  + label,
                          };
                      },
                  })
              );
              const viewBatch = buildGlobalViewBatch(sharedViewsData, false);
              const materializedViewBatch = buildGlobalViewBatch(sharedMaterializedViewsData, true);

              const synonymBatch = createBoundedQueryEditorCompletionCandidateBatch({
                  candidates: selectUnqualifiedCompletionSynonyms(sharedSynonymsData, oracleLoginOwner),
                  prefix: wordPrefix,
                  getMatchRank: (synonym, normalizedPrefix) => (
                      rankQueryEditorCompletionCandidate(normalizedPrefix, [synonym.synonymName])
                  ),
                  getSelectionKey: (synonym) => (
                      sortGroups.tableCurrent + '05' + getPrefixMatchRank(synonym.synonymName || '') + synonym.synonymName
                  ),
                  buildSuggestion: (synonym) => buildSynonymSuggestion(
                      synonym,
                      sortGroups.tableCurrent + '05' + getPrefixMatchRank(synonym.synonymName || '') + synonym.synonymName,
                  ),
              });

              const routineBatch = createBoundedQueryEditorCompletionCandidateBatch({
                  candidates: sharedRoutinesData,
                  prefix: wordPrefix,
                  getMatchRank: (routine, normalizedPrefix) => {
                      const meta = buildRoutineSuggestionMeta(routine);
                      if (expectsRoutineName && meta.routineType !== 'PROCEDURE') return null;
                      return rankQueryEditorCompletionCandidate(
                          normalizedPrefix,
                          [meta.dbQualifiedLabel, meta.displayName, meta.objectName, routine.routineName],
                      );
                  },
                  getSelectionKey: (routine) => {
                      const meta = buildRoutineSuggestionMeta(routine);
                      const isCurrentDb = isCurrentCompletionDatabase(routine.dbName || '');
                      return (isCurrentDb ? sortGroups.routineCurrent : sortGroups.routineOther)
                          + getPrefixMatchRank(meta.dbQualifiedLabel, meta.displayName, meta.objectName, routine.routineName || '')
                          + meta.dbQualifiedLabel;
                  },
                  buildSuggestion: (routine) => {
                      const meta = buildRoutineSuggestionMeta(routine);
                      const isCurrentDb = isCurrentCompletionDatabase(routine.dbName || '');
                      const schemaInfo = meta.schemaName && meta.schemaName.toLowerCase() !== String(routine.dbName || '').toLowerCase()
                          ? `.${meta.schemaName}`
                          : '';
                      return {
                          label: meta.dbQualifiedLabel,
                          kind: monaco.languages.CompletionItemKind.Function,
                          insertText: meta.insertText,
                          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                          detail: `${getRoutineTypeLabel(routine.routineType)} (${routine.dbName}${schemaInfo})`,
                          range,
                          sortText: (isCurrentDb ? sortGroups.routineCurrent : sortGroups.routineOther)
                              + getPrefixMatchRank(meta.dbQualifiedLabel, meta.displayName, meta.objectName, routine.routineName || '')
                              + meta.dbQualifiedLabel,
                      };
                  },
              });

              // 数据库提示
              const dbBatch = createBoundedQueryEditorCompletionCandidateBatch({
                  candidates: sharedVisibleDbs,
                  prefix: wordPrefix,
                  getMatchRank: (db, normalizedPrefix) => rankQueryEditorCompletionCandidate(normalizedPrefix, [db], false),
                  getSelectionKey: (db) => sortGroups.db + db,
                  buildSuggestion: (db) => ({
                      label: db,
                      kind: monaco.languages.CompletionItemKind.Module,
                      insertText: db,
                      detail: translate('query_editor.object_info.database'),
                      range,
                      sortText: sortGroups.db + db,
                  }),
              });

              // 关键字提示
              const keywordBatch = createBoundedQueryEditorCompletionCandidateBatch({
                  candidates: dialectKeywords,
                  prefix: wordPrefix,
                  getMatchRank: (keyword, normalizedPrefix) => rankQueryEditorCompletionCandidate(normalizedPrefix, [keyword], false),
                  getSelectionKey: (keyword) => sortGroups.keyword + keyword,
                  buildSuggestion: (keyword) => ({
                      label: keyword,
                      kind: monaco.languages.CompletionItemKind.Keyword,
                      insertText: keyword,
                      range,
                      sortText: sortGroups.keyword + keyword,
                  }),
              });

              // 内置函数提示
              const funcBatch = createBoundedQueryEditorCompletionCandidateBatch({
                  candidates: dialectFunctions,
                  prefix: wordPrefix,
                  getMatchRank: (func, normalizedPrefix) => rankQueryEditorCompletionCandidate(normalizedPrefix, [func.name], false),
                  getSelectionKey: (func) => sortGroups.func + func.name,
                  buildSuggestion: (func) => ({
                      label: func.name,
                      kind: monaco.languages.CompletionItemKind.Function,
                      insertText: func.name + '($0)',
                      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
                      detail: func.detail,
                      range,
                      sortText: sortGroups.func + func.name,
                  }),
              });

              const suggestions = materializeBoundedQueryEditorCompletionBatches([
                  relevantColumnBatch,
                  tableBatch,
                  viewBatch,
                  materializedViewBatch,
                  synonymBatch,
                  dbBatch,
                  routineBatch,
                  funcBatch,
                  keywordBatch,
              ], QUERY_EDITOR_COMPLETION_SUGGESTION_LIMIT);
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

      } // end sqlCompletionRegistered guard

      // 每个编辑器实例都注册内容变化监听（检测斜杠命令标记）
      let _handlingSlash = false;
      editor.onDidChangeModelContent((event: any) => {
          if (_handlingSlash) return;
          const hasSlashCommandMarker = Array.isArray(event?.changes)
              && event.changes.some((change: any) => /__AI_\w+__/.test(String(change?.text || '')));
          if (!hasSlashCommandMarker) return;
          const model = editor.getModel();
          if (!model) return;
          const content = model.getValue();
          const markerMatch = content.match(/__AI_(\w+)__/);
          if (!markerMatch) return;

          const cmdKey = markerMatch[1].toLowerCase();
          const defs = (window as any).__gonaviSlashCmdDefs || [];
          const cmdDef = defs.find((c: any) => c.cmd === `/${cmdKey}`);
          if (!cmdDef) return;

          // 清除标记文本（带递归保护）
          _handlingSlash = true;
          const fullText = model.getValue();
          const newText = fullText.replace(markerMatch[0], '').replace(/^\s*\n/, '');
          model.setValue(newText);
          _handlingSlash = false;

          // 组装 prompt
          const conn = connectionsRef.current.find(c => c.id === currentConnectionIdRef.current);
          const ctxText = buildQueryEditorAiContextPrompt(conn, currentDbRef.current);
          let finalPrompt = ctxText + cmdDef.prompt;
          if (cmdDef.useSelection) {
              const sel = editor.getSelection();
              const selText = sel ? model.getValueInRange(sel) : '';
              finalPrompt = finalPrompt.replace(QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER, selText || getCurrentQuery());
          }

          // 打开 AI 面板并注入 prompt
          const store = useStore.getState();
          if (!store.aiPanelVisible) {
              store.setAIPanelVisible(true);
          }
          setTimeout(() => {
              window.dispatchEvent(new CustomEvent('gonavi:ai:inject-prompt', { detail: { prompt: finalPrompt } }));
          }, store.aiPanelVisible ? 0 : 350);
      });
  };

  const handleFormat = () => {
      if (isElasticsearchMode) {
          const editor = editorRef.current;
          const monaco = monacoRef.current;
          const model = editor?.getModel?.();
          const selection = editor?.getSelection?.();
          const selectedRaw = model && selection
              ? String(model.getValueInRange?.(selection) || '')
              : '';
          const formatSelection = !!selection && !!selectedRaw.trim();
          const fullSource = getCurrentQuery();
          const source = formatSelection ? selectedRaw : fullSource;
          const formatted = formatElasticsearchConsoleSource(source);
          if (!formatted.ok) {
              void message.error(translate('query_editor.message.format_failed'));
              return;
          }
          if (source === formatted.text) {
              return;
          }
          updateQueryTabDraft(tab.id, {
              formatRestoreSnapshot: {
                  query: fullSource,
                  createdAt: Date.now(),
              },
          });
          if (editor && monaco && model) {
              const editRange = formatSelection
                  ? selection
                  : (model.getFullModelRange?.()
                      || new monaco.Range(1, 1, model.getLineCount?.() || 1, model.getLineMaxColumn?.(model.getLineCount?.() || 1) || 1));
              editor.pushUndoStop?.();
              editor.executeEdits?.('gonavi-format-elasticsearch-console', [{
                  range: editRange,
                  text: formatted.text,
                  forceMoveMarkers: true,
              }]);
              editor.pushUndoStop?.();
              applyQueryState(String(editor.getValue?.() || formatted.text));
              editor.setScrollLeft?.(0);
              return;
          }
          if (!formatSelection) {
              syncQueryToEditor(formatted.text);
          }
          return;
      }
      const startedAt = queryEditorFormatNow();
      let formatterLanguageLog = 'unknown';
      let dbType = '(unknown)';
      let driver = '(default)';
      let formatScope = 'full';
      let sqlLength = 0;
      let positionalParams = false;
      const logSuccess = (changed: boolean) => {
          writeQueryEditorFormatLog(
              'info',
              `[SQL美化] 成功：language=${formatterLanguageLog} dbType=${dbType} driver=${driver} scope=${formatScope} sqlLength=${sqlLength} positional=${positionalParams} durationMs=${formatQueryEditorFormatDuration(startedAt)} changed=${changed}`,
          );
      };
      try {
          const activeConnectionId = String(currentConnectionIdRef.current || '').trim();
          const tabConnectionId = String(tab.connectionId || '').trim();
          const conn = connectionsRef.current.find(c => c.id === activeConnectionId)
              || (tabConnectionId && tabConnectionId !== activeConnectionId
                  ? connectionsRef.current.find(c => c.id === tabConnectionId)
                  : undefined);
          const formatterLanguage = resolveQueryEditorFormatterLanguage(conn);
          formatterLanguageLog = formatterLanguage;
          dbType = normalizeQueryEditorFormatLogField(conn?.config?.type, '(unknown)');
          driver = normalizeQueryEditorFormatLogField(conn?.config?.driver, '(default)');
          const editor = editorRef.current;
          const monaco = monacoRef.current;
          const model = editor?.getModel?.();
          const selection = editor?.getSelection?.();
          const selectedRaw = model && selection
              ? String(model.getValueInRange?.(selection) || '')
              : '';
          const formatSelection = !!selection && !!selectedRaw.trim();
          formatScope = formatSelection ? 'selection' : 'full';
          const fullQuery = getCurrentQuery();
          const sourceSql = formatSelection ? selectedRaw : fullQuery;
          sqlLength = sourceSql.length;
          positionalParams = supportsPositionalSqlFormatParams(conn?.config);
          const formatted = format(sourceSql, {
              language: formatterLanguage,
              keywordCase: sqlFormatOptions.keywordCase,
              paramTypes: {
                  ...QUERY_EDITOR_FORMAT_PARAM_TYPES,
                  ...(positionalParams ? { positional: true } : {}),
              },
          });
          if (sourceSql === formatted) {
              logSuccess(false);
              return;
          }
          updateQueryTabDraft(tab.id, {
              formatRestoreSnapshot: {
                  query: fullQuery,
                  createdAt: Date.now(),
              },
          });
          if (editor && monaco && model) {
              const editRange = formatSelection
                  ? selection
                  : (model.getFullModelRange?.()
                      || new monaco.Range(1, 1, model.getLineCount?.() || 1, model.getLineMaxColumn?.(model.getLineCount?.() || 1) || 1));
              const currentValue = String(model.getValue?.() || fullQuery);
              if (!formatSelection && currentValue === formatted) {
                  logSuccess(false);
                  return;
              }
              editor.pushUndoStop?.();
              editor.executeEdits?.('gonavi-format-sql', [{
                  range: editRange,
                  text: formatted,
                  forceMoveMarkers: true,
              }]);
              editor.pushUndoStop?.();
              const nextValue = editor.getValue?.();
              applyQueryState(typeof nextValue === 'string' ? nextValue : (formatSelection ? currentValue : formatted));
              refreshObjectDecorations();
              editor.setScrollLeft?.(0);
              logSuccess(true);
              return;
      }
      if (formatSelection) {
          logSuccess(false);
          return;
      }
      syncQueryToEditor(formatted);
      logSuccess(true);
  } catch (e) {
          writeQueryEditorFormatLog(
              'error',
              `[SQL美化] 失败：language=${formatterLanguageLog} dbType=${dbType} driver=${driver} scope=${formatScope} sqlLength=${sqlLength} positional=${positionalParams} durationMs=${formatQueryEditorFormatDuration(startedAt)} error=${formatQueryEditorFormatError(e)}`,
          );
          void message.error(translate('query_editor.message.format_failed'));
      }
  };

  const handleFormatRef = useRef(handleFormat);
  useEffect(() => {
      handleFormatRef.current = handleFormat;
  });

  useEffect(() => {
      const handleFormatActiveQuery = () => {
          if (!isActive) {
              return;
          }
          handleFormatRef.current();
      };

      window.addEventListener('gonavi:format-active-query', handleFormatActiveQuery as EventListener);
      return () => {
          window.removeEventListener('gonavi:format-active-query', handleFormatActiveQuery as EventListener);
      };
  }, [isActive]);

  const handleRestoreLastFormat = () => {
      const previousQuery = tab.formatRestoreSnapshot?.query;
      if (!previousQuery) {
          void message.info(translate('query_editor.message.no_format_restore_snapshot'));
          return;
      }
      syncQueryToEditor(previousQuery);
      updateQueryTabDraft(tab.id, {
          query: previousQuery,
          formatRestoreSnapshot: undefined,
      });
      refreshObjectDecorations();
      void message.success(translate('query_editor.message.format_restore_success'));
  };

  const handleAIAction = (action: 'generate' | 'explain' | 'optimize' | 'schema') => {
      if (action === 'generate') {
          openTextToSqlModal();
          return;
      }

      const editor = editorRef.current;
      const selection = editor?.getModel()?.getValueInRange(editor.getSelection()) || '';
      const fullSQL = getCurrentQuery();

      const conn = connections.find(c => c.id === currentConnectionId);
      const ctxText = buildQueryEditorAiContextPrompt(conn, currentDb);

      const prompts: Record<string, string> = {
          generate: `${ctxText}${translate('query_editor.ai_prompt.generate')}`,
          explain: `${ctxText}${translate('query_editor.ai_prompt.explain', { sql: selection || fullSQL || QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER })}`,
          optimize: `${ctxText}${translate('query_editor.ai_prompt.optimize', { sql: selection || fullSQL || QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER })}`,
          schema: `${ctxText}${translate('query_editor.ai_prompt.schema')}`,
      };

      const store = useStore.getState();
      if (!store.aiPanelVisible) {
          store.setAIPanelVisible(true);
      }
      window.dispatchEvent(new CustomEvent('gonavi:ai:inject-prompt', { detail: { prompt: prompts[action] } }));
  };

  const formatSettingsMenu: MenuProps['items'] = [
      {
          type: 'group',
          key: 'format-actions',
          label: translate('query_editor.action.format_sql'),
          children: [
              {
                  key: 'upper',
                  label: translate('query_editor.format.keyword_upper'),
                  icon: <span aria-hidden="true" className="gn-query-format-case-icon gn-query-format-case-icon-upper">AA</span>,
                  onClick: () => setSqlFormatOptions({ keywordCase: 'upper' }),
              },
              {
                  key: 'lower',
                  label: translate('query_editor.format.keyword_lower'),
                  icon: <span aria-hidden="true" className="gn-query-format-case-icon gn-query-format-case-icon-lower">aa</span>,
                  onClick: () => setSqlFormatOptions({ keywordCase: 'lower' }),
              },
              {
                  key: 'restore-last-format',
                  label: translate('query_editor.format.restore_last_format'),
                  icon: <UndoOutlined />,
                  disabled: !tab.formatRestoreSnapshot?.query,
                  onClick: handleRestoreLastFormat,
              },
          ],
      },
      {
          type: 'group',
          key: 'format-settings',
          label: translate('settings.title'),
          children: [
              {
                  key: 'snippet-settings',
                  label: translate('query_editor.format.snippet_settings'),
                  icon: <CodeOutlined />,
                  onClick: () => window.dispatchEvent(new CustomEvent('gonavi:open-snippet-settings')),
              },
              {
                  key: 'shortcut-settings',
                  label: translate('query_editor.format.shortcut_settings'),
                  icon: <KeyOutlined />,
                  onClick: () => window.dispatchEvent(new CustomEvent('gonavi:open-shortcut-settings')),
              },
          ],
      },
  ];

  const splitSQLStatements = (sql: string, dbType = ''): string[] => {
    return findSqlStatementRanges(sql, dbType).map((range) => range.text);
  };

  const containsOraclePlsqlDefinition = (statements: string[]): boolean => (
      statements.some((statement) => /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:EDITIONABLE\s+|NONEDITIONABLE\s+)?(?:PROCEDURE|FUNCTION|PACKAGE|TRIGGER)\b/i.test(
          maskQueryEditorSqlLiteralsAndComments(statement),
      ))
  );

  const normalizeOracleSqlPlusSlashTerminators = (sql: string): string => (
      String(sql || '').replace(/(^|\n)([ \t]*\/[ \t]*);+([ \t]*(?:--[^\n]*)?)(?=\n|$)/g, '$1$2$3')
  );

  const getSelectedSQL = (): string => {
      const editor = editorRef.current;
      if (!editor) return '';
      const model = editor.getModel?.();
      const selection = editor.getSelection?.();
      if (!model || !selection) return '';

      const selected = model.getValueInRange?.(selection) || '';
      if (typeof selected !== 'string') return '';
      if (!selected.trim()) return '';
      return selected;
  };

  const buildResultSetMergeKey = (result: ResultSet): string => (
      buildQueryEditorResultSetMergeKey(result)
  );

  const mergeResultSets = (previous: ResultSet[], next: ResultSet[], replaceAll: boolean): ResultSet[] => {
      const merged = replaceAll ? previous.filter((result) => result.pinned) : [...previous];
      next.forEach((result) => {
          const incomingKey = buildResultSetMergeKey(result);
          const existingIndex = merged.findIndex(
              (item) => !item.pinned && buildResultSetMergeKey(item) === incomingKey,
          );
          if (existingIndex >= 0) {
              merged[existingIndex] = { ...result, key: merged[existingIndex].key, pinned: false };
              return;
          }
          merged.push({ ...result, key: `result-${resolveNextResultSetIndex(merged)}`, pinned: false });
      });
      return merged;
  };

  const clearUnpinnedResultSets = (fallbackActiveKey = ''): ResultSet[] => {
      const nextResultSets = resultSetsRef.current.filter((result) => result.pinned);
      const nextActiveKey = nextResultSets.some((result) => result.key === activeResultKeyRef.current)
          ? activeResultKeyRef.current
          : nextResultSets[0]?.key || fallbackActiveKey;
      resultSetsRef.current = nextResultSets;
      activeResultKeyRef.current = nextActiveKey;
      setResultSets(nextResultSets);
      setActiveResultKey(nextActiveKey);
      return nextResultSets;
  };

  const isDisplayableResultSet = (result?: ResultSet | null): boolean => {
      if (!result) {
          return false;
      }
      if (Array.isArray(result.messages) && result.messages.length > 0) {
          return true;
      }
      if (Array.isArray(result.columns) && result.columns.length > 0) {
          return true;
      }
      if (Array.isArray(result.rows) && result.rows.length > 0) {
          return true;
      }
      return false;
  };

  const isAffectedRowsResultSet = (result?: ResultSet | null): boolean =>
      Boolean(
          result &&
          Array.isArray(result.columns) &&
          result.columns.length === 1 &&
          result.columns[0] === 'affectedRows',
      );

  const isAffectedRowsResultSetData = (result?: any): boolean =>
      Boolean(
          result &&
          Array.isArray(result.rows) &&
          result.rows.length === 1 &&
          Array.isArray(result.columns) &&
          result.columns.length === 1 &&
          result.columns[0] === 'affectedRows',
      );

  const hasConcreteQueryResultSetData = (result: any, messages: string[]): boolean => {
      if (!result || isAffectedRowsResultSetData(result)) return false;
      if (messages.length > 0) return true;
      if (Array.isArray(result.columns) && result.columns.length > 0) return true;
      if (Array.isArray(result.rows) && result.rows.length > 0) return true;
      return false;
  };

  const isMessageLikeResultSet = (result?: ResultSet | null): boolean =>
      Boolean(
          result &&
          Array.isArray(result.messages) &&
          result.messages.length > 0 &&
          result.resultType !== 'grid',
      );

  const isConcreteGridResultSet = (result?: ResultSet | null): boolean =>
      Boolean(
          result &&
          result.resultType !== 'message' &&
          !isAffectedRowsResultSet(result) &&
          (
              (Array.isArray(result.columns) && result.columns.length > 0) ||
              (Array.isArray(result.rows) && result.rows.length > 0)
          ),
      );

  const isQueryDataGridResultSet = (result?: ResultSet | null): boolean =>
      Boolean(
          result &&
          result.resultType !== 'message' &&
          !isAffectedRowsResultSet(result),
      );

  const resolveActiveResultKeyAfterMerge = (merged: ResultSet[], executed: ResultSet[]): string => {
      const firstExecutedResult = executed.find((result) => isConcreteGridResultSet(result))
          || executed.find((result) => isMessageLikeResultSet(result))
          || executed.find((result) => isDisplayableResultSet(result) && !isAffectedRowsResultSet(result))
          || executed.find((result) => isDisplayableResultSet(result))
          || executed[0];
      if (!firstExecutedResult) {
          return '';
      }
      const executedSqlKey = buildResultSetMergeKey(firstExecutedResult);
      return merged.find(
          (item) => !item.pinned && buildResultSetMergeKey(item) === executedSqlKey,
      )?.key
          || firstExecutedResult.key
          || merged[0]?.key
          || '';
  };

  const activateExecutedResult = (merged: ResultSet[], executed: ResultSet[], requestSeq: number) => {
      const nextActiveResultKey = resolveActiveResultKeyAfterMerge(merged, executed);
      const nextActiveResult = merged.find((result) => result.key === nextActiveResultKey);
      setActiveResultKey(nextActiveResultKey);
      setResultDataPreviewRequest(isQueryDataGridResultSet(nextActiveResult)
          ? {
              resultKey: nextActiveResultKey,
              requestId: `${tab.id}:${requestSeq}`,
          }
          : null);
  };

  const resolveExecutableSQLAtEditorPosition = (model: any, sqlText: string, position: any, dbType = ''): string => {
      const normalizedPosition = normalizeEditorPosition(position);
      if (!normalizedPosition) return '';
      const cursorOffset = getNormalizedOffsetAtPosition(sqlText, normalizedPosition);
      const resolved = resolveExecutableSql(sqlText, cursorOffset, '', dbType);
      return resolved?.sql || '';
  };

  const getExecutableSQLAtCurrentCursor = (model: any, sqlText: string, dbType = ''): string => {
      const editor = editorRef.current;
      const liveSelection = normalizeEditorPosition(editor?.getSelection?.());
      if (liveSelection) {
          return resolveExecutableSQLAtEditorPosition(model, sqlText, liveSelection, dbType);
      }

      const livePosition = normalizeEditorPosition(editor?.getPosition?.());
      const cachedPosition = normalizeEditorPosition(lastEditorCursorPositionRef.current);
      const candidates: Array<{ lineNumber: number; column: number }> = [];
      if (cachedPosition) candidates.push(cachedPosition);
      if (livePosition) candidates.push(livePosition);
      const seen = new Set<string>();

      for (const position of candidates) {
          const key = `${position.lineNumber}:${position.column}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const sql = resolveExecutableSQLAtEditorPosition(model, sqlText, position, dbType);
          if (sql.trim()) return sql;
      }

      const fallbackPosition = cachedPosition || livePosition;
      return resolveExecutableSQLAtEditorPosition(model, sqlText, fallbackPosition, dbType);
  };

  const getExecutableSQL = (): string => {
      const editor = editorRef.current;
      const model = editor?.getModel?.();
      const currentQuery = getCurrentQuery();
      const selectedSQL = getSelectedSQL();
      const selected = selectedSQL.trim();
      if (!selected && resultSets.length > 0 && lastExecutedEditorQueryRef.current && currentQuery.startsWith(lastExecutedEditorQueryRef.current)) {
          const appendedSQL = currentQuery.slice(lastExecutedEditorQueryRef.current.length);
          if (appendedSQL.trim()) {
              return appendedSQL;
          }
      }
      if (!model || !editor) {
          return selectedSQL || currentQuery;
      }

      if (selected) {
          return selectedSQL;
      }
      const activeConnection = connections.find((connection) => connection.id === currentConnectionId);
      const activeDialect = resolveSqlDialect(
          String(activeConnection?.config?.type || ''),
          String(activeConnection?.config?.driver || ''),
          { oceanBaseProtocol: activeConnection?.config?.oceanBaseProtocol },
      );
      return getExecutableSQLAtCurrentCursor(model, String(model.getValue?.() ?? currentQuery), activeDialect);
  };

  const captureEditorCursorPosition = (event?: React.MouseEvent<HTMLElement>) => {
      event?.preventDefault();
      const editor = editorRef.current;
      const position = normalizeEditorPosition(editor?.getSelection?.()) || normalizeEditorPosition(editor?.getPosition?.());
      if (position) {
          lastEditorCursorPositionRef.current = position;
      }
  };

  const buildSqlExecutionConnectionConfig = useCallback((
      config: Record<string, any>,
      schemaName = currentSchemaRef.current,
  ) => {
      if (!canSelectQuerySchema || !supportsQueryEditorSchemaSelection(String(config.type || ''))) {
          return config;
      }
      return applyQueryEditorSchemaSearchPath(config, schemaName);
  }, [canSelectQuerySchema]);

  const executeSqlEditorMultiQuery = useCallback((
      config: Record<string, any>,
      dbName: string,
      sql: string,
      queryId: string,
      sourceStatements: string[],
      dbType = String(config.type || ''),
      connectionParamsOverride?: string,
      executionConnectionId = currentConnectionIdRef.current,
  ) => {
      const executionConfig = connectionParamsOverride === undefined
          ? buildSqlExecutionConnectionConfig(config)
          : { ...config, connectionParams: connectionParamsOverride };
      const currentContextConfig = buildSqlExecutionConnectionConfig(config);
      const matchesCurrentExecutionContext = String(executionConnectionId || '').trim()
              === String(currentConnectionIdRef.current || '').trim()
          && String(dbName || '').trim() === String(currentDbRef.current || '').trim()
          && (
              connectionParamsOverride === undefined
              || String(executionConfig.connectionParams || '')
                  === String(currentContextConfig.connectionParams || '')
          );
      const pendingTransaction = pendingSqlTransactionRef.current;
      if (
          pendingTransaction
          && matchesCurrentExecutionContext
          && canReusePendingSqlEditorTransactionForType(dbType, sourceStatements, config as ConnectionConfig)
      ) {
          return DBQueryMultiInTransaction(pendingTransaction.id, sql, queryId);
      }
      return DBQueryMulti(
          buildRpcConnectionConfig(executionConfig) as any,
          dbName,
          sql,
          queryId,
      );
  }, [buildSqlExecutionConnectionConfig]);

  // 精准重查询单个结果集（提交事务 / 刷新按钮使用），不会重跑整个编辑器 SQL
  const handleReloadResult = async (resultKey: string, sql: string) => {
      const currentResult = resultSets.find((item) => item.key === resultKey);
      const executionConnectionId = currentResult?.executionConnectionId || currentConnectionId;
      const executionDbName = currentResult?.executionDbName || currentDb;
      if (!sql?.trim() || !executionDbName) return;
      const conn = connections.find(c => c.id === executionConnectionId);
      if (!conn) return;
      const statementResultIndex = Math.max(1, Number(currentResult?.statementResultIndex || 1));

      const config = {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      };
      const normalizedDbType = String(resolveSqlDialect(
          String(config.type || ''),
          String((config as any).driver || ''),
          { oceanBaseProtocol: String((config as any).oceanBaseProtocol || '') },
      )).trim().toLowerCase();

      const runSeq = ++runSeqRef.current;
      const isCurrentRun = () => runSeqRef.current === runSeq;
      let runQueryId = '';
      setExecutionRunToken(runSeq);
      setLoading(true);

      try {
          if (currentQueryIdRef.current) {
              const previousQueryId = currentQueryIdRef.current;
              try {
                  await CancelQuery(previousQueryId);
              } catch {
                  // The previous query may already have completed.
              }
              if (!isCurrentRun()) return;
              if (currentQueryIdRef.current === previousQueryId) {
                  clearQueryId();
              }
          }
          // 保持与首次执行一致的后端路径，必要时复用挂起事务
          let queryId: string;
          try {
              queryId = await GenerateQueryID();
          } catch {
              queryId = 'reload-' + Date.now();
          }
          if (!isCurrentRun()) return;
          runQueryId = queryId;
          setQueryId(queryId);
          const res = await executeSqlEditorMultiQuery(
              config,
              executionDbName,
              sql,
              queryId,
              splitSQLStatements(sql, normalizedDbType),
              normalizedDbType,
              currentResult?.executionConnectionParams,
              executionConnectionId,
          );
          if (!isCurrentRun()) return;
          if (currentQueryIdRef.current === queryId) {
              clearQueryId();
              runQueryId = '';
          }
          if (!res?.success) {
              message.error(translate('query_editor.message.refresh_failed', {
                  error: formatSqlExecutionError(res?.message || translate('common.unknown'), { translate }),
              }));
              return;
          }

          const resultSetDataArray = Array.isArray(res.data) ? (res.data as any[]) : [];
          const rsData = resultSetDataArray[Math.max(0, statementResultIndex - 1)];
          if (!rsData) return;
          const isAffectedResult = Array.isArray(rsData.rows) && rsData.rows.length === 1
              && rsData.columns && rsData.columns.length === 1
              && rsData.columns[0] === 'affectedRows';
          if (isAffectedResult) return; // 不应该出现，但保险起见

          let rows = Array.isArray(rsData.rows) ? rsData.rows : [];
          const maxRows = Number(queryOptions?.maxRows) || 0;
          let truncated = false;
          if (Number.isFinite(maxRows) && maxRows > 0 && rows.length > maxRows) {
              truncated = true;
              rows = rows.slice(0, maxRows);
          }
          const cols = (rsData.columns && rsData.columns.length > 0)
              ? rsData.columns
              : (rows.length > 0 ? Object.keys(rows[0]) : []);
          const refreshedMessages = normalizeQueryResultMessages(rsData?.messages);
          rows.forEach((row: any, i: number) => {
              if (row && typeof row === 'object') row[GONAVI_ROW_KEY] = i;
          });

          // 只更新匹配的结果集的 rows 和 columns，保留 tableName/pkColumns/readOnly 等元数据
          setResultSets(prev => prev.map(rs =>
              rs.key === resultKey
                  ? {
                      ...rs,
                      rows,
                      columns: cols,
                      messages: refreshedMessages,
                      resultType: ((!Array.isArray(rsData.rows) || rsData.rows.length === 0) && (!Array.isArray(rsData.columns) || rsData.columns.length === 0) && refreshedMessages.length > 0)
                          ? 'message'
                          : 'grid',
                      truncated,
                  }
                  : rs
          ));
      } catch (err: any) {
          if (!isCurrentRun()) return;
          message.error(translate('query_editor.message.refresh_failed', {
              error: formatSqlExecutionError(err?.message || err || translate('common.unknown'), { translate }),
          }));
      } finally {
          if (isCurrentRun()) setLoading(false);
          if (runQueryId && currentQueryIdRef.current === runQueryId) {
              clearQueryId();
          }
      }
  };

  const handleRequestResultTotalCount = async (resultKey: string) => {
      const target = resultSetsRef.current.find((item) => item.key === resultKey);
      const executionConnectionId = target?.executionConnectionId || currentConnectionId;
      const executionDbName = target?.executionDbName || currentDb;
      if (!target?.page?.baseSql || !executionDbName || resultTotalCountRequestsRef.current[resultKey]) return;
      const conn = connections.find(c => c.id === executionConnectionId);
      if (!conn) return;
      const countSql = buildQueryResultCountSql(target.page.baseSql);
      if (!countSql) return;
      const config = {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || '',
          database: conn.config.database || '',
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
          timeout: resolveQueryEditorConnectionTimeout(conn.config),
      };
      const normalizedDbType = String(resolveSqlDialect(
          String(config.type || 'mysql'),
          String((config as any).driver || ''),
          { oceanBaseProtocol: String((config as any).oceanBaseProtocol || '') },
      )).toLowerCase();
      const sequence = ++resultTotalCountSeqRef.current;
      resultTotalCountRequestsRef.current[resultKey] = { sequence, queryId: '' };
      setResultSets(prev => prev.map(rs =>
          rs.key === resultKey && rs.page
              ? { ...rs, page: { ...rs.page, totalCountLoading: true, totalCountCancelled: false } }
              : rs
      ));
      const countStartedAt = Date.now();
      const isCurrentRequest = () => {
          if (resultTotalCountRequestsRef.current[resultKey]?.sequence !== sequence) return false;
          const currentResult = resultSetsRef.current.find((item) => item.key === resultKey);
          return currentResult?.page?.baseSql === target.page?.baseSql;
      };
      const finishLoading = (cancelled = false) => {
          if (!isCurrentRequest()) return;
          delete resultTotalCountRequestsRef.current[resultKey];
          setResultSets(prev => prev.map(rs =>
              rs.key === resultKey && rs.page
                  ? { ...rs, page: { ...rs.page, totalCountLoading: false, totalCountCancelled: cancelled } }
                  : rs
          ));
      };

      try {
          let queryId: string;
          try {
              queryId = await GenerateQueryID();
          } catch {
              queryId = `query-total-${uuidv4()}`;
          }
          if (!isCurrentRequest()) return;
          resultTotalCountRequestsRef.current[resultKey] = { sequence, queryId };
          const res = await executeSqlEditorMultiQuery(
              config,
              executionDbName,
              countSql,
              queryId,
              [countSql],
              normalizedDbType,
              target.executionConnectionParams,
              executionConnectionId,
          );
          const duration = Date.now() - countStartedAt;
          addSqlLog({
              id: `log-${Date.now()}-query-total-count`,
              timestamp: Date.now(),
              sql: countSql,
              status: res?.success ? 'success' : 'error',
              duration,
              message: res?.success ? '' : String(res?.message || translate('data_viewer.message.total_count_failed')),
              dbName: executionDbName,
          });
          if (!isCurrentRequest()) return;
          if (!res?.success) {
              finishLoading();
              message.error(String(res?.message || translate('data_viewer.message.total_count_failed')));
              return;
          }
          const resultSetData = Array.isArray(res.data) ? res.data[0] : null;
          const countRow = Array.isArray(resultSetData?.rows) ? resultSetData.rows[0] : null;
          const total = parseQueryResultTotalCount(countRow);
          if (total === null) {
              finishLoading();
              message.error(translate('data_viewer.message.total_count_parse_failed'));
              return;
          }

          delete resultTotalCountRequestsRef.current[resultKey];
          setResultSets(prev => prev.map(rs =>
              rs.key === resultKey && rs.page
                  ? {
                      ...rs,
                      page: {
                          ...rs.page,
                          total,
                          totalKnown: true,
                          totalCountLoading: false,
                          totalCountCancelled: false,
                      },
                  }
                  : rs
          ));
      } catch (error: any) {
          if (!isCurrentRequest()) return;
          addSqlLog({
              id: `log-${Date.now()}-query-total-count-error`,
              timestamp: Date.now(),
              sql: countSql,
              status: 'error',
              duration: Date.now() - countStartedAt,
              message: String(error?.message || error || translate('common.unknown')),
              dbName: executionDbName,
          });
          finishLoading();
          message.error(translate('data_viewer.message.total_count_failed_detail', {
              detail: String(error?.message || error || translate('common.unknown')),
          }));
      }
  };

  const cancelResultTotalCountRequests = async (resultKeys: string[]) => {
      const uniqueKeys = Array.from(new Set(resultKeys));
      const pendingRequests = uniqueKeys
          .map((key) => ({ key, request: resultTotalCountRequestsRef.current[key] }))
          .filter((item) => Boolean(item.request));
      if (pendingRequests.length === 0) return;
      pendingRequests.forEach(({ key }) => {
          delete resultTotalCountRequestsRef.current[key];
      });
      const pendingKeySet = new Set(pendingRequests.map(({ key }) => key));
      setResultSets(prev => prev.map(rs =>
          pendingKeySet.has(rs.key) && rs.page
              ? { ...rs, page: { ...rs.page, totalCountLoading: false, totalCountCancelled: true } }
              : rs
      ));
      await Promise.all(pendingRequests.map(async ({ request }) => {
          if (!request?.queryId) return;
          try {
              await CancelQuery(request.queryId);
          } catch {
              // The query may have completed between the local cancellation and the backend call.
          }
      }));
  };

  useEffect(() => {
      const nextContext = `${currentConnectionId}\u0000${currentDb}\u0000${currentSchema}`;
      if (resultTotalCountContextRef.current === nextContext) return;
      resultTotalCountContextRef.current = nextContext;
      void cancelResultTotalCountRequests(Object.keys(resultTotalCountRequestsRef.current));
  }, [currentConnectionId, currentDb, currentSchema]);

  useEffect(() => () => {
      const requests = Object.values(resultTotalCountRequestsRef.current);
      resultTotalCountRequestsRef.current = {};
      requests.forEach((request) => {
          if (!request.queryId) return;
          void CancelQuery(request.queryId).catch(() => undefined);
      });
  }, []);

  const handleCancelResultTotalCount = async (resultKey: string) => {
      await cancelResultTotalCountRequests([resultKey]);
  };

  const handleResultPageChange = async (
      resultKey: string,
      page: number,
      pageSize: number,
      sortInfoOverride?: GridSortInfoItem[],
  ) => {
      const target = resultSetsRef.current.find((item) => item.key === resultKey);
      const executionConnectionId = target?.executionConnectionId || currentConnectionId;
      const executionDbName = target?.executionDbName || currentDb;
      if (!target?.page?.baseSql || !executionDbName) return;
      const conn = connections.find(c => c.id === executionConnectionId);
      if (!conn) return;
      const safePage = Math.max(1, Math.floor(Number(page) || 1));
      const safePageSize = Math.max(1, Math.floor(Number(pageSize) || target.page.pageSize || 1));
      const config = {
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || "",
          database: conn.config.database || "",
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" }
      };
      const dbType = String(config.type || 'mysql');
      const driver = String((config as any).driver || '');
      const normalizedDbType = String(resolveSqlDialect(dbType, driver, {
          oceanBaseProtocol: String((config as any).oceanBaseProtocol || ''),
      })).toLowerCase();
      const pageSql = buildQueryResultPageSql({
          baseSql: target.page.baseSql,
          dbType: normalizedDbType,
          driver,
          oceanBaseProtocol: String((config as any).oceanBaseProtocol || ''),
          page: safePage,
          pageSize: safePageSize,
          lookahead: true,
          sortInfo: sortInfoOverride || target.sortInfo || [],
      });

      const runSeq = ++runSeqRef.current;
      const isCurrentRun = () => runSeqRef.current === runSeq;
      let runQueryId = '';
      setExecutionRunToken(runSeq);
      setLoading(true);

      try {
          setResultSets(prev => prev.map(rs =>
              rs.key === resultKey && rs.page
                  ? { ...rs, page: { ...rs.page, loading: true } }
                  : rs
          ));
          if (currentQueryIdRef.current) {
              const previousQueryId = currentQueryIdRef.current;
              try {
                  await CancelQuery(previousQueryId);
              } catch {
                  // The previous query may already have completed.
              }
              if (!isCurrentRun()) return;
              if (currentQueryIdRef.current === previousQueryId) {
                  clearQueryId();
              }
          }
          let queryId: string;
          try {
              queryId = await GenerateQueryID();
          } catch {
              queryId = 'query-page-' + Date.now();
          }
          if (!isCurrentRun()) return;
          runQueryId = queryId;
          setQueryId(queryId);
          const res = await executeSqlEditorMultiQuery(
              config,
              executionDbName,
              pageSql,
              queryId,
              splitSQLStatements(pageSql, normalizedDbType),
              normalizedDbType,
              target.executionConnectionParams,
              executionConnectionId,
          );
          if (!isCurrentRun()) return;
          if (currentQueryIdRef.current === queryId) {
              clearQueryId();
              runQueryId = '';
          }
          if (!res?.success) {
              message.error(translate('query_editor.message.page_query_failed', {
                  error: formatSqlExecutionError(res?.message || translate('common.unknown'), { translate }),
              }));
              return;
          }

          const resultSetDataArray = Array.isArray(res.data) ? (res.data as any[]) : [];
          const rsData = resultSetDataArray[0];
          if (!rsData) {
              message.warning(translate('query_editor.message.page_query_empty'));
              return;
          }
          const rawRows = Array.isArray(rsData.rows) ? rsData.rows : [];
          const hasNext = rawRows.length > safePageSize;
          const rows = rawRows.slice(0, safePageSize);
          const rowKeyOffset = (safePage - 1) * safePageSize;
          rows.forEach((row: any, i: number) => {
              if (row && typeof row === 'object') row[GONAVI_ROW_KEY] = rowKeyOffset + i;
          });
          const cols = (rsData.columns && rsData.columns.length > 0)
              ? rsData.columns
              : (rows.length > 0 ? Object.keys(rows[0]) : target.columns);
          const pageMessages = normalizeQueryResultMessages(rsData?.messages);
          const totalState = resolveQueryResultPaginationTotal({
              current: safePage,
              pageSize: safePageSize,
              rowCount: rows.length,
              hasNext,
          });
          setResultSets(prev => prev.map(rs => {
              if (rs.key !== resultKey || !rs.page) return rs;
              const hasExactTotal = rs.page.totalKnown === true
                  && Number.isFinite(Number(rs.page.total))
                  && Number(rs.page.total) >= 0;
              return {
                  ...rs,
                  rows,
                  columns: cols,
                  messages: pageMessages,
                  resultType: 'grid',
                  truncated: false,
                  page: {
                      ...rs.page,
                      current: safePage,
                      pageSize: safePageSize,
                      ...(hasExactTotal
                          ? { total: rs.page.total, totalKnown: true }
                          : totalState),
                      loading: false,
                  },
              };
          }));
      } catch (err: any) {
          if (!isCurrentRun()) return;
          message.error(translate('query_editor.message.page_query_failed', {
              error: formatSqlExecutionError(err?.message || err || translate('common.unknown'), { translate }),
          }));
      } finally {
          if (isCurrentRun()) {
              setLoading(false);
              setResultSets(prev => prev.map(rs =>
                  rs.key === resultKey && rs.page?.loading
                      ? { ...rs, page: { ...rs.page, loading: false } }
                      : rs
              ));
          }
          if (runQueryId && currentQueryIdRef.current === runQueryId) {
              clearQueryId();
          }
      }
  };

  const handleResultSort = async (resultKey: string, field: string, order: string) => {
      const nextSortInfo = parseQueryResultSortInfo(field, order);
      const target = resultSetsRef.current.find((item) => item.key === resultKey);
      if (!target) return;

      if (target.page) {
          setResultSets(prev => prev.map(rs => (
              rs.key === resultKey ? { ...rs, sortInfo: nextSortInfo } : rs
          )));
          await handleResultPageChange(resultKey, 1, target.page.pageSize, nextSortInfo);
          return;
      }

      setResultSets(prev => prev.map(rs => (
          rs.key === resultKey
              ? {
                  ...rs,
                  rows: sortCompleteQueryResultRows(rs.rows, nextSortInfo),
                  sortInfo: nextSortInfo,
              }
              : rs
      )));
  };

  const handleElasticsearchRun = async (runAll = false) => {
      const fullSource = getCurrentQuery();
      if (!fullSource.trim()) return;
      const conn = connections.find((connection) => connection.id === currentConnectionId);
      if (!conn) {
          void message.error(translate('query_editor.message.connection_not_found'));
          return;
      }

      const firstExecutableLine = fullSource
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .find((line) => {
              const trimmed = line.trim();
              return trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//');
          })
          ?.trim() || '';
      if (!currentDb && (firstExecutableLine.startsWith('{') || firstExecutableLine.startsWith('['))) {
          void message.error(translate('query_editor.elasticsearch.no_index_for_json'));
          return;
      }

      const editor = editorRef.current;
      const model = editor?.getModel?.();
      const selection = editor?.getSelection?.();
      const position = normalizeEditorPosition(editor?.getPosition?.());
      const cursorOffset = model && position && typeof model.getOffsetAt === 'function'
          ? Number(model.getOffsetAt(position))
          : fullSource.length;
      const hasSelection = !!selection && !(typeof selection.isEmpty === 'function'
          ? selection.isEmpty()
          : selection.startLineNumber === selection.endLineNumber && selection.startColumn === selection.endColumn);
      const selectionRange = hasSelection && model && typeof model.getOffsetAt === 'function'
          ? {
              start: Number(model.getOffsetAt({
                  lineNumber: selection.startLineNumber,
                  column: selection.startColumn,
              })),
              end: Number(model.getOffsetAt({
                  lineNumber: selection.endLineNumber,
                  column: selection.endColumn,
              })),
          }
          : null;
      const resolution = runAll
          ? { ok: true as const, source: 'all' as const, text: fullSource }
          : resolveElasticsearchConsoleExecution(fullSource, cursorOffset, selectionRange);
      if (!resolution.ok) {
          void message.error(translate(resolution.error === 'selection_must_include_complete_requests'
              ? 'query_editor.elasticsearch.selection_incomplete'
              : 'query_editor.message.no_executable_sql'));
          return;
      }

      const sourceToExecute = resolution.text;
      const config = buildRpcConnectionConfig({
          ...conn.config,
          port: Number(conn.config.port),
          password: conn.config.password || '',
          database: conn.config.database || '',
          useSSH: conn.config.useSSH || false,
          ssh: conn.config.ssh || { host: '', port: 22, user: '', password: '', keyPath: '' },
          timeout: resolveQueryEditorConnectionTimeout(conn.config),
      }) as any;

      const runSeq = ++runSeqRef.current;

      if (currentQueryIdRef.current) {
          const previousQueryID = currentQueryIdRef.current;
          try {
              await CancelQuery(previousQueryID);
          } catch {
              // A previous request may already have completed.
          }
          if (currentQueryIdRef.current === previousQueryID) {
              clearQueryId();
          }
          if (!isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) return;
      }

      let inspection: any;
      try {
          inspection = await InspectElasticsearchConsole(config, currentDb || '', sourceToExecute);
      } catch (error: any) {
          if (!isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) return;
          void message.error(`${translate('query_editor.elasticsearch.inspect_failed')}: ${error?.message || String(error || '')}`);
          return;
      }
      if (!isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) return;
      if (!inspection?.success || inspection?.blocked) {
          void message.error(`${translate('query_editor.elasticsearch.inspect_failed')}: ${inspection?.message || inspection?.blockReason || translate('common.unknown')}`);
          return;
      }
      if (Number(inspection.serverMajor) > 0) {
          setElasticsearchServerMajor(Number(inspection.serverMajor));
      }

      let confirmationToken = '';
      if (inspection.requiresConfirmation) {
          confirmationToken = String(inspection.confirmationToken || '');
          const confirmed = await new Promise<boolean>((resolve) => {
              let settled = false;
              const settle = (value: boolean) => {
                  if (settled) return;
                  settled = true;
                  resolve(value);
              };
              showCountdownDangerConfirm({
                  title: translate('query_editor.elasticsearch.confirm_title'),
                  confirmText: translate('common.confirm'),
                  content: (
                      <div>
                          <div>{translate('query_editor.elasticsearch.confirm_description')}</div>
                          <ul style={{ margin: '10px 0 0', paddingLeft: 20 }}>
                              {(Array.isArray(inspection.requests) ? inspection.requests : []).map((request: any) => (
                                  <li key={`${request.index}-${request.method}-${request.path}`}>
                                      {buildElasticsearchInspectionDisplayLabel(request)}
                                  </li>
                              ))}
                          </ul>
                      </div>
                  ),
                  onOk: () => settle(true),
                  onCancel: () => settle(false),
                  afterClose: () => settle(false),
              });
          });
          if (!confirmed || !isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) return;
      }

      if (getCurrentQuery() !== fullSource) {
          void message.error(translate('query_editor.elasticsearch.inspect_failed'));
          return;
      }

      setExecutionRunToken(runSeq);
      setLoading(true);
      setExecutionError('');
      let queryID = '';
      try {
          try {
              queryID = await GenerateQueryID();
          } catch {
              queryID = `query-${uuidv4()}`;
          }
          if (!isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) return;
          setQueryId(queryID);
          const execution: any = await ExecuteElasticsearchConsole(
              config,
              currentDb || '',
              sourceToExecute,
              queryID,
              String(inspection.fingerprint || ''),
              confirmationToken,
          );
          if (!isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) {
              return;
          }

          const responseResults = Array.isArray(execution?.results) ? execution.results : [];
          const nextResultSets: ResultSet[] = responseResults.map((response: any, index: number) => {
              const rows = Array.isArray(response.rows) ? response.rows : [];
              const columns = Array.isArray(response.columns) ? response.columns.map(String) : [];
              const affectedRows = Number(response.affectedRows);
              const displayRows = rows.length === 0 && Number.isFinite(affectedRows) && affectedRows !== 0
                  ? [{ affectedRows }]
                  : rows;
              const displayColumns = columns.length === 0 && displayRows.length > 0 && 'affectedRows' in displayRows[0]
                  ? ['affectedRows']
                  : columns;
              const requestLabel = String(response.requestLabel || `${response.method || 'REQUEST'} ${response.path || ''}`).trim();
              if (Number(response.serverMajor) > 0) {
                  setElasticsearchServerMajor(Number(response.serverMajor));
              }
              return {
                  key: `es-result-${runSeq}-${Number(response.index ?? index)}`,
                  sql: requestLabel,
                  sourceStatementIndex: Number(response.index ?? index),
                  statementResultIndex: 0,
                  rows: displayRows,
                  columns: displayColumns,
                  messages: response.message ? [String(response.message)] : [],
                  resultType: 'elasticsearch',
                  requestLabel,
                  httpStatus: Number(response.httpStatus) || undefined,
                  rawResponse: String(response.rawResponse || ''),
                  partialFailure: response.partialFailure === true || response.outcome === 'partial',
                  ...buildElasticsearchOutcomeMetadata(response),
                  pkColumns: [],
                  readOnly: true,
              };
          });
          if (nextResultSets.length > 0) {
              updateResultPanelVisibility(true);
              const merged = mergeResultSets(resultSetsRef.current, nextResultSets, runAll);
              setResultSets(merged);
              activateExecutedResult(merged, nextResultSets, runSeq);
          }
          if (!execution?.success) {
              const errorMessage = String(execution?.message || translate('query_editor.elasticsearch.execute_failed'));
              setExecutionError(hasElasticsearchUncertainOutcome(execution)
                  ? `${errorMessage} (${translate('query_editor.elasticsearch.outcome_unknown')})`
                  : errorMessage);
              updateResultPanelVisibility(true);
              return;
          }
          void message.success(translate('query_editor.elasticsearch.execution_success'));
      } catch (error: any) {
          if (!isElasticsearchConsoleRunCurrent(runSeqRef.current, runSeq)) return;
          setExecutionError(`${translate('query_editor.elasticsearch.execute_failed')}: ${error?.message || String(error || '')}`);
          updateResultPanelVisibility(true);
      } finally {
          if (runSeqRef.current === runSeq) {
              setLoading(false);
          }
          if (currentQueryIdRef.current === queryID) {
              clearQueryId();
          }
      }
  };

  const handleRun = async () => {
    if (isElasticsearchMode) {
        await handleElasticsearchRun(false);
        return;
    }
    if (canSelectQuerySchema && schemaLoading) {
        message.info(translate('common.loading'));
        return;
    }
    const currentQuery = getCurrentQuery();
    if (!currentQuery.trim()) return;
    const executableSQL = getExecutableSQL();
    if (!executableSQL.trim()) {
        message.info(translate('query_editor.message.no_executable_sql'));
        clearUnpinnedResultSets();
        return;
    }
    if (!currentDb) {
        message.error(translate('query_editor.message.select_database_first'));
        return;
    }

    const runSeq = ++runSeqRef.current;
    let runQueryId = '';
    const isCurrentRun = () => runSeqRef.current === runSeq;
    setExecutionRunToken(runSeq);
    lockQueryContextForRun(runSeq);
    setLoading(true);
    setExecutionError('');
    const runStartTime = Date.now();

    try {
    await cancelResultTotalCountRequests(Object.keys(resultTotalCountRequestsRef.current));
    if (!isCurrentRun()) return;
    // 如果已有查询在运行，先取消它
    if (currentQueryIdRef.current) {
        const previousQueryID = currentQueryIdRef.current;
        try {
            await CancelQuery(previousQueryID);
        } catch (error) {
            // 忽略取消错误，可能查询已完成
        }
        if (!isCurrentRun()) return;
        if (currentQueryIdRef.current === previousQueryID) {
            clearQueryId();
        }
    }
    const conn = connections.find(c => c.id === currentConnectionId);
    if (!conn) {
        message.error(translate('query_editor.message.connection_not_found'));
        if (isCurrentRun()) setLoading(false);
        return;
    }
    const connCaps = getDataSourceCapabilities(conn.config);
    if (!connCaps.supportsQueryEditor) {
        message.error(translate(connCaps.query.messageKey || 'query_editor.message.unsupported_source'));
        if (isCurrentRun()) setLoading(false);
        return;
    }
    const restrictedStatements = findConnectionMutatingStatements(conn.config, executableSQL);
    if (restrictedStatements.length > 0) {
        message.warning(translate('query_editor.message.connection_readonly_blocked'));
        if (isCurrentRun()) setLoading(false);
        return;
    }

    if (findPotentiallyMutatingConnectionStatements(conn.config, executableSQL).length > 0) {
        const approved = await confirmProductionRisk({
            connection: conn,
            action: translate('connection.production_risk.action.execute_sql'),
            target: currentDb,
            translate,
        });
        if (!isCurrentRun()) return;
        if (!approved) {
            setLoading(false);
            return;
        }
    }

    const config = {
        ...conn.config,
        port: Number(conn.config.port),
        password: conn.config.password || "",
        database: conn.config.database || "",
        useSSH: conn.config.useSSH || false,
        ssh: conn.config.ssh || { host: "", port: 22, user: "", password: "", keyPath: "" },
        timeout: resolveQueryEditorConnectionTimeout(conn.config),
    };
        const executionConfig = buildSqlExecutionConnectionConfig(config);
        const executionConnectionParams = canSelectQuerySchema
            ? String(executionConfig.connectionParams || '')
            : undefined;
        const rawSQL = executableSQL;
        const rpcConfig = buildRpcConnectionConfig(executionConfig) as any;
        const dbType = String(rpcConfig.type || 'mysql');
        const driver = String((config as any).driver || '');
        const normalizedDbType = String(resolveSqlDialect(dbType, driver, {
            oceanBaseProtocol: (config as any).oceanBaseProtocol,
        })).trim().toLowerCase();
        const normalizedRawSQL = String(rawSQL || '').replace(/；/g, ';');

        // MongoDB 仍走逐条执行的旧路径
        const isMongoDB = normalizedDbType === 'mongodb';

        if (isMongoDB) {
            // MongoDB: 保持逐条执行
            const splitInput = normalizedRawSQL
                .replace(/^\s*\/\/.*$/gm, '')
                .replace(/^\s*#.*$/gm, '');
            const statements = splitSQLStatements(splitInput, normalizedDbType);
            const didExecuteAppendedSql = resultSets.length > 0
                && lastExecutedEditorQueryRef.current
                && currentQuery.startsWith(lastExecutedEditorQueryRef.current)
                && normalizedRawSQL.trim() === currentQuery.slice(lastExecutedEditorQueryRef.current.length).replace(/；/g, ';').trim();
            const didExecuteWholeEditor = areSqlStatementListsEqual(
                splitSQLStatements(currentQuery.replace(/；/g, ';'), normalizedDbType),
                statements,
            );
            if (statements.length === 0) {
                message.info(translate('query_editor.message.no_executable_sql'));
                clearUnpinnedResultSets();
                return;
            }

            const nextResultSets: ResultSet[] = [];
            const maxRows = Number(queryOptions?.maxRows) || 0;
            const wantsLimitProbe = Number.isFinite(maxRows) && maxRows > 0;
            let anyTruncated = false;

            for (let idx = 0; idx < statements.length; idx++) {
                const rawStatement = statements[idx];
                let executedSql = rawStatement;
                const shellConvert = convertMongoShellToJsonCommand(executedSql);
                if (shellConvert.recognized) {
                    if (shellConvert.error) {
                        const prefix = statements.length > 1
                            ? translate('query_editor.message.statement_failed_prefix', { index: idx + 1 })
                            : '';
                        updateResultPanelVisibility(true);
                        setExecutionError(formatSqlExecutionError(shellConvert.error, { prefix, translate }));
                        clearUnpinnedResultSets();
                        return;
                    }
                    if (shellConvert.command) {
                        executedSql = shellConvert.command;
                    }
                }
                if (wantsLimitProbe) {
                    const limitResult = applyMongoQueryAutoLimit(executedSql, maxRows);
                    if (limitResult.applied) {
                        executedSql = limitResult.command;
                    }
                }
                const startTime = Date.now();
                let queryId: string;
                try {
                    queryId = await GenerateQueryID();
                } catch (error) {
                    console.warn('GenerateQueryID failed, using local UUID fallback:', error);
                    queryId = 'query-' + uuidv4();
                }
                if (!isCurrentRun()) return;
                runQueryId = queryId;
                setQueryId(queryId);

                const res = await DBQueryWithCancel(buildRpcConnectionConfig(config) as any, currentDb, executedSql, queryId);
                if (!isCurrentRun()) return;
                if (currentQueryIdRef.current === queryId) {
                    clearQueryId();
                    runQueryId = '';
                }
                const legacyResultMessages = normalizeQueryResultMessages(res?.messages);
                const duration = Date.now() - startTime;
                addSqlLog({
                    id: `log-${Date.now()}-query-${idx + 1}`,
                    timestamp: Date.now(),
                    sql: executedSql,
                    status: res.success ? 'success' : 'error',
                    duration,
                    message: res.success ? '' : res.message,
                    affectedRows: (res.success && !Array.isArray(res.data)) ? (res.data as any).affectedRows : (Array.isArray(res.data) ? res.data.length : undefined),
                    dbName: currentDb
                });
                if (!res.success) {
                    const prefix = statements.length > 1
                        ? translate('query_editor.message.statement_failed_prefix', { index: idx + 1 })
                        : '';
                    updateResultPanelVisibility(true);
                    setExecutionError(formatSqlExecutionError(res.message, { prefix, translate }));
                    clearUnpinnedResultSets(QUERY_EDITOR_SQL_LOG_TAB_KEY);
                    return;
                }
                if (Array.isArray(res.data)) {
                    let rows = (res.data as any[]) || [];
                    let truncated = false;
                    if (wantsLimitProbe && Number.isFinite(maxRows) && maxRows > 0 && rows.length > maxRows) {
                        truncated = true;
                        anyTruncated = true;
                        rows = rows.slice(0, maxRows);
                    }
                    const cols = (res.fields && res.fields.length > 0)
                        ? (res.fields as string[])
                        : (rows.length > 0 ? Object.keys(rows[0]) : []);
                    rows.forEach((row: any, i: number) => {
                        if (row && typeof row === 'object') row[GONAVI_ROW_KEY] = i;
                    });
                    nextResultSets.push({
                        key: `result-${idx + 1}`,
                        sql: rawStatement,
                        exportSql: rawStatement,
                        sourceStatementIndex: idx + 1,
                        statementResultIndex: 1,
                        rows,
                        columns: cols,
                        messages: legacyResultMessages,
                        pkColumns: [],
                        readOnly: true,
                        truncated
                    });
                } else if (legacyResultMessages.length > 0) {
                    nextResultSets.push({
                        key: `result-${idx + 1}`,
                        sql: rawStatement,
                        exportSql: rawStatement,
                        sourceStatementIndex: idx + 1,
                        statementResultIndex: 1,
                        rows: [],
                        columns: [],
                        messages: legacyResultMessages,
                        resultType: 'message',
                        pkColumns: [],
                        readOnly: true,
                    });
                } else {
                    const affected = Number((res.data as any)?.affectedRows);
                    if (Number.isFinite(affected)) {
                        const row = { affectedRows: affected };
                        (row as any)[GONAVI_ROW_KEY] = 0;
                        nextResultSets.push({
                            key: `result-${idx + 1}`,
                            sql: rawStatement,
                            exportSql: rawStatement,
                            sourceStatementIndex: idx + 1,
                            statementResultIndex: 1,
                            rows: [row],
                            columns: ['affectedRows'],
                            messages: legacyResultMessages,
                            pkColumns: [],
                            readOnly: true
                        });
                    }
                }
            }
            if (nextResultSets.length > 0) {
                updateResultPanelVisibility(true);
            }
            const shouldReplaceAllResults = didExecuteWholeEditor;
            const mergedResultSets = mergeResultSets(resultSets, nextResultSets, shouldReplaceAllResults);
            setResultSets(mergedResultSets);
            activateExecutedResult(mergedResultSets, nextResultSets, runSeq);
            if (didExecuteAppendedSql || didExecuteWholeEditor) {
                lastExecutedEditorQueryRef.current = currentQuery;
            }
            if (statements.length > 1) {
                message.success(translate('query_editor.message.execution_multi_success', {
                    statements: statements.length,
                    results: nextResultSets.length,
                }));
            } else if (nextResultSets.length === 0) {
                message.success(translate('query_editor.message.execution_success'));
            }

        } else {
            // 非 MongoDB：使用 DBQueryMulti 一次性执行多条 SQL，后端返回多结果集
            const sourceStatements = splitSQLStatements(normalizedRawSQL, normalizedDbType);
            const didExecuteAppendedSql = resultSets.length > 0
                && lastExecutedEditorQueryRef.current
                && currentQuery.startsWith(lastExecutedEditorQueryRef.current)
                && normalizedRawSQL.trim() === currentQuery.slice(lastExecutedEditorQueryRef.current.length).replace(/；/g, ';').trim();
            const didExecuteWholeEditor = areSqlStatementListsEqual(
                splitSQLStatements(currentQuery.replace(/；/g, ';'), normalizedDbType),
                sourceStatements,
            );
            if (sourceStatements.length === 0) {
                message.info(translate('query_editor.message.no_executable_sql'));
                clearUnpinnedResultSets();
                return;
            }
            const useManagedTransaction = shouldUseSqlEditorManagedTransactionForType(normalizedDbType, sourceStatements, config);
            if (useManagedTransaction && pendingSqlTransactionRef.current) {
                message.warning(translate('query_editor.transaction.message.pending_managed_transaction'));
                return;
            }
            const managedTransactionStatementCount = sourceStatements
                .filter((statement) => shouldUseSqlEditorManagedTransactionForType(normalizedDbType, [statement], config))
                .length || sourceStatements.length;

            const forceReadOnlyResult = connCaps.forceReadOnlyQueryResult;
            const defaultOracleSchema = isOracleLikeDialect(normalizedDbType)
                ? resolveOracleLikeDefaultSchemaName(config)
                : '';
            const oracleTableCache = new Map<string, CompletionTableMeta[]>();
            const getOracleTablesForDb = async (dbName: string): Promise<CompletionTableMeta[]> => {
                const normalizedDbName = String(dbName || '').trim();
                if (!normalizedDbName) return [];
                const cacheKey = normalizedDbName.toLowerCase();
                const cached = oracleTableCache.get(cacheKey);
                if (cached) return cached;

                try {
                    const metadataSnapshot: QueryEditorMetadataRequestSnapshot = {
                        generation: metadataGenerationRef.current,
                        connectionId: currentConnectionId,
                        connectionConfig: conn.config,
                    };
                    const resTables = await DBGetTables(buildRpcConnectionConfig(config) as any, normalizedDbName);
                    if (!resTables?.success || !Array.isArray(resTables.data)) {
                        oracleTableCache.set(cacheKey, []);
                        return [];
                    }
                    const fetchedTables = resTables.data
                        .map((row: any) => {
                            const tableName = extractTableNameFromMetadataRow(row);
                            if (!tableName) return null;
                            return {
                                dbName: normalizedDbName,
                                tableName,
                            } as CompletionTableMeta;
                        })
                        .filter(Boolean) as CompletionTableMeta[];
                    if (
                        fetchedTables.length > 0
                        && isQueryEditorMetadataRequestCurrent(metadataSnapshot)
                    ) {
                        const knownKeys = new Set(tablesRef.current.map((table) => `${String(table.dbName || '').trim().toLowerCase()}\u0000${String(table.tableName || '').trim()}`));
                        const missing = fetchedTables.filter((table) => !knownKeys.has(`${String(table.dbName || '').trim().toLowerCase()}\u0000${String(table.tableName || '').trim()}`));
                        if (missing.length > 0) {
                            tablesRef.current = [...tablesRef.current, ...missing];
                            if (isActive) {
                                sharedTablesData = tablesRef.current;
                            }
                        }
                    }
                    oracleTableCache.set(cacheKey, fetchedTables);
                    return fetchedTables;
                } catch {
                    oracleTableCache.set(cacheKey, []);
                    return [];
                }
            };
            const executedSourceStatements: string[] = [];
            const allowOracleRowIDByStatement: boolean[] = [];
            for (const statement of sourceStatements) {
                let executableStatement = statement;
                let allowOracleRowID = false;
                if (isOracleLikeDialect(normalizedDbType)) {
                    const leadingTable = matchLeadingSelectTableReference(statement);
                    if (leadingTable) {
                        const leadingSegments = splitQueryIdentifierPathSegments(leadingTable.tableText);
                        const oracleLookupDbCandidates = leadingSegments.length >= 2
                            ? [String(leadingSegments[0]?.value || '').trim()].filter(Boolean)
                            : resolveOracleLikeLookupSchemaCandidates(config, currentDb);
                        let exactQualifiedTable: string | undefined;
                        for (const oracleLookupDbName of oracleLookupDbCandidates) {
                            const oracleTables = oracleLookupDbName ? await getOracleTablesForDb(oracleLookupDbName) : [];
                            if (!isCurrentRun()) return;
                            if (
                                isOracleBaseTableReference(statement, oracleLookupDbName, oracleTables)
                            ) {
                                allowOracleRowID = true;
                            }
                            exactQualifiedTable = resolveOracleExactCaseTableReference(statement, oracleLookupDbName, oracleTables, {
                                qualifyUnqualified: Boolean(
                                    leadingSegments.length === 1
                                    && oracleLookupDbName
                                    && oracleLookupDbName.toLowerCase() !== String(defaultOracleSchema || '').trim().toLowerCase(),
                                ),
                            });
                            if (exactQualifiedTable) {
                                break;
                            }
                        }
                        if (exactQualifiedTable) {
                            executableStatement = rewriteLeadingSelectTableReference(statement, exactQualifiedTable) || statement;
                        }
                    }
                }
                executedSourceStatements.push(executableStatement);
                allowOracleRowIDByStatement.push(allowOracleRowID);
            }
            const statementPlans: QueryStatementPlan[] = [];
            for (let index = 0; index < sourceStatements.length; index += 1) {
                const statementForPlan = executedSourceStatements[index] || sourceStatements[index];
                try {
                    const statementPlan = await resolveQueryLocatorPlan({
                        statement: statementForPlan,
                        originalStatement: sourceStatements[index],
                        dbType: normalizedDbType,
                        currentDb,
                        config: executionConfig,
                        forceReadOnly: forceReadOnlyResult,
                        allowOracleRowID: allowOracleRowIDByStatement[index],
                    });
                    if (!isCurrentRun()) return;
                    statementPlans.push(statementPlan);
                } catch (planError) {
                    if (!isCurrentRun()) return;
                    // 行定位计划失败绝不能阻断查询执行，兜底裸计划保证结果页始终呈现。
                    console.warn('resolveQueryLocatorPlan failed; falling back to a bare statement plan', planError);
                    statementPlans.push({
                        originalSql: sourceStatements[index],
                        executedSql: statementForPlan,
                        pkColumns: [],
                    });
                }
            }

            // 自动给 SELECT 语句注入行数限制（防止大结果集卡死）
            const maxRowsForLimit = Number(queryOptions?.maxRows) || 0;
            let anyLimitApplied = false;
            const executablePlans = statementPlans.map((plan) => {
                if (!Number.isFinite(maxRowsForLimit) || maxRowsForLimit <= 0) return plan;
                const result = applyQueryAutoLimit(plan.executedSql, normalizedDbType, maxRowsForLimit, driver);
                if (result.applied) anyLimitApplied = true;
                return { ...plan, executedSql: result.sql };
            });
            const executableStatements = executablePlans.map((plan) => plan.executedSql);
            const shouldPreserveOraclePlsqlBatch = isOracleLikeDialect(normalizedDbType) && containsOraclePlsqlDefinition(sourceStatements);
            const fullSQL = shouldPreserveOraclePlsqlBatch
                ? normalizeOracleSqlPlusSlashTerminators(normalizedRawSQL)
                : executableStatements.join(';\n');

            const startTime = Date.now();
            let queryId: string;
            try {
                queryId = await GenerateQueryID();
            } catch (error) {
                console.warn('GenerateQueryID failed, using local UUID fallback:', error);
                queryId = 'query-' + uuidv4();
            }
            if (!isCurrentRun()) return;
            runQueryId = queryId;
            setQueryId(queryId);

            const res = useManagedTransaction
                ? await DBQueryMultiTransactional(
                    buildRpcConnectionConfig(executionConfig) as any,
                    currentDb,
                    fullSQL,
                    queryId,
                )
                : await executeSqlEditorMultiQuery(
                    config,
                    currentDb,
                    fullSQL,
                    queryId,
                    executableStatements,
                    normalizedDbType,
                    executionConnectionParams,
                    currentConnectionId,
                );
            if (!isCurrentRun()) return;
            const duration = Date.now() - startTime;

            addSqlLog({
                id: `log-${Date.now()}-query-multi`,
                timestamp: Date.now(),
                sql: sourceStatements.join(';\n'),
                status: res.success ? 'success' : 'error',
                duration,
                message: res.success ? '' : res.message,
                dbName: currentDb
            });

            if (!res.success) {
                const errorMsg = res.message.toLowerCase();
                const isCancelledError = errorMsg.includes('context canceled') ||
                                         errorMsg.includes('查询已取消') ||
                                         errorMsg.includes('canceled') ||
                                         errorMsg.includes('cancelled') ||
                                         errorMsg.includes('statement canceled') ||
                                         errorMsg.includes('sql: statement canceled');
                const isTimeoutError = errorMsg.includes('context deadline exceeded') ||
                                       errorMsg.includes('timeout') ||
                                       hasLocalizedSqlTimeoutKeyword(errorMsg) ||
                                       errorMsg.includes('deadline exceeded');

                if (isCancelledError && !isTimeoutError) {
                    clearUnpinnedResultSets();
                    if (currentQueryIdRef.current === queryId) {
                        clearQueryId();
                    }
                    return;
                }

                updateResultPanelVisibility(true);
                setExecutionError(formatSqlExecutionError(res.message, { translate }));
                clearUnpinnedResultSets(QUERY_EDITOR_SQL_LOG_TAB_KEY);
                return;
            }

            if (res.transactionPending && res.transactionId) {
                const transactionId = String(res.transactionId);
                if (useManagedTransaction) {
                    activatePendingSqlTransaction({
                        id: transactionId,
                        commitMode: sqlEditorCommitMode,
                        autoCommitDelayMs: sqlEditorAutoCommitDelayMs,
                        createdAt: Date.now(),
                        statementCount: managedTransactionStatementCount,
                        dbType: normalizedDbType,
                        dbName: currentDb,
                        statements: sourceStatements,
                        executionDurationMs: duration,
                    });
                } else {
                    appendPendingSqlTransactionExecution({
                        transactionId,
                        statements: sourceStatements,
                        durationMs: duration,
                    });
                }
            }

            // res.data 是 ResultSetData[] 数组
            const resultSetDataArray = Array.isArray(res.data) ? (res.data as any[]) : [];
            const topLevelMessages = normalizeQueryResultMessages(res.messages);
            const nextResultSets: ResultSet[] = [];
            const maxRows = Number(queryOptions?.maxRows) || 0;
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
                if (shouldHideSqlServerAffectedResult) {
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
                    let rows = Array.isArray(rsData.rows) ? rsData.rows : [];
                    let truncated = false;
                    // 仅当前端自动注入了 LIMIT 时才做兜底截断；用户手写 LIMIT 时尊重原始结果
                    if (anyLimitApplied && Number.isFinite(maxRows) && maxRows > 0 && rows.length > maxRows) {
                        truncated = true;
                        anyTruncated = true;
                        rows = rows.slice(0, maxRows);
                    }
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
                        fallbackPageSize: maxRows,
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
                        executionDbName: currentDb,
                        executionConnectionParams,
                        pkColumns: plan?.pkColumns || [],
                        editLocator,
                        readOnly: forceReadOnlyResult || !editLocator || editLocator.readOnly,
                        truncated,
                        page,
                    });
                }
            }

            if (topLevelMessages.length > 0 && !nextResultSets.some((result) => Array.isArray(result.messages) && result.messages.length > 0)) {
                nextResultSets.push({
                    key: `result-${nextResultSets.length + 1}`,
                    sql: fullSQL,
                    exportSql: sourceStatements.join(';\n'),
                    sourceStatementIndex: 1,
                    statementResultIndex: (statementResultCounts.get(1) || 0) + 1,
                    rows: [],
                    columns: [],
                    messages: topLevelMessages,
                    resultType: 'message',
                    pkColumns: [],
                    readOnly: true,
                });
            }

            if (nextResultSets.length > 0) {
                updateResultPanelVisibility(true);
            }
            const shouldReplaceAllResults = didExecuteWholeEditor;
            const mergedResultSets = mergeResultSets(resultSets, nextResultSets, shouldReplaceAllResults);
            setResultSets(mergedResultSets);
            activateExecutedResult(mergedResultSets, nextResultSets, runSeq);
            if (didExecuteAppendedSql || didExecuteWholeEditor) {
                lastExecutedEditorQueryRef.current = currentQuery;
            }

            executablePlans.forEach((plan) => {
                if (plan.warning) message.warning(plan.warning);
            });

            // 后端附带的提示信息（如本次改走逐条执行的多语句回退提示）
            if (res.message) {
                message.info(res.message);
            }
            if (resultSetDataArray.length > 1) {
                message.success(translate('query_editor.message.execution_result_sets_success', {
                    results: nextResultSets.length,
                }));
            } else if (nextResultSets.length === 0) {
                message.success(translate('query_editor.message.execution_success'));
            }

        }
    } catch (e: any) {
        if (!isCurrentRun()) return;
        const formattedError = formatSqlExecutionError(e?.message || e, { translate });
        message.error(translate('query_editor.message.execution_failed_with_error', { error: formattedError }));
        addSqlLog({
            id: `log-${Date.now()}-error`,
            timestamp: Date.now(),
            sql: executableSQL || getExecutableSQL() || getCurrentQuery(),
            status: 'error',
            duration: Date.now() - runStartTime,
            message: e.message,
            dbName: currentDb
        });
        updateResultPanelVisibility(true);
        setExecutionError(formattedError);
        clearUnpinnedResultSets(QUERY_EDITOR_SQL_LOG_TAB_KEY);
    } finally {
        unlockQueryContextForRun(runSeq);
        if (isCurrentRun()) setLoading(false);
        if (runQueryId && currentQueryIdRef.current === runQueryId) {
            clearQueryId();
        }
    }
  };

  useEffect(() => {
      handleRunRef.current = handleRun;
      return () => {
          if (handleRunRef.current === handleRun) {
              handleRunRef.current = null;
          }
      };
  }, [handleRun]);

  const runAfterQueryContextReady = useCallback(() => {
      const requestSeq = deferredContextRunSeqRef.current + 1;
      deferredContextRunSeqRef.current = requestSeq;
      window.setTimeout(() => {
          if (
              requestSeq !== deferredContextRunSeqRef.current
              || !queryEditorActiveRef.current
          ) {
              return;
          }
          if (schemaLoadingRef.current) {
              pendingRunAfterSchemaLoadRef.current = true;
              return;
          }
          void handleRunRef.current?.();
      }, 500);
  }, []);

  useEffect(() => {
      if (isActive) return;
      deferredContextRunSeqRef.current += 1;
      pendingRunAfterSchemaLoadRef.current = false;
  }, [isActive]);

  useEffect(() => {
      if (schemaLoading || !pendingRunAfterSchemaLoadRef.current) return;
      pendingRunAfterSchemaLoadRef.current = false;
      deferredContextRunSeqRef.current += 1;
      if (queryEditorActiveRef.current) {
          void handleRunRef.current?.();
      }
  }, [schemaLoading]);

  useEffect(() => () => {
      deferredContextRunSeqRef.current += 1;
      pendingRunAfterSchemaLoadRef.current = false;
  }, []);

  const handleRunSelectedShortcut = async () => {
      await handleRun();
  };

  const handleCancel = async () => {
    const finishCancelledRun = () => {
      const lockedRunSeq = queryContextLockRunSeqRef.current;
      runSeqRef.current += 1;
      if (lockedRunSeq !== 0) {
        unlockQueryContextForRun(lockedRunSeq);
      }
      setLoading(false);
      setResultSets(prev => prev.map(result =>
        result.page?.loading
          ? { ...result, page: { ...result.page, loading: false } }
          : result
      ));
    };

    if (!currentQueryIdRef.current) {
      if (loading) {
        finishCancelledRun();
        message.success(translate('query_editor.message.cancel_success'));
        return;
      }
      message.warning(translate('query_editor.message.cancel_no_running'));
      return;
    }
    const queryIdToCancel = currentQueryIdRef.current;
    try {
      const res = await CancelQuery(queryIdToCancel);
      if (res.success) {
        message.success(translate('query_editor.message.cancel_success'));
        if (currentQueryIdRef.current === queryIdToCancel) {
          finishCancelledRun();
          clearQueryId();
        }
      } else {
        message.warning(res.message);
      }
    } catch (error: any) {
      message.error(translate('query_editor.message.cancel_failed', { error: error.message }));
    }
  };

  useEffect(() => {
      const handleSelectAllInEditor = (event: KeyboardEvent) => {
          if (!isActive) {
              return;
          }
          if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'a') {
              return;
          }

          const editor = editorRef.current;
          if (!editor) {
              return;
          }

          const targetNode = resolveEventTargetNode(event.target);
          const editorHasFocus = !!editor.hasTextFocus?.();
          const inEditorPane = !!(targetNode && editorPaneRef.current?.contains(targetNode));
          const inQueryEditor = !!(targetNode && queryEditorRootRef.current?.contains(targetNode));
          if (isEditableElement(event.target)) {
              return;
          }
          if (!editorHasFocus && !inEditorPane) {
              return;
          }
          if (!editorHasFocus && !inQueryEditor) {
              return;
          }

          event.preventDefault();
          event.stopPropagation();
          editor.focus?.();
          editor.trigger('keyboard', 'editor.action.selectAll', null);
      };

      window.addEventListener('keydown', handleSelectAllInEditor, true);
      return () => {
          window.removeEventListener('keydown', handleSelectAllInEditor, true);
      };
  }, [isActive]);

  useEffect(() => {
      const binding = runQueryShortcutBinding;
      if (!binding?.enabled || !binding.combo) {
          return;
      }

      const handleRunShortcut = (event: KeyboardEvent) => {
          if (!isActive) {
              return;
          }
          if (!isShortcutMatch(event, binding.combo)) {
              return;
          }
          const editorHasFocus = !!editorRef.current?.hasTextFocus?.();
          const targetNode = resolveEventTargetNode(event.target);
          if (!shouldHandleQueryEditorRunShortcutFallback({
              editorHasFocus,
              targetNode,
              editorPane: editorPaneRef.current,
          })) {
              return;
          }
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          void handleRunSelectedShortcut();
      };

      window.addEventListener('keydown', handleRunShortcut, true);
      return () => {
          window.removeEventListener('keydown', handleRunShortcut, true);
      };
  }, [isActive, runQueryShortcutBinding, handleRun]);

  // Re-register Monaco internal keybinding when runQuery shortcut changes
  useEffect(() => {
      if (objectHoverActionRef.current) {
          objectHoverActionRef.current.dispose();
          objectHoverActionRef.current = null;
      }

      if (!editorRef.current || !monacoRef.current) return;

      registerShowObjectInfoAction();

      return () => {
          if (objectHoverActionRef.current) {
              objectHoverActionRef.current.dispose();
              objectHoverActionRef.current = null;
          }
      };
  }, [languagePreference, registerShowObjectInfoAction]);

  useEffect(() => {
      const editor = editorRef.current;
      if (!editor) return;

      registerInsertSqlSnippetContextMenuAction(editor);

      return () => {
          if (insertSqlSnippetActionRef.current) {
              insertSqlSnippetActionRef.current.dispose();
              insertSqlSnippetActionRef.current = null;
          }
      };
  }, [languagePreference, registerInsertSqlSnippetContextMenuAction]);

  useEffect(() => {
      const editor = editorRef.current;
      if (!editor) return;

      registerTransformCaseContextMenuActions(editor);

      return () => {
          disposeTransformCaseContextMenuActions();
      };
  }, [languagePreference, disposeTransformCaseContextMenuActions, registerTransformCaseContextMenuActions]);

  useEffect(() => {
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      registerTriggerSqlAiCompletionAction(editor, monaco);

      return () => {
          if (triggerSqlAiCompletionActionRef.current) {
              triggerSqlAiCompletionActionRef.current.dispose();
              triggerSqlAiCompletionActionRef.current = null;
          }
      };
  }, [languagePreference, registerTriggerSqlAiCompletionAction]);

  useEffect(() => {
      triggerSqlAiCompletionKeydownDisposableRef.current?.dispose?.();
      triggerSqlAiCompletionKeydownDisposableRef.current = null;

      const editor = editorRef.current;
      const binding = triggerSqlAiCompletionShortcutBinding;
      if (isElasticsearchMode || !editor?.onKeyDown || !binding?.enabled || !binding.combo) {
          return;
      }

      triggerSqlAiCompletionKeydownDisposableRef.current = editor.onKeyDown((event: any) => {
          if (!isActive) {
              return;
          }

          const browserEvent = event?.browserEvent || event?.event || event;
          if (!browserEvent) {
              return;
          }
          if (!isTriggerSqlAiCompletionShortcutEvent(browserEvent)) {
              if (isPossibleTriggerSqlAiCompletionFallbackEvent(browserEvent)) {
                  triggerSqlAiCompletionFallbackRef.current = { observedAt: Date.now() };
              }
              return;
          }

          triggerSqlAiCompletionFallbackRef.current = null;
          event?.preventDefault?.();
          event?.stopPropagation?.();
          browserEvent.preventDefault?.();
          browserEvent.stopPropagation?.();
          triggerAiInlineCompletionRef.current?.();
      });

      return () => {
          triggerSqlAiCompletionKeydownDisposableRef.current?.dispose?.();
          triggerSqlAiCompletionKeydownDisposableRef.current = null;
      };
  }, [isActive, isElasticsearchMode, isPossibleTriggerSqlAiCompletionFallbackEvent, isTriggerSqlAiCompletionShortcutEvent, triggerSqlAiCompletionShortcutBinding]);

  useEffect(() => {
      if (runQueryActionRef.current) {
          runQueryActionRef.current.dispose();
          runQueryActionRef.current = null;
      }

      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      const binding = runQueryShortcutBinding;
      if (!binding?.enabled || !binding.combo) return;

      const keyBinding = comboToMonacoKeyBinding(
          binding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
      );
      if (keyBinding) {
          runQueryActionRef.current = editor.addAction({
              id: 'gonavi.runQuery',
              label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.runQuery.label'),
              keybindings: [keyBinding.keyMod | keyBinding.keyCode],
              keybindingContext: 'editorTextFocus',
              run: () => {
                  window.dispatchEvent(new CustomEvent('gonavi:run-active-query', {
                      detail: { requireSelection: true },
                  }));
              },
          });
      }

      return () => {
          if (runQueryActionRef.current) {
              runQueryActionRef.current.dispose();
              runQueryActionRef.current = null;
          }
      };
  }, [activeShortcutPlatform, languagePreference, runQueryShortcutBinding]);

  useEffect(() => {
      if (selectCurrentStatementActionRef.current) {
          selectCurrentStatementActionRef.current.dispose();
          selectCurrentStatementActionRef.current = null;
      }
      if (macFindWithSelectionGuardActionRef.current) {
          macFindWithSelectionGuardActionRef.current.dispose();
          macFindWithSelectionGuardActionRef.current = null;
      }

      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      const binding = selectCurrentStatementShortcutBinding;
      if (binding?.enabled && binding.combo) {
          const keyBinding = comboToMonacoKeyBinding(
              binding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
          );
          if (keyBinding) {
              selectCurrentStatementActionRef.current = editor.addAction({
                  id: 'gonavi.selectCurrentStatement',
                  label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.selectCurrentStatement.label'),
                  keybindings: [keyBinding.keyMod | keyBinding.keyCode],
                  run: handleSelectCurrentStatement,
              });
          }
      }

      const macFindWithSelectionGuardKeyBinding = activeShortcutPlatform === 'mac'
          ? comboToMonacoKeyBinding(
              QUERY_EDITOR_MAC_FIND_WITH_SELECTION_COMBO,
              monaco.KeyMod,
              monaco.KeyCode,
              activeShortcutPlatform,
          )
          : null;
      if (macFindWithSelectionGuardKeyBinding) {
          macFindWithSelectionGuardActionRef.current = editor.addAction({
              id: QUERY_EDITOR_MAC_FIND_WITH_SELECTION_GUARD_ACTION_ID,
              label: 'GoNavi: Suppress macOS Cmd+E Find with Selection',
              keybindings: [
                  macFindWithSelectionGuardKeyBinding.keyMod
                  | macFindWithSelectionGuardKeyBinding.keyCode,
              ],
              run: () => {
                  if (
                      binding?.enabled
                      && normalizeShortcutCombo(binding.combo) === QUERY_EDITOR_MAC_FIND_WITH_SELECTION_COMBO
                  ) {
                      void handleSelectCurrentStatement();
                  }
              },
          });
      }

      return () => {
          if (selectCurrentStatementActionRef.current) {
              selectCurrentStatementActionRef.current.dispose();
              selectCurrentStatementActionRef.current = null;
          }
          if (macFindWithSelectionGuardActionRef.current) {
              macFindWithSelectionGuardActionRef.current.dispose();
              macFindWithSelectionGuardActionRef.current = null;
          }
      };
  }, [activeShortcutPlatform, languagePreference, selectCurrentStatementShortcutBinding, handleSelectCurrentStatement]);

  useEffect(() => {
      if (duplicateCurrentLineActionRef.current) {
          duplicateCurrentLineActionRef.current.dispose();
          duplicateCurrentLineActionRef.current = null;
      }

      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      const binding = duplicateCurrentLineShortcutBinding;
      if (!binding?.enabled || !binding.combo) return;

      const keyBinding = comboToMonacoKeyBinding(
          binding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
      );
      if (keyBinding) {
          duplicateCurrentLineActionRef.current = editor.addAction({
              id: 'gonavi.duplicateCurrentLine',
              label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.duplicateCurrentLine.label'),
              keybindings: [keyBinding.keyMod | keyBinding.keyCode],
              run: handleDuplicateCurrentLine,
          });
      }

      return () => {
          if (duplicateCurrentLineActionRef.current) {
              duplicateCurrentLineActionRef.current.dispose();
              duplicateCurrentLineActionRef.current = null;
          }
      };
  }, [activeShortcutPlatform, duplicateCurrentLineShortcutBinding, handleDuplicateCurrentLine, languagePreference]);

  useEffect(() => {
      if (saveQueryActionRef.current) {
          saveQueryActionRef.current.dispose();
          saveQueryActionRef.current = null;
      }

      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      const binding = saveQueryShortcutBinding;
      if (!binding?.enabled || !binding.combo) return;

      const keyBinding = comboToMonacoKeyBinding(
          binding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
      );
      if (keyBinding) {
          saveQueryActionRef.current = editor.addAction({
              id: 'gonavi.saveQuery',
              label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.saveQuery.label'),
              keybindings: [keyBinding.keyMod | keyBinding.keyCode],
              run: () => {
                  window.dispatchEvent(new CustomEvent('gonavi:save-active-query'));
              },
          });
      }

      return () => {
          if (saveQueryActionRef.current) {
              saveQueryActionRef.current.dispose();
              saveQueryActionRef.current = null;
          }
      };
  }, [activeShortcutPlatform, languagePreference, saveQueryShortcutBinding]);

  useEffect(() => {
      if (saveQueryAsActionRef.current) {
          saveQueryAsActionRef.current.dispose();
          saveQueryAsActionRef.current = null;
      }

      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco || !currentSavedQuery || tab.filePath) return;

      const binding = saveQueryAsShortcutBinding;
      if (!binding?.enabled || !binding.combo) return;

      const keyBinding = comboToMonacoKeyBinding(
          binding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
      );
      if (keyBinding) {
          saveQueryAsActionRef.current = editor.addAction({
              id: 'gonavi.saveQueryAs',
              label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.saveQueryAs.label'),
              keybindings: [keyBinding.keyMod | keyBinding.keyCode],
              run: () => {
                  window.dispatchEvent(new CustomEvent('gonavi:save-active-query-as'));
              },
          });
      }

      return () => {
          if (saveQueryAsActionRef.current) {
              saveQueryAsActionRef.current.dispose();
              saveQueryAsActionRef.current = null;
          }
      };
  }, [activeShortcutPlatform, currentSavedQuery, languagePreference, saveQueryAsShortcutBinding, tab.filePath]);

  useEffect(() => {
      if (findInEditorActionRef.current) {
          findInEditorActionRef.current.dispose();
          findInEditorActionRef.current = null;
      }

      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      const keyBinding = comboToMonacoKeyBinding(
          findInEditorShortcutCombo,
          monaco.KeyMod,
          monaco.KeyCode,
          activeShortcutPlatform,
      );
      if (keyBinding) {
          findInEditorActionRef.current = editor.addAction({
              id: 'gonavi.findInEditor',
              label: buildQueryEditorMonacoActionLabel('query_editor.action.find_in_editor'),
              keybindings: [keyBinding.keyMod | keyBinding.keyCode],
              run: () => {
                  window.dispatchEvent(new CustomEvent('gonavi:find-active-query'));
              },
          });
      }

      return () => {
          if (findInEditorActionRef.current) {
              findInEditorActionRef.current.dispose();
              findInEditorActionRef.current = null;
          }
      };
  }, [activeShortcutPlatform, findInEditorShortcutCombo, languagePreference]);

  useEffect(() => {
      if (formatSqlActionRef.current) {
          formatSqlActionRef.current.dispose();
          formatSqlActionRef.current = null;
      }

      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      const binding = formatSqlShortcutBinding;
      if (!binding?.enabled || !binding.combo) return;

      const keyBinding = comboToMonacoKeyBinding(
          binding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
      );
      if (keyBinding) {
          formatSqlActionRef.current = editor.addAction({
              id: 'gonavi.formatSql',
              label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.formatSql.label'),
              keybindings: [keyBinding.keyMod | keyBinding.keyCode],
              run: () => {
                  window.dispatchEvent(new CustomEvent('gonavi:format-active-query'));
              },
          });
      }

      return () => {
          if (formatSqlActionRef.current) {
              formatSqlActionRef.current.dispose();
              formatSqlActionRef.current = null;
          }
      };
  }, [activeShortcutPlatform, languagePreference, formatSqlShortcutBinding]);

  useEffect(() => {
      const editor = editorRef.current;
      if (!editor) return;

      registerQueryEditorAiContextMenuActions(editor);

      return () => {
          disposeQueryEditorAiContextMenuActions();
      };
  }, [languagePreference, disposeQueryEditorAiContextMenuActions, registerQueryEditorAiContextMenuActions]);

  useEffect(() => {
      refreshQueryEditorSlashCommandDefs();
  }, [languagePreference, refreshQueryEditorSlashCommandDefs]);

  useEffect(() => {
      if (toggleQueryResultsPanelActionRef.current) {
          toggleQueryResultsPanelActionRef.current.dispose();
          toggleQueryResultsPanelActionRef.current = null;
      }

      const editor = editorRef.current;
      const monaco = monacoRef.current;
      if (!editor || !monaco) return;

      const binding = toggleQueryResultsPanelShortcutBinding;
      if (!binding?.enabled || !binding.combo) return;

      const keyBinding = comboToMonacoKeyBinding(
          binding.combo, monaco.KeyMod, monaco.KeyCode, activeShortcutPlatform,
      );
      if (keyBinding) {
          toggleQueryResultsPanelActionRef.current = editor.addAction({
              id: 'gonavi.toggleQueryResultsPanel',
              label: buildQueryEditorMonacoActionLabel('app.shortcuts.action.toggleQueryResultsPanel.label'),
              keybindings: [keyBinding.keyMod | keyBinding.keyCode],
              run: toggleResultPanelVisibility,
          });
      }

      return () => {
          if (toggleQueryResultsPanelActionRef.current) {
              toggleQueryResultsPanelActionRef.current.dispose();
              toggleQueryResultsPanelActionRef.current = null;
          }
      };
  }, [activeShortcutPlatform, languagePreference, toggleQueryResultsPanelShortcutBinding, toggleResultPanelVisibility]);

  useEffect(() => {
      const handleRunActiveQuery = (event: Event) => {
          if (!isActive) {
              return;
          }
          if ((event as CustomEvent<{ requireSelection?: boolean }>).detail?.requireSelection) {
              void handleRunSelectedShortcut();
              return;
          }
          void handleRun();
      };

      window.addEventListener('gonavi:run-active-query', handleRunActiveQuery as EventListener);
      return () => {
          window.removeEventListener('gonavi:run-active-query', handleRunActiveQuery as EventListener);
      };
  }, [isActive, handleRun, handleRunSelectedShortcut]);

  useEffect(() => {
      const handleFindActiveQuery = () => {
          if (!isActive) {
              return;
          }
          handleOpenEditorFind();
      };

      window.addEventListener('gonavi:find-active-query', handleFindActiveQuery as EventListener);
      return () => {
          window.removeEventListener('gonavi:find-active-query', handleFindActiveQuery as EventListener);
      };
  }, [handleOpenEditorFind, isActive]);

  useEffect(() => {
      const binding = selectCurrentStatementShortcutBinding;
      if (!binding?.enabled || !binding.combo) {
          return;
      }

      const handleSelectCurrentStatementShortcut = (event: KeyboardEvent) => {
          if (!isActive) {
              return;
          }
          if (!isShortcutMatch(event, binding.combo)) {
              return;
          }

          const editor = editorRef.current;
          const targetNode = resolveEventTargetNode(event.target);
          const editorHasFocus = !!editor?.hasTextFocus?.();
          const inQueryEditor = !!(targetNode && queryEditorRootRef.current?.contains(targetNode));
          if (!editorHasFocus && !inQueryEditor && !isDocumentLevelShortcutTarget(targetNode)) {
              return;
          }

          event.preventDefault();
          event.stopPropagation();
          void handleSelectCurrentStatement();
      };

      window.addEventListener('keydown', handleSelectCurrentStatementShortcut, true);
      return () => {
          window.removeEventListener('keydown', handleSelectCurrentStatementShortcut, true);
      };
  }, [handleSelectCurrentStatement, isActive, selectCurrentStatementShortcutBinding]);

  useEffect(() => {
      const binding = selectCurrentStatementShortcutBinding;
      if (
          activeShortcutPlatform !== 'mac'
          || !binding?.enabled
          || normalizeShortcutCombo(binding.combo) !== 'Meta+E'
      ) {
          return;
      }

      try {
          return EventsOn(QUERY_EDITOR_NATIVE_SELECT_CURRENT_LINE_EVENT, () => {
              if (!isActive) {
                  return;
              }
              void handleSelectCurrentStatement();
          });
      } catch {
          return;
      }
  }, [activeShortcutPlatform, handleSelectCurrentStatement, isActive, selectCurrentStatementShortcutBinding]);

  useEffect(() => {
      const binding = duplicateCurrentLineShortcutBinding;
      if (!binding?.enabled || !binding.combo) {
          return;
      }

      const handleDuplicateCurrentLineShortcut = (event: KeyboardEvent) => {
          if (!isActive) {
              return;
          }
          if (!isShortcutMatch(event, binding.combo)) {
              return;
          }

          const editor = editorRef.current;
          const targetNode = resolveEventTargetNode(event.target);
          const editorHasFocus = !!editor?.hasTextFocus?.();
          const inQueryEditor = !!(targetNode && queryEditorRootRef.current?.contains(targetNode));
          if (!editorHasFocus && !inQueryEditor && !isDocumentLevelShortcutTarget(targetNode)) {
              return;
          }

          event.preventDefault();
          event.stopPropagation();
          handleDuplicateCurrentLine();
      };

      window.addEventListener('keydown', handleDuplicateCurrentLineShortcut, true);
      return () => {
          window.removeEventListener('keydown', handleDuplicateCurrentLineShortcut, true);
      };
  }, [duplicateCurrentLineShortcutBinding, handleDuplicateCurrentLine, isActive]);

  // 监听由 TabManager 分发的专用注入事件
  useEffect(() => {
      const handleInsertSql = (e: any) => {
          if (e.detail?.tabId !== tab.id || !e.detail?.sql) return;
          const { sql: sqlText, connectionId, dbName } = e.detail;

          const activeConnectionId = String(currentConnectionIdRef.current || '').trim();
          const targetConnectionId = String(connectionId || activeConnectionId).trim();
          const targetDbName = String(
              dbName || (targetConnectionId === activeConnectionId ? currentDbRef.current : ''),
          ).trim();
          if (!switchQueryContext(targetConnectionId, targetDbName)) return;

          const editor = editorRef.current;
          const monaco = monacoRef.current;
          if (editor && monaco) {
              const model = editor.getModel();
              const existingContent = editor.getValue?.() || '';

              // runImmediately 模式下，如果编辑器内容已是待注入的 SQL（TabManager 创建时已传入），
              // 跳过追加，直接选中全部内容并执行
              if (e.detail.runImmediately && existingContent.trim() === sqlText.trim()) {
                  if (model) {
                      const lineCount = model.getLineCount();
                      const maxCol = model.getLineMaxColumn(lineCount);
                      editor.setSelection(new monaco.Range(1, 1, lineCount, maxCol));
                      editor.focus();
                      runAfterQueryContextReady();
                  }
              } else {
              let position = editor.getPosition();
              if (!position && model) {
                  const lineCount = model.getLineCount();
                  const maxCol = model.getLineMaxColumn(lineCount);
                  position = new monaco.Position(lineCount, maxCol);
              }

              if (position) {
                  const mText = (sqlText.endsWith('\n') ? sqlText : sqlText + '\n');
                  const startRange = new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);
                  
                  editor.executeEdits('ai-insert', [{
                      range: startRange,
                      text: (position.column > 1 ? '\n' : '') + mText,
                      forceMoveMarkers: true
                  }]);
                  const nextValue = editor.getValue?.();
                  if (typeof nextValue === 'string') {
                      applyQueryState(nextValue);
                  }
                  
                  // 定位并滚动到可见区域
                  const targetLine = position.lineNumber + (position.column > 1 ? 1 : 0);
                  editor.revealLineInCenterIfOutsideViewport(targetLine);
                  editor.setPosition({ lineNumber: targetLine + mText.split('\n').length - 1, column: 1 });
                  editor.focus();
                  
                  if (!e.detail.runImmediately) {
                      message.success(translate('query_editor.message.insert_success'));
                  }

                  if (e.detail.runImmediately) {
                      const endPosition = editor.getPosition();
                      editor.setSelection(new monaco.Range(
                          targetLine, 1,
                          endPosition.lineNumber, endPosition.column
                      ));
                      // 🔧 延迟 500ms 等待连接/数据库切换的 setState 生效后再执行
                      runAfterQueryContextReady();
                  }
              }
              }
          } else {
              applyQueryState(getCurrentQuery() ? `${getCurrentQuery()}\n${sqlText}` : sqlText);
              message.success(translate('query_editor.message.append_success'));
          }
      };
      window.addEventListener('gonavi:insert-sql-to-tab', handleInsertSql as EventListener);
      return () => window.removeEventListener('gonavi:insert-sql-to-tab', handleInsertSql as EventListener);
  }, [runAfterQueryContextReady, switchQueryContext, tab.id]);

  const resolveDefaultQueryName = () => {
      const rawTitle = String(tab.title || '').trim();
      if (isLocalizedUntitledQueryTitle(rawTitle)) {
          return translate('query_editor.save_modal.unnamed');
      }
      return rawTitle;
  };

  const persistQuery = async (payload: {
      id: string;
      name: string;
      createdAt?: number;
      openCopyInNewTab?: boolean;
  }): Promise<boolean> => {
      const sql = getCurrentQuery();
      lastLocalQueryRef.current = sql;
      const saved = {
          id: payload.id,
          name: payload.name,
          sql,
          connectionId: currentConnectionId,
          dbName: currentDb || tab.dbName || '',
          createdAt: payload.createdAt ?? Date.now(),
      };
      const persisted = await runQueuedSaveOperation(() => saveQuery(saved));
      if (!queryEditorMountedRef.current) {
          return false;
      }

      const latestSql = getCurrentQuery();
      const latestConnectionId = currentConnectionIdRef.current;
      const latestDbName = currentDbRef.current;
      const latestTab = useStore.getState().tabs?.find((item) => item.id === tab.id) || tab;
      const nextTab = {
          ...latestTab,
          id: payload.openCopyInNewTab ? persisted.id : latestTab.id,
          title: persisted.name,
          query: latestSql,
          connectionId: latestConnectionId,
          dbName: latestDbName,
          savedQueryId: persisted.id,
      };
      addTab(nextTab);
      lastLocalQueryRef.current = latestSql;
      setQuery(latestSql);

      const savedSnapshotStillCurrent = latestSql === String(persisted.sql ?? '')
          && String(latestConnectionId || '').trim() === String(persisted.connectionId || '').trim()
          && String(latestDbName || '').trim() === String(persisted.dbName || '').trim();
      if (payload.openCopyInNewTab) {
          const sourceSnapshotStillCurrent = latestSql === String(currentSavedQuery?.sql ?? '')
              && String(latestConnectionId || '').trim() === String(currentSavedQuery?.connectionId || '').trim()
              && String(latestDbName || '').trim() === String(currentSavedQuery?.dbName || '').trim();
          if (sourceSnapshotStillCurrent) {
              clearQueryTabDraft(latestTab.id);
          } else {
              persistQueryTabDraftSnapshot(latestTab, latestSql, {
                  connectionId: latestConnectionId,
                  dbName: latestDbName,
              });
          }
          if (savedSnapshotStillCurrent) {
              clearQueryTabDraft(nextTab.id);
          } else {
              persistQueryTabDraftSnapshot(nextTab, latestSql, {
                  connectionId: latestConnectionId,
                  dbName: latestDbName,
              });
          }
      } else if (savedSnapshotStillCurrent) {
          clearQueryTabDraft(tab.id);
      } else {
          persistQueryTabDraftSnapshot(nextTab, latestSql, {
              connectionId: latestConnectionId,
              dbName: latestDbName,
          });
      }
      flushQueryTabDraftSnapshots();
      return true;
  };

  const openSaveQueryModal = (mode: 'save' | 'saveAs' | 'rename') => {
      setSaveModalMode(mode);
      saveForm.setFieldsValue({ name: currentSavedQuery?.name || resolveDefaultQueryName() });
      setIsSaveModalOpen(true);
  };

  const handleQuickSave = async () => {
      const filePath = String(tab.filePath || '').trim();
      if (filePath) {
          const sql = getCurrentQuery();
          try {
              const res = await runQueuedSaveOperation(() => WriteSQLFile(filePath, sql));
              if (!queryEditorMountedRef.current) {
                  return;
              }
              if (!res.success) {
                  message.error(translate('query_editor.message.save_sql_file_failed', {
                      error: res.message || translate('common.unknown'),
                  }));
                  return;
              }
              const latestSql = getCurrentQuery();
              const latestConnectionId = currentConnectionIdRef.current;
              const latestDbName = currentDbRef.current;
              const latestTab = useStore.getState().tabs?.find((item) => item.id === tab.id) || tab;
              const nextTab = {
                  ...latestTab,
                  query: latestSql,
                  connectionId: latestConnectionId,
                  dbName: latestDbName,
                  filePath,
                  savedQueryId: undefined,
              };
              addTab(nextTab);
              lastLocalQueryRef.current = latestSql;
              setQuery(latestSql);
              if (latestSql === sql) {
                  clearQueryTabDraft(tab.id);
              } else {
                  persistQueryTabDraftSnapshot(nextTab, latestSql, {
                      connectionId: latestConnectionId,
                      dbName: latestDbName,
                  });
              }
              flushQueryTabDraftSnapshots();
              message.success(translate('query_editor.message.sql_file_saved'));
          } catch (error) {
              message.error(translate('query_editor.message.save_sql_file_failed', {
                  error: error instanceof Error ? error.message : String(error),
              }));
          }
          return;
      }

      const existed = currentSavedQuery || null;
      const fallbackSavedId = String(tab.savedQueryId || '').trim();
      const saveId = existed?.id || fallbackSavedId || '';
      if (!saveId) {
          openSaveQueryModal('save');
          return;
      }
      const saveName = existed?.name || resolveDefaultQueryName();
      if (await persistQuery({ id: saveId, name: saveName, createdAt: existed?.createdAt })) {
          message.success(translate('query_editor.message.saved'));
      }
  };

  const handleRenameQuery = () => {
      const existed = currentSavedQuery || null;
      const fallbackSavedId = String(tab.savedQueryId || '').trim();
      if (!existed && !fallbackSavedId) {
          message.warning(translate('query_editor.message.save_first_before_rename'));
          openSaveQueryModal('save');
          return;
      }
      openSaveQueryModal('rename');
  };

  const handleSaveQueryAs = () => {
      if (!currentSavedQuery || tab.filePath) {
          return;
      }
      openSaveQueryModal('saveAs');
  };

  useEffect(() => {
      const handleRenameQueryRequest = (event: Event) => {
          if (!(event instanceof CustomEvent) || event.detail?.tabId !== tab.id) {
              return;
          }
          handleRenameQuery();
      };

      window.addEventListener(QUERY_TAB_RENAME_REQUEST_EVENT, handleRenameQueryRequest as EventListener);
      return () => {
          window.removeEventListener(QUERY_TAB_RENAME_REQUEST_EVENT, handleRenameQueryRequest as EventListener);
      };
  }, [handleRenameQuery, tab.id]);

  const handleExportSQLFile = async () => {
      try {
          const res = await ExportSQLFile(currentSavedQuery?.name || resolveDefaultQueryName(), getCurrentQuery());
          if (!res.success) {
              if ((res.message || '') !== '已取消') {
                  message.error(translate('query_editor.message.export_sql_file_failed', {
                      error: res.message || translate('common.unknown'),
                  }));
              }
              return;
          }
          message.success(translate('query_editor.message.export_sql_file_success'));
      } catch (error) {
          const errorDetail = error instanceof Error
              ? error.message || translate('common.unknown')
              : (typeof (error as any)?.message === 'string' && (error as any).message)
                  || (typeof error === 'string' && error)
                  || translate('common.unknown');
          message.error(translate('query_editor.message.export_sql_file_failed', {
              error: errorDetail,
          }));
      }
  };

  const insertElasticsearchConsoleTemplate = useCallback((templateSource: string) => {
      const source = String(templateSource || '');
      if (!source) return;
      const editor = editorRef.current;
      const monaco = monacoRef.current;
      const model = editor?.getModel?.();
      if (!editor || !monaco?.Range || !model) {
          const current = getCurrentQuery();
          syncQueryToEditor(current.trim() ? `${current.trimEnd()}\n\n${source}` : source);
          return;
      }
      const current = String(model.getValue?.() || '');
      const selection = editor.getSelection?.();
      const position = normalizeEditorPosition(editor.getPosition?.())
          || { lineNumber: model.getLineCount?.() || 1, column: model.getLineMaxColumn?.(model.getLineCount?.() || 1) || 1 };
      const range = current.trim()
          ? (selection || new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column))
          : (model.getFullModelRange?.() || new monaco.Range(1, 1, 1, 1));
      const selectedText = selection ? String(model.getValueInRange?.(selection) || '') : '';
      const hasSelection = !!selectedText;
      const cursorOffset = typeof model.getOffsetAt === 'function'
          ? Number(model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }))
          : current.length;
      const leading = current.trim() && !hasSelection && cursorOffset > 0 ? '\n\n' : '';
      const trailing = current.trim() && !hasSelection && cursorOffset < current.length ? '\n\n' : '';
      editor.focus?.();
      editor.pushUndoStop?.();
      editor.executeEdits?.('gonavi-insert-elasticsearch-template', [{
          range,
          text: `${leading}${source}${trailing}`,
          forceMoveMarkers: true,
      }]);
      editor.pushUndoStop?.();
      applyQueryState(String(editor.getValue?.() || source));
  }, [applyQueryState, getCurrentQuery]);

  const elasticsearchTemplateMenuItems: MenuProps['items'] = useMemo(() => (
      buildElasticsearchConsoleTemplates(currentDb, {
          majorVersion: elasticsearchServerMajor || 8,
      }).map((template) => ({
          key: template.id,
          icon: <FileTextOutlined />,
          danger: template.dangerous,
          label: template.dangerous
              ? `${translate('query_editor.elasticsearch.danger_badge')} · ${translate(template.labelKey)}`
              : translate(template.labelKey),
          onClick: () => insertElasticsearchConsoleTemplate(template.source),
      }))
  ), [currentDb, elasticsearchServerMajor, insertElasticsearchConsoleTemplate]);

  const saveMoreMenuItems: MenuProps['items'] = [
      {
          type: 'group',
          key: 'query-actions',
          label: translate('tab_manager.kind_badge.query'),
          children: [
              ...(currentSavedQuery && !tab.filePath ? [{
                  key: 'save-query-as',
                  icon: <SaveOutlined />,
                  label: (
                      <span className="gn-v2-context-menu-item-title">
                          {translate('query_editor.action.save_as')}
                          {saveQueryAsShortcutBinding?.enabled && saveQueryAsShortcutBinding.combo && (
                              <span className="gn-v2-context-menu-kbd">
                                  {getShortcutDisplayLabel(saveQueryAsShortcutBinding.combo, activeShortcutPlatform)}
                              </span>
                          )}
                      </span>
                  ),
                  onClick: handleSaveQueryAs,
              }] : []),
              {
                  key: 'rename-query',
                  label: translate('query_editor.action.rename_query'),
                  icon: <EditOutlined />,
                  disabled: !!tab.filePath,
                  onClick: handleRenameQuery,
              },
              {
                  key: 'export-sql-file',
                  label: translate('query_editor.action.export_sql_file'),
                  icon: <ExportOutlined />,
                  onClick: () => void handleExportSQLFile(),
              },
          ],
      },
      {
          type: 'group',
          key: 'analysis-actions',
          label: translate('tab_manager.kind_badge.sql_analysis'),
          children: [
              {
                  key: 'show-query-history',
                  icon: <ClockCircleOutlined />,
                  label: translate('query_history.action.open'),
                  onClick: openQueryHistoryWorkbench,
              },
              {
                  key: 'diagnose-query',
                  icon: <SearchOutlined />,
                  label: (
                      <span className="gn-v2-context-menu-item-title">
                          {translate('app.shortcuts.action.diagnoseQuery.label' as any)}
                          {diagnoseQueryShortcutBinding?.enabled && diagnoseQueryShortcutBinding.combo && (
                              <span className="gn-v2-context-menu-kbd">
                                  {getShortcutDisplayLabel(diagnoseQueryShortcutBinding.combo, activeShortcutPlatform)}
                              </span>
                          )}
                      </span>
                  ),
                  disabled: !currentConnectionCapabilities.supportsExplainDiagnosis,
                  onClick: () => openSqlAnalysisWorkbench('diagnose', getCurrentQuery()),
              },
              {
                  key: 'show-slow-queries',
                  icon: <HistoryOutlined />,
                  label: (
                      <span className="gn-v2-context-menu-item-title">
                          {translate('app.shortcuts.action.showSlowQueries.label' as any)}
                          {showSlowQueriesShortcutBinding?.enabled && showSlowQueriesShortcutBinding.combo && (
                              <span className="gn-v2-context-menu-kbd">
                                  {getShortcutDisplayLabel(showSlowQueriesShortcutBinding.combo, activeShortcutPlatform)}
                              </span>
                          )}
                      </span>
                  ),
                  onClick: () => openSqlAnalysisWorkbench('slow-query'),
              },
          ],
      },
  ];

  useEffect(() => {
      const handleFindShortcut = (event: KeyboardEvent) => {
          if (!isActive) {
              return;
          }
          if (!isShortcutMatch(event, findInEditorShortcutCombo)) {
              return;
          }

          const editor = editorRef.current;
          const targetNode = resolveEventTargetNode(event.target);
          const targetElement = targetNode
              && typeof (targetNode as Element).closest === 'function'
              ? targetNode as Element
              : null;
          const activeElement = document.activeElement;
          const dataGridHasFocus = !!(
              activeElement
              && typeof activeElement.closest === 'function'
              && activeElement.closest('.data-grid-root')
          );
          if (targetElement?.closest('.data-grid-root') || dataGridHasFocus) {
              return;
          }
          const editorHasFocus = !!editor?.hasTextFocus?.();
          const inEditorPane = !!(targetNode && editorPaneRef.current?.contains(targetNode));
          const inQueryEditor = !!(targetNode && queryEditorRootRef.current?.contains(targetNode));
          if (isEditableElement(event.target) && !inEditorPane) {
              return;
          }
          if (!editorHasFocus && !inEditorPane && !inQueryEditor && !isDocumentLevelShortcutTarget(targetNode)) {
              return;
          }

          event.preventDefault();
          event.stopPropagation();
          handleOpenEditorFind();
      };

      window.addEventListener('keydown', handleFindShortcut, true);
      return () => {
          window.removeEventListener('keydown', handleFindShortcut, true);
      };
  }, [findInEditorShortcutCombo, handleOpenEditorFind, isActive]);

  useEffect(() => {
      const binding = saveQueryShortcutBinding;
      if (!binding?.enabled || !binding.combo) {
          return;
      }

      const handleSaveShortcut = (event: KeyboardEvent) => {
          if (!isActive) {
              return;
          }
          if (!isShortcutMatch(event, binding.combo)) {
              return;
          }

          const editor = editorRef.current;
          const targetNode = resolveEventTargetNode(event.target);
          const editorHasFocus = !!editor?.hasTextFocus?.();
          const inQueryEditor = !!(targetNode && queryEditorRootRef.current?.contains(targetNode));
          if (!editorHasFocus && !inQueryEditor && !isDocumentLevelShortcutTarget(targetNode)) {
              return;
          }

          event.preventDefault();
          event.stopPropagation();
          void handleQuickSave();
      };

      window.addEventListener('keydown', handleSaveShortcut, true);
      return () => {
          window.removeEventListener('keydown', handleSaveShortcut, true);
      };
  }, [isActive, saveQueryShortcutBinding, handleQuickSave]);

  useEffect(() => {
      const binding = saveQueryAsShortcutBinding;
      if (!binding?.enabled || !binding.combo) {
          return;
      }

      const handleSaveAsShortcut = (event: KeyboardEvent) => {
          if (!isActive || !currentSavedQuery || tab.filePath) {
              return;
          }
          if (!isShortcutMatch(event, binding.combo)) {
              return;
          }

          const editor = editorRef.current;
          const targetNode = resolveEventTargetNode(event.target);
          const editorHasFocus = !!editor?.hasTextFocus?.();
          const inQueryEditor = !!(targetNode && queryEditorRootRef.current?.contains(targetNode));
          if (!editorHasFocus && !inQueryEditor && !isDocumentLevelShortcutTarget(targetNode)) {
              return;
          }

          event.preventDefault();
          event.stopPropagation();
          handleSaveQueryAs();
      };

      window.addEventListener('keydown', handleSaveAsShortcut, true);
      return () => {
          window.removeEventListener('keydown', handleSaveAsShortcut, true);
      };
  }, [currentSavedQuery, handleSaveQueryAs, isActive, saveQueryAsShortcutBinding, tab.filePath]);

  useEffect(() => {
      const binding = formatSqlShortcutBinding;
      if (!binding?.enabled || !binding.combo) {
          return;
      }

      const handleFormatShortcut = (event: KeyboardEvent) => {
          if (!isActive) {
              return;
          }
          if (!isShortcutMatch(event, binding.combo)) {
              return;
          }

          const editor = editorRef.current;
          const targetNode = resolveEventTargetNode(event.target);
          const editorHasFocus = !!editor?.hasTextFocus?.();
          const inQueryEditor = !!(targetNode && queryEditorRootRef.current?.contains(targetNode));
          if (!editorHasFocus && !inQueryEditor && !isDocumentLevelShortcutTarget(targetNode)) {
              return;
          }

          event.preventDefault();
          event.stopPropagation();
          handleFormatRef.current();
      };

      window.addEventListener('keydown', handleFormatShortcut, true);
      return () => {
          window.removeEventListener('keydown', handleFormatShortcut, true);
      };
  }, [isActive, formatSqlShortcutBinding]);

  useEffect(() => {
      const updateAltState = (event: KeyboardEvent) => {
          const key = String(event.key || '').trim().toLowerCase();
          const code = String(event.code || '').trim().toLowerCase();
          const isAltKey = key === 'alt'
              || code === 'altleft'
              || code === 'altright';
          if (isAltKey) {
              if (event.type === 'keydown') {
                  triggerSqlAiCompletionAltGestureAtRef.current = Date.now();
              }
              triggerSqlAiCompletionAltPressedRef.current = event.type !== 'keyup';
          } else if (event.type === 'keyup' && !event.altKey) {
              triggerSqlAiCompletionAltPressedRef.current = false;
          }
      };
      const clearAltState = () => {
          triggerSqlAiCompletionAltPressedRef.current = false;
          triggerSqlAiCompletionAltGestureAtRef.current = 0;
          triggerSqlAiCompletionFallbackRef.current = null;
      };

      window.addEventListener('keydown', updateAltState, true);
      window.addEventListener('keyup', updateAltState, true);
      window.addEventListener('blur', clearAltState);
      return () => {
          window.removeEventListener('keydown', updateAltState, true);
          window.removeEventListener('keyup', updateAltState, true);
          window.removeEventListener('blur', clearAltState);
      };
  }, []);

  useEffect(() => {
      const binding = triggerSqlAiCompletionShortcutBinding;
      if (!binding?.enabled || !binding.combo) {
          return;
      }

      const handleTriggerSqlAiCompletionShortcut = (event: KeyboardEvent) => {
          if (!isActive) {
              return;
          }
          const editor = editorRef.current;
          const targetNode = resolveEventTargetNode(event.target);
          const editorHasFocus = !!editor?.hasTextFocus?.();
          const inQueryEditor = !!(targetNode && queryEditorRootRef.current?.contains(targetNode));
          if (!editorHasFocus && !inQueryEditor && !isDocumentLevelShortcutTarget(targetNode)) {
              return;
          }
          if (!isTriggerSqlAiCompletionShortcutEvent(event)) {
              if (isPossibleTriggerSqlAiCompletionFallbackEvent(event)) {
                  triggerSqlAiCompletionFallbackRef.current = { observedAt: Date.now() };
              }
              return;
          }

          triggerSqlAiCompletionFallbackRef.current = null;
          event.preventDefault();
          event.stopPropagation();
          triggerAiInlineCompletionRef.current?.();
      };

      window.addEventListener('keydown', handleTriggerSqlAiCompletionShortcut, true);
      return () => {
          window.removeEventListener('keydown', handleTriggerSqlAiCompletionShortcut, true);
      };
  }, [isActive, isPossibleTriggerSqlAiCompletionFallbackEvent, isTriggerSqlAiCompletionShortcutEvent, triggerSqlAiCompletionShortcutBinding]);

  useEffect(() => {
      const binding = toggleQueryResultsPanelShortcutBinding;
      if (!binding?.enabled || !binding.combo) {
          return;
      }

      const handleToggleResultsShortcut = (event: KeyboardEvent) => {
          if (!isActive) {
              return;
          }
          if (!isShortcutMatch(event, binding.combo)) {
              return;
          }

          const editor = editorRef.current;
          const targetNode = resolveEventTargetNode(event.target);
          const editorHasFocus = !!editor?.hasTextFocus?.();
          const inQueryEditor = !!(targetNode && queryEditorRootRef.current?.contains(targetNode));
          if (!editorHasFocus && !inQueryEditor && !isDocumentLevelShortcutTarget(targetNode)) {
              return;
          }

          event.preventDefault();
          event.stopPropagation();
          toggleResultPanelVisibility();
      };

      window.addEventListener('keydown', handleToggleResultsShortcut, true);
      return () => {
          window.removeEventListener('keydown', handleToggleResultsShortcut, true);
      };
  }, [isActive, toggleQueryResultsPanelShortcutBinding, toggleResultPanelVisibility]);

  useEffect(() => {
      const handleSaveActiveQuery = () => {
          if (!isActive) {
              return;
          }
          void handleQuickSave();
      };

      window.addEventListener('gonavi:save-active-query', handleSaveActiveQuery as EventListener);
      return () => {
          window.removeEventListener('gonavi:save-active-query', handleSaveActiveQuery as EventListener);
      };
  }, [isActive, handleQuickSave]);

  useEffect(() => {
      const handleSaveActiveQueryAs = () => {
          if (!isActive || !currentSavedQuery || tab.filePath) {
              return;
          }
          handleSaveQueryAs();
      };

      window.addEventListener('gonavi:save-active-query-as', handleSaveActiveQueryAs as EventListener);
      return () => {
          window.removeEventListener('gonavi:save-active-query-as', handleSaveActiveQueryAs as EventListener);
      };
  }, [currentSavedQuery, handleSaveQueryAs, isActive, tab.filePath]);

  useEffect(() => {
      const handleOpenSqlExecutionLog = (event: Event) => {
          const mode = event instanceof CustomEvent && event.detail?.mode === 'open' ? 'open' : 'toggle';
          handleShowSqlExecutionLog(mode);
      };

      window.addEventListener('gonavi:show-sql-execution-log', handleOpenSqlExecutionLog as EventListener);
      return () => {
          window.removeEventListener('gonavi:show-sql-execution-log', handleOpenSqlExecutionLog as EventListener);
      };
  }, [handleShowSqlExecutionLog]);

  const handleSave = async () => {
      try {
          const values = await saveForm.validateFields();
          const existed = currentSavedQuery || null;
          const fallbackSavedId = String(tab.savedQueryId || '').trim();
          const isSaveAs = saveModalMode === 'saveAs';
          const nextSavedId = isSaveAs
              ? `saved-${uuidv4()}`
              : existed?.id || fallbackSavedId || `saved-${Date.now()}`;
          const applied = await persistQuery({
              id: nextSavedId,
              name: String(values.name || '').trim() || translate('query_editor.save_modal.unnamed'),
              createdAt: isSaveAs ? Date.now() : existed?.createdAt,
              openCopyInNewTab: isSaveAs,
          });
          if (!applied) {
              return;
          }
          message.success(translate(
              saveModalMode === 'rename'
                  ? 'query_editor.message.renamed'
                  : isSaveAs
                      ? 'query_editor.message.saved_as'
                      : 'query_editor.message.saved'
          ));
          setIsSaveModalOpen(false);
      } catch (e) {
          if (e instanceof Error) {
              message.error(translate('query_editor.message.save_query_failed', {
                  error: e.message,
              }));
          }
      }
  };

  const handleCloseResult = (key: string) => {
      void cancelResultTotalCountRequests([key]);
      const currentResultSets = resultSetsRef.current;
      const idx = currentResultSets.findIndex(result => result.key === key);
      if (idx < 0) return;

      const currentActiveKey = resolveEffectiveActiveResultKey(
          currentResultSets,
          activeResultKeyRef.current,
          isV2Ui,
      );
      const nextResultSets = currentResultSets.filter(result => result.key !== key);
      const nextActiveKey = currentActiveKey && currentActiveKey !== key
          ? currentActiveKey
          : nextResultSets[idx]?.key
              || nextResultSets[idx - 1]?.key
              || nextResultSets[0]?.key
              || (isV2Ui ? QUERY_EDITOR_SQL_LOG_TAB_KEY : '');

      resultSetsRef.current = nextResultSets;
      activeResultKeyRef.current = nextActiveKey;
      setResultSets(nextResultSets);
      setActiveResultKey(nextActiveKey);
  };

  useEffect(() => {
      if (!isActive) return;

      const handleCloseActiveResultTab = (event: Event) => {
          const request = (event as CustomEvent<CloseActiveResultShortcutRequest>).detail;
          if (!request || request.handled || request.targetTabId !== tab.id) return;
          request.handled = true;
          request.outcome = 'ignored';
          if (!isResultPanelVisibleRef.current) return;

          const effectiveActiveKey = resolveEffectiveActiveResultKey(
              resultSetsRef.current,
              activeResultKeyRef.current,
              isV2Ui,
          );
          if (!effectiveActiveKey) return;

          if (effectiveActiveKey === QUERY_EDITOR_SQL_LOG_TAB_KEY) {
              updateResultPanelVisibility(false);
              request.outcome = 'hidden';
              return;
          }
          if (!resultSetsRef.current.some(result => result.key === effectiveActiveKey)) return;

          handleCloseResult(effectiveActiveKey);
          request.outcome = 'closed';
      };

      window.addEventListener(CLOSE_ACTIVE_RESULT_TAB_EVENT, handleCloseActiveResultTab);
      return () => {
          window.removeEventListener(CLOSE_ACTIVE_RESULT_TAB_EVENT, handleCloseActiveResultTab);
      };
  }, [isActive, isV2Ui, tab.id, updateResultPanelVisibility]);

  const handleResultPinnedChange = (key: string, pinned: boolean) => {
      const nextResultSets = resultSetsRef.current.map((result) => (
          result.key === key ? { ...result, pinned } : result
      ));
      resultSetsRef.current = nextResultSets;
      setResultSets(nextResultSets);
  };

  const replaceResultSetsAfterMenuClose = (next: ResultSet[], preferredKey?: string) => {
      const nextKeys = new Set(next.map((result) => result.key));
      const removedCountKeys = Object.keys(resultTotalCountRequestsRef.current)
          .filter((key) => !nextKeys.has(key));
      void cancelResultTotalCountRequests(removedCountKeys);
      resultSetsRef.current = next;
      setResultSets(next);
      setActiveResultKey(prevActive => {
          const nextActiveKey = preferredKey && next.some(result => result.key === preferredKey)
              ? preferredKey
              : prevActive && next.some(result => result.key === prevActive)
                  ? prevActive
                  : next[0]?.key || '';
          activeResultKeyRef.current = nextActiveKey;
          return nextActiveKey;
      });
  };

  const closeOtherResultTabs = (key: string) => {
      replaceResultSetsAfterMenuClose(
          filterQueryEditorResultSetsForBulkClose(resultSets, key, 'other'),
          key,
      );
  };

  const closeResultTabsToLeft = (key: string) => {
      const next = filterQueryEditorResultSetsForBulkClose(resultSets, key, 'left');
      if (next === resultSets) return;
      replaceResultSetsAfterMenuClose(next, key);
  };

  const closeResultTabsToRight = (key: string) => {
      const next = filterQueryEditorResultSetsForBulkClose(resultSets, key, 'right');
      if (next === resultSets) return;
      replaceResultSetsAfterMenuClose(next, key);
  };

  const closeAllResultTabs = () => {
      replaceResultSetsAfterMenuClose(filterQueryEditorResultSetsForBulkClose(resultSets, '', 'all'));
  };

  const openResultInWindow = (
      key: string,
      preferred?: { x?: number; y?: number; width?: number; height?: number },
  ) => {
      const target = resultSets.find((result) => result.key === key);
      if (!target) return;
      const index = resultSets.findIndex((result) => result.key === key);
      const title = target.resultType === 'message'
          ? translate('query_editor.results_panel.tab.message', { index: index + 1 })
          : translate('query_editor.results_panel.detached.title', { index: index + 1 });
      const windowId = `query-result:${tab.id}:${target.key}`;
      const detachedWindow = {
          id: windowId,
          sourceQueryTabId: tab.id,
          connectionId: target.executionConnectionId || currentConnectionId || tab.connectionId || '',
          // 独立窗也要带上结果表元数据所属库，否则列类型/注释会丢
          dbName: target.metadataDbName || target.executionDbName || currentDb || tab.dbName || '',
          title,
          ...(preferred?.x !== undefined ? { x: preferred.x } : {}),
          ...(preferred?.y !== undefined ? { y: preferred.y } : {}),
          ...(preferred?.width !== undefined ? { width: preferred.width } : {}),
          ...(preferred?.height !== undefined ? { height: preferred.height } : {}),
          result: {
              key: target.key,
              sql: target.sql,
              exportSql: target.exportSql,
              sourceStatementIndex: target.sourceStatementIndex,
              statementResultIndex: target.statementResultIndex,
              rows: target.rows,
              columns: target.columns,
              messages: target.messages,
              resultType: target.resultType,
              requestLabel: target.requestLabel,
              httpStatus: target.httpStatus,
              rawResponse: target.rawResponse,
              partialFailure: target.partialFailure,
              outcomeUnknown: target.outcomeUnknown,
              tableName: target.metadataTableName || target.tableName,
              metadataDbName: target.metadataDbName,
              metadataTableName: target.metadataTableName,
              ddlDbName: target.ddlDbName,
              ddlTableName: target.ddlTableName,
              executionConnectionId: target.executionConnectionId,
              executionDbName: target.executionDbName,
              executionConnectionParams: target.executionConnectionParams,
              pkColumns: target.pkColumns || [],
              editLocator: target.editLocator as any,
              readOnly: target.readOnly !== false,
              showRowNumberColumn: target.showRowNumberColumn,
              truncated: target.truncated,
              pinned: target.pinned,
          },
      };
      void openNativeQueryResultWindow(detachedWindow)
          .then((opened) => {
              if (opened) handleCloseResult(key);
          })
          .catch((error) => {
              message.error(error instanceof Error ? error.message : String(error));
          });
  };

  React.useEffect(() => {
      const handleRestoreQueryResult = (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          const sourceQueryTabId = String(detail.sourceQueryTabId || '').trim();
          if (sourceQueryTabId !== tab.id) return;
          const restored = detail.result;
          if (!restored || typeof restored !== 'object') return;
          const restoredKey = String(restored.key || '').trim();
          if (!restoredKey) return;
          const windowId = String(detail.windowId || '').trim();
          const expectedWindowId = `query-result:${sourceQueryTabId}:${restoredKey}`;
          if (!resultSetsRef.current.some((item) => item.key === restoredKey)) {
              const restoredResult = {
                  key: restoredKey,
                  sql: String(restored.sql || ''),
                  exportSql: restored.exportSql,
                  sourceStatementIndex: restored.sourceStatementIndex,
                  statementResultIndex: restored.statementResultIndex,
                  rows: Array.isArray(restored.rows) ? restored.rows : [],
                  columns: Array.isArray(restored.columns) ? restored.columns : [],
                  messages: Array.isArray(restored.messages) ? restored.messages : undefined,
                  resultType: restored.resultType === 'message'
                      ? 'message'
                      : restored.resultType === 'elasticsearch'
                          ? 'elasticsearch'
                          : 'grid',
                  requestLabel: restored.requestLabel,
                  httpStatus: restored.httpStatus,
                  rawResponse: restored.rawResponse,
                  partialFailure: restored.partialFailure === true,
                  outcomeUnknown: restored.outcomeUnknown === true,
                  tableName: restored.tableName,
                  metadataDbName: restored.metadataDbName,
                  metadataTableName: restored.metadataTableName,
                  ddlDbName: restored.ddlDbName,
                  ddlTableName: restored.ddlTableName,
                  executionConnectionId: restored.executionConnectionId,
                  executionDbName: restored.executionDbName,
                  executionConnectionParams: restored.executionConnectionParams,
                  pkColumns: Array.isArray(restored.pkColumns) ? restored.pkColumns : [],
                  editLocator: restored.editLocator,
                  readOnly: restored.readOnly !== false,
                  showRowNumberColumn: restored.showRowNumberColumn,
                  truncated: restored.truncated,
                  pinned: restored.pinned === true,
              } as ResultSet;
              const nextResultSets = [
                  ...resultSetsRef.current,
                  restoredResult,
              ];
              resultSetsRef.current = nextResultSets;
              setResultSets(nextResultSets);
              if (windowId === expectedWindowId) {
                  nativeRestoredResultRefs.current.set(windowId, {
                      resultKey: restoredKey,
                      result: restoredResult,
                  });
              }
          } else if (windowId) {
              nativeRestoredResultRefs.current.delete(windowId);
          }
          activeResultKeyRef.current = restoredKey;
          setActiveResultKey(restoredKey);
          updateResultPanelVisibility(true);
      };
      const handleRedetachQueryResult = (event: Event) => {
          const detail = (event as CustomEvent).detail || {};
          const sourceQueryTabId = String(detail.sourceQueryTabId || '').trim();
          if (sourceQueryTabId !== tab.id) return;
          const resultKey = String(detail.resultKey || '').trim();
          const windowId = String(detail.windowId || '').trim();
          if (!resultKey || windowId !== `query-result:${sourceQueryTabId}:${resultKey}`) return;
          const restoredResult = nativeRestoredResultRefs.current.get(windowId);
          nativeRestoredResultRefs.current.delete(windowId);
          if (
              !restoredResult
              || restoredResult.resultKey !== resultKey
              || resultSetsRef.current.find((item) => item.key === resultKey) !== restoredResult.result
          ) return;
          handleCloseResult(resultKey);
      };
      window.addEventListener('gonavi:restore-query-result', handleRestoreQueryResult as EventListener);
      window.addEventListener(
          NATIVE_DETACHED_QUERY_RESULT_REDETACH_EVENT,
          handleRedetachQueryResult as EventListener,
      );
      return () => {
          window.removeEventListener('gonavi:restore-query-result', handleRestoreQueryResult as EventListener);
          window.removeEventListener(
              NATIVE_DETACHED_QUERY_RESULT_REDETACH_EVENT,
              handleRedetachQueryResult as EventListener,
          );
      };
  }, [isV2Ui, tab.id, updateResultPanelVisibility]);

  const toggleQueryResultsPanelShortcutLabel =
      toggleQueryResultsPanelShortcutBinding.enabled && toggleQueryResultsPanelShortcutBinding.combo
          ? getShortcutDisplayLabel(toggleQueryResultsPanelShortcutBinding.combo, activeShortcutPlatform)
          : '';

  const handleDiagnoseExecutionError = () => {
      const errSql = getCurrentQuery();
      const prompt = translate('query_editor.ai_prompt.diagnose', {
          sql: errSql,
          error: executionError,
      });
      const store = useStore.getState();
      const wasClosed = !store.aiPanelVisible;
      if (wasClosed) store.setAIPanelVisible(true);
      setTimeout(() => {
          window.dispatchEvent(new CustomEvent('gonavi:ai:inject-prompt', { detail: { prompt } }));
      }, wasClosed ? 350 : 0);
  };

  const sqlEditorTransactionToolbar = (
      <QueryEditorTransactionToolbar
          isV2Ui={isV2Ui}
          darkMode={darkMode}
          transaction={pendingSqlTransaction}
          autoCommitRemainingSeconds={sqlEditorAutoCommitRemainingSeconds}
          onFinish={(action) => void handleFinishPendingSqlTransaction(action)}
      />
  );
  const queryEditorStageStyle: React.CSSProperties = isResultPanelVisible
      ? {
          height: editorHeight,
          minHeight: '100px',
      }
      : {
          flex: '1 1 auto',
          minHeight: 0,
      };
  const resolvedQueryEditorStageStyle: React.CSSProperties = isV2Ui
      ? {
          ...queryEditorStageStyle,
      } as React.CSSProperties
      : queryEditorStageStyle;

  return (
    <div ref={queryEditorRootRef} className={isV2Ui ? 'gn-v2-query-editor' : undefined} style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div
        ref={editorPaneRef}
        className={isV2Ui ? 'gn-v2-query-editor-pane' : undefined}
        style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: isResultPanelVisible ? '0 0 auto' : '1 1 auto' }}
      >
      <QueryEditorToolbar
        editorMode={isElasticsearchMode ? 'elasticsearch' : 'sql'}
        isV2Ui={isV2Ui}
        currentConnectionId={currentConnectionId}
        currentDb={currentDb}
        queryCapableConnections={queryCapableConnections}
        dbList={dbList}
        contextSelectionDisabled={queryContextLockRunSeq !== 0 || Boolean(pendingSqlTransaction)}
        schemaSelect={canSelectQuerySchema ? {
            value: currentSchema,
            options: schemaList,
            loading: schemaLoading,
            disabled: schemaLoading || loading || queryContextLockRunSeq !== 0 || Boolean(pendingSqlTransaction),
            onChange: (schemaName) => {
                const nextSchema = String(schemaName || '').trim();
                if (
                    !nextSchema
                    || queryContextLockRunSeqRef.current !== 0
                    || pendingSqlTransactionRef.current
                ) return;
                currentSchemaRef.current = nextSchema;
                latestSelectedSchemaRef.current = nextSchema;
                setCurrentSchema(nextSchema);
                setSchemaList((current) => current.includes(nextSchema)
                    ? current
                    : [nextSchema, ...current]);
                updateQueryTabDraft(tab.id, { schemaName: nextSchema });
            },
        } : undefined}
        maxRows={queryOptions?.maxRows ?? 5000}
        sqlEditorCommitMode={sqlEditorCommitMode}
        sqlEditorAutoCommitDelayMs={sqlEditorAutoCommitDelayMs}
        pendingTransactionToolbar={pendingSqlTransaction ? sqlEditorTransactionToolbar : null}
        runQueryShortcutBinding={runQueryShortcutBinding}
        saveQueryShortcutBinding={saveQueryShortcutBinding}
        formatSqlShortcutBinding={formatSqlShortcutBinding}
        triggerSqlAiCompletionShortcutBinding={triggerSqlAiCompletionShortcutBinding}
        toggleQueryResultsPanelShortcutBinding={toggleQueryResultsPanelShortcutBinding}
        activeShortcutPlatform={activeShortcutPlatform}
        isResultPanelVisible={isResultPanelVisible}
        wordWrapEnabled={wordWrapEnabled}
        loading={loading}
        runDisabled={canSelectQuerySchema && schemaLoading}
        saveMoreMenuItems={saveMoreMenuItems}
        formatSettingsMenu={formatSettingsMenu}
        formatSettingsSelectedKeys={[sqlFormatOptions.keywordCase]}
        templateMenuItems={elasticsearchTemplateMenuItems}
        onConnectionChange={(val) => {
            void switchQueryContext(val, '');
        }}
        onDatabaseChange={handleDatabaseChange}
        onMaxRowsChange={(maxRows) => setQueryOptions({ maxRows })}
        onCommitModeChange={(mode) => setSqlEditorTransactionOptions(
            mode === 'auto'
                ? { commitMode: mode, autoCommitDelayMs: 0 }
                : { commitMode: mode },
        )}
        onAutoCommitDelayMsChange={(delayMs) => setSqlEditorTransactionOptions({ autoCommitDelayMs: delayMs })}
        onCaptureEditorCursorPosition={captureEditorCursorPosition}
        onRun={handleRun}
        onRunAll={() => void handleElasticsearchRun(true)}
        onCancel={handleCancel}
        onQuickSave={handleQuickSave}
        onFindInEditor={handleOpenEditorFind}
        onToggleWordWrap={() => setQueryOptions({ wordWrap: !wordWrapEnabled })}
        onFormat={handleFormat}
        onTriggerSqlAiCompletion={() => triggerAiInlineCompletionRef.current?.()}
        onToggleResultPanelVisibility={toggleResultPanelVisibility}
        onAIAction={handleAIAction}
        showViewDataVerify={
          isObjectEditQueryTab
          && (
            Boolean(String(tab.viewName || '').trim())
            || tab.objectType === 'view'
            || tab.objectType === 'materialized-view'
            || isViewEditSql(query)
          )
        }
        onViewDataVerify={() => {
          const viewName = resolveViewNameForVerify({
            sql: query,
            tabViewName: tab.viewName,
            tabTitle: tab.title,
          });
          if (!viewName) {
            message.warning(translate('result_diff.view_verify.error.no_view_name'));
            return;
          }
          setViewDataVerifyOpen(true);
        }}
      />
      
      <div
        ref={editorStageRef}
        className={isV2Ui ? 'gn-v2-query-monaco-stage gn-query-monaco-stage' : 'gn-query-monaco-stage'}
        style={resolvedQueryEditorStageStyle}
      >
        <div
          ref={editorShellRef}
          className={isV2Ui ? 'gn-v2-query-monaco-shell gn-query-monaco-shell' : 'gn-query-monaco-shell'}
          style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0 }}
        >
          <Editor 
            height="100%" 
            gonaviTypography="sql"
            language={queryEditorMonacoLanguage}
            theme={darkMode ? "transparent-dark" : "transparent-light"}
            defaultValue={query}
            onChange={(val) => {
                const nextValue = val || '';
                syncQueryDraft(nextValue);
            }}
            beforeMount={handleEditorBeforeMount}
            onMount={handleEditorDidMount}
            options={isElasticsearchMode ? {
                ...queryEditorMonacoOptions,
                quickSuggestions: false,
                suggestOnTriggerCharacters: false,
                inlineSuggest: { enabled: false },
            } : queryEditorMonacoOptions}
          />
        </div>
        <div className="gn-query-execution-statusbar">
          <span
            aria-label={executionElapsedLabel}
            className="gn-query-execution-timer"
            role="timer"
            title={executionElapsedLabel}
          >
            <span aria-hidden="true" className="gn-query-execution-speed-icon">
              {executionSpeedIcon}
            </span>
            <span className="gn-query-execution-elapsed">
              {executionElapsedText}
            </span>
          </span>
        </div>
      </div>

      {isResultPanelVisible && (
        <div
          className={isV2Ui ? 'gn-v2-query-resizer' : undefined}
          onMouseDown={handleMouseDown}
          style={{
              height: '5px',
              cursor: 'row-resize',
              background: darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)',
              flexShrink: 0,
              zIndex: 10
          }}
          title={translate('query_editor.action.resize_editor')}
        />
      )}
      </div>

      {isResultPanelVisible && (
        <QueryEditorResultsPanel
          resultSets={resultSets}
          activeResultKey={activeResultKey}
          isActive={isActive}
          loading={loading}
          executionError={executionError}
          sqlLogCount={sqlLogCount}
          darkMode={darkMode}
          isV2Ui={isV2Ui}
          currentDb={currentDb}
          currentConnectionId={currentConnectionId}
          dataPreviewRequest={resultDataPreviewRequest}
          toggleShortcutLabel={toggleQueryResultsPanelShortcutLabel}
          onActiveResultKeyChange={setActiveResultKey}
          onHide={() => updateResultPanelVisibility(false)}
          onCloseResult={handleCloseResult}
          onCloseOtherResultTabs={closeOtherResultTabs}
          onCloseResultTabsToLeft={closeResultTabsToLeft}
          onCloseResultTabsToRight={closeResultTabsToRight}
          onCloseAllResultTabs={closeAllResultTabs}
          onResultPinnedChange={handleResultPinnedChange}
          onOpenResultInWindow={openResultInWindow}
          onReloadResult={handleReloadResult}
          onResultPageChange={handleResultPageChange}
          onResultSort={handleResultSort}
          onRequestResultTotalCount={handleRequestResultTotalCount}
          onCancelResultTotalCount={handleCancelResultTotalCount}
          onDiagnoseExecutionError={handleDiagnoseExecutionError}
          onCompareResult={(resultKey) => {
            setResultDiffAnchorKey(resultKey);
            setResultDiffWizardOpen(true);
          }}
        />
      )}

      <ResultDiffWizard
        open={resultDiffWizardOpen}
        results={resultSets
          .map((rs, idx) => ({ rs, idx }))
          .filter(({ rs }) => rs.resultType !== 'message' && Array.isArray(rs.columns) && rs.columns.length > 0)
          .map(({ rs, idx }): ResultDiffComparableResult => ({
            key: rs.key,
            label: translate('query_editor.results_panel.tab.result', { index: idx + 1 }) + ` (${rs.rows?.length ?? 0})`,
            sql: String(rs.sql || rs.exportSql || ''),
            columns: rs.columns || [],
            rows: (rs.rows || []) as Record<string, unknown>[],
            pkColumns: rs.pkColumns || [],
            truncated: Boolean(rs.truncated),
            executionConnectionId: rs.executionConnectionId || currentConnectionId,
            executionDbName: rs.executionDbName || currentDb,
            executionConnectionParams: rs.executionConnectionParams,
            metadataDbName: rs.metadataDbName || rs.executionDbName || currentDb,
            metadataTableName: rs.metadataTableName || rs.tableName,
          }))}
        initialRightKey={resultDiffAnchorKey}
        connectionConfig={(() => {
          const conn = connections.find((c) => c.id === currentConnectionId);
          return conn ? buildRpcConnectionConfig(conn.config) : {};
        })()}
        database={currentDb}
        resolveExecutionConnectionConfig={(result) => {
          const connectionId = result.executionConnectionId || currentConnectionId;
          const conn = connections.find((item) => item.id === connectionId);
          if (!conn) return {};
          const config = result.executionConnectionParams === undefined
            ? conn.config
            : {
                ...conn.config,
                connectionParams: result.executionConnectionParams,
              };
          return buildRpcConnectionConfig(config);
        }}
        onCancel={() => setResultDiffWizardOpen(false)}
        onCompleted={(payload) => {
          setResultDiffWizardOpen(false);
          setResultDiffSession(payload);
        }}
      />

      {resultDiffSession && (
        <ResultDiffPanel
          open={Boolean(resultDiffSession)}
          jobId={resultDiffSession.jobId}
          summary={resultDiffSession.summary}
          leftLabel={resultDiffSession.leftLabel}
          rightLabel={resultDiffSession.rightLabel}
          darkMode={darkMode}
          columnMeta={resultDiffSession.columnMeta}
          onClose={() => setResultDiffSession(null)}
        />
      )}

      <ViewDataVerifyWizard
        open={viewDataVerifyOpen}
        connectionConfig={(() => {
          const conn = connections.find((c) => c.id === currentConnectionId);
          return conn ? buildRpcConnectionConfig(conn) : {};
        })()}
        database={currentDb}
        dbType={String(connections.find((c) => c.id === currentConnectionId)?.config?.type || '')}
        viewName={resolveViewNameForVerify({
          sql: query,
          tabViewName: tab.viewName,
          tabTitle: tab.title,
        })}
        ddlSql={query}
        onCancel={() => setViewDataVerifyOpen(false)}
        onCompleted={(payload) => {
          setViewDataVerifyOpen(false);
          setResultDiffSession(payload);
        }}
      />

      <Modal
        title={translate(isElasticsearchMode
          ? 'query_editor.elasticsearch.ai_title'
          : 'query_editor.text_to_sql.title')}
        open={isTextToSqlModalOpen}
        centered
        mask={false}
        maskClosable={!textToSqlGenerating}
        width={640}
        draggable
        resizable
        minResizableWidth={480}
        minResizableHeight={320}
        onCancel={() => {
          if (!textToSqlGenerating) {
            setIsTextToSqlModalOpen(false);
          }
        }}
        footer={[
          <Button key="cancel" disabled={textToSqlGenerating} onClick={() => setIsTextToSqlModalOpen(false)}>
            {translate('common.cancel')}
          </Button>,
          <Button key="generate" type="primary" loading={textToSqlGenerating} onClick={handleGenerateTextToSql}>
            {translate(isElasticsearchMode
              ? 'query_editor.elasticsearch.action.ai_generate'
              : 'query_editor.text_to_sql.generate')}
          </Button>,
        ]}
        styles={{
          content: {
            borderRadius: 16,
            border: darkMode ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(15,23,42,0.12)',
            background: darkMode ? 'rgba(18,18,20,0.98)' : 'rgba(255,255,255,0.98)',
            boxShadow: darkMode ? '0 24px 60px rgba(0,0,0,0.45)' : '0 24px 60px rgba(15,23,42,0.16)',
            backdropFilter: 'blur(12px)',
          },
          header: {
            background: 'transparent',
            borderBottom: 'none',
            paddingBottom: 8,
          },
          body: {
            paddingTop: 8,
            paddingBottom: 16,
          },
        }}
      >
        <div
          data-query-editor-text-to-sql-modal="true"
          style={{ display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <div style={{ fontSize: 12, lineHeight: 1.6, color: darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(16,24,40,0.6)' }}>
            {translate(isElasticsearchMode
              ? 'query_editor.elasticsearch.ai_read_only_hint'
              : 'query_editor.text_to_sql.description')}
          </div>
          <Input.TextArea
            autoFocus
            value={textToSqlInstruction}
            onChange={(event) => setTextToSqlInstruction(event.target.value)}
            placeholder={translate(isElasticsearchMode
              ? 'query_editor.elasticsearch.ai_placeholder'
              : 'query_editor.text_to_sql.placeholder')}
            autoSize={{ minRows: 5, maxRows: 10 }}
            disabled={textToSqlGenerating}
          />
          <Segmented
            value={textToSqlApplyMode}
            onChange={(value) => setTextToSqlApplyMode(value as QueryEditorAiApplyMode)}
            disabled={textToSqlGenerating}
            options={[
              { label: translate('query_editor.text_to_sql.mode.insert'), value: 'insert' },
              { label: translate('query_editor.text_to_sql.mode.replace_selection'), value: 'replaceSelection' },
              { label: translate('query_editor.text_to_sql.mode.replace_all'), value: 'replaceAll' },
            ]}
          />
        </div>
      </Modal>

      <Modal
        title={translate('query_editor.snippet_picker.title')}
        open={isSqlSnippetPickerOpen}
        centered
        mask={false}
        maskClosable={false}
        width={620}
        draggable
        resizable
        minResizableWidth={460}
        minResizableHeight={320}
        onCancel={handleCloseSqlSnippetPicker}
        footer={null}
        styles={{
          content: {
            borderRadius: 16,
            border: darkMode ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(15,23,42,0.12)',
            background: darkMode ? 'rgba(18,18,20,0.98)' : 'rgba(255,255,255,0.98)',
            boxShadow: darkMode ? '0 24px 60px rgba(0,0,0,0.45)' : '0 24px 60px rgba(15,23,42,0.16)',
            backdropFilter: 'blur(12px)',
          },
          header: {
            background: 'transparent',
            borderBottom: 'none',
            paddingBottom: 8,
          },
          body: {
            paddingTop: 8,
            paddingBottom: 16,
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            overflow: 'hidden',
          },
        }}
      >
        <div
          data-query-editor-snippet-picker="true"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            flex: '1 1 420px',
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <div style={{ fontSize: 12, lineHeight: 1.6, color: darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(16,24,40,0.6)' }}>
            {translate('query_editor.snippet_picker.description')}
          </div>
          <Input
            autoFocus
            data-query-editor-snippet-search="true"
            value={sqlSnippetPickerKeyword}
            onChange={(event) => setSqlSnippetPickerKeyword(event.target.value)}
            onPressEnter={() => {
              if (filteredSqlSnippets[0]) {
                handleInsertSqlSnippet(filteredSqlSnippets[0]);
              }
            }}
            placeholder={translate('query_editor.snippet_picker.search_placeholder')}
          />
          <div
            style={{
              flex: '1 1 auto',
              minHeight: 0,
              overflowY: 'auto',
              paddingRight: 4,
              display: 'grid',
              gap: 8,
            }}
          >
            {filteredSqlSnippets.map((snippet) => {
              const preview = String(snippet.description || snippet.syntaxHelp || snippet.body || '')
                .replace(/\s+/g, ' ')
                .trim();
              return (
                <button
                  key={snippet.id}
                  type="button"
                  data-query-editor-snippet-item={snippet.id}
                  onClick={() => handleInsertSqlSnippet(snippet)}
                  style={{
                    textAlign: 'left',
                    borderRadius: 12,
                    border: darkMode ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(15,23,42,0.1)',
                    background: darkMode ? 'rgba(255,255,255,0.03)' : '#fff',
                    padding: '12px 14px',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                    <span style={{ fontFamily: 'var(--gn-font-mono)', fontSize: 12, fontWeight: 700, color: '#1677ff' }}>
                      {snippet.prefix}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: darkMode ? 'rgba(255,255,255,0.9)' : 'rgba(15,23,42,0.88)' }}>
                      {snippet.name}
                    </span>
                    {snippet.isBuiltin ? (
                      <span
                        style={{
                          fontSize: 11,
                          padding: '1px 8px',
                          borderRadius: 999,
                          background: darkMode ? 'rgba(22,119,255,0.18)' : 'rgba(22,119,255,0.1)',
                          color: '#1677ff',
                        }}
                      >
                        {translate('snippet_settings.tag.builtin')}
                      </span>
                    ) : null}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      lineHeight: 1.6,
                      color: darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(16,24,40,0.6)',
                      fontFamily: preview.includes('${') ? 'var(--gn-font-mono)' : undefined,
                    }}
                  >
                    {preview}
                  </div>
                </button>
              );
            })}
            {!filteredSqlSnippets.length ? (
              <div
                data-query-editor-snippet-empty="true"
                style={{
                  borderRadius: 12,
                  padding: '18px 16px',
                  border: darkMode ? '1px dashed rgba(255,255,255,0.14)' : '1px dashed rgba(15,23,42,0.12)',
                  color: darkMode ? 'rgba(255,255,255,0.6)' : 'rgba(16,24,40,0.55)',
                  fontSize: 13,
                  lineHeight: 1.7,
                }}
              >
                {sqlSnippetPickerEmptyLabel}
              </div>
            ) : null}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <Button onClick={handleOpenSnippetSettingsFromPicker}>
              {translate('query_editor.snippet_picker.manage')}
            </Button>
            <Button onClick={handleCloseSqlSnippetPicker}>
              {translate('common.cancel')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal 
        title={translate(
          saveModalMode === 'rename'
            ? 'query_editor.save_modal.rename_title'
            : saveModalMode === 'saveAs'
              ? 'query_editor.save_modal.save_as_title'
              : 'query_editor.save_modal.title',
        )}
        open={isSaveModalOpen} 
        onOk={handleSave} 
        onCancel={() => setIsSaveModalOpen(false)}
        okText={translate(
          saveModalMode === 'rename'
            ? 'query_editor.save_modal.rename_ok'
            : saveModalMode === 'saveAs'
              ? 'query_editor.action.save_as'
              : 'common.save',
        )}
        cancelText={translate('common.cancel')}
        afterOpenChange={(open) => {
          if (open) {
            saveQueryNameInputRef.current?.focus({ cursor: 'all' });
          }
        }}
      >
          <Form form={saveForm} layout="vertical">
              <Form.Item name="name" label={translate('query_editor.save_modal.name_label')} rules={[{ required: true, message: translate('query_editor.save_modal.name_required') }]}>
                  <Input ref={saveQueryNameInputRef} placeholder={translate('query_editor.save_modal.name_placeholder')} />
              </Form.Item>
          </Form>
      </Modal>

    </div>
    );
};

const setQueryEditorMouseCursor = (
    editor: any,
    cursor: '' | 'pointer',
) => {
    const domNode = editor?.getDomNode?.();
    if (domNode?.style) {
        domNode.style.cursor = cursor;
    }
};

export default React.memo(QueryEditor);
