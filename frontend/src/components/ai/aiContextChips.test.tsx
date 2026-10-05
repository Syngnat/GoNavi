import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { AIContextItem } from '../../types';
import { buildAIChatAttachmentPromptText } from './aiChatAttachments';
import {
  CONTEXT_CHIP_MEDIA_TYPE,
  buildContextChipAttachments,
  contextItemToDisplayChip,
  isContextChipAttachment,
  isTransientContextItem,
  parseContextChipAttachment,
} from './aiContextChips';
import { AIContextChip, AIContextChips } from './AIContextChipRow';
import { AIComposerBoundChips } from './AIComposerBoundChips';
import { buildAIChatQuoteContextItem } from './aiEditorSelectionContext';
import { toAIChatMessages } from './aiRunHarnessClient';

const selectionItem: AIContextItem = {
  kind: 'editor_selection', dbName: 'dbms_job', tableName: '__gonavi_editor_selection__', ddl: '',
  label: 'RFM 三维客户分析', content: 'WITH rfm AS (SELECT 1)\nSELECT * FROM rfm\n',
  source: { tabId: 'tab-1' },
};
const tableItem: AIContextItem = { dbName: 'dbms_job', tableName: 'lab_customers', ddl: 'CREATE TABLE lab_customers (id bigint)' };

const copy = (key: string, params?: Record<string, unknown>) => (params ? `${key}|${JSON.stringify(params)}` : key);

describe('context chips', () => {
  it('builds one chip per bound item, carrying the full text', () => {
    const chips = buildContextChipAttachments([selectionItem, tableItem]);
    expect(chips).toHaveLength(2);
    expect(chips.every(isContextChipAttachment)).toBe(true);
    expect(chips.map((chip) => chip.mimeType)).toEqual([CONTEXT_CHIP_MEDIA_TYPE, CONTEXT_CHIP_MEDIA_TYPE]);
    expect(chips.map((chip) => chip.name)).toEqual(['RFM 三维客户分析', 'dbms_job.lab_customers']);
    expect(JSON.parse(chips[0].text!)).toEqual(expect.objectContaining({ kind: 'editor_selection', text: selectionItem.content }));
  });

  it('skips an empty selection and a table with no name', () => {
    expect(buildAIChatAttachmentPromptText(buildContextChipAttachments([]))).toBe('');
    expect(buildContextChipAttachments([{ ...selectionItem, content: '  \n ' }, { dbName: '', tableName: '', ddl: 'x' }])).toEqual([]);
  });

  it('round-trips through what the ledger stores', () => {
    const [chip] = buildContextChipAttachments([selectionItem]);
    const restored = parseContextChipAttachment('att-1', chip.name, chip.text!);
    expect(restored).toEqual(expect.objectContaining({
      kind: 'context', contextKind: 'editor_selection', name: 'RFM 三维客户分析', text: selectionItem.content, contextLines: 3,
    }));
  });

  it('refuses anything that is not one of ours', () => {
    expect(parseContextChipAttachment('a', 'x', 'not json')).toBeNull();
    expect(parseContextChipAttachment('a', 'x', JSON.stringify({ v: 2, kind: 'editor_selection', text: 'x' }))).toBeNull();
    expect(parseContextChipAttachment('a', 'x', JSON.stringify({ v: 1, kind: 'other', text: 'x' }))).toBeNull();
  });

  it('is shown from the durable message after a restart', () => {
    const [chip] = buildContextChipAttachments([selectionItem]);
    const messages = toAIChatMessages({
      messages: [{ id: 'm-1', role: 'user', content: '看下', createdAt: '2026-10-02T04:00:00Z', attachments: [
        { name: chip.name, mediaType: CONTEXT_CHIP_MEDIA_TYPE, data: chip.text },
        { name: 'notes.md', mediaType: 'text/markdown', data: '# notes' },
      ] }],
    } as any);
    expect(messages[0].attachments?.map((attachment) => attachment.kind)).toEqual(['context', 'document']);
    expect(messages[0].attachments?.[0].text).toBe(selectionItem.content);
  });

  it('is never added to the prompt as an uploaded attachment', () => {
    const [chip] = buildContextChipAttachments([selectionItem]);
    const restored = parseContextChipAttachment('a', chip.name, chip.text!)!;
    expect(buildAIChatAttachmentPromptText([restored])).toBe('');
  });
});

describe('AIContextChips', () => {
  it('renders an abbreviated chip with the line count for a selection', () => {
    const [chip] = buildContextChipAttachments([selectionItem]);
    const restored = parseContextChipAttachment('a', chip.name, chip.text!)!;
    const markup = renderToStaticMarkup(<AIContextChips attachments={[restored]} copy={copy} />);
    expect(markup).toContain('RFM 三维客户分析');
    expect(markup).toContain('ai_chat.message.context_chip.lines|{&quot;n&quot;:3}');
    expect(markup).toContain('data-context-kind="editor_selection"');
  });

  it('renders a table chip by its name, and nothing for ordinary attachments or none', () => {
    const [chip] = buildContextChipAttachments([tableItem]);
    const restored = parseContextChipAttachment('a', chip.name, chip.text!)!;
    expect(renderToStaticMarkup(<AIContextChips attachments={[restored]} copy={copy} />)).toContain('dbms_job.lab_customers');
    expect(renderToStaticMarkup(<AIContextChips attachments={[{ id: 'f', name: 'a.md', mimeType: 'text/markdown', size: 1, kind: 'markdown' }]} copy={copy} />)).toBe('');
    expect(renderToStaticMarkup(<AIContextChips attachments={undefined} copy={copy} />)).toBe('');
  });
});

const quoteItem = buildAIChatQuoteContextItem('use an index on order_date\nto avoid the scan', 'msg-7', 'dbms_job');

describe('quoted reply passages', () => {
  it('is a chip of its own kind, labelled with the start of the quote', () => {
    expect(quoteItem.kind).toBe('chat_quote');
    expect(quoteItem.quoteOf).toBe('msg-7');
    const chip = contextItemToDisplayChip(quoteItem)!;
    expect(chip).toEqual(expect.objectContaining({ kind: 'context', contextKind: 'chat_quote', text: quoteItem.content }));
    expect(chip.name.length).toBeLessThanOrEqual(25);
    expect(chip.name.startsWith('use an index on order_d')).toBe(true);
  });

  it('quoting the same passage twice is one item, different passages are different items', () => {
    expect(buildAIChatQuoteContextItem('same', 'm1').tableName).toBe(buildAIChatQuoteContextItem('same', 'm2').tableName);
    expect(buildAIChatQuoteContextItem('one', 'm1').tableName).not.toBe(buildAIChatQuoteContextItem('two', 'm1').tableName);
  });

  it('is stored with the message and read back like the other chips', () => {
    const [built] = buildContextChipAttachments([quoteItem]);
    expect(JSON.parse(built.text!)).toEqual(expect.objectContaining({ v: 1, kind: 'chat_quote', text: quoteItem.content }));
    expect(parseContextChipAttachment('a', built.name, built.text!)).toEqual(expect.objectContaining({ contextKind: 'chat_quote', text: quoteItem.content }));
  });

  it('is bound for one message only, like an editor selection, unlike a table schema', () => {
    expect(isTransientContextItem(quoteItem)).toBe(true);
    expect(isTransientContextItem(selectionItem)).toBe(true);
    expect(isTransientContextItem(tableItem)).toBe(false);
  });

  it('keeps the table coordinates in what is stored, so the harness can rebuild the item', () => {
    const [built] = buildContextChipAttachments([tableItem]);
    expect(JSON.parse(built.text!)).toEqual(expect.objectContaining({ kind: 'table_schema', dbName: 'dbms_job', tableName: 'lab_customers' }));
    const [selection] = buildContextChipAttachments([{ ...selectionItem, source: { tabId: 't', startLine: 4, endLine: 9 } }]);
    expect(JSON.parse(selection.text!)).toEqual(expect.objectContaining({ startLine: 4, endLine: 9 }));
  });
});

describe('composer chips', () => {
  it('shows what is bound for the next message with a way to take it back, and leaves table schemas to the context list', () => {
    const markup = renderToStaticMarkup(<AIComposerBoundChips items={[selectionItem, quoteItem, tableItem]} copy={copy} onRemove={() => undefined} />);
    expect(markup).toContain('data-context-kind="editor_selection"');
    expect(markup).toContain('data-context-kind="chat_quote"');
    expect(markup).not.toContain('data-context-kind="table_schema"');
    expect(markup.match(/ai_chat\.message\.context_chip\.remove/g)).toHaveLength(2);
  });

  it('renders nothing when only table schemas are attached', () => {
    expect(renderToStaticMarkup(<AIComposerBoundChips items={[tableItem]} copy={copy} onRemove={() => undefined} />)).toBe('');
  });

  it('has no remove button on a chip that is only shown', () => {
    const chip = contextItemToDisplayChip(selectionItem)!;
    expect(renderToStaticMarkup(<AIContextChip chip={chip} copy={copy} />)).not.toContain('context_chip.remove');
  });
});
