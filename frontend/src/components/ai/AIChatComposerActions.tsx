import React from 'react';
import { Button, Segmented, Tooltip } from 'antd';
import { GnAttachIcon, GnSendIcon, GnSlashCommandIcon, GnStopIcon, GnTableIcon } from '../icons/gnIcons';

import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import type { OverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';
import { AI_CHAT_ATTACHMENT_ACCEPT } from './aiChatAttachments';
import type { AIRunDispatchMode } from './aiRunHarnessClient';

interface AIChatComposerActionsProps {
  input: string;
  draftAttachmentCount: number;
  /** An editor selection is bound to the chat: it is something to send by itself. */
  hasBoundSelection?: boolean;
  /** An image's text is still being read: sending now would leave it out. */
  recognizingImages?: boolean;
  sending: boolean;
  dispatchMode?: AIRunDispatchMode;
  hasActiveRun?: boolean;
  stopRequestPending?: boolean;
  onDispatchModeChange?: (mode: AIRunDispatchMode) => void;
  overlayTheme: OverlayWorkbenchTheme;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onAttachmentUpload: React.ChangeEventHandler<HTMLInputElement>;
  onOpenContext: () => void;
  onOpenSlashMenu?: () => void;
  onSend: () => void;
  onStop: () => void;
}

const AIChatComposerActions: React.FC<AIChatComposerActionsProps> = ({
  input,
  draftAttachmentCount,
  hasBoundSelection = false,
  recognizingImages = false,
  sending,
  dispatchMode = 'queue',
  hasActiveRun = false,
  stopRequestPending = false,
  onDispatchModeChange,
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
  const canSend = (input.trim().length > 0 || draftAttachmentCount > 0 || hasBoundSelection) && !recognizingImages;
  const canChooseDispatchMode = hasActiveRun && typeof onDispatchModeChange === 'function';
  const showStopControl = sending || hasActiveRun;
  const v2IconButtonStyle: React.CSSProperties = {
    color: overlayTheme.mutedText,
    border: 'none',
    background: 'transparent',
  };

  return (
    <div
      className="gn-v2-ai-input-actions"
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
          icon={<GnAttachIcon />}
          onClick={() => fileInputRef.current?.click()}
          style={v2IconButtonStyle}
        />
      </Tooltip>
      <Tooltip title={t('ai_chat.input.tooltip.attach_table_context')}>
        <Button
          type="text"
          icon={<GnTableIcon />}
          onClick={onOpenContext}
          style={v2IconButtonStyle}
        />
      </Tooltip>
      <Tooltip title={t('ai_chat.input.tooltip.slash_command')}>
        <Button
          type="text"
          icon={<GnSlashCommandIcon />}
          onClick={onOpenSlashMenu}
          style={v2IconButtonStyle}
        />
      </Tooltip>
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
      {showStopControl && (
        <button
          type="button"
          className="ai-chat-send-btn ai-chat-stop-btn gn-v2-ai-send"
          onClick={onStop}
          disabled={stopRequestPending}
          aria-busy={stopRequestPending}
          title={t('ai_chat.input.action.stop')}
        >
          <GnStopIcon />
        </button>
      )}
      {(!sending || (hasActiveRun && canSend)) && (
        <button
          type="button"
          className="ai-chat-send-btn gn-v2-ai-send"
          onClick={() => onSend()}
          disabled={!canSend}
          title={recognizingImages
            ? t('ocr_component.composer.recognizing')
            : canChooseDispatchMode
              ? t(dispatchMode === 'steer' ? 'ai_chat.input.dispatch.send_steer' : 'ai_chat.input.dispatch.send_queue')
              : t('ai_chat.input.action.send')}
        >
          <GnSendIcon />
        </button>
      )}
    </div>
  );
};

export default AIChatComposerActions;
