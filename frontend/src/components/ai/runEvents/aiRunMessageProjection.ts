import { useStore } from '../../../store';
import type { AIChatMessage, AIToolCall } from '../../../types';
import { createRunPendingMessageId } from '../aiRunHarnessClient';
import {
  type AIRunState,
  type AIRunApprovalState,
  type AIRunRecoveryState,
  type AIRunEvent,
  toAIRunEventTimestamp,
  type AIRunModelCompletedPayload,
  toAIRunToolCalls,
  type AIRunToolIntent,
  normalizeAIRunToolIntent,
} from '../aiRunEventProjection';
import { projectAIRunActivities } from '../aiRunActivityTimeline';
import {
  type ProjectedRun,
  projectedRuns,
  createProjectedRun,
  claimedAssistantMessages,
} from './aiRunProjectionState';

export interface UseAIChatRunEventSubscriptionOptions {
  sid: string;
  setSending: (sending: boolean) => void;
  addAIChatMessage: (sid: string, message: AIChatMessage) => void;
  updateAIChatMessage: (
    sid: string,
    messageId: string,
    patch: Partial<AIChatMessage>,
  ) => void;
  deleteAIChatMessage?: (sid: string, messageId: string) => void;
  nextMessageId: () => string;
  onRunStateChange?: (runId: string, state: AIRunState, revision: number) => void;
  onApprovalChange?: (runId: string, approval: AIRunApprovalState | null) => void;
  onRecoveryChange?: (runId: string, recovery: AIRunRecoveryState | null) => void;
  /** Accept a run whose canonical session ID has not reached React yet. */
  isRunTracked?: (runId: string, sessionId: string) => boolean;
  /** Re-run the durable bootstrap when SubmitInput acknowledges a new run. */
  trackedRunIds?: string[];
  onRunTerminal?: (runId: string, sessionId: string) => void;
  translate?: (key: string, params?: Record<string, string | number | boolean | null | undefined>) => string;
}

/** Keep state callbacks monotonic across docked and detached projections. */
export const notifyRunState = (
  event: AIRunEvent,
  options: UseAIChatRunEventSubscriptionOptions,
  run?: ProjectedRun,
): void => {
  const projection = run || projectedRuns.get(event.runId) || createProjectedRun();
  if (!projectedRuns.has(event.runId)) projectedRuns.set(event.runId, projection);
  if (event.runRevision <= projection.lastNotifiedRevision) return;
  projection.lastNotifiedRevision = event.runRevision;
  options.onRunStateChange?.(event.runId, event.resultingState, event.runRevision);
};

export const notifyRunSnapshot = (
  runId: string,
  state: AIRunState,
  revision: number,
  options: UseAIChatRunEventSubscriptionOptions,
): void => {
  let run = projectedRuns.get(runId);
  if (!run) {
    run = createProjectedRun();
    projectedRuns.set(runId, run);
  }
  if (revision > run.lastNotifiedRevision) run.lastNotifiedRevision = revision;
  // A newly mounted panel still needs the current snapshot even when another
  // panel has already notified the same revision. Historical event replay is
  // filtered by notifyRunState below; this callback is the fresh baseline.
  options.onRunStateChange?.(runId, state, revision);
};

export const hasVisibleAssistantContent = (message: AIChatMessage | undefined): boolean => Boolean(
  message
  && (
    String(message.content || '').trim()
    || String(message.thinking || '').trim()
    || String(message.reasoning_content || '').trim()
    || (message.tool_calls || []).length > 0
  ),
);

export const fallbackCopy = (
  translate: UseAIChatRunEventSubscriptionOptions['translate'],
  key: string,
  fallback: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): string => {
  if (!translate) return fallback;
  const translated = translate(key, params);
  return translated && translated !== key ? translated : fallback;
};

export const findMessage = (sid: string, id: string): AIChatMessage | undefined =>
  (useStore.getState().aiChatHistory[sid] || []).find((message) => message.id === id);

const isPendingAssistantMessage = (message: AIChatMessage): boolean => (
  message.role === 'assistant'
  && message.loading === true
  && (message.phase === 'queued' || message.phase === 'connecting')
  && !claimedAssistantMessages.has(message.id)
);

export const findRunPendingMessage = (sid: string, runId: string): AIChatMessage | undefined =>
  [...(useStore.getState().aiChatHistory[sid] || [])]
    .reverse()
    .find((message) => (
      message.role === 'assistant'
      && message.loading === true
      && (message.phase === 'queued' || message.phase === 'connecting')
      && (message.runId === runId || message.id === createRunPendingMessageId(runId))
    ));

// Sessions created before SubmitInput began returning a run-scoped receipt can
// contain one legacy pending row. It is safe to adopt only when it is the
// sole candidate; picking the most recent one can cross-wire concurrent runs.
const findUnclaimedPendingMessage = (sid: string): AIChatMessage | undefined => {
  const candidates = (useStore.getState().aiChatHistory[sid] || [])
    .filter((message) => isPendingAssistantMessage(message) && !String(message.runId || '').trim());
  return candidates.length === 1 ? candidates[0] : undefined;
};

// A receipt-bound row and an older local `connecting` row can briefly coexist
// while React applies the SubmitInput receipt. A failed run must settle both
// empty rows, but only adopt the legacy row when it is unambiguous so another
// concurrently submitted legacy run is never removed.
export const findFailedRunPendingMessages = (sid: string, runId: string): AIChatMessage[] => {
  const messages = useStore.getState().aiChatHistory[sid] || [];
  const pending = messages.filter((message) => (
    message.role === 'assistant'
    && message.loading === true
    && !hasVisibleAssistantContent(message)
    && (
      message.phase === 'queued'
      || message.phase === 'connecting'
      || message.runId === runId
      || message.id === createRunPendingMessageId(runId)
    )
  ));
  const messageIds = new Set(
    pending
      .filter((message) => (
        message.runId === runId || message.id === createRunPendingMessageId(runId)
      ))
      .map((message) => message.id),
  );
  const legacy = pending.filter((message) => !String(message.runId || '').trim());
  if (legacy.length === 1) messageIds.add(legacy[0].id);
  return pending.filter((message) => messageIds.has(message.id));
};

// Keep the existing suffix stable for transient rows created by earlier builds.
// A run maps to exactly one assistant bubble even when it invokes tools across
// several model turns.
export const createRunMessageId = (runId: string): string => `agent-run-${runId}-0`;

export const ensureAssistantMessage = (
  event: AIRunEvent,
  options: UseAIChatRunEventSubscriptionOptions,
): { run: ProjectedRun; messageId: string } => {
  let run = projectedRuns.get(event.runId);
  if (!run) {
    run = {
      ...createProjectedRun(),
    };
    projectedRuns.set(event.runId, run);
  }

  if (run.assistantMessageId && findMessage(event.sessionId, run.assistantMessageId)) {
    return { run, messageId: run.assistantMessageId };
  }

  const existingRunMessage = [...(useStore.getState().aiChatHistory[event.sessionId] || [])]
    .reverse()
    .find((message) => (
      message.role === 'assistant'
      && message.runId === event.runId
      && !message.excludeFromAIContext
    ));
  const pending = existingRunMessage
    || findRunPendingMessage(event.sessionId, event.runId)
    || findUnclaimedPendingMessage(event.sessionId);
  const messageId = pending?.id || createRunMessageId(event.runId);
  run.assistantMessageId = messageId;
  claimedAssistantMessages.set(messageId, event.runId);

  if (pending) {
    options.updateAIChatMessage(event.sessionId, messageId, { runId: event.runId });
    if (pending.runActivities?.length) run.runActivities = pending.runActivities;
    if (pending.tokenUsage) run.tokenUsage = { ...pending.tokenUsage };
    if (hasVisibleAssistantContent(pending)) {
      if (pending.loading) {
        run.modelText = String(pending.content || '');
        run.modelReasoning = String(pending.reasoning_content || pending.thinking || '');
      } else {
        run.completedModelText = String(pending.content || '');
        run.completedModelReasoning = String(pending.reasoning_content || pending.thinking || '');
        run.hasCompletedModelTurn = true;
      }
    }
  } else {
    options.addAIChatMessage(event.sessionId, {
      id: messageId,
      runId: event.runId,
      role: 'assistant',
      phase: 'generating',
      content: '',
      timestamp: toAIRunEventTimestamp(event.timestamp),
      loading: true,
    });
  }
  return { run, messageId };
};

export const activityMessageIdFor = (
  event: AIRunEvent,
  run: ProjectedRun,
  preferredMessageId?: string,
): string | undefined => {
  if (preferredMessageId && findMessage(event.sessionId, preferredMessageId)) return preferredMessageId;
  if (run.assistantMessageId && findMessage(event.sessionId, run.assistantMessageId)) {
    return run.assistantMessageId;
  }
  const durableMessage = [...(useStore.getState().aiChatHistory[event.sessionId] || [])]
    .reverse()
    .find((message) => message.role === 'assistant' && message.runId === event.runId);
  if (!durableMessage) return undefined;
  run.assistantMessageId = durableMessage.id;
  if (durableMessage.runActivities?.length) run.runActivities = durableMessage.runActivities;
  return durableMessage.id;
};

/**
 * Persist only redacted event metadata. The transcript and raw error paths
 * remain separate so event replay cannot duplicate model text or leak tool IO.
 */
export const recordRunActivity = (
  event: AIRunEvent,
  run: ProjectedRun,
  options: UseAIChatRunEventSubscriptionOptions,
  preferredMessageId?: string,
): void => {
  run.runActivities = projectAIRunActivities(run.runActivities, event);
  const messageId = activityMessageIdFor(event, run, preferredMessageId);
  if (!messageId) return;
  options.updateAIChatMessage(event.sessionId, messageId, { runActivities: run.runActivities });
};

export const normalizeToolCalls = (payload: AIRunModelCompletedPayload): AIToolCall[] =>
  toAIRunToolCalls(payload);

export const rememberToolIntents = (
  run: ProjectedRun,
  payload: { toolCalls?: AIRunToolIntent[] },
): void => {
  if (!Array.isArray(payload.toolCalls)) return;
  for (const intent of payload.toolCalls) {
    const callId = String(intent?.callId || '').trim();
    const toolName = String(intent?.toolName || '').trim();
    if (!callId || !toolName) continue;
    // The Go harness rejects malformed/duplicate calls before execution. Keep
    // the approval projection equally strict so a partial provider response
    // cannot surface as a valid-looking control card.
    const normalized = normalizeAIRunToolIntent(intent);
    if (!normalized) continue;
    if (run.toolIntents.has(callId)) continue;
    run.toolIntents.set(callId, normalized);
  }
};
