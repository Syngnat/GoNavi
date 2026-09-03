import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useStore, type AIChatSessionSummary } from '../store';
import type { OverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import type {
    AIChatAttachment,
    AIChatMessage,
} from '../types';
import './AIChatPanel.css';
import '../styles/v2-theme-ai.css';

import { AIChatHeader } from './ai/AIChatHeader';
import { AIChatInput } from './ai/AIChatInput';
import { AIHistoryDrawer } from './ai/AIHistoryDrawer';
import AIChatPanelConversationView from './ai/AIChatPanelConversationView';
import AIChatRunControls, {
    type AIRunRecoveryAction,
} from './ai/AIChatRunControls';
import { useAIChatRunEventSubscription } from './ai/useAIChatRunEventSubscription';
import {
    controlAgentRun,
    createRunPendingMessageId,
    getAIRunHarnessService,
    getRunPolicy,
    hasAIRunHarness,
    mergeAIChatSessionMessages,
    mutateAgentSession,
    readAgentRun,
    readAgentSession,
    submitAgentInput,
    toAIChatMessages,
    type AgentAttachment,
    type AIRunDispatchMode,
    type AIRunHarnessService,
} from './ai/aiRunHarnessClient';
import { normalizeAIRunPolicy } from './ai/aiRunPolicy';
import type {
    AIRunApprovalState,
    AIRunRecoveryState,
    AIRunWorkspaceState,
} from './ai/aiRunEventProjection';
import {
    getAIWorkspaceSourceInstanceID,
} from './ai/useAIWorkspaceSnapshot';
import { buildRpcConnectionConfig } from '../utils/connectionRpcConfig';
import type { AIComposerNoticeDescriptor } from '../utils/aiComposerNotice';
import { buildAIComposerNotice } from '../utils/aiComposerNotice';
import { consumeAIChatSendShortcutOnKeyDown } from '../utils/aiChatSendShortcut';
import { getDynamicMaxContextChars } from '../utils/aiChatRuntime';
import { getShortcutPlatform, resolveShortcutBinding } from '../utils/shortcuts';
import { isMacLikePlatform } from '../utils/appearance';
import {
    buildAIChatInsights,
    buildAIChatInlineHistorySessions,
    calculateAIContextUsageChars,
    collectAIChatContextTableNames,
    inferAIChatConnectionContext,
    resolveAIChatPanelMode,
} from './ai/aiChatPanelDerivedState';
import { buildAIChatReadinessSnapshot } from './ai/aiChatReadiness';
import { useAIChatRuntimeResources } from './ai/useAIChatRuntimeResources';
import { useAIChatAutoContext } from './ai/useAIChatAutoContext';
import { useAIChatPanelResize } from './ai/useAIChatPanelResize';
import { useAIChatSessionState } from './ai/useAIChatSessionState';
import { useWorkbenchTabs } from '../hooks/useWorkbenchTabs';
import { useI18n } from '../i18n/provider';
import {
    coerceThinkingIntensityForProfile,
    defaultThinkingIntensityForProfile,
    resolveThinkingIntensityProfile,
} from '../utils/aiThinkingIntensity';

interface AIChatPanelProps {
    width?: number;
    darkMode: boolean;
    bgColor?: string;
    onClose: () => void;
    onOpenSettings?: () => void;
    onWidthChange?: (width: number) => void;
    overlayTheme: OverlayWorkbenchTheme;
    /** dock：侧栏；detached：独立浮动窗内 */
    presentation?: 'dock' | 'detached';
    onDetach?: () => void;
    onAttach?: () => void;
    onRegisterTerminalGuard?: (guard: (() => Promise<boolean>) | null) => void;
    interactionDisabled?: boolean;
    /** 独立窗：从标题栏发起拖拽（按钮区域会 stopPropagation） */
    onWindowDragStart?: (event: React.PointerEvent) => void;
}

const genId = () => `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

const toAgentAttachments = (attachments: AIChatAttachment[]): AgentAttachment[] =>
    attachments
        .map((attachment) => ({
            name: String(attachment.name || '').trim(),
            mediaType: String(attachment.mimeType || 'application/octet-stream'),
            data: String(attachment.dataUrl || attachment.text || ''),
        }))
        .filter((attachment) => Boolean(attachment.name));

const isTerminalRunState = (state: string | undefined): boolean =>
    state === 'completed'
    || state === 'failed'
    || state === 'canceled'
    || state === 'exhausted';

const hasTerminalRunError = (message: AIChatMessage, runId: string): boolean => (
    message.role === 'assistant'
    && message.runId === runId
    && message.loading === false
    && message.excludeFromAIContext === true
    && Boolean(String(message.rawError || '').trim())
);

const isRevisionConflictError = (error: unknown): boolean =>
    String(error instanceof Error ? error.message : error || '')
        .toLowerCase()
        .includes('revision_conflict');

const positiveRevision = (value: unknown): number => {
    const revision = Number(value);
    return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
};

interface PendingConversationBranch {
    sourceSessionId: string;
    sourceRevision?: number;
    branchFromMessageId: string;
}

export const AIChatPanel: React.FC<AIChatPanelProps> = ({
    width = 380, darkMode, bgColor, onClose, onOpenSettings, onWidthChange, overlayTheme,
    presentation = 'dock', onDetach, onAttach, onRegisterTerminalGuard,
    interactionDisabled = false, onWindowDragStart,
}) => {
    const { t } = useI18n();
    const [input, setInput] = useState('');
    const [draftAttachments, setDraftAttachments] = useState<AIChatAttachment[]>([]);
    const [sending, setSending] = useState(false);
    const [dispatchMode, setDispatchMode] = useState<AIRunDispatchMode>('queue');
    const [pendingApprovals, setPendingApprovals] = useState<Record<string, AIRunApprovalState>>({});
    const [pendingRecoveries, setPendingRecoveries] = useState<Record<string, AIRunRecoveryState>>({});
    const [waitingWorkspaces, setWaitingWorkspaces] = useState<Record<string, AIRunWorkspaceState>>({});
    const [runStateVersion, setRunStateVersion] = useState(0);
    const [runControlBusyKey, setRunControlBusyKey] = useState<string | null>(null);
    const [showScrollBottom, setShowScrollBottom] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [activePanelMode, setActivePanelMode] = useState<'chat' | 'insights' | 'history'>('chat');
    const [composerNoticeState, setComposerNoticeState] = useState<AIComposerNoticeDescriptor | null>(null);
    const [thinkingIntensity, setThinkingIntensity] = useState('medium');
    const {
        activeProvider,
        composerNotice: runtimeComposerNotice,
        dynamicModels,
        fetchDynamicModels,
        handleComposerAction,
        handleModelChange,
        handleOpenSettingsFromPanel,
        loadingModels,
    } = useAIChatRuntimeResources({ onOpenSettings });

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const activeRunsRef = useRef(new Map<string, { state: string; revision: number; sessionId?: string }>());
    const harnessServiceRef = useRef<AIRunHarnessService | undefined>(undefined);
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
    const sqlLogs = useStore(state => state.sqlLogs);
    const setAIActiveSessionId = useStore(state => state.setAIActiveSessionId);
    const aiPanelVisible = useStore(state => state.aiPanelVisible);
    const isV2Ui = appearance.uiVersion === 'v2';
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
        isV2Ui,
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

    // 切换供应商/模型时，将思考强度钳制到当前体系合法档位。
    useEffect(() => {
        if (!activeProvider) {
            return;
        }
        const profile = resolveThinkingIntensityProfile({
            type: activeProvider.type,
            apiFormat: activeProvider.apiFormat,
            baseUrl: activeProvider.baseUrl,
            model: activeProvider.model,
        });
        setThinkingIntensity((current) => {
            const next = coerceThinkingIntensityForProfile(
                current || defaultThinkingIntensityForProfile(profile),
                profile,
            );
            return next;
        });
    }, [
        activeProvider?.type,
        activeProvider?.apiFormat,
        activeProvider?.baseUrl,
        activeProvider?.model,
    ]);

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

    useEffect(() => {
        const handler = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            if (detail?.prompt) {
                setInput(detail.prompt);
                setTimeout(() => {
                    textareaRef.current?.focus();
                }, 50);
            }
        };
        window.addEventListener('gonavi:ai:inject-prompt', handler);
        return () => window.removeEventListener('gonavi:ai:inject-prompt', handler);
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
        setDraftAttachments(msg.attachments || []);
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

    const handleRunTerminal = useCallback((_runId: string, sessionId: string) => {
        const service = harnessServiceRef.current || getAIRunHarnessService();
        harnessServiceRef.current = service;
        void hydrateSessionProjection(sessionId, service);
    }, [hydrateSessionProjection]);

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

    const refreshRunAfterRevisionConflict = useCallback(async (
        runId: string,
        sessionId: string,
        service: AIRunHarnessService | undefined,
    ): Promise<void> => {
        if (!service?.AIReadAgentRun) return;
        try {
            const projection = await readAgentRun({ runId, afterSequence: 0, limit: 1 }, service);
            const state = String(projection?.run?.state || '').trim();
            const revision = Number(projection?.run?.revision || 0);
            if (state || revision > 0) {
                handleRunStateChange(runId, state || 'queued', revision);
            }
            void hydrateSessionProjection(sessionId, service);
        } catch (refreshError) {
            console.warn('Failed to refresh stale AI agent run projection', runId, refreshError);
        }
    }, [handleRunStateChange, hydrateSessionProjection]);

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
                void refreshRunAfterRevisionConflict(runId, sessionId, service);
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
    }, [addAIChatMessage, refreshRunAfterRevisionConflict, resolveRunRevision, sid, t]);

    const handleApprovalDecision = useCallback((
        approval: AIRunApprovalState,
        decision: 'approved' | 'denied',
    ) => {
        void handleRunControl(
            approval.runId,
            decision === 'approved' ? 'approve' : 'deny',
            {
                approvalId: approval.approvalId,
                callId: approval.callId,
                argsHash: approval.argsHash,
                busyKey: `${approval.runId}:${decision === 'approved' ? 'approve' : 'deny'}:${approval.approvalId}`,
            },
        );
    }, [handleRunControl]);

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
        const text = input.trim();
        if ((!text && draftAttachments.length === 0) || interactionDisabled) return;
        // A running harness can still accept a durable queued input or a
        // high-priority steer. Keep the old guard only for a stale local
        // sending flag that has no active Ledger run behind it.
        if (sending && !hasActiveRun) return;

        const connectionKey = activeContext?.connectionId ? `${activeContext.connectionId}:${activeContext.dbName || ''}` : 'default';
        const readiness = buildAIChatReadinessSnapshot({
            activeProvider,
            dynamicModels,
            loadingModels,
            activeContext,
            activeContextItems: aiContexts[connectionKey] || [],
        });

        if (readiness.status === 'missing_provider') {
            setComposerNoticeState({ kind: 'missing_provider' });
            return;
        }
        if (readiness.status === 'provider_incomplete') {
            setComposerNoticeState({ kind: 'provider_incomplete', issues: readiness.issues });
            return;
        }
        if (readiness.status === 'missing_model' || readiness.status === 'loading_models') {
            setComposerNoticeState({ kind: 'missing_model' });
            return;
        }
        setComposerNoticeState(null);

        const currentAttachments = [...draftAttachments];
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

    const handleStop = useCallback(async () => {
        try {
            const service = harnessServiceRef.current || getAIRunHarnessService();
            harnessServiceRef.current = service;
            if (!service?.AIControlAgentRun) throw new Error('AIControlAgentRun is unavailable');
            const candidate = Array.from(activeRunsRef.current.entries())
                .reverse()
                .find(([, run]) => run.sessionId === sid && !isTerminalRunState(run.state));
            if (!candidate) return;
            const [runId, run] = candidate;
            const expectedRevision = await resolveRunRevision(runId, run.revision, service);
            setSending(true);
            await controlAgentRun({
                requestId: `agent-control-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                runId,
                sessionId: sid,
                action: 'cancel',
                expectedRevision,
            }, service);
        } catch (error) {
            console.warn('Failed to stop chat stream', error);
            setSending(false);
        }
    }, [resolveRunRevision, sid]);

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
    const contextUsageChars = useMemo(
        () => calculateAIContextUsageChars(messages),
        [messages],
    );
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
        () => resolveAIChatPanelMode(isV2Ui, activePanelMode),
        [activePanelMode, isV2Ui],
    );

    const handleComposerActionWithNoticeReset = useCallback((actionKey: 'open-settings' | 'reload-models') => {
        setComposerNoticeState(null);
        handleComposerAction(actionKey);
    }, [handleComposerAction]);

    const handleModelChangeWithNoticeReset = useCallback((model: string) => {
        setComposerNoticeState(null);
        void handleModelChange(model);
    }, [handleModelChange]);

    const isDetachedPresentation = presentation === 'detached';

    return (
        <div
            ref={panelRef}
            className={`ai-chat-panel${isV2Ui ? ' gn-v2-ai-panel' : ''}${isDetachedPresentation ? ' is-detached' : ''}`}
            aria-busy={interactionDisabled}
            style={{
                width: isDetachedPresentation ? '100%' : panelWidth,
                height: isDetachedPresentation ? '100%' : undefined,
                background: bgColor || 'transparent',
                color: textColor,
                borderLeft: isDetachedPresentation ? 'none' : overlayTheme.shellBorder,
                position: 'relative',
                pointerEvents: interactionDisabled ? 'none' : undefined,
            }}
        >
            {!isDetachedPresentation && (
                <div className={`ai-resize-handle${isResizing ? ' active' : ''}`} onMouseDown={handleResizeStart} />
            )}

            {!isDetachedPresentation && isResizing && panelRect.current && createPortal(
                <div
                    ref={ghostRef}
                    style={{
                        position: 'fixed',
                        top: panelRect.current.top,
                        bottom: panelRect.current.bottom,
                        left: panelRect.current.left,
                        width: '2px',
                        background: darkMode ? '#ffd666' : '#1677ff',
                        zIndex: 99999,
                        pointerEvents: 'none'
                    }}
                />,
                document.body
            )}

            <AIChatHeader
                darkMode={darkMode}
                mutedColor={mutedColor}
                textColor={textColor}
                overlayTheme={overlayTheme}
                isV2Ui={isV2Ui}
                presentation={presentation}
                onHistoryClick={() => {
                    if (isV2Ui) {
                        setActivePanelMode('history');
                    } else {
                        setHistoryOpen(true);
                    }
                }}
                onClear={() => {
                    handleCreateSession();
                }}
                onSettingsClick={handleOpenSettingsFromPanel}
                onClose={onClose}
                onDetach={onDetach}
                onAttach={onAttach}
                onWindowDragStart={onWindowDragStart}
                sessionTitle={currentSessionTitle}
                activeMode={effectivePanelMode}
                onModeChange={(mode) => {
                    if (!isV2Ui) return;
                    setActivePanelMode(mode);
                    if (mode === 'history') {
                        setHistoryOpen(false);
                    }
                }}
            />

            <AIChatPanelConversationView
                mode={effectivePanelMode}
                messages={messages}
                darkMode={darkMode}
                overlayTheme={overlayTheme}
                textColor={textColor}
                mutedColor={mutedColor}
                quickActionBg={quickActionBg}
                quickActionBorder={quickActionBorder}
                showScrollBottom={showScrollBottom}
                contextTableNames={contextTableNames}
                isV2Ui={isV2Ui}
                insights={aiInsights}
                sessions={panelHistorySessions}
                activeSessionId={sid}
                sessionActionsDisabled={interactionDisabled}
                activeConnectionId={inferredConnectionId}
                activeConnectionConfig={activeConnectionConfig}
                activeDbName={inferredDbName}
                messagesEndRef={messagesEndRef}
                onScrollMessages={handleScrollMessages}
                onQuickAction={(prompt: string, autoSend?: boolean) => {
                    setInput(prompt);
                    if (autoSend) {
                        window.setTimeout(() => {
                            textareaRef.current?.focus();
                        }, 50);
                    }
                }}
                onSelectSession={handleSelectSession}
                onArchiveSession={handleArchiveSession}
                onEditMessage={handleEditMessage}
                onRetryMessage={handleRetryMessage}
                onMessageRenderError={handleMessageRenderError}
                onScrollBottom={scrollToMessagesBottom}
            />

            <AIChatRunControls
                approvals={visibleApprovals}
                recoveries={visibleRecoveries}
                waitingWorkspaces={visibleWaitingWorkspaces}
                darkMode={darkMode}
                textColor={textColor}
                mutedColor={mutedColor}
                overlayTheme={overlayTheme}
                busyKey={runControlBusyKey}
                onApprovalDecision={handleApprovalDecision}
                onRecoveryAction={handleRecoveryAction}
                onWorkspaceAction={handleWorkspaceAction}
            />

            <AIChatInput
                input={input}
                setInput={setInput}
                draftAttachments={draftAttachments}
                setDraftAttachments={setDraftAttachments}
                sending={sending}
                dispatchMode={dispatchMode}
                hasActiveRun={hasActiveRun}
                onDispatchModeChange={handleDispatchModeChange}
                onSend={handleSend}
                onStop={handleStop}
                handleKeyDown={handleKeyDown}
                activeConnName={activeConnName}
                activeContext={activeContext}
                activeProvider={activeProvider}
                dynamicModels={dynamicModels}
                loadingModels={loadingModels}
                sendShortcutBinding={aiChatSendShortcutBinding}
                shortcutPlatform={activeShortcutPlatform}
                composerNotice={composerNotice}
                onComposerAction={handleComposerActionWithNoticeReset}
                onModelChange={handleModelChangeWithNoticeReset}
                onFetchModels={fetchDynamicModels}
                thinkingIntensity={thinkingIntensity}
                onThinkingIntensityChange={setThinkingIntensity}
                textareaRef={textareaRef}
                darkMode={darkMode}
                textColor={textColor}
                mutedColor={mutedColor}
                overlayTheme={overlayTheme}
                contextUsageChars={contextUsageChars}
                maxContextChars={getDynamicMaxContextChars(activeProvider?.model)}
                isV2Ui={isV2Ui}
            />

            <AIHistoryDrawer
                open={historyOpen}
                onClose={() => setHistoryOpen(false)}
                bgColor={bgColor}
                darkMode={darkMode}
                textColor={textColor}
                mutedColor={mutedColor}
                borderColor={borderColor}
                onCreateNew={handleCreateSession}
                onSelectSession={handleSelectSession}
                onArchiveSession={handleArchiveSession}
                disabled={sending || interactionDisabled}
                navigationDisabled={interactionDisabled}
                sessionId={sid}
            />
        </div>
    );
};

export default AIChatPanel;
