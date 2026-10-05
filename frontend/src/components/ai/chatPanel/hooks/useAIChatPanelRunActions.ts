import React, { useCallback } from 'react';
import {
  type AIRunHarnessService,
  readAgentRun,
  readAgentSession,
  controlAgentRun,
  getAIRunHarnessService,
  type AIRunDispatchMode,
  hasAIRunHarness,
  submitAgentInput,
  createRunPendingMessageId,
} from '../../aiRunHarnessClient';
import {
  positiveRevision,
  isRevisionConflictError,
  genId,
  isTerminalRunState,
  hasTerminalRunError,
} from '../aiChatPanelRunState';
import { useAIChatApprovalDecision } from '../../useAIChatApprovalDecision';
import type { AIRunRecoveryState, AIRunWorkspaceState } from '../../aiRunEventProjection';
import type { AIRunRecoveryAction } from '../../AIChatRunControls';
import type { AIChatAttachment, AIChatMessage } from '../../../../types';
import {
  prepareAIWorkspaceSnapshotForChat,
  getAIWorkspaceSourceInstanceID,
} from '../../useAIWorkspaceSnapshot';
import { toAgentAttachments, isOcrPending } from '../../aiAgentAttachments';
import { useStore } from '../../../../store';
import { useAIInjectedPrompt } from '../../useAIInjectedPrompt';
import { isTransientContextItem, buildContextChipAttachments } from '../../aiContextChips';
import { buildAIChatReadinessSnapshot } from '../../aiChatReadiness';
import { composerNoticeDescriptorFor } from '../../composerNoticeForReadiness';
import { consumeAIChatSendShortcutOnKeyDown } from '../../../../utils/aiChatSendShortcut';
import type { AIChatPanelStateApi } from './useAIChatPanelState';
import type { AIChatPanelProps } from '../../../AIChatPanel';

export interface UseAIChatPanelRunActionsInput {
  activeRunsRef: AIChatPanelStateApi['activeRunsRef'];
  sid: AIChatPanelStateApi['sid'];
  setRunStateVersion: AIChatPanelStateApi['setRunStateVersion'];
  harnessServiceRef: AIChatPanelStateApi['harnessServiceRef'];
  setRunControlBusyKey: AIChatPanelStateApi['setRunControlBusyKey'];
  refreshRunProjection: AIChatPanelStateApi['refreshRunProjection'];
  addAIChatMessage: AIChatPanelStateApi['addAIChatMessage'];
  t: AIChatPanelStateApi['t'];
  activeProvider: AIChatPanelStateApi['activeProvider'];
  thinkingIntensity: AIChatPanelStateApi['thinkingIntensity'];
  activeRunIdRef: AIChatPanelStateApi['activeRunIdRef'];
  setAIActiveSessionId: AIChatPanelStateApi['setAIActiveSessionId'];
  hydrateSessionProjection: AIChatPanelStateApi['hydrateSessionProjection'];
  setSending: AIChatPanelStateApi['setSending'];
  interactionDisabled: Exclude<AIChatPanelProps['interactionDisabled'], undefined>;
  dynamicModels: AIChatPanelStateApi['dynamicModels'];
  loadingModels: AIChatPanelStateApi['loadingModels'];
  activeContext: AIChatPanelStateApi['activeContext'];
  aiContexts: AIChatPanelStateApi['aiContexts'];
  setInput: AIChatPanelStateApi['setInput'];
  textareaRef: AIChatPanelStateApi['textareaRef'];
  setComposerNoticeState: AIChatPanelStateApi['setComposerNoticeState'];
  setActivePanelMode: AIChatPanelStateApi['setActivePanelMode'];
  sending: AIChatPanelStateApi['sending'];
  orderedAISessions: AIChatPanelStateApi['orderedAISessions'];
  input: AIChatPanelStateApi['input'];
  draftAttachments: AIChatPanelStateApi['draftAttachments'];
  setDraftAttachments: AIChatPanelStateApi['setDraftAttachments'];
  hasActiveRun: AIChatPanelStateApi['hasActiveRun'];
  messages: AIChatPanelStateApi['messages'];
  pendingConversationBranchRef: AIChatPanelStateApi['pendingConversationBranchRef'];
  dispatchMode: AIChatPanelStateApi['dispatchMode'];
  aiChatSendShortcutBinding: AIChatPanelStateApi['aiChatSendShortcutBinding'];
}

export const useAIChatPanelRunActions = ({
  activeRunsRef, sid, setRunStateVersion, harnessServiceRef, setRunControlBusyKey,
  refreshRunProjection, addAIChatMessage, t, activeProvider, thinkingIntensity, activeRunIdRef,
  setAIActiveSessionId, hydrateSessionProjection, setSending, interactionDisabled, dynamicModels,
  loadingModels, activeContext, aiContexts, setInput, textareaRef, setComposerNoticeState,
  setActivePanelMode, sending, orderedAISessions, input, draftAttachments, setDraftAttachments,
  hasActiveRun, messages, pendingConversationBranchRef, dispatchMode, aiChatSendShortcutBinding,
}: UseAIChatPanelRunActionsInput) => {
  const resolveRunRevision = useCallback(async (
      runId: string,
      knownRevision: unknown,
      service: AIRunHarnessService | undefined,
  ): Promise<number> => {
      const currentRevision = positiveRevision(knownRevision);
      if (currentRevision > 0) return currentRevision;
      if (!service?.AIReadAgentRun) {
          throw new Error('AI agent run revision is unavailable');
      }
      const projection = await readAgentRun({ runId, afterSequence: 0, limit: 1 }, service);
      const revision = positiveRevision(projection?.run?.revision);
      if (revision <= 0) {
          throw new Error('AI agent run revision is unavailable');
      }
      const previous = activeRunsRef.current.get(runId);
      const state = String(projection?.run?.state || previous?.state || 'queued').trim() || 'queued';
      const sessionId = String(projection?.run?.sessionId || previous?.sessionId || sid).trim() || undefined;
      activeRunsRef.current.set(runId, { state, revision, sessionId });
      setRunStateVersion((version) => version + 1);
      return revision;
  }, [sid]);

  const resolveSessionRevision = useCallback(async (
      sessionId: string,
      knownRevision: unknown,
      service: AIRunHarnessService | undefined,
  ): Promise<number> => {
      const currentRevision = positiveRevision(knownRevision);
      if (currentRevision > 0) return currentRevision;
      if (!service?.AIReadAgentSession) {
          throw new Error('AI agent session revision is unavailable');
      }
      const projection = await readAgentSession({ sessionId, limit: 1 }, service);
      const revision = positiveRevision(projection?.revision);
      if (revision <= 0) {
          throw new Error('AI agent session revision is unavailable');
      }
      return revision;
  }, []);

  const handleRunControl = useCallback(async (
      runId: string,
      action: Parameters<typeof controlAgentRun>[0]['action'],
      extra: {
          approvalId?: string;
          callId?: string;
          argsHash?: string;
          busyKey: string;
      },
  ): Promise<void> => {
      const service = harnessServiceRef.current || getAIRunHarnessService();
      harnessServiceRef.current = service;
      const run = activeRunsRef.current.get(runId);
      if (!service?.AIControlAgentRun || !run) return;
      const sessionId = run.sessionId || sid;
      setRunControlBusyKey(extra.busyKey);
      try {
          if ((action === 'approve' || action === 'deny') && !String(extra.argsHash || '').trim()) {
              throw new Error('AI agent approval arguments hash is unavailable');
          }
          const expectedRevision = await resolveRunRevision(runId, run.revision, service);
          const snapshot = await controlAgentRun({
              requestId: `agent-control-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              runId,
              sessionId,
              action,
              ...(extra.approvalId ? { approvalId: extra.approvalId } : {}),
              ...(extra.callId ? { callId: extra.callId } : {}),
              ...(extra.argsHash ? { argsHash: extra.argsHash } : {}),
              expectedRevision,
          }, service);
          const nextState = String(snapshot?.state || '').trim();
          const nextRevision = Number(snapshot?.revision || 0);
          if (nextState || nextRevision > 0) {
              activeRunsRef.current.set(runId, {
                  ...run,
                  ...(nextState ? { state: nextState } : {}),
                  ...(nextRevision > 0 ? { revision: nextRevision } : {}),
              });
              setRunStateVersion((version) => version + 1);
          }
      } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          if (isRevisionConflictError(error)) {
              void refreshRunProjection(runId, sessionId, service);
          }
          addAIChatMessage(sessionId, {
              id: genId(),
              role: 'assistant',
              content: t('ai_chat.run.control.failed', { detail }),
              rawError: detail,
              timestamp: Date.now(),
              loading: false,
              phase: 'idle',
              excludeFromAIContext: true,
          });
      } finally {
          setRunControlBusyKey(null);
      }
  }, [addAIChatMessage, refreshRunProjection, resolveRunRevision, sid, t]);

  const handleApprovalDecision = useAIChatApprovalDecision(handleRunControl);

  const handleRecoveryAction = useCallback((
      recovery: AIRunRecoveryState,
      action: AIRunRecoveryAction,
  ) => {
      void handleRunControl(recovery.runId, action, {
          callId: recovery.callId,
          busyKey: `${recovery.runId}:${action}`,
      });
  }, [handleRunControl]);

  const handleWorkspaceAction = useCallback((
      workspace: AIRunWorkspaceState,
  ) => {
      void handleRunControl(workspace.runId, 'use_stale_workspace', {
          busyKey: `${workspace.runId}:use_stale_workspace`,
      });
  }, [handleRunControl]);

  const submitHarnessRun = useCallback(async (
      content: string,
      attachments: AIChatAttachment[],
      sessionId?: string,
      mode: AIRunDispatchMode = 'queue',
      expectedRevision?: number,
      branchFromMessageId?: string,
  ) => {
      const service = getAIRunHarnessService();
      harnessServiceRef.current = service;
      if (!hasAIRunHarness(service)) {
          throw new Error('AISubmitAgentInput is unavailable');
      }
      const resolvedRevision = sessionId
          ? await resolveSessionRevision(sessionId, expectedRevision, service)
          : undefined;
      await prepareAIWorkspaceSnapshotForChat();
      const receipt = await submitAgentInput({
          requestId: `agent-input-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ...(sessionId ? { sessionId } : {}),
          ...(branchFromMessageId ? { branchFromMessageId } : {}),
          content,
          attachments: toAgentAttachments(attachments),
          dispatchMode: mode,
          contextSourceId: 'desktop',
          contextSourceInstanceId: getAIWorkspaceSourceInstanceID(),
          provider: String(activeProvider?.id || '').trim() || undefined,
          model: String(activeProvider?.model || '').trim() || undefined,
          thinking: String(thinkingIntensity || '').trim() || undefined,
          ...(resolvedRevision ? { expectedRevision: resolvedRevision } : {}),
      }, service);
      const receiptRunId = String(receipt.runId || '').trim();
      const receiptSessionId = String(receipt.sessionId || sessionId || '').trim();
      const receiptState = String(receipt.state || 'queued').trim() || 'queued';
      const previousRun = receiptRunId ? activeRunsRef.current.get(receiptRunId) : undefined;
      // Events and the SubmitInput receipt are delivered independently. A
      // terminal event may win the race; never let its later receipt regress
      // the run back to queued/connecting.
      const effectiveState = previousRun && isTerminalRunState(previousRun.state)
          ? previousRun.state
          : receiptState;
      if (receiptRunId) {
          activeRunsRef.current.set(receiptRunId, {
              state: effectiveState,
              revision: Math.max(Number(receipt.revision || 0), previousRun?.revision || 0),
              sessionId: receiptSessionId || previousRun?.sessionId,
          });
          activeRunIdRef.current = receiptRunId;
          setRunStateVersion((version) => version + 1);
      }
      if (receiptSessionId && receiptSessionId !== sid) {
          setAIActiveSessionId(receiptSessionId);
      }
      if (receiptSessionId && receiptRunId) {
          const sessionMessages = useStore.getState().aiChatHistory[receiptSessionId] || [];
          const hasRunPendingAssistant = sessionMessages.some((message) => message.role === 'assistant'
              && message.runId === receiptRunId
              && message.loading === true);
          const hasRunTerminalError = sessionMessages.some((message) => hasTerminalRunError(message, receiptRunId));
          if (!isTerminalRunState(effectiveState) && !hasRunTerminalError && !hasRunPendingAssistant) {
              addAIChatMessage(receiptSessionId, {
                  id: createRunPendingMessageId(receiptRunId),
                  runId: receiptRunId,
                  role: 'assistant',
                  content: '',
                  // SubmitInput has acknowledged this run, but the worker
                  // has not yet entered its model step.
                  phase: 'queued',
                  timestamp: Date.now(),
                  loading: true,
              });
          }
      }
      if (receiptSessionId) {
          void hydrateSessionProjection(receiptSessionId, service);
      }
      if (isTerminalRunState(effectiveState)) {
          setSending(false);
      }
      return receipt;
  }, [activeProvider?.id, activeProvider?.model, addAIChatMessage, hydrateSessionProjection, resolveSessionRevision, setAIActiveSessionId, sid, thinkingIntensity]);

  useAIInjectedPrompt({
      interactionDisabled,
      activeProvider,
      dynamicModels,
      loadingModels,
      activeContext,
      aiContexts,
      setInput,
      focusInput: () => { textareaRef.current?.focus(); },
      setComposerNoticeState,
      setSending,
      setActivePanelMode,
      addAIChatMessage,
      activeSessionId: sid,
      t,
      submitHarnessRun,
  });

  const handleRetryMessage = useCallback(async (msg: AIChatMessage) => {
      if (sending || interactionDisabled || msg.excludeFromAIContext === true) return;
      const history = useStore.getState().aiChatHistory[sid] || [];
      const messageIndex = history.findIndex((message) => message.id === msg.id);
      if (messageIndex < 0) return;
      const userMessage = [...history.slice(0, messageIndex)]
          .reverse()
          .find((message) => message.role === 'user');
      if (!userMessage) return;
      const durableSession = orderedAISessions.find((session) => session.id === sid);
      if (sid === 'session-fallback' || !String(userMessage.id || '').trim()) return;
      const expectedRevision = positiveRevision(durableSession?.revision);
      setSending(true);
      try {
          await submitHarnessRun(
              userMessage.content,
              userMessage.attachments || [],
              sid,
              'queue',
              expectedRevision,
              userMessage.id,
          );
      } catch (error) {
          console.error('Failed to retry AI agent run', error);
          setSending(false);
          addAIChatMessage(sid, {
              id: genId(),
              role: 'assistant',
              content: t('ai_chat.panel.message.send_failed', {
                  detail: error instanceof Error ? error.message : String(error),
              }),
              rawError: error instanceof Error ? error.message : String(error),
              timestamp: Date.now(),
              loading: false,
              phase: 'idle',
              excludeFromAIContext: true,
          });
      }
  }, [addAIChatMessage, interactionDisabled, orderedAISessions, sending, sid, submitHarnessRun, t]);

  const handleSend = useCallback(async () => {
      const connectionKey = activeContext?.connectionId ? `${activeContext.connectionId}:${activeContext.dbName || ''}` : 'default';
      // A bound editor selection is a message by itself: with nothing typed, ask the
      // obvious question about it (shown in the chat as the person's message).
      const boundItems = (aiContexts[connectionKey] || []).filter(isTransientContextItem);
      const onlyQuotes = boundItems.length > 0 && boundItems.every((item) => item.kind === 'chat_quote');
      const text = input.trim() || (boundItems.length > 0
          ? t(onlyQuotes ? 'ai_chat.input.default_quote_prompt' : 'ai_chat.input.default_selection_prompt')
          : '');
      if ((!text && draftAttachments.length === 0) || interactionDisabled || draftAttachments.some(isOcrPending)) return;
      // A running harness can still accept a durable queued input or a
      // high-priority steer. Keep the old guard only for a stale local
      // sending flag that has no active Ledger run behind it.
      if (sending && !hasActiveRun) return;

      const readiness = buildAIChatReadinessSnapshot({
          activeProvider,
          dynamicModels,
          loadingModels,
          activeContext,
          activeContextItems: aiContexts[connectionKey] || [],
      });

      const readinessNotice = composerNoticeDescriptorFor(readiness);
      setComposerNoticeState(readinessNotice);
      if (readinessNotice) return;

      // What is bound travels with the message so the chat can show it as chips.
      const currentAttachments = [...draftAttachments, ...buildContextChipAttachments(aiContexts[connectionKey] || [])];
      // Existing sessions are addressed by their durable ID. A newly opened
      // local session has no Ledger row yet; omitting the ID lets Go create
      // one atomically and return the canonical session ID.
      const durableSession = sid === 'session-fallback'
          ? undefined
          : orderedAISessions.find((session) => session.id === sid);
      const pendingBranch = pendingConversationBranchRef.current;
      const branch = pendingBranch?.sourceSessionId === sid ? pendingBranch : null;
      const targetSessionId = branch
          ? branch.sourceSessionId
          : durableSession?.id;
      const expectedRevision = branch?.sourceRevision ?? positiveRevision(durableSession?.revision);
      setInput('');
      setDraftAttachments([]);
      setSending(true);
      textareaRef.current?.focus();
      try {
          await submitHarnessRun(
              text,
              currentAttachments,
              targetSessionId,
              branch ? 'queue' : dispatchMode,
              expectedRevision,
              branch?.branchFromMessageId,
          );
          if (branch && pendingConversationBranchRef.current === branch) {
              pendingConversationBranchRef.current = null;
          }
          // What was bound for this message belongs to it (it shows as chips on the message):
          // clear it from the composer now that the message is on its way.
          boundItems.forEach((item) => useStore.getState().removeAIContext(connectionKey, item.dbName, item.tableName));
      } catch (error) {
          console.error('Failed to submit AI agent input', error);
          const detail = error instanceof Error ? error.message : String(error);
          setSending(false);
          addAIChatMessage(sid, {
              id: genId(),
              role: 'assistant',
              content: t('ai_chat.panel.message.send_failed', { detail }),
              rawError: detail,
              timestamp: Date.now(),
              loading: false,
              phase: 'idle',
              excludeFromAIContext: true,
          });
      }
  }, [
      input,
      draftAttachments,
      sending,
      interactionDisabled,
      messages,
      orderedAISessions,
      addAIChatMessage,
      sid,
      activeContext,
      activeProvider,
      aiContexts,
      dynamicModels,
      loadingModels,
      submitHarnessRun,
      t,
      thinkingIntensity,
      hasActiveRun,
      dispatchMode,
  ]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
      consumeAIChatSendShortcutOnKeyDown(aiChatSendShortcutBinding, event, handleSend);
  }, [aiChatSendShortcutBinding, handleSend]);
  return {
    resolveRunRevision, resolveSessionRevision, handleApprovalDecision, handleRecoveryAction,
    handleWorkspaceAction, handleRetryMessage, handleSend, handleKeyDown,
  };
};

export type AIChatPanelRunActionsApi = ReturnType<typeof useAIChatPanelRunActions>;
