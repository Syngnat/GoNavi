import React from 'react';
import { Tooltip } from 'antd';
import { CodeOutlined, CommentOutlined, TableOutlined } from '@ant-design/icons';

import type { AIChatAttachment } from '../../types';
import type { I18nParams } from '../../i18n/types';
import { aiPx } from './aiScale';
import { isContextChipAttachment } from './aiContextChips';

export type AIContextChipCopy = (key: string, params?: I18nParams) => string;

interface AIContextChipsProps {
  attachments: AIChatAttachment[] | undefined;
  copy: AIContextChipCopy;
}

// The full text can be long (a whole query): keep the hover box a sensible size and
// scrollable. The mouse may move onto it, so a long text can be scrolled.
const TOOLTIP_MAX_WIDTH = 620;
const TOOLTIP_MAX_HEIGHT = 340;

const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  maxWidth: 280,
  padding: '3px 9px',
  borderRadius: 999,
  background: 'rgba(22, 119, 255, 0.08)',
  color: '#1677ff',
  fontSize: aiPx(12),
  lineHeight: 1.5,
  cursor: 'default',
};

const removeButtonStyle: React.CSSProperties = {
  flex: 'none',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  padding: 0,
  marginLeft: 2,
  lineHeight: 1,
  opacity: 0.7,
};

const HINT_KEY: Record<NonNullable<AIChatAttachment['contextKind']>, string> = {
  editor_selection: 'ai_chat.message.context_chip.selection_hint',
  table_schema: 'ai_chat.message.context_chip.table_hint',
  chat_quote: 'ai_chat.message.context_chip.quote_hint',
};

const FALLBACK_LABEL_KEY: Partial<Record<NonNullable<AIChatAttachment['contextKind']>, string>> = {
  editor_selection: 'ai_chat.message.context_chip.selection_fallback',
  chat_quote: 'ai_chat.message.context_chip.quote_fallback',
};

const ChipIcon: React.FC<{ kind: AIChatAttachment['contextKind'] }> = ({ kind }) => {
  if (kind === 'table_schema') return <TableOutlined />;
  if (kind === 'chat_quote') return <CommentOutlined />;
  return <CodeOutlined />;
};

/** One bound-context chip: an abbreviated pill whose hover shows the full text. */
export const AIContextChip: React.FC<{
  chip: AIChatAttachment;
  copy: AIContextChipCopy;
  /** Present in the composer, where a chip can still be taken back. */
  onRemove?: () => void;
}> = ({ chip, copy, onRemove }) => {
  const kind = chip.contextKind || 'editor_selection';
  const fallbackKey = FALLBACK_LABEL_KEY[kind];
  const label = chip.name.trim() || (fallbackKey ? copy(fallbackKey) : '');
  // Only the name is shortened when it is long; the size stays visible.
  const size = kind === 'editor_selection' && chip.contextLines
    ? copy('ai_chat.message.context_chip.lines', { n: chip.contextLines })
    : '';
  const title = copy(HINT_KEY[kind]);
  return (
    <Tooltip
      mouseLeaveDelay={0.15}
      styles={{ root: { maxWidth: TOOLTIP_MAX_WIDTH } }}
      title={(
        <div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{title}{label ? ` · ${label}` : ''}</div>
          <pre
            style={{
              margin: 0,
              maxHeight: TOOLTIP_MAX_HEIGHT,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize: aiPx(12),
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            }}
          >
            {chip.text || ''}
          </pre>
        </div>
      )}
    >
      <span className="gn-v2-ai-context-chip-pill" style={chipStyle} data-context-kind={kind}>
        <ChipIcon kind={kind} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{label}</span>
        {size ? <span style={{ flex: 'none', opacity: 0.75, whiteSpace: 'nowrap' }}>· {size}</span> : null}
        {onRemove ? (
          <button
            type="button"
            style={removeButtonStyle}
            aria-label={copy('ai_chat.message.context_chip.remove')}
            onClick={(event) => { event.stopPropagation(); onRemove(); }}
          >
            ×
          </button>
        ) : null}
      </span>
    </Tooltip>
  );
};

/** The bound-context chips of a sent message; renders nothing when there are none. */
export const AIContextChips: React.FC<AIContextChipsProps> = ({ attachments, copy }) => {
  const chips = (attachments || []).filter(isContextChipAttachment);
  if (chips.length === 0) {
    return null;
  }
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
      {chips.map((chip) => <AIContextChip key={chip.id} chip={chip} copy={copy} />)}
    </div>
  );
};

export default AIContextChips;
