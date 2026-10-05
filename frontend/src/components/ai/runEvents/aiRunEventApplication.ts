import type { AIChatMessage } from '../../../types';
import {
  type AIRunEvent,
  type AIRunModelDeltaPayload,
  type AIRunModelCompletedPayload,
  type AIRunToolPayload,
  type AIRunApprovalPayload,
  type AIRunErrorPayload,
  isAIRunTerminalState,
  type AIRunUsagePayload,
} from '../aiRunEventProjection';
import {
  type UseAIChatRunEventSubscriptionOptions,
  recordRunActivity,
  rememberToolIntents,
  notifyRunState,
  activityMessageIdFor,
  findMessage,
  normalizeToolCalls,
  ensureAssistantMessage,
} from './aiRunMessageProjection';
import {
  projectedRuns,
  createProjectedRun,
  payloadObject,
  type ReplayRunProjection,
} from './aiRunProjectionState';
import {
  projectRunTokenUsage,
  toRecoveryState,
  toApprovalState,
  hasTokenUsage,
  appendModelTurn,
  completedValue,
  mergeToolCalls,
  applyTerminal,
} from './aiRunStateProjection';

/**
 * Rebuild only the durable control projection while another view already owns
 * the shared event cursor. Replaying through applyAIRunEvent would append
 * model deltas a second time, so historical approval/recovery events use this
 * side-effect-free path instead.
 */
export const applyAIRunControlProjection = (
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
      {
        const payload = payloadObject<AIRunModelCompletedPayload>(event);
        rememberToolIntents(run, payload);
        run.lastModelCompletedHadUsage = projectRunTokenUsage(event, run, options, payload.usage);
      }
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
    case 'usage': {
      if (!run.lastModelCompletedHadUsage) {
        const payload = payloadObject<AIRunUsagePayload>(event);
        projectRunTokenUsage(event, run, options, payload.usage);
      }
      run.usageEventSequences.add(event.sequence);
      run.lastModelCompletedHadUsage = true;
      notifyRunState(event, options, run);
      return;
    }
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

export const flushAIRunReplayDeltas = (
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

export const rememberReplayCompletion = (
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
export const applyAIRunReplayEvent = (
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
      const durableMessage = activityMessageIdFor(event, run)
        ? findMessage(event.sessionId, run.assistantMessageId)
        : undefined;
      if (!hasTokenUsage(durableMessage?.tokenUsage)) {
        projectRunTokenUsage(event, run, options, payload.usage);
      }
      run.lastModelCompletedHadUsage = hasTokenUsage(payload.usage)
        || hasTokenUsage(durableMessage?.tokenUsage);
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

export const applyAIRunEvent = (
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
      run.lastModelCompletedHadUsage = projectRunTokenUsage(event, run, options, payload.usage);
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
    case 'usage': {
      if (!run.lastModelCompletedHadUsage) {
        const payload = payloadObject<AIRunUsagePayload>(event);
        projectRunTokenUsage(event, run, options, payload.usage);
      }
      run.usageEventSequences.add(event.sequence);
      run.lastModelCompletedHadUsage = true;
      notifyRunState(event, options, run);
      return;
    }
    case 'checkpoint':
      recordRunActivity(event, run, options);
      notifyRunState(event, options, run);
      return;
    default:
      return;
  }
};
