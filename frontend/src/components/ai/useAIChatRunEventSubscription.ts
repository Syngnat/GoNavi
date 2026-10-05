import { useEffect, useRef } from 'react';

import { EventsOn } from '../../../wailsjs/runtime';
import { useStore } from '../../store';
import {
  getAIRunHarnessService, mergeAIChatSessionMessages, readAgentRun, readAgentSession,
  toAIChatMessages, type RunReadResult,
} from './aiRunHarnessClient';
import {
  AI_RUN_EVENT_NAME, sharedAIRunEventSequenceTracker, isAIRunTerminalState, parseAIRunEvent,
  type AIRunEvent, type AIRunState,
} from './aiRunEventProjection';
import { buildAIRunSnapshotTerminalEvent, parseAIRunRecoveryPage } from './aiRunEventRecoveryPage';
import {
  type UseAIChatRunEventSubscriptionOptions,
  notifyRunSnapshot,
} from './runEvents/aiRunMessageProjection';
import {
  type ReplayRunProjection,
  AI_RUN_EVENT_RECOVERY_RETRY_MAX_MS,
  AI_RUN_EVENT_RECOVERY_RETRY_BASE_MS,
  isAIRunReconciliationState,
  projectedRuns,
  createReplayRunProjection,
} from './runEvents/aiRunProjectionState';
import {
  applyAIRunReplayEvent,
  applyAIRunEvent,
  rememberReplayCompletion,
  applyAIRunControlProjection,
  flushAIRunReplayDeltas,
} from './runEvents/aiRunEventApplication';
export type { UseAIChatRunEventSubscriptionOptions } from './runEvents/aiRunMessageProjection';
export {
  AI_RUN_EVENT_RECOVERY_RETRY_BASE_MS,
  AI_RUN_EVENT_RECOVERY_RETRY_MAX_MS,
  resetAIChatRunEventProjection,
} from './runEvents/aiRunProjectionState';

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
          const items = parseAIRunRecoveryPage(events, runId);
          for (const item of items) {
            if (item.event) {
              accept(item.event, replay);
            } else if (tracker.skipUnreadable(runId, item.sequence)) {
              console.warn('Skipped unreadable AI run event', runId, item.sequence);
            }
          }
          const snapshot = result?.run;
          const snapshotState = String(snapshot?.state || '').trim() as AIRunState;
          if (snapshotState) latestSnapshotState = snapshotState;
          if (isAIRunTerminalState(snapshotState)) {
            const sessionId = String(
              snapshot?.sessionId || sessionByRun.get(runId) || optionsRef.current.sid,
            ).trim();
            const run = projectedRuns.get(runId);
            if (sessionId && !run?.terminalHandled) {
              const terminalEvent = buildAIRunSnapshotTerminalEvent({
                runId,
                sessionId,
                snapshot,
                state: snapshotState,
                lastSequence: tracker.lastSequence(runId),
              });
              accept(terminalEvent, replay);
            }
          }
          const lastReadSequence = items.length > 0
            ? items[items.length - 1].sequence
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
