import type { SqlLog } from '../../store';
import { LogError, LogInfo } from '../../../wailsjs/runtime';
import { resolveOceanBaseProtocolFromConfig } from '../../utils/oceanBaseProtocol';
import { resolveSqlDialect } from '../../utils/sqlDialect';
import { t as translate } from '../../i18n';
import {
    maskQueryEditorSqlLiteralsAndComments,
    QUERY_EDITOR_HOVER_DELAY_MS,
} from './QueryEditorHelpers';
import { buildQueryEditorAiInlineSuggestOptions } from './QueryEditorAiAssist';

export const buildQueryEditorMonacoActionLabel = (key: string): string =>
    `GoNavi: ${translate(key)}`;

export type QueryEditorRunScope = 'default' | 'selection' | 'all';

export const QUERY_EDITOR_NATIVE_SELECT_CURRENT_LINE_EVENT = 'gonavi:native-select-current-line';
export const QUERY_EDITOR_MAC_FIND_WITH_SELECTION_COMBO = 'Meta+E';
export const QUERY_EDITOR_MAC_FIND_WITH_SELECTION_GUARD_ACTION_ID = 'gonavi.suppressMacFindWithSelection';
export const QUERY_EDITOR_AI_INLINE_DEBOUNCE_MS = 220;
export const QUERY_EDITOR_AI_INLINE_CONTEXT_KEY = 'gonaviAiInlineSuggestionVisible';
export const QUERY_EDITOR_IME_FALLBACK_DELAY_MS = 80;
export const QUERY_EDITOR_FORMAT_PARAM_TYPES = {
    custom: [
        { regex: String.raw`#\{[^{}]+\}` },
        { regex: String.raw`\$\{[^{}]+\}` },
    ],
};
const QUERY_EDITOR_FORMAT_ERROR_LOG_MAX_LENGTH = 500;
export const EMPTY_QUERY_EDITOR_SQL_LOGS: SqlLog[] = [];

export const normalizeBrowserSQLExportFileName = (rawName: string): string => {
    const pathParts = String(rawName || '').trim().split(/[\\/]/);
    let name = String(pathParts[pathParts.length - 1] || '').trim();
    if (!name || name === '.') name = 'query';
    name = name.replace(/[\\/:*?"<>|]/g, '_') || 'query';
    return name.toLowerCase().endsWith('.sql') ? name : `${name}.sql`;
};

export const hasElasticsearchUncertainOutcome = (response: any): boolean => (
    response?.outcomeUnknown === true
);

export const hasSqlExecutionOutcomeUnknown = (response: any): boolean => (
    !response
    || typeof response?.success !== 'boolean'
    || response?.outcomeUnknown === true
    || response?.data?.outcomeUnknown === true
    || String(response?.cancellationState || '').trim().toLowerCase() === 'unsupported'
    || String(response?.data?.cancellationState || '').trim().toLowerCase() === 'unsupported'
);

export const isQueryEditorTriggerDropStatement = (statement: string): boolean => (
    /^\s*DROP\s+TRIGGER\b/i.test(maskQueryEditorSqlLiteralsAndComments(String(statement || '')))
);

export const buildElasticsearchOutcomeMetadata = (response: any): { outcomeUnknown: boolean } => ({
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

export const supportsPositionalSqlFormatParams = (config: any): boolean => (
    isOceanBaseOracleConnection(config)
    || resolveSqlDialect(
        String(config?.type || ''),
        String(config?.driver || ''),
        { oceanBaseProtocol: config?.oceanBaseProtocol },
    ) === 'dameng'
);

export const queryEditorFormatNow = (): number => (
    typeof globalThis.performance?.now === 'function'
        ? globalThis.performance.now()
        : Date.now()
);

export const formatQueryEditorFormatDuration = (startedAt: number): string => (
    String(Math.round(Math.max(0, queryEditorFormatNow() - startedAt) * 10) / 10)
);

export const normalizeQueryEditorFormatLogField = (value: unknown, fallback: string): string => {
    const normalized = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '_')
        .slice(0, 64);
    return normalized || fallback;
};

export const formatQueryEditorFormatError = (error: unknown): string => {
    const messageText = error instanceof Error ? error.message : String(error || 'unknown');
    return messageText
        .replace(/\s+/g, ' ')
        .replace(/Unexpected "(?:[^"\\]|\\.)*"/gi, 'Unexpected <token>')
        .trim()
        .slice(0, QUERY_EDITOR_FORMAT_ERROR_LOG_MAX_LENGTH) || 'unknown';
};

export const writeQueryEditorFormatLog = (level: 'info' | 'error', messageText: string): void => {
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

export const buildQueryEditorMonacoOptions = (
    isObjectEditQueryTab: boolean,
    wordWrapEnabled = false,
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
            lineNumbersMinChars: 4,
            stickyScroll: { enabled: false },
        }
        : {}),
});

export const QUERY_EDITOR_SQL_PROMPT_PLACEHOLDER = '{SQL}';

const QUERY_EDITOR_TABLE_SUGGESTION_ROW_HEIGHT = 36;
