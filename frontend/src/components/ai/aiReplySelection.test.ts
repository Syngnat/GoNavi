import { describe, expect, it } from 'vitest';

import {
  MAX_QUOTE_CHARS,
  QUOTE_SOURCE_ATTRIBUTE,
  clampQuoteText,
  resolveReplySelection,
  type QuoteSelectionLike,
} from './aiReplySelection';

// A tiny stand-in for the DOM: an element that knows its attributes and its parent.
interface FakeElement {
  attrs: Record<string, string>;
  parentElement: FakeElement | null;
  closest: (selector: string) => FakeElement | null;
  getAttribute: (name: string) => string | null;
  contains: (other: unknown) => boolean;
}

const element = (attrs: Record<string, string> = {}, parent: FakeElement | null = null): FakeElement => {
  const node: FakeElement = {
    attrs,
    parentElement: parent,
    closest(selector) {
      const name = selector.replace(/^\[|\]$/g, '');
      let cursor: FakeElement | null = node;
      while (cursor) {
        if (name in cursor.attrs) return cursor;
        cursor = cursor.parentElement;
      }
      return null;
    },
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    contains(other) {
      let cursor = other as FakeElement | null;
      while (cursor) {
        if (cursor === node) return true;
        cursor = cursor.parentElement;
      }
      return false;
    },
  };
  return node;
};

const selectionOf = (text: string, inside: FakeElement | null, collapsed = false): QuoteSelectionLike => ({
  isCollapsed: collapsed,
  rangeCount: 1,
  toString: () => text,
  getRangeAt: () => ({
    commonAncestorContainer: inside as any,
    getBoundingClientRect: () => ({ left: 100, top: 300, width: 80, height: 18 }),
  }),
});

describe('resolveReplySelection', () => {
  const panel = element();
  const answer = element({ [QUOTE_SOURCE_ATTRIBUTE]: 'msg-7' }, panel);
  const paragraph = element({}, answer);

  it('finds the answer a selection belongs to, and where to put the toolbar', () => {
    expect(resolveReplySelection(selectionOf('  use an index  ', paragraph), panel as any)).toEqual({
      text: 'use an index', messageId: 'msg-7', anchor: { x: 140, y: 300 },
    });
  });

  it('offers nothing for an empty or collapsed selection', () => {
    expect(resolveReplySelection(selectionOf('   ', paragraph), panel as any)).toBeNull();
    expect(resolveReplySelection(selectionOf('text', paragraph, true), panel as any)).toBeNull();
    expect(resolveReplySelection(null, panel as any)).toBeNull();
  });

  it('offers nothing outside an answer, such as in the composer or a user message', () => {
    const composer = element({}, panel);
    expect(resolveReplySelection(selectionOf('text', composer), panel as any)).toBeNull();
  });

  it('offers nothing for a selection that spans several messages', () => {
    // Its common ancestor is the list that holds the messages, above any one answer.
    expect(resolveReplySelection(selectionOf('text', panel), panel as any)).toBeNull();
  });

  it('ignores selections in another panel', () => {
    const elsewhere = element({ [QUOTE_SOURCE_ATTRIBUTE]: 'msg-1' });
    expect(resolveReplySelection(selectionOf('text', elsewhere), panel as any)).toBeNull();
  });
});

describe('clampQuoteText', () => {
  it('keeps a normal quote and cuts an enormous one with a marker', () => {
    expect(clampQuoteText('  short  ')).toBe('short');
    const clamped = clampQuoteText('x'.repeat(MAX_QUOTE_CHARS + 500));
    expect(clamped.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(clamped).toContain('quote truncated');
  });
});
