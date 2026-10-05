import type { AIUserPromptSettings } from '../../types';
import type { CompletionColumnMeta } from './QueryEditorHelpers';
import {
    type QueryEditorAiContext,
    type QueryEditorAiEditorSnapshot,
    type QueryEditorAiMessage,
    INLINE_PREFIX_LIMIT,
    INLINE_SUFFIX_LIMIT,
    TEXT_TO_SQL_PREFIX_LIMIT,
    TEXT_TO_SQL_SUFFIX_LIMIT,
    SQL_CODE_FENCE_RE,
    MAX_INLINE_GHOST_PREVIEW_CHARS,
    MAX_SCHEMA_COLUMNS_PER_TABLE,
    MAX_SCHEMA_TABLES,
    MAX_SCHEMA_SNAPSHOT_CHARS,
} from './queryEditorAiAssistTypes';
import { truncateHead, truncateTail, getCurrentStatementPrefix } from './queryEditorAiInlineText';
import {
    resolveQueryEditorInlineCompletionIntentDetails,
    collectInlineTableReferences,
    collectReferencedSchemaTables,
    filterColumnsForTables,
    collectCurrentDatabaseTables,
    schemaItemKey,
} from './queryEditorAiInlineReferences';
import {
    resolveInlineColumnOwnerReference,
    filterInlineTableMatches,
} from './queryEditorAiInlineCandidates';

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
                'Respect the selected database connection, host, database, dialect, reported database_version, and schema hints.',
                'Use only SQL syntax and functions supported by that database version. If database_version is unknown, use a conservative baseline for the dialect.',
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
            'Respect the database dialect, reported database_version, current database, schema hints, and existing editor context.',
            'Use only SQL syntax and functions supported by that database version. If database_version is unknown, use a conservative baseline for the dialect.',
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
    const sqlDialect = String(context.sqlDialect || '').trim();
    const databaseVersion = String(context.databaseVersion || '').trim();
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
        sqlDialect ? `- sql_dialect: ${sqlDialect}` : '',
        `- connection: ${connectionName}`,
        hostLabel ? `- host: ${hostLabel}` : '',
        `- current_database: ${currentDb}`,
        databaseVersion ? `- database_version: ${databaseVersion}` : '- database_version: unknown',
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
    const dialect = context.sqlDialect || context.sourceType || '';
    const statementPrefix = getCurrentStatementPrefix(editorSnapshot.prefix, dialect);
    const intent = resolveQueryEditorInlineCompletionIntentDetails(editorSnapshot, dialect);
    const referencedTables = collectInlineTableReferences(statementPrefix, currentDb, context.visibleDbs || [], dialect);

    let nextContext: QueryEditorAiContext;
    if (context.inlineSchemaScope) {
        nextContext = {
            ...context,
            inlineReferencedTables: context.inlineReferencedTables || referencedTables,
        };
    } else if (referencedTables.length > 0) {
        const tables = collectReferencedSchemaTables(context.tables || [], referencedTables, dialect);
        nextContext = {
            ...context,
            tables,
            columns: filterColumnsForTables(context.columns || [], tables, referencedTables, dialect),
            inlineSchemaScope: 'referenced_tables',
            inlineReferencedTables: referencedTables,
        };
    } else {
        const currentDbTables = collectCurrentDatabaseTables(context.tables || [], currentDb, dialect);
        nextContext = {
            ...context,
            tables: currentDbTables,
            columns: filterColumnsForTables(context.columns || [], currentDbTables, [], dialect),
            inlineSchemaScope: 'current_database',
            inlineReferencedTables: [],
        };
    }

    if (intent.intent === 'column_name') {
        const ownerRef = resolveInlineColumnOwnerReference(context, editorSnapshot, intent.qualifier);
        if (ownerRef) {
            const ownerTables = collectReferencedSchemaTables(context.tables || [], [ownerRef], dialect);
            return {
                ...nextContext,
                tables: ownerTables,
                columns: filterColumnsForTables(context.columns || [], ownerTables, [ownerRef], dialect),
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
            tables: filterInlineTableMatches(context.tables || [], currentDb, intent.fragment, dialect),
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
    const dialect = context.sqlDialect || context.sourceType || '';
    const currentDb = String(context.currentDb || '').trim().toLowerCase();
    const columnsByTable = new Map<string, CompletionColumnMeta[]>();
    (context.columns || []).forEach((column) => {
        const key = schemaItemKey(column.dbName, column.tableName, dialect);
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
        const columns = columnsByTable.get(schemaItemKey(dbName, tableName, dialect)) || [];
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
