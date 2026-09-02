import React from 'react';
import { Button, Segmented, Tooltip } from 'antd';
import { CodeOutlined, PictureOutlined, SendOutlined, StopOutlined, TableOutlined } from '@ant-design/icons';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import { AI_CHAT_ATTACHMENT_ACCEPT } from './aiChatAttachments';
import type { AIRunDispatchMode } from './aiRunHarnessClient';

interface AIChatComposerActionsProps {
  variant: 'legacy' | 'v2';
  input: string;
  draftAttachmentCount: number;
  sending: boolean;
  dispatchMode?: AIRunDispatchMode;
  hasActiveRun?: boolean;
  onDispatchModeChange?: (mode: AIRunDispatchMode) => void;
  darkMode: boolean;
  textColor: string;
  mutedColor: string;
  overlayTheme: OverlayWorkbenchTheme;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onAttachmentUpload: React.ChangeEventHandler<HTMLInputElement>;
  onOpenContext: () => void;
  onOpenSlashMenu?: () => void;
  onSend: () => void;
  onStop: () => void;
}

const buttonIconStyle = { fontSize: 16 };

const AIChatComposerActions: React.FC<AIChatComposerActionsProps> = ({
  variant,
  input,
  draftAttachmentCount,
  sending,
  dispatchMode = 'queue',
  hasActiveRun = false,
  onDispatchModeChange,
  darkMode,
  textColor,
  mutedColor,
  overlayTheme,
  fileInputRef,
  onAttachmentUpload,
  onOpenContext,
  onOpenSlashMenu,
  onSend,
  onStop,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));
  const canSend = input.trim().length > 0 || draftAttachmentCount > 0;
  const isV2 = variant === 'v2';
  const canChooseDispatchMode = hasActiveRun && typeof onDispatchModeChange === 'function';
  const legacyIconButtonStyle: React.CSSProperties = {
    color: overlayTheme.mutedText,
    border: 'none',
    background: 'transparent',
    padding: '0 4px',
    height: 26,
  };
  const v2IconButtonStyle: React.CSSProperties = {
    color: overlayTheme.mutedText,
    border: 'none',
    background: 'transparent',
  };

  return (
    <div
      className={isV2 ? 'gn-v2-ai-input-actions' : undefined}
      style={isV2 ? undefined : { display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}
    >
      <input
        type="file"
        accept={AI_CHAT_ATTACHMENT_ACCEPT}
        multiple
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={onAttachmentUpload}
      />
      <Tooltip title={t('ai_chat.input.tooltip.upload_attachment')}>
        <Button
          type="text"
          icon={<PictureOutlined style={isV2 ? undefined : buttonIconStyle} />}
          onClick={() => fileInputRef.current?.click()}
          style={isV2 ? v2IconButtonStyle : legacyIconButtonStyle}
          onMouseEnter={isV2 ? undefined : (event) => { event.currentTarget.style.color = textColor; }}
          onMouseLeave={isV2 ? undefined : (event) => { event.currentTarget.style.color = overlayTheme.mutedText; }}
        />
      </Tooltip>
      <Tooltip title={t('ai_chat.input.tooltip.attach_table_context')}>
        <Button
          type="text"
          icon={<TableOutlined style={isV2 ? undefined : buttonIconStyle} />}
          onClick={onOpenContext}
          style={isV2 ? v2IconButtonStyle : legacyIconButtonStyle}
          onMouseEnter={isV2 ? undefined : (event) => { event.currentTarget.style.color = textColor; }}
          onMouseLeave={isV2 ? undefined : (event) => { event.currentTarget.style.color = overlayTheme.mutedText; }}
        />
      </Tooltip>
      {isV2 && (
        <Tooltip title={t('ai_chat.input.tooltip.slash_command')}>
          <Button
            type="text"
            icon={<CodeOutlined />}
            onClick={onOpenSlashMenu}
            style={v2IconButtonStyle}
          />
        </Tooltip>
      )}
      {canChooseDispatchMode && (
        <Tooltip title={t('ai_chat.input.dispatch.tooltip')}>
          <Segmented
            className="ai-run-dispatch-mode"
            size="small"
            aria-label={t('ai_chat.input.dispatch.tooltip')}
            value={dispatchMode}
            onChange={(value) => onDispatchModeChange?.(String(value) as AIRunDispatchMode)}
            options={[
              { label: t('ai_chat.input.dispatch.queue'), value: 'queue' },
              { label: t('ai_chat.input.dispatch.steer'), value: 'steer' },
            ]}
          />
        </Tooltip>
      )}
      {sending && (
        <button
          type={isV2 ? 'button' : undefined}
          className={isV2 ? 'ai-chat-send-btn ai-chat-stop-btn gn-v2-ai-send' : 'ai-chat-send-btn ai-chat-stop-btn'}
          onClick={onStop}
          title={t('ai_chat.input.action.stop')}
          style={isV2 ? undefined : {
            background: 'rgba(255,77,79,0.1)',
            color: '#ff4d4f',
            border: '1px solid rgba(255,77,79,0.2)',
            width: 26,
            height: 26,
            borderRadius: 6,
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          {isV2 ? <StopOutlined /> : <div style={{ width: 10, height: 10, background: 'currentColor', borderRadius: 2 }} />}
        </button>
      )}
      {(!sending || (hasActiveRun && canSend)) && (
        <button
          type={isV2 ? 'button' : undefined}
          className={isV2 ? 'ai-chat-send-btn gn-v2-ai-send' : 'ai-chat-send-btn'}
          onClick={() => onSend()}
          disabled={!canSend}
          title={canChooseDispatchMode
            ? t(dispatchMode === 'steer' ? 'ai_chat.input.dispatch.send_steer' : 'ai_chat.input.dispatch.send_queue')
            : t('ai_chat.input.action.send')}
          style={isV2 ? undefined : {
            background: canSend ? overlayTheme.iconBg : (darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'),
            color: canSend ? overlayTheme.iconColor : mutedColor,
            width: 26,
            height: 26,
            borderRadius: 6,
            border: 'none',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: canSend ? 'pointer' : 'not-allowed',
            flexShrink: 0,
          }}
        >
          <SendOutlined />
        </button>
      )}
    </div>
  );
};

export default AIChatComposerActions;
