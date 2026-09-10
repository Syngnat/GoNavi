import React from 'react';
import { FileTextOutlined, WarningOutlined } from '@ant-design/icons';

import type { AIChatAttachment } from '../../types';
import { t as catalogTranslate } from '../../i18n/catalog';
import { useOptionalI18n } from '../../i18n/provider';
import { formatAIChatAttachmentSize } from './aiChatAttachments';

interface AIChatAttachmentStripProps {
  attachments: AIChatAttachment[];
  onRemove: (index: number) => void;
}

type AttachmentKindLabels = {
  text: string;
  image: string;
  file: string;
};

const formatAttachmentKind = (attachment: AIChatAttachment, labels: AttachmentKindLabels): string => {
  if (attachment.kind === 'markdown') return 'MD';
  if (attachment.kind === 'pdf') return 'PDF';
  if (attachment.kind === 'word') return 'Word';
  if (attachment.kind === 'excel') return 'Excel';
  if (attachment.kind === 'text') return labels.text;
  if (attachment.kind === 'image') return labels.image;
  return labels.file;
};

const AttachmentFileChip: React.FC<{
  attachment: AIChatAttachment;
  attachmentKindLabels: AttachmentKindLabels;
  onRemove: () => void;
  removeAriaLabel: string;
}> = ({ attachment, attachmentKindLabels, onRemove, removeAriaLabel }) => (
    <div className={`gn-v2-ai-attachment-file${attachment.extractWarning ? ' has-warning' : ''}`}>
      <FileTextOutlined />
      <span className="gn-v2-ai-attachment-file-name" title={attachment.name}>{attachment.name}</span>
      <span className="gn-v2-ai-attachment-file-meta">
        {formatAttachmentKind(attachment, attachmentKindLabels)} · {formatAIChatAttachmentSize(attachment.size)}
      </span>
      {attachment.extractWarning ? <WarningOutlined title={attachment.extractWarning} /> : null}
      <button type="button" onClick={onRemove} aria-label={removeAriaLabel}>×</button>
    </div>
);

export const AIChatAttachmentStrip: React.FC<AIChatAttachmentStripProps> = ({
  attachments,
  onRemove,
}) => {
  const i18n = useOptionalI18n();
  const t = i18n?.t ?? ((key: string, params?: Record<string, string | number | boolean | null | undefined>) =>
    catalogTranslate('en-US', key, params));
  if (attachments.length === 0) {
    return null;
  }

  const removeFileAriaLabel = t('ai_chat.input.attachment.remove_file');
  const removeImageAriaLabel = t('ai_chat.input.attachment.remove_image');
  const attachmentKindLabels: AttachmentKindLabels = {
    text: t('ai_chat.input.attachment.kind.text'),
    image: t('ai_chat.input.attachment.kind.image'),
    file: t('ai_chat.input.attachment.kind.file'),
  };
  const buildImageAlt = (index: number) => t('ai_chat.message.image_alt', { index });

  return (
    <div className="gn-v2-ai-attachment-row">
      {attachments.map((attachment, index) => (
        attachment.kind === 'image' && attachment.dataUrl ? (
          <div key={attachment.id || index} className="gn-v2-ai-attachment-thumb">
            <img src={attachment.dataUrl} alt={buildImageAlt(index)} />
            <button
              type="button"
              onClick={() => onRemove(index)}
              aria-label={removeImageAriaLabel}
            >
              ×
            </button>
          </div>
        ) : (
          <AttachmentFileChip
            key={attachment.id || index}
            attachment={attachment}
            attachmentKindLabels={attachmentKindLabels}
            removeAriaLabel={removeFileAriaLabel}
            onRemove={() => onRemove(index)}
          />
        )
      ))}
    </div>
  );
};

export default AIChatAttachmentStrip;
