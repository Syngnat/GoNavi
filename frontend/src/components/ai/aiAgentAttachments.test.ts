import { describe, expect, it } from 'vitest';

import type { AIChatAttachment } from '../../types';
import { OCR_TEXT_MEDIA_TYPE, isOcrPending, toAgentAttachments } from './aiAgentAttachments';
import { toAIChatMessages } from './aiRunHarnessClient';

const image = (ocr?: AIChatAttachment['ocr']): AIChatAttachment => ({
  id: 'i1', name: 'error.png', mimeType: 'image/png', size: 9, kind: 'image', dataUrl: 'data:image/png;base64,AA==', ...(ocr ? { ocr } : {}),
});

describe('toAgentAttachments', () => {
  it('stores an image with the text that was read from it, under the image\'s name', () => {
    expect(toAgentAttachments([image({ status: 'done', text: 'ERROR 1146' })])).toEqual([
      { name: 'error.png', mediaType: 'image/png', data: 'data:image/png;base64,AA==' },
      { name: 'error.png', mediaType: OCR_TEXT_MEDIA_TYPE, data: 'ERROR 1146' },
    ]);
  });

  it('adds nothing for an image that was not read, found no text, or failed', () => {
    for (const ocr of [undefined, { status: 'no_text' as const }, { status: 'failed' as const, error: 'x' }, { status: 'needs_install' as const }, { status: 'running' as const }]) {
      expect(toAgentAttachments([image(ocr)])).toHaveLength(1);
    }
  });

  it('keeps documents as they were: the extracted text, under the file\'s own type', () => {
    const document: AIChatAttachment = { id: 'd1', name: 'notes.md', mimeType: 'text/markdown', size: 4, kind: 'markdown', text: '# hi' };
    expect(toAgentAttachments([document])).toEqual([{ name: 'notes.md', mediaType: 'text/markdown', data: '# hi' }]);
  });

  it('leaves out an attachment without a name', () => {
    expect(toAgentAttachments([{ ...image(), name: '  ' }])).toEqual([]);
  });

  it('uses the media type the Go side recognizes', () => {
    // runharness.OCRTextMediaType: if one changes, so must the other.
    expect(OCR_TEXT_MEDIA_TYPE).toBe('application/vnd.gonavi.ocr+text');
  });
});

describe('isOcrPending', () => {
  it('is true only while an image is waiting for or being read', () => {
    expect(isOcrPending(image({ status: 'waiting' }))).toBe(true);
    expect(isOcrPending(image({ status: 'running' }))).toBe(true);
    for (const status of ['done', 'no_text', 'failed', 'needs_install'] as const) {
      expect(isOcrPending(image({ status }))).toBe(false);
    }
    expect(isOcrPending(image())).toBe(false);
  });
});

describe('a sent message read back from the ledger', () => {
  it('shows the image once: the text read from it is for the model', () => {
    const [message] = toAIChatMessages({
      messages: [{ id: 'm-1', role: 'user', content: 'what is this?', createdAt: '2026-10-02T04:00:00Z', attachments: [
        { name: 'error.png', mediaType: 'image/png', data: 'data:image/png;base64,AA==' },
        { name: 'error.png', mediaType: OCR_TEXT_MEDIA_TYPE, data: 'ERROR 1146' },
        { name: 'notes.md', mediaType: 'text/markdown', data: '# hi' },
      ] }],
    } as any);
    expect(message.attachments?.map((attachment) => [attachment.name, attachment.kind])).toEqual([['error.png', 'image'], ['notes.md', 'document']]);
  });
});
