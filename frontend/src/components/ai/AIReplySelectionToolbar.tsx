import React from 'react';
import { createPortal } from 'react-dom';
import { CommentOutlined, PlusOutlined } from '@ant-design/icons';

import type { I18nParams } from '../../i18n/types';
import { resolveReplySelection, type ReplySelection } from './aiReplySelection';

export type AIQuoteMode = 'reply' | 'context';

interface AIReplySelectionToolbarProps {
  /** The chat panel: only selections inside it are offered. */
  rootRef: React.RefObject<HTMLElement | null>;
  onQuote: (text: string, messageId: string, mode: AIQuoteMode) => void;
  copy: (key: string, params?: I18nParams) => string;
}

const TOOLBAR_HEIGHT = 34;

const toolbarStyle = (anchor: ReplySelection['anchor']): React.CSSProperties => {
  const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const x = Math.min(Math.max(anchor.x, 110), Math.max(110, viewportWidth - 110));
  const aboveSelection = anchor.y - TOOLBAR_HEIGHT - 8;
  return {
    position: 'fixed',
    left: x,
    top: aboveSelection >= 8 ? aboveSelection : anchor.y + 24,
    transform: 'translateX(-50%)',
    zIndex: 2000,
    display: 'flex',
    gap: 2,
    padding: 3,
    borderRadius: 9,
    background: '#262626',
    boxShadow: '0 6px 20px rgba(0, 0, 0, 0.28)',
  };
};

const buttonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 10px',
  border: 'none',
  borderRadius: 7,
  background: 'transparent',
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

/**
 * A small floating toolbar over text selected in an AI answer, like the quote
 * action in Claude's desktop app: reply to the passage, or just add it to the
 * context of the next message.
 */
export const AIReplySelectionToolbar: React.FC<AIReplySelectionToolbarProps> = ({ rootRef, onQuote, copy }) => {
  const [selection, setSelection] = React.useState<ReplySelection | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    const refresh = () => setSelection(resolveReplySelection(window.getSelection() as any, rootRef.current as any));
    // After the mouse is released (or a selection is extended with the keyboard) the
    // selection is final; scrolling or clicking elsewhere takes the toolbar away.
    const onPointerUp = () => window.setTimeout(refresh, 0);
    const hide = () => setSelection(null);
    const onPointerDown = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest?.('[data-ai-quote-toolbar]')) hide();
    };
    document.addEventListener('mouseup', onPointerUp);
    document.addEventListener('keyup', onPointerUp);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('mouseup', onPointerUp);
      document.removeEventListener('keyup', onPointerUp);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('scroll', hide, true);
    };
  }, [rootRef]);

  if (!selection) {
    return null;
  }
  const act = (mode: AIQuoteMode) => {
    onQuote(selection.text, selection.messageId, mode);
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  };
  return createPortal(
    <div
      data-ai-quote-toolbar="true"
      role="toolbar"
      style={toolbarStyle(selection.anchor)}
      // Keep the selection alive while a button is pressed.
      onMouseDown={(event) => event.preventDefault()}
    >
      <button type="button" style={buttonStyle} onClick={() => act('reply')}>
        <CommentOutlined />{copy('ai_chat.quote.reply')}
      </button>
      <button type="button" style={buttonStyle} onClick={() => act('context')}>
        <PlusOutlined />{copy('ai_chat.quote.add_context')}
      </button>
    </div>,
    document.body,
  );
};

export default AIReplySelectionToolbar;
