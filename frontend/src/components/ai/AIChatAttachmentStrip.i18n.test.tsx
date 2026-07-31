import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../i18n/provider';
import AIChatAttachmentStrip from './AIChatAttachmentStrip';
import { buildOverlayWorkbenchTheme } from '../../utils/overlayWorkbenchTheme';

vi.mock('../../i18n/runtime', () => ({
  syncLanguageRuntime: vi.fn(async () => undefined),
}));

vi.mock('@ant-design/icons', async () => {
  const React = await import('react');
  const makeIcon = (name: string) => () => React.createElement('span', { 'data-icon': name });
  return {
    FileTextOutlined: makeIcon('file-text'),
    WarningOutlined: makeIcon('warning'),
  };
});

const renderAttachmentStrip = (
  variant: 'legacy' | 'v2',
  attachments: Array<Record<string, unknown>>,
  preference: 'en-US' | 'zh-CN' = 'en-US',
) => renderToStaticMarkup(
  <I18nProvider
    preference={preference}
    systemLanguages={[preference]}
    onPreferenceChange={() => undefined}
  >
    <AIChatAttachmentStrip
      attachments={attachments as any}
      onRemove={() => undefined}
      overlayTheme={buildOverlayWorkbenchTheme(false)}
      variant={variant}
    />
  </I18nProvider>,
);

const renderAttachmentStripWithoutProvider = (
  variant: 'legacy' | 'v2',
  attachments: Array<Record<string, unknown>>,
) => renderToStaticMarkup(
  <AIChatAttachmentStrip
    attachments={attachments as any}
    onRemove={() => undefined}
    overlayTheme={buildOverlayWorkbenchTheme(false)}
    variant={variant}
  />,
);

describe('AIChatAttachmentStrip i18n source guards', () => {

  it('renders localized remove aria labels and attachment kind labels while preserving raw attachment names', () => {
    const fileAttachment = [{
      id: 'file-1',
      name: 'orders.csv',
      kind: 'text',
      size: 128,
      mimeType: 'text/csv',
    }];
    const genericAttachment = [{
      id: 'file-2',
      name: 'dump.bin',
      kind: 'document',
      size: 64,
      mimeType: 'application/octet-stream',
    }];
    const imageAttachment = [{
      id: 'image-1',
      name: 'draft.png',
      kind: 'image',
      size: 256,
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AA==',
    }];
    const imageWithoutPreviewAttachment = [{
      id: 'image-2',
      name: 'screenshot.png',
      kind: 'image',
      size: 96,
      mimeType: 'image/png',
    }];

    const legacyFileMarkup = renderAttachmentStrip('legacy', fileAttachment);
    const legacyImageMarkup = renderAttachmentStrip('legacy', imageAttachment);
    const v2FileMarkup = renderAttachmentStrip('v2', fileAttachment);
    const v2ImageMarkup = renderAttachmentStrip('v2', imageAttachment);
    const zhLegacyFileMarkup = renderAttachmentStrip('legacy', fileAttachment, 'zh-CN');
    const zhV2FileMarkup = renderAttachmentStrip('v2', fileAttachment, 'zh-CN');
    const zhLegacyGenericMarkup = renderAttachmentStrip('legacy', genericAttachment, 'zh-CN');
    const zhV2GenericMarkup = renderAttachmentStrip('v2', genericAttachment, 'zh-CN');
    const zhLegacyImageNoPreviewMarkup = renderAttachmentStrip('legacy', imageWithoutPreviewAttachment, 'zh-CN');
    const zhV2ImageNoPreviewMarkup = renderAttachmentStrip('v2', imageWithoutPreviewAttachment, 'zh-CN');

    expect(legacyFileMarkup).toContain('aria-label="Remove attachment"');
    expect(v2FileMarkup).toContain('aria-label="Remove attachment"');
    expect(legacyImageMarkup).toContain('aria-label="Remove image"');
    expect(v2ImageMarkup).toContain('aria-label="Remove image"');
    expect(legacyImageMarkup).toContain('alt="Attached image 0"');
    expect(v2ImageMarkup).toContain('alt="Attached image 0"');
    expect(legacyFileMarkup).toContain('orders.csv');
    expect(v2FileMarkup).toContain('orders.csv');
    expect(zhLegacyFileMarkup).toContain('文本');
    expect(zhV2FileMarkup).toContain('文本');
    expect(zhLegacyGenericMarkup).toContain('文件');
    expect(zhV2GenericMarkup).toContain('文件');
    expect(zhLegacyImageNoPreviewMarkup).toContain('图片');
    expect(zhV2ImageNoPreviewMarkup).toContain('图片');
  });

  it('falls back to English attachment labels without an i18n provider while preserving raw names', () => {
    const fileAttachment = [{
      id: 'file-1',
      name: 'orders.csv',
      kind: 'text',
      size: 128,
      mimeType: 'text/csv',
    }];
    const genericAttachment = [{
      id: 'file-2',
      name: 'dump.bin',
      kind: 'document',
      size: 64,
      mimeType: 'application/octet-stream',
    }];
    const imageAttachment = [{
      id: 'image-1',
      name: 'draft.png',
      kind: 'image',
      size: 256,
      mimeType: 'image/png',
      dataUrl: 'data:image/png;base64,AA==',
    }];
    const imageWithoutPreviewAttachment = [{
      id: 'image-2',
      name: 'screenshot.png',
      kind: 'image',
      size: 96,
      mimeType: 'image/png',
    }];

    expect(() => renderAttachmentStripWithoutProvider('legacy', fileAttachment)).not.toThrow();
    expect(() => renderAttachmentStripWithoutProvider('v2', imageAttachment)).not.toThrow();

    const legacyFileMarkup = renderAttachmentStripWithoutProvider('legacy', fileAttachment);
    const legacyImageMarkup = renderAttachmentStripWithoutProvider('legacy', imageAttachment);
    const v2FileMarkup = renderAttachmentStripWithoutProvider('v2', fileAttachment);
    const v2ImageMarkup = renderAttachmentStripWithoutProvider('v2', imageAttachment);
    const legacyGenericMarkup = renderAttachmentStripWithoutProvider('legacy', genericAttachment);
    const v2GenericMarkup = renderAttachmentStripWithoutProvider('v2', genericAttachment);
    const legacyImageNoPreviewMarkup = renderAttachmentStripWithoutProvider('legacy', imageWithoutPreviewAttachment);
    const v2ImageNoPreviewMarkup = renderAttachmentStripWithoutProvider('v2', imageWithoutPreviewAttachment);

    expect(legacyFileMarkup).toContain('aria-label="Remove attachment"');
    expect(v2FileMarkup).toContain('aria-label="Remove attachment"');
    expect(legacyImageMarkup).toContain('aria-label="Remove image"');
    expect(v2ImageMarkup).toContain('aria-label="Remove image"');
    expect(legacyImageMarkup).toContain('alt="Attached image 0"');
    expect(v2ImageMarkup).toContain('alt="Attached image 0"');
    expect(legacyFileMarkup).toContain('orders.csv');
    expect(v2FileMarkup).toContain('orders.csv');
    expect(legacyFileMarkup).toContain('Text');
    expect(v2FileMarkup).toContain('Text');
    expect(legacyGenericMarkup).toContain('File');
    expect(v2GenericMarkup).toContain('File');
    expect(legacyImageNoPreviewMarkup).toContain('Image');
    expect(v2ImageNoPreviewMarkup).toContain('Image');
    expect(legacyFileMarkup).not.toContain('ai_chat.input.attachment.remove_file');
  });
});
