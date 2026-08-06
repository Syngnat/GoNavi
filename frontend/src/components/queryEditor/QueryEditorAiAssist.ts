import type {
    AIProviderConfig,
    AIUserPromptSettings,
} from '../../types';
import type {
    CompletionColumnMeta,
    CompletionTableMeta,
} from './QueryEditorHelpers';
import {
    buildQueryEditorAliasMap,
} from './QueryEditorHelpers';
import { isPostgresSchemaDialect } from '../../utils/connectionDriverType';

export type QueryEditorAiApplyMode = 'insert' | 'replaceSelection' | 'replaceAll';

export interface QueryEditorAiService {
    AIGetProviders?: () => Promise<AIProviderConfig[]>;
    AIGetActiveProvider?: () => Promise<string>;
    AIGetUserPromptSettings?: () => Promise<Partial<AIUserPromptSettings>>;
    AIChatSend?: (messages: QueryEditorAiMessage[], tools?: any[]) => Promise<Record<string, any>>;
    AIChatSendWithOptions?: (
        messages: QueryEditorAiMessage[],
        tools?: any[],
        options?: QueryEditorAiChatSendOptions,
    ) => Promise<Record<string, any>>;
}

export interface QueryEditorAiChatSendOptions {
    model?: string;
    temperature?: number;
    maxTokens?: number;
}

export interface QueryEditorAiMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface QueryEditorAiContext {
    connectionName?: string;
    host?: string;
    port?: string | number;
    sourceType?: string;
    currentDb?: string;
    visibleDbs?: string[];
    tables?: CompletionTableMeta[];
    columns?: CompletionColumnMeta[];
    inlineSchemaScope?: 'referenced_tables' | 'current_database';
    inlineReferencedTables?: QueryEditorAiTableReference[];
    inlineCompletionIntent?: 'general_sql' | 'table_name' | 'column_name';
    inlineCompletionFragment?: string;
    inlineCompletionQualifier?: string;
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

const EMPTY_USER_PROMPT_SETTINGS: AIUserPromptSettings = {
    global: '',
    database: '',
    jvm: '',
    jvmDiagnostic: '',
};

const INLINE_PREFIX_LIMIT = 3600;
const INLINE_SUFFIX_LIMIT = 1200;
const TEXT_TO_SQL_PREFIX_LIMIT = 5000;
const TEXT_TO_SQL_SUFFIX_LIMIT = 1800;
const MAX_SCHEMA_SNAPSHOT_CHARS = 7000;
const MAX_SCHEMA_TABLES = 48;
const MAX_INLINE_SCHEMA_TABLES = 18;
const MAX_SCHEMA_COLUMNS_PER_TABLE = 14;
const MAX_INLINE_INSERT_CHARS = 1800;
const MAX_INLINE_GHOST_PREVIEW_CHARS = 220;
const INLINE_COMPLETION_MAX_TOKENS = 192;
const INLINE_COMPLETION_TEMPERATURE = 0.1;
const INLINE_RUNTIME_READINESS_CACHE_TTL_MS = 5000;

const SQL_CODE_FENCE_RE = /```(?:sql|mysql|postgresql|postgres|oracle|plsql|sqlite|sqlserver|mssql|tsql|clickhouse|duckdb|starrocks|tdengine)?\s*([\s\S]*?)```/i;
const INLINE_TABLE_COMPLETION_RE = /\b(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE\s+TABLE)\s*([^\s,()]*)$/i;

type QueryEditorInlineCompletionIntentDetails = {
    intent: 'general_sql' | 'table_name' | 'column_name';
    fragment: string;
    qualifier: string;
};

export const getQueryEditorAiService = (): QueryEditorAiService | undefined =>
    (window as any)?.go?.aiservice?.Service;

export const resolveQueryEditorInlineCompletionModel = (provider: AIProviderConfig): string =>
    String(provider.inlineCompletionModel || provider.model || '').trim();

export const resolveQueryEditorAiRuntimeReadiness = async (
    service: QueryEditorAiService | undefined,
    options: { requireInlineCompletionModel?: boolean } = {},
): Promise<QueryEditorAiRuntimeReadiness> => {
    if ((!service?.AIChatSend && !service?.AIChatSendWithOptions) || !service?.AIGetProviders || !service?.AIGetActiveProvider) {
        return {
            ready: false,
            reason: 'service_unavailable',
            userPromptSettings: EMPTY_USER_PROMPT_SETTINGS,
        };
    }

    const [providers, activeProviderId, rawUserPromptSettings] = await Promise.all([
        service.AIGetProviders(),
        service.AIGetActiveProvider(),
        service.AIGetUserPromptSettings?.().catch(() => EMPTY_USER_PROMPT_SETTINGS),
    ]);
    const provider = Array.isArray(providers)
        ? providers.find((item) => item.id === activeProviderId)
        : undefined;
    const userPromptSettings = {
        ...EMPTY_USER_PROMPT_SETTINGS,
        ...(rawUserPromptSettings || {}),
    };

    if (!provider) {
        return {
            ready: false,
            reason: 'provider_missing',
            userPromptSettings,
        };
    }
    const selectedModel = options.requireInlineCompletionModel
        ? resolveQueryEditorInlineCompletionModel(provider)
        : String(provider.model || '').trim();
    if (!selectedModel) {
        return {
            ready: false,
            reason: 'model_missing',
            provider,
            userPromptSettings,
        };
    }

    return {
        ready: true,
        provider,
        userPromptSettings,
    };
};

type InlineRuntimeReadinessCacheEntry = {
    expiresAt: number;
    promise: Promise<QueryEditorAiRuntimeReadiness>;
};

let inlineRuntimeReadinessCache = new WeakMap<object, InlineRuntimeReadinessCacheEntry>();

export const clearQueryEditorInlineRuntimeReadinessCache = (): void => {
    inlineRuntimeReadinessCache = new WeakMap<object, InlineRuntimeReadinessCacheEntry>();
};

if (typeof window !== 'undefined') {
    window.addEventListener('gonavi:ai:provider-changed', clearQueryEditorInlineRuntimeReadinessCache);
    window.addEventListener('gonavi:ai:config-changed', clearQueryEditorInlineRuntimeReadinessCache);
}

export const resolveQueryEditorInlineRuntimeReadiness = (
    service: QueryEditorAiService | undefined,
): Promise<QueryEditorAiRuntimeReadiness> => {
    if (!service || typeof service !== 'object') {
        return resolveQueryEditorAiRuntimeReadiness(service, { requireInlineCompletionModel: true });
    }

    const now = Date.now();
    const cached = inlineRuntimeReadinessCache.get(service);
    if (cached && cached.expiresAt > now) {
        return cached.promise;
    }

    const promise = resolveQueryEditorAiRuntimeReadiness(service, { requireInlineCompletionModel: true });
    const entry = {
        expiresAt: now + INLINE_RUNTIME_READINESS_CACHE_TTL_MS,
        promise,
    };
    inlineRuntimeReadinessCache.set(service, entry);
    void promise.catch(() => {
        if (inlineRuntimeReadinessCache.get(service) === entry) {
            inlineRuntimeReadinessCache.delete(service);
        }
    });
    return promise;
};

export const shouldRequestQueryEditorInlineCompletion = (
    snapshot: QueryEditorAiEditorSnapshot,
): boolean => {
    if (!shouldAllowQueryEditorInlineMemoryCompletion(snapshot)) {
        return false;
    }

    const prefix = String(snapshot.prefix || '');
    const currentStatement = getCurrentStatementPrefix(prefix);
    const trimmedStatement = currentStatement.trim();
    if (trimmedStatement.length < 3) {
        return false;
    }
    return true;
};

export const shouldAllowQueryEditorInlineMemoryCompletion = (
    snapshot: QueryEditorAiEditorSnapshot,
): boolean => {
    const lineAfterCursor = String(snapshot.currentLineAfterCursor || '');
    if (lineAfterCursor.length > 0) {
        return false;
    }

    const prefix = String(snapshot.prefix || '');
    const currentStatement = getCurrentStatementPrefix(prefix);
    const trimmedStatement = currentStatement.trim();
    if (/[;)]\s*$/.test(trimmedStatement)) {
        return false;
    }

    const currentLine = String(snapshot.currentLineBeforeCursor || '');
    const trimmedLine = currentLine.trimStart();
    if (trimmedLine.startsWith('--') || trimmedLine.startsWith('#')) {
        return false;
    }
    if (currentLine.includes('--')) {
        return false;
    }
    if (hasUnclosedBlockComment(prefix) || hasUnclosedSqlString(currentStatement)) {
        return false;
    }

    return true;
};

const normalizeInlineMemoryCandidateSql = (sql: string): string => (
    String(sql || '')
        .replace(/\r\n?/g, '\n')
        .trim()
);

const normalizeInlineMemoryMatchText = (sql: string): string => (
    normalizeInlineMemoryCandidateSql(sql)
        .replace(/\s+/g, ' ')
        .trimStart()
        .toLowerCase()
);

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
}: {
    editorSnapshot: QueryEditorAiEditorSnapshot;
    memoryEntries: QueryEditorInlineMemoryEntry[];
    sourceType?: string;
}): string => {
    if (!shouldAllowQueryEditorInlineMemoryCompletion(editorSnapshot)) {
        return '';
    }

    const statementPrefix = getCurrentStatementPrefix(editorSnapshot.prefix);
    const normalizedStatementPrefix = normalizeInlineMemoryMatchText(statementPrefix);
    for (const entry of memoryEntries || []) {
        const candidateSql = normalizeInlineMemoryCandidateSql(entry?.sql || '');
        if (!candidateSql) {
            continue;
        }
        if (normalizedStatementPrefix && !normalizeInlineMemoryMatchText(candidateSql).startsWith(normalizedStatementPrefix)) {
            continue;
        }
        const insertText = resolveInlineSqlInsertText(candidateSql, editorSnapshot.prefix);
        const intent = resolveQueryEditorInlineCompletionIntentDetails(editorSnapshot);
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
}: {
    aiContext: QueryEditorAiContext;
    editorSnapshot: QueryEditorAiEditorSnapshot;
    deferEmptySchemaCompletion?: boolean;
}): { handled: boolean; insertText: string } => {
    if (!shouldRequestQueryEditorInlineCompletion(editorSnapshot)) {
        return {
            handled: true,
            insertText: '',
        };
    }

    const inlineIntent = resolveQueryEditorInlineCompletionIntentDetails(editorSnapshot);
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

    return resolveDeterministicInlineSyntaxCompletion(editorSnapshot);
};

export const requestQueryEditorInlineCompletion = async ({
    service,
    aiContext,
    editorSnapshot,
}: {
    service: QueryEditorAiService | undefined;
    aiContext: QueryEditorAiContext;
    editorSnapshot: QueryEditorAiEditorSnapshot;
}): Promise<string> => {
    const localCompletion = resolveQueryEditorInlineLocalCompletion({ aiContext, editorSnapshot });
    if (localCompletion.handled) {
        return localCompletion.insertText;
    }
    const inlineIntent = resolveQueryEditorInlineCompletionIntentDetails(editorSnapshot);
    const readiness = await resolveQueryEditorInlineRuntimeReadiness(service);
    if (!readiness.ready || !readiness.provider) {
        return '';
    }

    const inlineAiContext = buildQueryEditorInlineCompletionContext(aiContext, editorSnapshot);
    const messages = buildQueryEditorInlineCompletionMessages({
        aiContext: inlineAiContext,
        editorSnapshot,
        userPromptSettings: readiness.userPromptSettings,
    });
    const inlineModel = resolveQueryEditorInlineCompletionModel(readiness.provider);
    const result = service?.AIChatSendWithOptions
        ? await service.AIChatSendWithOptions(messages, [], {
            model: inlineModel,
            maxTokens: INLINE_COMPLETION_MAX_TOKENS,
            temperature: INLINE_COMPLETION_TEMPERATURE,
        })
        : await service!.AIChatSend!(messages, []);
    const responseContent = String(result?.content || result?.reasoning_content || '');
    if (!result?.success || !responseContent.trim()) {
        return '';
    }

    const sanitized = sanitizeSqlAssistantResponse(responseContent);
    const insertText = resolveInlineSqlInsertText(sanitized, editorSnapshot.prefix);
    if (inlineIntent.intent === 'table_name') {
        return limitInlineInsertText(resolveValidatedInlineTableAiInsertText(
            inlineAiContext,
            editorSnapshot,
            inlineIntent.fragment,
            insertText,
        ));
    }
    if (inlineIntent.intent === 'column_name') {
        return limitInlineInsertText(resolveValidatedInlineColumnAiInsertText(
            inlineAiContext,
            editorSnapshot,
            inlineIntent.qualifier,
            inlineIntent.fragment,
            insertText,
        ));
    }
    if (!isInlineCompletionScopedToKnownContext(insertText, editorSnapshot.prefix, inlineAiContext)) {
        return '';
    }
    return limitInlineInsertText(insertText);
};

export const shouldTriggerQueryEditorInlineObjectSuggestFallback = ({
    aiContext,
    editorSnapshot,
}: {
    aiContext: QueryEditorAiContext;
    editorSnapshot: QueryEditorAiEditorSnapshot;
}): boolean => {
    const intent = resolveQueryEditorInlineCompletionIntentDetails(editorSnapshot);
    if (intent.intent === 'table_name') {
        return shouldAllowInlineTableAiFallback(aiContext, intent.fragment);
    }
    if (intent.intent === 'column_name') {
        return shouldAllowInlineColumnAiFallback(
            aiContext,
            editorSnapshot,
            intent.qualifier,
            intent.fragment,
        );
    }
    return false;
};

export const requestQueryEditorTextToSql = async ({
    service,
    aiContext,
    editorSnapshot,
    instruction,
}: {
    service: QueryEditorAiService | undefined;
    aiContext: QueryEditorAiContext;
    editorSnapshot: QueryEditorAiEditorSnapshot;
    instruction: string;
}): Promise<{ sql: string; readiness: QueryEditorAiRuntimeReadiness }> => {
    const readiness = await resolveQueryEditorAiRuntimeReadiness(service);
    if (!readiness.ready) {
        return { sql: '', readiness };
    }

    const messages = buildQueryEditorTextToSqlMessages({
        aiContext,
        editorSnapshot,
        instruction,
        userPromptSettings: readiness.userPromptSettings,
    });
    const result = await service!.AIChatSend!(messages, []);
    if (!result?.success) {
        throw new Error(String(result?.error || 'AI request failed'));
    }

    return {
        sql: sanitizeSqlAssistantResponse(String(result.content || '')),
        readiness,
    };
};

export const requestQueryEditorTextToElasticsearch = async ({
    service,
    aiContext,
    editorSnapshot,
    instruction,
}: {
    service: QueryEditorAiService | undefined;
    aiContext: QueryEditorAiContext;
    editorSnapshot: QueryEditorAiEditorSnapshot;
    instruction: string;
}): Promise<{ source: string; readiness: QueryEditorAiRuntimeReadiness }> => {
    const readiness = await resolveQueryEditorAiRuntimeReadiness(service);
    if (!readiness.ready) {
        return { source: '', readiness };
    }

    const messages = buildQueryEditorTextToElasticsearchMessages({
        aiContext,
        editorSnapshot,
        instruction,
        userPromptSettings: readiness.userPromptSettings,
    });
    const result = await service!.AIChatSend!(messages, []);
    if (!result?.success) {
        throw new Error(String(result?.error || 'AI request failed'));
    }

    return {
        source: sanitizeElasticsearchConsoleAssistantResponse(String(result.content || '')),
        readiness,
    };
};

export const buildQueryEditorInlineCompletionMessages = ({
    aiContext,
    editorSnapshot,
    userPromptSettings,
}: {
    aiContext: QueryEditorAiContext;
    editorSnapshot: QueryEditorAiEditorSnapshot;
    userPromptSettings: AIUserPromptSettings;
}): QueryEditorAiMessage[] => {
    // inlineCompletionIntent 已存在说明调用方传入的已是收敛后的内联上下文，避免重复做 O(列数) 的过滤。
    const inlineAiContext = aiContext.inlineCompletionIntent !== undefined
        ? aiContext
        : buildQueryEditorInlineCompletionContext(aiContext, editorSnapshot);
    return [
        {
            role: 'system',
            content: [
                'You are GoNavi SQL inline completion.',
                'Return only the exact SQL text that should be inserted at the cursor.',
                'Do not use Markdown, code fences, explanations, comments about your answer, or natural language.',
                'Continue the current SQL instead of repeating text that already exists before the cursor.',
                'Respect the selected database connection, host, database, dialect, and schema hints.',
                'Use only tables, columns, schemas, and databases present in the schema hints or already present in the editor snapshot.',
                'If schema hints are insufficient, generate only minimal SQL syntax and do not invent object names.',
                'When inline_completion_intent is table_name, use only tables from the selected database context.',
                'When inline_completion_intent is column_name, use only columns from the referenced table or alias context.',
                'When inline_completion_intent is table_name or column_name, never output aliases, AS clauses, predicates, JOIN clauses, or commentary.',
                'If the cursor is at an object-name position and there is no grounded schema candidate, return an empty string.',
                'Prefer concise, executable SQL.',
            ].join('\n'),
        },
        ...buildCustomPromptMessages(userPromptSettings),
        {
            role: 'user',
            content: [
                buildQueryEditorAiContextBlock(inlineAiContext),
                'Editor snapshot:',
                '<prefix_before_cursor>',
                truncateHead(editorSnapshot.prefix, INLINE_PREFIX_LIMIT),
                '</prefix_before_cursor>',
                '<suffix_after_cursor>',
                truncateTail(editorSnapshot.suffix, INLINE_SUFFIX_LIMIT),
                '</suffix_after_cursor>',
                'The cursor is at the end of prefix_before_cursor. Generate the continuation text only.',
            ].join('\n'),
        },
    ];
};

export const buildQueryEditorTextToSqlMessages = ({
    aiContext,
    editorSnapshot,
    instruction,
    userPromptSettings,
}: {
    aiContext: QueryEditorAiContext;
    editorSnapshot: QueryEditorAiEditorSnapshot;
    instruction: string;
    userPromptSettings: AIUserPromptSettings;
}): QueryEditorAiMessage[] => [
    {
        role: 'system',
        content: [
            'You are GoNavi Text-to-SQL.',
            'Generate SQL for the SQL editor from the user request.',
            'Return only SQL. Do not use Markdown, code fences, or explanations.',
            'Respect the database dialect, current database, schema hints, and existing editor context.',
            'Prefer read-only SQL unless the user explicitly asks for data or schema changes.',
        ].join('\n'),
    },
    ...buildCustomPromptMessages(userPromptSettings),
    {
        role: 'user',
        content: [
            buildQueryEditorAiContextBlock(aiContext),
            'User request:',
            instruction.trim(),
            '',
            'Current editor context:',
            '<prefix_before_cursor>',
            truncateHead(editorSnapshot.prefix, TEXT_TO_SQL_PREFIX_LIMIT),
            '</prefix_before_cursor>',
            '<suffix_after_cursor>',
            truncateTail(editorSnapshot.suffix, TEXT_TO_SQL_SUFFIX_LIMIT),
            '</suffix_after_cursor>',
        ].join('\n'),
    },
];

export const buildQueryEditorTextToElasticsearchMessages = ({
    aiContext,
    editorSnapshot,
    instruction,
    userPromptSettings,
}: {
    aiContext: QueryEditorAiContext;
    editorSnapshot: QueryEditorAiEditorSnapshot;
    instruction: string;
    userPromptSettings: AIUserPromptSettings;
}): QueryEditorAiMessage[] => {
    const currentIndex = String(aiContext.currentDb || '').trim() || '(not selected)';
    const version = String(aiContext.elasticsearchVersion || '').trim() || '(unknown)';
    const mapping = String(aiContext.elasticsearchMapping || '').trim() || '(not available)';
    return [
        {
            role: 'system',
            content: [
                'You are GoNavi Elasticsearch REST console assistant.',
                'Return only executable Elasticsearch DevTools requests in METHOD /path plus optional JSON or NDJSON body form.',
                'Do not use Markdown, code fences, explanations, base URLs, HTTP headers, authentication, or credentials.',
                'Generate read-only requests by default. Generate writes only when the user explicitly asks to create, change, or delete data or indexes.',
                'Use GET, POST, PUT, DELETE, or HEAD and relative paths beginning with /.',
                'Respect the server major version, current index, mapping, and existing editor context.',
            ].join('\n'),
        },
        ...buildCustomPromptMessages(userPromptSettings),
        {
            role: 'user',
            content: [
                `Elasticsearch major version: ${version}`,
                `Current index: ${currentIndex}`,
                'Mapping:',
                mapping,
                '',
                'User request:',
                instruction.trim(),
                '',
                'Current editor context:',
                '<prefix_before_cursor>',
                truncateHead(editorSnapshot.prefix, TEXT_TO_SQL_PREFIX_LIMIT),
                '</prefix_before_cursor>',
                '<suffix_after_cursor>',
                truncateTail(editorSnapshot.suffix, TEXT_TO_SQL_SUFFIX_LIMIT),
                '</suffix_after_cursor>',
            ].join('\n'),
        },
    ];
};

export const sanitizeElasticsearchConsoleAssistantResponse = (raw: string): string => {
    let text = String(raw || '').trim();
    const fenceMatch = text.match(/```(?:http|json|ndjson|elasticsearch|console)?\s*([\s\S]*?)```/i);
    if (fenceMatch?.[1]) {
        text = fenceMatch[1].trim();
    }
    text = text
        .replace(/^\s*(?:request|answer|console)\s*[:：]\s*/i, '')
        .trim();
    if (/https?:\/\//i.test(text)) {
        return '';
    }
    if (/^\s*(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:/im.test(text)) {
        return '';
    }
    return text;
};

export const sanitizeSqlAssistantResponse = (raw: string): string => {
    let text = String(raw || '').trim();
    const fenceMatch = text.match(SQL_CODE_FENCE_RE);
    if (fenceMatch?.[1]) {
        text = fenceMatch[1].trim();
    }
    text = text
        .replace(/^\s*(?:sql|query|answer)\s*[:：]\s*/i, '')
        .replace(/^\s*Here is (?:the )?SQL\s*[:：]\s*/i, '')
        .trim();
    if (
        text.length >= 2
        && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
        && !text.includes('\n')
    ) {
        text = text.slice(1, -1).trim();
    }
    return text;
};

export const resolveInlineSqlInsertText = (generatedSql: string, prefix: string): string => {
    const generated = String(generatedSql || '').trimEnd();
    if (!generated.trim()) {
        return '';
    }

    const prefixText = String(prefix || '');
    const statementPrefix = getCurrentStatementPrefix(prefixText);
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

export const resolveInlineSqlGhostPreviewText = (insertText: string): string => {
    const raw = String(insertText || '').replace(/\r\n?/g, '\n');
    if (!raw.trim()) {
        return '';
    }

    const hasLeadingWhitespace = /^\s/.test(raw);
    const singleLine = raw.replace(/\s+/g, ' ').trim();
    if (!singleLine) {
        return '';
    }

    const preview = singleLine.length > MAX_INLINE_GHOST_PREVIEW_CHARS
        ? `${singleLine.slice(0, MAX_INLINE_GHOST_PREVIEW_CHARS).trimEnd()} ...`
        : singleLine;
    return `${hasLeadingWhitespace ? ' ' : ''}${preview}`;
};

export const buildQueryEditorAiContextBlock = (context: QueryEditorAiContext): string => {
    const sourceType = String(context.sourceType || '').trim() || 'unknown';
    const connectionName = String(context.connectionName || '').trim() || 'unknown';
    const host = String(context.host || '').trim();
    const port = String(context.port || '').trim();
    const hostLabel = host ? `${host}${port ? `:${port}` : ''}` : '';
    const currentDb = String(context.currentDb || '').trim() || 'default';
    const visibleDbs = (context.visibleDbs || [])
        .map((db) => String(db || '').trim())
        .filter(Boolean)
        .slice(0, 24)
        .join(', ');
    const referencedTables = (context.inlineReferencedTables || [])
        .map((table) => {
            const label = `${table.dbName ? `${table.dbName}.` : ''}${table.tableName}`;
            return table.alias ? `${label} AS ${table.alias}` : label;
        })
        .filter(Boolean)
        .join(', ');

    return [
        'Database context:',
        `- source_type: ${sourceType}`,
        `- connection: ${connectionName}`,
        hostLabel ? `- host: ${hostLabel}` : '',
        `- current_database: ${currentDb}`,
        visibleDbs ? `- visible_databases: ${visibleDbs}` : '',
        context.inlineSchemaScope ? `- schema_scope: ${context.inlineSchemaScope}` : '',
        referencedTables ? `- current_statement_tables: ${referencedTables}` : '',
        context.inlineCompletionIntent ? `- inline_completion_intent: ${context.inlineCompletionIntent}` : '',
        context.inlineCompletionQualifier ? `- inline_completion_qualifier: ${context.inlineCompletionQualifier}` : '',
        context.inlineCompletionFragment !== undefined ? `- inline_completion_fragment: ${context.inlineCompletionFragment}` : '',
        'Schema hints:',
        buildSchemaSnapshot(context),
    ].filter(Boolean).join('\n');
};

export const buildQueryEditorInlineCompletionContext = (
    context: QueryEditorAiContext,
    editorSnapshot: QueryEditorAiEditorSnapshot,
): QueryEditorAiContext => {
    const currentDb = String(context.currentDb || '').trim();
    const statementPrefix = getCurrentStatementPrefix(editorSnapshot.prefix);
    const intent = resolveQueryEditorInlineCompletionIntentDetails(editorSnapshot);
    const referencedTables = collectInlineTableReferences(statementPrefix, currentDb, context.visibleDbs || []);

    let nextContext: QueryEditorAiContext;
    if (context.inlineSchemaScope) {
        nextContext = {
            ...context,
            inlineReferencedTables: context.inlineReferencedTables || referencedTables,
        };
    } else if (referencedTables.length > 0) {
        const tables = collectReferencedSchemaTables(context.tables || [], referencedTables);
        nextContext = {
            ...context,
            tables,
            columns: filterColumnsForTables(context.columns || [], tables, referencedTables),
            inlineSchemaScope: 'referenced_tables',
            inlineReferencedTables: referencedTables,
        };
    } else {
        const currentDbTables = collectCurrentDatabaseTables(context.tables || [], currentDb);
        nextContext = {
            ...context,
            tables: currentDbTables,
            columns: filterColumnsForTables(context.columns || [], currentDbTables, []),
            inlineSchemaScope: 'current_database',
            inlineReferencedTables: [],
        };
    }

    if (intent.intent === 'column_name') {
        const ownerRef = resolveInlineColumnOwnerReference(context, editorSnapshot, intent.qualifier);
        if (ownerRef) {
            const ownerTables = collectReferencedSchemaTables(context.tables || [], [ownerRef]);
            return {
                ...nextContext,
                tables: ownerTables,
                columns: filterColumnsForTables(context.columns || [], ownerTables, [ownerRef]),
                inlineSchemaScope: 'referenced_tables',
                inlineReferencedTables: [ownerRef],
                inlineCompletionIntent: intent.intent,
                inlineCompletionFragment: intent.fragment,
                inlineCompletionQualifier: intent.qualifier,
            };
        }
    }

    if (intent.intent === 'table_name') {
        return {
            ...nextContext,
            tables: filterInlineTableMatches(context.tables || [], currentDb, intent.fragment),
            columns: [],
            inlineSchemaScope: 'current_database',
            inlineReferencedTables: [],
            inlineCompletionIntent: intent.intent,
            inlineCompletionFragment: intent.fragment,
            inlineCompletionQualifier: '',
        };
    }

    return {
        ...nextContext,
        inlineCompletionIntent: intent.intent,
        inlineCompletionFragment: intent.fragment,
        inlineCompletionQualifier: intent.qualifier,
    };
};

const buildCustomPromptMessages = (settings: AIUserPromptSettings): QueryEditorAiMessage[] => {
    const prompts = [
        String(settings.global || '').trim(),
        String(settings.database || '').trim(),
    ].filter(Boolean);
    if (!prompts.length) {
        return [];
    }
    return [{
        role: 'system',
        content: [
            'User configured GoNavi AI instructions:',
            ...prompts.map((prompt, index) => `Instruction ${index + 1}:\n${prompt}`),
        ].join('\n\n'),
    }];
};

const buildSchemaSnapshot = (context: QueryEditorAiContext): string => {
    const currentDb = String(context.currentDb || '').trim().toLowerCase();
    const columnsByTable = new Map<string, CompletionColumnMeta[]>();
    (context.columns || []).forEach((column) => {
        const key = schemaItemKey(column.dbName, column.tableName);
        const existing = columnsByTable.get(key) || [];
        if (existing.length < MAX_SCHEMA_COLUMNS_PER_TABLE) {
            existing.push(column);
            columnsByTable.set(key, existing);
        }
    });

    const tables = [...(context.tables || [])]
        .filter((table) => String(table.tableName || '').trim())
        .sort((left, right) => {
            const leftDb = String(left.dbName || '').trim().toLowerCase();
            const rightDb = String(right.dbName || '').trim().toLowerCase();
            if (leftDb === currentDb && rightDb !== currentDb) return -1;
            if (rightDb === currentDb && leftDb !== currentDb) return 1;
            return String(left.tableName || '').localeCompare(String(right.tableName || ''));
        })
        .slice(0, MAX_SCHEMA_TABLES);

    if (!tables.length) {
        if (context.inlineSchemaScope === 'referenced_tables') {
            const refs = (context.inlineReferencedTables || [])
                .map((table) => `${table.dbName ? `${table.dbName}.` : ''}${table.tableName}`)
                .filter(Boolean)
                .join(', ');
            return refs
                ? `- Referenced table metadata is unavailable for: ${refs}. Do not use any other table or column names.`
                : '- Referenced table metadata is unavailable. Do not invent table or column names.';
        }
        if (context.inlineSchemaScope === 'current_database') {
            return '- No table metadata is loaded for the current database. Do not invent table or column names.';
        }
        return '- No table metadata is loaded yet. Use the current SQL and database name as context.';
    }

    const lines = tables.map((table) => {
        const dbName = String(table.dbName || context.currentDb || '').trim();
        const tableName = String(table.tableName || '').trim();
        const columns = columnsByTable.get(schemaItemKey(dbName, tableName)) || [];
        const columnText = columns.length
            ? columns.map((column) => {
                const type = String(column.type || '').trim();
                const comment = String(column.comment || '').trim();
                return [
                    String(column.name || '').trim(),
                    type ? ` ${type}` : '',
                    comment ? ` -- ${comment}` : '',
                ].join('');
            }).join(', ')
            : 'columns unavailable';
        const comment = String(table.comment || '').trim();
        return `- ${dbName ? `${dbName}.` : ''}${tableName}${comment ? ` -- ${comment}` : ''}; columns: ${columnText}`;
    });

    const snapshot = lines.join('\n');
    return snapshot.length > MAX_SCHEMA_SNAPSHOT_CHARS
        ? `${snapshot.slice(0, MAX_SCHEMA_SNAPSHOT_CHARS)}\n- ...schema snapshot truncated`
        : snapshot;
};

const schemaItemKey = (dbName: string, tableName: string): string =>
    `${String(dbName || '').trim().toLowerCase()}\u0000${String(tableName || '').trim().toLowerCase()}`;

const INLINE_IDENTIFIER_PATTERN = '(?:`[^`]+`|"[^"]+"|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)';
const INLINE_IDENTIFIER_PATH_PATTERN = `${INLINE_IDENTIFIER_PATTERN}(?:\\s*\\.\\s*${INLINE_IDENTIFIER_PATTERN}){0,2}`;
const INLINE_COLUMN_COMPLETION_RE = new RegExp(`(${INLINE_IDENTIFIER_PATTERN})\\s*\\.\\s*([^\\s,()]*)$`, 'i');
const INLINE_TABLE_REFERENCE_RE = new RegExp(
    `\\b(?:FROM|JOIN|UPDATE|INTO|DELETE\\s+FROM|ALTER\\s+TABLE|DROP\\s+TABLE|TRUNCATE\\s+TABLE)\\s+(${INLINE_IDENTIFIER_PATH_PATTERN})(?:\\s+(?:AS\\s+)?(${INLINE_IDENTIFIER_PATTERN}))?`,
    'gi',
);
const INLINE_CTE_NAME_RE = new RegExp(
    `(?:\\bWITH|,)\\s+(${INLINE_IDENTIFIER_PATTERN})\\s+AS\\s*\\(`,
    'gi',
);
const INLINE_TABLE_FRAGMENT_SAFE_RE = /^[`"[\]A-Za-z0-9_$.]*$/;
const INLINE_COLUMN_FRAGMENT_SAFE_RE = /^[`"[\]A-Za-z0-9_$]*$/;

const INLINE_TABLE_ALIAS_RESERVED_WORDS = new Set([
    'where', 'on', 'group', 'order', 'limit', 'having',
    'left', 'right', 'inner', 'outer', 'full', 'cross', 'join',
    'union', 'except', 'intersect', 'as', 'set', 'values', 'returning',
    'add', 'rename', 'modify', 'change', 'column', 'columns', 'comment',
    'cascade', 'restrict', 'restart', 'continue', 'identity', 'using',
    'when', 'then',
]);

const stripInlineIdentifierQuotes = (part: string): string => {
    const text = String(part || '').trim();
    if (!text) return '';
    if ((text.startsWith('`') && text.endsWith('`'))
        || (text.startsWith('"') && text.endsWith('"'))
        || (text.startsWith('[') && text.endsWith(']'))) {
        return text.slice(1, -1).trim();
    }
    return text;
};

const normalizeInlineIdentifierPath = (value: string): string => (
    String(value || '')
        .split('.')
        .map(stripInlineIdentifierQuotes)
        .filter(Boolean)
        .join('.')
);

const getInlineIdentifierLastPart = (value: string): string => {
    const parts = normalizeInlineIdentifierPath(value).split('.').filter(Boolean);
    return parts[parts.length - 1] || '';
};

const sameIdentifier = (left: string | undefined, right: string | undefined): boolean =>
    String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();

const splitInlineSchemaAndTable = (tableName: string): { schema: string; table: string } => {
    const parts = normalizeInlineIdentifierPath(tableName).split('.').filter(Boolean);
    if (parts.length < 2) {
        return { schema: '', table: parts[0] || '' };
    }
    return { schema: parts.slice(0, -1).join('.'), table: parts[parts.length - 1] || '' };
};

const resolveInlineTableReference = (
    rawTableIdent: string,
    rawAlias: string,
    currentDb: string,
    visibleDbs: string[],
): QueryEditorAiTableReference | null => {
    const tableIdent = normalizeInlineIdentifierPath(rawTableIdent);
    if (!tableIdent) return null;

    const visibleDbByLower = new Map(
        visibleDbs
            .map((db) => String(db || '').trim())
            .filter(Boolean)
            .map((db) => [db.toLowerCase(), db] as const),
    );
    const parts = tableIdent.split('.').filter(Boolean);
    let dbName = currentDb || '';
    let tableName = tableIdent;
    if (parts.length === 2) {
        const firstPartDb = visibleDbByLower.get(parts[0].toLowerCase());
        if (firstPartDb || sameIdentifier(parts[0], currentDb)) {
            dbName = firstPartDb || currentDb;
            tableName = parts[1];
        }
    } else if (parts.length >= 3) {
        dbName = visibleDbByLower.get(parts[0].toLowerCase()) || parts[0];
        tableName = parts.slice(1).join('.');
    }

    const alias = stripInlineIdentifierQuotes(rawAlias);
    const normalizedAlias = alias.toLowerCase();
    return {
        dbName,
        tableName,
        alias: alias && !INLINE_TABLE_ALIAS_RESERVED_WORDS.has(normalizedAlias) ? alias : undefined,
        raw: tableIdent,
    };
};

const collectInlineTableReferences = (
    sql: string,
    currentDb: string,
    visibleDbs: string[],
): QueryEditorAiTableReference[] => {
    const refs: QueryEditorAiTableReference[] = [];
    const seen = new Set<string>();
    INLINE_TABLE_REFERENCE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_TABLE_REFERENCE_RE.exec(String(sql || ''))) !== null) {
        const ref = resolveInlineTableReference(match[1] || '', match[2] || '', currentDb, visibleDbs);
        if (!ref) continue;
        const key = `${ref.dbName.toLowerCase()}\u0000${ref.tableName.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push(ref);
    }
    return refs;
};

const tableMatchesInlineReference = (
    table: Pick<CompletionTableMeta, 'dbName' | 'tableName'>,
    ref: QueryEditorAiTableReference,
): boolean => {
    if (ref.dbName && table.dbName && !sameIdentifier(table.dbName, ref.dbName)) {
        return false;
    }
    const tableName = normalizeInlineIdentifierPath(table.tableName || '');
    const refTableName = normalizeInlineIdentifierPath(ref.tableName || '');
    if (sameIdentifier(tableName, refTableName)) {
        return true;
    }
    const parsedTable = splitInlineSchemaAndTable(tableName);
    const parsedRef = splitInlineSchemaAndTable(refTableName);
    return !!parsedTable.table && sameIdentifier(parsedTable.table, parsedRef.table || refTableName);
};

const collectReferencedSchemaTables = (
    tables: CompletionTableMeta[],
    refs: QueryEditorAiTableReference[],
): CompletionTableMeta[] => {
    const result: CompletionTableMeta[] = [];
    const seen = new Set<string>();
    const addTable = (table: CompletionTableMeta) => {
        const key = schemaItemKey(table.dbName, table.tableName);
        if (seen.has(key)) return;
        seen.add(key);
        result.push(table);
    };

    refs.forEach((ref) => {
        const matched = tables.filter((table) => tableMatchesInlineReference(table, ref));
        if (matched.length > 0) {
            matched.forEach(addTable);
        } else {
            addTable({ dbName: ref.dbName, tableName: ref.tableName });
        }
    });

    return result.slice(0, MAX_INLINE_SCHEMA_TABLES);
};

// 大库列元数据可达数十万条，逐列正则匹配会阻塞主线程；按表名末段建一次索引，同一 columns 数组内复用。
const inlineColumnIndexCache = new WeakMap<CompletionColumnMeta[], Map<string, CompletionColumnMeta[]>>();

const getInlineColumnsByTableLastPart = (
    columns: CompletionColumnMeta[],
): Map<string, CompletionColumnMeta[]> => {
    const cached = inlineColumnIndexCache.get(columns);
    if (cached) {
        return cached;
    }
    const index = new Map<string, CompletionColumnMeta[]>();
    columns.forEach((column) => {
        const lastPart = getInlineIdentifierLastPart(column.tableName || '').toLowerCase();
        if (!lastPart) {
            return;
        }
        const list = index.get(lastPart);
        if (list) {
            list.push(column);
        } else {
            index.set(lastPart, [column]);
        }
    });
    inlineColumnIndexCache.set(columns, index);
    return index;
};

const collectColumnsMatchingReference = (
    columns: CompletionColumnMeta[],
    ref: QueryEditorAiTableReference,
): CompletionColumnMeta[] => {
    const refLastPart = getInlineIdentifierLastPart(ref.tableName || '').toLowerCase();
    if (!refLastPart) {
        return [];
    }
    const candidates = getInlineColumnsByTableLastPart(columns).get(refLastPart) || [];
    return candidates.filter((column) => tableMatchesInlineReference(
        { dbName: column.dbName, tableName: column.tableName },
        ref,
    ));
};

const filterColumnsForTables = (
    columns: CompletionColumnMeta[],
    tables: CompletionTableMeta[],
    refs: QueryEditorAiTableReference[],
): CompletionColumnMeta[] => {
    if (!columns.length || (!tables.length && !refs.length)) {
        return [];
    }
    const targets: QueryEditorAiTableReference[] = [
        ...tables.map((table) => ({ dbName: table.dbName, tableName: table.tableName, raw: table.tableName })),
        ...refs,
    ];
    const seen = new Set<CompletionColumnMeta>();
    const result: CompletionColumnMeta[] = [];
    targets.forEach((ref) => {
        collectColumnsMatchingReference(columns, ref).forEach((column) => {
            if (seen.has(column)) {
                return;
            }
            seen.add(column);
            result.push(column);
        });
    });
    return result;
};

const collectCurrentDatabaseTables = (
    tables: CompletionTableMeta[],
    currentDb: string,
): CompletionTableMeta[] => (
    tables
        .filter((table) => sameIdentifier(table.dbName, currentDb))
        .sort((left, right) => String(left.tableName || '').localeCompare(String(right.tableName || '')))
        .slice(0, MAX_INLINE_SCHEMA_TABLES)
);

export const resolveQueryEditorInlineCompletionIntentDetails = (
    editorSnapshot: QueryEditorAiEditorSnapshot,
): QueryEditorInlineCompletionIntentDetails => {
    const statementPrefix = getCurrentStatementPrefix(editorSnapshot.prefix);
    const tableMatch = statementPrefix.match(INLINE_TABLE_COMPLETION_RE);
    if (tableMatch) {
        const rawFragment = String(tableMatch[1] || '').trim();
        return {
            intent: 'table_name',
            fragment: INLINE_TABLE_FRAGMENT_SAFE_RE.test(rawFragment)
                ? normalizeInlineIdentifierPath(rawFragment)
                : '',
            qualifier: '',
        };
    }

    const columnMatch = statementPrefix.match(INLINE_COLUMN_COMPLETION_RE);
    if (columnMatch) {
        const rawFragment = String(columnMatch[2] || '').trim();
        return {
            intent: 'column_name',
            fragment: INLINE_COLUMN_FRAGMENT_SAFE_RE.test(rawFragment)
                ? stripInlineIdentifierQuotes(rawFragment).trim()
                : '',
            qualifier: normalizeInlineIdentifierPath(columnMatch[1] || ''),
        };
    }

    return {
        intent: 'general_sql',
        fragment: '',
        qualifier: '',
    };
};

const filterInlineTableMatches = (
    tables: CompletionTableMeta[],
    currentDb: string,
    fragment: string,
): CompletionTableMeta[] => {
    const normalizedFragment = normalizeInlineIdentifierPath(fragment).toLowerCase();
    const useQualifiedName = normalizedFragment.includes('.');
    const sourceTables = useQualifiedName ? tables : collectCurrentDatabaseTables(tables, currentDb);
    const matched = sourceTables.filter((table) => {
        if (!normalizedFragment) {
            return true;
        }
        const normalizedTableName = normalizeInlineIdentifierPath(table.tableName || '');
        const normalizedDbName = normalizeInlineIdentifierPath(table.dbName || '');
        const candidatePaths = useQualifiedName
            ? [
                normalizedTableName,
                normalizedDbName && !normalizedTableName.toLowerCase().startsWith(`${normalizedDbName.toLowerCase()}.`)
                    ? `${normalizedDbName}.${normalizedTableName}`
                    : '',
            ].filter(Boolean)
            : [getInlineIdentifierLastPart(normalizedTableName)];
        return candidatePaths.some((candidate) => candidate.toLowerCase().startsWith(normalizedFragment));
    });
    return matched.slice(0, MAX_INLINE_SCHEMA_TABLES);
};

const resolveInlineColumnOwnerReference = (
    context: QueryEditorAiContext,
    editorSnapshot: QueryEditorAiEditorSnapshot,
    qualifier: string,
): QueryEditorAiTableReference | null => {
    const normalizedQualifier = normalizeInlineIdentifierPath(qualifier);
    if (!normalizedQualifier) {
        return null;
    }

    const currentDb = String(context.currentDb || '').trim();
    const statementPrefix = getCurrentStatementPrefix(editorSnapshot.prefix);
    const aliasMap = buildQueryEditorAliasMap(statementPrefix, currentDb);
    const aliasMatch = aliasMap[normalizedQualifier.toLowerCase()];
    if (aliasMatch) {
        return {
            dbName: aliasMatch.dbName,
            tableName: aliasMatch.tableName,
            alias: normalizedQualifier,
            raw: normalizedQualifier,
        };
    }

    const directTable = (context.tables || []).find((table) => {
        if (!sameIdentifier(table.dbName, currentDb)) {
            return false;
        }
        const normalizedTableName = normalizeInlineIdentifierPath(table.tableName || '');
        return sameIdentifier(normalizedTableName, normalizedQualifier)
            || sameIdentifier(getInlineIdentifierLastPart(normalizedTableName), normalizedQualifier);
    });
    if (!directTable) {
        return null;
    }
    return {
        dbName: directTable.dbName,
        tableName: directTable.tableName,
        raw: normalizedQualifier,
    };
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

const collectInlineTableCandidateLabels = (
    context: QueryEditorAiContext,
    fragment: string,
): string[] => {
    const currentDb = String(context.currentDb || '').trim();
    const useQualifiedName = normalizeInlineIdentifierPath(fragment).includes('.');
    return filterInlineTableMatches(context.tables || [], currentDb, fragment)
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

const collectInlineColumnCandidateLabels = (
    context: QueryEditorAiContext,
    editorSnapshot: QueryEditorAiEditorSnapshot,
    qualifier: string,
): string[] => {
    const ownerRef = resolveInlineColumnOwnerReference(context, editorSnapshot, qualifier);
    if (!ownerRef) {
        return [];
    }

    return collectColumnsMatchingReference(context.columns || [], ownerRef)
        .map((column) => stripInlineIdentifierQuotes(column.name || '').trim())
        .filter(Boolean);
};

const resolveValidatedInlineObjectCandidateInsertText = ({
    candidateLabels,
    fragment,
    insertText,
    prefix,
    normalizer,
    safePattern,
    preserveCandidateCase = false,
}: {
    candidateLabels: string[];
    fragment: string;
    insertText: string;
    prefix: string;
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

const resolveValidatedInlineTableAiInsertText = (
    context: QueryEditorAiContext,
    editorSnapshot: QueryEditorAiEditorSnapshot,
    fragment: string,
    insertText: string,
): string => resolveValidatedInlineObjectCandidateInsertText({
    candidateLabels: collectInlineTableCandidateLabels(context, fragment),
    fragment,
    insertText,
    prefix: editorSnapshot.prefix,
    normalizer: normalizeInlineIdentifierPath,
    safePattern: INLINE_TABLE_FRAGMENT_SAFE_RE,
    preserveCandidateCase: isPostgresSchemaDialect(context.sourceType || ''),
});

const resolveValidatedInlineColumnAiInsertText = (
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
    normalizer: stripInlineIdentifierQuotes,
    safePattern: INLINE_COLUMN_FRAGMENT_SAFE_RE,
    preserveCandidateCase: isPostgresSchemaDialect(context.sourceType || ''),
});

const shouldAllowInlineTableAiFallback = (
    context: QueryEditorAiContext,
    fragment: string,
): boolean => shouldAllowInlineObjectAiFallback(
    collectInlineTableCandidateLabels(context, fragment),
    fragment,
    normalizeInlineIdentifierPath,
);

const shouldAllowInlineColumnAiFallback = (
    context: QueryEditorAiContext,
    editorSnapshot: QueryEditorAiEditorSnapshot,
    qualifier: string,
    fragment: string,
): boolean => shouldAllowInlineObjectAiFallback(
    collectInlineColumnCandidateLabels(context, editorSnapshot, qualifier),
    fragment,
    stripInlineIdentifierQuotes,
);

const resolveDeterministicInlineSchemaCompletion = (
    context: QueryEditorAiContext,
    editorSnapshot: QueryEditorAiEditorSnapshot,
    intentDetails?: QueryEditorInlineCompletionIntentDetails,
): { handled: boolean; insertText: string } => {
    const intent = intentDetails || resolveQueryEditorInlineCompletionIntentDetails(editorSnapshot);
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
    const intent = resolveQueryEditorInlineCompletionIntentDetails(editorSnapshot);
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

const resolveDeterministicInlineSyntaxCompletion = (
    editorSnapshot: QueryEditorAiEditorSnapshot,
): { handled: boolean; insertText: string } => {
    const statementPrefix = getCurrentStatementPrefix(editorSnapshot.prefix);
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

const collectInlineCteNames = (sql: string): Set<string> => {
    const names = new Set<string>();
    INLINE_CTE_NAME_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_CTE_NAME_RE.exec(String(sql || ''))) !== null) {
        const name = stripInlineIdentifierQuotes(match[1] || '').trim();
        if (name) {
            names.add(name.toLowerCase());
        }
    }
    return names;
};

const isInlineCompletionScopedToKnownContext = (
    insertText: string,
    prefix: string,
    context: QueryEditorAiContext,
): boolean => {
    const insertedTableRefs = collectInlineTableReferences(insertText, context.currentDb || '', context.visibleDbs || []);
    if (!insertedTableRefs.length) {
        return true;
    }

    const knownTables = context.tables || [];
    const knownRefs = context.inlineReferencedTables || [];
    const cteNames = collectInlineCteNames(prefix);

    return insertedTableRefs.every((ref) => {
        const refLastPart = getInlineIdentifierLastPart(ref.tableName).toLowerCase();
        if (refLastPart && cteNames.has(refLastPart)) {
            return true;
        }
        return knownTables.some((table) => tableMatchesInlineReference(table, ref))
            || knownRefs.some((knownRef) => tableMatchesInlineReference(
                { dbName: knownRef.dbName, tableName: knownRef.tableName },
                ref,
            ));
    });
};

const getCurrentStatementPrefix = (prefix: string): string => {
    const text = String(prefix || '');
    const semicolonIndex = text.lastIndexOf(';');
    return semicolonIndex >= 0 ? text.slice(semicolonIndex + 1) : text;
};

const hasUnclosedBlockComment = (text: string): boolean =>
    String(text || '').lastIndexOf('/*') > String(text || '').lastIndexOf('*/');

const hasUnclosedSqlString = (text: string): boolean => {
    let singleOpen = false;
    let doubleOpen = false;
    let backtickOpen = false;
    const value = String(text || '');
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        const next = value[index + 1];
        if (char === "'" && !doubleOpen && !backtickOpen) {
            if (next === "'") {
                index += 1;
            } else {
                singleOpen = !singleOpen;
            }
        } else if (char === '"' && !singleOpen && !backtickOpen) {
            doubleOpen = !doubleOpen;
        } else if (char === '`' && !singleOpen && !doubleOpen) {
            backtickOpen = !backtickOpen;
        }
    }
    return singleOpen || doubleOpen || backtickOpen;
};

const findCaseInsensitiveOverlap = (prefix: string, completion: string): number => {
    const left = String(prefix || '');
    const right = String(completion || '');
    const max = Math.min(left.length, right.length);
    const leftLower = left.toLowerCase();
    const rightLower = right.toLowerCase();
    for (let length = max; length > 0; length -= 1) {
        if (leftLower.slice(left.length - length) === rightLower.slice(0, length)) {
            return length;
        }
    }
    return 0;
};

const truncateHead = (text: string, limit: number): string => {
    const value = String(text || '');
    if (value.length <= limit) return value;
    return value.slice(value.length - limit);
};

const truncateTail = (text: string, limit: number): string => {
    const value = String(text || '');
    if (value.length <= limit) return value;
    return value.slice(0, limit);
};

const limitInlineInsertText = (text: string): string => {
    const value = String(text || '').trimEnd();
    if (value.length <= MAX_INLINE_INSERT_CHARS) {
        return value;
    }
    const truncated = value.slice(0, MAX_INLINE_INSERT_CHARS);
    const lastStatementEnd = Math.max(truncated.lastIndexOf(';'), truncated.lastIndexOf('\n'));
    return (lastStatementEnd > 80 ? truncated.slice(0, lastStatementEnd + 1) : truncated).trimEnd();
};
