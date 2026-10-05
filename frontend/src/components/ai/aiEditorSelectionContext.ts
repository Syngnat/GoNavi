import { useSyncExternalStore } from 'react';

import type { AIContextItem, AIEditorSelection } from '../../types';

/** Keep an accidental full-document selection from consuming the whole model context. */
export const AI_EDITOR_SELECTION_MAX_CHARS = 30_000;
const SELECTION_TRUNCATION_MARKER = '\n/* ... selection truncated before sending ... */';

const selections = new Map<string, AIEditorSelection>();
const listeners = new Set<() => void>();

const notify = (): void => {
  listeners.forEach((listener) => listener());
};

const normalizePositive = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
};

const normalizeSelection = (selection: AIEditorSelection): AIEditorSelection | null => {
  const tabId = String(selection.tabId || '').trim();
  const rawText = String(selection.text || '');
  if (!tabId || !rawText.trim()) {
    return null;
  }
  const truncated = rawText.length > AI_EDITOR_SELECTION_MAX_CHARS;
  const text = truncated
    ? `${rawText.slice(0, Math.max(0, AI_EDITOR_SELECTION_MAX_CHARS - SELECTION_TRUNCATION_MARKER.length))}${SELECTION_TRUNCATION_MARKER}`
    : rawText;
  return {
    tabId,
    ...(String(selection.tabTitle || '').trim() ? { tabTitle: String(selection.tabTitle).trim() } : {}),
    ...(String(selection.connectionId || '').trim() ? { connectionId: String(selection.connectionId).trim() } : {}),
    ...(String(selection.dbName || '').trim() ? { dbName: String(selection.dbName).trim() } : {}),
    ...(String(selection.language || '').trim() ? { language: String(selection.language).trim() } : {}),
    text,
    ...(normalizePositive(selection.startLine) ? { startLine: normalizePositive(selection.startLine) } : {}),
    ...(normalizePositive(selection.startColumn) ? { startColumn: normalizePositive(selection.startColumn) } : {}),
    ...(normalizePositive(selection.endLine) ? { endLine: normalizePositive(selection.endLine) } : {}),
    ...(normalizePositive(selection.endColumn) ? { endColumn: normalizePositive(selection.endColumn) } : {}),
    ...(truncated || selection.truncated ? { truncated: true } : {}),
  };
};

export const publishAIEditorSelection = (selection: AIEditorSelection | null): AIEditorSelection | null => {
  const tabId = String(selection?.tabId || '').trim();
  if (!tabId) {
    return null;
  }
  const normalized = selection ? normalizeSelection(selection) : null;
  if (!normalized) {
    if (selections.delete(tabId)) {
      notify();
    }
    return null;
  }
  const previous = selections.get(tabId);
  if (previous && JSON.stringify(previous) === JSON.stringify(normalized)) {
    return previous;
  }
  selections.set(tabId, normalized);
  notify();
  return normalized;
};

export const clearAIEditorSelection = (tabId: string): void => {
  const key = String(tabId || '').trim();
  if (key && selections.delete(key)) {
    notify();
  }
};

// A live editor registers a way to read its selection on demand. The event-driven
// copy above can lag or miss a change (select-all by keyboard, focus moving to
// the AI panel), so an explicit "bind" reads the editor itself.
const refreshers = new Map<string, () => unknown>();

export const registerAIEditorSelectionRefresher = (tabId: string, refresh: () => unknown): (() => void) => {
  const key = String(tabId || '').trim();
  if (!key) {
    return () => {};
  }
  refreshers.set(key, refresh);
  return () => {
    if (refreshers.get(key) === refresh) {
      refreshers.delete(key);
    }
  };
};

/** Re-read the tab's editor selection now, then return what is registered for it. */
export const refreshAIEditorSelection = (tabId: string | null | undefined): AIEditorSelection | null => {
  const key = String(tabId || '').trim();
  if (!key) {
    return null;
  }
  try {
    refreshers.get(key)?.();
  } catch {
    // A disposed editor must not break the composer; fall back to the stored copy.
  }
  return selections.get(key) || null;
};

export const getAIEditorSelection = (tabId: string | null | undefined): AIEditorSelection | null => {
  const key = String(tabId || '').trim();
  return key ? selections.get(key) || null : null;
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useAIEditorSelection = (tabId: string | null | undefined): AIEditorSelection | null => {
  const key = String(tabId || '').trim();
  return useSyncExternalStore(
    subscribe,
    () => (key ? selections.get(key) || null : null),
    () => null,
  );
};

/** Convert the current selection into the legacy-compatible attached item shape. */
export const buildAIEditorSelectionContextItem = (
  selection: AIEditorSelection,
): AIContextItem => ({
  kind: 'editor_selection',
  dbName: String(selection.dbName || '').trim(),
  // The store still uses dbName/tableName as its stable removal key. A single
  // current selection is intentionally bound per database context.
  tableName: '__gonavi_editor_selection__',
  // Keep the legacy field present for the shared item contract, but avoid
  // duplicating up to 30k characters in the workspace snapshot.
  ddl: '',
  ...(String(selection.tabTitle || '').trim() ? { label: String(selection.tabTitle).trim() } : {}),
  content: selection.text,
  source: {
    tabId: selection.tabId,
    ...(selection.tabTitle ? { tabTitle: selection.tabTitle } : {}),
    ...(selection.connectionId ? { connectionId: selection.connectionId } : {}),
    ...(selection.dbName ? { dbName: selection.dbName } : {}),
    ...(selection.language ? { language: selection.language } : {}),
    ...(selection.startLine ? { startLine: selection.startLine } : {}),
    ...(selection.startColumn ? { startColumn: selection.startColumn } : {}),
    ...(selection.endLine ? { endLine: selection.endLine } : {}),
    ...(selection.endColumn ? { endColumn: selection.endColumn } : {}),
    ...(selection.truncated ? { truncated: true } : {}),
  },
});

export const isAIEditorSelectionContext = (item: AIContextItem | null | undefined): boolean =>
  item?.kind === 'editor_selection';

export const isAIChatQuoteContext = (item: AIContextItem | null | undefined): boolean =>
  item?.kind === 'chat_quote';

export const isAITableSchemaContext = (item: AIContextItem | null | undefined): boolean =>
  !isAIEditorSelectionContext(item) && !isAIChatQuoteContext(item);

// A short, stable key for a quoted passage: quoting the same text twice is one
// attachment, and different passages never replace each other.
const quoteKey = (text: string): string => {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
};

/** A passage quoted from an answer, as a context item for the next message. */
export const buildAIChatQuoteContextItem = (text: string, messageId: string, dbName = ''): AIContextItem => ({
  kind: 'chat_quote',
  dbName,
  tableName: `__gonavi_chat_quote__:${quoteKey(text)}`,
  ddl: '',
  content: text,
  quoteOf: messageId,
});
