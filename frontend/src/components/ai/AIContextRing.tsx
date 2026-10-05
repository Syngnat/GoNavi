import React from 'react';
import { Popover } from 'antd';

import type { I18nParams } from '../../i18n/types';
import { formatContextSize } from '../../utils/aiChatRuntime';
import type { AIContextBreakdown, AIContextSegmentId } from './aiContextBreakdown';
import './AIContextRing.css';

type Copy = (key: string, params?: I18nParams) => string;

interface AIContextRingProps {
  breakdown: AIContextBreakdown;
  copy: Copy;
}

const SEGMENT_LABEL_KEYS: Record<AIContextSegmentId, string> = {
  instructions: 'ai_chat.context_ring.segment.instructions',
  workspace: 'ai_chat.context_ring.segment.workspace',
  bound: 'ai_chat.context_ring.segment.bound',
  skills: 'ai_chat.context_ring.segment.skills',
  user: 'ai_chat.context_ring.segment.user',
  assistant: 'ai_chat.context_ring.segment.assistant',
  toolResults: 'ai_chat.context_ring.segment.tool_results',
};

/** Always shown, even when empty: the person asked where each of these stands. */
const ALWAYS_LISTED: ReadonlySet<AIContextSegmentId> = new Set(['skills']);

export const formatRingSize = (value: number): string => (
  value < 1000 ? String(Math.round(value)) : formatContextSize(value, true)
);

const formatShare = (size: number, windowSize: number): string => {
  if (size <= 0) return '0%';
  const percent = (size / windowSize) * 100;
  return percent < 1 ? '<1%' : `${Math.round(percent)}%`;
};

const RING_RADIUS = 15.9155; // a circumference of 100, so a dash length is a percentage

/** The context window as a small circle that fills as the conversation grows. */
export const AIContextRing: React.FC<AIContextRingProps> = ({ breakdown, copy }) => {
  const percent = Math.min(100, Math.max(0, breakdown.pressure * 100));
  const ariaLabel = copy('ai_chat.context_ring.aria', { percent: Math.round(percent) });
  const listed = breakdown.segments.filter((segment) => segment.size > 0 || ALWAYS_LISTED.has(segment.id));

  const content = (
    <div className="gn-ai-ctx-popover" data-level={breakdown.level}>
      <div className="gn-ai-ctx-head">
        <span className="gn-ai-ctx-title">{copy('ai_chat.context_ring.title')}</span>
        <span className="gn-ai-ctx-summary">
          {copy('ai_chat.context_ring.summary', {
            used: formatRingSize(breakdown.used),
            budget: formatRingSize(breakdown.budget),
            percent: Math.round(percent),
          })}
        </span>
      </div>
      <div className="gn-ai-ctx-bar" aria-hidden="true">
        {breakdown.segments.filter((segment) => segment.size > 0).map((segment) => (
          <span
            key={segment.id}
            className="gn-ai-ctx-bar-part"
            data-seg={segment.id}
            style={{ width: `${(segment.size / breakdown.windowSize) * 100}%` }}
          />
        ))}
        <span className="gn-ai-ctx-bar-part" data-seg="reserved" style={{ width: `${(breakdown.reserved / breakdown.windowSize) * 100}%` }} />
      </div>
      <ul className="gn-ai-ctx-list">
        {listed.map((segment) => (
          <li key={segment.id} data-seg={segment.id}>
            <i className="gn-ai-ctx-dot" data-seg={segment.id} aria-hidden="true" />
            <span className="gn-ai-ctx-label">{copy(SEGMENT_LABEL_KEYS[segment.id])}</span>
            <span className="gn-ai-ctx-size">{formatRingSize(segment.size)}</span>
            <span className="gn-ai-ctx-share">{formatShare(segment.size, breakdown.windowSize)}</span>
          </li>
        ))}
        <li data-seg="reserved">
          <i className="gn-ai-ctx-dot" data-seg="reserved" aria-hidden="true" />
          <span className="gn-ai-ctx-label">{copy('ai_chat.context_ring.segment.reserved')}</span>
          <span className="gn-ai-ctx-size">{formatRingSize(breakdown.reserved)}</span>
          <span className="gn-ai-ctx-share">{formatShare(breakdown.reserved, breakdown.windowSize)}</span>
        </li>
        <li data-seg="free">
          <i className="gn-ai-ctx-dot" data-seg="free" aria-hidden="true" />
          <span className="gn-ai-ctx-label">{copy('ai_chat.context_ring.segment.free')}</span>
          <span className="gn-ai-ctx-size">{formatRingSize(breakdown.free)}</span>
          <span className="gn-ai-ctx-share">{formatShare(breakdown.free, breakdown.windowSize)}</span>
        </li>
      </ul>
      <div className="gn-ai-ctx-window">
        {copy('ai_chat.context_ring.window', { window: formatContextSize(breakdown.windowSize) })}
      </div>
      {breakdown.overflow && <div className="gn-ai-ctx-note is-alert">{copy('ai_chat.context_ring.note.overflow')}</div>}
      {breakdown.omittedMessages ? <div className="gn-ai-ctx-note">{copy('ai_chat.context_ring.note.omitted', { count: breakdown.omittedMessages })}</div> : null}
      {breakdown.workspaceTrimmed ? <div className="gn-ai-ctx-note">{copy('ai_chat.context_ring.note.workspace_trimmed')}</div> : null}
      <div className="gn-ai-ctx-note">{copy('ai_chat.context_ring.note.skills')}</div>
      <div className="gn-ai-ctx-note">{copy('ai_chat.context_ring.note.estimate')}</div>
    </div>
  );

  return (
    <Popover content={content} trigger={['hover', 'click']} placement="topRight" mouseEnterDelay={0.12} overlayClassName="gn-ai-ctx-overlay">
      <button type="button" className="gn-ai-ctx-ring" data-level={breakdown.level} aria-label={ariaLabel}>
        <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
          <circle className="gn-ai-ctx-ring-track" cx="18" cy="18" r={RING_RADIUS} />
          <circle
            className="gn-ai-ctx-ring-arc"
            cx="18"
            cy="18"
            r={RING_RADIUS}
            strokeDasharray={`${percent} ${100 - percent}`}
          />
        </svg>
      </button>
    </Popover>
  );
};

export default AIContextRing;
