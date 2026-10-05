import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useI18n } from '../../../../i18n/provider';
import type { AIChatAttachment, AIChatMessage } from '../../../../types';
import {
  type AIRunDispatchMode,
  type AIRunHarnessService,
  getAIRunHarnessService,
  getRunPolicy,
  readAgentSession,
  toAIChatMessages,
  mergeAIChatSessionMessages,
  readAgentRun,
} from '../../aiRunHarnessClient';
import type {
  AIRunApprovalState,
  AIRunRecoveryState,
  AIRunWorkspaceState,
} from '../../aiRunEventProjection';
import {
  type AIComposerNoticeDescriptor,
  buildAIComposerNotice,
} from '../../../../utils/aiComposerNotice';
import { useAIChatRuntimeResources } from '../../useAIChatRuntimeResources';
import {
  resolveProviderThinkingIntensityControl,
  coerceThinkingIntensityForControl,
} from '../../../../utils/aiThinkingIntensity';
import {
  type PendingConversationBranch,
  isTerminalRunState,
  createRunStopFailureMessageId,
  genId,
} from '../aiChatPanelRunState';
import { useStore } from '../../../../store';
import { useWorkbenchTabs } from '../../../../hooks/useWorkbenchTabs';
import { useAIEditorSelection } from '../../aiEditorSelectionContext';
import { getShortcutPlatform, resolveShortcutBinding } from '../../../../utils/shortcuts';
import { isMacLikePlatform } from '../../../../utils/appearance';
import { useAIChatPanelResize } from '../../useAIChatPanelResize';
import { useAIChatSessionState } from '../../useAIChatSessionState';
import { useAIChatAutoContext } from '../../useAIChatAutoContext';
import { normalizeAIRunPolicy } from '../../aiRunPolicy';
import { isContextChipAttachment } from '../../aiContextChips';
import { useAIChatRunEventSubscription } from '../../useAIChatRunEventSubscription';
import { collectBusyAISessionIds } from '../../AIChatSessionSwitcher';
import type { AIChatPanelProps } from '../../../AIChatPanel';

export interface UseAIChatPanelStateInput {
  onOpenSettings: AIChatPanelProps['onOpenSettings'];
  width: Exclude<AIChatPanelProps['width'], undefined>;
  onWidthChange: AIChatPanelProps['onWidthChange'];
  overlayTheme: AIChatPanelProps['overlayTheme'];
  darkMode: AIChatPanelProps['darkMode'];
}

export const useAIChatPanelState = ({ onOpenSettings, width, onWidthChange, overlayTheme, darkMode }: UseAIChatPanelStateInput) => {
  const { t } = useI18n();
  const [input, setInput] = useState('');
  const [draftAttachments, setDraftAttachments] = useState<AIChatAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [dispatchMode, setDispatchMode] = useState<AIRunDispatchMode>('queue');
  const [pendingApprovals, setPendingApprovals] = useState<Record<string, AIRunApprovalState>>({});
  const [pendingRecoveries, setPendingRecoveries] = useState<Record<string, AIRunRecoveryState>>({});
  const [waitingWorkspaces, setWaitingWorkspaces] = useState<Record<string, AIRunWorkspaceState>>({});
  const [runStateVersion, setRunStateVersion] = useState(0);
  const [stopRequestVersion, setStopRequestVersion] = useState(0);
  const [runControlBusyKey, setRunControlBusyKey] = useState<string | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activePanelMode, setActivePanelMode] = useState<'chat' | 'insights' | 'history'>('chat');
  const [composerNoticeState, setComposerNoticeState] = useState<AIComposerNoticeDescriptor | null>(null);
  const [thinkingIntensity, setThinkingIntensity] = useState('');
  const {
      activeProvider,
      cliCapabilities,
      composerNotice: runtimeComposerNotice,
      dynamicModels,
      fetchDynamicModels,
      fetchProviderModels,
      handleComposerAction,
      handleModelChange,
      handleProviderModelChange,
      handleOpenSettingsFromPanel,
      loadingModels,
      modelContextProfile,
      providers,
      providerModels,
      providerCatalogs,
  } = useAIChatRuntimeResources({ onOpenSettings, translate: t });
  const activeCLICapability = useMemo(() => (cliCapabilities || []).find((capability) =>
      capability.apiFormat === String(activeProvider?.apiFormat || '').trim()), [activeProvider?.apiFormat, cliCapabilities]);
  const activeCLIModelCatalog = activeProvider ? providerCatalogs?.[activeProvider.id] : undefined;
  const thinkingControl = useMemo(() => activeProvider
      ? resolveProviderThinkingIntensityControl(activeProvider, activeCLICapability, activeCLIModelCatalog)
      : null, [
          activeProvider?.id, activeProvider?.type, activeProvider?.authMode, activeProvider?.apiFormat,
          activeProvider?.baseUrl, activeProvider?.model, activeProvider?.effort,
          activeCLICapability, activeCLIModelCatalog,
      ]);
  const thinkingProviderIdRef = useRef('');

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeRunsRef = useRef(new Map<string, { state: string; revision: number; sessionId?: string }>());
  const harnessServiceRef = useRef<AIRunHarnessService | undefined>(undefined);
  const stopRequestsInFlightRef = useRef(new Set<string>());
  const pendingConversationBranchRef = useRef<PendingConversationBranch | null>(null);
  const dispatchModeDirtyRef = useRef(false);

  const aiActiveSessionId = useStore(state => state.aiActiveSessionId);
  const appearance = useStore(state => state.appearance);
  const createNewAISession = useStore(state => state.createNewAISession);
  const addAIChatMessage = useStore(state => state.addAIChatMessage);
  const updateAIChatMessage = useStore(state => state.updateAIChatMessage);
  const deleteAIChatMessage = useStore(state => state.deleteAIChatMessage);
  const deleteAISession = useStore(state => state.deleteAISession);

  const activeContext = useStore(state => state.activeContext);
  const aiContexts = useStore(state => state.aiContexts);
  const connections = useStore(state => state.connections);
  const tabs = useWorkbenchTabs();
  const activeTabId = useStore(state => state.activeTabId);
  const activeEditorSelection = useAIEditorSelection(activeTabId);
  const sqlLogs = useStore(state => state.sqlLogs);
  const setAIActiveSessionId = useStore(state => state.setAIActiveSessionId);
  const aiPanelVisible = useStore(state => state.aiPanelVisible);

  const activeShortcutPlatform = getShortcutPlatform(isMacLikePlatform());
  const {
      ghostRef,
      handleResizeStart,
      isResizing,
      panelRect,
      panelRef,
      panelWidth,
  } = useAIChatPanelResize({
      width,
      onWidthChange,
  });
  const aiChatSendShortcutBinding = useStore(state => resolveShortcutBinding(
      state.shortcutOptions,
      'sendAIChatMessage',
      activeShortcutPlatform,
  ));
  const { sid, messages, orderedAISessions } = useAIChatSessionState({
      aiActiveSessionId,
      aiPanelVisible,
      createNewAISession,
  });

  // A draft created by editing a durable turn belongs only to the source
  // session. Do not carry that immutable branch cursor into another
  // session when the user navigates before sending it.
  useEffect(() => {
      pendingConversationBranchRef.current = null;
  }, [sid]);

  useAIChatAutoContext({
      aiPanelVisible,
      activeTabId,
      tabs,
  });

  // The persisted policy is the default for a fresh composer. A deliberate
  // per-message choice remains local and must not be overwritten by an
  // asynchronous policy read.
  useEffect(() => {
      if (!aiPanelVisible || dispatchModeDirtyRef.current) return;
      const service = harnessServiceRef.current || getAIRunHarnessService();
      harnessServiceRef.current = service;
      if (!service?.AIGetRunPolicy) return;
      let disposed = false;
      void getRunPolicy(service).then((snapshot) => {
          if (disposed || dispatchModeDirtyRef.current) return;
          setDispatchMode(normalizeAIRunPolicy(snapshot.policy).defaultDispatchMode);
      }).catch((error) => {
          // A missing policy is intentionally non-fatal: the server-side
          // default remains queue and the composer stays usable.
          console.warn('Failed to load AI agent run policy', error);
      });
      return () => {
          disposed = true;
      };
  }, [aiPanelVisible]);

  const handleDispatchModeChange = useCallback((mode: AIRunDispatchMode) => {
      dispatchModeDirtyRef.current = true;
      setDispatchMode(mode === 'steer' ? 'steer' : 'queue');
  }, []);

  useEffect(() => {
      if (runtimeComposerNotice) {
          setComposerNoticeState(null);
      }
  }, [runtimeComposerNotice]);

  // 切换供应商/模型时，将思考强度钳制到当前供应商和模型真实支持的档位。
  useEffect(() => {
      if (!activeProvider || !thinkingControl) return;
      const providerChanged = thinkingProviderIdRef.current !== activeProvider.id;
      thinkingProviderIdRef.current = activeProvider.id;
      setThinkingIntensity((current) => {
          if (providerChanged || !current) return thinkingControl.defaultValue;
          if (current === 'default' && activeProvider.effort
              && thinkingControl.options.some((option) => option.value === activeProvider.effort)) {
              return activeProvider.effort;
          }
          return coerceThinkingIntensityForControl(current, thinkingControl);
      });
  }, [activeProvider?.id, activeProvider?.effort, thinkingControl]);

  const getConnectionName = useCallback(() => {
      let connectionId = activeContext?.connectionId;
      if (!connectionId) {
          const activeTab = tabs.find(tab => tab.id === activeTabId);
          connectionId = activeTab?.connectionId;
      }
      if (!connectionId) return '';
      const connection = connections.find(item => item.id === connectionId);
      return connection ? connection.name : '';
  }, [activeContext, activeTabId, connections, tabs]);

  const activeConnName = getConnectionName();
  const composerNotice = useMemo(
      () => buildAIComposerNotice(t, composerNoticeState) ?? runtimeComposerNotice,
      [composerNoticeState, runtimeComposerNotice, t],
  );

  const textColor = overlayTheme.titleText;
  const mutedColor = overlayTheme.mutedText;
  const borderColor = overlayTheme.divider;
  const quickActionBg = darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.8)';
  const quickActionBorder = overlayTheme.sectionBorder;

  useEffect(() => {
      if (messages.length === 0) return;
      messagesEndRef.current?.scrollIntoView({ behavior: sending ? 'auto' : 'smooth', block: 'end' });
  }, [messages.length, sending]);

  useEffect(() => {
      const timer = setTimeout(() => {
          textareaRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
  }, []);

  const handleScrollMessages = useCallback((event: React.UIEvent<HTMLDivElement>) => {
      const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 150;
      setShowScrollBottom(!isNearBottom);
  }, []);

  const scrollToMessagesBottom = useCallback(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const handleEditMessage = useCallback((msg: AIChatMessage) => {
      const sourceSession = orderedAISessions.find((session) => session.id === sid);
      const messageId = String(msg.id || '').trim();
      // Editing a durable user turn never rewrites that transcript. Go will
      // copy the prefix before this cursor into a new branch on send.
      pendingConversationBranchRef.current = sourceSession && messageId
          ? {
              sourceSessionId: sid,
              sourceRevision: Number(sourceSession.revision) || undefined,
              branchFromMessageId: messageId,
          }
          : null;
      setInput(msg.content);
      setDraftAttachments((msg.attachments || []).filter((attachment) => !isContextChipAttachment(attachment)));
      setTimeout(() => textareaRef.current?.focus(), 50);
  }, [orderedAISessions, sid]);

  const activeRunIdRef = useRef<string | null>(null);

  const hydrateSessionProjection = useCallback(async (
      sessionId: string,
      service: AIRunHarnessService | undefined,
  ): Promise<void> => {
      if (!sessionId || sessionId === 'session-fallback' || !service?.AIReadAgentSession) return;
      try {
          const projection = await readAgentSession({ sessionId, limit: 10_000 }, service);
          const durable = toAIChatMessages(projection);
          useStore.setState((state) => {
              const history = { ...state.aiChatHistory };
              if (durable.length > 0 || Array.isArray(projection.messages)) {
                  history[sessionId] = mergeAIChatSessionMessages(durable, history[sessionId] || []);
              }
              const title = String(projection.title || '').trim();
              if (!title) return { aiChatHistory: history };
              const updatedAtRaw = projection.updatedAt;
              const parsedUpdatedAt = typeof updatedAtRaw === 'number'
                  ? updatedAtRaw
                  : Date.parse(String(updatedAtRaw || ''));
              const updatedAt = Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : Date.now();
              const existing = state.aiChatSessions.find((session) => session.id === sessionId);
              const session = {
                  id: sessionId,
                  title,
                  updatedAt,
                  revision: Number(projection.revision) || undefined,
                  generation: Number(projection.generation) || undefined,
              };
              return {
                  aiChatHistory: history,
                  aiChatSessions: existing
                      ? state.aiChatSessions.map((item) => item.id === sessionId ? { ...item, ...session } : item)
                      : [session, ...state.aiChatSessions],
              };
          });
      } catch (error) {
          // A newly created run can finish before the projection read races
          // with SQLite. The event stream remains authoritative and will
          // replay the missing messages on the next mount.
          console.warn('Failed to hydrate AI agent session', sessionId, error);
      }
  }, []);

  const handleRunStateChange = useCallback((runId: string, state: string, revision: number) => {
      const previous = activeRunsRef.current.get(runId);
      const sessionId = previous?.sessionId || sid;
      activeRunsRef.current.set(runId, {
          state,
          revision,
          sessionId,
      });
      setRunStateVersion((version) => version + 1);
      if (state !== 'awaiting_approval') {
          setPendingApprovals((current) => {
              if (!current[runId]) return current;
              const next = { ...current };
              delete next[runId];
              return next;
          });
      }
      if (state === 'recovery_required') {
          setPendingRecoveries((current) => current[runId]
              ? current
              : {
                  ...current,
                  [runId]: {
                      runId,
                      sessionId,
                      revision,
                  },
              });
      } else {
          setPendingRecoveries((current) => {
              if (!current[runId]) return current;
              const next = { ...current };
              delete next[runId];
              return next;
          });
      }
      if (state === 'awaiting_workspace') {
          setWaitingWorkspaces((current) => current[runId]?.revision === revision
              ? current
              : {
                  ...current,
                  [runId]: { runId, sessionId, revision },
              });
      } else {
          setWaitingWorkspaces((current) => {
              if (!current[runId]) return current;
              const next = { ...current };
              delete next[runId];
              return next;
          });
      }
      if (runId === activeRunIdRef.current && isTerminalRunState(state)) {
          setSending(false);
      }
  }, [sid]);

  const handleApprovalChange = useCallback((runId: string, approval: AIRunApprovalState | null) => {
      setPendingApprovals((current) => {
          if (!approval || approval.decision !== 'pending') {
              if (!current[runId]) return current;
              const next = { ...current };
              delete next[runId];
              return next;
          }
          return { ...current, [runId]: approval };
      });
  }, []);

  const handleRecoveryChange = useCallback((runId: string, recovery: AIRunRecoveryState | null) => {
      setPendingRecoveries((current) => {
          if (!recovery) {
              if (!current[runId]) return current;
              const next = { ...current };
              delete next[runId];
              return next;
          }
          return { ...current, [runId]: recovery };
      });
  }, []);

  const isTrackedRun = useCallback((runId: string): boolean => activeRunsRef.current.has(runId), []);
  const trackedRunIds = Array.from(activeRunsRef.current.keys());

  const handleRunTerminal = useCallback((runId: string, sessionId: string) => {
      deleteAIChatMessage(sessionId, createRunStopFailureMessageId(runId));
      const service = harnessServiceRef.current || getAIRunHarnessService();
      harnessServiceRef.current = service;
      void hydrateSessionProjection(sessionId, service);
  }, [deleteAIChatMessage, hydrateSessionProjection]);

  useAIChatRunEventSubscription({
      sid,
      setSending,
      addAIChatMessage,
      updateAIChatMessage,
      deleteAIChatMessage,
      nextMessageId: genId,
      onRunStateChange: handleRunStateChange,
      onApprovalChange: handleApprovalChange,
      onRecoveryChange: handleRecoveryChange,
      isRunTracked: isTrackedRun,
      trackedRunIds,
      onRunTerminal: handleRunTerminal,
      translate: t,
  });

  const activeRuns = useMemo(
      () => Array.from(activeRunsRef.current.entries())
          .filter(([, run]) => run.sessionId === sid && !isTerminalRunState(run.state))
          .map(([runId, run]) => ({ runId, ...run })),
      [runStateVersion, sid],
  );
  const hasActiveRun = activeRuns.length > 0;
  const busySessionIds = useMemo(
      () => collectBusyAISessionIds(activeRunsRef.current.values()),
      [runStateVersion],
  );
  const stopRequestPending = useMemo(
      () => activeRuns.some(({ runId }) => stopRequestsInFlightRef.current.has(runId)),
      [activeRuns, stopRequestVersion],
  );
  const visibleApprovals = useMemo(
      () => Object.values(pendingApprovals).filter((approval) => approval.sessionId === sid),
      [pendingApprovals, sid],
  );
  const visibleRecoveries = useMemo(
      () => Object.values(pendingRecoveries).filter((recovery) => recovery.sessionId === sid),
      [pendingRecoveries, sid],
  );
  const visibleWaitingWorkspaces = useMemo(
      () => Object.values(waitingWorkspaces).filter((workspace) => workspace.sessionId === sid),
      [waitingWorkspaces, sid],
  );

  const refreshRunProjection = useCallback(async (
      runId: string,
      sessionId: string,
      service: AIRunHarnessService | undefined,
  ): Promise<{ state: string; revision: number } | null> => {
      if (!service?.AIReadAgentRun) return null;
      try {
          const projection = await readAgentRun({ runId, afterSequence: 0, limit: 1 }, service);
          const state = String(projection?.run?.state || '').trim();
          const revision = Number(projection?.run?.revision || 0);
          if (state || revision > 0) {
              handleRunStateChange(runId, state || 'queued', revision);
          }
          void hydrateSessionProjection(sessionId, service);
          return { state, revision };
      } catch (refreshError) {
          console.warn('Failed to refresh AI agent run projection', runId, refreshError);
          return null;
      }
  }, [handleRunStateChange, hydrateSessionProjection]);
  return {
    t, input, setInput, draftAttachments, setDraftAttachments, sending, setSending, dispatchMode,
    setRunStateVersion, setStopRequestVersion, runControlBusyKey, setRunControlBusyKey,
    showScrollBottom, historyOpen, setHistoryOpen, activePanelMode, setActivePanelMode,
    setComposerNoticeState, thinkingIntensity, setThinkingIntensity, activeProvider, dynamicModels,
    fetchDynamicModels, fetchProviderModels, handleComposerAction, handleModelChange,
    handleProviderModelChange, handleOpenSettingsFromPanel, loadingModels, modelContextProfile,
    providers, providerModels, activeCLICapability, activeCLIModelCatalog, messagesEndRef,
    textareaRef, activeRunsRef, harnessServiceRef, stopRequestsInFlightRef,
    pendingConversationBranchRef, createNewAISession, addAIChatMessage, updateAIChatMessage,
    deleteAIChatMessage, deleteAISession, activeContext, aiContexts, connections,
    activeEditorSelection, sqlLogs, setAIActiveSessionId, activeShortcutPlatform, ghostRef,
    handleResizeStart, isResizing, panelRect, panelRef, panelWidth, aiChatSendShortcutBinding, sid,
    messages, orderedAISessions, handleDispatchModeChange, activeConnName, composerNotice,
    textColor, mutedColor, borderColor, quickActionBg, quickActionBorder, handleScrollMessages,
    scrollToMessagesBottom, handleEditMessage, activeRunIdRef, hydrateSessionProjection,
    handleRunStateChange, hasActiveRun, busySessionIds, stopRequestPending, visibleApprovals,
    visibleRecoveries, visibleWaitingWorkspaces, refreshRunProjection,
  };
};

export type AIChatPanelStateApi = ReturnType<typeof useAIChatPanelState>;
