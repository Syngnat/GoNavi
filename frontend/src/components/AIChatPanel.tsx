import React from 'react';
import { createPortal } from 'react-dom';
import type { OverlayWorkbenchTheme } from '../utils/overlayWorkbenchTheme';
import './AIChatPanel.css';
import '../styles/v2-theme-ai.css';

import { AIChatHeader } from './ai/AIChatHeader';
import { AIChatInput } from './ai/AIChatInput';
import { AIHistoryDrawer } from './ai/AIHistoryDrawer';
import AIChatPanelConversationView from './ai/AIChatPanelConversationView';
import AIChatRunControls from './ai/AIChatRunControls';
import { resolveEffectiveContextWindow } from '../utils/aiChatRuntime';
import { AIReplySelectionToolbar } from './ai/AIReplySelectionToolbar';
import { useAIChatPanelState } from './ai/chatPanel/hooks/useAIChatPanelState';
import { useAIChatPanelRunActions } from './ai/chatPanel/hooks/useAIChatPanelRunActions';
import { useAIChatPanelTerminalActions } from './ai/chatPanel/hooks/useAIChatPanelTerminalActions';

export interface AIChatPanelProps {
    width?: number;
    darkMode: boolean;
    bgColor?: string;
    onClose: () => void;
    onOpenSettings?: (providerId?: string) => void;
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

export const AIChatPanel: React.FC<AIChatPanelProps> = ({
    width = 380, darkMode, bgColor, onClose, onOpenSettings, onWidthChange, overlayTheme,
    presentation = 'dock', onDetach, onAttach, onRegisterTerminalGuard,
    interactionDisabled = false, onWindowDragStart,
}) => {
    const {
      t, input, setInput, draftAttachments, setDraftAttachments, sending, setSending, dispatchMode,
      setRunStateVersion, setStopRequestVersion, runControlBusyKey, setRunControlBusyKey,
      showScrollBottom, historyOpen, setHistoryOpen, activePanelMode, setActivePanelMode,
      setComposerNoticeState, thinkingIntensity, setThinkingIntensity, activeProvider,
      dynamicModels, fetchDynamicModels, fetchProviderModels, handleComposerAction,
      handleModelChange, handleProviderModelChange, handleOpenSettingsFromPanel, loadingModels,
      modelContextProfile, providers, providerModels, activeCLICapability, activeCLIModelCatalog,
      messagesEndRef, textareaRef, activeRunsRef, harnessServiceRef, stopRequestsInFlightRef,
      pendingConversationBranchRef, createNewAISession, addAIChatMessage, updateAIChatMessage,
      deleteAIChatMessage, deleteAISession, activeContext, aiContexts, connections,
      activeEditorSelection, sqlLogs, setAIActiveSessionId, activeShortcutPlatform, ghostRef,
      handleResizeStart, isResizing, panelRect, panelRef, panelWidth, aiChatSendShortcutBinding,
      sid, messages, orderedAISessions, handleDispatchModeChange, activeConnName, composerNotice,
      textColor, mutedColor, borderColor, quickActionBg, quickActionBorder, handleScrollMessages,
      scrollToMessagesBottom, handleEditMessage, activeRunIdRef, hydrateSessionProjection,
      handleRunStateChange, hasActiveRun, busySessionIds, stopRequestPending, visibleApprovals,
      visibleRecoveries, visibleWaitingWorkspaces, refreshRunProjection,
    } = useAIChatPanelState({ onOpenSettings, width, onWidthChange, overlayTheme, darkMode });

    const {
      resolveRunRevision, resolveSessionRevision, handleApprovalDecision, handleRecoveryAction,
      handleWorkspaceAction, handleRetryMessage, handleSend, handleKeyDown,
    } = useAIChatPanelRunActions({
      activeRunsRef, sid, setRunStateVersion, harnessServiceRef, setRunControlBusyKey,
      refreshRunProjection, addAIChatMessage, t, activeProvider, thinkingIntensity, activeRunIdRef,
      setAIActiveSessionId, hydrateSessionProjection, setSending, interactionDisabled,
      dynamicModels, loadingModels, activeContext, aiContexts, setInput, textareaRef,
      setComposerNoticeState, setActivePanelMode, sending, orderedAISessions, input,
      draftAttachments, setDraftAttachments, hasActiveRun, messages, pendingConversationBranchRef,
      dispatchMode, aiChatSendShortcutBinding,
    });

    const {
      handleStop, handleCreateSession, handleSelectSession, handleArchiveSession,
      inferredConnectionId, inferredDbName, handleMessageRenderError, currentSessionTitle,
      activeConnectionConfig, contextHistory, contextTableNames, aiInsights, panelHistorySessions,
      effectivePanelMode, handleComposerActionWithNoticeReset, handleModelChangeWithNoticeReset,
      handleQuoteFromReply, isDetachedPresentation,
    } = useAIChatPanelTerminalActions({
      activeRunsRef, sid, stopRequestsInFlightRef, setStopRequestVersion, deleteAIChatMessage,
      harnessServiceRef, resolveRunRevision, setSending, handleRunStateChange, refreshRunProjection,
      t, updateAIChatMessage, addAIChatMessage, interactionDisabled, sending,
      pendingConversationBranchRef, createNewAISession, setActivePanelMode, setAIActiveSessionId,
      setHistoryOpen, resolveSessionRevision, deleteAISession, onRegisterTerminalGuard,
      activeContext, orderedAISessions, connections, messages, aiContexts, sqlLogs, activePanelMode,
      setComposerNoticeState, handleComposerAction, handleModelChange, textareaRef, presentation,
    });

    return (
        <div
            ref={panelRef}
            className={`ai-chat-panel gn-v2-ai-panel${isDetachedPresentation ? ' is-detached' : ''}`}
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
                presentation={presentation}
                onHistoryClick={() => {
                    setActivePanelMode('history');
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
                insights={aiInsights}
                sessions={panelHistorySessions}
                activeSessionId={sid}
                busySessionIds={busySessionIds}
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

            <AIReplySelectionToolbar rootRef={panelRef} onQuote={handleQuoteFromReply} copy={t} />

            <AIChatInput
                input={input}
                setInput={setInput}
                draftAttachments={draftAttachments}
                setDraftAttachments={setDraftAttachments}
                sending={sending}
                dispatchMode={dispatchMode}
                hasActiveRun={hasActiveRun}
                stopRequestPending={stopRequestPending}
                onDispatchModeChange={handleDispatchModeChange}
                onSend={handleSend}
                onStop={handleStop}
                handleKeyDown={handleKeyDown}
                activeConnName={activeConnName}
                activeContext={activeContext}
                activeEditorSelection={activeEditorSelection}
                activeProvider={activeProvider}
                providers={providers}
                providerModels={providerModels}
                dynamicModels={dynamicModels}
                loadingModels={loadingModels}
                sendShortcutBinding={aiChatSendShortcutBinding}
                shortcutPlatform={activeShortcutPlatform}
                composerNotice={composerNotice}
                onComposerAction={handleComposerActionWithNoticeReset}
                onModelChange={handleModelChangeWithNoticeReset}
                onProviderModelChange={(providerId, model) => {
                    setComposerNoticeState(null);
                    void handleProviderModelChange(providerId, model);
                }}
                onManageProvider={handleOpenSettingsFromPanel}
                onFetchModels={fetchDynamicModels}
                onFetchProviderModels={fetchProviderModels}
                thinkingIntensity={thinkingIntensity}
                onThinkingIntensityChange={setThinkingIntensity}
                cliCapability={activeCLICapability}
                cliCatalog={activeCLIModelCatalog}
                textareaRef={textareaRef}
                darkMode={darkMode}
                textColor={textColor}
                mutedColor={mutedColor}
                overlayTheme={overlayTheme}
                contextHistory={contextHistory}
                contextSessionId={sid === 'session-fallback' ? undefined : sid}
                contextWindow={resolveEffectiveContextWindow(modelContextProfile, activeProvider?.contextWindow)}
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
