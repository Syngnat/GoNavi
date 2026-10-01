import React from 'react';
import { Button } from 'antd';
import { ExclamationCircleFilled } from '@ant-design/icons';

import type { AIComposerNotice } from '../../utils/aiComposerNotice';
import { aiPx } from './aiScale';

interface AIChatComposerNoticeProps {
  composerNotice?: AIComposerNotice | null;
  darkMode: boolean;
  textColor: string;
  mutedColor: string;
  onComposerNoticeAction?: () => void;
}

const resolveNoticePalette = (tone: AIComposerNotice['tone'] | undefined, darkMode: boolean) => {
  if (tone === 'error') {
    return darkMode
      ? {
        background: 'rgba(255,120,117,0.12)',
        borderColor: 'rgba(255,120,117,0.24)',
        iconColor: '#ff7875',
      }
      : {
        background: 'rgba(255,77,79,0.08)',
        borderColor: 'rgba(255,77,79,0.16)',
        iconColor: '#ff4d4f',
      };
  }

  return darkMode
    ? {
      background: 'rgba(250,173,20,0.12)',
      borderColor: 'rgba(250,173,20,0.22)',
      iconColor: '#ffd666',
    }
    : {
      background: 'rgba(250,173,20,0.08)',
      borderColor: 'rgba(250,173,20,0.18)',
      iconColor: '#d48806',
    };
};

export const AIChatComposerNotice: React.FC<AIChatComposerNoticeProps> = ({
  composerNotice,
  darkMode,
  textColor,
  mutedColor,
  onComposerNoticeAction,
}) => {
  if (!composerNotice) {
    return null;
  }

  const palette = resolveNoticePalette(composerNotice.tone, darkMode);
  const actionLabel = composerNotice.action?.label;

  return (
    <div
      data-ai-chat-composer-notice="true"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 12,
        background: palette.background,
        border: `1px solid ${palette.borderColor}`,
      }}
    >
      <ExclamationCircleFilled style={{ color: palette.iconColor, fontSize: aiPx(14), marginTop: 1, flexShrink: 0 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: aiPx(12), fontWeight: 600, color: textColor, lineHeight: 1.4 }}>
          {composerNotice.title}
        </div>
        <div style={{ fontSize: aiPx(11), color: mutedColor, lineHeight: 1.5, marginTop: 2, wordBreak: 'break-word' }}>
          {composerNotice.description}
        </div>
        {actionLabel && typeof onComposerNoticeAction === 'function' && (
          <Button
            size="small"
            type="default"
            onClick={onComposerNoticeAction}
            style={{ marginTop: 8, borderRadius: 8 }}
          >
            {actionLabel}
          </Button>
        )}
      </div>
    </div>
  );
};

export default AIChatComposerNotice;
