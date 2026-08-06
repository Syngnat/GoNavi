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
    resolveQueryEditorInlineCompletionModel,
    resolveQueryEditorInlineCompletionIntentDetails,
    sanitizeSqlAssistantResponse,
    sanitizeElasticsearchConsoleAssistantResponse,
    shouldAllowQueryEditorInlineMemoryCompletion,
    shouldTriggerQueryEditorInlineObjectSuggestFallback,
    shouldRequestQueryEditorInlineCompletion,
    type QueryEditorAiService,
} from './QueryEditorAiAssist';

const readyService = (content = 'SELECT * FROM users;'): QueryEditorAiService => ({
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
    AIChatSend: vi.fn(async () => ({ success: true, content })),
});

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
        expect(service.AIChatSend).toHaveBeenCalledTimes(1);
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

        expect(service.AIChatSend).not.toHaveBeenCalled();
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
        expect(inlineJoined).toContain('- current_statement_tables: shop.videos AS v');
        expect(inlineJoined).toContain('- inline_completion_intent: column_name');
        expect(inlineJoined).toContain('- inline_completion_qualifier: v');
        expect(inlineJoined).toContain('shop.videos -- media table; columns: code varchar');
        expect(inlineJoined).not.toContain('shop.orders -- sales orders');
        expect(inlineJoined).toContain('<prefix_before_cursor>');

        const textToSqlMessages = buildQueryEditorTextToSqlMessages({
            aiContext,
            editorSnapshot: {
                prefix: '',
                suffix: '',
                currentLineBeforeCursor: '',
                currentLineAfterCursor: '',
            },
            instruction: 'total order amount by day',
            userPromptSettings,
        });
        expect(textToSqlMessages.map((message) => message.content).join('\n')).toContain('total order amount by day');
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
                prefix: 'select * from users ',
                suffix: '',
                currentLineBeforeCursor: 'select * from users ',
                currentLineAfterCursor: '',
            },
        });
        expect(insertText).toBe('where id > 1;');
        expect(service.AIChatSend).toHaveBeenCalledTimes(1);

        const missingProvider = await resolveQueryEditorAiRuntimeReadiness({
            AIChatSend: vi.fn(),
            AIGetProviders: vi.fn(async () => []),
            AIGetActiveProvider: vi.fn(async () => ''),
        });
        expect(missingProvider.ready).toBe(false);
        expect(missingProvider.reason).toBe('provider_missing');
    });

    it('caches unavailable inline AI readiness across adjacent automatic requests', async () => {
        const service: QueryEditorAiService = {
            AIChatSend: vi.fn(),
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
                prefix: 'select * from users ',
                suffix: '',
                currentLineBeforeCursor: 'select * from users ',
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
        expect(service.AIChatSend).not.toHaveBeenCalled();
        expect(service.AIGetProviders).not.toHaveBeenCalled();
        expect(service.AIGetActiveProvider).not.toHaveBeenCalled();
    });

    it('inherits the typed fragment case for deterministic table-name completion', async () => {
        const service = readyService('TABLE');
        const buildRequest = (fragment: string) => ({
            service,
            aiContext: {
                connectionName: 'Local Dameng',
                sourceType: 'dameng',
                currentDb: 'APP',
                tables: [{ dbName: 'APP', tableName: 'TABLE' }],
                columns: [],
            },
            editorSnapshot: {
                prefix: `SELECT * FROM ${fragment}`,
                suffix: '',
                currentLineBeforeCursor: `SELECT * FROM ${fragment}`,
                currentLineAfterCursor: '',
            },
        });

        await expect(requestQueryEditorInlineCompletion(buildRequest('ta'))).resolves.toBe('ble');
        await expect(requestQueryEditorInlineCompletion(buildRequest('TA'))).resolves.toBe('BLE');
        expect(service.AIChatSend).not.toHaveBeenCalled();
    });

    it('inherits the typed fragment case for deterministic column-name completion', async () => {
        const service = readyService('SHORT_TITLE');

        const insertText = await requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local Dameng',
                sourceType: 'dameng',
                currentDb: 'APP',
                tables: [{ dbName: 'APP', tableName: 'VIDEOS' }],
                columns: [{ dbName: 'APP', tableName: 'VIDEOS', name: 'SHORT_TITLE', type: 'varchar' }],
            },
            editorSnapshot: {
                prefix: 'SELECT v.sh FROM VIDEOS v WHERE v.sh',
                suffix: '',
                currentLineBeforeCursor: 'SELECT v.sh FROM VIDEOS v WHERE v.sh',
                currentLineAfterCursor: '',
            },
        });

        expect(insertText).toBe('ort_title');
        expect(service.AIChatSend).not.toHaveBeenCalled();
    });

    it('uses deterministic schema metadata for alter-table inline completion and skips AI', async () => {
        const service = readyService('ALTER TABLE orders ADD COLUMN status INT;');

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
                prefix: 'ALTER TABLE ord',
                suffix: '',
                currentLineBeforeCursor: 'ALTER TABLE ord',
                currentLineAfterCursor: '',
            },
        });

        expect(insertText).toBe('ers');
        expect(service.AIChatSend).not.toHaveBeenCalled();
    });

    it('uses grounded AI for ambiguous table-name inline completion when the suggestion matches schema metadata', async () => {
        const service = readyService('videos');

        const insertText = await requestQueryEditorInlineCompletion({
            service,
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
                prefix: 'SELECT * FROM vi',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM vi',
                currentLineAfterCursor: '',
            },
        });

        expect(insertText).toBe('deos');
        expect(service.AIChatSend).toHaveBeenCalledTimes(1);
    });

    it('inherits the typed fragment case for grounded AI table-name completion', async () => {
        const service = readyService('TABLE');

        const insertText = await requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local Dameng',
                sourceType: 'dameng',
                currentDb: 'APP',
                tables: [
                    { dbName: 'APP', tableName: 'TABLE' },
                    { dbName: 'APP', tableName: 'TARGET' },
                ],
                columns: [],
            },
            editorSnapshot: {
                prefix: 'SELECT * FROM ta',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM ta',
                currentLineAfterCursor: '',
            },
        });

        expect(insertText).toBe('ble');
        expect(service.AIChatSend).toHaveBeenCalledTimes(1);
    });

    it('rejects ungrounded AI table-name inline completion when the suggestion is outside schema metadata', async () => {
        const service = readyService('Japgolly');

        const insertText = await requestQueryEditorInlineCompletion({
            service,
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
                prefix: 'SELECT * FROM \\',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM \\',
                currentLineAfterCursor: '',
            },
        });

        expect(insertText).toBe('');
        expect(service.AIChatSend).toHaveBeenCalledTimes(1);
    });

    it('uses deterministic schema metadata for alias column inline completion and skips AI', async () => {
        const service = readyService('SELECT * FROM videos;');

        const insertText = await requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'videos' }],
                columns: [
                    { dbName: 'shop', tableName: 'videos', name: 'code', type: 'varchar' },
                    { dbName: 'shop', tableName: 'videos', name: 'created_at', type: 'datetime' },
                ],
            },
            editorSnapshot: {
                prefix: 'SELECT v.co FROM videos v WHERE v.co',
                suffix: '',
                currentLineBeforeCursor: 'SELECT v.co FROM videos v WHERE v.co',
                currentLineAfterCursor: '',
            },
        });

        expect(insertText).toBe('de');
        expect(service.AIChatSend).not.toHaveBeenCalled();
    });

    it('uses grounded AI for ambiguous column-name inline completion when the suggestion matches table metadata', async () => {
        const service = readyService('code');

        const insertText = await requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'videos' }],
                columns: [
                    { dbName: 'shop', tableName: 'videos', name: 'code', type: 'varchar' },
                    { dbName: 'shop', tableName: 'videos', name: 'created_at', type: 'datetime' },
                ],
            },
            editorSnapshot: {
                prefix: 'SELECT * FROM videos v WHERE v.c',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM videos v WHERE v.c',
                currentLineAfterCursor: '',
            },
        });

        expect(insertText).toBe('ode');
        expect(service.AIChatSend).toHaveBeenCalledTimes(1);
    });

    it('rejects ungrounded AI column-name inline completion when the suggestion is outside table metadata', async () => {
        const service = readyService('checksum');

        const insertText = await requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'videos' }],
                columns: [
                    { dbName: 'shop', tableName: 'videos', name: 'code', type: 'varchar' },
                    { dbName: 'shop', tableName: 'videos', name: 'created_at', type: 'datetime' },
                ],
            },
            editorSnapshot: {
                prefix: 'SELECT * FROM videos v WHERE v.c',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM videos v WHERE v.c',
                currentLineAfterCursor: '',
            },
        });

        expect(insertText).toBe('');
        expect(service.AIChatSend).toHaveBeenCalledTimes(1);
    });

    it('uses the dedicated inline completion model when configured', async () => {
        const service = {
            ...readyService('select * from users;'),
            AIGetProviders: vi.fn(async () => [{
                id: 'openai-main',
                type: 'openai' as const,
                name: 'OpenAI',
                apiKey: '',
                hasSecret: true,
                baseUrl: 'https://api.openai.com/v1',
                model: 'gpt-5',
                inlineCompletionModel: 'gpt-5-mini',
                maxTokens: 2048,
                temperature: 0.2,
            }]),
            AIChatSendWithOptions: vi.fn(async () => ({ success: true, content: 'select * from users where id = 1;' })),
        };

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
                prefix: 'select * from users ',
                suffix: '',
                currentLineBeforeCursor: 'select * from users ',
                currentLineAfterCursor: '',
            },
        });

        expect(resolveQueryEditorInlineCompletionModel((await service.AIGetProviders())[0])).toBe('gpt-5-mini');
        expect(insertText).toBe('where id = 1;');
        expect(service.AIChatSend).not.toHaveBeenCalled();
        expect(service.AIChatSendWithOptions).toHaveBeenCalledWith(expect.any(Array), [], {
            model: 'gpt-5-mini',
            maxTokens: 192,
            temperature: 0.1,
        });
    });

    it('falls back to the chat model for inline completion when no dedicated model is configured', async () => {
        const service = {
            ...readyService('select * from users;'),
            AIChatSendWithOptions: vi.fn(async () => ({ success: true, content: 'select * from users where id = 1;' })),
        };

        await requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'users' }],
                columns: [{ dbName: 'shop', tableName: 'users', name: 'id', type: 'bigint' }],
            },
            editorSnapshot: {
                prefix: 'select * from users ',
                suffix: '',
                currentLineBeforeCursor: 'select * from users ',
                currentLineAfterCursor: '',
            },
        });

        expect(service.AIChatSendWithOptions).toHaveBeenCalledWith(expect.any(Array), [], expect.objectContaining({
            model: 'gpt-5',
        }));
    });

    it('uses reasoning content as a fallback for inline completion responses', async () => {
        const service = {
            ...readyService(''),
            AIChatSend: vi.fn(async () => ({
                success: true,
                content: '',
                reasoning_content: 'SELECT * FROM videos WHERE code IS NOT NULL;',
            })),
        };

        const insertText = await requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'videos' }],
                columns: [{ dbName: 'shop', tableName: 'videos', name: 'code', type: 'varchar' }],
            },
            editorSnapshot: {
                prefix: 'select * from videos ',
                suffix: '',
                currentLineBeforeCursor: 'select * from videos ',
                currentLineAfterCursor: '',
            },
        });

        expect(insertText).toBe('WHERE code IS NOT NULL;');
    });

    it('drops inline completions that introduce tables outside the selected database context', async () => {
        const service = {
            ...readyService('select * from orders where id = 1;'),
            AIChatSendWithOptions: vi.fn(async () => ({ success: true, content: 'select * from orders where id = 1;' })),
        };

        const insertText = await requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'videos' }],
                columns: [{ dbName: 'shop', tableName: 'videos', name: 'code', type: 'varchar' }],
            },
            editorSnapshot: {
                prefix: 'select * from videos ',
                suffix: '',
                currentLineBeforeCursor: 'select * from videos ',
                currentLineAfterCursor: '',
            },
        });

        expect(insertText).toBe('');
    });
});
