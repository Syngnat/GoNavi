import React, { useState } from 'react';
import { Button, Tooltip, message } from 'antd';
import {
  CheckOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  FileTextOutlined,
  ReloadOutlined,
  WarningOutlined,
  RobotOutlined,
  UserOutlined,
} from '@ant-design/icons';

import type { AIChatMessage } from '../../types';
import { useStore } from '../../store';
import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { I18nParams } from '../../i18n/types';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import { extractJVMChangePlan, resolveJVMAIPlanTargetTabId } from '../../utils/jvmAiPlan';
import {
  parseJVMDiagnosticPlan,
  resolveJVMDiagnosticPlanTargetTabId,
} from '../../utils/jvmDiagnosticPlan';
import { AIMessageMarkdown } from './messageBubble/AIMessageMarkdown';
import { AIThinkingBlock, AIToolCallingBlock } from './messageBubble/AIMessageStatusBlocks';
import { formatAIChatAttachmentSize } from './aiChatAttachments';
import type { AIToolResultIndex } from './aiToolResultIndex';

interface AIMessageBubbleProps {
  msg: AIChatMessage;
  canRetry: boolean;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  textColor: string;
  onEdit: (msg: AIChatMessage) => void;
  onRetry: (msg: AIChatMessage) => void;
  onDelete?: (id: string) => void;
  activeConnectionId?: string;
  activeConnectionConfig?: any;
  activeDbName?: string;
  toolResultsById: AIToolResultIndex;
}

interface AIMessageActionBarProps {
  msg: AIChatMessage;
  isUser: boolean;
  canRetry: boolean;
  isCopied: boolean;
  textColor: string;
  mutedText: string;
  onEdit: (msg: AIChatMessage) => void;
  onRetry: (msg: AIChatMessage) => void;
  onDelete?: (id: string) => void;
  onCopy: () => void;
  copy: (key: string, params?: I18nParams) => string;
}

const AIMessageAttachmentSummary: React.FC<{
  msg: AIChatMessage;
  overlayTheme: OverlayWorkbenchTheme;
}> = ({ msg, overlayTheme }) => {
  const fileAttachments = (msg.attachments || []).filter((attachment) => attachment.kind !== 'image');
  if (fileAttachments.length === 0) {
    return null;
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
      {fileAttachments.map((attachment) => (
        <div
          key={attachment.id}
          title={attachment.extractWarning || attachment.name}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            maxWidth: 260,
            padding: '4px 8px',
            borderRadius: 8,
            border: overlayTheme.shellBorder,
            color: overlayTheme.titleText,
            background: 'rgba(0,0,0,0.03)',
            fontSize: 12,
          }}
        >
          <FileTextOutlined />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachment.name}</span>
          <span style={{ color: overlayTheme.mutedText, flexShrink: 0 }}>{formatAIChatAttachmentSize(attachment.size)}</span>
          {attachment.extractWarning ? <WarningOutlined style={{ color: '#faad14', flexShrink: 0 }} /> : null}
        </div>
      ))}
    </div>
  );
};

const AIMessageActionBar: React.FC<AIMessageActionBarProps> = ({
  msg,
  isUser,
  canRetry,
  isCopied,
  textColor,
  mutedText,
  onEdit,
  onRetry,
  onDelete,
  onCopy,
  copy,
}) => (
  <div className="ai-message-actions" style={{ display: 'flex', gap: 8, opacity: 0, transition: 'opacity 0.2s', padding: '0 4px' }}>
    <Tooltip title={isCopied ? copy('ai_chat.message.action.copied') : copy('ai_chat.message.action.copy_full')}>
      {isCopied ? (
        <CheckOutlined className="ai-action-icon" style={{ color: '#10b981' }} />
      ) : (
        <CopyOutlined
          className="ai-action-icon"
          onClick={onCopy}
          style={{ cursor: 'pointer', color: mutedText }}
          onMouseEnter={(event) => { event.currentTarget.style.color = textColor; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = mutedText; }}
        />
      )}
    </Tooltip>
    {isUser ? (
      <Tooltip title={copy('ai_chat.message.action.edit')}>
        <EditOutlined
          className="ai-action-icon"
          onClick={() => onEdit(msg)}
          style={{ cursor: 'pointer', color: mutedText }}
          onMouseEnter={(event) => { event.currentTarget.style.color = textColor; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = mutedText; }}
        />
      </Tooltip>
    ) : canRetry ? (
      <Tooltip title={copy('ai_chat.message.action.retry')}>
        <ReloadOutlined
          className="ai-action-icon"
          onClick={() => onRetry(msg)}
          style={{ cursor: 'pointer', color: mutedText }}
          onMouseEnter={(event) => { event.currentTarget.style.color = textColor; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = mutedText; }}
        />
      </Tooltip>
    ) : null}
    {onDelete ? (
      <Tooltip title={copy('ai_chat.message.action.delete')}>
        <DeleteOutlined
          className="ai-action-icon"
          onClick={() => onDelete(msg.id)}
          style={{ cursor: 'pointer', color: mutedText }}
          onMouseEnter={(event) => { event.currentTarget.style.color = '#ef4444'; }}
          onMouseLeave={(event) => { event.currentTarget.style.color = mutedText; }}
        />
      </Tooltip>
    ) : null}
  </div>
);

const AIRawErrorButton: React.FC<{
  messageId: string;
  rawError: string;
  darkMode: boolean;
  overlayTheme: OverlayWorkbenchTheme;
  copy: (key: string, params?: I18nParams) => string;
}> = ({ messageId, rawError, darkMode, overlayTheme, copy }) => (
  <div style={{ marginTop: 8 }}>
    <button
      onClick={() => {
        navigator.clipboard.writeText(rawError || '');
        const button = document.getElementById(`raw-err-btn-${messageId}`);
        if (button) {
          button.textContent = `✅ ${copy('ai_chat.message.action.copied_error_raw')}`;
          setTimeout(() => {
            button.textContent = `📋 ${copy('ai_chat.message.action.copy_error_raw')}`;
          }, 1500);
        }
      }}
      id={`raw-err-btn-${messageId}`}
      style={{
        fontSize: 12,
        padding: '3px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        border: `1px solid ${darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'}`,
        background: darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
        color: overlayTheme.mutedText,
        transition: 'all 0.15s ease',
      }}
    >
      📋 {copy('ai_chat.message.action.copy_error_raw')}
    </button>
  </div>
);

export const AIMessageBubble: React.FC<AIMessageBubbleProps> = React.memo(({
  msg,
  canRetry,
  darkMode,
  overlayTheme,
  textColor,
  onEdit,
  onRetry,
  onDelete,
  activeConnectionId,
  activeConnectionConfig,
  activeDbName,
  toolResultsById,
}) => {
  const [isCopied, setIsCopied] = useState(false);
  const i18n = useOptionalI18n();
  const copy = (key: string, params?: I18nParams) => (
    i18n?.t ?? ((catalogKey, catalogParams) => catalogTranslate('en-US', catalogKey, catalogParams))
  )(key, params);
  const isUser = msg.role === 'user';

  const { displayContent, parsedThinking } = React.useMemo(() => {
    const content = msg.content || '';
    if (msg.thinking) {
      return { displayContent: content, parsedThinking: msg.thinking };
    }
    const thinkRegex = /<think>([\s\S]*?)(?:<\/think>|$)/g;
    const thinkParts: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = thinkRegex.exec(content)) !== null) {
      thinkParts.push(match[1].trim());
    }
    if (thinkParts.length > 0) {
      return {
        displayContent: content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').trim(),
        parsedThinking: thinkParts.join('\n\n'),
      };
    }
    return { displayContent: content, parsedThinking: '' };
  }, [msg.content, msg.thinking]);

  const jvmPlan = React.useMemo(() => {
    if (isUser) {
      return null;
    }
    return extractJVMChangePlan(displayContent);
  }, [displayContent, isUser]);

  const jvmDiagnosticPlan = React.useMemo(() => {
    if (isUser) {
      return null;
    }
    return parseJVMDiagnosticPlan(displayContent, copy);
  }, [copy, displayContent, isUser]);

  const isTypingThinking = Boolean(msg.loading && msg.phase === 'thinking');

  if (msg.role === 'tool') {
    return null;
  }

  const isWaitState = msg.phase === 'connecting'
    || (msg.loading && !msg.content && (msg.phase === 'thinking' || msg.phase === 'tool_calling'));

  if (isWaitState) {
    return (
      <div className="ai-ide-message" style={{ borderBottom: 'none', padding: '8px 16px' }}>
        <div style={{
          background: darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
          borderRadius: 12,
          padding: '14px 16px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: overlayTheme.mutedText }}>
            <div className="ai-wave-pulse">
              <span /> <span /> <span />
            </div>
            <span style={{ fontSize: 13, opacity: 0.8 }}>{msg.content || copy('ai_chat.message.wait.connecting')}...</span>
          </div>

          <div style={{ marginTop: parsedThinking || (msg.tool_calls && msg.tool_calls.length > 0) ? 12 : 0 }}>
            {!isUser && parsedThinking && (
              <AIThinkingBlock
                displayThinking={parsedThinking}
                isTyping={isTypingThinking}
                isGlobalLoading={Boolean(msg.loading)}
                darkMode={darkMode}
                overlayTheme={overlayTheme}
                hasContent={false}
              />
            )}
            {!isUser && msg.tool_calls && msg.tool_calls.length > 0 && (
              <AIToolCallingBlock
                toolCalls={msg.tool_calls}
                loading={Boolean(msg.loading)}
                toolResultsById={toolResultsById}
                darkMode={darkMode}
                overlayTheme={overlayTheme}
                hasContent={false}
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ai-ide-message" style={{ borderBottom: 'none', padding: '8px 16px' }}>
      <div style={{
        background: isUser ? (darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)') : (darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)'),
        borderRadius: 12,
        padding: '14px 16px',
      }}>
        <div className="ai-ide-message-header" style={{
          color: isUser ? overlayTheme.mutedText : overlayTheme.titleText,
          marginBottom: isUser ? 6 : 10,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <div>
            {isUser
              ? <><UserOutlined /> <span>{copy('ai_chat.message.role.user')}</span></>
              : <><RobotOutlined style={{ color: overlayTheme.iconColor }} /> <span>GoNavi AI</span></>}
          </div>
          <AIMessageActionBar
            msg={msg}
            isUser={isUser}
            canRetry={canRetry}
            isCopied={isCopied}
            textColor={textColor}
            mutedText={overlayTheme.mutedText}
            onEdit={onEdit}
            onRetry={onRetry}
            onDelete={onDelete}
            onCopy={() => {
              navigator.clipboard.writeText(msg.content);
              setIsCopied(true);
              setTimeout(() => setIsCopied(false), 2000);
            }}
            copy={copy}
          />
        </div>

        <div className="ai-ide-message-content ai-markdown-content" style={{ color: textColor }}>
          {msg.images && msg.images.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {msg.images.map((image, index) => (
                <img key={index} src={image} alt={copy('ai_chat.message.image_alt', { index })} style={{ maxWidth: 200, maxHeight: 200, borderRadius: 8, objectFit: 'contain', border: overlayTheme.shellBorder }} />
              ))}
            </div>
          )}
          <AIMessageAttachmentSummary msg={msg} overlayTheme={overlayTheme} />

          {!isUser && parsedThinking && (
            <AIThinkingBlock
              displayThinking={parsedThinking}
              isTyping={isTypingThinking}
              isGlobalLoading={Boolean(msg.loading)}
              darkMode={darkMode}
              overlayTheme={overlayTheme}
              hasContent={Boolean(msg.content)}
            />
          )}

          {isUser ? (
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>{msg.content}</div>
          ) : (
            <AIMessageMarkdown
              content={displayContent}
              darkMode={darkMode}
              overlayTheme={overlayTheme}
              activeConnectionConfig={activeConnectionConfig}
              activeConnectionId={activeConnectionId}
              activeDbName={activeDbName}
            />
          )}

          {!isUser && jvmPlan && (
            <div style={{ marginTop: 12 }}>
              <Button
                size="small"
                type="primary"
                onClick={() => {
                  const targetContext = msg.jvmPlanContext;
                  if (!targetContext) {
                    message.warning(copy('ai_chat.message.jvm.missing_plan_context'));
                    return;
                  }

                  const store = useStore.getState();
                  const targetTabId = resolveJVMAIPlanTargetTabId(store.tabs, targetContext);
                  if (!targetTabId) {
                    message.warning(copy('ai_chat.message.jvm.plan_target_not_found'));
                    return;
                  }

                  window.dispatchEvent(new CustomEvent('gonavi:jvm-apply-ai-plan', {
                    detail: {
                      plan: jvmPlan,
                      targetTabId,
                      connectionId: targetContext.connectionId,
                      providerMode: targetContext.providerMode,
                      resourcePath: targetContext.resourcePath,
                    },
                  }));
                }}
              >
                {copy('ai_chat.message.jvm.apply_preview')}
              </Button>
            </div>
          )}

          {!isUser && jvmDiagnosticPlan && (
            <div style={{ marginTop: 12 }}>
              <Button
                size="small"
                type="primary"
                onClick={() => {
                  const targetContext = msg.jvmDiagnosticPlanContext;
                  if (!targetContext) {
                    message.warning(copy('ai_chat.message.jvm.missing_diagnostic_context'));
                    return;
                  }

                  const store = useStore.getState();
                  const targetTabId = resolveJVMDiagnosticPlanTargetTabId(
                    store.tabs,
                    store.connections,
                    targetContext,
                  );
                  if (!targetTabId) {
                    message.warning(copy('ai_chat.message.jvm.diagnostic_target_not_found'));
                    return;
                  }

                  window.dispatchEvent(new CustomEvent('gonavi:jvm-apply-diagnostic-plan', {
                    detail: {
                      plan: jvmDiagnosticPlan,
                      targetTabId,
                      connectionId: targetContext.connectionId,
                      transport: targetContext.transport,
                    },
                  }));
                }}
              >
                {copy('ai_chat.message.jvm.apply_diagnostic')}
              </Button>
            </div>
          )}

          {!isUser && msg.rawError && (
            <AIRawErrorButton
              messageId={msg.id}
              rawError={msg.rawError}
              darkMode={darkMode}
              overlayTheme={overlayTheme}
              copy={copy}
            />
          )}

          {!isUser && msg.tool_calls && msg.tool_calls.length > 0 && (
            <AIToolCallingBlock
              toolCalls={msg.tool_calls}
              loading={Boolean(msg.loading)}
              toolResultsById={toolResultsById}
              darkMode={darkMode}
              overlayTheme={overlayTheme}
              hasContent={Boolean(msg.content)}
            />
          )}

          {msg.loading && msg.phase !== 'tool_calling' && msg.content && (
            <span className="ai-blinking-cursor" style={{ background: overlayTheme.iconColor }} />
          )}
        </div>
      </div>
    </div>
  );
});
