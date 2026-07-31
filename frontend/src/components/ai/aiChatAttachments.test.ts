import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  appendAIChatAttachmentsToContent,
  buildAIChatAttachmentPromptText,
  createAIChatAttachmentFromFile,
  resolveAIChatAttachmentKind,
} from './aiChatAttachments';

const makeFile = (parts: BlobPart[], name: string, type: string): File => {
  const blob = new Blob(parts, { type });
  return Object.assign(blob, { name, lastModified: 0 }) as File;
};

const translateAttachmentWarning = (
  key: string,
  params?: Record<string, string | number | boolean | null | undefined>,
): string => ({
  'ai_chat.input.attachment.excel.worksheet_header': `[Worksheet: ${params?.sheetName}]`,
  'ai_chat.input.attachment.kind.text': 'Text',
  'ai_chat.input.attachment.kind.markdown': 'Markdown',
  'ai_chat.input.attachment.kind.pdf': 'PDF',
  'ai_chat.input.attachment.kind.word': 'Word',
  'ai_chat.input.attachment.kind.excel': 'Excel',
  'ai_chat.input.attachment.kind.document': 'File',
  'ai_chat.input.attachment.warning.pdf_partial_text': 'PDF used lightweight text extraction; scanned or compressed-font content may not be fully readable.',
  'ai_chat.input.attachment.warning.pdf_no_text': 'No readable text was extracted from the PDF; if it is scanned or uses complex encoding, copy the body before sending.',
  'ai_chat.input.attachment.warning.legacy_office_partial_text': 'Legacy Office binary files only use lightweight text snippet extraction; convert to docx/xlsx before uploading for more complete content.',
  'ai_chat.input.attachment.warning.too_large': `File exceeds ${params?.size}; file metadata was attached but the body was not read.`,
  'ai_chat.input.attachment.warning.unsupported_type': 'This file type was attached, but body text was not extracted yet; use markdown, txt, docx, xlsx, or pdf if the model needs the content.',
  'ai_chat.input.attachment.warning.extract_failed': `Attachment body extraction failed: ${params?.detail}`,
  'ai_chat.input.attachment.prompt.content_truncated': '[Attachment body truncated]',
  'ai_chat.input.attachment.prompt.heading': `### Attachment ${params?.index}: ${params?.name}`,
  'ai_chat.input.attachment.prompt.kind': `- Type: ${params?.kind}`,
  'ai_chat.input.attachment.prompt.mime': `- MIME: ${params?.mimeType}`,
  'ai_chat.input.attachment.prompt.size': `- Size: ${params?.size}`,
  'ai_chat.input.attachment.prompt.extract_warning': `- Extraction note: ${params?.message}`,
  'ai_chat.input.attachment.prompt.text_truncated': '- Extraction note: Body text was truncated before sending.',
  'ai_chat.input.attachment.prompt.no_text': 'No readable attachment body was extracted.',
  'ai_chat.input.attachment.prompt.default_user_content': 'Continue based on the following attachment content.',
  'ai_chat.input.attachment.prompt.wrapper_start': '<User Uploaded Attachments>',
  'ai_chat.input.attachment.prompt.wrapper_end': '</User Uploaded Attachments>',
}[key] || key);

describe('aiChatAttachments', () => {

  it('keeps attachment prompt and worksheet keys present in all six catalogs', () => {
    const catalogs = [
      '../../../../shared/i18n/zh-CN.json',
      '../../../../shared/i18n/zh-TW.json',
      '../../../../shared/i18n/en-US.json',
      '../../../../shared/i18n/ja-JP.json',
      '../../../../shared/i18n/de-DE.json',
      '../../../../shared/i18n/ru-RU.json',
    ].map((path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')));

    const requiredKeys = [
      'ai_chat.input.attachment.excel.worksheet_header',
      'ai_chat.input.attachment.kind.markdown',
      'ai_chat.input.attachment.kind.pdf',
      'ai_chat.input.attachment.kind.word',
      'ai_chat.input.attachment.kind.excel',
      'ai_chat.input.attachment.kind.document',
      'ai_chat.input.attachment.prompt.content_truncated',
      'ai_chat.input.attachment.prompt.heading',
      'ai_chat.input.attachment.prompt.kind',
      'ai_chat.input.attachment.prompt.mime',
      'ai_chat.input.attachment.prompt.size',
      'ai_chat.input.attachment.prompt.extract_warning',
      'ai_chat.input.attachment.prompt.text_truncated',
      'ai_chat.input.attachment.prompt.no_text',
      'ai_chat.input.attachment.prompt.default_user_content',
      'ai_chat.input.attachment.prompt.wrapper_start',
      'ai_chat.input.attachment.prompt.wrapper_end',
      'ai_chat.input.attachment.message.warning',
      'ai_chat.input.attachment.message.read_failed',
    ];

    for (const catalog of catalogs) {
      for (const key of requiredKeys) {
        expect(catalog[key]).toBeTruthy();
      }
    }
  });

  it('extracts markdown text so it can be sent to AI', async () => {
    const attachment = await createAIChatAttachmentFromFile(makeFile(['# Report\n\nhello'], 'report.md', 'text/markdown'));

    expect(attachment.kind).toBe('markdown');
    expect(attachment.text).toContain('# Report');
    expect(buildAIChatAttachmentPromptText([attachment])).toContain('hello');
  });

  it('extracts docx document text from Office Open XML', async () => {
    const bytes = zipSync({
      'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>用户增长</w:t></w:r></w:p><w:p><w:r><w:t>GMV &amp; 留存</w:t></w:r></w:p></w:body></w:document>'),
    });
    const attachment = await createAIChatAttachmentFromFile(makeFile([bytes], 'plan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));

    expect(attachment.kind).toBe('word');
    expect(attachment.text).toContain('用户增长');
    expect(attachment.text).toContain('GMV & 留存');
  });

  it('extracts xlsx worksheet rows with shared strings', async () => {
    const bytes = zipSync({
      'xl/sharedStrings.xml': strToU8('<sst><si><t>姓名</t></si><si><t>张三</t></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>100</v></c></row><row><c t="s"><v>1</v></c><c><v>88</v></c></row></sheetData></worksheet>'),
    });
    const attachment = await createAIChatAttachmentFromFile(
      makeFile([bytes], 'score.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      translateAttachmentWarning,
    );

    expect(attachment.kind).toBe('excel');
    expect(attachment.text).toContain('[Worksheet: sheet1]');
    expect(attachment.text).toContain('姓名\t100');
    expect(attachment.text).toContain('张三\t88');
  });

  it('extracts lightweight PDF literal text and keeps a warning about limitations', async () => {
    const attachment = await createAIChatAttachmentFromFile(
      makeFile(['%PDF-1.4\nBT (Invoice total 42) Tj ET\n%%EOF'], 'invoice.pdf', 'application/pdf'),
      translateAttachmentWarning,
    );

    expect(attachment.kind).toBe('pdf');
    expect(attachment.text).toContain('Invoice total 42');
    expect(attachment.extractWarning).toBe('PDF used lightweight text extraction; scanned or compressed-font content may not be fully readable.');
  });

  it('returns a localized fallback warning when a PDF yields no readable text', async () => {
    const attachment = await createAIChatAttachmentFromFile(
      makeFile([new Uint8Array([0x00, 0x01, 0x02, 0x03])], 'scan.pdf', 'application/pdf'),
      translateAttachmentWarning,
    );

    expect(attachment.kind).toBe('pdf');
    expect(attachment.text).toBe('');
    expect(attachment.extractWarning).toBe('No readable text was extracted from the PDF; if it is scanned or uses complex encoding, copy the body before sending.');
  });

  it('extracts lightweight legacy Office text and keeps a localized warning about the limited result', async () => {
    const attachment = await createAIChatAttachmentFromFile(
      makeFile(['Legacy DOC Budget 2026 forecast'], 'budget.doc', 'application/msword'),
      translateAttachmentWarning,
    );

    expect(attachment.kind).toBe('word');
    expect(attachment.text).toContain('Legacy DOC Budget 2026 forecast');
    expect(attachment.extractWarning).toBe('Legacy Office binary files only use lightweight text snippet extraction; convert to docx/xlsx before uploading for more complete content.');
  });

  it('returns a localized warning when the file exceeds the readable size limit', async () => {
    const oversized = new Uint8Array(15 * 1024 * 1024 + 1);
    const attachment = await createAIChatAttachmentFromFile(
      makeFile([oversized], 'oversized.txt', 'text/plain'),
      translateAttachmentWarning,
    );

    expect(attachment.kind).toBe('text');
    expect(attachment.extractWarning).toBe('File exceeds 15.0 MB; file metadata was attached but the body was not read.');
    expect(attachment.text).toBeUndefined();
  });

  it('returns a localized warning for attached file types without body extraction support yet', async () => {
    const attachment = await createAIChatAttachmentFromFile(
      makeFile([new Uint8Array([0x01, 0x02, 0x03])], 'archive.bin', 'application/octet-stream'),
      translateAttachmentWarning,
    );

    expect(attachment.kind).toBe('document');
    expect(attachment.extractWarning).toBe('This file type was attached, but body text was not extracted yet; use markdown, txt, docx, xlsx, or pdf if the model needs the content.');
    expect(attachment.text).toBeUndefined();
  });

  it('returns a localized extraction failure wrapper and preserves raw detail', async () => {
    const brokenFile = makeFile([], 'broken.txt', 'text/plain');
    brokenFile.text = async () => {
      throw new Error('disk read failed');
    };

    const attachment = await createAIChatAttachmentFromFile(brokenFile, translateAttachmentWarning);

    expect(attachment.kind).toBe('text');
    expect(attachment.extractWarning).toBe('Attachment body extraction failed: disk read failed');
    expect(attachment.text).toBeUndefined();
  });

  it('appends non-image attachments to the upstream user content', () => {
    const content = appendAIChatAttachmentsToContent('帮我总结', [{
      id: 'att-1',
      name: 'report.txt',
      mimeType: 'text/plain',
      size: 12,
      kind: 'text',
      text: '核心指标下降',
    }], translateAttachmentWarning as any);

    expect(content).toContain('帮我总结');
    expect(content).toContain('<User Uploaded Attachments>');
    expect(content).toContain('核心指标下降');
  });

  it('keeps images out of the prompt text because they are sent through multimodal payload fields', () => {
    expect(resolveAIChatAttachmentKind({ name: 'screen.png', type: 'image/png' })).toBe('image');
    expect(buildAIChatAttachmentPromptText([{
      id: 'att-img',
      name: 'screen.png',
      mimeType: 'image/png',
      size: 10,
      kind: 'image',
      dataUrl: 'data:image/png;base64,abc',
    }])).toBe('');
  });

  it('builds localized attachment prompt copy instead of legacy Chinese wrappers', () => {
    const prompt = buildAIChatAttachmentPromptText([{
      id: 'att-1',
      name: 'report.md',
      mimeType: 'text/markdown',
      size: 18,
      kind: 'markdown',
      text: 'Revenue dropped',
      textTruncated: true,
      extractWarning: 'PDF used lightweight text extraction; scanned or compressed-font content may not be fully readable.',
    }], translateAttachmentWarning as any);

    expect(prompt).toContain('### Attachment 1: report.md');
    expect(prompt).toContain('- Type: Markdown');
    expect(prompt).toContain('- MIME: text/markdown');
    expect(prompt).toContain('- Size: 18 B');
    expect(prompt).toContain('- Extraction note: PDF used lightweight text extraction; scanned or compressed-font content may not be fully readable.');
    expect(prompt).toContain('- Extraction note: Body text was truncated before sending.');
    expect(prompt).not.toContain('### 附件 1');
    expect(prompt).not.toContain('- 类型: ');
    expect(prompt).not.toContain('- 提取说明: ');
  });

  it('uses localized default prompt wrapper and empty-body fallback when translator is provided', () => {
    const content = appendAIChatAttachmentsToContent('', [{
      id: 'att-2',
      name: 'empty.pdf',
      mimeType: 'application/pdf',
      size: 10,
      kind: 'pdf',
      text: '',
    }], translateAttachmentWarning as any);

    expect(content).toContain('Continue based on the following attachment content.');
    expect(content).toContain('<User Uploaded Attachments>');
    expect(content).toContain('</User Uploaded Attachments>');
    expect(content).toContain('No readable attachment body was extracted.');
    expect(content).not.toContain('请根据以下附件内容继续处理。');
    expect(content).not.toContain('未提取到可发送的附件正文。');
  });
});
