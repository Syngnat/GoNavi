import type { AIChatAttachment } from '../../types';
import type { AgentAttachment } from './aiRunHarnessClient';

/**
 * Marks an attachment holding text the desktop read from an image. The Go side
 * (runharness.OCRTextMediaType) gives it to the model as recognized text, which
 * may contain mistakes.
 */
export const OCR_TEXT_MEDIA_TYPE = 'application/vnd.gonavi.ocr+text';

/**
 * What is stored with a sent message. An image that was read comes with the text
 * read from it, under the image's own name.
 */
export const toAgentAttachments = (attachments: AIChatAttachment[]): AgentAttachment[] => (
  attachments.flatMap((attachment) => {
    const name = String(attachment.name || '').trim();
    if (!name) return [];
    const stored: AgentAttachment = {
      name,
      mediaType: String(attachment.mimeType || 'application/octet-stream'),
      data: String(attachment.dataUrl || attachment.text || ''),
    };
    const recognized = attachment.kind === 'image' && attachment.ocr?.status === 'done' ? String(attachment.ocr.text || '') : '';
    return recognized ? [stored, { name, mediaType: OCR_TEXT_MEDIA_TYPE, data: recognized }] : [stored];
  })
);

/** An image's text is still being read: a message sent now would leave it out. */
export const isOcrPending = (attachment: AIChatAttachment): boolean => (
  attachment.ocr?.status === 'waiting' || attachment.ocr?.status === 'running'
);
