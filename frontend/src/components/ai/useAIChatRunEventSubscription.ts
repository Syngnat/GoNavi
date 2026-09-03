import { useEffect, useRef } from 'react';

import { EventsOn } from '../../../wailsjs/runtime';
import { useStore } from '../../store';
import type { AIChatMessage, AIChatRunActivity, AIToolCall } from '../../types';
import {
  createRunPendingMessageId,
  getAIRunHarnessService,
  mergeAIChatSessionMessages,
  readAgentRun,
  readAgentSession,
  toAIChatMessages,
  type RunReadResult,
} from './aiRunHarnessClient';
import {
  AI_RUN_EVENT_NAME,
  sharedAIRunEventSequenceTracker,
  isAIRunTerminalState,
  parseAIRunEvent,
  normalizeAIRunToolIntent,
  toAIRunEventTimestamp,
  toAIRunToolCalls,
  type AIRunEvent,
  type AIRunApprovalPayload,
  type AIRunApprovalState,
  type AIRunErrorPayload,
  type AIRunModelCompletedPayload,
  type AIRunModelDeltaPayload,
  type AIRunRecoveryState,
  type AIRunState,
  type AIRunToolIntent,
  type AIRunToolPayload,
  type AIRunTerminalPayload,
} from './aiRunEventProjection';
import { projectAIRunActivities } from './aiRunActivityTimeline';

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

interface ProjectedRun {
  assistantMessageId: string;
  /** Text from model turns that have already crossed their completion boundary. */
  completedModelText: string;
  /** Reasoning from model turns that have already crossed their completion boundary. */
  completedModelReasoning: string;
  /** Text streamed during the currently executing model turn. */
  modelText: string;
  /** Reasoning streamed during the currently executing model turn. */
  modelReasoning: string;
  /** A completed model turn already contributes to this run's single UI row. */
  hasCompletedModelTurn: boolean;
  toolIntents: Map<string, AIRunToolIntent>;
  /** Redacted process steps, kept even when the transient assistant row moves. */
  runActivities: AIChatRunActivity[];
  lastNotifiedRevision: number;
  lastError?: AIRunErrorPayload;
  terminal?: AIRunState;
  terminalHandled?: boolean;
}

interface ReplayRunProjection {
  /** Number of completed assistant turns already present in the Ledger. */
  durableAssistantTurns: number;
  /** Number of model_completed events consumed during this replay. */
  completedTurns: number;
  /** Protect the turn count when a replay page overlaps the shared cursor. */
  completedEventSequences: Set<number>;
  /** Deltas for the model turn whose completion has not arrived yet. */
  pendingModelEvents: AIRunEvent[];
  /** A live subscriber already projected model text while replay was running. */
  liveModelProjectionSeen: boolean;
}

const projectedRuns = new Map<string, ProjectedRun>();
const claimedAssistantMessages = new Map<string, string>();

export const AI_RUN_EVENT_RECOVERY_RETRY_BASE_MS = 100;
export const AI_RUN_EVENT_RECOVERY_RETRY_MAX_MS = 5_000;

const isAIRunReconciliationState = (state: AIRunState): boolean => (
  state === 'queued'
  || state === 'running_model'
  || state === 'running_tool'
  || state === 'canceling'
);

const createProjectedRun = (): ProjectedRun => ({
  assistantMessageId: '',
  completedModelText: '',
  completedModelReasoning: '',
  modelText: '',
  modelReasoning: '',
  hasCompletedModelTurn: false,
  toolIntents: new Map(),
  runActivities: [],
  lastNotifiedRevision: -1,
});

const createReplayRunProjection = (durableAssistantTurns = 0): ReplayRunProjection => ({
  durableAssistantTurns,
  completedTurns: 0,
  completedEventSequences: new Set(),
  pendingModelEvents: [],
  liveModelProjectionSeen: false,
});

/** Reset only the module-level projection cache; intended for isolated tests. */
export const resetAIChatRunEventProjection = (): void => {
  projectedRuns.clear();
  claimedAssistantMessages.clear();
  sharedAIRunEventSequenceTracker.reset();
};

const payloadObject = <T extends object>(event: AIRunEvent): T => event.payload as T;

/** Keep state callbacks monotonic across docked and detached projections. */
const notifyRunState = (
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

const notifyRunSnapshot = (
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

const hasVisibleAssistantContent = (message: AIChatMessage | undefined): boolean => Boolean(
  message
  && (
    String(message.content || '').trim()
    || String(message.thinking || '').trim()
    || String(message.reasoning_content || '').trim()
    || (message.tool_calls || []).length > 0
  ),
);

const fallbackCopy = (
  translate: UseAIChatRunEventSubscriptionOptions['translate'],
  key: string,
  fallback: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): string => {
  if (!translate) return fallback;
  const translated = translate(key, params);
  return translated && translated !== key ? translated : fallback;
};

const findMessage = (sid: string, id: string): AIChatMessage | undefined =>
  (useStore.getState().aiChatHistory[sid] || []).find((message) => message.id === id);

const isPendingAssistantMessage = (message: AIChatMessage): boolean => (
  message.role === 'assistant'
  && message.loading === true
  && (message.phase === 'queued' || message.phase === 'connecting')
  && !claimedAssistantMessages.has(message.id)
);

const findRunPendingMessage = (sid: string, runId: string): AIChatMessage | undefined =>
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
const findFailedRunPendingMessages = (sid: string, runId: string): AIChatMessage[] => {
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
const createRunMessageId = (runId: string): string => `agent-run-${runId}-0`;

const ensureAssistantMessage = (
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

const activityMessageIdFor = (
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
const recordRunActivity = (
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

const normalizeToolCalls = (payload: AIRunModelCompletedPayload): AIToolCall[] =>
  toAIRunToolCalls(payload);

const rememberToolIntents = (
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

const toolIntentFor = (run: ProjectedRun, callId: unknown): AIRunToolIntent | undefined =>
  run.toolIntents.get(String(callId || '').trim());

const toApprovalState = (
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

const toRecoveryState = (
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

const completedValue = (current: string | undefined, completed: unknown): string => {
  const existing = String(current || '');
  const final = String(completed || '');
  if (!final) return existing;
  if (!existing || final.startsWith(existing)) return final;
  // Some Provider adapters return the full response after already emitting it
  // as deltas. Keep the longer projection instead of duplicating the turn.
  if (existing.endsWith(final) || existing.includes(final)) return existing;
  return final;
};

const appendModelTurn = (completed: string, currentTurn: string): string => {
  if (!currentTurn) return completed;
  if (!completed) return currentTurn;
  if (completed === currentTurn || completed.endsWith(currentTurn)) return completed;
  if (currentTurn.startsWith(completed)) return currentTurn;
  return `${completed.trimEnd()}\n\n${currentTurn.trimStart()}`;
};

const mergeToolCalls = (
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

const applyTerminal = (
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

/**
 * Rebuild only the durable control projection while another view already owns
 * the shared event cursor. Replaying through applyAIRunEvent would append
 * model deltas a second time, so historical approval/recovery events use this
 * side-effect-free path instead.
 */
const applyAIRunControlProjection = (
  event: AIRunEvent,
  options: UseAIChatRunEventSubscriptionOptions,
): void => {
  let run = projectedRuns.get(event.runId);
  if (!run) {
    run = createProjectedRun();
    projectedRuns.set(event.runId, run);
  }
  recordRunActivity(event, run, options);

  switch (event.kind) {
    case 'model_delta':
      rememberToolIntents(run, payloadObject<AIRunModelDeltaPayload>(event));
      notifyRunState(event, options, run);
      return;
    case 'model_completed':
      rememberToolIntents(run, payloadObject<AIRunModelCompletedPayload>(event));
      notifyRunState(event, options, run);
      return;
    case 'tool': {
      const payload = payloadObject<AIRunToolPayload>(event);
      if (
        event.resultingState === 'recovery_required'
        || String(payload.status || '').toLowerCase() === 'unknown'
      ) {
        options.onRecoveryChange?.(event.runId, toRecoveryState(event, payload, run));
      } else {
        options.onRecoveryChange?.(event.runId, null);
      }
      notifyRunState(event, options, run);
      return;
    }
    case 'approval': {
      const approval = toApprovalState(
        event,
        payloadObject<AIRunApprovalPayload>(event),
      );
      options.onApprovalChange?.(
        event.runId,
        approval && approval.decision === 'pending' ? approval : null,
      );
      notifyRunState(event, options, run);
      return;
    }
    case 'run_error': {
      const payload = payloadObject<AIRunErrorPayload>(event);
      if (event.resultingState === 'recovery_required') {
        options.onRecoveryChange?.(event.runId, toRecoveryState(event, payload, run));
      } else if (isAIRunTerminalState(event.resultingState)) {
        options.onApprovalChange?.(event.runId, null);
        options.onRecoveryChange?.(event.runId, null);
      } else {
        options.onRecoveryChange?.(event.runId, null);
      }
      notifyRunState(event, options, run);
      if (isAIRunTerminalState(event.resultingState)) {
        if (event.sessionId === options.sid) options.setSending(false);
        options.onRunTerminal?.(event.runId, event.sessionId);
      }
      return;
    }
    case 'terminal':
      options.onApprovalChange?.(event.runId, null);
      options.onRecoveryChange?.(event.runId, null);
      if (event.sessionId === options.sid) options.setSending(false);
      notifyRunState(event, options, run);
      options.onRunTerminal?.(event.runId, event.sessionId);
      return;
    case 'usage':
    case 'checkpoint':
      // Checkpoints carry state-only transitions such as interrupted and
      // awaiting_workspace. Replay must rebuild those controls even though
      // they do not carry assistant text.
      notifyRunState(event, options, run);
      return;
    default:
      return;
  }
};

const flushAIRunReplayDeltas = (
  replay: ReplayRunProjection,
  options: UseAIChatRunEventSubscriptionOptions,
  runId: string,
): void => {
  if (replay.pendingModelEvents.length === 0) return;
  const suppressText = replay.liveModelProjectionSeen
    || replay.completedTurns < replay.durableAssistantTurns;
  if (!suppressText) {
    for (const pending of replay.pendingModelEvents) {
      applyAIRunEvent(pending, options);
    }
  } else {
    // Even when text is suppressed, intents may be needed to render a pending
    // approval card whose event was emitted after the delta.
    let run = projectedRuns.get(runId);
    if (!run) {
      run = createProjectedRun();
      projectedRuns.set(runId, run);
    }
    for (const pending of replay.pendingModelEvents) {
      rememberToolIntents(run, payloadObject<AIRunModelDeltaPayload>(pending));
    }
  }
  replay.pendingModelEvents = [];
};

const rememberReplayCompletion = (
  replay: ReplayRunProjection,
  event: AIRunEvent,
): boolean => {
  if (event.kind !== 'model_completed' || replay.completedEventSequences.has(event.sequence)) {
    return false;
  }
  replay.completedEventSequences.add(event.sequence);
  replay.completedTurns += 1;
  return true;
};

/**
 * Project an event read during initial session hydration. Model deltas are
 * held until their model_completed boundary, because only that boundary tells
 * us whether the assistant message is already durable. Control events can be
 * rebuilt immediately without touching the conversation transcript.
 */
const applyAIRunReplayEvent = (
  event: AIRunEvent,
  replay: ReplayRunProjection,
  options: UseAIChatRunEventSubscriptionOptions,
): void => {
  let run = projectedRuns.get(event.runId);
  if (!run) {
    run = createProjectedRun();
    projectedRuns.set(event.runId, run);
  }

  if (event.kind === 'model_delta') {
    replay.pendingModelEvents.push(event);
    rememberToolIntents(run, payloadObject<AIRunModelDeltaPayload>(event));
    return;
  }

  if (event.kind === 'model_completed') {
    const payload = payloadObject<AIRunModelCompletedPayload>(event);
    rememberReplayCompletion(replay, event);
    const suppressText = replay.liveModelProjectionSeen
      || replay.completedTurns <= replay.durableAssistantTurns;

    if (suppressText) {
      // Preserve tool metadata and the turn boundary, but do not append the
      // already durable assistant content a second time.
      for (const pending of replay.pendingModelEvents) {
        rememberToolIntents(run, payloadObject<AIRunModelDeltaPayload>(pending));
      }
      rememberToolIntents(run, payload);
      const toolCalls = normalizeToolCalls(payload);
      // Tool intents are needed for approval cards, but all model turns in a
      // run belong to the same assistant UI row.
      if (toolCalls.length > 0) rememberToolIntents(run, payload);
      applyAIRunControlProjection(event, options);
    } else {
      for (const pending of replay.pendingModelEvents) {
        applyAIRunEvent(pending, options);
      }
      applyAIRunEvent(event, options);
    }

    replay.pendingModelEvents = [];
    return;
  }

  // A terminal can race the final model_completed event. Keep a visible
  // partial response when it is not already represented by a durable turn.
  if (event.kind === 'terminal' || (
    event.kind === 'run_error' && isAIRunTerminalState(event.resultingState)
  )) {
    flushAIRunReplayDeltas(replay, options, event.runId);
    applyAIRunEvent(event, options);
    return;
  }

  if (event.kind === 'run_error') {
    // Preserve the detailed non-terminal error for the terminal event that
    // follows it. The latter carries only a stable reason/error code, while
    // the former contains the provider's actionable failure message.
    applyAIRunEvent(event, options);
    return;
  }

  // Input/tool/approval/checkpoint events carry no assistant text that
  // needs replaying. Rebuild their state and control cards only.
  applyAIRunControlProjection(event, options);
};

const applyAIRunEvent = (
  event: AIRunEvent,
  options: UseAIChatRunEventSubscriptionOptions,
): void => {
  let run = projectedRuns.get(event.runId);
  if (!run) {
    run = createProjectedRun();
    projectedRuns.set(event.runId, run);
  }

  switch (event.kind) {
    case 'input':
      // Receipt creation only proves that the Ledger accepted the request.
      // The input event means the worker has actually entered the model step.
      const { messageId } = ensureAssistantMessage(event, options);
      recordRunActivity(event, run, options, messageId);
      options.updateAIChatMessage(event.sessionId, messageId, {
        phase: 'thinking',
        loading: true,
      });
      if (event.sessionId === options.sid && !isAIRunTerminalState(event.resultingState)) {
        options.setSending(true);
      }
      notifyRunState(event, options, run);
      return;
    case 'model_delta': {
      const { messageId } = ensureAssistantMessage(event, options);
      recordRunActivity(event, run, options, messageId);
      const payload = payloadObject<AIRunModelDeltaPayload>(event);
      rememberToolIntents(run, payload);
      const current = findMessage(event.sessionId, messageId);
      if (!current) return;
      run.modelText += String(payload.text || '');
      run.modelReasoning += String(payload.reasoning || '');
      options.updateAIChatMessage(event.sessionId, messageId, {
        content: appendModelTurn(run.completedModelText, run.modelText),
        ...(run.modelReasoning
          ? { reasoning_content: appendModelTurn(run.completedModelReasoning, run.modelReasoning) }
          : {}),
        phase: payload.reasoning && !payload.text ? 'thinking' : 'generating',
        loading: true,
      });
      return;
    }
    case 'model_completed': {
      const { messageId } = ensureAssistantMessage(event, options);
      recordRunActivity(event, run, options, messageId);
      const payload = payloadObject<AIRunModelCompletedPayload>(event);
      rememberToolIntents(run, payload);
      const current = findMessage(event.sessionId, messageId);
      const patch: Partial<AIChatMessage> = {};
      run.modelText = completedValue(run.modelText, payload.text);
      if (payload.reasoning !== undefined) {
        run.modelReasoning = completedValue(run.modelReasoning, payload.reasoning);
      }
      run.completedModelText = appendModelTurn(run.completedModelText, run.modelText);
      run.completedModelReasoning = appendModelTurn(run.completedModelReasoning, run.modelReasoning);
      run.modelText = '';
      run.modelReasoning = '';
      run.hasCompletedModelTurn = true;
      patch.content = run.completedModelText || current?.content || '';
      if (run.completedModelReasoning) patch.reasoning_content = run.completedModelReasoning;
      const toolCalls = normalizeToolCalls(payload);
      if (toolCalls.length > 0) {
        patch.tool_calls = mergeToolCalls(current?.tool_calls, toolCalls);
        patch.phase = 'tool_calling';
      } else {
        patch.phase = 'generating';
      }
      patch.loading = true;
      if (!current) return;
      options.updateAIChatMessage(event.sessionId, messageId, patch);
      notifyRunState(event, options, run);
      return;
    }
    case 'tool': {
      recordRunActivity(event, run, options);
      const messageId = run.assistantMessageId;
      if (messageId) {
        options.updateAIChatMessage(event.sessionId, messageId, {
          phase: 'tool_calling',
          loading: true,
        });
      }
      const payload = payloadObject<AIRunToolPayload>(event);
      if (event.resultingState === 'recovery_required' || String(payload.status || '').toLowerCase() === 'unknown') {
        options.onRecoveryChange?.(event.runId, toRecoveryState(event, payload, run));
      } else {
        options.onRecoveryChange?.(event.runId, null);
      }
      notifyRunState(event, options, run);
      return;
    }
    case 'approval': {
      recordRunActivity(event, run, options);
      const messageId = run.assistantMessageId;
      if (messageId) {
        options.updateAIChatMessage(event.sessionId, messageId, {
          phase: 'tool_calling',
          loading: true,
        });
      }
      const payload = payloadObject<AIRunApprovalPayload>(event);
      const approval = toApprovalState(event, payload);
      if (approval && approval.decision === 'pending') {
        options.onApprovalChange?.(event.runId, approval);
      } else {
        options.onApprovalChange?.(event.runId, null);
      }
      notifyRunState(event, options, run);
      return;
    }
    case 'run_error': {
      run.lastError = payloadObject<AIRunErrorPayload>(event);
      if (!isAIRunTerminalState(event.resultingState)) recordRunActivity(event, run, options);
      const current = run.assistantMessageId ? findMessage(event.sessionId, run.assistantMessageId) : undefined;
      if (current && run.lastError.message) {
        options.updateAIChatMessage(event.sessionId, current.id, { rawError: run.lastError.message });
      }
      if (event.resultingState === 'recovery_required') {
        options.onRecoveryChange?.(event.runId, toRecoveryState(event, run.lastError, run));
      } else if (!isAIRunTerminalState(event.resultingState)) {
        options.onRecoveryChange?.(event.runId, null);
      }
      if (isAIRunTerminalState(event.resultingState)) applyTerminal(event, run, options);
      else notifyRunState(event, options, run);
      return;
    }
    case 'terminal':
      applyTerminal(event, run, options);
      return;
    case 'usage':
      notifyRunState(event, options, run);
      return;
    case 'checkpoint':
      recordRunActivity(event, run, options);
      notifyRunState(event, options, run);
      return;
    default:
      return;
  }
};

export const useAIChatRunEventSubscription = (options: UseAIChatRunEventSubscriptionOptions): void => {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const subscribedSessionRef = useRef<string | null>(null);
  const trackedRunKey = [...(options.trackedRunIds || [])].sort().join('|');

  useEffect(() => {
    let disposed = false;
    // `sending` is a projection of the selected session, not a global harness
    // lock. Session bootstrap below turns it back on when that session owns a
    // non-terminal run.
    if (subscribedSessionRef.current !== options.sid) {
      subscribedSessionRef.current = options.sid;
      optionsRef.current.setSending(false);
    }
    const tracker = sharedAIRunEventSequenceTracker;
    const pendingByRun = new Map<string, Map<number, AIRunEvent>>();
    const recoveryByRun = new Map<string, Promise<void>>();
    const recoveryRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const recoveryRetryAttempts = new Map<string, number>();
    const replayByRun = new Map<string, ReplayRunProjection>();
    const sessionByRun = new Map<string, string>();

    let recover: (runId: string, replay?: ReplayRunProjection) => void;

    const clearRecoveryRetry = (runId: string): void => {
      const timer = recoveryRetryTimers.get(runId);
      if (timer !== undefined) clearTimeout(timer);
      recoveryRetryTimers.delete(runId);
      recoveryRetryAttempts.delete(runId);
    };

    const scheduleRecoveryRetry = (runId: string, replay?: ReplayRunProjection): void => {
      if (disposed || recoveryRetryTimers.has(runId)) return;
      const attempt = recoveryRetryAttempts.get(runId) || 0;
      recoveryRetryAttempts.set(runId, attempt + 1);
      const delay = Math.min(
        AI_RUN_EVENT_RECOVERY_RETRY_MAX_MS,
        AI_RUN_EVENT_RECOVERY_RETRY_BASE_MS * (2 ** Math.min(attempt, 10)),
      );
      const timer = setTimeout(() => {
        recoveryRetryTimers.delete(runId);
        recover(runId, replayByRun.get(runId) || replay);
      }, delay);
      recoveryRetryTimers.set(runId, timer);
    };

    const bufferEvent = (event: AIRunEvent) => {
      let pending = pendingByRun.get(event.runId);
      if (!pending) {
        pending = new Map();
        pendingByRun.set(event.runId, pending);
      }
      pending.set(event.sequence, event);
    };

    const accept = (event: AIRunEvent, replay?: ReplayRunProjection) => {
      const decision = tracker.observe(event);
      if (decision.disposition === 'accepted') {
        sessionByRun.set(event.runId, event.sessionId);
        if (replay) {
          applyAIRunReplayEvent(event, replay, optionsRef.current);
        } else {
          const activeReplay = replayByRun.get(event.runId);
          if (activeReplay && (event.kind === 'model_delta' || event.kind === 'model_completed')) {
            activeReplay.liveModelProjectionSeen = true;
          }
          applyAIRunEvent(event, optionsRef.current);
        }
        if (isAIRunTerminalState(event.resultingState)) {
          clearRecoveryRetry(event.runId);
          pendingByRun.delete(event.runId);
        } else if (isAIRunReconciliationState(event.resultingState)) {
          // Wails runtime events are best-effort. While a run is active, keep
          // checking the durable snapshot at a bounded backoff so a dropped
          // terminal event cannot leave the chat permanently sending.
          scheduleRecoveryRetry(event.runId);
        }
      } else if (decision.disposition === 'gap') {
        bufferEvent(event);
        recover(event.runId, replay);
      } else if (replay) {
        // Duplicate/late events are expected when rebuilding a second view;
        // only project approval/recovery state and never replay chat text.
        rememberReplayCompletion(replay, event);
        applyAIRunControlProjection(event, optionsRef.current);
      }
    };

    const drainPending = (runId: string, replay?: ReplayRunProjection) => {
      const pending = pendingByRun.get(runId);
      if (!pending) return;
      let progressed = true;
      while (progressed) {
        progressed = false;
        const next = pending.get(tracker.lastSequence(runId) + 1);
        if (!next) continue;
        pending.delete(next.sequence);
        accept(next, replay);
        progressed = true;
      }
      if (pending.size === 0) pendingByRun.delete(runId);
    };

    recover = (runId: string, replay?: ReplayRunProjection): void => {
      if (recoveryByRun.has(runId) || recoveryRetryTimers.has(runId)) return;
      const readRun = getAIRunHarnessService()?.AIReadAgentRun;
      if (!readRun) {
        scheduleRecoveryRetry(runId, replay);
        return;
      }
      const recovery = (async () => {
        let page = 0;
        let hasMore = true;
        let readSucceeded = false;
        let replayAfter = replay ? 0 : tracker.lastSequence(runId);
        let latestSnapshotState: AIRunState | undefined;
        while (!disposed && hasMore && page < 20) {
          page += 1;
          const before = replay ? replayAfter : tracker.lastSequence(runId);
          let result: RunReadResult | undefined;
          try {
            result = await readAgentRun({ runId, afterSequence: before, limit: 500 });
          } catch {
            if (!disposed) scheduleRecoveryRetry(runId, replay);
            return;
          }
          readSucceeded = true;
          // The component may have been unmounted while the Ledger read was
          // in flight. Do not project replayed events into a stale store view.
          if (disposed) return;
          const events = Array.isArray(result?.events) ? result!.events : [];
          const parsed = events
            .map(parseAIRunEvent)
            .filter((event): event is AIRunEvent => Boolean(event))
            .sort((left, right) => left.sequence - right.sequence);
          for (const event of parsed) accept(event, replay);
          const snapshot = result?.run;
          const snapshotState = String(snapshot?.state || '').trim() as AIRunState;
          if (snapshotState) latestSnapshotState = snapshotState;
          if (isAIRunTerminalState(snapshotState)) {
            const sessionId = String(
              snapshot?.sessionId || sessionByRun.get(runId) || optionsRef.current.sid,
            ).trim();
            const run = projectedRuns.get(runId);
            if (sessionId && !run?.terminalHandled) {
              const revision = Number(snapshot?.revision);
              const attempt = Number(snapshot?.attempt);
              const sessionGeneration = Number(snapshot?.sessionGeneration);
              const terminalEvent: AIRunEvent = {
                schemaVersion: 1,
                runId,
                sessionId,
                sessionGeneration: Number.isSafeInteger(sessionGeneration) && sessionGeneration >= 0
                  ? sessionGeneration
                  : 0,
                // A snapshot is authoritative but has no durable event payload
                // to consume. Advance the local cursor by one so delayed
                // runtime callbacks remain late after the terminal projection.
                sequence: tracker.lastSequence(runId) + 1,
                runRevision: Number.isSafeInteger(revision) && revision >= 0
                  ? revision
                  : tracker.lastSequence(runId),
                attempt: Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0,
                timestamp: typeof snapshot?.updatedAt === 'string' || typeof snapshot?.updatedAt === 'number'
                  ? snapshot.updatedAt
                  : Date.now(),
                kind: 'terminal',
                resultingState: snapshotState,
                payload: {
                  reason: String(snapshot?.terminalReason || snapshotState),
                },
              };
              accept(terminalEvent, replay);
            }
          }
          const lastReadSequence = parsed.length > 0
            ? parsed[parsed.length - 1].sequence
            : before;
          if (replay) replayAfter = lastReadSequence;
          hasMore = result?.hasMore === true && lastReadSequence > before;
          if (isAIRunTerminalState(snapshotState)) hasMore = false;
          if (lastReadSequence === before) break;
        }
        if (!disposed && replay) flushAIRunReplayDeltas(replay, optionsRef.current, runId);
        if (!disposed) {
          drainPending(runId, replay);
          if (readSucceeded && latestSnapshotState && isAIRunReconciliationState(latestSnapshotState)) {
            scheduleRecoveryRetry(runId, replay);
          } else if (readSucceeded && !pendingByRun.has(runId)) {
            clearRecoveryRetry(runId);
          } else if (pendingByRun.has(runId)) {
            scheduleRecoveryRetry(runId, replay);
          }
        }
      })().finally(() => {
        recoveryByRun.delete(runId);
      });
      recoveryByRun.set(runId, recovery);
    };

    const bootstrapSession = async (): Promise<void> => {
      const sessionId = optionsRef.current.sid;
      const service = getAIRunHarnessService();
      if (!sessionId || sessionId === 'session-fallback' || !service?.AIReadAgentSession) return;
      try {
        const projection = await readAgentSession({ sessionId, limit: 10_000 }, service);
        if (disposed || optionsRef.current.sid !== sessionId) return;
        const durableAssistantTurnsByRun = new Map<string, number>();
        for (const rawMessage of Array.isArray(projection.messages) ? projection.messages : []) {
          if (!rawMessage || typeof rawMessage !== 'object' || Array.isArray(rawMessage)) continue;
          const message = rawMessage as Record<string, unknown>;
          if (String(message.role || '').trim() !== 'assistant') continue;
          const runId = String(message.runId || message.RunID || '').trim();
          if (!runId) continue;
          durableAssistantTurnsByRun.set(
            runId,
            (durableAssistantTurnsByRun.get(runId) || 0) + 1,
          );
        }
        const durable = toAIChatMessages(projection);
        // An explicit empty durable transcript is authoritative too: it must
        // clear terminal/error placeholders left only in the local projection.
        if (Array.isArray(projection.messages)) {
          useStore.setState((state) => ({
            aiChatHistory: {
              ...state.aiChatHistory,
              [sessionId]: mergeAIChatSessionMessages(
                durable,
                state.aiChatHistory[sessionId] || [],
              ),
            },
          }));
        }
        for (const item of Array.isArray(projection.runs) ? projection.runs : []) {
          const runId = String(item?.runId || item?.id || '').trim();
          const state = String(item?.state || '') as AIRunState;
          const revision = Number(item?.revision || 0);
          if (!runId) continue;
          notifyRunSnapshot(runId, state, revision, optionsRef.current);
          if (!isAIRunTerminalState(state)) {
            optionsRef.current.setSending(true);
          }
          if (!isAIRunTerminalState(state) || state === 'failed' || state === 'exhausted') {
            // The shared event cursor may already have been consumed by the
            // docked view. Replay control events from sequence zero so a newly
            // mounted view can still render approval/recovery cards. Failed
            // runs are replayed too: a terminal event may have been lost while
            // the panel was open, and its detailed error is not a durable chat
            // message that session hydration can reconstruct by itself.
            const replay = createReplayRunProjection(
              durableAssistantTurnsByRun.get(runId) || 0,
            );
            replayByRun.set(runId, replay);
            recover(runId, replay);
          }
        }
      } catch {
        // A new local session does not exist in the Ledger until its first
        // SubmitInput. Treat that as an empty projection.
      }
    };

    const handler = (...args: unknown[]) => {
      const raw = args.length === 1 ? args[0] : args;
      const event = parseAIRunEvent(raw) || parseAIRunEvent(args[0]);
      if (!event || disposed) return;
      const currentOptions = optionsRef.current;
      if (
        event.sessionId !== currentOptions.sid
        && !currentOptions.isRunTracked?.(event.runId, event.sessionId)
      ) return;
      accept(event);
    };

    const unsubscribe = EventsOn(AI_RUN_EVENT_NAME, handler);
    void bootstrapSession();
    return () => {
      disposed = true;
      for (const timer of recoveryRetryTimers.values()) clearTimeout(timer);
      recoveryRetryTimers.clear();
      recoveryRetryAttempts.clear();
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [options.sid, trackedRunKey]);
};
