import type { AIChatTokenUsage, AIToolCall, AIChatMessage } from '../../../types';
import {
  type AIRunToolIntent,
  type AIRunEvent,
  type AIRunApprovalPayload,
  type AIRunApprovalState,
  type AIRunToolPayload,
  type AIRunErrorPayload,
  type AIRunRecoveryState,
  type AIRunUsage,
  type AIRunTerminalPayload,
  toAIRunEventTimestamp,
} from '../aiRunEventProjection';
import { type ProjectedRun, payloadObject, claimedAssistantMessages } from './aiRunProjectionState';
import {
  type UseAIChatRunEventSubscriptionOptions,
  activityMessageIdFor,
  recordRunActivity,
  findMessage,
  findRunPendingMessage,
  hasVisibleAssistantContent,
  fallbackCopy,
  findFailedRunPendingMessages,
  createRunMessageId,
  notifyRunState,
} from './aiRunMessageProjection';

const toolIntentFor = (run: ProjectedRun, callId: unknown): AIRunToolIntent | undefined =>
  run.toolIntents.get(String(callId || '').trim());

export const toApprovalState = (
  event: AIRunEvent,
  payload: AIRunApprovalPayload,
): AIRunApprovalState | null => {
  const approvalId = String(payload.approvalId || '').trim();
  const callId = String(payload.callId || '').trim();
  const toolName = String(payload.toolName || '').trim();
  const effect = String(payload.effect || '').trim();
  const argsHash = String(payload.argsHash || '').trim();
  const decision = String(payload.decision || '').trim().toLowerCase();
  if (!approvalId || !callId || !toolName || !effect || !argsHash || !decision) return null;
  const summary = String(payload.summary || '').trim();
  return {
    runId: event.runId,
    sessionId: event.sessionId,
    approvalId,
    callId,
    toolName,
    effect,
    argsHash,
    decision,
    ...(summary ? { summary } : {}),
    revision: event.runRevision,
  };
};

export const toRecoveryState = (
  event: AIRunEvent,
  payload: AIRunToolPayload | AIRunErrorPayload,
  run: ProjectedRun,
): AIRunRecoveryState => {
  const callId = 'callId' in payload ? String(payload.callId || '').trim() : '';
  const intent = toolIntentFor(run, callId);
  const toolName = 'toolName' in payload ? String(payload.toolName || '').trim() : '';
  const effect = 'effect' in payload ? String(payload.effect || '').trim() : '';
  const status = 'status' in payload ? String(payload.status || '').trim() : '';
  const errorCode = 'errorCode' in payload
    ? String(payload.errorCode || '').trim()
    : ('code' in payload ? String(payload.code || '').trim() : '');
  const reason = 'message' in payload ? String(payload.message || '').trim() : '';
  return {
    runId: event.runId,
    sessionId: event.sessionId,
    ...(callId ? { callId } : {}),
    ...(toolName || intent?.toolName ? { toolName: toolName || intent?.toolName } : {}),
    ...(effect || intent?.effect ? { effect: effect || String(intent?.effect) } : {}),
    ...(status ? { status } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(reason ? { reason } : {}),
    revision: event.runRevision,
  };
};

export const completedValue = (current: string | undefined, completed: unknown): string => {
  const existing = String(current || '');
  const final = String(completed || '');
  if (!final) return existing;
  if (!existing || final.startsWith(existing)) return final;
  // Some Provider adapters return the full response after already emitting it
  // as deltas. Keep the longer projection instead of duplicating the turn.
  if (existing.endsWith(final) || existing.includes(final)) return existing;
  return final;
};

export const appendModelTurn = (completed: string, currentTurn: string): string => {
  if (!currentTurn) return completed;
  if (!completed) return currentTurn;
  if (completed === currentTurn || completed.endsWith(currentTurn)) return completed;
  if (currentTurn.startsWith(completed)) return currentTurn;
  return `${completed.trimEnd()}\n\n${currentTurn.trimStart()}`;
};

export const hasTokenUsage = (usage: AIRunUsage | AIChatTokenUsage | undefined): boolean => Boolean(
  usage && (
    usage.promptTokens !== undefined
    || usage.completionTokens !== undefined
    || usage.totalTokens !== undefined
    || usage.cachedTokens !== undefined
  ),
);

const addTokenUsage = (
  existing: AIChatTokenUsage | undefined,
  incoming: AIRunUsage,
): AIChatTokenUsage => {
  const merged: AIChatTokenUsage = { ...(existing || {}) };
  for (const key of ['promptTokens', 'completionTokens', 'totalTokens', 'cachedTokens'] as const) {
    if (incoming[key] === undefined) continue;
    merged[key] = (merged[key] || 0) + incoming[key];
  }
  return merged;
};

export const projectRunTokenUsage = (
  event: AIRunEvent,
  run: ProjectedRun,
  options: UseAIChatRunEventSubscriptionOptions,
  usage: AIRunUsage | undefined,
): boolean => {
  if (!hasTokenUsage(usage)) return false;
  if (run.usageEventSequences.has(event.sequence)) return true;
  run.usageEventSequences.add(event.sequence);
  run.tokenUsage = addTokenUsage(run.tokenUsage, usage || {});
  const messageId = activityMessageIdFor(event, run);
  if (messageId) {
    options.updateAIChatMessage(event.sessionId, messageId, { tokenUsage: run.tokenUsage });
  }
  return true;
};

export const mergeToolCalls = (
  existing: AIToolCall[] | undefined,
  incoming: AIToolCall[],
): AIToolCall[] | undefined => {
  if (incoming.length === 0) return existing;
  const calls = [...(existing || [])];
  const existingIds = new Set(calls.map((call) => call.id));
  for (const call of incoming) {
    if (existingIds.has(call.id)) continue;
    calls.push(call);
    existingIds.add(call.id);
  }
  return calls;
};

export const applyTerminal = (
  event: AIRunEvent,
  run: ProjectedRun,
  options: UseAIChatRunEventSubscriptionOptions,
): void => {
  if (run.terminalHandled) return;
  run.terminalHandled = true;
  run.terminal = event.resultingState;
  recordRunActivity(event, run, options);
  const message = (run.assistantMessageId
    ? findMessage(event.sessionId, run.assistantMessageId)
    : undefined)
    || findRunPendingMessage(event.sessionId, event.runId);
  const terminalPayload = payloadObject<AIRunTerminalPayload>(event);
  const errorText = run.lastError?.message || terminalPayload.reason || terminalPayload.errorCode || '';
  const state = event.resultingState;

  if (state === 'completed') {
    if (message) {
      if (!hasVisibleAssistantContent(message)) {
        options.updateAIChatMessage(event.sessionId, message.id, {
          content: fallbackCopy(
            options.translate,
            'ai_chat.panel.message.empty_response',
            'The model did not return any content.',
          ),
          loading: false,
          phase: 'idle',
          excludeFromAIContext: true,
        });
      } else {
        options.updateAIChatMessage(event.sessionId, message.id, {
          loading: false,
          phase: 'idle',
        });
      }
    }
  } else if (state === 'canceled' || state === 'interrupted') {
    if (message && hasVisibleAssistantContent(message)) {
      const steerInterrupted = /steer|supersed/i.test(String(terminalPayload.reason || ''));
      options.updateAIChatMessage(event.sessionId, message.id, {
        loading: false,
        phase: 'idle',
        ...(steerInterrupted ? { excludeFromAIContext: true } : {}),
      });
    } else if (message) {
      // Keep the transient placeholder local and explicitly out of future
      // model context. The Ledger owns durable messages; deleting from the
      // Zustand projection here would make the next hydrate resurrect it.
      options.updateAIChatMessage(event.sessionId, message.id, {
        loading: false,
        phase: 'idle',
        excludeFromAIContext: true,
      });
    }
  } else {
    const stalePendingMessages = findFailedRunPendingMessages(event.sessionId, event.runId);
    if (message && hasVisibleAssistantContent(message)) {
      options.updateAIChatMessage(event.sessionId, message.id, {
        loading: false,
        phase: 'idle',
        rawError: errorText || undefined,
      });
    }
    for (const pending of stalePendingMessages) {
      claimedAssistantMessages.delete(pending.id);
      if (options.deleteAIChatMessage) {
        options.deleteAIChatMessage(event.sessionId, pending.id);
      } else {
        options.updateAIChatMessage(event.sessionId, pending.id, {
          loading: false,
          phase: 'idle',
          excludeFromAIContext: true,
        });
      }
    }
    if (errorText) {
      const errorMessageId = `${createRunMessageId(event.runId)}-error`;
      const errorMessage = {
        runId: event.runId,
        role: 'assistant',
        content: fallbackCopy(
          options.translate,
          'ai_chat.panel.message.error',
          `Error: ${errorText}`,
          { detail: errorText },
        ),
        rawError: errorText,
        runActivities: run.runActivities,
        timestamp: toAIRunEventTimestamp(event.timestamp),
        loading: false,
        phase: 'idle',
        excludeFromAIContext: true,
      } satisfies Omit<AIChatMessage, 'id'>;
      if (findMessage(event.sessionId, errorMessageId)) {
        options.updateAIChatMessage(event.sessionId, errorMessageId, errorMessage);
      } else {
        options.addAIChatMessage(event.sessionId, {
          id: errorMessageId,
          ...errorMessage,
        });
      }
    }
  }

  if (event.sessionId === options.sid) {
    options.setSending(false);
  }
  notifyRunState(event, options, run);
  options.onApprovalChange?.(event.runId, null);
  options.onRecoveryChange?.(event.runId, null);
  options.onRunTerminal?.(event.runId, event.sessionId);
};
