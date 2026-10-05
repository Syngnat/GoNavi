import type { AIProviderConfig } from '../../types';
import {
    type QueryEditorAiService,
    type QueryEditorAiRuntimeReadiness,
    EMPTY_USER_PROMPT_SETTINGS,
    INLINE_RUNTIME_READINESS_CACHE_TTL_MS,
    type QueryEditorAiEditorSnapshot,
} from './queryEditorAiAssistTypes';
import {
    getCurrentStatementPrefix,
    hasUnclosedBlockComment,
    hasUnclosedSqlString,
} from './queryEditorAiInlineText';

export const getQueryEditorAiService = (): QueryEditorAiService | undefined =>
    (window as any)?.go?.aiservice?.Service;

export const resolveQueryEditorInlineCompletionModel = (provider: AIProviderConfig): string =>
    String(provider.inlineCompletionModel || provider.model || '').trim();

export const resolveQueryEditorAiRuntimeReadiness = async (
    service: QueryEditorAiService | undefined,
    options: { requireInlineCompletionModel?: boolean } = {},
): Promise<QueryEditorAiRuntimeReadiness> => {
    if (!service?.AISubmitAgentInput || !service?.AIReadAgentRun || !service?.AIGetProviders || !service?.AIGetActiveProvider) {
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
    sqlDialect = '',
): boolean => {
    if (!shouldAllowQueryEditorInlineMemoryCompletion(snapshot, sqlDialect)) {
        return false;
    }

    const prefix = String(snapshot.prefix || '');
    const currentStatement = getCurrentStatementPrefix(prefix, sqlDialect);
    const trimmedStatement = currentStatement.trim();
    if (trimmedStatement.length < 3) {
        return false;
    }
    return true;
};

export const shouldAllowQueryEditorInlineMemoryCompletion = (
    snapshot: QueryEditorAiEditorSnapshot,
    sqlDialect = '',
): boolean => {
    const lineAfterCursor = String(snapshot.currentLineAfterCursor || '');
    if (lineAfterCursor.length > 0) {
        return false;
    }

    const prefix = String(snapshot.prefix || '');
    const currentStatement = getCurrentStatementPrefix(prefix, sqlDialect);
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

export const normalizeInlineMemoryCandidateSql = (sql: string): string => (
    String(sql || '')
        .replace(/\r\n?/g, '\n')
        .trim()
);

export const normalizeInlineMemoryMatchText = (sql: string): string => (
    normalizeInlineMemoryCandidateSql(sql)
        .replace(/\s+/g, ' ')
        .trimStart()
        .toLowerCase()
);
