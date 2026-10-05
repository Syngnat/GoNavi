/**
 * Selecting text in an AI answer offers to quote it: add it as context for the
 * next message, or reply to it. These helpers decide whether a browser selection
 * is such a selection; they only use a small slice of the DOM so they can be
 * tested without one.
 */

/** Marks the container of an answer's text: its value is the message id. */
export const QUOTE_SOURCE_ATTRIBUTE = 'data-ai-quote-source';

/** Longest passage that is quoted; more is cut with a marker, like an editor selection. */
export const MAX_QUOTE_CHARS = 12_000;
const QUOTE_TRUNCATION_MARKER = '\n… (quote truncated)';

interface QuoteNode {
  parentElement?: QuoteElement | null;
}

interface QuoteElement extends QuoteNode {
  closest?: (selector: string) => QuoteElement | null;
  getAttribute?: (name: string) => string | null;
  contains?: (other: unknown) => boolean;
}

export interface QuoteSelectionLike {
  isCollapsed: boolean;
  rangeCount: number;
  toString: () => string;
  getRangeAt: (index: number) => {
    commonAncestorContainer: QuoteNode & QuoteElement;
    getBoundingClientRect: () => { left: number; top: number; width: number; height: number };
  };
}

export interface ReplySelection {
  text: string;
  messageId: string;
  /** Where to show the toolbar: the middle of the top edge of the selection. */
  anchor: { x: number; y: number };
}

export const clampQuoteText = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > MAX_QUOTE_CHARS
    ? `${trimmed.slice(0, MAX_QUOTE_CHARS - QUOTE_TRUNCATION_MARKER.length)}${QUOTE_TRUNCATION_MARKER}`
    : trimmed;
};

/**
 * The selected passage of one answer inside `root`, or null: nothing selected,
 * a selection outside the panel, in a user message, or spanning several messages.
 */
export const resolveReplySelection = (
  selection: QuoteSelectionLike | null | undefined,
  root: QuoteElement | null | undefined,
): ReplySelection | null => {
  if (!selection || selection.isCollapsed || selection.rangeCount < 1 || !root) {
    return null;
  }
  const text = clampQuoteText(selection.toString());
  if (!text) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const container = range.commonAncestorContainer;
  const element = typeof container.closest === 'function' ? container : (container.parentElement ?? null);
  const source = element?.closest?.(`[${QUOTE_SOURCE_ATTRIBUTE}]`);
  // A selection that spans messages has a common ancestor above any one message.
  if (!source || !root.contains?.(source)) {
    return null;
  }
  const messageId = String(source.getAttribute?.(QUOTE_SOURCE_ATTRIBUTE) || '').trim();
  if (!messageId) {
    return null;
  }
  const rect = range.getBoundingClientRect();
  return { text, messageId, anchor: { x: rect.left + rect.width / 2, y: rect.top } };
};
