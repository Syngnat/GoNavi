import type { AIChatMessage } from '../../../types';

export const genId = () => `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

export const createRunStopFailureMessageId = (runId: string): string =>
    `agent-run-${runId}-stop-error`;

export const isTerminalRunState = (state: string | undefined): boolean =>
    state === 'completed'
    || state === 'failed'
    || state === 'canceled'
    || state === 'exhausted';

export const hasTerminalRunError = (message: AIChatMessage, runId: string): boolean => (
    message.role === 'assistant'
    && message.runId === runId
    && message.loading === false
    && message.excludeFromAIContext === true
    && Boolean(String(message.rawError || '').trim())
);

export const isRevisionConflictError = (error: unknown): boolean =>
    String(error instanceof Error ? error.message : error || '')
        .toLowerCase()
        .includes('revision_conflict');

export const positiveRevision = (value: unknown): number => {
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
};

export interface PendingConversationBranch {
    sourceSessionId: string;
    sourceRevision?: number;
    branchFromMessageId: string;
}
