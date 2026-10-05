import { describe, expect, it, vi } from 'vitest';
import { setSqlAiCompletionEnabled } from '../../utils/sqlAiCompletionEnabled';
import {
    isQueryEditorInlineTableAliasPending,
    requestQueryEditorInlineCompletion,
    resolveQueryEditorInlineCompletionModel,
    resolveQueryEditorInlineCompletionIntentDetails,
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
    it('suggests an alias after a manually completed table source and skips AI', async () => {
        const service = readyService('SELECT * FROM system_user su;');
        const request = {
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [
                    { dbName: 'shop', tableName: 'system_user' },
                    { dbName: 'shop', tableName: 'service_user' },
                ],
                columns: [],
            },
        };

        await expect(requestQueryEditorInlineCompletion({
            ...request,
            editorSnapshot: {
                prefix: 'SELECT * FROM system_user ',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM system_user ',
                currentLineAfterCursor: '',
            },
        })).resolves.toBe('AS su');
        await expect(requestQueryEditorInlineCompletion({
            ...request,
            editorSnapshot: {
                prefix: 'SELECT * FROM system_user su JOIN service_user ',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM system_user su JOIN service_user ',
                currentLineAfterCursor: '',
            },
        })).resolves.toBe('AS su2');
        expect(service.AISubmitAgentInput).not.toHaveBeenCalled();
        expect(service.AIGetProviders).not.toHaveBeenCalled();
        expect(service.AIGetActiveProvider).not.toHaveBeenCalled();
    });

    it('keeps manual table-alias context across semicolons in strings and comments', async () => {
        const service = readyService('SELECT * FROM system_user su;');
        const request = {
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [
                    { dbName: 'shop', tableName: 'system_user' },
                    { dbName: 'shop', tableName: 'service_user' },
                ],
                columns: [],
            },
        };
        const makeSnapshot = (prefix: string) => ({
            prefix,
            suffix: '',
            currentLineBeforeCursor: prefix.split(/\r?\n/).pop() || '',
            currentLineAfterCursor: '',
        });

        for (const prefix of [
            "SELECT * FROM system_user su WHERE note = ';' JOIN service_user ",
            'SELECT * FROM system_user su -- ;\r\nJOIN service_user ',
            'SELECT * FROM system_user su # ;\r\nJOIN service_user ',
            'SELECT * FROM shop.system_user su /* ; */ JOIN shop.service_user ',
        ]) {
            await expect(requestQueryEditorInlineCompletion({
                ...request,
                editorSnapshot: makeSnapshot(prefix),
            })).resolves.toBe('AS su2');
            expect(isQueryEditorInlineTableAliasPending(makeSnapshot(prefix), 'mysql')).toBe(true);
        }
        expect(service.AISubmitAgentInput).not.toHaveBeenCalled();
    });

    it('uses the configured custom prefix for manual table aliases across lexical statement contexts', async () => {
        const service = readyService('SELECT * FROM system_user t0;');
        const baseContext = {
            connectionName: 'Local MySQL',
            sourceType: 'mysql',
            tableAliasPrefix: 't',
            currentDb: 'shop',
            tables: [
                { dbName: 'shop', tableName: 'system_user' },
                { dbName: 'shop', tableName: 'service_user' },
            ],
            columns: [],
        };
        const makeSnapshot = (prefix: string) => ({
            prefix,
            suffix: '',
            currentLineBeforeCursor: prefix.split(/\r?\n/).pop() || '',
            currentLineAfterCursor: '',
        });

        await expect(requestQueryEditorInlineCompletion({
            service,
            aiContext: baseContext,
            editorSnapshot: makeSnapshot('SELECT * FROM system_user '),
        })).resolves.toBe('AS t0');
        await expect(requestQueryEditorInlineCompletion({
            service,
            aiContext: baseContext,
            editorSnapshot: makeSnapshot('SELECT * FROM system_user t0 /* ; */ JOIN service_user '),
        })).resolves.toBe('AS t1');

        for (const aiContext of [
            { ...baseContext, connectionName: 'Local Oracle', sourceType: 'oracle', tableAliasPrefix: 'T', currentDb: 'ORCL' },
            { ...baseContext, connectionName: 'OceanBase Oracle', sourceType: 'oceanbase', sqlDialect: 'oracle', tableAliasPrefix: 'T', currentDb: 'ORCL' },
        ]) {
            await expect(requestQueryEditorInlineCompletion({
                service,
                aiContext,
                editorSnapshot: makeSnapshot('SELECT * FROM system_user T0 JOIN service_user '),
            })).resolves.toBe('T1');
        }
        expect(service.AISubmitAgentInput).not.toHaveBeenCalled();
    });

    it('starts manual alias generation from the new statement after a real separator', async () => {
        const service = readyService('SELECT * FROM system_user su;');
        const prefix = 'SELECT * FROM system_user su; SELECT * FROM service_user ';
        const editorSnapshot = {
            prefix,
            suffix: '',
            currentLineBeforeCursor: prefix,
            currentLineAfterCursor: '',
        };

        await expect(requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [
                    { dbName: 'shop', tableName: 'system_user' },
                    { dbName: 'shop', tableName: 'service_user' },
                ],
                columns: [],
            },
            editorSnapshot,
        })).resolves.toBe('AS su');
        expect(resolveQueryEditorInlineCompletionIntentDetails({
            ...editorSnapshot,
            prefix: 'SELECT * FROM system_user su; SELECT * FROM ser',
            currentLineBeforeCursor: 'SELECT * FROM system_user su; SELECT * FROM ser',
        }, 'mysql')).toEqual({
            intent: 'table_name',
            fragment: 'ser',
            qualifier: '',
        });
        expect(service.AISubmitAgentInput).not.toHaveBeenCalled();
    });

    it('uses an alias without AS after a manually entered Oracle table name', async () => {
        const service = readyService('SELECT * FROM system_user su;');
        await expect(requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'Local Oracle',
                sourceType: 'oracle',
                currentDb: 'ORCL',
                tables: [{ dbName: 'ORCL', tableName: 'system_user' }],
                columns: [],
            },
            editorSnapshot: {
                prefix: 'SELECT * FROM system_user ',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM system_user ',
                currentLineAfterCursor: '',
            },
        })).resolves.toBe('su');
        expect(service.AISubmitAgentInput).not.toHaveBeenCalled();
    });

    it('keeps Oracle alias syntax after a comment semicolon, including OceanBase Oracle mode', async () => {
        const prefix = 'SELECT * FROM system_user su /* ; */ JOIN service_user ';
        const editorSnapshot = {
            prefix,
            suffix: '',
            currentLineBeforeCursor: prefix,
            currentLineAfterCursor: '',
        };
        for (const aiContext of [
            {
                connectionName: 'Local Oracle',
                sourceType: 'oracle',
                currentDb: 'ORCL',
            },
            {
                connectionName: 'OceanBase Oracle',
                sourceType: 'oceanbase',
                sqlDialect: 'oracle',
                currentDb: 'ORCL',
            },
        ]) {
            await expect(requestQueryEditorInlineCompletion({
                service: readyService('SELECT * FROM system_user su;'),
                aiContext: {
                    ...aiContext,
                    tables: [
                        { dbName: 'ORCL', tableName: 'system_user' },
                        { dbName: 'ORCL', tableName: 'service_user' },
                    ],
                    columns: [],
                },
                editorSnapshot,
            })).resolves.toBe('su2');
        }
    });

    it('does not suggest aliases after DML targets but keeps INSERT SELECT aliases', async () => {
        const service = readyService('SELECT * FROM system_user su;');
        const request = {
            service,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'system_user' }],
                columns: [],
            },
        };
        const makeSnapshot = (prefix: string) => ({
            prefix,
            suffix: '',
            currentLineBeforeCursor: prefix,
            currentLineAfterCursor: '',
        });

        for (const prefix of [
            'UPDATE system_user ',
            'DELETE FROM system_user ',
            'INSERT INTO system_user ',
            'REPLACE INTO system_user ',
            'MERGE INTO system_user ',
        ]) {
            const snapshot = makeSnapshot(prefix);
            expect(isQueryEditorInlineTableAliasPending(snapshot)).toBe(false);
            const insertText = await requestQueryEditorInlineCompletion({
                ...request,
                editorSnapshot: snapshot,
            });
            expect(insertText).not.toBe('AS su');
            expect(insertText).not.toBe('su');
        }

        const insertSelectSnapshot = makeSnapshot('INSERT INTO audit_log SELECT * FROM system_user ');
        expect(isQueryEditorInlineTableAliasPending(insertSelectSnapshot)).toBe(true);
        await expect(requestQueryEditorInlineCompletion({
            ...request,
            editorSnapshot: insertSelectSnapshot,
        })).resolves.toBe('AS su');

        const functionSelectSnapshot = makeSnapshot("SELECT REPLACE(name, 'x', 'y') FROM system_user ");
        expect(isQueryEditorInlineTableAliasPending(functionSelectSnapshot)).toBe(true);
        await expect(requestQueryEditorInlineCompletion({
            ...request,
            editorSnapshot: functionSelectSnapshot,
        })).resolves.toBe('AS su');
    });

    it('uses the resolved OceanBase Oracle dialect for table aliases', async () => {
        const service = readyService('SELECT * FROM system_user su;');
        await expect(requestQueryEditorInlineCompletion({
            service,
            aiContext: {
                connectionName: 'OceanBase Oracle',
                sourceType: 'oceanbase',
                sqlDialect: 'oracle',
                currentDb: 'ORCL',
                tables: [{ dbName: 'ORCL', tableName: 'system_user' }],
                columns: [],
            },
            editorSnapshot: {
                prefix: 'SELECT * FROM system_user ',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM system_user ',
                currentLineAfterCursor: '',
            },
        })).resolves.toBe('su');
        expect(service.AISubmitAgentInput).not.toHaveBeenCalled();
    });

    it('does not suggest an alias after a manually completed table source when disabled', async () => {
        const service = readyService('SELECT * FROM system_user su;');
        await expect(requestQueryEditorInlineCompletion({
            service,
            autoAddTableAlias: false,
            aiContext: {
                connectionName: 'Local MySQL',
                sourceType: 'mysql',
                tableAliasPrefix: 't',
                currentDb: 'shop',
                tables: [{ dbName: 'shop', tableName: 'system_user' }],
                columns: [],
            },
            editorSnapshot: {
                prefix: 'SELECT * FROM system_user ',
                suffix: '',
                currentLineBeforeCursor: 'SELECT * FROM system_user ',
                currentLineAfterCursor: '',
            },
        })).resolves.toBe('');
        expect(service.AISubmitAgentInput).not.toHaveBeenCalled();
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
        expect(service.AISubmitAgentInput).not.toHaveBeenCalled();
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
        expect(service.AISubmitAgentInput).not.toHaveBeenCalled();
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
        expect(service.AISubmitAgentInput).not.toHaveBeenCalled();
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
        expect(service.AISubmitAgentInput).toHaveBeenCalledTimes(1);
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
        expect(service.AISubmitAgentInput).toHaveBeenCalledTimes(1);
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
        expect(service.AISubmitAgentInput).toHaveBeenCalledTimes(1);
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
        expect(service.AISubmitAgentInput).not.toHaveBeenCalled();
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
        expect(service.AISubmitAgentInput).toHaveBeenCalledTimes(1);
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
        expect(service.AISubmitAgentInput).toHaveBeenCalledTimes(1);
    });

    it('does not ask the model for inline SQL when SQL AI completion is off', async () => {
        setSqlAiCompletionEnabled(false);
        try {
            const service = readyService('= 1;');
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
                    prefix: 'select * from users where id ',
                    suffix: '',
                    currentLineBeforeCursor: 'select * from users where id ',
                    currentLineAfterCursor: '',
                },
            })).resolves.toBe('');
            expect(service.AISubmitAgentInput).not.toHaveBeenCalled();

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
            expect(service.AISubmitAgentInput).not.toHaveBeenCalled();
        } finally {
            setSqlAiCompletionEnabled(true);
        }
    });

    it('uses the dedicated inline completion model when configured', async () => {
        const service = {
            ...readyService('select * from users where id = 1;'),
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
                prefix: 'select * from users where id ',
                suffix: '',
                currentLineBeforeCursor: 'select * from users where id ',
                currentLineAfterCursor: '',
            },
        });

        expect(resolveQueryEditorInlineCompletionModel((await service.AIGetProviders())[0])).toBe('gpt-5-mini');
        expect(insertText).toBe('= 1;');
        expect(service.AISubmitAgentInput).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gpt-5-mini',
            maxTokens: 192,
            temperature: 0.1,
            taskKind: 'query_editor_generation',
            allowTools: false,
        }));
    });

    it('falls back to the chat model for inline completion when no dedicated model is configured', async () => {
        const service = readyService('select * from users where id = 1;');

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
                prefix: 'select * from users where id ',
                suffix: '',
                currentLineBeforeCursor: 'select * from users where id ',
                currentLineAfterCursor: '',
            },
        });

        expect(service.AISubmitAgentInput).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gpt-5',
            maxTokens: 192,
            temperature: 0.1,
        }));
    });

    it('does not use hidden reasoning as inline SQL output', async () => {
        const service = readyService('');

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
                prefix: 'select * from videos where code ',
                suffix: '',
                currentLineBeforeCursor: 'select * from videos where code ',
                currentLineAfterCursor: '',
            },
        });

        expect(insertText).toBe('');
    });

    it('drops inline completions that introduce tables outside the selected database context', async () => {
        const service = readyService('select * from orders where id = 1;');

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
                prefix: 'select * from videos where code ',
                suffix: '',
                currentLineBeforeCursor: 'select * from videos where code ',
                currentLineAfterCursor: '',
            },
        });

        expect(insertText).toBe('');
    });
});
