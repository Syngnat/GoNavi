import React from 'react';

import type { I18nParams } from '../../../i18n/types';
import type { AIChatMessage } from '../../../types';
import type { OverlayWorkbenchTheme } from '../../../utils/overlayWorkbenchTheme';
import { formatMessageTime, formatProcessingDuration } from '../aiMessageTimeFormat';
import { aiPx } from '../aiScale';

interface AIMessageFooterProps {
  msg: AIChatMessage;
  isUser: boolean;
  /** Token usage is only meaningful for a finished, non-error assistant reply. */
  showUsage: boolean;
  language: string;
  overlayTheme: OverlayWorkbenchTheme;
  copy: (key: string, params?: I18nParams) => string;
}

const formatTokenCount = (value: number | undefined): string => {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '—';
  return String(Math.floor(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};

const formatCacheRate = (cachedTokens: number | undefined, promptTokens: number | undefined): string => {
  if (cachedTokens === undefined || promptTokens === undefined) return '—';
  if (promptTokens <= 0) return cachedTokens === 0 ? '0%' : '—';
  const percentage = Math.min(100, Math.max(0, (cachedTokens / promptTokens) * 100));
  return `${Number(percentage.toFixed(1))}%`;
};

/** Send time for every message, AI processing time and token usage for assistant replies. */
export const AIMessageFooter: React.FC<AIMessageFooterProps> = ({
  msg,
  isUser,
  showUsage,
  language,
  overlayTheme,
  copy,
}) => {
  const time = formatMessageTime(msg.timestamp);
  const processing = !isUser && msg.processingMs
    ? formatProcessingDuration(msg.processingMs, language)
    : '';
  const segments: Array<{ key: string; text: string; title?: string }> = [];
  if (time) segments.push({ key: 'time', text: time, title: new Date(msg.timestamp).toLocaleString(language) });
  if (processing) {
    segments.push({ key: 'processing', text: copy('ai_chat.message.processing_time', { duration: processing }) });
  }
  if (showUsage) {
    segments.push(
      { key: 'input', text: `${copy('ai_chat.message.usage.input')} ${formatTokenCount(msg.tokenUsage?.promptTokens)}` },
      { key: 'output', text: `${copy('ai_chat.message.usage.output')} ${formatTokenCount(msg.tokenUsage?.completionTokens)}` },
      {
        key: 'cache',
        text: `${copy('ai_chat.message.usage.cache_rate')} ${formatCacheRate(msg.tokenUsage?.cachedTokens, msg.tokenUsage?.promptTokens)}`,
      },
    );
  }
  if (segments.length === 0) return null;

  return (
    <div
      className="ai-message-footer"
      data-testid="ai-message-footer"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        marginTop: isUser ? 6 : 10,
        paddingTop: isUser ? 0 : 8,
        borderTop: isUser ? undefined : overlayTheme.shellBorder,
        color: overlayTheme.mutedText,
        fontSize: aiPx(11),
        lineHeight: 1.4,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {segments.map((segment, index) => (
        <React.Fragment key={segment.key}>
          {index > 0 ? <span aria-hidden="true">·</span> : null}
          <span title={segment.title}>{segment.text}</span>
        </React.Fragment>
      ))}
    </div>
  );
};
