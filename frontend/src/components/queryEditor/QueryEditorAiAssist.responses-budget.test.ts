import { describe, expect, it, vi } from 'vitest';

import {
    requestQueryEditorInlineCompletion,
    requestQueryEditorTextToSql,
    type QueryEditorAiService,
} from './QueryEditorAiAssist';

const createReadyService = (providerModel: string, inlineCompletionModel?: string): QueryEditorAiService => {
    const runId = `query-editor-budget-${providerModel}`;
    const events = [
        {
            schemaVersion: 1,
            runId,
            sessionId: 'query-editor-budget-session',
            sessionGeneration: 1,
            sequence: 1,
            runRevision: 1,
            attempt: 1,
            timestamp: 1,
            kind: 'model_completed' as const,
            resultingState: 'running_model' as const,
            payload: { text: ' = 1;' },
        },
        {
            schemaVersion: 1,
            runId,
            sessionId: 'query-editor-budget-session',
            sessionGeneration: 1,
            sequence: 2,
            runRevision: 2,
            attempt: 1,
            timestamp: 2,
            kind: 'terminal' as const,
            resultingState: 'completed' as const,
            payload: { reason: 'completed' },
        },
    ];
    return {
        AIGetProviders: vi.fn(async () => [{
            id: 'responses-provider',
            type: 'openai' as const,
            name: 'Responses provider',
            apiKey: '',
            hasSecret: true,
            baseUrl: 'https://api.example.test/v1',
            model: providerModel,
            inlineCompletionModel,
            maxTokens: 0,
            temperature: 0.2,
        }]),
        AIGetActiveProvider: vi.fn(async () => 'responses-provider'),
        AIGetUserPromptSettings: vi.fn(async () => ({
            global: '',
            database: '',
            jvm: '',
            jvmDiagnostic: '',
        })),
        AISubmitAgentInput: vi.fn(async (request: { requestId: string }) => ({
            requestId: request.requestId,
            sessionId: 'query-editor-budget-session',
            runId,
            disposition: 'started' as const,
            revision: 1,
            state: 'running_model' as const,
        })),
        AIReadAgentRun: vi.fn(async (request: { afterSequence?: number }) => ({
            run: { id: runId, state: 'completed' as const },
            events: events.filter((event) => event.sequence > Number(request.afterSequence || 0)),
            hasMore: false,
        })),
    };
};

const requestInlineSQL = async (service: QueryEditorAiService) => requestQueryEditorInlineCompletion({
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

describe('QueryEditorAiAssist Responses budget', () => {
    it('disables hidden reasoning for the small inline SQL budget', async () => {
        const service = createReadyService('gpt-5');

        await expect(requestInlineSQL(service)).resolves.toBe('= 1;');
        expect(service.AISubmitAgentInput).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gpt-5',
            thinking: 'none',
            maxTokens: 192,
        }));
    });

    it('keeps the same explicit off selection when a dedicated model is used', async () => {
        const service = createReadyService('gpt-5', 'gpt-5-mini');

        await expect(requestInlineSQL(service)).resolves.toBe('= 1;');
        expect(service.AISubmitAgentInput).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gpt-5-mini',
            thinking: 'none',
            maxTokens: 192,
        }));
    });

    it('does not disable reasoning for non-inline Query Editor generation', async () => {
        const service = createReadyService('gpt-5');

        await expect(requestQueryEditorTextToSql({
            service,
            aiContext: { sourceType: 'mysql', currentDb: 'shop' },
            editorSnapshot: {
                prefix: '',
                suffix: '',
                currentLineBeforeCursor: '',
                currentLineAfterCursor: '',
            },
            instruction: '查询 users 表',
        })).resolves.toMatchObject({ sql: '= 1;' });
        expect(service.AISubmitAgentInput).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gpt-5',
            maxTokens: undefined,
        }));
        const submitAgentInput = vi.mocked(service.AISubmitAgentInput!);
        expect(submitAgentInput.mock.calls[0]?.[0]).not.toHaveProperty('thinking');
    });
});
