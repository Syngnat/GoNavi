import React from 'react';
import { message } from 'antd';
import type { AIChatAttachment } from '../../types';
import { createAIChatAttachmentFromFile, type AIChatAttachmentTranslator } from './aiChatAttachments';

interface UseAIChatDraftAttachmentsParams {
  setDraftAttachments: React.Dispatch<React.SetStateAction<AIChatAttachment[]>>;
  translate?: AIChatAttachmentTranslator;
  /** Called with each attachment once it is added (images are read from here, for a model that cannot see them). */
  onAttachmentAdded?: (attachment: AIChatAttachment) => void;
}

export const useAIChatDraftAttachments = ({
  setDraftAttachments,
  translate,
  onAttachmentAdded,
}: UseAIChatDraftAttachmentsParams) => {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const translateAttachmentMessage = React.useCallback((
    key: string,
    fallback: string,
    params?: Record<string, string | number | boolean | null | undefined>,
  ) => {
    if (!translate) {
      return fallback;
    }
    const translated = translate(key, params);
    return translated && translated !== key ? translated : fallback;
  }, [translate]);

  const appendDraftFiles = React.useCallback(async (files: File[]) => {
    for (const file of files) {
      try {
        const attachment = await createAIChatAttachmentFromFile(file, translate);
        setDraftAttachments((prev) => [...prev, attachment]);
        onAttachmentAdded?.(attachment);
        if (attachment.extractWarning) {
          message.warning(translateAttachmentMessage(
            'ai_chat.input.attachment.message.warning',
            `${attachment.name}: ${attachment.extractWarning}`,
            {
              name: attachment.name,
              message: attachment.extractWarning,
            },
          ));
        }
      } catch (error: any) {
        const detail = error?.message || String(error);
        const name = file.name || 'unnamed';
        message.error(translateAttachmentMessage(
          'ai_chat.input.attachment.message.read_failed',
          `Failed to read attachment ${name}: ${detail}`,
          {
            name,
            detail,
          },
        ));
      }
    }
  }, [setDraftAttachments, translate, translateAttachmentMessage, onAttachmentAdded]);

  const handleAttachmentUpload = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (files.length > 0) {
      void appendDraftFiles(files);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [appendDraftFiles]);

  const handlePasteImages = React.useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) {
      return;
    }
    const imageFiles: File[] = [];
    for (let index = 0; index < items.length; index += 1) {
      if (items[index].type.includes('image')) {
        const blob = items[index].getAsFile();
        if (blob) {
          imageFiles.push(blob);
        }
      }
    }
    if (imageFiles.length > 0) {
      event.preventDefault();
      void appendDraftFiles(imageFiles);
    }
  }, [appendDraftFiles]);

  const handleRemoveDraftAttachment = React.useCallback((index: number) => {
    setDraftAttachments((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
  }, [setDraftAttachments]);

  return {
    fileInputRef,
    handleAttachmentUpload,
    handlePasteImages,
    handleRemoveDraftAttachment,
  };
};
