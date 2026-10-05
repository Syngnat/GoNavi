import type { AIProviderConfig, AIUserPromptSettings } from '../../types';
import type {
    CompletionTableMeta,
    CompletionColumnMeta,
    QueryIdentifierPathSegment,
} from './QueryEditorHelpers';
import type { AIRunHarnessService } from '../ai/aiRunHarnessClient';

export type QueryEditorAiApplyMode = 'insert' | 'replaceSelection' | 'replaceAll';

export interface QueryEditorAiService extends Pick<AIRunHarnessService, 'AISubmitAgentInput' | 'AIReadAgentRun'> {
    AIGetProviders?: () => Promise<AIProviderConfig[]>;
    AIGetActiveProvider?: () => Promise<string>;
    AIGetUserPromptSettings?: () => Promise<Partial<AIUserPromptSettings>>;
}

export interface QueryEditorAiMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface QueryEditorAiContext {
    connectionId?: string;
    connectionName?: string;
    host?: string;
    port?: string | number;
    sourceType?: string;
    sqlDialect?: string;
    tableAliasPrefix?: string;
    currentDb?: string;
    visibleDbs?: string[];
    tables?: CompletionTableMeta[];
    columns?: CompletionColumnMeta[];
    inlineSchemaScope?: 'referenced_tables' | 'current_database';
    inlineReferencedTables?: QueryEditorAiTableReference[];
    inlineCompletionIntent?: 'general_sql' | 'table_name' | 'column_name';
    inlineCompletionFragment?: string;
    inlineCompletionQualifier?: string;
    databaseVersion?: string;
    elasticsearchVersion?: string;
    elasticsearchMapping?: string;
}

export interface QueryEditorAiEditorSnapshot {
    prefix: string;
    suffix: string;
    currentLineBeforeCursor: string;
    currentLineAfterCursor: string;
}

export interface QueryEditorAiRuntimeReadiness {
    ready: boolean;
    reason?: 'service_unavailable' | 'provider_missing' | 'model_missing';
    provider?: AIProviderConfig;
    userPromptSettings: AIUserPromptSettings;
}

export interface QueryEditorAiTableReference {
    dbName: string;
    tableName: string;
    alias?: string;
    raw: string;
    parts?: string[];
    segments?: QueryIdentifierPathSegment[];
    aliasSegment?: QueryIdentifierPathSegment;
}

export interface QueryEditorInlineMemoryEntry {
    sql: string;
}

export const buildQueryEditorAiInlineSuggestOptions = () => ({
    enabled: true,
    mode: 'prefix' as const,
    showToolbar: 'onHover' as const,
    suppressSuggestions: true,
    minShowDelay: 60,
    // Monaco hides inline completions while the normal suggest widget is open unless this is enabled.
    experimental: {
        showOnSuggestConflict: 'always' as const,
    },
});

export const EMPTY_USER_PROMPT_SETTINGS: AIUserPromptSettings = {
    global: '',
    database: '',
    jvm: '',
    jvmDiagnostic: '',
};

export const INLINE_PREFIX_LIMIT = 3600;
export const INLINE_SUFFIX_LIMIT = 1200;
export const TEXT_TO_SQL_PREFIX_LIMIT = 5000;
export const TEXT_TO_SQL_SUFFIX_LIMIT = 1800;
export const MAX_SCHEMA_SNAPSHOT_CHARS = 7000;
export const MAX_SCHEMA_TABLES = 48;
export const MAX_INLINE_SCHEMA_TABLES = 18;
export const MAX_SCHEMA_COLUMNS_PER_TABLE = 14;
export const MAX_INLINE_INSERT_CHARS = 1800;
export const MAX_INLINE_GHOST_PREVIEW_CHARS = 220;
export const INLINE_COMPLETION_MAX_TOKENS = 192;
export const INLINE_COMPLETION_TEMPERATURE = 0.1;
export const INLINE_RUNTIME_READINESS_CACHE_TTL_MS = 5000;
export const QUERY_EDITOR_RUN_POLL_INTERVAL_MS = 80;
export const QUERY_EDITOR_RUN_EVENT_PAGE_SIZE = 200;

export const SQL_CODE_FENCE_RE = /```(?:sql|mysql|postgresql|postgres|oracle|plsql|sqlite|sqlserver|mssql|tsql|clickhouse|duckdb|starrocks|tdengine)?\s*([\s\S]*?)```/i;
export const INLINE_TABLE_COMPLETION_RE = /\b(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE\s+TABLE)\s*([^\s,()]*)$/i;

export type QueryEditorInlineCompletionIntentDetails = {
    intent: 'general_sql' | 'table_name' | 'column_name';
    fragment: string;
    qualifier: string;
};
