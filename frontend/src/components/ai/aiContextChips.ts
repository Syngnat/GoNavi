import type { AIChatAttachment, AIContextItem } from '../../types';
import { isAIChatQuoteContext, isAIEditorSelectionContext } from './aiEditorSelectionContext';

/**
 * What the person binds for one message (an editor selection, a passage quoted
 * from an answer) or attaches (a table schema) is shown on the sent message as a
 * small chip, with the full text on hover. It travels with the durable user
 * message as an attachment of this media type, so the chat shows it after a
 * restart as well, and the harness merges it into that message's context (the
 * live workspace cannot be the only carrier: the composer clears what it bound as
 * soon as the message is sent). The provider never gets it as an attachment.
 */
export const CONTEXT_CHIP_MEDIA_TYPE = 'application/vnd.gonavi.context+json';

export type ContextChipKind = 'editor_selection' | 'table_schema' | 'chat_quote';

interface ContextChipPayload {
  v: 1;
  kind: ContextChipKind;
  label: string;
  text: string;
  dbName?: string;
  tableName?: string;
  startLine?: number;
  endLine?: number;
}

export const isContextChipAttachment = (attachment: Pick<AIChatAttachment, 'kind'>): boolean =>
  attachment.kind === 'context';

/** Bound for one message only: cleared from the composer once that message is sent. */
export const isTransientContextItem = (item: AIContextItem | null | undefined): boolean =>
  isAIEditorSelectionContext(item) || isAIChatQuoteContext(item);

const lineCount = (text: string): number => (text ? text.split(/\r?\n/).length : 0);

const QUOTE_LABEL_CHARS = 24;
const shortLabel = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > QUOTE_LABEL_CHARS ? `${flat.slice(0, QUOTE_LABEL_CHARS)}…` : flat;
};

const chipKindOf = (item: AIContextItem): ContextChipKind =>
  isAIEditorSelectionContext(item) ? 'editor_selection' : isAIChatQuoteContext(item) ? 'chat_quote' : 'table_schema';

/** The attachments to store with a message that is sent while these items are bound. */
export const buildContextChipAttachments = (items: AIContextItem[]): AIChatAttachment[] =>
  items.flatMap((item, index): AIChatAttachment[] => {
    const kind = chipKindOf(item);
    const text = String(kind === 'table_schema' ? item.ddl || '' : item.content || '');
    if (kind !== 'table_schema' && !text.trim()) return [];
    const label = kind === 'table_schema'
      ? [item.dbName, item.tableName].map((part) => String(part || '').trim()).filter(Boolean).join('.')
      : String(item.label || item.source?.tabTitle || '').trim() || (kind === 'chat_quote' ? shortLabel(text) : '');
    if (kind === 'table_schema' && !label) return [];
    const payload: ContextChipPayload = { v: 1, kind, label, text };
    if (item.dbName) payload.dbName = item.dbName;
    if (kind === 'table_schema') payload.tableName = item.tableName;
    if (kind === 'editor_selection' && item.source?.startLine && item.source?.endLine) {
      payload.startLine = item.source.startLine;
      payload.endLine = item.source.endLine;
    }
    return [{
      id: `context-chip-${index}`,
      // The sender needs a non-empty name; the label is shown from the payload.
      name: label || kind,
      mimeType: CONTEXT_CHIP_MEDIA_TYPE,
      size: text.length,
      kind: 'context',
      contextKind: kind,
      // For a chip being sent, `text` is the JSON payload that gets stored.
      text: JSON.stringify(payload),
    }];
  });

/** Rebuild a chip from what the ledger stored; null when it is not one of ours. */
export const parseContextChipAttachment = (id: string, name: string, data: string): AIChatAttachment | null => {
  try {
    const payload = JSON.parse(data) as Partial<ContextChipPayload> | null;
    if (!payload || payload.v !== 1) return null;
    if (payload.kind !== 'editor_selection' && payload.kind !== 'table_schema' && payload.kind !== 'chat_quote') return null;
    const text = String(payload.text || '');
    return {
      id,
      name: String(payload.label || name || '').trim() || name,
      mimeType: CONTEXT_CHIP_MEDIA_TYPE,
      size: text.length,
      kind: 'context',
      contextKind: payload.kind,
      contextLines: lineCount(text),
      // For a chip read back, `text` is the full content shown on hover.
      text,
    };
  } catch {
    return null;
  }
};

/** A bound item as the chip the composer and the message show. */
export const contextItemToDisplayChip = (item: AIContextItem): AIChatAttachment | null => {
  const [built] = buildContextChipAttachments([item]);
  return built ? parseContextChipAttachment(built.id, built.name, built.text || '') : null;
};
