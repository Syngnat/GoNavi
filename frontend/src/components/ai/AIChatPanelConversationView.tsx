import React from 'react';
import { DownOutlined } from '@ant-design/icons';

import type { RpcConnectionConfig } from '../../utils/connectionRpcConfig';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import type { AIChatMessage } from '../../types';
import { AIChatWelcome } from './AIChatWelcome';
import { AIMessageBubble } from './AIMessageBubble';
import AIMessageRenderBoundary from './AIMessageRenderBoundary';
import AIChatPanelModeContent, {
  type AIChatInlineHistorySession,
  type AIChatInsightItem,
  type AIChatPanelMode,
} from './AIChatPanelModeContent';
import {
  buildAIToolResultIndex,
  haveSameRelevantToolResults,
  type AIToolResultIndex,
} from './aiToolResultIndex';
import { collectRetryableAIChatAssistantMessageIds } from './aiChatRetrySafety';

interface AIChatPanelConversationViewProps {
  mode: AIChatPanelMode;
  messages: AIChatMessage[];
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  textColor: string;
  mutedColor: string;
  quickActionBg: string;
  quickActionBorder: string;
  showScrollBottom: boolean;
  contextTableNames: string[];
  isV2Ui: boolean;
  insights: AIChatInsightItem[];
  sessions: AIChatInlineHistorySession[];
  activeSessionId: string;
  sessionActionsDisabled?: boolean;
  activeConnectionId?: string;
  activeConnectionConfig?: RpcConnectionConfig;
  activeDbName?: string;
  messagesEndRef: React.Ref<HTMLDivElement>;
  onScrollMessages: (event: React.UIEvent<HTMLDivElement>) => void;
  onQuickAction: (prompt: string, autoSend?: boolean) => void;
  onSelectSession: (sessionId: string) => void;
  onArchiveSession?: (session: AIChatInlineHistorySession) => Promise<void> | void;
  onEditMessage: (message: AIChatMessage) => void;
  onRetryMessage: (message: AIChatMessage) => void;
  onDeleteMessage?: (id: string) => void;
  onMessageRenderError: (error: Error, errorInfo: React.ErrorInfo, message: AIChatMessage) => void;
  onScrollBottom: () => void;
}

interface AIChatMessageRowProps {
  message: AIChatMessage;
  canRetry: boolean;
  toolResultsById: AIToolResultIndex;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  textColor: string;
  activeConnectionId?: string;
  activeConnectionConfig?: RpcConnectionConfig;
  activeDbName?: string;
  onEditMessage: (message: AIChatMessage) => void;
  onRetryMessage: (message: AIChatMessage) => void;
  onDeleteMessage?: (id: string) => void;
  onMessageRenderError: (error: Error, errorInfo: React.ErrorInfo, message: AIChatMessage) => void;
}

const areAIChatMessageRowPropsEqual = (
  previous: AIChatMessageRowProps,
  next: AIChatMessageRowProps,
): boolean => (
  previous.message === next.message
  && previous.canRetry === next.canRetry
  && previous.darkMode === next.darkMode
  && previous.overlayTheme === next.overlayTheme
  && previous.textColor === next.textColor
  && previous.activeConnectionId === next.activeConnectionId
  && previous.activeConnectionConfig === next.activeConnectionConfig
  && previous.activeDbName === next.activeDbName
  && previous.onEditMessage === next.onEditMessage
  && previous.onRetryMessage === next.onRetryMessage
  && previous.onDeleteMessage === next.onDeleteMessage
  && previous.onMessageRenderError === next.onMessageRenderError
  && haveSameRelevantToolResults(
    next.message.tool_calls,
    previous.toolResultsById,
    next.toolResultsById,
  )
);

const AIChatMessageRow: React.FC<AIChatMessageRowProps> = React.memo(({
  message,
  canRetry,
  toolResultsById,
  darkMode,
  overlayTheme,
  textColor,
  activeConnectionId,
  activeConnectionConfig,
  activeDbName,
  onEditMessage,
  onRetryMessage,
  onDeleteMessage,
  onMessageRenderError,
}) => (
  <AIMessageRenderBoundary
    msg={message}
    darkMode={darkMode}
    overlayTheme={overlayTheme}
    onDeleteMessage={onDeleteMessage}
    onError={onMessageRenderError}
  >
    <AIMessageBubble
      msg={message}
      canRetry={canRetry}
      darkMode={darkMode}
      overlayTheme={overlayTheme}
      textColor={textColor}
      onEdit={onEditMessage}
      onRetry={onRetryMessage}
      onDelete={onDeleteMessage}
      activeConnectionId={activeConnectionId}
      activeConnectionConfig={activeConnectionConfig}
      activeDbName={activeDbName}
      toolResultsById={toolResultsById}
    />
  </AIMessageRenderBoundary>
), areAIChatMessageRowPropsEqual);

interface AIChatMessageListProps extends Omit<
  AIChatMessageRowProps,
  'message' | 'canRetry' | 'toolResultsById'
> {
  messages: AIChatMessage[];
}

const AIChatMessageList: React.FC<AIChatMessageListProps> = ({
  messages,
  ...rowProps
}) => {
  const toolResultsById = React.useMemo(
    () => buildAIToolResultIndex(messages),
    [messages],
  );
  const retryableMessageIds = React.useMemo(
    () => collectRetryableAIChatAssistantMessageIds(messages),
    [messages],
  );

  return (
    <>
      {messages.map((message) => (
        <AIChatMessageRow
          key={message.id}
          {...rowProps}
          message={message}
          canRetry={retryableMessageIds.has(message.id)}
          toolResultsById={toolResultsById}
        />
      ))}
    </>
  );
};

const AIChatPanelConversationView: React.FC<AIChatPanelConversationViewProps> = ({
  mode,
  messages,
  darkMode,
  overlayTheme,
  textColor,
  mutedColor,
  quickActionBg,
  quickActionBorder,
  showScrollBottom,
  contextTableNames,
  isV2Ui,
  insights,
  sessions,
  activeSessionId,
  sessionActionsDisabled = false,
  activeConnectionId,
  activeConnectionConfig,
  activeDbName,
  messagesEndRef,
  onScrollMessages,
  onQuickAction,
  onSelectSession,
  onArchiveSession,
  onEditMessage,
  onRetryMessage,
  onDeleteMessage,
  onMessageRenderError,
  onScrollBottom,
}) => (
  <>
    <div className="ai-chat-messages" onScroll={onScrollMessages}>
      {mode === 'chat' && (
        messages.length === 0 ? (
          <AIChatWelcome
            overlayTheme={overlayTheme}
            quickActionBg={quickActionBg}
            quickActionBorder={quickActionBorder}
            textColor={textColor}
            mutedColor={mutedColor}
            onQuickAction={onQuickAction}
            contextTableNames={contextTableNames}
            isV2Ui={isV2Ui}
          />
        ) : (
          <AIChatMessageList
            messages={messages}
            darkMode={darkMode}
            overlayTheme={overlayTheme}
            textColor={textColor}
            activeConnectionId={activeConnectionId}
            activeConnectionConfig={activeConnectionConfig}
            activeDbName={activeDbName}
            onEditMessage={onEditMessage}
            onRetryMessage={onRetryMessage}
            onDeleteMessage={onDeleteMessage}
            onMessageRenderError={onMessageRenderError}
          />
        )
      )}

      <AIChatPanelModeContent
        mode={mode}
        insights={insights}
        sessions={sessions}
        activeSessionId={activeSessionId}
        sessionActionsDisabled={sessionActionsDisabled}
        onSelectSession={onSelectSession}
        onArchiveSession={onArchiveSession}
      />

      <div ref={messagesEndRef} />
    </div>

    {showScrollBottom && (
      <div
        onClick={onScrollBottom}
        style={{
          position: 'absolute',
          bottom: 120,
          right: 20,
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: darkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.05)',
          backdropFilter: 'blur(8px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          color: textColor,
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          zIndex: 10,
          transition: 'all 0.2s ease',
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.transform = 'scale(1.1)';
          event.currentTarget.style.background = darkMode ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.transform = 'scale(1)';
          event.currentTarget.style.background = darkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.05)';
        }}
      >
        <DownOutlined style={{ fontSize: 14 }} />
      </div>
    )}
  </>
);

export default AIChatPanelConversationView;
