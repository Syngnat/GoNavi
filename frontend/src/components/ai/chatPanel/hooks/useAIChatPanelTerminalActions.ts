import React, { useCallback, useEffect, useMemo } from 'react';
import { isTerminalRunState, createRunStopFailureMessageId } from '../aiChatPanelRunState';
import {
  type AIRunHarnessService,
  getAIRunHarnessService,
  controlAgentRun,
  mutateAgentSession,
} from '../../aiRunHarnessClient';
import type { AIChatMessage } from '../../../../types';
import { useStore, type AIChatSessionSummary } from '../../../../store';
import {
  inferAIChatConnectionContext,
  collectAIChatContextTableNames,
  buildAIChatInsights,
  buildAIChatInlineHistorySessions,
  resolveAIChatPanelMode,
} from '../../aiChatPanelDerivedState';
import { buildRpcConnectionConfig } from '../../../../utils/connectionRpcConfig';
import { measureAIChatHistory } from '../../aiContextBreakdown';
import type { AIComposerNoticeAction } from '../../../../utils/aiComposerNotice';
import { useAIQuoteFromReply } from '../../useAIQuoteFromReply';
import type { AIChatPanelStateApi } from './useAIChatPanelState';
import type { AIChatPanelRunActionsApi } from './useAIChatPanelRunActions';
import type { AIChatPanelProps } from '../../../AIChatPanel';

export interface UseAIChatPanelTerminalActionsInput {
  activeRunsRef: AIChatPanelStateApi['activeRunsRef'];
  sid: AIChatPanelStateApi['sid'];
  stopRequestsInFlightRef: AIChatPanelStateApi['stopRequestsInFlightRef'];
  setStopRequestVersion: AIChatPanelStateApi['setStopRequestVersion'];
  deleteAIChatMessage: AIChatPanelStateApi['deleteAIChatMessage'];
  harnessServiceRef: AIChatPanelStateApi['harnessServiceRef'];
  resolveRunRevision: AIChatPanelRunActionsApi['resolveRunRevision'];
  setSending: AIChatPanelStateApi['setSending'];
  handleRunStateChange: AIChatPanelStateApi['handleRunStateChange'];
  refreshRunProjection: AIChatPanelStateApi['refreshRunProjection'];
  t: AIChatPanelStateApi['t'];
  updateAIChatMessage: AIChatPanelStateApi['updateAIChatMessage'];
  addAIChatMessage: AIChatPanelStateApi['addAIChatMessage'];
  interactionDisabled: Exclude<AIChatPanelProps['interactionDisabled'], undefined>;
  sending: AIChatPanelStateApi['sending'];
  pendingConversationBranchRef: AIChatPanelStateApi['pendingConversationBranchRef'];
  createNewAISession: AIChatPanelStateApi['createNewAISession'];
  setActivePanelMode: AIChatPanelStateApi['setActivePanelMode'];
  setAIActiveSessionId: AIChatPanelStateApi['setAIActiveSessionId'];
  setHistoryOpen: AIChatPanelStateApi['setHistoryOpen'];
  resolveSessionRevision: AIChatPanelRunActionsApi['resolveSessionRevision'];
  deleteAISession: AIChatPanelStateApi['deleteAISession'];
  onRegisterTerminalGuard: AIChatPanelProps['onRegisterTerminalGuard'];
  activeContext: AIChatPanelStateApi['activeContext'];
  orderedAISessions: AIChatPanelStateApi['orderedAISessions'];
  connections: AIChatPanelStateApi['connections'];
  messages: AIChatPanelStateApi['messages'];
  aiContexts: AIChatPanelStateApi['aiContexts'];
  sqlLogs: AIChatPanelStateApi['sqlLogs'];
  activePanelMode: AIChatPanelStateApi['activePanelMode'];
  setComposerNoticeState: AIChatPanelStateApi['setComposerNoticeState'];
  handleComposerAction: AIChatPanelStateApi['handleComposerAction'];
  handleModelChange: AIChatPanelStateApi['handleModelChange'];
  textareaRef: AIChatPanelStateApi['textareaRef'];
  presentation: Exclude<AIChatPanelProps['presentation'], undefined>;
}

export const useAIChatPanelTerminalActions = ({
  activeRunsRef, sid, stopRequestsInFlightRef, setStopRequestVersion, deleteAIChatMessage,
  harnessServiceRef, resolveRunRevision, setSending, handleRunStateChange, refreshRunProjection, t,
  updateAIChatMessage, addAIChatMessage, interactionDisabled, sending, pendingConversationBranchRef,
  createNewAISession, setActivePanelMode, setAIActiveSessionId, setHistoryOpen,
  resolveSessionRevision, deleteAISession, onRegisterTerminalGuard, activeContext,
  orderedAISessions, connections, messages, aiContexts, sqlLogs, activePanelMode,
  setComposerNoticeState, handleComposerAction, handleModelChange, textareaRef, presentation,
}: UseAIChatPanelTerminalActionsInput) => {
  const handleStop = useCallback(async () => {
      const candidate = Array.from(activeRunsRef.current.entries())
          .reverse()
          .find(([, run]) => run.sessionId === sid && !isTerminalRunState(run.state));
      if (!candidate) return;
      const [runId, run] = candidate;
      if (stopRequestsInFlightRef.current.has(runId)) return;
      stopRequestsInFlightRef.current.add(runId);
      setStopRequestVersion((version) => version + 1);
      const sessionId = run.sessionId || sid;
      const stopFailureMessageId = createRunStopFailureMessageId(runId);
      deleteAIChatMessage(sessionId, stopFailureMessageId);
      let service: AIRunHarnessService | undefined;
      try {
          service = harnessServiceRef.current || getAIRunHarnessService();
          harnessServiceRef.current = service;
          if (!service?.AIControlAgentRun) throw new Error('AIControlAgentRun is unavailable');
          const expectedRevision = await resolveRunRevision(runId, run.revision, service);
          setSending(true);
          const snapshot = await controlAgentRun({
              requestId: `agent-control-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              runId,
              sessionId,
              action: 'cancel',
              expectedRevision,
          }, service);
          const nextState = String(snapshot?.state || '').trim();
          const nextRevision = Number(snapshot?.revision || 0);
          const latestRevision = activeRunsRef.current.get(runId)?.revision || 0;
          if (nextState && nextRevision > 0 && nextRevision >= latestRevision) {
              handleRunStateChange(runId, nextState, nextRevision);
          }
      } catch (error) {
          console.warn('Failed to stop chat stream', error);
          // A failed bridge call can be either a definite rejection or an
          // ambiguous transport failure after the durable command committed.
          const refreshed = await refreshRunProjection(runId, sessionId, service);
          if (refreshed && (refreshed.state === 'canceling' || isTerminalRunState(refreshed.state))) {
              return;
          }
          const detail = error instanceof Error ? error.message : String(error);
          const failureMessage: AIChatMessage = {
              id: stopFailureMessageId,
              runId,
              role: 'assistant',
              content: t('ai_chat.panel.message.stop_failed', { detail }),
              rawError: detail,
              timestamp: Date.now(),
              loading: false,
              phase: 'idle',
              excludeFromAIContext: true,
          };
          const alreadyVisible = (useStore.getState().aiChatHistory[sessionId] || [])
              .some((message) => message.id === stopFailureMessageId);
          if (alreadyVisible) updateAIChatMessage(sessionId, stopFailureMessageId, failureMessage);
          else addAIChatMessage(sessionId, failureMessage);
      } finally {
          stopRequestsInFlightRef.current.delete(runId);
          setStopRequestVersion((version) => version + 1);
      }
  }, [addAIChatMessage, deleteAIChatMessage, handleRunStateChange, refreshRunProjection, resolveRunRevision, sid, t, updateAIChatMessage]);

  const handleCreateSession = useCallback(() => {
      if (sending || interactionDisabled) return;
      pendingConversationBranchRef.current = null;
      createNewAISession();
      setActivePanelMode('chat');
  }, [createNewAISession, interactionDisabled, sending]);

  const handleSelectSession = useCallback((sessionId: string) => {
      if (interactionDisabled) return;
      pendingConversationBranchRef.current = null;
      setAIActiveSessionId(sessionId);
      setActivePanelMode('chat');
      setHistoryOpen(false);
  }, [interactionDisabled, setAIActiveSessionId]);

  const handleArchiveSession = useCallback(async (session: AIChatSessionSummary) => {
      const sessionId = String(session.id || '').trim();
      if (!sessionId) return;
      const service = harnessServiceRef.current || getAIRunHarnessService();
      harnessServiceRef.current = service;
      if (service?.AIMutateAgentSession) {
          const expectedRevision = await resolveSessionRevision(sessionId, session.revision, service);
          await mutateAgentSession({
              sessionId,
              expectedRevision,
              archived: true,
          }, service);
      }
      deleteAISession(sessionId);
  }, [deleteAISession, resolveSessionRevision]);

  const prepareForTerminalAction = useCallback(async () => {
      const service = harnessServiceRef.current || getAIRunHarnessService();
      harnessServiceRef.current = service;
      if (!service?.AIControlAgentRun) return true;
      const activeRuns = Array.from(activeRunsRef.current.entries())
          .filter(([, run]) => !isTerminalRunState(run.state));
      if (activeRuns.length === 0) return true;
      const results = await Promise.allSettled(activeRuns.map(async ([runId, run]) => {
          const expectedRevision = await resolveRunRevision(runId, run.revision, service);
          return controlAgentRun({
              requestId: `agent-shutdown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              runId,
              sessionId: run.sessionId,
              action: 'cancel',
              expectedRevision,
          }, service);
      }));
      return results.every((result) => result.status === 'fulfilled');
  }, [resolveRunRevision]);

  useEffect(() => {
      onRegisterTerminalGuard?.(prepareForTerminalAction);
      return () => onRegisterTerminalGuard?.(null);
  }, [onRegisterTerminalGuard, prepareForTerminalAction]);

  const { inferredConnectionId, inferredDbName } = useMemo(
  () => inferAIChatConnectionContext({
          activeConnectionId: activeContext?.connectionId,
          activeDbName: activeContext?.dbName,
      }),
      [activeContext?.connectionId, activeContext?.dbName],
  );

  const handleMessageRenderError = useCallback((error: Error, errorInfo: React.ErrorInfo, msg: AIChatMessage) => {
      console.error('[AI Message Render Error]', msg.id, error, errorInfo);
      const renderErrorPayload = {
          messageId: msg.id,
          role: msg.role,
          contentPreview: String(msg.content || '').slice(0, 240),
          message: error.message,
          stack: error.stack,
          componentStack: errorInfo.componentStack,
          recordedAt: Date.now(),
      };
      if (typeof window !== 'undefined') {
          (window as any).__gonaviLastAIMessageRenderError = renderErrorPayload;
      }
      (globalThis as any).__gonaviLastAIMessageRenderError = renderErrorPayload;
  }, []);
  const currentSessionTitle = useMemo(
      () => orderedAISessions.find((session) => session.id === sid)?.title || t('ai_chat.panel.session.default_title'),
      [orderedAISessions, sid, t],
  );
  const activeConnectionConfig = useMemo(() => {
      if (!inferredConnectionId) return undefined;
      const connection = connections.find(item => item.id === inferredConnectionId);
      return connection ? buildRpcConnectionConfig(connection.config) : undefined;
  }, [inferredConnectionId, connections]);
  const contextHistory = useMemo(() => measureAIChatHistory(messages), [messages]);
  const contextTableNames = useMemo(
      () => collectAIChatContextTableNames({
          aiContexts,
          activeConnectionId: activeContext?.connectionId,
          activeDbName: activeContext?.dbName,
      }),
      [activeContext?.connectionId, activeContext?.dbName, aiContexts],
  );
  const aiInsights = useMemo(() => {
      return buildAIChatInsights({
          contextTableNames,
          sqlLogs,
          translate: t,
      });
  }, [contextTableNames, sqlLogs, t]);
  const panelHistorySessions = useMemo(
      () => buildAIChatInlineHistorySessions(
          orderedAISessions.map((session) => ({
              ...session,
              title: session.title || t('ai_chat.panel.session.default_title'),
          })),
      ),
      [orderedAISessions, t],
  );
  const effectivePanelMode = useMemo(
      () => resolveAIChatPanelMode(activePanelMode),
      [activePanelMode],
  );

  const handleComposerActionWithNoticeReset = useCallback((actionKey: AIComposerNoticeAction) => {
      setComposerNoticeState(null);
      handleComposerAction(actionKey);
  }, [handleComposerAction]);

  const handleModelChangeWithNoticeReset = useCallback((model: string) => {
      setComposerNoticeState(null);
      void handleModelChange(model);
  }, [handleModelChange]);

  const handleQuoteFromReply = useAIQuoteFromReply(activeContext, textareaRef);
  const isDetachedPresentation = presentation === 'detached';
  return {
    handleStop, handleCreateSession, handleSelectSession, handleArchiveSession,
    inferredConnectionId, inferredDbName, handleMessageRenderError, currentSessionTitle,
    activeConnectionConfig, contextHistory, contextTableNames, aiInsights, panelHistorySessions,
    effectivePanelMode, handleComposerActionWithNoticeReset, handleModelChangeWithNoticeReset,
    handleQuoteFromReply, isDetachedPresentation,
  };
};

export type AIChatPanelTerminalActionsApi = ReturnType<typeof useAIChatPanelTerminalActions>;
