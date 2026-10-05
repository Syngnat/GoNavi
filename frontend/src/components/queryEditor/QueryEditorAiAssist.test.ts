import { describe, expect, it, vi } from 'vitest';
import {
    buildQueryEditorAiInlineSuggestOptions,
    buildQueryEditorInlineCompletionMessages,
    buildQueryEditorInlineCompletionContext,
    buildQueryEditorTextToElasticsearchMessages,
    buildQueryEditorTextToSqlMessages,
    requestQueryEditorTextToElasticsearch,
    requestQueryEditorInlineCompletion,
    resolveInlineSqlGhostPreviewText,
    resolveInlineSqlInsertText,
    resolveQueryEditorAiRuntimeReadiness,
    resolveQueryEditorInlineMemoryInsertText,
    resolveQueryEditorInlineCompletionEdit,
    resolveQueryEditorInlineCompletionIntentDetails,
    sanitizeSqlAssistantResponse,
    sanitizeElasticsearchConsoleAssistantResponse,
    shouldAllowQueryEditorInlineMemoryCompletion,
    shouldTriggerQueryEditorInlineObjectSuggestFallback,
    shouldRequestQueryEditorInlineCompletion,
    serializeQueryEditorAgentPrompt,
    type QueryEditorAiService,
} from './QueryEditorAiAssist';

const queryEditorRunEvents = (content: string, runId = 'query-editor-run') => [
    {
        schemaVersion: 1,
        runId,
        sessionId: 'query-editor-session',
        sessionGeneration: 1,
        sequence: 1,
        runRevision: 1,
        attempt: 1,
        timestamp: 1,
        kind: 'model_completed',
        resultingState: 'running_model',
        payload: { text: content },
    },
    {
        schemaVersion: 1,
        runId,
        sessionId: 'query-editor-session',
        sessionGeneration: 1,
        sequence: 2,
        runRevision: 2,
        attempt: 1,
        timestamp: 2,
        kind: 'terminal',
        resultingState: 'completed',
        payload: { reason: 'completed' },
    },
];

const readyService = (content = 'SELECT * FROM users;'): QueryEditorAiService => {
    const runId = 'query-editor-run';
    return {
        AIGetProviders: vi.fn(async () => [{
            id: 'openai-main',
            type: 'openai' as const,
            name: 'OpenAI',
            apiKey: '',
            hasSecret: true,
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-5',
            maxTokens: 2048,
            temperature: 0.2,
        }]),
        AIGetActiveProvider: vi.fn(async () => 'openai-main'),
        AIGetUserPromptSettings: vi.fn(async () => ({
            global: 'Keep answers deterministic.',
            database: 'Prefer readonly SQL.',
        })),
        AISubmitAgentInput: vi.fn(async (request: { requestId: string }) => ({
            requestId: request.requestId,
            sessionId: 'query-editor-session',
            runId,
            disposition: 'started',
            revision: 1,
            state: 'running_model',
        })),
        AIReadAgentRun: vi.fn(async (request: { afterSequence?: number }) => ({
            run: { id: runId, state: 'completed' },
            events: queryEditorRunEvents(content, runId).filter((event) => event.sequence > Number(request.afterSequence || 0)),
            hasMore: false,
        })),
    };
};

describe('QueryEditorAiAssist', () => {
    it('builds a read-first Elasticsearch console prompt with version and mapping context', () => {
        const messages = buildQueryEditorTextToElasticsearchMessages({
            aiContext: {
                sourceType: 'elasticsearch',
                currentDb: 'orders-v1',
                elasticsearchVersion: '8',
                elasticsearchMapping: '{"properties":{"status":{"type":"keyword"}}}',
            },
            editorSnapshot: {
                prefix: 'GET /orders-v1/_search\n',
                suffix: '',
                currentLineBeforeCursor: '',
                currentLineAfterCursor: '',
            },
            instruction: '查询 status 为 paid 的文档',
            userPromptSettings: { global: '', database: '', jvm: '', jvmDiagnostic: '' },
        });

        expect(messages[0]?.content).toContain('read-only');
        expect(messages[0]?.content).toContain('METHOD /path');
        expect(messages[messages.length - 1]?.content).toContain('Elasticsearch major version: 8');
        expect(messages[messages.length - 1]?.content).toContain('"status"');
    });

    it('sanitizes Elasticsearch console output and rejects URLs or credential headers', () => {
        expect(sanitizeElasticsearchConsoleAssistantResponse(
            '```http\nGET /orders/_search\n{"query":{"match_all":{}}}\n```',
        )).toBe('GET /orders/_search\n{"query":{"match_all":{}}}');
        expect(sanitizeElasticsearchConsoleAssistantResponse(
            'GET https://example.test/orders/_search',
        )).toBe('');
        expect(sanitizeElasticsearchConsoleAssistantResponse(
            'GET /orders/_search\nAuthorization: ApiKey secret',
        )).toBe('');
    });

    it('requests Elasticsearch console text without executing it', async () => {
        const service = readyService('POST /orders/_search\n{"query":{"term":{"status":"paid"}}}');
        const result = await requestQueryEditorTextToElasticsearch({
            service,
            aiContext: { sourceType: 'elasticsearch', currentDb: 'orders' },
            editorSnapshot: {
                prefix: '',
                suffix: '',
                currentLineBeforeCursor: '',
                currentLineAfterCursor: '',
            },
            instruction: '查询 paid 订单',
        });

        expect(result.source).toContain('POST /orders/_search');
        expect(service.AISubmitAgentInput).toHaveBeenCalledTimes(1);
        expect(service.AISubmitAgentInput).toHaveBeenCalledWith(expect.objectContaining({
            taskKind: 'query_editor_generation',
            allowTools: false,
            dispatchMode: 'queue',
            contextSourceId: 'desktop',
            contextSourceInstanceId: expect.any(String),
            provider: 'openai-main',
            model: 'gpt-5',
        }));
    });

    it('serializes role-ordered query editor prompts into the single harness content field', () => {
        expect(serializeQueryEditorAgentPrompt([
            { role: 'system', content: 'Return only SQL.' },
            { role: 'user', content: 'Use the current schema.' },
        ])).toContain('<query_editor_message index="1" role="system">\nReturn only SQL.\n</query_editor_message>');
        expect(serializeQueryEditorAgentPrompt([
            { role: 'system', content: 'Return only SQL.' },
            { role: 'user', content: 'Use the current schema.' },
        ])).toContain('<query_editor_message index="2" role="user">\nUse the current schema.\n</query_editor_message>');
    });

    it('keeps AI inline suggestions visible when normal SQL suggestions are open', () => {
        expect(buildQueryEditorAiInlineSuggestOptions()).toMatchObject({
            enabled: true,
            mode: 'prefix',
            suppressSuggestions: true,
            experimental: {
                showOnSuggestConflict: 'always',
            },
        });
    });

    it('only requests inline completion in editable SQL context', () => {
        expect(shouldRequestQueryEditorInlineCompletion({
            prefix: 'select',
            suffix: '',
            currentLineBeforeCursor: 'select',
            currentLineAfterCursor: '',
        })).toBe(true);

        expect(shouldRequestQueryEditorInlineCompletion({
            prefix: '-- select',
            suffix: '',
            currentLineBeforeCursor: '-- select',
            currentLineAfterCursor: '',
        })).toBe(false);

        expect(shouldRequestQueryEditorInlineCompletion({
            prefix: "select 'abc",
            suffix: '',
            currentLineBeforeCursor: "select 'abc",
            currentLineAfterCursor: '',
        })).toBe(false);

        expect(shouldRequestQueryEditorInlineCompletion({
            prefix: 'select',
            suffix: ' from users',
            currentLineBeforeCursor: 'select',
            currentLineAfterCursor: ' from users',
        })).toBe(false);
    });

    it('allows inline memory completion in empty or prefix-only editable SQL context', () => {
        expect(shouldAllowQueryEditorInlineMemoryCompletion({
            prefix: '',
            suffix: '',
            currentLineBeforeCursor: '',
            currentLineAfterCursor: '',
        })).toBe(true);

        expect(resolveQueryEditorInlineMemoryInsertText({
            editorSnapshot: {
                prefix: '',
                suffix: '',
                currentLineBeforeCursor: '',
                currentLineAfterCursor: '',
            },
            memoryEntries: [
                { sql: 'SELECT * FROM videos WHERE code = ?;' },
                { sql: 'UPDATE videos SET status = 1 WHERE id = ?;' },
            ],
        })).toBe('SELECT * FROM videos WHERE code = ?;');

        expect(resolveQueryEditorInlineMemoryInsertText({
            editorSnapshot: {
                prefix: 'UPDATE',
                suffix: '',
                currentLineBeforeCursor: 'UPDATE',
                currentLineAfterCursor: '',
            },
            memoryEntries: [
                { sql: 'SELECT * FROM videos WHERE code = ?;' },
                { sql: 'UPDATE videos SET status = 1 WHERE id = ?;' },
            ],
        })).toBe(' videos SET status = 1 WHERE id = ?;');
    });

    it('inherits the typed table fragment case without changing the remaining remembered SQL', () => {
        expect(resolveQueryEditorInlineMemoryInsertText({
            editorSnapshot: {
                prefix: 'SELECT * FROM A_C',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM A_C',
                currentLineAfterCursor: '',
            },
            memoryEntries: [
                { sql: "SELECT * FROM a_cninfo_announcement where short_title like 'about%'" },
            ],
        })).toBe("ninfo_announcement where short_title like 'about%'");

        expect(resolveQueryEditorInlineMemoryInsertText({
            editorSnapshot: {
                prefix: 'SELECT * FROM a_c',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM a_c',
                currentLineAfterCursor: '',
            },
            memoryEntries: [
                { sql: 'SELECT * FROM A_CNINFO_ANNOUNCEMENT WHERE SHORT_TITLE IS NOT NULL' },
            ],
        })).toBe('ninfo_announcement WHERE SHORT_TITLE IS NOT NULL');
    });

    it('uses the metadata identifier when accepting case-mismatched table completion', () => {
        const aiContext = {
            sourceType: 'mysql',
            currentDb: 'main',
            tables: [{ dbName: 'main', tableName: 'a_cninfo_announcement' }],
            columns: [],
        };

        expect(resolveQueryEditorInlineCompletionEdit({
            aiContext,
            editorSnapshot: {
                prefix: 'SELECT * FROM A_C',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM A_C',
                currentLineAfterCursor: '',
            },
            insertText: "ninfo_announcement where short_title like 'about%'",
        })).toEqual({
            previewText: "ninfo_announcement where short_title like 'about%'",
            editText: "a_cninfo_announcement where short_title like 'about%'",
            replacePrefixLength: 3,
        });

        expect(resolveQueryEditorInlineCompletionEdit({
            aiContext: {
                ...aiContext,
                tables: [{ dbName: 'main', tableName: 'TABLE' }],
            },
            editorSnapshot: {
                prefix: 'SELECT * FROM ta',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM ta',
                currentLineAfterCursor: '',
            },
            insertText: 'ble where id = 1',
        })).toEqual({
            previewText: 'ble where id = 1',
            editText: 'table where id = 1',
            replacePrefixLength: 2,
        });

        expect(resolveQueryEditorInlineCompletionEdit({
            aiContext: {
                ...aiContext,
                currentDb: 'main',
                tables: [{ dbName: 'analytics', tableName: 'a_cninfo_announcement' }],
            },
            editorSnapshot: {
                prefix: 'SELECT * FROM analytics.A_C',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM analytics.A_C',
                currentLineAfterCursor: '',
            },
            insertText: 'ninfo_announcement',
        })).toEqual({
            previewText: 'ninfo_announcement',
            editText: 'analytics.a_cninfo_announcement',
            replacePrefixLength: 'analytics.A_C'.length,
        });
    });

    it('preserves exact-case inline identifiers for PostgreSQL-family dialects', () => {
        const postgresContext = {
            sourceType: 'postgres',
            currentDb: 'main',
            tables: [{ dbName: 'main', tableName: 'TABLE' }],
            columns: [],
        };

        expect(resolveQueryEditorInlineCompletionEdit({
            aiContext: postgresContext,
            editorSnapshot: {
                prefix: 'SELECT * FROM ta',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM ta',
                currentLineAfterCursor: '',
            },
            insertText: 'ble',
        })).toEqual({
            previewText: 'BLE',
            editText: 'TABLE',
            replacePrefixLength: 2,
        });
    });

    it('sanitizes fenced SQL and removes duplicated typed prefixes', () => {
        expect(sanitizeSqlAssistantResponse('```sql\nselect * from users;\n```')).toBe('select * from users;');
        expect(sanitizeSqlAssistantResponse('SQL: select count(*) from orders;')).toBe('select count(*) from orders;');

        expect(resolveInlineSqlInsertText('SELECT * FROM users;', 'select')).toBe(' * FROM users;');
        expect(resolveInlineSqlInsertText('from users;', 'select ')).toBe('from users;');
        expect(resolveInlineSqlInsertText('orders', 'select * from')).toBe(' orders');

        expect(resolveInlineSqlGhostPreviewText(' * FROM users\nWHERE id = 1;')).toBe(' * FROM users WHERE id = 1;');
    });

    it('treats stray non-identifier markers in object-name positions as an empty fragment', () => {
        expect(resolveQueryEditorInlineCompletionIntentDetails({
            prefix: 'SELECT * FROM \\',
            suffix: '',
            currentLineBeforeCursor: 'SELECT * FROM \\',
            currentLineAfterCursor: '',
        })).toEqual({
            intent: 'table_name',
            fragment: '',
            qualifier: '',
        });

        expect(resolveQueryEditorInlineCompletionIntentDetails({
            prefix: 'SELECT * FROM videos v WHERE v.\\',
            suffix: '',
            currentLineBeforeCursor: 'SELECT * FROM videos v WHERE v.\\',
            currentLineAfterCursor: '',
        })).toEqual({
            intent: 'column_name',
            fragment: '',
            qualifier: 'v',
        });

        expect(resolveQueryEditorInlineCompletionIntentDetails({
            prefix: 'ALTER TABLE \\',
            suffix: '',
            currentLineBeforeCursor: 'ALTER TABLE \\',
            currentLineAfterCursor: '',
        })).toEqual({
            intent: 'table_name',
            fragment: '',
            qualifier: '',
        });
    });

    it('only keeps object-name suggest fallback for unresolved inline object positions', () => {
        expect(shouldTriggerQueryEditorInlineObjectSuggestFallback({
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [
                    { dbName: 'shop', tableName: 'videos' },
                    { dbName: 'shop', tableName: 'visits' },
                ],
                columns: [],
            },
            editorSnapshot: {
                prefix: 'SELECT * FROM ',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM ',
                currentLineAfterCursor: '',
            },
        })).toBe(true);

        expect(shouldTriggerQueryEditorInlineObjectSuggestFallback({
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [
                    { dbName: 'shop', tableName: 'videos' },
                    { dbName: 'shop', tableName: 'visits' },
                ],
                columns: [],
            },
            editorSnapshot: {
                prefix: 'SELECT * FROM videos',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM videos',
                currentLineAfterCursor: '',
            },
        })).toBe(false);
    });

    it('uses deterministic SQL skeletons for weak keyword-only contexts and skips AI', async () => {
        const service = readyService('select * from users;');

        await expect(requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'users' }],
                columns: [{ dbName: 'shop', tableName: 'users', name: 'id', type: 'bigint' }],
            },
            editorSnapshot: {
                prefix: 'SELECT',
                suffix: '',
                currentLineBeforeCursor: 'SELECT',
                currentLineAfterCursor: '',
            },
        })).resolves.toBe(' * FROM ');

        await expect(requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'users' }],
                columns: [{ dbName: 'shop', tableName: 'users', name: 'id', type: 'bigint' }],
            },
            editorSnapshot: {
                prefix: 'DELETE',
                suffix: '',
                currentLineBeforeCursor: 'DELETE',
                currentLineAfterCursor: '',
            },
        })).resolves.toBe(' FROM ');

        await expect(requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'users' }],
                columns: [{ dbName: 'shop', tableName: 'users', name: 'id', type: 'bigint' }],
            },
            editorSnapshot: {
                prefix: 'MERGE',
                suffix: '',
                currentLineBeforeCursor: 'MERGE',
                currentLineAfterCursor: '',
            },
        })).resolves.toBe(' INTO ');

        await expect(requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'users' }],
                columns: [{ dbName: 'shop', tableName: 'users', name: 'id', type: 'bigint' }],
            },
            editorSnapshot: {
                prefix: 'REPLACE',
                suffix: '',
                currentLineBeforeCursor: 'REPLACE',
                currentLineAfterCursor: '',
            },
        })).resolves.toBe(' INTO ');

        await expect(requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'users' }],
                columns: [{ dbName: 'shop', tableName: 'users', name: 'id', type: 'bigint' }],
            },
            editorSnapshot: {
                prefix: 'ALTER',
                suffix: '',
                currentLineBeforeCursor: 'ALTER',
                currentLineAfterCursor: '',
            },
        })).resolves.toBe(' TABLE ');

        await expect(requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'users' }],
                columns: [{ dbName: 'shop', tableName: 'users', name: 'id', type: 'bigint' }],
            },
            editorSnapshot: {
                prefix: 'CREATE',
                suffix: '',
                currentLineBeforeCursor: 'CREATE',
                currentLineAfterCursor: '',
            },
        })).resolves.toBe(' TABLE ');

        await expect(requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'users' }],
                columns: [{ dbName: 'shop', tableName: 'users', name: 'id', type: 'bigint' }],
            },
            editorSnapshot: {
                prefix: 'DROP',
                suffix: '',
                currentLineBeforeCursor: 'DROP',
                currentLineAfterCursor: '',
            },
        })).resolves.toBe(' TABLE ');

        await expect(requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'users' }],
                columns: [{ dbName: 'shop', tableName: 'users', name: 'id', type: 'bigint' }],
            },
            editorSnapshot: {
                prefix: 'TRUNCATE',
                suffix: '',
                currentLineBeforeCursor: 'TRUNCATE',
                currentLineAfterCursor: '',
            },
        })).resolves.toBe(' TABLE ');

        expect(service.AISubmitAgentInput).not.toHaveBeenCalled();
    });

    it('builds inline and text-to-sql prompts with custom instructions and schema hints', () => {
        const aiContext = {
            connectionName: 'Local MySQL',
            host: '127.0.0.1',
            port: 3306,
            sourceType: 'mysql',
            currentDb: 'shop',
            visibleDbs: ['shop'],
            tables: [
                { dbName: 'shop', tableName: 'orders', comment: 'sales orders' },
                { dbName: 'shop', tableName: 'videos', comment: 'media table' },
            ],
            columns: [
                { dbName: 'shop', tableName: 'orders', name: 'id', type: 'bigint' },
                { dbName: 'shop', tableName: 'orders', name: 'amount', type: 'decimal' },
                { dbName: 'shop', tableName: 'videos', name: 'code', type: 'varchar' },
            ],
        };
        const userPromptSettings = {
            global: 'Always use explicit column names.',
            database: 'Readonly by default.',
            jvm: '',
            jvmDiagnostic: '',
        };

        const inlineMessages = buildQueryEditorInlineCompletionMessages({
            aiContext,
            editorSnapshot: {
                prefix: 'select * from videos v where v.',
                suffix: '',
                currentLineBeforeCursor: 'select * from videos v where v.',
                currentLineAfterCursor: '',
            },
            userPromptSettings,
        });
        const inlineJoined = inlineMessages.map((message) => message.content).join('\n');
        expect(inlineJoined).toContain('Always use explicit column names.');
        expect(inlineJoined).toContain('- host: 127.0.0.1:3306');
        expect(inlineJoined).toContain('- database_version: unknown');
        expect(inlineJoined).toContain('Use only SQL syntax and functions supported by that database version.');
        expect(inlineJoined).toContain('- current_statement_tables: shop.videos AS v');
        expect(inlineJoined).toContain('- inline_completion_intent: column_name');
        expect(inlineJoined).toContain('- inline_completion_qualifier: v');
        expect(inlineJoined).toContain('shop.videos -- media table; columns: code varchar');
        expect(inlineJoined).not.toContain('shop.orders -- sales orders');
        expect(inlineJoined).toContain('<prefix_before_cursor>');

        const textToSqlMessages = buildQueryEditorTextToSqlMessages({
            aiContext: {
                ...aiContext,
                databaseVersion: '5.7.44-log',
            },
            editorSnapshot: {
                prefix: '',
                suffix: '',
                currentLineBeforeCursor: '',
                currentLineAfterCursor: '',
            },
            instruction: 'total order amount by day',
            userPromptSettings,
        });
        const textToSqlJoined = textToSqlMessages.map((message) => message.content).join('\n');
        expect(textToSqlJoined).toContain('total order amount by day');
        expect(textToSqlJoined).toContain('- database_version: 5.7.44-log');
        expect(textToSqlJoined).toContain('Use only SQL syntax and functions supported by that database version.');
    });

    it('focuses inline schema hints on referenced tables or the current database', () => {
        const focused = buildQueryEditorInlineCompletionContext({
            connectionName: 'Local MySQL',
            sourceType: 'mysql',
            currentDb: 'shop',
            visibleDbs: ['shop'],
            tables: [
                { dbName: 'shop', tableName: 'orders' },
                { dbName: 'shop', tableName: 'videos' },
                { dbName: 'archive', tableName: 'videos' },
            ],
            columns: [
                { dbName: 'shop', tableName: 'orders', name: 'id', type: 'bigint' },
                { dbName: 'shop', tableName: 'videos', name: 'code', type: 'varchar' },
                { dbName: 'archive', tableName: 'videos', name: 'legacy_code', type: 'varchar' },
            ],
        }, {
            prefix: 'select * from videos v where',
            suffix: '',
            currentLineBeforeCursor: 'select * from videos v where',
            currentLineAfterCursor: '',
        });

        expect(focused.inlineSchemaScope).toBe('referenced_tables');
        expect(focused.inlineReferencedTables).toEqual([{
            dbName: 'shop',
            tableName: 'videos',
            alias: 'v',
            raw: 'videos',
        }]);
        expect(focused.tables).toEqual([{ dbName: 'shop', tableName: 'videos' }]);
        expect(focused.columns).toEqual([{ dbName: 'shop', tableName: 'videos', name: 'code', type: 'varchar' }]);
    });

    it('keeps PostgreSQL quoted table references separate from folded unquoted names', () => {
        const context = {
            sourceType: 'postgres',
            currentDb: 'appdb',
            visibleDbs: ['appdb'],
            tables: [
                { dbName: 'appdb', tableName: 'public.Users' },
                { dbName: 'appdb', tableName: 'public.users' },
            ],
            columns: [
                { dbName: 'appdb', tableName: 'public.Users', name: 'QuotedId', type: 'bigint' },
                { dbName: 'appdb', tableName: 'public.users', name: 'id', type: 'bigint' },
            ],
        };

        const quoted = buildQueryEditorInlineCompletionContext(context, {
            prefix: 'select * from public."Users" u where u.',
            suffix: '',
            currentLineBeforeCursor: 'select * from public."Users" u where u.',
            currentLineAfterCursor: '',
        });
        expect(quoted.tables).toEqual([{ dbName: 'appdb', tableName: 'public.Users' }]);
        expect(quoted.columns).toEqual([
            { dbName: 'appdb', tableName: 'public.Users', name: 'QuotedId', type: 'bigint' },
        ]);

        const unquoted = buildQueryEditorInlineCompletionContext(context, {
            prefix: 'select * from public.users u where u.',
            suffix: '',
            currentLineBeforeCursor: 'select * from public.users u where u.',
            currentLineAfterCursor: '',
        });
        expect(unquoted.tables).toEqual([{ dbName: 'appdb', tableName: 'public.users' }]);
        expect(unquoted.columns).toEqual([
            { dbName: 'appdb', tableName: 'public.users', name: 'id', type: 'bigint' },
        ]);
    });

    it('matches schema-qualified table metadata columns by table name last part', () => {
        const focused = buildQueryEditorInlineCompletionContext({
            connectionName: 'Local Oracle',
            sourceType: 'oracle',
            currentDb: 'APP',
            visibleDbs: ['APP'],
            tables: [
                { dbName: 'APP', tableName: 'SCOTT.ORDERS' },
                { dbName: 'APP', tableName: 'SCOTT.USERS' },
            ],
            columns: [
                { dbName: 'APP', tableName: 'SCOTT.ORDERS', name: 'ORDER_ID', type: 'number' },
                { dbName: 'APP', tableName: 'SCOTT.USERS', name: 'USER_ID', type: 'number' },
            ],
        }, {
            prefix: 'select * from orders o where',
            suffix: '',
            currentLineBeforeCursor: 'select * from orders o where',
            currentLineAfterCursor: '',
        });

        expect(focused.inlineSchemaScope).toBe('referenced_tables');
        expect(focused.tables).toEqual([{ dbName: 'APP', tableName: 'SCOTT.ORDERS' }]);
        expect(focused.columns).toEqual([{ dbName: 'APP', tableName: 'SCOTT.ORDERS', name: 'ORDER_ID', type: 'number' }]);
    });

    it('checks active provider readiness before inline AI requests', async () => {
        const service = readyService('select * from users where id > 1;');
        const readiness = await resolveQueryEditorAiRuntimeReadiness(service);
        expect(readiness.ready).toBe(true);
        expect(readiness.provider?.model).toBe('gpt-5');

        const insertText = await requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'users' }],
                columns: [{ dbName: 'shop', tableName: 'users', name: 'id', type: 'bigint' }],
            },
            editorSnapshot: {
                prefix: 'select * from users where id ',
                suffix: '',
                currentLineBeforeCursor: 'select * from users where id ',
                currentLineAfterCursor: '',
            },
        });
        expect(insertText).toBe('> 1;');
        expect(service.AISubmitAgentInput).toHaveBeenCalledTimes(1);

        const missingProvider = await resolveQueryEditorAiRuntimeReadiness({
            AISubmitAgentInput: vi.fn(),
            AIReadAgentRun: vi.fn(),
            AIGetProviders: vi.fn(async () => []),
            AIGetActiveProvider: vi.fn(async () => ''),
        });
        expect(missingProvider.ready).toBe(false);
        expect(missingProvider.reason).toBe('provider_missing');
    });

    it('caches unavailable inline AI readiness across adjacent automatic requests', async () => {
        const service: QueryEditorAiService = {
            AISubmitAgentInput: vi.fn(),
            AIReadAgentRun: vi.fn(),
            AIGetProviders: vi.fn(async () => []),
            AIGetActiveProvider: vi.fn(async () => ''),
        };
        const request = {
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [],
                columns: [],
            },
            editorSnapshot: {
                prefix: 'select * from users where id ',
                suffix: '',
                currentLineBeforeCursor: 'select * from users where id ',
                currentLineAfterCursor: '',
            },
        };

        await requestQueryEditorInlineCompletion(request);
        await requestQueryEditorInlineCompletion(request);

        expect(service.AIGetProviders).toHaveBeenCalledTimes(1);
        expect(service.AIGetActiveProvider).toHaveBeenCalledTimes(1);
    });

    it('uses deterministic schema metadata for table-name inline completion and skips AI', async () => {
        const service = readyService('SELECT * FROM orders;');

        const insertText = await requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [
                    { dbName: 'shop', tableName: 'videos' },
                    { dbName: 'shop', tableName: 'orders' },
                ],
                columns: [],
            },
            editorSnapshot: {
                prefix: 'SELECT * FROM vid',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM vid',
                currentLineAfterCursor: '',
            },
        });

        expect(insertText).toBe('eos');
        expect(service.AISubmitAgentInput).not.toHaveBeenCalled();
        expect(service.AIGetProviders).not.toHaveBeenCalled();
        expect(service.AIGetActiveProvider).not.toHaveBeenCalled();
    });
});
